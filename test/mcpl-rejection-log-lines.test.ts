/**
 * A rejection line in the host log can't be forged by the sender's own
 * identifiers (agent-framework#267 review).
 *
 * The ingress handlers' rejection lines name what the server sent (its
 * channel, messageId, eventId and featureSet), and the host log is read a
 * line at a time, by eye and with grep. Printed raw, a line break in an id
 * printed a second line that read as another host record, about another
 * server, and an `=` in it could hold a lookalike field that a search for
 * that field found first. Each such value now prints through `logValue`: a
 * plain id as it is, anything else as one JSON string with its `=` and
 * invisible characters escaped, cut with its length named when it is long.
 *
 * Run: node --import tsx --test test/mcpl-rejection-log-lines.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TS } from './helpers/coalescing-fixture.js';
import { logDetail, logValue } from '../src/mcpl/log-value.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { parseDeclaredClasses } from '../src/mcpl/tool-classes.js';
import { RefusalLines } from '../src/mcpl/refusal-lines.js';
import { AgentFramework } from '../src/framework.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

/** A field as the host log shows it: one JSON string, its spaces and `=` escaped too. */
const field = (value: string) => JSON.stringify(value).replace(/ /g, '\\u0020').replace(/=/g, '\\u003d');
/** An id that, printed raw, would add a line reading as another server's record. */
const FORGED = 'x\n[push-event-rejected] server=other eventId=y reason=duplicate';
/** How the host log shows it: one quoted field. */
const SHOWN = field(FORGED);
/** A feature set the server declares under a forged name, enabled by `*`. */
const FORGED_SET = 'doc\n[push-event-rejected] server=other eventId=y reason=duplicate';
/** A channel the server registers under a forged id. */
const FORGED_CHANNEL = 'chat\n[channel-incoming-rejected] server=other channel=chat messageId=y reason=empty-content';

function captureConsoleError(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  return lines;
}

test('logValue: a plain id prints as it is', () => {
  for (const id of ['bad', 'discord:1234567890', 'message:m', 'café', '日本']) assert.equal(logValue(id), id);
  assert.equal(logValue(undefined), 'undefined');
});

test('logValue: lookalikes print as they are; ids that differ only invisibly never print alike', () => {
  // Canonically equivalent or lookalike ids can still print alike: café
  // composed and decomposed, and a Cyrillic а for a Latin a.
  for (const id of ['caf\u00e9', 'cafe\u0301', '\u0430bc', 'abc']) assert.equal(logValue(id), id, JSON.stringify(id));
  // A Hangul filler, a combining grapheme joiner, a variation selector and a
  // blank Braille pattern are escaped, so each differs from plain abc.
  const cases: Array<[string, string]> = [
    ['abc\u3164', '"abc\\u3164"'],
    ['\u034fabc', '"\\u034fabc"'],
    ['abc\ufe0f', '"abc\\ufe0f"'],
    ['ab\u2800c', '"ab\\u2800c"'],
  ];
  for (const [value, shown] of cases) {
    assert.equal(logValue(value), shown, JSON.stringify(value));
    assert.equal(JSON.parse(logValue(value)), value);
  }
});

test('logValue: an = is escaped, so a search for a field on the line finds only the real one', () => {
  assert.equal(logValue('a=b'), '"a\\u003db"');
  assert.equal(logValue('reason=forged'), '"reason\\u003dforged"');
  assert.equal(JSON.parse(logValue('reason=forged')), 'reason=forged', 'JSON.parse gives back exactly what was sent');
  const line = `[push-event-rejected] server=editor eventId=${logValue('reason=forged')} reason=duplicate`;
  assert.deepEqual(line.match(/reason=(\S+)/)?.[1], 'duplicate', 'the first reason= on the line is the real one');
});

test('logValue: a value that is not a string prints as its JSON text, and converting it never throws', () => {
  assert.equal(logValue(5), '5');
  assert.equal(logValue(null), 'null');
  assert.equal(logValue({ toString: 1 }), '"{\\"toString\\":1}"');
  assert.equal(logValue({ a: 'b c' }), '"{\\"a\\":\\"b\\u0020c\\"}"');
  assert.equal(logValue(10n), '10');
  assert.equal(logValue({ toJSON() { throw new Error('no'); }, toString: 1 }), '"[object\\u0020Object]"');
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(logValue(proxy), '[unprintable]', 'a value no reader can read');
  // JSON writes these as null, which would read as a missing id.
  assert.equal(logValue(NaN), 'NaN');
  assert.equal(logValue(Infinity), 'Infinity');
  assert.equal(logValue(-Infinity), '-Infinity');
});

