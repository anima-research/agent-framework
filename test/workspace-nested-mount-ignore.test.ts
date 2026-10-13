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
 * #282 checks nesting at tool admission, at the store mutation, and at
 * disk effects. An intervening disk change can leave an outer draft whose
 * later materialize is refused. Existing components use disk spelling;
 * unmade components follow the documented platform-default case rule.
 *
 * Driven through the public tools, and a real watcher, over tmpdir mounts.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, parse, sep, win32 } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { nestedSuffix, readPath } from '../src/modules/workspace/observe.js';
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
  const at = (outer: string, inner: string) => nestedSuffix({ real: outer }, { real: inner }, win32);
  assert.equal(at('C:\\w\\outer', 'C:\\w\\outer\\a\\b'), 'a/b');
  assert.equal(at('C:\\w\\outer', 'D:\\w\\outer\\a'), null, 'another drive is another root');
  assert.equal(at('C:\\w\\outer', 'C:\\w'), null);
  assert.equal(at('C:\\w\\outer', 'C:\\w\\side'), null);
  assert.equal(at('C:\\w\\outer', 'C:\\w\\outer'), '', 'the root itself: inside, but nothing nests there');
  assert.equal(at('C:\\w\\outer', 'C:\\w\\outer\\..cache'), '..cache');
  assert.equal(nestedSuffix({ real: '/w/outer' }, { real: '/w/outer/..cache/x' }), '..cache/x');
  // Windows' default: case is ignored only where a component isn't made yet
  // (`missingFrom` counts components after the drive root).
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    assert.equal(nestedSuffix({ real: 'C:\\w\\Inner', missingFrom: 1 }, { real: 'C:\\w\\inner\\x' }, win32), 'x');
    assert.equal(nestedSuffix({ real: 'C:\\w\\Inner' }, { real: 'C:\\w\\inner\\x' }, win32), null, 'both made: compared exactly');
  } finally { Object.defineProperty(process, 'platform', platform); }
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

/** Whether a mount's store holds an entry at a mount-relative path. */
function storeHolds(workspace: WorkspaceModule, mount: string, rel: string): boolean {
  const internals = workspace as unknown as { mounts: Map<string, { treeStateId: string }>; getStore(): { treeGet(id: string, rel: string): unknown } };
  return internals.getStore().treeGet(internals.mounts.get(mount)!.treeStateId, rel) != null;
}

/** A started workspace on a store at `storePath`; `stops` stops it at the end, if nothing has. */
async function started(stops: Array<() => Promise<void>>, storePath: string, mounts: MountConfig[], pushEvent: (event: unknown) => void = () => {}) {
  const store = JsStore.openOrCreate({ path: storePath });
  const warn = console.warn;
  console.warn = () => {};
  let workspace: WorkspaceModule;
  try { workspace = new WorkspaceModule({ mounts }); } finally { console.warn = warn; }
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent } as unknown as ModuleContext);
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
  assert.match(JSON.stringify(dropped.data), /stopped tracking/i);
  assert.equal(readFileSync(join(outerDir, 'a', 'b', 'x.txt'), 'utf8'), "the inner mount's");
  const again = await call('delete', { path: 'outer/a/b/x.txt' });
  assert.equal(again.success, false);
  assert.equal(again.error, '"outer/a/b/x.txt" is inside mount "inner", which is nested in "outer" at a/b/, and "outer" doesn\'t hold it: use "inner/x.txt"');
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
  // The write is refused at the tool, as disk spells the path, so the outer
  // mount's store never holds a draft there.
  const written = await call('write', { path: 'outer/alias/y.txt', content: 'through the alias' });
  assert.equal(written.success, false);
  assert.match(String(written.error), /"outer\/alias\/y\.txt" is inside mount "inner", which is nested in "outer": use "inner\/y\.txt"/);
  assert.throws(() => readFileSync(join(outerDir, 'a', 'b', 'y.txt')), "nothing was written into the inner mount's directory");
});

