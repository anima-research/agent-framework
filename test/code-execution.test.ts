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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { AgentFramework, PYTHON_RUNTIME_SOURCE, PyRunner, buildInjectedTools } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';
import { PYTC_STOP_ROWS_DRIVER } from './helpers/pytc-stop-rows.js';

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
  it("no two runners' interpreters share a number, so a mark keyed by one can't match another's", async () => {
    const first = new PyRunner({ onToolCall: async () => '' });
    const second = new PyRunner({ onToolCall: async () => '' });
    try {
      assert.strictEqual(first.interpreter, null, 'no interpreter before the first script');
      await first.exec('x = 1', []);
      await second.exec('x = 1', []);
      assert.notStrictEqual(first.interpreter, null);
      assert.notStrictEqual(second.interpreter, null);
      assert.notStrictEqual(first.interpreter, second.interpreter, 'each interpreter has its own number');
    } finally {
      first.dispose();
      second.dispose();
    }
    assert.strictEqual(first.interpreter, null, 'and none once the runner is disposed');
  });

  it('an interpreter killed by a signal the runner didn\'t send has no number: it is gone', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      await runner.exec('x = 1', []);
      const child = (runner as unknown as { child: import('node:child_process').ChildProcess }).child;
      assert.notStrictEqual(runner.interpreter, null, 'live while it runs');
      const exited = new Promise((resolve) => child.once('exit', resolve));
      process.kill(child.pid!, 'SIGKILL');
      await exited;
      assert.equal(child.killed, false, 'the runner sent no signal');
      assert.strictEqual(runner.interpreter, null, 'and once the signal ended it, none is live');
    } finally {
      runner.dispose();
    }
  });

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

  it('rejects a second exec issued before the first has started (same tick)', async () => {
    // exec() awaits the interpreter before it records the running script, so
    // a check made only after that await let two execs in at once.
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      for (const warm of [false, true]) {
        const first = runner.exec('import asyncio\nawait asyncio.sleep(0.2)\nprint("first ran")', []);
        const second = runner.exec('print("second ran")', []);
        const [a, b] = await Promise.race([
          Promise.all([first, second]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`warm=${warm}: an exec never settled`)), 10_000)),
        ]);
        assert.strictEqual(b.returnCode, 1, `warm=${warm}`);
        assert.match(b.stderr, /already running/);
        assert.strictEqual(a.returnCode, 0, `warm=${warm}: ${a.stderr}`);
        assert.match(a.stdout, /first ran/);
        assert.ok(!a.stdout.includes('second ran') && !b.stdout.includes('second ran'));
      }
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

