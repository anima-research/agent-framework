import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HistoryModule } from '../src/modules/history/index.js';
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';

/**
 * The incremental sync must CONVERGE: repeated bounded ticks over a store
 * denser than the tick budget end with every message indexed.
 *
 * Each tick re-walks the overlap window behind the service's watermark
 * (messages stamped slightly out of order are picked up that way; the
 * service dedups the re-sends). Those re-sends are free for the service but
 * they were not free for the tick's item budget: when the overlap window
 * held more indexable messages than the budget, every tick spent the whole
 * budget re-sending the same already-indexed items, reported `more: true`,
 * and never reached the first new message — the index froze at the
 * watermark while looking merely "behind". At 1 msg/s that is any 10-minute
 * window with > 256 messages for the pre-search catch-up and > 1024 for the
 * background tick.
 */

interface Item { id: string; text: string; ts?: number; channel?: string | null; kind: string; level?: number; cursor?: number }

/** Minimal embed-service: dedup by id, cursor-aware stats, counts requests. */
class FakeService {
  items = new Map<string, Item>();
  calls: string[] = [];
  server!: Server;
  url = '';
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const m = /^\/v1\/index\/([^/]+)\/(stats|upsert|search)$/.exec(req.url ?? '');
        this.calls.push(m?.[2] ?? '?');
        const json = (code: number, o: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (!m) return json(404, {});
        if (m[2] === 'stats') {
          if (this.items.size === 0) return json(404, { error: { message: 'no such namespace' } });
          const by: Record<string, { count: number; max_ts: null; min_ts: null; max_cursor: number | null }> = {};
          for (const it of this.items.values()) {
            const d = by[it.kind] ??= { count: 0, max_ts: null, min_ts: null, max_cursor: null };
            d.count++;
            if (it.cursor !== undefined) d.max_cursor = d.max_cursor === null ? it.cursor : Math.max(d.max_cursor, it.cursor);
          }
          return json(200, { namespace: 'n', model: 'fake', dim: 1, count: this.items.size, by_kind: by });
        }
        if (m[2] === 'upsert') {
          const items = (JSON.parse(body) as { items: Item[] }).items;
          let inserted = 0, unchanged = 0;
          for (const it of items) { if (this.items.has(it.id)) unchanged++; else inserted++; this.items.set(it.id, it); }
          return json(200, { inserted, updated: 0, unchanged, count: this.items.size });
        }
        return json(200, { namespace: 'n', hits: [], count_indexed: this.items.size, timing_ms: { embed: 0, search: 0 } });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }
  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

function msg(id: string, ms: number, text: string): StoredMessage {
  return {
    id, sequence: Number(id.replace(/\D/g, '')), participant: 'Linn',
    content: [{ type: 'text', text }] as ContentBlock[], timestamp: new Date(ms), metadata: undefined,
  } as unknown as StoredMessage;
}

/** Stub CM with the real queryByTime contract: inclusive bounds, oldest first, `limit` = first N. */
function stubCm(messages: StoredMessage[]): ContextManager {
  return {
    queryMessagesByTime(o: { fromMs?: number; toMs?: number; limit?: number }) {
      const all = messages
        .filter((m) => (o.fromMs === undefined || m.timestamp.getTime() >= o.fromMs) && (o.toMs === undefined || m.timestamp.getTime() <= o.toMs))
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      return { messages: all.slice(0, o.limit ?? all.length), totalCount: all.length };
    },
    getSummariesInRange() { return []; },
  } as unknown as ContextManager;
}

const T0 = Date.UTC(2026, 8, 22);

describe('semantic sync converges', () => {
  const svc = new FakeService();
  before(() => svc.start());
  after(() => svc.stop());

  it('a store denser than the tick budget is fully indexed after enough ticks (overlap re-sends do not eat the budget)', async () => {
    // 700 messages one second apart: the default 10-minute overlap window
    // holds 600 of them, more than a 300-item tick.
    const store = Array.from({ length: 700 }, (_, i) => msg(`m${i}`, T0 + i * 1000, `message number ${i} with enough text to index`));
    const mod = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0 } });
    mod.bind(stubCm(store));
    try {
      const reports: Array<[number, boolean]> = [];
      for (let tick = 0; tick < 12 && svc.items.size < 700; tick++) {
        const r = await mod.syncSemanticIndex(300)!;
        reports.push([r.pushed, r.more]);
      }
      assert.equal(svc.items.size, 700, `index froze at ${svc.items.size}; ticks (pushed, more): ${JSON.stringify(reports)}`);
      const last = await mod.syncSemanticIndex(300)!;
      assert.equal(last.more, false, 'a caught-up store reports more: false');
    } finally {
      await mod.stop();
    }
  });

  it('stop() cancels the first-tick timer: nothing reaches the service after a stopped module', async () => {
    const mod = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 60_000 } });
    mod.bind(stubCm([msg('z1', T0, 'a message that would be pushed by the first tick')]));
    await mod.stop();
    svc.calls.length = 0;
    await new Promise((r) => setTimeout(r, 5_300));
    assert.deepEqual(svc.calls, [], `stopped module still called the service: ${JSON.stringify(svc.calls)}`);
  });
});
