/**
 * A mount that contains another mount ignores it (agent-framework #280).
 *
 * The constructor's overlap guard adds an ignore rule to the outer mount for
 * the inner mount's directory, and says so ("auto-ignoring to prevent
 * overlap"). It pushed the bare relative path, which the walk's matcher reads
 * only as an entry name: a mount nested two levels deep (`a/b`) was never
 * ignored, so the outer mount synced the inner mount's files too, and a
 * mount nested one level deep (`sub`) also hid every other directory named
 * `sub`. The rule is now `<rel>/**`, which matches that path from the
 * outer mount's root and what is under it, and nothing else.
 *
 * The watcher read none of a mount's patterns: chokidar takes a string as one
 * exact path. It now reads them as the walk does.
 *
 * #282's round makes the invariant whole: a mount never takes in or writes
 * out what lies in a mount nested in it. Nesting is read from canonical
 * roots; the outer mount's tools refuse paths in the inner's directory,
 * naming the inner; and every containment check refuses a canonical path
 * there, however it was reached.
 *
 * Driven through the public tools, and a real watcher, over tmpdir mounts.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep, win32 } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { nestedAt } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import { MountWatcher, type FsChange } from '../src/modules/workspace/watcher.js';

/** A valid 1x1 PNG, for read_image. */
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');