test("a write or an edit through an alias into a nested mount is refused at the tool, with nothing to materialize", async (t) => {
  // autoMaterialize off: nothing would reach disk to refuse it later, so the
  // tool itself reads where the path leads.
  const { root, stops } = scratch(t, 'af-nested-mount-alias-draft-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  writeFileSync(join(outerDir, 'a', 'b', 'x.txt'), "the inner mount's");
  symlinkSync(join(outerDir, 'a', 'b'), join(outerDir, 'alias'));
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize: false },
    { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  const written = await call('write', { path: 'outer/alias/y.txt', content: 'through the alias' });
  assert.equal(written.success, false);
  assert.match(String(written.error), /"outer\/alias\/y\.txt" is inside mount "inner", which is nested in "outer": use "inner\/y\.txt"/);
  const edited = await call('edit', { path: 'outer/alias/x.txt', oldString: 'inner', newString: 'outer' });
  assert.equal(edited.success, false);
  assert.match(String(edited.error), /"outer\/alias\/x\.txt" is inside mount "inner", which is nested in "outer": use "inner\/x\.txt"/);
  // Several parts that don't exist yet are joined in order.
  const deep = await call('write', { path: 'outer/alias/new/deep/f.txt', content: 'deep' });
  assert.match(String(deep.error), /"outer\/alias\/new\/deep\/f\.txt" is inside mount "inner", which is nested in "outer": use "inner\/new\/deep\/f\.txt"/);
  const binary = await workspace.writeBinary('outer/alias/z.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
  assert.equal(binary.success, false);
  assert.match(String(binary.error), /"outer\/alias\/z\.bin" is inside mount "inner", which is nested in "outer": use "inner\/z\.bin"/);
  for (const rel of ['alias/y.txt', 'alias/x.txt', 'alias/new/deep/f.txt', 'alias/z.bin']) {
    assert.equal(storeHolds(workspace, 'outer', rel), false, `the outer mount's store holds nothing at ${rel}`);
  }
  assert.equal(readFileSync(join(outerDir, 'a', 'b', 'x.txt'), 'utf8'), "the inner mount's");
});

for (const op of ['write', 'edit', 'writeBinary', 'delete'] as const) {
  test(`${op === 'edit' ? 'an' : 'a'} ${op} that waits for the mount's turn is judged on the path as it is when its turn comes: a nesting made meanwhile is refused`, async (t) => {
    // The check that counts runs in the mount's turn, after the last await,
    // beside the store change, so a path that came to lie in a nested mount
    // while the call waited changes nothing in the outer mount's store.
    const { root, stops } = scratch(t, `af-nested-mount-queued-${op}-`);
    const outerDir = join(root, 'outer');
    const innerDir = join(outerDir, 'inner');
    mkdirSync(innerDir, { recursive: true });
    mkdirSync(join(outerDir, 'alias'));
    writeFileSync(join(innerDir, 'x.txt'), 'inner original');
    const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
      { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize: false },
      { name: 'inner', path: innerDir, mode: 'read-write', watch: 'never' },
    ]);
    const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
    if (op === 'edit') {
      const drafted = await call('write', { path: 'outer/alias/x.txt', content: 'old draft' });
      assert.equal(drafted.success, true, String(drafted.error));
    }
    const internals = workspace as unknown as { mounts: Map<string, unknown>; withMount(m: unknown, f: () => Promise<void>): Promise<void> };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inTurn = new Promise<void>((resolve) => { entered = resolve; });
    const held = internals.withMount(internals.mounts.get('outer'), async () => { entered(); await gate; });
    await inTurn;
    const pending = op === 'writeBinary'
      ? workspace.writeBinary('outer/alias/x.txt', Buffer.from('binary draft'), 'application/octet-stream')
      : op === 'write'
        ? call('write', { path: 'outer/alias/x.txt', content: 'new draft' })
        : op === 'edit'
          ? call('edit', { path: 'outer/alias/x.txt', oldString: 'old', newString: 'new' })
          : call('delete', { path: 'outer/alias/y.txt' });
    rmSync(join(outerDir, 'alias'), { recursive: true });
    symlinkSync(innerDir, join(outerDir, 'alias'));
    release();
    await held;
    const result = await pending;
    assert.equal(result.success, false, JSON.stringify(result));
    assert.match(String(result.error), /is inside mount "inner", which is nested in "outer"/);
    if (op === 'edit') {
      const internals2 = workspace as unknown as { mounts: Map<string, { treeStateId: string }>; getStore(): { treeGet(id: string, rel: string): { blobHash: string } | null; getBlob(hash: string): Buffer | null } };
      const kept = internals2.getStore().treeGet(internals2.mounts.get('outer')!.treeStateId, 'alias/x.txt');
      assert.equal(kept && internals2.getStore().getBlob(kept.blobHash)?.toString(), 'old draft', 'the old copy is as it was');
    } else {
      assert.equal(storeHolds(workspace, 'outer', op === 'delete' ? 'alias/y.txt' : 'alias/x.txt'), false, "nothing reaches the outer mount's store");
    }
    assert.equal(readFileSync(join(innerDir, 'x.txt'), 'utf8'), 'inner original');
  });
}

test("a write through a dangling link into a nested mount is refused at the tool, for a file link and a directory link", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-dangling-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  // Neither target exists yet: the links lead to nothing so far.
  symlinkSync(join(outerDir, 'a', 'b', 'later.txt'), join(outerDir, 'flink'));
  symlinkSync(join(outerDir, 'a', 'b', 'newdir'), join(outerDir, 'dlink'));
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize: false },
    { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  const file = await call('write', { path: 'outer/flink', content: 'through a dangling link' });
  assert.match(String(file.error), /"outer\/flink" is inside mount "inner", which is nested in "outer": use "inner\/later\.txt"/);
  const dir = await call('write', { path: 'outer/dlink/f.txt', content: 'through a dangling directory link' });
  assert.match(String(dir.error), /"outer\/dlink\/f\.txt" is inside mount "inner", which is nested in "outer": use "inner\/newdir\/f\.txt"/);
  assert.equal(storeHolds(workspace, 'outer', 'flink'), false);
  assert.equal(storeHolds(workspace, 'outer', 'dlink/f.txt'), false);
});

test("a delete through a link into a nested mount stops tracking an old copy and touches nothing on disk, and is refused otherwise", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-delete-alias-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  mkdirSync(join(outerDir, 'moved'));
  writeFileSync(join(outerDir, 'a', 'b', 'z.txt'), "the inner mount's");
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize: false },
    { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  // An old copy: written while `moved` was the outer mount's own directory,
  // which then became a link into the nested mount.
  const drafted = await call('write', { path: 'outer/moved/z.txt', content: 'an old copy' });
  assert.equal(drafted.success, true, String(drafted.error));
  rmSync(join(outerDir, 'moved'), { recursive: true });
  symlinkSync(join(outerDir, 'a', 'b'), join(outerDir, 'moved'));
  const forgotten = await call('delete', { path: 'outer/moved/z.txt' });
  assert.equal(forgotten.success, true, String(forgotten.error));
  assert.match(JSON.stringify(forgotten.data), /stopped tracking/i);
  assert.equal(storeHolds(workspace, 'outer', 'moved/z.txt'), false);
  assert.equal(readFileSync(join(outerDir, 'a', 'b', 'z.txt'), 'utf8'), "the inner mount's", 'disk is untouched');
  // With no old copy, the delete is refused, naming the inner mount.
  const refused = await call('delete', { path: 'outer/moved/z.txt' });
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /"outer\/moved\/z\.txt" is inside mount "inner", which is nested in "outer", and "outer" doesn't hold it: use "inner\/z\.txt"/);
  assert.equal(readFileSync(join(outerDir, 'a', 'b', 'z.txt'), 'utf8'), "the inner mount's");
});

test("read_image under the mount's size limit refuses a link out of the mount, or into a nested one, as such", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-image-limit-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  writeFileSync(join(outerDir, 'a', 'b', 'i.png'), ONE_PIXEL_PNG);
  writeFileSync(join(root, 'outside.png'), ONE_PIXEL_PNG);
  symlinkSync(join(outerDir, 'a', 'b'), join(outerDir, 'alias'));
  symlinkSync(join(root, 'outside.png'), join(outerDir, 'out.png'));
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, maxFileSize: 10 },
    { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const image = (path: string) => workspace.handleToolCall({ id: path, name: 'read_image', input: { path } });
  const nested = await image('outer/alias/i.png');
  assert.match(String(nested.error), /"outer\/alias\/i\.png" is inside mount "inner", which is nested in "outer": use "inner\/i\.png"/);
  const out = await image('outer/out.png');
  assert.match(String(out.error), /Symlink escape detected: outer\/out\.png/);
});

