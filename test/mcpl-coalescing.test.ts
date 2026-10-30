/**
 * RFC-006 event coalescing (mcpl PR #5, revision 7) — wire-level tests over a
 * real loopback WebSocket MCPL server and a mock model provider.
 *
 * Vector numbers refer to RFC-006 §14.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBlock, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';
import { createMockResponse, HeldStream, MockYieldingStream } from './helpers/mock-membrane.js';
import { fixture, eventually, settles, crash, ok, TS } from './helpers/coalescing-fixture.js';
import { destinationKey } from '../src/mcpl/channel-registry.js';
import { PushCoalescer, type CoalescerHost, type CoalescedOccurrence, type CoalescingReceiptRecord, type CoalescingSnapshot } from '../src/mcpl/push-coalescer.js';

// ---------------------------------------------------------------------------
// Plain coalescing, feature-set scope (vectors 1–6, 35)
// ---------------------------------------------------------------------------

test('host advertises eventCoalescing with the default retry window', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.deepEqual(f.hostCaps[0].eventCoalescing, { pushEvents: true, channelsIncoming: true, deferred: true, channelScopedPush: true, retryWindowMs: 3_600_000 });
});

test('vectors 2, 6, 35: unread replacement keeps only the newest content; a retry returns the receipt', async (t) => {
  const f = await fixture(); t.after(f.close);
  const first = await f.send('push/event', f.params('1', 'edit_original', { initial: true }));
  const second = await f.send('push/event', f.params('2', 'edit_middle'));
  const last = await f.send('push/event', f.params('3', 'edit_latest'));
  assert.equal(first.result.coalesce.outcome, 'first');
  assert.equal(second.result.coalesce.outcome, 'replaced');
  assert.deepEqual(last.result.coalesce, { outcome: 'replaced', priorEventId: '2' });
  // In context immediately (not staged), but only the newest occurrence.
  assert(f.context().includes('edit_latest'));
  assert(!f.context().includes('edit_original') && !f.context().includes('edit_middle'));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('edit_latest') && !f.lastRequest().includes('edit_original'));
  const retry = await f.send('push/event', f.params('3', 'edit_latest'));
  assert.deepEqual(retry.result, last.result);
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'a retry has no second effect');
});

test('vector 3: a consumed occurrence is history; the next one appends', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'battery_79', { initial: true }));
  await f.framework.runUntilIdle();
  const r = await f.send('push/event', f.params('2', 'battery_78'));
  assert.deepEqual(r.result.coalesce, { outcome: 'appended', priorEventId: '1' });
  await f.turn();
  const req = f.lastRequest();
  assert(req.includes('battery_79') && req.includes('battery_78'));
  assert(req.indexOf('battery_79') < req.indexOf('battery_78'));
});

test('vector 28: retraction of never-read content leaves no trace and no turn', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'unread_original', { initial: true }));
  const r = await f.send('push/event', f.params('2', 'deletion_notice', { retract: true }));
  assert.equal(r.result.coalesce.outcome, 'retracted');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
  assert(!f.context().includes('unread_original') && !f.context().includes('deletion_notice'));
});

for (const shape of ['an update', 'a retraction with a notice', 'a retraction with no notice'] as const) {
  test(`while a branch switch holds the store, ${shape} of an unread coalesced push keeps the stored message, and ${shape === 'a retraction with no notice' ? 'appends nothing' : 'its text lands after the release'}`, async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.send('push/event', f.params('1', 'unread_original', { initial: true }));
    assert(f.context().includes('unread_original'));
    const cm = f.framework.getAgent('agent')!.getContextManager();
    const before = cm.getMessageCount();
    const spied = cm as unknown as { setStrategy: (strategy: unknown) => Promise<void> };
    const setStrategy = spied.setStrategy.bind(cm);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    spied.setStrategy = async (strategy: unknown) => { entered(); await gate; return setStrategy(strategy); };
    const switching = f.framework.switchBranch(f.framework.getStore().currentBranch().name);
    const text = shape === 'an update' ? 'held_update' : shape === 'a retraction with a notice' ? 'held_notice' : '';
    const bounded = <T>(work: Promise<T>, what: string): Promise<T> => Promise.race([
      work,
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`${what} didn't come within 10 s`)), 10_000).unref(); }),
    ]);
    try {
      await bounded(reached, "the switch's re-initialization");
      await bounded(f.send('push/event', f.params('2', text, shape === 'an update' ? {} : { retract: true })), 'the push\'s reply');
      assert(f.context().includes('unread_original'), 'the stored message stays while the store is held');
      assert(!f.context().includes('held_update') && !f.context().includes('held_notice'), 'nothing lands while the store is held');
    } finally {
      open();
    }
    await switching;
    spied.setStrategy = setStrategy;
    assert(f.context().includes('unread_original'), 'the stored message stays after the release');
    if (text) assert(f.context().includes(text), `${text} lands after the release`);
    else assert.equal(cm.getMessageCount(), before, 'nothing is appended');
  });
}

test('vectors 29/34: read original → unread edit → delete keeps the original and appends only the notice', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'read_original', { initial: true }));
  await f.framework.runUntilIdle();
  const edit = await f.send('push/event', f.params('2', 'unread_edit'));
  assert.equal(edit.result.coalesce.outcome, 'appended');
  const del = await f.send('push/event', f.params('3', 'deletion_notice', { retract: true }));
  assert.equal(del.result.coalesce.outcome, 'noted');
  await f.turn();
  const req = f.lastRequest();
  assert(req.includes('read_original') && req.includes('deletion_notice') && !req.includes('unread_edit'));
  // History persists past the empty slot: a new create under the same key, then delete → noted.
  await f.send('push/event', f.params('4', 'new_create'));
  const again = await f.send('push/event', f.params('5', 'second_notice', { retract: true }));
  assert.equal(again.result.coalesce.outcome, 'noted');
});

test('vector 30/33: empty retraction of consumed content is "consumed" and appends nothing', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [f.channel('c', 'presence_line', { initial: true }, 'chat', 'p1')] });
  await f.framework.runUntilIdle();
  const count = f.framework.getAgent('agent')!.getContextManager().getMessageCount();
  const r = await f.send('push/event', { featureSet: 'doc', eventId: 'gone', timestamp: TS, coalesce: { channelId: 'chat', key: 'message:p1', retract: true }, payload: { content: [] } });
  assert.equal(r.result.coalesce.outcome, 'consumed');
  assert.equal(f.framework.getAgent('agent')!.getContextManager().getMessageCount(), count);
});

test('vectors 31/32/34a: history is unknown without `initial`; `initial` makes "retracted" reachable after a restart', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.framework.stop(); await f.create();
  const plainCreate = await f.send('push/event', f.params('a', 'no_birth_marker', { key: 'k1' }));
  assert.equal(plainCreate.result.coalesce.outcome, 'appended');
  const plainDelete = await f.send('push/event', f.params('b', '[deleted]', { key: 'k1', retract: true }));
  assert.equal(plainDelete.result.coalesce.outcome, 'noted', 'unknown history yields the notice');
  const born = await f.send('push/event', f.params('c', 'born_here', { key: 'k2', initial: true }));
  assert.equal(born.result.coalesce.outcome, 'first');
  const gone = await f.send('push/event', f.params('d', '[deleted]', { key: 'k2', retract: true }));
  assert.equal(gone.result.coalesce.outcome, 'retracted');
  assert(!f.context().includes('born_here'));
  // vector 34b: initial cannot lower history.
  await f.send('push/event', f.params('e', 'seen', { key: 'k3', initial: true }));
  await f.framework.runUntilIdle();
  await f.send('push/event', f.params('f', 'again', { key: 'k3', initial: true }));
  const later = await f.send('push/event', f.params('g', 'notice', { key: 'k3', retract: true }));
  assert.equal(later.result.coalesce.outcome, 'noted');
});

test('vector 9: feature set and key isolate subjects', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'doc_a', { key: 'A', initial: true }));
  await f.send('push/event', f.params('2', 'doc_b', { key: 'B', initial: true }));
  const r = await f.send('push/event', f.params('3', 'doc_a2', { key: 'A' }));
  assert.equal(r.result.coalesce.outcome, 'replaced');
  assert(f.context().includes('doc_b') && f.context().includes('doc_a2') && !f.context().includes('doc_a"'));
});

test('vector 38: malformed coalesce is a -32602 on push/event and per-message on channels/incoming', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const bad = await f.send('push/event', f.params('1', 'x', { key: 'k'.repeat(257) }));
  assert.equal(bad.error.code, -32602);
  const both = await f.send('push/event', f.params('2', 'x', { deferred: true, retract: true }));
  assert.equal(both.error.code, -32602);
  const missing = { ...f.channel('bad', 'bad'), eventId: undefined };
  const deferred = f.channel('bad2', 'bad2', { deferred: true });
  const r = await f.send('channels/incoming', { messages: [missing, f.channel('good', 'good', { initial: true }), deferred] });
  assert.deepEqual(r.result.results.map((x: { accepted: boolean }) => x.accepted), [false, true, false]);
  assert.equal(r.result.results[0].reason, 'coalesce_invalid');
  assert.equal(r.result.results[2].reason, 'coalesce_invalid');
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('good'));
});

// ---------------------------------------------------------------------------
// Channel scope, mixed lanes (vectors 8, 10, 13, 14, 15a, 43)
// ---------------------------------------------------------------------------

test('vector 10: channel create, push edit, push delete share one unread subject', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const first = await f.send('channels/incoming', { messages: [f.channel('c', 'chat_original', { initial: true })] });
  const edit = await f.send('push/event', f.params('e', 'chat_edit', { channelId: 'chat', key: 'message:m' }));
  const del = await f.send('push/event', f.params('d', 'chat_deleted', { channelId: 'chat', key: 'message:m', retract: true }));
  assert.equal(first.result.results[0].coalesce.outcome, 'first');
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  assert.equal(del.result.coalesce.outcome, 'retracted');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
  for (const text of ['chat_original', 'chat_edit', 'chat_deleted']) assert(!f.context().includes(text));
});

test('vector 8: repeated channel edits keep the platform message id and deduplicate a retried occurrence', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [f.channel('c', 'original', { initial: true })] });
  const edit = await f.send('channels/incoming', { messages: [f.channel('e', 'newest')] });
  const retry = await f.send('channels/incoming', { messages: [f.channel('e', 'newest')] });
  assert.deepEqual(retry.result, edit.result);
  assert.equal(edit.result.results[0].coalesce.outcome, 'replaced');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('newest') && !f.lastRequest().includes('original'));
  const stored = f.framework.getAgent('agent')!.getContextManager().getAllMessages().find((m) => m.metadata?.eventId === 'e');
  assert.equal(stored?.metadata?.messageId, 'm');
});

test('vector 43: a mixed-lane edit keeps the stable reply target', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [{ ...f.channel('c', 'first_version', { initial: true }), threadId: 'thread' }] });
  await f.framework.runUntilIdle();
  await f.send('push/event', { ...f.params('e', 'second_version', { channelId: 'chat', key: 'message:m' }), origin: { messageId: 'm', authorId: 'u', authorName: 'User', threadId: 'thread' } });
  await f.turn();
  assert.equal(f.published.at(-1)?.channelId, 'chat');
});

test('vectors 13/15: a channel-scoped push needs current channel authority and a declared channel', async (t) => {
  const f = await fixture(); t.after(f.close);
  const unknown = await f.send('push/event', f.params('1', 'text', { channelId: 'chat' }));
  assert.equal(unknown.error.code, -32023);
  // A channel id that only ever appeared in a push's origin is not declared.
  await f.send('push/event', { featureSet: 'doc', eventId: 'dm', timestamp: TS, payload: { content: [{ type: 'text', text: 'dm' }] },
    tags: ['chat:dm'], origin: { source: 'discord', channelId: '42', guildId: null, authorId: 'u', authorName: 'User' } });
  await f.framework.runUntilIdle();
  const forged = await f.send('push/event', f.params('2', 'text', { channelId: 'discord:dm:42' }));
  assert.equal(forged.error.code, -32023);
  await f.register();
  const okNow = await f.send('push/event', f.params('3', 'text', { channelId: 'chat', initial: true }));
  assert.equal(okNow.result.coalesce.outcome, 'first');
});

test('vector 14: scope is never inferred from origin', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register('chat:one');
  await f.send('channels/incoming', { messages: [f.channel('a', 'channel_one', { initial: true }, 'chat:one')] });
  await f.send('push/event', { ...f.params('feature', 'feature_scope', { key: 'message:m' }), origin: { channelId: 'chat:one' } });
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('channel_one') && f.lastRequest().includes('feature_scope'));
});

test('vector 33 (channel lane): an ordinary channels/incoming message without coalesce is unchanged', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const r = await f.send('channels/incoming', { messages: [{ channelId: 'chat', messageId: 'p', timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'plain' }] }] });
  assert.deepEqual(r.result.results[0], { messageId: 'p', accepted: true });
});

// ---------------------------------------------------------------------------
// Wake treatment (vectors 36, 43 rev-6 behavioural)
// ---------------------------------------------------------------------------

test('a retraction starts no inference for the unstarted wake its subject queued', async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => true } }); t.after(f.close);
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  await f.send('push/event', f.params('1', 'withdrawn', { initial: true }));
  assert.equal(internals.pendingRequests.length, 1);
  await f.send('push/event', f.params('2', 'gone', { retract: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
});

test('a replacement is evaluated by the gate as a fresh occurrence; a qualifying replacement wakes once', async (t) => {
  const f = await fixture({ framework: { gate: { config: { policies: [{ name: 'attention', match: { tagsAny: ['doc:wake'] }, behavior: 'always' }], default: 'skip' } } } as never }); t.after(f.close);
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  await f.send('push/event', { ...f.params('1', 'quiet', { initial: true }), tags: ['doc:quiet'] });
  assert.equal(internals.pendingRequests.length, 0);
  await f.send('push/event', { ...f.params('2', 'loud', {}), tags: ['doc:wake'] });
  assert.equal(internals.pendingRequests.length, 1);
  await f.send('push/event', { ...f.params('3', 'louder', {}), tags: ['doc:wake'] });
  assert.equal(internals.pendingRequests.length, 1, 'no second wake for the same subject');
  await f.send('push/event', { ...f.params('4', 'quiet_again', {}), tags: ['doc:quiet'] });
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Deferred rendering (vectors 16–27)
// ---------------------------------------------------------------------------

test('vectors 16/17/18: notices render once at assembly with their private data; never the fallback', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'fallback_unavailable', { deferred: true, data: { private: 'hidden_notice' } }));
  const joined = await f.send('push/event', f.params('2', 'fallback_unavailable', { deferred: true, data: { private: 'hidden_notice_2' } }));
  assert.equal(joined.result.coalesce.outcome, 'replaced');
  assert.equal(f.renders.length, 0);
  assert(!f.context().includes('fallback_unavailable'), 'a batch is not model-visible');
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].notices ? (f.renders[0].notices as unknown[]).length : 0, 2);
  assert.deepEqual((f.renders[0].notices as Array<{ data: unknown }>).map((n) => n.data), [{ private: 'hidden_notice' }, { private: 'hidden_notice_2' }]);
  const req = f.lastRequest();
  assert(req.includes('document_diff') && !req.includes('fallback_unavailable') && !req.includes('hidden_notice'));
  // vector 18: a second inference issues no render; vector 19: a new notice does.
  await f.turn();
  assert.equal(f.renders.length, 1);
  const again = await f.send('push/event', f.params('3', 'fallback', { deferred: true }));
  assert.equal(again.result.coalesce.outcome, 'first');
  await f.turn();
  assert.equal(f.renders.length, 2);
});

test('vector 20: an empty render appends nothing', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.renderer(async () => ({ content: [] }));
  await f.send('push/event', f.params('1', 'fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  assert(!f.context().includes('fallback'));
  // The batch was the turn's only cause and rendered nothing: no inference
  // (an uncaused wake would show the model only older context).
  assert.equal(f.membrane.calls.length, 0);
});

test('vectors 21/23: a render past the deadline materializes the fallback; the late result is discarded', async (t) => {
  const f = await fixture(); t.after(f.close);
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  f.renderer(() => { began(); return new Promise((resolve) => { release = resolve; }); });
  const discarded = new Promise<void>((resolve) => {
    f.framework.onTrace((e) => {
      const ev = e as { type: string; kind?: string; discarded?: boolean };
      if (ev.type === 'mcpl:coalescing' && ev.kind === 'late-render' && ev.discarded === true) resolve();
    });
  });
  await f.send('push/event', f.params('1', 'bounded_fallback', { deferred: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = f.framework.runUntilIdle();
  try {
    await started;
    t.mock.timers.tick(5_000);
  } finally {
    t.mock.timers.reset();
  }
  await settles(run, 'the turn after the render timed out');
  assert(f.lastRequest().includes('bounded_fallback') && !f.lastRequest().includes('wire_late_payload'));
  release({ content: [{ type: 'text', text: 'wire_late_payload' }] });
  await settles(discarded, 'the late render being discarded');
  assert(!f.context().includes('wire_late_payload'));
});

test('vector 21: a render error uses the fallback', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.renderer(async () => ({ content: [null] }));
  await f.send('push/event', f.params('1', 'fallback_text', { deferred: true }));
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('fallback_text'));
});

test('vector 26: inference/request during push/render is refused', async (t) => {
  const f = await fixture(); t.after(f.close);
  let refused: unknown;
  f.renderer(async () => { refused = (await f.send('inference/request', { featureSet: 'doc', messages: [] })).error?.code; return { content: [{ type: 'text', text: 'rendered' }] }; });
  await f.send('push/event', f.params('1', 'fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert.equal(refused, -32600);
});

test('vectors 27a/27c: retract or plain replacement during a render cancels the frozen batch', async (t) => {
  for (const operation of ['retract', 'plain'] as const) {
    const f = await fixture();
    try {
      let release!: (value: unknown) => void;
      let began!: () => void;
      const started = new Promise<void>((resolve) => { began = resolve; });
      f.renderer(() => { began(); return new Promise((resolve) => { release = resolve; }); });
      await f.send('push/event', f.params('1', 'fallback_one', { deferred: true, initial: true }));
      const run = f.framework.runUntilIdle();
      await started;
      const r = await f.send('push/event', operation === 'retract'
        ? f.params('2', 'deletion_notice', { retract: true })
        : f.params('2', 'complete_snapshot'));
      assert.equal(r.result.coalesce.outcome, operation === 'retract' ? 'retracted' : 'replaced');
      // The plain replacement arrived while the turn was alive: it lands at
      // the turn boundary and wakes the agent again, so a second turn follows.
      if (operation === 'plain') f.alwaysRespond();
      release({ content: [{ type: 'text', text: 'late_old_render' }] });
      await run;
      if (operation === 'retract') {
        // The cancelled batch was the turn's only cause and never-read
        // content was withdrawn (vector 28): no inference at all.
        assert.equal(f.membrane.calls.length, 0);
        assert(!f.context().includes('late_old_render') && !f.context().includes('fallback_one') && !f.context().includes('deletion_notice'));
      } else {
        const req = f.lastRequest();
        assert(!req.includes('late_old_render') && !req.includes('fallback_one') && !req.includes('deletion_notice'));
        assert(req.includes('complete_snapshot'));
      }
    } finally { await f.close(); }
  }
});

test('vector 24: revoked authority before assembly drops the batch without a render', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'previously_permitted', { deferred: true }));
  await f.framework.stop(); await f.create(false);
  let withdrawn = 0;
  f.framework.onTrace((e) => { if (e.type === 'mcpl:coalescing' && (e as { kind?: string }).kind === 'turn-withdrawn') withdrawn++; });
  // A second model call would wait for a response the fixture never queues.
  await settles(f.framework.runUntilIdle(), 'the drain after the restart');
  assert.equal(f.renders.length, 0);
  assert(!f.context().includes('previously_permitted'));
  assert.equal(f.membrane.calls.length, 0, 'and the revoked batch, the only cause, started no inference');
  assert.equal(withdrawn, 1, 'its turn started and was withdrawn');
});

test('vector 27i: a deferred notice displaces an unread plain occurrence', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'plain_unread', { initial: true }));
  const r = await f.send('push/event', f.params('2', 'fallback', { deferred: true }));
  assert.equal(r.result.coalesce.outcome, 'replaced');
  assert(!f.context().includes('plain_unread'));
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('document_diff') && !f.lastRequest().includes('plain_unread'));
});

// ---------------------------------------------------------------------------
// Recovery (vectors 7, 39, 40, 41, 47) and the findings from PR #196
// ---------------------------------------------------------------------------

test('vector 41 (#196 finding 1): a transient reconnect does not reject ordinary channel traffic', async (t) => {
  const f = await fixture({ server: { reconnect: true, reconnectIntervalMs: 20 } }); t.after(f.close); await f.register();
  const plain = (id: string) => ({ channelId: 'chat', messageId: id, timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'plain_' + id }] });
  const before = await f.send('channels/incoming', { messages: [plain('1')] });
  const reconnected = new Promise<void>((resolve) => { f.framework.onTrace((e) => { if (e.type === 'mcpl:server-reconnected') resolve(); }); });
  f.disconnect();
  await settles(reconnected, 'the reconnect');
  const after = await f.send('channels/incoming', { messages: [plain('2')] });
  assert.equal(before.result.results[0].accepted, true);
  assert.equal(after.result.results[0].accepted, true);
});

test('vector 39/40: a reconnect keeps accepted content and answers a retry with its receipt', async (t) => {
  const f = await fixture({ server: { reconnect: true, reconnectIntervalMs: 20 } }); t.after(f.close); await f.register();
  const params = { messages: [f.channel('c', 'survives_disconnect', { initial: true })] };
  const accepted = await f.send('channels/incoming', params);
  f.disconnect();
  await eventually(() => f.hostCaps.length === 2, 'reconnect');
  await f.register();
  const retry = await f.send('channels/incoming', params);
  assert.deepEqual(retry.result, accepted.result);
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1);
  const req = f.lastRequest();
  assert.equal(req.split('survives_disconnect').length - 1, 1, 'exactly once');
});

test('vectors 7/47: restart keeps accepted content, receipts, and appends after it', async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('once', 'exactly_once', { initial: true });
  const original = await f.send('push/event', params);
  await f.framework.stop(); await f.create();
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, original.result);
  const next = await f.send('push/event', f.params('two', 'after_restart'));
  assert.equal(next.result.coalesce.outcome, 'appended');
  await f.framework.runUntilIdle();
  const req = f.lastRequest();
  assert(req.includes('exactly_once') && req.includes('after_restart'));
  assert.equal(req.split('exactly_once').length - 1, 1);
});

test('#196 finding 2 / vector 34c: a busy channel never hits a subject cap', async (t) => {
  // start() arms the periodic store sync, and this fixture never calls it;
  // syncIntervalMs: 0 keeps that sync off if one ever does.
  const f = await fixture({ framework: { gate: { config: { policies: [{ name: 'attention', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }], default: 'skip' } }, syncIntervalMs: 0 } as never }); t.after(f.close); await f.register();
  const msg = (i: number | string, tags: string[]) => ({ channelId: 'chat', messageId: 'm' + i, eventId: 'e' + i, timestamp: TS, author: { id: 'u', name: 'User' }, tags,
    content: [{ type: 'text', text: 'text_' + i }], coalesce: { key: 'message:m' + i, initial: true } });
  // #196's review measured 85 ms a message on this path, because its journal
  // synced the store for each of three operations per message. An acceptance
  // now awaits one durable commit (RFC-006), so messages sent one at a time
  // make one store sync each. The count takes every store sync during the
  // sends; nothing else in this fixture syncs the store meanwhile. It must be
  // at least one, or the count no longer sees the commits, and at most one a
  // message, so commits shared between acceptances would still pass. The
  // total time depends on the disk and the host's load, so it's reported, not
  // asserted; each send keeps the fixture's reply deadline, its guard against
  // a hang.
  const store = (f.framework as unknown as { store: { sync: (...a: unknown[]) => unknown } }).store;
  const sync = store.sync.bind(store);
  let syncs = 0;
  store.sync = (...a: unknown[]) => { syncs++; return sync(...a); };
  const sends = 300;
  const t0 = Date.now();
  for (let i = 0; i < sends; i++) {
    const r = await f.send('channels/incoming', { messages: [msg(i, [])] });
    assert.equal(r.result.results[0].accepted, true);
  }
  const elapsed = Date.now() - t0;
  const synced = syncs;
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
  const mention = await f.send('channels/incoming', { messages: [msg('mention', ['chat:mention'])] });
  assert.equal(mention.result.results[0].accepted, true);
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('text_mention') && f.lastRequest().includes('text_0'));
  console.log(`# ${sends} serial coalesced channel messages: ${elapsed}ms (${(elapsed / sends).toFixed(1)} ms/msg incl. fsync), ${synced} store syncs`);
  assert(synced > 0, `${sends} coalesced messages made no store sync: the acceptances didn't commit, or the count can't see their commits`);
  assert(synced <= sends, `${sends} coalesced messages made ${synced} store syncs, more than one a message`);
});

test('#196 finding 4: a context-budget restart does not assemble a pending batch', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'pending_batch', { deferred: true }));
  const internals = f.framework as unknown as { startAgentStream(a: unknown, t: unknown): Promise<void>; pendingRequests: unknown[] };
  internals.pendingRequests.length = 0;
  await internals.startAgentStream(f.framework.getAgent('agent'), { agentName: 'agent', reason: 'context_budget_restart', source: 'probe', timestamp: Date.now() });
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0, 'not rendered mid-logical-turn');
  assert(!f.lastRequest().includes('document_diff'));
  const joined = await f.send('push/event', f.params('2', 'pending_batch', { deferred: true }));
  assert.equal(joined.result.coalesce.outcome, 'replaced', 'the batch survived the restart turn');
  await f.turn();
  assert.equal(f.renders.length, 1, 'rendered at the next fresh turn');
  assert.equal((f.renders[0].notices as unknown[]).length, 2);
});

test('#196 finding 5: undo of a turn keeps the coalesced input that preceded it', async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => true } }); t.after(f.close);
  await f.send('push/event', f.params('a', 'turn_one', { key: 'a', initial: true }));
  await f.framework.runUntilIdle();
  await f.send('push/event', f.params('b', 'unread_before_undo', { key: 'b', initial: true }));
  await f.turn();
  assert(f.lastRequest().includes('unread_before_undo'));
  f.framework.undoLastTurn('agent');
  assert(f.context().includes('unread_before_undo'), 'the input survives the undo of the turn that read it');
  const r = await f.send('push/event', f.params('c', 'after_undo', { key: 'b' }));
  assert.equal(r.result.coalesce.outcome, 'appended', 'after a branch switch nothing is replaceable');
});

test('a replacement while a turn is alive edits the deferred queue, not the live turn', async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as { activeTurnTokens: Map<string, number> };
  internals.activeTurnTokens.set('agent', 100);
  await f.send('push/event', f.params('1', 'queued_original', { initial: true }));
  const r = await f.send('push/event', f.params('2', 'queued_replacement'));
  assert.equal(r.result.coalesce.outcome, 'replaced');
  assert(!f.context().includes('queued_original') && !f.context().includes('queued_replacement'));
  internals.activeTurnTokens.delete('agent');
  await f.turn();
  assert(f.lastRequest().includes('queued_replacement') && !f.lastRequest().includes('queued_original'));
});

test('compression consumes: a message folded into a summary is no longer replaceable', async (t) => {
  const { AutobiographicalStrategy } = await import('@animalabs/context-manager');
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 1_000, targetChunkTokens: 300,
    kvStableReachTokens: 300, autoTickOnNewMessage: false, compressionModel: 'summarizer',
  } as never);
  const f = await fixture({ agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', strategy }] }); t.after(f.close);
  (f.membrane as unknown as { complete: unknown }).complete = async (req: unknown) => { f.membrane.calls.push(req as never); return createMockResponse([{ type: 'text', text: 'SUMMARY' }]); };
  await f.send('push/event', f.params('1', 'folded_original', { initial: true }));
  const cm = f.framework.getAgent('agent')!.getContextManager();
  for (let i = 0; i < 30; i++) cm.addMessage('user', [{ type: 'text', text: `filler_${i} ` + 'lorem ipsum '.repeat(40) }]);
  for (let i = 0; i < 12; i++) await cm.tick();
  assert(cm.getMaxSummaryLevel() > 0, 'folding happened');
  const r = await f.send('push/event', f.params('2', 'after_fold'));
  assert.equal(r.result.coalesce.outcome, 'appended');
  assert(f.context().includes('folded_original') && f.context().includes('after_fold'));
});

test('conversation forks: a channel-scoped edit follows the routed fork and pins its reply channel', async (t) => {
  const f = await fixture({ framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never }); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [f.channel('c', 'fork_original', { initial: true })] });
  const edit = await f.send('push/event', f.params('e', 'fork_latest', { channelId: 'chat', key: 'message:m' }));
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('fork_latest') && !f.lastRequest().includes('fork_original'));
  assert(!f.context().includes('fork_latest'), 'the trunk never sees channel traffic');
  assert.equal(f.published.at(-1)?.channelId, 'chat');
});

// ---------------------------------------------------------------------------
// Review round 1 (#197): Greptile G1–G15, Codex C1–C3
// ---------------------------------------------------------------------------

test('C1: a channel-scoped render result is dropped when channels.incoming is revoked mid-render', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const { CapabilityGrant } = await import('../src/mcpl/capability-grant.js');
  let release!: (v: unknown) => void;
  const started = new Promise<void>((resolve) => { f.renderer(() => { resolve(); return new Promise((r) => { release = r; }); }); });
  await f.send('push/event', f.params('1', 'fallback', { deferred: true, channelId: 'chat', key: 'activity' }));
  const run = f.framework.runUntilIdle();
  await started;
  const conn = (f.framework as unknown as { mcplServerRegistry: { getServer(id: string): { establishGrant(g: unknown): void; grant: unknown } } }).mcplServerRegistry.getServer('editor');
  conn.establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
  release({ content: [{ type: 'text', text: 'revoked_render' }] });
  await run;
  assert(!f.context().includes('revoked_render') && !f.context().includes('fallback'));
});

test('C2 / vector 42: reassigning the server id to another endpoint starts a new binding', async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await f.send('push/event', f.params('E', 'from_endpoint_a', { key: 'K', initial: true }));
  assert.equal(a.result.coalesce.outcome, 'first');
  const config = (f.framework as unknown as { mcplServerConfigs: Map<string, { url: string }> }).mcplServerConfigs.get('editor')!;
  await f.framework.restartMcplServer('editor', { ...config, url: `${config.url}/reassigned` } as never);
  await eventually(() => f.hostCaps.length === 2, 'reconnect to the new endpoint');
  const b = await f.send('push/event', f.params('E', 'from_endpoint_b', { key: 'K', initial: true }));
  assert.equal(b.result.coalesce.outcome, 'first', "B's reuse of A's event id is a new occurrence");
  const b2 = await f.send('push/event', f.params('E2', 'from_endpoint_b_2', { key: 'K' }));
  assert.equal(b2.result.coalesce.outcome, 'replaced');
  assert.equal(b2.result.coalesce.priorEventId, 'E');
  assert(f.context().includes('from_endpoint_a'), "A's unread content is not touched by B");
  assert(f.context().includes('from_endpoint_b_2') && !f.context().includes('from_endpoint_b"'));
});

test('C3: a replacement follows the prior delivery into its fork, never into a fresh one', async (t) => {
  const f = await fixture({ framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never }); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [f.channel('c', 'fork_original', { initial: true })] });
  const router = (f.framework as unknown as { conversationRouter: { getBinding(channel: { serverId: string; channelId: string }): { agentName: string } | undefined; unbind(channel: { serverId: string; channelId: string }): void } }).conversationRouter;
  const g1 = router.getBinding({ serverId: 'editor', channelId: 'chat' })!.agentName;
  router.unbind({ serverId: 'editor', channelId: 'chat' });
  const edit = await f.send('push/event', f.params('e', 'fork_edit', { channelId: 'chat', key: 'message:m' }));
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  assert.equal(router.getBinding({ serverId: 'editor', channelId: 'chat' }), undefined, 'no fresh fork was spawned for the edit');
  const g1ctx = JSON.stringify(f.framework.getAgent(g1)!.getContextManager().getAllMessages());
  assert(g1ctx.includes('fork_edit') && !g1ctx.includes('fork_original'));
});

test('G1: malformed content on a coalesced channel item fails that item only', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const bad = { ...f.channel('bad', 'x', { initial: true }, 'chat', 'b'), content: 'not-an-array' };
  const r = await f.send('channels/incoming', { messages: [bad, f.channel('good', 'good_sibling', { initial: true }, 'chat', 'g')] });
  assert.deepEqual(r.result.results.map((x: { accepted: boolean }) => x.accepted), [false, true]);
  assert.equal(r.result.results[0].reason, 'coalesce_invalid');
  const badPush = await f.send('push/event', { ...f.params('p', 'x'), payload: { content: [{ type: 'text' }] } });
  assert.equal(badPush.error.code, -32602);
});

test('G3/G5: a deferred channel-scoped push renders with its feature set and wakes with its channel', async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => true } }); t.after(f.close); await f.register();
  await f.send('push/event', { ...f.params('1', 'fallback', { deferred: true, channelId: 'chat', key: 'activity' }), origin: { authorId: 'u', authorName: 'User' } });
  const internals = f.framework as unknown as { pendingRequests: Array<{ channelId?: string; counterparty?: string }> };
  assert.equal(internals.pendingRequests[0]?.channelId, 'chat');
  assert.equal(internals.pendingRequests[0]?.counterparty, 'editor:user:u');
  await f.framework.runUntilIdle();
  assert.equal(f.renders[0]?.featureSet, 'doc');
  assert.equal(f.renders[0]?.channelId, 'chat');
  assert.equal(f.published.at(-1)?.channelId, 'chat', 'the reply goes to the batch\'s channel');
});

test('G4: a deferred channel-scoped push spawns the conversation fork it needs', async (t) => {
  const f = await fixture({ framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never, server: { shouldTriggerInference: () => true } }); t.after(f.close); await f.register();
  await f.send('push/event', f.params('1', 'fallback', { deferred: true, channelId: 'chat', key: 'activity' }));
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  const router = (f.framework as unknown as { conversationRouter: { getBinding(channel: { serverId: string; channelId: string }): { agentName: string } | undefined } }).conversationRouter;
  const fork = router.getBinding({ serverId: 'editor', channelId: 'chat' })?.agentName;
  assert(fork, 'a fork was bound');
  assert(JSON.stringify(f.framework.getAgent(fork!)!.getContextManager().getAllMessages()).includes('document_diff'));
  assert(!f.context().includes('document_diff'));
});

test('G6: a replacement finds its prior after the deferred flush stored it', async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as { activeTurnTokens: Map<string, number>; flushDeferredWrites(label: string): Promise<void> };
  internals.activeTurnTokens.set('agent', 100);
  await f.send('push/event', f.params('1', 'queued_then_stored', { initial: true }));
  internals.activeTurnTokens.delete('agent');
  await internals.flushDeferredWrites('test');
  assert(f.context().includes('queued_then_stored'), 'flushed into context, unread');
  const r = await f.send('push/event', f.params('2', 'replacement_after_flush'));
  assert.equal(r.result.coalesce.outcome, 'replaced');
  assert(!f.context().includes('queued_then_stored') && f.context().includes('replacement_after_flush'));
  const del = await f.send('push/event', f.params('3', 'notice', { retract: true }));
  assert.equal(del.result.coalesce.outcome, 'retracted');
  assert(!f.context().includes('replacement_after_flush'));
});

test('G9: an acknowledged acceptance keeps its receipt through a crash before the snapshot flush', async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('durable', 'durable_text', { initial: true });
  const first = await f.send('push/event', params);
  await crash(f); await f.create();
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, first.result, 'the retry is answered from the receipt');
  assert.equal(copies(f, 'durable_text'), 1, 'and delivers nothing again');
});

test('G10: a batch that never began rendering renders after a clean restart', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'fallback_text', { deferred: true }));
  await f.framework.stop(); await f.create();
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'push/render issued after restart');
  assert(f.lastRequest().includes('document_diff') && !f.lastRequest().includes('fallback_text'));
});

test('G11: a push edit without origin identity keeps the channel message identity', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [{ ...f.channel('c', 'first_version', { initial: true }), threadId: 'thread' }] });
  await f.send('push/event', f.params('e', 'second_version', { channelId: 'chat', key: 'message:m' }));
  const stored = f.framework.getAgent('agent')!.getContextManager().getAllMessages().find((m) => m.metadata?.eventId === 'e');
  assert.equal(stored?.metadata?.messageId, 'm');
  assert.equal(stored?.metadata?.threadId, 'thread');
  assert.deepEqual(stored?.metadata?.author, { id: 'u', name: 'User' });
});

test('G13: modules see coalesced deliveries', async (t) => {
  const seen: string[] = [];
  const spy = { name: 'spy', async start() {}, async stop() {}, async onProcess(e: { type: string }) { seen.push(e.type); return {}; } };
  const f = await fixture({ framework: { modules: [spy] } as never }); t.after(f.close); await f.register();
  await f.send('push/event', f.params('1', 'x', { initial: true }));
  await f.send('channels/incoming', { messages: [f.channel('c', 'y', { initial: true })] });
  assert.deepEqual(seen.filter((x) => x.startsWith('mcpl:')), ['mcpl:push-event', 'mcpl:channel-incoming']);
});

test('G15: inference/request is refused while a cancelled render is still outstanding', async (t) => {
  const f = await fixture(); t.after(f.close);
  let refused: unknown;
  f.renderer(async () => {
    await f.send('push/event', f.params('2', 'notice', { retract: true }));
    refused = (await f.send('inference/request', { featureSet: 'doc', messages: [] })).error?.code;
    return { content: [{ type: 'text', text: 'late' }] };
  });
  await f.send('push/event', f.params('1', 'fallback', { deferred: true, initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(refused, -32600);
  // The withdrawn batch was the turn's only cause: no inference at all.
  assert.equal(f.membrane.calls.length, 0);
  assert(!f.context().includes('late') && !f.context().includes('fallback'));
});

// ---------------------------------------------------------------------------
// Review round 2 (#197): Codex R1–R4 on d86afc1
// ---------------------------------------------------------------------------

test('R1: a deferred acceptance survives a crash before the snapshot flush, with its receipt', async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('1', 'crash_fallback', { deferred: true, data: { k: 'v' } });
  const original = await f.send('push/event', params);
  await crash(f); await f.create();
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, original.result, 'the receipt survived');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'the accepted work was delivered');
  assert(f.lastRequest().includes('crash_fallback'), 'as its fallback: the host cannot prove no render started');
  assert.equal(f.renders.length, 0);
});

test('R2: work admitted under a former binding never reaches the replacement endpoint', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'old_binding_fallback', { deferred: true, data: { secret: 'private_notice_data' } }));
  const config = (f.framework as unknown as { mcplServerConfigs: Map<string, { url: string }> }).mcplServerConfigs.get('editor')!;
  await f.framework.restartMcplServer('editor', { ...config, url: `${config.url}/reassigned` } as never);
  await eventually(() => f.hostCaps.length === 2, 'reconnect to the new endpoint');
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0, 'no push/render to the new peer');
  assert(!JSON.stringify(f.renders).includes('private_notice_data'));
  assert(!f.context().includes('old_binding_fallback'));
});

test('R3: a deferred notice displacing an unread plain occurrence stays in its fork', async (t) => {
  const f = await fixture({ framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never, server: { shouldTriggerInference: () => true } }); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [f.channel('c', 'fork_plain', { initial: true })] });
  const router = (f.framework as unknown as { conversationRouter: { getBinding(channel: { serverId: string; channelId: string }): { agentName: string } | undefined; unbind(channel: { serverId: string; channelId: string }): void } }).conversationRouter;
  const g1 = router.getBinding({ serverId: 'editor', channelId: 'chat' })!.agentName;
  router.unbind({ serverId: 'editor', channelId: 'chat' });
  const r = await f.send('push/event', f.params('n', 'fallback', { deferred: true, channelId: 'chat', key: 'message:m' }));
  assert.equal(r.result.coalesce.outcome, 'replaced');
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert.equal(router.getBinding({ serverId: 'editor', channelId: 'chat' }), undefined, 'no fresh fork');
  const g1ctx = JSON.stringify(f.framework.getAgent(g1)!.getContextManager().getAllMessages());
  assert(g1ctx.includes('document_diff') && !g1ctx.includes('fork_plain'));
});

test('R4: the render-start boundary is persisted before the RPC is issued', async (t) => {
  const f = await fixture(); t.after(f.close);
  let release!: (v: unknown) => void;
  const started = new Promise<void>((resolve) => { f.renderer(() => { resolve(); return new Promise((r) => { release = r; }); }); });
  await f.send('push/event', f.params('1', 'fallback', { deferred: true }));
  const run = f.framework.runUntilIdle();
  await started;
  const store = (f.framework as unknown as { store: { getStateJson(id: string): { subjects: Array<{ batch?: { rendering?: boolean } }> } } }).store;
  assert.equal(store.getStateJson('mcpl/coalescing').subjects[0]?.batch?.rendering, true, 'persisted as RENDERING while the RPC is outstanding');
  release({ content: [{ type: 'text', text: 'rendered' }] });
  await run;
  assert(f.lastRequest().includes('rendered'));
});

// ---------------------------------------------------------------------------
// Review round 3 (#197): Codex on c03b23b — recovery from a mid-window image
// ---------------------------------------------------------------------------

test('R5: an acknowledged retraction is recoverable; a retry cannot resurrect the batch', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'withdrawn_fallback', { deferred: true, initial: true }));
  const retract = f.params('2', 'notice', { retract: true });
  const first = await f.send('push/event', retract);
  assert.equal(first.result.coalesce.outcome, 'retracted');
  await crash(f); await f.create();
  const retry = await f.send('push/event', retract);
  assert.deepEqual(retry.result, first.result);
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
  assert(!f.context().includes('withdrawn_fallback') && !f.context().includes('notice'));
});

test('R6: a completed render is not delivered again as fallback after recovery', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'stale_fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('document_diff'));
  await crash(f); await f.create();
  await f.framework.runUntilIdle();
  const ctx = f.context();
  assert.equal(ctx.split('document_diff').length - 1, 1, 'rendered content exactly once');
  assert(!ctx.includes('stale_fallback'), 'no second delivery as fallback');
  assert.equal(f.renders.length, 1);
  // History is known: a retraction now appends the notice rather than withdrawing.
  const r = await f.send('push/event', f.params('2', 'deleted_notice', { retract: true }));
  assert.equal(r.result.coalesce.outcome, 'noted');
});

test('R7: a read plain occurrence recovered from a mid-window image still gets its deletion notice', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'read_before_crash', { initial: true }));
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('read_before_crash'));
  await crash(f); await f.create();
  const r = await f.send('push/event', f.params('2', 'deletion_notice_after_crash', { retract: true }));
  assert.equal(r.result.coalesce.outcome, 'noted');
  assert(f.context().includes('read_before_crash') && f.context().includes('deletion_notice_after_crash'));
  // And the unread variant stays traceless: born, never read, crash, retract.
  await f.send('push/event', f.params('3', 'never_read', { key: 'k2', initial: true }));
  await crash(f); await f.create();
  const r2 = await f.send('push/event', f.params('4', 'notice2', { key: 'k2', retract: true }));
  assert.equal(r2.result.coalesce.outcome, 'noted', 'a stored occurrence counts as read after recovery (watermark at head)');
  assert(f.context().includes('never_read') && f.context().includes('notice2'));
});

// ---------------------------------------------------------------------------
// Review round 5 (#197): durability under SIGKILL (no stop, no close, no sync)
// ---------------------------------------------------------------------------

async function killChild(mode: 'accept' | 'render'): Promise<{ dir: string; port: number; receipt: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'coalescing-kill-'));
  const child = fork(join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'coalescing-kill-child.js'), [dir, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const [msg] = await once(child, 'message') as [{ port: number; receipt: unknown }];
  child.kill('SIGKILL');
  await once(child, 'exit');
  return { dir, port: msg.port, receipt: msg.receipt };
}

test('R8 (kill, acceptance): the receipt and the accepted work survive SIGKILL after the wire ack', async (t) => {
  const { dir, port, receipt } = await killChild('accept');
  const f = await fixture({ dir, port }); t.after(async () => { await f.close(); rmSync(dir, { recursive: true, force: true }); });
  const retry = await f.send('push/event', f.params('1', 'killed_fallback', { deferred: true, data: { k: 'v' } }));
  assert.deepEqual(retry.result, receipt, 'the receipt survived the kill');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'the accepted work survived the kill');
  assert(f.lastRequest().includes('killed_fallback'));
});

test('R9 (kill, render-start): a render that may have run is not issued again after SIGKILL', async (t) => {
  const { dir, port } = await killChild('render');
  const f = await fixture({ dir, port }); t.after(async () => { await f.close(); rmSync(dir, { recursive: true, force: true }); });
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0, 'no second push/render');
  assert(f.lastRequest().includes('render_fallback'), 'the fallback is delivered instead');
});

// ---------------------------------------------------------------------------
// Review round 6 (#197): the asynchronous barrier's failure and interleaving paths
// ---------------------------------------------------------------------------

test('R10: a retry after a failed commit is acknowledged only once the commit succeeds', async (t) => {
  const f = await fixture(); t.after(f.close);
  const store = (f.framework as unknown as { store: { sync: () => void } }).store;
  const orig = store.sync.bind(store);
  let syncs = 0; let failing = 1;
  store.sync = () => { syncs++; if (failing > 0) { failing--; throw new Error('EIO simulated'); } orig(); };
  const params = f.params('1', 'fallback', { deferred: true, initial: true });
  const first = await f.send('push/event', params);
  assert.equal(first.error?.code, -32000);
  const before = syncs;
  const retry = await f.send('push/event', params);
  assert.equal(retry.result?.coalesce?.outcome, 'first', 'acknowledged on the retry');
  assert(syncs > before, 'the retry committed; it did not just return the pending receipt');
  // Still failing: the retry fails again rather than acknowledging.
  failing = 1;
  const again = await f.send('push/event', f.params('2', 'other', { key: 'k2', initial: true }));
  assert.equal(again.error?.code, -32000);
  const again2 = await f.send('push/event', f.params('2', 'other', { key: 'k2', initial: true }));
  assert.equal(again2.result?.coalesce?.outcome, 'first');
  assert.equal(f.framework.getAgent('agent')!.getContextManager().getAllMessages().filter((m) => JSON.stringify(m.content).includes('other')).length, 1, 'plain: delivered exactly once across the failed and successful acknowledgement');
});

/** Make the host's next `times` writes of a coalescing receipt record fail,
 *  as a full disk would; returns how many are still to fail. A write that
 *  only empties the list, as the snapshot flush's does, isn't counted. */