function workspaceWith(t: TestContext, files: string[], innerRel: string, outerIgnore?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'af-nested-mount-'));
  const outerDir = join(root, 'outer');
  for (const file of files) {
    mkdirSync(dirname(join(outerDir, file)), { recursive: true });
    writeFileSync(join(outerDir, file), file);
  }
  mkdirSync(join(outerDir, innerRel), { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const outer: MountConfig = {
    name: 'outer', path: outerDir, mode: 'read-write', watch: 'never',
    ...(outerIgnore ? { ignore: [...outerIgnore] } : {}),
  };
  const warn = console.warn;
  console.warn = () => {};
  let workspace: WorkspaceModule;
  try {
    workspace = new WorkspaceModule({ mounts: [
      outer,
      { name: 'inner', path: join(outerDir, innerRel), mode: 'read-write', watch: 'never' },
    ] });
  } finally { console.warn = warn; }
  workspace.initStore(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { workspace, outer };
}

async function syncedByOuter(workspace: WorkspaceModule): Promise<string[]> {
  const result = await workspace.handleToolCall({ id: 'sync-outer', name: 'sync', input: { mount: 'outer' } });
  assert.equal(result.success, true, `sync should succeed: ${result.error ?? ''}`);
  const data = result.data as { results: Array<{ mount: string; synced: string[] }> };
  return [...data.results.find((r) => r.mount === 'outer')!.synced].sort();
}

test('a mount nested two levels deep is left out of the outer mount', async (t) => {
  const { workspace, outer } = workspaceWith(t, ['top.txt', 'a/b/x.txt', 'a/other.txt'], 'a/b');
  assert.deepEqual(outer.ignore, ['a/b/**']);
  assert.deepEqual(await syncedByOuter(workspace), ['a/other.txt', 'top.txt'],
    "the inner mount's file is the inner mount's alone; its sibling is still the outer's");
});

test("a sync without a path counts the nested mount's directory under passedOver", async (t) => {
  const { workspace } = workspaceWith(t, ['top.txt', 'a/b/x.txt'], 'a/b');
  const result = await workspace.handleToolCall({ id: 'sync-outer', name: 'sync', input: { mount: 'outer' } });
  const data = result.data as { passedOver?: Array<{ mount: string; reason: string; count: number }> };
  assert.deepEqual(data.passedOver?.filter((p) => p.mount === 'outer'), [{ mount: 'outer', reason: 'ignored by the mount', count: 1 }]);
});

test("a mount nested one level deep hides only itself, not every directory with its name", async (t) => {
  const { workspace, outer } = workspaceWith(t, ['sub/z.txt', 'deep/sub/y.txt', 'top.txt'], 'sub');
  assert.deepEqual(outer.ignore, ['sub/**']);
  assert.deepEqual(await syncedByOuter(workspace), ['deep/sub/y.txt', 'top.txt']);
});

test("an outer mount's own bare path doesn't stop the rule that works; its own /** form isn't repeated", async (t) => {
  const bare = workspaceWith(t, ['top.txt', 'a/b/x.txt'], 'a/b', ['a/b']);
  assert.deepEqual(bare.outer.ignore, ['a/b', 'a/b/**']);
  assert.deepEqual(await syncedByOuter(bare.workspace), ['top.txt']);

  const glob = workspaceWith(t, ['top.txt', 'a/b/x.txt'], 'a/b', ['a/b/**']);
  assert.deepEqual(glob.outer.ignore, ['a/b/**']);
  assert.deepEqual(await syncedByOuter(glob.workspace), ['top.txt']);
});

test("a mount nested in a directory whose name starts with '..' is still nested", async (t) => {
  const { workspace, outer } = workspaceWith(t, ['top.txt', '..cache/x.txt'], '..cache');
  assert.deepEqual(outer.ignore, ['..cache/**']);
  assert.deepEqual(await syncedByOuter(workspace), ['top.txt']);
});

test("a watched mount's changes pass over what it ignores, a nested mount included", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'af-nested-mount-watch-'));
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  mkdirSync(join(outerDir, 'a', 'c'));
  const outer: MountConfig = {
    name: 'outer', path: outerDir, mode: 'read-write', watch: 'always', ignore: ['node_modules', '*.log', 'vendor/', 'build/cache'],
    watchDebounceMs: 50, watchRootPollMs: 50,
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    new WorkspaceModule({ mounts: [
      outer,
      { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
    ] });
  } finally { console.warn = warn; }
  assert.deepEqual(outer.ignore, ['node_modules', '*.log', 'vendor/', 'build/cache', 'a/b/**']);

  const seen: FsChange[] = [];
  let ready!: () => void, failed!: (err: Error) => void;
  const isReady = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const watcher = new MountWatcher(outer, (changes) => { seen.push(...changes); }, {
    onReady: () => ready(),
    onError: (err: Error) => failed(err),
  });
  // Chokidar's polling backend, as the watcher tests use outside their
  // Linux-only native cases: the ignore rule is the walk's on either backend.
  // On macOS in CI, the native stream reported none of the writes into `a/`
  // and `a/c/`, directories that existed before the watch began.
  const backend = { usePolling: process.env.CHOKIDAR_USEPOLLING, interval: process.env.CHOKIDAR_INTERVAL };
  process.env.CHOKIDAR_USEPOLLING = 'true';
  process.env.CHOKIDAR_INTERVAL = '25';
  try {
    watcher.start();
  } finally {
    if (backend.usePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = backend.usePolling;
    if (backend.interval === undefined) delete process.env.CHOKIDAR_INTERVAL;
    else process.env.CHOKIDAR_INTERVAL = backend.interval;
  }
  t.after(async () => {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });
  // A watcher that never starts, or fails, fails the test rather than hanging it.
  let bound: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([isReady, new Promise((_, reject) => { bound = setTimeout(() => reject(new Error('the watcher was not ready within 10 s')), 10_000); })])
    .finally(() => clearTimeout(bound));
  // Chokidar 4 reads a directory before it starts that directory's poller,
  // and the poller takes its first reading later, so `ready` can come before
  // a directory that existed before the watch has one. A write made then can
  // fall inside that first reading and never be reported: about 1 run in 48
  // on the VPS missed `a/c/y.txt`, on Node 20 and 24 alike. So each such
  // directory gets a new file each round until one is reported there, which
  // shows its poller is reading, before the checks begin.
  const primedDirs = ['', 'a', 'a/c'];
  const primedIn = (dir: string) => seen.some((c) => c.path.startsWith(dir ? `${dir}/primed-` : 'primed-'));
  for (let round = 0; round < 25 && !primedDirs.every(primedIn); round++) {
    for (const dir of primedDirs.filter((d) => !primedIn(d))) writeFileSync(join(outerDir, dir, `primed-${round}.txt`), 'primed');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(primedDirs.every(primedIn), `each directory that existed before the watch reported a write: ${JSON.stringify(seen.map((c) => c.path))}`);

  // Each ignored write has a twin the mount reports, written after it and
  // reported by the same machinery, though not strictly after it: the same
  // directory for the name pattern, and the same depth for the two ignored
  // directories. Each directory is polled on its own, and each file's report
  // waits for its size to settle, so reported writes can arrive in any order;
  // waiting for every twin gives each ignored write the time it would take to
  // be reported.
  mkdirSync(join(outerDir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(outerDir, 'node_modules', 'pkg', 'index.js'), 'ignored');
  mkdirSync(join(outerDir, 'pkgs', 'pkg'), { recursive: true });
  writeFileSync(join(outerDir, 'pkgs', 'pkg', 'index.js'), 'its twin');
  writeFileSync(join(outerDir, 'a', 'b', 'x.txt'), 'the inner mount\'s');
  writeFileSync(join(outerDir, 'a', 'c', 'y.txt'), 'its twin');
  writeFileSync(join(outerDir, 'a', 'x.log'), 'ignored by its name');
  writeFileSync(join(outerDir, 'a', 'other.txt'), 'its twin');
  // A name below the root (I19), a trailing-slash name and a slash path (I7).
  mkdirSync(join(outerDir, 'deep', 'node_modules'), { recursive: true });
  writeFileSync(join(outerDir, 'deep', 'node_modules', 'dep.js'), 'ignored below the root');
  mkdirSync(join(outerDir, 'deep', 'modules'));
  writeFileSync(join(outerDir, 'deep', 'modules', 'dep.js'), 'its twin');
  mkdirSync(join(outerDir, 'vendor'));
  writeFileSync(join(outerDir, 'vendor', 'lib.js'), "ignored as 'vendor/'");
  mkdirSync(join(outerDir, 'vendored'));
  writeFileSync(join(outerDir, 'vendored', 'lib.js'), 'its twin');
  mkdirSync(join(outerDir, 'build', 'cache'), { recursive: true });
  writeFileSync(join(outerDir, 'build', 'cache', 'blob'), "ignored as 'build/cache'");
  mkdirSync(join(outerDir, 'build', 'out'));
  writeFileSync(join(outerDir, 'build', 'out', 'blob'), 'its twin');
  writeFileSync(join(outerDir, 'later.txt'), 'last');
  const reported = ['pkgs/pkg/index.js', 'a/c/y.txt', 'a/other.txt', 'deep/modules/dep.js', 'vendored/lib.js', 'build/out/blob', 'later.txt'];
  for (let i = 0; i < 200 && !reported.every((path) => seen.some((c) => c.path === path)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Then a settle window longer than a report's own delays (debounce 50 ms,
  // a file's size settling over 100 ms), so an ignored write reported after
  // its twin is still seen (I1).
  await new Promise((resolve) => setTimeout(resolve, 600));
  const paths = seen.map((c) => c.path).sort();
  for (const path of reported) assert.ok(paths.includes(path), `${path} was seen: ${JSON.stringify(paths)}`);
  const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');
  assert.deepEqual(paths.filter((p) => under(p, 'a/b') || under(p, 'node_modules') || under(p, 'deep/node_modules')
    || under(p, 'vendor') || under(p, 'build/cache') || p.endsWith('.log')), [],
    'nothing the mount ignores was reported');
});

test("trailing-slash and slash-path patterns leave out what they name in a sync, and nothing else", async (t) => {
  const { workspace } = workspaceWith(t,
    ['vendor/lib.js', 'vendored/lib.js', 'build/cache/blob', 'build/out/blob', 'deep/node_modules/dep.js', 'top.txt'],
    'inner', ['vendor/', 'build/cache', 'node_modules/']);
  assert.deepEqual(await syncedByOuter(workspace), ['build/out/blob', 'top.txt', 'vendored/lib.js']);
});

test("a parent or a sibling mount isn't nested in a mount; the parent holds its child", (t) => {
  const root = mkdtempSync(join(tmpdir(), 'af-nested-mount-family-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'child'));
  mkdirSync(join(root, 'side'));
  const child: MountConfig = { name: 'child', path: join(root, 'child'), mode: 'read-write', watch: 'never' };
  const parent: MountConfig = { name: 'parent', path: root, mode: 'read-write', watch: 'never' };
  const side: MountConfig = { name: 'side', path: join(root, 'side'), mode: 'read-write', watch: 'never' };
  const warn = console.warn;
  console.warn = () => {};
  try { new WorkspaceModule({ mounts: [child, parent, side] }); } finally { console.warn = warn; }
  assert.equal(child.ignore, undefined, "its parent (`..`) isn't nested in the child");
  assert.equal(side.ignore, undefined, "its sibling (`../child`) isn't nested in it");
  assert.deepEqual(parent.ignore, ['child/**', 'side/**']);
});

test('nesting by the platform rules: separators, `..`, and another Windows drive', () => {
  assert.equal(nestedAt('C:\\w\\outer', 'C:\\w\\outer\\a\\b', win32), 'a/b');
  assert.equal(nestedAt('C:\\w\\outer', 'D:\\w\\outer\\a', win32), null, 'another drive is another root');
  assert.equal(nestedAt('C:\\w\\outer', 'C:\\w', win32), null);
  assert.equal(nestedAt('C:\\w\\outer', 'C:\\w\\side', win32), null);
  assert.equal(nestedAt('C:\\w\\outer', 'C:\\w\\outer', win32), null);
  assert.equal(nestedAt('C:\\w\\outer', 'C:\\w\\outer\\..cache', win32), '..cache');
  assert.equal(nestedAt('/w/outer', '/w/outer/..cache/x'), '..cache/x');
});

test('a nested mount configured through a symlink, or an outer one, is still nested', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'af-nested-mount-spelling-'));
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  writeFileSync(join(outerDir, 'a', 'b', 'x.txt'), "the inner mount's");
  writeFileSync(join(outerDir, 'top.txt'), 'top');
  symlinkSync(join(outerDir, 'a', 'b'), join(root, 'inner-link'));
  symlinkSync(outerDir, join(root, 'outer-link'));
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const outer: MountConfig = { name: 'outer', path: join(root, 'outer-link'), mode: 'read-write', watch: 'never' };
  const warn = console.warn;
  console.warn = () => {};
  let workspace: WorkspaceModule;
  try {
    workspace = new WorkspaceModule({ mounts: [outer, { name: 'inner', path: join(root, 'inner-link'), mode: 'read-write', watch: 'never' }] });
  } finally { console.warn = warn; }
  workspace.initStore(store);
  assert.deepEqual(outer.ignore, ['a/b/**']);
  assert.deepEqual(await syncedByOuter(workspace), ['top.txt']);
});

/** A scratch root, removed after every workspace started on it has stopped. */
function scratch(t: TestContext, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stops: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const stop of stops.reverse()) await stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, stops };
}

/** A started workspace on a store at `storePath`; `stops` stops it at the end, if nothing has. */
async function started(stops: Array<() => Promise<void>>, storePath: string, mounts: MountConfig[]) {
  const store = JsStore.openOrCreate({ path: storePath });
  const warn = console.warn;
  console.warn = () => {};
  let workspace: WorkspaceModule;
  try { workspace = new WorkspaceModule({ mounts }); } finally { console.warn = warn; }
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await workspace.stop();
    if (!store.isClosed()) store.close();
  };
  stops.push(stop);
  return { workspace, stop };
}

test("the outer mount's tools refuse a path in a nested mount, naming it; deleting an old copy only stops tracking it", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-tools-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  writeFileSync(join(outerDir, 'a', 'b', 'x.txt'), "the inner mount's");
  const storePath = join(root, 'workspace.chronicle');
  const outer = (): MountConfig => ({ name: 'outer', path: outerDir, mode: 'read-write', watch: 'never' });
  const inner = (): MountConfig => ({ name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' });

  // Before the inner mount existed, the outer one took the file in, so disk
  // agreed with it about that path, and then drafted over it.
  const before = await started(stops, storePath, [outer()]);
  const tookIn = await before.workspace.handleToolCall({ id: 'took-in', name: 'sync', input: { mount: 'outer' } });
  assert.equal(tookIn.success, true, String(tookIn.error));
  assert.equal((tookIn.data as { totalSynced: number }).totalSynced, 1, 'the outer mount took in a/b/x.txt');
  assert.equal((await before.workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/a/b/x.txt', content: 'an outer draft' } })).success, true);
  await before.stop();

  const { workspace } = await started(stops, storePath, [outer(), inner()]);
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  for (const [name, input] of [
    ['read', { path: 'outer/a/b/x.txt' }], ['write', { path: 'outer/a/b/y.txt', content: 'no' }],
    ['edit', { path: 'outer/a/b/x.txt', oldString: 'an', newString: 'no' }], ['ls', { path: 'outer/a/b' }],
    ['glob', { pattern: '**', path: 'outer/a/b' }], ['grep', { pattern: 'draft', path: 'outer/a/b' }],
    ['sync', { path: 'outer/a/b' }], ['sync', { path: 'outer/a/./b/x.txt' }], ['materialize', { path: 'outer/a/b/x.txt' }],
  ] as const) {
    const result = await call(name, input);
    assert.equal(result.success, false, `${name} ${JSON.stringify(input)} is refused`);
    assert.match(String(result.error), /is inside mount "inner", which is nested in "outer" at a\/b\/: use "inner(\/[^"]*)?"/, `${name}: ${result.error}`);
  }

  // A materialize without a path leaves the old draft unwritten, and says why.
  const pushed = await call('materialize', {});
  assert.match(JSON.stringify(pushed), /a\/b\/x\.txt: inside mount \\"inner\\", which is nested in this one; delete it here to stop tracking it/, JSON.stringify(pushed));
  assert.equal(readFileSync(join(outerDir, 'a', 'b', 'x.txt'), 'utf8'), "the inner mount's", "the inner mount's file is untouched");

  // Deleting the old copy stops tracking it here, and leaves disk alone.
  const dropped = await call('delete', { path: 'outer/a/b/x.txt' });
  assert.equal(dropped.success, true, String(dropped.error));
  assert.match(JSON.stringify(dropped.data), /no longer tracked by \\"outer\\"/);
  assert.equal(readFileSync(join(outerDir, 'a', 'b', 'x.txt'), 'utf8'), "the inner mount's");
  const again = await call('delete', { path: 'outer/a/b/x.txt' });
  assert.equal(again.success, false);
  assert.match(String(again.error), /doesn't hold it: use "inner\/x\.txt"/);
  // Nothing of it is owed any more: a later materialize doesn't list it.
  const after = await call('materialize', {});
  assert.doesNotMatch(JSON.stringify(after), /a\/b\/x\.txt/, JSON.stringify(after));
  // Nor is it remembered: what disk agreed with about it is gone too, so a
  // sync without a path passes over the inner mount's directory as ignored,
  // and has nothing of it to report.
  const later = await call('sync', { mount: 'outer' });
  assert.equal(later.success, true, String(later.error));
  const laterData = later.data as { skipped?: unknown; incomplete?: unknown; passedOver?: unknown };
  assert.equal(laterData.skipped, undefined, JSON.stringify(laterData));
  assert.equal(laterData.incomplete, undefined, JSON.stringify(laterData));
  assert.deepEqual(laterData.passedOver, [{ mount: 'outer', reason: 'ignored by the mount', count: 1 }]);
  // The inner mount answers for its own file.
  assert.equal((await call('read', { path: 'inner/x.txt' })).success, true);
});

test('an alias inside a following outer mount reaches nothing of a nested mount', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-alias-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  writeFileSync(join(outerDir, 'a', 'b', 'x.txt'), "the inner mount's");
  symlinkSync(join(outerDir, 'a', 'b'), join(outerDir, 'alias'));
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize: true },
    { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  const synced = await call('sync', { path: 'outer/alias/x.txt' });
  assert.equal(synced.success, true, String(synced.error));
  const data = synced.data as { totalSynced: number; skipped?: Array<{ path: string; reason: string }> };
  assert.equal(data.totalSynced, 0, 'nothing taken in through the alias');
  assert.match(JSON.stringify(data.skipped), /inside mount \\"inner\\", which is nested in this one/);
  const written = await call('write', { path: 'outer/alias/y.txt', content: 'through the alias' });
  assert.match(JSON.stringify(written), /inside mount \\"inner\\", which is nested in this one/, JSON.stringify(written));
  assert.throws(() => readFileSync(join(outerDir, 'a', 'b', 'y.txt')), "nothing was written into the inner mount's directory");
});

test("the disk readers reach nothing of a nested mount through an alias, and the raw reader keeps the mount's boundary", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-readers-');
  const outerDir = join(root, 'outer');
  const innerDir = join(outerDir, 'a', 'b');
  mkdirSync(innerDir, { recursive: true });
  writeFileSync(join(innerDir, 'x.txt'), "the inner mount's");
  writeFileSync(join(innerDir, 'i.png'), ONE_PIXEL_PNG);
  writeFileSync(join(outerDir, 'own.txt'), "the outer mount's");
  writeFileSync(join(root, 'outside.txt'), 'outside every mount');
  symlinkSync(innerDir, join(outerDir, 'alias'));
  symlinkSync(join(outerDir, 'own.txt'), join(outerDir, 'own-link.txt'));
  symlinkSync(join(root, 'outside.txt'), join(outerDir, 'out-link.txt'));
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'inner', path: innerDir, mode: 'read-write', watch: 'never' },
  ]);
  const naming = /"outer\/alias\/(x\.txt|i\.png)" is inside mount "inner", which is nested in "outer": use "inner\/(x\.txt|i\.png)"/;

  await assert.rejects(workspace.readFileFromDisk('outer/alias/x.txt'), (err: Error & { code?: string }) => {
    assert.equal(err.code, 'escape');
    assert.match(err.message, naming);
    return true;
  });
  const raw = await workspace.readBinaryFromDisk('outer/alias/x.txt');
  assert.ok('error' in raw, 'the raw reader refuses it');
  assert.match(raw.error, naming);
  const image = await workspace.handleToolCall({ id: 'img', name: 'read_image', input: { path: 'outer/alias/i.png' } });
  assert.equal(image.success, false, 'read_image refuses it');
  assert.match(String(image.error), naming);
  // The inner mount answers for its own files.
  assert.equal((await workspace.readFileFromDisk('inner/x.txt')).bytes.toString(), "the inner mount's");

  // The raw reader follows a symlink within the mount, and refuses one that leads outside it, as the others do.
  const own = await workspace.readBinaryFromDisk('outer/own-link.txt');
  assert.ok('data' in own, 'error' in own ? own.error : '');
  assert.equal(own.data.toString(), "the outer mount's");
  // Its size limit is checked on the file it opens, with its old text.
  const capped = await workspace.readBinaryFromDisk('outer/own-link.txt', { maxBytes: 3 });
  assert.deepEqual(capped, { error: `File too large: ${Buffer.byteLength("the outer mount's")} > 3 bytes` });
  const out = await workspace.readBinaryFromDisk('outer/out-link.txt');
  assert.ok('error' in out);
  assert.match(out.error, /Symlink escape detected: outer\/out-link\.txt/);
  await assert.rejects(workspace.readFileFromDisk('outer/out-link.txt'), /Symlink escape detected/);
});

