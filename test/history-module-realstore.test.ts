import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '@animalabs/context-manager';
import type { ContextManager } from '@animalabs/context-manager';
import { HistoryModule } from '../src/modules/history/index.js';
import type { ToolCall } from '../src/types/events.js';

/**
 * PR #174 review repros on a REAL chronicle-backed MessageStore (not a stub):
 * messages are appended in one order and their timestamps rewritten after
 * append (the way context-manager's own history-index tests do it), so
 * append order and timestamp order genuinely disagree — Discord catch-up
 * backfill. Channel-scoped native queries come back in APPEND order here.
 */

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Row {
  text: string;
  channel: string;
  ms: number;
  author?: string;
  authorId?: string;
}

function build(rows: Row[]) {
  const dir = mkdtempSync(join(tmpdir(), 'af-history-real-'));
  dirs.push(dir);
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try {
    MessageStore.register(store);
  } catch {}
  const ms = new MessageStore(store);
  const ids = new Map<string, string>();
  // Live position of the next append: removals splice state items out.
  let live = 0;
  const append = (r: Row) => {
    const meta: Record<string, unknown> = { channelId: r.channel };
    if (r.author) meta.author = { id: r.authorId ?? `id-${r.author}`, name: r.author };
    const m = ms.append('user', [{ type: 'text', text: r.text }], meta as never);
    ids.set(r.text, String(m.id));
    const item = store.getStateItemJson('messages', live) as Record<string, unknown>;
    store.editStateItem('messages', live, Buffer.from(JSON.stringify({ ...item, timestamp: r.ms })));
    live++;
  };
  const remove = (text: string) => {
    ms.remove(ids.get(text)! as never);
    live--;
  };
  rows.forEach(append);
  const cm = {
    queryMessagesByTime: (o: never) => ms.queryByTime(o),
    queryMessagesByTimeAndChannel: (o: never) => ms.queryByTimeAndChannel(o),
    getMessage: (id: string) => ms.get(id as never),
    getMessageCount: () => ms.length(),
    getMessageWindow: (offset: number, limit: number) => ms.getWindow(offset, limit),
  } as unknown as ContextManager;
  const mod = new HistoryModule();
  mod.bind(cm);
  return { mod, ids, append, remove };
}

async function call(mod: HistoryModule, name: string, input: Record<string, unknown>): Promise<any> {
  const r = await mod.handleToolCall({ id: 't', name, input } as ToolCall);
  assert.equal(r.success, true, r.error);
  return r.data;
}
const texts = (ms: Array<{ text?: string; content?: string }>) => ms.map((m: any) => String(m.text ?? m.content).replace(/^.*?:\s*/, ''));
const MIN = 60_000;

