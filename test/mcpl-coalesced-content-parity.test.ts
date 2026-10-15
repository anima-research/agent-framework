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
import { RefusalLines } from '../src/mcpl/refusal-lines.js';

/** Base64 for an image well over 1 MiB once serialized (a Retina screenshot). */
const BIG_IMAGE = { type: 'image', data: 'A'.repeat(1_600_000), mimeType: 'image/png' };

type Rejection = { type: string; reason?: string; field?: string; detail?: string; messageId?: string; eventId?: string; channelId?: string };

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The agent's context keeps `count` images, each BIG_IMAGE with its data whole: stored, not only accepted. */
function assertKeepsBigImage(f: Fixture, count: number): void {
  const images = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as { type?: string }).type === 'image') as Array<{ source?: unknown }>;
  assert.equal(images.length, count, `${count} image(s) stored`);
  for (const image of images) {
    assert.deepEqual(image.source, { type: 'base64', data: BIG_IMAGE.data, mediaType: BIG_IMAGE.mimeType }, 'the image data arrives whole');
  }
}

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
  assertKeepsBigImage(f, 2);
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
  assertKeepsBigImage(f, 1);
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
  assertKeepsBigImage(f, 1);
});

test('#266: a malformed coalesced channel item is refused on the wire and named on the host', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:channel-incoming-rejected') rejected.push(e); });
  const badBlock = { ...f.channel('e1', '', { initial: true }, 'chat', 'bad'), content: ['not-a-block'] };
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
  const badBlock = { ...f.params('b1', ''), payload: { content: ['not-a-block'] } };
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
  const [channelTrace, pushTrace] = rejected as Array<Rejection & { channelId?: string; featureSet?: string }>;
  assert.equal(channelTrace.channelId, 'chat', 'the channel trace names its channel');
  assert.equal(pushTrace.featureSet, 'doc', 'the push trace names its feature set');
  assert(rejected.every((e) => !('field' in e)), 'a plain Error has no field');
  assert(lines.some((l) => l.includes('[channel-incoming-rejected]') && l.includes('reason=coalesce-failed')));
  assert(lines.some((l) => l.includes('[push-event-rejected]') && l.includes('reason=coalesce-failed')));
});

test('a push the coalescer can\'t take (-32000, coalescing unavailable) is the host\'s failure on both lanes', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const lines = captureConsoleError(t);
  const rejected: Array<Rejection & { type: string }> = [];
  f.framework.onTrace((e) => {
    if (e.type === 'mcpl:channel-incoming-rejected' || e.type === 'mcpl:push-event-rejected') rejected.push(e);
  });
  (f.framework as unknown as { pushCoalescer: unknown }).pushCoalescer = null;
  const channel = await f.send('channels/incoming', { messages: [f.channel('c1', 'fine_text', { initial: true }, 'chat', 'fine')] });
  assert.deepEqual(channel.result.results[0], { messageId: 'fine', accepted: false, reason: 'coalescing unavailable' });
  const push = await f.send('push/event', f.params('p1', 'fine_push', { initial: true }));
  assert.equal(push.error?.code, -32000);
  assert.deepEqual(
    rejected.map(({ type, reason, field }) => ({ type, reason, field })),
    [
      { type: 'mcpl:channel-incoming-rejected', reason: 'coalesce-failed', field: 'coalesce' },
      { type: 'mcpl:push-event-rejected', reason: 'coalesce-failed', field: 'coalesce' },
    ],
  );
  assert(lines.some((l) => l.startsWith('[push-event-rejected]') && l.includes('reason=coalesce-failed field=coalesce: "coalescing unavailable"')));
});

test('a channel-scoped push the sender may not make is the sender\'s refusal (coalesce-invalid), as the wire answers it', async (t) => {
  // -32023: the channel isn't one the server declared.
  const f = await fixture(); t.after(f.close);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:push-event-rejected') rejected.push(e); });
  const unknown = await f.send('push/event', f.params('u1', 'to_nowhere', { initial: true, channelId: 'nope' }));
  assert.equal(unknown.error?.code, -32023);
  // -32017: the server has no channels.incoming grant.
  const g = await fixture({ server: { disabledCapabilities: ['channels.incoming'] } }); t.after(g.close);
  g.framework.onTrace((e) => { if (e.type === 'mcpl:push-event-rejected') rejected.push(e); });
  const denied = await g.send('push/event', g.params('d1', 'not_permitted', { initial: true, channelId: 'chat' }));
  assert.equal(denied.error?.code, -32017);
  assert.deepEqual(
    rejected.map(({ reason, field, eventId }) => ({ reason, field, eventId })),
    [
      { reason: 'coalesce-invalid', field: 'coalesce.channelId', eventId: 'u1' },
      { reason: 'coalesce-invalid', field: 'coalesce.channelId', eventId: 'd1' },
    ],
  );
});