function failReceiptWrites(f: Awaited<ReturnType<typeof fixture>>, times: number): () => number {
  const store = (f.framework as unknown as { store: { setStateJson: (id: string, value: unknown) => void } }).store;
  const orig = store.setStateJson.bind(store);
  let left = times;
  store.setStateJson = (id, value) => {
    if (id === 'mcpl/coalescing-recent' && Array.isArray(value) && value.length > 0 && left > 0) { left--; throw new Error('ENOSPC simulated'); }
    orig(id, value);
  };
  return () => left;
}

/** How many of the agent's messages hold `text`. */
function copies(f: Awaited<ReturnType<typeof fixture>>, text: string): number {
  return f.framework.getAgent('agent')!.getContextManager().getAllMessages().filter((m) => JSON.stringify(m.content).includes(text)).length;
}

/** A producer's first send and five resends of one event (discord-mcpl's
 *  schedule, less its waits), the agent taking a turn after each, so a copy
 *  delivered again would be read rather than replaced. Returns each answer. */
async function sendAndResend(f: Awaited<ReturnType<typeof fixture>>, send: () => Promise<any>): Promise<any[]> {
  const answers: any[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    answers.push(await send());
    await f.framework.runUntilIdle();
  }
  return answers;
}

const failedReceiptWrite = {
  'a plain push': {
    text: 'plain_copy', before: async () => {},
    send: (f: Awaited<ReturnType<typeof fixture>>) => f.send('push/event', f.params('e1', 'plain_copy', { initial: true })),
    first: { accepted: true, coalesce: { outcome: 'first' } },
  },
  'a coalesced channel message': {
    text: 'chan_copy', before: async (f: Awaited<ReturnType<typeof fixture>>) => { await f.register(); },
    send: (f: Awaited<ReturnType<typeof fixture>>) => f.send('channels/incoming', { messages: [f.channel('c1', 'chan_copy', { initial: true })] }),
    first: { results: [{ messageId: 'm', accepted: true, coalesce: { outcome: 'first' } }] },
  },
  'a deferred notice': {
    text: 'document_diff', before: async () => {},
    send: (f: Awaited<ReturnType<typeof fixture>>) => f.send('push/event', f.params('d1', 'deferred_copy', { deferred: true, initial: true })),
    first: { accepted: true, coalesce: { outcome: 'first' } },
  },
  'a deletion notice of a read message': {
    text: 'deletion_notice',
    before: async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.send('push/event', f.params('r0', 'original_text', { initial: true }));
      await f.framework.runUntilIdle();
    },
    send: (f: Awaited<ReturnType<typeof fixture>>) => f.send('push/event', f.params('r1', 'deletion_notice', { retract: true })),
    first: { accepted: true, coalesce: { outcome: 'noted', priorEventId: 'r0' } },
  },
};

for (const [what, c] of Object.entries(failedReceiptWrite)) test(`a failed receipt write keeps the receipt: ${what} resent five times reaches the agent once, and every resend answers the first result`, async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  await c.before(f);
  const left = failReceiptWrites(f, 1);
  const [first, ...resends] = await sendAndResend(f, () => c.send(f));
  assert.equal(left(), 0, 'the write failed once');
  // The channel lane too answers the request -32000: a per-message
  // `accepted: false` would say the message wasn't admitted.
  assert.equal(first.error?.code, -32000, 'the first send is answered -32000');
  assert.equal(first.error?.message, 'host could not persist the acceptance; retry');
  for (const resend of resends) assert.deepEqual(resend.result, c.first, 'a resend answers the first result');
  assert.equal(copies(f, c.text), 1, 'one copy reached the agent');
  if (what === 'a deferred notice') assert.equal(f.renders.length, 1, 'one render');
});

test('a channels/incoming request stops at a message admitted without its receipt: the request is answered -32000, nothing after it is admitted, and the resend answers both', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  await f.register();
  failReceiptWrites(f, 1);
  const request = { messages: [f.channel('a1', 'first_message', { initial: true }, 'chat', 'ma'), f.channel('b1', 'second_message', { initial: true }, 'chat', 'mb')] };
  const first = await f.send('channels/incoming', request);
  assert.equal(first.error?.code, -32000);
  await f.framework.runUntilIdle();
  assert.equal(copies(f, 'first_message'), 1, 'the first message was admitted');
  assert.equal(copies(f, 'second_message'), 0, 'nothing after it was');
  const resend = await f.send('channels/incoming', request);
  assert.deepEqual(resend.result, { results: [
    { messageId: 'ma', accepted: true, coalesce: { outcome: 'first' } },
    { messageId: 'mb', accepted: true, coalesce: { outcome: 'first' } },
  ] });
  await f.framework.runUntilIdle();
  assert.equal(copies(f, 'first_message'), 1);
  assert.equal(copies(f, 'second_message'), 1);
});

test('a channels/incoming request whose coalesced message is admitted without its receipt, after an uncoalesced one, fails; the resend admits the uncoalesced message again and answers the coalesced one from its receipt', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  await f.register();
  failReceiptWrites(f, 1);
  const { coalesce: _none, ...uncoalesced } = f.channel('u1', 'loose_copy', {}, 'chat', 'mu');
  const request = { messages: [uncoalesced, f.channel('c1', 'coalesced_copy', { initial: true }, 'chat', 'mc')] };
  const first = await f.send('channels/incoming', request);
  assert.deepEqual(first.error && { code: first.error.code, data: first.error.data }, { code: -32000, data: { field: 'eventId' } });
  await f.framework.runUntilIdle();
  const resend = await f.send('channels/incoming', request);
  assert.deepEqual(resend.result, { results: [
    { messageId: 'mu', accepted: true },
    { messageId: 'mc', accepted: true, coalesce: { outcome: 'first' } },
  ] });
  await f.framework.runUntilIdle();
  // The cost named in the change: the uncoalesced message has no receipt.
  assert.equal(copies(f, 'loose_copy'), 2);
  assert.equal(copies(f, 'coalesced_copy'), 1);
});

test("a receipt record whose write failed isn't written later with the batch it held, so a crash after another subject's receipt doesn't bring back a batch since dropped", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  failReceiptWrites(f, 1);
  const answer = await f.send('push/event', f.params('e1', 'dropped_fallback', { deferred: true, initial: true }));
  assert.equal(answer.error?.code, -32000);
  const internals = f.framework as unknown as { coalescedAuthorized: (occ: unknown) => boolean };
  const authorized = internals.coalescedAuthorized.bind(internals);
  internals.coalescedAuthorized = () => false;
  try {
    await settles(f.framework.runUntilIdle(), 'the assembly that drops the revoked batch');
  } finally {
    internals.coalescedAuthorized = authorized;
  }
  const other = await f.send('push/event', f.params('o1', 'other_subject', { initial: true, key: 'notes' }));
  assert.equal(other.result.coalesce.outcome, 'first', "another subject's receipt is written");
  await crash(f); await f.create();
  await settles(f.framework.runUntilIdle(), 'the drain after the restart');
  assert(!f.context().includes('dropped_fallback'), 'the dropped batch is not delivered after the restart');
});

test('a coalescer failure before any effect stays a per-message refusal on the channel lane', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.register();
  (f.framework as unknown as { pushCoalescer: PushCoalescer<unknown> }).pushCoalescer.suspend();
  const answer = await f.send('channels/incoming', { messages: [f.channel('s1', 'stopping_message', { initial: true })] });
  assert.deepEqual(answer.result, { results: [{ messageId: 'm', accepted: false, reason: 'host is stopping' }] });
  assert.equal(copies(f, 'stopping_message'), 0);
});

test('a retry of an admitted message while the host is stopping fails the request on the channel lane, not the message', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.register();
  failReceiptWrites(f, 1);
  const send = () => f.send('channels/incoming', { messages: [f.channel('s1', 'stop_copy', { initial: true })] });
  assert.equal((await send()).error?.code, -32000);
  (f.framework as unknown as { pushCoalescer: PushCoalescer<unknown> }).pushCoalescer.suspend();
  const retry = await send();
  assert.deepEqual(retry.error && { code: retry.error.code, message: retry.error.message }, { code: -32000, message: 'host is stopping' });
});

