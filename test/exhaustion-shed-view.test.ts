/**
 * The poison-history breaker's shed after inference exhaustion (#834). On an
 * agent left in legacy mode, where the window is the record, the shed passes
 * over the rows the agent's view leaves out, as it does on a presented
 * window. After a stream's exhaustion it takes only an exchange that the
 * failing stream carried, so a row stored while the request was in flight
 * stays, and a stream with no record of what it carried sheds nothing. A
 * failure before a stream exists sheds the newest row the agent is sent.
 */
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, type MessageId, type MessageMetadata } from '@animalabs/context-manager';
import { MembraneError, type ContentBlock, type NormalizedRequest, type StreamEvent, type YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { until } from './helpers/dendrite.js';
import { WireMembrane } from './helpers/wire-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] }) => row.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');

class SurfaceModule implements Module {
  readonly name = 'surface';
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content, metadata } = event as unknown as { content: ContentBlock[]; metadata: { ask: string[] } };
    return { addMessages: [{ participant: 'user', content }], requestInference: metadata.ask };
  }
}
const input = (t: string, ask: string[]): ProcessEvent =>
  ({ type: 'external-message', source: 'test', content: [text(t)], metadata: { ask } }) as unknown as ProcessEvent;

type Internals = {
  presents(agent: Agent): boolean;
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
  emitTrace(event: Record<string, unknown>): void;
  consecutiveInferenceFailures: Map<string, number>;
  exhaustionRewinds: Map<string, number>;
  streamCarried: WeakMap<YieldingStream, Set<MessageId>>;
  subconsciousAgentName: string | null;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * mira and oren, residents. `legacy` leaves them in legacy mode, as a failed
 * write-down at registration does. `failFirst` makes the first request fail
 * with a 400 `invalid_request`: its stream throws it or yields it as an
 * error event once it is read and `release()` is called, or making its
 * stream throws it (`setup`), before any stream exists. `beforeFailing`
 * runs as it fails, with the failing stream if there is one.
 */
async function boot(opts: { legacy: boolean; subconscious?: boolean; failFirst?: 'throws' | 'yields' | 'setup'; beforeFailing?: (stream?: YieldingStream) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'af-exhaustion-shed-'));
  dirs.push(dir);
  const membrane = new WireMembrane();
  const requests: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reading = false;
  const base = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (request: NormalizedRequest, o?: unknown): YieldingStream => {
    requests.push(JSON.stringify(request.messages));
    const error = new MembraneError({ type: 'invalid_request', retryable: false, httpStatus: 400, message: 'Bad request: zz', rawError: undefined });
    if (opts.failFirst === 'setup' && requests.length === 1) {
      opts.beforeFailing?.();
      throw error;
    }
    const stream = base(request, o);
    if (opts.failFirst && requests.length === 1) {
      const how = opts.failFirst;
      (stream as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* (): AsyncGenerator<StreamEvent> {
        // The request is in flight from here, as a provider stream's is once read.
        reading = true;
        await released;
        opts.beforeFailing?.(stream);
        if (how === 'yields') yield { type: 'error', error } as unknown as StreamEvent;
        else throw error;
      };
    }
    return stream;
  };
  const proto = ContextManager.prototype as unknown as { presentRows: (...a: unknown[]) => unknown };
  const presentRows = proto.presentRows;
  if (opts.legacy) proto.presentRows = function () { throw new Error('zz: the write-down fails'); };
  let framework: AgentFramework;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: ['mira', 'oren'].map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', proseRouting: 'disabled' })),
      modules: [new SurfaceModule()],
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      ...(opts.subconscious ? { subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' } } : {}),
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
  } finally {
    proto.presentRows = presentRows;
  }
  frameworks.push(framework);
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  const internals = framework as unknown as Internals;
  const mira = framework.getAgent('mira')!;
  assert.equal(internals.presents(mira), !opts.legacy, opts.legacy ? 'mira is in legacy mode' : "mira's window is presented");
  const cm = mira.getContextManager();
  const compiled = async (manager: ContextManager) => JSON.stringify((await manager.compile(undefined, undefined, { dryRun: true })).messages);
  const row = (t: string) => cm.getAllMessages().find((m) => textOf(m) === t);
  // getMessage reads a row the record has removed too, so the record is asked for its rows.
  const inRecord = (id: MessageId) => cm.getAllMessages().some((m) => m.id === id);
  return { framework, internals, traces, requests, release, reading: () => reading, mira, cm, compiled, row, inRecord };
}

/** Every value inside `value`, a Set and an array's members included, at any depth. */
function leavesOf(value: unknown): unknown[] {
  if (value instanceof Set) return [value, ...[...value].flatMap(leavesOf)];
  if (Array.isArray(value)) return value.flatMap(leavesOf);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leavesOf);
  return [value];
}

function captureErrors() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

// Each row the shed passes over in mira's legacy record, newest after
// zz-before, which she is sent: three that her request leaves out, and a
// system change, which is the host's and which her compile carries as such.
const leftOut: Record<string, (cm: ContextManager) => MessageId> = {
  'a row a tune-out holds from residents': (cm) => cm.addMessage('someone', [text('zz-held')], { tuneOut: { epochId: 'e1' } } as MessageMetadata),
  "another resident's stored injection": (cm) => cm.addMessage('oren', [text('zz-injection')], { contextInjection: { agent: 'oren', namespace: 'agents/oren', contentHash: 'h-1', part: 0, parts: 1 } } as MessageMetadata),
  'a system change': (cm) => cm.addMessage('host', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]),
  'a row a suppress rule took': (cm) => cm.addMessage('someone', [text('zz-suppressed')], { suppressed: { rule: 'zz-rule', eventType: 'zz-event' } } as MessageMetadata),
};