test("a nested mount whose root doesn't exist yet, configured through a symlinked parent, is nested from the start", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-absent-');
  const outerDir = join(root, 'outer');
  mkdirSync(outerDir);
  writeFileSync(join(outerDir, 'top.txt'), 'top');
  symlinkSync(outerDir, join(root, 'via'));
  const outer: MountConfig = { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', autoMaterialize: true };
  const inner: MountConfig = { name: 'inner', path: join(root, 'via', 'child'), mode: 'read-write', watch: 'never' };
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const warn = console.warn;
  console.warn = () => {};
  let workspace: WorkspaceModule;
  try { workspace = new WorkspaceModule({ mounts: [outer, inner] }); } finally { console.warn = warn; }
  stops.push(async () => { await workspace.stop(); if (!store.isClosed()) store.close(); });
  assert.deepEqual(outer.ignore, ['child/**'], 'the inner root reads through the symlink before it exists');
  // The inner root is made, and a file in it, after the module was built.
  mkdirSync(join(outerDir, 'child'));
  writeFileSync(join(outerDir, 'child', 'x.txt'), "the inner mount's");
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  assert.deepEqual(await syncedByOuter(workspace), ['top.txt']);
  const written = await call('write', { path: 'outer/child/x.txt', content: 'an outer overwrite' });
  assert.equal(written.success, false);
  assert.match(String(written.error), /is inside mount "inner", which is nested in "outer" at child\/: use "inner\/x\.txt"/);
  assert.equal(readFileSync(join(outerDir, 'child', 'x.txt'), 'utf8'), "the inner mount's");
});