test('a coalescing save that fails stays unsaved, so the stop saves it and a retry after the restart is answered from the receipt it carries', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  failReceiptWrites(f, 1);
  const store = (f.framework as unknown as { store: { setStateJson: (id: string, value: unknown) => void } }).store;
  const write = store.setStateJson.bind(store);
  let failSnapshot = 1;
  store.setStateJson = (id, value) => {
    if (id === 'mcpl/coalescing' && failSnapshot > 0) { failSnapshot--; throw new Error('ENOSPC simulated'); }
    write(id, value);
  };
  const send = () => f.send('push/event', f.params('e1', 'plain_copy', { initial: true }));
  assert.equal((await send()).error?.code, -32000, "the receipt's record wasn't written");
  // The throttled save fails too: only the receipt in memory holds the admission.
  (f.framework as unknown as { flushCoalescingSnapshot: () => void }).flushCoalescingSnapshot();
  assert.equal(failSnapshot, 0, 'the save failed');
  await f.framework.runUntilIdle();
  await f.framework.stop(); await f.create();
  const retry = await send();
  assert.deepEqual(retry.result, { accepted: true, coalesce: { outcome: 'first' } }, 'answered from the receipt the stop saved');
  await f.framework.runUntilIdle();
  assert.equal(copies(f, 'plain_copy'), 1);
});

test('a receipt write that fails on the send and every resend repeats no effect, and the first resend after it works answers the first result', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  failReceiptWrites(f, 6);
  const send = () => f.send('push/event', f.params('e1', 'plain_copy', { initial: true }));
  const answers = await sendAndResend(f, send);
  for (const answer of answers) assert.equal(answer.error?.code, -32000);
  assert.equal(copies(f, 'plain_copy'), 1, 'one copy, read, though every answer failed');
  const after = await send();
  assert.deepEqual(after.result, { accepted: true, coalesce: { outcome: 'first' } });
  await f.framework.runUntilIdle();
  assert.equal(copies(f, 'plain_copy'), 1);
});

/** Hold the host's next durability commit; returns a release function once it is held. */
function holdNextCommit(f: Awaited<ReturnType<typeof fixture>>): Promise<() => void> {
  const internals = f.framework as unknown as { commitCoalescingDurable: () => Promise<void> };
  const orig = internals.commitCoalescingDurable.bind(internals);
  return new Promise((held) => {
    internals.commitCoalescingDurable = () => {
      internals.commitCoalescingDurable = orig;
      return new Promise<void>((resolve) => { held(() => orig().then(resolve, resolve)); });
    };
  });
}

test('a channels/incoming request whose first commit is held admits every message once the commit is made', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  f.alwaysRespond();
  const held = holdNextCommit(f);
  const batch = f.send('channels/incoming', { messages: [
    f.channel('e1', 'held_one', {}, 'chat', 'm1'), f.channel('e2', 'held_two', {}, 'chat', 'm2'), f.channel('e3', 'held_three', {}, 'chat', 'm3'),
  ] });
  (await held)();
  const answer = await batch;
  assert.deepEqual(answer.result.results.map((r: { messageId: string; accepted: boolean }) => [r.messageId, r.accepted]), [['m1', true], ['m2', true], ['m3', true]]);
  await settles(f.framework.runUntilIdle(), 'the turns the messages wake');
  for (const text of ['held_one', 'held_two', 'held_three']) assert.equal(copies(f, text), 1, `${text} reached the agent`);
});

test('R11: a retraction during the render-start commit wait is final; the batch is not restored', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'withdrawn_fallback', { deferred: true, initial: true }));
  const held = holdNextCommit(f);
  const run = f.framework.runUntilIdle();
  const release = await held;
  // The freeze (including this commit wait) is one critical section with
  // admission: the retraction is admitted only after it, so it is sent
  // without awaiting here and settles either way as a cancellation.
  const pending = f.send('push/event', f.params('2', 'notice', { retract: true }));
  release();
  const r = await pending;
  assert.equal(r.result.coalesce.outcome, 'retracted');
  await run;
  assert.equal((f.framework as unknown as { pushCoalescer: { pendingBatches(): number } }).pushCoalescer.pendingBatches(), 0);
  assert(!f.context().includes('withdrawn_fallback') && !f.context().includes('document_diff'), 'nothing of the withdrawn batch was published');
  assert.equal(f.membrane.calls.length, 0, 'and the withdrawn batch, the only cause, started no inference');
  const renders = f.renders.length;
  await f.turn();
  assert.equal(f.renders.length, renders, 'and nothing renders later');
  assert(!f.context().includes('withdrawn_fallback') && !f.context().includes('document_diff'));
});

test('R12: endpoint reassignment during the render-start commit wait never sends the batch to the new peer', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'old_fallback', { deferred: true, data: { secret: 'private_notice_data' } }));
  let withdrawn = 0;
  f.framework.onTrace((e) => { if (e.type === 'mcpl:coalescing' && (e as { kind?: string }).kind === 'turn-withdrawn') withdrawn++; });
  const held = holdNextCommit(f);
  const run = f.framework.runUntilIdle();
  const release = await held;
  const config = (f.framework as unknown as { mcplServerConfigs: Map<string, { url: string }> }).mcplServerConfigs.get('editor')!;
  await f.framework.restartMcplServer('editor', { ...config, url: `${config.url}/reassigned` } as never);
  await eventually(() => f.hostCaps.length === 2, 'reconnect to the new endpoint');
  release();
  // A second model call would wait for a response the fixture never queues.
  await settles(run, 'the drain after the reassignment');
  assert.equal(f.renders.length, 0, 'no push/render to the new peer');
  assert(!JSON.stringify(f.renders).includes('private_notice_data'));
  assert(!f.context().includes('old_fallback'));
  assert.equal(f.membrane.calls.length, 0, 'and the revoked batch, the only cause, started no inference');
  assert.equal(withdrawn, 1, 'its turn started and was withdrawn');
});

// ---------------------------------------------------------------------------
// Review round 7 (#197): neighbours of the round-6 fixes
// ---------------------------------------------------------------------------

test('R13: a retraction during the audience lookup is final; the stale batch is not frozen', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'withdrawn_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as { coalescedAudience: (occ: unknown) => Promise<string[]> };
  const orig = internals.coalescedAudience.bind(internals);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    internals.coalescedAudience = (occ) => { internals.coalescedAudience = orig; return new Promise<string[]>((res) => { release = () => orig(occ).then(res); resolve(); }); };
  });
  const run = f.framework.runUntilIdle();
  await held;
  const pending = f.send('push/event', f.params('2', 'notice', { retract: true }));
  release();
  const r = await pending;
  assert.equal(r.result.coalesce.outcome, 'retracted');
  await run;
  assert(!f.context().includes('withdrawn_fallback') && !f.context().includes('document_diff'), 'nothing of the withdrawn batch was published');
  await f.turn();
  assert(!f.context().includes('document_diff'));
});

test('a turn whose batch\'s audience no longer names its agent at the assembly starts no inference', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'moved_fallback', { deferred: true, initial: true }));
  // The admission's wake has looked the audience up; the next lookup is the
  // assembly's, and it names another agent instead, as when a conversation
  // fork's channel is bound to a new fork in between.
  const internals = f.framework as unknown as { coalescedAudience: (occ: unknown) => Promise<string[]>; pushCoalescer: { pendingBatches(): number } };
  const orig = internals.coalescedAudience.bind(internals);
  internals.coalescedAudience = async () => { internals.coalescedAudience = orig; return ['conversation-chat-g2']; };
  let withdrawn = 0;
  f.framework.onTrace((e) => { if (e.type === 'mcpl:coalescing' && (e as { kind?: string }).kind === 'turn-withdrawn') withdrawn++; });
  // A second model call would wait for a response the fixture never queues.
  await settles(f.framework.runUntilIdle(), 'the drain after the wake');
  assert.equal(f.renders.length, 0);
  assert(!f.context().includes('moved_fallback'));
  assert.equal(f.membrane.calls.length, 0, 'the batch, the only cause, started no inference');
  assert.equal(withdrawn, 1, 'its turn started and was withdrawn');
  assert.equal(internals.pushCoalescer.pendingBatches(), 1, 'the batch stays pending');
});

test('an assembly for an agent outside the audience of a batch another assembly is rendering declines it', async (t) => {
  const f = await fixture({ agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }, { name: 'other', model: 'test', systemPrompt: 'test' }] }); t.after(f.close);
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  f.renderer(() => { began(); return new Promise((resolve) => { release = resolve; }); });
  await f.send('push/event', f.params('1', 'shared_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as { coalescedAudience: (occ: unknown) => Promise<string[]>; pushCoalescer: { assemble(agent: string): Promise<{ settled: Set<string>; materialized: Set<string> }> } };
  // From here on the audience is 'other' alone, as when a conversation fork's
  // channel has moved to a new fork. 'other' freezes the batch and its render
  // is held; 'agent' then assembles while it's in flight.
  internals.coalescedAudience = async () => ['other'];
  const rendering = internals.pushCoalescer.assemble('other');
  await settles(started, "the render for 'other'");
  // Joining the held render instead would wait for a release that comes
  // only after this call.
  const declined = await settles(internals.pushCoalescer.assemble('agent'), "the assembly for 'agent'");
  assert.equal(declined.settled.size, 1, 'the subject is settled for the agent outside the audience');
  assert.equal(declined.materialized.size, 0, 'and gave it nothing');
  release({ content: [{ type: 'text', text: 'shared_render' }] });
  const rendered = await settles(rendering, "the assembly for 'other'");
  assert.equal(rendered.materialized.size, 1, 'the assembly in the audience delivered the render');
});

// ---------------------------------------------------------------------------
// A batch-only turn whose batch is gone, rendering elsewhere, or placed in
// another agent's queue (a turn with nothing to read never reaches the model)
// ---------------------------------------------------------------------------

type Wake = { agentName: string; reason?: string; source?: string; timestamp?: number; coalescingSubject?: string; coalescingBatch?: boolean; coalescingBatchSubjects?: string[]; readsDeferredWrite?: string; readsStoredMessage?: string; channelId?: string };

type TurnInternals = {
  startAgentStream: (...a: unknown[]) => Promise<unknown>;
  processInferenceRequests: () => Promise<void>;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Wake[];
  providerAccelerationCooldowns: Map<string, { startedAt: number; until: number; timer: ReturnType<typeof setTimeout>; heldRequests: Wake[]; reason: string; failures: number }>;
  releaseProviderAccelerationCooldown(agent: string): void;
  providerGate(agent: string): { auxiliaryInFlight: number; idleWaiters: Array<() => void> };
  drainDeferredFor(agent: string): unknown[];
  readdDrained(entries: unknown[], where: string, opts?: { bypassDeferral?: boolean }): unknown[];
  ackDeferredWrites(): void;
  pushCoalescer: {
    pendingBatches(): number;
    assemble(agent: string, causes?: readonly string[]): Promise<{ settled: Set<string>; materialized: Set<string> }>;
  };
};

const TWO_RESIDENTS = [
  { name: 'agent', model: 'test', systemPrompt: 'test' },
  { name: 'other', model: 'test', systemPrompt: 'test' },
];

/** A trigger filter under which a push whose text says 'quiet' triggers no inference. */
const QUIET_PUSHES_DONT_TRIGGER = { shouldTriggerInference: (text: string) => !text.includes('quiet') };

/** Ends the turn a stand-in token kept alive, storing what waited in its
 *  deferred queue, as a torn-down turn's flush does. */
function endStandInTurn(internals: TurnInternals, agent = 'agent'): void {
  if (!internals.activeTurnTokens.delete(agent)) return;
  internals.readdDrained(internals.drainDeferredFor(agent), 'the stand-in turn ends');
  internals.ackDeferredWrites();
}

function withdrawals(f: Awaited<ReturnType<typeof fixture>>): string[] {
  const agents: string[] = [];
  f.framework.onTrace((e) => {
    const ev = e as { type: string; kind?: string; agentName?: string };
    if (ev.type === 'mcpl:coalescing' && ev.kind === 'turn-withdrawn') agents.push(ev.agentName ?? '');
  });
  return agents;
}

test('a batch-only turn whose batch is retracted after its wake is dispatched starts no inference', async (t) => {
  const f = await fixture(); t.after(f.close);
  const withdrawn = withdrawals(f);
  await f.send('push/event', f.params('1', 'withdrawn_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  const start = internals.startAgentStream.bind(internals);
  // The retraction lands after the scheduler took the wake and before the
  // turn reaches its assembly, as it can while the wake waits behind an
  // auxiliary call. No batch is pending by the time the turn gets there.
  internals.startAgentStream = async (...a: unknown[]) => {
    internals.startAgentStream = start;
    const r = await f.send('push/event', f.params('2', '', { retract: true }));
    assert.equal(r.result.coalesce.outcome, 'retracted');
    return start(...a);
  };
  await settles(f.framework.runUntilIdle(), 'the drain after the wake');
  assert.equal(f.membrane.calls.length, 0, 'the withdrawn batch, the only cause, started no inference');
  assert.deepEqual(withdrawn, ['agent'], 'its turn started and was withdrawn');
});

test('a batch-only turn whose batch is retracted while its assembly waits for the coalescer starts no inference', async (t) => {
  const f = await fixture(); t.after(f.close);
  const withdrawn = withdrawals(f);
  await f.send('push/event', f.params('1', 'withdrawn_fallback', { deferred: true, initial: true }));
  const coalescer = (f.framework as unknown as TurnInternals).pushCoalescer;
  const assemble = coalescer.assemble.bind(coalescer);
  // The retraction lands after the gate saw the batch pending and before the
  // batch's freeze, as it can while another admission holds the coalescer's
  // lock; this seam, before the assembly takes the lock, stands in for that
  // wait.
  coalescer.assemble = async (...a) => {
    coalescer.assemble = assemble;
    const r = await f.send('push/event', f.params('2', '', { retract: true }));
    assert.equal(r.result.coalesce.outcome, 'retracted');
    return assemble(...a);
  };
  await settles(f.framework.runUntilIdle(), 'the drain after the wake');
  assert.equal(f.membrane.calls.length, 0, 'the withdrawn batch, the only cause, started no inference');
  assert.deepEqual(withdrawn, ['agent'], 'its turn started and was withdrawn');
});

test('a batch-only turn whose batch a plain occurrence replaces while its assembly waits gives way to the replacement\'s own turn', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  const withdrawn = withdrawals(f);
  await f.send('push/event', f.params('1', 'replaced_fallback', { deferred: true, initial: true }));
  const coalescer = (f.framework as unknown as TurnInternals).pushCoalescer;
  const assemble = coalescer.assemble.bind(coalescer);
  // The replacement lands while the turn is alive, so it waits in the
  // deferred queue: this turn's compile wouldn't show it.
  coalescer.assemble = async (...a) => {
    coalescer.assemble = assemble;
    const r = await f.send('push/event', f.params('2', 'plain_replacement'));
    assert.equal(r.result.coalesce.outcome, 'replaced');
    return assemble(...a);
  };
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert.deepEqual(withdrawn, ['agent'], 'the batch-only turn was withdrawn');
  assert.equal(f.membrane.calls.length, 1, "the replacement's own wake started one turn");
  assert(f.lastRequest().includes('plain_replacement'), 'which read the replacement');
});

test("a batch-only turn whose batch a stored replacement displaced gets nothing of it; the replacement wakes whom its own trigger wakes", async (t) => {
  const f = await fixture({ server: QUIET_PUSHES_DONT_TRIGGER }); t.after(f.close);
  f.alwaysRespond();
  const withdrawn = withdrawals(f);
  await f.send('push/event', f.params('1', 'replaced_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  const start = internals.startAgentStream.bind(internals);
  // The replacement, which triggers no inference, lands after the scheduler
  // took the batch's wake and before the turn is alive, so it's stored and
  // unread when the turn assembles.
  internals.startAgentStream = async (...a: unknown[]) => {
    internals.startAgentStream = start;
    const r = await f.send('push/event', f.params('2', 'quiet_replacement'));
    assert.equal(r.result.coalesce.outcome, 'replaced');
    return start(...a);
  };
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert(f.context().includes('quiet_replacement'), 'the replacement is in context');
  assert.equal(f.membrane.calls.length, 0, "the batch's turn didn't take the replacement as its own");
  assert.deepEqual(withdrawn, ['agent']);
});

test("a batch-only turn that reaches its assembly while another resident's assembly renders its batch waits for it and gets nothing of it: one call reads the render", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  const withdrawn = withdrawals(f);
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  f.renderer(() => { began(); return new Promise((resolve) => { release = resolve; }); });
  await f.send('push/event', f.params('1', 'shared_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  const coalescer = internals.pushCoalescer;
  // 'other''s wake parks behind an auxiliary call of its own, so its turn
  // starts outside the scheduler's pass, once the call ends: the one way two
  // residents' assemblies overlap. The primary's turn is alive (this token
  // stands in for one), so the same pass leaves the primary's wake queued.
  const otherGate = internals.providerGate('other');
  otherGate.auxiliaryInFlight = 1;
  internals.activeTurnTokens.set('agent', -1);
  try {
    await settles(internals.processInferenceRequests(), 'the pass that parks the wake');
    assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent'], "the primary's wake waits for its turn to end");
  } finally {
    endStandInTurn(internals);
  }
  // The primary's turn starts, and its assembly renders the batch, held.
  const pass = internals.processInferenceRequests();
  await settles(started, "the primary's render");
  // The auxiliary call ends, and 'other''s turn reaches its assembly while
  // the render is in flight. A host that skips the assembly with no batch
  // pending calls the model for 'other' instead.
  const assemble = coalescer.assemble.bind(coalescer);
  let joins!: () => void;
  const otherAssembles = new Promise<void>((resolve) => { joins = resolve; });
  let otherAssembly: ReturnType<typeof assemble> | undefined;
  coalescer.assemble = (agent, causes) => {
    const assembly = assemble(agent, causes);
    if (agent === 'other') { otherAssembly = assembly; joins(); }
    return assembly;
  };
  const start = internals.startAgentStream.bind(internals);
  let otherTurn: Promise<unknown> = new Promise(() => {});
  let otherStarts!: () => void;
  const otherStarted = new Promise<void>((resolve) => { otherStarts = resolve; });
  internals.startAgentStream = (...a: unknown[]) => {
    const turn = start(...a);
    if ((a[0] as { name: string }).name === 'other') { otherTurn = turn; otherStarts(); }
    return turn;
  };
  otherGate.auxiliaryInFlight = 0;
  for (const resolve of otherGate.idleWaiters.splice(0)) resolve();
  await settles(Promise.race([otherAssembles, otherStarted.then(() => otherTurn)]), "'other''s assembly or its turn");
  if (otherAssembly) {
    // 'other' joined the render in flight, so its assembly waits for it.
    let settledEarly = false;
    void otherAssembly.then(() => { settledEarly = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert(!settledEarly, "'other''s assembly waits for the render in flight");
  }
  release({ content: [{ type: 'text', text: 'shared_render' }] });
  await settles(pass, "the primary's turn");
  await settles(otherTurn, "'other''s turn");
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert.equal(f.membrane.calls.length, 1, 'the batch got one model call');
  assert(f.lastRequest().includes('shared_render'), 'and that call read the render');
  assert.deepEqual(withdrawn, ['other'], "'other''s turn got nothing of the primary's render");
});

test("a render placed in a live turn's deferred queue isn't read by the resident that rendered it; the queue's agent is woken for it", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  const withdrawn = withdrawals(f);
  await f.send('push/event', f.params('1', 'queued_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // The primary's turn is alive, as while it waits on a tool call; this
  // token stands in for one. 'other''s assembly renders the batch, and the
  // delivery, bound for the primary's context, waits in its queue.
  internals.activeTurnTokens.set('agent', -1);
  try {
    await settles(internals.processInferenceRequests(), 'one scheduler pass');
    assert.equal(f.membrane.calls.length, 0, "'other' read nothing, so its turn started no inference");
    assert.deepEqual(withdrawn, ['other']);
    assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent'], 'the primary is woken for the render');
    assert(!f.context().includes('document_diff'), 'which is still in its queue');
  } finally {
    endStandInTurn(internals);
  }
  await settles(f.framework.runUntilIdle(), "the primary's turn");
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('document_diff'), "the primary's turn read the render once its queue was flushed");
});

test("a render placed in a live turn's deferred queue takes a newer batch of its subject, and its wakes, to its agent", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let renders = 0;
  f.renderer(() => {
    if (++renders > 1) return Promise.resolve({ content: [{ type: 'text', text: 'second_render' }] });
    began();
    return new Promise((resolve) => { release = resolve; });
  });
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // As above, the primary's turn is alive and 'other''s assembly renders the
  // batch, here held. A notice during the render opens a newer batch of the
  // subject, which wakes its audience. Once the render lands in the
  // primary's queue, the newer batch follows the primary, wakes included.
  internals.activeTurnTokens.set('agent', -1);
  try {
    const pass = internals.processInferenceRequests();
    await settles(started, "the render for 'other'");
    await f.send('push/event', f.params('2', 'second_fallback', { deferred: true }));
    const woken = internals.pendingRequests.map((r) => r.agentName).sort();
    assert.deepEqual(woken, ['agent', 'other']);
    release({ content: [{ type: 'text', text: 'first_render' }] });
    await settles(pass, 'the scheduler pass');
    assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent', 'agent'],
      "the newer batch's wake is the primary's now, beside the primary's wake for the render");
  } finally {
    endStandInTurn(internals);
  }
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('first_render') && f.lastRequest().includes('second_render'), 'one call read both renders');
});

test("a render placed in a live turn's deferred queue wakes its agent though a newer batch of its subject wakes no one", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS, server: QUIET_PUSHES_DONT_TRIGGER }); t.after(f.close);
  f.alwaysRespond();
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let renders = 0;
  f.renderer(() => {
    if (++renders > 1) return Promise.resolve({ content: [{ type: 'text', text: 'second_render' }] });
    began();
    return new Promise((resolve) => { release = resolve; });
  });
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // As above, but the notice during the render triggers no inference: the
  // newer batch it opens replaces the subject's wakes with none.
  internals.activeTurnTokens.set('agent', -1);
  try {
    const pass = internals.processInferenceRequests();
    await settles(started, "the render for 'other'");
    await f.send('push/event', f.params('2', 'quiet_fallback', { deferred: true }));
    assert.equal(internals.pendingRequests.length, 0, 'the newer batch wakes no one');
    release({ content: [{ type: 'text', text: 'first_render' }] });
    await settles(pass, 'the scheduler pass');
    assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent'], 'the primary is woken for the render in its queue');
  } finally {
    endStandInTurn(internals);
  }
  await settles(f.framework.runUntilIdle(), "the primary's turn");
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('first_render'), "the primary's turn read the render");
});

test("a notice after a render landed unread in a live turn's deferred queue leaves it there, and the turn reads it before the newer render (#548)", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  let renders = 0;
  f.renderer(() => Promise.resolve({ content: [{ type: 'text', text: ++renders > 1 ? 'second_render' : 'first_render' }] }));
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // The primary's turn is alive, so 'other''s assembly places the render in
  // the primary's deferred queue, unread. A notice then arrives. The render
  // is a delta the next one builds on (RFC-006 §5.2), so it stays, and the
  // notice's batch follows the primary.
  internals.activeTurnTokens.set('agent', -1);
  try {
    await settles(internals.processInferenceRequests(), 'the scheduler pass');
    assert.equal(renders, 1, "'other''s assembly rendered the first batch");
    await f.send('push/event', f.params('2', 'second_fallback', { deferred: true }));
    assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent', 'agent'], "the render's wake and the newer batch's, both the primary's");
  } finally {
    endStandInTurn(internals);
  }
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert.equal(f.membrane.calls.length, 1);
  const request = f.lastRequest();
  assert(request.includes('first_render') && request.indexOf('first_render') < request.indexOf('second_render'), 'one call read the first render, then the second');
});

test("a render placed in a live turn's deferred queue takes a newer batch of its subject to its agent, so another agent's assembly leaves that batch and the render's wake alone", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  const withdrawn = withdrawals(f);
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let renders = 0;
  f.renderer(() => {
    if (++renders > 1) return Promise.resolve({ content: [] });
    began();
    return new Promise((resolve) => { release = resolve; });
  });
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // As above: the primary's turn is alive, 'other''s assembly renders the
  // batch into the primary's queue, and a notice during the render opens a
  // newer batch, which wakes both. Once the render lands, the newer batch
  // follows the primary, whose queue holds the render it builds on (RFC-006
  // §5.2), wakes included. In the next pass the primary is still busy, and
  // 'other' has no wake left for the batch: the batch waits, with its wake,
  // for the primary.
  internals.activeTurnTokens.set('agent', -1);
  try {
    const pass = internals.processInferenceRequests();
    await settles(started, "the render for 'other'");
    await f.send('push/event', f.params('2', 'second_fallback', { deferred: true }));
    release({ content: [{ type: 'text', text: 'first_render' }] });
    await settles(pass, 'the first pass');
    await settles(internals.processInferenceRequests(), 'the second pass');
    assert.deepEqual(withdrawn, ['other'], "only 'other''s turn that rendered the first batch, which gave it nothing");
    assert.equal(renders, 1, "'other''s assembly didn't render the newer batch");
    assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent', 'agent'], "the primary's wakes for the render and for the newer batch both wait for its turn");
  } finally {
    endStandInTurn(internals);
  }
  await settles(f.framework.runUntilIdle(), "the primary's turn");
  assert.equal(renders, 2, "the primary's assembly rendered the newer batch, which gave nothing");
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('first_render'), "the primary's turn read the render");
});

test("a render whose write failed at its agent's turn start is read before the next render of its subject, in that turn's request", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  let renders = 0;
  f.renderer(() => Promise.resolve({ content: [{ type: 'text', text: ++renders > 1 ? 'second_render' : 'first_render' }] }));
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // As in the test above: 'other''s assembly places the render in the
  // primary's deferred queue while the primary's turn is alive, and a notice
  // opens a newer batch, which follows the primary. That turn ends without
  // a flush, so the render is still queued when the primary's next turn
  // starts, and that start's flush fails to store it, once.
  internals.activeTurnTokens.set('agent', -1);
  try {
    await settles(internals.processInferenceRequests(), 'the scheduler pass');
    assert.equal(renders, 1, "'other''s assembly rendered the first batch");
    await f.send('push/event', f.params('2', 'second_fallback', { deferred: true }));
  } finally {
    internals.activeTurnTokens.delete('agent');
  }
  const cm = f.framework.getAgent('agent')!.getContextManager();
  const add = cm.addMessage.bind(cm);
  let failed = false;
  (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
    if (!failed && JSON.stringify(args[1]).includes('first_render')) {
      failed = true;
      throw new Error('transient');
    }
    return add(...args);
  };
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await settles(f.framework.runUntilIdle(), "the primary's turn");
  } finally {
    console.error = error;
  }
  assert.ok(errors.some((e) => e.includes('turn-start flush for agent') && e.includes('transient')), "the start's flush couldn't store the first render");
  assert.equal(renders, 2);
  assert.equal(f.membrane.calls.length, 1);
  const request = f.lastRequest();
  assert(request.includes('first_render') && request.indexOf('first_render') < request.indexOf('second_render'), 'one call read the first render, then the second');
});