for (const [kind, store] of Object.entries(leftOut)) {
  it(`in legacy mode, the shed after exhaustion passes over ${kind}, and takes the newest row mira is sent`, async () => {
    const held = kind === 'a row a tune-out holds from residents';
    const h = await boot({ legacy: true, subconscious: held });
    const before = h.internals.addMessage('someone', [text('zz-before')]);
    const newest = store(h.cm);
    assert.ok([before, newest].every(h.inRecord), "both are in mira's record");
    const sent = await h.compiled(h.cm);
    const change = kind === 'a system change';
    assert.deepEqual(['zz-before', 'zz-held', 'zz-injection', 'zz-suppressed', 'Use metric units.', 'system_change'].map((t) => sent.includes(t)), [true, false, false, false, change, change], change ? "mira's compile sends zz-before and the system change" : "mira's compile sends zz-before alone");
    const sub = held ? h.framework.getAgent(h.internals.subconsciousAgentName!)!.getContextManager() : undefined;
    if (sub) assert.ok((await h.compiled(sub)).includes('zz-held'), "the subconscious's compile carries the held row");

    const errors = captureErrors();
    try {
      // An exhaustion with no stream, as a failure before the stream exists reports it.
      for (let i = 0; i < 3; i++) {
        h.internals.emitTrace({ type: 'inference:exhausted', agentName: 'mira', error: '400 invalid_request: zz', errorType: 'invalid_request', httpStatus: 400, retryable: false });
      }
    } finally {
      errors.restore();
    }
    assert.deepEqual({ before: h.inRecord(before), newest: h.inRecord(newest) }, { before: false, newest: true }, 'the shed took zz-before and left the newest row');
    if (sub) assert.ok((await h.compiled(sub)).includes('zz-held'), "the subconscious's compile still carries the held row");
  });
}

