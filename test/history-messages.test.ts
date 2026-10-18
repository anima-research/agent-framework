/**
 * What the history tools tell an agent when a call doesn't go through: each
 * refusal says nothing was read or searched, names what the call gave, and
 * says what to send instead or that calling again won't help. The texts are
 * pinned whole, since they are what the agent reads.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import { HistoryModule } from '../src/modules/history/index.js';
import * as semantic from '../src/modules/history/semantic.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';

const T = Date.UTC(2026, 2, 1, 9, 0, 0);
const AT = new Date(T).toISOString();

function message(id: string, ms: number, channelId: string): StoredMessage {
  return {
    id,
    sequence: Number(id.replace(/\D/g, '')) || 0,
    participant: 'User',
    content: [{ type: 'text', text: 'hello' }],
    metadata: { external: { channelId } },
    timestamp: new Date(ms),
  } as unknown as StoredMessage;
}

const channelOf = (m: StoredMessage): string => (m.metadata as { external: { channelId: string } }).external.channelId;

/**
 * A store holding `m1`, or `id`, in channel `c1`, or `channel`. With `ties`,
 * that many messages share any single instant asked for, as after a backfill
 * burst, paged by offset and limit as the store pages them.
 */
function store(ties?: number, channel = 'c1', id = 'm1'): ContextManager {
  const messages = [message(id, T, channel)];
  const single = (args: { fromMs?: number; toMs?: number }) =>
    ties !== undefined && args.fromMs !== undefined && args.fromMs === args.toMs;
  const tied = (args: { fromMs?: number; limit?: number; offset?: number }) => {
    const offset = args.offset ?? 0;
    const n = Math.max(0, Math.min(args.limit ?? ties!, ties! - offset));
    return Array.from({ length: n }, (_, i) => message(`t${offset + i}`, args.fromMs!, channel));
  };
  const page = (all: StoredMessage[], args: { limit?: number; offset?: number }) =>
    all.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? all.length));
  return {
    getMessage: (id: string) => messages.find((m) => m.id === id) ?? null,
    getMessageCount: () => messages.length,
    getMessageWindow: (start: number, n: number) => ({ messages: messages.slice(start, start + n) }),
    queryMessagesByTimeAndChannel(args: { fromMs?: number; toMs?: number; channelId?: string; limit?: number; offset?: number }) {
      if (single(args)) return { messages: tied(args), matchedCount: ties };
      const all = messages.filter((m) => args.channelId === undefined || channelOf(m) === args.channelId);
      return { messages: page(all, args), matchedCount: all.length };
    },
    queryMessagesByTime(args: { fromMs?: number; toMs?: number; limit?: number; offset?: number }) {
      if (single(args)) {
        const found = tied(args);
        return { messages: found, matchedCount: found.length };
      }
      return { messages: page(messages, args), matchedCount: messages.length };
    },
    getSummariesInRange: () => [],
    getChannelMessageCounts: () => [],
    getChannelTokenStats: () => ({ totalMessages: 0, totalTokensEstimate: 0, byChannel: [] }),
  } as unknown as ContextManager;
}

async function refusal(h: HistoryModule, name: string, input: Record<string, unknown>): Promise<string> {
  const result = await h.handleToolCall({ id: `call-${name}`, name, input });
  assert.equal(result.success, false, `${name} ${JSON.stringify(input)} went through`);
  assert.equal(result.isError, true);
  return result.error ?? '';
}

async function answer<T>(h: HistoryModule, name: string, input: Record<string, unknown>): Promise<T> {
  const result = await h.handleToolCall({ id: `call-${name}`, name, input });
  assert.equal(result.success, true, result.error);
  return result.data as T;
}

function bound(ties?: number, registry?: ChannelRegistry, channel?: string, id?: string): HistoryModule {
  const h = new HistoryModule();
  h.bind(store(ties, channel, id), registry);
  return h;
}

/** An embed-service stand-in that answers every request with one status and message. */
async function service(t: TestContext, status: number, msg: string): Promise<string> {
  return routed(t, () => [status, { error: { message: msg } }]);
}

/**
 * An embed-service stand-in that answers each request by its kind (stats,
 * upsert, delete or search) and how many of that kind came before it. A
 * string body goes as it is, as a web page; anything else, as JSON.
 */
async function routed(t: TestContext, reply: (kind: string, n: number) => [number, unknown]): Promise<string> {
  const seen = new Map<string, number>();
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const kind = (req.url ?? '').slice((req.url ?? '').lastIndexOf('/') + 1);
      const n = seen.get(kind) ?? 0;
      seen.set(kind, n + 1);
      const [status, body] = reply(kind, n);
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  return listen(t, server);
}

/** A web page, as a wrong address can answer with. */
const PAGE = '<!DOCTYPE html><title>Welcome</title>';

/** A character outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const GRIN = '\u{1F600}';

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function withIndex(t: TestContext, url: string, requestTimeoutMs?: number): HistoryModule {
  const h = new HistoryModule({ semantic: { url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0, requestTimeoutMs } });
  // The background indexer's own failures are logged; they aren't what's tested here.
  t.mock.method(console, 'warn', () => {});
  h.bind(store());
  t.after(() => h.stop());
  return h;
}

const client = (url: string, requestTimeoutMs?: number) =>
  new semantic.SemanticIndexClient({ url, token: 'tok', namespace: 'test/ns', requestTimeoutMs });

/** What a promise rejected with, as the client's error. */
async function failed(promise: Promise<unknown>): Promise<semantic.EmbedServiceError> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof semantic.EmbedServiceError, String(e));
    return e;
  }
  assert.fail('it went through');
}

test('a history tool called before the host binds the module says nothing can be done here, and tells the host', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  assert.equal(
    await refusal(new HistoryModule(), 'stats', {}),
    "The history tools aren't available: this host hasn't finished setting up the history module, so nothing was read. "
      + "Calling them again won't change that; ask whoever runs this host.",
  );
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [
    ['[history] a tool was called before the host bound the module: call bind(contextManager) before tool dispatch'],
  ]);
});

test('a tool the module has no route for is named with the tools it has', async (t) => {
  assert.equal(
    await refusal(bound(), 'bogus', {}),
    'There\'s no tool "history--bogus", so nothing ran. The history module\'s tools are history--stats, '
      + 'history--extract, history--search and history--overview.',
  );
  assert.equal(
    await refusal(withIndex(t, 'http://127.0.0.1:9'), 'bogus', {}),
    'There\'s no tool "history--bogus", so nothing ran. The history module\'s tools are history--stats, '
      + 'history--extract, history--search, history--overview and history--semantic_search.',
  );
});