describe('HistoryModule on a real store (PR #174 review)', () => {
  it('finding 1: extract author+channel continuation reaches late-appended older messages', async () => {
    const now = Date.now();
    const rows: Row[] = [60, 50, 40, 30, 20].map((m, i) => ({ text: `a${i + 1}`, channel: 'diary', author: 'antra', ms: now - m * MIN }));
    rows.push({ text: 'b1', channel: 'diary', author: 'antra', ms: now - 55 * MIN });
    rows.push({ text: 'b2', channel: 'diary', author: 'antra', ms: now - 25 * MIN });
    const { mod } = build(rows);
    const seen: string[] = [];
    let d = await call(mod, 'extract', { author: 'antra', channelId: 'diary', maxScan: 5 });
    seen.push(...d.messages.map((m: any) => m.id));
    for (let guard = 0; d.truncated && guard < 10; guard++) {
      assert.ok(d.resume, `truncated response must carry a resume object, got ${JSON.stringify(d)}`);
      d = await call(mod, 'extract', { author: 'antra', channelId: 'diary', maxScan: 5, ...d.resume });
      seen.push(...d.messages.map((m: any) => m.id));
    }
    assert.equal(new Set(seen).size, 7, `continuation must reach all 7 messages, saw ${seen.length} (${new Set(seen).size} distinct)`);
  });

  it('finding 1: pageFull continuation also resumes by position', async () => {
    const now = Date.now();
    const rows: Row[] = [60, 50, 40, 30, 20].map((m, i) => ({ text: `a${i + 1}`, channel: 'diary', author: 'antra', ms: now - m * MIN }));
    rows.push({ text: 'b1', channel: 'diary', author: 'antra', ms: now - 55 * MIN });
    const { mod } = build(rows);
    const seen: string[] = [];
    let d = await call(mod, 'extract', { author: 'antra', channelId: 'diary', limit: 2 });
    seen.push(...d.messages.map((m: any) => m.id));
    for (let guard = 0; d.truncated && guard < 10; guard++) {
      d = await call(mod, 'extract', { author: 'antra', channelId: 'diary', limit: 2, ...d.resume });
      seen.push(...d.messages.map((m: any) => m.id));
    }
    assert.equal(new Set(seen).size, 6);
    assert.equal(seen.length, 6, 'no repeats');
  });

  it('finding 2: newest edge window is the timestamp tail even when it overshoots fetchCap', async () => {
    const now = Date.now();
    const rows: Row[] = [{ text: 'elsewhere', channel: 'x', ms: now - 30 * 24 * 60 * MIN }];
    const dense0 = now - 3 * 24 * 60 * MIN;
    for (let i = 0; i < 2000; i++) rows.push({ text: `dense${i}`, channel: 'd', ms: dense0 + i * 1000 });
    [55, 45, 35, 25, 15].forEach((m, i) => rows.push({ text: `q${i + 1}`, channel: 'd', ms: now - m * MIN }));
    rows.push({ text: 'OLD-backfill', channel: 'd', ms: now - 4 * 24 * 60 * MIN });
    const { mod, ids } = build(rows);

    const s = await call(mod, 'search', { query: 'e', channelId: 'd', order: 'newest', maxScan: 10 });
    // every dense* contains "e"; q* don't — check the pool edge via scannedThrough
    assert.equal(s.truncated, true);
    assert.equal(s.scannedThrough, new Date(dense0 + 1995 * 1000).toISOString());
    assert.ok(!s.matches.some((m: any) => m.id === ids.get('OLD-backfill')));

    const a = await call(mod, 'extract', { aroundId: ids.get('q1'), before: 5, after: 2 });
    assert.deepEqual(
      a.messages.map((m: any) => m.id),
      ['dense1995', 'dense1996', 'dense1997', 'dense1998', 'dense1999', 'q1', 'q2', 'q3'].map((t) => ids.get(t)),
    );
  });

  it('finding 2: a single millisecond larger than fetchCap still yields the exact (timestamp, sequence) tail', async () => {
    const now = Date.now();
    const T = now - 60 * MIN;
    const rows: Row[] = [{ text: 'm-old', channel: 'x', ms: now - 30 * 24 * 60 * MIN }];
    for (let i = 0; i < 1100; i++) rows.push({ text: `m-tie${i}`, channel: 'd', ms: T });
    [30, 20, 10].forEach((m, i) => rows.push({ text: `m-late${i}`, channel: 'd', ms: now - m * MIN }));
    rows.push({ text: 'm-backfill', channel: 'd', ms: T - 1000 });
    const { mod, ids } = build(rows);
    const s = await call(mod, 'search', { query: 'm-', channelId: 'd', order: 'newest', maxScan: 10, limit: 50 });
    assert.deepEqual(
      s.matches.map((m: any) => m.id),
      ['m-late2', 'm-late1', 'm-late0', ...[1099, 1098, 1097, 1096, 1095, 1094, 1093].map((i) => `m-tie${i}`)].map((t) => ids.get(t)),
    );
  });

  it('note 6: author "user" does not match every MCPL-ingested message', async () => {
    const { mod } = build([{ text: 'hello', channel: 'z', ms: Date.now() - MIN, author: 'antra' }]);
    assert.equal((await call(mod, 'search', { query: 'hello', author: 'user' })).matches.length, 0);
  });

  it('note 5: channel newest window is not capped at Date.now()', async () => {
    const now = Date.now();
    const rows: Row[] = [{ text: 'old', channel: 'x', ms: now - 60 * 24 * 60 * MIN }];
    for (let i = 0; i < 20; i++) rows.push({ text: `c${i}`, channel: 'c', ms: now - 5 * MIN + i * 10_000 });
    rows.push({ text: 'future', channel: 'c', ms: now + 60_000 });
    const { mod, ids } = build(rows);
    const s = await call(mod, 'search', { query: 'c', channelId: 'c', order: 'newest', maxScan: 5, limit: 50 });
    const noCh = await call(mod, 'search', { query: 'u', order: 'newest', maxScan: 5, limit: 50 });
    assert.equal(noCh.matches[0].id, ids.get('future'));
    assert.equal(s.scannedThrough, new Date(now - 5 * MIN + 16 * 10_000).toISOString());
    // pool = future c19 c18 c17 c16 — "future" contains no "c", so first match is c19
    assert.equal(s.matches[0].id, ids.get('c19'));
    assert.equal(s.matches.length, 4);
  });

  it('note 3: author id with uppercase letters matches', async () => {
    const { mod, ids } = build([{ text: 'hi', channel: 'z', ms: Date.now() - MIN, author: 'Ann', authorId: 'U0ABC' }]);
    const d = await call(mod, 'search', { query: 'hi', author: 'U0ABC' });
    assert.deepEqual(d.matches.map((m: any) => m.id), [ids.get('hi')]);
  });

  it('note 4: wholeWord treats combining marks as word characters', async () => {
    const { mod } = build([
      { text: 'café au lait', channel: 'z', ms: Date.now() - 2 * MIN },
      { text: 'नमस्ते', channel: 'z', ms: Date.now() - MIN },
    ]);
    assert.equal((await call(mod, 'search', { query: 'cafe', wholeWord: true })).matches.length, 0);
    assert.equal((await call(mod, 'search', { query: 'नम', wholeWord: true })).matches.length, 0);
  });

});

