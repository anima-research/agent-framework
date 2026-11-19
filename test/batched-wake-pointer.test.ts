/**
 * A batched wake's line where something follows its messages. A debounced
 * batch of messages already in the window writes no `[Gate: …]` line when it
 * is delivered (gate-batch-in-window.test.ts). But a batch's messages can sit
 * through its whole quiet period, so by the time its turn starts a message
 * that woke nothing (another channel's chatter) can be the newest entry, and
 * an agent reading the last entry as its cause would answer it into the
 * batch's channel. So a fresh start of a turn a batched wake starts (its
 * BATCH_ROWS) writes one line naming the wake's messages its window holds,
 * as its own row, when a row a reply could be meant for follows them there:
 * none for a turn that merges a wake that isn't a batch's, and in a window
 * still in legacy mode, only the delivery agent's start. The scan reads the
 * window's last 32 rows: where every one of them is a row it leaves aside,
 * such as a clock row or a stored context injection, it writes the line.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager as StoreWindow } from '@animalabs/context-manager';
import type { ContextInjection, MessageMetadata } from '@animalabs/context-manager';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework, CLOCK_ROW_KIND, asOwnRow, withAudience, type Agent } from '../src/index.js';
import * as frameworkModule from '../src/framework.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { incoming, registerOpen, MENTION, AMBIENT } from './helpers/admission.js';
import { GateModule, waitCall, say } from './helpers/dendrite.js';
import { storeOwnRow } from '../src/dendrite/audience.js';

/** The framework's internal mark of a batched wake's rows, read loosely so
 *  this file still runs, red, against a framework without it. */
const BATCH_ROWS: symbol = (frameworkModule as unknown as { BATCH_ROWS?: symbol }).BATCH_ROWS ?? Symbol('no batch mark');

const LINE = /^\[Gate: (\d+) events? matched\]\n\n- (\d+) messages? in (.+) \(oldest ~\d+s ago\) — already shown above at arrival; this is a batched wake, not new content$/;

async function settleUntil(framework: { runUntilIdle(): Promise<void> }, cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await framework.runUntilIdle();
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** End `name`'s provider hold now, as its timer would when it runs out. */
function releaseHoldNow(framework: unknown, name: string): void {
  const f = framework as {
    providerAccelerationCooldowns: Map<string, { until: number }>;
    releaseProviderAccelerationCooldown(name: string): void;
  };
  const hold = f.providerAccelerationCooldowns.get(name);
  assert.ok(hold, `premise: ${name} is held`);
  hold.until = Date.now();
  f.releaseProviderAccelerationCooldown(name);
}

/** The first call meets an organization-acceleration 429 (a provider hold),
 *  the next succeeds. */
class HoldThenAnswerMembrane extends MockMembrane {
  private n = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    if (++this.n === 1) {
      const error = new MembraneError({
        type: 'rate_limit', retryable: true, httpStatus: 429,
        message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
        rawError: { status: 429 }, rawRequest: request,
      });
      return {
        isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
        provideToolResults() { throw new Error('not waiting'); },
        cancel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> { yield { type: 'error', error } as StreamEvent; },
      } as unknown as YieldingStream;
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answered' }])]);
  }
}

type Bare = {
  framework: AgentFramework;
  membrane: MockMembrane;
  dir: string;
  internals: {
    addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
    pendingRequests: Array<Record<string, unknown>>;
    providerAccelerationDefaultCooldownMs: number;
    providerAccelerationJitterMs: number;
    providerAccelerationCooldowns: Map<string, Record<string, unknown>>;
    processInferenceRequests(): Promise<void>;
    storeInjections(agent: Agent, injections: ContextInjection[] | undefined): unknown;
    placeBatchLine(agent: Agent, rows: readonly string[]): void;
    activeTurnTokens: Map<string, number>;
  };
};

async function bare(names: string[], membrane: MockMembrane = new MockMembrane(), extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}): Promise<Bare> {
  const dir = mkdtempSync(join(tmpdir(), 'wake-pointer-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: names.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, ...((extra[name] as object | undefined) ?? {}) })),
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...config,
  } as never);
  return { framework, membrane, dir, internals: framework as unknown as Bare['internals'] };
}
async function done(b: Bare): Promise<void> {
  await b.framework.stop();
  rmSync(b.dir, { recursive: true, force: true });
}
const storeDm = (b: Bare, eventId: string, text: string): string =>
  b.internals.addMessage('antra', [{ type: 'text', text }], { serverId: 'discord', eventId, channelId: 'discord:dm:1' });
const storeChatter = (b: Bare, text = 'unrelated chatter'): string =>
  b.internals.addMessage('someone', [{ type: 'text', text }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: `m-${text}` });
const rowText = (m: { content: Array<{ type: string; text?: string }> }): string => m.content.map((x) => (x.type === 'text' ? x.text ?? '' : '')).join('');
const texts = (b: Bare, name = 'scout'): string[] => b.framework.getAgent(name)!.getContextManager().getAllMessages().map(rowText);
/** The rows of `name`'s presented window, as the start's request holds them. */
const presentedTexts = (b: Bare, name = 'scout'): string[] => b.framework.getAgent(name)!.getContextManager().getPresentedMessages().map(rowText);
/** The gate lines written as `name`'s own rows. */
const linesOf = (b: Bare, name = 'scout'): string[] => b.framework.getAgent(name)!.getContextManager().getAllMessages()
  .filter((m) => (m.metadata as { ownRowOf?: unknown } | undefined)?.ownRowOf === name)
  .map(rowText).filter((t) => t.startsWith('[Gate:'));
