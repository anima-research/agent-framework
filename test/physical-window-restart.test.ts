/**
 * Issue #92 — mid-turn physical-window projection.
 *
 * A turn's continuation rounds append tool results to the compiled request
 * without recompiling, so a turn that starts near the compile target can
 * walk past the provider's HARD context cap mid-turn and take a wire 400.
 * When AgentConfig.physicalWindowTokens is set, the framework projects each
 * continuation round's real size (the cache-INCLUSIVE prompt of the latest
 * call that reported one + that call's output + what the stream grew by
 * since, when later calls reported no prompt + blocks about to be appended +
 * reserve for response) and breaks the stream through the budget-restart
 * path — fresh compile — instead of dispatching a doomed request. Unset →
 * behavior unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import type {
  EventResponse,
  Module,
  ProcessEvent,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

/** Each streamYielding call consumes exactly ONE queued response — the
 *  restart must open a fresh stream rather than continue the first. */
class SequentialStreamMembrane extends MockMembrane {
  private streamIdx = 0;
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.responses.slice(this.streamIdx, ++this.streamIdx));
    this.lastStream = stream;
    return stream;
  }
}

/** Explicit response queue per streamYielding call. */
class QueuedStreamsMembrane extends MockMembrane {
  constructor(private queues: NormalizedResponse[][]) {
    super();
  }
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.queues.shift() ?? []);
    this.lastStream = stream;
    return stream;
  }
}

class BlobToolModule implements Module {
  readonly name = 'canned';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'blob', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: true, data: { blob: 'x'.repeat(30_000) } };
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

/** Tool round whose usage reports a near-cap REAL prefix: only 5k fresh
 *  input (far under maxStreamTokens) but 195k cache-read — the projection
 *  must count cached tokens or it misses the window entirely. */
function nearCapToolResponse(): NormalizedResponse {
  const r = createMockResponse([
    { type: 'text', text: 'Working…' },
    { type: 'tool_use', id: 'call_1', name: 'canned--fetch', input: {} },
  ], 'tool_use');
  (r as { usage: unknown }).usage = {
    inputTokens: 5_000,
    outputTokens: 5,
    cacheReadTokens: 195_000,
  };
  return r;
}

async function pollUntil(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

function storedTexts(framework: AgentFramework): string {
  const cm = framework.getAgent('prime')?.getContextManager();
  const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{
    content: Array<{ type: string; text?: string }>;
  }>;
  return msgs
    .flatMap((m) => m.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

async function runTurn(
  physicalWindowTokens: number | undefined,
  /** Sequential = one response per stream (restart opens stream 2); plain
   *  MockMembrane feeds the whole queue to stream 1 (no-restart continues). */
  membrane: MockMembrane,
): Promise<{
  framework: AgentFramework;
  membrane: MockMembrane;
  traces: TraceEvent[];
  tempDir: string;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), 'phys-window-'));
  membrane.pushResponse(nearCapToolResponse());
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered final answer' }]));

  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime',
      model: 'test-model',
      systemPrompt: 'You are prime.',
      allowedTools: 'all',
      maxTokens: 4_000,
      ...(physicalWindowTokens !== undefined ? { physicalWindowTokens } : {}),
    }],
    modules: [new BlobToolModule()],
    syncIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  framework.start();
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text: 'fetch it' }],
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent);
  return { framework, membrane, traces, tempDir };
}

