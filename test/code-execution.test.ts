/**
 * Client-side programmatic tool calling (code_execution) tests.
 *
 * PyRunner tests spawn a REAL python3 subprocess — the protocol, top-level
 * await, tool-function injection, timeout, and deadline behavior are all
 * exercised end-to-end. Framework tests drive a full agent turn through the
 * MockMembrane and assert the load-bearing invariant: inner tool results
 * reach the running script but never the model-facing tool_result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, PyRunner, buildInjectedTools } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const ECHO_TOOLS: { pyName: string; toolName: string }[] = [
  { pyName: 'test__echo', toolName: 'test--echo' },
];

describe('buildInjectedTools', () => {
  it('sanitizes -- to __ and keeps valid identifiers', () => {
    const injected = buildInjectedTools(['mcpl--discord--send_message', 'think']);
    assert.deepStrictEqual(injected, [
      { pyName: 'mcpl__discord__send_message', toolName: 'mcpl--discord--send_message' },
      { pyName: 'think', toolName: 'think' },
    ]);
  });

  it('sanitizes single hyphens inside segments (live fleet names)', () => {
    // Found on the first Mica canary run: module/server ids with single
    // hyphens were skipped entirely. They must inject.
    const injected = buildInjectedTools([
      'mcpl-admin--mcpl_deploy',
      'mcpl--dog-events--dog_events_status',
      'channel-mode--set_channel_mode',
    ]);
    assert.deepStrictEqual(injected, [
      { pyName: 'mcpl_admin__mcpl_deploy', toolName: 'mcpl-admin--mcpl_deploy' },
      { pyName: 'mcpl__dog_events__dog_events_status', toolName: 'mcpl--dog-events--dog_events_status' },
      { pyName: 'channel_mode__set_channel_mode', toolName: 'channel-mode--set_channel_mode' },
    ]);
  });

  it('prefixes a leading digit', () => {
    const injected = buildInjectedTools(['3d-tools--render']);
    assert.deepStrictEqual(injected, [{ pyName: '_3d_tools__render', toolName: '3d-tools--render' }]);
  });

  it('skips colliding sanitized names loudly (first wins)', () => {
    const logs: string[] = [];
    const injected = buildInjectedTools(['a--b', 'a__b'], (m) => logs.push(m));
    assert.deepStrictEqual(injected, [{ pyName: 'a__b', toolName: 'a--b' }]);
    assert.strictEqual(logs.length, 1);
    assert.match(logs[0], /collides/);
  });
});

describe('PyRunner (real python3)', () => {
  it('runs a script and returns stdout', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("hello from python")', []);
      assert.strictEqual(result.returnCode, 0);
      assert.match(result.stdout, /hello from python/);
      assert.strictEqual(result.stderr, '');
    } finally {
      runner.dispose();
    }
  });

  it('round-trips a tool call as an awaited async function', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const runner = new PyRunner({
      onToolCall: async (name, args) => {
        calls.push({ name, args });
        return JSON.stringify({ echoed: args });
      },
    });
    try {
      const result = await runner.exec(
        [
          'import json',
          'r = json.loads(await test__echo({"message": "alpha"}))',
          'print("echoed:", r["echoed"]["message"])',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /echoed: alpha/);
      assert.deepStrictEqual(calls, [{ name: 'test--echo', args: { message: 'alpha' } }]);
    } finally {
      runner.dispose();
    }
  });

  it('supports the exact-name tools[...] escape hatch', async () => {
    const runner = new PyRunner({
      onToolCall: async (_name, args) => `got:${String(args.v)}`,
    });
    try {
      const result = await runner.exec(
        'print(await tools["test--echo"]({"v": 7}))',
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /got:7/);
    } finally {
      runner.dispose();
    }
  });

  it('runs parallel tool calls via asyncio.gather', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = new PyRunner({
      onToolCall: async (_name, args) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 150));
        inFlight--;
        return String(args.i);
      },
    });
    try {
      const result = await runner.exec(
        [
          'import asyncio',
          'results = await asyncio.gather(*(test__echo({"i": i}) for i in range(3)))',
          'print(",".join(results))',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /0,1,2/);
      assert.ok(maxInFlight >= 2, `expected parallel dispatch, max in flight was ${maxInFlight}`);
    } finally {
      runner.dispose();
    }
  });

  it('persists interpreter state across execs (container-reuse semantics)', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('x = 41', []);
      assert.strictEqual(first.returnCode, 0, first.stderr);
      const second = await runner.exec('print(x + 1)', []);
      assert.strictEqual(second.returnCode, 0, second.stderr);
      assert.match(second.stdout, /42/);
    } finally {
      runner.dispose();
    }
  });

  it('reports script exceptions as a traceback with return_code 1', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('raise ValueError("boom")', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /ValueError: boom/);
      assert.match(result.stderr, /Traceback/);
    } finally {
      runner.dispose();
    }
  });

  it('delivers tool errors as plain strings the script can handle', async () => {
    const runner = new PyRunner({
      onToolCall: async () => 'Error: Query timeout - table lock exceeded',
    });
    try {
      const result = await runner.exec(
        [
          'r = await test__echo({})',
          'if r.startswith("Error:"):',
          '    print("handled:", r)',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /handled: Error: Query timeout/);
    } finally {
      runner.dispose();
    }
  });

  it('raises TimeoutError inside the script when a tool call gets no response', async () => {
    const runner = new PyRunner({
      toolCallTimeoutMs: 1000,
      onToolCall: () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
    });
    try {
      const result = await runner.exec('await test__echo({})', ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /TimeoutError: Calling tool \['test--echo'\] timed out/);
    } finally {
      runner.dispose();
    }
  });

  it('cancels a script that exceeds the deadline', async () => {
    const runner = new PyRunner({
      scriptTimeoutMs: 1000,
      onToolCall: async () => '',
    });
    try {
      const started = Date.now();
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(60)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /cancelled by host/);
      assert.ok(Date.now() - started < 15_000, 'deadline cancel took too long');
    } finally {
      runner.dispose();
    }
  });

  it('abort() settles a running script and reclaims the interpreter', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const pending = runner.exec('import asyncio\nawait asyncio.sleep(60)', []);
      // Let the exec actually start before aborting.
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(runner.busy, true);
      runner.abort('test abort');
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, /aborted by host: test abort/);
      // Runner remains usable after reclaim (fresh interpreter, state gone).
      const after = await runner.exec('print("alive")', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.match(after.stdout, /alive/);
    } finally {
      runner.dispose();
    }
  });

  it('rejects concurrent execs on one runner', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = runner.exec('import asyncio\nawait asyncio.sleep(2)', []);
      await new Promise((r) => setTimeout(r, 300));
      const second = await runner.exec('print("nope")', []);
      assert.strictEqual(second.returnCode, 1);
      assert.match(second.stderr, /already running/);
      runner.abort('cleanup');
      await first;
    } finally {
      runner.dispose();
    }
  });

  it('reserves the runner during cold startup and allows immediate cancellation', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = runner.exec('import asyncio\nawait asyncio.sleep(60)', []);
      assert.strictEqual(runner.busy, true, 'startup must count as busy');
      const second = await runner.exec('print("must not run")', []);
      assert.match(second.stderr, /already running/);
      runner.abort('startup cancelled');
      assert.strictEqual((await first).aborted, true);
      const next = await runner.exec('print("fresh")', []);
      assert.strictEqual(next.returnCode, 0, next.stderr);
      assert.match(next.stdout, /fresh/);
    } finally { runner.dispose(); }
  });

  it('disposal during startup settles promptly', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    const result = runner.exec('print("must not run")', []);
    runner.dispose();
    assert.strictEqual((await result).aborted, true);
    assert.strictEqual(runner.busy, false);
  });

  it('keeps sub-second inner-tool timeouts instead of rounding them to zero', async () => {
    const runner = new PyRunner({
      toolCallTimeoutMs: 50,
      onToolCall: async () => { await new Promise(r => setTimeout(r, 300)); return 'too late'; },
    });
    try {
      const result = await runner.exec('print(await test__echo({}))', ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /TimeoutError/);
    } finally { runner.dispose(); }
  });

  it('does not deliver a late tool result to a replacement interpreter', async () => {
    let resolveOld!: (value: string) => void;
    let resolveNew!: (value: string) => void;
    let startedOld!: () => void;
    let startedNew!: () => void;
    const oldStarted = new Promise<void>(r => { startedOld = r; });
    const newStarted = new Promise<void>(r => { startedNew = r; });
    let calls = 0;
    const runner = new PyRunner({ onToolCall: async () => {
      if (++calls === 1) {
        startedOld();
        return new Promise<string>(r => { resolveOld = r; });
      }
      startedNew();
      return new Promise<string>(r => { resolveNew = r; });
    } });
    try {
      const old = runner.exec('print(await test__echo({}))', ECHO_TOOLS);
      await oldStarted;
      runner.abort('replace interpreter');
      await old;
      const fresh = runner.exec('print(await test__echo({}))', ECHO_TOOLS);
      await newStarted;
      resolveOld('STALE RESULT');
      // Give the old reply a chance to reach the new interpreter's t1 call.
      await new Promise(r => setTimeout(r, 100));
      resolveNew('CURRENT RESULT');
      const result = await fresh;
      assert.strictEqual(result.stdout.trim(), 'CURRENT RESULT');
    } finally { runner.dispose(); }
  });

  it('does not deliver a late wake acknowledgement to a replacement interpreter', async () => {
    let refuseOld!: (error: string | null) => void;
    let ackNew!: (error: string | null) => void;
    let startedOld!: () => void;
    let startedNew!: () => void;
    const oldStarted = new Promise<void>(r => { startedOld = r; });
    const newStarted = new Promise<void>(r => { startedNew = r; });
    let wakes = 0;
    const onWake = async (): Promise<string | null> => {
      if (++wakes === 1) {
        startedOld();
        return new Promise<string | null>(r => { refuseOld = r; });
      }
      startedNew();
      return new Promise<string | null>(r => { ackNew = r; });
    };
    const runner = new PyRunner({ onToolCall: async () => '' });
    const background = { logPath: null, lifetimeMs: 30_000, onWake };
    try {
      const old = runner.exec('await wake_agent("old")', [], background);
      await oldStarted;
      runner.abort('replace interpreter');
      await old;
      // The fresh interpreter numbers its wakes from w1 again.
      const fresh = runner.exec('await wake_agent("new")\nprint("acknowledged")', [], background);
      await newStarted;
      refuseOld('STALE REFUSAL');
      // Give the old refusal a chance to reach the new interpreter's w1 wake.
      await new Promise(r => setTimeout(r, 100));
      ackNew(null);
      const result = await fresh;
      assert.strictEqual(result.returnCode, 0, result.tail ?? result.stderr);
      assert.match(result.tail ?? '', /acknowledged/);
    } finally { runner.dispose(); }
  });

  it('fails gracefully when the python binary is missing', async () => {
    const runner = new PyRunner({
      pythonPath: '/definitely/not/a/python',
      onToolCall: async () => '',
    });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /Failed to start python runtime|exited before becoming ready/);
    } finally {
      runner.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Framework integration
// ---------------------------------------------------------------------------

class ScriptToolModule implements Module {
  readonly name = 'test';
  readonly calls: ToolCall[] = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echo input. Returns JSON: {"echoed": <input>}.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      {
        name: 'finish',
        description: 'End the turn.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const baseName = call.name.includes('--')
      ? call.name.slice(call.name.lastIndexOf('--') + 2)
      : call.name;
    if (baseName === 'finish') {
      return { success: true, data: { finished: true }, endTurn: true };
    }
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const content = Array.isArray((event as { content?: unknown }).content)
        ? ((event as { content: unknown }).content as Array<{ type: string; text?: string }>)
        : [{ type: 'text', text: String((event as { content?: unknown }).content) }];
      return {
        addMessages: [{ participant: 'User', content: content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store.chronicle') };
}

async function createFrameworkWithCodeExecution(storePath: string, membrane: MockMembrane, module: Module) {
  return AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: [],
    modules: [module],
    syncIntervalMs: 0,
    codeExecution: { enabled: true },
  });
}

describe('framework code_execution integration (real python3)', () => {
  it('synthesizes the tool only when enabled', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-tools-');
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
    });
    try {
      assert.ok(!framework.getAllTools().some((t) => t.name === 'code_execution'));
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }

    const { tempDir: tempDir2, storePath: storePath2 } = tempStorePath('pytc-tools2-');
    const membrane2 = new MockMembrane();
    const framework2 = await createFrameworkWithCodeExecution(storePath2, membrane2, new ScriptToolModule());
    try {
      const tool = framework2.getAllTools().find((t) => t.name === 'code_execution');
      assert.ok(tool, 'code_execution tool should be synthesized');
      assert.match(tool.description, /async Python function/);
      assert.match(tool.description, /__/);
    } finally {
      await framework2.stop();
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('runs a script that calls module tools; intermediates never reach the model', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-run-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();

    const code = [
      'import json',
      'names = []',
      'for m in ["alpha", "beta"]:',
      '    r = json.loads(await test__echo({"message": m}))',
      '    names.append(r["echoed"]["message"].upper())',
      'print("summary:", "+".join(names))',
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Let me fan out.' },
      { type: 'tool_use', id: 'call_ce_1', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Final answer.' },
    ]));

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'worker',
        model: 'test-model',
        systemPrompt: 'Do the task.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await promise;

      assert.strictEqual(result.speech, 'Final answer.');

      // The module saw both inner calls, dispatched with pytc- IDs (waiter
      // path), not the model's call ID.
      const echoCalls = module.calls.filter((c) => c.name.endsWith('--echo') || c.name === 'echo');
      assert.strictEqual(echoCalls.length, 2);
      for (const call of echoCalls) {
        assert.match(String(call.id), /^pytc-/);
      }

      // The model-facing tool_result carries the script's stdout...
      const stream = membrane.lastStream!;
      assert.strictEqual(stream.receivedToolResults.length, 1);
      const wireResult = stream.receivedToolResults[0][0] as { toolUseId: string; content: string };
      assert.strictEqual(wireResult.toolUseId, 'call_ce_1');
      assert.match(wireResult.content, /summary: ALPHA\+BETA/);
      assert.match(wireResult.content, /"return_code":\s*0/);
      // ...and NOT the intermediate tool results.
      assert.ok(
        !wireResult.content.includes('"echoed"'),
        'intermediate tool results must not reach the model-facing result',
      );
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('an ephemeral agent waits for its script to finish instead of being promised a wake', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-ephemeral-wait-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_slow', name: 'code_execution',
        input: { code: 'import asyncio\nawait asyncio.sleep(0.3)\nprint("ephemeral done")', wait_ms: 0 } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
      codeExecution: { enabled: true, foregroundWaitMs: 5 },
    });
    try {
      const created = await framework.createEphemeralAgent({
        name: 'helper', model: 'test-model', systemPrompt: 'Help.', allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      await promise;
      const wire = membrane.lastStream!.receivedToolResults[0][0] as { content: string };
      assert.match(wire.content, /ephemeral done/);
      assert.doesNotMatch(wire.content, /Still running/);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defers endTurn from inner calls to the code_execution result', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-endturn-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();

    const code = [
      'r = await test__finish({})',
      'print("after finish:", r)',
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Finishing via script.' },
      { type: 'tool_use', id: 'call_ce_2', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    // No further response: endTurn must settle the turn without another round.

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'finisher',
        model: 'test-model',
        systemPrompt: 'Finish.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Wrap up.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await promise;

      // The script ran to completion (endTurn was deferred, not applied
      // mid-script), and the turn then ended without another model round.
      const finishCalls = module.calls.filter((c) => c.name.endsWith('--finish') || c.name === 'finish');
      assert.strictEqual(finishCalls.length, 1);
      assert.strictEqual(result.toolCallsCount, 1); // one model-visible call: code_execution
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Background scripts (wake_agent) + spill-to-file
// ---------------------------------------------------------------------------

describe('PyRunner background mode (real python3)', () => {
  it('wake_agent reports the caller line and payload; log file journals output', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bg-'));
    const logPath = join(tempDir, 'nested', 'bg.log');
    const wakes: Array<{ line: number; payload: unknown }> = [];
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = [
        'print("watcher starting")',        // line 1
        'x = 1',                            // line 2
        'await wake_agent({"hit": x})',     // line 3
        'print("after wake")',              // line 4
      ].join('\n');
      const result = await runner.exec(code, [], {
        logPath,
        lifetimeMs: 30_000,
        onWake: async (line, payload) => {
          wakes.push({ line, payload });
          return null;
        },
      });
      assert.strictEqual(result.returnCode, 0, result.tail ?? '');
      assert.strictEqual(wakes.length, 1);
      assert.strictEqual(wakes[0].line, 3);
      assert.deepStrictEqual(wakes[0].payload, { hit: 1 });
      const { readFileSync } = await import('node:fs');
      const log = readFileSync(logPath, 'utf8');
      assert.match(log, /watcher starting/);
      assert.match(log, /after wake/);
      assert.match(result.tail ?? '', /after wake/);
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a refused wake raises RuntimeError inside the script', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('await wake_agent({"n": 1})', [], {
        logPath: null,
        lifetimeMs: 30_000,
        onWake: async () => 'wake limit reached (test)',
      });
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.tail ?? '', /RuntimeError: wake_agent refused by host: wake limit reached/);
    } finally {
      runner.dispose();
    }
  });

  it('wake_agent is absent in foreground scripts', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("wake_agent" in globals())', []);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /False/);
    } finally {
      runner.dispose();
    }
  });
});

describe('framework background scripts + spill (real python3)', () => {
  async function createBgFramework(storePath: string, membrane: MockMembrane, opts?: {
    mountDir?: string;
    codeExecution?: Record<string, unknown>;
  }) {
    const { WorkspaceModule } = await import('../src/modules/workspace/index.js');
    const modules: Module[] = [new ScriptToolModule()];
    let workspace: InstanceType<typeof WorkspaceModule> | null = null;
    if (opts?.mountDir) {
      workspace = new WorkspaceModule({
        mounts: [{ name: 'files', path: opts.mountDir, mode: 'read-write', watch: 'never' }],
      });
      modules.push(workspace as unknown as Module);
    }
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
      }],
      modules,
      syncIntervalMs: 0,
      codeExecution: {
        enabled: true,
        wakeMinIntervalMs: 0,
        ...(opts?.codeExecution ?? {}),
      },
    });
    // Host wiring (fkm does this in production): mounts populate in initStore.
    workspace?.initStore(framework.getStore());
    return framework;
  }

  it('yields foreground await, retains its result, and preserves interpreter state', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-yield-');
    const framework = await createBgFramework(storePath, new MockMembrane(), {
      codeExecution: { foregroundWaitMs: 5 },
    });
    const call = (input: Record<string, unknown>) => framework.executeToolCall({
      id: `test-${Math.random()}`, name: 'code_execution', callerAgentName: 'prime', input,
    });
    try {
      const started = await call({ code: 'import asyncio\nx = 41\nawait asyncio.sleep(0.25)\nprint("finished")' });
      const id = (started.data as { script_id: string }).script_id;
      assert.equal((started.data as { status: string }).status, 'running');
      assert.equal(started.endTurn, undefined);
      const busy = await call({ code: 'print("must not run")' });
      assert.equal(busy.isError, true);
      assert.match(busy.error ?? '', new RegExp(id));
      const done = await call({ action: 'wait', script_id: id, wait_ms: 3000 });
      assert.equal((done.data as { stdout: string }).stdout.trim(), 'finished');
      assert.equal((done.data as { return_code: number }).return_code, 0);
      assert.equal((done.data as { status: string }).status, 'finished');
      const reused = await call({ code: 'print(x + 1)', wait_ms: 3000 });
      assert.equal((reused.data as { stdout: string }).stdout.trim(), '42');
      const reread = await call({ action: 'wait', script_id: id, wait_ms: 0 });
      assert.equal((reread.data as { stdout: string }).stdout.trim(), 'finished');
      const wrongOwner = await framework.executeToolCall({
        id: 'wrong-owner', name: 'code_execution', callerAgentName: 'someone-else',
        input: { action: 'wait', script_id: id },
      });
      assert.equal(wrongOwner.isError, true);
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  for (const releaseBy of ['agent', 'operator'] as const) {
    it(`${releaseBy} can end a waiting turn while the script survives to wake it`, async () => {
      const { tempDir, storePath } = tempStorePath('pytc-wait-wake-');
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{
        type: 'tool_use', id: 'wait-call', name: 'code_execution', input: {
          code: 'import asyncio\nawait asyncio.sleep(0.4)\nprint("completion payload")',
          wait_ms: releaseBy === 'agent' ? 0 : 60_000,
          on_timeout: releaseBy === 'agent' ? 'end_turn' : 'continue',
        },
      }], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'I saw completion.' }]));
      const framework = await createBgFramework(storePath, membrane);
      try {
        framework.start();
        framework.pushEvent({ type: 'external-message', source: 'test',
          content: [{ type: 'text', text: 'run and rest' }], metadata: {}, triggerInference: true } as ProcessEvent);
        const deadline = Date.now() + 5000;
        if (releaseBy === 'operator') {
          let released = false;
          while (!released && Date.now() < deadline) {
            const list = await framework.executeToolCall({ id: 'list', name: 'code_execution',
              callerAgentName: 'prime', input: { action: 'list' } });
            const scripts = (list.data as { scripts: { script_id: string; status: string }[] }).scripts;
            if (scripts[0]?.status === 'running') {
              assert.deepEqual(framework.releaseCodeExecutionWait('prime'), { released: 1 });
              released = true;
            } else await new Promise(r => setTimeout(r, 5));
          }
          assert.ok(released, 'operator should find an active wait');
        }
        while (membrane.calls.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
        assert.equal(membrane.calls.length, 2, 'completion must start a second inference');
        assert.match(JSON.stringify(membrane.calls[1]), /completion payload/);
        const messages = framework.getAgent('prime')!.getContextManager().queryMessages({}).messages;
        const results = messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
        assert.ok(results.some(b => JSON.parse((b as { content: string }).content).status === 'running'));
        // The second response must not be consumed by a continuation BEFORE completion.
        assert.match(JSON.stringify(messages), /I saw completion|completion payload/);
      } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
    });
  }

  it('cancels a yielded foreground run and reports its retained cancellation', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-yield-cancel-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    const call = (input: Record<string, unknown>) => framework.executeToolCall({
      id: 'test', name: 'code_execution', callerAgentName: 'prime', input,
    });
    try {
      const started = await call({ code: 'prior = 1\nimport asyncio\nawait asyncio.sleep(60)', wait_ms: 0 });
      const id = (started.data as { script_id: string }).script_id;
      await call({ action: 'cancel', script_id: id });
      const result = await call({ action: 'wait', script_id: id });
      assert.equal((result.data as { status: string }).status, 'cancelled');
      assert.equal((result.data as { aborted: boolean }).aborted, true);
      const next = await call({ code: 'print("prior" in globals())' });
      assert.equal((next.data as { stdout: string }).stdout.trim(), 'False', 'cancel must reclaim the interpreter');
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(r => setTimeout(r, 10));
    }
  };
  const statusOf = async (framework: AgentFramework, id: string) => {
    const list = await framework.executeToolCall({ id: 'list', name: 'code_execution', callerAgentName: 'prime', input: { action: 'list' } });
    return (list.data as { scripts: { script_id: string; status: string }[] }).scripts.find(s => s.script_id === id)?.status;
  };
  const idOf = (r: ToolResult) => (r.data as { script_id: string }).script_id;
  const stdoutOf = (r: ToolResult) => (r.data as { stdout: string }).stdout.trim();

  it('an inner end-turn ends only a turn that is still waiting on the script', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-late-endturn-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    const call = (input: Record<string, unknown>) => framework.executeToolCall({
      id: `t-${Math.random()}`, name: 'code_execution', callerAgentName: 'prime', input,
    });
    try {
      framework.start();
      const observed = await call({ code: 'await test__finish({})\nprint("observed")', wait_ms: 5000 });
      assert.equal(stdoutOf(observed), 'observed');
      assert.equal(observed.endTurn, true, 'the waiting call carries the end-turn');

      const started = await call({ code: 'import asyncio\nawait asyncio.sleep(0.2)\nawait test__finish({})\nprint("late")', wait_ms: 0 });
      const id = idOf(started);
      assert.equal(started.endTurn, undefined);
      await until(async () => (await statusOf(framework, id)) === 'finished', 'the yielded script to finish');
      const retrieved = await call({ action: 'wait', script_id: id, wait_ms: 0 });
      assert.equal(stdoutOf(retrieved), 'late');
      assert.equal(retrieved.endTurn, undefined, 'a late end-turn must not end the turn that retrieves the result');
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it("a background script's inner end-turn never ends a foreground call", async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bg-endturn-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    const call = (input: Record<string, unknown>) => framework.executeToolCall({
      id: `t-${Math.random()}`, name: 'code_execution', callerAgentName: 'prime', input,
    });
    try {
      framework.start();
      const foreground = call({ code: 'import asyncio\nawait asyncio.sleep(0.5)\nprint("fg")', wait_ms: 5000 });
      const background = await call({ background: true, code: 'await test__finish({})\nprint("bg")' });
      const bgId = idOf(background);
      const fg = await foreground;
      assert.equal(stdoutOf(fg), 'fg');
      await until(async () => (await statusOf(framework, bgId)) === 'finished', 'the background script to finish');
      assert.equal(fg.endTurn, undefined, "the background script's end-turn must not land on the foreground call");
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('a failed turn stops the script it is waiting on, never one it already left running', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-abort-observed-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    const call = (input: Record<string, unknown>) => framework.executeToolCall({
      id: `t-${Math.random()}`, name: 'code_execution', callerAgentName: 'prime', input,
    });
    const streamFailed = () => (framework as unknown as { abortAgentScript(a: string, r: string): void })
      .abortAgentScript('prime', 'stream error');
    try {
      const yielded = await call({ code: 'import asyncio\nawait asyncio.sleep(0.3)\nprint("survived")', wait_ms: 0 });
      streamFailed();
      const survived = await call({ action: 'wait', script_id: idOf(yielded), wait_ms: 5000 });
      assert.equal(stdoutOf(survived), 'survived');

      const observed = call({ code: 'import asyncio\nawait asyncio.sleep(30)', wait_ms: 30_000 });
      const records = (framework as unknown as { codeExecutionScripts: Map<string, { status: string; run: { observing: boolean } }> }).codeExecutionScripts;
      await until(() => [...records.values()].some(r => r.status === 'running' && r.run.observing), 'the observed script');
      streamFailed();
      const aborted = await observed;
      assert.equal((aborted.data as { aborted?: boolean }).aborted, true);
      assert.equal((aborted.data as { status: string }).status, 'died');
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('a pending rate-limited wake is released when its script ends', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-wake-release-');
    const framework = await createBgFramework(storePath, new MockMembrane(), {
      codeExecution: { wakeMinIntervalMs: 60_000 },
    });
    try {
      const started = await framework.executeToolCall({ id: 'bg', name: 'code_execution', callerAgentName: 'prime',
        input: { background: true, time_limit_ms: 1000, code: 'await wake_agent("first")\nawait wake_agent("second")' } });
      const id = idOf(started);
      const record = (framework as unknown as { codeExecutionScripts: Map<string, { wakes: number; wakeQueue: Promise<unknown> }> })
        .codeExecutionScripts.get(id)!;
      await until(() => record.wakes === 1, 'the first wake');
      // The second wake now sits behind the 60 s floor; the 1 s limit ends the script.
      await until(async () => (await statusOf(framework, id)) !== 'running', 'the time limit');
      const outcome = await Promise.race([
        record.wakeQueue.then(() => 'released'),
        new Promise(r => setTimeout(() => r('still waiting'), 1000)),
      ]);
      assert.equal(outcome, 'released');
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('a result announced by a completion notice is kept until retrieved', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-announced-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    const call = (input: Record<string, unknown>) => framework.executeToolCall({
      id: `t-${Math.random()}`, name: 'code_execution', callerAgentName: 'prime', input,
    });
    try {
      const id = idOf(await call({ code: 'import asyncio\nawait asyncio.sleep(0.1)\nprint("kept")', wait_ms: 0 }));
      await until(async () => (await statusOf(framework, id)) === 'finished', 'the yielded script');
      const notice = framework.getAgent('prime')!.getContextManager().queryMessages({}).messages
        .find(m => (m.metadata as { scriptId?: string } | undefined)?.scriptId === id);
      assert.ok(notice, 'a completion notice was delivered');
      assert.match(JSON.stringify(notice.content), /kept until you retrieve it/);
      assert.equal((notice.metadata as { system?: boolean }).system, true, 'completion notices are system messages');
      for (let i = 0; i < 6; i++) await call({ code: `print(${i})`, wait_ms: 5000 });
      const retrieved = await call({ action: 'wait', script_id: id, wait_ms: 0 });
      assert.equal(stdoutOf(retrieved), 'kept', 'newer results must not evict an announced, unretrieved one');
      // Once retrieved it is an ordinary result again and ages out.
      for (let i = 0; i < 6; i++) await call({ code: `print(${i})`, wait_ms: 5000 });
      assert.equal((await call({ action: 'wait', script_id: id, wait_ms: 0 })).isError, true);
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('quiesce drains scripts that outlived their turn; abandon stops them and spares watchers', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-quiesce-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    const call = (input: Record<string, unknown>) => framework.executeToolCall({
      id: `t-${Math.random()}`, name: 'code_execution', callerAgentName: 'prime', input,
    });
    try {
      const fg = idOf(await call({ code: 'import asyncio\nawait asyncio.sleep(60)', wait_ms: 0 }));
      const bg = idOf(await call({ background: true, code: 'import asyncio\nawait asyncio.sleep(60)' }));
      const drained = await framework.quiesce({ reason: 'test', timeoutMs: 1000 });
      assert.equal(drained.drained, false, 'a running foreground script is not quiet');
      assert.equal(drained.foregroundScripts, 1);
      assert.equal(drained.backgroundScripts, 1);
      const abandoned = await framework.quiesce({ abandon: true });
      assert.equal(abandoned.drained, true);
      assert.equal(abandoned.foregroundScripts, 0);
      assert.equal(abandoned.backgroundScripts, 1, 'background watchers keep running');
      assert.equal(await statusOf(framework, fg), 'died');
      assert.equal(await statusOf(framework, bg), 'running');
      assert.ok(abandoned.deferredWrites >= 1, 'the owner hears about the stopped script at resume');
      await framework.resume();
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('serializes concurrent wake requests across the rate floor and cap', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-wake-limit-');
    const framework = await createBgFramework(storePath, new MockMembrane(), {
      codeExecution: { wakeMinIntervalMs: 30, maxWakesPerScript: 2 },
    });
    const times: number[] = [];
    const delivery = framework as unknown as { addMessage: (...args: unknown[]) => string };
    const add = delivery.addMessage.bind(framework);
    delivery.addMessage = (...args) => { times.push(Date.now()); return add(...args); };
    try {
      const result = await framework.executeToolCall({ id: 'wake-limit', name: 'code_execution', callerAgentName: 'prime',
        input: { background: true, wait_ms: 3000, code:
          'import asyncio\nawait wake_agent("first")\nr = await asyncio.gather(wake_agent("second"), wake_agent("third"), return_exceptions=True)\nprint(r)' } });
      assert.match((result.data as { tail: string }).tail, /wake limit reached/);
      assert.equal(times.length, 2);
      assert.ok(times[1] - times[0] >= 25, `wakes were only ${times[1] - times[0]}ms apart`);
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('refuses a wake if context delivery failed instead of falsely acknowledging it', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-wake-fail-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    (framework as unknown as { addMessage: () => string }).addMessage = () => { throw new Error('storage unavailable'); };
    try {
      const result = await framework.executeToolCall({ id: 'wake-fail', name: 'code_execution', callerAgentName: 'prime',
        input: { background: true, wait_ms: 3000, code:
          'try:\n    await wake_agent("signal")\nexcept RuntimeError as e:\n    print(str(e))' } });
      assert.match((result.data as { tail: string }).tail, /wake injection failed: storage unavailable/);
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('returns an observed background failure without an extra crash wake', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-observed-crash-');
    const framework = await createBgFramework(storePath, new MockMembrane());
    let notifications = 0;
    (framework as unknown as { addMessage: () => string }).addMessage = () => { notifications++; return ''; };
    try {
      const result = await framework.executeToolCall({ id: 'observed-crash', name: 'code_execution', callerAgentName: 'prime',
        input: { background: true, wait_ms: 3000, code: 'raise ValueError("observed failure")' } });
      assert.equal((result.data as { return_code: number }).return_code, 1);
      assert.match((result.data as { tail: string }).tail, /observed failure/);
      assert.equal(notifications, 0);
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });

  it('background script detaches, wakes the agent with provenance, and triggers inference', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgfw-');
    const mountDir = join(tempDir, 'mount');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(mountDir, { recursive: true });
    const membrane = new MockMembrane();

    const bgCode = [
      'import asyncio',
      'await asyncio.sleep(0.2)',
      'await wake_agent({"found": "signal"})',
    ].join('\\n');

    // Turn 1: spawn the background script, then finish the turn.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Arming watcher.' },
      { type: 'tool_use', id: 'call_bg1', name: 'code_execution', input: { code: bgCode.split('\\n').join('\n'), background: true } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Watcher armed; resting.' }]));
    // Turn 2 (the wake): agent answers.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Woke and handled.' }]));

    const framework = await createBgFramework(storePath, membrane, { mountDir });
    try {
      framework.start();
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'arm a watcher' }],
        metadata: {},
        triggerInference: true,
      } as unknown as ProcessEvent);

      // Wait for: turn 1 result mentions script started, then wake message lands.
      const deadline = Date.now() + 20_000;
      let wakeMessage: { content: ContentBlockLike[] } | null = null;
      while (Date.now() < deadline && !wakeMessage) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        wakeMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
      }
      assert.ok(wakeMessage, 'wake message should be injected');
      const text = (wakeMessage.content[0] as { text?: string }).text ?? '';
      assert.match(text, /\[background script bg-\d+\] Woke you/);
      assert.match(text, /line 3 of your script/);
      assert.match(text, /"found": "signal"/);
      assert.match(text, /workspace file files\/background-scripts\/bg-\d+\.log/);
      assert.match(text, /Script status: still running|Script status/);
      assert.notEqual((wakeMessage as { metadata?: { system?: boolean } }).metadata?.system, true,
        'a wake_agent payload is the script speaking to its agent, not a system marker');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('list and cancel manage the daemon fleet; cap enforced', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bglist-');
    const membrane = new MockMembrane();
    const framework = await createBgFramework(storePath, membrane, {
      codeExecution: { maxBackgroundScripts: 1 },
    });
    try {
      const idle = 'import asyncio\nawait asyncio.sleep(60)';
      const first = await framework.executeToolCall({
        id: 'c1', name: 'code_execution', input: { code: idle, background: true }, callerAgentName: 'prime',
      });
      assert.strictEqual(first.success, true, JSON.stringify(first));
      const firstId = (first.data as { script_id: string }).script_id;

      const second = await framework.executeToolCall({
        id: 'c2', name: 'code_execution', input: { code: idle, background: true }, callerAgentName: 'prime',
      });
      assert.strictEqual(second.isError, true);
      assert.match(String(second.error), /limit reached/);

      const list = await framework.executeToolCall({
        id: 'c3', name: 'code_execution', input: { action: 'list' }, callerAgentName: 'prime',
      });
      const scripts = (list.data as { background_scripts: Array<{ script_id: string; status: string }> }).background_scripts;
      assert.strictEqual(scripts.filter((s) => s.status === 'running').length, 1);

      const cancel = await framework.executeToolCall({
        id: 'c4', name: 'code_execution', input: { action: 'cancel', script_id: firstId }, callerAgentName: 'prime',
      });
      assert.strictEqual(cancel.success, true);
      assert.strictEqual((cancel.data as { status: string }).status, 'cancelled');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('crashed background script wakes the agent with the error tail', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgcrash-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const framework = await createBgFramework(storePath, membrane, {});
    try {
      framework.start();
      const started = await framework.executeToolCall({
        id: 'c1',
        name: 'code_execution',
        input: { code: 'import asyncio\nawait asyncio.sleep(0.1)\nraise ValueError("watcher exploded")', background: true },
        callerAgentName: 'prime',
      });
      assert.strictEqual(started.success, true, JSON.stringify(started));

      const deadline = Date.now() + 20_000;
      let crashMessage: { content: ContentBlockLike[] } | null = null;
      while (Date.now() < deadline && !crashMessage) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        crashMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
      }
      assert.ok(crashMessage, 'crash wake should be injected');
      const text = (crashMessage.content[0] as { text?: string }).text ?? '';
      assert.match(text, /DIED/);
      assert.match(text, /ValueError: watcher exploded/);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('oversized tool results spill to a workspace file with a reference', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-spill-');
    const mountDir = join(tempDir, 'mount');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(mountDir, { recursive: true });
    const membrane = new MockMembrane();

    // big module: returns ~600KB (strategy default maxMessageTokens absent →
    // maxChars undefined → no spill). Force the cap via agent_settings-style
    // override path by configuring a small maxMessageTokens on the agent.
    class BigToolModule implements Module {
      readonly name = 'big';
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] {
        return [{ name: 'blob', description: 'Returns JSON: huge string.', inputSchema: { type: 'object', properties: {} } }];
      }
      async handleToolCall(): Promise<ToolResult> {
        return { success: true, data: { blob: 'x'.repeat(600_000) } };
      }
      async onProcess(event: ProcessEvent): Promise<EventResponse> {
        if (event.type === 'external-message') {
          return {
            addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
            requestInference: true,
          };
        }
        return {};
      }
    }

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Fetching blob.' },
      { type: 'tool_use', id: 'call_blob', name: 'big--blob', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));

    const { WorkspaceModule } = await import('../src/modules/workspace/index.js');
    const spillWorkspace = new WorkspaceModule({
      mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }],
    });
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
        strategy: new CappedPassthroughStrategy() as never,
      }],
      modules: [
        new BigToolModule(),
        spillWorkspace as unknown as Module,
      ],
      syncIntervalMs: 0,
      codeExecution: { enabled: true },
    });
    spillWorkspace.initStore(framework.getStore());
    try {
      framework.start();
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'get the blob' }],
        metadata: {},
        triggerInference: true,
      } as unknown as ProcessEvent);

      const deadline = Date.now() + 20_000;
      let toolResultText: string | null = null;
      while (Date.now() < deadline && !toolResultText) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: Array<{ type: string; content?: string }> }>;
        for (const m of msgs) {
          for (const b of m.content ?? []) {
            if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('[truncated')) {
              toolResultText = b.content;
            }
          }
        }
      }
      assert.ok(toolResultText, 'spilled tool result should be stored');
      assert.match(toolResultText, /full content: workspace file files\/tool-results\//);
      assert.match(toolResultText, /tool_result_inline_max_chars/);
      assert.ok(toolResultText.length < 20_000, 'inline copy must be capped');
      // The full content lives in the chronicle tree — the same place the
      // agent's own read tool looks (disk materialization is async and
      // watch-mode-dependent; not what we're testing here).
      const refMatch = toolResultText.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(refMatch, 'reference should name the spill file');
      const spilledFile = await spillWorkspace.readBinary(refMatch[1]);
      assert.ok('data' in spilledFile, `spill file should be readable: ${JSON.stringify(spilledFile)}`);
      assert.ok((spilledFile as { data: Buffer }).data.byteLength >= 600_000, 'full content in file');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

type ContentBlockLike = { type: string; text?: string };

import { PassthroughStrategy } from '../src/index.js';
class CappedPassthroughStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 1000;
}

describe('code_execution per-call time limit (time_limit_ms)', () => {
  it('PyRunner: a per-exec deadline replaces scriptTimeoutMs, and the result says the time ran out', async () => {
    const runner = new PyRunner({ scriptTimeoutMs: 600_000, onToolCall: async () => '' });
    try {
      const started = Date.now();
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(60)', [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 15_000, 'the per-exec deadline was not applied');
    } finally {
      runner.dispose();
    }
  });

  it('PyRunner: a script that catches the cancellation and finishes is not reported as stopped', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = 'import asyncio\ntry:\n    await asyncio.sleep(60)\nexcept asyncio.CancelledError:\n    print("cleaned up")';
      const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /cleaned up/);
      assert.doesNotMatch(result.stderr, /script stopped/);
    } finally {
      runner.dispose();
    }
  });

  it('PyRunner: a deadline beyond Node timers (~24.8 days) is clamped, not fired at once', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(0.3)\nprint("done")', [], undefined, { deadlineMs: 30 * 86_400_000 });
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /done/);
    } finally {
      runner.dispose();
    }
  });

  it('a ceiling below the default is refused when the framework is created', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-badcfg-');
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath,
          membrane: new MockMembrane().asMembrane(),
          agents: [],
          modules: [],
          syncIntervalMs: 0,
          codeExecution: { enabled: true, scriptTimeoutMs: 600_000, maxScriptTimeoutMs: 60_000 },
        }),
        /maxScriptTimeoutMs \(60000\) must be at least scriptTimeoutMs \(600000\)/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('an out-of-range foregroundWaitMs is refused when the framework is created', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-badwait-');
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath,
          membrane: new MockMembrane().asMembrane(),
          agents: [],
          modules: [],
          syncIntervalMs: 0,
          codeExecution: { enabled: true, foregroundWaitMs: 120_000 },
        }),
        /foregroundWaitMs \(120000\) must be an integer from 0 to 60000/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function withFramework(
    codeExecution: Record<string, unknown>,
    body: (framework: AgentFramework) => Promise<void>,
  ): Promise<void> {
    const { tempDir, storePath } = tempStorePath('pytc-timeout-');
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
      codeExecution: { enabled: true, ...codeExecution },
    });
    try {
      await body(framework);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const run = (framework: AgentFramework, input: Record<string, unknown>) =>
    framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
  const dataOf = (r: ToolResult) => r.data as { stdout: string; stderr: string; return_code: number; time_limit_note?: string };

  it('the tool tells the agent its time limit and offers time_limit_ms', async () => {
    await withFramework({ scriptTimeoutMs: 300_000, maxScriptTimeoutMs: 1_800_000 }, async (framework) => {
      const tool = framework.getAllTools().find((t) => t.name === 'code_execution')!;
      assert.match(tool.description, /A foreground script is stopped after 5 min; pass time_limit_ms to set this call's limit \(at most 30 min; a background script runs up to 24 h\)/);
      const props = (tool.inputSchema as { properties: Record<string, { description: string }> }).properties;
      assert.match(props.time_limit_ms.description, /Default 300000, at most 1800000/);
    });
  });

  it('time_limit_ms shortens one call; the deployment default is unchanged for the next', async () => {
    await withFramework({ scriptTimeoutMs: 600_000 }, async (framework) => {
      const short = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', time_limit_ms: 1000 }));
      assert.strictEqual(short.return_code, 1);
      assert.match(short.stderr, /reached its 1s time limit/);
      const normal = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(1.5)\nprint("done")' }));
      assert.strictEqual(normal.return_code, 0);
      assert.match(normal.stdout, /done/);
    });
  });

  it('a request above the ceiling is capped, and the result says so', async () => {
    await withFramework({ scriptTimeoutMs: 1000 }, async (framework) => {
      const started = Date.now();
      const r = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', time_limit_ms: 60_000 }));
      assert.strictEqual(r.return_code, 1);
      assert.strictEqual(r.time_limit_note, "time_limit_ms 60000 was capped at 1000, this deployment's maximum");
      assert.ok(Date.now() - started < 15_000, 'the cap was not applied');
    });
  });

  it('maxScriptTimeoutMs lets an agent ask for longer than the default', async () => {
    await withFramework({ scriptTimeoutMs: 1000, maxScriptTimeoutMs: 10_000 }, async (framework) => {
      const code = 'import asyncio\nawait asyncio.sleep(2)\nprint("long done")';
      const defaulted = dataOf(await run(framework, { code }));
      assert.strictEqual(defaulted.return_code, 1, 'without time_limit_ms the 1s default applies');
      const longer = dataOf(await run(framework, { code, time_limit_ms: 5000 }));
      assert.strictEqual(longer.return_code, 0);
      assert.match(longer.stdout, /long done/);
      assert.strictEqual(longer.time_limit_note, undefined);
    });
  });

  it('an invalid time_limit_ms is refused before anything runs', async () => {
    await withFramework({}, async (framework) => {
      for (const time_limit_ms of ['soon', 10, -5, Number.NaN]) {
        const r = await run(framework, { code: 'print("ran")', time_limit_ms });
        assert.strictEqual(r.success, false, String(time_limit_ms));
        assert.match(String(r.error), /time_limit_ms/);
      }
    });
  });

  it('a background script: time_limit_ms shortens its lifetime, capped at the lifetime ceiling', async () => {
    await withFramework({ backgroundMaxLifetimeMs: 1500 }, async (framework) => {
      const r = await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', background: true, time_limit_ms: 60_000 });
      assert.strictEqual(r.success, true);
      const data = r.data as { script_id: string; time_limit_note?: string; lifetime: string };
      assert.strictEqual(data.time_limit_note, "time_limit_ms 60000 was capped at 1500, this deployment's maximum");
      assert.strictEqual(data.lifetime, '2s', 'a short lifetime is reported exactly, not rounded to 0 hours');
      let status = 'running';
      const until = Date.now() + 15_000;
      while (status === 'running' && Date.now() < until) {
        await new Promise((res) => setTimeout(res, 200));
        const listed = (await run(framework, { action: 'list' })).data as { background_scripts: Array<{ script_id: string; status: string }> };
        status = listed.background_scripts.find((s) => s.script_id === data.script_id)?.status ?? 'gone';
      }
      assert.strictEqual(status, 'died', 'the script was stopped at its capped lifetime');
    });
  });
});
