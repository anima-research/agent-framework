/**
 * RFC-006 event coalescing (mcpl PR #5, revision 7) — wire-level tests over a
 * real loopback WebSocket MCPL server and a mock model provider.
 *
 * Vector numbers refer to RFC-006 §14.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockResponse } from './helpers/mock-membrane.js';
import { fixture, eventually, crash, ok, TS } from './helpers/coalescing-fixture.js';

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

test('a retraction withdraws the unstarted wake its subject queued', async (t) => {
  const f = await fixture({ server: { shouldTriggerInference: () => true } }); t.after(f.close);
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  await f.send('push/event', f.params('1', 'withdrawn', { initial: true }));
  assert.equal(internals.pendingRequests.length, 1);
  await f.send('push/event', f.params('2', 'gone', { retract: true }));
  assert.equal(internals.pendingRequests.length, 0);
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
  assert.equal(internals.pendingRequests.length, 0, 'a non-qualifying replacement withdraws the wake');
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
  assert(!f.lastRequest().includes('fallback'));
});

test('vectors 21/23: a render past the deadline materializes the fallback; the late result is discarded', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.renderer(async () => { await new Promise((r) => setTimeout(r, 5300)); return { content: [{ type: 'text', text: 'wire_late_payload' }] }; });
  await f.send('push/event', f.params('1', 'bounded_fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('bounded_fallback') && !f.lastRequest().includes('wire_late_payload'));
  await new Promise((r) => setTimeout(r, 400));
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
      const req = f.lastRequest();
      assert(!req.includes('late_old_render') && !req.includes('fallback_one') && !req.includes('deletion_notice'));
      if (operation === 'plain') assert(req.includes('complete_snapshot'));
    } finally { await f.close(); }
  }
});

test('vector 24: revoked authority before assembly drops the batch without a render', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'previously_permitted', { deferred: true }));
  await f.framework.stop(); await f.create(false);
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0);
  assert(!f.context().includes('previously_permitted'));
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
  f.disconnect();
  await eventually(() => f.hostCaps.length === 2, 'reconnect');
  await new Promise((r) => setTimeout(r, 100));
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
  const f = await fixture({ framework: { gate: { config: { policies: [{ name: 'attention', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }], default: 'skip' } } } as never }); t.after(f.close); await f.register();
  const msg = (i: number | string, tags: string[]) => ({ channelId: 'chat', messageId: 'm' + i, eventId: 'e' + i, timestamp: TS, author: { id: 'u', name: 'User' }, tags,
    content: [{ type: 'text', text: 'text_' + i }], coalesce: { key: 'message:m' + i, initial: true } });
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    const r = await f.send('channels/incoming', { messages: [msg(i, [])] });
    assert.equal(r.result.results[0].accepted, true);
  }
  const elapsed = Date.now() - t0;
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
  const mention = await f.send('channels/incoming', { messages: [msg('mention', ['chat:mention'])] });
  assert.equal(mention.result.results[0].accepted, true);
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1);
  assert(f.lastRequest().includes('text_mention') && f.lastRequest().includes('text_0'));
  // Each acceptance awaits a group-committed fsync (RFC-006 durability); serial
  // sends cannot batch, so this is ~300 fsyncs. Bounded, and reported.
  console.log(`# 300 serial coalesced channel messages: ${elapsed}ms (${(elapsed / 300).toFixed(1)} ms/msg incl. fsync)`);
  assert(elapsed < 30_000, `300 coalesced messages took ${elapsed}ms`);
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
  const internals = f.framework as unknown as { activeTurnTokens: Map<string, number>; deferredMessages: unknown[] };
  internals.activeTurnTokens.set('agent', 100);
  await f.send('push/event', f.params('1', 'queued_original', { initial: true }));
  const r = await f.send('push/event', f.params('2', 'queued_replacement'));
  assert.equal(r.result.coalesce.outcome, 'replaced');
  assert.equal(internals.deferredMessages.length, 1);
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
  const router = (f.framework as unknown as { conversationRouter: { getBinding(id: string): { agentName: string } | undefined; unbind(id: string): void } }).conversationRouter;
  const g1 = router.getBinding('chat')!.agentName;
  router.unbind('chat');
  const edit = await f.send('push/event', f.params('e', 'fork_edit', { channelId: 'chat', key: 'message:m' }));
  assert.equal(edit.result.coalesce.outcome, 'replaced');
  assert.equal(router.getBinding('chat'), undefined, 'no fresh fork was spawned for the edit');
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
  const router = (f.framework as unknown as { conversationRouter: { getBinding(id: string): { agentName: string } | undefined } }).conversationRouter;
  const fork = router.getBinding('chat')?.agentName;
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

test('G9: a receipt is durable before the acceptance is acknowledged', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('durable', 'x', { initial: true }));
  const store = (f.framework as unknown as { store: { getStateJson(id: string): unknown } }).store;
  const recent = store.getStateJson('mcpl/coalescing-recent') as Array<{ key: string; born?: string }>;
  assert.equal(recent.length, 1);
  assert(recent[0].key.includes('"durable"'));
  assert.equal(recent[0].born, 'none');
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
  assert(!f.lastRequest().includes('late') && !f.lastRequest().includes('fallback'));
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
  const router = (f.framework as unknown as { conversationRouter: { getBinding(id: string): { agentName: string } | undefined; unbind(id: string): void } }).conversationRouter;
  const g1 = router.getBinding('chat')!.agentName;
  router.unbind('chat');
  const r = await f.send('push/event', f.params('n', 'fallback', { deferred: true, channelId: 'chat', key: 'message:m' }));
  assert.equal(r.result.coalesce.outcome, 'replaced');
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert.equal(router.getBinding('chat'), undefined, 'no fresh fork');
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
  assert(!f.context().includes('withdrawn_fallback') && !f.lastRequest().includes('document_diff'), 'nothing of the withdrawn batch was published');
  const renders = f.renders.length;
  await f.turn();
  assert.equal(f.renders.length, renders, 'and nothing renders later');
  assert(!f.context().includes('withdrawn_fallback') && !f.context().includes('document_diff'));
});

test('R12: endpoint reassignment during the render-start commit wait never sends the batch to the new peer', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'old_fallback', { deferred: true, data: { secret: 'private_notice_data' } }));
  const held = holdNextCommit(f);
  const run = f.framework.runUntilIdle();
  const release = await held;
  const config = (f.framework as unknown as { mcplServerConfigs: Map<string, { url: string }> }).mcplServerConfigs.get('editor')!;
  await f.framework.restartMcplServer('editor', { ...config, url: `${config.url}/reassigned` } as never);
  await eventually(() => f.hostCaps.length === 2, 'reconnect to the new endpoint');
  release();
  await run;
  assert.equal(f.renders.length, 0, 'no push/render to the new peer');
  assert(!JSON.stringify(f.renders).includes('private_notice_data'));
  assert(!f.context().includes('old_fallback'));
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

test('R16: a batch whose render-start commit failed is re-woken once storage recovers', async (t) => {
  const f = await fixture(); t.after(f.close);
  const coalescer = (f.framework as unknown as { pushCoalescer: { options: { recoveryBackoffMs?: number }; pendingBatches(): number } }).pushCoalescer;
  coalescer.options.recoveryBackoffMs = 50;
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  const store = (f.framework as unknown as { store: { sync: () => void } }).store;
  const orig = store.sync.bind(store);
  let failing = 0;
  store.sync = () => { if (failing > 0) { failing--; throw new Error('EIO simulated'); } orig(); };
  await f.send('push/event', f.params('1', 'asleep_fallback', { deferred: true, initial: true }));
  failing = 1; // the render-start commit fails; storage then recovers
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0);
  assert.equal(coalescer.pendingBatches(), 1, 'the batch is kept');
  assert(!f.lastRequest().includes('asleep_fallback'));
  await eventually(() => internals.pendingRequests.length > 0, 'recovery wake');
  await f.turn();
  assert(f.lastRequest().includes('asleep_fallback'), 'delivered without unrelated traffic');
  assert.equal(coalescer.pendingBatches(), 0);
});

test('R16b: a producer retry re-wakes a batch left asleep by a failed freeze', async (t) => {
  const f = await fixture(); t.after(f.close);
  const coalescer = (f.framework as unknown as { pushCoalescer: { options: { recoveryBackoffMs?: number }; pendingBatches(): number } }).pushCoalescer;
  coalescer.options.recoveryBackoffMs = 600_000; // park the timer; the retry must do it
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  const store = (f.framework as unknown as { store: { sync: () => void } }).store;
  const orig = store.sync.bind(store);
  let failing = 0;
  store.sync = () => { if (failing > 0) { failing--; throw new Error('EIO simulated'); } orig(); };
  const params = f.params('1', 'asleep_fallback', { deferred: true, initial: true });
  const first = await f.send('push/event', params);
  failing = 1;
  await f.framework.runUntilIdle();
  assert.equal(internals.pendingRequests.length, 0, 'asleep');
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, first.result);
  assert.equal(internals.pendingRequests.length, 1, 'the retry re-woke it');
  await f.turn();
  assert(f.lastRequest().includes('asleep_fallback'));
});

test('R17: a persistent storage outage backs off (1×, 2×, 4× …) and the series resets on recovery', async (t) => {
  const f = await fixture(); t.after(f.close);
  const coalescer = (f.framework as unknown as { pushCoalescer: { options: { recoveryBackoffMs?: number }; pendingBatches(): number; recovery: Map<string, { attempt: number; timer?: unknown }> } }).pushCoalescer;
  coalescer.options.recoveryBackoffMs = 40;
  const internals = f.framework as unknown as { pendingRequests: unknown[] };
  const store = (f.framework as unknown as { store: { sync: () => void } }).store;
  const orig = store.sync.bind(store);
  let failing = false;
  store.sync = () => { if (failing) throw new Error('EIO persistent'); orig(); };
  const wakes: Array<{ attempt: number; delayMs: number }> = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:coalescing' && (e as { kind?: string }).kind === 'recovery-wake') wakes.push(e as never); });
  await f.send('push/event', f.params('1', 'outage_fallback', { deferred: true, initial: true }));
  failing = true;
  f.alwaysRespond();
  for (let i = 0; i < 3; i++) {
    await f.framework.runUntilIdle(); // freeze fails → recovery scheduled
    await eventually(() => internals.pendingRequests.length > 0, `recovery wake ${i + 1}`);
  }
  assert.deepEqual(wakes.map((w) => w.attempt), [1, 2, 3], 'consecutive failures count up');
  assert.deepEqual(wakes.map((w) => w.delayMs), [40, 80, 160], 'and the delay doubles');
  assert.equal(coalescer.pendingBatches(), 1);
  assert(!f.context().includes('outage_fallback'));
  failing = false; // storage recovers
  await f.framework.runUntilIdle();
  assert(f.lastRequest().includes('outage_fallback'), 'delivered once storage recovered');
  assert.equal(coalescer.pendingBatches(), 0);
  assert.equal(coalescer.recovery.size, 0, 'the failure series is forgotten on success');
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
