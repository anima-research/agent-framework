/**
 * A coalesced occurrence is admitted exactly as an uncoalesced message is
 * (agent-framework#266).
 *
 * RFC-006 keeps content in context: a plain coalesced occurrence is delivered
 * through the ordinary channel/push path the moment it is admitted, and the
 * coalescer only remembers where it landed. So the `coalesce` member must not
 * decide whether a message carrying an image is admitted. A 1 MiB
 * serialized-content budget on the coalesced path alone dropped every Discord
 * message with a screenshot, silently on the host.
 *
 * Also: every coalesce rejection is visible on the host (a console line and a
 * trace naming the field), not only on the wire.
 *
 * Run: node --import tsx --test test/mcpl-coalesced-content-parity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TS } from './helpers/coalescing-fixture.js';

/** Base64 for an image well over 1 MiB once serialized (a Retina screenshot). */
const BIG_IMAGE = { type: 'image', data: 'A'.repeat(1_600_000), mimeType: 'image/png' };

type Rejection = { type: string; reason?: string; field?: string; detail?: string; messageId?: string; eventId?: string };

function captureConsoleError(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  return lines;
}

test('#266 repro: a coalesced channel message with a >1 MiB inline image is admitted and stored, as an uncoalesced one is', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const coalesced = { ...f.channel('e1', '', { initial: true }, 'chat', 'shot'), content: [{ type: 'text', text: 'look_at_this' }, BIG_IMAGE] };
  const plain = {
    channelId: 'chat', messageId: 'plain', timestamp: TS, author: { id: 'u', name: 'User' },
    content: [{ type: 'text', text: 'plain_with_image' }, BIG_IMAGE],
  };
  const r = await f.send('channels/incoming', { messages: [coalesced, plain] });
  assert.deepEqual(r.result.results.map((x: { accepted: boolean }) => x.accepted), [true, true]);
  assert.equal(r.result.results[0].coalesce?.outcome, 'first');
  await f.framework.runUntilIdle();
  const context = f.context();
  assert(context.includes('look_at_this'), 'the coalesced message is stored');
  assert(context.includes('plain_with_image'), 'the uncoalesced one too');
  const images = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as { type?: string }).type === 'image');
  assert.equal(images.length, 2, 'both messages keep their image');
});

test('#266: a coalesced push/event with a >1 MiB inline image is admitted and stored', async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = { ...f.params('p1', '', { initial: true }), payload: { content: [{ type: 'text', text: 'pushed_with_image' }, BIG_IMAGE] } };
  const r = await f.send('push/event', params);
  assert.equal(r.error, undefined);
  assert.equal(r.result.accepted, true);
  assert.equal(r.result.coalesce.outcome, 'first');
  await f.framework.runUntilIdle();
  assert(f.context().includes('pushed_with_image'));
});