test('the checks every history tool shares name the field and the value, and say nothing was read', async () => {
  assert.equal(
    await refusal(bound(), 'stats', { from: 'yesterday' }),
    'Nothing was read: "from" is "yesterday", which isn\'t an ISO 8601 date. Write it like 2026-03-01 or 2026-03-01T09:00:00Z.',
  );
  assert.equal(
    await refusal(bound(), 'overview', { from: '2026-03-02', to: '2026-03-01' }),
    'Nothing was read: "from" ("2026-03-02") is after "to" ("2026-03-01"), so the range holds nothing. Swap them, or '
      + 'correct the one that\'s wrong.',
  );
  // A date the parser takes can be long, with a comment in parentheses, and is quoted cut to 80 UTF-16 units.
  assert.equal(
    await refusal(bound(), 'overview', { from: `March 3, 2026 (${'x'.repeat(90)})`, to: 'March 2, 2026' }),
    `Nothing was read: "from" ("March 3, 2026 (${'x'.repeat(64)}…) is after "to" ("March 2, 2026"), so the range holds `
      + 'nothing. Swap them, or correct the one that\'s wrong.',
  );
  assert.equal(
    await refusal(bound(), 'extract', { author: ['alice', 42] }),
    'Nothing was read: "author" must list names or ids as text, such as ["alice", "1234"], and 42 isn\'t text.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', excludeAuthor: [] }),
    'Nothing was read: "excludeAuthor" names no one: the list is empty. List at least one name or id, such as '
      + '["alice"], or leave "excludeAuthor" out.',
  );
  assert.equal(
    await refusal(bound(), 'extract', { author: [' ', '@'] }),
    'Nothing was read: "author" names no one: its entries are blank. List at least one name or id, such as '
      + '["alice"], or leave "author" out.',
  );
  // A count each tool clamps, named with its range and default, in the tool's own outcome.
  assert.equal(
    await refusal(bound(), 'extract', { limit: -1 }),
    'Nothing was read: "limit" is -1, which isn\'t a whole number from 0 to 200. Pass one, or leave it out for 50.',
  );
  assert.equal(
    await refusal(bound(), 'overview', { limit: 2.5 }),
    'Nothing was read: "limit" is 2.5, which isn\'t a whole number from 0 to 200. Pass one, or leave it out for 50.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', limit: 'ten' }),
    'Nothing was searched: "limit" is "ten", which isn\'t a whole number from 0 to 100. Pass one, or leave it out for 20.',
  );
  // A channel label the host doesn't know, with the near matches it offers and without.
  const registry = (candidates?: string[]) => ({
    resolveProseTargetDurable: () => ({ error: 'no registered channel', ...(candidates ? { candidates } : {}) }),
  }) as unknown as ChannelRegistry;
  assert.equal(
    await refusal(bound(undefined, registry(['#general', '#garden'])), 'extract', { channelId: '#gnral' }),
    'Nothing was read: no channel history matches "#gnral". This host may never have seen a channel by that name, '
      + 'or saw it before it kept channel names. Did you mean "#general" or "#garden"? Each message history--search '
      + 'returns carries its "channelId", so searching for something said in that channel shows its id; pass that id '
      + 'as "channelId".',
  );
  // A name it suggests is for the agent to send, so it's quoted whole, however long.
  const long = `#${'g'.repeat(100)}`;
  assert.equal(
    await refusal(bound(undefined, registry([long])), 'extract', { channelId: '#gnral' }),
    'Nothing was read: no channel history matches "#gnral". This host may never have seen a channel by that name, '
      + `or saw it before it kept channel names. Did you mean "${long}"? Each message history--search returns carries `
      + 'its "channelId", so searching for something said in that channel shows its id; pass that id as "channelId".',
  );
  assert.equal(
    await refusal(bound(undefined, registry()), 'search', { query: 'x', channelId: '#gnral' }),
    'Nothing was read: no channel history matches "#gnral". This host may never have seen a channel by that name, '
      + 'or saw it before it kept channel names. Each message history--search returns carries its "channelId", so '
      + 'searching for something said in that channel shows its id; pass that id as "channelId".',
  );
  // The label is quoted as any value the call gave is, cut to 80 UTF-16 units.
  assert.equal(
    await refusal(bound(undefined, registry()), 'search', { query: 'x', channelId: `#${'g'.repeat(100)}` }),
    `Nothing was read: no channel history matches "#${'g'.repeat(78)}…. This host may never have seen a channel by `
      + 'that name, or saw it before it kept channel names. Each message history--search returns carries its '
      + '"channelId", so searching for something said in that channel shows its id; pass that id as "channelId".',
  );
  // The id that advice points to: m1 was said in c1.
  const found = await answer<{ matches: Array<{ id: string; channelId: string | null }> }>(bound(), 'search', { query: 'hello' });
  assert.deepEqual(found.matches.map((m) => [m.id, m.channelId]), [['m1', 'c1']]);
});