// Spellings of a root that will be the outer mount's `child`, made before it
// exists: `base/hop` links to the outer mount's `deep`, so `base/hop/..` is
// the outer mount, as the filesystem reads it (`..` after following `hop`).
const unmadeRootSpellings: Array<{ name: string; spell: (root: string) => string }> = [
  {
    name: 'a link to it',
    spell: (root) => {
      symlinkSync(join(root, 'outer', 'child'), join(root, 'inner-link'));
      return join(root, 'inner-link');
    },
  },
  {
    name: "a link whose target climbs out of a linked directory with '..'",
    spell: (root) => {
      symlinkSync(['base', 'hop', '..', 'child'].join(sep), join(root, 'inner-link'));
      return join(root, 'inner-link');
    },
  },
];

test("a mount configured with '..' after a link reads that path as every workspace operation does, so nesting and its own files agree", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-written-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'deep'), { recursive: true });
  mkdirSync(join(outerDir, 'child'));
  writeFileSync(join(outerDir, 'child', 'x.txt'), 'through the link');
  mkdirSync(join(root, 'base', 'child'), { recursive: true });
  writeFileSync(join(root, 'base', 'child', 'x.txt'), 'as written');
  symlinkSync(join(outerDir, 'deep'), join(root, 'base', 'hop'));
  const outer: MountConfig = { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never' };
  // Through the link, `base/hop/..` is the outer mount; as written, it is
  // `base`. The workspace reads a configured path as written, so this inner
  // mount is `base/child` for its own operations and for nesting alike.
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    outer,
    { name: 'inner', path: [root, 'base', 'hop', '..', 'child'].join(sep), mode: 'read-write', watch: 'never' },
  ]);
  assert.equal(outer.ignore, undefined, 'not nested in the outer mount');
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  const synced = await call('sync', { mount: 'inner' });
  assert.equal(synced.success, true, String(synced.error));
  const own = await call('read', { path: 'inner/x.txt' });
  assert.equal(own.success, true, String(own.error));
  assert.match((own.data as { content: string }).content, /as written/);
  assert.equal((await workspace.readFileFromDisk('inner/x.txt')).bytes.toString(), 'as written');
  // A generated file registers there and reads back, as in a mount configured plainly.
  workspace.registerGeneratedTextFile('inner/live.txt', () => 'generated content', 'owner');
  const generated = await workspace.handleToolCall({ id: 'generated', name: 'read', callerAgentName: 'owner', input: { path: 'inner/live.txt' } });
  assert.equal(generated.success, true, String(generated.error));
  assert.match((generated.data as { content: string }).content, /generated content/);
  const outers = await call('read', { path: 'outer/child/x.txt' });
  assert.equal(outers.success, true, String(outers.error));
  assert.match((outers.data as { content: string }).content, /through the link/);

  // Its watcher watches the same root, and reports a change there relative to it.
  const configured = [root, 'base', 'hop', '..', 'child', ''].join(sep);
  const seen: FsChange[] = [];
  let ready!: () => void;
  const isReady = new Promise<void>((resolveReady) => { ready = resolveReady; });
  const watcher = new MountWatcher(
    { name: 'inner', path: configured, mode: 'read-write', watch: 'always', watchDebounceMs: 50, watchRootPollMs: 50 },
    (changes) => { seen.push(...changes); },
    { onReady: () => ready() },
  );
  const backend = { usePolling: process.env.CHOKIDAR_USEPOLLING, interval: process.env.CHOKIDAR_INTERVAL };
  process.env.CHOKIDAR_USEPOLLING = 'true';
  process.env.CHOKIDAR_INTERVAL = '25';
  try {
    watcher.start();
  } finally {
    if (backend.usePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = backend.usePolling;
    if (backend.interval === undefined) delete process.env.CHOKIDAR_INTERVAL;
    else process.env.CHOKIDAR_INTERVAL = backend.interval;
  }
  stops.push(() => watcher.stop());
  await isReady;
  // A new file in each round, until one is reported: the warm-up the
  // nested-mount watch test explains.
  for (let round = 0; round < 25 && !seen.some((c) => c.path.startsWith('new-')); round++) {
    writeFileSync(join(root, 'base', 'child', `new-${round}.txt`), 'new');
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  assert.ok(seen.some((c) => /^new-\d+\.txt$/.test(c.path)), `a change under base/child was reported relative to the root: ${JSON.stringify(seen)}`);
});

