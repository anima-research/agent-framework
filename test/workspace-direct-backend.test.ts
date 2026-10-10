import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, appendFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { directWalk } from '../src/modules/workspace/direct.js';
import type { ModuleContext } from '../src/types/module.js';
import type { MountConfig, MountState, WorkspaceModuleState } from '../src/modules/workspace/types.js';
import type { ToolResult } from '../src/types/events.js';

function makeCtx(opts: {
  isRestart: boolean;
  saved?: WorkspaceModuleState;
  events?: unknown[];
  onSave?: (s: WorkspaceModuleState) => void;
}): ModuleContext {
  return {
    isRestart: opts.isRestart,
    getState: <T,>() => (opts.saved ?? null) as T | null,
    setState: (s: unknown) => opts.onSave?.(s as WorkspaceModuleState),
    pushEvent: (e: unknown) => opts.events?.push(e),
  } as unknown as ModuleContext;
}

type Call = (name: string, input?: Record<string, unknown>) => Promise<ToolResult>;

function setup(t: TestContext, mounts: Array<Partial<MountConfig> & { name: string }>) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-direct-'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const configs: MountConfig[] = mounts.map(m => {
    const path = join(root, m.name);
    mkdirSync(path, { recursive: true });
    return { mode: 'read-write', watch: 'never', ...m, path } as MountConfig;
  });
  const module = new WorkspaceModule({ mounts: configs });
  module.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const call: Call = (name, input = {}) => module.handleToolCall({ id: name, name, input });
  const data = async (name: string, input?: Record<string, unknown>) => {
    const r = await call(name, input);
    assert.equal(r.success, true, `${name} failed: ${r.error}`);
    return r.data as Record<string, unknown>;
  };
  return { root, store, module, call, data };
}

test('direct mount: writes land on disk, reads see shell-side changes, edit and delete act on disk', async t => {
  const { root, call, data } = setup(t, [{ name: 'd', backend: 'direct' }]);
  const file = join(root, 'd', 'notes', 'log.md');

  const w = await data('write', { path: 'd/notes/log.md', content: 'one\n' });
  assert.equal(readFileSync(file, 'utf-8'), 'one\n');
  assert.equal(w.size, 4);

  // A shell append is visible to the very next read — there is no second copy to go stale.
  appendFileSync(file, 'two\n');
  const r = await data('read', { path: 'd/notes/log.md' });
  assert.equal(r.content, '     1\tone\n     2\ttwo\n     3\t');
  assert.equal(r.totalLines, 3);

  await data('edit', { path: 'd/notes/log.md', oldString: 'two', newString: 'TWO' });
  assert.equal(readFileSync(file, 'utf-8'), 'one\nTWO\n');

  const dup = await call('edit', { path: 'd/notes/log.md', oldString: '\n', newString: ';' });
  assert.equal(dup.success, false);
  assert.match(dup.error ?? '', /found 2 times/);
  await data('edit', { path: 'd/notes/log.md', oldString: '\n', newString: ';', replaceAll: true });
  assert.equal(readFileSync(file, 'utf-8'), 'one;TWO;');

  await data('delete', { path: 'd/notes/log.md' });
  assert.equal(existsSync(file), false);
  const gone = await call('read', { path: 'd/notes/log.md' });
  assert.equal(gone.success, false);
  assert.match(gone.error ?? '', /File not found/);

  const status = (await data('status')).d as Record<string, unknown>;
  assert.equal(status.backend, 'direct');
  assert.equal('fileCount' in status, false);
});

test('direct mount: append adds to the end and creates a missing file', async t => {
  const { root, data } = setup(t, [{ name: 'd', backend: 'direct' }]);
  const file = join(root, 'd', 'LOG.md');
  const first = await data('write', { path: 'd/LOG.md', content: 'entry 1\n', append: true });
  assert.equal(first.appended, undefined, 'creating a missing file is a plain write');
  const second = await data('write', { path: 'd/LOG.md', content: 'entry 2 — ✓\n', append: true });
  assert.equal(second.appended, true);
  assert.equal(second.size, statSync(file).size);
  assert.equal(readFileSync(file, 'utf-8'), 'entry 1\nentry 2 — ✓\n');
  await data('write', { path: 'd/LOG.md', content: 'fresh\n' });
  assert.equal(readFileSync(file, 'utf-8'), 'fresh\n');
});

test('chronicle mount: append concatenates in the store', async t => {
  const { data } = setup(t, [{ name: 'c' }]);
  await data('write', { path: 'c/a.txt', content: 'x' });
  const r = await data('write', { path: 'c/a.txt', content: 'y', append: true });
  assert.equal(r.appended, true);
  assert.equal((await data('read', { path: 'c/a.txt' })).content, '     1\txy');
});