test("a case variant of a nested path is refused at the tool where the disk ignores case", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-mount-case-');
  const outerDir = join(root, 'outer');
  mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
  // Where the disk tells case apart, `A/B` would be a directory of the outer
  // mount's own, so there's nothing to refuse.
  const ignoresCase = existsSync(join(outerDir, 'A', 'B'));
  if (!ignoresCase) mkdirSync(join(outerDir, 'A', 'B'), { recursive: true });
  const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
    { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', autoMaterialize: false },
    { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const written = await workspace.handleToolCall({ id: 'write', name: 'write', input: { path: 'outer/A/B/y.txt', content: 'a case variant' } });
  assert.equal(written.success, !ignoresCase, JSON.stringify(written));
  if (ignoresCase) assert.match(String(written.error), /"outer\/A\/B\/y\.txt" is inside mount "inner", which is nested in "outer": use "inner\/y\.txt"/);
  assert.equal(storeHolds(workspace, 'outer', 'A/B/y.txt'), !ignoresCase);
});

for (const autoMaterialize of [false, true]) {
  test(`a write through a file link into a nested mount is refused when it would reach disk, and the inner mount's file is untouched (autoMaterialize ${autoMaterialize})`, async (t) => {
    // The outer mount holds a copy of flink.txt from before the path became a
    // link into the nested mount: a draft with autoMaterialize off, and with
    // it on, the file the write made on disk, which the link then replaces.
    // Nothing refuses the copy at the tool: only the write to disk, which
    // follows the link, finds where it now leads.
    const { root, stops } = scratch(t, 'af-nested-mount-file-link-');
    const outerDir = join(root, 'outer');
    mkdirSync(join(outerDir, 'a', 'b'), { recursive: true });
    writeFileSync(join(outerDir, 'a', 'b', 'x.txt'), "the inner mount's");
    const { workspace } = await started(stops, join(root, 'workspace.chronicle'), [
      { name: 'outer', path: outerDir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize },
      { name: 'inner', path: join(outerDir, 'a', 'b'), mode: 'read-write', watch: 'never' },
    ]);
    const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
    const drafted = await call('write', { path: 'outer/flink.txt', content: 'outer wrote' });
    assert.equal(drafted.success, true, String(drafted.error));
    if (existsSync(join(outerDir, 'flink.txt'))) rmSync(join(outerDir, 'flink.txt'));
    symlinkSync(join(outerDir, 'a', 'b', 'x.txt'), join(outerDir, 'flink.txt'));
    const forced = await call('materialize', { path: 'outer/flink.txt', force: true });
    assert.match(JSON.stringify(forced), /flink\.txt: inside mount \\"inner\\", which is nested in this one; delete it here to stop tracking it/, JSON.stringify(forced));
    assert.equal(readFileSync(join(outerDir, 'a', 'b', 'x.txt'), 'utf8'), "the inner mount's", "the inner mount's file is as it was");
  });
}

test("the located read refuses a file it opens through a link into a nested mount, as the walk's observation does", async (t) => {
  // A pass observes a path before it reads it, and the observation refuses a
  // link into a nested mount. The read checks the file it actually opened
  // again, as it checks that the file is in the mount at all, so a link
  // swapped in between the two reaches nothing either. Called directly here,
  // as a pass calls it after its observation.
  const { root } = scratch(t, 'af-nested-mount-located-read-');
  const outerDir = join(root, 'outer');
  const innerDir = join(outerDir, 'a', 'b');
  mkdirSync(innerDir, { recursive: true });
  writeFileSync(join(innerDir, 'x.txt'), "the inner mount's");
  symlinkSync(join(innerDir, 'x.txt'), join(outerDir, 'flink.txt'));
  const view = { root: outerDir, followSymlinks: true, maxFileSize: 1 << 20, ignore: [], nested: [{ name: 'inner', real: realpathSync(innerDir) }] };
  assert.deepEqual(await readPath(view, realpathSync(outerDir), 'flink.txt', 1 << 20),
    { kind: 'unobserved', reason: 'inside mount "inner", which is nested in this one' });
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
  // Under a size limit, a file the boundary refuses is refused as such, and
  // its size isn't told.
  assert.deepEqual(await workspace.readBinaryFromDisk('outer/out-link.txt', { maxBytes: 3 }),
    { error: 'Symlink escape detected: outer/out-link.txt' });
  const nestedCapped = await workspace.readBinaryFromDisk('outer/alias/x.txt', { maxBytes: 3 });
  assert.ok('error' in nestedCapped);
  assert.match(nestedCapped.error, naming);
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
    const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
    // A first call reads the roots before the nesting exists, so the calls
    // after it must read them again.
    const before = await call('sync', { mount: 'outer' });
    assert.equal(before.success, true, String(before.error));
    symlinkSync(outerDir, join(root, 'via'));
    mkdirSync(join(outerDir, 'child'));
    writeFileSync(join(outerDir, 'child', 'x.txt'), "the inner mount's");

    // The first call after the nesting appears is a write: the outer mount's
    // tools refuse the path, naming the inner mount, as they do for a nesting
    // found when the module was built. Without a materialize after the write,
    // only that refusal can keep the write out of the outer mount's tree.
    const written = await call('write', { path: 'outer/child/y.txt', content: 'an outer write' });
    assert.equal(written.success, false, JSON.stringify(written));
    assert.match(String(written.error), /"outer\/child\/y\.txt" is inside mount "inner", which is nested in "outer" at child\/: use "inner\/y\.txt"/);
    assert.equal(storeHolds(workspace, 'outer', 'child/y.txt'), false);
    const synced = await call('sync', { mount: 'outer' });
    assert.equal(synced.success, true, String(synced.error));
    assert.doesNotMatch(JSON.stringify((synced.data as { results: unknown[] }).results), /"synced":\[[^\]]*child\/x\.txt/, 'not taken in');
    // No ignore rule names it, since the nesting came about after the module
    // was built; the walk passes over it all the same, rather than listing
    // files it would refuse one by one.
    assert.deepEqual((synced.data as { passedOver?: unknown }).passedOver, [{ mount: 'outer', reason: 'ignored by the mount', count: 1 }]);
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

test('#282 round: path-less materialize reports an aliased nested copy as skipped', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-round-materialize-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'inner'), { recursive: true });
  mkdirSync(join(outer, 'alias'));
  writeFileSync(join(outer, 'inner', 'x.txt'), 'inner bytes');
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', autoMaterialize: false, followSymlinks: true },
    { name: 'inner', path: join(outer, 'inner'), mode: 'read-write', watch: 'never' },
  ]);
  const write = await workspace.handleToolCall({ id: 'write', name: 'write', input: { path: 'outer/alias/x.txt', content: 'old draft' } });
  assert.equal(write.success, true);
  rmSync(join(outer, 'alias'), { recursive: true });
  symlinkSync(join(outer, 'inner'), join(outer, 'alias'));
  const result = await workspace.handleToolCall({ id: 'push', name: 'materialize', input: { mount: 'outer' } });
  assert.match(JSON.stringify(result.data), /alias\/x.txt: inside mount \\"inner\\", which is nested in this one; delete it here to stop tracking it/);
  assert.equal(readFileSync(join(outer, 'inner', 'x.txt'), 'utf8'), 'inner bytes');
});

