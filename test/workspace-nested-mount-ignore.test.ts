/**
 * A mount that contains another mount ignores it (agent-framework #280).
 *
 * The constructor's overlap guard adds an ignore rule to the outer mount for
 * the inner mount's directory, and says so ("auto-ignoring to prevent
 * overlap"). It pushed the bare relative path, which the walk's matcher reads
 * only as an entry name: a mount nested two levels deep (`a/b`) was never
 * ignored, so the outer mount synced the inner mount's files too, and a
 * mount nested one level deep (`sub`) also hid every other directory named
 * `sub`. The rule is now `<rel>/**`, which matches that path and what is
 * under it, at any depth, and nothing else.
 *
 * The watcher read none of a mount's patterns: chokidar takes a string as one
 * exact path. It now reads them as the walk does.
 *
 * Driven through the public sync tool, and a real watcher, over tmpdir mounts.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
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
    name: 'outer', path: outerDir, mode: 'read-write', watch: 'always', ignore: ['node_modules', '*.log'],
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
  assert.deepEqual(outer.ignore, ['node_modules', '*.log', 'a/b/**']);

  const seen: FsChange[] = [];
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => { ready = resolve; });
  const watcher = new MountWatcher(outer, (changes) => { seen.push(...changes); }, { onReady: () => ready() });
  watcher.start();
  t.after(async () => {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await isReady;

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
  writeFileSync(join(outerDir, 'later.txt'), 'last');
  const reported = ['pkgs/pkg/index.js', 'a/c/y.txt', 'a/other.txt', 'later.txt'];
  for (let i = 0; i < 200 && !reported.every((path) => seen.some((c) => c.path === path)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const paths = seen.map((c) => c.path).sort();
  for (const path of reported) assert.ok(paths.includes(path), `${path} was seen: ${JSON.stringify(paths)}`);
  assert.deepEqual(paths.filter((p) => p.startsWith('a/b') || p.startsWith('node_modules') || p.endsWith('.log')), [],
    'nothing the mount ignores was reported');
});