test("a render an assembly joins reaches the joining agent's request when it lands in that agent's queue (vector 25)", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let joined!: () => void;
  const notesStarted = new Promise<void>((resolve) => { joined = resolve; });
  f.renderer((params) => {
    if (JSON.stringify(params).includes('notes')) {
      joined();
      return Promise.resolve({ content: [{ type: 'text', text: 'notes_render' }] });
    }
    began();
    return new Promise((resolve) => { release = resolve; });
  });
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // While the primary's turn is alive, 'other''s assembly freezes the
  // document's batch and awaits its render.
  internals.activeTurnTokens.set('agent', -1);
  const first = internals.processInferenceRequests();
  await settles(started, "the document's render for 'other'");
  // A batch of another subject wakes the primary, whose assembly joins the
  // document's render (it is in that batch's audience) and renders the notes'
  // batch. Its iteration reaches the document first, so the notes' render
  // starting means the join is made.
  await f.send('push/event', f.params('2', 'notes_fallback', { deferred: true, initial: true, key: 'notes' }));
  internals.activeTurnTokens.delete('agent');
  const second = internals.processInferenceRequests();
  await settles(notesStarted, "the notes' render for the primary");
  // The document's render lands in the primary's window, written for
  // 'other''s assembly, so the primary's live turn defers it into its queue.
  const flushed: string[] = [];
  f.framework.onTrace((e) => {
    const event = e as { type: string; source?: string; messageId?: string };
    if (event.type === 'message:added' && event.source === 'deferred-flush:assembly' && event.messageId) flushed.push(event.messageId);
  });
  release({ content: [{ type: 'text', text: 'first_render' }] });
  await settles(Promise.all([first, second]), 'both passes');
  await settles(f.framework.runUntilIdle(), 'the drain');
  const primaryCalls = f.membrane.calls.filter((c) => JSON.stringify((c as { messages?: unknown }).messages).includes('notes_render'));
  assert.equal(primaryCalls.length, 1, "one primary turn: the render's wake to read it was retired once its request read it");
  assert(JSON.stringify((primaryCalls[0] as { messages?: unknown }).messages).includes('first_render'), "the primary's request read the render its assembly joined");
  const store = f.framework.getAgent('agent')!.getContextManager().getAllMessages();
  assert.ok(store.some((m) => flushed.includes(m.id) && JSON.stringify(m.content).includes('first_render')), "the render was deferred into the primary's queue and written by its assembly's flush");
  // Stored before the turn's checkpoint, it is the turn's input: undoing the
  // turn keeps it.
  f.framework.undoLastTurn('agent');
  assert(f.context().includes('first_render'), 'the undo of the turn that read it keeps it');
});

test("a render deferred behind a write the store keeps refusing stays tracked, and a retraction removes both", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  let renders = 0;
  f.renderer(() => Promise.resolve({ content: [{ type: 'text', text: ++renders > 1 ? 'second_render' : 'first_render' }] }));
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals & { deferredMessages: Array<{ content: unknown }> };
  // As above, the first render waits in the primary's queue when its next
  // turn starts, and the newer batch follows the primary. Here the store
  // refuses the first render every time.
  internals.activeTurnTokens.set('agent', -1);
  try {
    await settles(internals.processInferenceRequests(), 'the scheduler pass');
    await f.send('push/event', f.params('2', 'second_fallback', { deferred: true }));
  } finally {
    internals.activeTurnTokens.delete('agent');
  }
  const cm = f.framework.getAgent('agent')!.getContextManager();
  const add = cm.addMessage.bind(cm);
  (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
    if (JSON.stringify(args[1]).includes('first_render')) throw new Error('disk full');
    return add(...args);
  };
  const error = console.error;
  console.error = () => {};
  try {
    await settles(f.framework.runUntilIdle(), "the primary's turns");
  } finally {
    console.error = error;
  }
  assert.equal(renders, 2, "the primary's assembly rendered the newer batch");
  const queued = () => internals.deferredMessages.map((m) => JSON.stringify(m.content));
  assert.ok(queued().some((c) => c.includes('second_render')), 'the newer render waits behind the refused one');
  assert.ok(f.membrane.calls.every((c) => !JSON.stringify((c as { messages?: unknown }).messages).includes('second_render')), 'no request read it without the render it builds on');
  const r = await f.send('push/event', f.params('3', '', { retract: true }));
  assert.equal(r.result.coalesce.outcome, 'retracted', 'both renders were unread, and both are withdrawn');
  assert.ok(!queued().some((c) => c.includes('first_render') || c.includes('second_render')), 'neither is queued any more');
});

test("a wake to read a render that was retracted unread starts no turn", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  f.renderer(() => Promise.resolve({ content: [{ type: 'text', text: 'first_render' }] }));
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // While the primary's turn is alive, 'other''s assembly places the render
  // in the primary's queue, with a wake for the primary to read it. The
  // server retracts it before the primary is free.
  internals.activeTurnTokens.set('agent', -1);
  try {
    await settles(internals.processInferenceRequests(), 'the scheduler pass');
    assert.ok(internals.pendingRequests.some((r) => r.agentName === 'agent'), "the primary's wake to read the render");
    const r = await f.send('push/event', f.params('2', '', { retract: true }));
    assert.equal(r.result.coalesce.outcome, 'retracted');
  } finally {
    endStandInTurn(internals);
  }
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert.equal(f.membrane.calls.length, 0, 'nothing is left to read, so no turn runs');
});

test("a wake to read a render neither carries its mark into a merge with other causes nor absorbs another wake while parked", async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals & {
    quiesced: boolean;
    deferredMessages: Array<{ id: string; seq: number; participant: string; content: unknown[]; heldAt: number }>;
  };
  // The renders they read wait, unread, in the agent's queue.
  internals.deferredMessages.push(
    { id: 'render-1', seq: 1, participant: 'editor', content: [{ type: 'text', text: 'queued_render' }], heldAt: Date.now() },
    { id: 'render-2', seq: 2, participant: 'editor', content: [{ type: 'text', text: 'other_render' }], heldAt: Date.now() });
  const wake = (extra: Partial<Wake> = {}): Wake => ({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), ...extra });
  // Parked while quiesced, wakes are kept newest by key; a wake to read the
  // render keys apart from a plain push wake, so neither absorbs the other.
  internals.quiesced = true;
  try {
    internals.pendingRequests.push(wake({ readsDeferredWrite: 'render-1' }), wake(), wake({ readsDeferredWrite: 'render-2' }));
    await settles(internals.processInferenceRequests(), 'the parked pass');
    assert.deepEqual(internals.pendingRequests.map((r) => r.readsDeferredWrite), ['render-1', undefined, 'render-2'], 'each wake stays parked, those reading different renders included');
  } finally {
    internals.quiesced = false;
  }
  // Merged into one turn, the trigger keeps the mark only when every wake
  // has it. The wake to read the render comes first, so it is the trigger.
  const triggers: Array<{ readsDeferredWrite?: string }> = [];
  const start = internals.startAgentStream;
  internals.startAgentStream = async (_agent: unknown, trigger: unknown) => { triggers.push(trigger as { readsDeferredWrite?: string }); return undefined; };
  try {
    await settles(internals.processInferenceRequests(), 'the merged pass');
    internals.pendingRequests.push(wake({ readsDeferredWrite: 'render-1' }), wake({ readsDeferredWrite: 'render-2' }));
    await settles(internals.processInferenceRequests(), 'the pass of two renders');
    internals.pendingRequests.push(wake({ readsDeferredWrite: 'render-1' }), wake({ readsDeferredWrite: 'render-1' }));
    await settles(internals.processInferenceRequests(), 'the pass of two wakes reading one render');
    internals.pendingRequests.push(wake({ readsDeferredWrite: 'render-1' }));
    await settles(internals.processInferenceRequests(), 'the lone pass');
  } finally {
    internals.startAgentStream = start;
    internals.deferredMessages.splice(0);
  }
  assert.deepEqual(triggers.map((r) => r.readsDeferredWrite), [undefined, undefined, 'render-1', 'render-1'], 'merged with a plain wake, or one reading another render, it drops the mark; merged with wakes reading the same render, or alone, it keeps it');
});

test("a wake to read a stored message neither carries its mark into a merge with other causes nor absorbs another wake while parked", async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals & { quiesced: boolean };
  const cm = f.framework.getAgent('agent')!.getContextManager();
  const first = cm.addMessage('editor', [{ type: 'text', text: 'stored_one' }]);
  const second = cm.addMessage('editor', [{ type: 'text', text: 'stored_two' }]);
  const wake = (extra: Partial<Wake> = {}): Wake => ({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), ...extra });
  internals.quiesced = true;
  try {
    internals.pendingRequests.push(wake({ readsStoredMessage: first }), wake(), wake({ readsStoredMessage: second }));
    await settles(internals.processInferenceRequests(), 'the parked pass');
    assert.deepEqual(internals.pendingRequests.map((r) => r.readsStoredMessage), [first, undefined, second], 'each wake stays parked, those reading different messages included');
  } finally {
    internals.quiesced = false;
  }
  const triggers: Array<{ readsStoredMessage?: string }> = [];
  const start = internals.startAgentStream;
  internals.startAgentStream = async (_agent: unknown, trigger: unknown) => { triggers.push(trigger as { readsStoredMessage?: string }); return undefined; };
  try {
    await settles(internals.processInferenceRequests(), 'the merged pass');
    internals.pendingRequests.push(wake({ readsStoredMessage: first }), wake({ readsStoredMessage: second }));
    await settles(internals.processInferenceRequests(), 'the pass of two messages');
    internals.pendingRequests.push(wake({ readsStoredMessage: first }), wake({ readsStoredMessage: first }));
    await settles(internals.processInferenceRequests(), 'the pass of two wakes reading one message');
    internals.pendingRequests.push(wake({ readsStoredMessage: first }));
    await settles(internals.processInferenceRequests(), 'the lone pass');
  } finally {
    internals.startAgentStream = start;
  }
  assert.deepEqual(triggers.map((r) => r.readsStoredMessage), [undefined, undefined, first, first], 'merged with a plain wake, or one reading another message, it drops the mark; merged with wakes reading the same message, or alone, it keeps it');
});

test("a wake to read a render starts its turn until the render's row is at or below the watermark of the agent's answered requests on the current branch", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => true } }); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals & {
    deferredMessages: Array<{ id: string; seq: number; participant: string; content: unknown[]; heldAt: number }>;
  };
  const agent = f.framework.getAgent('agent')! as unknown as {
    getContextManager(): { getAllMessages(): Array<{ sequence: number; metadata?: { deferredWriteId?: string } }>; currentBranch(): { name: string } };
    getAnsweredWatermark(): { branch: string; sequence: number } | null;
    answeredWatermark: { branch: string; sequence: number } | null;
  };
  // A render placed in the agent's queue lands in its store, as a flush
  // stores it, while its wake to read it waits.
  const land = (id: string): { sequence: number } => {
    internals.deferredMessages.push({ id, seq: 1, participant: 'editor', content: [{ type: 'text', text: `${id}_text` }], heldAt: Date.now() });
    internals.readdDrained(internals.drainDeferredFor('agent'), `${id} lands`);
    internals.ackDeferredWrites();
    const row = agent.getContextManager().getAllMessages().find((m) => m.metadata?.deferredWriteId === id);
    assert(row, `${id} landed on the current branch`);
    return row;
  };
  // The pass starts whatever turns are left.
  const pass = async (id: string): Promise<number> => {
    internals.pendingRequests.push({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsDeferredWrite: id });
    let started = 0;
    const start = internals.startAgentStream;
    internals.startAgentStream = async () => { started++; return undefined; };
    try {
      await settles(internals.processInferenceRequests(), `the pass after ${id}`);
    } finally {
      internals.startAgentStream = start;
    }
    return started;
  };
  // Above an answered watermark on its branch: no request that carried it
  // was answered. (The agent's creation answers nothing, so without this the
  // pass would read no watermark at all.)
  const before = land('render_before');
  agent.answeredWatermark = { branch: agent.getContextManager().currentBranch().name, sequence: before.sequence };
  land('render_0');
  assert.equal(await pass('render_0'), 1, 'above the watermark on its branch, the wake starts the turn');
  // At the watermark itself: read, as a compile whose newest row it was.
  const atMark = land('render_at');
  agent.answeredWatermark = { branch: agent.getContextManager().currentBranch().name, sequence: atMark.sequence };
  assert.equal(await pass('render_at'), 0, 'at the watermark on its branch, the wake starts no turn');
  // Below it: read, by a compile that read what followed it too.
  land('render_below');
  const after = land('render_after');
  agent.answeredWatermark = { branch: agent.getContextManager().currentBranch().name, sequence: after.sequence };
  assert.equal(await pass('render_below'), 0, 'below the watermark on its branch, the wake starts no turn');
  // Drained from the queue but not yet stored: still queued.
  const pendingWrite = { id: 'render_drained', seq: 1, participant: 'editor', content: [{ type: 'text', text: 'render_drained_text' }], heldAt: Date.now() };
  (internals as unknown as { unackedDeferredWrites: unknown[] }).unackedDeferredWrites.push(pendingWrite);
  assert.equal(await pass('render_drained'), 1, 'drained and not yet stored, the wake starts the turn');
  (internals as unknown as { unackedDeferredWrites: unknown[] }).unackedDeferredWrites.splice(0);
  // Stored and read, but still un-acked while the chronicle's sync fails:
  // judged by its row.
  const unsynced = land('render_unsynced');
  (internals as unknown as { unackedDeferredWrites: unknown[] }).unackedDeferredWrites.push({ ...pendingWrite, id: 'render_unsynced' });
  agent.answeredWatermark = { branch: agent.getContextManager().currentBranch().name, sequence: unsynced.sequence };
  assert.equal(await pass('render_unsynced'), 0, 'stored and read, though not yet synced, the wake starts no turn');
  (internals as unknown as { unackedDeferredWrites: unknown[] }).unackedDeferredWrites.splice(0);
  // With no watermark (a store that couldn't be read when it was taken): in doubt.
  const noMark = land('render_null');
  agent.answeredWatermark = null;
  assert.equal(await pass('render_null'), 1, 'with no watermark, the wake starts the turn');
  agent.answeredWatermark = { branch: agent.getContextManager().currentBranch().name, sequence: noMark.sequence };
  await f.send('push/event', f.params('a', 'turn_one', { key: 'a', initial: true }));
  await f.framework.runUntilIdle();
  // An operator's undo switches the store to a new branch; the watermark of
  // the agent's answered requests stays on the old one until a request on
  // the new one is answered. The render lands at or below that watermark's
  // sequence, so only the branch tells it unread.
  await f.framework.undoLastTurn('agent').settled;
  const afterUndo = land('render_1');
  const mark = agent.getAnsweredWatermark();
  assert(mark && mark.branch !== agent.getContextManager().currentBranch().name && afterUndo.sequence <= mark.sequence,
    `the watermark ${JSON.stringify(mark)} is on another branch, at or past the render's row (${afterUndo.sequence})`);
  assert.equal(await pass('render_1'), 1, 'with the watermark on another branch, the wake starts the turn');
});

test("a render's wake to read it is marked ambient only when the coalescer says every notice it folds was", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => true } }); t.after(f.close);
  const internals = f.framework as unknown as {
    pendingRequests: Array<{ ambient?: true; addressed?: boolean; readsDeferredWrite?: string }>;
    pushCoalescer?: { host: CoalescerHost<unknown> };
  };
  // Through the framework's own host for its coalescer, as the coalescer calls it.
  const host = internals.pushCoalescer?.host;
  assert.ok(host, "the framework's coalescer and its host");
  // The latest notice's own tag doesn't decide it: the render covers the batch.
  for (const [tags, allAmbient, ambient] of [[['chat:ambient'], true, true], [['chat:ambient'], false, undefined], [undefined, false, undefined]] as const) {
    internals.pendingRequests.length = 0;
    await host.wakeToRead({
      serverId: 'editor', binding: 'b', scope: { kind: 'channel', id: 'editor:room' }, key: 'k', eventId: 'e', timestamp: new Date().toISOString(),
      retract: false, deferred: true, initial: false, content: [],
      ...(tags ? { tags: [...tags] } : {}),
      event: { lane: 'push', event: { triggerInference: true, origin: {} } },
    } as unknown as CoalescedOccurrence<unknown>, 'agent', 'render-x', allAmbient);
    assert.equal(internals.pendingRequests.length, 1, 'one wake to read the render');
    assert.equal(internals.pendingRequests[0]!.readsDeferredWrite, 'render-x');
    assert.equal(internals.pendingRequests[0]!.ambient, ambient, `latest tags ${JSON.stringify(tags)}, all ambient ${allAmbient}`);
  }
});

test("a deferred batch is all ambient only while every notice folded into it was tagged chat:ambient, through a snapshot too", async () => {
  // What each subject's wake to read its render was told, by subject key.
  const seen = new Map<string, boolean | undefined>();
  let saved: (() => CoalescingSnapshot) | undefined;
  let rendered: () => void = () => {};
  let holdRender: Promise<void> | null = null;
  const host = (): CoalescerHost<null> => ({
    isUnread: () => true, isUnshown: () => true, remove: () => true,
    // Every delivery lands in the deferred queue of an agent whose turn is alive.
    deliver: async (occ) => ({ agent: 'other', deferredId: `deferred-${occ.eventId}` }),
    wakeForBatch: async () => {}, wakeToRead: async (occ, _agent, _id, allAmbient) => { seen.set(occ.key, allAmbient); },
    cancelWake: () => {}, authorized: () => true,
    audience: async () => ['other'],
    render: async () => {
      rendered();
      if (holdRender) await holdRender;
      return { content: [{ type: 'text', text: 'diff' }] };
    },
    audit: () => {}, save: (snapshot) => { saved = snapshot; },
  });
  const occurrence = (key: string, eventId: string, tags?: readonly string[], deferred = true): CoalescedOccurrence<null> => ({
    serverId: 'editor', binding: 'binding', scope: { kind: 'channel', id: 'editor:room' }, key, eventId, timestamp: TS,
    retract: false, deferred, initial: false, content: [{ type: 'text', text: eventId }], event: null, ...(tags ? { tags: [...tags] } : {}),
  });
  const A = ['chat:ambient'], ADDRESSED = ['chat:addressed'];
  const batches = [
    ['both-ambient', [A, A], true],
    ['addressed-then-ambient', [ADDRESSED, A], false],
    ['ambient-then-addressed', [A, ADDRESSED], false],
    ['ambient-then-untagged', [A, undefined], false],
  ] as const;
  const coalescer = new PushCoalescer<null>(host());
  for (const [key, notices] of batches) {
    for (const [i, tags] of notices.entries()) await coalescer.accept(occurrence(key, `${key}-${i}`, tags));
  }
  await coalescer.assemble('other');
  assert.deepEqual(Object.fromEntries(seen), Object.fromEntries(batches.map(([key, , all]) => [key, all])), 'only the batch whose every notice was ambient');

  // A notice that displaces an unread plain occurrence stands its render in
  // that occurrence's place, so the occurrence's tag counts too.
  seen.clear();
  const displacing = new PushCoalescer<null>(host());
  for (const [key, plain] of [['displaces-ambient', A], ['displaces-addressed', ADDRESSED]] as const) {
    await displacing.accept(occurrence(key, `${key}-plain`, plain, false));
    await displacing.accept(occurrence(key, `${key}-notice`, A));
  }
  await displacing.assemble('other');
  assert.deepEqual(Object.fromEntries(seen), { 'displaces-ambient': true, 'displaces-addressed': false }, 'a displaced plain occurrence counts');

  // Past maxNotices, an addressed notice counts whether it's the one shifted
  // out or the one whose arrival shifts another out.
  seen.clear();
  const small = new PushCoalescer<null>(host(), { maxNotices: 1 });
  for (const [key, notices] of [['shifted-out', [ADDRESSED, A]], ['shifts-out', [A, ADDRESSED]]] as const) {
    for (const [i, tags] of notices.entries()) await small.accept(occurrence(key, `${key}-${i}`, tags));
  }
  await small.assemble('other');
  assert.deepEqual(Object.fromEntries(seen), { 'shifted-out': false, 'shifts-out': false }, 'an addressed notice counts past maxNotices');

  // Through a snapshot: an all-ambient batch stays so, a mixed one stays
  // mixed, and one written without the field reads as not all ambient.
  seen.clear();
  const before = new PushCoalescer<null>(host());
  for (const [key, notices] of [['kept', [A]], ['mixed', [ADDRESSED, A]]] as const) {
    for (const [i, tags] of notices.entries()) await before.accept(occurrence(key, `${key}-${i}`, tags));
  }
  const snapshot = structuredClone(saved!());
  const old = structuredClone(snapshot);
  for (const s of old.subjects) if (s.batch) delete (s.batch as { allAmbient?: true }).allAmbient;
  const restored = new PushCoalescer<null>(host());
  restored.restore(snapshot);
  await restored.assemble('other');
  assert.deepEqual(Object.fromEntries(seen), { kept: true, mixed: false }, 'kept through its snapshot');
  seen.clear();
  const restoredOld = new PushCoalescer<null>(host());
  restoredOld.restore(old);
  await restoredOld.assemble('other');
  assert.deepEqual(Object.fromEntries(seen), { kept: false, mixed: false }, 'not read into one written without it');

  // Through a snapshot taken while the batch renders: restored, it takes the
  // fallback, and its wake keeps its mark, all ambient or not.
  for (const [key, notices, all] of [['mid-ambient', [A], true], ['mid-mixed', [ADDRESSED, A], false]] as const) {
    let release: () => void = () => {};
    holdRender = new Promise<void>((resolve) => { release = resolve; });
    const renderStarted = new Promise<void>((resolve) => { rendered = resolve; });
    const midRender = new PushCoalescer<null>(host());
    for (const [i, tags] of notices.entries()) await midRender.accept(occurrence(key, `${key}-${i}`, tags));
    const assembling = midRender.assemble('other');
    await renderStarted;
    const during = structuredClone(saved!());
    assert.ok(during.subjects.some((s) => s.batch?.rendering === true), `${key}: the snapshot was taken while the batch rendered`);
    release();
    await assembling;
    holdRender = null;
    rendered = () => {};
    seen.clear();
    const restoredMid = new PushCoalescer<null>(host());
    restoredMid.restore(during);
    await restoredMid.assemble('other');
    assert.deepEqual(Object.fromEntries(seen), { [key]: all }, `${key}: a batch restored from a mid-render snapshot keeps its mark`);
  }
});

test("a wake to read a render that carries a channel starts its turn until the agent has published there having read it, unless the render was ambient", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => true } }); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals & {
    deferredMessages: Array<{ id: string; seq: number; participant: string; content: unknown[]; heldAt: number }>;
  };
  const agent = f.framework.getAgent('agent')! as unknown as {
    getContextManager(): { getAllMessages(): Array<{ sequence: number; metadata?: { deferredWriteId?: string } }>; currentBranch(): { name: string } };
    answeredWatermark: { branch: string; sequence: number } | null;
    notePublished(destination: string, readThrough: { branch: string; sequence: number } | null): void;
  };
  internals.deferredMessages.push({ id: 'render_room', seq: 1, participant: 'editor', content: [{ type: 'text', text: 'render_room_text' }], heldAt: Date.now() });
  internals.readdDrained(internals.drainDeferredFor('agent'), 'render_room lands');
  internals.ackDeferredWrites();
  const row = agent.getContextManager().getAllMessages().find((m) => m.metadata?.deferredWriteId === 'render_room');
  assert(row, 'the render landed on the current branch');
  const branch = agent.getContextManager().currentBranch().name;
  agent.answeredWatermark = { branch, sequence: row.sequence };
  const pass = async (tagged?: 'addressed' | 'ambient' | 'untagged' | 'notice'): Promise<number> => {
    internals.pendingRequests.push({
      agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), channelId: 'editor:room', readsDeferredWrite: 'render_room',
      ...(tagged === 'addressed' ? { addressed: true } : tagged === 'ambient' ? { addressed: false, ambient: true } : tagged === 'untagged' ? { addressed: false }
        : tagged === 'notice' ? { addressed: false, systemNotice: true as const } : {}),
    });
    let started = 0;
    const start = internals.startAgentStream;
    internals.startAgentStream = async () => { started++; return undefined; };
    try {
      await settles(internals.processInferenceRequests(), 'the pass');
    } finally {
      internals.startAgentStream = start;
    }
    return started;
  };
  const room = destinationKey({ serverId: 'editor', channelId: 'editor:room' });
  assert.equal(await pass(), 1, 'read but not answered in its channel, the wake starts the turn');
  assert.equal(await pass('addressed'), 1, 'addressed, read but not answered in its channel, the wake starts the turn');
  // A render its server marked ambient asked nothing of the agent: reading
  // it was all its wake was for, as before a publish was asked of any render.
  assert.equal(await pass('ambient'), 0, 'marked ambient, read and not answered, the wake starts no turn');
  // A chat:system notice asks nothing either, and no speech is routed by it,
  // so its channel would never see the answer the check waits for.
  assert.equal(await pass('notice'), 0, 'a notice, not ambient, read and not answered, the wake starts no turn');
  // Neither tag is doubt: such a render waits for an answer, as an
  // addressed one does.
  assert.equal(await pass('untagged'), 1, 'with neither tag, read but not answered in its channel, the wake starts the turn');
  agent.notePublished(room, { branch, sequence: row.sequence - 1 });
  assert.equal(await pass(), 1, 'answered in its channel only before reading it, the wake starts the turn');
  agent.notePublished(destinationKey({ serverId: 'editor', channelId: 'editor:general' }), { branch, sequence: row.sequence });
  assert.equal(await pass(), 1, 'spoken in another channel having read it, the wake starts the turn');
  agent.notePublished(destinationKey({ serverId: 'other', channelId: 'editor:room' }), { branch, sequence: row.sequence });
  assert.equal(await pass(), 1, "spoken in another server's channel of the same id, the wake starts the turn");
  agent.notePublished(room, { branch, sequence: row.sequence });
  assert.equal(await pass(), 0, 'spoken in its channel having read it, the wake starts no turn');
  agent.notePublished(room, { branch, sequence: row.sequence - 1 });
  assert.equal(await pass(), 0, "an earlier round's words landing later leave the newer publish standing");
  agent.notePublished(room, { branch: `${branch}-other`, sequence: row.sequence + 5 });
  assert.equal(await pass(), 1, 'spoken there last on another branch, the wake starts the turn');
  agent.notePublished(room, { branch, sequence: row.sequence });
  assert.equal(await pass(), 0, 'spoken there again on this branch having read it, the wake starts no turn');
  // A publish on another branch replaces the record whatever its sequence,
  // since a branch an undo made can carry lower sequences than the one it
  // left.
  agent.notePublished(room, { branch: `${branch}-other`, sequence: row.sequence - 3 });
  assert.equal(await pass(), 1, 'spoken there last on another branch at a lower sequence, the wake starts the turn');
});

test("a turn a wake to read a render started, held by a provider hold, is retried once the hold ends, though a request that carried the render was answered", async (t) => {
  const f = await fixture(); t.after(f.close);
  let calls = 0;
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
    f.membrane.calls.push(request as never);
    if (++calls > 1) return new MockYieldingStream([ok()]);
    return new FailingStream(new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429,
      message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
      rawError: { status: 429 }, rawRequest: request,
    } as ConstructorParameters<typeof MembraneError>[0]));
  };
  const internals = f.framework as unknown as TurnInternals & {
    deferredMessages: Array<{ id: string; seq: number; participant: string; content: unknown[]; heldAt: number }>;
  };
  // A render waits in the agent's queue with its wake to read it; the turn
  // the wake starts stores it at its start and compiles it.
  internals.deferredMessages.push({ id: 'render-1', seq: 1, participant: 'editor', content: [{ type: 'text', text: 'queued_render' }], heldAt: Date.now() });
  internals.pendingRequests.push({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsDeferredWrite: 'render-1' });
  await settles(f.framework.runUntilIdle(), 'the turn that meets the limit');
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('queued_render'), 'its request read the render');
  const hold = internals.providerAccelerationCooldowns.get('agent');
  assert.equal(hold?.heldRequests.length, 1, "the turn's trigger is held");
  const agent = f.framework.getAgent('agent')!;
  const cm = agent.getContextManager() as unknown as { getAllMessages(): Array<{ sequence: number; metadata?: { deferredWriteId?: string } }>; currentBranch(): { name: string } };
  const row = cm.getAllMessages().find((m) => m.metadata?.deferredWriteId === 'render-1');
  assert(row, "the turn's start stored the render");
  agent.markAnswered({ branch: cm.currentBranch().name, sequence: row.sequence });
  hold!.until = Date.now();
  internals.releaseProviderAccelerationCooldown('agent');
  await settles(f.framework.runUntilIdle(), 'the retry');
  assert.equal(f.membrane.calls.length, 2, 'the held turn was retried');
});