describe('physical-window mid-turn restart (issue #92)', () => {
  it('restarts through a fresh compile instead of dispatching past the hard cap', async () => {
    // Projection: 200k real prefix (5k fresh + 195k cached) + appended tool
    // result + 4k reserve > 200k window → restart. The fresh-input-only
    // check (5k vs maxStreamTokens 150k) would have sent the doomed request.
    const h = await runTurn(200_000, new SequentialStreamMembrane());
    try {
      const done = await pollUntil(() => storedTexts(h.framework).includes('Recovered final answer'));
      assert.ok(done, 'turn should complete with the post-restart answer');
      assert.strictEqual(h.membrane.calls.length, 2, 'restart should open a second stream');
      const restarted = h.traces.find((e) => e.type === 'inference:stream_restarted') as
        { reason?: string; inputTokens?: number; budget?: number } | undefined;
      assert.ok(restarted, 'a stream_restarted trace should be emitted');
      assert.strictEqual(restarted.reason, 'physical_window');
      assert.strictEqual(restarted.budget, 200_000);
      assert.ok((restarted.inputTokens ?? 0) > 200_000, 'trace should carry the projected size');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('does not inherit the pre-restart window size into the new stream', async () => {
    // Regression pin for the reset (opus-rev review finding #1): after a
    // physical-window restart, the fresh stream runs a tool round whose
    // usage reports nothing (membrane still emits the event: the stream's
    // running total, all 0) before reaching the tool-result boundary.
    // Without the stream-start reset, the projection would run on the
    // inherited 200k figure — the very number that caused the restart — and
    // restart again into an empty queue (loop; this test would then time
    // out). With it, no call on the new stream has reported a prompt yet, so
    // the projection doesn't run.
    const tempDir = mkdtempSync(join(tmpdir(), 'phys-window-'));
    const noUsageToolResponse = createMockResponse([
      { type: 'text', text: 'Continuing…' },
      { type: 'tool_use', id: 'call_2', name: 'canned--fetch', input: {} },
    ], 'tool_use');
    (noUsageToolResponse as { usage: unknown }).usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const membrane = new QueuedStreamsMembrane([
      [nearCapToolResponse()],
      [noUsageToolResponse, createMockResponse([{ type: 'text', text: 'Recovered final answer' }])],
    ]);

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
        maxTokens: 4_000,
        physicalWindowTokens: 200_000,
      }],
      modules: [new BlobToolModule()],
      syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    framework.start();
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: [{ type: 'text', text: 'fetch it' }],
      metadata: {},
      triggerInference: true,
    } as unknown as ProcessEvent);
    try {
      const done = await pollUntil(() => storedTexts(framework).includes('Recovered final answer'));
      assert.ok(done, 'the post-restart stream must resume, not restart again');
      assert.strictEqual(membrane.calls.length, 2, 'exactly one restart');
      const restarts = traces.filter((e) => e.type === 'inference:stream_restarted');
      assert.strictEqual(restarts.length, 1, 'the inherited value must not trigger a second restart');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** A tool round (or, with id null, a final answer) whose usage is the
   *  stream's running total so far, as membrane's usage events are. */
  const round = (
    id: string | null,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens?: number },
  ) => {
    const r = id === null
      ? createMockResponse([{ type: 'text', text: 'Answered on the first stream' }])
      : createMockResponse([
        { type: 'text', text: 'Working…' },
        { type: 'tool_use', id, name: 'canned--fetch', input: {} },
      ], 'tool_use');
    (r as { usage: unknown }).usage = usage;
    return r;
  };

  /** One turn on a 200k window with a 32k response reserve. */
  async function windowTurn(streams: NormalizedResponse[][], module: Module = new BlobToolModule()) {
    const tempDir = mkdtempSync(join(tmpdir(), 'phys-window-'));
    const membrane = new QueuedStreamsMembrane(streams);
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
        maxTokens: 32_000,
        physicalWindowTokens: 200_000,
      }],
      modules: [module],
      syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    framework.start();
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: [{ type: 'text', text: 'fetch it' }],
      metadata: {},
      triggerInference: true,
    } as unknown as ProcessEvent);
    const done = await pollUntil(() => /Answered (on the first stream|after a restart)/.test(storedTexts(framework)));
    const restarts = traces.filter((e) => e.type === 'inference:stream_restarted') as Array<{ reason?: string; inputTokens?: number }>;
    return { framework, membrane, restarts, done, close: async () => { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); } };
  }
  const afterRestart = [createMockResponse([{ type: 'text', text: 'Answered after a restart' }])];

  it("projects from the latest call, not the stream's running total", async () => {
    // Membrane's usage event is cumulative across the tool loop. Each call
    // here fits: the second call's prompt is 118k (20k fresh, 20k cache
    // write, 78k cache read), and with its 30k output, the appended tool
    // result and the 32k reserve the next request projects to about 186k of
    // the 200k window. The first call put 20k or more into every count, so
    // taking any one term from the running total instead crosses the window.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 20_000, cacheCreationTokens: 20_000, cacheReadTokens: 40_000, outputTokens: 20_000 }),
        round('call_2', { inputTokens: 40_000, cacheCreationTokens: 40_000, cacheReadTokens: 118_000, outputTokens: 50_000 }),
        round(null, { inputTokens: 42_000, cacheCreationTokens: 41_000, cacheReadTokens: 236_000, outputTokens: 50_500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.deepStrictEqual(t.restarts, [], 'every call fits the window, so the stream must not restart');
      assert.strictEqual(t.membrane.calls.length, 1);
      assert.ok(storedTexts(t.framework).includes('Answered on the first stream'));
    } finally {
      await t.close();
    }
  });

  it("restarts when the latest call's output is what crosses the window", async () => {
    // A 120k prompt with 45k of output: with the appended tool result and
    // the 32k reserve the next request projects past 200k, though without
    // the output it would fit.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 20_000, cacheReadTokens: 100_000, outputTokens: 45_000 }),
        round(null, { inputTokens: 21_000, cacheReadTokens: 220_000, outputTokens: 45_500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.strictEqual(t.restarts.length, 1, 'the projection must count the output');
      assert.strictEqual(t.restarts[0]!.reason, 'physical_window');
      assert.ok((t.restarts[0]!.inputTokens ?? 0) > 200_000);
      assert.ok(storedTexts(t.framework).includes('Answered after a restart'));
    } finally {
      await t.close();
    }
  });

  it("restarts at a later boundary on that call's own figures", async () => {
    // The first call fits easily (an 80k prompt with 30k of output); the
    // second alone crosses the window (a 190k prompt with 10k of output, so
    // with the appended tool result and the 32k reserve, about 238k). The
    // second boundary must project from the second call: figures kept from
    // the first would project about 148k and dispatch past the cap. When
    // this test was added, every other restart test here crossed at the
    // first boundary.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 20_000, cacheReadTokens: 60_000, outputTokens: 30_000 }),
        round('call_2', { inputTokens: 30_000, cacheReadTokens: 240_000, outputTokens: 40_000 }),
        round(null, { inputTokens: 31_000, cacheReadTokens: 480_000, outputTokens: 40_500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.strictEqual(t.restarts.length, 1, 'the second boundary must restart');
      assert.strictEqual(t.restarts[0]!.reason, 'physical_window');
      // The second call's own figures: its 190k prompt and 10k output, the
      // appended round and the reserve. The first call's 30k output, kept,
      // would project 258,043.
      assert.strictEqual(t.restarts[0]!.inputTokens, 190_000 + 10_000 + APPENDED + 32_000);
      assert.strictEqual(t.membrane.calls.length, 2, 'the first stream, then the restart');
      assert.ok(storedTexts(t.framework).includes('Answered after a restart'));
    } finally {
      await t.close();
    }
  });

  // Each blob tool round appends 6,043 tokens by the framework's estimate
  // (estimateAppendedRoundTokens: the 24,000-character inline cap at chars/4,
  // plus its per-block overhead). The restart trace's inputTokens is the
  // projection, so the tests below pin it whole.
  const APPENDED = 6_043;

  it('counts a cache-write prompt term toward a restart', async () => {
    // 10k fresh + 30k cache write + 120k cache read = a 160k prompt; with 2k
    // output, the appended round and the 32k reserve it projects to 200,043.
    // Without the cache-write term it would project 170,043 and fit.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 10_000, cacheCreationTokens: 30_000, cacheReadTokens: 120_000, outputTokens: 2_000 }),
        round(null, { inputTokens: 11_000, cacheCreationTokens: 30_000, cacheReadTokens: 280_000, outputTokens: 2_500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.strictEqual(t.restarts.length, 1);
      assert.strictEqual(t.restarts[0]!.reason, 'physical_window');
      assert.strictEqual(t.restarts[0]!.inputTokens, 160_000 + 2_000 + APPENDED + 32_000);
    } finally {
      await t.close();
    }
  });

  it('projects the growth since the last call that reported a prompt: the rounds appended since count', async () => {
    // Call 1 reports a 155k prompt and 2k output: 195,043 projected, it fits.
    // Call 2 reports 2k of output but no prompt (its input counts repeat the
    // running total). Its request was call 1's prompt and output plus the
    // round appended after call 1, so the next boundary adds that round and
    // call 2's output to call 1's figures: 203,086, past the window. Keeping
    // call 1's figures alone would project 195,043 again and dispatch.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 15_000, cacheReadTokens: 140_000, outputTokens: 2_000 }),
        round('call_2', { inputTokens: 15_000, cacheReadTokens: 140_000, outputTokens: 4_000 }),
        round(null, { inputTokens: 16_000, cacheReadTokens: 300_000, outputTokens: 4_500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.strictEqual(t.restarts.length, 1, 'the second boundary must restart');
      assert.strictEqual(t.restarts[0]!.inputTokens, 155_000 + 2_000 + (APPENDED + 2_000) + APPENDED + 32_000);
      assert.strictEqual(t.membrane.calls.length, 2, 'the first stream, then the restart');
    } finally {
      await t.close();
    }
  });

  it("counts the output of a call that reports output but no prompt", async () => {
    // Call 1: a 150k prompt and 2k output, 190,043 projected. Call 2 reports
    // 5k of output and no prompt: with it the next boundary projects 201,086
    // and restarts; dropping it would project 196,086 and dispatch.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 10_000, cacheReadTokens: 140_000, outputTokens: 2_000 }),
        round('call_2', { inputTokens: 10_000, cacheReadTokens: 140_000, outputTokens: 7_000 }),
        round(null, { inputTokens: 11_000, cacheReadTokens: 300_000, outputTokens: 7_500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.strictEqual(t.restarts.length, 1);
      assert.strictEqual(t.restarts[0]!.inputTokens, 150_000 + 2_000 + (APPENDED + 5_000) + APPENDED + 32_000);
    } finally {
      await t.close();
    }
  });

  it('bounds the output of a call that reports a prompt but no output by maxTokens', async () => {
    // Call 1 reports a 150k prompt and no output, though it wrote a tool_use:
    // its output counts as the 32k it could have been, so the first boundary
    // projects 150k + 32k + the appended round + the 32k reserve = 220,043,
    // a restart. Counting it as 0 would project 188,043 and dispatch.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 10_000, cacheReadTokens: 140_000, outputTokens: 0 }),
        round(null, { inputTokens: 11_000, cacheReadTokens: 290_000, outputTokens: 500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.strictEqual(t.restarts.length, 1);
      assert.strictEqual(t.restarts[0]!.inputTokens, 150_000 + 32_000 + APPENDED + 32_000);
    } finally {
      await t.close();
    }
  });

  it('bounds the output of a call that reports nothing by maxTokens', async () => {
    // Call 2's usage event repeats the running total: no prompt and no
    // output reported. Its output is unknown, so the projection counts the
    // 32k it could have been: 120k + 5k + (the appended round + 32k) + the
    // next appended round + the 32k reserve = 201,086, a restart. Counting
    // it as 0 would project 169,086 and dispatch.
    const first = { inputTokens: 20_000, cacheReadTokens: 100_000, outputTokens: 5_000 };
    const t = await windowTurn([
      [round('call_1', first), round('call_2', first), round(null, first)],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.strictEqual(t.restarts.length, 1);
      assert.strictEqual(t.restarts[0]!.inputTokens, 120_000 + 5_000 + (APPENDED + 32_000) + APPENDED + 32_000);
    } finally {
      await t.close();
    }
  });

  it('starts the growth again when a later call reports a prompt', async () => {
    // Call 1 reports a 100k prompt; call 2 reports nothing, so the second
    // boundary projects 100k + 2k + (6,043 + 32k) + 6,043 + 32k = 178,086,
    // which fits. Call 3 reports a 140k prompt and 2k output: the third
    // boundary projects from it alone, 180,043, and fits. Carrying the growth
    // past call 3 (6,043 + 32k + 6,043) would project 224,129 and restart.
    const t = await windowTurn([
      [
        round('call_1', { inputTokens: 10_000, cacheReadTokens: 90_000, outputTokens: 2_000 }),
        round('call_2', { inputTokens: 10_000, cacheReadTokens: 90_000, outputTokens: 2_000 }),
        round('call_3', { inputTokens: 30_000, cacheReadTokens: 210_000, outputTokens: 4_000 }),
        round(null, { inputTokens: 31_000, cacheReadTokens: 360_000, outputTokens: 4_500 }),
      ],
      afterRestart,
    ]);
    try {
      assert.ok(t.done, 'the turn should finish');
      assert.deepStrictEqual(t.restarts, [], 'every boundary fits');
      assert.strictEqual(t.membrane.calls.length, 1);
    } finally {
      await t.close();
    }
  });

  it('leaves behavior unchanged when physicalWindowTokens is unset', async () => {
    const h = await runTurn(undefined, new MockMembrane());
    try {
      // Same near-cap usage, no declared window: the stream resumes in place
      // and the SECOND queued response is never consumed by a restart —
      // MockYieldingStream continues the first stream instead.
      const done = await pollUntil(() => storedTexts(h.framework).includes('Recovered final answer'));
      assert.ok(done, 'turn should complete on the original stream');
      assert.strictEqual(h.membrane.calls.length, 1, 'no second stream without a declared window');
      assert.ok(
        !h.traces.some((e) => e.type === 'inference:stream_restarted'),
        'no restart trace without a declared window',
      );
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });
});
