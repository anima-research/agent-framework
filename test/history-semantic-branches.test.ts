/**
 * The semantic index across the store's branches, on real paths: a real
 * ContextManager with the autobiographical strategy mints summaries, an
 * undo's way of branching (store.createBranchAt at an earlier sequence) makes
 * a branch that mints ids its parent already used, and the real
 * HistoryModule keeps its state in the store's module state, which the
 * branches carry, against a fake embed service.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '@animalabs/context-manager';
import { HistoryModule } from '../src/modules/history/index.js';
import { ensureStateRegistered } from '../src/module-registry.js';

interface Item { id: string; text: string; kind: string; cursor?: number; level?: number; ts?: number }
class FakeService {
  items = new Map<string, Item>();
  deletes: string[][] = [];
  /** Every /delete call, answered or refused. */
  deleteCalls = 0;
  /** Answer /delete with 404, as a service build without the route does. */
  noDelete = false;
  /** Answer this many /delete calls with 500. */
  failDeletes = 0;
  /** Awaited before an upsert is answered. */
  onUpsert: (() => Promise<void>) | null = null;
  /** Answer this many upserts with 500. */
  failUpserts = 0;
  /** Answer this many upserts that carry a message with 500. */
  failMessageUpserts = 0;
  /** Every upsert call, answered or refused. */
  upsertCalls = 0;
  /** Awaited before a search is answered. */
  onSearch: (() => Promise<void>) | null = null;
  server!: Server; url = '';
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        void (async () => {
          const m = /^\/v1\/index\/([^/]+)\/(stats|upsert|search|delete)$/.exec(req.url ?? '');
          const json = (code: number, o: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
          if (!m) return json(404, {});
          if (m[2] === 'stats') {
            if (this.items.size === 0) return json(404, { error: { message: 'no such namespace' } });
            const by: Record<string, { count: number; max_ts: number | null; min_ts: number | null; max_cursor: number | null }> = {};
            for (const it of this.items.values()) {
              const d = by[it.kind] ??= { count: 0, max_ts: null, min_ts: null, max_cursor: null };
              d.count++; if (it.cursor !== undefined) d.max_cursor = d.max_cursor === null ? it.cursor : Math.max(d.max_cursor, it.cursor);
            }
            return json(200, { namespace: 'ns', model: 'fake', dim: 4, count: this.items.size, by_kind: by });
          }
          if (m[2] === 'delete') {
            this.deleteCalls++;
            if (this.noDelete) return json(404, { error: { message: 'no such route' } });
            if (this.failDeletes > 0) { this.failDeletes--; return json(500, { error: { message: 'boom' } }); }
            const ids = (JSON.parse(body) as { ids: string[] }).ids;
            this.deletes.push(ids);
            let deleted = 0;
            for (const id of ids) if (this.items.delete(id)) deleted++;
            return json(200, { namespace: 'ns', deleted, count: this.items.size });
          }
          if (m[2] === 'upsert') {
            const items = (JSON.parse(body) as { items: Item[] }).items;
            this.upsertCalls++;
            await this.onUpsert?.();
            if (this.failUpserts > 0) { this.failUpserts--; return json(500, { error: { message: 'boom' } }); }
            if (this.failMessageUpserts > 0 && items.some((it) => it.kind === 'message')) {
              this.failMessageUpserts--; return json(500, { error: { message: 'boom' } });
            }
            for (const it of items) this.items.set(it.id, it);
            return json(200, { namespace: 'ns', inserted: items.length, updated: 0, unchanged: 0, count: this.items.size });
          }
          await this.onSearch?.();
          const q = JSON.parse(body) as { query: string; kinds?: string[]; k?: number };
          const hits = [...this.items.values()].filter((it) => !q.kinds || q.kinds.includes(it.kind))
            .map((it) => ({ id: it.id, score: it.text.includes(q.query) ? 0.9 : 0.05, text: it.text, ts: it.ts ?? null, channel: null, kind: it.kind, level: it.level ?? null, meta: {} }))
            .sort((a, b) => b.score - a.score).slice(0, q.k ?? 10);
          return json(200, { namespace: 'ns', hits, count_indexed: this.items.size, timing_ms: { embed: 1, search: 1 } });
        })();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address(); this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }
  stop(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
  summaryKeys(): string[] { return [...this.items.values()].filter((x) => x.kind === 'summary').map((x) => x.id).sort(); }
}

