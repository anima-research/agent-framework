import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryModule } from '../src/modules/history/index.js';
import type { ContextManager, StoredMessage, IndexedMessageQueryResult } from '@animalabs/context-manager';
import type { ToolCall } from '../src/types/events.js';

/**
 * Author filter, extract-around-id, wholeWord, order:"newest" and the
 * scannedThrough resume point (Fable's history-tool UX feedback, 09-22).
 * Same stub posture as history-module.test.ts: in-memory filtering that
 * mirrors the native query contract (time-ordered, both-ends-inclusive,
 * offset/limit applied after filtering, matchedCount = pre-pagination).
 */

interface Spec {
  id: string;
  ms: number;
  text: string;
  channel?: string;
  /** metadata.author.name — MCPL-ingested messages are participant "user". */
  author?: string;
  authorId?: string;
  participant?: string;
}

function mk(s: Spec): StoredMessage {
  const metadata: Record<string, unknown> = {};
  if (s.channel) metadata.channelId = s.channel;
  if (s.author || s.authorId) metadata.author = { id: s.authorId ?? `id-${s.author}`, name: s.author };
  return {
    id: s.id,
    sequence: Number(s.id.replace(/\D/g, '')),
    participant: s.participant ?? (s.author ? 'user' : 'Fable'),
    content: [{ type: 'text', text: s.text }],
    metadata,
    timestamp: new Date(s.ms),
  } as unknown as StoredMessage;
}

/**
 * Mirrors the REAL MessageStore contracts, including the unkind ones (the
 * first version of this feature passed a kinder stub and failed on a real
 * store): a time-only/unfiltered query is timestamp-ordered and its
 * matchedCount is just the PAGE size; a channel-scoped query is APPEND
 * (sequence) ordered with an exact matchedCount; queryMessagesByTime
 * supports reverse.
 */
function stub(messages: StoredMessage[]) {
  const calls: Array<Record<string, unknown>> = [];
  const byTs = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.sequence - b.sequence);
  const bySeq = [...messages].sort((a, b) => a.sequence - b.sequence);
  const inRange = (m: StoredMessage, f?: number, t?: number) => {
    const ts = m.timestamp.getTime();
    return (f === undefined || ts >= f) && (t === undefined || ts <= t);
  };
  const chan = (m: StoredMessage) => (m.metadata as { channelId?: string }).channelId;
  const queryMessagesByTime = (args: { fromMs?: number; toMs?: number; limit?: number; offset?: number; reverse?: boolean }): IndexedMessageQueryResult => {
    calls.push({ method: 'time', ...args });
    let list = byTs.filter((m) => inRange(m, args.fromMs, args.toMs));
    if (args.reverse) list = list.reverse();
    const offset = args.offset ?? 0;
    const page = list.slice(offset, args.limit === undefined ? undefined : offset + args.limit);
    return { messages: page, matchedCount: page.length };
  };
  const cm = {
    queryMessagesByTime,
    queryMessagesByTimeAndChannel(args: { fromMs?: number; toMs?: number; channelId?: string; limit?: number; offset?: number }): IndexedMessageQueryResult {
      if (args.channelId === undefined) return queryMessagesByTime(args);
      calls.push({ method: 'timeAndChannel', ...args });
      const filtered = bySeq.filter((m) => inRange(m, args.fromMs, args.toMs) && chan(m) === args.channelId);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? filtered.length;
      return { messages: filtered.slice(offset, offset + limit), matchedCount: filtered.length };
    },
    getMessage(id: string): StoredMessage | null {
      return messages.find((m) => m.id === id) ?? null;
    },
  } as unknown as ContextManager;
  const mod = new HistoryModule();
  mod.bind(cm);
  return { mod, calls };
}

async function call(mod: HistoryModule, name: string, input: Record<string, unknown>) {
  return mod.handleToolCall({ id: 't', name, input } as ToolCall);
}

function data(r: { success: boolean; data?: unknown; error?: string }): any {
  assert.equal(r.success, true, r.error);
  return r.data;
}

const T0 = Date.parse('2026-09-20T00:00:00Z');
const min = (n: number) => T0 + n * 60_000;