test("extract's refusals say which fields go together, and how to read instead", async (t) => {
  assert.equal(
    await refusal(bound(), 'extract', { before: 5 }),
    'Nothing was read: "before" goes with "aroundId", which reads the conversation around one message. Pass '
      + 'aroundId too, or leave it out to read a range with "from", "to" and "channelId".',
  );
  assert.equal(
    await refusal(bound(), 'extract', { before: 5, allChannels: true }),
    'Nothing was read: "before" and "allChannels" go with "aroundId", which reads the conversation around one '
      + 'message. Pass aroundId too, or leave them out to read a range with "from", "to" and "channelId".',
  );
  assert.equal(
    await refusal(bound(), 'extract', { windowOffset: 3 }),
    'Nothing was read: "windowOffset" resumes an author-filtered extract, so it goes with the "author" or '
      + '"excludeAuthor" of the call that returned it: repeat that call with the fields of its "resume". To page through a '
      + 'range without an author filter, use "offset".',
  );
  assert.equal(
    await refusal(bound(), 'extract', { windowOffset: 3, afterId: 'm1', seqMark: 9 }),
    'Nothing was read: "windowOffset", "afterId" and "seqMark" resume an author-filtered extract, so they go with the '
      + '"author" or "excludeAuthor" of the call that returned them: repeat that call with the fields of its "resume". To '
      + 'page through a range without an author filter, use "offset".',
  );
  assert.equal(
    await refusal(bound(), 'extract', { author: ['alice'], maxScan: 0 }),
    'Nothing was read: "maxScan" is 0, which isn\'t a whole number from 1 to 50000. Pass one, or leave it out for 10000.',
  );
  // An author-filtered extract's continuation, copied from "resume" in part or from another window.
  assert.equal(
    await refusal(bound(), 'extract', { author: ['alice'], afterId: 'm1' }),
    'Nothing was read: "afterId" goes with a "windowOffset" above 0, both copied from a truncated response\'s '
      + '"resume". For a first page, leave afterId out; to continue, copy the fields of that "resume" into the call.',
  );
  assert.equal(
    await refusal(bound(), 'extract', { author: ['alice'], windowOffset: 3 }),
    'Nothing was read: "windowOffset" needs the "afterId" from the same "resume", or a message added or removed '
      + 'since the previous call would be skipped unseen. Copy the fields of the previous response\'s "resume" into '
      + 'the call.',
  );
  assert.equal(
    await refusal(bound(), 'extract', { author: ['alice'], windowOffset: 1, afterId: 'zz' }),
    'Nothing was read: the window changed since the previous call. Message "zz", where that scan stopped, is no longer '
      + 'within 1000 positions of windowOffset 1; it may have been deleted. Restart the scan without "windowOffset" and '
      + '"afterId", over the same range or one narrowed with "from" and "to".',
  );
  assert.equal(
    await refusal(bound(), 'extract', { author: ['alice'], windowOffset: 1, afterId: 'z'.repeat(100) }),
    `Nothing was read: the window changed since the previous call. Message "${'z'.repeat(79)}…, where that scan stopped, `
      + 'is no longer within 1000 positions of windowOffset 1; it may have been deleted. Restart the scan without '
      + '"windowOffset" and "afterId", over the same range or one narrowed with "from" and "to".',
  );
  assert.equal(
    await refusal(bound(), 'extract', { author: ['alice'], windowOffset: 1, afterId: 'm1' }),
    'Nothing was read: "windowOffset" without "channelId" needs the "seqMark" from the same "resume". Copy the '
      + 'fields of the previous response\'s "resume" into the call.',
  );
  // aroundId and what it doesn't take.
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: 'nope' }),
    'Nothing was read: no message in your history has the id "nope". Pass the "id" of a history--search or '
      + 'history--extract result.',
  );
  assert.equal(
    await refusal(withIndex(t, 'http://127.0.0.1:9'), 'extract', { aroundId: 'nope' }),
    'Nothing was read: no message in your history has the id "nope". Pass the "id" of a history--search or '
      + 'history--extract result, or the "messageId" of a history--semantic_search hit.',
  );
  // A number too large for JSON to hold, such as 1e400, arrives as Infinity, and is quoted as it came.
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: Infinity }),
    'Nothing was read: no message in your history has the id Infinity. Pass the "id" of a history--search or '
      + 'history--extract result.',
  );
  // A channel the message isn't in, quoted as any value the call gave is, cut to 80 UTF-16 units.
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: 'm1', channelId: 'x'.repeat(100) }),
    `Nothing was read: message "m1" isn't in channel "${'x'.repeat(79)}… (it's in "c1"). Leave out "channelId" to `
      + 'read around it in its own channel.',
  );
  // So is the channel the message is in, and the message's id.
  assert.equal(
    await refusal(bound(undefined, undefined, 'c'.repeat(100)), 'extract', { aroundId: 'm1', channelId: 'c2' }),
    `Nothing was read: message "m1" isn't in channel "c2" (it's in "${'c'.repeat(79)}…). Leave out "channelId" to `
      + 'read around it in its own channel.',
  );
  assert.equal(
    await refusal(bound(undefined, undefined, undefined, 'm'.repeat(100)), 'extract', { aroundId: 'm'.repeat(100), channelId: 'c2' }),
    `Nothing was read: message "${'m'.repeat(79)}… isn't in channel "c2" (it's in "c1"). Leave out "channelId" to `
      + 'read around it in its own channel.',
  );
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: 'm1', from: AT, limit: 5 }),
    'Nothing was read: "aroundId" picks its own window, so it doesn\'t take "from" or "limit". Size the window with '
      + '"before" and "after", or leave out "aroundId" to read a range.',
  );
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: 'm1', author: ['alice'] }),
    'Nothing was read: "aroundId" reads the whole conversation around one message, so author filters don\'t apply '
      + 'to it. To find someone\'s messages, use history--search or history--extract with "author".',
  );
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: 'm1', channelId: 'c1', allChannels: true }),
    'Nothing was read: "channelId" and "allChannels" can\'t go together. Leave out "channelId" to read around the '
      + 'message in every channel, or leave out both to read around it in its own channel.',
  );
  // Each way it names reads around the message, in every channel and in its own; a channelId other than its own
  // is refused, below.
  for (const [input, channelId] of [[{ aroundId: 'm1', allChannels: true }, null], [{ aroundId: 'm1' }, 'c1']] as const) {
    const read = await answer<{ anchorId: string; channelId: string | null }>(bound(), 'extract', input);
    assert.deepEqual([read.anchorId, read.channelId], ['m1', channelId], JSON.stringify(input));
  }
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: 'sum:s1' }),
    'Nothing was read: "sum:s1" is a compression summary, not a message. history--overview reads summaries; '
      + '"aroundId" takes a message, such as the "id" of a history--search or history--extract result.',
  );
  assert.equal(
    await refusal(withIndex(t, 'http://127.0.0.1:9'), 'extract', { aroundId: 'sum:s1' }),
    'Nothing was read: "sum:s1" is a compression summary, not a message. history--overview reads summaries; '
      + '"aroundId" takes a message, such as the "messageId" of a history--semantic_search hit.',
  );
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: 'm1', channelId: 'c2' }),
    'Nothing was read: message "m1" isn\'t in channel "c2" (it\'s in "c1"). Leave out "channelId" to read around it '
      + 'in its own channel.',
  );
});

test('a timestamp too many messages share names the instant, and reading it whole with extract works', async () => {
  assert.equal(
    await refusal(bound(5001), 'extract', { aroundId: 'm1' }),
    `Nothing was read: more than 5000 messages share the timestamp of message "m1", ${AT}, too many for aroundId to `
      + `put in order. To read them, call history--extract with "from" and "to" both set to ${AT} and "channelId" `
      + 'set to "c1"; it pages through them with "offset" and "limit".',
  );
  // The channel is the agent's to send, so it's quoted whole, however long, and the message's id is quoted cut to
  // 80 UTF-16 units, as a value a message names is.
  assert.equal(
    await refusal(bound(5001, undefined, 'c'.repeat(100)), 'extract', { aroundId: 'm1' }),
    `Nothing was read: more than 5000 messages share the timestamp of message "m1", ${AT}, too many for aroundId to `
      + `put in order. To read them, call history--extract with "from" and "to" both set to ${AT} and "channelId" `
      + `set to "${'c'.repeat(100)}"; it pages through them with "offset" and "limit".`,
  );
  assert.equal(
    await refusal(bound(5001, undefined, undefined, 'm'.repeat(100)), 'extract', { aroundId: 'm'.repeat(100) }),
    `Nothing was read: more than 5000 messages share the timestamp of message "${'m'.repeat(79)}…, ${AT}, too many `
      + `for aroundId to put in order. To read them, call history--extract with "from" and "to" both set to ${AT} and `
      + '"channelId" set to "c1"; it pages through them with "offset" and "limit".',
  );
  assert.equal(
    await refusal(bound(5001), 'extract', { aroundId: 'm1', allChannels: true }),
    `Nothing was read: more than 5000 messages share the timestamp of message "m1", ${AT}, too many for aroundId to `
      + `put in order. To read them, call history--extract with "from" and "to" both set to ${AT}; it pages through `
      + 'them with "offset" and "limit".',
  );
  // A search continuation stepping past an instant: the count is by channel
  // alone, so the remedy is a channel or extract, never an author filter.
  assert.equal(
    await refusal(bound(5001), 'search', { query: 'x', from: AT, skipSequences: [0, 1] }),
    `Nothing was searched: more than 5000 messages share the instant ${AT}, too many for a continuation to step `
      + `past. To read them, call history--extract with "from" and "to" both set to ${AT}; it pages through them `
      + 'with "offset" and "limit". Searching one channel, with "channelId", may also bring them under the limit.',
  );
  assert.equal(
    await refusal(bound(5001), 'search', { query: 'x', from: AT, channelId: 'c1', skipSequences: [0, 1] }),
    `Nothing was searched: more than 5000 messages share the instant ${AT}, too many for a continuation to step `
      + `past. To read them, call history--extract with "from" and "to" both set to ${AT} and the same "channelId"; `
      + 'it pages through them with "offset" and "limit".',
  );
  // The call those refusals advise, run: every message of the instant, a page at a time.
  type Page = { messages: Array<{ id: string; timestamp: string }>; hasMore: boolean };
  const h = bound(5001);
  const first = await answer<Page>(h, 'extract', { from: AT, to: AT, channelId: 'c1', limit: 3 });
  assert.deepEqual(first.messages.map((m) => m.id), ['t0', 't1', 't2']);
  assert.ok(first.messages.every((m) => m.timestamp === AT));
  assert.equal(first.hasMore, true);
  const next = await answer<Page>(h, 'extract', { from: AT, to: AT, channelId: 'c1', limit: 3, offset: 3 });
  assert.deepEqual(next.messages.map((m) => m.id), ['t3', 't4', 't5']);
  const last = await answer<Page>(h, 'extract', { from: AT, to: AT, limit: 3, offset: 4999 });
  assert.deepEqual(last.messages.map((m) => m.id), ['t4999', 't5000'], 'without channelId too, to the last of them');
  assert.equal(last.hasMore, false);
});