// Each summary names the topic of the chunk it compresses.
const membrane = {
  complete: async (request: { messages: Array<{ content: Array<{ text?: string }> }> }) => {
    const text = request.messages.flatMap((m) => m.content).map((b) => b.text ?? '').join(' ');
    const topics = [...new Set([...text.matchAll(/topic-(\w+)/g)].map((x) => x[1]))].join(' and ');
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary about ${topics || 'nothing'}.` }], usage: { input_tokens: 100, output_tokens: 10 } };
  },
} as never;

const say = (topic: string, i: number) => [{ type: 'text', text: `topic-${topic} message ${i} ` + 'word '.repeat(8) }] as never;

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) { if (manager.isReady()) return; await manager.tick(); }
  throw new Error('drain: queue did not converge');
}

interface Rig {
  svc: FakeService;
  manager: ContextManager;
  store: { currentSequence(): number; createBranchAt(name: string, from: string, at: number): unknown; getStateJson(id: string): unknown; setStateJson(id: string, v: unknown): unknown };
  mod: HistoryModule;
  talk(topic: string, n?: number): Promise<void>;
  search(query: string, limit?: number): Promise<{ hits: string[]; droppedOffBranch: number; droppedStale: number }>;
  summaries(): Array<{ id: string; content: string; created: number }>;
  state(): Record<string, unknown> | null;
  /** How many times the module has written its state. */
  stateWrites(): number;
}

/** The branch's sync cursors in the module's state, as the module keeps them. */
const cursors = (r: Rig): { namespace?: string; summaries?: number | null; messages?: number | null } =>
  (r.state()?.semanticCursors ?? {}) as { namespace?: string; summaries?: number | null; messages?: number | null };

/** A store, a history module started on the store's module state and bound to it, and a fake service. */
async function rig(t: { after(fn: () => Promise<void>): void }, opts: { maxSyncBeforeSearch?: number; overlapMs?: number; syncBatch?: number } = {}): Promise<Rig> {
  const svc = new FakeService();
  await svc.start();
  const dir = mkdtempSync(join(tmpdir(), 'semantic-branches-'));
  const strategy = new AutobiographicalStrategy({ compressionModel: 'test-compression-model', targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0, hierarchical: true } as never);
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane });
  const store = manager.getStore() as unknown as Rig['store'];
  // The framework keeps a module's state here, as ModuleContextImpl does.
  const stateId = 'modules/history/state';
  ensureStateRegistered(store as never, { id: stateId, strategy: 'snapshot' });
  let writes = 0;
  const ctx = { getState: () => store.getStateJson(stateId), setState: (v: unknown) => { writes++; store.setStateJson(stateId, v); } } as never;
  const mod = new HistoryModule({ semantic: { url: svc.url, namespace: 'ns', syncIntervalMs: 0, ...opts } });
  await mod.start(ctx);
  mod.bind(manager);
  t.after(async () => {
    await mod.stop();
    await manager.close();
    await svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let n = 0;
  return {
    svc, manager, store, mod,
    async talk(topic, count = 8) {
      for (let i = 0; i < count; i++) manager.addMessage(n++ % 2 ? 'agent' : 'user', say(topic, i));
      await drain(manager);
    },
    async search(query, limit) {
      const res = await mod.handleToolCall({ id: 'q', name: 'semantic_search', input: { query, level: 1, ...(limit ? { limit } : {}) } } as never);
      assert.equal(res.success, true, JSON.stringify(res));
      const data = res.data as { hits: Array<{ id: string; snippet: string; score: number }>; index: { droppedOffBranch: number; droppedStale: number } };
      return { hits: data.hits.filter((h) => h.score > 0.5).map((h) => `${h.id} ${h.snippet}`), droppedOffBranch: data.index.droppedOffBranch, droppedStale: data.index.droppedStale };
    },
    summaries: () => (manager.getSummariesInRange({}) as Array<{ id: string; content: string; createdMs: number }>).map((s) => ({ id: s.id, content: s.content, created: s.createdMs })),
    state: () => store.getStateJson(stateId) as Record<string, unknown> | null,
    stateWrites: () => writes,
  };
}

it('a branch made at an earlier point that mints a summary id its parent used keeps its own summary, and each branch finds only its own', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  const trunk = r.manager.currentBranch().name;
  const forkAt = r.store.currentSequence();
  await r.talk('bananas');
  await r.mod.syncSemanticIndex();
  assert.equal(r.svc.deleteCalls, 0, 'a new index holds no old items, so its first pass deletes nothing');
  const bananas = r.summaries().find((s) => s.content.includes('bananas'))!;
  assert.ok(bananas, JSON.stringify(r.summaries()));

  r.store.createBranchAt('undo-1', trunk, forkAt);
  await r.manager.switchBranch('undo-1');
  await r.talk('cherries');
  const cherries = r.summaries().find((s) => s.content.includes('cherries'))!;
  assert.equal(cherries.id, bananas.id, 'the premise: the branch mints the id the trunk used');
  await r.mod.syncSemanticIndex();
  assert.ok(r.svc.items.has(`sum:${bananas.id}@${bananas.created}`), 'the trunk\'s summary is still indexed');
  assert.ok(r.svc.items.has(`sum:${cherries.id}@${cherries.created}`), 'beside the branch\'s');
  assert.deepEqual((await r.search('cherries')).hits, [`sum:${cherries.id} ${cherries.content}`]);

  await r.manager.switchBranch(trunk);
  const onTrunk = await r.search('bananas');
  assert.deepEqual(onTrunk.hits, [`sum:${bananas.id} ${bananas.content}`]);
  const elsewhere = await r.search('cherries');
  assert.deepEqual(elsewhere.hits, [], 'the branch\'s summary is not a hit on the trunk');
  // Every indexed summary the trunk doesn't hold is the branch's, the cherries one among them.
  const trunkKeys = new Set(r.summaries().map((s) => `sum:${s.id}@${s.created}`));
  const branchOnly = r.svc.summaryKeys().filter((k) => !trunkKeys.has(k));
  assert.ok(branchOnly.includes(`sum:${cherries.id}@${cherries.created}`), JSON.stringify(branchOnly));
  assert.equal(elsewhere.droppedOffBranch, branchOnly.length);
});

it('a summary a branch minted and left before a sync is indexed once that branch syncs, whatever the other branch sent since', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  const trunk = r.manager.currentBranch().name;
  const forkAt = r.store.currentSequence();
  r.store.createBranchAt('side', trunk, forkAt);
  await r.manager.switchBranch('side');
  await r.talk('dates');
  const dates = r.summaries().find((s) => s.content.includes('dates'))!;
  assert.ok(dates, JSON.stringify(r.summaries()));
  await r.manager.switchBranch(trunk);
  await r.talk('elderberries', 16);
  await r.mod.syncSemanticIndex();
  const trunkCursor = cursors(r).summaries as number;
  assert.ok(trunkCursor > dates.created, 'the premise: the trunk\'s cursor is past the side\'s unsent summary');

  await r.manager.switchBranch('side');
  await r.mod.syncSemanticIndex();
  assert.ok(r.svc.items.has(`sum:${dates.id}@${dates.created}`), JSON.stringify(r.svc.summaryKeys()));
  assert.deepEqual((await r.search('dates')).hits, [`sum:${dates.id} ${dates.content}`]);
});

it('a pass the store leaves its branch during writes no cursor, so the branch it lands on still sends its own summaries', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  const trunk = r.manager.currentBranch().name;
  const forkAt = r.store.currentSequence();
  r.store.createBranchAt('side', trunk, forkAt);
  await r.manager.switchBranch('side');
  await r.talk('figs');
  const figs = r.summaries().find((s) => s.content.includes('figs'))!;
  assert.ok(figs, JSON.stringify(r.summaries()));
  await r.manager.switchBranch(trunk);
  await r.talk('grapes');
  const grapes = r.summaries().find((s) => s.content.includes('grapes'))!;
  assert.ok(grapes.created > figs.created, 'the premise: the trunk\'s new summary is newer than the side\'s');

  // The trunk's pass reads the trunk's summaries; while their upsert is out, the store moves to the side.
  r.svc.onUpsert = async () => { r.svc.onUpsert = null; await r.manager.switchBranch('side'); };
  await r.mod.syncSemanticIndex();
  assert.equal(r.manager.currentBranch().name, 'side');
  assert.ok(r.svc.items.has(`sum:${grapes.id}@${grapes.created}`), 'the trunk\'s pass sent its summary');
  assert.ok((cursors(r).summaries ?? 0) < figs.created, 'and wrote no cursor into the side\'s state');

  await r.mod.syncSemanticIndex();
  assert.ok(r.svc.items.has(`sum:${figs.id}@${figs.created}`), JSON.stringify(r.svc.summaryKeys()));
});

it('an index from before summaries were keyed by creation time: each summary is sent under its new key and its old item deleted', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  await r.talk('bananas');
  const mine = r.summaries();
  assert.ok(mine.length >= 2, JSON.stringify(mine));
  // What an earlier version indexed: each summary under its id alone.
  for (const s of mine) r.svc.items.set(`sum:${s.id}`, { id: `sum:${s.id}`, text: s.content, kind: 'summary', cursor: s.created });
  // Another part of the module's state, which the cursors' write keeps.
  r.store.setStateJson('modules/history/state', { ...(r.state() ?? {}), keepMe: 1 });
  await r.mod.syncSemanticIndex();
  assert.deepEqual(r.svc.summaryKeys(), mine.map((s) => `sum:${s.id}@${s.created}`).sort());
  assert.deepEqual(r.svc.deletes.flat().sort(), mine.map((s) => `sum:${s.id}`).sort());
  assert.equal(r.state()?.keepMe, 1);
  // A pass with nothing new deletes nothing and writes no state, and nor does one with no budget.
  const [calls, writes, before] = [r.svc.deleteCalls, r.stateWrites(), cursors(r)];
  await r.mod.syncSemanticIndex();
  await r.mod.syncSemanticIndex(0);
  assert.equal(r.svc.deleteCalls, calls);
  assert.equal(r.stateWrites(), writes);
  assert.deepEqual(cursors(r), before);
});

it('on a service without /delete, an old item is left out of search once this branch\'s cursor covers its summary', async (t) => {
  const r = await rig(t);
  const warn = t.mock.method(console, 'warn', () => {});
  r.svc.noDelete = true;
  await r.talk('apples');
  const [apples] = r.summaries();
  r.svc.items.set(`sum:${apples!.id}`, { id: `sum:${apples!.id}`, text: apples!.content, kind: 'summary', cursor: apples!.created });
  // The search's catch-up sends the summary under its new key and moves the cursor.
  const found = await r.search('apples');
  assert.ok(r.svc.items.has(`sum:${apples!.id}`), 'the old item stays');
  assert.deepEqual(found.hits, [`sum:${apples!.id} ${apples!.content}`], 'one hit for the summary, not two');
  assert.equal(found.droppedOffBranch, 0, 'and the old copy isn\'t counted as another branch\'s');
  assert.equal(found.droppedStale, 0, 'or as stale');
  const said = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes('/delete answered 404'));
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0]!, /Later removals and edits down to nothing indexable are dropped too/);
  // Once the route is known to be missing, later passes don't call it.
  const calls = r.svc.deleteCalls;
  await r.talk('blueberries');
  await r.mod.syncSemanticIndex();
  assert.equal(r.svc.deleteCalls, calls);
});

it('before this branch\'s first pass, an old item is still its summary\'s hit', async (t) => {
  const r = await rig(t, { maxSyncBeforeSearch: 0 });
  await r.talk('apples');
  const [apples] = r.summaries();
  r.svc.items.set(`sum:${apples!.id}`, { id: `sum:${apples!.id}`, text: apples!.content, kind: 'summary', cursor: apples!.created });
  assert.deepEqual((await r.search('apples')).hits, [`sum:${apples!.id} ${apples!.content}`]);
});

it('an old item is still its summary\'s hit while a bounded pass hasn\'t reached that summary', async (t) => {
  const r = await rig(t, { maxSyncBeforeSearch: 1 });
  r.svc.noDelete = true;
  await r.talk('apples');
  await r.talk('bananas');
  const mine = r.summaries().sort((a, b) => a.created - b.created);
  const newest = mine.at(-1)!;
  assert.ok(mine.length >= 2 && mine[0]!.created < newest.created, JSON.stringify(mine));
  for (const s of mine) r.svc.items.set(`sum:${s.id}`, { id: `sum:${s.id}`, text: s.content, kind: 'summary', cursor: s.created });
  // The search's catch-up sends the oldest summary alone, so the cursor stops behind the newest.
  const found = await r.search(newest.content);
  assert.ok((cursors(r).summaries as number) < newest.created, JSON.stringify(r.state()));
  assert.ok(!r.svc.items.has(`sum:${newest.id}@${newest.created}`), 'the premise: the newest isn\'t sent yet');
  assert.deepEqual(found.hits, [`sum:${newest.id} ${newest.content}`], 'its old item is the hit');
});

it('a pass whose budget runs out inside a millisecond finishes it, so each summary there has its old item deleted', async (t) => {
  const svc = new FakeService(); await svc.start();
  t.after(() => svc.stop());
  const T = Date.UTC(2026, 8, 22);
  // Three summaries minted in one millisecond, each with an old item.
  const sums = [1, 2, 3].map((i) => ({ id: `s${i}`, level: 1, content: `summary ${i}`, tokens: 2, startMs: T, endMs: T + 1, firstSequence: 0, lastSequence: 1, createdMs: T + 5 }));
  for (const s of sums) svc.items.set(`sum:${s.id}`, { id: `sum:${s.id}`, text: s.content, kind: 'summary', cursor: s.createdMs });
  const cm = {
    getSummariesInRange: () => sums,
    getSummary: (id: string) => { const s = sums.find((x) => x.id === id); return s ? { ...s, created: s.createdMs } : null; },
    getMessage: () => null,
    queryMessagesByTime: () => ({ messages: [], totalCount: 0 }),
  } as unknown as ContextManager;
  const mod = new HistoryModule({ semantic: { url: svc.url, namespace: 'ns', syncIntervalMs: 0 } });
  mod.bind(cm);
  t.after(() => mod.stop());
  await mod.syncSemanticIndex(1);
  await mod.syncSemanticIndex(1);
  assert.deepEqual(svc.summaryKeys(), sums.map((s) => `sum:${s.id}@${s.createdMs}`));
});

it('summaries sent again at the cursor\'s millisecond cost no budget, so a pass of one still reaches a new summary', async (t) => {
  const svc = new FakeService(); await svc.start();
  t.after(() => svc.stop());
  const T = Date.UTC(2026, 8, 22);
  const sum = (i: number, createdMs: number) => ({ id: `s${i}`, level: 1, content: `summary ${i}`, tokens: 2, startMs: T, endMs: T + 1, firstSequence: 0, lastSequence: 1, createdMs });
  const sums = [sum(1, T + 5)];
  const cm = {
    getSummariesInRange: () => sums,
    getSummary: (id: string) => { const s = sums.find((x) => x.id === id); return s ? { ...s, created: s.createdMs } : null; },
    getMessage: () => null,
    queryMessagesByTime: () => ({ messages: [], totalCount: 0 }),
  } as unknown as ContextManager;
  const mod = new HistoryModule({ semantic: { url: svc.url, namespace: 'ns', syncIntervalMs: 0 } });
  mod.bind(cm);
  t.after(() => mod.stop());
  await mod.syncSemanticIndex(1);
  sums.push(sum(2, T + 9));
  await mod.syncSemanticIndex(1);
  assert.ok(svc.items.has(`sum:s2@${T + 9}`), JSON.stringify(svc.summaryKeys()));
});

it('a failed delete of old items leaves the cursor, so the next pass sends those summaries and deletes again', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  const [apples] = r.summaries();
  r.svc.items.set(`sum:${apples!.id}`, { id: `sum:${apples!.id}`, text: apples!.content, kind: 'summary', cursor: apples!.created });
  r.svc.failDeletes = 1;
  t.mock.method(console, 'warn', () => {});
  await r.mod.syncSemanticIndex();
  assert.ok(r.svc.items.has(`sum:${apples!.id}`), 'the delete failed');
  assert.equal(cursors(r).summaries ?? null, null, 'so no summary cursor was written');
  assert.match((r.mod as unknown as { indexer: { lastError: string | null } }).indexer.lastError ?? '', /boom/);
  // Both items are in the index now, and the answer holds both: one hit for the summary.
  r.svc.failDeletes = 1;
  assert.deepEqual((await r.search('apples')).hits, [`sum:${apples!.id} ${apples!.content}`]);
  await r.mod.syncSemanticIndex();
  assert.ok(!r.svc.items.has(`sum:${apples!.id}`), 'the next pass deleted it');
  assert.equal(cursors(r).summaries, apples!.created);
});

it('a summary minted at the cursor\'s millisecond after the pass that wrote it is sent by the next one', async (t) => {
  const svc = new FakeService(); await svc.start();
  t.after(() => svc.stop());
  const T = Date.UTC(2026, 8, 22);
  const sum = (i: number, createdMs: number) => ({ id: `s${i}`, level: 1, content: `summary ${i}`, tokens: 2, startMs: T, endMs: T + 1, firstSequence: 0, lastSequence: 1, createdMs });
  const sums = [sum(1, T + 5)];
  const cm = {
    getSummariesInRange: () => sums,
    getSummary: (id: string) => { const s = sums.find((x) => x.id === id); return s ? { ...s, created: s.createdMs } : null; },
    getMessage: () => null,
    queryMessagesByTime: () => ({ messages: [], totalCount: 0 }),
  } as unknown as ContextManager;
  const mod = new HistoryModule({ semantic: { url: svc.url, namespace: 'ns', syncIntervalMs: 0 } });
  mod.bind(cm);
  t.after(() => mod.stop());
  await mod.syncSemanticIndex();
  sums.push(sum(2, T + 5));
  await mod.syncSemanticIndex();
  assert.ok(svc.items.has(`sum:s2@${T + 5}`), JSON.stringify(svc.summaryKeys()));
});

it('a pass whose summaries\' upsert fails deletes no old item and writes no cursor', async (t) => {
  const r = await rig(t);
  t.mock.method(console, 'warn', () => {});
  await r.talk('apples');
  const [apples] = r.summaries();
  r.svc.items.set(`sum:${apples!.id}`, { id: `sum:${apples!.id}`, text: apples!.content, kind: 'summary', cursor: apples!.created });
  r.svc.failUpserts = 1;
  await r.mod.syncSemanticIndex();
  assert.equal(r.svc.upsertCalls, 1, 'the summaries\' upsert was sent, and refused');
  assert.equal(r.svc.deleteCalls, 0);
  assert.ok(r.svc.items.has(`sum:${apples!.id}`));
  assert.deepEqual(cursors(r), {});
});

it('a deleted index gets every message and summary again, and so does an index under another name', async (t) => {
  // No overlap, so only the cursors decide where the message walk starts.
  const r = await rig(t, { overlapMs: 0 });
  await r.talk('apples');
  await r.talk('bananas');
  await r.mod.syncSemanticIndex();
  const keys = r.summaries().map((s) => `sum:${s.id}@${s.created}`).sort();
  assert.deepEqual(r.svc.summaryKeys(), keys);
  const messageKeys = [...r.svc.items.keys()].filter((k) => k.startsWith('msg:')).sort();
  // The namespace is deleted: /stats answers 404 until the next pass makes it again.
  r.svc.items.clear();
  await r.mod.syncSemanticIndex();
  assert.deepEqual(r.svc.summaryKeys(), keys);
  assert.deepEqual([...r.svc.items.keys()].filter((k) => k.startsWith('msg:')).sort(), messageKeys);

  // Another module over the same state, configured for another index that already exists.
  const other = new FakeService(); await other.start();
  t.after(() => other.stop());
  other.items.set('msg:elsewhere', { id: 'msg:elsewhere', text: 'something else', kind: 'message', cursor: 1 });
  const stateId = 'modules/history/state';
  const ctx = { getState: () => r.store.getStateJson(stateId), setState: (v: unknown) => { r.store.setStateJson(stateId, v); } } as never;
  const mod2 = new HistoryModule({ semantic: { url: other.url, namespace: 'ns2', syncIntervalMs: 0, overlapMs: 0 } });
  await mod2.start(ctx);
  mod2.bind(r.manager);
  t.after(() => mod2.stop());
  await mod2.syncSemanticIndex();
  assert.deepEqual(other.summaryKeys(), keys);
  // Its walk starts at that index's own watermark, not at the cursor kept for the other.
  assert.deepEqual([...other.items.keys()].filter((k) => k.startsWith('msg:') && k !== 'msg:elsewhere').sort(), messageKeys);
  assert.equal(cursors(r).namespace, 'ns2');
});

it('messages a branch stored before another branch\'s later synced ones are indexed once that branch syncs', async (t) => {
  // No overlap, so only the cursor decides where the walk starts.
  const r = await rig(t, { overlapMs: 0 });
  const tick = () => new Promise((res) => setTimeout(res, 5));
  const trunk = r.manager.currentBranch().name;
  r.manager.addMessage('user', say('before', 0));
  await r.mod.syncSemanticIndex();
  const forkAt = r.store.currentSequence();
  r.store.createBranchAt('side', trunk, forkAt);
  await r.manager.switchBranch('side');
  await tick();
  const sideId = String(r.manager.addMessage('user', say('side', 1)));
  await tick();
  await r.manager.switchBranch(trunk);
  await tick();
  r.manager.addMessage('user', say('trunk', 2));
  await r.mod.syncSemanticIndex();
  assert.ok(!r.svc.items.has(`msg:${sideId}`), 'the premise: the side branch\'s message isn\'t sent yet');
  await r.manager.switchBranch('side');
  await r.mod.syncSemanticIndex();
  assert.ok(r.svc.items.has(`msg:${sideId}`), JSON.stringify([...r.svc.items.keys()]));
});

it('a search the store leaves its branch during checks the hits with the branch it lands on', async (t) => {
  const r = await rig(t, { maxSyncBeforeSearch: 0 });
  r.svc.noDelete = true;
  t.mock.method(console, 'warn', () => {});
  const trunk = r.manager.currentBranch().name;
  const forkAt = r.store.currentSequence();
  await r.talk('apples');
  r.store.createBranchAt('side', trunk, forkAt);
  await r.manager.switchBranch('side');
  await r.talk('cherries');
  const cherries = r.summaries().find((s) => s.content.includes('cherries'))!;
  await r.manager.switchBranch(trunk);
  await r.talk('bananas');
  await r.mod.syncSemanticIndex();
  assert.ok((cursors(r).summaries ?? 0) >= cherries.created, 'the premise: the trunk\'s cursor is past the side\'s summary');
  // An item from before keys carried the creation time, holding the side's summary.
  r.svc.items.set(`sum:${cherries.id}`, { id: `sum:${cherries.id}`, text: cherries.content, kind: 'summary', cursor: cherries.created });
  // The search starts on the trunk, and the store moves to the side while it waits.
  r.svc.onSearch = async () => { r.svc.onSearch = null; await r.manager.switchBranch('side'); };
  const found = await r.search(cherries.content);
  assert.deepEqual(found.hits, [`sum:${cherries.id} ${cherries.content}`], 'the side has no cursor yet, so its old item is its hit');
});

it('a branch with no message cursor, as after an upgrade, starts its walk at the service\'s watermark', async (t) => {
  const r = await rig(t, { overlapMs: 0 });
  for (let i = 0; i < 4; i++) {
    r.manager.addMessage('user', say('figs', i));
    await new Promise((res) => setTimeout(res, 3));
  }
  await r.mod.syncSemanticIndex();
  // As before cursors were kept: the state has none.
  r.store.setStateJson('modules/history/state', {});
  assert.deepEqual(cursors(r), {});
  const report = (await r.mod.syncSemanticIndex())!;
  assert.equal(report.messagesScanned, 1, 'only the message at the watermark is walked again');
});

it('a pass that reads another branch and comes back writes no cursor', async (t) => {
  const r = await rig(t);
  const trunk = r.manager.currentBranch().name;
  await r.talk('apples');
  r.store.createBranchAt('side', trunk, r.store.currentSequence());
  // The summaries' upsert moves the store to the side, where the message walk reads,
  // and the messages' upsert moves it back.
  let n = 0;
  r.svc.onUpsert = async () => { n++; if (n === 1) await r.manager.switchBranch('side'); else if (n === 2) { r.svc.onUpsert = null; await r.manager.switchBranch(trunk); } };
  const report = (await r.mod.syncSemanticIndex())!;
  assert.equal(r.manager.currentBranch().name, trunk);
  assert.ok(n >= 2, 'the premise: both upserts ran');
  assert.deepEqual(cursors(r), {}, 'no cursor written from the side\'s reads');
  assert.equal(report.more, true, 'and the pass says items may be left');
});

it('a pass that finds its index deleted starts the cursors over even if it fails partway through', async (t) => {
  const r = await rig(t);
  t.mock.method(console, 'warn', () => {});
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  assert.notDeepEqual(cursors(r), {});
  r.svc.items.clear();
  // The pass's first upsert, the summaries', fails.
  r.svc.failUpserts = 1;
  await r.mod.syncSemanticIndex();
  assert.equal(r.svc.failUpserts, 0, 'the premise: the upsert was refused');
  assert.equal(cursors(r).summaries ?? null, null);
  assert.equal(cursors(r).messages ?? null, null);
});

it('a pass whose messages\' upsert fails after its summaries went in writes no cursor', async (t) => {
  const r = await rig(t);
  t.mock.method(console, 'warn', () => {});
  await r.talk('apples');
  r.svc.failMessageUpserts = 1;
  await r.mod.syncSemanticIndex();
  assert.equal(r.svc.failMessageUpserts, 0, 'the premise: the messages\' upsert was refused');
  assert.ok(r.svc.summaryKeys().length > 0, 'the premise: the summaries went in');
  assert.deepEqual(cursors(r), {});
});

it('an old item holding another branch\'s text is left out once the cursor covers this branch\'s summary, though the answer lacks the keyed item', async (t) => {
  const r = await rig(t);
  r.svc.noDelete = true;
  t.mock.method(console, 'warn', () => {});
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  const [apples] = r.summaries();
  // An item from before keys carried the creation time, under this summary's id, with another branch's text.
  r.svc.items.set(`sum:${apples!.id}`, { id: `sum:${apples!.id}`, text: 'Summary about cherries.', kind: 'summary', cursor: apples!.created });
  // One hit asked for: the first answer is the old item alone.
  const res = await r.search('cherries', 1);
  assert.deepEqual(res.hits, []);
  // Left out by the cursor, which counts nothing, not as off the branch or stale.
  assert.equal(res.droppedOffBranch, 0);
  assert.equal(res.droppedStale, 0);
});

it('a hit for a summary whose ts can\'t be read is named by its id in the host\'s log', async (t) => {
  // No catch-up before the search, which would send the summary again with its ts.
  const r = await rig(t, { maxSyncBeforeSearch: 0 });
  const warn = t.mock.method(console, 'warn', () => {});
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  const [apples] = r.summaries();
  const key = `sum:${apples!.id}@${apples!.created}`;
  r.svc.items.set(key, { ...r.svc.items.get(key)!, ts: 'not a time' as never });
  await r.search(apples!.content);
  const said = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("couldn't be read"));
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.ok(said[0]!.includes(`"sum:${apples!.id}" (ts)`), said[0]);
});

it('after stop(), a pass goes on from the cursors last written for its branch', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  await r.mod.stop();
  const earlier = new Set(r.summaries().map((s) => `${s.id}@${s.created}`));
  await r.talk('bananas');
  const added = r.summaries().filter((s) => !earlier.has(`${s.id}@${s.created}`));
  assert.ok(added.length > 0, 'the premise: new summaries');
  const deletes = r.svc.deleteCalls;
  const report = (await r.mod.syncSemanticIndex())!;
  assert.equal(report.summariesScanned, r.summaries().length, 'the premise: the pass ran');
  assert.ok(added.every((s) => r.svc.items.has(`sum:${s.id}@${s.created}`)), 'the new summaries were sent');
  // Only the new summaries were new to it, so only their old keys were deleted.
  assert.equal(r.svc.deleteCalls, deletes + 1);
  assert.deepEqual(r.svc.deletes.slice(-1)[0]!.sort(), added.map((s) => `sum:${s.id}`).sort());
});

it('after stop(), a pass on another branch doesn\'t take the cursors written on the last one', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  const trunk = r.manager.currentBranch().name;
  r.store.createBranchAt('side', trunk, r.store.currentSequence());
  await r.manager.switchBranch('side');
  await r.talk('cherries');
  const cherries = r.summaries().find((s) => s.content.includes('cherries'))!;
  assert.ok(cherries, JSON.stringify(r.summaries()));
  await r.manager.switchBranch(trunk);
  await r.talk('bananas');
  const bananas = r.summaries().find((s) => s.content.includes('bananas'))!;
  assert.ok(bananas.created > cherries.created, 'the premise: the trunk\'s summary is newer than the side\'s');
  await r.mod.syncSemanticIndex();
  await r.mod.stop();
  await r.manager.switchBranch('side');
  await r.mod.syncSemanticIndex();
  assert.ok(r.svc.items.has(`sum:${cherries.id}@${cherries.created}`), JSON.stringify(r.svc.summaryKeys()));
});

it('a pass whose summaries are read on another branch writes no cursor', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  const before = cursors(r);
  const trunk = r.manager.currentBranch().name;
  r.store.createBranchAt('side', trunk, r.store.currentSequence());
  const id = r.manager.addMessage('user', say('edited', 0));
  r.manager.editMessage(id, [{ type: 'text', text: 'topic-edited, in other words' }] as never);
  // The edit's upsert moves the store to the side, where the summaries are read,
  // and the summaries' upsert moves it back, before the message walk reads.
  let n = 0;
  r.svc.onUpsert = async () => { n++; if (n === 1) await r.manager.switchBranch('side'); else if (n === 2) { r.svc.onUpsert = null; await r.manager.switchBranch(trunk); } };
  const report = (await r.mod.syncSemanticIndex())!;
  assert.ok(n >= 2, 'the premise: the edit\'s and the summaries\' upserts ran');
  assert.equal(r.manager.currentBranch().name, trunk);
  assert.deepEqual(cursors(r), before, 'the new message\'s cursor isn\'t written');
  assert.equal(report.more, true);
});

it('a pass the store leaves between message pages writes no cursor', async (t) => {
  // One flush per page of 256, so the store can move between the pages' reads.
  const r = await rig(t, { syncBatch: 256 });
  const trunk = r.manager.currentBranch().name;
  for (let i = 0; i < 300; i++) r.manager.addMessage(i % 2 ? 'agent' : 'user', say('many', i));
  r.store.createBranchAt('side', trunk, r.store.currentSequence());
  // The first page's upsert moves the store to the side, where the second page is read,
  // and the last upsert moves it back.
  let n = 0;
  r.svc.onUpsert = async () => { n++; if (n === 1) await r.manager.switchBranch('side'); else if (n === 2) { r.svc.onUpsert = null; await r.manager.switchBranch(trunk); } };
  const report = (await r.mod.syncSemanticIndex())!;
  assert.equal(n, 2, 'the premise: one upsert per page');
  assert.equal(report.messagesScanned, 300);
  assert.equal(r.manager.currentBranch().name, trunk);
  assert.deepEqual(cursors(r), {});
});

it('a pass the store leaves after its last read writes no cursor where it lands', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  const trunk = r.manager.currentBranch().name;
  r.store.createBranchAt('side', trunk, r.store.currentSequence());
  // The last upsert, the messages', moves the store to the side, after every read.
  let n = 0;
  r.svc.onUpsert = async () => { n++; if (n === 2) { r.svc.onUpsert = null; await r.manager.switchBranch('side'); } };
  const report = (await r.mod.syncSemanticIndex())!;
  assert.equal(n, 2, 'the premise: the summaries\' and the messages\' upserts');
  assert.equal(r.manager.currentBranch().name, 'side');
  assert.deepEqual(cursors(r), {}, 'no cursor written into the side\'s state');
  assert.equal(report.more, true);
});

it('a deleted index whose branch kept only a summary cursor sends every summary again', async (t) => {
  const r = await rig(t);
  await r.talk('apples');
  // Later summaries, a millisecond or more after the first ones, so a cursor at the newest leaves those out.
  await new Promise((res) => setTimeout(res, 5));
  await r.talk('bananas');
  await r.mod.syncSemanticIndex();
  const keys = r.svc.summaryKeys();
  const newest = Math.max(...r.summaries().map((s) => s.created));
  assert.ok(r.summaries().some((s) => s.created < newest), 'the premise: a summary older than the cursor');
  r.store.setStateJson('modules/history/state', { semanticCursors: { namespace: 'ns', summaries: newest, messages: null } });
  r.svc.items.clear();
  await r.mod.syncSemanticIndex();
  assert.deepEqual(r.svc.summaryKeys(), keys);
});

it('a deleted index whose branch kept only a message cursor sends every message again', async (t) => {
  // No overlap, so only the cursor decides where the walk starts.
  const r = await rig(t, { overlapMs: 0 });
  // A message a millisecond or more older than the cursor's, which a walk from the cursor doesn't reach.
  r.manager.addMessage('user', say('early', 0));
  await new Promise((res) => setTimeout(res, 5));
  await r.talk('apples');
  await r.mod.syncSemanticIndex();
  const messageKeys = [...r.svc.items.keys()].filter((k) => k.startsWith('msg:')).sort();
  const early = [...r.svc.items.values()].filter((it) => it.kind === 'message' && it.text.includes('topic-early'));
  assert.ok(early.length === 1 && early[0]!.cursor! < cursors(r).messages!, 'the premise: the early message is older than the cursor');
  r.store.setStateJson('modules/history/state', { semanticCursors: { namespace: 'ns', summaries: null, messages: cursors(r).messages } });
  r.svc.items.clear();
  await r.mod.syncSemanticIndex();
  assert.deepEqual([...r.svc.items.keys()].filter((k) => k.startsWith('msg:')).sort(), messageKeys);
});