// Diary-shaped fixture: antra and Fable talking in #diary, plus a heartbeat
// and Fable's own journal checklist that mention "mission" too.
const fixture = [
  mk({ id: 'm1', ms: min(1), text: 'the mission today is the museum', channel: 'diary', author: 'antra' }),
  mk({ id: 'm2', ms: min(2), text: 'museum of the uncommissioned — checklist', channel: 'diary' }), // Fable's own
  mk({ id: 'm3', ms: min(3), text: 'heartbeat: mission status nominal', channel: 'diary', author: 'heartbeat' }),
  mk({ id: 'm4', ms: min(4), text: 'Mission accomplished, I think', channel: 'diary', author: 'antra' }),
  mk({ id: 'm5', ms: min(5), text: 'meanwhile elsewhere', channel: 'general', author: 'antra' }),
  mk({ id: 'm6', ms: min(6), text: 'what was the mission again?', channel: 'diary', author: 'Joanne' }),
  mk({ id: 'm7', ms: min(7), text: 'миссия выполнена', channel: 'diary', author: 'antra' }),
];

describe('HistoryModule UX: author filter', () => {
  it('search author keeps only that author (case-insensitive, @ tolerated) and reports author on matches', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'search', { query: 'mission', author: '@Antra' }));
    assert.deepEqual(d.matches.map((m: any) => m.id), ['m1', 'm4']);
    assert.equal(d.matches[0].author, 'antra');
    assert.equal(d.matches[0].participant, 'user');
    assert.equal(d.candidatePoolSize, 7);
    assert.equal(d.afterAuthorFilter, 4);
  });

  it('author is exact, never substring ("ann" does not pull in Joanne/antra)', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'search', { query: 'mission', author: 'ann' }));
    assert.deepEqual(d.matches, []);
  });

  it('author matches author id, a <@id> mention, and participant for own turns', async () => {
    const { mod } = stub([
      mk({ id: 'a1', ms: min(1), text: 'x', author: 'antra', authorId: '12345' }),
      mk({ id: 'a2', ms: min(2), text: 'x' }), // participant Fable
      mk({ id: 'a3', ms: min(3), text: 'x', author: 'bob' }),
    ]);
    assert.deepEqual(data(await call(mod, 'search', { query: 'x', author: '<@12345>' })).matches.map((m: any) => m.id), ['a1']);
    assert.deepEqual(data(await call(mod, 'search', { query: 'x', author: 'fable' })).matches.map((m: any) => m.id), ['a2']);
    assert.deepEqual(data(await call(mod, 'search', { query: 'x', author: ['bob', 'Fable'] })).matches.map((m: any) => m.id), ['a2', 'a3']);
  });

  it('excludeAuthor drops heartbeats and own turns', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'search', { query: 'mission', excludeAuthor: ['heartbeat', 'Fable'] }));
    assert.deepEqual(d.matches.map((m: any) => m.id), ['m1', 'm4', 'm6']);
  });

  it('rejects an empty or non-string author spec', async () => {
    const { mod } = stub(fixture);
    assert.equal((await call(mod, 'search', { query: 'x', author: [] })).success, false);
    assert.equal((await call(mod, 'search', { query: 'x', author: [5] })).success, false);
  });

  it('extract author: offset/limit over the filtered sequence, exact matchedCount when exhausted', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'extract', { author: 'antra', limit: 2, offset: 1 }));
    assert.deepEqual(d.messages.map((m: any) => m.id), ['m4', 'm5']);
    assert.equal(d.messages[0].author, 'antra');
    // page full + one more antra message (m7) exists → not a total
    assert.equal(d.truncated, true);
    assert.equal(d.matchedCountAtLeast, 4);
    const all = data(await call(mod, 'extract', { author: 'antra' }));
    assert.equal(all.truncated, false);
    assert.equal(all.matchedCount, 4);
    assert.equal(all.scanned, 7);
  });

  it('extract author: maxScan bound reports truncated + scannedThrough, and a window of exactly maxScan is complete', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'extract', { author: 'antra', maxScan: 3 }));
    assert.equal(d.truncated, true);
    assert.equal(d.scanned, 3);
    assert.equal(d.scannedThrough, new Date(min(3)).toISOString());
    assert.deepEqual(d.messages.map((m: any) => m.id), ['m1']);
    const exact = data(await call(mod, 'extract', { author: 'antra', maxScan: 7 }));
    assert.equal(exact.truncated, false);
    assert.equal(exact.matchedCount, 4);
  });
});

