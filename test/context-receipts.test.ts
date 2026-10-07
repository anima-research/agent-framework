/**
 * Receipt clocks (src/context-receipts): the ledger's semantics, round-by-round
 * confirmation, and version identity, without a framework around them.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, type CompileProvenance } from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';
import { Agent } from '../src/agent.js';
import {
  ChannelClockLedger,
  CLOCK_RECORD,
  ContextReceipts,
  channelKey,
  requestEvidence,
  injectedEvidence,
  versionOf,
  type BodyEvidence,
  type RequestEvidence,
  type RoundReport,
} from '../src/context-receipts/index.js';
import type { InboundChannelSource } from '../src/mcpl/inbound-source.js';

const CH = { binding: 'b1', channelId: 'discord:g:room', serverId: 'discord' };
const CH2 = { binding: 'b1', channelId: 'discord:g:other', serverId: 'discord' };
const BRANCH = { id: 'br-main', name: 'main' };

function src(messageId: string, acceptedAt: number) {
  return { messageId, acceptedAt, sourceTimestamp: new Date(acceptedAt).toISOString() };
}
const ver = (key: string) => ({ basis: 'event' as const, key });

describe('ChannelClockLedger', () => {
  let dir: string;
  let store: JsStore;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clock-ledger-'));
    store = JsStore.openOrCreate({ path: join(dir, 'store') });
    clock = 1_000;
  });
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (limits = {}) => {
    const ledger = new ChannelClockLedger(store, 'store-1', now, limits);
    ledger.start();
    return ledger;
  };
  const clocks = (l: ChannelClockLedger, agent: string, ch = CH) => l.clocksFor(agent, [ch]).get(channelKey(ch))!;

  it('advances received at acceptance while delivered waits for a round, then delivers once per version', () => {
    const l = open();
    l.received(CH, src('m1', 1_100), 'channels/incoming');
    let c = clocks(l, 'resident');
    assert.equal(c.lastReceivedAt, 1_100);
    assert.equal(c.received?.messageId, 'm1');
    assert.equal(c.lastDeliveredAt, null, 'nothing delivered yet');

    clock = 2_000;
    assert.equal(l.delivered('resident', CH, src('m1', 1_100), ver('e1'), BRANCH), true);
    clock = 3_000;
    assert.equal(l.delivered('resident', CH, src('m1', 1_100), ver('e1'), BRANCH), false, 'a re-presented version never refreshes');
    c = clocks(l, 'resident');
    assert.equal(c.lastDeliveredAt, 2_000);
    assert.equal(c.delivered?.messageId, 'm1');
    assert.equal(c.delivered?.basis, 'event');
    assert.deepEqual(c.delivered?.branch, BRANCH);
    assert.equal(l.scope('resident').degraded, false);
    assert.deepEqual(l.scope('resident').gaps, []);
  });

  it('keeps residents and channels apart', () => {
    const l = open();
    l.delivered('a', CH, src('m1', 1_100), ver('e1'), BRANCH);
    assert.equal(clocks(l, 'b').lastDeliveredAt, null);
    assert.equal(clocks(l, 'a', CH2).lastDeliveredAt, null);
    assert.equal(l.delivered('b', CH, src('m1', 1_100), ver('e1'), BRANCH), true, 'each resident gets its own first delivery');
  });

  it('records a partial exposure until the body arrives whole, and never after', () => {
    const l = open();
    clock = 1_500;
    assert.equal(l.partial('r', CH, src('m1', 1_100), ver('e1'), BRANCH, ['content']), true);
    assert.equal(l.partial('r', CH, src('m1', 1_100), ver('e1'), BRANCH, ['content']), false, 'first partial only');
    assert.equal(clocks(l, 'r').lastPartialAt, 1_500);
    assert.deepEqual(clocks(l, 'r').partial?.missing, ['content']);
    assert.equal(clocks(l, 'r').lastDeliveredAt, null, 'a partial copy never advances delivered');
    clock = 2_000;
    assert.equal(l.delivered('r', CH, src('m1', 1_100), ver('e1'), BRANCH), true);
    assert.equal(l.partial('r', CH, src('m1', 1_100), ver('e1'), BRANCH, ['content']), false);
  });

  it('survives restart, and reports an unclean previous run as a gap', () => {
    let l = open();
    l.received(CH, src('m1', 1_100), 'push/event');
    l.delivered('r', CH, src('m1', 1_100), ver('e1'), BRANCH);
    // No stop: the process died.
    clock = 9_000;
    l = open();
    assert.equal(clocks(l, 'r').lastReceivedAt, 1_100);
    assert.equal(clocks(l, 'r').lastDeliveredAt, 1_000);
    const scope = l.scope('r');
    assert.equal(scope.trackingSince, 1_000);
    assert.equal(scope.gaps.length, 1);
    assert.equal(scope.gaps[0]!.reason, 'unclean-stop');
    assert.equal(scope.gaps[0]!.to, 9_000);
    assert.equal(scope.storeId, 'store-1');
    assert.equal(l.delivered('r', CH, src('m1', 1_100), ver('e1'), BRANCH), false, 'dedup survives restart');

    l.stop();
    clock = 10_000;
    l = open();
    assert.equal(l.scope('r').gaps.length, 1, 'a clean stop adds no gap');
  });

  it('opens a coverage gap on a failed write, reports it, and records it at the next write', () => {
    let failing = false;
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'appendJson' && failing) return () => { throw new Error('disk full'); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const l = new ChannelClockLedger(flaky, 'store-1', now);
    l.start();
    failing = true;
    clock = 2_000;
    l.received(CH, src('m1', 2_000), 'channels/incoming'); // swallowed: delivery must not depend on bookkeeping
    assert.equal(l.scope('r').degraded, true);
    assert.match(l.scope('r').gaps.at(-1)!.reason, /ledger-write-failed \(ongoing\)/);
    failing = false;
    clock = 3_000;
    l.received(CH, src('m2', 3_000), 'channels/incoming');
    const scope = l.scope('r');
    assert.equal(scope.degraded, false);
    assert.deepEqual(scope.gaps.at(-1), { from: 2_000, to: 3_000, reason: 'ledger-write-failed' });
    assert.equal(clocks(l, 'r').received?.messageId, 'm2');
  });

  it('writes no stop marker when the outstanding gap cannot be written, so the next start reports it', () => {
    let failing = false;
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'appendJson' && failing) return () => { throw new Error('disk full'); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const l = new ChannelClockLedger(flaky, 'store-1', now);
    l.start();
    failing = true;
    l.received(CH, src('m1', 1_000), 'channels/incoming');
    l.stop();
    failing = false;
    clock = 5_000;
    const next = open();
    assert.ok(next.scope('r').gaps.some((g) => g.reason === 'unclean-stop'));
  });

  it('counts a version when it first arrives, however long ago it was accepted, and only once', () => {
    let l = open({ checkpointEvery: 3 });
    // Many newer versions reach the resident first...
    for (let i = 0; i < 50; i++) l.delivered('r', CH, src(`m${i}`, 10_000 + i), ver(`e${i}`), BRANCH);
    // ...then a body accepted long before all of them arrives at last: a genuine first delivery.
    clock = 20_000;
    assert.equal(l.delivered('r', CH, src('held', 1), ver('held'), BRANCH), true);
    assert.equal(clocks(l, 'r').delivered?.messageId, 'held');
    // Exactly once, across checkpoints and a restart.
    l.stop();
    l = open({ checkpointEvery: 3 });
    for (let i = 0; i < 50; i++) assert.equal(l.delivered('r', CH, src(`m${i}`, 10_000 + i), ver(`e${i}`), BRANCH), false);
    assert.equal(l.delivered('r', CH, src('held', 1), ver('held'), BRANCH), false);
    assert.equal(l.isDelivered('r', ver('held')), true);
    // Equal acceptance times are no collision.
    assert.equal(l.delivered('r', CH, src('twin', 1), ver('twin'), BRANCH), true);
  });

  it('keeps a delivery across an /undo-style branch rewind (lived time)', () => {
    const l = open();
    const before = store.currentBranch();
    l.delivered('r', CH, src('m1', 1_100), ver('e1'), { id: before.id, name: before.name });
    // Rewind: a new branch from an earlier point, then switch to it.
    store.createBranchAt('undo-1', before.name, 0);
    store.switchBranch('undo-1');
    const reopened = open();
    const c = clocks(reopened, 'r');
    assert.equal(c.delivered?.messageId, 'm1', 'the delivery happened and stays delivered');
    assert.equal(c.delivered?.branch.name, before.name, 'naming the branch it happened on');
  });

  it('checkpoints and rebuilds from the checkpoint plus tail', () => {
    let l = open({ checkpointEvery: 3 });
    for (let i = 0; i < 7; i++) l.received(CH, src(`m${i}`, 1_000 + i), 'channels/incoming');
    // Real version keys, as evidence.ts builds them.
    const real = versionOf(
      { kind: 'channel', lane: 'channels/incoming', serverId: 'discord', binding: 'b1', channelId: CH.channelId, messageId: 'm6', acceptedAt: 1_006 },
      [[{ type: 'text', text: 'six' }]], 'store-1', 's6',
    );
    l.delivered('r', CH, src('m6', 1_006), real, BRANCH);
    assert.equal(l.scope('r').degraded, false, 'every write landed');
    l.stop();
    assert.ok(store.getRecordIdsByType(`${CLOCK_RECORD}/checkpoint`).length >= 3, 'checkpoints were written');
    l = open({ checkpointEvery: 3 });
    assert.equal(l.scope('r').degraded, false);
    assert.deepEqual(l.scope('r').gaps, []);
    assert.equal(clocks(l, 'r').received?.messageId, 'm6');
    assert.equal(l.delivered('r', CH, src('m6', 1_006), real, BRANCH), false);
  });
});

describe('ContextReceipts', () => {
  let dir: string;
  let store: JsStore;
  let ledger: ChannelClockLedger;
  let accepted: Array<{ agent: string; usage: RoundReport['usage']; presentation: string }>;
  let acceptFailures = 0;
  let receipts: ContextReceipts;

  const body = (index: number, id: string, extra: Partial<BodyEvidence> = {}): BodyEvidence => ({
    index,
    storeMessageId: `s-${id}`,
    complete: true,
    ch: CH,
    src: src(id, 1_000 + index),
    ver: ver(id),
    ...extra,
  });
  const evidence = (bodies: BodyEvidence[]): RequestEvidence => ({
    agent: 'r',
    storeId: 'store-1',
    provenance: { compileId: 'c1', namespace: 'agents/r', branch: { id: 'br', name: 'main', created: 1 }, messages: [], layout: null, strategy: 'passthrough' } as CompileProvenance,
    bodies,
  });
  const round = (extra: Partial<RoundReport> = {}): RoundReport => ({
    index: 0,
    stopReason: 'end_turn',
    usage: { inputTokens: 10 },
    fidelity: 'established',
    ...extra,
  });
  const delivered = (id: string) => {
    const c = ledger.clocksFor('r', [CH]).get(channelKey(CH))!;
    return c.delivered?.messageId === id;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'context-receipts-'));
    store = JsStore.openOrCreate({ path: join(dir, 'store') });
    ledger = new ChannelClockLedger(store, 'store-1');
    ledger.start();
    accepted = [];
    acceptFailures = 0;
    receipts = new ContextReceipts(ledger, {
      acceptRound: (agent, _p, usage, _at, presentation) => {
        if (acceptFailures > 0) {
          acceptFailures--;
          throw new Error('journal write failed');
        }
        accepted.push({ agent, usage, presentation });
      },
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('confirms complete bodies at a round that stood, and accepts the compile once', () => {
    receipts.beginStream('r', 1, evidence([body(0, 'm1'), body(1, 'm2')]));
    receipts.usage('r', 1, round());
    assert.ok(delivered('m2'));
    assert.equal(ledger.scope('r').degraded, false);
    receipts.usage('r', 1, round({ index: 1 }));
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0]!.usage, { inputTokens: 10 });
    assert.equal(accepted[0]!.presentation, 'verbatim');
  });

  it('retries a failed acceptance at the next round, and records how the round presented the compile', () => {
    acceptFailures = 1;
    receipts.beginStream('r', 1, evidence([body(0, 'm1')]));
    receipts.usage('r', 1, round());
    assert.equal(accepted.length, 0, 'the first attempt failed');
    receipts.usage('r', 1, round({ index: 1, altered: { messages: [0], injected: [] } }));
    assert.deepEqual(accepted.map((a) => a.presentation), ['altered']);
    receipts.beginStream('r', 2, evidence([body(0, 'm2')]));
    receipts.usage('r', 2, round({ fidelity: 'unknown' }));
    assert.deepEqual(accepted.map((a) => a.presentation), ['altered', 'unknown']);
  });

  it('delivers a body only when every fragment carrying it arrived whole', () => {
    // One version compiled into two request messages (a split message); the
    // producer altered the second fragment.
    receipts.beginStream('r', 1, evidence([body(0, 'm1'), body(1, 'm1-part2', { ver: ver('m1'), src: src('m1', 1_000) })]));
    receipts.usage('r', 1, round({ altered: { messages: [1], injected: [] } }));
    const c = ledger.clocksFor('r', [CH]).get(channelKey(CH))!;
    assert.equal(c.lastDeliveredAt, null, 'not delivered: one fragment was altered');
    assert.ok(c.partial?.missing.includes('wire-alteration'));
  });

  it('confirms nothing for a refused round, a stream that never reports, or unknown fidelity', () => {
    receipts.beginStream('r', 1, evidence([body(0, 'm1')]));
    receipts.usage('r', 1, round({ stopReason: 'refusal' }));
    assert.ok(!delivered('m1'));
    assert.equal(accepted.length, 0, 'a refusal accepts nothing');
    receipts.usage('r', 1, round({ fidelity: 'unknown' }));
    assert.ok(!delivered('m1'), 'unknown fidelity is neither delivered nor partial');
    assert.equal(ledger.clocksFor('r', [CH]).get(channelKey(CH))!.lastPartialAt, null);
    receipts.usage('r', 1, round({ index: 2 }));
    assert.ok(delivered('m1'), 'still eligible at a later round');
  });

  it('treats a body membrane altered as partial, and a partial compile copy as partial', () => {
    receipts.beginStream('r', 1, evidence([body(0, 'm1'), body(1, 'm2', { complete: false, missing: ['content'] })]));
    receipts.usage('r', 1, round({ altered: { messages: [0], injected: [] } }));
    const c = ledger.clocksFor('r', [CH]).get(channelKey(CH))!;
    assert.equal(c.lastDeliveredAt, null);
    assert.ok(c.partial?.missing.includes('content') || c.partial?.missing.includes('wire-alteration'));
  });

  it('keeps the whole batch\'s coordinates when some injected messages are not bodies', () => {
    receipts.beginStream('r', 1, evidence([]));
    // Index 0 is a routing notice (no evidence); index 1 is the channel body.
    receipts.injectedBatch('r', 1, 2, [body(1, 'i1')]);
    receipts.usage('r', 1, round({ injectedBatch: { batch: 0, applied: 2 } }));
    assert.ok(delivered('i1'));
  });

  it('delivers injected bodies only once a round carried them', () => {
    receipts.beginStream('r', 1, evidence([]));
    const batch = receipts.injectedBatch('r', 1, 2, [body(0, 'i0'), body(1, 'i1')]);
    assert.equal(batch, 0);
    receipts.usage('r', 1, round({ injectedBatch: { batch: 0, applied: 1 } }));
    assert.ok(delivered('i0'));
    receipts.usage('r', 1, round({ index: 1, injectedBatch: { batch: 0, applied: 2 } }));
    assert.ok(delivered('i1'));
  });

  it('records a replayed copy of an already-delivered version once', () => {
    receipts.beginStream('r', 1, evidence([body(0, 'm1'), body(1, 'm1-replay', { ver: ver('m1'), src: src('m1', 1_000) })]));
    receipts.usage('r', 1, round());
    const dlv = store.getRecordIdsByType(CLOCK_RECORD)
      .map((id) => JSON.parse(store.getRecord(id)!.payload.toString('utf8')) as { k: string })
      .filter((e) => e.k === 'dlv');
    assert.equal(dlv.length, 1);
  });

  it('notices a membrane that does not report rounds', () => {
    receipts.beginStream('r', 1, evidence([body(0, 'm1')]));
    receipts.usage('r', 1, undefined);
    assert.equal(receipts.roundReportsMissing, true);
    assert.ok(!delivered('m1'));
  });
});

describe('receipt evidence', () => {
  const base: InboundChannelSource = {
    kind: 'channel', lane: 'channels/incoming', serverId: 'discord', binding: 'b1', channelId: 'discord:g:room', acceptedAt: 5,
  };

  it('chooses the version basis the lane guarantees', () => {
    const text = [[{ type: 'text' as const, text: 'hi' }]];
    assert.equal(versionOf({ ...base, lane: 'push/event', eventId: 'e1' }, text, 's', 'm').basis, 'event');
    assert.equal(versionOf({ ...base, coalesced: true, eventId: 'e1' }, text, 's', 'm').basis, 'event');
    const a = versionOf({ ...base, eventId: 'adapter', messageId: 'p1' }, text, 's', 'm');
    assert.equal(a.basis, 'message-digest', 'an unguaranteed eventId is not a version key');
    const edited = versionOf({ ...base, messageId: 'p1' }, [[{ type: 'text', text: 'hi!' }]], 's', 'm');
    assert.notEqual(a.key, edited.key, 'an edited body is a new version');
    const reordered = versionOf({ ...base, eventId: 'adapter', messageId: 'p1' }, [[{ text: 'hi', type: 'text' } as never]], 's', 'm');
    assert.equal(a.key, reordered.key, 'key order (as the store reads content back) does not change the version');
    assert.equal(versionOf(base, text, 's', 'm').basis, 'stored-copy');
  });

  it('maps compiled bodies to request indices, keeping only channel bodies', () => {
    const stored = new Map([
      ['s1', { id: 's1', sequence: 1, participant: 'u', content: [{ type: 'text', text: 'a' }], metadata: { inboundSource: { ...base, messageId: 'p1' } } }],
      ['s2', { id: 's2', sequence: 2, participant: 'u', content: [{ type: 'text', text: 'b' }], metadata: {} }],
      ['s3', { id: 's3', sequence: 3, participant: 'u', content: [{ type: 'text', text: 'x' }], metadata: { tags: ['chat:deleted'], inboundSource: { ...base, messageId: 'p3' } } }],
    ]);
    const provenance = {
      messages: [
        { kind: 'raw', bodies: [{ messageId: 's1', sequence: 1, complete: true }] },
        { kind: 'raw', bodies: [{ messageId: 's2', sequence: 2, complete: true }] },
        { kind: 'raw', bodies: [{ messageId: 's3', sequence: 3, complete: true }] },
        { kind: 'raw', bodies: [{ messageId: 's1', sequence: 1, complete: false, missing: ['content'] }] },
      ],
    } as unknown as CompileProvenance;
    const ev = requestEvidence({
      agent: 'r', storeId: 'store-1', provenance,
      requestIndexOf: [0, 1, 2, -1],
      getMessage: (id) => (stored.get(id) as never) ?? null,
      groupMembers: (head) => [head],
    });
    assert.deepEqual(ev.bodies.map((b) => [b.index, b.storeMessageId, b.complete]), [[0, 's1', true]]);
    assert.ok(Object.isFrozen(ev) && Object.isFrozen(ev.bodies));
    assert.equal(injectedEvidence(0, 'x', { content: [], metadata: { inboundSource: { ...base, deferred: true } } }, 's'), null, 'a deferred notice is not a body');
  });
});

describe('request-owned evidence', () => {
  it('names a body the reader compiled from an auxiliary slot, and delivers it to that reader only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-aux-'));
    try {
      const main = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy() });
      const reader = await ContextManager.open({
        store: main.getStore(), namespace: 'subconscious/reader', isolate: true,
        strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
      });
      const source = {
        kind: 'channel', lane: 'push/event', serverId: 'discord', binding: 'b1',
        channelId: 'discord:g:room', eventId: 'ev-aux', messageId: 'p-aux', acceptedAt: 7,
      };
      main.addMessage('alice', [{ type: 'text', text: 'heard by the reader' }], { inboundSource: source } as never);
      const agent = new Agent({ name: 'reader', model: 'test', systemPrompt: 's' }, reader, {} as Membrane);
      const { evidence } = await agent.prepareActivationRequest([]);
      assert.equal(evidence.bodies.length, 1, 'the auxiliary body is in the evidence');
      assert.equal(evidence.bodies[0]!.ver.basis, 'event');

      const store = main.getStore();
      const ledger = new ChannelClockLedger(store, reader.getStoreId());
      ledger.start();
      const receipts = new ContextReceipts(ledger, { acceptRound: () => {} });
      receipts.beginStream('reader', 1, evidence);
      receipts.usage('reader', 1, { index: 0, stopReason: 'end_turn', usage: {}, fidelity: 'established' });
      const key = channelKey({ binding: 'b1', channelId: 'discord:g:room' });
      const ref = [{ binding: 'b1', channelId: 'discord:g:room' }];
      assert.equal(ledger.clocksFor('reader', ref).get(key)!.delivered?.messageId, 'p-aux');
      assert.equal(ledger.clocksFor('main', ref).get(key)!.lastDeliveredAt, null, 'not the main resident');
      ledger.stop();
      reader.close();
      main.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the body as prepared, even if it is edited before the round is confirmed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-edit-'));
    try {
      const cm = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy(), namespace: 'agents/r' });
      const source = {
        kind: 'channel', lane: 'channels/incoming', serverId: 'discord', binding: 'b1',
        channelId: 'discord:g:room', messageId: 'p1', acceptedAt: 5,
      };
      const id = cm.addMessage('someone', [{ type: 'text', text: 'original words' }], { inboundSource: source } as never);
      const agent = new Agent({ name: 'r', model: 'test', systemPrompt: 's' }, cm, {} as Membrane);
      const { evidence } = await agent.prepareActivationRequest([]);
      assert.equal(evidence.bodies.length, 1);
      const sent = evidence.bodies[0]!;
      assert.equal(sent.complete, true);
      cm.editMessage(id, [{ type: 'text', text: 'edited during inference' }]);
      const asSent = versionOf(source as never, [[{ type: 'text', text: 'original words' }]], cm.getStoreId(), id);
      const asEdited = versionOf(source as never, [[{ type: 'text', text: 'edited during inference' }]], cm.getStoreId(), id);
      assert.equal(sent.ver.key, asSent.key);
      assert.notEqual(sent.ver.key, asEdited.key);
      cm.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('history--folds folding sentence', () => {
  it('names a strategy that never folds, never summarizes, or reports no layout', async () => {
    const { foldingSentence } = await import('../src/modules/history/folds.js');
    assert.match(foldingSentence('passthrough', ['raw']), /passthrough strategy never folds/);
    assert.match(foldingSentence('windowed-passthrough', ['raw', 'omitted']), /never summarizes/);
    assert.match(foldingSentence('custom', null), /does not report its rendered layout/);
    assert.match(foldingSentence('autobiographical', ['raw', 'summary', 'omitted']), /folds history into summaries/);
  });
});