for (const [legacy, how] of [[true, 'throws'], [true, 'yields'], [false, 'throws']] as const) {
  it(`a row stored while the failing request is in flight stays, and the retry carries it (${legacy ? 'legacy mode' : 'a presented window'}, the stream ${how} its error)`, async () => {
    const h = await boot({ legacy, failFirst: how });
    h.internals.consecutiveInferenceFailures.set('mira', 2);
    h.framework.start();
    h.framework.pushEvent(input('zz-prompt', ['mira']));
    await until(h.reading, 'the failing request in flight');
    h.framework.pushEvent(input('zz-arrival', []));
    await until(() => h.row('zz-arrival') !== undefined, 'the arrival stored');
    const prompt = h.row('zz-prompt')!.id;
    const arrival = h.row('zz-arrival')!.id;
    assert.deepEqual([h.requests[0]!.includes('zz-prompt'), h.requests[0]!.includes('zz-arrival')], [true, false], 'the failing request carried zz-prompt alone');

    h.release();
    await until(() => h.requests.length >= 2, 'the retry', 8000);
    if (legacy) {
      assert.deepEqual([h.inRecord(prompt), h.inRecord(arrival)], [false, true], 'the shed took zz-prompt from the record and left zz-arrival');
    } else {
      const retracted = h.traces.filter((t) => t.type === 'presentation:retracted' && (t as { reason?: string }).reason === 'shed');
      assert.deepEqual(retracted.map((t) => (t as unknown as { messageIds: MessageId[] }).messageIds), [[prompt]], 'the shed took zz-prompt out of the window, by its ID');
      assert.deepEqual([h.cm.windowStatusOf(prompt), h.cm.windowStatusOf(arrival)], ['undone', 'in']);
    }
    assert.deepEqual([h.requests[1]!.includes('zz-prompt'), h.requests[1]!.includes('zz-arrival')], [false, true], 'the retry carries zz-arrival and not zz-prompt');
    const exhausted = h.traces.find((t) => t.type === 'inference:exhausted');
    assert.ok(exhausted, 'the exhaustion was traced');
    assert.deepEqual(leavesOf(exhausted).filter((v) => v instanceof Set || v === prompt || v === arrival), [], 'the trace carries no record of rows');
  });
}

it('in legacy mode, a failure before the stream exists sheds the newest row mira is sent, past a held row stored after it', async () => {
  let h!: Awaited<ReturnType<typeof boot>>;
  let prompt!: MessageId;
  let held!: MessageId;
  h = await boot({
    legacy: true,
    failFirst: 'setup',
    beforeFailing: () => {
      prompt = h.row('zz-prompt')!.id;
      held = h.cm.addMessage('someone', [text('zz-held')], { tuneOut: { epochId: 'e1' } } as MessageMetadata);
    },
  });
  h.internals.consecutiveInferenceFailures.set('mira', 2);
  const errors = captureErrors();
  try {
    h.framework.start();
    h.framework.pushEvent(input('zz-prompt', ['mira']));
    await until(() => errors.lines.some((l) => l.includes('[inference-rewind]')), 'the breaker');
    assert.deepEqual({ prompt: h.inRecord(prompt), held: h.inRecord(held) }, { prompt: false, held: true }, 'the shed took zz-prompt and left the held row');
  } finally {
    errors.restore();
  }
});

it('in legacy mode, a failing stream with no record of what it carried sheds nothing, and says why', async () => {
  let h!: Awaited<ReturnType<typeof boot>>;
  h = await boot({ legacy: true, failFirst: 'throws', beforeFailing: (stream) => { h.internals.streamCarried.delete(stream!); } });
  h.internals.consecutiveInferenceFailures.set('mira', 2);
  const errors = captureErrors();
  try {
    h.framework.start();
    h.framework.pushEvent(input('zz-prompt', ['mira']));
    await until(() => h.requests.length === 1, 'the failing request');
    const before = h.cm.getAllMessages().map((m) => m.id);
    h.release();
    await until(() => errors.lines.some((l) => l.includes('[inference-rewind]')), 'the breaker');
    assert.deepEqual(before.filter((id) => !h.inRecord(id)), [], 'no row left the record');
    assert.equal(h.internals.exhaustionRewinds.get('mira') ?? 0, 0, 'no rewind was counted');
    assert.ok(errors.lines.some((l) => l.includes('agent=mira has no eligible exchange to shed for this failure — manual repair needed')), errors.lines.join('\n'));
  } finally {
    errors.restore();
  }
});

