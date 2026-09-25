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
  rows.forEach((r, i) => {
    const meta: Record<string, unknown> = { channelId: r.channel };
    if (r.author) meta.author = { id: r.authorId ?? `id-${r.author}`, name: r.author };
    const m = ms.append('user', [{ type: 'text', text: r.text }], meta as never);
    ids.set(r.text, String(m.id));
    const item = store.getStateItemJson('messages', i) as Record<string, unknown>;
    store.editStateItem('messages', i, Buffer.from(JSON.stringify({ ...item, timestamp: r.ms })));
  });
  const cm = {
    queryMessagesByTime: (o: never) => ms.queryByTime(o),
    queryMessagesByTimeAndChannel: (o: never) => ms.queryByTimeAndChannel(o),
    getMessage: (id: string) => ms.get(id as never),
  } as unknown as ContextManager;
  const mod = new HistoryModule();
  mod.bind(cm);
  return { mod, ids };
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