test("a turn a wake to read a stored message started, held by a provider hold, is retried once the hold ends, though a request that carried the message was answered", async (t) => {
  const f = await fixture(); t.after(f.close);
  let calls = 0;
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
    f.membrane.calls.push(request as never);
    if (++calls > 1) return new MockYieldingStream([ok()]);
    return new FailingStream(new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429,
      message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
      rawError: { status: 429 }, rawRequest: request,
    } as ConstructorParameters<typeof MembraneError>[0]));
  };
  const internals = f.framework as unknown as TurnInternals;
  const agent = f.framework.getAgent('agent')!;
  const id = agent.getContextManager().addMessage('editor', [{ type: 'text', text: 'stored_message' }]);
  internals.pendingRequests.push({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsStoredMessage: id });
  await settles(f.framework.runUntilIdle(), 'the turn that meets the limit');
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('stored_message'), 'its request read the message');
  const hold = internals.providerAccelerationCooldowns.get('agent');
  assert.equal(hold?.heldRequests.length, 1, "the turn's trigger is held");
  const cm = agent.getContextManager() as unknown as { getMessage(id: string): { sequence: number } | null; currentBranch(): { name: string } };
  const row = cm.getMessage(id);
  assert(row, 'the message is stored');
  agent.markAnswered({ branch: cm.currentBranch().name, sequence: row.sequence });
  hold!.until = Date.now();
  internals.releaseProviderAccelerationCooldown('agent');
  await settles(f.framework.runUntilIdle(), 'the retry');
  assert.equal(f.membrane.calls.length, 2, 'the held turn was retried');
});

test("a wake to read a stored message starts its turn when the store can't say whether the agent read it", async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals;
  const cm = f.framework.getAgent('agent')!.getContextManager() as unknown as { getMessage: (...a: unknown[]) => unknown };
  const getMessage = cm.getMessage;
  cm.getMessage = () => { throw new Error('a blob the store names is missing'); };
  internals.pendingRequests.push({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsStoredMessage: 'stored-1' });
  const triggers: unknown[] = [];
  const start = internals.startAgentStream;
  internals.startAgentStream = async (_agent: unknown, trigger: unknown) => { triggers.push(trigger); return undefined; };
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await settles(internals.processInferenceRequests(), 'the pass');
  } finally {
    console.error = error;
    internals.startAgentStream = start;
    cm.getMessage = getMessage;
  }
  assert.equal(triggers.length, 1, 'in doubt, the wake starts the turn');
  assert(errors.some((e) => e.includes('stored-1') && e.includes('a blob the store names is missing')), `the failed read is logged: ${JSON.stringify(errors)}`);
});

test("a wake to read a render starts its turn when the store can't say whether the agent read it", async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals;
  const cm = f.framework.getAgent('agent')!.getContextManager() as unknown as { queryMessages: (...a: unknown[]) => unknown };
  const query = cm.queryMessages;
  cm.queryMessages = () => { throw new Error('a blob the store names is missing'); };
  // The blob-free scan that stands in when the query throws can't read the
  // store either.
  const scanning = f.framework as unknown as { landedPositions?: unknown };
  scanning.landedPositions = () => { throw new Error('a blob the store names is missing, and the scan failed too'); };
  t.after(() => { delete scanning.landedPositions; });
  internals.pendingRequests.push({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsDeferredWrite: 'render-1' });
  const triggers: unknown[] = [];
  const start = internals.startAgentStream;
  internals.startAgentStream = async (_agent: unknown, trigger: unknown) => { triggers.push(trigger); return undefined; };
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await settles(internals.processInferenceRequests(), 'the pass');
  } finally {
    console.error = error;
    internals.startAgentStream = start;
    cm.queryMessages = query;
  }
  assert.equal(triggers.length, 1, 'in doubt, the wake starts the turn');
  assert(errors.some((e) => e.includes('render-1') && e.includes('a blob the store names is missing')), `the failed read is logged: ${JSON.stringify(errors)}`);
});

test("a wake to read a render that's gone is dropped from a pass whose other wakes still start the turn", async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals;
  internals.pendingRequests.push(
    { agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsDeferredWrite: 'render-gone' },
    { agentName: 'agent', reason: 'heartbeat', source: 'framework', timestamp: Date.now() });
  const triggers: Wake[] = [];
  const start = internals.startAgentStream;
  internals.startAgentStream = async (_agent: unknown, trigger: unknown) => { triggers.push(trigger as Wake); return undefined; };
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await settles(internals.processInferenceRequests(), 'the pass');
  } finally {
    console.error = error;
    internals.startAgentStream = start;
  }
  assert.deepEqual(triggers.map((r) => [r.reason, r.readsDeferredWrite]), [['heartbeat', undefined]], 'the turn starts for the heartbeat alone');
  assert(errors.some((e) => e.includes('dropped 1 wake(s)')), `the drop is logged: ${JSON.stringify(errors)}`);
});

test("a provider recovery whose released wakes start no turn reopens auxiliary admission: a gone render's wake under any policy, and a wake the policy drops; one beside a wake that starts the turn leaves it parked", async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals & {
    inferencePolicy: { shouldInfer(...a: unknown[]): boolean };
    providerAccelerationRecoveries: Map<string, unknown>;
  };
  const gate = internals.providerGate('agent') as unknown as { primaryPending: boolean; auxiliaryWaiters: Array<() => void> };
  // A hold's release leaves a primary turn pending, which holds auxiliary
  // calls back until it runs; the pass then finds nothing to start.
  const releaseThenPass = async (shouldInfer: boolean, wake: Wake): Promise<boolean> => {
    internals.inferencePolicy = { shouldInfer: () => shouldInfer };
    gate.primaryPending = true;
    internals.providerAccelerationRecoveries.set('agent', { startedAt: Date.now(), failures: 1, heldRequests: 1, reason: 'held', releasedAt: Date.now() });
    let admitted = false;
    gate.auxiliaryWaiters.push(() => { admitted = true; });
    internals.pendingRequests.push(wake);
    const error = console.error;
    console.error = () => {};
    try {
      await settles(internals.processInferenceRequests(), 'the pass');
      await settles(f.framework.runUntilIdle(), 'the drain');
    } finally {
      console.error = error;
    }
    return admitted;
  };
  // Under a policy that would start a turn for anything, even no cause.
  assert.equal(await releaseThenPass(true, { agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsDeferredWrite: 'render-gone' }),
    true, "a gone render's wake: the parked auxiliary call is admitted");
  assert.equal(await releaseThenPass(false, { agentName: 'agent', reason: 'heartbeat', source: 'framework', timestamp: Date.now() }),
    true, 'a wake the policy drops: the parked auxiliary call is admitted');
  assert.equal(f.membrane.calls.length, 0, 'no turn runs');
  // A gone render's wake dropped beside a wake that starts the turn leaves
  // the recovery to that turn.
  internals.inferencePolicy = { shouldInfer: () => true };
  gate.primaryPending = true;
  internals.providerAccelerationRecoveries.set('agent', { startedAt: Date.now(), failures: 1, heldRequests: 2, reason: 'held', releasedAt: Date.now() });
  internals.pendingRequests.push(
    { agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsDeferredWrite: 'render-gone' },
    { agentName: 'agent', reason: 'heartbeat', source: 'framework', timestamp: Date.now() });
  let admitted = false;
  gate.auxiliaryWaiters.push(() => { admitted = true; });
  let started = 0;
  const start = internals.startAgentStream;
  internals.startAgentStream = async () => { started++; return undefined; };
  const error = console.error;
  console.error = () => {};
  try {
    await settles(internals.processInferenceRequests(), 'the pass with a turn to start');
  } finally {
    console.error = error;
    internals.startAgentStream = start;
  }
  assert.equal(started, 1, "the heartbeat's turn starts");
  assert.equal(admitted, false, 'and the parked auxiliary call waits behind it');
});

test("a provider hold keeps a wake to read a render or a stored message, a batch wake, a batch-only merge and an ordinary wake apart, though they share a millisecond", async (t) => {
  const f = await fixture(); t.after(f.close);
  const internals = f.framework as unknown as TurnInternals;
  const timer = setTimeout(() => {}, 60_000);
  t.after(() => clearTimeout(timer));
  internals.providerAccelerationCooldowns.set('agent', { startedAt: Date.now(), until: Date.now() + 60_000, timer, heldRequests: [], reason: 'held', failures: 1 });
  const at = Date.now();
  const wake = (extra: Partial<Wake> = {}): Wake => ({ agentName: 'agent', reason: 'mcpl:push-event', source: 'editor', timestamp: at, ...extra });
  // A trigger merged from batches of two subjects carries no single
  // subject: only its subjects tell it from an ordinary wake, or from a
  // merge of other batches.
  const merged = wake({ coalescingBatch: true, coalescingBatchSubjects: ['doc', 'notes'] });
  internals.pendingRequests.push(merged, wake(), wake({ coalescingSubject: 'doc', coalescingBatch: true }), wake({ readsDeferredWrite: 'render-1' }), wake({ readsDeferredWrite: 'render-2' }),
    wake({ coalescingBatch: true, coalescingBatchSubjects: ['doc', 'other'] }), wake({ readsStoredMessage: 'stored-1' }), wake({ readsStoredMessage: 'stored-2' }));
  await settles(internals.processInferenceRequests(), 'the held pass');
  const held = internals.providerAccelerationCooldowns.get('agent')?.heldRequests ?? [];
  assert.deepEqual(held.map((r) => [r.coalescingSubject, r.coalescingBatchSubjects?.join(','), r.readsDeferredWrite ?? r.readsStoredMessage]),
    [[undefined, 'doc,notes', undefined], [undefined, undefined, undefined], ['doc', undefined, undefined], [undefined, undefined, 'render-1'], [undefined, undefined, 'render-2'], [undefined, 'doc,other', undefined],
      [undefined, undefined, 'stored-1'], [undefined, undefined, 'stored-2']],
    'each is held: none stands for another, which a withdrawal or a read could take with it');
});

test("a render that settles after its turn's assembly threw, while the turn is alive, is deferred like any write during the turn", async (t) => {
  const f = await fixture(); t.after(f.close);
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  f.renderer(() => { began(); return new Promise((resolve) => { release = resolve; }); });
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals & {
    deferredMessages: Array<{ content: unknown[] }>;
    pushCoalescer: { assemble(agent: string, causes?: readonly string[]): Promise<unknown> };
  };
  const assemble = internals.pushCoalescer.assemble.bind(internals.pushCoalescer);
  internals.pushCoalescer.assemble = async (agent: string, causes?: readonly string[]) => {
    internals.pushCoalescer.assemble = assemble;
    void assemble(agent, causes);
    await started;
    throw new Error('a freeze failed');
  };
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
    f.membrane.calls.push(request as never);
    return new HeldStream(opened, [ok()]);
  };
  const queued = () => internals.deferredMessages.some((m) => JSON.stringify(m.content).includes('late_render'));
  const error = console.error;
  console.error = () => {};
  try {
    const turn = f.framework.runUntilIdle();
    await eventually(() => f.membrane.calls.length === 1, "the turn's model call");
    release({ content: [{ type: 'text', text: 'late_render' }] });
    await eventually(() => queued() || f.context().includes('late_render'), 'the render landing');
    assert(!f.context().includes('late_render'), 'deferred, not stored into the live turn');
    open();
    await settles(turn, "the agent's turns");
  } finally {
    console.error = error;
    open();
  }
  assert(f.context().includes('late_render'), 'stored once the turn ended');
});

test("a write deferred for an agent while its assembly awaits a render lands in that turn's request, unless the host is quiesced by then", async (t) => {
  for (const quiesce of [false, true]) {
    const f = await fixture();
    try {
      f.alwaysRespond();
      let release!: (value: unknown) => void;
      let began!: () => void;
      const started = new Promise<void>((resolve) => { began = resolve; });
      f.renderer(() => {
        began();
        return new Promise((resolve) => { release = resolve; });
      });
      const internals = f.framework as unknown as TurnInternals & {
        quiesced: boolean;
        deferredMessages: unknown[];
        addMessage(participant: string, content: Array<{ type: 'text'; text: string }>): string;
      };
      // A plain push wakes the agent and a notice opens a batch while another
      // turn of its holds it, so one turn starts for both: it has a cause
      // besides the batch, and the batch's empty render doesn't withdraw it.
      internals.activeTurnTokens.set('agent', -1);
      try {
        await f.send('push/event', { featureSet: 'doc', eventId: 'p1', timestamp: TS, payload: { content: [{ type: 'text', text: 'plain_before' }] } });
        await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
        await eventually(() => internals.pendingRequests.length > 0, 'the wakes');
      } finally {
        internals.activeTurnTokens.delete('agent');
      }
      const turn = f.framework.runUntilIdle();
      await settles(started, 'the render');
      // A module's write while the assembly awaits the render is deferred:
      // the agent's turn is alive. The render then gives nothing, so no write
      // of the assembly's comes after it.
      internals.addMessage('Antra', [{ type: 'text', text: 'module_write' }]);
      assert(!f.context().includes('module_write'), `quiesced ${quiesce}: deferred, not stored while the turn is alive`);
      if (quiesce) internals.quiesced = true;
      release({ content: [] });
      await settles(turn, "the agent's turn");
      const first = JSON.stringify((f.membrane.calls[0] as { messages?: unknown } | undefined)?.messages);
      assert(first.includes('plain_before'), `quiesced ${quiesce}: the turn ran`);
      assert.equal(first.includes('module_write'), !quiesce, quiesce
        ? 'a quiesced host keeps it queued for resume()'
        : "the turn's request read the write that arrived while its assembly awaited the render");
      if (quiesce) {
        assert.ok(internals.deferredMessages.length > 0, 'still queued');
        internals.quiesced = false;
      }
    } finally {
      await f.close();
    }
  }
});

test("a render queued for one resident isn't another resident's to read once its flush has stored it", async (t) => {
  const f = await fixture({ agents: [...TWO_RESIDENTS, { name: 'third', model: 'test', systemPrompt: 'test' }] }); t.after(f.close);
  f.alwaysRespond();
  const withdrawn = withdrawals(f);
  await f.send('push/event', f.params('1', 'queued_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // One pass takes all three wakes. The primary's turn is alive (a stand-in
  // token), so its wake waits; 'other''s assembly renders the batch into the
  // primary's queue, and the primary is woken for it. Before 'third''s turn
  // starts, the primary's turn ends, and its flush stores the render, as a
  // torn-down turn's does.
  const start = internals.startAgentStream.bind(internals);
  internals.startAgentStream = async (...a: unknown[]) => {
    if ((a[0] as { name: string }).name === 'third') {
      internals.startAgentStream = start;
      endStandInTurn(internals);
    }
    return start(...a);
  };
  internals.activeTurnTokens.set('agent', -1);
  try {
    await settles(internals.processInferenceRequests(), 'the pass');
  } finally {
    endStandInTurn(internals);
  }
  assert(f.context().includes('document_diff'), 'the render is stored');
  assert.equal(f.membrane.calls.length, 0, "'third' didn't read the primary's render");
  await settles(f.framework.runUntilIdle(), "the primary's turn");
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('document_diff'), 'the primary, woken for it, read it');
  assert.deepEqual(withdrawn, ['other', 'third']);
});

test("a batch consumed by one resident's request gives another resident's batch-only turn nothing", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  f.alwaysRespond();
  const withdrawn = withdrawals(f);
  await f.send('push/event', f.params('1', 'consumed_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent', 'other'], 'both residents are woken');
  // One scheduler pass takes both wakes. 'agent''s assembly renders the
  // batch and its request reads it; 'other''s turn then finds the batch
  // consumed (RFC-006 §5.2), as if its wake had still been queued when the
  // freeze withdrew it.
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert.equal(f.membrane.calls.length, 1, 'one call for the batch');
  assert(f.lastRequest().includes('document_diff'));
  assert.deepEqual(withdrawn, ['other']);
});

/** A stream that fails with `error` before any content. */
class FailingStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

test("a batch-only turn whose call a provider's capacity limit held is retried when the hold ends, not withdrawn", async (t) => {
  const f = await fixture(); t.after(f.close);
  const withdrawn = withdrawals(f);
  // The first call meets an organization acceleration 429, which holds the
  // turn's trigger for one fresh compile once the cooldown ends.
  let calls = 0;
  const shown: Array<Wake | undefined> = [];
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
    f.membrane.calls.push(request as never);
    shown.push(f.framework.getActiveTurnTrigger('agent') as Wake | undefined);
    if (++calls > 1) return new MockYieldingStream([ok()]);
    return new FailingStream(new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429,
      message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
      rawError: { status: 429 }, rawRequest: request,
    } as ConstructorParameters<typeof MembraneError>[0]));
  };
  await f.send('push/event', f.params('1', 'held_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  await settles(f.framework.runUntilIdle(), 'the turn that meets the limit');
  assert.equal(f.membrane.calls.length, 1);
  const hold = internals.providerAccelerationCooldowns.get('agent');
  assert.equal(hold?.heldRequests.length, 1, "the turn's trigger is held");
  const marks = (w: Wake | undefined) => [w?.coalescingSubject, w?.coalescingBatch, w?.coalescingBatchSubjects];
  // The cooldown's time is up, and its timer's work runs now (a release
  // before its time only sets the timer again).
  hold!.until = Date.now();
  internals.releaseProviderAccelerationCooldown('agent');
  await settles(f.framework.runUntilIdle(), 'the retry');
  assert.equal(f.membrane.calls.length, 2, 'the held turn was retried');
  assert(f.lastRequest().includes('document_diff'), 'and the retry read the render');
  assert.deepEqual(withdrawn, []);
  assert.equal(shown[0]?.coalescingBatch, true, "getActiveTurnTrigger shows the first attempt's batch wake as it came");
  assert.deepEqual(marks(shown[1]), [undefined, undefined, undefined], "and the retry's trigger without the batch wake's marks");
});

test("a turn a provider hold kept is retried though another resident's request consumed a newer batch of its subject meanwhile", async (t) => {
  const f = await fixture({ agents: TWO_RESIDENTS }); t.after(f.close);
  const withdrawn = withdrawals(f);
  // The first call, the primary's (its wake comes first in the pass), meets
  // an organization acceleration 429, which holds its turn's trigger; 'other'
  // isn't held. A release with nothing held would queue a fresh compile, so
  // the case needs a held wake of the subject: the newer batch's, below.
  let calls = 0;
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
    f.membrane.calls.push(request as never);
    if (++calls === 1) return new FailingStream(new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429,
      message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
      rawError: { status: 429 }, rawRequest: request,
    } as ConstructorParameters<typeof MembraneError>[0]));
    return new MockYieldingStream([ok()]);
  };
  await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // One pass: the primary's assembly consumes the batch and its call fails;
  // 'other''s turn finds the batch consumed and is withdrawn.
  await settles(internals.processInferenceRequests(), 'the pass whose primary call meets the limit');
  const hold = internals.providerAccelerationCooldowns.get('agent');
  assert.equal(hold?.heldRequests.length, 1, "the primary's trigger is held");
  // The hold de-duplicates by timestamp, among other fields: the held wake
  // dates from before the newer batch's, as it would in a running host, where
  // a render and a call lie between them, not a shared millisecond.
  hold!.heldRequests[0].timestamp = Date.now() - 1000;
  // During the hold, 'other' already has a wake queued (a heartbeat), so its
  // turn comes first in the next pass. A newer batch of the subject arrives;
  // 'other''s assembly consumes it, and its freeze withdraws the subject's
  // queued and held wakes. The primary's wake for the newer batch, which the
  // same pass reaches after that freeze, is held.
  internals.pendingRequests.push({ agentName: 'other', reason: 'heartbeat', source: 'framework', timestamp: Date.now() });
  f.renderer(async () => ({ content: [{ type: 'text', text: 'second_render' }] }));
  await f.send('push/event', f.params('2', 'second_fallback', { deferred: true }));
  await settles(internals.processInferenceRequests(), "the pass where 'other' reads the newer batch");
  assert(f.lastRequest().includes('second_render'), "'other''s request read the newer batch");
  assert(hold!.heldRequests.some((r) => r.coalescingSubject !== undefined), "the primary's wake for the newer batch is held");
  const callsBefore = f.membrane.calls.length;
  // The hold's time is up, and its timer's work runs now.
  hold!.until = Date.now();
  internals.releaseProviderAccelerationCooldown('agent');
  await settles(f.framework.runUntilIdle(), "the primary's retry");
  assert.equal(f.membrane.calls.length, callsBefore + 1, "the primary's held turn was retried");
  assert(f.lastRequest().includes('document_diff'), 'and the retry read the first render');
  assert(!withdrawn.includes('agent'), "the primary's retry wasn't withdrawn");
});

/** One pass merges the agent's queued wakes into one trigger; the wrapped
 *  `startAgentStream` sends it back to the queue before its gate, as the
 *  auxiliary park's requeue does when another turn has taken the agent. */
async function mergeAndRequeue(f: Awaited<ReturnType<typeof fixture>>): Promise<Wake> {
  const internals = f.framework as unknown as TurnInternals;
  const start = internals.startAgentStream.bind(internals);
  let merged: Wake | undefined;
  internals.startAgentStream = async (_agent: unknown, trigger: unknown) => {
    internals.startAgentStream = start;
    merged = trigger as Wake;
    internals.pendingRequests.push(merged);
  };
  await settles(internals.processInferenceRequests(), 'the pass that merges the wakes');
  assert(merged, 'the pass merged the wakes into one trigger');
  return merged!;
}

test("a wake merged from a batch wake and another wake keeps the other cause when the batch's subject is withdrawn before its gate", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  await f.send('push/event', f.params('1', 'merged_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  // A heartbeat for the same agent, queued behind the batch's wake: the merge
  // is spread from the batch's wake.
  internals.pendingRequests.push({ agentName: 'agent', reason: 'heartbeat', source: 'framework', timestamp: Date.now() });
  const merged = await mergeAndRequeue(f);
  // A retraction withdraws the wakes whose sole cause is the subject (§4.2).
  const r = await f.send('push/event', f.params('2', '', { retract: true }));
  assert.equal(r.result.coalesce.outcome, 'retracted');
  assert(internals.pendingRequests.includes(merged), "the merged wake, which the heartbeat shares, isn't withdrawn with the batch's subject");
  await settles(f.framework.runUntilIdle(), 'the merged turn');
  assert.equal(f.membrane.calls.length, 1, "the heartbeat's turn ran");
});

test("a batch wake requeued before its gate is still withdrawn with its subject", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  await f.send('push/event', f.params('1', 'stale_fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as TurnInternals;
  const merged = await mergeAndRequeue(f);
  const r = await f.send('push/event', f.params('2', '', { retract: true }));
  assert.equal(r.result.coalesce.outcome, 'retracted');
  assert(!internals.pendingRequests.includes(merged), 'the wake, whose sole cause was the batch, is withdrawn with its subject');
  await settles(f.framework.runUntilIdle(), 'the drain');
  assert.equal(f.membrane.calls.length, 0);
});

test('R14: two consecutive crash windows with an acceptance in between keep both recovered batches', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('a', 'first_window_fallback', { deferred: true, key: 'A' }));
  await crash(f); await f.create();
  await f.send('push/event', f.params('b', 'second_window_fallback', { deferred: true, key: 'B' }));
  await crash(f); await f.create();
  const retryA = await f.send('push/event', f.params('a', 'first_window_fallback', { deferred: true, key: 'A' }));
  assert.equal(retryA.result?.coalesce?.outcome, 'first', "A's receipt survived the second window");
  await f.framework.runUntilIdle();
  const req = f.lastRequest();
  assert(req.includes('first_window_fallback') && req.includes('second_window_fallback'), 'both recovered batches delivered');
});

test('R15: a retraction arriving between the render result and its publication waits for the settlement', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'fallback', { deferred: true, initial: true }));
  const internals = f.framework as unknown as { deliverCoalesced: (...a: unknown[]) => Promise<unknown> };
  const orig = internals.deliverCoalesced.bind(internals);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    internals.deliverCoalesced = (...a) => { internals.deliverCoalesced = orig; return new Promise((res) => { release = () => orig(...a).then(res); resolve(); }); };
  });
  f.alwaysRespond(); // the notice wakes a second turn
  const run = f.framework.runUntilIdle();
  await held; // the render result is in hand; publication is being settled
  const pending = f.send('push/event', f.params('2', 'deleted_notice', { retract: true }));
  release();
  const r = await pending;
  assert.equal(r.result.coalesce.outcome, 'noted', 'the retraction saw the published render as read');
  await run;
  const ctx = f.context();
  assert.equal(ctx.split('document_diff').length - 1, 1, 'rendered exactly once');
  assert(ctx.includes('deleted_notice'), 'and corrected by the notice');
});

// ---------------------------------------------------------------------------
// Review round 8 (#197): liveness after a failed render-start commit
// ---------------------------------------------------------------------------

test('R16: a batch whose render-start commit failed is re-woken once storage recovers', { timeout: 120_000 }, async (t) => {
  const f = await fixture(); t.after(f.close);
  const coalescer = (f.framework as unknown as { pushCoalescer: { options: { recoveryBackoffMs?: number }; pendingBatches(): number } }).pushCoalescer;
  coalescer.options.recoveryBackoffMs = 50;
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  const store = (f.framework as unknown as { store: { sync: () => void } }).store;
  const orig = store.sync.bind(store);
  let failing = 0;
  store.sync = () => { if (failing > 0) { failing--; throw new Error('EIO simulated'); } orig(); };
  const traced: Array<{ kind: string; source?: string }> = [];
  f.framework.onTrace((e) => {
    if (e.type === 'mcpl:coalescing') traced.push({ kind: (e as { kind: string }).kind, source: (e as { source?: string }).source });
  });
  // Every turn that reaches the model is answered, so a model call nothing
  // should have caused is counted rather than left waiting for a response.
  f.alwaysRespond();
  await f.send('push/event', f.params('1', 'asleep_fallback', { deferred: true, initial: true }));
  failing = 1; // the render-start commit fails; storage then recovers
  // The recovery wake can fire inside the first drain or after it, so drive
  // until the batch renders rather than for a fixed number of drains.
  await settles(f.framework.runUntilIdle(), 'the first drain');
  for (let pass = 0; !traced.some((e) => e.kind === 'rendered'); pass++) {
    assert(pass < 5, 'the batch rendered within five recovery wakes');
    await eventually(() => internals.pendingRequests.length > 0, 'recovery wake');
    await settles(f.framework.runUntilIdle(), `the drain after recovery wake ${pass + 1}`);
    // A macrotask turn, so timers (this test's timeout among them) can fire
    // even when both waits above return at once.
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.membrane.calls.length, 1, 'one model call, the recovery turn\'s: the wake whose render-start commit failed, the only cause, started none');
  assert(f.lastRequest().includes('asleep_fallback'), 'the recovery turn delivered the batch');
  const kinds = traced.map((e) => e.kind);
  const order = (...steps: string[]) => kinds.filter((k) => steps.includes(k));
  assert.deepEqual(order('persist-failed', 'turn-withdrawn', 'rendered'), ['persist-failed', 'turn-withdrawn', 'rendered'], 'the failed freeze withdrew its turn');
  assert.deepEqual(order('persist-failed', 'recovery-wake', 'rendered'), ['persist-failed', 'recovery-wake', 'rendered'], 're-woken by the recovery timer, without unrelated traffic');
  // The failed commit can't prove that no render started, so the batch takes
  // its fallback and the server is never asked to render it.
  assert.equal(traced.find((e) => e.kind === 'rendered')?.source, 'fallback');
  assert.equal(f.renders.length, 0);
  assert.equal(coalescer.pendingBatches(), 0);
});

