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
import type { ContentBlock, Membrane } from '@animalabs/membrane';
import { Agent } from '../src/agent.js';
import {
  ChannelClockLedger,
  CLOCK_RECORD,
  ContextReceipts,
  channelKey,
  requestEvidence,
  injectedEvidence,
  versionOf,
  recordedBodyDigest,
  sourceBodyDigest,
  copyIntact,
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

  it('never records a delivery twice after an append that landed but reported failure', () => {
    let landThenThrow = false;
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'appendJson') {
          return (type: string, payload: unknown) => {
            const written = target.appendJson(type, payload);
            if (landThenThrow && (payload as { k?: string }).k === 'dlv') {
              landThenThrow = false;
              throw new Error('write reported failure after landing');
            }
            return written;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const l = new ChannelClockLedger(flaky, 'store-1', now);
    l.start();
    landThenThrow = true;
    clock = 100;
    assert.equal(l.delivered('r', CH, src('m1', 50), ver('e1'), BRANCH), false, 'the write reported failure');
    clock = 200;
    assert.equal(l.delivered('r', CH, src('m1', 50), ver('e1'), BRANCH), false, 'reconciled: it had landed');
    const dlv = store.getRecordIdsByType(CLOCK_RECORD)
      .map((id) => JSON.parse(store.getRecord(id)!.payload.toString('utf8')) as { k: string; at: number })
      .filter((e) => e.k === 'dlv');
    assert.deepEqual(dlv.map((e) => e.at), [100]);
    assert.equal(clocks(l, 'r').lastDeliveredAt, 100);
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
    preparationAltered: false,
  });
  const round = (extra: Partial<RoundReport> = {}): RoundReport => ({
    index: 0,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 1 },
    altered: { messages: [], injected: [] },
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
    assert.deepEqual(accepted[0]!.usage, { inputTokens: 10, outputTokens: 1 });
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

  it('delivers a version when any one copy arrived whole, even if another copy was partial', () => {
    receipts.beginStream('r', 1, evidence([
      body(0, 'old-copy', { storeMessageId: 's-old', ver: ver('v'), src: src('m1', 1_000), complete: false, missing: ['content'] }),
      body(1, 'fresh-copy', { storeMessageId: 's-fresh', ver: ver('v'), src: src('m1', 1_000) }),
    ]));
    receipts.usage('r', 1, round());
    const c = ledger.clocksFor('r', [CH]).get(channelKey(CH))!;
    assert.ok(c.lastDeliveredAt, 'the complete copy establishes delivery');
    assert.equal(c.lastPartialAt, null);
  });

  it('delivers a body only when every fragment carrying it arrived whole', () => {
    // One version compiled into two request messages (a split message); the
    // producer altered the second fragment.
    receipts.beginStream('r', 1, evidence([body(0, 'm1'), body(1, 'm1-part2', { storeMessageId: 's-m1', ver: ver('m1'), src: src('m1', 1_000) })]));
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

  it('keeps one source-body version through decoration and sharding, while the copy is what ingestion stored', () => {
    const src = { ...base, messageId: 'p1' };
    const body = { type: 'text' as const, text: 'unchanged body' };
    const header = (label: string) => ({ type: 'text' as const, text: `[source: discord / discord:g:room · ${label}]` });
    const stamped = (stored: ContentBlock[]) => ({ sharded: false, sourceDigest: sourceBodyDigest([body]), storedDigest: sourceBodyDigest(stored) });
    // A rename between two acceptances changes the stored header, not the version.
    const oldCopy = [header('Old room'), body];
    const newCopy = [header('New room'), body];
    const before = versionOf(src, [oldCopy], 's', 'copy-1', stamped(oldCopy));
    const after = versionOf(src, [newCopy], 's', 'copy-2', stamped(newCopy));
    assert.equal(before.basis, 'message-digest');
    assert.equal(before.key, after.key);
    // A stamped copy matches an undecorated, unsharded copy stored before the record.
    assert.equal(before.key, versionOf(src, [[body]], 's', 'legacy').key);
    // An edit after ingestion keeps the copy's identity (it is still a copy of
    // that item); copyIntact, which completeness requires, says it no longer
    // presents the body.
    const editedBlocks = [header('Old room'), { type: 'text' as const, text: 'edited body' }];
    assert.equal(versionOf(src, [editedBlocks], 's', 'copy-1', stamped(oldCopy)).key, before.key);
    assert.equal(copyIntact([editedBlocks], stamped(oldCopy)), false);
    assert.equal(copyIntact([oldCopy], stamped(oldCopy)), true);
    assert.equal(copyIntact([oldCopy], { sharded: false, sourceDigest: 'x' }), false, 'a stamp without its stored digest cannot vouch');
    assert.equal(copyIntact([[body]], { sharded: false }), true, 'stored before stamping: cannot be checked');
    // Shards can't be edited, so a stamped sharded copy keeps its version.
    const shardedStamped = versionOf(src, [[header('Old room')], [body]], 's', 'head', { sharded: true, sourceDigest: sourceBodyDigest([body]) });
    assert.equal(shardedStamped.key, before.key);
    // Unstamped and sharded, by the copy's own sharding facts, even when only
    // one shard is at hand: the source digest can't be recovered.
    assert.equal(versionOf(src, [[header('Old room'), body]], 's', 'head', { sharded: true }).basis, 'stored-copy');
    assert.equal(recordedBodyDigest({ sourceBodyDigest: 'abc' }), 'abc');
    assert.equal(recordedBodyDigest({ sourceBodyDigest: '' }), undefined);
    assert.equal(recordedBodyDigest(undefined), undefined);
  });

  it('a legacy sharded head with one shard available is a stored copy (Hugo #47005 control)', () => {
    const source = { ...base, messageId: 'p8' };
    const head = { id: 'h8', sequence: 8, participant: 'u', content: [{ type: 'text', text: 'first half' }], metadata: { inboundSource: source }, bodyGroupId: 'g8', shardIndex: 0 };
    const ev = requestEvidence({
      agent: 'r', storeId: 'store',
      provenance: { messages: [{ kind: 'raw', bodies: [{ messageId: 'h8', sequence: 8, complete: false, missing: ['shards'] }] }] } as unknown as CompileProvenance,
      requestIndexOf: [0],
      getMessage: (id) => (id === 'h8' ? head as never : null),
      groupMembers: () => [head] as never,
    });
    assert.equal(ev.bodies[0]!.ver.basis, 'stored-copy');
    assert.equal(ev.bodies[0]!.complete, false);
  });

  it('injected and compiled copies share the recorded version', () => {
    const source = { ...base, messageId: 'p9' };
    const metadata = { inboundSource: source, sourceBodyDigest: 'recorded' };
    const head = { id: 's9', sequence: 9, participant: 'u', content: [{ type: 'text', text: '[source: x]' }], metadata, bodyGroupId: 'g', shardIndex: 0 };
    const injected = injectedEvidence(0, 's9', { content: [{ type: 'text', text: '[source: x]' }, { type: 'text', text: 'body' }], metadata }, 'store', head)!;
    const tail = { id: 's10', sequence: 10, participant: 'u', content: [{ type: 'text', text: 'body' }], metadata, bodyGroupId: 'g', shardIndex: 1 };
    const compiled = requestEvidence({
      agent: 'r', storeId: 'store',
      provenance: { messages: [{ kind: 'raw', bodies: [{ messageId: 's9', sequence: 9, complete: true }] }] } as unknown as CompileProvenance,
      requestIndexOf: [0],
      getMessage: (id) => ([head, tail].find((m) => m.id === id) as never) ?? null,
      groupMembers: () => [head, tail] as never,
    });
    assert.equal(compiled.bodies[0]!.ver.key, injected.ver.key);
  });

  it('marks a copy incomplete when preparation dropped one of its fragments', () => {
    const stored = new Map([
      ['s1', { id: 's1', sequence: 1, participant: 'u', content: [{ type: 'text', text: 'a' }], metadata: { inboundSource: { ...base, messageId: 'p1' } } }],
    ]);
    const provenance = {
      messages: [
        { kind: 'raw', bodies: [{ messageId: 's1', sequence: 1, complete: true }] },
        { kind: 'raw', bodies: [{ messageId: 's1', sequence: 1, complete: true }] },
      ],
    } as unknown as CompileProvenance;
    const ev = requestEvidence({
      agent: 'r', storeId: 'store-1', provenance,
      requestIndexOf: [-1, 0],
      getMessage: (id) => (stored.get(id) as never) ?? null,
      groupMembers: (head) => [head],
    });
    assert.deepEqual(ev.bodies.map((b) => [b.index, b.complete, b.missing]), [[0, false, ['preparation']]]);
    const whollyDropped = requestEvidence({
      agent: 'r', storeId: 'store-1', provenance,
      requestIndexOf: [-1, -1],
      getMessage: (id) => (stored.get(id) as never) ?? null,
      groupMembers: (head) => [head],
    });
    assert.equal(whollyDropped.bodies.length, 0, 'a copy dropped entirely is no exposure');
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
        { kind: 'raw', bodies: [{ messageId: 's4', sequence: 4, complete: true }] },
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
  for (const lane of ['channels/incoming', 'push/event'] as const) {
    it(`an inbound body edited before preparation is a partial exposure, not a delivery (${lane})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'evidence-edit-'));
      try {
        const cm = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy(), namespace: 'agents/r' });
        const source = {
          kind: 'channel', lane, serverId: 'discord', binding: 'b1', channelId: 'discord:g:room', acceptedAt: 5,
          ...(lane === 'push/event' ? { eventId: 'ev-7' } : { messageId: 'p7' }),
        };
        const header = { type: 'text' as const, text: '[source: discord / discord:g:room · #room]' };
        const body = { type: 'text' as const, text: 'ORIGINAL text' };
        const stored = [header, body];
        const id = cm.addMessage('someone', stored, {
          inboundSource: source, sourceBodyDigest: sourceBodyDigest([body]), storedBodyDigest: sourceBodyDigest(stored),
        } as never);
        cm.editMessage(id, [header, { type: 'text', text: 'EDITED text' }]);
        const agent = new Agent({ name: 'r', model: 'test', systemPrompt: 's' }, cm, {} as Membrane);
        const { request, evidence } = await agent.prepareActivationRequest([]);
        assert.ok(JSON.stringify(request.messages).includes('EDITED text'));
        assert.equal(evidence.bodies[0]!.complete, false);
        assert.deepEqual(evidence.bodies[0]!.missing, ['edited']);
        assert.equal(evidence.bodies[0]!.ver.basis, lane === 'push/event' ? 'event' : 'message-digest');

        const ledger = new ChannelClockLedger(cm.getStore(), cm.getStoreId());
        ledger.start();
        const receipts = new ContextReceipts(ledger, { acceptRound: () => {} });
        receipts.beginStream('r', 1, evidence);
        receipts.usage('r', 1, { index: 0, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, altered: { messages: [], injected: [] }, fidelity: 'established' });
        const clocks = ledger.clocksFor('r', [{ binding: 'b1', channelId: 'discord:g:room' }]).get(channelKey({ binding: 'b1', channelId: 'discord:g:room' }))!;
        assert.equal(clocks.lastDeliveredAt, null, 'the original body was never shown');
        assert.ok(clocks.partial?.missing.includes('edited'));
        ledger.stop();
        cm.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('composes request preparation\'s own changes: a compile it altered is never presented verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-prep-'));
    try {
      const cm = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy(), namespace: 'agents/r' });
      const source = {
        kind: 'channel', lane: 'push/event', serverId: 'discord', binding: 'b1',
        channelId: 'discord:g:room', eventId: 'ev-1', messageId: 'p1', acceptedAt: 5,
      };
      cm.addMessage('someone', [{ type: 'text', text: '   ' }]); // whitespace only: preparation drops it
      cm.addMessage('someone', [{ type: 'text', text: '  ' }, { type: 'text', text: 'hello' }], { inboundSource: source } as never);
      const agent = new Agent({ name: 'r', model: 'test', systemPrompt: 's' }, cm, {} as Membrane);
      const { request, evidence } = await agent.prepareActivationRequest([]);
      assert.equal(request.messages.length, 1);
      assert.equal(evidence.preparationAltered, true);
      assert.equal(evidence.bodies[0]!.complete, false, 'its whitespace block was not carried');
      assert.deepEqual(evidence.bodies[0]!.missing, ['preparation']);

      const store = cm.getStore();
      const ledger = new ChannelClockLedger(store, cm.getStoreId());
      ledger.start();
      const presentations: string[] = [];
      const receipts = new ContextReceipts(ledger, { acceptRound: (_a, _p, _u, _t, presentation) => { presentations.push(presentation); } });
      receipts.beginStream('r', 1, evidence);
      receipts.usage('r', 1, { index: 0, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, altered: { messages: [], injected: [] }, fidelity: 'established' });
      assert.deepEqual(presentations, ['altered'], 'the producer preserved what it was given, but the compile was already changed');
      const key = channelKey({ binding: 'b1', channelId: 'discord:g:room' });
      assert.equal(ledger.clocksFor('r', [{ binding: 'b1', channelId: 'discord:g:room' }]).get(key)!.lastDeliveredAt, null);
      ledger.stop();
      cm.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      receipts.usage('reader', 1, { index: 0, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, altered: { messages: [], injected: [] }, fidelity: 'established' });
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
