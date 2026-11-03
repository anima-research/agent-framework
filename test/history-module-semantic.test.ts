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
  /** Answer hits without text, as a service that keeps only vectors and ids does. */
  omitText = false;
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
          .map((it) => ({ id: it.id, score: it.text.includes(q.query as string) ? 0.9 : 0.1, ts: it.ts ?? null, channel: it.channel ?? null, kind: it.kind, level: it.level ?? null, meta: it.meta ?? {}, ...(this.omitText ? {} : { text: it.text.slice(0, 40), chars: it.text.length }) }))
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
function stubCm(messages: StoredMessage[], summaries: Array<Record<string, unknown>> = [], offBranch: Set<string> = new Set()): ContextManager {
  return {
    // Branch-scoped like the real store: getMessage/getSummary answer null for
    // anything not on the current branch (see MessageStore.lookupIndex).
    getMessage(id: string) { return offBranch.has(id) ? null : (messages.find((m) => m.id === id) ?? null); },
    getSummary(id: string) {
      const s = offBranch.has(id) ? undefined : summaries.find((x) => x.id === id);
      // A SummaryEntry carries its mint time as `created`, which the range
      // listing gives as `createdMs`.
      return s ? { ...s, created: s.createdMs } : null;
    },
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

  it('messageIndexText keeps what the resident sent through a send tool, and only the message', () => {
    const sent = msg('m9', T0 + 9000, [
      { type: 'tool_use', id: 'a', name: 'mcpl--slack--reply_message', input: { channelId: 'C123', messageId: '1700.1', content: 'the route moved to venue B at 09:30 ET' } },
      { type: 'tool_use', id: 'b', name: 'zulip--send_message', input: { type: 'stream', to: 'rook_dev_support', topic: 'routing', content: 'posted in Slack too' } },
      { type: 'tool_use', id: 'c', name: 'channel_publish', input: { channelId: 'chan-A', text: 'an older caller sends text' } },
      { type: 'tool_use', id: 'f', name: 'mcpl--slack--send_dm', input: { userId: 'U42', content: 'a word to one person' } },
      { type: 'tool_use', id: 'd', name: 'mcpl--slack--edit_message', input: { channelId: 'C123', messageId: '1700.2', content: 'venue B, not C' } },
      { type: 'tool_use', id: 'e', name: 'mcpl--slack--add_reaction', input: { channelId: 'C123', messageId: '1700.1', emoji: 'eyes' } },
    ] as ContentBlock[]);
    const expected = [
      '[reply_message] the route moved to venue B at 09:30 ET',
      '[send_message] posted in Slack too',
      '[channel_publish] an older caller sends text',
      '[send_dm] a word to one person',
      '[edit_message] venue B, not C',
    ].join('\n');
    assert.equal(messageIndexText(sent), expected);
    // What it wrote to someone isn't a private note, so it is indexed with
    // private tools left out.
    assert.equal(messageIndexText(sent, false), expected);
  });

  it('syncs messages and summaries incrementally with cursors, then searches with mapped filters', async () => {
    const mod = new HistoryModule({ semantic: { url: svc.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0, syncBatch: 2 } });
    const minted = [...summaries];
    mod.bind(stubCm(messages, minted));
    const r1 = await mod.syncSemanticIndex()!;
    assert.deepEqual({ pushed: r1.pushed, inserted: r1.inserted, more: r1.more }, { pushed: 4, inserted: 4, more: false });
    assert.deepEqual([...svc.items.keys()].sort(), ['msg:m1', 'msg:m2', 'msg:m4', `sum:s1@${T0 + 9000}`]);
    assert.equal(svc.items.get('msg:m1')!.cursor, T0 + 1000);
    assert.equal(svc.items.get(`sum:s1@${T0 + 9000}`)!.cursor, T0 + 9000);
    assert.equal(svc.items.get('msg:m1')!.channel, 'chan-A');
    minted.push({ id: 's2', level: 1, content: 'A second summary of the evening', tokens: 10, startMs: T0, endMs: T0 + 5000, firstSequence: 1, lastSequence: 4, createdMs: T0 + 9000 });
    const r2 = await mod.syncSemanticIndex()!;
    assert.deepEqual({ inserted: r2.inserted, unchanged: r2.unchanged }, { inserted: 1, unchanged: r2.pushed - 1 });
    assert.ok(svc.items.has(`sum:s2@${T0 + 9000}`), 'the summary minted in the cursor\'s millisecond is indexed');

    const res = await mod.handleToolCall({ id: 'c1', name: 'semantic_search', input: { query: 'fluid sim', from: '2026-09-22T00:00:00Z', kinds: 'messages', limit: 5 } });
    assert.equal(res.success, true, JSON.stringify(res));
    const data = res.data as { hits: Array<{ id: string; score: number; timestamp: string; channelId: string | null }>; index: { indexed: number; behind: boolean } };
    assert.equal(data.hits[0]!.id, 'msg:m1');
    assert.equal((data.hits[0] as unknown as { messageId: string }).messageId, 'm1');
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

  it('drops hits for messages and summaries that are no longer on the current branch (/undo, /checkout)', async () => {
    const svc2 = new FakeService(); await svc2.start();
    try {
      const mod = new HistoryModule({ semantic: { url: svc2.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
      const offBranch = new Set<string>();
      mod.bind(stubCm(messages, summaries, offBranch));
      await mod.syncSemanticIndex()!;
      assert.ok(svc2.items.has('msg:m2') && svc2.items.has(`sum:s1@${T0 + 9000}`));
      // Before the undo: the think note is a hit.
      const before = await mod.handleToolCall({ id: 'b', name: 'semantic_search', input: { query: 'private note', kinds: 'messages' } });
      assert.equal(before.success, true, JSON.stringify(before));
      assert.ok((before.data as { hits: Array<{ id: string }> }).hits.some((h) => h.id === 'msg:m2'));
      // /undo to m1: m2 leaves the branch but stays in the remote index (ids are never reused).
      offBranch.add('m2');
      const after = await mod.handleToolCall({ id: 'a', name: 'semantic_search', input: { query: 'private note', kinds: 'messages' } });
      const data = after.data as { hits: Array<{ id: string }>; index: { droppedOffBranch: number } };
      assert.ok(!data.hits.some((h) => h.id === 'msg:m2'), JSON.stringify(data.hits));
      assert.equal(data.index.droppedOffBranch, 1);
      // Same rule for summaries minted on a branch the agent has left.
      offBranch.add('s1');
      const sum = await mod.handleToolCall({ id: 's', name: 'semantic_search', input: { query: 'evening', level: 1 } });
      const sdata = sum.data as { hits: Array<{ id: string }>; index: { droppedOffBranch: number } };
      assert.ok(!sdata.hits.some((h) => h.id === 'sum:s1'), JSON.stringify(sdata.hits));
      assert.equal(sdata.index.droppedOffBranch, 1);
      await mod.stop();
    } finally { await svc2.stop(); }
  });

  it('rebuilds a summary hit\'s snippet from the local summary when the service returns no text', async () => {
    const svc2 = new FakeService(); await svc2.start();
    try {
      const mod = new HistoryModule({ semantic: { url: svc2.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
      mod.bind(stubCm(messages, summaries));
      await mod.syncSemanticIndex()!;
      svc2.omitText = true;
      const res = await mod.handleToolCall({ id: 'n', name: 'semantic_search', input: { query: 'evening', level: 1 } });
      assert.equal(res.success, true, JSON.stringify(res));
      const hit = (res.data as { hits: Array<{ id: string; snippet: string; chars: number }> }).hits.find((h) => h.id === 'sum:s1');
      assert.ok(hit, JSON.stringify(res.data));
      assert.equal(hit.snippet, 'Summary of the evening');
      assert.equal(hit.chars, 'Summary of the evening'.length);
      await mod.stop();
    } finally { await svc2.stop(); }
  });

  it('a summary hit\'s local snippet and chars are the summary\'s text as indexed: trimmed, and cut at maxChars at a whole character', async () => {
    // One code point, two UTF-16 units, so after the "x" the 4th unit is the first half of the second one.
    const grin = '\u{1F600}';
    const svc2 = new FakeService(); await svc2.start();
    try {
      const mod = new HistoryModule({ semantic: { url: svc2.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0, maxChars: 4 } });
      mod.bind(stubCm(messages, [{ ...summaries[0], content: `\n  x${grin.repeat(3)}  \n` }]));
      await mod.syncSemanticIndex()!;
      assert.equal(svc2.items.get(`sum:s1@${T0 + 9000}`)?.text, `x${grin}`, 'the index holds the summary trimmed and cut at maxChars at a whole character');
      svc2.omitText = true;
      const res = await mod.handleToolCall({ id: 'n', name: 'semantic_search', input: { query: 'x', level: 1 } });
      assert.equal(res.success, true, JSON.stringify(res));
      const hit = (res.data as { hits: Array<{ id: string; snippet: string; chars: number }> }).hits.find((h) => h.id === 'sum:s1');
      assert.ok(hit, JSON.stringify(res.data));
      assert.equal(hit.snippet, `x${grin}`);
      assert.equal(hit.chars, 3);
      await mod.stop();
    } finally { await svc2.stop(); }
  });

  it('a summary hit\'s snippet keeps up to 400 units of the local summary, one fewer at a split pair, with "…", whatever the service sends', async () => {
    // One code point, two UTF-16 units, so after the "x" the 400th unit is the first half of the 200th of them.
    const grin = '\u{1F600}';
    for (const omitText of [false, true]) {
      const svc2 = new FakeService(); await svc2.start();
      try {
        const mod = new HistoryModule({ semantic: { url: svc2.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
        mod.bind(stubCm(messages, [{ ...summaries[0], content: `x${grin.repeat(250)}` }]));
        await mod.syncSemanticIndex()!;
        svc2.omitText = omitText;
        const res = await mod.handleToolCall({ id: 'n', name: 'semantic_search', input: { query: 'x', level: 1 } });
        assert.equal(res.success, true, JSON.stringify(res));
        const hit = (res.data as { hits: Array<{ id: string; snippet: string; chars: number }> }).hits.find((h) => h.id === 'sum:s1');
        assert.ok(hit, JSON.stringify(res.data));
        assert.equal(hit.snippet, `x${grin.repeat(199)}…`, `with the service ${omitText ? 'sending no text' : 'sending text'}`);
        assert.equal(hit.chars, 501);
        await mod.stop();
      } finally { await svc2.stop(); }
    }
  });

  it('another branch\'s summary under the same id is dropped as off-branch, and this branch\'s is found by its own words and dated by its own start', async () => {
    // A branch made from an earlier point, as an undo makes one, can mint a
    // summary id another branch already used. Each summary's key carries its
    // creation time, so the index holds both, and a hit is this branch's only
    // when its time is this branch's summary's.
    const svc2 = new FakeService(); await svc2.start();
    try {
      const local = [{ ...summaries[0] }];
      const mod = new HistoryModule({ semantic: { url: svc2.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
      mod.bind(stubCm(messages, local));
      await mod.syncSemanticIndex()!;
      // Now on a branch whose own s1 was minted later, about a morning.
      local[0] = { ...summaries[0], content: 'Summary of a morning on this branch', startMs: T0 + 86_400_000, createdMs: T0 + 90_000 };
      await mod.syncSemanticIndex()!;
      assert.equal(svc2.items.get(`sum:s1@${T0 + 9000}`)?.text, 'Summary of the evening', 'the other branch\'s s1 stays indexed');
      assert.equal(svc2.items.get(`sum:s1@${T0 + 90_000}`)?.text, 'Summary of a morning on this branch', 'beside this branch\'s');
      const evening = await mod.handleToolCall({ id: 'e', name: 'semantic_search', input: { query: 'evening', level: 1 } });
      assert.equal(evening.success, true, JSON.stringify(evening));
      const edata = evening.data as { hits: Array<{ id: string; score: number }>; index: { droppedOffBranch: number } };
      assert.deepEqual(edata.hits.filter((h) => h.score > 0.5), [], 'the other branch\'s summary is not a hit here');
      assert.equal(edata.index.droppedOffBranch, 1);
      const morning = await mod.handleToolCall({ id: 'm', name: 'semantic_search', input: { query: 'morning', level: 1 } });
      const hit = (morning.data as { hits: Array<{ id: string; snippet: string; chars: number; score: number; timestamp: string | null }> }).hits.find((h) => h.id === 'sum:s1');
      assert.ok(hit, JSON.stringify(morning.data));
      assert.equal(hit.score, 0.9, 'ranked by its own text');
      assert.equal(hit.timestamp, new Date(T0 + 86_400_000).toISOString(), 'and dated by its own start');
      assert.equal(hit.snippet, 'Summary of a morning on this branch');
      assert.equal(hit.chars, 'Summary of a morning on this branch'.length);
      await mod.stop();
    } finally { await svc2.stop(); }
  });

  it('an item from before keys carried the creation time is never a hit, and isn\'t counted, whatever text the index holds', async () => {
    // An old-form item can hold this branch's summary or another branch's
    // under the same id, so it's left out, as superseded, before this
    // branch's passes send the summary under its own key.
    const svc2 = new FakeService(); await svc2.start();
    try {
      const local = [{ ...summaries[0], content: 'Summary of a morning on this branch' }];
      svc2.items.set('sum:s1', { id: 'sum:s1', text: 'Summary of the evening', kind: 'summary', level: 1, ts: T0, cursor: T0 + 9000 } as never);
      const mod = new HistoryModule({ semantic: { url: svc2.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0, maxSyncBeforeSearch: 0 } });
      mod.bind(stubCm(messages, local));
      const res = await mod.handleToolCall({ id: 'o', name: 'semantic_search', input: { query: 'evening', level: 1 } });
      assert.equal(res.success, true, JSON.stringify(res));
      const data = res.data as { hits: Array<{ id: string }>; index: { droppedOffBranch: number; droppedStale: number } };
      assert.ok(svc2.items.has('sum:s1'), 'the premise: the old item is still in the index');
      assert.deepEqual(data.hits.map((h) => h.id), [], JSON.stringify(res.data));
      assert.equal(data.index.droppedOffBranch, 0);
      assert.equal(data.index.droppedStale, 0);
      await mod.stop();
    } finally { await svc2.stop(); }
  });

  it('a summary hit whose local summary is empty is dropped as stale, never shown with the index\'s text', async () => {
    // context-manager drops a summary that's empty after trimming when it
    // loads, so getSummary doesn't return one. The drop is defensive, against
    // a store that did, while the index holds another summary's text.
    const svc2 = new FakeService(); await svc2.start();
    try {
      const local = [{ ...summaries[0] }];
      const mod = new HistoryModule({ semantic: { url: svc2.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0, maxSyncBeforeSearch: 0 } });
      mod.bind(stubCm(messages, local));
      await mod.syncSemanticIndex()!;
      local[0]!.content = '  ';
      const res = await mod.handleToolCall({ id: 'n', name: 'semantic_search', input: { query: 'evening', level: 1 } });
      assert.equal(res.success, true, JSON.stringify(res));
      assert.equal(svc2.items.get(`sum:s1@${T0 + 9000}`)?.text, 'Summary of the evening', 'the index still holds the other text');
      const data = res.data as { hits: Array<{ id: string }>; index: { droppedStale: number } };
      assert.deepEqual(data.hits.map((h) => h.id), []);
      assert.equal(data.index.droppedStale, 1);
      await mod.stop();
    } finally { await svc2.stop(); }
  });

  it('service failure is a clean tool error and backs off sync', async () => {
    const mod = new HistoryModule({ semantic: { url: svc.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
    mod.bind(stubCm(messages, summaries));
    svc.failNext = 3;
    const r = await mod.syncSemanticIndex()!;
    assert.equal(r.more, true);
    const res = await mod.handleToolCall({ id: 'c3', name: 'semantic_search', input: { query: 'anything' } });
    assert.equal(res.success, false);
    assert.match(String(res.error), /^Nothing was searched: the semantic index service answered the search request with an error \(HTTP 500: boom\)\. /);
    await mod.stop();
  });

  it('validates input', async () => {
    const mod = new HistoryModule({ semantic: { url: svc.url, token: 'tok', namespace: 'test/ns', syncIntervalMs: 0 } });
    mod.bind(stubCm([]));
    for (const input of [{}, { query: '' }, { query: 'x', from: 'nope' }, { query: 'x', from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, { query: 'x', limit: 0 }, { query: 'x', minScore: 7 }]) {
      const res = await mod.handleToolCall({ id: 'v', name: 'semantic_search', input });
      assert.equal(res.success, false, JSON.stringify(input));
    }
    // contradictory filters are an error, not a silent empty result
    const searchesBefore = svc.searches.length;
    for (const input of [{ query: 'x', channelId: 'chan-A', kinds: 'summaries' }, { query: 'x', channelId: 'chan-A', level: 1 }, { query: 'x', kinds: 'messages', level: 1 }]) {
      const res = await mod.handleToolCall({ id: 'v', name: 'semantic_search', input });
      assert.equal(res.success, false, JSON.stringify(input));
      assert.match(String(res.error), /summaries|level/);
    }
    assert.equal(svc.searches.length, searchesBefore);
    await mod.stop();
    const unconfigured = await new HistoryModule().handleToolCall({ id: 'u', name: 'semantic_search', input: { query: 'x' } });
    assert.equal(unconfigured.success, false);
  });
});