describe('Greptile review on 62b57f0 (real store)', () => {
  const ids = (d: any, key = 'messages') => d[key].map((m: any) => m.id);

  it('G1: search limit continuation makes progress (distinct times and a same-ms group)', async () => {
    const now = Date.now();
    const rows: Row[] = [1, 2, 3].map((i) => ({ text: `x${i}`, channel: 'c', ms: now - (10 - i) * MIN }));
    for (let i = 0; i < 5; i++) rows.push({ text: `x-tie${i}`, channel: 'c', ms: now - MIN });
    const { mod } = build(rows);
    for (const [order, extra] of [['oldest', { limit: 1 }], ['newest', { limit: 1 }], ['oldest', { maxScan: 2 }], ['newest', { maxScan: 2 }]] as const) {
      const seen: string[] = [];
      let d = await call(mod, 'search', { query: 'x', order, ...extra });
      seen.push(...ids(d, 'matches'));
      for (let guard = 0; (d.resume || d.scannedThrough) && guard < 12; guard++) {
        const cont = d.resume ?? { [order === 'oldest' ? 'from' : 'to']: d.scannedThrough };
        d = await call(mod, 'search', { query: 'x', order, ...extra, ...cont });
        seen.push(...ids(d, 'matches'));
      }
      assert.equal(new Set(seen).size, 8, `${order} ${JSON.stringify(extra)}: reached ${new Set(seen).size}/8`);
      assert.equal(seen.length, 8, `${order} ${JSON.stringify(extra)}: no repeats`);
    }
  });

  it('G2: a resumed, exhausted author extract does not claim the whole-window matchedCount', async () => {
    const now = Date.now();
    const { mod } = build([1, 2, 3, 4].map((i) => ({ text: `a${i}`, channel: 'd', author: 'antra', ms: now - (10 - i) * MIN })));
    const first = await call(mod, 'extract', { author: 'antra', channelId: 'd', maxScan: 3 });
    const second = await call(mod, 'extract', { author: 'antra', channelId: 'd', maxScan: 3, ...first.resume });
    assert.equal(second.truncated, false);
    assert.equal(second.matchedCount, undefined, 'resumed scan saw only part of the window');
    assert.equal(first.matchedCountAtLeast + second.matchedSinceWindowOffset, 4);
  });

  it('G3: aroundId rejects limit instead of silently ignoring it', async () => {
    const { mod, ids: m } = build([{ text: 'a', channel: 'd', ms: Date.now() - MIN }]);
    const r = await mod.handleToolCall({ id: 't', name: 'extract', input: { aroundId: m.get('a'), limit: 1 } } as ToolCall);
    assert.equal(r.success, false);
  });

  it('G4: aroundId inside a same-millisecond group larger than the tie cap returns true neighbours', async () => {
    const now = Date.now();
    const rows: Row[] = [];
    for (let i = 0; i < 1100; i++) rows.push({ text: `t${i}`, channel: 'd', ms: now - MIN });
    const { mod, ids: m } = build(rows);
    const d = await call(mod, 'extract', { aroundId: m.get('t590'), before: 3, after: 2 });
    assert.deepEqual(ids(d), [587, 588, 589, 590, 591, 592].map((i) => m.get(`t${i}`)));
  });

  it('G5: <@id> mention form works for alphanumeric ids', async () => {
    const { mod, ids: m } = build([{ text: 'hi', channel: 'z', ms: Date.now() - MIN, author: 'Ann', authorId: 'U0ABC' }]);
    assert.deepEqual(ids(await call(mod, 'search', { query: 'hi', author: '<@U0ABC>' }), 'matches'), [m.get('hi')]);
    assert.equal((await call(mod, 'search', { query: 'hi', excludeAuthor: '<@U0ABC>' })).matches.length, 0);
  });

  it('G6: wholeWord sees astral-plane letters beside the match', async () => {
    const { mod } = build([{ text: '\u{1D504}a b\u{1D504}', channel: 'z', ms: Date.now() - MIN }]);
    assert.equal((await call(mod, 'search', { query: 'a', wholeWord: true })).matches.length, 0);
    assert.equal((await call(mod, 'search', { query: 'b', wholeWord: true })).matches.length, 0);
  });

  it('G7: author schema does not advertise a form its declared type rejects', () => {
    const tools = new HistoryModule().getTools();
    for (const t of tools) {
      for (const k of ['author', 'excludeAuthor']) {
        const p = (t.inputSchema as any).properties?.[k];
        if (!p) continue;
        const allowsString = p.type === 'string' || (Array.isArray(p.type) && p.type.includes('string'));
        assert.ok(allowsString || !/single string/i.test(p.description), `${t.name}.${k}`);
      }
    }
  });

  it('G8: limit:0 author extract resume advances; maxScan:0 is rejected', async () => {
    const now = Date.now();
    const { mod } = build([1, 2, 3].map((i) => ({ text: `a${i}`, channel: 'd', author: 'antra', ms: now - (10 - i) * MIN })));
    const d = await call(mod, 'extract', { author: 'antra', channelId: 'd', limit: 0 });
    assert.ok(!d.truncated || d.resume.windowOffset > 0, JSON.stringify(d));
    const r = await mod.handleToolCall({ id: 't', name: 'extract', input: { author: 'antra', maxScan: 0 } } as ToolCall);
    assert.equal(r.success, false);
  });
});

