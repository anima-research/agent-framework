/**
 * RFC-007 for calls a code_execution script makes (issue #235, finding F4):
 * a real framework, a real python interpreter, real MCPL servers over stdio.
 *
 *   prov         offers `click` (classed `computer`) and `run` (unclassed,
 *                returns an error result); `delay_ms` delays an answer, and
 *                `hold` holds it until a file exists
 *   obs-all      observe, no filter: every call, metadata only
 *   obs-comms    filter `class: comms`
 *   obs-run      filter `serverTool: run`
 *   obs-web      filter `class: web`, which no call has
 *
 * The module tool `test--send` is classed `comms` by the embedding host.
 * Before this, observers saw only the outer code_execution call (`shell`),
 * so obs-comms and obs-run saw nothing at all.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { SCRIPT_PARENT_META_KEY } from '../src/mcpl/tool-lifecycle.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tool-lifecycle-mcpl-server.mjs');

class TestModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{
      name: 'send',
      description: 'Send a message to a person',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: true, data: 'RESULT-MARKER sent' };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
        requestInference: true,
      };
    }
    return {};
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type Params = Record<string, unknown> & { tool: string; phase: string; toolCallId: string };
type Logged = { event: string; params?: Params; [k: string]: unknown };
const readLog = (path: string): Logged[] =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const OBSERVERS = {
  'obs-all': null,
  'obs-comms': [{ match: { class: 'comms' } }],
  'obs-run': [{ match: { serverTool: 'run' } }],
  'obs-web': [{ match: { class: 'web' } }],
} as const;
type ObserverId = keyof typeof OBSERVERS;

describe('tool lifecycle for script-made calls (RFC-007, #235 F4)', () => {
  let tempDir: string;
  let logs: Record<ObserverId | 'prov', string>;
  let membrane: MockMembrane;
  let framework: AgentFramework;

  const lifecycle = (id: ObserverId): Params[] =>
    readLog(logs[id]).filter((e) => e.event === 'lifecycle').map((e) => e.params!);
  /** The stream's teardown, which ends (aborts) its open calls, has run. */
  const streamEnded = () => !(framework as unknown as { activeStreams: Map<string, unknown> }).activeStreams.has('scout');

  async function runTurn(blocks: unknown[]): Promise<void> {
    const callsBefore = membrane.calls.length;
    membrane.pushResponse(createMockResponse(blocks as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: [{ type: 'text', text: 'go' }],
      metadata: {},
      triggerInference: true,
    } as unknown as ProcessEvent);
    await waitFor(
      () => membrane.calls.length > callsBefore && (membrane.lastStream?.receivedToolResults.length ?? 0) >= 1,
      'the tool round answered',
    );
    await waitFor(streamEnded, "the turn's stream ended");
  }

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tool-lifecycle-script-'));
    logs = {
      prov: join(tempDir, 'prov.jsonl'),
      'obs-all': join(tempDir, 'obs-all.jsonl'),
      'obs-comms': join(tempDir, 'obs-comms.jsonl'),
      'obs-run': join(tempDir, 'obs-run.jsonl'),
      'obs-web': join(tempDir, 'obs-web.jsonl'),
    };
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [new TestModule()],
      codeExecution: { enabled: true },
      hostToolClasses: { 'test--send': ['comms'] },
      mcplServers: [
        {
          id: 'prov',
          toolPrefix: 'prov',
          command: process.execPath,
          args: [FIXTURE],
          env: { ROLE: 'provider', LOG_PATH: logs.prov },
        },
        ...(Object.entries(OBSERVERS) as Array<[ObserverId, unknown]>).map(([id, filter]) => ({
          id,
          toolPrefix: id,
          command: process.execPath,
          args: [FIXTURE],
          env: {
            ROLE: 'observer',
            LOG_PATH: logs[id],
            ...(filter ? { FILTER: JSON.stringify(filter) } : {}),
          },
          toolLifecycle: { observe: {} },
        })),
      ],
    });
    await framework.start();
    for (const [id, filter] of Object.entries(OBSERVERS) as Array<[ObserverId, unknown]>) {
      if (filter) {
        await waitFor(() => readLog(logs[id]).some((e) => e.event === 'observe-applied'), `${id} filter applied`);
      } else {
        await waitFor(() => readLog(logs[id]).some((e) => e.event === 'policy'), `${id} granted`);
      }
    }
    await waitFor(
      () => ['prov--click', 'prov--run', 'test--send'].every((n) => framework.getAllTools().some((t) => t.name === n)),
      'tools listed',
    );
  });

  after(async () => {
    await framework?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports a script's calls under each inner tool's own name and class; model calls unchanged", async () => {
    const code = [
      'await prov__click({"x": 1, "y": 2, "delay_ms": 250})',
      'await prov__run({"cmd": "make"})',
      'await test__send({"text": "hello"})',
      'print("script done")',
    ].join('\n');
    await runTurn([
      { type: 'tool_use', id: 'toolu_01SCRIPTAAAAAAAAAAAAAAAAA', name: 'code_execution', input: { code } },
      { type: 'tool_use', id: 'toolu_01MODELBBBBBBBBBBBBBBBBBB', name: 'prov--click', input: { x: 5, y: 6 } },
    ]);
    await waitFor(() => lifecycle('obs-all').length >= 10, 'obs-all: five calls, both phases');
    await new Promise((r) => setTimeout(r, 300)); // a stray or duplicate would land here

    const script = JSON.stringify(membrane.lastStream?.receivedToolResults ?? []);
    assert.match(script, /script done/, 'the script ran to the end');

    const all = lifecycle('obs-all');
    assert.equal(all.length, 10, all.map((p) => `${p.tool}:${p.phase}`).join(', '));
    const parent = all.find((p) => p.tool === 'code_execution' && p.phase === 'started')!;
    assert.deepEqual(parent.class, ['shell']);
    const parentMeta = { [SCRIPT_PARENT_META_KEY]: parent.toolCallId };

    // The model's own calls: as before, no attribution.
    for (const p of all.filter((p) => p.tool === 'code_execution' || p.toolCallId === 'toolu_01MODELBBBBBBBBBBBBBBBBBB')) {
      assert.equal(p._meta, undefined, `${p.tool}:${p.phase} carries no _meta`);
    }
    const modelClick = all.filter((p) => p.toolCallId === 'toolu_01MODELBBBBBBBBBBBBBBBBBB');
    assert.deepEqual(modelClick.map((p) => `${p.tool}:${p.phase}`), ['prov--click:started', 'prov--click:completed']);

    // The script's calls: inner tool, inner class, the parent's inference and call.
    const inner = all.filter((p) => p._meta !== undefined);
    assert.equal(inner.length, 6);
    for (const p of inner) {
      assert.deepEqual(p._meta, parentMeta);
      assert.equal(p.inferenceId, parent.inferenceId);
      assert.equal(p.conversationId, 'scout');
      assert.notEqual(p.toolCallId, parent.toolCallId);
    }
    const phases = (tool: string) => inner.filter((p) => p.tool === tool);
    const [clickStart, clickEnd] = phases('prov--click');
    assert.deepEqual([clickStart.phase, clickEnd.phase], ['started', 'completed']);
    assert.equal(clickStart.toolCallId, clickEnd.toolCallId);
    assert.deepEqual(clickStart.class, ['computer']);
    assert.equal(clickStart.serverId, 'prov');
    assert.equal(clickStart.serverTool, 'click');
    assert.equal(clickEnd.isError, false);
    const duration = clickEnd.durationMs as number;
    assert.ok(duration >= 200 && duration < 10_000, `durationMs ${duration} spans the 250ms call`);

    const [runStart, runEnd] = phases('prov--run');
    assert.deepEqual(runStart.class, []);
    assert.equal(runEnd.phase, 'completed', 'an error result is completed, not failed');
    assert.equal(runEnd.isError, true);

    const [sendStart, sendEnd] = phases('test--send');
    assert.deepEqual(sendStart.class, ['comms']);
    assert.equal(sendStart.serverId, undefined, 'a host-implemented tool');
    assert.equal(sendEnd.phase, 'completed');

    // Filters see the inner calls they ask for, by class and by name.
    assert.deepEqual(lifecycle('obs-comms').map((p) => `${p.tool}:${p.phase}`), ['test--send:started', 'test--send:completed']);
    assert.deepEqual(lifecycle('obs-comms')[0]._meta, parentMeta);
    assert.deepEqual(
      lifecycle('obs-run').map((p) => `${p.tool}:${p.phase}:${p.isError}`),
      ['prov--run:started:undefined', 'prov--run:completed:true'],
    );
    assert.equal(lifecycle('obs-web').length, 0, 'a filter no call matches sees nothing');

    for (const id of Object.keys(OBSERVERS) as ObserverId[]) {
      const wire = JSON.stringify(lifecycle(id));
      for (const secret of ['RESULT-MARKER', 'hello', 'make']) {
        assert.ok(!wire.includes(secret), `"${secret}" must not reach ${id}`);
      }
    }
    assert.equal(readLog(logs.prov).filter((e) => e.event === 'lifecycle').length, 0, 'the provider holds no grant');
  });

  it('a dispatch that throws after doing work is reported started then failed, not dropped', async () => {
    // Some host tools change state and then throw synchronously (sleep with
    // a huge `seconds` sets the gate, then fails formatting its reply).
    // Stand one in for test--send.
    const internals = framework as unknown as {
      dispatchToolCall(agentName: string, call: { name: string; input: unknown }): void;
    };
    const original = internals.dispatchToolCall;
    let workDone = 0;
    internals.dispatchToolCall = function (this: unknown, agentName, call) {
      if (call.name === 'test--send' && (call.input as { boom?: boolean }).boom) {
        workDone++;
        throw new RangeError('Invalid time value');
      }
      return original.call(this, agentName, call);
    };
    try {
      const before = { all: lifecycle('obs-all').length, comms: lifecycle('obs-comms').length };
      await runTurn([{
        type: 'tool_use',
        id: 'toolu_01THROWSDDDDDDDDDDDDDDDDDD',
        name: 'code_execution',
        input: { code: 'r = await test__send({"text": "x", "boom": True})\nprint("got:", r)' },
      }]);
      await waitFor(() => lifecycle('obs-all').length >= before.all + 4, 'both calls ended');
      await new Promise((r) => setTimeout(r, 300)); // a stray or duplicate would land here

      assert.equal(workDone, 1);
      assert.match(JSON.stringify(membrane.lastStream!.receivedToolResults), /got: Error: Invalid time value/);
      const events = lifecycle('obs-all').slice(before.all);
      assert.deepEqual(events.map((p) => `${p.tool}:${p.phase}`), [
        'code_execution:started',
        'test--send:started',
        'test--send:failed',
        'code_execution:completed',
      ]);
      assert.deepEqual(events[2]._meta, { [SCRIPT_PARENT_META_KEY]: events[0].toolCallId });
      assert.deepEqual(
        lifecycle('obs-comms').slice(before.comms).map((p) => `${p.tool}:${p.phase}`),
        ['test--send:started', 'test--send:failed'],
      );
    } finally {
      delete (internals as { dispatchToolCall?: unknown }).dispatchToolCall;
    }
  });

  it('a call still running when its script is killed is reported completed when it finishes', async () => {
    const before = lifecycle('obs-all').length;
    const release = join(tempDir, 'release-orphan');
    await runTurn([{
      type: 'tool_use',
      id: 'toolu_01ORPHANCCCCCCCCCCCCCCCCCC',
      name: 'code_execution',
      input: { code: `await prov__click({"x": 1, "y": 1, "hold": ${JSON.stringify(release)}})`, time_limit_ms: 1000 },
    }]);
    // The script was stopped and the turn's stream has ended (ending its open
    // calls), while the provider still holds the inner call's reply.
    const whileHeld = lifecycle('obs-all').slice(before);
    assert.deepEqual(whileHeld.map((p) => `${p.tool}:${p.phase}`), [
      'code_execution:started',
      'prov--click:started',
      'code_execution:completed',
    ]);

    // Held for at least 200ms more, after the call had already started.
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(release, '');
    await waitFor(() => lifecycle('obs-all').length >= before + 4, 'the orphaned call finished');
    await new Promise((r) => setTimeout(r, 300)); // a stray or duplicate would land here
    const events = lifecycle('obs-all').slice(before);
    assert.deepEqual(events.map((p) => `${p.tool}:${p.phase}`), [
      'code_execution:started',
      'prov--click:started',
      'code_execution:completed',
      'prov--click:completed',
    ]);
    const end = events[3];
    assert.equal(end.isError, false);
    assert.ok((end.durationMs as number) >= 200, `durationMs ${String(end.durationMs)} covers the hold`);
  });
});