test('direct mount: ls, glob and grep read the disk — shell creations visible, deletions gone, binaries reported', async t => {
  const { root, call, data } = setup(t, [{ name: 'd', backend: 'direct', ignore: ['*.tmp'] }]);
  mkdirSync(join(root, 'd', 'sub'));
  writeFileSync(join(root, 'd', 'a.md'), 'alpha needle\n');
  writeFileSync(join(root, 'd', 'sub', 'b.md'), 'beta\nneedle here\n');
  writeFileSync(join(root, 'd', 'sub', 'c.tmp'), 'ignored needle\n');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(root, 'd', 'img.png'), png);

  const top = await data('ls', { path: 'd' });
  assert.deepEqual(top.entries, [
    { name: 'a.md', type: 'file', size: 13 },
    { name: 'img.png', type: 'file', size: png.length },
    { name: 'sub', type: 'directory' },
  ]);
  const rec = await data('ls', { path: 'd', recursive: true });
  assert.deepEqual((rec.entries as Array<{ path: string }>).map(e => e.path).sort(), ['a.md', 'img.png', 'sub/b.md']);
  assert.equal(rec.truncated, undefined);

  const mounts = (await data('ls')).mounts as Array<{ name: string; backend: string }>;
  assert.deepEqual(mounts, [{ name: 'd', path: join(root, 'd'), mode: 'read-write', backend: 'direct' }]);

  // Same glob semantics as the chronicle backend: `*` never crosses a slash, `**/` needs one.
  assert.deepEqual((await data('glob', { pattern: '**/*.md' })).matches, ['d/sub/b.md']);
  assert.deepEqual((await data('glob', { pattern: '*.md', path: 'd' })).matches, ['d/a.md']);

  const grep = await data('grep', { pattern: 'needle', path: 'd' });
  assert.deepEqual(grep.results, [
    { file: 'd/a.md', matches: [{ line: 1, text: 'alpha needle' }] },
    { file: 'd/sub/b.md', matches: [{ line: 2, text: 'needle here' }] },
  ]);
  assert.deepEqual(grep.skipped, { binary: 1, tooLarge: 0, unreadable: 0 });

  const one = await data('grep', { pattern: 'beta', path: 'd/sub/b.md' });
  assert.equal(one.totalMatches, 1);

  rmSync(join(root, 'd', 'a.md'));
  assert.deepEqual((await data('glob', { pattern: '*.md', path: 'd' })).matches, []);
  const asText = await call('read', { path: 'd/img.png' });
  assert.equal(asText.success, false);
  assert.match(asText.error ?? '', /Binary file/);
  const image = await call('read_image', { path: 'd/img.png' });
  assert.equal(image.success, true, image.error);
  assert.equal((image.data as Array<{ type: string }>)[1]?.type, 'image');
});

test('direct mount: materialize and sync report it as not applicable and never touch its files', async t => {
  const { root, call, data } = setup(t, [{ name: 'c' }, { name: 'd', backend: 'direct' }]);
  const file = join(root, 'd', 'keep.md');
  await data('write', { path: 'd/keep.md', content: 'disk truth\n' });
  appendFileSync(file, 'shell append\n');
  const before = statSync(file).mtimeMs;

  await data('write', { path: 'c/x.md', content: 'chronicle\n' });
  const bare = await data('materialize');
  assert.deepEqual(bare.materialized, [{ mount: 'c', path: 'x.md' }]);
  assert.deepEqual(bare.skipped, [{ mount: 'd', reason: 'direct backend — files are already on disk' }]);
  assert.equal(readFileSync(join(root, 'c', 'x.md'), 'utf-8'), 'chronicle\n');

  const named = await data('materialize', { mount: 'd' });
  assert.equal(named.count, 0);
  assert.equal((named.skipped as unknown[]).length, 1);
  const byPath = await data('materialize', { path: 'd/keep.md' });
  assert.equal(byPath.count, 0);

  const sync = await data('sync', { path: 'd/keep.md' });
  assert.equal(sync.totalSynced, 0);
  assert.deepEqual(sync.skipped, [{ mount: 'd', path: '*', reason: 'direct backend — reads always come from disk' }]);
  const syncAll = await data('sync');
  assert.equal((syncAll.skipped as Array<{ mount: string }>).some(s => s.mount === 'd'), true);

  assert.equal(readFileSync(file, 'utf-8'), 'disk truth\nshell append\n');
  assert.equal(statSync(file).mtimeMs, before);
  const r = await call('materialize', { mount: 'nope' });
  assert.equal(r.success, false);
});