for (const destination of ['outside', 'inner'] as const) {
  test(`#282 round: a directory link to ${destination} is refused by its boundary, not its kind`, async (t) => {
    const { root, stops } = scratch(t, 'af-nested-round-directory-');
    const outer = join(root, 'outer');
    mkdirSync(join(outer, 'inner'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    symlinkSync(destination === 'inner' ? join(outer, 'inner') : join(root, 'outside'), join(outer, 'link'));
    const { workspace } = await started(stops, join(root, 'store'), [
      { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'inner', path: join(outer, 'inner'), mode: 'read-write', watch: 'never' },
    ]);
    await assert.rejects(workspace.readFileFromDisk('outer/link'),
      destination === 'inner'
        ? /"outer\/link" is inside mount "inner", which is nested in "outer": use "inner"$/
        : /Symlink escape detected: outer\/link$/);
  });
}

test('#282 round: every nested lookup names the innermost mount', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-round-deep-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'mid', 'deep'), { recursive: true });
  writeFileSync(join(outer, 'mid', 'deep', 'x.txt'), 'inner bytes');
  symlinkSync(join(outer, 'mid', 'deep'), join(outer, 'alias'));
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'mid', path: join(outer, 'mid'), mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(outer, 'mid', 'deep'), mode: 'read-write', watch: 'never' },
  ]);
  const lexical = await workspace.handleToolCall({ id: 'l', name: 'write', input: { path: 'outer/mid/deep/new.txt', content: 'draft' } });
  assert.equal(lexical.error, 'Error: "outer/mid/deep/new.txt" is inside mount "inner", which is nested in "outer" at mid/deep/: use "inner/new.txt"');
  const alias = await workspace.handleToolCall({ id: 'a', name: 'write', input: { path: 'outer/alias/new.txt', content: 'draft' } });
  assert.equal(alias.error, '"outer/alias/new.txt" is inside mount "inner", which is nested in "outer": use "inner/new.txt"');
  await assert.rejects(workspace.readFileFromDisk('outer/alias/x.txt'),
    /"outer\/alias\/x.txt" is inside mount "inner", which is nested in "outer": use "inner\/x.txt"$/);
});

test('#282 round: root-level disk-spelled write and delete refusals name the mount without a slash', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-round-root-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'a', 'b'), { recursive: true });
  symlinkSync(join(outer, 'a'), join(outer, 'via'));
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'inner', path: join(outer, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const write = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/via/b', content: 'draft' } });
  assert.equal(write.error, '"outer/via/b" is inside mount "inner", which is nested in "outer": use "inner"');
  const deleted = await workspace.handleToolCall({ id: 'd', name: 'delete', input: { path: 'outer/via/b' } });
  assert.equal(deleted.error, '"outer/via/b" is inside mount "inner", which is nested in "outer", and "outer" doesn\'t hold it: use "inner"');
});

test('#282 round: the insensitive default covers an unmade nested root without changing existing spelling', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-round-default-case-');
  const outer = join(root, 'outer');
  mkdirSync(outer);
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', autoMaterialize: false },
    { name: 'inner', path: join(outer, 'Child'), mode: 'read-write', watch: 'never' },
  ]);
  // This exercises the chosen platform policy on a real local directory.
  // It is not a stand-in for a case-insensitive filesystem integration run.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/child/x.txt', content: 'draft' } });
    assert.equal(result.success, false);
    assert.match(String(result.error), /use "inner\/x.txt"/);
    assert.equal(storeHolds(workspace, 'outer', 'child/x.txt'), false);
    assert.equal(existsSync(join(outer, 'Child')), false);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('#282 round: a case-variant nested delete finds the stored disk spelling', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-round-delete-case-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'a', 'b'), { recursive: true });
  if (!existsSync(join(outer, 'A', 'B'))) { t.skip('requires a case-insensitive directory'); return; }
  writeFileSync(join(outer, 'a', 'b', 'File.txt'), 'inner bytes');
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(outer, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const store = (workspace as unknown as { getStore(): JsStore }).getStore();
  const blobHash = store.storeBlob(Buffer.from('old copy'), 'text/plain');
  store.treeSet('workspace/outer/tree', 'a/b/File.txt', { blobHash, size: 8, mode: 0o644 });
  const result = await workspace.handleToolCall({ id: 'd', name: 'delete', input: { path: 'outer/A/B/file.txt' } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(storeHolds(workspace, 'outer', 'a/b/File.txt'), false);
  assert.equal(readFileSync(join(outer, 'a', 'b', 'File.txt'), 'utf8'), 'inner bytes');
});

test('#282 round: a nested delete reached by alias finds a copy stored under its disk spelling', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-round-stored-spelling-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'a', 'b'), { recursive: true });
  writeFileSync(join(outer, 'a', 'b', 'x.txt'), 'inner bytes');
  symlinkSync(join(outer, 'a', 'b'), join(outer, 'via'));
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'inner', path: join(outer, 'a', 'b'), mode: 'read-write', watch: 'never' },
  ]);
  const store = (workspace as unknown as { getStore(): JsStore }).getStore();
  const blobHash = store.storeBlob(Buffer.from('old copy'), 'text/plain');
  store.treeSet('workspace/outer/tree', 'a/b/x.txt', { blobHash, size: 8, mode: 0o644 });
  const readDir = fs.readdirSync;
  try {
    fs.readdirSync = (() => { throw Object.assign(new Error('directory unavailable'), { code: 'EIO' }); }) as typeof readDir;
    syncBuiltinESMExports();
    const result = await workspace.handleToolCall({ id: 'unavailable', name: 'delete', input: { path: 'outer/via/x.txt' } });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(storeHolds(workspace, 'outer', 'a/b/x.txt'), false);
    assert.equal((result.data as { note: string }).note,
      'Stopped tracking "outer/a/b/x.txt". The file or link on disk, if any, was left untouched.');
  } finally { fs.readdirSync = readDir; syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(outer, 'a', 'b', 'x.txt'), 'utf8'), 'inner bytes');
});