test('a block the converters can\'t render is admitted coalesced exactly as uncoalesced: a placeholder, not a refusal', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const odd = [
    [{ type: 'video', uri: 'https://example.invalid/v.mp4' }],
    [{ type: 'mystery' }],
    [{ type: 'image', mimeType: 'image/png' }],
  ];
  const messages = odd.flatMap((content, i) => [
    { ...f.channel(`e${i}`, '', { initial: true }, 'chat', `coalesced${i}`), content },
    { channelId: 'chat', messageId: `plain${i}`, timestamp: TS, author: { id: 'u', name: 'User' }, content },
  ]);
  const r = await f.send('channels/incoming', { messages });
  assert.deepEqual(r.result.results.map((x: { accepted: boolean }) => x.accepted), messages.map(() => true));
  for (const [i, content] of odd.entries()) {
    const push = await f.send('push/event', { ...f.params(`p${i}`, '', { initial: true, key: `doc${i}` }), payload: { content } });
    assert.equal(push.error, undefined, JSON.stringify(content));
    assert.equal(push.result.accepted, true);
  }
});

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('a block whose type, text or source isn\'t a string converts on both lanes, coalesced or not, without stopping a batch', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  f.alwaysRespond();
  // What isn't a string is left out of the block. An object whose toString
  // isn't a function throws when converted to text, as a placeholder would.
  // `shows` is what the context then holds for it. Each of text, data,
  // mimeType and uri also takes an array, a number and null.
  const odd = (marker: string) => [{ toString: 1 }, [marker], 424242, null];
  const malformed: Array<{ content: unknown[]; shows: string }> = [
    { content: [{ type: { toString: 1 } }], shows: '[unrecognized content block: untyped]' },
    { content: [{ type: 7 }], shows: '[unrecognized content block: untyped]' },
    ...odd('array_data').map((data) => ({ content: [{ type: 'image', data, mimeType: 'image/png' }], shows: '[Image: no data]' })),
    ...odd('array_uri').map((uri) => ({ content: [{ type: 'image', uri }], shows: '[Image: no data]' })),
    // Data whose media type is unusable is named as such, not as no data.
    ...odd('array_mime').map((mimeType) => ({ content: [{ type: 'image', data: 'AAAA', mimeType }], shows: '[Image: no media type]' })),
    ...odd('array_mime').map((mimeType) => ({ content: [{ type: 'audio', data: 'AAAA', mimeType }], shows: '[Audio: no media type]' })),
    ...odd('array_text').map((text, i) => ({
      content: [{ type: 'text', text }, { type: 'text', text: `beside_text_without_text_${i}` }], shows: `beside_text_without_text_${i}`,
    })),
    // Reference-shaped: a uri that isn't a non-empty string never makes a
    // reference, with a disposition or without.
    { content: [{ type: 'resource', uri: 424242 }], shows: '[unrecognized content block: reference without string uri]' },
    { content: [{ type: 'image', uri: 424242, disposition: 'ref' }], shows: '[Image: no data]' },
    { content: [{ type: 'image', uri: '', disposition: 'ref' }], shows: '[Image: no data]' },
    { content: [{ type: 'audio', uri: { toString: 1 }, disposition: 'ref' }], shows: '[Audio: no data]' },
  ];
  const messages: unknown[] = malformed.flatMap(({ content }, i) => [
    { ...f.channel(`e${i}`, '', { initial: true }, 'chat', `coalesced${i}`), content },
    { channelId: 'chat', messageId: `plain${i}`, timestamp: TS, author: { id: 'u', name: 'User' }, content },
  ]);
  // A valid message after them all, which a throw in conversion never reached.
  messages.push(f.channel('last', 'sibling_after_malformed', { initial: true }, 'chat', 'last'));
  const r = await f.send('channels/incoming', { messages });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.result.results.map((x: { accepted: boolean }) => x.accepted), messages.map(() => true));
  for (const [i, { content }] of malformed.entries()) {
    const coalesced = await f.send('push/event', { ...f.params(`p${i}`, '', { initial: true, key: `doc${i}` }), payload: { content } });
    assert.equal(coalesced.error, undefined, JSON.stringify(content));
    assert.equal(coalesced.result.accepted, true);
    const { coalesce: _coalesce, ...uncoalesced } = f.params(`q${i}`, '');
    const plain = await f.send('push/event', { ...uncoalesced, payload: { content } });
    assert.equal(plain.error, undefined, JSON.stringify(content));
    assert.equal(plain.result.accepted, true);
  }
  await f.framework.runUntilIdle();
  const context = f.context();
  assert(context.includes('sibling_after_malformed'), 'the batch went on past the malformed messages');
  // Each malformed block, four times: coalesced and not, on each lane.
  for (const shows of new Set(malformed.map((m) => m.shows))) {
    const expected = malformed.filter((m) => m.shows === shows).length * 4;
    assert.equal(occurrences(context, JSON.stringify(shows)), expected, shows);
  }
  for (const leaked of ['toString', 'array_', '424242']) assert(!context.includes(leaked), `nothing that was not a string reaches the context (${leaked})`);
});

