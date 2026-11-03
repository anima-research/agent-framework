import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HistoryModule } from '../src/modules/history/index.js';
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';

/**
 * Regressions for the Greptile review of AF #173 (semantic sync edge cases).
 * Each case was red before the fix it names.
 */

interface Item { id: string; text: string; ts?: number; channel?: string | null; kind: string; level?: number; cursor?: number }

/** Minimal embed-service: dedup by id, cursor-aware stats, counts requests. */
class FakeService {
  items = new Map<string, Item>();
  calls: string[] = [];
  deleted: string[] = [];
  searchKs: number[] = [];
  /** When set, /delete answers this status instead of deleting. */
  deleteStatus: number | null = null;
  /** When set, /delete answers 404 while the namespace holds nothing, as
   *  /stats does, the way a service may answer for a namespace that doesn't
   *  exist. */
  deleteNeedsIndex = false;
  /** When set, /stats answers 200 with JSON that isn't stats, as a page
   *  shown while the service restarts may. */
  statsNotStats = false;
  /** When set, /upsert answers this status instead of indexing. */
  upsertStatus: number | null = null;
  server!: Server;
  url = '';
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const m = /^\/v1\/index\/([^/]+)\/(stats|upsert|search|delete)$/.exec(req.url ?? '');
        this.calls.push(m?.[2] ?? '?');
        const json = (code: number, o: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (!m) return json(404, {});
        if (m[2] === 'stats') {
          if (this.statsNotStats) return json(200, { namespace: 'n' });
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
          if (this.upsertStatus !== null) return json(this.upsertStatus, { error: { message: 'upsert failed' } });
          const items = (JSON.parse(body) as { items: Item[] }).items;
          let inserted = 0, unchanged = 0;
          for (const it of items) { if (this.items.get(it.id)?.text === it.text) unchanged++; else inserted++; this.items.set(it.id, it); }
          return json(200, { inserted, updated: 0, unchanged, count: this.items.size });
        }
        if (m[2] === 'delete') {
          if (this.deleteStatus !== null) return json(this.deleteStatus, { error: { message: 'delete failed' } });
          if (this.deleteNeedsIndex && this.items.size === 0) return json(404, { error: { message: 'no such namespace' } });
          const ids = (JSON.parse(body) as { ids: string[] }).ids;
          let n = 0; for (const id of ids) if (this.items.delete(id)) n++;
          this.deleted.push(...ids);
          return json(200, { deleted: n });
        }
        // search: every item in insertion order (a stand-in ranking), first k, with text as snippet.
        const q = JSON.parse(body) as { k: number };
        this.searchKs.push(q.k);
        const hits = [...this.items.values()].slice(0, q.k).map((it, i) => ({ id: it.id, score: 1 - i / 1000, ts: it.ts ?? null, channel: it.channel ?? null, kind: it.kind, level: it.level ?? null, text: it.text, chars: it.text.length, meta: {} }));
        return json(200, { namespace: 'n', hits, count_indexed: this.items.size, timing_ms: { embed: 0, search: 0 } });
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

type Listener = (e: { type: string; messageId?: string }) => void;

function msg(id: string, ms: number, content: ContentBlock[] | string, metadata?: Record<string, unknown>): StoredMessage {
  return {
    id, sequence: Number(id.replace(/\D/g, '')), participant: 'Linn',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    timestamp: new Date(ms), metadata,
  } as unknown as StoredMessage;
}

/** Stub CM following the real contracts: inclusive bounds, oldest first, offset then limit, onMessage events. */
class StubCm {
  listeners = new Set<Listener>();
  constructor(public messages: StoredMessage[], public summaries: Array<Record<string, unknown>> = []) {}
  queryMessagesByTime(o: { fromMs?: number; toMs?: number; limit?: number; offset?: number }) {
    const all = this.messages
      .filter((m) => (o.fromMs === undefined || m.timestamp.getTime() >= o.fromMs) && (o.toMs === undefined || m.timestamp.getTime() <= o.toMs))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.sequence - b.sequence);
    const off = o.offset ?? 0;
    return { messages: all.slice(off, o.limit === undefined ? undefined : off + o.limit), totalCount: all.length };
  }
  getSummariesInRange() { return this.summaries; }
  getMessage(id: string) { return this.messages.find((m) => m.id === id) ?? null; }
  getSummary(id: string) {
    const s = this.summaries.find((x) => x.id === id);
    return s ? { ...s, created: s.createdMs } : null;
  }
  onMessage(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  edit(id: string, text: string) {
    const m = this.getMessage(id)!;
    (m as { content: ContentBlock[] }).content = [{ type: 'text', text }];
    for (const l of this.listeners) l({ type: 'edit', messageId: id });
  }
  /** Branch switch (/undo): the message leaves the current branch with no remove event. */
  hide(id: string) { this.messages = this.messages.filter((m) => m.id !== id); }
  remove(id: string) {
    this.messages = this.messages.filter((m) => m.id !== id);
    for (const l of this.listeners) l({ type: 'remove', messageId: id });
  }
}

const T0 = Date.UTC(2026, 8, 22);

describe('semantic sync: Greptile #173 findings', () => {
  const svc = new FakeService();
  before(() => svc.start());
  after(() => svc.stop());
  beforeEach(() => { svc.items.clear(); svc.calls.length = 0; svc.deleted.length = 0; svc.deleteStatus = null; svc.deleteNeedsIndex = false; svc.statsNotStats = false; svc.upsertStatus = null; svc.searchKs.length = 0; });

  function mod(cm: StubCm): HistoryModule {
    const m = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0 } });
    m.bind(cm as unknown as ContextManager);
    return m;
  }