/** Whether the `n`th request `b`'s membrane was sent holds `text`. */
const inRequest = (b: Bare, text: string, n = 0): boolean => JSON.stringify(b.membrane.calls[n]).includes(text);
const wake = (rows: string[], agentName = 'scout', timestamp = Date.now()) =>
  ({ agentName, reason: 'gate:debounce', source: 'gate', timestamp, [BATCH_ROWS]: rows });

describe("a batched wake's line at its turn's start, where something follows its messages", () => {
  it('a DM followed by chatter: the start writes one line naming the DM, after the chatter and in its request', async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      const added: Array<{ messageId?: string; source?: string }> = [];
      b.framework.onTrace((event) => { if (event.type === 'message:added') added.push(event as { messageId?: string; source?: string }); });
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['1', '1', 'discord:dm:1'], lines[0]);
      const all = texts(b);
      assert.ok(all.indexOf(lines[0]!) > all.indexOf('unrelated chatter'), 'the line follows the chatter');
      assert.ok(JSON.stringify(b.membrane.calls[0]).includes('[Gate: 1 event matched]'), 'and is in the turn\'s request');
      const line = b.framework.getAgent('scout')!.getContextManager().getAllMessages().find((m) => rowText(m) === lines[0]);
      assert.deepEqual(added.filter((e) => e.source === 'gate:wake-line').map((e) => e.messageId), [line!.id], "the line's message:added trace names its row");
    } finally { await done(b); }
  });

  it("a read that throws while the start decides the line: the turn goes on without one, and the fault is logged", async (t) => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      const cm = b.framework.getAgent('scout')!.getContextManager();
      const status = cm.windowStatusOf.bind(cm);
      t.mock.method(cm, 'windowStatusOf', (id: Parameters<typeof cm.windowStatusOf>[0]) => {
        if (id === dm) throw new Error('store unreadable');
        return status(id);
      });
      const logged: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'the turn ran');
      assert.deepEqual(linesOf(b), [], 'without a line');
      assert.ok(logged.some((line) => line.includes("a batched wake's line") && line.includes('store unreadable')), logged.join('\n'));
    } finally { await done(b); }
  });

  it('a DM still the newest entry: no line', async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      assert.ok(inRequest(b, 'are you there?'), "premise: the start's request holds the batch's message");
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });

  it('rows not in the window: no line', async () => {
    const b = await bare(['scout']);
    try {
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake(['no-such-row']));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });

  it('a clock row after it: no line', async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      const cm = b.framework.getAgent('scout')!.getContextManager() as unknown as { addMessage(participant: string, content: unknown[], metadata: unknown): unknown };
      cm.addMessage('user', [{ type: 'text', text: '[clock row]' }], { system: true, kind: CLOCK_ROW_KIND, clock: { at: Date.now() } });
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const shown = presentedTexts(b);
      assert.ok(shown.indexOf('are you there?') >= 0 && shown.indexOf('are you there?') < shown.indexOf('[clock row]'), `premise: the window holds the DM, then the clock row: ${JSON.stringify(shown)}`);
      assert.deepEqual(linesOf(b), [], "a clock row isn't a message a reply could be meant for");
    } finally { await done(b); }
  });

  it('a message after a clock row after it: the line', async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      const cm = b.framework.getAgent('scout')!.getContextManager() as unknown as { addMessage(participant: string, content: unknown[], metadata: unknown): unknown };
      cm.addMessage('user', [{ type: 'text', text: '[clock row]' }], { system: true, kind: CLOCK_ROW_KIND, clock: { at: Date.now() } });
      storeChatter(b, 'after the clock');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(linesOf(b).length, 1);
    } finally { await done(b); }
  });

  it("a row the agent's view leaves out after it, as a tune-out's: no line", async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      b.internals.addMessage('someone', [{ type: 'text', text: 'diverted after it' }],
        { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-diverted', tuneOut: { epochId: 'epoch-1' } });
      assert.ok(texts(b).includes('diverted after it'), 'premise: stored');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      assert.ok(inRequest(b, 'are you there?'), "premise: the start's request holds the batch's message");
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });

  it('a stored injection after it: no line', async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      const scout = b.framework.getAgent('scout')!;
      b.internals.storeInjections(scout, [{ namespace: 'lessons', position: 'afterUser', content: [{ type: 'text', text: 'LESSON one' }] } as ContextInjection]);
      assert.ok(texts(b).includes('LESSON one'), 'premise: the injection is stored');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const shown = presentedTexts(b);
      assert.ok(shown.indexOf('are you there?') >= 0 && shown.indexOf('are you there?') < shown.indexOf('LESSON one'), `premise: the window holds the DM, then the injection: ${JSON.stringify(shown)}`);
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });

  it('a start that resumes a logical turn writes none', async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push({ ...wake([dm]), reason: 'tool_result_guard_retry', source: 'framework' });
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the resuming start ran');
      assert.ok(inRequest(b, 'are you there?'), "premise: the resuming start's request holds the batch's message");
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });
});