test('a text block whose text isn\'t a string is no text, so alone it is refused as empty on both lanes, coalesced or not', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const content = [{ type: 'text', text: { toString: 1 } }];
  const r = await f.send('channels/incoming', { messages: [
    { ...f.channel('e1', '', { initial: true }, 'chat', 'coalesced'), content },
    { channelId: 'chat', messageId: 'plain', timestamp: TS, author: { id: 'u', name: 'User' }, content },
  ] });
  assert.deepEqual(r.result.results.map((x: { accepted: boolean; reason?: string }) => [x.accepted, x.reason]),
    [[false, 'empty_content'], [false, 'empty_content']]);
  const coalesced = await f.send('push/event', { ...f.params('p1', '', { initial: true }), payload: { content } });
  const { coalesce: _coalesce, ...uncoalesced } = f.params('q1', '');
  const plain = await f.send('push/event', { ...uncoalesced, payload: { content } });
  assert.equal(coalesced.error?.code, -32602);
  assert.equal(plain.error?.code, -32602);
  assert.equal(coalesced.error?.message, plain.error?.message);
});

test('an inference filter reads the text conversion stores, a placeholder included, on both lanes, coalesced or not', async (t) => {
  const seen: string[] = [];
  const f = await fixture({ server: { shouldTriggerInference: (text: string) => { seen.push(text); return false; } } });
  t.after(f.close); await f.register();
  // A text block whose text isn't a string, which reads as no text; a block
  // that converts to a placeholder; and visible text.
  const content = [{ type: 'text', text: { toString: 1 } }, { type: 'video', uri: 'https://example.invalid/v.mp4' }, { type: 'text', text: 'visible_text' }];
  const shown = '\n[unrecognized content block: video]\nvisible_text';
  const r = await f.send('channels/incoming', { messages: [
    { ...f.channel('e1', '', { initial: true }, 'chat', 'coalesced'), content },
    { channelId: 'chat', messageId: 'plain', timestamp: TS, author: { id: 'u', name: 'User' }, content },
    // A valid message after them, which a throw in the filter never reached.
    { channelId: 'chat', messageId: 'sibling', timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'sibling_text' }] },
  ] });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.result.results.map((x: { accepted: boolean }) => x.accepted), [true, true, true]);
  const coalesced = await f.send('push/event', { ...f.params('p1', '', { initial: true }), payload: { content } });
  const { coalesce: _coalesce, ...uncoalesced } = f.params('q1', '');
  const plain = await f.send('push/event', { ...uncoalesced, payload: { content } });
  assert.equal(coalesced.result?.accepted, true);
  assert.equal(plain.result?.accepted, true);
  // Each lane joins its converted text blocks with a line break, the
  // non-string one as empty text and the video as its placeholder.
  assert.deepEqual(seen, [shown, shown, 'sibling_text', shown, shown],
    'the filter gets the same text on both lanes, and is reached for every message');
});

