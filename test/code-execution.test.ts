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