test('#282 round: boundary refusal precedes opening a directory', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-round-open-boundary-');
  const outer = join(root, 'outer');
  mkdirSync(outer);
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(outer, 'own.txt'), 'owned');
  symlinkSync(join(root, 'outside'), join(outer, 'link'));
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true },
  ]);
  const original = fsPromises.open;
  let opens = 0;
  try {
    fsPromises.open = (async (...args: Parameters<typeof original>) => {
      opens++;
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    assert.equal((await workspace.readFileFromDisk('outer/own.txt')).bytes.toString(), 'owned');
    assert.equal(opens, 1, 'the counter observes this reader');
    await assert.rejects(workspace.readFileFromDisk('outer/link'), /Symlink escape detected/);
    assert.equal(opens, 1, 'a platform that refuses opening directories still receives the boundary answer');
  } finally {
    fsPromises.open = original;
    syncBuiltinESMExports();
  }
});

async function secondPassRig(t: TestContext, autoMaterialize = false, maxFileSize?: number) {
  const { root, stops } = scratch(t, 'af-nested-pass2-');
  const outer = join(root, 'outer');
  const inner = join(outer, 'inner');
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, 'x.txt'), 'inner bytes');
  const events: unknown[] = [];
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize, maxFileSize },
    { name: 'inner', path: inner, mode: 'read-write', watch: 'never' },
  ], (event) => { events.push(event); });
  const state = workspace as unknown as {
    getStore(): JsStore;
    intents: Map<string, import('../src/modules/workspace/branch-intent.js').BranchIntents>;
    agreementOrThrow(): import('../src/modules/workspace/disk-agreement.js').DiskAgreement;
  };
  const store = state.getStore();
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  const seedCopy = (path: string) => {
    const blobHash = store.storeBlob(Buffer.from('old copy'), 'text/plain');
    store.treeSet('workspace/outer/tree', path, { blobHash, size: 8, mode: 0o644 });
    return blobHash;
  };
  return { root, stops, outer, inner, workspace, state, store, call, seedCopy, events };
}

for (const kind of ['lexical', 'parent-alias', 'final-link'] as const) {
  for (const force of [false, true]) for (const applyDeletions of [false, true]) {
    test(`a legacy ${kind} pending deletion stops tracking once (force ${force}, applyDeletions ${applyDeletions})`, async (t) => {
      const r = await secondPassRig(t);
      const path = kind === 'lexical' ? 'inner/x.txt' : kind === 'parent-alias' ? 'via/x.txt' : 'link';
      if (kind === 'parent-alias') symlinkSync(r.inner, join(r.outer, 'via'));
      if (kind === 'final-link') symlinkSync(join(r.inner, 'x.txt'), join(r.outer, 'link'));
      // A deletion recorded before this path became nested, or by an older
      // version. Its tree entry is gone but intent and agreement remain.
      const hash = r.store.storeBlob(Buffer.from('old copy'), 'text/plain');
      r.state.intents.get('outer')!.put(path, { tombstone: { hash } });
      r.state.agreementOrThrow().set('outer', path, { kind: 'content', hash, size: 8 });
      const result = await r.call('materialize', { mount: 'outer', force, applyDeletions });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.data), /stopped tracking.*disk.*untouched/i);
      assert.doesNotMatch(JSON.stringify(result.data), /delete it here|applyDeletions to remove/);
      assert.equal(r.state.intents.get('outer')!.get(path), null);
      assert.equal(r.state.agreementOrThrow().get('outer', path), undefined);
      assert.equal(readFileSync(join(r.inner, 'x.txt'), 'utf8'), 'inner bytes');
      const again = await r.call('materialize', { mount: 'outer', force, applyDeletions });
      assert.doesNotMatch(JSON.stringify(again), /stopped tracking|delete it here|workspaceDeletionsLeftOnDisk/i);
    });
  }
}