for (const autoMaterialize of [true, false]) for (const { name: spelling, spell } of unmadeRootSpellings) {
  test(`a nested mount configured as ${spelling}, before its directory is made, is nested from the start (autoMaterialize ${autoMaterialize})`, async (t) => {
    const { root, stops } = scratch(t, 'af-nested-mount-unmade-');
    const outerDir = join(root, 'outer');
    mkdirSync(join(outerDir, 'deep'), { recursive: true });
    mkdirSync(join(root, 'base'));
    symlinkSync(join(outerDir, 'deep'), join(root, 'base', 'hop'));
    writeFileSync(join(outerDir, 'top.txt'), 'top');
    const outer: MountConfig = { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', autoMaterialize };
    const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
      outer,
      { name: 'inner', path: spell(root), mode: 'read-write', watch: 'never' },
    ]);
    assert.deepEqual(outer.ignore, ['child/**'], 'the inner root reads as the filesystem will read it, before it exists');
    const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
    const written = await call('write', { path: 'outer/child/y.txt', content: 'an outer write' });
    assert.equal(written.success, false, JSON.stringify(written));
    assert.match(String(written.error), /"outer\/child\/y\.txt" is inside mount "inner", which is nested in "outer" at child\/: use "inner\/y\.txt"/);
    assert.equal(existsSync(join(outerDir, 'child')), false, "nothing made the inner mount's directory");
    const owed = await call('materialize', {});
    assert.doesNotMatch(JSON.stringify(owed), /child\/y\.txt/, 'the outer mount holds nothing at that path');
    // Once the root is made, the outer mount's sync passes over it.
    mkdirSync(join(outerDir, 'child'));
    writeFileSync(join(outerDir, 'child', 'x.txt'), "the inner mount's");
    assert.deepEqual(await syncedByOuter(workspace), ['top.txt']);
  });
}

