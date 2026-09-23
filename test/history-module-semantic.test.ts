import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HistoryModule } from '../src/modules/history/index.js';
import { messageIndexText } from '../src/modules/history/semantic.js';
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';

// ---- fake embed-service: in-memory namespace, cursor-aware stats, trivial "search" -------------
interface Item { id: string; text: string; ts?: number; channel?: string | null; kind: string; level?: number; cursor?: number; meta?: Record<string, unknown> }
class FakeService {
  items = new Map<string, Item>();
  upserts: Item[][] = [];
  searches: Record<string, unknown>[] = [];
  failNext = 0;
  server!: Server; url = '';
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (this.failNext > 0) { this.failNext--; res.writeHead(500); res.end(JSON.stringify({ error: { message: 'boom' } })); return; }
        if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'unauthorized' } })); return; }
        const m = /^\/v1\/index\/([^/]+)\/(stats|upsert|search)$/.exec(req.url ?? '');
        if (!m) { res.writeHead(404); res.end('{}'); return; }
        assert.equal(decodeURIComponent(m[1]!), 'test/ns');
        const json = (code: number, o: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (m[2] === 'stats') {
          if (this.items.size === 0) return json(404, { error: { message: 'no such namespace' } });
          const by: Record<string, { count: number; max_ts: number | null; min_ts: number | null; max_cursor: number | null }> = {};
          for (const it of this.items.values()) {
            const d = by[it.kind] ??= { count: 0, max_ts: null, min_ts: null, max_cursor: null };
            d.count++; if (it.cursor !== undefined) d.max_cursor = d.max_cursor === null ? it.cursor : Math.max(d.max_cursor, it.cursor);
          }
          return json(200, { namespace: 'test/ns', model: 'fake', dim: 4, count: this.items.size, by_kind: by });
        }
        if (m[2] === 'upsert') {
          const items = (JSON.parse(body) as { items: Item[] }).items; this.upserts.push(items);
          let inserted = 0, unchanged = 0;
          for (const it of items) { if (this.items.has(it.id) && this.items.get(it.id)!.text === it.text) unchanged++; else inserted++; this.items.set(it.id, it); }
          return json(200, { namespace: 'test/ns', inserted, updated: 0, unchanged, count: this.items.size });
        }
        const q = JSON.parse(body) as Record<string, unknown>; this.searches.push(q);
        const hits = [...this.items.values()].filter((it) => !q.kinds || (q.kinds as string[]).includes(it.kind))
          .filter((it) => !q.channel || it.channel === q.channel)
          .map((it) => ({ id: it.id, score: it.text.includes(q.query as string) ? 0.9 : 0.1, ts: it.ts ?? null, channel: it.channel ?? null, kind: it.kind, level: it.level ?? null, meta: it.meta ?? {}, text: it.text.slice(0, 40), chars: it.text.length }))
          .sort((a, b) => b.score - a.score).slice(0, (q.k as number) ?? 10);
        return json(200, { namespace: 'test/ns', hits, count_indexed: this.items.size, timing_ms: { embed: 1, search: 1 } });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address(); this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }
  stop(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
}

// ---- stub context-manager ----------------------------------------------------------------------
function msg(id: string, ms: number, content: ContentBlock[], channelId?: string): StoredMessage {
  return { id, sequence: Number(id.replace(/\D/g, '')), participant: 'Linn', content, timestamp: new Date(ms),
    metadata: channelId ? { external: { source: 'discord', channelId, authorName: 'Linn' } } : undefined } as unknown as StoredMessage;
}
function stubCm(messages: StoredMessage[], summaries: Array<Record<string, unknown>> = []): ContextManager {
  return {
    queryMessagesByTime(o: { fromMs?: number; toMs?: number; limit?: number }) {
      const all = messages.filter((m) => (o.fromMs === undefined || m.timestamp.getTime() >= o.fromMs) && (o.toMs === undefined || m.timestamp.getTime() <= o.toMs))
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      return { messages: all.slice(0, o.limit ?? all.length), totalCount: all.length };
    },
    getSummariesInRange() { return summaries; },
  } as unknown as ContextManager;
}
const T0 = Date.UTC(2026, 8, 22);
const messages = [
  msg('m1', T0 + 1000, [{ type: 'text', text: 'the night the fluid sim was read back to me as art' }], 'chan-A'),
  msg('m2', T0 + 2000, [{ type: 'tool_use', id: 'x', name: 'think', input: { content: 'a private note about vortices and the second small body' } }]),
  msg('m3', T0 + 3000, [{ type: 'tool_result', toolUseId: 'x', content: 'ignored payload' }]),
  msg('m4', T0 + 4000, [{ type: 'text', text: 'goodnight, crow' }], 'chan-B'),
];
const summaries = [
  { id: 's1', level: 1, content: 'Summary of the evening', tokens: 10, startMs: T0, endMs: T0 + 5000, firstSequence: 1, lastSequence: 4, createdMs: T0 + 9000 },
];