for (const autoMaterialize of [false, true]) {
  test(`delete of an outer link stops tracking instead of leaving an impossible unlink (autoMaterialize ${autoMaterialize})`, async (t) => {
    const r = await secondPassRig(t, autoMaterialize);
    assert.equal((await r.call('write', { path: 'outer/link', content: 'old copy' })).success, true);
    rmSync(join(r.outer, 'link'), { force: true });
    symlinkSync(join(r.inner, 'x.txt'), join(r.outer, 'link'));
    const result = await r.call('delete', { path: 'outer/link' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.match(JSON.stringify(result.data), /stopped tracking.*link.*disk.*untouched/i);
    assert.equal(storeHolds(r.workspace, 'outer', 'link'), false);
    assert.equal(r.state.intents.get('outer')!.get('link'), null);
    assert.equal(r.state.agreementOrThrow().get('outer', 'link'), undefined);
    assert.equal(fs.lstatSync(join(r.outer, 'link')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(r.inner, 'x.txt'), 'utf8'), 'inner bytes');
    for (const force of [false, true]) for (const applyDeletions of [false, true]) {
      const later = await r.call('materialize', { mount: 'outer', force, applyDeletions });
      assert.doesNotMatch(JSON.stringify(later), /link|workspaceDeletionsLeftOnDisk/);
    }
  });
}

test('a Darwin-policy constructor preserves an unmade root in its ignore rule', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-pass2-ignore-');
  const outer = join(root, 'outer');
  mkdirSync(outer);
  writeFileSync(join(outer, 'top.txt'), 'top');
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  let workspace: WorkspaceModule | undefined;
  stops.push(async () => { await workspace?.stop(); if (!store.isClosed()) store.close(); });
  const config: MountConfig = { name: 'outer', path: outer, mode: 'read-write', watch: 'never' };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    workspace = new WorkspaceModule({ mounts: [config,
      { name: 'inner', path: join(outer, 'CamelChild'), mode: 'read-write', watch: 'never' }] });
    workspace.initStore(store);
    await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    assert.deepEqual(config.ignore, ['CamelChild/**']);
    const denied = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/camelchild/new.txt', content: 'draft' } });
    assert.equal(denied.success, false);
    mkdirSync(join(outer, 'CamelChild'));
    writeFileSync(join(outer, 'CamelChild', 'x.txt'), 'inner');
    assert.deepEqual(await syncedByOuter(workspace), ['top.txt']);
    const synced = await workspace.handleToolCall({ id: 's', name: 'sync', input: { mount: 'outer' } });
    assert.deepEqual((synced.data as { passedOver: unknown }).passedOver, [{ mount: 'outer', reason: 'ignored by the mount', count: 1 }]);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('existing case-distinct paths retain their spelling under the Darwin policy', async (t) => {
  const r = await secondPassRig(t);
  if (existsSync(join(r.outer, 'INNER'))) { t.skip('requires a case-sensitive directory for the control'); return; }
  mkdirSync(join(r.outer, 'INNER'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await r.call('write', { path: 'outer/INNER/KeepCase.txt', content: 'owned' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(storeHolds(r.workspace, 'outer', 'INNER/KeepCase.txt'), true);
    assert.equal(storeHolds(r.workspace, 'outer', 'inner/keepcase.txt'), false);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('delete recognises a case variant of the nested root itself', async (t) => {
  const r = await secondPassRig(t);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await r.call('delete', { path: 'outer/INNER' });
    assert.equal(result.success, false);
    assert.match(String(result.error), /is inside mount "inner".*use "inner"$/);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('a nested delete refuses before importing or announcing an alias', async (t) => {
  const r = await secondPassRig(t);
  assert.equal((await r.call('write', { path: 'outer/owned.txt', content: 'outer bytes' })).success, true);
  // The old disk-spelling lookup reaches its derived-key assignment only
  // when the entry exists on disk as well as in the outer store.
  writeFileSync(join(r.outer, 'owned.txt'), 'outer bytes');
  symlinkSync(r.outer, join(r.inner, 'back'));
  const result = await r.call('delete', { path: 'outer/inner/back/owned.txt' });
  assert.equal(result.success, false, JSON.stringify({ result, events: r.events }));
  assert.equal(storeHolds(r.workspace, 'outer', 'owned.txt'), true);
  assert.doesNotMatch(JSON.stringify(r.events), /inner\/back\/owned.txt/,
    'a refused nested delete neither imports nor announces a temporary copy');
});

test('a nested delete neither lists the inner directory nor returns its OS errors', async (t) => {
  const r = await secondPassRig(t);
  const readdir = fs.readdirSync;
  let listed = 0;
  try {
    fs.readdirSync = (() => {
      listed++;
      throw Object.assign(new Error('EACCES /private/inner-directory'), { code: 'EACCES' });
    }) as typeof readdir;
    syncBuiltinESMExports();
    const result = await r.call('delete', { path: 'outer/inner/x.txt' });
    assert.equal(result.success, false);
    assert.match(String(result.error), /is inside mount "inner".*doesn't hold it: use "inner\/x.txt"/);
    assert.doesNotMatch(String(result.error), /EACCES|private|Cannot identify/);
    assert.equal(listed, 0);
  } finally { fs.readdirSync = readdir; syncBuiltinESMExports(); }
});

test('a case-folded store match is a hint, not permission to forget that key', async (t) => {
  const r = await secondPassRig(t);
  r.seedCopy('inner/File.txt');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await r.call('delete', { path: 'outer/INNER/file.txt' });
    assert.equal(result.success, false);
    assert.match(String(result.error), /tracked spelling.*outer\/inner\/File.txt/i);
    assert.equal(storeHolds(r.workspace, 'outer', 'inner/File.txt'), true);
    const exact = await r.call('delete', { path: 'outer/inner/File.txt' });
    assert.equal(exact.success, true, JSON.stringify(exact));
    assert.equal(storeHolds(r.workspace, 'outer', 'inner/File.txt'), false);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('untracking a stale nested copy makes no claim that its disk file exists', async (t) => {
  const r = await secondPassRig(t);
  assert.match(r.workspace.getTools().find((tool) => tool.name === 'delete')!.description, /stops tracking.*any disk entry untouched/);
  assert.match(r.workspace.getTools().find((tool) => tool.name === 'materialize')!.description, /Pending deletions blocked by nested-mount ownership stop being tracked/);
  r.seedCopy('inner/missing.txt');
  const result = await r.call('delete', { path: 'outer/inner/missing.txt' });
  assert.equal(result.success, true);
  assert.match(JSON.stringify(result.data), /if any.*untouched/);
  assert.equal(existsSync(join(r.inner, 'missing.txt')), false);
});

test('materialize reads nested roots once for its selection, not per path', async (t) => {
  const r = await secondPassRig(t);
  for (let i = 0; i < 4; i++) assert.equal((await r.call('write', { path: `outer/own-${i}.txt`, content: 'owned' })).success, true);
  const native = fs.realpathSync.native;
  let innerReads = 0;
  try {
    fs.realpathSync.native = ((path: Parameters<typeof native>[0], options?: Parameters<typeof native>[1]) => {
      if (String(path) === r.inner) innerReads++;
      return native(path, options as never);
    }) as typeof native;
    const result = await r.call('materialize', { mount: 'outer' });
    assert.equal(result.success, true, JSON.stringify(result));
    // One snapshot for selection and one for the subsequent disk push.
    assert.equal(innerReads, 2);
  } finally { fs.realpathSync.native = native; }
});

test('a blocked physical push still reports its completed nested-deletion cleanup', async (t) => {
  const r = await secondPassRig(t);
  const path = 'inner/x.txt';
  const hash = r.store.storeBlob(Buffer.from('old copy'), 'text/plain');
  r.state.intents.get('outer')!.put(path, { tombstone: { hash } });
  r.state.agreementOrThrow().set('outer', path, { kind: 'content', hash, size: 8 });
  (r.workspace as unknown as { mountMaterializeBlockReason(): string }).mountMaterializeBlockReason = () => 'test branch barrier';
  const result = await r.call('materialize', { mount: 'outer' });
  assert.equal(result.success, false);
  assert.match(String(result.error), /Stopped tracking.*test branch barrier/);
  assert.equal(r.state.intents.get('outer')!.get(path), null);
  assert.equal(r.state.agreementOrThrow().get('outer', path), undefined);
  const again = await r.call('materialize', { mount: 'outer' });
  assert.doesNotMatch(String(again.error), /Stopped tracking/);
  assert.equal(readFileSync(join(r.inner, 'x.txt'), 'utf8'), 'inner bytes');
});

test('a non-ingested nested alias cannot derive an outer-owned key', async (t) => {
  const r = await secondPassRig(t, false, 4);
  assert.equal((await r.call('write', { path: 'outer/owned.txt', content: 'old' })).success, true);
  // Too large for observation to import under the alias. The old fallback
  // therefore reached its derived key and removed the outer-owned copy.
  writeFileSync(join(r.outer, 'owned.txt'), 'outer bytes above the four-byte cap');
  symlinkSync(r.outer, join(r.inner, 'back'));
  const result = await r.call('delete', { path: 'outer/inner/back/owned.txt' });
  assert.equal(storeHolds(r.workspace, 'outer', 'owned.txt'), true, JSON.stringify(result));
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(readFileSync(join(r.outer, 'owned.txt'), 'utf8'), 'outer bytes above the four-byte cap');
});

test('an ordinary delete rechecks nesting after awaited settlement', async (t) => {
  const r = await secondPassRig(t);
  mkdirSync(join(r.outer, 'moved'));
  writeFileSync(join(r.outer, 'moved', 'x.txt'), 'old');
  assert.equal((await r.call('write', { path: 'outer/moved/x.txt', content: 'old' })).success, true);
  const internals = r.workspace as unknown as { settleBeforeMutation(...args: unknown[]): Promise<void> };
  const settle = internals.settleBeforeMutation.bind(r.workspace);
  internals.settleBeforeMutation = async (...args) => {
    await settle(...args);
    rmSync(join(r.outer, 'moved'), { recursive: true });
    symlinkSync(r.inner, join(r.outer, 'moved'));
  };
  const result = await r.call('delete', { path: 'outer/moved/x.txt' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(r.state.intents.get('outer')!.get('moved/x.txt'), null);
  assert.equal(storeHolds(r.workspace, 'outer', 'moved/x.txt'), false);
  assert.equal(readFileSync(join(r.inner, 'x.txt'), 'utf8'), 'inner bytes');
});

test("a pass's view keeps an unmade nested root's marker: a directory made under another case is passed over, its file refused", async (t) => {
  const { root, stops } = scratch(t, 'af-nested-pass2-view-');
  const outer = join(root, 'outer');
  mkdirSync(outer);
  writeFileSync(join(outer, 'top.txt'), 'top');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const config: MountConfig = { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true };
    const { workspace } = await started(stops, join(root, 'store'), [config,
      { name: 'inner', path: join(outer, 'CamelChild'), mode: 'read-write', watch: 'never' }]);
    assert.deepEqual(config.ignore, ['CamelChild/**']);
    // Made under another case than configured, so the rule doesn't name it.
    // On a case-insensitive disk it would be the inner root; here, a
    // case-sensitive one, the inner root stays unmade and the platform rule
    // still reads this directory as it, from the marker in the pass's view.
    mkdirSync(join(outer, 'camelchild'));
    writeFileSync(join(outer, 'camelchild', 'x.txt'), 'inner');
    symlinkSync(join(outer, 'camelchild', 'x.txt'), join(outer, 'alias.txt'));
    const synced = await workspace.handleToolCall({ id: 's', name: 'sync', input: { mount: 'outer' } });
    assert.equal(synced.success, true, JSON.stringify(synced));
    const data = synced.data as { results: Array<{ synced: string[] }>; passedOver?: unknown };
    assert.deepEqual([...data.results[0]!.synced].sort(), ['top.txt'], JSON.stringify(synced.data));
    assert.deepEqual(data.passedOver, [{ mount: 'outer', reason: 'ignored by the mount', count: 1 }]);
    // A link the walk lists is read through, and its target is refused.
    assert.match(JSON.stringify(synced.data), /alias\.txt[^}]*inside mount \\"inner\\"/);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('failed agreement removal leaves the tracked copy available for retry', async (t) => {
  const r = await secondPassRig(t);
  const hash = r.seedCopy('inner/x.txt');
  const agreement = r.state.agreementOrThrow();
  agreement.set('outer', 'inner/x.txt', { kind: 'content', hash, size: 8 });
  const forget = agreement.forget;
  try {
    agreement.forget = () => { throw new Error('injected agreement failure'); };
    const failed = await r.call('delete', { path: 'outer/inner/x.txt' });
    assert.equal(failed.success, false);
    assert.equal(storeHolds(r.workspace, 'outer', 'inner/x.txt'), true);
    assert.equal(agreement.get('outer', 'inner/x.txt')?.kind, 'content');
  } finally { agreement.forget = forget; }
  assert.equal((await r.call('delete', { path: 'outer/inner/x.txt' })).success, true);
  assert.equal(storeHolds(r.workspace, 'outer', 'inner/x.txt'), false);
  assert.equal(agreement.get('outer', 'inner/x.txt'), undefined);
});

test('policy-only nesting cannot authorize a derived-key removal', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-pass2-derived-policy-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'camel'), { recursive: true });
  if (existsSync(join(outer, 'Camel'))) { t.skip('requires distinct case spellings for this control'); return; }
  writeFileSync(join(outer, 'camel', 'x.txt'), 'outer bytes');
  symlinkSync(join(outer, 'camel'), join(outer, 'via'));
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize: false },
    { name: 'inner', path: join(outer, 'Camel'), mode: 'read-write', watch: 'never' },
  ]);
  const store = (workspace as unknown as { getStore(): JsStore }).getStore();
  const blobHash = store.storeBlob(Buffer.from('outer copy'), 'text/plain');
  store.treeSet('workspace/outer/tree', 'camel/x.txt', { blobHash, size: 10, mode: 0o644 });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await workspace.handleToolCall({ id: 'd', name: 'delete', input: { path: 'outer/via/x.txt' } });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(storeHolds(workspace, 'outer', 'camel/x.txt'), true,
      'folding can refuse the path but cannot select that different exact key to remove');
    // The policy reads `camel` as the unmade `Camel`, so a delete by that key's
    // own name would stop tracking it: the refusal names it, and removes nothing.
    assert.match(String(result.error), /^Tracked spelling: "outer\/camel\/x\.txt"; use that exact path to stop tracking this copy\.$/);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('a tracked spelling whose nested directory differs in case is named, where a delete by it would stop tracking it', async (t) => {
  const r = await secondPassRig(t);
  r.seedCopy('Inner/a.txt');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await r.call('delete', { path: 'outer/inner/a.txt' });
    assert.equal(result.success, false);
    assert.match(String(result.error), /^Tracked spelling: "outer\/Inner\/a\.txt"; use that exact path/);
    assert.equal(storeHolds(r.workspace, 'outer', 'Inner/a.txt'), true, 'a hint removes nothing');
    const exact = await r.call('delete', { path: 'outer/Inner/a.txt' });
    assert.equal(exact.success, true, JSON.stringify(exact));
    assert.equal(storeHolds(r.workspace, 'outer', 'Inner/a.txt'), false);
    assert.equal(readFileSync(join(r.inner, 'x.txt'), 'utf8'), 'inner bytes');
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('a tracked spelling held only as a pending deletion is named too, as the delete it names would find it', async (t) => {
  const r = await secondPassRig(t);
  const hash = r.store.storeBlob(Buffer.from('old copy'), 'text/plain');
  r.state.intents.get('outer')!.put('Inner/a.txt', { tombstone: { hash } });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await r.call('delete', { path: 'outer/inner/a.txt' });
    assert.equal(result.success, false);
    assert.match(String(result.error), /^Tracked spelling: "outer\/Inner\/a\.txt"; use that exact path/);
    const exact = await r.call('delete', { path: 'outer/Inner/a.txt' });
    assert.equal(exact.success, true, JSON.stringify(exact));
    assert.equal(r.state.intents.get('outer')!.get('Inner/a.txt'), null);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test("a case variant that is the outer mount's own directory is never named as a nested copy's spelling", async (t) => {
  const r = await secondPassRig(t);
  if (existsSync(join(r.outer, 'Inner'))) { t.skip('requires distinct case spellings for this control'); return; }
  mkdirSync(join(r.outer, 'Inner'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    // A real directory of its own: known components compare exactly, so it isn't nested.
    assert.equal((await r.call('write', { path: 'outer/Inner/a.txt', content: 'owned' })).success, true);
    const result = await r.call('delete', { path: 'outer/inner/a.txt' });
    assert.equal(result.success, false);
    assert.match(String(result.error), /^"outer\/inner\/a\.txt" is inside mount "inner", which is nested in "outer" at inner\/, and "outer" doesn't hold it: use "inner\/a\.txt"$/);
    assert.equal(storeHolds(r.workspace, 'outer', 'Inner/a.txt'), true);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('a read-only mount can stop tracking an old nested copy, and refuses every other delete', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-pass2-read-only-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'inner'), { recursive: true });
  writeFileSync(join(outer, 'inner', 'x.txt'), 'inner bytes');
  writeFileSync(join(outer, 'top.txt'), 'top');
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-only', watch: 'never' },
    { name: 'inner', path: join(outer, 'inner'), mode: 'read-write', watch: 'never' },
  ]);
  const store = (workspace as unknown as { getStore(): JsStore }).getStore();
  // As a scan before the nesting was honoured took it in.
  store.treeSet('workspace/outer/tree', 'inner/x.txt', { blobHash: store.storeBlob(Buffer.from('old copy'), 'text/plain'), size: 8, mode: 0o644 });
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  const stopped = await call('delete', { path: 'outer/inner/x.txt' });
  assert.equal(stopped.success, true, JSON.stringify(stopped));
  assert.match(JSON.stringify(stopped.data), /Stopped tracking \\"outer\/inner\/x\.txt\\"/);
  assert.equal(storeHolds(workspace, 'outer', 'inner/x.txt'), false);
  assert.equal(readFileSync(join(outer, 'inner', 'x.txt'), 'utf8'), 'inner bytes');
  assert.equal((await call('sync', { mount: 'outer' })).success, true);
  assert.equal(storeHolds(workspace, 'outer', 'top.txt'), true);
  const refused = await call('delete', { path: 'outer/top.txt' });
  assert.equal(refused.success, false);
  assert.equal(refused.error, 'Mount "outer" is read-only');
  assert.equal(storeHolds(workspace, 'outer', 'top.txt'), true);
  // A key it doesn't hold is refused as read-only at once, nested or not (a
  // path in the nested mount, and an outer link into it), reading no root.
  symlinkSync(join(outer, 'inner', 'x.txt'), join(outer, 'link'));
  const native = fs.realpathSync.native;
  let reads = 0;
  try {
    fs.realpathSync.native = ((path: Parameters<typeof native>[0], options?: Parameters<typeof native>[1]) => {
      reads++;
      return native(path, options as never);
    }) as typeof native;
    for (const path of ['outer/inner/x.txt', 'outer/inner/other.txt', 'outer/link']) {
      const unheld = await call('delete', { path });
      assert.equal(unheld.error, 'Mount "outer" is read-only', path);
    }
  } finally { fs.realpathSync.native = native; }
  assert.equal(reads, 0, 'the refusal reads no root from disk');
  assert.equal(readFileSync(join(outer, 'inner', 'x.txt'), 'utf8'), 'inner bytes');
});

test('a read or an edit of a tracked file the mount ignores checks it against disk first, as nothing else keeps it current', async (t) => {
  const { root, stops } = scratch(t, 'af-nested-pass2-ignored-read-');
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'node_modules'), { recursive: true });
  writeFileSync(join(outer, 'node_modules', 'pkg.js'), 'v1');
  const { workspace } = await started(stops, join(root, 'store'), [
    { name: 'outer', path: outer, mode: 'read-write', watch: 'never', ignore: ['node_modules'] },
  ]);
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: name, name, input });
  // Taken in by name, as the old watcher took such files in unasked.
  assert.equal((await call('sync', { path: 'outer/node_modules/pkg.js' })).success, true);
  assert.equal(storeHolds(workspace, 'outer', 'node_modules/pkg.js'), true);
  writeFileSync(join(outer, 'node_modules', 'pkg.js'), 'v2');
  // A sync without a path passes over it, so the workspace copy is still v1.
  assert.equal((await call('sync', { mount: 'outer' })).success, true);
  const read = await call('read', { path: 'outer/node_modules/pkg.js' });
  assert.match(JSON.stringify(read.data), /\\tv2/, JSON.stringify(read));
  writeFileSync(join(outer, 'node_modules', 'pkg.js'), 'v3');
  const edited = await call('edit', { path: 'outer/node_modules/pkg.js', oldString: 'v3', newString: 'v4' });
  assert.equal(edited.success, true, JSON.stringify(edited));
});

test("an untracked outer link into a nested mount is refused as leading into it, not as lying inside it", async (t) => {
  const r = await secondPassRig(t);
  symlinkSync(join(r.inner, 'x.txt'), join(r.outer, 'link'));
  const result = await r.call('delete', { path: 'outer/link' });
  assert.equal(result.success, false);
  assert.equal(result.error, '"outer/link" leads into mount "inner", which is nested in "outer", and "outer" doesn\'t hold it: use "inner/x.txt"');
});