it('in legacy mode, a failing stream that carried only a system marker sheds nothing, though an uncarried row stands behind it', async () => {
  let h!: Awaited<ReturnType<typeof boot>>;
  let marker!: MessageId;
  h = await boot({
    legacy: true,
    failFirst: 'throws',
    beforeFailing: (stream) => {
      marker = h.cm.addMessage('host', [text('zz-marker')], { system: true } as MessageMetadata);
      h.internals.streamCarried.set(stream!, new Set([marker]));
    },
  });
  h.internals.consecutiveInferenceFailures.set('mira', 2);
  const errors = captureErrors();
  try {
    h.framework.start();
    h.framework.pushEvent(input('zz-prompt', ['mira']));
    await until(() => h.requests.length === 1, 'the failing request');
    const before = h.cm.getAllMessages().map((m) => m.id);
    h.release();
    await until(() => errors.lines.some((l) => l.includes('[inference-rewind]')), 'the breaker');
    assert.deepEqual([...before.filter((id) => !h.inRecord(id)), ...(h.inRecord(marker) ? [] : [marker])], [], 'no row left the record, the marker included');
    assert.equal(h.internals.exhaustionRewinds.get('mira') ?? 0, 0, 'no rewind was counted');
    assert.ok(errors.lines.some((l) => l.includes('agent=mira has no eligible exchange to shed for this failure — manual repair needed')), errors.lines.join('\n'));
  } finally {
    errors.restore();
  }
});

it('in legacy mode, a failure before the stream exists passes over a held tool call and its result, and sheds the newest row mira is sent', async () => {
  let h!: Awaited<ReturnType<typeof boot>>;
  let prompt!: MessageId;
  let hiddenPair!: MessageId[];
  h = await boot({
    legacy: true,
    failFirst: 'setup',
    beforeFailing: () => {
      prompt = h.row('zz-prompt')!.id;
      const held = { tuneOut: { epochId: 'e1' } } as MessageMetadata;
      hiddenPair = [
        h.cm.addMessage('someone', [{ type: 'tool_use', id: 'zz-call', name: 'zz--look', input: {} } as ContentBlock], held),
        h.cm.addMessage('someone', [{ type: 'tool_result', toolUseId: 'zz-call', content: 'zz-seen' } as ContentBlock], held),
      ];
    },
  });
  h.internals.consecutiveInferenceFailures.set('mira', 2);
  const errors = captureErrors();
  try {
    h.framework.start();
    h.framework.pushEvent(input('zz-prompt', ['mira']));
    await until(() => errors.lines.some((l) => l.includes('[inference-rewind]')), 'the breaker');
    assert.deepEqual({ prompt: h.inRecord(prompt), held: hiddenPair.map(h.inRecord) }, { prompt: false, held: [true, true] }, 'the shed took zz-prompt and left the held call and result');
  } finally {
    errors.restore();
  }
});

for (const [result, answers] of [['an unrelated tool result', false], ["the call's own held result", true]] as const) {
  it(`in legacy mode, a failing stream that carried a tool call ${answers ? 'takes' : 'leaves'} ${result} stored right after it`, async () => {
    let h!: Awaited<ReturnType<typeof boot>>;
    let call!: MessageId;
    let after!: MessageId;
    h = await boot({
      legacy: true,
      failFirst: 'throws',
      beforeFailing: (stream) => {
        call = h.cm.addMessage('mira', [{ type: 'tool_use', id: 'zz-call', name: 'zz--look', input: {} } as ContentBlock]);
        h.internals.streamCarried.set(stream!, new Set([call]));
        after = answers
          ? h.cm.addMessage('someone', [{ type: 'tool_result', toolUseId: 'zz-call', content: 'zz-seen' } as ContentBlock], { tuneOut: { epochId: 'e1' } } as MessageMetadata)
          : h.cm.addMessage('oren', [{ type: 'tool_result', toolUseId: 'zz-other', content: 'zz-unrelated' } as ContentBlock]);
      },
    });
    h.internals.consecutiveInferenceFailures.set('mira', 2);
    const errors = captureErrors();
    try {
      h.framework.start();
      h.framework.pushEvent(input('zz-prompt', ['mira']));
      await until(() => h.requests.length === 1, 'the failing request');
      h.release();
      await until(() => errors.lines.some((l) => l.includes('[inference-rewind]')), 'the breaker');
      assert.deepEqual({ call: h.inRecord(call), after: h.inRecord(after) }, { call: false, after: !answers }, `the shed took the carried call${answers ? ' and its result' : ', and left the unrelated result'}`);
    } finally {
      errors.restore();
    }
  });
}