describe("a batched wake's line is written once per wake", () => {
  it("a turn the provider holds after its start wrote the line: the hold's fresh compile doesn't write it again", async () => {
    const b = await bare(['scout'], new HoldThenAnswerMembrane());
    b.internals.providerAccelerationDefaultCooldownMs = 60_000;
    b.internals.providerAccelerationJitterMs = 0;
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the first attempt met the hold');
      releaseHoldNow(b.framework, 'scout');
      await settleUntil(b.framework, () => b.membrane.calls.length >= 2, "the hold's fresh compile");
      assert.equal(linesOf(b).length, 1);
    } finally { await done(b); }
  });

  it("a line its first start left out, then a provider hold with an arrival during it: the hold's fresh start writes the line after the arrival", async () => {
    const b = await bare(['scout'], new HoldThenAnswerMembrane());
    b.internals.providerAccelerationDefaultCooldownMs = 60_000;
    b.internals.providerAccelerationJitterMs = 0;
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the first attempt met the hold');
      assert.deepEqual(linesOf(b), [], 'premise: the first start left the line out');
      storeChatter(b, 'chatter during the hold');
      releaseHoldNow(b.framework, 'scout');
      await settleUntil(b.framework, () => b.membrane.calls.length >= 2, "the hold's fresh compile");
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'written once');
      const all = texts(b);
      assert.ok(all.indexOf(lines[0]!) > all.indexOf('chatter during the hold'), 'after the chatter');
    } finally { await done(b); }
  });

  it("the start while the host is quiesced writes none, and leaves it for a later start", async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      const scout = b.framework.getAgent('scout')!;
      const rows = [dm];
      assert.equal(typeof b.internals.placeBatchLine, 'function', 'premise: the start places a batched wake\'s line');
      await b.framework.quiesce({ reason: 'test window' });
      b.internals.placeBatchLine(scout, rows);
      assert.deepEqual(linesOf(b), [], 'none written while quiesced');
      await b.framework.resume();
      b.internals.placeBatchLine(scout, rows);
      assert.equal(linesOf(b).length, 1, 'a later start writes it');
      b.internals.placeBatchLine(scout, rows);
      assert.equal(linesOf(b).length, 1, 'and no start writes it twice');
    } finally { await done(b); }
  });

  for (const order of ['older first', 'newer first'] as const) it(`two wakes parked while the host is quiesced, coalesced into one (${order}): the line at resume names both`, async () => {
    const b = await bare(['scout']);
    try {
      const first = storeDm(b, 'ev-1', 'first DM');
      const second = storeDm(b, 'ev-2', 'second DM');
      storeChatter(b);
      await b.framework.quiesce({ reason: 'test window' });
      const t0 = Date.now();
      const [a, z] = order === 'older first' ? [t0, t0 + 10] : [t0 + 10, t0];
      b.internals.pendingRequests.push(wake([first], 'scout', a));
      b.internals.pendingRequests.push(wake([second], 'scout', z));
      await b.internals.processInferenceRequests();
      assert.equal(b.membrane.calls.length, 0, 'premise: parked while quiesced');
      assert.equal(b.internals.pendingRequests.length, 1, 'premise: coalesced into one');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      await b.framework.resume();
      await settleUntil(b.framework, () => b.membrane.calls.length >= 1, 'the turn at resume');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['2', '2', 'discord:dm:1'], lines[0]);
    } finally { await done(b); }
  });

  it('two held wakes alike in everything but their rows: the hold keeps both, and its release names both', async () => {
    const b = await bare(['scout']);
    try {
      const first = storeDm(b, 'ev-1', 'first DM');
      const second = storeDm(b, 'ev-2', 'second DM');
      storeChatter(b);
      const now = Date.now();
      const timer = setTimeout(() => {}, 60_000);
      b.internals.providerAccelerationCooldowns.set('scout', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'test hold', failures: 1 });
      const at = Date.now();
      b.internals.pendingRequests.push(wake([first], 'scout', at));
      b.internals.pendingRequests.push(wake([second], 'scout', at));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 0, 'premise: held');
      const held = b.internals.providerAccelerationCooldowns.get('scout')!.heldRequests as unknown[];
      assert.equal(held.length, 2, 'the hold keeps both wakes');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      clearTimeout(timer);
      releaseHoldNow(b.framework, 'scout');
      await settleUntil(b.framework, () => b.membrane.calls.length >= 1, "the hold's release");
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['2', '2', 'discord:dm:1'], lines[0]);
    } finally { await done(b); }
  });

  it("a held turn whose start wrote its line, merged at the hold's release with a new batch: the new line names the new batch alone", async () => {
    const b = await bare(['scout'], new HoldThenAnswerMembrane());
    b.internals.providerAccelerationDefaultCooldownMs = 60_000;
    b.internals.providerAccelerationJitterMs = 0;
    try {
      const first = storeDm(b, 'ev-1', 'first DM');
      storeChatter(b, 'first chatter');
      b.internals.pendingRequests.push(wake([first]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the first attempt met the hold');
      assert.equal(linesOf(b).length, 1, "premise: the first start wrote the first batch's line");
      const second = b.internals.addMessage('antra', [{ type: 'text', text: 'second DM' }], { serverId: 'discord', eventId: 'ev-2', channelId: 'discord:dm:2' });
      storeChatter(b, 'second chatter');
      b.internals.pendingRequests.push(wake([second]));
      releaseHoldNow(b.framework, 'scout');
      await settleUntil(b.framework, () => b.membrane.calls.length >= 2, "the hold's release");
      assert.equal(b.membrane.calls.length, 2, 'premise: one merged turn at the release');
      const lines = linesOf(b);
      assert.equal(lines.length, 2, 'one more line');
      assert.deepEqual(LINE.exec(lines[1]!)?.slice(1), ['1', '1', 'discord:dm:2'], `the first batch isn't named again: ${lines[1]}`);
    } finally { await done(b); }
  });

  it("a line whose write fails doesn't fail the start and stays undecided for a later one; one that landed though its write threw counts as written", async () => {
    const b = await bare(['scout']);
    try {
      const scout = b.framework.getAgent('scout')!;
      const cm = scout.getContextManager() as unknown as { addMessage: (...a: unknown[]) => unknown };
      const real = cm.addMessage;
      const first = [storeDm(b, 'ev-1', 'are you there?')];
      storeChatter(b);
      cm.addMessage = () => { throw new Error('store unavailable'); };
      try { b.internals.placeBatchLine(scout, first); } finally { cm.addMessage = real; }
      assert.deepEqual(linesOf(b), [], 'not written');
      b.internals.placeBatchLine(scout, first);
      assert.equal(linesOf(b).length, 1, 'written by the next start');
      const second = [storeDm(b, 'ev-2', 'and now?')];
      storeChatter(b, 'more chatter');
      cm.addMessage = (...a: unknown[]) => { real.apply(cm, a); throw new Error('propagation failed'); };
      try { b.internals.placeBatchLine(scout, second); } finally { cm.addMessage = real; }
      assert.equal(linesOf(b).length, 2, 'it landed');
      b.internals.placeBatchLine(scout, second);
      assert.equal(linesOf(b).length, 2, 'and the next start writes it no second time');
    } finally { await done(b); }
  });

  it("the agent's own row presented during its turn, before a batch row stored earlier is: the batch row enters the window after it, newest, so no line", async () => {
    const b = await bare(['scout']);
    try {
      const scout = b.framework.getAgent('scout')!;
      const window = (): string[] => scout.getContextManager().getPresentedMessages().map(rowText);
      b.internals.activeTurnTokens.set('scout', 1);
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeOwnRow(scout, 'scout', [{ type: 'text', text: 'my own words' }]);
      b.internals.activeTurnTokens.delete('scout');
      assert.ok(window().includes('my own words'), 'premise: the own row is presented');
      assert.ok(!window().includes('are you there?'), 'premise: the batch row waits outside the window');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const all = window();
      assert.ok(all.indexOf('are you there?') > all.indexOf('my own words'), 'premise: the batch row entered after the own row');
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });

  it("a batched message whose metadata names its channel, chatter after it: the line names the channel by that name, as the gate's quote did", async () => {
    const b = await bare(['scout']);
    try {
      const row = b.internals.addMessage('antra', [{ type: 'text', text: 'in work' }], { serverId: 'discord', channelId: 'discord:g1:work', channelName: 'work', messageId: 'w1' });
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([row]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['1', '1', '#work (discord:g1:work)'], lines[0]);
    } finally { await done(b); }
  });

  it("a batched message whose channel name already starts with '#', chatter after it: the line names it with one '#'", async () => {
    const b = await bare(['scout']);
    try {
      const row = b.internals.addMessage('antra', [{ type: 'text', text: 'in design' }], { serverId: 'discord', channelId: 'discord:g1:design', channelName: '#design', messageId: 'd1' });
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([row]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['1', '1', '#design (discord:g1:design)'], lines[0]);
    } finally { await done(b); }
  });

  it("a batched message whose channel name and id hold a supplied opening, chatter after it: the line marks each opening", async () => {
    const b = await bare(['scout']);
    try {
      const row = b.internals.addMessage('antra', [{ type: 'text', text: 'in the room' }], { serverId: 'discord', channelId: 'raw\u2029[drafts]', channelName: 'room\u2028[delivered] nothing', messageId: 'r1' });
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([row]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.ok(lines[0]!.includes('in #room \\[delivered] nothing (raw \\[drafts])'), JSON.stringify(lines[0]));
    } finally { await done(b); }
  });

  for (const [clockRows, line] of [[31, false], [32, true]] as const) {
    it(`a DM followed by ${clockRows} clock rows: ${line ? 'past the 32 newest rows the start reads, so the line' : 'within the 32 newest rows the start reads, so no line'}`, async () => {
      const b = await bare(['scout']);
      try {
        const dm = storeDm(b, 'ev-1', 'are you there?');
        const cm = b.framework.getAgent('scout')!.getContextManager() as unknown as { addMessage(participant: string, content: unknown[], metadata: unknown): unknown };
        for (let i = 0; i < clockRows; i++) cm.addMessage('user', [{ type: 'text', text: `[clock row ${i}]` }], { system: true, kind: CLOCK_ROW_KIND, clock: { at: Date.now() } });
        b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
        b.internals.pendingRequests.push(wake([dm]));
        await b.framework.runUntilIdle();
        assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
        assert.ok(inRequest(b, 'are you there?'), "premise: the start's request holds the batch's message");
        assert.equal(linesOf(b).length, line ? 1 : 0);
      } finally { await done(b); }
    });
  }

  it('the line gives the age of the oldest of its messages, as of the start', async () => {
    const b = await bare(['scout']);
    try {
      const first = storeDm(b, 'ev-1', 'are you there?');
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const second = storeDm(b, 'ev-2', 'hello?');
      storeChatter(b);
      // The start writes the line 60 s on, by the clock it reads.
      const internals = b.framework as unknown as { placeBatchLine(...args: unknown[]): unknown };
      const place = internals.placeBatchLine;
      internals.placeBatchLine = function (this: unknown, ...args: unknown[]) {
        const now = Date.now;
        Date.now = () => now() + 60_000;
        try { return place.apply(this, args); } finally { Date.now = now; }
      };
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([first, second]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      const age = Number(/oldest ~(\d+)s ago/.exec(lines[0]!)?.[1]);
      assert.ok(age >= 62 && age <= 63, `the first message's age, a little over 62 s: ${lines[0]}`);
    } finally { await done(b); }
  });

  it('a batched message that names no channel, chatter after it: the line says it has none', async () => {
    const b = await bare(['scout']);
    try {
      const row = b.internals.addMessage('user', [{ type: 'text', text: 'water the plants' }]);
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([row]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.match(lines[0]!, /^\[Gate: 1 event matched\]\n\n- 1 message with no channel \(oldest ~\d+s ago\) — already shown above at arrival; this is a batched wake, not new content$/);
    } finally { await done(b); }
  });

  it("a DM, chatter, then the batch's own gate line: the start's line names the DM", async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      const own = b.internals.addMessage('user', [{ type: 'text', text: '[Gate: 1 event matched]\n\n- [batch] (clock:reminder): water the plants' }], { source: 'gate:debounce' });
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm, own]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['1', '1', 'discord:dm:1'], lines[0]);
    } finally { await done(b); }
  });

  it("a DM, then the batch's own gate line: no line", async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      const own = b.internals.addMessage('user', [{ type: 'text', text: '[Gate: 1 event matched]\n\n- [batch] (clock:reminder): water the plants' }], { source: 'gate:debounce' });
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm, own]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      assert.ok(inRequest(b, 'are you there?'), "premise: the start's request holds the batch's message");
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });

  it("a DM, then another batch's gate line: the line names the DM", async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      b.internals.addMessage('user', [{ type: 'text', text: '[Gate: 1 event matched]\n\n- [batch] (clock:reminder): water the plants' }], { source: 'gate:debounce' });
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['1', '1', 'discord:dm:1'], lines[0]);
    } finally { await done(b); }
  });

  it("one batched message in one server's general and two in another server's general, chatter after them: one line counting each server's channel apart", async () => {
    const b = await bare(['scout']);
    try {
      const rows = [
        b.internals.addMessage('antra', [{ type: 'text', text: 'a in one' }], { serverId: 'one', channelId: 'general', messageId: 'a1' }),
        b.internals.addMessage('antra', [{ type: 'text', text: 'b in two' }], { serverId: 'two', channelId: 'general', messageId: 'b1' }),
        b.internals.addMessage('antra', [{ type: 'text', text: 'c in two' }], { serverId: 'two', channelId: 'general', messageId: 'b2' }),
      ];
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake(rows));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      const counts = [...lines[0]!.matchAll(/^- (\d+) messages? in general /gm)].map((m) => m[1]).sort();
      assert.deepEqual(counts, ['1', '2'], lines[0]);
      assert.match(lines[0]!, /^\[Gate: 3 events matched\]/);
    } finally { await done(b); }
  });

  it("a batched wake merged with another batch's wake that names nothing: the line names the first batch's rows", async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      const at = Date.now();
      b.internals.pendingRequests.push(wake([dm], 'scout', at));
      b.internals.pendingRequests.push(wake([], 'scout', at + 1));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: one merged turn');
      const lines = linesOf(b);
      assert.equal(lines.length, 1, 'one line');
      assert.deepEqual(LINE.exec(lines[0]!)?.slice(1), ['1', '1', 'discord:dm:1'], lines[0]);
    } finally { await done(b); }
  });

  it('a batched wake merged with a wake that names no rows: no line', async () => {
    const b = await bare(['scout']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      const at = Date.now();
      b.internals.pendingRequests.push(wake([dm], 'scout', at));
      b.internals.pendingRequests.push({ agentName: 'scout', reason: 'mention', source: 'discord', timestamp: at + 1 });
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: one merged turn');
      assert.deepEqual(linesOf(b), [], 'the merged turn is not the batch\'s alone');
    } finally { await done(b); }
  });
});