test('a render result with a malformed block falls back, and the host names it on a console line', async (t) => {
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  f.renderer(async () => ({ content: [{ type: 'text' }] }));
  await f.send('push/event', f.params('r1', 'render_fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  assert(f.context().includes('render_fallback'), 'the occurrence\'s own content is delivered');
  const line = lines.find((l) => l.startsWith('[push-render-failed]'));
  assert(line, lines.join('\n'));
  assert.match(line, /^\[push-render-failed\] server=editor subject=\S+ eventId=r1 field=payload\.content: "CoalesceError:\\u0020invalid\\u0020content\\u0020block" \(the occurrence's own content is delivered instead\)$/);
});

test('a render result is delivered only when the converters show each block as itself or as a reference stub', async (t) => {
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  f.alwaysRespond();
  const cases: Array<{ block: Record<string, unknown>; delivered: boolean }> = [
    { block: { type: 'image', data: 'AAAA', mimeType: 'image/png' }, delivered: true },
    { block: { type: 'image', uri: 'https://example.invalid/i.png' }, delivered: true },
    { block: { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }, delivered: true },
    { block: { type: 'audio', uri: 'https://example.invalid/a.wav', disposition: 'ref' }, delivered: true },
    { block: { type: 'resource', uri: 'https://example.invalid/doc' }, delivered: true },
    // Each of these converts to a placeholder, so the occurrence's own
    // content is delivered instead.
    { block: { type: 'image', data: '', mimeType: 'image/png' }, delivered: false },
    { block: { type: 'image', data: 'AAAA', mimeType: '' }, delivered: false },
    { block: { type: 'image', data: 'AAAA', mimeType: 'image/png', uri: 'https://example.invalid/i.png' }, delivered: false },
    { block: { type: 'audio', data: '', mimeType: 'audio/wav' }, delivered: false },
    { block: { type: 'audio', uri: 'https://example.invalid/a.wav' }, delivered: false },
    { block: { type: 'resource', uri: '' }, delivered: false },
    { block: { type: 'resource', uri: `https://example.invalid/${'x'.repeat(4096)}` }, delivered: false },
    { block: { type: 'audio', uri: `https://example.invalid/${'x'.repeat(4096)}`, disposition: 'ref' }, delivered: false },
    { block: { type: 'image', uri: '' }, delivered: false },
    { block: { type: 'video', data: 'AAAA', mimeType: 'video/mp4' }, delivered: false },
  ];
  f.renderer(async (params) => {
    const i = Number(String(params.eventId).slice(1));
    return { content: [{ type: 'text', text: `rendered_${i}` }, cases[i].block] };
  });
  for (const [i] of cases.entries()) await f.send('push/event', f.params(`r${i}`, `fallback_${i}`, { deferred: true, key: `doc${i}` }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, cases.length);
  const context = f.context();
  for (const [i, { block, delivered }] of cases.entries()) {
    assert.equal(context.includes(JSON.stringify(`rendered_${i}`)), delivered, `rendered: ${JSON.stringify(block)}`);
    assert.equal(context.includes(JSON.stringify(`fallback_${i}`)), !delivered, `fell back: ${JSON.stringify(block)}`);
  }
  // Each fallback is named on the host.
  const failed = lines.filter((l) => l.startsWith('[push-render-failed]')).map((l) => /eventId=(\S+)/.exec(l)?.[1]).sort();
  assert.deepEqual(failed, cases.flatMap(({ delivered }, i) => (delivered ? [] : [`r${i}`])).sort());
});

test('a render error the server words itself prints as one field, so it can\'t add fields to the line', async (t) => {
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  f.renderer(async () => ({ error: { code: -32000, message: 'bad server=other eventId=forged' } }));
  await f.send('push/event', f.params('r2', 'render_fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert(f.context().includes('render_fallback'), 'the occurrence\'s own content is delivered');
  const line = lines.find((l) => l.startsWith('[push-render-failed]'));
  assert(line, lines.join('\n'));
  assert(line.includes('bad\\u0020server\\u003dother\\u0020eventId\\u003dforged'), line);
  // The last field before the tail ends with its colon.
  const fields = line.split(' ').filter((word) => /^(server|eventId)=/.test(word)).map((word) => word.replace(/:$/, ''));
  assert.deepEqual(fields, ['server=editor', 'eventId=r2'], 'no field but the real ones');
});

test('an uncoalesced message without an identity is refused as one, with no coalesce line or trace', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:channel-incoming-rejected') rejected.push(e); });
  const plain = { channelId: 'chat', messageId: 'm1', timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'hi' }] };
  // With no coalescer wired, a message carrying coalesce is handled uncoalesced too.
  const withoutCoalescer = await fixture(); t.after(withoutCoalescer.close); await withoutCoalescer.register();
  (withoutCoalescer.framework as unknown as { channelRegistry: { handleCoalescedIncoming: unknown } }).channelRegistry.handleCoalescedIncoming = undefined;
  withoutCoalescer.framework.onTrace((e) => { if (e.type === 'mcpl:channel-incoming-rejected') rejected.push(e); });

  const r = await f.send('channels/incoming', { messages: [{ ...plain, channelId: undefined }, { ...plain, messageId: undefined }] });
  const w = await withoutCoalescer.send('channels/incoming', { messages: [{ ...withoutCoalescer.channel('e1', 'hi', { initial: true }), messageId: undefined }] });
  assert.deepEqual(
    [...r.result.results, ...w.result.results].map((x: { reason?: string }) => x.reason),
    ['invalid channel/message identity', 'invalid channel/message identity', 'invalid channel/message identity'],
  );
  assert.deepEqual(rejected, [], 'no coalesce trace');
  assert(!lines.some((l) => l.includes('coalesce')), lines.join('\n'));
});

test('a coalesced push without an eventId, or with one that is not a string, is answered and named without throwing', async (t) => {
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:push-event-rejected') rejected.push(e); });
  const missing = await f.send('push/event', { ...f.params('x', 'no_id', { initial: true }), eventId: undefined });
  assert.equal(missing.error?.code, -32602);
  // An object eventId whose toString isn't callable, on the malformed-content
  // path, where the line is written before the answer.
  const odd = await f.send('push/event', { ...f.params('x', ''), eventId: { toString: 1 }, payload: { content: ['not-a-block'] } });
  assert.equal(odd.error?.code, -32602, 'answered');
  assert.deepEqual(rejected.map(({ eventId, field }) => ({ eventId, field })), [
    { eventId: '', field: 'eventId' },
    { eventId: '', field: 'payload.content' },
  ]);
  assert(lines.some((l) => l.startsWith('[push-event-rejected] server=editor featureSet=doc eventId="" reason=coalesce-invalid field=eventId:')), lines.join('\n'));
  assert(lines.some((l) => l.startsWith('[push-event-rejected] server=editor featureSet=doc eventId="{\\"toString\\":1}" reason=coalesce-invalid field=payload.content:')), lines.join('\n'));
});

test('a message for an unregistered channel is traced with its message id, coalesced or not, and named on the host at most once a minute per channel', async (t) => {
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:channel-incoming-rejected') rejected.push(e); });
  let now = 0;
  (f.framework as unknown as { channelRegistry: { unknownChannelLines: RefusalLines } }).channelRegistry.unknownChannelLines = new RefusalLines(() => now);
  const plain = (channelId: string, messageId: string) => ({
    channelId, messageId, timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'hi' }],
  });
  const r = await f.send('channels/incoming', { messages: [
    plain('nowhere', 'p1'), f.channel('e1', 'hi', { initial: true }, 'nowhere', 'c1'), plain('nowhere', 'p2'), plain('elsewhere', 'q1'),
  ] });
  assert.deepEqual(r.result.results.map((x: { accepted: boolean }) => x.accepted), [false, false, false, false]);
  // A minute on, the channel's next refusal prints again, with how many came since.
  now += 60_000;
  await f.send('channels/incoming', { messages: [plain('nowhere', 'p3')] });
  assert.deepEqual(rejected.map(({ messageId, reason }) => [messageId, reason]), [
    ['p1', 'unknown-channel'], ['c1', 'unknown-channel'], ['p2', 'unknown-channel'], ['q1', 'unknown-channel'], ['p3', 'unknown-channel'],
  ]);
  assert.deepEqual(lines.filter((l) => l.startsWith('[channel-incoming-rejected]')), [
    '[channel-incoming-rejected] server=editor channel=nowhere messageId=p1 reason=unknown-channel (not registered, §14.5)',
    '[channel-incoming-rejected] server=editor channel=elsewhere messageId=q1 reason=unknown-channel (not registered, §14.5)',
    '[channel-incoming-rejected] server=editor channel=nowhere messageId=p3 reason=unknown-channel (not registered, §14.5; 2 more since the last line)',
  ]);
});