test('#266: a render result carrying a >1 MiB image is delivered, not replaced by the fallback (RFC-006 §5.2)', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.renderer(async () => ({ content: [{ type: 'text', text: 'rendered_with_image' }, BIG_IMAGE] }));
  await f.send('push/event', f.params('d1', 'render_fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  const context = f.context();
  assert(context.includes('rendered_with_image'), 'the rendered content is delivered');
  assert(!context.includes('render_fallback'), 'not the fallback');
});

test('#266: a malformed coalesced channel item is refused on the wire and named on the host', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:channel-incoming-rejected') rejected.push(e); });
  const badBlock = { ...f.channel('e1', '', { initial: true }, 'chat', 'bad'), content: [{ type: 'image', mimeType: 'image/png' }] };
  const noEventId = { ...f.channel('e2', 'no_event_id', { initial: true }, 'chat', 'noid'), eventId: undefined };
  const noMessageId = { ...f.channel('e3', 'no_message_id', { initial: true }, 'chat', 'x'), messageId: undefined };
  const r = await f.send('channels/incoming', { messages: [badBlock, noEventId, noMessageId] });
  assert.deepEqual(r.result.results.map((x: { reason?: string }) => x.reason), ['coalesce_invalid', 'coalesce_invalid', 'coalesce_invalid'], 'the wire is unchanged');
  assert.deepEqual(
    rejected.map(({ reason, field, messageId }) => ({ reason, field, messageId })),
    [
      { reason: 'coalesce-invalid', field: 'payload.content', messageId: 'bad' },
      { reason: 'coalesce-invalid', field: 'eventId', messageId: 'noid' },
      { reason: 'coalesce-invalid', field: 'messageId', messageId: undefined },
    ],
  );
  assert(rejected.every((e) => typeof e.detail === 'string' && e.detail.length > 0), 'each says why');
  assert(lines.some((l) => l.includes('[channel-incoming-rejected]') && l.includes('messageId=bad') && l.includes('reason=coalesce-invalid') && l.includes('field=payload.content')));
  assert(lines.some((l) => l.includes('[channel-incoming-rejected]') && l.includes('messageId=noid') && l.includes('field=eventId')));
});

test('#266: a malformed coalesced push is a -32602 on the wire and named on the host', async (t) => {
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:push-event-rejected') rejected.push(e); });
  const badBlock = { ...f.params('b1', ''), payload: { content: [{ type: 'text' }] } };
  const badKey = f.params('b2', 'text', { key: 'k'.repeat(257) });
  const first = await f.send('push/event', badBlock);
  const second = await f.send('push/event', badKey);
  assert.equal(first.error?.code, -32602);
  assert.equal(second.error?.code, -32602);
  assert.deepEqual(
    rejected.map(({ reason, field, eventId }) => ({ reason, field, eventId })),
    [
      { reason: 'coalesce-invalid', field: 'payload.content', eventId: 'b1' },
      { reason: 'coalesce-invalid', field: 'coalesce.key', eventId: 'b2' },
    ],
  );
  assert(lines.some((l) => l.includes('[push-event-rejected]') && l.includes('eventId=b1') && l.includes('reason=coalesce-invalid') && l.includes('field=payload.content')));
  assert(lines.some((l) => l.includes('[push-event-rejected]') && l.includes('eventId=b2') && l.includes('field=coalesce.key')));
});

test('#266: a coalescer failure is traced as the host\'s (coalesce-failed), as the wire answers it, not as the sender\'s malformed item', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => {
    if (e.type === 'mcpl:channel-incoming-rejected' || e.type === 'mcpl:push-event-rejected') rejected.push(e);
  });
  // The coalescer itself throws a plain Error (no code) for well-formed items.
  (f.framework as unknown as { pushCoalescer: { accept: () => Promise<never> } }).pushCoalescer.accept =
    async () => { throw new Error('coalescer_broke'); };
  const channel = await f.send('channels/incoming', { messages: [f.channel('c1', 'fine_text', { initial: true }, 'chat', 'fine')] });
  assert.deepEqual(channel.result.results[0], { messageId: 'fine', accepted: false, reason: 'coalescer_broke' }, 'the wire calls it a failure');
  const push = await f.send('push/event', f.params('p1', 'fine_push', { initial: true }));
  assert.equal(push.error?.code, -32603, 'the wire calls it a failure');
  assert.deepEqual(
    rejected.map(({ type, reason, detail }) => ({ type, reason, detail })),
    [
      { type: 'mcpl:channel-incoming-rejected', reason: 'coalesce-failed', detail: 'coalescer_broke' },
      { type: 'mcpl:push-event-rejected', reason: 'coalesce-failed', detail: 'coalescer_broke' },
    ],
  );
  assert(lines.some((l) => l.includes('[channel-incoming-rejected]') && l.includes('reason=coalesce-failed')));
  assert(lines.some((l) => l.includes('[push-event-rejected]') && l.includes('reason=coalesce-failed')));
});