describe('HistoryModule UX: wholeWord', () => {
  it('"mission" no longer matches inside "uncommissioned"', async () => {
    const { mod } = stub([
      mk({ id: 'w1', ms: min(1), text: 'museum of the uncommissioned' }),
      mk({ id: 'w2', ms: min(2), text: 'the Mission, finally' }),
    ]);
    assert.deepEqual(data(await call(mod, 'search', { query: 'mission' })).matches.map((m: any) => m.id), ['w1', 'w2']);
    assert.deepEqual(data(await call(mod, 'search', { query: 'mission', wholeWord: true })).matches.map((m: any) => m.id), ['w2']);
  });

  it('is Unicode-aware and finds a later whole-word occurrence after an embedded one', async () => {
    const { mod } = stub([
      mk({ id: 'u1', ms: min(1), text: 'суперкот и кот' }),
      mk({ id: 'u2', ms: min(2), text: 'котёнок' }),
    ]);
    const d = data(await call(mod, 'search', { query: 'кот', wholeWord: true }));
    assert.deepEqual(d.matches.map((m: any) => m.id), ['u1']);
    assert.match(d.matches[0].snippet, /и кот/);
  });

  it('does not demand word boundaries next to a needle\'s own punctuation', async () => {
    const { mod } = stub([mk({ id: 'p1', ms: min(1), text: 'see #general2 and #general' })]);
    assert.equal(data(await call(mod, 'search', { query: '#general', wholeWord: true })).matches.length, 1);
  });

  it('is rejected together with regex', async () => {
    const { mod } = stub(fixture);
    const r = await call(mod, 'search', { query: 'a', regex: true, wholeWord: true });
    assert.equal(r.success, false);
    assert.match(r.error!, /\\b/);
  });
});

describe('HistoryModule UX: order + scannedThrough', () => {
  it('order:newest scans the most recent maxScan and returns newest-first, with a to: resume point', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'search', { query: 'mission', order: 'newest', maxScan: 4 }));
    // window = m4..m7, newest first; m7 is Cyrillic so no match
    assert.deepEqual(d.matches.map((m: any) => m.id), ['m6', 'm4']);
    assert.equal(d.truncated, true);
    assert.equal(d.scannedThrough, new Date(min(4)).toISOString());
    assert.match(d.hint, /to:/);
  });

  it('order:oldest truncated → from: resume point at the pool edge', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'search', { query: 'zzz', maxScan: 2 }));
    assert.equal(d.truncated, true);
    assert.equal(d.scannedThrough, new Date(min(2)).toISOString());
    assert.match(d.hint, /from:/);
  });

  it('stopping at limit also yields scannedThrough at the last scanned candidate', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'search', { query: 'mission', limit: 1 }));
    assert.equal(d.truncated, false);
    assert.equal(d.scannedThrough, new Date(min(1)).toISOString());
  });

  it('a complete, un-limited scan carries no resume point', async () => {
    const { mod } = stub(fixture);
    const d = data(await call(mod, 'search', { query: 'mission' }));
    assert.equal(d.scannedThrough, undefined);
    assert.equal(d.order, 'oldest');
  });

  it('rejects an unknown order', async () => {
    const { mod } = stub(fixture);
    assert.equal((await call(mod, 'search', { query: 'x', order: 'sideways' })).success, false);
  });
});

describe('HistoryModule UX: extract aroundId', () => {
  const conv = Array.from({ length: 30 }, (_, i) =>
    mk({ id: `c${i + 1}`, ms: min(i + 1), text: `line ${i + 1}`, channel: i % 3 === 0 ? 'other' : 'diary', author: 'antra' }),
  );

  it('defaults to the anchor\'s own channel, before/after around it, anchor flagged', async () => {
    const { mod } = stub(conv);
    // c11 is index 10 → 10%3=1 → diary
    const d = data(await call(mod, 'extract', { aroundId: 'c11', before: 2, after: 3 }));
    assert.equal(d.channelId, 'diary');
    assert.deepEqual(d.messages.map((m: any) => m.id), ['c8', 'c9', 'c11', 'c12', 'c14', 'c15']);
    assert.equal(d.messages.find((m: any) => m.anchor)?.id, 'c11');
  });

  it('allChannels interleaves every channel', async () => {
    const { mod } = stub(conv);
    const d = data(await call(mod, 'extract', { aroundId: 'c11', before: 2, after: 2, allChannels: true }));
    assert.deepEqual(d.messages.map((m: any) => m.id), ['c9', 'c10', 'c11', 'c12', 'c13']);
    assert.equal(d.channelId, null);
  });

  it('clips at the ends of history', async () => {
    const { mod } = stub(conv);
    const d = data(await call(mod, 'extract', { aroundId: 'c2', before: 5, after: 1 }));
    assert.deepEqual(d.messages.map((m: any) => m.id), ['c2', 'c3']);
  });

  it('handles same-millisecond neighbours in sequence order', async () => {
    const t = min(100);
    const { mod } = stub([
      mk({ id: 's1', ms: t - 1, text: 'a', channel: 'x' }),
      mk({ id: 's2', ms: t, text: 'b', channel: 'x' }),
      mk({ id: 's3', ms: t, text: 'c', channel: 'x' }),
      mk({ id: 's4', ms: t, text: 'd', channel: 'x' }),
      mk({ id: 's5', ms: t + 1, text: 'e', channel: 'x' }),
    ]);
    const d = data(await call(mod, 'extract', { aroundId: 's3', before: 2, after: 1 }));
    assert.deepEqual(d.messages.map((m: any) => m.id), ['s1', 's2', 's3', 's4']);
  });

  it('errors cleanly: unknown id, anchor outside an explicit channel, mixing with from/to or author', async () => {
    const { mod } = stub(conv);
    assert.match((await call(mod, 'extract', { aroundId: 'nope' })).error!, /No message/);
    assert.match((await call(mod, 'extract', { aroundId: 'c11', channelId: 'other' })).error!, /not in channel/);
    assert.equal((await call(mod, 'extract', { aroundId: 'c11', from: '2026-09-20T00:00:00Z' })).success, false);
    assert.equal((await call(mod, 'extract', { aroundId: 'c11', author: 'antra' })).success, false);
    assert.equal((await call(mod, 'extract', { before: 3 })).success, false);
  });
});