test("search's refusals name what it got and how to search instead", async () => {
  assert.equal(
    await refusal(bound(), 'search', {}),
    'Nothing was searched: "query" must be the text to look for; this call gave none.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: '' }),
    'Nothing was searched: "query" must be the text to look for; it\'s "".',
  );
  // A value that isn't text, other than a number, which is searched as its text. With "regex" and
  // "caseSensitive", a regular expression would take a list or true as its text too; it's refused all the same.
  for (const [query, quote] of [[true, 'true'], [[1], '[1]'], [{}, '{}'], [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'], [null, 'null']] as const) {
    for (const flags of [{}, { regex: true, caseSensitive: true }]) {
      assert.equal(
        await refusal(bound(), 'search', { query, ...flags }),
        `Nothing was searched: "query" must be the text to look for; it's ${quote}.`,
      );
    }
  }
  assert.equal(
    await refusal(bound(), 'search', { query: '(', regex: true }),
    'Nothing was searched: "query" "(" isn\'t a valid regular expression (Unterminated group). Fix the pattern, or '
      + 'set "regex" to false to search for the text as written.',
  );
  // V8's message restates the pattern, line breaks and all; the reason alone follows the quote.
  assert.equal(
    await refusal(bound(), 'search', { query: 'a\n(', regex: true }),
    'Nothing was searched: "query" "a\\n(" isn\'t a valid regular expression (Unterminated group). Fix the pattern, or '
      + 'set "regex" to false to search for the text as written.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', maxScan: 0 }),
    'Nothing was searched: "maxScan" is 0, which isn\'t a whole number from 1 to 50000. Pass one, or leave it out for 5000.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', order: 'up' }),
    'Nothing was searched: "order" must be "oldest" or "newest", or left out for "oldest"; it\'s "up".',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', wholeWord: true, regex: true }),
    'Nothing was searched: "wholeWord" applies to a search for text, not a regular expression. In a regular '
      + 'expression, write \\b around the pattern instead, or set "regex" to false.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', from: AT, skipSequences: [5, 2] }),
    'Nothing was searched: "skipSequences" must be two whole numbers, 0 or more, the first no larger than the '
      + 'second, as a search\'s "resume" gives it; it\'s [5,2]. Copy it from "resume" with its "from" or "to", or '
      + 'leave it out for a new search.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', skipSequences: [0, 1] }),
    'Nothing was searched: "skipSequences" goes with the "from" from the same "resume". Copy the fields of the '
      + 'previous response\'s "resume" into the call, or leave "skipSequences" out for a new search.',
  );
});

test('a value too long to quote whole is cut to 80 UTF-16 units, one fewer rather than split a surrogate pair', async () => {
  const refused = (order: string) => refusal(bound(), 'search', { query: 'x', order });
  const said = (quote: string) =>
    `Nothing was searched: "order" must be "oldest" or "newest", or left out for "oldest"; it's ${quote}.`;
  // As JSON, 39 of them are 80 units, so they're quoted whole.
  assert.equal(await refused(GRIN.repeat(39)), said(`"${GRIN.repeat(39)}"`));
  // 100 are 202 units: the 80th is the first half of the 40th, so the quote keeps 79 units, the mark and 39 of them.
  assert.equal(await refused(GRIN.repeat(100)), said(`"${GRIN.repeat(39)}…`));
  // After an "a", the 80th unit ends the 39th, so the quote keeps all 80.
  assert.equal(await refused(`a${GRIN.repeat(100)}`), said(`"a${GRIN.repeat(39)}…`));
  // A summary id given to extract, and a pattern that isn't a valid regular expression, are cut the same way.
  assert.equal(
    await refusal(bound(), 'extract', { aroundId: `sum:${'x'.repeat(100)}` }),
    `Nothing was read: "sum:${'x'.repeat(75)}… is a compression summary, not a message. history--overview reads `
      + 'summaries; "aroundId" takes a message, such as the "id" of a history--search or history--extract result.',
  );
  assert.equal(
    await refusal(bound(), 'search', { query: `(${'a'.repeat(100)}`, regex: true }),
    `Nothing was searched: "query" "(${'a'.repeat(78)}… isn't a valid regular expression (Unterminated group). `
      + 'Fix the pattern, or set "regex" to false to search for the text as written.',
  );
  // Inside a list, JSON writes Infinity as null, and so does the quote.
  assert.equal(
    await refusal(bound(), 'search', { query: 'x', from: AT, skipSequences: [0, Infinity] }),
    'Nothing was searched: "skipSequences" must be two whole numbers, 0 or more, the first no larger than the '
      + 'second, as a search\'s "resume" gives it; it\'s [0,null]. Copy it from "resume" with its "from" or "to", or '
      + 'leave it out for a new search.',
  );
});

test('a number given as the query is read as its text, whichever way the search is made', async () => {
  const s = store();
  (s.getMessage('m1') as unknown as { content: unknown[] }).content = [{ type: 'text', text: 'due in 2026' }];
  const h = new HistoryModule();
  h.bind(s);
  for (const flags of [{}, { caseSensitive: true }, { caseSensitive: true, wholeWord: true }, { regex: true }, { regex: true, caseSensitive: true }]) {
    const found = await answer<{ matches: Array<{ id: string; snippet: string }> }>(h, 'search', { query: 2026, ...flags });
    assert.deepEqual(found.matches.map((m) => [m.id, m.snippet]), [['m1', 'due in 2026']], JSON.stringify(flags));
  }
  // 0 too, as "0".
  const zero = await answer<{ matches: Array<{ id: string }> }>(h, 'search', { query: 0 });
  assert.deepEqual(zero.matches.map((m) => m.id), ['m1']);
});

test("semantic_search's refusals of its input say nothing was searched and what to send", async (t) => {
  assert.equal(
    await refusal(bound(), 'semantic_search', { query: 'x' }),
    "Nothing was searched: this host has no semantic index set up, so history--semantic_search isn't available "
      + "here, and calling it again won't change that. history--search finds messages by their words.",
  );
  const h = withIndex(t, 'http://127.0.0.1:9');
  assert.equal(
    await refusal(h, 'semantic_search', { query: '  ' }),
    'Nothing was searched: "query" must be a sentence describing what you\'re looking for; it\'s "  ".',
  );
  assert.equal(
    await refusal(h, 'semantic_search', {}),
    'Nothing was searched: "query" must be a sentence describing what you\'re looking for; this call gave none.',
  );
  assert.equal(
    await refusal(h, 'semantic_search', { query: 'x', limit: 0 }),
    'Nothing was searched: "limit" is 0, which isn\'t a whole number from 1 to 50. Pass one, or leave it out for 10.',
  );
  assert.equal(
    await refusal(h, 'semantic_search', { query: 'x', from: '2026-03-02', to: '2026-03-01' }),
    'Nothing was read: "from" ("2026-03-02") is after "to" ("2026-03-01"), so the range holds nothing. Swap them, or '
      + 'correct the one that\'s wrong.',
  );
  assert.equal(
    await refusal(h, 'semantic_search', { query: 'x', level: 1, kinds: 'messages' }),
    'Nothing was searched: "level" picks summaries, and "kinds" is "messages", so the two can\'t go together. '
      + 'Leave out "kinds" to search summaries of that level, or leave out "level" to search messages.',
  );
  for (const level of [-1, 1.5]) {
    assert.equal(
      await refusal(h, 'semantic_search', { query: 'x', level }),
      `Nothing was searched: "level" must be a whole number, 0 or more, such as 1; it's ${level}.`,
    );
  }
  // A channel beside what picks summaries, each way, and the retry that works.
  assert.equal(
    await refusal(h, 'semantic_search', { query: 'x', channelId: 'c1', kinds: 'summaries' }),
    'Nothing was searched: summaries aren\'t kept by channel, so "channelId" can\'t go with "kinds": "summaries". '
      + 'Leave out "channelId" to search summaries, or leave out "kinds" to search that channel\'s messages.',
  );
  assert.equal(
    await refusal(h, 'semantic_search', { query: 'x', channelId: 'c1', level: 1 }),
    'Nothing was searched: summaries aren\'t kept by channel, so "channelId" can\'t go with "level". Leave out '
      + '"channelId" to search summaries, or leave out "level" to search that channel\'s messages.',
  );
  assert.equal(
    await refusal(h, 'semantic_search', { query: 'x', channelId: 'c1', kinds: 'summaries', level: 1 }),
    'Nothing was searched: summaries aren\'t kept by channel, so "channelId" can\'t go with "kinds": "summaries" or '
      + '"level". Leave out "channelId" to search summaries, or leave out "kinds" and "level" to search that '
      + 'channel\'s messages.',
  );
  assert.equal(
    await refusal(h, 'semantic_search', { query: 'x', minScore: 2 }),
    'Nothing was searched: "minScore" must be a number from -1 to 1, or left out; it\'s 2.',
  );
});

