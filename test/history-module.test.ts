import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryModule } from '../src/modules/history/index.js';
import type { ContextManager, StoredMessage, IndexedMessageQueryResult, ChannelCount, ChannelTokenStats } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import type { ToolCall } from '../src/types/events.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';

/**
 * HistoryModule's own logic is dispatch (always via
 * queryMessagesByTimeAndChannel, per context-manager's own test evidence
 * that it already handles "only one filter" and "neither filter"), input
 * validation (ISO dates, regex, limit capping), and presentation (content
 * flattening, snippet extraction, truncation detection). The underlying
 * index-query *correctness* is context-manager's own responsibility and is
 * covered by its test suite (test/message-store-history-index.test.ts) — so
 * this stub implements realistic-but-simple in-memory filtering over a small
 * fixture rather than standing up a real chronicle store, and a `calls` log
 * lets tests assert on exactly what HistoryModule asked for (e.g. the capped
 * limit).
 */

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

function metaFor(channelId?: string): Record<string, unknown> | undefined {
  return channelId ? { external: { channelId } } : undefined;
}

function msg(id: string, ms: number, participant: string, content: ContentBlock[], channelId?: string): StoredMessage {
  return {
    id,
    sequence: Number(id.replace(/\D/g, '')),
    participant,
    content,
    metadata: metaFor(channelId),
    timestamp: new Date(ms),
  } as StoredMessage;
}

function channelIdOf(m: StoredMessage): string | undefined {
  return (m.metadata as { external?: { channelId?: string } } | undefined)?.external?.channelId;
}

/** Trivial, deterministic stand-in for real token estimation — tests only
 *  assert on shape/filtering, never on the exact number. */
function estimate(m: StoredMessage): number {
  return m.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 4), 0);
}

interface StubOptions {
  /** When set, every query/stats method throws this — simulates a chronicle
   *  build that predates the native index-query capability. */
  throwUnsupported?: boolean;
}

function buildStub(messages: StoredMessage[], opts: StubOptions = {}): { cm: ContextManager; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = [];
  const unsupported = () => {
    throw new Error('Chronicle history index unsupported: native field-index capability absent on this chronicle build.');
  };

  const cm = {
    queryMessagesByTimeAndChannel(args: { fromMs?: number; toMs?: number; channelId?: string; limit?: number; offset?: number }): IndexedMessageQueryResult {
      calls.push({ method: 'queryMessagesByTimeAndChannel', args });
      if (opts.throwUnsupported) return unsupported();
      const filtered = messages.filter((m) => {
        const ts = m.timestamp.getTime();
        if (args.fromMs !== undefined && ts < args.fromMs) return false;
        if (args.toMs !== undefined && ts > args.toMs) return false;
        if (args.channelId !== undefined && channelIdOf(m) !== args.channelId) return false;
        return true;
      });
      const matchedCount = filtered.length;
      const offset = args.offset ?? 0;
      const limit = args.limit ?? filtered.length;
      return { messages: filtered.slice(offset, offset + limit), matchedCount };
    },
    // Time-only native query (search's candidate window and extract's
    // aroundId use it for timestamp-ordered edges). Real contract:
    // timestamp-ordered, `reverse` supported, matchedCount = PAGE size.
    queryMessagesByTime(args: { fromMs?: number; toMs?: number; limit?: number; offset?: number; reverse?: boolean }): IndexedMessageQueryResult {
      calls.push({ method: 'queryMessagesByTime', args });
      if (opts.throwUnsupported) return unsupported();
      let filtered = messages
        .filter((m) => {
          const ts = m.timestamp.getTime();
          if (args.fromMs !== undefined && ts < args.fromMs) return false;
          if (args.toMs !== undefined && ts > args.toMs) return false;
          return true;
        })
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      if (args.reverse) filtered = filtered.reverse();
      const offset = args.offset ?? 0;
      const page = filtered.slice(offset, args.limit === undefined ? undefined : offset + args.limit);
      return { messages: page, matchedCount: page.length };
    },
    getChannelMessageCounts(): ChannelCount[] {
      calls.push({ method: 'getChannelMessageCounts', args: undefined });
      if (opts.throwUnsupported) return unsupported();
      const counts = new Map<string, number>();
      for (const m of messages) {
        const c = channelIdOf(m);
        if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      return [...counts.entries()].map(([channelId, count]) => ({ channelId, messages: count }));
    },
    getChannelTokenStats(args?: { fromMs?: number; toMs?: number }): ChannelTokenStats {
      calls.push({ method: 'getChannelTokenStats', args });
      if (opts.throwUnsupported) return unsupported();
      const inRange = messages.filter((m) => {
        const ts = m.timestamp.getTime();
        if (args?.fromMs !== undefined && ts < args.fromMs) return false;
        if (args?.toMs !== undefined && ts > args.toMs) return false;
        return true;
      });
      const byChannel = new Map<string, { messages: number; tokensEstimate: number }>();
      let totalTokensEstimate = 0;
      for (const m of inRange) {
        const est = estimate(m);
        totalTokensEstimate += est;
        const c = channelIdOf(m);
        if (c) {
          const agg = byChannel.get(c) ?? { messages: 0, tokensEstimate: 0 };
          agg.messages++;
          agg.tokensEstimate += est;
          byChannel.set(c, agg);
        }
      }
      return {
        totalMessages: inRange.length,
        totalTokensEstimate,
        byChannel: [...byChannel.entries()].map(([channelId, agg]) => ({ channelId, ...agg })),
      };
    },
  } as unknown as ContextManager;

  return { cm, calls };
}

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, input } as unknown as ToolCall;
}