  it('#2 indexes the channel from metadata.channelId (MCPL ingestion shape), not only metadata.external.channelId', async () => {
    const m = mod(new StubCm([
      msg('m1', T0, 'hello from the mcpl side of things', { channelId: 'chan-mcpl' }),
      msg('m2', T0 + 1, 'hello from the legacy discord shape', { external: { channelId: 'chan-ext' } }),
    ]));
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:m1')?.channel, 'chan-mcpl');
    assert.equal(svc.items.get('msg:m2')?.channel, 'chan-ext');
    await m.stop();
  });

  it('#3 more than one page of messages sharing one millisecond are all indexed', async () => {
    const store = Array.from({ length: 600 }, (_, i) => msg(`m${i}`, T0, `same-millisecond message ${i}`));
    const m = mod(new StubCm(store));
    for (let i = 0; i < 5; i++) await m.syncSemanticIndex(10_000);
    assert.equal(svc.items.size, 600);
    await m.stop();
  });

  it('#5 a message backlog larger than the tick budget does not starve new summaries', async () => {
    const store = Array.from({ length: 2000 }, (_, i) => msg(`m${i}`, T0 + i * 1000, `backlog message ${i}`));
    const summaries = [{ id: 's1', level: 1, content: 'a fresh summary', tokens: 3, startMs: T0, endMs: T0 + 1, firstSequence: 0, lastSequence: 1, createdMs: T0 + 5 }];
    const m = mod(new StubCm(store, summaries));
    const r = await m.syncSemanticIndex(300)!;
    assert.equal(r.more, true);
    assert.ok(svc.items.has(`sum:s1@${T0 + 5}`), 'summary indexed while the message backlog is still draining');
    await m.stop();
  });