test('a semantic search the index service fails says nothing was searched, and whether trying later can help', async (t) => {
  const meanwhile = 'history--search finds messages by their words meanwhile.';
  const later = `You can try again later; if it keeps happening, ask whoever runs this host. ${meanwhile}`;
  const noAnswer = 'If the service is down or slow, or the connection dropped, a later call can work; if its address '
    + `or certificate is wrong, none will until whoever runs this host fixes the semantic index's settings. ${meanwhile}`;
  const search = async (url: string, timeout?: number) => refusal(withIndex(t, url, timeout), 'semantic_search', { query: 'x' });
  assert.equal(
    await search(await service(t, 503, 'overloaded')),
    `Nothing was searched: the semantic index service answered the search request with an error (HTTP 503: overloaded). ${later}`,
  );
  assert.equal(
    await search(await service(t, 500, 'boom')),
    `Nothing was searched: the semantic index service answered the search request with an error (HTTP 500: boom). ${later}`,
  );
  assert.equal(
    await search(await service(t, 429, 'slow down')),
    `Nothing was searched: the semantic index service answered the search request with an error (HTTP 429: slow down). ${later}`,
  );
  assert.equal(
    await search(await service(t, 408, 'request timeout')),
    'Nothing was searched: the semantic index service answered the search request with an error (HTTP 408: request '
      + `timeout). ${later}`,
  );
  assert.equal(
    await search(await service(t, 400, 'k out of range')),
    'Nothing was searched: the semantic index service answered the search request with an error (HTTP 400: k out '
      + "of range). Calling it again the same way won't change that; if it keeps happening, ask whoever runs this "
      + `host. ${meanwhile}`,
  );
  // A 404 may be this store's index not made yet, which the first messages
  // indexed make, or a service without the route, which a later call won't change.
  assert.equal(
    await search(await service(t, 404, 'no such index')),
    'Nothing was searched: the semantic index service answered the search request with an error (HTTP 404: no such '
      + 'index). If this store\'s index doesn\'t exist yet, the first messages indexed create it, and a later call '
      + `can work; if it keeps happening, ask whoever runs this host. ${meanwhile}`,
  );
  // An answer that isn't a search's, such as a web page at a wrong address,
  // JSON without hits, or a hit without an id: a page shown while the
  // service restarts clears, and an address that points elsewhere doesn't.
  const notHits = 'If the service was restarting, a later call can work; if its address points at something else, '
    + `none will until whoever runs this host fixes the semantic index's settings. ${meanwhile}`;
  const hit = { id: 'msg:m1', score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 };
  // Each lacks what the tool reads of every hit: a hit at all, or a string id.
  const unreadable = [null, { ...hit, id: 5 }];
  const answers = [PAGE, { results: [] }, ...unreadable.map((h) => ({ namespace: 'test/ns', hits: [h], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }))];
  for (const body of answers) {
    assert.equal(
      await search(await routed(t, () => [200, body])),
      'Nothing was searched: the semantic index service answered the search request without a list of hits, each with '
        + `an id (HTTP 200). ${notHits}`,
      JSON.stringify(body),
    );
  }
  // No answer within the timeout.
  assert.equal(
    await search(await listen(t, createServer(() => {})), 300),
    `Nothing was searched: the semantic index service didn't answer the search request within 300 ms. ${noAnswer}`,
  );
  // Nothing listening: the port of a server that has closed.
  const gone = createServer(() => {});
  await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve));
  const port = (gone.address() as AddressInfo).port;
  await new Promise<void>((resolve) => gone.close(() => resolve()));
  assert.equal(
    await search(`http://127.0.0.1:${port}`),
    'Nothing was searched: the semantic index service couldn\'t be reached for the search request (connect '
      + `ECONNREFUSED 127.0.0.1:${port}). ${noAnswer}`,
  );
});

test('a search that answered keeps its hits when searching again for more fails, and says why there are fewer', async (t) => {
  // The first search's two hits hold one message no longer on this branch,
  // so it searches again for more, and that search answers `second`.
  const kept = async (second: [number, unknown]): Promise<unknown> => {
    const url = await routed(t, (kind, n) => {
      if (kind !== 'search') return [404, { error: { message: 'no such index' } }];
      if (n > 0) return second;
      const hit = (id: string) => ({ id, score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 });
      return [200, { namespace: 'test/ns', hits: [hit('msg:m1'), hit('msg:undone')], count_indexed: 2, timing_ms: { embed: 1, search: 1 } }];
    });
    const found = await answer<{ hits: Array<{ messageId: string }>; index: Record<string, unknown>; timingMs: unknown }>(
      withIndex(t, url), 'semantic_search', { query: 'x', limit: 2 },
    );
    // What comes back is the first search's: its hit on this branch, its count and its timing.
    assert.deepEqual(found.hits.map((h) => h.messageId), ['m1']);
    assert.equal(found.index.droppedOffBranch, 1);
    assert.equal(found.index.indexed, 2);
    assert.deepEqual(found.timingMs, { embed: 1, search: 1 });
    // The background sync failed on its upsert before the search, and lastError is the client's sentence alone.
    assert.equal(
      found.index.lastError,
      'the semantic index service answered the upsert request with an error (HTTP 404: no such index)',
    );
    return found.index.searchAgainError;
  };
  const again = 'searching again for more hits failed: the semantic index service answered the search request';
  assert.equal(
    await kept([503, { error: { message: 'overloaded' } }]),
    `${again} with an error (HTTP 503: overloaded). Calling again may bring more.`,
  );
  assert.equal(
    await kept([400, { error: { message: 'k out of range' } }]),
    `${again} with an error (HTTP 400: k out of range). Calling again the same way won't change that.`,
  );
  assert.equal(
    await kept([200, PAGE]),
    `${again} without a list of hits, each with an id (HTTP 200). Calling again may bring more.`,
  );
  // A hit without an id, which every hit is read for, fails that search alone.
  const noId = { score: 1, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'x', chars: 1 };
  assert.equal(
    await kept([200, { namespace: 'test/ns', hits: [noId], count_indexed: 2, timing_ms: { embed: 2, search: 2 } }]),
    `${again} without a list of hits, each with an id (HTTP 200). Calling again may bring more.`,
  );
});