test('R16b: a producer retry re-wakes a batch left asleep by a failed freeze', async (t) => {
  const f = await fixture(); t.after(f.close);
  const coalescer = (f.framework as unknown as { pushCoalescer: { options: { recoveryBackoffMs?: number }; pendingBatches(): number } }).pushCoalescer;
  coalescer.options.recoveryBackoffMs = 600_000; // park the timer; the retry must do it
  const store = (f.framework as unknown as { store: { sync: () => void } }).store;
  const orig = store.sync.bind(store);
  let failing = 0;
  store.sync = () => { if (failing > 0) { failing--; throw new Error('EIO simulated'); } orig(); };
  const params = f.params('1', 'asleep_fallback', { deferred: true, initial: true });
  const first = await f.send('push/event', params);
  failing = 1;
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'asleep: the failed freeze started no turn');
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, first.result);
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'the retry re-woke it');
  assert(f.lastRequest().includes('asleep_fallback'));
});

// The timeout bounds a drain that never returns, such as a backoff regressed
// to a tight loop, far sooner than npm test's ten-minute --test-timeout.
/**
 * R17's harness: a coalescing fixture whose store fails while `failing` is
 * set, its recovery backoff at `baseMs`, and every traced recovery wake with
 * the timer that fired it: the delay it was armed with (`armedMs`), and when
 * it was armed among the harness's steps (`armedAt`, beside the wake's own
 * `tracedAt`). The spacing the coalescer controls is those two: each wake's
 * timer armed after the wake before it, with the delay it's labelled with.
 * When a timer fires is the host's: by `performance.now()` Node can fire one
 * early, and on a CI runner one fired at least 1.3 ms early, so the wakes'
 * measured spacing isn't checked. Every setTimeout is still a real one; the harness
 * only counts each arming and notes, while a timer's callback runs, which
 * arming it was.
 */
async function storageOutage(t: TestContext, baseMs: number) {
  const f = await fixture();
  const coalescer = (f.framework as unknown as { pushCoalescer: { options: { recoveryBackoffMs?: number }; pendingBatches(): number } }).pushCoalescer;
  coalescer.options.recoveryBackoffMs = baseMs;
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  const store = (f.framework as unknown as { store: { sync: () => void } }).store;
  const orig = store.sync.bind(store);
  const outage = { failing: false };
  store.sync = () => { if (outage.failing) throw new Error('EIO persistent'); orig(); };
  // One hook, in order: storage recovers before the fixture closes, so a
  // failed assertion doesn't add the close's own EIO to its report.
  t.after(async () => { outage.failing = false; await f.close(); });
  // The arming of the timer whose callback is running, if one is: its delay,
  // and its step, from one count of armings and wakes. A recovery wake is
  // traced from inside its timer's callback (scheduleRecovery), so the trace
  // can name the timer that fired it.
  let step = 0;
  let firing: { ms: number | undefined; at: number } | undefined;
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const arming = { ms, at: ++step };
    return realSetTimeout(function (this: unknown) {
      const outer = firing;
      firing = arming;
      try { callback.apply(this, args); } finally { firing = outer; }
    }, ms);
  }) as typeof setTimeout);
  const wakes: Array<{ attempt: number; delayMs: number; armedMs: number | undefined; armedAt: number | undefined; tracedAt: number }> = [];
  f.framework.onTrace((e) => {
    if (e.type === 'mcpl:coalescing' && (e as { kind?: string }).kind === 'recovery-wake') {
      wakes.push({ ...(e as unknown as { attempt: number; delayMs: number }), armedMs: firing?.ms, armedAt: firing?.at, tracedAt: ++step });
    }
  });
  f.alwaysRespond();
  /**
   * Drive until `count` recovery wakes have fired, ending with one still
   * pending. Observe the recovery transitions themselves, not the drains:
   * runUntilIdle drains until idle, so a recovery timer that fires while a
   * drain is still running is consumed by that same drain, which freezes and
   * fails again. One drain can therefore carry several attempts.
   */
  const driveTo = async (count: number) => {
    while (wakes.length < count) {
      const before = wakes.length;
      await f.framework.runUntilIdle(); // each failed freeze schedules the next recovery
      await eventually(() => internals.pendingRequests.length > 0, `recovery wake after ${wakes.length}`);
      // Between attempts only the recovery timer re-wakes the batch, and it
      // traces before it queues the request: every round adds a wake, so a
      // lost trace fails here instead of looping forever.
      assert(wakes.length > before, 'each re-wake is a traced recovery wake');
    }
  };
  /** Each wake came from a timer armed with the delay its trace names, after
   *  the wake before it was traced. A trace made outside every timer's
   *  callback names no timer, and fails this: `firing` is put back as each
   *  callback ends, so a later trace, such as one from a microtask, doesn't
   *  take that timer's arming. */
  const assertArmed = () => {
    assert.deepEqual(wakes.map((w) => w.armedMs), wakes.map((w) => w.delayMs), 'each wake was fired by a timer armed with its delay');
    for (let i = 1; i < wakes.length; i++) {
      assert((wakes[i].armedAt ?? 0) > wakes[i - 1].tracedAt, `wake ${i + 1}'s timer was armed after wake ${i} was traced`);
    }
  };
  return { f, coalescer, outage, wakes, driveTo, assertArmed };
}

test('R17: a persistent storage outage backs off, and the series starts again on recovery', { timeout: 120_000 }, async (t) => {
  const { f, coalescer, outage, wakes, driveTo, assertArmed } = await storageOutage(t, 40);
  await f.send('push/event', f.params('1', 'outage_fallback', { deferred: true, initial: true }));
  outage.failing = true;
  await driveTo(3);
  const delays = wakes.map((w) => w.delayMs);
  for (let i = 1; i < delays.length; i++) assert(delays[i] >= delays[i - 1], `no wake comes sooner than the one before: ${delays.join(', ')}`);
  assert(delays.at(-1)! > delays[0], `the wakes back off: ${delays.join(', ')}`);
  assertArmed();
  assert.equal(coalescer.pendingBatches(), 1);
  assert(!f.context().includes('outage_fallback'));
  outage.failing = false; // storage recovers
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('outage_fallback'), 'delivered once storage recovered');
  assert.equal(coalescer.pendingBatches(), 0);

  const second = wakes.length;
  await f.send('push/event', f.params('2', 'second_outage', { deferred: true }));
  outage.failing = true;
  await driveTo(second + 1);
  assert.equal(wakes[second]!.delayMs, delays[0], 'a second outage starts again from the first delay');
  assertArmed();
  outage.failing = false;
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('second_outage'), 'delivered once storage recovered again');
});

test('R17b: under a persistent storage outage the backoff stops growing', { timeout: 120_000 }, async (t) => {
  const { f, wakes, outage, driveTo, assertArmed } = await storageOutage(t, 3);
  await f.send('push/event', f.params('1', 'capped_fallback', { deferred: true, initial: true }));
  outage.failing = true;
  await driveTo(8);
  const delays = wakes.slice(0, 8).map((w) => w.delayMs);
  const capped = delays.findIndex((d, i) => i > 0 && d === delays[i - 1]);
  assert(capped > 0, `a delay repeats: ${delays.join(', ')}`);
  for (let i = capped + 1; i < delays.length; i++) assert(delays[i] <= delays[i - 1], `no delay grows after that: ${delays.join(', ')}`);
  assertArmed();
});

// ---------------------------------------------------------------------------
// Review round 10 (#197): residents share one message slot
// ---------------------------------------------------------------------------

for (const reader of ['other', 'agent'] as const) test(`R18 (${reader} read it): a message read by any resident of the shared slot is history for all of them`, async (t) => {
  const f = await fixture({ agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }, { name: 'other', model: 'test', systemPrompt: 'test' }], server: { shouldTriggerInference: () => true } }); t.after(f.close);
  await f.send('push/event', f.params('1', 'read_by_one', { initial: true }));
  const internals = f.framework as unknown as { pendingRequests: Array<{ agentName: string }> };
  internals.pendingRequests = internals.pendingRequests.filter((r) => r.agentName === reader);
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('read_by_one'), `${reader} read it`);
  const edit = await f.send('push/event', f.params('2', 'later_edit'));
  assert.equal(edit.result.coalesce.outcome, 'appended');
  for (const name of ['agent', 'other']) {
    const ctx = JSON.stringify(f.framework.getAgent(name)!.getContextManager().getAllMessages());
    assert(ctx.includes('read_by_one') && ctx.includes('later_edit'), `${name} keeps the consumed original`);
  }
  const del = await f.send('push/event', f.params('3', 'deletion_notice', { retract: true }));
  assert.equal(del.result.coalesce.outcome, 'noted');
  assert(f.context().includes('read_by_one') && f.context().includes('deletion_notice') && !f.context().includes('later_edit'));
});

// ---------------------------------------------------------------------------
// #157's markers: an edit the agent sees first is the message it replaced
// ---------------------------------------------------------------------------

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A turn, started by a mention in `chat`, with one round per `during` that
 * sends explicitly (channel_publish), then a round that speaks. Each sending
 * round streams only once its `during` has run: the first while the turn is
 * live, each later one after the previous round's tool boundary. So what a
 * `during` delivers reaches the agent at its round's tool boundary.
 */
async function sendThenSpeak(f: Fixture, ...during: Array<() => Promise<void>>) {
  const gates = during.map(() => {
    const gate = {} as { open: () => void; opened: Promise<void>; reached: () => void; atGate: Promise<void> };
    gate.opened = new Promise<void>((resolve) => { gate.open = resolve; });
    gate.atGate = new Promise<void>((resolve) => { gate.reached = resolve; });
    return gate;
  });
  let first: MockYieldingStream | undefined;
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
    f.membrane.calls.push(request as never);
    if (first) return new MockYieldingStream([ok()]);
    const stream = new MockYieldingStream([
      ...during.map((_, i) => createMockResponse([{ type: 'tool_use', id: `p${i}`, name: 'channel_publish', input: { content: `explicit_send_${i}` } }] as ContentBlock[], 'tool_use')),
      createMockResponse([{ type: 'text', text: 'prose_reply' }] as ContentBlock[]),
    ]);
    first = stream;
    let provided = 0;
    const provide = stream.provideToolResults.bind(stream);
    stream.provideToolResults = (results, options) => { provided++; provide(results, options); };
    const inner = stream[Symbol.asyncIterator].bind(stream);
    (stream as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
      gates[0].reached();
      await gates[0].opened;
      const it = inner();
      let streamed = 0;
      while (true) {
        const n = await it.next();
        if (n.done) return;
        // A later sending round's first event: hold it until its `during` ran.
        if (provided > streamed && provided < gates.length) {
          streamed = provided;
          gates[streamed].reached();
          await gates[streamed].opened;
        }
        yield n.value;
      }
    };
    return stream;
  };
  await f.send('channels/incoming', { messages: [f.channel('c1', 'question', { initial: true }, 'chat', 'm1')] });
  const run = f.framework.runUntilIdle();
  for (const [i, deliver] of during.entries()) {
    await gates[i].atGate;
    await deliver();
    gates[i].open();
  }
  await run;
  const posted = f.published.map((p) => JSON.stringify(p.content));
  return {
    /** What each tool boundary injected, in order. */
    injected: first!.receivedToolResultOptions.map((o) => JSON.stringify(o?.injectedMessages ?? [])),
    sent: during.every((_, i) => posted.some((c) => c.includes(`explicit_send_${i}`))),
    replied: posted.some((c) => c.includes('prose_reply')),
  };
}

/** Whether the stored row holding `text` carries the coalescer's first-view
 *  mark, which the host reads there (isConversationalInjection): a tool
 *  boundary hands membrane an injected message's content alone. */
const storedFirstView = (f: Fixture, text: string): boolean =>
  f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .some((m) => JSON.stringify(m.content).includes(text) && (m.metadata as { firstView?: unknown } | undefined)?.firstView === true);

const unreadFollowUp = (f: Fixture, initial = true) =>
  f.send('channels/incoming', { messages: [f.channel('c2', 'follow_up_wiht_typo', initial ? { initial: true } : {}, 'chat', 'm2')] });
const pushTagged = async (f: Fixture, tags: string[], eventId = 'e2', text = 'follow_up_fixed') =>
  (await f.send('push/event', { ...f.params(eventId, text, { channelId: 'chat', key: 'message:m2' }), tags })).result.coalesce.outcome as string;

/** A follow-up the agent hasn't been shown, then its edit, in each lane; returns the edit's outcome. */
const followUpThenEdit: Record<string, (f: Fixture) => Promise<string>> = {
  'channel-scoped push': async (f) => {
    await unreadFollowUp(f);
    return pushTagged(f, ['chat:edited']);
  },
  'channel message': async (f) => {
    await unreadFollowUp(f);
    return (await f.send('channels/incoming', { messages: [{ ...f.channel('e2', 'follow_up_fixed', {}, 'chat', 'm2'), tags: ['chat:edited'] }] })).result.results[0].coalesce.outcome;
  },
  'feature-set push': async (f) => {
    await f.send('push/event', { ...f.params('c2', 'follow_up_wiht_typo', { key: 'message:m2', initial: true }), tags: ['chat:mention'] });
    return (await f.send('push/event', { ...f.params('e2', 'follow_up_fixed', { key: 'message:m2' }), tags: ['chat:edited'] })).result.coalesce.outcome;
  },
};

for (const [lane, arrive] of Object.entries(followUpThenEdit)) test(`#157 (${lane}): an edit of a follow-up the agent hasn't been shown is its first view, so the reply after an explicit send routes`, async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  let outcome: string | undefined;
  const r = await sendThenSpeak(f, async () => { outcome = await arrive(f); });
  assert.equal(outcome, 'replaced');
  assert(r.injected[0].includes('follow_up_fixed') && !r.injected[0].includes('follow_up_wiht_typo'), 'the edit alone reached the boundary');
  assert(r.sent, 'the explicit send posted');
  assert(r.replied, 'the reply to the follow-up posted');
});

for (const tag of ['chat:reaction', 'chat:reaction-remove', 'chat:deleted']) test(`#157: a ${tag} occurrence that replaced an unread follow-up is still a notice about it, so the prose after an explicit send stays withheld`, async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  let outcome: string | undefined;
  const r = await sendThenSpeak(f, async () => { await unreadFollowUp(f); outcome = await pushTagged(f, [tag], 'e2', `${tag}_notice`); });
  assert.equal(outcome, 'replaced');
  assert(r.injected[0].includes(`${tag}_notice`), 'the notice reached the boundary');
  assert(r.sent, 'the explicit send posted');
  assert(!r.replied, 'the prose after the send stayed withheld');
});

test('#157: an edit of an edit, after the agent read the message, stays a marker, so the prose after an explicit send stays withheld', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const outcomes: string[] = [];
  const r = await sendThenSpeak(f, async () => {
    for (const [eventId, text] of [['e1', 'question_edited_once'], ['e2', 'question_edited_twice']]) {
      outcomes.push((await f.send('push/event', { ...f.params(eventId, text, { channelId: 'chat', key: 'message:m1' }), tags: ['chat:edited'] })).result.coalesce.outcome);
    }
  });
  assert.deepEqual(outcomes, ['appended', 'replaced'], 'the agent had read the question, and the second edit replaced the unread first');
  assert(r.injected[0].includes('question_edited_twice') && !r.injected[0].includes('question_edited_once'), 'the second edit alone reached the boundary');
  assert(r.sent, 'the explicit send posted');
  assert(!r.replied, 'the prose after the send stayed withheld');
});

test('#157: an edit of a follow-up the agent was shown at a tool boundary stays a marker, so the prose after the next explicit send stays withheld', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const r = await sendThenSpeak(f, async () => { await unreadFollowUp(f); }, async () => { await pushTagged(f, ['chat:edited']); });
  assert(r.injected[0].includes('follow_up_wiht_typo'), 'the first boundary showed the agent the follow-up');
  assert(r.injected[1].includes('follow_up_fixed'), 'the second boundary showed it the edit');
  assert(r.sent, 'both explicit sends posted');
  assert(!r.replied, 'the prose after the second send stayed withheld');
});

test('#157: an edit of an edit of a follow-up the agent was shown at a tool boundary stays a marker, so the prose after the next explicit send stays withheld', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const r = await sendThenSpeak(f, async () => { await unreadFollowUp(f); }, async () => {
    await pushTagged(f, ['chat:edited'], 'e2', 'follow_up_fixed');
    await pushTagged(f, ['chat:edited'], 'e3', 'follow_up_fixed_again');
  });
  assert(r.injected[0].includes('follow_up_wiht_typo'), 'the first boundary showed the agent the follow-up');
  assert(r.injected[1].includes('follow_up_fixed_again') && !storedFirstView(f, 'follow_up_fixed_again'), 'the second boundary showed it the last edit, stored unmarked');
  assert(r.sent, 'both explicit sends posted');
  assert(!r.replied, 'the prose after the second send stayed withheld');
});

test('#157: two edits of a follow-up the agent hasn\'t been shown leave the last its first view, so the reply after an explicit send routes', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const outcomes: string[] = [];
  const r = await sendThenSpeak(f, async () => {
    await unreadFollowUp(f);
    outcomes.push(await pushTagged(f, ['chat:edited'], 'e2', 'follow_up_fixed'));
    outcomes.push(await pushTagged(f, ['chat:edited'], 'e3', 'follow_up_fixed_again'));
  });
  assert.deepEqual(outcomes, ['replaced', 'replaced']);
  assert(r.injected[0].includes('follow_up_fixed_again') && storedFirstView(f, 'follow_up_fixed_again'), 'the boundary showed the agent the last edit, stored with the mark');
  assert(r.sent, 'the explicit send posted');
  assert(r.replied, 'the reply to the follow-up posted');
});

test('#157: an edit of a follow-up whose producer never marked it initial stays a marker, so the prose after an explicit send stays withheld', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  let outcome: string | undefined;
  const r = await sendThenSpeak(f, async () => { await unreadFollowUp(f, false); outcome = await pushTagged(f, ['chat:edited']); });
  assert.equal(outcome, 'replaced', 'the edit replaced the unread follow-up, whose history the host can\'t know');
  assert(r.injected[0].includes('follow_up_fixed'), 'the edit reached the boundary');
  assert(r.sent, 'the explicit send posted');
  assert(!r.replied, 'the prose after the send stayed withheld');
});

const serverMarked: Record<string, (f: Fixture) => Promise<string>> = {
  'channel message': async (f) => (await f.send('channels/incoming', { messages: [{
    ...f.channel('e9', 'edit_claiming_first_view', {}, 'chat', 'm9'), tags: ['chat:edited'], metadata: { firstView: true },
  }] })).result.results[0].coalesce.outcome,
  'channel-scoped push': async (f) => (await f.send('push/event', {
    ...f.params('e9', 'edit_claiming_first_view', { channelId: 'chat', key: 'message:m9' }), tags: ['chat:edited'], origin: { firstView: true },
  })).result.coalesce.outcome,
  'feature-set push': async (f) => (await f.send('push/event', {
    ...f.params('e9', 'edit_claiming_first_view', { key: 'message:m9' }), tags: ['chat:edited'], origin: { firstView: true },
  })).result.coalesce.outcome,
};

for (const [lane, deliver] of Object.entries(serverMarked)) test(`#157 (${lane}): a server can't mark its own edit as the agent's first view`, async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  let outcome: string | undefined;
  const r = await sendThenSpeak(f, async () => { outcome = await deliver(f); });
  assert.equal(outcome, 'appended');
  assert(r.injected[0].includes('edit_claiming_first_view'), 'the edit reached the boundary');
  assert(!storedFirstView(f, 'edit_claiming_first_view'), "the server's own mark was dropped");
  assert(r.sent, 'the explicit send posted');
  assert(!r.replied, 'the prose after the send stayed withheld');
});

/** An organization acceleration 429, which holds the turn for a later compile. */
const accelerationLimit = (request: NormalizedRequest): MembraneError => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429,
  message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
  rawError: { status: 429 }, rawRequest: request,
});

/**
 * A turn, started by a mention in `chat`, whose first stream sends into
 * `chat` and then ends with an acceleration 429, so the turn waits for a
 * later compile with none of its streams running. `midStream` runs while
 * that first stream is still alive, and `during` while the turn waits.
 * Returns the channel the turn's next start spoke into.
 */
async function heldTurnSpeaksInto(f: Fixture, during: () => Promise<void>, midStream?: () => Promise<void>): Promise<unknown> {
  let streams = 0;
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request as never);
    if (++streams > 1) return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'prose_after_hold' }] as ContentBlock[])]);
    const stream = new MockYieldingStream([
      createMockResponse([{ type: 'tool_use', id: 'p0', name: 'channel_publish', input: { channelId: 'chat', content: 'explicit_send' } }] as ContentBlock[], 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ]);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    (stream as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: iterate }) {
        if ((event as { type?: string }).type === 'complete') { await midStream?.(); yield { type: 'error' as const, error: accelerationLimit(request) }; return; }
        yield event;
      }
    };
    return stream;
  };
  await f.send('channels/incoming', { messages: [f.channel('c1', 'question', { initial: true }, 'chat', 'm1')] });
  await f.framework.runUntilIdle();
  const internals = f.framework as unknown as {
    providerAccelerationCooldowns: Map<string, { until: number }>;
    releaseProviderAccelerationCooldown(agentName: string): void;
  };
  const hold = internals.providerAccelerationCooldowns.get('agent');
  assert.ok(hold, 'the turn is held after its first stream');
  await during();
  hold.until = Date.now();
  internals.releaseProviderAccelerationCooldown('agent');
  await f.framework.runUntilIdle();
  assert.equal(streams, 2, 'one deferred compile');
  return f.published.find((p) => JSON.stringify(p.content).includes('prose_after_hold'))?.channelId;
}

test("#157: an edit that addresses the agent, of a follow-up stored while the turn waits out a capacity hold and not yet seen, moves the turn to the follow-up's channel", async (t) => {
  const f = await fixture({ framework: { speech: { locus: 'latest-inbound' } } }); /* the re-pin is the legacy rule */ t.after(f.close); await f.register(); await f.register('other');
  let outcome: string | undefined;
  const channel = await heldTurnSpeaksInto(f, async () => {
    await f.send('channels/incoming', { messages: [{ ...f.channel('q1', 'follow_up_wiht_typo', { initial: true }, 'other', 'mq'), tags: ['chat:ambient', 'chat:from-human'] }] });
    outcome = (await f.send('push/event', {
      ...f.params('e1', 'follow_up_fixed @agent', { channelId: 'other', key: 'message:mq' }), tags: ['chat:edited', 'chat:mention'],
    })).result.coalesce.outcome;
  });
  assert.equal(outcome, 'replaced', 'the edit replaced the follow-up the agent had not seen');
  assert.equal(channel, 'other');
});

test('#157: an edit of a follow-up stored at once, which a turn then read, is appended as a marker, so the prose after an explicit send stays withheld', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  // Stored at once, with no turn alive. The turn it wakes shows it to the agent in its compile.
  await f.send('channels/incoming', { messages: [{ ...f.channel('c2', 'follow_up_wiht_typo', { initial: true }, 'chat', 'm2'), tags: ['chat:ambient', 'chat:from-human'] }] });
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'one turn ran');
  assert(JSON.stringify(f.membrane.calls[0]).includes('follow_up_wiht_typo'), "that turn's compile showed the agent the follow-up");
  let outcome: string | undefined;
  const r = await sendThenSpeak(f, async () => { outcome = await pushTagged(f, ['chat:edited']); });
  assert.equal(outcome, 'appended', 'the edit came after the agent read the follow-up, so it replaced nothing');
  assert(r.injected[0].includes('follow_up_fixed') && !storedFirstView(f, 'follow_up_fixed'), 'the edit reached the boundary, stored unmarked');
  assert(r.sent, 'the explicit send posted');
  assert(!r.replied, 'the prose after the send stayed withheld');
});

test('#157: an edit admitted while a compile is assembling a message stored at once stays a marker, so the prose after an explicit send stays withheld', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  // The question is stored at once and wakes the turn. The edit is admitted
  // after the compile has assembled it and before the compile returns, so
  // the question still counts as unread.
  const cm = f.framework.getAgent('agent')!.getContextManager() as unknown as { compile: (...args: unknown[]) => Promise<unknown> };
  const compile = cm.compile.bind(cm);
  let shown = false;
  let edited = false;
  cm.compile = async (...args: unknown[]) => {
    const result = await compile(...args);
    if (!edited) {
      edited = true;
      shown = JSON.stringify(result).includes('question');
      await f.send('push/event', { ...f.params('e1', 'question_edited', { channelId: 'chat', key: 'message:m1' }), tags: ['chat:edited'] });
    }
    return result;
  };
  const r = await sendThenSpeak(f, async () => {});
  assert(shown, 'the compile assembled the question');
  assert(r.injected[0].includes('question_edited') && !storedFirstView(f, 'question_edited'), 'the edit reached the boundary, stored unmarked');
  assert(r.sent, 'the explicit send posted');
  assert(!r.replied, 'the prose after the send stayed withheld');
});

/** A message in an agent's store whose text includes `text`. */
const storedWith = (f: Fixture, text: string, agent = 'agent') =>
  f.framework.getAgent(agent)!.getContextManager().getAllMessages().find((m) => JSON.stringify(m.content).includes(text));
const isMarked = (message: { metadata?: unknown } | undefined) => (message?.metadata as { firstView?: unknown } | undefined)?.firstView === true;

test("#157: a compile of an agent with a store of its own leaves another agent's message stored at once unseen, so its edit is still marked", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register();
  // Stored at once in the agent's store, waking no turn.
  await f.send('push/event', f.params('d1', 'doc_unseen', { initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'nothing has compiled yet');
  // An ephemeral agent, whose store is its own, runs a turn.
  const helper = await f.framework.createEphemeralAgent({ name: 'helper', model: 'test', systemPrompt: 'Do the task.' });
  t.after(helper.cleanup);
  helper.contextManager.addMessage('User', [{ type: 'text', text: 'helper_task' }]);
  const run = f.framework.runEphemeralToCompletion(helper.agent, helper.contextManager);
  await f.framework.runUntilIdle();
  await run;
  assert.equal(f.membrane.calls.length, 1, "the helper's compile ran");
  assert(!JSON.stringify(f.membrane.calls[0]).includes('doc_unseen'), "the helper's request doesn't hold the agent's message");
  const edit = await f.send('push/event', { ...f.params('d2', 'doc_edited'), tags: ['chat:edited'] });
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  assert(isMarked(storedWith(f, 'doc_edited')), "the edit is the agent's first view");
});

test("#157: another resident's compile that assembles a message stored at once in the shared slot shows it, so an edit admitted during that compile isn't marked", async (t) => {
  const f = await fixture({ agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }, { name: 'other', model: 'test', systemPrompt: 'test' }], server: { shouldTriggerInference: () => true } }); t.after(f.close);
  // The edit is admitted after the other resident's compile has assembled
  // the message and before that compile returns.
  const cm = f.framework.getAgent('other')!.getContextManager() as unknown as { compile: (...args: unknown[]) => Promise<unknown> };
  const compile = cm.compile.bind(cm);
  let shown = false;
  let edited = false;
  cm.compile = async (...args: unknown[]) => {
    const result = await compile(...args);
    if (!edited) {
      edited = true;
      shown = JSON.stringify(result).includes('doc_unseen');
      await f.send('push/event', { ...f.params('d2', 'doc_edited'), tags: ['chat:edited'] });
    }
    return result;
  };
  await f.send('push/event', f.params('d1', 'doc_unseen', { initial: true }));
  const internals = f.framework as unknown as { pendingRequests: Array<{ agentName: string }> };
  internals.pendingRequests = internals.pendingRequests.filter((r) => r.agentName === 'other');
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert(shown, "the other resident's compile assembled the message");
  const stored = storedWith(f, 'doc_edited');
  assert(stored, 'the edit is stored');
  assert(!isMarked(stored), "the edit isn't marked as the agent's first view");
});