  it('#6 an edit to a message older than the overlap window reaches the index on the next sync', async () => {
    const cm = new StubCm([msg('old', T0, 'the original wording'), msg('new', T0 + 3_600_000, 'an hour later')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.edit('old', 'the corrected wording');
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:old')?.text, 'the corrected wording');
    await m.stop();
  });

  it('#1 a removed message is deleted from the index on the next sync', async () => {
    const cm = new StubCm([msg('gone', T0, 'something that gets deleted'), msg('kept', T0 + 1, 'something that stays')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.remove('gone');
    await m.syncSemanticIndex();
    assert.deepEqual(svc.deleted, ['msg:gone']);
    assert.ok(!svc.items.has('msg:gone'));
    assert.ok(svc.items.has('msg:kept'));
    await m.stop();
  });

  it('#8 a short private note is still indexed', async () => {
    const m = mod(new StubCm([msg('t', T0, [{ type: 'tool_use', id: 'x', name: 'think', input: { content: 'wait for Ben' } }] as ContentBlock[])]));
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:t')?.text, '[think] wait for Ben');
    await m.stop();
  });

  it('re-review #1: a failing /delete does not freeze indexing; the removal is retried on the next tick', async (t) => {
    const warned = t.mock.method(console, 'warn', () => {});
    const cm = new StubCm([msg('a', T0, 'first message'), msg('b', T0 + 1, 'second message')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.remove('a');
    cm.messages.push(msg('c', T0 + 2, 'a new message after the removal'));
    svc.deleteStatus = 500;
    await m.syncSemanticIndex();
    assert.ok(svc.items.has('msg:c'), 'new messages still index while /delete fails');
    assert.ok(svc.items.has('msg:a'));
    assert.deepEqual(warned.mock.calls.map((c) => String(c.arguments[0])), [
      '[history/semantic] index "n": delete failed, 1 removal(s) re-queued: the semantic index service answered the '
        + 'delete request with an error (HTTP 500: delete failed)',
    ]);
    svc.deleteStatus = null;
    await m.syncSemanticIndex();
    assert.ok(!svc.items.has('msg:a'), 'the queued removal is retried once /delete works');
    await m.stop();
  });

  it('re-review #1: a 404 from /delete (service without the route) drops the removals instead of retrying forever', async (t) => {
    const warned = t.mock.method(console, 'warn', () => {});
    const cm = new StubCm([
      msg('a', T0, 'first message'), msg('b', T0 + 1, 'second message'),
      msg('d', T0 + 3, 'fourth message'), msg('e', T0 + 4, 'fifth message'),
    ]);
    let state: unknown = null;
    const ctx = { getState: () => state, setState: (v: unknown) => { state = v; } } as never;
    const pending = () => (state as { semanticPending: { edited: string[]; removed: string[] } }).semanticPending;
    const m = mod(cm);
    await m.start(ctx);
    await m.syncSemanticIndex();
    cm.remove('a');
    cm.edit('b', '');
    cm.messages.push(msg('c', T0 + 2, 'a new message after the removal'));
    svc.deleteStatus = 404;
    await m.syncSemanticIndex();
    assert.ok(svc.items.has('msg:c'), 'new messages still index when /delete is missing');
    assert.deepEqual(warned.mock.calls.map((c) => String(c.arguments[0])), [
      '[history/semantic] index "n": /delete answered 404, so the service lacks that route; dropping 1 removal(s) and '
        + '1 edit(s) down to nothing indexable. Later removals and edits down to nothing indexable are dropped too, '
        + 'until the host restarts or binds the history module again: the semantic index service answered the delete '
        + 'request with an error (HTTP 404: delete failed)',
    ]);
    svc.calls.length = 0;
    svc.deleteStatus = null;
    // A later removal is dropped as it comes, not queued.
    cm.remove('c');
    assert.deepEqual(pending().removed, []);
    // A later edit down to nothing indexable makes no call and isn't kept,
    // and an indexable edit still reaches the index.
    cm.edit('d', '');
    cm.edit('e', 'fifth message, reworded');
    await m.syncSemanticIndex();
    assert.ok(!svc.calls.includes('delete'), `/delete called after the route was found missing: ${JSON.stringify(svc.calls)}`);
    assert.equal(svc.items.get('msg:e')?.text, 'fifth message, reworded');
    assert.equal(warned.mock.calls.length, 1);
    await m.stop();
    const again = mod(cm);
    await again.start(ctx);
    await again.syncSemanticIndex();
    assert.ok(!svc.calls.includes('delete'), `a dropped removal or edit was kept for the next start: ${JSON.stringify(svc.calls)}`);
    await again.stop();
  });

  it('the route-missing warning names what its pass dropped: removals, edits down to nothing indexable, or both', async (t) => {
    const warned = t.mock.method(console, 'warn', () => {});
    const later = '. Later removals and edits down to nothing indexable are dropped too, until the host restarts or binds '
      + 'the history module again: the semantic index service answered the delete request with an error (HTTP 404: '
      + 'delete failed)';
    // A pass whose delete held only a removal.
    const cm1 = new StubCm([msg('a', T0, 'first message'), msg('b', T0 + 1, 'second message')]);
    const m1 = mod(cm1);
    await m1.syncSemanticIndex();
    svc.deleteStatus = 404;
    cm1.remove('a');
    await m1.syncSemanticIndex();
    await m1.stop();
    // A pass whose delete held only an edit down to nothing indexable.
    svc.deleteStatus = null;
    svc.items.clear();
    const cm2 = new StubCm([msg('p', T0, 'first message'), msg('q', T0 + 1, 'second message')]);
    const m2 = mod(cm2);
    await m2.syncSemanticIndex();
    svc.deleteStatus = 404;
    cm2.edit('q', '');
    await m2.syncSemanticIndex();
    await m2.stop();
    assert.deepEqual(warned.mock.calls.map((c) => String(c.arguments[0])), [
      `[history/semantic] index "n": /delete answered 404, so the service lacks that route; dropping 1 removal(s)${later}`,
      '[history/semantic] index "n": /delete answered 404, so the service lacks that route; dropping 1 edit(s) down to '
        + `nothing indexable${later}`,
    ]);
  });

  it('a 404 from /delete in a pass whose /stats answered with something that isn\'t stats is re-queued, not read as a missing route', async (t) => {
    const warned = t.mock.method(console, 'warn', () => {});
    const cm = new StubCm([msg('a', T0, 'first message'), msg('b', T0 + 1, 'second message'), msg('c', T0 + 2, 'third message')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.remove('a');
    cm.edit('b', '');
    svc.statsNotStats = true;
    svc.deleteStatus = 404;
    svc.calls.length = 0;
    await m.syncSemanticIndex();
    assert.ok(svc.calls.includes('delete'), `a pass whose /stats wasn't 404 made no /delete call: ${JSON.stringify(svc.calls)}`);
    assert.deepEqual(warned.mock.calls.map((c) => String(c.arguments[0])), [
      '[history/semantic] index "n": delete failed, 1 removal(s) and 1 edit(s) down to nothing indexable re-queued: the '
        + 'semantic index service answered the delete request with an error (HTTP 404: delete failed)',
    ]);
    svc.statsNotStats = false;
    svc.deleteStatus = null;
    await m.syncSemanticIndex();
    assert.deepEqual(svc.deleted, ['msg:a', 'msg:b']);
    assert.ok(!svc.items.has('msg:a'));
    assert.ok(!svc.items.has('msg:b'));
    await m.stop();
  });

  it('a removal before this store\'s index is made is dropped without a call, and later removals still reach the index', async (t) => {
    const warned = t.mock.method(console, 'warn', () => {});
    svc.deleteNeedsIndex = true;
    const cm = new StubCm([msg('a', T0, 'first message'), msg('b', T0 + 1, 'second message'), msg('c', T0 + 2, 'third message')]);
    const m = mod(cm);
    // Before the first pass, while /stats answers 404: one message removed,
    // and one edited down to nothing indexable.
    cm.remove('a');
    cm.edit('b', '');
    await m.syncSemanticIndex();
    // /stats answered 404, and no /delete was called.
    assert.ok(svc.calls.includes('stats') && !svc.calls.includes('delete'), JSON.stringify(svc.calls));
    assert.deepEqual([...svc.items.keys()], ['msg:c']);
    // With the index made, a later removal reaches it, and only that one.
    cm.remove('c');
    await m.syncSemanticIndex();
    assert.deepEqual(svc.deleted, ['msg:c']);
    assert.equal(svc.items.size, 0);
    assert.deepEqual(warned.mock.calls.map((c) => String(c.arguments[0])), []);
    await m.stop();
  });

  it('a failing re-upsert of an edit is logged under its index', async (t) => {
    const warned = t.mock.method(console, 'warn', () => {});
    const cm = new StubCm([msg('a', T0, 'first message')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.edit('a', 'first message, reworded');
    svc.upsertStatus = 503;
    await m.syncSemanticIndex();
    const lines = warned.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(
      lines.includes(
        '[history/semantic] index "n": edit re-upsert failed, 1 edit(s) re-queued: the semantic index service answered '
          + 'the upsert request with an error (HTTP 503: upsert failed)',
      ),
      JSON.stringify(lines),
    );
    await m.stop();
  });

  it('re-review #2: an edited message that left the branch (/undo) is dropped, not deleted from the index', async () => {
    const cm = new StubCm([msg('e', T0, 'the original wording'), msg('f', T0 + 1, 'another message')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.edit('e', 'the edited wording');
    cm.hide('e');
    await m.syncSemanticIndex();
    assert.deepEqual(svc.deleted, []);
    assert.ok(svc.items.has('msg:e'), 'still indexed for when /redo brings it back');
    await m.stop();
  });

  it('pending edits survive a module restart via module state', async () => {
    const cm = new StubCm([msg('p', T0, 'the original wording'), msg('q', T0 + 3_600_000, 'an hour later')]);
    let state: unknown = null;
    const ctx = { getState: () => state, setState: (v: unknown) => { state = v; } } as never;
    const m1 = mod(cm);
    await m1.start(ctx);
    await m1.syncSemanticIndex();
    cm.edit('p', 'the corrected wording');
    await m1.stop();
    cm.listeners.clear();
    const m2 = mod(cm);
    await m2.start(ctx);
    await m2.syncSemanticIndex();
    assert.equal(svc.items.get('msg:p')?.text, 'the corrected wording');
    await m2.stop();
  });

  // ---- Greptile re-review at 1b42164 ----

  it('G2#1 pending changes are restored and persisted when start() runs before bind()', async () => {
    const cm = new StubCm([msg('p', T0, 'the corrected wording'), msg('o', T0 + 1_000, 'a second earlier line'), msg('q', T0 + 3_600_000, 'an hour later')]);
    let state: unknown = { semanticPending: { edited: ['p'], removed: [] } };
    const ctx = { getState: () => state, setState: (v: unknown) => { state = v; } } as never;
    const m = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0 } });
    await m.start(ctx);
    m.bind(cm as unknown as ContextManager);
    svc.items.set('msg:p', { id: 'msg:p', text: 'the original wording', kind: 'message', cursor: T0 });
    svc.items.set('msg:q', { id: 'msg:q', text: 'an hour later', kind: 'message', cursor: T0 + 3_600_000 });
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:p')?.text, 'the corrected wording', 'pending edit restored from module state');
    cm.edit('o', 'a second earlier line, edited');
    await m.stop();
    const again = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0 } });
    await again.start(ctx);
    again.bind(cm as unknown as ContextManager);
    await again.syncSemanticIndex();
    assert.equal(svc.items.get('msg:o')?.text, 'a second earlier line, edited', 'a new edit persisted for the next start');
    await again.stop();
  });

  it('G2#2 summaries sharing one createdMs are all indexed across bounded passes', async () => {
    const sums = [1, 2, 3].map((i) => ({ id: `s${i}`, level: 1, content: `summary ${i}`, tokens: 2, startMs: T0, endMs: T0 + 1, firstSequence: 0, lastSequence: 1, createdMs: T0 + 5 }));
    const m = mod(new StubCm([], sums));
    for (let i = 0; i < 5; i++) await m.syncSemanticIndex(1);
    assert.deepEqual([...svc.items.keys()].sort(), [1, 2, 3].map((i) => `sum:s${i}@${T0 + 5}`));
    await m.stop();
  });

  it('G2#3 off-branch hits are replaced by lower-ranked on-branch matches', async () => {
    const cm = new StubCm(Array.from({ length: 6 }, (_, i) => msg(`m${i}`, T0 + i, `message ${i}`)));
    const m = mod(cm);
    await m.syncSemanticIndex();
    for (const id of ['m0', 'm1', 'm2']) cm.hide(id);
    const res = await m.handleToolCall({ id: 'c', name: 'semantic_search', input: { query: 'message', limit: 3 } });
    const data = res.data as { hits: Array<{ id: string }>; index: { droppedOffBranch: number } };
    assert.deepEqual(data.hits.map((h) => h.id), ['msg:m3', 'msg:m4', 'msg:m5']);
    await m.stop();
  });

  it('G2#4 an edit to nothing indexable is retried when /delete fails, and hidden at search time when /delete is missing', async () => {
    const cm = new StubCm([msg('e', T0, 'text that will be blanked'), msg('f', T0 + 1, 'another message')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.edit('e', '');
    svc.deleteStatus = 500;
    await m.syncSemanticIndex();
    svc.deleteStatus = null;
    await m.syncSemanticIndex();
    assert.ok(!svc.items.has('msg:e'), 'blanked message deleted once /delete recovers');

    const cm2 = new StubCm([msg('g', T0, 'text that will be blanked'), msg('h', T0 + 1, 'another message')]);
    svc.items.clear();
    const m2 = mod(cm2);
    await m2.syncSemanticIndex();
    cm2.edit('g', '');
    svc.deleteStatus = 404;
    await m2.syncSemanticIndex();
    const res = await m2.handleToolCall({ id: 'c', name: 'semantic_search', input: { query: 'blanked' } });
    assert.ok(!(res.data as { hits: Array<{ id: string }> }).hits.some((h) => h.id === 'msg:g'), 'stale snippet of a blanked message is not served');
    await m.stop(); await m2.stop();
  });

  it('G2#5 queued edits spend the catch-up budget', async () => {
    const store = Array.from({ length: 300 }, (_, i) => msg(`m${i}`, T0 + i * 3_600_000, `message ${i}`));
    const cm = new StubCm(store);
    const m = mod(cm);
    await m.syncSemanticIndex();
    for (let i = 0; i < 300; i++) cm.edit(`m${i}`, `edited message ${i}`);
    const r = await m.syncSemanticIndex(100)!;
    const taken = [...svc.items.values()].filter((item) => item.text.startsWith('edited')).length;
    assert.ok(taken <= 100, `the service took ${taken} edits with a budget of 100`);
    assert.equal(r.more, true);
    for (let i = 0; i < 5; i++) await m.syncSemanticIndex(100);
    assert.equal(svc.items.get('msg:m299')?.text, 'edited message 299');
    await m.stop();
  });

  // ---- Greptile round 3 at f2bcf12 ----

  it('G3#1 a hit for an edited message never serves the pre-edit text as its snippet', async () => {
    const cm = new StubCm([msg('e', T0, 'public part. SECRET passage that was edited out'), msg('f', T0 + 1, 'another message')]);
    const m = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0, maxSyncBeforeSearch: 0 } });
    m.bind(cm as unknown as ContextManager);
    await m.syncSemanticIndex();
    cm.edit('e', 'public part.');
    const res = await m.handleToolCall({ id: 'c', name: 'semantic_search', input: { query: 'secret' } });
    const hit = (res.data as { hits: Array<{ id: string; snippet: string }> }).hits.find((h) => h.id === 'msg:e');
    assert.ok(hit, 'the message is still a hit');
    assert.ok(!hit.snippet.includes('SECRET'), `stale snippet served: ${hit.snippet}`);
    assert.equal(hit.snippet, 'public part.');
    await m.stop();
  });

  it("a hit's snippet keeps up to 400 units of its text, one fewer where the 400th would split a surrogate pair", async () => {
    // One code point, two UTF-16 units, so after the "x" the 400th unit is the first half of the 200th of them.
    const grin = '\u{1F600}';
    const cm = new StubCm([msg('e', T0, `x${grin.repeat(250)}`)]);
    const m = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0, maxSyncBeforeSearch: 0 } });
    m.bind(cm as unknown as ContextManager);
    await m.syncSemanticIndex();
    const res = await m.handleToolCall({ id: 'c', name: 'semantic_search', input: { query: 'x' } });
    const hit = (res.data as { hits: Array<{ id: string; snippet: string }> }).hits.find((h) => h.id === 'msg:e');
    assert.ok(hit, 'the message is a hit');
    assert.equal(hit.snippet, `x${grin.repeat(199)}…`);
    await m.stop();
  });

  it("with maxChars at 400, a hit's snippet is its text cut there at a whole character", async () => {
    // maxChars cuts the current text the snippet is built from. After the "x", the 400th unit is the first half of a pair.
    const grin = '\u{1F600}';
    const cm = new StubCm([msg('e', T0, `x${grin.repeat(250)}`)]);
    const m = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0, maxSyncBeforeSearch: 0, maxChars: 400 } });
    m.bind(cm as unknown as ContextManager);
    await m.syncSemanticIndex();
    const res = await m.handleToolCall({ id: 'c', name: 'semantic_search', input: { query: 'x' } });
    const hit = (res.data as { hits: Array<{ id: string; snippet: string }> }).hits.find((h) => h.id === 'msg:e');
    assert.ok(hit, 'the message is a hit');
    assert.equal(hit.snippet, `x${grin.repeat(199)}`);
    await m.stop();
  });

  it("the text indexed is cut at maxChars at a whole character, a message's and a summary's", async () => {
    const grin = '\u{1F600}';
    const summary = { id: 's1', level: 1, content: `x${grin.repeat(250)}`, tokens: 3, startMs: T0, endMs: T0 + 1, firstSequence: 0, lastSequence: 1, createdMs: T0 + 5 };
    const m = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0, maxChars: 400 } });
    m.bind(new StubCm([msg('e', T0, `x${grin.repeat(250)}`)], [summary]) as unknown as ContextManager);
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:e')?.text, `x${grin.repeat(199)}`);
    assert.equal(svc.items.get(`sum:s1@${T0 + 5}`)?.text, `x${grin.repeat(199)}`);
    await m.stop();
  });

  it('G3#2 queued edits for messages that left the branch do not spend the sync budget', async () => {
    const cm = new StubCm(Array.from({ length: 300 }, (_, i) => msg(`m${i}`, T0 + i * 3_600_000, `message ${i}`)));
    const m = mod(cm);
    await m.syncSemanticIndex();
    for (let i = 0; i < 300; i++) { cm.edit(`m${i}`, `edited ${i}`); cm.hide(`m${i}`); }
    cm.messages.push(msg('new', T0 + 400 * 3_600_000, 'a new message after the undo'));
    await m.syncSemanticIndex(100);
    assert.ok(svc.items.has('msg:new'), 'new history indexed in the same pass');
    await m.stop();
  });
});