for (const [order, ids] of [['the carried call, then another call', ['zz-call', 'zz-other']], ['another call, then the carried call', ['zz-other', 'zz-call']]] as const) {
  it(`in legacy mode, a failing stream that carried a tool call takes with it a held result body whose two shards answer ${order}`, async () => {
    let h!: Awaited<ReturnType<typeof boot>>;
    let call!: MessageId;
    let shards!: MessageId[];
    h = await boot({
      legacy: true,
      failFirst: 'throws',
      beforeFailing: (stream) => {
        call = h.cm.addMessage('mira', [{ type: 'tool_use', id: 'zz-call', name: 'zz--look', input: {} } as ContentBlock]);
        h.internals.streamCarried.set(stream!, new Set([call]));
        const store = (h.cm as unknown as { messageStore: { append: (...args: unknown[]) => { id: MessageId } } }).messageStore;
        const held = { tuneOut: { epochId: 'e1' } } as MessageMetadata;
        shards = ids.map((toolUseId, shardIndex) =>
          store.append('someone', [{ type: 'tool_result', toolUseId, content: `zz-${toolUseId}` } as ContentBlock], held, undefined, { bodyGroupId: 'zz-results', shardIndex }).id);
      },
    });
    h.internals.consecutiveInferenceFailures.set('mira', 2);
    const errors = captureErrors();
    try {
      h.framework.start();
      h.framework.pushEvent(input('zz-prompt', ['mira']));
      await until(() => h.requests.length === 1, 'the failing request');
      h.release();
      await until(() => errors.lines.some((l) => l.includes('[inference-rewind]')), 'the breaker');
      assert.deepEqual({ call: h.inRecord(call), shards: shards.map(h.inRecord) }, { call: false, shards: [false, false] }, `the shed took the carried call with the whole held body; the log: ${errors.lines.join(' | ')}`);
    } finally {
      errors.restore();
    }
  });
}

it('in legacy mode, the shed takes a body whole when its first shard is sent and its last shard is held, as main does', async () => {
  let h!: Awaited<ReturnType<typeof boot>>;
  let prompt!: MessageId;
  let shards!: MessageId[];
  h = await boot({
    legacy: true,
    failFirst: 'setup',
    beforeFailing: () => {
      prompt = h.row('zz-prompt')!.id;
      const store = (h.cm as unknown as { messageStore: { append: (...args: unknown[]) => { id: MessageId } } }).messageStore;
      shards = [
        store.append('someone', [text('zz-part-0')], {}, undefined, { bodyGroupId: 'zz-mixed', shardIndex: 0 }).id,
        store.append('someone', [text('zz-part-1')], { tuneOut: { epochId: 'e1' } }, undefined, { bodyGroupId: 'zz-mixed', shardIndex: 1 }).id,
      ];
    },
  });
  h.internals.consecutiveInferenceFailures.set('mira', 2);
  const errors = captureErrors();
  try {
    h.framework.start();
    h.framework.pushEvent(input('zz-prompt', ['mira']));
    await until(() => errors.lines.some((l) => l.includes('[inference-rewind]')), 'the breaker');
    assert.deepEqual({ prompt: h.inRecord(prompt), shards: shards.map(h.inRecord) }, { prompt: true, shards: [false, false] }, `the shed took the whole body and left zz-prompt; the log: ${errors.lines.join(' | ')}`);
  } finally {
    errors.restore();
  }
});