test("#157: an edit that addresses the agent, of a follow-up that arrived during the turn and was flushed when the turn was held, moves the turn to the follow-up's channel", async (t) => {
  const f = await fixture({ framework: { speech: { locus: 'latest-inbound' } } }); /* the re-pin is the legacy rule */ t.after(f.close); await f.register(); await f.register('other');
  let outcome: string | undefined;
  const channel = await heldTurnSpeaksInto(f, async () => {
    assert(storedWith(f, 'follow_up_wiht_typo'), 'the hold flushed the follow-up into the store');
    outcome = (await f.send('push/event', {
      ...f.params('e1', 'follow_up_fixed @agent', { channelId: 'other', key: 'message:mq' }), tags: ['chat:edited', 'chat:mention'],
    })).result.coalesce.outcome;
  }, async () => {
    // The follow-up arrives while the first stream runs, so it waits in the deferred queue.
    await f.send('channels/incoming', { messages: [{ ...f.channel('q1', 'follow_up_wiht_typo', { initial: true }, 'other', 'mq'), tags: ['chat:ambient', 'chat:from-human'] }] });
    assert(!storedWith(f, 'follow_up_wiht_typo'), 'the follow-up was deferred, not stored at once');
  });
  assert.equal(outcome, 'replaced', 'the edit replaced the follow-up the agent had not seen');
  assert.equal(channel, 'other');
});

test("#157: an edit of a follow-up that arrived during a turn and was flushed at the turn's end, before any compile showed it, is the agent's first view", async (t) => {
  // The question wakes the turn. The follow-up and its edit wake nothing, so
  // no compile shows the follow-up after the flush.
  const f = await fixture({ server: { shouldTriggerInference: (content: string) => !content.includes('follow_up') } }); t.after(f.close); await f.register();
  let streams = 0;
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request as never);
    const stream = new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answer' }] as ContentBlock[])]);
    if (++streams > 1) return stream;
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    (stream as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: iterate }) {
        // The follow-up arrives after the turn's last round, so no tool
        // boundary drains it: it waits for the turn-end flush.
        if ((event as { type?: string }).type === 'complete') {
          await f.send('push/event', f.params('d1', 'follow_up_wiht_typo', { initial: true }));
          assert(!storedWith(f, 'follow_up_wiht_typo'), 'the follow-up was deferred, not stored at once');
        }
        yield event;
      }
    };
    return stream;
  };
  await f.send('channels/incoming', { messages: [f.channel('c1', 'question', { initial: true }, 'chat', 'm1')] });
  await f.framework.runUntilIdle();
  assert.equal(streams, 1, 'one turn ran');
  assert(storedWith(f, 'follow_up_wiht_typo'), "the turn-end flush stored the follow-up");
  assert(!f.membrane.calls.some((c) => JSON.stringify(c).includes('follow_up_wiht_typo')), 'no request held the follow-up');
  const edit = await f.send('push/event', { ...f.params('d2', 'follow_up_fixed'), tags: ['chat:edited'] });
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  assert(isMarked(storedWith(f, 'follow_up_fixed')), "the edit is the agent's first view");
});

test("#157: an edit admitted while the agent's compileContext is assembling a message stored at once stays a marker", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register();
  // Stored at once, waking no turn.
  await f.send('push/event', f.params('d1', 'doc_unseen', { initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'no turn ran');
  const agent = f.framework.getAgent('agent')!;
  const cm = agent.getContextManager() as unknown as { compile: (...args: unknown[]) => Promise<unknown> };
  const compile = cm.compile.bind(cm);
  let shown = false;
  let outcome: string | undefined;
  cm.compile = async (...args: unknown[]) => {
    const result = await compile(...args);
    shown = JSON.stringify(result).includes('doc_unseen');
    outcome = (await f.send('push/event', { ...f.params('d2', 'doc_edited'), tags: ['chat:edited'] })).result.coalesce.outcome;
    return result;
  };
  await agent.compileContext();
  assert(shown, 'compileContext assembled the message');
  assert.equal(outcome, 'replaced', 'the message still counted as unread while compileContext ran');
  const stored = storedWith(f, 'doc_edited');
  assert(stored, 'the edit is stored');
  assert(!isMarked(stored), "the edit isn't the agent's first view");
});

for (const method of ['compileContext', 'compileWithInjections'] as const) test(`#157: a committing ${method} that throws gives its shown mark back, so an edit of a message stored at once is still the agent's first view`, async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register();
  // Stored at once, waking no turn.
  await f.send('push/event', f.params('d1', 'doc_unseen', { initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'no turn ran');
  const agent = f.framework.getAgent('agent')!;
  const cm = agent.getContextManager() as unknown as { compile: (...args: unknown[]) => Promise<unknown> };
  const compile = cm.compile;
  cm.compile = async () => { throw new Error('compile_failed'); };
  await assert.rejects(agent[method](), /compile_failed/);
  cm.compile = compile;
  const edit = await f.send('push/event', { ...f.params('d2', 'doc_edited'), tags: ['chat:edited'] });
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  const stored = storedWith(f, 'doc_edited');
  assert(stored, 'the edit is stored');
  assert(isMarked(stored), "the edit is the agent's first view");
});

test("#157: a compile that throws after a tool boundary has moved the shown mark leaves the boundary's move, so an edit of a message stored at once is a marker", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register();
  await f.send('push/event', f.params('d1', 'doc_unseen', { initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'no turn ran');
  const agent = f.framework.getAgent('agent')!;
  const cm = agent.getContextManager() as unknown as { compile: (...args: unknown[]) => Promise<unknown> };
  const compile = cm.compile;
  // A boundary of another turn injects while the compile runs, then the compile fails.
  cm.compile = async () => { agent.markContextShown(); throw new Error('compile_failed'); };
  await assert.rejects(agent.compileContext(), /compile_failed/);
  cm.compile = compile;
  const edit = await f.send('push/event', { ...f.params('d2', 'doc_edited'), tags: ['chat:edited'] });
  assert.equal(edit.result.coalesce.outcome, 'replaced', 'the message is still unread');
  const stored = storedWith(f, 'doc_edited');
  assert(stored, 'the edit is stored');
  assert(!isMarked(stored), "the edit isn't the agent's first view");
});

test('#157: a tool boundary that cannot read the store counts every message as shown, so an edit of a message stored at once is a marker', async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register();
  await f.send('push/event', f.params('d1', 'doc_unseen', { initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'no turn ran');
  const agent = f.framework.getAgent('agent')!;
  const cm = agent.getContextManager() as unknown as { currentBranch: () => unknown };
  const currentBranch = cm.currentBranch;
  cm.currentBranch = () => { throw new Error('store_unreadable'); };
  agent.markContextShown();
  cm.currentBranch = currentBranch;
  const edit = await f.send('push/event', { ...f.params('d2', 'doc_edited'), tags: ['chat:edited'] });
  assert.equal(edit.result.coalesce.outcome, 'replaced', 'the message is still unread');
  const stored = storedWith(f, 'doc_edited');
  assert(stored, 'the edit is stored');
  assert(!isMarked(stored), "the edit isn't the agent's first view");
});

test("#157: a dry-run preview shows the agent nothing, so an edit of a message stored at once after one is still its first view", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register();
  await f.send('push/event', f.params('d1', 'doc_unseen', { initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'no turn ran');
  const preview = await f.framework.previewActivation('agent');
  assert(JSON.stringify(preview).includes('doc_unseen'), 'the preview assembled the message');
  const edit = await f.send('push/event', { ...f.params('d2', 'doc_edited'), tags: ['chat:edited'] });
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  const stored = storedWith(f, 'doc_edited');
  assert(stored, 'the edit is stored');
  assert(isMarked(stored), "the edit is the agent's first view");
});

test("#157: the render of a deferred notice that births its subject is the agent's first view, so an edit tag on it doesn't make it a marker", async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', { ...f.params('n1', 'fallback_text', { deferred: true, initial: true }), tags: ['chat:edited'] });
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'the notice rendered at assembly');
  const stored = storedWith(f, 'document_diff');
  assert(stored, 'the render is stored');
  assert(isMarked(stored), "the render is the agent's first view");
});

/** What a stand-in host has removed. As in the framework, a removed
 *  placement is no longer unread, and nothing can still be unshown in it, so
 *  a first-view decision has to be taken before the removal. */
function removals() {
  const removed = new Set<string>();
  const key = (p: { deferredId?: string; messageId?: string }) => p.deferredId ?? p.messageId ?? '';
  return {
    gone: (p: { deferredId?: string; messageId?: string }) => removed.has(key(p)),
    remove: (p: { deferredId?: string; messageId?: string }) => { removed.add(key(p)); return true; },
  };
}

test("#157: a render that lands unread in another agent's deferred queue keeps its first view, so an edit that replaces it is marked", async () => {
  const delivered: Array<{ eventId: string; firstView?: true }> = [];
  const r = removals();
  const host: CoalescerHost<null> = {
    isUnread: (p) => !r.gone(p), isUnshown: (p) => !r.gone(p), remove: r.remove,
    // Every delivery lands in the deferred queue of an agent whose turn is alive.
    deliver: async (occ) => { delivered.push({ eventId: occ.eventId, ...(occ.firstView ? { firstView: true as const } : {}) }); return { agent: 'other', deferredId: `deferred-${delivered.length}` }; },
    wakeForBatch: async () => {}, wakeToRead: async () => {}, cancelWake: () => {}, authorized: () => true,
    audience: async () => ['agent', 'other'],
    render: async () => ({ content: [{ type: 'text', text: 'document_diff' }] }),
    audit: () => {}, save: () => {},
  };
  const coalescer = new PushCoalescer<null>(host);
  const occurrence = (eventId: string, flags: Partial<CoalescedOccurrence<null>>): CoalescedOccurrence<null> => ({
    serverId: 'editor', binding: 'binding', scope: { kind: 'featureSet', id: 'doc' }, key: 'document', eventId, timestamp: TS,
    retract: false, deferred: false, initial: false, content: [{ type: 'text', text: eventId }], event: null, ...flags,
  });
  await coalescer.accept(occurrence('n1', { deferred: true, initial: true }));
  await coalescer.assemble('agent');
  const edit = await coalescer.accept(occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(edit.coalesce?.outcome, 'replaced', 'the edit replaced the unread render');
  assert.deepEqual(delivered, [{ eventId: 'n1', firstView: true }, { eventId: 'e1', firstView: true }], 'the render and the edit that replaced it are each marked');
});

test("#157: a notice's render that lands while an earlier render of its subject waits unread in a deferred queue is no first view", async () => {
  const delivered: Array<{ eventId: string; firstView?: true }> = [];
  let releaseFirst!: () => void;
  const firstRender = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const r = removals();
  const host: CoalescerHost<null> = {
    isUnread: (p) => !r.gone(p), isUnshown: (p) => !r.gone(p), remove: r.remove,
    // Every delivery lands in the deferred queue of an agent whose turn is alive.
    deliver: async (occ) => { delivered.push({ eventId: occ.eventId, ...(occ.firstView ? { firstView: true as const } : {}) }); return { agent: 'other', deferredId: `deferred-${delivered.length}` }; },
    wakeForBatch: async () => {}, wakeToRead: async () => {}, cancelWake: () => {}, authorized: () => true,
    audience: async () => ['agent', 'other'],
    render: async (occ) => { if (occ.eventId === 'n1') await firstRender; return { content: [{ type: 'text', text: `diff_${occ.eventId}` }] }; },
    audit: () => {}, save: () => {},
  };
  const coalescer = new PushCoalescer<null>(host);
  const occurrence = (eventId: string, flags: Partial<CoalescedOccurrence<null>>): CoalescedOccurrence<null> => ({
    serverId: 'editor', binding: 'binding', scope: { kind: 'featureSet', id: 'doc' }, key: 'document', eventId, timestamp: TS,
    retract: false, deferred: false, initial: false, content: [{ type: 'text', text: eventId }], event: null, ...flags,
  });
  await coalescer.accept(occurrence('n1', { deferred: true, initial: true }));
  const first = coalescer.assemble('agent');
  // A second notice arrives while the first batch renders, so it opens a new batch.
  await coalescer.accept(occurrence('n2', { deferred: true }));
  releaseFirst();
  await first;
  await coalescer.assemble('agent');
  assert.deepEqual(delivered, [{ eventId: 'n1', firstView: true }, { eventId: 'n2' }], 'only the first render is the first view');
});

/** A coalescer whose every delivery lands in the deferred queue of 'other',
 *  an agent whose turn is alive, unless `stored` names the event, whose
 *  delivery is then stored and so materialized for the assembling turn, or
 *  `unplaced` does, whose delivery is placed nowhere. The renders of `held`
 *  wait for `release`, and those of `blank` come back blank. `state` answers
 *  the host's read and shown questions for every placement it hasn't removed
 *  (removals), and its `shownEvents` and `readEvents`, when given, for the
 *  placements of the events they name.
 *  (slimepriestess's probe for #168, with the held renders and the other
 *  options added.) */
function firstViewProbe(state: { shown: boolean; read: boolean; shownEvents?: Set<string>; readEvents?: Set<string> }, { held = ['n1'], stored = [] as string[], unplaced = [] as string[], blank = [] as string[] } = {}) {
  const delivered: Array<{ eventId: string; firstView?: true }> = [];
  // Each placement's event, for the per-event read and shown answers.
  const eventOf = new Map<string, string>();
  const named = (p: { deferredId?: string; messageId?: string }, events?: Set<string>) => events?.has(eventOf.get(p.deferredId ?? p.messageId ?? '') ?? '') === true;
  const releases = new Map<string, () => void>();
  const gates = new Map(held.map((id) => [id, new Promise<void>((resolve) => { releases.set(id, resolve); })]));
  const started = new Map<string, () => void>();
  const renderStarted = new Map(held.map((id) => [id, new Promise<void>((resolve) => { started.set(id, resolve); })]));
  const r = removals();
  const host: CoalescerHost<null> = {
    isUnread: (p) => !r.gone(p) && !state.read && !named(p, state.readEvents),
    isUnshown: (p) => !r.gone(p) && !state.shown && !state.read && !named(p, state.shownEvents) && !named(p, state.readEvents),
    remove: r.remove,
    deliver: async (occ) => {
      delivered.push({ eventId: occ.eventId, ...(occ.firstView ? { firstView: true as const } : {}) });
      if (unplaced.includes(occ.eventId)) return undefined;
      const placement = stored.includes(occ.eventId)
        ? { agent: 'agent', messageId: `stored-${delivered.length}` }
        : { agent: 'other', deferredId: `deferred-${delivered.length}` };
      eventOf.set(placement.messageId ?? placement.deferredId!, occ.eventId);
      return placement;
    },
    wakeForBatch: async () => {}, wakeToRead: async () => {}, cancelWake: () => {}, authorized: () => true,
    audience: async () => ['agent', 'other'],
    render: async (occ) => {
      started.get(occ.eventId)?.();
      await gates.get(occ.eventId);
      return { content: [{ type: 'text', text: blank.includes(occ.eventId) ? ' ' : `diff_${occ.eventId}` }] };
    },
    audit: () => {}, save: () => {},
  };
  const coalescer = new PushCoalescer<null>(host);
  const occurrence = (eventId: string, flags: Partial<CoalescedOccurrence<null>>): CoalescedOccurrence<null> => ({
    serverId: 'editor', binding: 'binding', scope: { kind: 'featureSet', id: 'doc' }, key: 'document', eventId, timestamp: TS,
    retract: false, deferred: false, initial: false, content: [{ type: 'text', text: eventId }], event: null, ...flags,
  });
  return {
    coalescer, host, delivered, occurrence,
    release: (id: string) => releases.get(id)!(),
    renderStarted: (id: string) => renderStarted.get(id)!,
  };
}

/** n1's render lands in 'other''s deferred queue as a first view, after n2
 *  opened a batch of the same subject during that render. */
async function firstViewQueuedWithBatchPending(p: ReturnType<typeof firstViewProbe>): Promise<void> {
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  const first = p.coalescer.assemble('agent');
  await p.coalescer.accept(p.occurrence('n2', { deferred: true }));
  p.release('n1');
  await first;
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }], "n1's render is the agent's first view");
}

for (const shown of [false, true]) test(`#157: a notice after a queued first-view render joins the pending batch and leaves the render in place, the batch's render joins its run unmarked, and a plain edit that displaces the run ${shown ? 'the agent was shown is no first view' : 'nothing has shown is the first view'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state);
  await firstViewQueuedWithBatchPending(p);
  // Shown at a boundary whose stream doesn't declare what it carries
  // injected: still unread, but no longer unshown.
  state.shown = shown;
  const n3 = await p.coalescer.accept(p.occurrence('n3', { deferred: true, tags: ['chat:edited'] }));
  assert.equal(n3.coalesce?.outcome, 'replaced', 'n3 joined the pending batch');
  await p.coalescer.assemble('agent');
  // A render is a delta the next one builds on (RFC-006 §5.2): n1 stays, and
  // the batch's render joins its run. The run holds the first view, in n1.
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }, { eventId: 'n3' }]);
  const e1 = await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(e1.coalesce?.outcome, 'replaced', 'e1 displaced the run');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'e1', ...(shown ? {} : { firstView: true as const }) },
    shown ? 'the agent was shown the run, so the edit is no first view' : 'nothing showed the run, so the edit takes its first view');
});

for (const shown of [false, true]) test(`#157: a render that settles while a first-view render is queued joins its run unmarked, and a retraction of the run ${shown ? 'the agent was shown leaves the next batch no first view' : 'nothing had shown leaves the next batch the first view'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: ['n1', 'n2'] });
  await firstViewQueuedWithBatchPending(p);
  // n2's batch renders, held, so no batch is pending when n3 arrives.
  const second = p.coalescer.assemble('agent');
  await settles(p.renderStarted('n2'), "n2's render");
  state.shown = shown;
  const n3 = await p.coalescer.accept(p.occurrence('n3', { deferred: true, tags: ['chat:edited'] }));
  assert.equal(n3.coalesce?.outcome, 'first', 'n3 opened a batch beside the queued render, which stays');
  p.release('n2');
  await second;
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }, { eventId: 'n2' }], "n2's render joined n1's run unmarked");
  const r1 = await p.coalescer.accept(p.occurrence('r1', { retract: true, content: [] }));
  assert.equal(r1.coalesce?.outcome, 'retracted');
  // Later versions haven't been shown, whatever happened to the run.
  state.shown = false;
  await p.coalescer.accept(p.occurrence('n4', { deferred: true }));
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'n4', ...(shown ? {} : { firstView: true as const }) });
});

test("#157: a batch opened during a render whose content the turn then read has a render that is no first view", async () => {
  const state = { shown: false, read: false };
  // n1's render is stored where the assembling turn's compile reads it, so
  // that turn consumes it.
  const p = firstViewProbe(state, { stored: ['n1'] });
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  const first = p.coalescer.assemble('agent');
  await p.coalescer.accept(p.occurrence('n2', { deferred: true }));
  p.release('n1');
  await first;
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }, { eventId: 'n2' }], "n2's batch opened before the agent read n1, but its render comes after");
});

test('#157: a plain edit that takes the place of a pending first-view batch after the agent read an earlier render is no first view', async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state);
  await firstViewQueuedWithBatchPending(p);
  state.read = true;
  const e1 = await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(e1.coalesce?.outcome, 'replaced');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'e1' });
});

/** n1's render lands in 'other''s deferred queue as the agent's first view,
 *  and `shown` says whether the agent is then shown it. n2 opens a batch
 *  beside it, which follows the run's agent and is no first view, since the
 *  run holds it; that batch starts rendering for 'other'; n3 opens a new
 *  batch during that render. Returns the held assembly, wrapped, since an
 *  async function returning it would wait for it. */
async function firstViewEndedDuringRender(p: ReturnType<typeof firstViewProbe>, state: { shown: boolean }, shown: boolean) {
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }], "n1's render is the agent's first view");
  state.shown = shown;
  const n2 = await p.coalescer.accept(p.occurrence('n2', { deferred: true }));
  assert.equal(n2.coalesce?.outcome, 'first', 'n2 opened a batch beside the queued render, which stays');
  const second = p.coalescer.assemble('other');
  await settles(p.renderStarted('n2'), "n2's render");
  const n3 = await p.coalescer.accept(p.occurrence('n3', { deferred: true }));
  assert.equal(n3.coalesce?.outcome, 'first', 'n3 opened a new batch during the render');
  return { second };
}

for (const shown of [false, true]) test(`#157: a plain edit that takes the place of a batch opened during a render beside a queued first-view render displaces that run too, and ${shown ? 'is no first view when the agent was shown it' : 'is the first view when nothing had shown it'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: ['n2'] });
  const { second } = await firstViewEndedDuringRender(p, state, shown);
  const e1 = await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(e1.coalesce?.outcome, 'replaced', "e1 took the pending batch's place");
  p.release('n2');
  await second;
  assert.equal(p.delivered.at(-1)?.eventId, 'e1');
  assert.equal(p.delivered.at(-1)?.firstView === true, !shown);
});

for (const shown of [false, true]) test(`#157: beside a queued first-view render, a batch whose render comes back blank and a later batch's render leave the run its first view, so a plain edit that displaces the run ${shown ? 'the agent was shown is no first view' : 'nothing had shown is the first view'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: ['n2'], blank: ['n2'] });
  const { second } = await firstViewEndedDuringRender(p, state, shown);
  p.release('n2');
  await second;
  assert.equal(p.delivered.length, 1, "n2's blank render delivered nothing");
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'n3' }, "n3's render joined n1's run unmarked");
  const e1 = await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(e1.coalesce?.outcome, 'replaced', 'e1 displaced the run');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'e1', ...(shown ? {} : { firstView: true as const }) });
});

/** n1's render lands in 'other''s deferred queue as the agent's first view;
 *  `shown` says whether the agent is then shown it, and a retraction
 *  withdraws it. */
/** A run of n1, the agent's first view, and n3's render, which joined it
 *  unmarked, both queued for 'other'. */
async function firstViewRunOfTwo(p: ReturnType<typeof firstViewProbe>): Promise<void> {
  await firstViewQueuedWithBatchPending(p);
  await p.coalescer.accept(p.occurrence('n3', { deferred: true, tags: ['chat:edited'] }));
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }, { eventId: 'n3' }], "n3's render joined n1's run unmarked");
}

/** Runs whose renders the agent may have seen differently: only a run none
 *  of whose renders may have been shown, and none of whose renders has left
 *  it read, hands its first view on. */
const runMixes: Record<string, { shownEvents?: string[]; readEvents?: string[] }> = {
  'its newest render shown and its oldest not': { shownEvents: ['n3'] },
  'its oldest render shown and its newest not': { shownEvents: ['n1'] },
  'its newest render read and its oldest not': { readEvents: ['n3'] },
};
const runEndings: Record<string, (p: ReturnType<typeof firstViewProbe>) => Promise<string>> = {
  'a plain edit that displaces it is': async (p) => {
    const e1 = await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
    assert.equal(e1.coalesce?.outcome, 'replaced', 'e1 displaced what is left of the run');
    return 'e1';
  },
  'a retraction of it leaves the next batch': async (p) => {
    await p.coalescer.accept(p.occurrence('r1', { retract: true, content: [] }));
    await p.coalescer.accept(p.occurrence('n4', { deferred: true }));
    await p.coalescer.assemble('agent');
    return 'n4';
  },
};
for (const [mix, seen] of Object.entries(runMixes)) for (const [ending, end] of Object.entries(runEndings)) test(`#157: with a run of renders that has ${mix}, ${ending} no first view`, async () => {
  const state = { shown: false, read: false, shownEvents: new Set<string>(), readEvents: new Set<string>() };
  const p = firstViewProbe(state);
  await firstViewRunOfTwo(p);
  for (const id of seen.shownEvents ?? []) state.shownEvents.add(id);
  for (const id of seen.readEvents ?? []) state.readEvents.add(id);
  const next = await end(p);
  assert.deepEqual(p.delivered.at(-1), { eventId: next }, 'something of the run may have been shown');
});

async function firstViewRetracted(p: ReturnType<typeof firstViewProbe>, state: { shown: boolean }, shown: boolean) {
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }], "n1's render is the agent's first view");
  state.shown = shown;
  const r1 = await p.coalescer.accept(p.occurrence('r1', { retract: true, content: [] }));
  assert.equal(r1.coalesce?.outcome, 'retracted');
  // Later versions haven't been shown, whatever happened to n1.
  state.shown = false;
}

for (const shown of [false, true]) test(`#157: after a retraction withdraws a first-view render ${shown ? 'the agent was shown, the next batch is no first view' : 'nothing had shown, the next batch is the first view'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  await firstViewRetracted(p, state, shown);
  await p.coalescer.accept(p.occurrence('n2', { deferred: true }));
  await p.coalescer.assemble('agent');
  assert.equal(p.delivered.at(-1)?.eventId, 'n2');
  assert.equal(p.delivered.at(-1)?.firstView === true, !shown);
});

for (const shown of [false, true]) test(`#157: after a retraction withdraws a first-view render ${shown ? 'the agent was shown, a plain birth is no first view, nor its edit' : 'nothing had shown, a plain birth is the first view, and so is its edit'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  await firstViewRetracted(p, state, shown);
  const p1 = await p.coalescer.accept(p.occurrence('p1', {}));
  assert.equal(p1.coalesce?.outcome, 'first');
  const e1 = await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(e1.coalesce?.outcome, 'replaced', 'e1 replaced the unread birth');
  assert.equal(p.delivered.at(-1)?.eventId, 'e1');
  assert.equal(p.delivered.at(-1)?.firstView === true, !shown);
});

for (const shown of [false, true]) test(`#157: a plain occurrence that displaces a first-view render ${shown ? 'the agent was shown and is placed nowhere leaves the next batch no first view' : 'nothing had shown and is placed nowhere leaves the next batch the first view'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [], unplaced: ['p1'] });
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  await p.coalescer.assemble('agent');
  state.shown = shown;
  const p1 = await p.coalescer.accept(p.occurrence('p1', { tags: ['chat:edited'] }));
  assert.equal(p1.coalesce?.outcome, 'replaced');
  assert.equal(p.delivered.at(-1)?.eventId, 'p1');
  state.shown = false;
  await p.coalescer.accept(p.occurrence('n2', { deferred: true }));
  await p.coalescer.assemble('agent');
  assert.equal(p.delivered.at(-1)?.eventId, 'n2');
  assert.equal(p.delivered.at(-1)?.firstView === true, !shown);
});

test("#157: a snapshot keeps a subject's ended first view, so a restored coalescer's next batch is no first view", async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  await firstViewRetracted(p, state, true);
  const snapshot = p.coalescer.snapshot();
  const restored = new PushCoalescer<null>(p.host);
  restored.restore(snapshot);
  await restored.accept(p.occurrence('n2', { deferred: true }));
  await restored.assemble('agent');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'n2' });
});

/** n1's render lands in 'other''s deferred queue as the agent's first view;
 *  `shown` says whether the agent is then shown it, and a plain edit
 *  displaces it. */
async function firstViewDisplacedByPlain(p: ReturnType<typeof firstViewProbe>, state: { shown: boolean }, shown: boolean) {
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }], "n1's render is the agent's first view");
  state.shown = shown;
  const p1 = await p.coalescer.accept(p.occurrence('p1', { tags: ['chat:edited'] }));
  assert.equal(p1.coalesce?.outcome, 'replaced', 'p1 displaced the queued render');
  // Later versions haven't been shown, whatever happened to n1.
  state.shown = false;
}

const firstViewEndings = { 'a retraction': firstViewRetracted, 'a plain occurrence that displaces it': firstViewDisplacedByPlain };

for (const [ending, end] of Object.entries(firstViewEndings)) for (const shown of [false, true]) test(`#157: the crash-window receipt records keep a subject's ended first view after ${ending}, so a coalescer restored from them alone ${shown ? 'gives the next batch no first view' : 'still gives the next batch its first view when nothing had shown the agent the last'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  const records: CoalescingReceiptRecord[] = [];
  p.host.recordReceipt = (record) => { records.push(structuredClone(record)); };
  await end(p, state, shown);
  // A crash before the throttled snapshot: only the records written at each acceptance survive.
  const restored = new PushCoalescer<null>(p.host);
  restored.restoreReceipts(records);
  await restored.accept(p.occurrence('n2', { deferred: true }));
  await restored.assemble('agent');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'n2', ...(shown ? {} : { firstView: true as const }) });
});