describe('HistoryModule UX: real-store ordering (catch-up backfill)', () => {
  // Discord catch-up appends messages late with OLDER timestamps: b1/b2
  // have high sequence numbers but timestamps inside the conversation.
  const now = Date.now();
  const ago = (m: number) => now - m * 60_000;
  const store = [
    mk({ id: 'r1', ms: ago(60), text: 'one', channel: 'diary', author: 'antra' }),
    mk({ id: 'r2', ms: ago(50), text: 'two', channel: 'diary', author: 'antra' }),
    mk({ id: 'r3', ms: ago(40), text: 'three', channel: 'diary', author: 'antra' }),
    mk({ id: 'r4', ms: ago(10), text: 'four', channel: 'diary', author: 'antra' }),
    mk({ id: 'r5', ms: ago(5), text: 'five', channel: 'diary', author: 'antra' }),
    mk({ id: 'r90', ms: ago(45), text: 'backfilled 45', channel: 'diary', author: 'antra' }),
    mk({ id: 'r91', ms: ago(20), text: 'backfilled 20', channel: 'diary', author: 'antra' }),
    mk({ id: 'r6', ms: ago(30), text: 'elsewhere', channel: 'general', author: 'antra' }),
  ];

  it('aroundId in a channel uses timestamp neighbours, not append order', async () => {
    const { mod } = stub(store);
    const d = data(await call(mod, 'extract', { aroundId: 'r3', before: 2, after: 2 }));
    assert.deepEqual(d.messages.map((m: any) => m.id), ['r2', 'r90', 'r3', 'r91', 'r4']);
  });

  it('aroundId with allChannels uses the timestamp index', async () => {
    const { mod } = stub(store);
    const d = data(await call(mod, 'extract', { aroundId: 'r3', before: 1, after: 2, allChannels: true }));
    assert.deepEqual(d.messages.map((m: any) => m.id), ['r90', 'r3', 'r6', 'r91']);
  });

  it('order:newest without a channel does not trust a page-size matchedCount', async () => {
    const { mod } = stub(store);
    const d = data(await call(mod, 'search', { query: 'e', order: 'newest', maxScan: 3 }));
    // newest three by timestamp: r5 (five), r4 (four), r91 (backfilled 20)
    assert.equal(d.candidatePoolSize, 3);
    assert.equal(d.truncated, true);
    assert.deepEqual(d.matches.map((m: any) => m.id), ['r5', 'r91']);
  });

  it('order:newest in a channel picks the timestamp tail, not the append tail', async () => {
    const { mod } = stub(store);
    const d = data(await call(mod, 'search', { query: 'o', channelId: 'diary', order: 'newest', maxScan: 2 }));
    // timestamp tail of #diary = r5, r4 (the append tail would be r91, r90)
    assert.deepEqual(d.matches.map((m: any) => m.id), ['r4']);
    assert.equal(d.scannedThrough, new Date(ago(10)).toISOString());
  });

  it('plain extract without a channel reports hasMore instead of a page-size matchedCount', async () => {
    const { mod } = stub(store);
    const d = data(await call(mod, 'extract', { limit: 3 }));
    assert.equal(d.matchedCount, undefined);
    assert.equal(d.hasMore, true);
    const c = data(await call(mod, 'extract', { channelId: 'diary', limit: 3 }));
    assert.equal(c.matchedCount, 7);
    assert.equal(c.hasMore, true);
  });
});