describe('HistoryModule on a real store: window changes between resume calls (PR #174 re-review)', () => {
  const rowsN = (n: number, channel = 'd') => {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => ({ text: `m${i}`, channel, author: 'antra', ms: now - (100 - i) * MIN }));
  };
  const texts2 = (d: any) => d.messages.map((m: any) => String(m.content).replace(/^.*?:\s*/, ''));

  for (const channelId of ['d', undefined]) {
    it(`extract author resume after a removal before the cursor skips nothing (${channelId ? 'channel' : 'no channel'})`, async () => {
      const { mod, remove } = build(rowsN(9));
      const q = { author: 'antra', limit: 4, ...(channelId ? { channelId } : {}) };
      const first = await call(mod, 'extract', q);
      assert.deepEqual(texts2(first), ['m0', 'm1', 'm2', 'm3']);
      remove('m1');
      const second = await call(mod, 'extract', { ...q, ...first.resume });
      assert.deepEqual(texts2(second), ['m4', 'm5', 'm6', 'm7']);
      assert.equal(second.windowChanged?.shift, -1);
    });
  }

  it('extract author resume after an older-stamped insertion before the cursor repeats nothing, and says so', async () => {
    const { mod, append } = build(rowsN(9));
    const first = await call(mod, 'extract', { author: 'antra', limit: 4 });
    assert.deepEqual(texts2(first), ['m0', 'm1', 'm2', 'm3']);
    // catch-up backfill: appended now, stamped between m0 and m1 → lands before the cursor in the time-ordered window
    append({ text: 'late', channel: 'd', author: 'antra', ms: Date.now() - 99.5 * MIN });
    const second = await call(mod, 'extract', { author: 'antra', limit: 4, ...first.resume });
    assert.deepEqual(texts2(second), ['m4', 'm5', 'm6', 'm7']);
    assert.equal(second.windowChanged?.shift, 1);
    assert.match(second.windowChanged.note, /did not see/);
  });

  it('extract author resume notices a BALANCED change (one removal + one older-stamped insertion before the cursor)', async () => {
    const { mod, append, remove, ids: m } = build(rowsN(9));
    const first = await call(mod, 'extract', { author: 'antra', limit: 4 });
    assert.deepEqual(texts2(first), ['m0', 'm1', 'm2', 'm3']);
    remove('m1');
    append({ text: 'late', channel: 'd', author: 'antra', ms: Date.now() - 99.5 * MIN });
    const second = await call(mod, 'extract', { author: 'antra', limit: 4, ...first.resume });
    assert.deepEqual(texts2(second), ['m4', 'm5', 'm6', 'm7']);
    assert.ok(second.windowChanged, 'a message landed behind the cursor; the response must say so');
    assert.deepEqual(second.windowChanged.missedIds, [m.get('late')]);
  });

  it('extract author resume (no channel) is not broken by many unrelated appends since seqMark', async () => {
    const { mod, append } = build(rowsN(9));
    const first = await call(mod, 'extract', { author: 'antra', limit: 4 });
    for (let i = 0; i < 1500; i++) append({ text: `busy${i}`, channel: 'other', author: 'bob', ms: Date.now() });
    const second = await call(mod, 'extract', { author: 'antra', limit: 4, ...first.resume });
    assert.deepEqual(texts2(second), ['m4', 'm5', 'm6', 'm7']);
    assert.equal(second.windowChanged, undefined);
  });

  it('extract author resume in a channel window: a late append lands after the cursor and is simply returned', async () => {
    const { mod, append, remove } = build(rowsN(9));
    const q = { author: 'antra', limit: 4, channelId: 'd' };
    const first = await call(mod, 'extract', q);
    remove('m1');
    append({ text: 'late', channel: 'd', author: 'antra', ms: Date.now() - 99.5 * MIN });
    const second = await call(mod, 'extract', { ...q, limit: 10, ...first.resume });
    assert.deepEqual(texts2(second), ['m4', 'm5', 'm6', 'm7', 'm8', 'late']);
  });

  it('extract resume fails loudly when the anchor message itself was removed, or afterId is missing', async () => {
    const { mod, remove } = build(rowsN(9));
    const first = await call(mod, 'extract', { author: 'antra', channelId: 'd', limit: 4 });
    remove('m3');
    const r = await mod.handleToolCall({ id: 't', name: 'extract', input: { author: 'antra', channelId: 'd', limit: 4, ...first.resume } } as ToolCall);
    assert.equal(r.success, false);
    assert.match(r.error!, /window changed/);
    const noId = await mod.handleToolCall({ id: 't', name: 'extract', input: { author: 'antra', channelId: 'd', windowOffset: 4 } } as ToolCall);
    assert.equal(noId.success, false);
    assert.match(noId.error!, /afterId/);
  });

  const chain = async (mod: HistoryModule, base: Record<string, unknown>, between?: (step: number) => void) => {
    const seen: string[] = [];
    let d = await call(mod, 'search', base);
    seen.push(...d.matches.map((m: any) => m.id));
    for (let step = 0; d.resume && step < 20; step++) {
      between?.(step);
      d = await call(mod, 'search', { ...base, ...d.resume });
      seen.push(...d.matches.map((m: any) => m.id));
    }
    return seen;
  };

  for (const channelId of ['c', undefined]) {
    it(`search newest: a message appended at the resume instant between calls is not lost (${channelId ? 'channel' : 'no channel'})`, async () => {
      const now = Date.now();
      const tieMs = now - MIN;
      const rows: Row[] = [1, 2].map((i) => ({ text: `x-old${i}`, channel: 'c', ms: now - (10 - i) * MIN }));
      for (let i = 0; i < 6; i++) rows.push({ text: `x-tie${i}`, channel: 'c', ms: tieMs });
      const { mod, append, ids: m } = build(rows);
      const base = { query: 'x', order: 'newest', limit: 3, ...(channelId ? { channelId } : {}) };
      const seen = await chain(mod, base, (step) => {
        if (step === 0) append({ text: 'x-tie-new', channel: 'c', ms: tieMs });
      });
      assert.ok(seen.includes(m.get('x-tie-new')!), 'appended tie reached');
      assert.equal(new Set(seen).size, 9);
      assert.equal(seen.length, 9, 'no repeats');
    });
  }

  it('search oldest: removing an already-scanned message at the resume instant does not skip an unscanned one', async () => {
    const now = Date.now();
    const tieMs = now - MIN;
    const rows: Row[] = [];
    for (let i = 0; i < 6; i++) rows.push({ text: `x-tie${i}`, channel: 'c', ms: tieMs });
    rows.push({ text: 'x-after', channel: 'c', ms: now - 0.5 * MIN });
    const { mod, remove, ids: m } = build(rows);
    const seen = await chain(mod, { query: 'x', limit: 2 }, (step) => {
      if (step === 0) remove('x-tie0');
    });
    const expected = ['x-tie0', 'x-tie1', 'x-tie2', 'x-tie3', 'x-tie4', 'x-tie5', 'x-after'].map((t) => m.get(t));
    assert.deepEqual(seen, expected);
  });

  it('search rejects maxScan:0 (it could never make progress)', async () => {
    const { mod } = build(rowsN(2));
    const r = await mod.handleToolCall({ id: 't', name: 'search', input: { query: 'm', maxScan: 0 } } as ToolCall);
    assert.equal(r.success, false);
    assert.match(r.error!, /maxScan/);
  });

  it('aroundId accepts a semantic_search "msg:<id>" hit and explains a "sum:<id>" one', async () => {
    const { mod, ids: m } = build(rowsN(5));
    const d = await call(mod, 'extract', { aroundId: `msg:${m.get('m2')}`, before: 1, after: 1 });
    assert.deepEqual(texts2(d), ['m1', 'm2', 'm3']);
    const r = await mod.handleToolCall({ id: 't', name: 'extract', input: { aroundId: 'sum:42' } } as ToolCall);
    assert.equal(r.success, false);
    assert.match(r.error!, /summary/);
  });
});