// Inner-call ids restart in every interpreter: a result that outlives its
// interpreter must not resolve a call of the one that replaced it.
describe('code_execution inner-call results after the interpreter is replaced (real python3)', () => {
  const until = async (cond: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const stops: Record<string, { code: string; stop?: (runner: PyRunner) => void }> = {
    aborted: { code: 'print(await test__echo({}))', stop: (runner) => runner.abort('turn abandoned') },
    crashed: {
      code: 'import asyncio, os\nasyncio.get_running_loop().call_later(0.2, os._exit, 1)\nprint(await test__echo({}))',
    },
  };

  for (const [how, { code, stop }] of Object.entries(stops)) {
    it(`a late result from a script whose interpreter ${how} does not reach the next script`, async () => {
      const calls: Array<(result: string) => void> = [];
      const runner = new PyRunner({
        onToolCall: () => new Promise<string>((resolve) => calls.push(resolve)),
      });
      const logged: string[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
        consoleError(...args);
      };
      try {
        const first = runner.exec(code, ECHO_TOOLS);
        await until(() => calls.length === 1, 'the first script to call its tool');
        stop?.(runner);
        const stopped = await first;
        assert.strictEqual(stopped.aborted, true, stopped.stderr);

        const second = runner.exec('print(await test__echo({}))', ECHO_TOOLS);
        await until(() => calls.length === 2, 'the second script to call its tool');
        // Both calls are the first of their interpreter.
        calls[0]('stale result of the stopped script');
        await new Promise((r) => setTimeout(r, 300));
        calls[1]('result of this script');
        const result = await second;
        assert.strictEqual(result.returnCode, 0, result.stderr);
        assert.strictEqual(result.stdout, 'result of this script\n');
        assert.ok(
          logged.some((l) => /dropped late result of test--echo call t1: the interpreter that asked for it is gone/.test(l)),
          'the dropped result is logged',
        );
      } finally {
        console.error = consoleError;
        runner.dispose();
      }
    });
  }
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

  it('two code_execution calls in one response: one runs, the other is refused, the turn completes', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-two-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    const code = (label: string) => [
      'import asyncio, json',
      `r = json.loads(await test__echo({"message": "${label}"}))`,
      'await asyncio.sleep(0.2)',
      `print("ran:", r["echoed"]["message"])`,
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_two_a', name: 'code_execution', input: { code: code('a') } },
      { type: 'tool_use', id: 'call_two_b', name: 'code_execution', input: { code: code('b') } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both answered.' }]));

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'pair',
        model: 'test-model',
        systemPrompt: 'Run both.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the turn never completed')), 15_000)),
      ]);
      assert.strictEqual(result.speech, 'Both answered.');

      const [results] = membrane.lastStream!.receivedToolResults as Array<Array<{ toolUseId: string; content: string }>>;
      const byId = new Map(results.map((r) => [r.toolUseId, r.content]));
      assert.match(byId.get('call_two_a') ?? '', /ran: a/, 'the first script ran');
      assert.match(byId.get('call_two_b') ?? '', /already running/, 'the second was refused');
      assert.ok(!(byId.get('call_two_b') ?? '').includes('ran: b'));
      const echoed = module.calls.filter((c) => c.name.endsWith('--echo') || c.name === 'echo').map((c) => (c.input as { message: string }).message);
      assert.deepStrictEqual(echoed, ['a']);
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

  it("a stopped script's late end-turn request does not end the next script's turn", async () => {
    let releaseFinish: () => void = () => {};
    const finishReleased = new Promise<void>((resolve) => { releaseFinish = resolve; });
    let finishStarted = false;
    class SlowFinishModule extends ScriptToolModule {
      override async handleToolCall(call: ToolCall): Promise<ToolResult> {
        if (call.name.endsWith('finish')) {
          finishStarted = true;
          await finishReleased;
        }
        return super.handleToolCall(call);
      }
    }
    const { tempDir, storePath } = tempStorePath('pytc-stale-endturn-');
    const framework = await createFrameworkWithCodeExecution(storePath, new MockMembrane(), new SlowFinishModule());
    const run = (input: Record<string, unknown>) =>
      framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
    framework.start();
    try {
      // The first script is stopped at its time limit while its call that ends the turn is running.
      const stopped = await run({ code: 'await test__finish({})', time_limit_ms: 1000 });
      assert.ok(finishStarted);
      assert.match((stopped.data as { stderr: string }).stderr, /reached its 1s time limit/);
      assert.ok(!stopped.endTurn);

      // The call finishes while the next script runs; its request belonged to the stopped script.
      const next = run({ code: 'import asyncio\nawait asyncio.sleep(1)\nprint("next done")' });
      await new Promise((r) => setTimeout(r, 300));
      releaseFinish();
      const result = await next;
      assert.strictEqual((result.data as { stdout: string }).stdout, 'next done\n');
      assert.ok(!result.endTurn, "the stopped script's request ended the next script's turn");
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A round that runs code_execution: its script's calls count as the round's
// ---------------------------------------------------------------------------

describe("a round that runs code_execution is routed once its scripts return (real python3)", () => {
  /** echo, send_message and a `slow` tool held until the test lets it go; each call is logged. */
  class RoundToolModule implements Module {
    readonly name = 'test';
    releaseSlow: () => void = () => {};
    private slowReleased = new Promise<void>((resolve) => { this.releaseSlow = resolve; });
    constructor(private readonly log: string[]) {}
    async start(_ctx: ModuleContext): Promise<void> {}
    async stop(): Promise<void> {}
    getTools(): ToolDefinition[] {
      const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
      return [tool('echo'), tool('send_message'), tool('slow')];
    }
    async handleToolCall(call: ToolCall): Promise<ToolResult> {
      const name = call.name.includes('--') ? call.name.slice(call.name.lastIndexOf('--') + 2) : call.name;
      this.log.push(`tool:${name}`);
      if (name === 'slow') {
        await this.slowReleased;
        this.log.push('slow:returned');
      }
      return { success: true, data: { ok: true } };
    }
    async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true }
        : {};
    }
  }

  const CHANNEL_TOOLS = [
    { name: 'skip_reply', description: 'End your turn without sending anything.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'think', description: 'Reason privately.', inputSchema: { type: 'object' as const, properties: { content: { type: 'string' } } } },
    { name: 'channel_open', description: 'Open a channel.', inputSchema: { type: 'object' as const, properties: { channelId: { type: 'string' } } } },
  ];

  async function scriptRound(mode: 'locus' | 'hybrid' | 'explicit' | 'disabled', responses: ReturnType<typeof createMockResponse>[],
    config: { sameRoundThinkTextPolicy?: 'private' } = {}, options: { codeExecution?: boolean } = {}) {
    const { tempDir, storePath } = tempStorePath('pytc-round-');
    const membrane = new MockMembrane();
    for (const response of responses) membrane.pushResponse(response);
    const log: string[] = [];
    const module = new RoundToolModule(log);
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Act.', proseRouting: mode, ...config }],
      modules: [module],
      syncIntervalMs: 0,
      ...(options.codeExecution === false ? {} : { codeExecution: { enabled: true } }),
    });
    // The registry stub: skip_reply and think are on the agent's surface, so
    // its scripts get them too, and skip_reply ends the turn as the real one
    // does.
    // What each `>>` label names; a test can rename one while a script runs.
    const directory: Record<string, string> = { '#alpha': 'chan-alpha' };
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test',
      resolveProseTarget: (spec: string) => (directory[spec] ? { channelId: directory[spec] } : { error: `no channel ${spec}` }),
      routeSpeech: async (_agent: string, text: string, channelId: string | null) => {
        if (!channelId) return null;
        log.push(`publish:${text}@${channelId}`);
        return { delivered: true, channelId };
      },
      sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
        log.push(`chunk:${delta}@${channelId}`);
      },
      handleChannelToolCall: async (name: string, input: Record<string, unknown> | undefined) => {
        log.push(`tool:${name}`);
        if (name === 'skip_reply') return { success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } };
        // A successful channel_open moves the turn's locus, as the real one does.
        if (name === 'channel_open') return { success: true, data: { channelId: input?.channelId } };
        return { success: true, data: {} };
      },
      getChannelTools: () => CHANNEL_TOOLS,
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    }, { get: (target, key: string) => (key in target ? (target as Record<string, unknown>)[key] : () => undefined) });
    const run = async () => {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    };
    const done = async () => {
      module.releaseSlow();
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    };
    return { framework, module, log, run, done, directory };
  }

  const scriptCall = (input: Record<string, unknown>, id = 'ce1') =>
    ({ type: 'tool_use', id, name: 'code_execution', input }) as ContentBlock;
  // A script holds its round only when it can change the round's routing:
  // its code names such a tool (scriptMayRoute). A script given this suffix
  // names skip_reply on a line that never runs, so its round waits for it.
  const HOLDS = '\nif False: await skip_reply({})';

  for (const mode of ['locus', 'hybrid', 'explicit'] as const) {
    it(`${mode}: a skip_reply inside the script keeps its round's prose from delivery and the stream`, async () => {
      const prose = mode === 'explicit' ? '>>#alpha checking quietly' : 'checking quietly';
      const h = await scriptRound(mode, [
        createMockResponse([
          { type: 'text', text: prose },
          scriptCall({ code: 'await skip_reply({})' }),
        ] as ContentBlock[], 'tool_use'),
      ]);
      try {
        await h.run();
        assert.ok(h.log.includes('tool:skip_reply'), 'the script called skip_reply');
        assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
          "the round's prose is kept, as a direct skip_reply keeps it");
      } finally { await h.done(); }
    });
  }

  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a send inside the script silences its round and the turn's later prose`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await test__send_message({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the script sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        'the send silences the round and what follows, as a direct send does');
    } finally { await h.done(); }
  });

  it("explicit: a send inside the script silences neither its round nor the turn's later prose, as a direct send doesn't", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: '>>#alpha posting the summary' },
        scriptCall({ code: 'await test__send_message({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>#alpha done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the script sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [
        'publish:posting the summary@chan-alpha', 'chunk:posting the summary@chan-alpha',
        'publish:done@chan-alpha', 'chunk:\n\ndone@chan-alpha',
      ], "explicit mode's prefixed prose is deliberate, so a send doesn't silence it");
    } finally { await h.done(); }
  });

  for (const mode of ['locus', 'hybrid', 'explicit'] as const) it(`${mode}: a think inside the script holds its round back under the private same-round policy`, async () => {
    const prefix = mode === 'explicit' ? '>>#alpha ' : '';
    const target = mode === 'explicit' ? 'chan-alpha' : 'world:test';
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: `${prefix}working it through` },
        scriptCall({ code: 'await think({"content": "notes"})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: `${prefix}the answer` }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    try {
      await h.run();
      assert.ok(h.log.includes('tool:think'), 'the script called think');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [`publish:the answer@${target}`],
        'the round beside the think stays private, as with a direct think, and the next round is delivered');
    } finally { await h.done(); }
  });

  it("the round's prose goes out once its script returns, not after a slow tool beside it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'on it' },
        scriptCall({ code: 'print(await test__echo({}))' + HOLDS }),
        { type: 'tool_use', id: 'slow1', name: 'test--slow', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Let the slow tool go once the round's prose has gone out, or after a
    // bound, so a round that waited for it still ends and fails the order.
    const watch = setInterval(() => { if (h.log.includes('publish:on it@world:test')) h.module.releaseSlow(); }, 10);
    // The bound only matters when the code is wrong: a round that waited
    // for the slow tool still ends, and fails the order.
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:on it@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('tool:echo') < at('publish:on it@world:test'), "it waited for the script's own call");
      assert.ok(at('publish:on it@world:test') < at('slow:returned'), 'and not for the slow tool beside it');
      assert.ok(at('publish:on it@world:test') < at('chunk:on it@world:test'), 'and its chunk followed its publish');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a script whose code names no tool that changes routing doesn't hold its round: its prose goes out while the script runs", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The script waits in its slow call until the round's prose has gone out,
    // or until a bound, so a round that waited for the script still ends.
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  /** Runs a one-script round whose prose should go out while its script waits in a slow call. */
  const publishedWhileScriptRuns = async (mode: 'locus' | 'explicit', code: string) => {
    const prefix = mode === 'explicit' ? '>>#alpha ' : '';
    const target = mode === 'explicit' ? 'chan-alpha' : 'world:test';
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: `${prefix}running the analysis` },
        scriptCall({ code }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: `${prefix}done` }] as ContentBlock[]),
    ]);
    const published = `publish:running the analysis@${target}`;
    const watch = setInterval(() => { if (h.log.includes(published)) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at(published) >= 0, 'the prose was delivered');
      assert.ok(at(published) < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  };

  it("a name inside a longer identifier, as say_hello or my_say, doesn't hold its round", async () => {
    await publishedWhileScriptRuns('locus', 'say_hello = 1\nmy_say = 2\nsend_message_log = []\nawait test__slow({})');
  });

  it("a comment that names a routing tool doesn't hold its round, since Python never runs it", async () => {
    await publishedWhileScriptRuns('locus', 'await test__slow({})  # then skip_reply, or say so');
  });

  it("explicit: a script that names only a send doesn't hold its round, since a send can't change an explicit round's routing", async () => {
    await publishedWhileScriptRuns('explicit', 'await test__slow({})\nif False: await test__send_message({})');
  });

  it("disabled: a script that names skip_reply doesn't hold its round, since nothing is routed", async () => {
    const h = await scriptRound('disabled', [
      createMockResponse([
        { type: 'text', text: 'never routed' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
    let waitedOn: boolean | undefined;
    const watch = setInterval(() => {
      if (!h.log.includes('tool:slow')) return;
      clearInterval(watch);
      waitedOn = rounds.has('assistant');
      h.module.releaseSlow();
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.equal(waitedOn, false, 'no round waited on the script');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [], 'and nothing was published');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a script whose code names a world utterance, as say, holds its round until it returns", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'about to speak' },
        scriptCall({ code: 'await test__slow({})\nif False: await mcpl__world__say({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Once the script is in its slow call, a round routed at its tool-calls
    // event has had its delivery queued long before; with the agent's queued
    // deliveries run, the round must still be unpublished. Then the call goes.
    let publishedWhileRunning: boolean | undefined;
    let checking = false;
    const watch = setInterval(() => {
      if (checking || !h.log.includes('tool:slow')) return;
      checking = true;
      const queued = (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('assistant');
      void Promise.resolve(queued).then(() => {}, () => {}).then(() => {
        publishedWhileRunning = h.log.includes('publish:about to speak@world:test');
        h.module.releaseSlow();
      });
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.equal(publishedWhileRunning, false, "the round wasn't published while its script ran");
      assert.ok(at('slow:returned') < at('publish:about to speak@world:test'), 'it went out once the script had returned');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a tool name a script builds at runtime goes unseen: its round is routed at its tool-calls event, as before scripts counted", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'not held' },
        scriptCall({ code: 'name = "skip" + "_reply"\nawait tools[name]({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('tool:skip_reply') >= 0, 'the script called skip_reply by a name it built');
      assert.ok(at('publish:not held@world:test') >= 0,
        "the round was published anyway: its code names no tool that changes routing, so it didn't wait for the skip_reply that would have kept it back");
    } finally { await h.done(); }
  });

  it("under the public same-round policy, a script that calls think doesn't hold its round", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'thinking it over' },
        scriptCall({ code: 'await think({"content": "notes"})\nawait test__slow({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const watch = setInterval(() => { if (h.log.includes('publish:thinking it over@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:thinking it over@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:thinking it over@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("without code execution, a code_execution call holds nothing: its round is routed at its tool-calls event", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'not a script after all' },
        scriptCall({ code: 'await skip_reply({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], {}, { codeExecution: false });
    try {
      await h.run();
      assert.ok(h.log.includes('publish:not a script after all@world:test'),
        "the call is answered as an unknown tool, whose result settles no round, so the round doesn't wait for it");
    } finally { await h.done(); }
  });

  it("a helper an earlier script defined holds a later script's round: the interpreter ran a script that names a tool that changes routing", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await post()' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the helper sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:defining a helper@world:test'],
        "the send through the helper silences its round and the turn's later prose, as a direct send does");
    } finally { await h.done(); }
  });

  it("a script that only calls a routing tool directly, by name or by key, leaves no mark: a later script's round isn't held for it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'thinking first' },
        scriptCall({ code: 'await think({"content": "notes"})\nawait tools["think"]({"content": "more"})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(!h.log.includes('publish:thinking first@world:test'), 'the round whose script thought stays private');
      assert.ok(at('publish:running the analysis@world:test') >= 0, "the later round's prose was delivered");
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while its script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a key an earlier script kept holds a later script's round, as an alias does", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'keeping a key' },
        scriptCall({ code: 'name = "test--send_message"' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await tools[name]({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the kept key sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:keeping a key@world:test'],
        "the send through the kept key silences its round and the turn's later prose, as a direct send does");
    } finally { await h.done(); }
  });

  it("an alias an earlier script bound to a routing tool holds a later script's round, as a helper does", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'keeping a handle' },
        scriptCall({ code: 'post = test__send_message' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await post({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the alias sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:keeping a handle@world:test'],
        "the send through the alias silences its round and the turn's later prose, as a direct send does");
    } finally { await h.done(); }
  });

  /** The agent's interpreter mark: the names it holds, or undefined when there is none. */
  const markOf = (framework: AgentFramework) => {
    const mark = (framework as unknown as { scriptRoutingInterpreters: Map<string, { names: Set<string> }> })
      .scriptRoutingInterpreters.get('assistant');
    return mark && [...mark.names].sort();
  };

  it("a script that calls a routing tool directly, beside a definition that doesn't use it, leaves no mark", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'formatting notes' },
        scriptCall({ code: 'def fmt(x):\n    return x.upper()\nawait think({"content": fmt("notes")})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:think'), 'the script thought');
      assert.equal(markOf(h.framework), undefined, 'fmt can still be called, but it reaches no routing tool');
    } finally { await h.done(); }
  });

  it('a later mark in the same interpreter adds its names to the earlier ones', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'keeping a handle' },
        scriptCall({ code: 't = think' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(markOf(h.framework), ['send_message', 'think'], 'the helper the first script left is still there');
    } finally { await h.done(); }
  });

  it('a script the busy runner refuses leaves no mark, though its code would have', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'two scripts at once' },
        scriptCall({ code: 'await test__slow({})' }, 'ce1'),
        scriptCall({ code: 'post = test__send_message' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Let the first script go once the second's refusal has come back.
    const results: string[] = [];
    h.framework.onTrace((event) => {
      if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') {
        results.push(event.callId);
        if (event.callId === 'ce2') h.module.releaseSlow();
      }
    });
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(results, ['ce2', 'ce1'], "the second script was refused while the first ran");
      assert.equal(markOf(h.framework), undefined, 'the refused alias never ran, so it marks nothing');
    } finally {
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a mark left in an earlier interpreter doesn't hold a round once a newer interpreter runs", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'starting fresh' },
        scriptCall({ code: 'x = 1' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }, 'ce3'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The helper's interpreter is reclaimed once its script returns; the next
    // script starts a newer one, which is live when the third round is decided.
    h.framework.onTrace((event) => {
      if (event.type === 'tool:completed' && event.callId === 'ce1') {
        const runner = (h.framework as unknown as { codeExecutionRunners: Map<string, { reclaim(why: string): void }> })
          .codeExecutionRunners.get('assistant')!;
        runner.reclaim('test');
      }
    });
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the third round was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while its script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("under the public same-round policy, a helper that calls think doesn't hold a later script's round", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def note():\n    await think({"content": "notes"})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await note()\nawait test__slow({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(h.log.includes('tool:think'), 'the helper thought');
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("under the private same-round policy, a helper that calls think holds a later script's round back", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def note():\n    await think({"content": "notes"})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'working it through' },
        scriptCall({ code: 'await note()' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'the answer' }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    try {
      await h.run();
      assert.ok(h.log.includes('tool:think'), 'the helper thought');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')),
        ['publish:defining a helper@world:test', 'publish:the answer@world:test'],
        'the round whose helper thought stays private, as with a direct think, and the rounds around it are delivered');
    } finally { await h.done(); }
  });

  it("once the interpreter is reclaimed, a script that names no such tool doesn't hold its round, since the helpers went with it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The interpreter that ran the helper's script is reclaimed once that
    // script returns, as an idle reclaim or a restart would.
    h.framework.onTrace((event) => {
      if (event.type === 'tool:completed' && event.callId === 'ce1') {
        const runner = (h.framework as unknown as { codeExecutionRunners: Map<string, { reclaim(why: string): void }> })
          .codeExecutionRunners.get('assistant')!;
        runner.reclaim('test');
      }
    });
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a background script's round is routed as soon as the script starts", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'starting a watcher' },
        scriptCall({ code: 'import asyncio\nawait asyncio.sleep(30)', background: true }),
        { type: 'tool_use', id: 'slow1', name: 'test--slow', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const watch = setInterval(() => { if (h.log.includes('publish:starting a watcher@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:starting a watcher@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:starting a watcher@world:test') < at('slow:returned'), 'without waiting for the slow tool');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a round with two code_execution calls waits for both: the second is refused at once, and the first's later skip_reply still counts", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'two scripts at once' },
        scriptCall({ code: 'await test__slow({})\nawait skip_reply({})' }, 'ce1'),
        scriptCall({ code: 'print("second")' + HOLDS }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
    ]);
    // Let the first script go once the second's refusal has come back.
    const results: string[] = [];
    h.framework.onTrace((event) => {
      if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') {
        results.push(event.callId);
        if (event.callId === 'ce2') h.module.releaseSlow();
      }
    });
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(results, ['ce2', 'ce1'], "the second script's refusal came back while the first ran");
      assert.ok(h.log.includes('tool:skip_reply'), "the first script's skip_reply ran");
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "the round waited for the first script, so its skip_reply kept the round's prose");
    } finally {
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a background script's calls aren't its round's, even while a foreground script in the round runs", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'still mine to say' },
        scriptCall({ code: 'await test__send_message({})', background: true }, 'bg'),
        scriptCall({ code: 'await test__slow({})' + HOLDS }, 'fg'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The foreground script holds the round open until the background send has run.
    const watch = setInterval(() => { if (h.log.includes('tool:send_message')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('tool:send_message') >= 0 && at('tool:send_message') < at('slow:returned'),
        'the background send ran while the round waited on its foreground script');
      assert.ok(h.log.includes('publish:still mine to say@world:test'), "the background send didn't silence the round");
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("locus: a script round's prose goes to the locus it was written for, though the script opens another channel", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'for the room I was in' },
        scriptCall({ code: 'await channel_open({"channelId": "chan-other"})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'now over here' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [
        'publish:for the room I was in@world:test',
        'publish:now over here@chan-other',
      ], 'the open moves later prose, not the round written before it');
    } finally { await h.done(); }
  });

  it("an ephemeral disposed while its round's script runs doesn't publish the round when the script returns", async () => {
    const h = await scriptRound('locus', []);
    const membrane = (h.framework as unknown as { membrane: MockMembrane }).membrane;
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'never decided' },
      scriptCall({ code: 'await test__slow({})' + HOLDS }),
    ] as ContentBlock[], 'tool_use'));
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    try {
      const created = await h.framework.createEphemeralAgent({ name: 'eph-script', model: 'test-model', systemPrompt: 'Act.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'go' }]);
      // The idle watchdog disposes the ephemeral while its script waits in the slow call.
      const run = h.framework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 15000, idleTimeoutMs: 300, idlePollMs: 20 });
      h.framework.start();
      await assert.rejects(run, /stalled/);
      assert.ok(h.log.includes('tool:slow'), 'the script was running when the ephemeral was disposed');
      // The script now returns, and its result arrives with the framework still running.
      let resulted!: () => void;
      const result = new Promise<void>((resolve) => { resulted = resolve; });
      h.framework.onTrace((event) => {
        if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') resulted();
      });
      h.module.releaseSlow();
      await result;
      await h.framework.runUntilIdle();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "the round's routing was never decided, so the late result publishes nothing");
      assert.ok(lines.some((line) => line.includes('eph-script: round [code_execution] -> 1 prose segment(s) withheld: its stream ended before its scripts returned')),
        "the disposed ephemeral's stream withheld the round as it ended");
    } finally {
      console.error = error;
      await h.done();
    }
  });

  // Each way a stream can stop owning its round while the round's script runs:
  // the agent stops waiting on it, is deregistered, or moves to a newer stream.
  const leaveRound: Record<string, (framework: AgentFramework, agent: { reset(): void }) => void> = {
    'its agent is reset': (_framework, agent) => agent.reset(),
    'its agent is deregistered': (framework) => {
      (framework as unknown as { agents: Map<string, unknown> }).agents.delete('assistant');
    },
    'its agent moves to a newer stream': (_framework, agent) => {
      (agent as unknown as { _streamId: number })._streamId++;
    },
  };
  for (const [how, leave] of Object.entries(leaveRound)) it(`a round is withheld when its script returns if, meanwhile, ${how}`, async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'never decided' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    let stream: { cancel(): void } | undefined;
    let agent: { state: { stream?: { cancel(): void } }; reset(): void } | undefined;
    try {
      h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      void h.framework.runUntilIdle().catch(() => {});
      const started = Date.now();
      while (!h.log.includes('tool:slow') && Date.now() - started < 15000) await new Promise((r) => setTimeout(r, 10));
      assert.ok(h.log.includes('tool:slow'), 'the script reached its slow call');
      // The turn's routing state, whose receipt counts what the turn suppressed.
      const routing = (h.framework as unknown as { turnRouting: Map<string, { suppressed: number }> }).turnRouting.get('assistant')!;
      const suppressedBefore = routing.suppressed;
      // The stream no longer owns the round, while it lives on.
      agent = h.framework.getAgent('assistant')! as unknown as { state: { stream?: { cancel(): void } }; reset(): void };
      stream = agent.state.stream;
      leave(h.framework, agent);
      let resulted!: () => void;
      const result = new Promise<void>((resolve) => { resulted = resolve; });
      h.framework.onTrace((event) => {
        if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') resulted();
      });
      h.module.releaseSlow();
      await result;
      const until = Date.now() + 15000;
      while (Date.now() < until && !lines.some((line) => line.includes('prose segment(s) withheld'))) await new Promise((r) => setTimeout(r, 10));
      assert.ok(lines.some((line) => line.includes('assistant: round [code_execution] -> 1 prose segment(s) withheld: its turn no longer waits on it')),
        'the script result found the round undecidable and withheld it');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [], 'and published nothing');
      assert.equal(routing.suppressed, suppressedBefore + 1, "and the turn's receipt counts the withheld segment as suppressed");
    } finally {
      console.error = error;
      stream?.cancel();
      // The departures are simulated, without the bookkeeping a real one does:
      // a real deregistration also clears the name's active stream, and a real
      // newer stream takes that entry over and clears it when it ends. Clear
      // it and settle the agent, so the loop this test started finds the
      // framework idle and the file can exit.
      (h.framework as unknown as { activeStreams: Map<string, unknown> }).activeStreams.delete('assistant');
      agent?.reset();
      await h.done();
    }
  });

  it("a round whose stream is stopped before its script returns is withheld", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'never decided' },
        scriptCall({ code: 'await test__slow({})\nawait skip_reply({})' }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    try {
      h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      void h.framework.runUntilIdle().catch(() => {});
      // The script is running, held in its slow call.
      const started = Date.now();
      while (!h.log.includes('tool:slow') && Date.now() - started < 15000) await new Promise((r) => setTimeout(r, 10));
      assert.ok(h.log.includes('tool:slow'), 'the script reached its slow call');
      await h.framework.stop();
      h.module.releaseSlow();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "whether the script would have silenced the round is unknown, so its prose isn't sent");
      assert.ok(lines.some((line) => line.includes('1 prose segment(s) withheld: its stream ended before its scripts returned')),
        'and the withheld round is logged, not dropped silently');
    } finally {
      console.error = error;
      await h.done();
    }
  });

  /** A pending round of another stream, as scriptRounds holds one: it records what it was asked to do. */
  const pendingRound = (agent: unknown, pending: string[] = ['elsewhere']) => {
    const asked: string[] = [];
    return {
      asked,
      round: {
        agent, streamId: -1, scripts: new Map<string, string[]>(), pending: new Set(pending),
        route: () => { asked.push('route'); },
        withhold: (why: string) => { asked.push(`withhold: ${why}`); },
      },
    };
  };

  it("a script's result settles only the round that dispatched it, though a newer round waits on the same call id", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the first round' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
    // While the script runs, a newer round comes to wait under the name on a
    // call with the same id, as a provider that reuses ids could make one.
    const newer = pendingRound(h.framework.getAgent('assistant'), ['ce1']);
    let swapped = false;
    const watch = setInterval(() => {
      if (!h.log.includes('tool:slow')) return;
      clearInterval(watch);
      rounds.set('assistant', newer.round);
      swapped = true;
      h.module.releaseSlow();
    }, 10);
    // A script that never reaches its slow call still ends, and fails below.
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.ok(swapped, 'the newer round came to wait while the script ran');
      assert.deepStrictEqual(newer.asked, [], "the first round's result doesn't settle the newer round");
      assert.equal(rounds.get('assistant'), newer.round, 'which still waits');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a newer round that doesn't wait displaces an older waiting round, so a call of its own with the same id can't settle it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the newer round' },
        scriptCall({ code: 'print("quick")' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // An older round of another stream still waits on a call with the same
    // id, as a provider that reuses ids could leave one.
    const older = pendingRound({}, ['ce1']);
    (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds.set('assistant', older.round);
    try {
      await h.run();
      assert.deepStrictEqual(older.asked, ['withhold: a newer round replaced it before its scripts returned'],
        "the older round is withheld, and the newer round's result settles nothing of it");
      assert.ok(h.log.includes('publish:the newer round@world:test'), 'and the newer round is routed at once');
    } finally { await h.done(); }
  });

  it('a round registered while another waits under the same agent name withholds the older one', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the newer round' },
        scriptCall({ code: 'print("quick")' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const older = pendingRound({});
    (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds.set('assistant', older.round);
    try {
      await h.run();
      assert.deepStrictEqual(older.asked, ['withhold: a newer round replaced it before its scripts returned'],
        'the older round is withheld, not overwritten silently');
      assert.ok(h.log.includes('publish:the newer round@world:test'), 'and the newer round is routed as usual');
    } finally { await h.done(); }
  });

  // A successor's round comes to wait under the agent's name while this stream
  // runs: one of another agent object of the name, or one of the same agent
  // object's later stream (a restart overlapping this one).
  for (const whose of ['another agent object', "the same agent object's later stream"] as const) {
    it(`a stream's teardown leaves alone a round that belongs to ${whose}`, async () => {
      const h = await scriptRound('locus', [
        createMockResponse([
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'r1', name: 'test--echo', input: {} },
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
      ]);
      // pendingRound's round has stream id -1, which no stream has.
      const successor = pendingRound(whose === 'another agent object' ? {} : h.framework.getAgent('assistant'));
      const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
      h.framework.onTrace((event) => {
        if (event.type === 'tool:completed' && event.callId === 'r1') rounds.set('assistant', successor.round);
      });
      try {
        await h.run();
        assert.ok(h.log.includes('publish:done@world:test'), 'the stream ran to its end');
        assert.deepStrictEqual(successor.asked, [], "this stream's teardown doesn't withhold the successor's round");
        assert.equal(rounds.get('assistant'), successor.round, 'nor remove it');
      } finally { await h.done(); }
    });
  }

  it("explicit: a script round goes to the target its `>>` named when the round ended, though the label is renamed while the script runs", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: '>>#alpha written for alpha' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>skip_reply done' }] as ContentBlock[]),
    ]);
    // While the script waits in its slow call, #alpha comes to name another channel.
    const watch = setInterval(() => {
      if (h.log.includes('tool:slow')) { h.directory['#alpha'] = 'chan-renamed'; h.module.releaseSlow(); }
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:written for alpha@chan-alpha'],
        'the round was admitted when it ended');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
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

// The deadline's cancel op is an asyncio cancellation, which lands only when a
// script awaits; the SIGINT that follows it stops blocking code (#235 F3).
describe('code_execution time limit vs blocking code (real python3)', { skip: process.platform === 'win32' }, () => {
  const pidOf = (stdout: string) => /pid=(\d+)/.exec(stdout)?.[1];

  it('blocking code stops at the time limit, keeping its output, and the interpreter survives', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      const pid = pidOf(first.stdout);
      assert.ok(pid, first.stdout);
      const blocking: Record<string, string> = {
        sleep: 'import time\nprint("before")\ntime.sleep(60)\nprint("after")',
        'busy loop': 'print("before")\nn = 0\nwhile True:\n    n += 1\nprint("after")',
        'blocking read': 'import socket\nprint("before")\na, b = socket.socketpair()\na.recv(1)\nprint("after")',
      };
      for (const [shape, code] of Object.entries(blocking)) {
        const started = Date.now();
        const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
        const elapsed = Date.now() - started;
        assert.strictEqual(result.returnCode, 1, shape);
        assert.strictEqual(result.aborted, undefined, `${shape}: interrupted, not killed`);
        assert.strictEqual(result.stdout, 'before\n', `${shape}: output before the limit is kept`);
        assert.match(result.stderr, /KeyboardInterrupt: script interrupted by host/, shape);
        assert.match(result.stderr, /script stopped: it reached its 1s time limit/, shape);
        assert.match(result.stderr, /File "<script>", line \d+/, `${shape}: says where the script was`);
        assert.doesNotMatch(result.stderr, /runtime\.py/, `${shape}: no runtime frames`);
        assert.ok(elapsed < 5000, `${shape}: stopped at the limit, not the kill grace (${elapsed}ms)`);
      }
      const last = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      assert.strictEqual(pidOf(last.stdout), pid, 'same interpreter: nothing was killed');
    } finally {
      runner.dispose();
    }
  });

  it('variables survive an interrupted script', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const set = await runner.exec('x = 41', []);
      assert.strictEqual(set.returnCode, 0, set.stderr);
      const stopped = await runner.exec('import time\ny = 1\ntime.sleep(60)', [], undefined, { deadlineMs: 1000 });
      assert.match(stopped.stderr, /reached its 1s time limit/);
      const after = await runner.exec('print(x + y)', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, '42\n');
    } finally {
      runner.dispose();
    }
  });

  it('a script waiting on an await is still stopped by the cancel', async () => {
    const runner = new PyRunner({
      onToolCall: () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
    });
    try {
      const started = Date.now();
      const result = await runner.exec('print("before")\nawait test__echo({})\nprint("after")', ECHO_TOOLS, undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stdout, 'before\n');
      assert.match(result.stderr, /KeyboardInterrupt: script cancelled by host/);
      assert.doesNotMatch(result.stderr, /interrupted by host/);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 5000, 'stopped at the limit');
    } finally {
      runner.dispose();
    }
  });

  it('SIGINT between scripts does nothing', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('import os\nx = 1\nprint(f"pid={os.getpid()}")', []);
      const pid = Number(pidOf(first.stdout));
      assert.ok(pid > 0, first.stdout);
      process.kill(pid, 'SIGINT');
      await new Promise((r) => setTimeout(r, 200));
      const result = await runner.exec('print(x)\nprint(f"pid={os.getpid()}")', []);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `1\npid=${pid}\n`);
    } finally {
      runner.dispose();
    }
  });

  it('SIGINT while a script waits cancels it before it can resume into blocking code', async () => {
    let pid = 0;
    const runner = new PyRunner({
      onToolCall: async () => {
        // The script is suspended on this call. The signal arrives with no cancel op behind it;
        // the result does, and the script would then block.
        process.kill(pid, 'SIGINT');
        await new Promise((r) => setTimeout(r, 200));
        return 'tool ok';
      },
    });
    try {
      const first = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      pid = Number(pidOf(first.stdout));
      assert.ok(pid > 0, first.stdout);
      const started = Date.now();
      const result = await runner.exec('import time\nprint(await test__echo({}))\ntime.sleep(30)', ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stdout, '');
      // Cancelled at its await (or, if the signal beat the script to it, interrupted there).
      assert.match(result.stderr, /KeyboardInterrupt: script (cancelled|interrupted) by host/);
      assert.ok(Date.now() - started < 5000, 'stopped at once, not after the blocking call');
      const after = await runner.exec('print(f"pid={os.getpid()}")', []);
      assert.strictEqual(after.stdout, `pid=${pid}\n`, 'same interpreter');
    } finally {
      runner.dispose();
    }
  });

  it('a script that resumes from an await into blocking code at its limit is stopped', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const result = await runner.exec('import asyncio, time\nawait asyncio.sleep(1)\ntime.sleep(5)\nprint("after")', [], undefined, { deadlineMs: 1000 });
        assert.strictEqual(result.returnCode, 1, result.stderr);
        assert.strictEqual(result.stdout, '');
        assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
        assert.ok(Date.now() - started < 3000, `stopped at the limit (${Date.now() - started}ms)`);
      }
    } finally {
      runner.dispose();
    }
  });

  it("the runtime's stop table: each place a signal or cancel op can land stops the script once", () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-stop-rows-'));
    try {
      writeFileSync(join(dir, 'runtime.py'), PYTHON_RUNTIME_SOURCE);
      writeFileSync(join(dir, 'driver.py'), PYTC_STOP_ROWS_DRIVER);
      type Row = { rc: number | null; tail: string; secs: number; ops: string[] };
      const rows = JSON.parse(
        execFileSync('python3', [join(dir, 'driver.py'), join(dir, 'runtime.py')], { encoding: 'utf8', timeout: 60_000 }),
      ) as Record<string, Row>;
      const printed = (row: Row, line: string) => row.tail.split('\n').includes(line);
      const interrupted = /KeyboardInterrupt: script interrupted by host/;
      const cancelled = /KeyboardInterrupt: script cancelled by host/;
      const stopped = (name: string, how: RegExp, has: string[] = [], hasNot: string[] = []) => {
        const row = rows[name];
        assert.ok(row, name);
        assert.strictEqual(row.rc, 1, `${name}: ${row.tail}`);
        assert.match(row.tail, how, name);
        for (const w of has) assert.ok(printed(row, w), `${name}: printed ${w}`);
        for (const w of hasNot) assert.ok(!printed(row, w), `${name}: did not print ${w}`);
        assert.ok(row.secs < 2, `${name}: stopped at once (${row.secs}s)`);
      };
      const finished = (name: string, has: string[]) => {
        const row = rows[name];
        assert.ok(row, name);
        assert.strictEqual(row.rc, 0, `${name}: ${row.tail}`);
        for (const w of has) assert.ok(printed(row, w), `${name}: printed ${w}`);
        assert.doesNotMatch(row.tail, /by host/, `${name}: never stopped (again) by us`);
      };

      stopped('1 own code', interrupted, ['a'], ['b']);
      stopped('2 waiting on an await', cancelled, [], ['b']);
      // Cancelling inside the handler here raised InvalidStateError out of main().
      stopped('3 mid-dispatch, reply behind', cancelled, [], ['woke']);
      stopped('4 protocol write', cancelled, [], ['b']);
      assert.ok(rows['4 protocol write'].ops.includes('tool_call'), 'the protocol line stayed whole');
      stopped('5 reply ahead, then await', cancelled, ['woke'], ['b']);
      // Interrupted in its blocking code; the queued cancellation must not cut its cleanup short.
      finished('6 reply ahead, then block', ['woke', 'cleaned']);
      finished('7 reply ahead, then finish', ['woke']);
      finished('7 next script', ['ok']);
      stopped('8 before start, signal', cancelled, [], ['ran']);
      // The cancel op before the script started used to leave it reporting nothing.
      stopped('8 before start, cancel op', cancelled, [], ['ran']);
      finished('9 cancel op first', ['cleaned']);
      finished('10 after delivery', ['cleaned']);
      finished('11 reporting', ['done']);
      finished('12 between scripts', ['ok']);
      if (rows['13 next script blocks']) {
        // Python 3.12+: an eager task factory left installed by an earlier script.
        finished('13 eager task factory installed', ['installed']);
        stopped('13 next script blocks', interrupted, ['a'], ['b']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an eager task factory installed by an earlier script does not hide the next one from the deadline', async (t) => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 3000 });
    try {
      const install = await runner.exec(
        'import asyncio, sys\nif sys.version_info >= (3, 12):\n    asyncio.get_running_loop().set_task_factory(asyncio.eager_task_factory)\n    print("installed")',
        [],
      );
      assert.strictEqual(install.returnCode, 0, install.stderr);
      if (install.stdout !== 'installed\n') {
        t.skip('asyncio.eager_task_factory needs Python 3.12+');
        return;
      }
      const started = Date.now();
      const result = await runner.exec('import time\nprint("before")\ntime.sleep(30)', [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.aborted, undefined, 'interrupted, not killed');
      assert.strictEqual(result.stdout, 'before\n');
      assert.match(result.stderr, /KeyboardInterrupt: script interrupted by host/);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 2500, `stopped at the limit (${Date.now() - started}ms)`);
    } finally {
      runner.dispose();
    }
  });

  it('a script that ignores the interrupt is killed after the grace, and its interpreter state is gone', async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 500 });
    try {
      assert.strictEqual((await runner.exec('x = 41', [])).returnCode, 0);
      const code = 'import time\ntry:\n    time.sleep(60)\nexcept KeyboardInterrupt:\n    time.sleep(60)';
      const started = Date.now();
      const killed = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(killed.aborted, true);
      assert.strictEqual(killed.returnCode, 1);
      assert.match(
        killed.stderr,
        /script stopped: it reached its 1s time limit and did not respond, so it was killed and the interpreter restarted \(variables from earlier scripts are gone\)/,
      );
      assert.ok(Date.now() - started < 5000, `killed after the grace (${Date.now() - started}ms)`);
      const after = await runner.exec('print(x)', []);
      assert.strictEqual(after.returnCode, 1);
      assert.match(after.stderr, /NameError: name 'x' is not defined/);
    } finally {
      runner.dispose();
    }
  });
});