describe("a batched wake's line in each resident's own window", () => {
  it('one batch for two residents, chatter after it: each start writes its own line, once', async () => {
    const b = await bare(['scout', 'mira']);
    try {
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'scout answers' }]));
      b.internals.pendingRequests.push(wake([dm], 'scout'));
      await b.framework.runUntilIdle();
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'mira answers' }]));
      b.internals.pendingRequests.push(wake([dm], 'mira'));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 2, 'premise: both turns ran');
      assert.equal(linesOf(b, 'scout').length, 1, "scout's own line");
      assert.equal(linesOf(b, 'mira').length, 1, "mira's own line");
    } finally { await done(b); }
  });

  it("a co-resident's own round after the batch, which she doesn't observe: no line in mira's window", async () => {
    const b = await bare(['mira', 'oren']);
    try {
      const mira = b.framework.getAgent('mira')!;
      const oren = b.framework.getAgent('oren')!;
      for (const agent of [mira, oren]) agent.getContextManager().presentRows([]);
      const arrived = mira.getContextManager().addMessage('user', [{ type: 'text', text: 'the event' } as ContentBlock],
        withAudience({ serverId: 'discord', eventId: 'ev-1', channelId: 'discord:dm:1' } as unknown as MessageMetadata, ['mira', 'oren']));
      oren.getContextManager().addMessage('oren', [{ type: 'text', text: "oren's reply" } as ContentBlock], asOwnRow(undefined, 'oren'));
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'mira answers' }]));
      b.internals.pendingRequests.push(wake([arrived], 'mira'));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: her turn ran');
      assert.ok(inRequest(b, 'the event'), "premise: her request holds the batch's message");
      assert.deepEqual(linesOf(b, 'mira'), [], "oren's row isn't in mira's window");
    } finally { await done(b); }
  });

  it("a row stored for another resident alone, chatter after it in both windows: no line in hers", async () => {
    const b = await bare(['mira', 'oren']);
    try {
      const mira = b.framework.getAgent('mira')!;
      const oren = b.framework.getAgent('oren')!;
      for (const agent of [mira, oren]) agent.getContextManager().presentRows([]);
      const orens = mira.getContextManager().addMessage('user', [{ type: 'text', text: "for oren's eyes" } as ContentBlock],
        withAudience({ serverId: 'discord', eventId: 'ev-1', channelId: 'discord:dm:1' } as unknown as MessageMetadata, ['oren']));
      mira.getContextManager().addMessage('user', [{ type: 'text', text: 'chatter for both' } as ContentBlock],
        withAudience({ serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-both' } as unknown as MessageMetadata, ['mira', 'oren']));
      assert.notEqual(mira.getContextManager().windowStatusOf(orens), 'in', "premise: the row isn't in her window");
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'mira answers' }]));
      b.internals.pendingRequests.push(wake([orens], 'mira'));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: her turn ran');
      assert.deepEqual(linesOf(b, 'mira'), [], 'nothing of the wake is in her window to name');
    } finally { await done(b); }
  });

  it("an observed co-resident's own round after the batch, not yet presented to her: her line", async () => {
    const b = await bare(['mira', 'oren'], new MockMembrane(), { mira: { observes: ['oren'] } });
    try {
      const mira = b.framework.getAgent('mira')!;
      const oren = b.framework.getAgent('oren')!;
      for (const agent of [mira, oren]) agent.getContextManager().presentRows([]);
      const arrived = mira.getContextManager().addMessage('user', [{ type: 'text', text: 'the event' } as ContentBlock],
        withAudience({ serverId: 'discord', eventId: 'ev-1', channelId: 'discord:dm:1' } as unknown as MessageMetadata, ['mira', 'oren']));
      mira.getContextManager().presentRows([arrived]);
      const round = oren.getContextManager().addMessage('oren', [{ type: 'text', text: "oren's reply" } as ContentBlock], asOwnRow(undefined, 'oren'));
      assert.equal(mira.getContextManager().windowStatusOf(round), 'out', 'premise: not presented to her yet');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'mira answers' }]));
      b.internals.pendingRequests.push(wake([arrived], 'mira'));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: her turn ran');
      assert.equal(linesOf(b, 'mira').length, 1, "oren's round, which she observes, follows it in her request");
    } finally { await done(b); }
  });
});

