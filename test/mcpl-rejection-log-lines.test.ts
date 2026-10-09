/**
 * A rejection line in the host log can't be forged by the sender's own
 * identifiers (agent-framework#267 review).
 *
 * The ingress handlers' rejection lines name what the server sent (its
 * channel, messageId, eventId and featureSet), and the host log is read a
 * line at a time. Printed raw, a line break in an id printed a second line
 * that read as another host record, about another server. Each such value now
 * prints through `logValue`: a plain id as it is, anything else as one JSON
 * string with its invisible characters escaped.
 *
 * Run: node --import tsx --test test/mcpl-rejection-log-lines.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TS } from './helpers/coalescing-fixture.js';
import { logValue } from '../src/mcpl/log-value.js';

/** An id that, printed raw, would add a line reading as another server's record. */
const FORGED = 'x\n[push-event-rejected] server=other eventId=y reason=duplicate';
/** How the host log shows it: one quoted field. */
const SHOWN = JSON.stringify(FORGED);
/** A feature set the server declares under a forged name, enabled by `*`. */
const FORGED_SET = 'doc\n[push-event-rejected] server=other eventId=y reason=duplicate';
/** A channel the server registers under a forged id. */
const FORGED_CHANNEL = 'chat\n[channel-incoming-rejected] server=other channel=chat messageId=y reason=empty-content';

test('logValue: a plain id prints as it is', () => {
  for (const id of ['bad', 'discord:1234567890', 'message:m', 'a=b', 'café', '日本']) assert.equal(logValue(id), id);
  assert.equal(logValue(undefined), 'undefined');
});

test('logValue: anything else prints as one JSON string, every invisible character escaped', () => {
  const cases: Array<[string, string]> = [
    ['', '""'],
    ['a b', '"a b"'],
    ['x\n[forged] server=other', '"x\\n[forged] server=other"'],
    ['x\r\ny', '"x\\r\\ny"'],
    ['\x1b[31mred', '"\\u001b[31mred"'],
    ['a\x7fb', '"a\\u007fb"'],
    ['a\u0085b', '"a\\u0085b"'],
    ['a\u2028b', '"a\\u2028b"'],
    ['\u202eevil', '"\\u202eevil"'],
    ['a\u00a0b', '"a\\u00a0b"'],
    ['a\u{e0041}b', '"a\\udb40\\udc41b"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', '"a\\\\b"'],
  ];
  for (const [value, shown] of cases) {
    assert.equal(logValue(value), shown, JSON.stringify(value));
    assert.equal(JSON.parse(logValue(value)), value, 'JSON.parse gives back exactly what was sent');
  }
});

test('every rejection line of the ingress handlers stays one line, whatever the sender\'s ids hold', async (t) => {
  const f = await fixture({
    featureSets: { doc: { description: 'doc', uses: ['pushEvents'] }, [FORGED_SET]: { description: 'forged', uses: ['pushEvents'] } },
    server: { enabledFeatureSets: ['*'] },
  });
  t.after(f.close); await f.register(FORGED_CHANNEL);
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });

  // channels/incoming: a coalesced item with no channelId, a malformed
  // coalesced one, and an empty uncoalesced one.
  await f.send('channels/incoming', { messages: [
    { ...f.channel('c1', 'text', { initial: true }, FORGED_CHANNEL, FORGED), channelId: undefined },
    { ...f.channel('c2', '', { initial: true }, FORGED_CHANNEL, FORGED), content: [{ type: 'text' }] },
    { channelId: FORGED_CHANNEL, messageId: FORGED, timestamp: TS, author: { id: 'u', name: 'User' }, content: [] },
  ] });
  // push/event: an unknown feature set (which its reason names too), a
  // malformed coalesced occurrence, an empty push, then a duplicate.
  const push = { featureSet: 'doc', eventId: FORGED, timestamp: TS, payload: { content: [{ type: 'text', text: 'hi' }] } };
  await f.send('push/event', { ...push, featureSet: FORGED });
  await f.send('push/event', { ...f.params(FORGED, ''), featureSet: FORGED_SET, payload: { content: [{ type: 'text' }] } });
  await f.send('push/event', { ...push, payload: { content: [] } });
  await f.send('push/event', push);
  await f.send('push/event', push);

  const rejected = lines.filter((l) => /^\[(channel-incoming|push-event)-rejected\]/.test(l));
  assert(rejected.every((l) => !/[\n\r\u0085\u2028\u2029]/.test(l)), 'no rejection line breaks');
  assert.deepEqual(rejected, [
    `[channel-incoming-rejected] server=editor channel="" messageId=${SHOWN} reason=coalesce-invalid field=channelId: "a coalesced message needs a channelId and a messageId"`,
    `[channel-incoming-rejected] server=editor channel=${JSON.stringify(FORGED_CHANNEL)} messageId=${SHOWN} reason=coalesce-invalid field=payload.content: "invalid content block"`,
    `[channel-incoming-rejected] server=editor channel=${JSON.stringify(FORGED_CHANNEL)} messageId=${SHOWN} reason=empty-content`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=${JSON.stringify(`Unknown feature set: ${FORGED}`)}`,
    `[push-event-rejected] server=editor featureSet=${JSON.stringify(FORGED_SET)} eventId=${SHOWN} reason=coalesce-invalid field=payload.content: "invalid content block"`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=empty-content`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=duplicate`,
  ]);
});