describe('HistoryModule semantic_search', () => {
  const svc = new FakeService();
  before(() => svc.start());
  after(() => svc.stop());

  it('offers the tool only when configured', () => {
    assert.ok(!new HistoryModule().getTools().some((t) => t.name === 'semantic_search'));
    const mod = new HistoryModule({ semantic: { url: 'http://x', namespace: 'n', syncIntervalMs: 0 } });
    assert.ok(mod.getTools().some((t) => t.name === 'semantic_search'));
  });

  it('messageIndexText keeps text + private-prose tool args, drops tool_result', () => {
    assert.equal(messageIndexText(messages[0]!), 'the night the fluid sim was read back to me as art');
    assert.equal(messageIndexText(messages[1]!), '[think] a private note about vortices and the second small body');
    assert.equal(messageIndexText(messages[2]!), '');
    assert.equal(messageIndexText(messages[1]!, false), '');
  });

  it('syncs messages and summaries incrementally with cursors, then searches with mapped filters', async () => {
    const mod = new HistoryModule({ semantic: { url: svc.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0, syncBatch: 2 } });
    mod.bind(stubCm(messages, summaries));
    const r1 = await mod.syncSemanticIndex()!;
    assert.deepEqual({ pushed: r1.pushed, inserted: r1.inserted, more: r1.more }, { pushed: 4, inserted: 4, more: false });
    assert.deepEqual([...svc.items.keys()].sort(), ['msg:m1', 'msg:m2', 'msg:m4', 'sum:s1']);
    assert.equal(svc.items.get('msg:m1')!.cursor, T0 + 1000);
    assert.equal(svc.items.get('sum:s1')!.cursor, T0 + 9000);
    assert.equal(svc.items.get('msg:m1')!.channel, 'chan-A');
    // second pass: overlap re-sends the recent messages but the service reports them unchanged; the summary is not re-sent
    const r2 = await mod.syncSemanticIndex()!;
    assert.equal(r2.inserted, 0);
    assert.ok(!svc.upserts.at(-1)!.some((i) => i.id === 'sum:s1') || r2.pushed === 0);

    const res = await mod.handleToolCall({ id: 'c1', name: 'semantic_search', input: { query: 'fluid sim', from: '2026-09-22T00:00:00Z', kinds: 'messages', limit: 5 } });
    assert.equal(res.success, true, JSON.stringify(res));
    const data = res.data as { hits: Array<{ id: string; score: number; timestamp: string; channelId: string | null }>; index: { indexed: number; behind: boolean } };
    assert.equal(data.hits[0]!.id, 'msg:m1');
    assert.equal(data.hits[0]!.channelId, 'chan-A');
    assert.equal(data.hits[0]!.timestamp, new Date(T0 + 1000).toISOString());
    assert.equal(data.index.behind, false);
    const q = svc.searches.at(-1)!;
    assert.deepEqual(q.kinds, ['message']);
    assert.equal(q.ts_from, Date.UTC(2026, 8, 22) / 1000);
    assert.equal(q.k, 5);
    // level implies summaries
    await mod.handleToolCall({ id: 'c2', name: 'semantic_search', input: { query: 'evening', level: 1 } });
    assert.deepEqual(svc.searches.at(-1)!.kinds, ['summary']);
    await mod.stop();
  });

  it('service failure is a clean tool error and backs off sync', async () => {
    const mod = new HistoryModule({ semantic: { url: svc.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
    mod.bind(stubCm(messages, summaries));
    svc.failNext = 3;
    const r = await mod.syncSemanticIndex()!;
    assert.equal(r.more, true);
    const res = await mod.handleToolCall({ id: 'c3', name: 'semantic_search', input: { query: 'anything' } });
    assert.equal(res.success, false);
    assert.match(String(res.error), /embed-service|boom/);
    await mod.stop();
  });

  it('validates input', async () => {
    const mod = new HistoryModule({ semantic: { url: svc.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
    mod.bind(stubCm([]));
    for (const input of [{}, { query: '' }, { query: 'x', from: 'nope' }, { query: 'x', from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, { query: 'x', limit: 0 }, { query: 'x', minScore: 7 }]) {
      const res = await mod.handleToolCall({ id: 'v', name: 'semantic_search', input });
      assert.equal(res.success, false, JSON.stringify(input));
    }
    const unconfigured = await new HistoryModule().handleToolCall({ id: 'u', name: 'semantic_search', input: { query: 'x' } });
    assert.equal(unconfigured.success, false);
  });
});