test('logValue: a value over 256 units prints quoted as its first 256, then its full length', () => {
  assert.equal(logValue('A'.repeat(256)), 'A'.repeat(256), 'up to the bound, a plain token is whole');
  assert.equal(logValue('A'.repeat(1_600_000)), `"${'A'.repeat(256)}"…(1600000)`);
  assert.equal(logValue('a b'.repeat(200)), `${field('a b'.repeat(200).slice(0, 256))}…(600)`);
  // Never half a surrogate pair: the head stops before one the bound would split.
  assert.equal(logValue(`${'A'.repeat(255)}\u{1F600}B`), `"${'A'.repeat(255)}"…(258)`);
  const json = JSON.stringify({ id: 'A'.repeat(1000) });
  assert.equal(logValue({ id: 'A'.repeat(1000) }), `${field(json.slice(0, 256))}…(${json.length})`);
  assert.equal(logDetail('x '.repeat(200)), `${JSON.stringify('x '.repeat(128))}…(400)`, 'the host\'s tail is bounded too');
});

test('logDetail: the host\'s message keeps its plain spaces and = and escapes everything else logValue does', () => {
  assert.equal(logDetail('invalid content block'), '"invalid content block"');
  assert.equal(logDetail('x\nforged a=b'), '"x\\nforged a=b"');
  assert.equal(logDetail('a\u00a0b\u3164'), '"a\\u00a0b\\u3164"');
  assert.equal(logDetail('timeout'), 'timeout');
  assert.equal(logDetail('a=b'), 'a=b');
});