/** A host whose residents' windows weren't written down at registration
 *  (the write-down refused), so each window is the slot's record. */
async function legacy(names: string[]): Promise<Bare> {
  const presentRows = StoreWindow.prototype.presentRows;
  StoreWindow.prototype.presentRows = function (this: StoreWindow, ids: Parameters<typeof presentRows>[0], ...rest: unknown[]) {
    if (ids.length === 0) throw new Error('the write-down is refused (test)');
    return (presentRows as (...a: unknown[]) => ReturnType<typeof presentRows>).call(this, ids, ...rest);
  } as typeof presentRows;
  try {
    return await bare(names);
  } finally {
    StoreWindow.prototype.presentRows = presentRows;
  }
}

describe("a batched wake's line in a window still in legacy mode", () => {
  it("one batch for two residents, chatter after it: only the delivery agent's start writes the slot's one line", async () => {
    const b = await legacy(['scout', 'mira']);
    try {
      for (const name of ['scout', 'mira']) {
        assert.equal(b.framework.getAgent(name)!.getContextManager().windowMode(), 'legacy', `premise: ${name}'s window is the record`);
      }
      const dm = storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'mira answers' }]));
      b.internals.pendingRequests.push(wake([dm], 'mira'));
      await b.framework.runUntilIdle();
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'scout answers' }]));
      b.internals.pendingRequests.push(wake([dm], 'scout'));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 2, 'premise: both turns ran');
      assert.deepEqual(linesOf(b, 'mira'), [], "the co-resident's start places nothing in the shared record");
      assert.equal(linesOf(b, 'scout').length, 1, "the delivery agent's start writes the slot's line");
    } finally { await done(b); }
  });

  it("a row the agent's view leaves out after it: no line", async () => {
    const b = await legacy(['scout']);
    try {
      assert.equal(b.framework.getAgent('scout')!.getContextManager().windowMode(), 'legacy', 'premise: the window is the record');
      const dm = storeDm(b, 'ev-1', 'are you there?');
      b.internals.addMessage('someone', [{ type: 'text', text: 'diverted after it' }],
        { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-diverted', tuneOut: { epochId: 'epoch-1' } });
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dm]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      assert.ok(inRequest(b, 'are you there?'), "premise: the start's request holds the batch's message");
      assert.deepEqual(linesOf(b), []);
    } finally { await done(b); }
  });

  it('a row the view leaves out among the wake\'s, chatter after it: no line naming it', async () => {
    const b = await legacy(['scout']);
    try {
      const held = b.internals.addMessage('antra', [{ type: 'text', text: 'held by a tune-out' }],
        { serverId: 'discord', eventId: 'ev-held', channelId: 'discord:dm:1', tuneOut: { epochId: 'epoch-1' } });
      storeChatter(b);
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([held]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: the turn ran');
      assert.deepEqual(linesOf(b), [], 'nothing of the wake is in its view to name');
    } finally { await done(b); }
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type GateInternals = { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout>; events: unknown[] }>; fireDebounce(name: string): void };
const gateOf = (f: Fixture) => (f.framework as unknown as { eventGate: GateInternals }).eventGate;
const addressedOnly = { name: 'batch', match: { scope: ['mcpl:channel-incoming'], tagsAny: ['chat:addressed'] }, behavior: { debounce: 60_000 } };
const pending = (f: Fixture) => [...gateOf(f).debounceTimers.values()].reduce((n, s) => n + s.events.length, 0);
function fireAll(f: Fixture) { for (const [name, s] of [...gateOf(f).debounceTimers]) { clearTimeout(s.timer); gateOf(f).fireDebounce(name); } }
const requestTexts = (r: unknown): string[] => ((r as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }).messages)
  .map((m) => m.content.map((c) => c.text ?? '').join(''));

describe('through the gate, a debounced batch in alpha', () => {
  it('then chatter in beta before it fires, the locus already alpha: the turn ends on a line naming the batch', async () => {
    const f = await fixture({ framework: { gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false } } });
    try {
      (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
        f.membrane.calls.push(request);
        return new MockYieldingStream([say(`plain answer ${f.membrane.calls.length}`)]);
      };
      await registerOpen(f, 'alpha', 'beta');
      await incoming(f, 'alpha', 'm1', 'first question', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => pending(f) === 1, 'batched 1');
      fireAll(f);
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 1, 'premise: the first batch set the locus to alpha');
      await incoming(f, 'alpha', 'm2', 'second question', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => pending(f) === 1, 'batched 2');
      await incoming(f, 'beta', 'm3', 'chatter in beta', AMBIENT);
      await f.framework.runUntilIdle();
      fireAll(f);
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 2, 'premise: the second batch woke the agent');
      const all = requestTexts(f.membrane.calls[1]);
      const at = all.findIndex((t) => t.includes('second question'));
      assert.ok(at >= 0, 'premise: the request holds the batch');
      const tail = all.slice(at);
      assert.ok(!tail.some((t) => t.startsWith('[routing]')), 'premise: no routing notice after the batch, the locus unchanged');
      const last = tail.at(-1) ?? '';
      assert.deepEqual(LINE.exec(last)?.slice(1, 3), ['1', '1'], `the request ends on the line: ${JSON.stringify(tail.slice(-3))}`);
      assert.match(last, /in alpha/);
    } finally { await f.close(); }
  });

  it("whose turn's start announces the locus: no line for the notice", async () => {
    const f = await fixture({ framework: { gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false } } });
    try {
      (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
        f.membrane.calls.push(request);
        return new MockYieldingStream([say('plain answer')]);
      };
      await registerOpen(f, 'alpha');
      await incoming(f, 'alpha', 'm1', 'the question', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => pending(f) === 1, 'batched');
      fireAll(f);
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 1, 'premise: the batch woke the agent');
      const tail = requestTexts(f.membrane.calls[0]);
      assert.ok(tail.some((t) => t.startsWith('[routing]')), 'premise: the start announced the locus');
      assert.ok(tail.some((t) => t.includes('the question')), "premise: the start's request holds the batch's message");
      assert.ok(!tail.some((t) => t.startsWith('[Gate:')), 'no line');
    } finally { await f.close(); }
  });

  it("whose start announces the locus, then fails and is retried at the same turn: the retry writes no line for its first start's notice", async () => {
    const f = await fixture({ framework: {
      errorPolicy: { maxRetries: 1, onInferenceError: (_e: Error, _a: string, attempt: number) => attempt === 0 ? { retry: true, delayMs: 20 } : { retry: false } },
      gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false },
    } });
    try {
      (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
        f.membrane.calls.push(request);
        if (f.membrane.calls.length === 1) {
          const error = new MembraneError({ type: 'server', retryable: true, httpStatus: 500, message: 'Internal server error', rawError: { status: 500 }, rawRequest: request });
          return {
            isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
            provideToolResults() { throw new Error('not waiting'); },
            cancel() {},
            async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> { yield { type: 'error', error } as StreamEvent; },
          } as unknown as YieldingStream;
        }
        return new MockYieldingStream([say('plain answer')]);
      };
      await registerOpen(f, 'alpha');
      await incoming(f, 'alpha', 'm1', 'the question', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => pending(f) === 1, 'batched');
      fireAll(f);
      await settleUntil(f.framework, () => f.membrane.calls.length >= 2, 'the failed attempt and its retry');
      assert.equal(f.membrane.calls.length, 2, 'premise: the attempt and its retry');
      const retried = requestTexts(f.membrane.calls[1]);
      const at = retried.findIndex((t) => t.includes('the question'));
      assert.ok(at >= 0 && retried.slice(at).some((t) => t.startsWith('[routing]')), "premise: the first start's routing notice follows the question in the retry's request");
      assert.ok(!retried.some((t) => t.startsWith('[Gate:')), 'no line');
    } finally { await f.close(); }
  });

  it("for two residents, then chatter in beta before it fires: each resident's request holds its own line naming the batch, after the chatter", async () => {
    const f = await fixture({
      agents: ['scout', 'mira'].map((name) => ({ name, model: 'test', systemPrompt: `You are ${name}.` })),
      framework: { gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false } },
    });
    try {
      (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
        f.membrane.calls.push(request);
        return new MockYieldingStream([say(`plain answer ${f.membrane.calls.length}`)]);
      };
      await registerOpen(f, 'alpha', 'beta');
      await incoming(f, 'alpha', 'm1', 'a question for both', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => pending(f) === 1, 'batched');
      await incoming(f, 'beta', 'm2', 'chatter in beta', AMBIENT);
      await f.framework.runUntilIdle();
      fireAll(f);
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 2, 'premise: the batch woke both residents');
      for (const [i, name] of ['scout', 'mira'].entries()) {
        const own = f.framework.getAgent(name)!.getContextManager().getAllMessages()
          .filter((m) => (m.metadata as { ownRowOf?: unknown } | undefined)?.ownRowOf === name)
          .map(rowText).filter((t) => t.startsWith('[Gate:'));
        assert.equal(own.length, 1, `${name}'s own line`);
        assert.deepEqual(LINE.exec(own[0]!)?.slice(1, 3), ['1', '1'], own[0]);
        const all = requestTexts(f.membrane.calls.find((c) => JSON.stringify(c).includes(`You are ${name}.`)));
        const chatter = all.findIndex((t) => t.includes('chatter in beta'));
        assert.ok(chatter >= 0, `premise: ${name}'s request holds the chatter (call ${i})`);
        assert.ok(all.indexOf(own[0]!) > chatter, `${name}'s request holds the line after the chatter`);
      }
    } finally { await f.close(); }
  });

  it('answered at a tool boundary, then chatter in beta, then the fire: the wake drops and no line is written', async () => {
    const module = new GateModule();
    const f = await fixture({ framework: { modules: [module], errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) }, gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false } } });
    try {
      (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
        f.membrane.calls.push(request);
        return new MockYieldingStream(f.membrane.calls.length === 1 ? [waitCall('first'), say('answered the question')] : [say('fresh turn')], true);
      };
      await registerOpen(f, 'alpha', 'beta');
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'agent', reason: 'test', source: 'editor', channelId: 'alpha', channelServerId: 'editor', timestamp: Date.now() });
      const loop = f.framework.runUntilIdle();
      await eventually(() => module.entered.has('first'), 'turn reached tool');
      await incoming(f, 'alpha', 'm1', 'the question', MENTION);
      await eventually(() => pending(f) === 1, 'batched');
      module.release('first');
      await loop;
      await incoming(f, 'beta', 'm3', 'chatter in beta', AMBIENT);
      await f.framework.runUntilIdle();
      const gate = gateOf(f) as unknown as { requestInferenceFn: (agentName: string, ...rest: unknown[]) => void };
      const requested: string[] = [];
      const original = gate.requestInferenceFn;
      gate.requestInferenceFn = (agentName, ...rest) => { requested.push(agentName); original(agentName, ...rest); };
      fireAll(f);
      await f.framework.runUntilIdle();
      assert.deepEqual(requested, ['agent'], 'premise: the batch requested its wake');
      assert.equal(f.membrane.calls.length, 1, 'the answered wake starts no turn');
      assert.ok(!f.context().includes('[Gate:'), 'no line');
    } finally { await f.close(); }
  });
});
