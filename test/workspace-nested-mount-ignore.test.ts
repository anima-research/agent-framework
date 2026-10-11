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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { nestedAt } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import { MountWatcher, type FsChange } from '../src/modules/workspace/watcher.js';

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
  watcher.start();
  t.after(async () => {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });
  // A watcher that never starts, or fails, fails the test rather than hanging it.
  let bound: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([isReady, new Promise((_, reject) => { bound = setTimeout(() => reject(new Error('the watcher was not ready within 10 s')), 10_000); })])
    .finally(() => clearTimeout(bound));

  // Each ignored write has a twin the mount reports, written after it and
  // reported by the same machinery, though not strictly after it: the same
  // directory for the name pattern, and the same depth for the two ignored
  // directories. Each directory has its own watch, and each file's report
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

  // Before the inner mount existed, the outer one took the file in and drafted over it.
  const before = await started(stops, storePath, [outer()]);
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

test("a path named with '.' segments is read as its one spelling, and the ignore note says so", async (t) => {
  const { workspace } = workspaceWith(t, ['node_modules/pkg.js', 'top.txt'], 'inner', ['node_modules']);
  const result = await workspace.handleToolCall({ id: 'sync-dot', name: 'sync', input: { path: 'outer/./node_modules//pkg.js' } });
  assert.equal(result.success, true, String(result.error));
  const data = result.data as { results: Array<{ synced: string[] }>; ignored?: Array<{ path: string }> };
  assert.deepEqual(data.results.flatMap((r) => r.synced), ['node_modules/pkg.js']);
  assert.deepEqual(data.ignored?.map((i) => i.path), ['node_modules/pkg.js']);
});
