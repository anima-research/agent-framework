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
            await this.onUpsert?.();
            for (const it of items) this.items.set(it.id, it);
            return json(200, { namespace: 'ns', inserted: items.length, updated: 0, unchanged: 0, count: this.items.size });
          }
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
  search(query: string): Promise<{ hits: string[]; droppedOffBranch: number }>;
  summaries(): Array<{ id: string; content: string; created: number }>;
  state(): Record<string, unknown> | null;
  /** How many times the module has written its state. */
  stateWrites(): number;
}

/** A store, a history module started on the store's module state and bound to it, and a fake service. */
async function rig(t: { after(fn: () => Promise<void>): void }, opts: { maxSyncBeforeSearch?: number } = {}): Promise<Rig> {
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
    async search(query) {
      const res = await mod.handleToolCall({ id: 'q', name: 'semantic_search', input: { query, level: 1 } } as never);
      assert.equal(res.success, true, JSON.stringify(res));
      const data = res.data as { hits: Array<{ id: string; snippet: string; score: number }>; index: { droppedOffBranch: number } };
      return { hits: data.hits.filter((h) => h.score > 0.5).map((h) => `${h.id} ${h.snippet}`), droppedOffBranch: data.index.droppedOffBranch };
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
  const trunkCursor = r.state()?.semanticSummaryCursor as number;
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
  assert.ok(((r.state()?.semanticSummaryCursor as number | undefined) ?? 0) < figs.created, 'and wrote no cursor into the side\'s state');

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
  await r.mod.syncSemanticIndex();
  assert.deepEqual(r.svc.summaryKeys(), mine.map((s) => `sum:${s.id}@${s.created}`).sort());
  assert.deepEqual(r.svc.deletes.flat().sort(), mine.map((s) => `sum:${s.id}`).sort());
  // A pass with nothing new deletes nothing and writes no state.
  const [calls, writes] = [r.svc.deleteCalls, r.stateWrites()];
  await r.mod.syncSemanticIndex();
  assert.equal(r.svc.deleteCalls, calls);
  assert.equal(r.stateWrites(), writes);
});

it('on a service without /delete, an old item is left out of search once this branch\'s cursor covers its summary', async (t) => {
  const r = await rig(t);
  r.svc.noDelete = true;
  await r.talk('apples');
  const [apples] = r.summaries();
  r.svc.items.set(`sum:${apples!.id}`, { id: `sum:${apples!.id}`, text: apples!.content, kind: 'summary', cursor: apples!.created });
  // The search's catch-up sends the summary under its new key and moves the cursor.
  const found = await r.search('apples');
  assert.ok(r.svc.items.has(`sum:${apples!.id}`), 'the old item stays');
  assert.deepEqual(found.hits, [`sum:${apples!.id} ${apples!.content}`], 'one hit for the summary, not two');
  assert.equal(found.droppedOffBranch, 0, 'and the old copy isn\'t counted as another branch\'s');
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
  assert.ok((r.state()?.semanticSummaryCursor as number) < newest.created, JSON.stringify(r.state()));
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
  await r.mod.syncSemanticIndex();
  assert.ok(r.svc.items.has(`sum:${apples!.id}`), 'the delete failed');
  assert.equal(r.state()?.semanticSummaryCursor, undefined, 'so no cursor was written');
  await r.mod.syncSemanticIndex();
  assert.ok(!r.svc.items.has(`sum:${apples!.id}`), 'the next pass deleted it');
  assert.equal(r.state()?.semanticSummaryCursor, apples!.created);
});