// Fixture: two channels (c1, c2), one channel-less message, spread across
// distinct timestamps so time-range filtering is exercisable.
const FIXTURE: StoredMessage[] = [
  msg('m1', 1000, 'User', [textBlock('hello world')], 'c1'),
  msg('m2', 2000, 'Claude', [{ type: 'tool_use', id: 't1', name: 'search', input: {} }], 'c1'),
  msg('m3', 3000, 'User', [textBlock('foo BAR baz')], 'c2'),
  msg('m4', 4000, 'Claude', [{ type: 'thinking', thinking: 'hmm' }, textBlock('final answer')], 'c2'),
  msg('m5', 5000, 'User', [textBlock('unchanneled message')]),
  msg('m6', 6000, 'User', [textBlock('another c1 message with searchterm inside')], 'c1'),
];

describe('HistoryModule', () => {
  describe('stats', () => {
    it('reports all-time message counts and range-scoped token stats separately', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      // Range covers only m3..m5 (3000-5000), but messageCountsAllTime must
      // still reflect the whole store.
      const result = await h.handleToolCall(call('stats', { from: new Date(3000).toISOString(), to: new Date(5000).toISOString() }));
      assert.equal(result.success, true, result.error);
      const data = result.data as {
        messageCountsAllTime: ChannelCount[];
        tokenStatsForRange: ChannelTokenStats;
      };

      const allTimeByChannel = new Map(data.messageCountsAllTime.map((c) => [c.channelId, c.messages]));
      assert.equal(allTimeByChannel.get('c1'), 3); // m1, m2, m6 — unaffected by the range
      assert.equal(allTimeByChannel.get('c2'), 2); // m3, m4

      assert.equal(data.tokenStatsForRange.totalMessages, 3); // m3, m4, m5
      const rangeByChannel = new Map(data.tokenStatsForRange.byChannel.map((c) => [c.channelId, c.messages]));
      assert.equal(rangeByChannel.get('c2'), 2); // m3 and m4 both fall in [3000,5000]
      assert.equal(rangeByChannel.has('c1'), false); // no c1 message falls in [3000,5000]
    });

    it('filters both parts of the response to one channelId when given', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('stats', { channelId: 'c1' }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { messageCountsAllTime: ChannelCount[]; tokenStatsForRange: ChannelTokenStats };
      assert.deepEqual(data.messageCountsAllTime.map((c) => c.channelId), ['c1']);
      assert.deepEqual(data.tokenStatsForRange.byChannel.map((c) => c.channelId), ['c1']);
    });

    it('rejects an invalid ISO date cleanly instead of throwing', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('stats', { from: 'not-a-date' }));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /Invalid ISO 8601 date/);
    });

    it('surfaces the capability-absent error as a clean tool error, not a crash', async () => {
      const { cm } = buildStub(FIXTURE, { throwUnsupported: true });
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('stats', {}));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /Chronicle history index unsupported/);
    });
  });

  describe('extract', () => {
    it('filters by channel and date range', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(
        call('extract', { channelId: 'c1', from: new Date(1500).toISOString() }),
      );
      assert.equal(result.success, true, result.error);
      const data = result.data as { matchedCount: number; returned: number; messages: Array<{ id: string }> };
      // c1 messages at ts >= 1500: m2 (2000), m6 (6000) — m1 (1000) excluded.
      assert.deepEqual(data.messages.map((m) => m.id), ['m2', 'm6']);
      assert.equal(data.returned, 2);
      assert.equal(data.matchedCount, 2);
    });

    it('format:"text" flattens content; format:"raw" returns blocks as-is', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const textResult = await h.handleToolCall(call('extract', { channelId: 'c2', format: 'text' }));
      const textData = textResult.data as { messages: Array<{ id: string; content: unknown }> };
      const m4 = textData.messages.find((m) => m.id === 'm4')!;
      assert.equal(m4.content, '[thinking] final answer');

      const rawResult = await h.handleToolCall(call('extract', { channelId: 'c2', format: 'raw' }));
      const rawData = rawResult.data as { messages: Array<{ id: string; content: unknown }> };
      const m4Raw = rawData.messages.find((m) => m.id === 'm4')!;
      assert.ok(Array.isArray(m4Raw.content));
      assert.equal((m4Raw.content as ContentBlock[]).length, 2);
      assert.equal((m4Raw.content as ContentBlock[])[0]?.type, 'thinking');
    });

    it('caps limit at the hard maximum before it reaches context-manager', async () => {
      const { cm, calls } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      await h.handleToolCall(call('extract', { limit: 999999 }));
      const queryCall = calls.find((c) => c.method === 'queryMessagesByTimeAndChannel');
      // 200 = the hard cap; +1 is extract's own "is there another page" probe row.
      assert.equal((queryCall?.args as { limit?: number }).limit, 201);
    });

    it('clamps an out-of-u32-range offset to the native ceiling instead of passing it through to wrap (reviewer repro)', async () => {
      // Number.MAX_SAFE_INTEGER is not a safe ceiling for a value that
      // eventually crosses into a native u32 argument: 4294967296 (one past
      // u32 max) must be clamped to 4294967295, not passed through as-is —
      // otherwise it wraps/truncates at the N-API boundary into a small
      // offset and silently returns the wrong page instead of an empty one.
      const { cm, calls } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      await h.handleToolCall(call('extract', { offset: 4294967296, limit: 1 }));
      const queryCall = calls.find((c) => c.method === 'queryMessagesByTimeAndChannel');
      assert.equal((queryCall?.args as { offset?: number }).offset, 4294967295);
    });

    it('surfaces the capability-absent error cleanly', async () => {
      const { cm } = buildStub(FIXTURE, { throwUnsupported: true });
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('extract', {}));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /Chronicle history index unsupported/);
    });
  });

  describe('search', () => {
    it('matches a case-insensitive substring by default', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: 'bar' }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { matches: Array<{ id: string; snippet: string }> };
      assert.deepEqual(data.matches.map((m) => m.id), ['m3']);
      assert.match(data.matches[0]!.snippet, /BAR/);
    });

    it('limit:0 (substring) returns zero matches instead of one (reviewer repro)', async () => {
      // clampCount accepts 0 as a valid value (it's >= 0). Both matching
      // loops used to push a match onto the results array BEFORE checking
      // the limit, so with a matching candidate present, limit:0 still
      // returned exactly 1 match.
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: 'bar', limit: 0 }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { matches: unknown[] };
      assert.equal(data.matches.length, 0);
    });

    it('limit:0 (regex) returns zero matches instead of one (reviewer repro)', async () => {
      // Same bug, independently, in search-regex-worker.ts's own copy of
      // the match loop.
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: '\\bworld\\b', regex: true, limit: 0 }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { matches: unknown[] };
      assert.equal(data.matches.length, 0);
    });

    it('caseSensitive:true respects case', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: 'bar', caseSensitive: true }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { matches: unknown[] };
      assert.equal(data.matches.length, 0); // fixture only has "BAR", not "bar"
    });

    it('matches a regex', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: '\\bworld\\b', regex: true }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { matches: Array<{ id: string }> };
      assert.deepEqual(data.matches.map((m) => m.id), ['m1']);
    });

    it('forcibly terminates a catastrophically-backtracking (ReDoS) regex instead of hanging', async () => {
      // Reviewer's repro: 32 'a's followed by a non-matching character, plus
      // a classic exponential-backtracking pattern. `(a+)+$` against this
      // input backtracks exponentially and (verified separately in an
      // isolated child process) has to be force-killed after several
      // seconds; the equivalent linear pattern `^a+$` returns instantly.
      // This must never block the framework's single event loop — matching
      // has to happen off-thread with a real, forcible deadline.
      const evil = 'a'.repeat(32) + '!';
      const { cm } = buildStub([msg('r1', 1000, 'User', [textBlock(evil)], 'c1')]);
      const h = new HistoryModule();
      h.bind(cm);

      const start = Date.now();
      const result = await h.handleToolCall(call('search', { query: '(a+)+$', regex: true, maxScan: 1 }));
      const elapsed = Date.now() - start;

      // Returns well within a bounded time (module deadline is 2s; generous
      // slack here for worker spawn/CI jitter) — proves the test runner
      // itself never hung waiting on this call.
      assert.ok(elapsed < 8000, `search took ${elapsed}ms — should have been forcibly terminated near the deadline`);
      // A cut-short match MUST be a clean, unambiguous failure, never
      // success:true with an empty matches array — that would be
      // indistinguishable from "no matches found", which is a lie.
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /timed out/i);
    });

    it('a normal regex against the same kind of input still matches correctly (worker path is not just failing everything)', async () => {
      const { cm } = buildStub([msg('r1', 1000, 'User', [textBlock('aaaa!')], 'c1')]);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: '^a+!$', regex: true }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { matches: Array<{ id: string }> };
      assert.deepEqual(data.matches.map((m) => m.id), ['r1']);
    });

    it('returns a clean error for an invalid regex instead of throwing', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: '(unclosed', regex: true }));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /Invalid regex/);
    });

    it('reports truncated:true up front when the candidate window exceeds maxScan', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: 'm', maxScan: 3 }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { truncated: boolean; candidatePoolSize: number; scanned: number };
      assert.equal(data.truncated, true);
      assert.equal(data.candidatePoolSize, 3);
      assert.ok(data.scanned <= 3);
    });

    it('does not report truncated when the candidate window fits within maxScan', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: 'searchterm', maxScan: 5000 }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { truncated: boolean; matches: Array<{ id: string }> };
      assert.equal(data.truncated, false);
      assert.deepEqual(data.matches.map((m) => m.id), ['m6']);
    });

    it('surfaces the capability-absent error cleanly', async () => {
      const { cm } = buildStub(FIXTURE, { throwUnsupported: true });
      const h = new HistoryModule();
      h.bind(cm);

      const result = await h.handleToolCall(call('search', { query: 'x' }));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /Chronicle history index unsupported/);
    });
  });

  describe('pagination input validation', () => {
    // Math.min(value, max) alone only enforces an UPPER bound —
    // Math.min(-1, 200) is -1, not clamped up to anything — so a negative
    // (or non-integer/non-finite) limit/offset/maxScan would previously
    // reach context-manager's native query unbounded. Each of these must
    // now be rejected before the native call is ever made.
    const badValues: Array<[string, number]> = [
      ['negative', -1],
      ['non-integer', 1.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ];

    for (const [label, value] of badValues) {
      it(`extract: rejects a ${label} limit before it reaches context-manager`, async () => {
        const { cm, calls } = buildStub(FIXTURE);
        const h = new HistoryModule();
        h.bind(cm);
        const result = await h.handleToolCall(call('extract', { limit: value }));
        assert.equal(result.success, false);
        assert.equal(result.isError, true);
        assert.equal(calls.length, 0, 'must reject before ever calling context-manager');
      });

      it(`extract: rejects a ${label} offset before it reaches context-manager`, async () => {
        const { cm, calls } = buildStub(FIXTURE);
        const h = new HistoryModule();
        h.bind(cm);
        const result = await h.handleToolCall(call('extract', { offset: value }));
        assert.equal(result.success, false);
        assert.equal(result.isError, true);
        assert.equal(calls.length, 0);
      });

      it(`search: rejects a ${label} limit before it reaches context-manager`, async () => {
        const { cm, calls } = buildStub(FIXTURE);
        const h = new HistoryModule();
        h.bind(cm);
        const result = await h.handleToolCall(call('search', { query: 'm', limit: value }));
        assert.equal(result.success, false);
        assert.equal(result.isError, true);
        assert.equal(calls.length, 0);
      });

      it(`search: rejects a ${label} maxScan before it reaches context-manager`, async () => {
        const { cm, calls } = buildStub(FIXTURE);
        const h = new HistoryModule();
        h.bind(cm);
        const result = await h.handleToolCall(call('search', { query: 'm', maxScan: value }));
        assert.equal(result.success, false);
        assert.equal(result.isError, true);
        assert.equal(calls.length, 0);
      });
    }

    it('extract: a real 250-message store with limit:-1 does NOT return everything (reviewer repro)', async () => {
      // Reviewer's exact repro shape: a store larger than the hard cap, and
      // a negative limit that must not bypass it.
      const many = Array.from({ length: 250 }, (_, i) => msg(`p${i}`, 1000 + i, 'User', [textBlock(`m${i}`)], 'c1'));
      const { cm } = buildStub(many);
      const h = new HistoryModule();
      h.bind(cm);
      const result = await h.handleToolCall(call('extract', { limit: -1 }));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
    });

    it('search: a real large candidate pool with maxScan:-2 does NOT fetch everything (reviewer repro)', async () => {
      const many = Array.from({ length: 248 }, (_, i) => msg(`q${i}`, 1000 + i, 'User', [textBlock(`m${i}`)], 'c1'));
      const { cm, calls } = buildStub(many);
      const h = new HistoryModule();
      h.bind(cm);
      const result = await h.handleToolCall(call('search', { query: 'm', maxScan: -2 }));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.equal(calls.length, 0);
    });
  });

  describe('channel-label retrofit (resolveChannel via ChannelRegistry)', () => {
    /**
     * Minimal ChannelRegistry-shaped stub — HistoryModule's resolveChannel()
     * only ever calls resolveProseTargetDurable(), so that's all this needs
     * to implement. `known` maps a label spec to the raw channelId it
     * resolves to; anything else is an unresolvable miss (mirrors
     * ChannelRegistry's own {error} return).
     */
    function stubRegistry(known: Record<string, string>): ChannelRegistry {
      return {
        resolveProseTargetDurable(spec: string) {
          const channelId = known[spec];
          return channelId !== undefined ? { channelId } : { error: `no such channel: ${spec}` };
        },
      } as unknown as ChannelRegistry;
    }

    it('stats: resolves a label to the raw channelId before calling context-manager', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm, stubRegistry({ '#c1-label': 'c1' }));

      const result = await h.handleToolCall(call('stats', { channelId: '#c1-label' }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { messageCountsAllTime: ChannelCount[]; tokenStatsForRange: ChannelTokenStats };
      // Same result as passing the raw 'c1' id directly (see the plain
      // stats/channelId test above) — proves the label was resolved, not
      // passed through as a literal (nonexistent) channelId.
      assert.deepEqual(data.messageCountsAllTime.map((c) => c.channelId), ['c1']);
      assert.deepEqual(data.tokenStatsForRange.byChannel.map((c) => c.channelId), ['c1']);
    });

    it('extract: resolves a label to the raw channelId before calling context-manager', async () => {
      const { cm, calls } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm, stubRegistry({ '#c1-label': 'c1' }));

      const result = await h.handleToolCall(
        call('extract', { channelId: '#c1-label', from: new Date(1500).toISOString() }),
      );
      assert.equal(result.success, true, result.error);
      const data = result.data as { messages: Array<{ id: string }> };
      assert.deepEqual(data.messages.map((m) => m.id), ['m2', 'm6']);
      const queryCall = calls.find((c) => c.method === 'queryMessagesByTimeAndChannel');
      assert.equal((queryCall?.args as { channelId?: string }).channelId, 'c1', 'context-manager must see the resolved raw id, not the label');
    });

    it('search: resolves a label to the raw channelId before calling context-manager', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm, stubRegistry({ '#c1-label': 'c1' }));

      const result = await h.handleToolCall(call('search', { query: 'searchterm', channelId: '#c1-label' }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { matches: Array<{ id: string }> };
      assert.deepEqual(data.matches.map((m) => m.id), ['m6']);
    });

    it('an unresolvable spec is passed through unchanged (escape hatch for an already-raw channelId)', async () => {
      const { cm, calls } = buildStub(FIXTURE);
      const h = new HistoryModule();
      // Registry is bound but knows nothing about 'c1' as a *label* — only
      // resolveProseTargetDurable would be asked, and it misses.
      h.bind(cm, stubRegistry({}));

      const result = await h.handleToolCall(call('extract', { channelId: 'c1' }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { messages: Array<{ id: string }> };
      assert.deepEqual(data.messages.map((m) => m.id), ['m1', 'm2', 'm6']);
      const queryCall = calls.find((c) => c.method === 'queryMessagesByTimeAndChannel');
      assert.equal((queryCall?.args as { channelId?: string }).channelId, 'c1');
    });

    it('a typo\'d label-shaped spec (starts with # or @) surfaces a clean error with suggestions instead of silently looking empty (finding #8)', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(
        cm,
        {
          resolveProseTargetDurable(spec: string) {
            if (spec === '#c1-label') return { channelId: 'c1' };
            // Unresolvable, but the resolver still offers a near-match
            // suggestion — exactly what a real ChannelRegistry miss returns.
            // The underlying error text deliberately mimics
            // resolveProseTarget's SEND-flavored DM wording ("use the
            // send_dm tool") — resolveChannel must not surface it verbatim
            // (see the next test): a read-only history tool needs its own
            // wording, not send-context advice.
            return { error: `no registered DM found for "${spec}" — use the send_dm tool`, candidates: ['#c1-label'] };
          },
        } as unknown as ChannelRegistry,
      );

      const result = await h.handleToolCall(call('extract', { channelId: '#c1-labl' })); // typo
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /No channel history found/i);
      assert.match(result.error ?? '', /#c1-label/); // the suggestion made it into the error
    });

    it('never reuses the live resolver\'s send_dm-flavored error text — always uses read-only-tool wording (finding: DM error text)', async () => {
      const { cm } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(
        cm,
        {
          resolveProseTargetDurable(_spec: string) {
            return { error: 'no registered DM found for "@ghost" — for someone without a registered DM channel, use the send_dm tool' };
          },
        } as unknown as ChannelRegistry,
      );

      const result = await h.handleToolCall(call('extract', { channelId: '@ghost' }));
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.doesNotMatch(result.error ?? '', /send_dm/, 'send-context advice must never leak into a read-only tool error');
    });

    it('a bare (non-#/@) unresolvable spec still passes through unchanged — the escape hatch is preserved for non-label-shaped input', async () => {
      const { cm, calls } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(
        cm,
        {
          resolveProseTargetDurable(_spec: string) {
            return { error: 'no such channel', candidates: ['c1'] };
          },
        } as unknown as ChannelRegistry,
      );

      // 'c1' doesn't start with '#' or '@' — even on a registry miss, this
      // must still be treated as an already-raw id, not an error.
      const result = await h.handleToolCall(call('extract', { channelId: 'c1' }));
      assert.equal(result.success, true, result.error);
      const queryCall = calls.find((c) => c.method === 'queryMessagesByTimeAndChannel');
      assert.equal((queryCall?.args as { channelId?: string }).channelId, 'c1');
    });

    it('an unresolvable <@id>/<@!id> mention form surfaces the clean error on extract/stats/search/overview, not a silent empty result (finding: mention-form escape-hatch gap)', async () => {
      const { cm } = buildStub(FIXTURE);
      const registry = {
        resolveProseTargetDurable(_spec: string) {
          return { error: 'no registered DM matches the mention <@999>' };
        },
      } as unknown as ChannelRegistry;

      for (const mention of ['<@999>', '<@!999>']) {
        for (const toolName of ['extract', 'stats', 'search', 'overview']) {
          const h = new HistoryModule();
          h.bind(cm, registry);
          const input: Record<string, unknown> = { channelId: mention };
          if (toolName === 'search') input.query = 'x';
          const result = await h.handleToolCall(call(toolName, input));
          assert.equal(result.success, false, `${toolName}(${mention}) should error, not silently succeed`);
          assert.equal(result.isError, true);
          assert.match(
            result.error ?? '',
            /No channel history found/i,
            `${toolName}(${mention}) should surface the clean resolution error`,
          );
        }
      }
    });

    it('regression guard: an unbound module (bind(cm) only, no registry) still accepts a raw id unchanged', async () => {
      const { cm, calls } = buildStub(FIXTURE);
      const h = new HistoryModule();
      h.bind(cm); // no ChannelRegistry passed — today's pre-retrofit call shape.

      const result = await h.handleToolCall(call('extract', { channelId: 'c1' }));
      assert.equal(result.success, true, result.error);
      const data = result.data as { messages: Array<{ id: string }> };
      assert.deepEqual(data.messages.map((m) => m.id), ['m1', 'm2', 'm6']);
      const queryCall = calls.find((c) => c.method === 'queryMessagesByTimeAndChannel');
      assert.equal((queryCall?.args as { channelId?: string }).channelId, 'c1');
    });
  });

  it('rejects tool calls before bind()', async () => {
    const h = new HistoryModule();
    const result = await h.handleToolCall(call('stats', {}));
    assert.equal(result.success, false);
    assert.equal(result.isError, true);
    assert.match(result.error ?? '', /not bound/);
  });

  it('rejects an unknown tool name', async () => {
    const { cm } = buildStub(FIXTURE);
    const h = new HistoryModule();
    h.bind(cm);
    const result = await h.handleToolCall(call('bogus', {}));
    assert.equal(result.success, false);
    assert.equal(result.isError, true);
    assert.match(result.error ?? '', /Unknown tool/);
  });
});