test('a channel-scoped push refused for its channel (-32023, -32017) is traced each time and named, with its channel, on the host at most once a minute per channel', async (t) => {
  let now = 0;
  const throttle = (g: Awaited<ReturnType<typeof fixture>>) => {
    (g.framework as unknown as { pushHandler: { channelRefusalLines: RefusalLines } }).pushHandler.channelRefusalLines = new RefusalLines(() => now);
  };
  const lines = captureConsoleError(t);
  const rejected: Rejection[] = [];
  // -32023: a channel the server never declared.
  const f = await fixture(); t.after(f.close); throttle(f);
  f.framework.onTrace((e) => { if (e.type === 'mcpl:push-event-rejected') rejected.push(e); });
  for (const id of ['u1', 'u2', 'u3']) {
    const r = await f.send('push/event', f.params(id, 'to_nowhere', { initial: true, channelId: 'nope', key: id }));
    assert.equal(r.error?.code, -32023);
  }
  // Another channel of the same server prints its own first refusal.
  const other = await f.send('push/event', f.params('v1', 'to_elsewhere', { initial: true, channelId: 'elsewhere', key: 'v1' }));
  assert.equal(other.error?.code, -32023);
  // A push refused for what it holds (-32602) prints every time, whatever its channel.
  for (const id of ['m1', 'm2']) {
    const { timestamp: _, ...untimed } = f.params(id, 'to_nowhere', { initial: true, channelId: 'nope', key: id });
    const r = await f.send('push/event', untimed);
    assert.equal(r.error?.code, -32602);
  }
  // -32017: a server with no channels.incoming grant.
  const g = await fixture({ server: { disabledCapabilities: ['channels.incoming'] } }); t.after(g.close); throttle(g);
  g.framework.onTrace((e) => { if (e.type === 'mcpl:push-event-rejected') rejected.push(e); });
  for (const id of ['d1', 'd2']) {
    const r = await g.send('push/event', g.params(id, 'not_permitted', { initial: true, channelId: 'chat', key: id }));
    assert.equal(r.error?.code, -32017);
  }
  now += 60_000;
  await f.send('push/event', f.params('u4', 'to_nowhere', { initial: true, channelId: 'nope', key: 'u4' }));
  // Each refusal is traced, and one refused for its channel names it.
  assert.deepEqual(rejected.map(({ eventId, reason, channelId }) => [eventId, reason, channelId]), [
    ['u1', 'coalesce-invalid', 'nope'], ['u2', 'coalesce-invalid', 'nope'], ['u3', 'coalesce-invalid', 'nope'], ['v1', 'coalesce-invalid', 'elsewhere'],
    ['m1', 'coalesce-invalid', undefined], ['m2', 'coalesce-invalid', undefined],
    ['d1', 'coalesce-invalid', 'chat'], ['d2', 'coalesce-invalid', 'chat'], ['u4', 'coalesce-invalid', 'nope'],
  ]);
  assert.deepEqual(lines.filter((l) => l.startsWith('[push-event-rejected]')), [
    '[push-event-rejected] server=editor featureSet=doc eventId=u1 channel=nope reason=coalesce-invalid field=coalesce.channelId: "Unknown channel"',
    '[push-event-rejected] server=editor featureSet=doc eventId=v1 channel=elsewhere reason=coalesce-invalid field=coalesce.channelId: "Unknown channel"',
    '[push-event-rejected] server=editor featureSet=doc eventId=m1 reason=coalesce-invalid field=timestamp: "timestamp is required"',
    '[push-event-rejected] server=editor featureSet=doc eventId=m2 reason=coalesce-invalid field=timestamp: "timestamp is required"',
    '[push-event-rejected] server=editor featureSet=doc eventId=d1 channel=chat reason=coalesce-invalid field=coalesce.channelId: "Channel not permitted"',
    '[push-event-rejected] server=editor featureSet=doc eventId=u4 channel=nope reason=coalesce-invalid field=coalesce.channelId: "Unknown channel" (2 more since the last line)',
  ]);
});

test('the framework\'s empty-content backstops name a module-emitted event\'s ids as one field each', async (t) => {
  // Events that never crossed the MCPL boundary (here, emitted straight onto
  // the queue) meet the store/wake backstop instead of the ingress refusal.
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  const forged = 'x\n[forged] y';
  f.framework.pushEvent({
    type: 'mcpl:push-event', serverId: 'editor', featureSet: 'doc', eventId: forged, content: [], timestamp: TS, triggerInference: false,
  } as never);
  f.framework.pushEvent({
    type: 'mcpl:channel-incoming', serverId: 'editor', channelId: forged, messageId: forged,
    author: { id: 'u', name: 'User' }, content: [], timestamp: TS, triggerInference: false,
  } as never);
  await f.framework.runUntilIdle();
  const shown = '"x\\n[forged]\\u0020y"';
  assert.deepEqual(lines.filter((l) => l.includes('-dropped]')).sort(), [
    `[channel-incoming-dropped] server=editor channel=${shown} messageId=${shown} reason=empty-content`,
    `[push-event-dropped] server=editor eventId=${shown} reason=empty-content`,
  ], lines.join('\n'));
});