for (const shown of [false, true]) test(`#157: a snapshot taken before a subject's first view ended, with the records written after it, ${shown ? 'gives the next batch no first view' : 'still gives the next batch its first view when nothing had shown the agent the last'}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  // The last snapshot holds the subject with its batch pending; the records after it are the crash window's.
  const snapshot = p.coalescer.snapshot();
  const records: CoalescingReceiptRecord[] = [];
  p.host.recordReceipt = (record) => { records.push(structuredClone(record)); };
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }], "n1's render is the agent's first view");
  state.shown = shown;
  const r1 = await p.coalescer.accept(p.occurrence('r1', { retract: true, content: [] }));
  assert.equal(r1.coalesce?.outcome, 'retracted');
  state.shown = false;
  assert.equal(records.length, 1, "the retraction's record is the only one after the snapshot");
  const restored = new PushCoalescer<null>(p.host);
  restored.restore(snapshot);
  restored.restoreReceipts(records);
  await restored.accept(p.occurrence('n2', { deferred: true }));
  await restored.assemble('agent');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'n2', ...(shown ? {} : { firstView: true as const }) });
});

for (const shown of [false, true]) test(`#157: a snapshot that holds a first-view batch, restored with the records after it once their retry window has passed, ${shown ? "gives that batch's render no first view when a record ends the first view" : "leaves that batch's render the first view when nothing had shown the agent the last"}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  // The last snapshot holds n1's batch pending, as the agent's first view.
  const snapshot = p.coalescer.snapshot();
  const records: CoalescingReceiptRecord[] = [];
  p.host.recordReceipt = (record) => { records.push(structuredClone(record)); };
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }], "n1's render is the agent's first view");
  state.shown = shown;
  await p.coalescer.accept(p.occurrence('r1', { retract: true, content: [] }));
  state.shown = false;
  // The host comes back two hours after the crash. Past their retry window
  // the records' batch facts aren't read, so the snapshot's batch is back,
  // and the end a record carries holds for it too.
  const later = Date.now() + 2 * 3_600_000;
  const restored = new PushCoalescer<null>({ ...p.host, now: () => later });
  restored.restore(snapshot);
  restored.restoreReceipts(records);
  await restored.assemble('agent');
  assert.deepEqual(p.delivered.at(-1), { eventId: 'n1', ...(shown ? {} : { firstView: true as const }) });
});

for (const shown of [false, true]) test(`#157: crash-window records restored after their retry window has passed ${shown ? "still end the first view, so the edit of a later initial plain occurrence is no first view" : "leave the edit of a later initial plain occurrence the first view when nothing had shown the agent the last"}`, async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  const records: CoalescingReceiptRecord[] = [];
  p.host.recordReceipt = (record) => { records.push(structuredClone(record)); };
  await firstViewRetracted(p, state, shown);
  // The host comes back two hours after the crash: every record is past the default one-hour retry window.
  const later = Date.now() + 2 * 3_600_000;
  const restored = new PushCoalescer<null>({ ...p.host, now: () => later });
  restored.restoreReceipts(records);
  await restored.accept(p.occurrence('p1', { initial: true }));
  const e1 = await restored.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(e1.coalesce?.outcome, 'replaced', 'e1 replaced the unread p1');
  // A birth carries no mark of its own (it isn't an edit); its edit carries the first view it hands on.
  assert.deepEqual(p.delivered.slice(-2), [
    { eventId: 'p1' },
    { eventId: 'e1', ...(shown ? {} : { firstView: true as const }) },
  ]);
});

test("#157: a receipt keeps an admission's first view in memory only, so a restored receipt has none", async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  await p.coalescer.assemble('agent');
  await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.deepEqual(p.delivered.at(-1), { eventId: 'e1', firstView: true });
  assert.equal(p.coalescer.receiptFirstView('editor', 'binding', 'e1'), true, "the receipt records e1's first view");
  const snapshot = p.coalescer.snapshot();
  const restored = new PushCoalescer<null>(p.host);
  restored.restore(snapshot);
  assert.equal(restored.receiptFirstView('editor', 'binding', 'e1'), false, 'a restored receipt has no first view');
});

test('#157: a plain edit that arrives while a first-view batch renders takes its place as the first view', async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state);
  await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  const first = p.coalescer.assemble('agent');
  await settles(p.renderStarted('n1'), "n1's render");
  const e1 = await p.coalescer.accept(p.occurrence('e1', { tags: ['chat:edited'] }));
  assert.equal(e1.coalesce?.outcome, 'replaced', 'e1 cancelled the render and took its place');
  p.release('n1');
  await first;
  assert.deepEqual(p.delivered, [{ eventId: 'e1', firstView: true }]);
});

for (const shown of [false, true]) test(`#157: a notice that displaces an unread first view ${shown ? 'that something may have shown the agent opens a batch whose render is no first view' : 'that nothing has shown the agent opens a batch whose render is the first view'}`, async () => {
  const delivered: Array<{ eventId: string; firstView?: true }> = [];
  const r = removals();
  const host: CoalescerHost<null> = {
    isUnread: (p) => !r.gone(p), isUnshown: (p) => !r.gone(p) && !shown, remove: r.remove,
    deliver: async (occ) => { delivered.push({ eventId: occ.eventId, ...(occ.firstView ? { firstView: true as const } : {}) }); return { agent: 'agent', messageId: `stored-${delivered.length}` }; },
    wakeForBatch: async () => {}, wakeToRead: async () => {}, cancelWake: () => {}, authorized: () => true,
    audience: async () => ['agent'],
    render: async () => ({ content: [{ type: 'text', text: 'document_diff' }] }),
    audit: () => {}, save: () => {},
  };
  const coalescer = new PushCoalescer<null>(host);
  const occurrence = (eventId: string, flags: Partial<CoalescedOccurrence<null>>): CoalescedOccurrence<null> => ({
    serverId: 'editor', binding: 'binding', scope: { kind: 'featureSet', id: 'doc' }, key: 'document', eventId, timestamp: TS,
    retract: false, deferred: false, initial: false, content: [{ type: 'text', text: eventId }], event: null, ...flags,
  });
  await coalescer.accept(occurrence('p1', { initial: true }));
  const notice = await coalescer.accept(occurrence('n1', { deferred: true, tags: ['chat:edited'] }));
  assert.equal(notice.coalesce?.outcome, 'replaced', 'the notice displaced the unread birth');
  await coalescer.assemble('agent');
  assert.deepEqual(delivered, [{ eventId: 'p1' }, { eventId: 'n1', ...(shown ? {} : { firstView: true as const }) }]);
});

test("#157: a plain edit that takes the place of a pending notice that birthed its subject is the agent's first view, and so is an edit of that edit", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close);
  // The notice waits as a batch: no turn assembles it.
  await f.send('push/event', f.params('n1', 'fallback_text', { deferred: true, initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0, 'nothing rendered the notice');
  const first = await f.send('push/event', { ...f.params('e1', 'doc_edit_one'), tags: ['chat:edited'] });
  assert.equal(first.result.coalesce.outcome, 'replaced', "the edit took the batch's place");
  const one = storedWith(f, 'doc_edit_one');
  assert(one, 'the edit is stored');
  assert(isMarked(one), "the edit is the agent's first view");
  const second = await f.send('push/event', { ...f.params('e2', 'doc_edit_two'), tags: ['chat:edited'] });
  assert.equal(second.result.coalesce.outcome, 'replaced', 'the second edit replaced the first, unread');
  const two = storedWith(f, 'doc_edit_two');
  assert(two, 'the second edit is stored');
  assert(isMarked(two), "the second edit is the agent's first view too");
});

test("#157: a notice that births its subject and is still pending at a restart is still the agent's first view after it", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close);
  await f.send('push/event', f.params('n1', 'fallback_text', { deferred: true, initial: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0, 'nothing rendered the notice');
  await f.framework.stop(); await f.create();
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0, 'nothing rendered the notice after the restart');
  const edit = await f.send('push/event', { ...f.params('e1', 'doc_edit_one'), tags: ['chat:edited'] });
  assert.equal(edit.result.coalesce.outcome, 'replaced', "the edit took the restored batch's place");
  const stored = storedWith(f, 'doc_edit_one');
  assert(stored, 'the edit is stored');
  assert(isMarked(stored), "the edit is the agent's first view");
});

type IncomingAnchor = { buildChannelContext: (agent: string | undefined, serverId: string) => { incoming?: { channelId: string; messageId: string } } | undefined };
const incomingAnchor = (f: Fixture) => (f.framework as unknown as { channelRegistry: IncomingAnchor }).channelRegistry.buildChannelContext('agent', 'editor')?.incoming;

test("#157: a channel edit that is the agent's first view moves context.incoming to its message, as the message would", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register(); await f.register('other');
  await f.send('channels/incoming', { messages: [f.channel('a1', 'question_wiht_typo', { initial: true }, 'other', 'ma')] });
  await f.send('channels/incoming', { messages: [f.channel('b1', 'unrelated', { initial: true }, 'chat', 'mb')] });
  assert.equal(incomingAnchor(f)?.messageId, 'mb', 'the later message is the anchor');
  const edit = await f.send('channels/incoming', { messages: [{ ...f.channel('a2', 'question_fixed', {}, 'other', 'ma'), tags: ['chat:edited'] }] });
  assert.equal(edit.result.results[0].coalesce.outcome, 'replaced', 'the edit replaced the question the agent had not seen');
  assert(!('firstView' in edit.result.results[0]), "the host's mark isn't in the answer to the server");
  assert(isMarked(storedWith(f, 'question_fixed')), "the edit is the agent's first view");
  assert.equal(incomingAnchor(f)?.channelId, 'other', "the anchor moved to the edit's channel");
  assert.equal(incomingAnchor(f)?.messageId, 'ma', "and to the edit's message");
});

test("#157: a channel edit that is the agent's first view moves context.incoming to its message when its acceptance is retried after a failed commit", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register(); await f.register('other');
  await f.send('channels/incoming', { messages: [f.channel('a1', 'question_wiht_typo', { initial: true }, 'other', 'ma')] });
  await f.send('channels/incoming', { messages: [f.channel('b1', 'unrelated', { initial: true }, 'chat', 'mb')] });
  assert.equal(incomingAnchor(f)?.messageId, 'mb', 'the later message is the anchor');
  // The edit's acceptance commit fails once, after its delivery (R10's seam),
  // so the server retries, and the retry is answered from the receipt.
  const internals = f.framework as unknown as { commitCoalescingDurable: () => Promise<void> };
  const commit = internals.commitCoalescingDurable.bind(internals);
  internals.commitCoalescingDurable = () => { internals.commitCoalescingDurable = commit; return Promise.reject(new Error('EIO simulated')); };
  const message = { ...f.channel('a2', 'question_fixed', {}, 'other', 'ma'), tags: ['chat:edited'] };
  const first = await f.send('channels/incoming', { messages: [message] });
  // Admitted, so not refused: the request fails, which leaves it unacknowledged.
  assert.equal(first.error?.code, -32000, 'the failed commit leaves the edit unacknowledged');
  const delivered = storedWith(f, 'question_fixed');
  assert(isMarked(delivered), "the edit was delivered as the agent's first view");
  assert.equal(incomingAnchor(f)?.messageId, 'mb', 'an unacknowledged acceptance moves no anchor');
  const retry = await f.send('channels/incoming', { messages: [message] });
  // A second admission would replace the first attempt's delivery of a2
  // itself, and say so.
  assert.equal(retry.result.results[0].coalesce.outcome, 'replaced');
  assert.equal(retry.result.results[0].coalesce.priorEventId, 'a1', "the retry is answered from the first attempt's receipt");
  assert.equal(storedWith(f, 'question_fixed')?.id, delivered!.id, 'and delivers nothing again');
  assert(!('firstView' in retry.result.results[0]), "the host's mark isn't in the answer to the server");
  assert.equal(incomingAnchor(f)?.channelId, 'other', "the anchor moved to the edit's channel");
  assert.equal(incomingAnchor(f)?.messageId, 'ma', "and to the edit's message");
});

test("#157: a channel edit after an earlier edit that was the agent's first view, of a message the agent has since read, leaves context.incoming where it was", async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register(); await f.register('other');
  await f.send('channels/incoming', { messages: [f.channel('a1', 'question_wiht_typo', { initial: true }, 'other', 'ma')] });
  await f.send('channels/incoming', { messages: [f.channel('b1', 'unrelated', { initial: true }, 'chat', 'mb')] });
  await f.send('channels/incoming', { messages: [{ ...f.channel('a2', 'question_fixed', {}, 'other', 'ma'), tags: ['chat:edited'] }] });
  assert.equal(incomingAnchor(f)?.messageId, 'ma', "the first-view edit moved the anchor to its message");
  await f.send('channels/incoming', { messages: [f.channel('c1', 'later', { initial: true }, 'chat', 'mc')] });
  await f.framework.getAgent('agent')!.compileContext();
  // Each admission records only its own delivery's mark.
  const edit = await f.send('channels/incoming', { messages: [{ ...f.channel('a3', 'question_fixed_again', {}, 'other', 'ma'), tags: ['chat:edited'] }] });
  assert.equal(edit.result.results[0].coalesce.outcome, 'appended', 'the agent had read the edit');
  assert.equal(incomingAnchor(f)?.messageId, 'mc', 'the marker left the anchor at the later message');
});

test('#157: a channel edit of a message the agent has read leaves context.incoming where it was', async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => false } }); t.after(f.close); await f.register(); await f.register('other');
  await f.send('channels/incoming', { messages: [f.channel('a1', 'question_wiht_typo', { initial: true }, 'other', 'ma')] });
  await f.framework.getAgent('agent')!.compileContext();
  await f.send('channels/incoming', { messages: [f.channel('b1', 'unrelated', { initial: true }, 'chat', 'mb')] });
  const edit = await f.send('channels/incoming', { messages: [{ ...f.channel('a2', 'question_fixed', {}, 'other', 'ma'), tags: ['chat:edited'] }] });
  assert.equal(edit.result.results[0].coalesce.outcome, 'appended', 'the agent had read the question');
  assert.equal(incomingAnchor(f)?.messageId, 'mb', 'the marker left the anchor at the later message');
});

test("a receipt whose write failed is written by the producer's retry with the subject's batch as it is then, so records restored after a crash don't bring back a batch already rendered", async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [] });
  const records: CoalescingReceiptRecord[] = [];
  let failing = 1;
  p.host.recordReceipt = (record) => {
    if (failing > 0) { failing--; throw new Error('ENOSPC simulated'); }
    records.push(structuredClone(record));
  };
  await assert.rejects(p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true })), (error: { code?: number }) => error.code === -32000);
  // The accepted notice renders before the producer's retry comes.
  await p.coalescer.assemble('agent');
  assert.deepEqual(p.delivered, [{ eventId: 'n1', firstView: true }]);
  const retry = await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  assert.deepEqual(retry, { accepted: true, coalesce: { outcome: 'first' } }, "the retry answers the admission's result");
  assert.equal(records.length, 1, 'the retry wrote the record');
  // A crash before the throttled snapshot: only the record survives.
  const restored = new PushCoalescer<null>(p.host);
  restored.restoreReceipts(records);
  await restored.assemble('agent');
  assert.equal(p.delivered.length, 1, 'the rendered notice is not delivered again');
});

test("a receipt a retry writes while its batch renders records that batch, so a crash before the render's content is stored brings it back for its fallback", async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: ['n1'] });
  const records: CoalescingReceiptRecord[] = [];
  let failing = 1;
  p.host.recordReceipt = (record) => {
    if (failing > 0) { failing--; throw new Error('ENOSPC simulated'); }
    records.push(structuredClone(record));
  };
  await assert.rejects(p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true })), (error: { code?: number }) => error.code === -32000);
  const assembling = p.coalescer.assemble('agent');
  await p.renderStarted('n1');
  // The render-start snapshot, then the producer's retry while the render runs.
  const snapshot = p.coalescer.snapshot();
  const retry = await p.coalescer.accept(p.occurrence('n1', { deferred: true, initial: true }));
  assert.deepEqual(retry, { accepted: true, coalesce: { outcome: 'first' } });
  assert.equal(records.length, 1, 'the retry wrote the record');
  // A crash before the render's content is stored: the snapshot and the record survive.
  const restored = new PushCoalescer<null>(p.host);
  restored.restore(snapshot);
  restored.restoreReceipts(records);
  await restored.assemble('agent');
  assert.deepEqual(p.delivered.map((d) => d.eventId), ['n1'], 'the accepted notice comes back for its fallback');
  p.release('n1');
  await assembling;
});

test('a snapshot carries a receipt whose record was never written, so a coalescer restored from it answers the retry from that receipt', async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [], stored: ['p1'] });
  p.host.recordReceipt = () => { throw new Error('ENOSPC simulated'); };
  await assert.rejects(p.coalescer.accept(p.occurrence('p1', { initial: true })), (error: { code?: number }) => error.code === -32000);
  const snapshot = p.coalescer.snapshot();
  const restored = new PushCoalescer<null>({ ...p.host, recordReceipt: () => {} });
  restored.restore(snapshot);
  const retry = await restored.accept(p.occurrence('p1', { initial: true }));
  assert.deepEqual(retry, { accepted: true, coalesce: { outcome: 'first' } });
  assert.deepEqual(p.delivered, [{ eventId: 'p1' }], 'delivered once');
});

test("a retry's record for a subject evicted since its admission says nothing of the subject's birth", async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [], stored: ['p1', 'q1'] });
  const records: CoalescingReceiptRecord[] = [];
  let failing = 1;
  p.host.recordReceipt = (record) => {
    if (failing > 0) { failing--; throw new Error('ENOSPC simulated'); }
    records.push(structuredClone(record));
  };
  const coalescer = new PushCoalescer<null>(p.host, { maxSubjects: 1 });
  await assert.rejects(coalescer.accept(p.occurrence('p1', { initial: true })), (error: { code?: number }) => error.code === -32000);
  // Read, then withdrawn with nothing to say: the subject is idle.
  state.read = true;
  assert.equal((await coalescer.accept(p.occurrence('r1', { retract: true, content: [] }))).coalesce?.outcome, 'consumed');
  state.read = false;
  // A second subject evicts it.
  await coalescer.accept({ ...p.occurrence('q1', { initial: true }), key: 'other' });
  const retry = await coalescer.accept(p.occurrence('p1', { initial: true }));
  assert.deepEqual(retry, { accepted: true, coalesce: { outcome: 'first' } });
  const rewritten = records.find((r) => r.key.includes('"p1"'));
  assert.ok(rewritten, 'the retry wrote the record');
  assert.equal(rewritten.born, undefined, 'no birth: the subject is untracked now');
});

test('an admission whose receipt is never written is observed once, after its effects', async () => {
  const state = { shown: false, read: false };
  const p = firstViewProbe(state, { held: [], stored: ['p1'] });
  const observed: string[] = [];
  const deliveredWhenObserved: number[] = [];
  p.host.accepted = (occurrence) => { observed.push(occurrence.eventId); deliveredWhenObserved.push(p.delivered.length); };
  p.host.recordReceipt = () => { throw new Error('ENOSPC simulated'); };
  for (let attempt = 0; attempt < 6; attempt++) {
    await assert.rejects(p.coalescer.accept(p.occurrence('p1', { initial: true })), (error: { code?: number }) => error.code === -32000);
  }
  assert.deepEqual(p.delivered, [{ eventId: 'p1' }], 'delivered once');
  assert.deepEqual(observed, ['p1'], 'observed once, though no write landed');
  assert.deepEqual(deliveredWhenObserved, [1], 'after its delivery');
});

// ---------------------------------------------------------------------------
// A wake the scheduler merged, taken back before its turn starts, is merged
// again from the wakes it took in
// ---------------------------------------------------------------------------

type MergedWakeInternals = {
  withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>, model?: string): Promise<T>;
  providerGate(agent: string): { idleWaiters: Array<() => void> };
  providerAccelerationCooldowns: Map<string, { heldRequests: Wake[] }>;
  pendingRequests: Wake[];
};

const statedWait = (retryAfterMs: number) => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs,
  message: 'rate limit reached', rawError: { status: 429 },
} as ConstructorParameters<typeof MembraneError>[0]);

function auxiliaryCall(f: Fixture) {
  let settle!: (error?: Error) => void;
  const done = (f.framework as unknown as MergedWakeInternals).withAuxiliaryAdmission('agent', () => new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve());
  }), 'test').catch(() => {});
  return { end: (error?: Error): Promise<void> => { settle(error); return done; } };
}

const heldWakes = (f: Fixture): Wake[] => (f.framework as unknown as MergedWakeInternals).providerAccelerationCooldowns.get('agent')?.heldRequests ?? [];

async function mergedWakeParked(f: Fixture) {
  const auxiliary = auxiliaryCall(f);
  await f.send('push/event', f.params('a1', 'batch_a', { deferred: true, initial: true, key: 'docA' }));
  await f.send('push/event', f.params('b1', 'batch_b', { deferred: true, initial: true, key: 'docB' }));
  await settles(f.framework.runUntilIdle(), 'the merged wake parking');
  assert.equal((f.framework as unknown as MergedWakeInternals).providerGate('agent').idleWaiters.length, 1, 'one wake parked behind the auxiliary call');
  return auxiliary;
}

async function mergedWakeHeld(f: Fixture) {
  await (await mergedWakeParked(f)).end(statedWait(60_000));
  await eventually(() => heldWakes(f).length === 1, 'the merged wake held at its last admission boundary');
  assert.equal(heldWakes(f)[0]!.coalescingBatchSubjects?.length, 2, 'the held wake stands for both batches');
}

const retract = async (f: Fixture, key: string) =>
  assert.equal((await f.send('push/event', f.params(`${key}-gone`, 'gone', { retract: true, key }))).result.coalesce.outcome, 'retracted');

function withdrawnTurns(f: Fixture) {
  const traced: Array<{ agentName?: string; subjects?: string[] }> = [];
  f.framework.onTrace((e) => {
    if (e.type === 'mcpl:coalescing' && (e as { kind?: string }).kind === 'turn-withdrawn') traced.push(e as { agentName?: string; subjects?: string[] });
  });
  return traced;
}

function stderrLines(t: TestContext) {
  const lines: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); write(...args); };
  t.after(() => { console.error = write; });
  return lines;
}

const holdReleased = (f: Fixture) =>
  assert.ok(!(f.framework as unknown as MergedWakeInternals).providerAccelerationCooldowns.has('agent'), 'the hold released');

test('a wake merged from two deferred batches and held by a stated wait is withdrawn with them, traced turn-withdrawn, and its hold releases with no turn', async (t) => {
  const f = await fixture(); t.after(f.close);
  const withdrawn = withdrawnTurns(f);
  const stderr = stderrLines(t);
  await mergedWakeHeld(f);
  assert.equal(f.framework.getHostModeStatus().gatedRequests, 2, 'the held wake counts as the two wakes it took in');
  const subjects = heldWakes(f)[0]!.coalescingBatchSubjects!;
  await retract(f, 'docA');
  await retract(f, 'docB');
  assert.equal(withdrawn.length, 1, 'traced as a withdrawn turn when the last batch goes');
  assert.equal(withdrawn[0]!.agentName, 'agent');
  assert.deepEqual([...withdrawn[0]!.subjects!].sort(), [...subjects].sort(), 'naming both batches');
  f.framework.releaseProviderWait('agent');
  await settles(f.framework.runUntilIdle(), 'the pass after the release');
  holdReleased(f);
  assert.equal(f.membrane.calls.length, 0, 'no model call: the wake has nothing left to read');
  assert.ok(stderr.some((line) => line.includes('agent=agent hold, its held wakes withdrawn, released')), 'the release says its wakes were withdrawn');
});

test('a wake merged from two deferred batches and sent back by a quiesce while it waited for an auxiliary call starts no turn once both batches are withdrawn', async (t) => {
  const f = await fixture(); t.after(f.close);
  const auxiliary = await mergedWakeParked(f);
  const quiescing = f.framework.quiesce({ reason: 'test' });
  await auxiliary.end();
  await quiescing;
  assert.equal(f.framework.getHostModeStatus().parkedAdmissions, 0, 'the wake left its park');
  await f.framework.resume();
  assert.equal((f.framework as unknown as MergedWakeInternals).pendingRequests.length, 1, 'the wake waits whole in the queue: no pass has taken it since the resume');
  await retract(f, 'docA');
  await retract(f, 'docB');
  await settles(f.framework.runUntilIdle(), 'the pass after the resume');
  assert.equal(f.membrane.calls.length, 0, 'no model call: the wake has nothing left to read');
});

test('a wake merged from two deferred batches and held by a stated wait is withdrawn at its turn\'s start when neither batch renders anything', async (t) => {
  const f = await fixture(); t.after(f.close);
  const withdrawn = withdrawnTurns(f);
  f.renderer(async () => ({ content: [] }));
  await mergedWakeHeld(f);
  const subjects = heldWakes(f)[0]!.coalescingBatchSubjects!;
  f.framework.releaseProviderWait('agent');
  await settles(f.framework.runUntilIdle(), 'the pass after the release');
  assert.equal(f.membrane.calls.length, 0, 'no model call: neither batch gave the turn anything to read');
  assert.equal(withdrawn.length, 1, 'traced as a withdrawn turn');
  assert.deepEqual([...withdrawn[0]!.subjects!].sort(), [...subjects].sort(), 'naming both batches');
});

test('a wake merged from two deferred batches and held by a stated wait renders both at its turn once the wait is released', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.renderer(async (params) => ({ content: [{ type: 'text', text: `rendered_${String(params.key)}` }] }));
  await mergedWakeHeld(f);
  f.framework.releaseProviderWait('agent');
  await settles(f.framework.runUntilIdle(), 'the turn after the release');
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('rendered_docA') && f.lastRequest().includes('rendered_docB'), 'both batches rendered into the turn');
});

test('a deferred batch\'s wake held by a stated wait starts no turn once its batch is withdrawn', async (t) => {
  const f = await fixture(); t.after(f.close);
  await auxiliaryCall(f).end(statedWait(60_000));
  await f.send('push/event', f.params('a1', 'batch_a', { deferred: true, initial: true, key: 'docA' }));
  await settles(f.framework.runUntilIdle(), 'the wake held');
  assert.equal(heldWakes(f).length, 1, 'the wake is held by the wait');
  const stderr = stderrLines(t);
  await retract(f, 'docA');
  f.framework.releaseProviderWait('agent');
  await settles(f.framework.runUntilIdle(), 'the pass after the release');
  holdReleased(f);
  assert.equal(f.membrane.calls.length, 0, 'no model call: nothing is left for a turn to read');
  assert.ok(stderr.some((line) => line.includes('agent=agent hold, its held wakes withdrawn, released')), 'the release says its wakes were withdrawn');
});