test('logValue: anything else prints as one JSON string, every invisible character escaped', () => {
  const cases: Array<[string, string]> = [
    ['', '""'],
    ['a b', '"a\\u0020b"'],
    ['x\n[forged] server=other', '"x\\n[forged]\\u0020server\\u003dother"'],
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
  const lines = captureConsoleError(t);

  // channels/incoming: a coalesced item with no channelId, a malformed
  // coalesced one, an empty uncoalesced one, and one for a channel that was
  // never registered.
  await f.send('channels/incoming', { messages: [
    { ...f.channel('c1', 'text', { initial: true }, FORGED_CHANNEL, FORGED), channelId: undefined },
    { ...f.channel('c2', '', { initial: true }, FORGED_CHANNEL, FORGED), content: ['not-a-block'] },
    { channelId: FORGED_CHANNEL, messageId: FORGED, timestamp: TS, author: { id: 'u', name: 'User' }, content: [] },
    { channelId: FORGED_SET, messageId: FORGED, timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'hi' }] },
  ] });
  // push/event: an unknown feature set (which its reason names too), a
  // malformed coalesced occurrence, an empty push, then a duplicate.
  const push = { featureSet: 'doc', eventId: FORGED, timestamp: TS, payload: { content: [{ type: 'text', text: 'hi' }] } };
  await f.send('push/event', { ...push, featureSet: FORGED });
  await f.send('push/event', { ...f.params(FORGED, ''), featureSet: FORGED_SET, payload: { content: ['not-a-block'] } });
  await f.send('push/event', { ...push, payload: { content: [] } });
  await f.send('push/event', push);
  await f.send('push/event', push);
  // A coalesced push to a channel the server never declared names it.
  await f.send('push/event', f.params('u1', 'hi', { initial: true, channelId: FORGED_SET, key: 'u1' }));

  const rejected = lines.filter((l) => /^\[(channel-incoming|push-event)-rejected\]/.test(l));
  assert(rejected.every((l) => !/[\n\r\u0085\u2028\u2029]/.test(l)), 'no rejection line breaks');
  assert.deepEqual(rejected, [
    `[channel-incoming-rejected] server=editor channel="" messageId=${SHOWN} reason=coalesce-invalid field=channelId: "a coalesced message needs a channelId and a messageId"`,
    `[channel-incoming-rejected] server=editor channel=${field(FORGED_CHANNEL)} messageId=${SHOWN} reason=coalesce-invalid field=payload.content: "invalid content block"`,
    `[channel-incoming-rejected] server=editor channel=${field(FORGED_CHANNEL)} messageId=${SHOWN} reason=empty-content`,
    `[channel-incoming-rejected] server=editor channel=${field(FORGED_SET)} messageId=${SHOWN} reason=unknown-channel (not registered, §14.5)`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=${field(`Unknown feature set: ${FORGED}`)}`,
    `[push-event-rejected] server=editor featureSet=${field(FORGED_SET)} eventId=${SHOWN} reason=coalesce-invalid field=payload.content: "invalid content block"`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=empty-content`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=duplicate`,
    `[push-event-rejected] server=editor featureSet=doc eventId=u1 channel=${field(FORGED_SET)} reason=coalesce-invalid field=coalesce.channelId: "Unknown channel"`,
  ]);
  // Each line names its server and its reason once: the forged ids hold neither.
  for (const line of rejected) {
    assert.equal(line.split('server=').length - 1, 1, line);
    assert.equal(line.split('reason=').length - 1, 1, line);
  }
});

test('a push without an eventId prints it as "" and traces it as \'\' on each rejection path', async (t) => {
  const f = await fixture(); t.after(f.close);
  const lines = captureConsoleError(t);
  const rejected: Array<{ eventId?: unknown; reason?: string }> = [];
  f.framework.onTrace((e) => { if (e.type === 'mcpl:push-event-rejected') rejected.push(e); });
  const { coalesce: _coalesce, ...uncoalesced } = f.params('x', '');
  const empty = await f.send('push/event', { ...uncoalesced, eventId: undefined });
  const coalescedEmpty = await f.send('push/event', { ...f.params('x', ''), eventId: undefined });
  const unknownSet = await f.send('push/event', { ...uncoalesced, eventId: undefined, featureSet: 'nope', payload: { content: [{ type: 'text', text: 'hi' }] } });
  assert.deepEqual([empty.error?.code, coalescedEmpty.error?.code, unknownSet.error?.code], [-32602, -32602, -32003]);
  assert.deepEqual(lines.filter((l) => l.startsWith('[push-event-rejected]')), [
    '[push-event-rejected] server=editor eventId="" reason=empty-content',
    '[push-event-rejected] server=editor eventId="" reason=empty-content',
    `[push-event-rejected] server=editor eventId="" reason=${field('Unknown feature set: nope')}`,
  ]);
  // A feature-set refusal has no trace; each empty-content refusal has one.
  assert.deepEqual(rejected.map(({ eventId, reason }) => ({ eventId, reason })), [
    { eventId: '', reason: 'empty-content' },
    { eventId: '', reason: 'empty-content' },
  ]);
});

test('a feature set the host disables is named as one field on its line', async (t) => {
  const lines = captureConsoleError(t);
  const f = await fixture({
    featureSets: { doc: { description: 'doc', uses: ['pushEvents'] }, [FORGED_SET]: { description: 'forged', uses: [] } },
    server: { enabledFeatureSets: ['*'] },
  });
  t.after(f.close);
  const disabled = lines.filter((l) => l.startsWith('[mcpl] editor/'));
  assert.deepEqual(disabled, [`[mcpl] editor/${field(FORGED_SET)} disabled: invalid_uses (§6.4 — uses absent or empty) — overrides enabledFeatureSets`]);
});

test('a capability the host masks is named as one field on its line', async (t) => {
  const lines = captureConsoleError(t);
  const forgedCapability = 'cap\n[push-event-rejected] server=other eventId=y reason=duplicate';
  const f = await fixture({
    server: { enabledCapabilities: ['pushEvents', 'inferenceRequest', 'channels'] },
    mcpl: { [forgedCapability]: true },
  });
  t.after(f.close);
  assert.deepEqual(lines.filter((l) => l.includes('capabilities masked by host config')), [
    `MCPL server "editor" capabilities masked by host config: ${field(forgedCapability)}`,
  ]);
});

test('a tool\'s name and its declared classes are named as one field each', (t) => {
  const lines = captureConsoleError(t);
  const tool = 'mcpl--editor--x\n[push-event-rejected] server=other';
  parseDeclaredClasses({ 'mcpl/class': 'comms' }, tool);
  parseDeclaredClasses({ 'mcpl/class': ['comms', 'x\n[forged] y'] }, tool);
  assert.deepEqual(lines, [
    `[mcpl] ${field(tool)}: _meta["mcpl/class"] is not an array — treated as unclassed`,
    `[mcpl] ${field(tool)}: unknown tool class ${field('x\n[forged] y')} ignored (RFC-008 §3)`,
  ]);
});

test('speech routed into a closed channel names the channel as one field on each line', async (t) => {
  const lines = captureConsoleError(t);
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async () => ({ delivered: true }),
    sendChannelsOpen: async () => ({}),
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {}, {},
  );
  (registry as unknown as { channels: Map<string, unknown> }).channels.set(`editor:${FORGED_CHANNEL}`, {
    serverId: 'editor', descriptor: { id: FORGED_CHANNEL, type: 'discord', label: 'chat' }, open: false,
  });
  const routed = await registry.routeSpeech('agent', 'hello', FORGED_CHANNEL);
  assert.equal(routed?.delivered, true);
  assert.deepEqual(lines.filter((l) => l.startsWith('[routeSpeech]')), [
    `[routeSpeech] agent: locus ${field(FORGED_CHANNEL)} was closed — opened by delivery (speech implies engagement)`,
    `[routeSpeech] agent: routed 5 chars -> ${field(FORGED_CHANNEL)} (server=editor, delivered=true)`,
  ]);
});

test('a refusal reaction with no server for its locus names the locus as one field', async (t) => {
  const lines = captureConsoleError(t);
  const locus = `discord:g1:${FORGED_CHANNEL}`;
  const fakeThis = {
    channelRegistry: { buildChannelContext: () => ({ incoming: { channelId: locus, messageId: 'm1' } }), getChannelServerId: () => undefined },
    mcplServerRegistry: { getServer: () => undefined },
  };
  const react = (AgentFramework.prototype as unknown as { reactToRefusal: (agent: string, category: string) => Promise<void> }).reactToRefusal;
  await react.call(fakeThis, 'agent', 'harmful');
  assert.deepEqual(lines, [`[inference-refusal] reaction skipped: no MCPL server for locus ${field(locus)} (agent=agent)`]);
});

/** The framework's own spawn step, which both spawn paths decide through,
 *  for a stub framework: it calls the stub's createConversationAgent. */
function spawnStep() {
  const proto = AgentFramework.prototype as unknown as Record<'routeConversation' | 'spawnConversationAgent', unknown>;
  return { conversationSpawns: new Map(), routeConversation: proto.routeConversation, spawnConversationAgent: proto.spawnConversationAgent };
}

test('a conversation agent that fails to spawn names its channel as one field', async (t) => {
  const lines = captureConsoleError(t);
  const traces: Array<{ type: string }> = [];
  const fakeThis = {
    conversationRouter: { route: () => ({ kind: 'spawn', agentName: 'conversation-chat-g1', generation: 1, trigger: true }), templateAgent: 'agent' },
    channelRegistry: { getDescriptor: () => undefined },
    ...spawnStep(),
    createConversationAgent: async () => { throw new Error('no room'); },
    emitTrace: (e: { type: string }) => { traces.push(e); },
  };
  const route = (AgentFramework.prototype as unknown as { routeConversationIncoming: (event: unknown, metadata: unknown) => Promise<unknown> }).routeConversationIncoming;
  await route.call(fakeThis, { serverId: 'editor', channelId: FORGED_CHANNEL, messageId: 'm1', author: { id: 'u', name: 'User' }, content: [] }, {});
  assert.deepEqual(lines, [`Failed to spawn conversation agent for ${field(FORGED_CHANNEL)}: Error: no room`]);
  assert.deepEqual(traces.map((e) => e.type), ['mcpl:conversation-spawn-failed']);
});

test('a coalesced batch whose conversation agent fails to spawn names its channel as one field', async (t) => {
  const lines = captureConsoleError(t);
  const fakeThis = {
    agents: new Map(),
    conversationRouter: {
      getBinding: () => undefined,
      route: () => ({ kind: 'spawn', agentName: 'conversation-chat-g1', generation: 1, trigger: true }),
    },
    channelRegistry: { getDescriptor: () => undefined },
    ...spawnStep(),
    createConversationAgent: async () => { throw new Error('no room'); },
  };
  const audience = (AgentFramework.prototype as unknown as { coalescedAudience: (occ: unknown) => Promise<string[]> }).coalescedAudience;
  const occ = { scope: { kind: 'channel', id: FORGED_CHANNEL }, event: { lane: 'channel', event: { metadata: {} } } };
  assert.deepEqual(await audience.call(fakeThis, occ), []);
  assert.deepEqual(lines, [`[coalescing] could not spawn a conversation agent for ${field(FORGED_CHANNEL)}: Error: no room`]);
});

test('a refusal line prints for a channel\'s first refusal, then at most once a minute with how many were held back', () => {
  let now = 1_000;
  const lines = new RefusalLines(() => now);
  assert.equal(lines.admit('editor', 'nowhere'), 0, 'the first prints');
  assert.equal(lines.admit('editor', 'nowhere'), null, 'a repeat within the minute is held back');
  assert.equal(lines.admit('editor', 'elsewhere'), 0, 'another channel\'s first prints');
  assert.equal(lines.admit('other', 'nowhere'), 0, 'so does another server\'s');
  now += 59_999;
  assert.equal(lines.admit('editor', 'nowhere'), null, 'still within the minute');
  now += 1;
  assert.equal(lines.admit('editor', 'nowhere'), 2, 'a minute on, it prints with the two held back');
  assert.equal(lines.admit('editor', 'nowhere'), null, 'and its next minute starts');
});

test('a refusal line keeps servers and channels apart, and keys a channel as its line prints it', () => {
  const lines = new RefusalLines(() => 0);
  assert.equal(lines.admit('a:b', 'c'), 0);
  assert.equal(lines.admit('a', 'b:c'), 0, 'a colon doesn\'t merge two server and channel pairs');
  assert.equal(lines.admit('a\u0000b', 'c'), 0);
  assert.equal(lines.admit('a', 'b\u0000c'), 0, 'nor does a NUL');
  assert.equal(lines.admit('ab', 'c'), 0);
  assert.equal(lines.admit('a', 'bc'), 0, 'nor do two pairs that run together alike');
  const head = 'x'.repeat(256);
  assert.equal(lines.admit('editor', `${head}one`), 0);
  assert.equal(lines.admit('editor', `${head}two`), null, 'ids cut to the same 256 units at the same length print alike, and share a record');
  assert.equal(lines.admit('editor', `${head}three`), 0, 'an id of another length prints otherwise, and has its own');
});

test('refusal lines time their minute with the monotonic clock, not the wall clock', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const lines = new RefusalLines();
  assert.equal(lines.admit('editor', 'nowhere'), 0);
  assert.equal(lines.admit('editor', 'nowhere'), null);
  now += 60_000;
  assert.equal(lines.admit('editor', 'nowhere'), 1, 'a minute on the monotonic clock, the wall clock standing still');
});

test('refusal lines cover at most 1,000 channels, evicting the least recently refused', () => {
  const lines = new RefusalLines(() => 0);
  assert.equal(lines.admit('editor', 'busy'), 0);
  assert.equal(lines.admit('editor', 'quiet'), 0);
  for (let i = 0; i < 997; i++) assert.equal(lines.admit('editor', `c${i}`), 0);
  // 999 channels; busy, refused again, is now the most recent and quiet the least.
  assert.equal(lines.admit('editor', 'busy'), null);
  assert.equal(lines.admit('editor', 'c997'), 0, 'the thousandth channel');
  assert.equal(lines.admit('editor', 'c998'), 0, 'one more evicts quiet');
  assert.equal(lines.admit('editor', 'busy'), null, 'busy keeps its record');
  assert.equal(lines.admit('editor', 'quiet'), 0, 'quiet, evicted, prints again as new');
});

for (const [name, eventId, shown] of [['its eventId', FORGED, SHOWN], ['a missing eventId as ""', undefined, '""']] as const) {
  test(`a silent heartbeat names ${name} as one field`, async (t) => {
    const f = await fixture({
      server: { id: 'heartbeat', enabledFeatureSets: ['heartbeat'] },
      featureSets: { heartbeat: { description: 'heartbeat', uses: ['pushEvents'] } },
    });
    t.after(f.close);
    const lines = captureConsoleError(t);
    const r = await f.send('push/event', {
      featureSet: 'heartbeat', eventId, timestamp: TS, origin: { source: 'heartbeat', silent: true }, payload: { content: [] },
    });
    assert.equal(r.result?.accepted, true);
    await f.framework.runUntilIdle();
    assert.deepEqual(lines.filter((l) => l.startsWith('[heartbeat]')), [`[heartbeat] heartbeat: accepted silent scheduled wake ${shown}`]);
  });
}