test('direct mount: traversal and symlink escapes are refused on every op', async t => {
  const { root, call } = setup(t, [{ name: 'd', backend: 'direct' }]);
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(root, 'd', 'link.txt'));
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(root, 'd', 'linkdir'));

  for (const [name, input] of [
    ['read', { path: 'd/../outside.txt' }],
    ['write', { path: 'd/../x.txt', content: 'no' }],
    ['delete', { path: 'd/../outside.txt' }],
  ] as const) {
    const r = await call(name, input as Record<string, unknown>);
    assert.equal(r.success, false, name);
    assert.match(r.error ?? '', /traversal/, name);
  }
  for (const [name, input] of [
    ['read', { path: 'd/link.txt' }],
    ['write', { path: 'd/link.txt', content: 'no' }],
    ['edit', { path: 'd/link.txt', oldString: 's', newString: 'S' }],
    ['delete', { path: 'd/link.txt' }],
    ['write', { path: 'd/linkdir/new.txt', content: 'no' }],
  ] as const) {
    const r = await call(name, input as Record<string, unknown>);
    assert.equal(r.success, false, name);
    assert.match(r.error ?? '', /[Ss]ymlink/, `${name}: ${r.error}`);
  }
  assert.equal(readFileSync(outside, 'utf-8'), 'secret');
  assert.equal(existsSync(join(root, 'elsewhere', 'new.txt')), false);
  // Symlinks are listed as such, never followed, and skipped by recursive walks.
  const ls = await call('ls', { path: 'd' });
  assert.deepEqual(ls.data, { path: 'd', entries: [{ name: 'link.txt', type: 'symlink' }, { name: 'linkdir', type: 'symlink' }], count: 2 });
  assert.deepEqual((await call('ls', { path: 'd', recursive: true })).data, { path: 'd', entries: [], count: 0 });
});

test('direct walk: the file cap is reported, not silent', async t => {
  const { root, module } = setup(t, [{ name: 'd', backend: 'direct' }]);
  for (let i = 0; i < 7; i++) writeFileSync(join(root, 'd', `f${i}.txt`), String(i));
  const mount = (module as unknown as { mounts: Map<string, MountState> }).mounts.get('d')!;
  const walk = await directWalk(mount, '', { recursive: true, cap: 3 });
  assert.equal(walk.files.length, 3);
  assert.equal(walk.truncated, true);
  const full = await directWalk(mount, '', { recursive: true });
  assert.equal(full.files.length, 7);
  assert.equal(full.truncated, false);
});

test('switching a mount back from direct to chronicle syncs disk before the first materialize', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-direct-switch-'));
  const dir = join(root, 'w');
  mkdirSync(dir);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const base = { name: 'w', path: dir, mode: 'read-write' as const, watch: 'never' as const };
  const run = (name: string, m: WorkspaceModule, input: Record<string, unknown> = {}) => m.handleToolCall({ id: name, name, input });

  // 1. Chronicle: write v1 and materialize it.
  const chron1 = new WorkspaceModule({ mounts: [base] });
  chron1.initStore(store);
  let saved: WorkspaceModuleState | undefined;
  await chron1.start(makeCtx({ isRestart: false, onSave: s => { saved = s; } }));
  assert.equal((await run('write', chron1, { path: 'w/a.md', content: 'v1\n' })).success, true);
  assert.equal((await run('materialize', chron1)).success, true);
  await chron1.stop();
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf-8'), 'v1\n');
  assert.equal(saved?.mounts.w.backend, 'chronicle');

  // 2. Direct stint: v2 goes straight to disk; the tree still says v1.
  const direct = new WorkspaceModule({ mounts: [{ ...base, backend: 'direct' }] });
  direct.initStore(store);
  await direct.start(makeCtx({ isRestart: true, saved, onSave: s => { saved = s; } }));
  assert.equal((await run('write', direct, { path: 'w/a.md', content: 'v2\n' })).success, true);
  await direct.stop();
  assert.equal(saved?.mounts.w.backend, 'direct');

  // 3. Back to chronicle: a bare materialize must not revert disk to v1.
  const chron2 = new WorkspaceModule({ mounts: [base] });
  chron2.initStore(store);
  await chron2.start(makeCtx({ isRestart: true, saved }));
  const mat = await run('materialize', chron2);
  assert.equal(mat.success, true, mat.error);
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf-8'), 'v2\n');
  const read = await run('read', chron2, { path: 'w/a.md' });
  assert.equal((read.data as { content: string }).content, '     1\tv2\n     2\t');
  await chron2.stop();
});

test('direct mount with watch: always emits filesystem events without a tree', async t => {
  const { root, module } = setup(t, [{ name: 'd', backend: 'direct', watch: 'always', watchDebounceMs: 50 }]);
  const events: Array<{ type: string; paths?: string[] }> = [];
  await module.start(makeCtx({ isRestart: false, events }));
  const mount = (module as unknown as { mounts: Map<string, MountState> }).mounts.get('d')!;
  const deadline = Date.now() + 5000;
  while (mount.watcherReadyAt === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.notEqual(mount.watcherReadyAt, null, 'watcher attached');

  writeFileSync(join(root, 'd', 'ext.md'), 'from outside\n');
  while (!events.some(e => e.type === 'workspace:created') && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  const created = events.find(e => e.type === 'workspace:created');
  assert.deepEqual(created?.paths, ['d/ext.md']);
  assert.equal(events.some(e => e.type === 'workspace:initial-scan-failed'), false);
  await module.stop();
});