for (const autoMaterialize of [true, false]) {
  test(`a mount that comes to lie in another after the module is built is refused there, whatever path reaches it (autoMaterialize ${autoMaterialize})`, async (t) => {
    const { root, stops } = scratch(t, 'af-nested-mount-later-');
    const outerDir = join(root, 'outer');
    mkdirSync(outerDir);
    writeFileSync(join(outerDir, 'top.txt'), 'top');
    // `via` doesn't exist when the module is built, so the inner root isn't inside the outer one then.
    const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
      { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize },
      { name: 'inner', path: join(root, 'via', 'child'), mode: 'read-write', watch: 'never' },
    ]);
    symlinkSync(outerDir, join(root, 'via'));
    mkdirSync(join(outerDir, 'child'));
    writeFileSync(join(outerDir, 'child', 'x.txt'), "the inner mount's");
    const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });

    const synced = await call('sync', { mount: 'outer' });
    assert.equal(synced.success, true, String(synced.error));
    assert.doesNotMatch(JSON.stringify((synced.data as { results: unknown[] }).results), /"synced":\[[^\]]*child\/x\.txt/, 'not taken in');
    // The outer mount's tools refuse the path, naming the inner mount, as they
    // do for a nesting found when the module was built. Without a materialize
    // after the write, only that refusal can keep the write out of the outer
    // mount's tree.
    const written = await call('write', { path: 'outer/child/y.txt', content: 'an outer write' });
    assert.equal(written.success, false, JSON.stringify(written));
    assert.match(String(written.error), /"outer\/child\/y\.txt" is inside mount "inner", which is nested in "outer" at child\/: use "inner\/y\.txt"/);
    const owed = await call('materialize', {});
    assert.doesNotMatch(JSON.stringify(owed), /child\/y\.txt/, 'the outer mount holds nothing at that path');
    assert.throws(() => readFileSync(join(outerDir, 'child', 'y.txt')), "nothing was written into the inner mount's directory");
    // The disk readers refuse it by its name, and through an alias, which
    // only the check of the path disk opens can see.
    symlinkSync(join(outerDir, 'child'), join(outerDir, 'alias'));
    await assert.rejects(workspace.readFileFromDisk('outer/child/x.txt'), /"outer\/child\/x\.txt" is inside mount "inner", which is nested in "outer" at child\/: use "inner\/x\.txt"/);
    await assert.rejects(workspace.readFileFromDisk('outer/alias/x.txt'), /"outer\/alias\/x\.txt" is inside mount "inner", which is nested in "outer": use "inner\/x\.txt"/);
    const raw = await workspace.readBinaryFromDisk('outer/alias/x.txt');
    assert.ok('error' in raw && /"outer\/alias\/x\.txt" is inside mount "inner"/.test(raw.error), JSON.stringify(raw));
  });
}

test("a path named with '.' segments is read as its one spelling, and the ignore note says so", async (t) => {
  const { workspace } = workspaceWith(t, ['node_modules/pkg.js', 'top.txt'], 'inner', ['node_modules']);
  const result = await workspace.handleToolCall({ id: 'sync-dot', name: 'sync', input: { path: 'outer/./node_modules//pkg.js' } });
  assert.equal(result.success, true, String(result.error));
  const data = result.data as { results: Array<{ synced: string[] }>; ignored?: Array<{ path: string }> };
  assert.deepEqual(data.results.flatMap((r) => r.synced), ['node_modules/pkg.js']);
  assert.deepEqual(data.ignored?.map((i) => i.path), ['node_modules/pkg.js']);
});