test("a hit whose ts or meta can't be read is returned without it, and the host is told which", async (t) => {
  const ids = Array.from({ length: 17 }, (_, i) => `m${i + 1}`);
  const messages = ids.map((id) => message(id, T, 'c1'));
  const hit = (id: string, fields: Record<string, unknown> = {}) => ({
    id: `msg:${id}`, score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null,
    meta: { participant: 'User', author: 'ann' }, text: 'hello', chars: 5, ...fields,
  });
  const { ts: _, ...undated } = hit('m2');
  const { meta: _meta, ...metaless } = hit('m14');
  const url = await routed(t, (kind) => {
    if (kind !== 'search') return [404, { error: { message: 'no such index' } }];
    const hits = [
      hit('m1'), undated, hit('m3', { ts: 'soon' }), hit('m4', { meta: null }), hit('m5', { ts: null }), hit('m6', { meta: 'quiet' }),
      hit('m7', { meta: [] }), hit('m8', { ts: '', meta: null }),
      // Values a multiplication would read as a date, or throw on: none of them is a number of seconds.
      hit('m9', { ts: false }), hit('m10', { ts: true }), hit('m11', { ts: [] }), hit('m12', { ts: { toString: 1 } }),
      // Text holding a number of seconds reads as main read it.
      hit('m13', { ts: String(T / 1000) }),
      // No meta at all; blank text, which Number() alone would read as 0; a number of seconds past any date a Date
      // holds; and text that starts with a number but isn't one.
      metaless, hit('m15', { ts: '   ' }), hit('m16', { ts: 1e20 }), hit('m17', { ts: '12abc' }),
    ];
    return [200, { namespace: 'test/ns', hits, count_indexed: 17, timing_ms: { embed: 1, search: 1 } }];
  });
  const warned = t.mock.method(console, 'warn', () => {});
  const h = new HistoryModule({ semantic: { url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
  h.bind({ ...store(), getMessage: (id: string) => messages.find((m) => m.id === id) ?? null } as unknown as ContextManager);
  t.after(() => h.stop());
  const found = await answer<{ hits: Array<{ messageId: string; timestamp: string | null; participant: unknown; author: unknown }> }>(
    h, 'semantic_search', { query: 'x', limit: 17 },
  );
  // Each is returned: a ts that makes no date, or none, reads as no timestamp, as a null one does, and a meta that
  // isn't an object as no participant or author.
  assert.deepEqual(found.hits.map((x) => [x.messageId, x.timestamp, x.participant, x.author]), [
    ['m1', AT, 'User', 'ann'],
    ['m2', null, 'User', 'ann'],
    ['m3', null, 'User', 'ann'],
    ['m4', AT, null, null],
    ['m5', null, 'User', 'ann'],
    ['m6', AT, null, null],
    ['m7', AT, null, null],
    ['m8', null, null, null],
    ['m9', null, 'User', 'ann'],
    ['m10', null, 'User', 'ann'],
    ['m11', null, 'User', 'ann'],
    ['m12', null, 'User', 'ann'],
    ['m13', AT, 'User', 'ann'],
    ['m14', AT, null, null],
    ['m15', null, 'User', 'ann'],
    ['m16', null, 'User', 'ann'],
    ['m17', null, 'User', 'ann'],
  ]);
  // The host is told of those whose data couldn't be read, once for the answer; a null ts was written so.
  const lines = warned.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes('a search returned'));
  assert.deepEqual(lines, [
    '[history/semantic] index "test/ns": a search returned hits whose ts or meta couldn\'t be read, without them: '
      + '"msg:m2" (ts), "msg:m3" (ts), "msg:m4" (meta), "msg:m6" (meta), "msg:m7" (meta), "msg:m8" (ts and meta), '
      + '"msg:m9" (ts), "msg:m10" (ts), "msg:m11" (ts), "msg:m12" (ts), "msg:m14" (meta), "msg:m15" (ts), "msg:m16" (ts), '
      + '"msg:m17" (ts)',
  ]);
});

test("a background sync whose upsert is answered with a web page, or JSON that isn't an object, keeps the client's sentence as lastError", async (t) => {
  const hit = { id: 'msg:m1', score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 };
  for (const body of [PAGE, [], null]) {
    const url = await routed(t, (kind) => {
      if (kind === 'search') return [200, { namespace: 'test/ns', hits: [hit], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }];
      if (kind === 'stats') return [404, { error: { message: 'no such index' } }];
      return [200, body];
    });
    const found = await answer<{ index: Record<string, unknown> }>(withIndex(t, url), 'semantic_search', { query: 'x', limit: 1 });
    assert.equal(
      found.index.lastError,
      'the semantic index service answered the upsert request without a JSON object (HTTP 200)',
      JSON.stringify(body),
    );
  }
});

test('a background sync whose stats request is answered without stats by kind walks from the start, and names the answer as lastError', async (t) => {
  const hit = { id: 'msg:m1', score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 };
  // JSON that isn't the service's stats, JSON whose stats by kind are a list or
  // null, and a web page at a wrong route.
  for (const body of [{ namespace: 'test/ns' }, { namespace: 'test/ns', by_kind: [] }, { namespace: 'test/ns', by_kind: null }, PAGE]) {
    let upserts = 0;
    const url = await routed(t, (kind) => {
      if (kind === 'search') return [200, { namespace: 'test/ns', hits: [hit], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }];
      if (kind === 'stats') return [200, body];
      if (kind === 'upsert') upserts++;
      return [200, { inserted: 1, updated: 0, unchanged: 0, count: 1 }];
    });
    const found = await answer<{ index: Record<string, unknown> }>(withIndex(t, url), 'semantic_search', { query: 'x', limit: 1 });
    // The store's one message reached the index, and the pass finished.
    assert.equal(upserts, 1);
    assert.equal(found.index.behind, false);
    assert.equal(
      found.index.lastError,
      'the semantic index service answered the stats request without stats by kind (HTTP 200)',
      JSON.stringify(body),
    );
  }
});

test('a sync pass names each failure it met in lastError once: the stats answer first on a pass that finishes, and what ended it first on one that fails', async (t) => {
  const notStats = 'the semantic index service answered the stats request without stats by kind (HTTP 200)';
  const deleteFailed = 'the semantic index service answered the delete request with an error (HTTP 500: delete failed)';
  const hit = { id: 'msg:m1', score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 };
  const url = await routed(t, (kind) => {
    if (kind === 'search') return [200, { namespace: 'test/ns', hits: [hit], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }];
    if (kind === 'stats') return [200, PAGE];
    if (kind === 'delete') return [500, { error: { message: 'delete failed' } }];
    return [200, { inserted: 1, updated: 0, unchanged: 0, count: 1 }];
  });
  t.mock.method(console, 'warn', () => {});
  // A module whose store tells it of edits or removals, made before its first pass.
  type Event = { type: string; messageId: string };
  const told = (at: string, ...events: Event[]): HistoryModule => {
    const listeners = new Set<(e: Event) => void>();
    const h = new HistoryModule({ semantic: { url: at, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
    h.bind({ ...store(), onMessage: (l: (e: Event) => void) => { listeners.add(l); return () => listeners.delete(l); } } as unknown as ContextManager);
    t.after(() => h.stop());
    for (const l of listeners) for (const event of events) l(event);
    return h;
  };
  const removal = { type: 'remove', messageId: 'm0' };
  // A pass that finishes: the stats answer, then the failed delete.
  const finished = await answer<{ index: Record<string, unknown> }>(told(url, removal), 'semantic_search', { query: 'x', limit: 1 });
  assert.equal(finished.index.behind, false);
  assert.equal(finished.index.lastError, `${notStats}; ${deleteFailed}`);
  // A pass whose budget runs out fails on the stats answer, and names the failed delete after it.
  const h = told(url, removal);
  await h.syncSemanticIndex(0);
  const ended = await answer<{ index: Record<string, unknown> }>(h, 'semantic_search', { query: 'x', limit: 1 });
  assert.equal(ended.index.behind, true);
  assert.equal(ended.index.lastError, `${notStats}; ${deleteFailed}`);
  // An edit's upsert and the walk's fail the same way: the sentence is named once.
  const overloaded = await routed(t, (kind) => {
    if (kind === 'search') return [200, { namespace: 'test/ns', hits: [hit], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }];
    if (kind === 'stats') return [404, { error: { message: 'no such index' } }];
    return [503, { error: { message: 'overloaded' } }];
  });
  const twice = await answer<{ index: Record<string, unknown> }>(told(overloaded, { type: 'edit', messageId: 'm1' }), 'semantic_search', { query: 'x', limit: 1 });
  const overload = 'the semantic index service answered the upsert request with an error (HTTP 503: overloaded)';
  assert.equal(twice.index.lastError, overload);
  // A failed delete and a failed edit's upsert in one pass are each named, in the order met.
  const both = await routed(t, (kind, n) => {
    if (kind === 'search') return [200, { namespace: 'test/ns', hits: [hit], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }];
    if (kind === 'stats') return [404, { error: { message: 'no such index' } }];
    if (kind === 'delete') return [500, { error: { message: 'delete failed' } }];
    // The edit's upsert comes first, before the walk's.
    return n === 0 ? [503, { error: { message: 'overloaded' } }] : [200, { inserted: 1, updated: 0, unchanged: 0, count: 1 }];
  });
  const twoKinds = await answer<{ index: Record<string, unknown> }>(told(both, removal, { type: 'edit', messageId: 'm1' }), 'semantic_search', { query: 'x', limit: 1 });
  assert.equal(twoKinds.index.lastError, `${deleteFailed}; ${overload}`);
  // A pass that met a stats answer that isn't stats, and then failed on the walk's upsert, names what ended it
  // first, and the stats answer after it.
  const pageThenOverload = await routed(t, (kind) => {
    if (kind === 'search') return [200, { namespace: 'test/ns', hits: [hit], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }];
    if (kind === 'stats') return [200, PAGE];
    return [503, { error: { message: 'overloaded' } }];
  });
  const failedPass = await answer<{ index: Record<string, unknown> }>(told(pageThenOverload), 'semantic_search', { query: 'x', limit: 1 });
  assert.equal(failedPass.index.behind, true);
  assert.equal(failedPass.index.lastError, `${overload}; ${notStats}`);
  // And the failures of its edits and removals after those, each named after the one before it.
  const deleteOverloaded = 'the semantic index service answered the delete request with an error (HTTP 503: overloaded)';
  const failedWithRemoval = await answer<{ index: Record<string, unknown> }>(told(pageThenOverload, removal), 'semantic_search', { query: 'x', limit: 1 });
  assert.equal(failedWithRemoval.index.behind, true);
  assert.equal(failedWithRemoval.index.lastError, `${overload}; ${notStats}; ${deleteOverloaded}`);
});

test('a background sync without stats fails on that answer when its budget cuts the walk short', async (t) => {
  // More messages than the sync before a search may send (256): with no
  // watermark, every pass would walk the same first page again.
  const messages = Array.from({ length: 300 }, (_, i) => message(`m${i + 1}`, T + i, 'c1'));
  const many = {
    ...store(),
    getMessage: (id: string) => messages.find((m) => m.id === id) ?? null,
    queryMessagesByTime(args: { fromMs?: number; limit?: number; offset?: number }) {
      const from = messages.filter((m) => args.fromMs === undefined || m.timestamp.getTime() >= args.fromMs);
      const offset = args.offset ?? 0;
      return { messages: from.slice(offset, offset + (args.limit ?? from.length)), matchedCount: from.length };
    },
  } as unknown as ContextManager;
  const hit = { id: 'msg:m1', score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 };
  const url = await routed(t, (kind) => {
    if (kind === 'search') return [200, { namespace: 'test/ns', hits: [hit], count_indexed: 1, timing_ms: { embed: 1, search: 1 } }];
    if (kind === 'stats') return [200, PAGE];
    return [200, { inserted: 1, updated: 0, unchanged: 0, count: 1 }];
  });
  const warned = t.mock.method(console, 'warn', () => {});
  // Batches of 100, so the 256 the pass walks end in a batch of 56, sent before the pass fails.
  const h = new HistoryModule({ semantic: { url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0, syncBatch: 100 } });
  h.bind(many);
  t.after(() => h.stop());
  const found = await answer<{ index: Record<string, unknown> }>(h, 'semantic_search', { query: 'x', limit: 1 });
  const notStats = 'the semantic index service answered the stats request without stats by kind (HTTP 200)';
  assert.equal(found.index.behind, true);
  assert.equal(found.index.syncedThisCall, 256);
  assert.equal(found.index.lastError, notStats);
  const lines = warned.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(lines.includes(`[history/semantic] index "test/ns": sync failed (1×, retry in 5s): ${notStats}`), JSON.stringify(lines));
});

test('when searching again fails, the hits it keeps are checked as they are after that search, not before it', async (t) => {
  // m1 and m2 are on this branch, and the first search's third hit isn't, so it searches again for more. While
  // that search waits, m1 is edited and m2 deleted, and the search fails.
  const texts = new Map([['m1', 'hello'], ['m2', 'hello']]);
  const s = store();
  (s as unknown as { getMessage: (id: string) => StoredMessage | null }).getMessage = (id) => {
    const text = texts.get(id);
    if (text === undefined) return null;
    const m = message(id, T, 'c1');
    (m as unknown as { content: unknown[] }).content = [{ type: 'text', text }];
    return m;
  };
  const hit = (id: string) => ({ id, score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 });
  const url = await routed(t, (kind, n) => {
    if (kind !== 'search') return [404, { error: { message: 'no such index' } }];
    if (n === 0) {
      return [200, { namespace: 'test/ns', hits: [hit('msg:m1'), hit('msg:m2'), hit('msg:undone')], count_indexed: 3, timing_ms: { embed: 1, search: 1 } }];
    }
    texts.set('m1', 'goodbye');
    texts.delete('m2');
    return [503, { error: { message: 'overloaded' } }];
  });
  const h = new HistoryModule({ semantic: { url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
  t.mock.method(console, 'warn', () => {});
  h.bind(s);
  t.after(() => h.stop());
  const found = await answer<{ hits: Array<{ messageId: string; snippet: string; chars: number }>; index: Record<string, unknown> }>(
    h, 'semantic_search', { query: 'x', limit: 3 },
  );
  // m1 with its text as edited, and m2 gone with the hit off the branch.
  assert.deepEqual(found.hits.map((x) => [x.messageId, x.snippet, x.chars]), [['m1', 'goodbye', 7]]);
  assert.equal(found.index.droppedOffBranch, 2);
  assert.equal(
    found.index.searchAgainError,
    'searching again for more hits failed: the semantic index service answered the search request with an error '
      + '(HTTP 503: overloaded). Calling again may bring more.',
  );
});

test('when a third search fails, the hits come back from the second, the last that answered', async (t) => {
  const hit = (id: string) => ({ id, score: 0.9, ts: T / 1000, channel: 'c1', kind: 'message', level: null, meta: {}, text: 'hello', chars: 5 });
  const gone = (n: number) => Array.from({ length: n }, (_, i) => hit(`msg:undone${i}`));
  // limit 2: the first search (k 2) finds nothing on this branch, the second
  // (k 8) finds m1 among eight, and the third (k 32) fails.
  const url = await routed(t, (kind, n) => {
    if (kind !== 'search') return [404, { error: { message: 'no such index' } }];
    if (n === 0) return [200, { namespace: 'test/ns', hits: gone(2), count_indexed: 9, timing_ms: { embed: 1, search: 1 } }];
    if (n === 1) return [200, { namespace: 'test/ns', hits: [hit('msg:m1'), ...gone(7)], count_indexed: 9, timing_ms: { embed: 2, search: 2 } }];
    return [503, { error: { message: 'overloaded' } }];
  });
  const found = await answer<{ hits: Array<{ messageId: string }>; index: Record<string, unknown>; timingMs: unknown }>(
    withIndex(t, url), 'semantic_search', { query: 'x', limit: 2 },
  );
  assert.deepEqual(found.hits.map((h) => h.messageId), ['m1']);
  assert.equal(found.index.droppedOffBranch, 7);
  assert.deepEqual(found.timingMs, { embed: 2, search: 2 });
  assert.equal(
    found.index.searchAgainError,
    'searching again for more hits failed: the semantic index service answered the search request with an error '
      + '(HTTP 503: overloaded). Calling again may bring more.',
  );
});

test("the index client's failure carries the service's status, and a namespace that doesn't exist yet reads as no stats", async (t) => {
  assert.equal(await client(await service(t, 404, 'no such namespace')).stats(), null);
  const failing = await failed(client(await service(t, 500, 'boom')).stats());
  assert.equal(failing.status, 500);
  assert.equal(failing.message, 'the semantic index service answered the stats request with an error (HTTP 500: boom)');
  // A body that isn't the service's JSON error is quoted to its first 200 UTF-16 units, and "…" marks the cut:
  // here the 200th is the first half of the 100th character after the "x", so the quote keeps 199 units, the "x"
  // and 99 of them.
  const long = await failed(client(await routed(t, () => [500, `x${GRIN.repeat(250)}`])).stats());
  assert.equal(
    long.message,
    `the semantic index service answered the stats request with an error (HTTP 500: x${GRIN.repeat(99)}…)`,
  );
  // So is the service's own message, and one that isn't text gives way to the body.
  const longMessage = await failed(client(await routed(t, () => [500, { error: { message: `y${GRIN.repeat(250)}` } }])).stats());
  assert.equal(
    longMessage.message,
    `the semantic index service answered the stats request with an error (HTTP 500: y${GRIN.repeat(99)}…)`,
  );
  // One of exactly 200 units isn't cut, and has no mark.
  const whole = await failed(client(await routed(t, () => [500, { error: { message: 'z'.repeat(200) } }])).stats());
  assert.equal(
    whole.message,
    `the semantic index service answered the stats request with an error (HTTP 500: ${'z'.repeat(200)})`,
  );
  // Every other body quotes as it came: JSON that isn't an object, an object without an error or whose error isn't
  // one, an error without a message, and a message that's a number or a list. A message of "" quotes nothing.
  for (const [body, quote] of [
    [null, ': null'], [42, ': 42'], [[], ': []'], [{ detail: 'Not Found' }, ': {"detail":"Not Found"}'],
    [{ error: 'boom' }, ': {"error":"boom"}'], [{ error: {} }, ': {"error":{}}'], [{ error: { message: '' } }, ''],
    [{ error: { message: 42 } }, ': {"error":{"message":42}}'], [{ error: { message: ['a'] } }, ': {"error":{"message":["a"]}}'],
  ] as const) {
    const shape = await failed(client(await routed(t, () => [500, body])).stats());
    assert.equal(shape.message, `the semantic index service answered the stats request with an error (HTTP 500${quote})`, JSON.stringify(body));
  }
  const notText = await failed(client(await routed(t, () => [500, { error: { message: { code: 7 } } }])).stats());
  assert.equal(
    notText.message,
    'the semantic index service answered the stats request with an error (HTTP 500: {"error":{"message":{"code":7}}})',
  );

  // The timeout as the client used it: whole seconds, or else milliseconds.
  const silent = await listen(t, createServer(() => {}));
  for (const [ms, within] of [[1000, '1 s'], [1100, '1100 ms']] as const) {
    const late = await failed(client(silent, ms).stats());
    assert.equal(late.message, `the semantic index service didn't answer the stats request within ${within}`);
    assert.equal(late.status, null);
  }
});

test('an answer cut off after its status counts as no answer, and says it was cut off', async (t) => {
  // Node's fetch rejects the body's read with the socket's error as its cause.
  t.mock.method(globalThis, 'fetch', async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
      },
    }),
    { status: 404 },
  ));
  // So a 404 cut off isn't read as no stats, and the sync asks again on a later pass.
  const cut = await failed(client('http://127.0.0.1:9').stats());
  assert.equal(cut.status, null);
  assert.equal(cut.message, "the semantic index service's answer to the stats request was cut off (other side closed)");
});

test("an answer that doesn't finish within the timeout says so, and counts as no answer", async (t) => {
  // The status and the start of the body come, and the rest never does.
  const stalled = await listen(t, createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"by_kind":');
  }));
  // A second, far longer than the status takes to arrive over a local socket: the verdict needs the status within
  // the timeout, and the margin is wide.
  const late = await failed(client(stalled, 1000).stats());
  assert.equal(late.status, null);
  assert.equal(late.message, "the semantic index service's answer to the stats request didn't finish within 1 s");
});

test('a request no address took names each address that refused it', async (t) => {
  // Node's fetch tries each address of a name like localhost, and reports
  // them together in an AggregateError with no message of its own.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', {
      cause: new AggregateError([new Error('connect ECONNREFUSED ::1:9'), new Error('connect ECONNREFUSED 127.0.0.1:9')], ''),
    });
  });
  const unreached = await failed(client('http://localhost:9').stats());
  assert.equal(unreached.status, null);
  assert.equal(
    unreached.message,
    "the semantic index service couldn't be reached for the stats request (connect ECONNREFUSED ::1:9; connect "
      + 'ECONNREFUSED 127.0.0.1:9)',
  );
});

test("the index's background sync names the index in the lines it logs", async (t) => {
  const h = new HistoryModule({
    semantic: { url: await service(t, 503, 'overloaded'), token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 },
  });
  const warned = t.mock.method(console, 'warn', () => {});
  // This store has no onMessage, so the indexer says edits and removals won't reach the index.
  h.bind(store());
  t.after(() => h.stop());
  await refusal(h, 'semantic_search', { query: 'x' });
  const lines = warned.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    lines.includes(
      '[history/semantic] index "test/ns": the context-manager has no onMessage, so edits and removals won\'t reach '
        + 'the index',
    ),
    JSON.stringify(lines),
  );
  assert.ok(
    lines.includes(
      '[history/semantic] index "test/ns": sync failed (1×, retry in 5s): the semantic index service answered the '
        + 'stats request with an error (HTTP 503: overloaded)',
    ),
    JSON.stringify(lines),
  );
});
