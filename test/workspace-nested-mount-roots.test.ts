/**
 * A mount nested in another is that mount's directory wherever disk puts
 * it, not only where the outer mount's paths name it as written. Before, the
 * nested-mount checks read paths and roots lexically, so the outer mount
 * reached the inner one's directory three ways. A root configured through a
 * symlink, or beneath one, wasn't nested at all, and the outer mount took in
 * and read the inner mount's files. On a mount that follows symlinks, a
 * link into the inner mount's directory let the outer mount read, take in,
 * write and unlink the inner mount's files through it. And a write through a
 * link the mount doesn't follow stored a draft no push could write. Each
 * root is now read at each start, awaited, and nested where it really is;
 * every check that resolves a path canonically refuses one in a nested
 * mount's directory; and the file tools refuse such a path before anything
 * is stored. Separately, a mount configured as `./m` now hears its watcher.
 */

import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { checkDir, readPath, type MountView } from '../src/modules/workspace/observe.js';
import { EffectFailed, unlinkContained, writeContained } from '../src/modules/workspace/effects.js';
import { MountWatcher, type FsChange } from '../src/modules/workspace/watcher.js';
import { changesFlow, isProbe } from './helpers/watcher-flow.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-nested-roots-'));
  readonly store: JsStore;

  constructor(t: TestContext) {
    this.store = JsStore.openOrCreate({ path: join(this.root, 'ws.chronicle') });
    t.after(() => {
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  at(rel: string): string {
    return join(this.root, rel);
  }

  write(rel: string, content: string): void {
    mkdirSync(dirname(this.at(rel)), { recursive: true });
    writeFileSync(this.at(rel), content);
  }

  async open(t: TestContext, mounts: MountConfig[]): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    t.after(() => m.stop().catch(() => {}));
    return m;
  }

  /** The paths a mount's tree holds. */
  tree(mount: string): string[] {
    return this.store.treeList(`workspace/${mount}/tree`).map((e: { path: string }) => e.path).sort();
  }
}

function mount(name: string, path: string, extra: Partial<MountConfig> = {}): MountConfig {
  return { name, path, mode: 'read-write', watch: 'never', autoMaterialize: false, ...extra };
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<{ success: boolean; error?: string; data?: any }> {
  return m.handleToolCall({ id: 't', name, input }) as Promise<{ success: boolean; error?: string; data?: any }>;
}

/** The refusal a file tool gives a path that reaches a nested mount's directory through a link the mount follows. */
function leadsInto(path: string, outer: string, inner: string, use: string): string {
  return `"${path}" leads into mount "${inner}", nested in mount "${outer}", which neither reads nor writes it: use "${use}".`;
}

/** Read `path`, the path a refusal named, and check it holds `text`: the named path reaches the file. */
async function readsBack(m: WorkspaceModule, path: string, text: string): Promise<void> {
  const read = await call(m, 'read', { path });
  assert.equal(read.success, true, `${path}: ${read.error}`);
  assert.match(read.data.content, new RegExp(text), path);
}

/** The skipped reason for a path in a materialize's or a sync's result. */
function skippedReason(data: any, path: string): string {
  const entry = ((data.skipped ?? []) as Array<{ path?: string; reason: string }>)
    .find((s) => s.path === path || s.reason.startsWith(`${path}: `));
  assert.ok(entry, `nothing skipped for ${path}: ${JSON.stringify(data)}`);
  return entry.reason;
}

/** Run `fn` with node:fs/promises' `name` replaced by `make(original)`, as the code under test sees it. */
async function withFsp<T>(name: 'lstat' | 'realpath', make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>, fn: () => Promise<T>): Promise<T> {
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
  const original = fsp[name]!;
  fsp[name] = make(original);
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fsp[name] = original;
    syncBuiltinESMExports();
  }
}

describe('a mount root configured through a symlink', () => {
  test('an inner mount configured through a link into the outer mount is nested where the link leads', async (t) => {
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the inner mount's\n");
    symlinkSync(env.at('outer/a/b'), env.at('via'));
    const m = await env.open(t, [mount('outer', env.at('outer')), mount('inner', env.at('via'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.deepEqual(env.tree('outer'), [], "the outer mount took none of the inner mount's files in");
    assert.deepEqual(env.tree('inner'), ['x.txt']);
    const read = await call(m, 'read', { path: 'outer/a/b/x.txt' });
    assert.equal(read.success, false);
    assert.equal(read.error, '"outer/a/b/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
    await readsBack(m, 'inner/x.txt', "the inner mount's");
  });

  test('an inner root configured as a link to a directory not made yet inside the outer mount is nested where the link leads', async (t) => {
    for (const absolute of [false, true]) {
      const env = new Env(t);
      env.write('outer/top.txt', "the outer mount's\n");
      symlinkSync(absolute ? env.at('outer/c/inner-dir') : 'outer/c/inner-dir', env.at('via'));
      const m = await env.open(t, [mount('outer', env.at('outer')), mount('inner', env.at('via'))]);
      // The inner mount's directory is made after the module starts.
      env.write('outer/c/inner-dir/x.txt', "the inner mount's\n");
      assert.equal((await call(m, 'sync', {})).success, true);
      assert.deepEqual(env.tree('outer'), ['top.txt'], `the outer mount took none of the inner mount's files in (absolute target: ${absolute})`);
      const read = await call(m, 'read', { path: 'outer/c/inner-dir/x.txt' });
      assert.equal(read.error, '"outer/c/inner-dir/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
      await readsBack(m, 'inner/x.txt', "the inner mount's");
    }
  });

  test('before its first start, the module nests by configured path alone', async (t) => {
    // The roots are read at start, awaited; until then a call has the
    // nesting the constructor reads from the configured paths.
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the linked inner mount's\n");
    env.write('outer/c/y.txt', "the inner mount's\n");
    symlinkSync(env.at('outer/a/b'), env.at('via'));
    const m = new WorkspaceModule({ mounts: [mount('outer', env.at('outer')), mount('linked', env.at('via')), mount('inner', env.at('outer/c'))] });
    m.initStore(env.store);
    t.after(() => m.stop().catch(() => {}));
    assert.equal(m.resolveAbsolutePath('outer/c/y.txt'), null, 'nested by its configured path');
    assert.equal(m.resolveAbsolutePath('outer/a/b/x.txt'), join(env.at('outer'), 'a/b/x.txt'), 'not yet placed where its root is');
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    assert.equal(m.resolveAbsolutePath('outer/a/b/x.txt'), null, 'placed at start');
  });

  test('a root configured as a link to a link to a place not made yet is placed where that leads, however the target is written', async (t) => {
    // w/L2 leads to made-later, not made yet. The inner mount is configured
    // as w/in, a link to L2 written plain, with a trailing separator, and
    // with a doubled one beneath it (Ogden-2688's case).
    for (const [target, dir] of [['L2', 'made-later'], ['L2/', 'made-later'], ['L2//sub', 'made-later/sub']] as const) {
      const env = new Env(t);
      mkdirSync(env.at('w'), { recursive: true });
      symlinkSync('made-later', env.at('w/L2'));
      symlinkSync(target, env.at('w/in'));
      const m = await env.open(t, [mount('w', env.at('w')), mount('in', env.at('w/in'))]);
      env.write(`w/${dir}/f.txt`, "the inner mount's\n");
      const read = await call(m, 'read', { path: `w/${dir}/f.txt` });
      assert.equal(read.error, `"w/${dir}/f.txt" lies in mount "in", nested in mount "w", which neither reads nor writes it: use "in/f.txt".`, target);
      await readsBack(m, 'in/f.txt', "the inner mount's");
    }
  });

  test('a mount configured as a link to the outer mount\'s own root is nested by its configured path alone, and refuses none of the outer mount\'s other paths', async (t) => {
    const env = new Env(t);
    env.write('outer/x.txt', "the outer mount's\n");
    symlinkSync(env.at('outer'), env.at('outer/self'));
    const m = await env.open(t, [mount('outer', env.at('outer'), { followSymlinks: true }), mount('self', env.at('outer/self'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.deepEqual(env.tree('outer'), ['x.txt'], 'the outer mount passed over the link');
    await readsBack(m, 'outer/x.txt', "the outer mount's");
    const write = await call(m, 'write', { path: 'outer/y.txt', content: 'outer wrote\n' });
    assert.equal(write.success, true, write.error);
    const through = await call(m, 'read', { path: 'outer/self/x.txt' });
    assert.equal(through.error, '"outer/self/x.txt" lies in mount "self", nested in mount "outer", which neither reads nor writes it: use "self/x.txt".');
    await readsBack(m, 'self/x.txt', "the outer mount's");
  });

  test('an outer mount configured through a link keeps the nesting by configured path of a mount configured as a link back to its root', async (t) => {
    // ol leads to o, and o/self leads back to o: self's configured path lies
    // beneath the outer mount's root as it really is, not as configured.
    const env = new Env(t);
    env.write('o/x.txt', "the outer mount's\n");
    symlinkSync(env.at('o'), env.at('ol'));
    symlinkSync(env.at('o'), env.at('o/self'));
    const m = await env.open(t, [mount('outer', env.at('ol'), { followSymlinks: true }), mount('self', env.at('o/self'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.deepEqual(env.tree('outer'), ['x.txt'], 'the outer mount passed over the link');
    const through = await call(m, 'read', { path: 'outer/self/x.txt' });
    assert.equal(through.error, '"outer/self/x.txt" lies in mount "self", nested in mount "outer", which neither reads nor writes it: use "self/x.txt".');
  });

  test('a mount configured as a link back to the outer mount\'s root keeps the nesting by configured path when its path reaches that root through a link above it', async (t) => {
    // alias leads to real, as macOS's /var leads to /private/var, and self's
    // configured path reaches the outer mount's root through it.
    const env = new Env(t);
    env.write('real/o/x.txt', "the outer mount's\n");
    symlinkSync(env.at('real'), env.at('alias'));
    symlinkSync(env.at('real/o'), env.at('real/o/self'));
    const m = await env.open(t, [mount('outer', env.at('real/o'), { followSymlinks: true }), mount('self', env.at('alias/o/self'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.deepEqual(env.tree('outer'), ['x.txt'], 'the outer mount passed over the link');
    const through = await call(m, 'read', { path: 'outer/self/x.txt' });
    assert.equal(through.error, '"outer/self/x.txt" lies in mount "self", nested in mount "outer", which neither reads nor writes it: use "self/x.txt".');
  });

  test('an outer mount configured through a link keeps the nesting by configured path of a mount configured through a link inside it that leads out of it', async (t) => {
    // o/via leads to e, outside the outer mount, and e/self back to o. self's
    // configured path reaches the outer mount's root at o, above via, so the
    // outer mount configured through ol nests it as one configured at o does.
    // Its parent placed on disk is e, which isn't beneath that root.
    const env = new Env(t);
    env.write('o/x.txt', "the outer mount's\n");
    mkdirSync(env.at('e'));
    symlinkSync(env.at('e'), env.at('o/via'));
    symlinkSync(env.at('o'), env.at('e/self'));
    symlinkSync(env.at('o'), env.at('ol'));
    const m = await env.open(t, [mount('outer', env.at('ol'), { followSymlinks: true }), mount('self', env.at('o/via/self'))]);
    const through = await call(m, 'read', { path: 'outer/via/self/x.txt' });
    assert.equal(through.error, '"outer/via/self/x.txt" lies in mount "self", nested in mount "outer", which neither reads nor writes it: use "self/x.txt".');
  });

  test('a mount configured as a link inside the outer mount to a directory above it is nested by its configured path, and holds the outer mount where it is', async (t) => {
    const env = new Env(t);
    env.write('top/top.txt', "the upper mount's\n");
    env.write('top/outer/x.txt', "the outer mount's\n");
    symlinkSync(env.at('top'), env.at('top/outer/up'));
    const m = await env.open(t, [mount('outer', env.at('top/outer')), mount('up', env.at('top/outer/up'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.deepEqual(env.tree('outer'), ['x.txt']);
    assert.deepEqual(env.tree('up'), ['top.txt']);
    const through = await call(m, 'read', { path: 'outer/up/top.txt' });
    assert.equal(through.error, '"outer/up/top.txt" lies in mount "up", nested in mount "outer", which neither reads nor writes it: use "up/top.txt".');
    const write = await call(m, 'write', { path: 'outer/up/new.txt', content: 'outer wrote\n' });
    assert.equal(write.error, '"outer/up/new.txt" lies in mount "up", nested in mount "outer", which neither reads nor writes it: use "up/new.txt".');
    const back = await call(m, 'read', { path: 'up/outer/x.txt' });
    assert.equal(back.error, '"up/outer/x.txt" lies in mount "outer", nested in mount "up", which neither reads nor writes it: use "outer/x.txt".');
    await readsBack(m, 'up/top.txt', "the upper mount's");
    await readsBack(m, 'outer/x.txt', "the outer mount's");
  });

  test('an inner mount configured through a link inside the outer mount is passed over at both of its directories', async (t) => {
    // Configured as outer/via, which leads to outer/a/b: the walk reaches
    // the inner mount's files under a/b, the real directory, and a path
    // written through via names them too.
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the inner mount's\n");
    env.write('outer/top.txt', "the outer mount's\n");
    symlinkSync(env.at('outer/a/b'), env.at('outer/via'));
    const m = await env.open(t, [mount('outer', env.at('outer')), mount('inner', env.at('outer/via'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.deepEqual(env.tree('outer'), ['top.txt'], "the outer mount took none of the inner mount's files in");
    for (const [path, use] of [['outer/a/b/x.txt', 'inner/x.txt'], ['outer/via/x.txt', 'inner/x.txt']] as const) {
      const read = await call(m, 'read', { path });
      assert.equal(read.success, false, path);
      assert.equal(read.error, `"${path}" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "${use}".`);
    }
  });

  test('an outer mount configured through a link holds an inner mount configured at its real path', async (t) => {
    const env = new Env(t);
    env.write('real-outer/a/b/x.txt', "the inner mount's\n");
    symlinkSync(env.at('real-outer'), env.at('outer-link'));
    const m = await env.open(t, [mount('outer', env.at('outer-link')), mount('inner', env.at('real-outer/a/b'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.deepEqual(env.tree('outer'), []);
    const read = await call(m, 'read', { path: 'outer/a/b/x.txt' });
    assert.equal(read.error, '"outer/a/b/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
  });

  test('an inner root not made yet, beneath a link into the outer mount, is nested where it would be made', async (t) => {
    const env = new Env(t);
    env.write('outer/a/keep.txt', "the outer mount's\n");
    symlinkSync(env.at('outer/a'), env.at('via'));
    const m = await env.open(t, [mount('outer', env.at('outer'), { autoMaterialize: true }), mount('inner', env.at('via/newdir'))]);
    const write = await call(m, 'write', { path: 'outer/a/newdir/x.txt', content: 'outer wrote\n' });
    assert.equal(write.success, false);
    assert.equal(write.error, '"outer/a/newdir/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
    assert.equal(existsSync(env.at('outer/a/newdir')), false, "the inner mount's root wasn't made by the outer mount");
  });
});

describe('a link into a nested mount\'s directory, on a mount that follows symlinks', () => {
  test('a read or write through it is refused before anything is stored, naming the path to use (Esther-2584\'s case)', async (t) => {
    const env = new Env(t);
    env.write('work/nested/sub/x.txt', 'inner file\n');
    symlinkSync('nested/sub', env.at('work/l'));
    const m = await env.open(t, [
      mount('work', env.at('work'), { followSymlinks: true, autoMaterialize: true }),
      mount('inner', env.at('work/nested'), { autoMaterialize: true }),
    ]);
    const read = await call(m, 'read', { path: 'work/l/x.txt' });
    assert.equal(read.success, false);
    assert.equal(read.error, leadsInto('work/l/x.txt', 'work', 'inner', 'inner/sub/x.txt'));
    await readsBack(m, 'inner/sub/x.txt', 'inner file');
    const write = await call(m, 'write', { path: 'work/l/new.txt', content: 'via work\n' });
    assert.equal(write.success, false);
    assert.equal(write.error, leadsInto('work/l/new.txt', 'work', 'inner', 'inner/sub/new.txt'));
    assert.equal(existsSync(env.at('work/nested/sub/new.txt')), false);
    assert.deepEqual(env.tree('work'), [], 'nothing was stored');
    await assert.rejects(m.readFileFromDisk('work/l/x.txt'), (err: unknown) => {
      assert.ok(err instanceof WorkspaceReadError, String(err));
      assert.equal(err.code, 'other_mount');
      assert.equal(err.message, leadsInto('work/l/x.txt', 'work', 'inner', 'inner/sub/x.txt'));
      return true;
    });
    assert.deepEqual(await m.readBinaryFromDisk('work/l/x.txt'), { error: leadsInto('work/l/x.txt', 'work', 'inner', 'inner/sub/x.txt') });
  });

  test('a sync naming a path through it takes nothing in, and says where the path leads', async (t) => {
    const env = new Env(t);
    env.write('work/nested/sub/x.txt', 'inner file\n');
    symlinkSync('nested/sub', env.at('work/l'));
    const m = await env.open(t, [mount('work', env.at('work'), { followSymlinks: true }), mount('inner', env.at('work/nested'))]);
    const sync = await call(m, 'sync', { path: 'work/l/x.txt' });
    assert.equal(sync.success, true, sync.error);
    assert.equal(skippedReason(sync.data, 'l/x.txt'), 'disk could not be checked: "work/l" leads into mount "inner", nested in mount "work": use "inner/sub" in its place');
    assert.deepEqual(env.tree('work'), []);
  });

  test('a path through a link to a directory holding the nested mount is refused where it reaches it, and the rest is the outer mount\'s (Ada-1017\'s case)', async (t) => {
    const env = new Env(t);
    env.write('work/a/b/x.txt', 'inner file\n');
    env.write('work/a/top.txt', 'outer file under a\n');
    symlinkSync('a', env.at('work/l'));
    const m = await env.open(t, [
      mount('work', env.at('work'), { followSymlinks: true, autoMaterialize: true }),
      mount('inner', env.at('work/a/b'), { autoMaterialize: true }),
    ]);
    const read = await call(m, 'read', { path: 'work/l/b/x.txt' });
    assert.equal(read.error, leadsInto('work/l/b/x.txt', 'work', 'inner', 'inner/x.txt'));
    await readsBack(m, 'inner/x.txt', 'inner file');
    const top = await call(m, 'read', { path: 'work/l/top.txt' });
    assert.equal(top.success, true, top.error);
    assert.match(top.data.content, /outer file under a/);
    for (const [path, use] of [['work/l/b/new.txt', 'inner/new.txt'], ['work/l/b/deep/new.txt', 'inner/deep/new.txt']] as const) {
      const write = await call(m, 'write', { path, content: 'via work\n' });
      assert.equal(write.error, leadsInto(path, 'work', 'inner', use));
    }
    assert.equal(existsSync(env.at('work/a/b/new.txt')), false);
    assert.equal(existsSync(env.at('work/a/b/deep')), false);
  });

  test('a link to a place not made yet in it leads there: a write through it is refused before anything is stored', async (t) => {
    const env = new Env(t);
    env.write('work/nested/keep.txt', 'inner\n');
    symlinkSync('nested/new.txt', env.at('work/flink.txt'));
    symlinkSync('nested/sub', env.at('work/l'));
    const m = await env.open(t, [
      mount('work', env.at('work'), { followSymlinks: true, autoMaterialize: true }),
      mount('inner', env.at('work/nested'), { autoMaterialize: true }),
    ]);
    for (const [path, use] of [['work/flink.txt', 'inner/new.txt'], ['work/l/x.txt', 'inner/sub/x.txt']] as const) {
      const write = await call(m, 'write', { path, content: 'via work\n' });
      assert.equal(write.error, leadsInto(path, 'work', 'inner', use));
    }
    assert.deepEqual(env.tree('work'), [], 'nothing was stored');
    assert.equal(existsSync(env.at('work/nested/new.txt')), false);
    assert.equal(existsSync(env.at('work/nested/sub')), false);
  });

  test('a link to a place not made yet is read from its directory as it is on disk, a `..` in its target included', async (t) => {
    // work/alias leads to nested/sub, where flink.txt leads to ../y.txt, not
    // made yet. On disk that's nested/y.txt, in the nested mount; read from
    // the path as written, it would be work/y.txt.
    const env = new Env(t);
    env.write('work/nested/sub/keep.txt', 'inner\n');
    symlinkSync('nested/sub', env.at('work/alias'));
    symlinkSync('../y.txt', env.at('work/nested/sub/flink.txt'));
    const m = await env.open(t, [mount('work', env.at('work'), { followSymlinks: true }), mount('inner', env.at('work/nested'))]);
    const write = await call(m, 'write', { path: 'work/alias/flink.txt', content: 'via work\n' });
    assert.equal(write.error, leadsInto('work/alias/flink.txt', 'work', 'inner', 'inner/y.txt'));
    // A `..` after a link inside the target is taken from where that link
    // leads too: x leads to nested/sub/deep, so x/../z.txt is nested/sub/z.txt.
    env.write('work/nested/sub/deep/keep.txt', 'inner\n');
    symlinkSync('nested/sub/deep', env.at('work/x'));
    symlinkSync('x/../z.txt', env.at('work/flink2.txt'));
    const second = await call(m, 'write', { path: 'work/flink2.txt', content: 'via work\n' });
    assert.equal(second.error, leadsInto('work/flink2.txt', 'work', 'inner', 'inner/sub/z.txt'));
    assert.deepEqual(env.tree('work'), [], 'nothing was stored');
    assert.equal(existsSync(env.at('work/nested/y.txt')), false);
    assert.equal(existsSync(env.at('work/nested/sub/z.txt')), false);
  });

  test('read_image refuses a path that now leads into it, rather than give the copy held from before', async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('work/l'), { recursive: true });
    env.write('work/nested/sub/keep.txt', 'inner\n');
    const m = await env.open(t, [mount('work', env.at('work'), { followSymlinks: true }), mount('inner', env.at('work/nested'))]);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
    const saved = await m.writeBinary('work/l/img.png', png, 'image/png');
    assert.equal(saved.success, true, saved.error);
    rmSync(env.at('work/l'), { recursive: true, force: true });
    symlinkSync('nested/sub', env.at('work/l'));
    const image = await call(m, 'read_image', { path: 'work/l/img.png' });
    assert.equal(image.success, false);
    assert.equal(image.error, leadsInto('work/l/img.png', 'work', 'inner', 'inner/sub/img.png'));
  });

  test('a file link into it is taken in by no sync, and a copy held from before is neither read, searched nor pushed through it', async (t) => {
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the inner mount's\n");
    env.write('outer/flink.txt', "the outer mount's copy\n");
    const m = await env.open(t, [mount('outer', env.at('outer'), { followSymlinks: true }), mount('inner', env.at('outer/a/b'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    rmSync(env.at('outer/flink.txt'));
    symlinkSync(env.at('outer/a/b/x.txt'), env.at('outer/flink.txt'));
    const sync = await call(m, 'sync', {});
    assert.equal(skippedReason(sync.data, 'flink.txt'), 'disk could not be checked: "outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place');
    const read = await call(m, 'read', { path: 'outer/flink.txt' });
    assert.equal(read.error, leadsInto('outer/flink.txt', 'outer', 'inner', 'inner/x.txt'));
    for (const path of ['outer', 'outer/flink.txt']) {
      const grep = await call(m, 'grep', { pattern: 'copy', path });
      assert.deepEqual(grep.data.results, [], `grep of ${path} searched none of the copy held from before`);
      assert.deepEqual(grep.data.skipped, [{ file: 'outer/flink.txt', reason: leadsInto('outer/flink.txt', 'outer', 'inner', 'inner/x.txt') }], path);
    }
    // A write made now, with the link in place, is refused at the tool
    // (anima-research/agent-framework#530's third case).
    const write = await call(m, 'write', { path: 'outer/flink.txt', content: 'outer wrote\n' });
    assert.equal(write.error, leadsInto('outer/flink.txt', 'outer', 'inner', 'inner/x.txt'));
    const materialize = await call(m, 'materialize', { path: 'outer/flink.txt', force: true });
    assert.equal(materialize.data.count, 0);
    assert.equal(skippedReason(materialize.data, 'flink.txt'), 'flink.txt: not written: "outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place');
    assert.equal(readFileSync(env.at('outer/a/b/x.txt'), 'utf8'), "the inner mount's\n");
  });

  test('grep gives each file with the states of the branch its text comes from, when a branch is selected while it asks about a held copy', async (t) => {
    // grep asks whether each path whose disk its pass couldn't check leads
    // into a nested mount, which awaits a realpath. A branch selected in that
    // await mustn't have its text labelled with the states of the pass.
    const env = new Env(t);
    env.write('work/l/x.txt', 'outer copy\n');
    env.write('work/nested/sub/keep.txt', 'inner\n');
    env.write('work/z.txt', 'main\n');
    const m = await env.open(t, [mount('work', env.at('work'), { followSymlinks: true }), mount('inner', env.at('work/nested'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.store.switchBranch('other');
    assert.equal((await call(m, 'write', { path: 'work/z.txt', content: 'OTHER\n' })).success, true);
    env.store.switchBranch(main);
    rmSync(env.at('work/l'), { recursive: true });
    symlinkSync('nested/sub', env.at('work/l'));
    let switched = false;
    const grep = await withFsp('realpath', (realpath) => async (path: string, ...rest: unknown[]) => {
      if (!switched && String(path) === env.at('work/l/x.txt')) {
        switched = true;
        env.store.switchBranch('other');
      }
      return realpath(path, ...rest);
    }, () => call(m, 'grep', { pattern: 'main|OTHER', path: 'work' }));
    assert.ok(switched, 'a branch was selected while grep asked');
    const settled = await call(m, 'grep', { pattern: 'main|OTHER', path: 'work' });
    assert.notEqual(settled.data.results[0]?.state, 'synced', "z.txt's state on the other branch isn't main's");
    assert.deepEqual(grep.data.results, settled.data.results, "grep gave the other branch's text with that branch's states");
  });

  for (const autoMaterialize of [false, true]) test(`a draft made before a file link into it took the path's place gets the path to use from a push, unforced and forced (autoMaterialize ${autoMaterialize})`, async (t) => {
    // anima-research/agent-framework#530's first two cases. On `main` the
    // unforced push skipped the path with advice to force it, and the forced
    // push wrote into the inner mount's file.
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the inner mount's\n");
    const m = await env.open(t, [mount('outer', env.at('outer'), { followSymlinks: true, autoMaterialize }), mount('inner', env.at('outer/a/b'))]);
    assert.equal((await call(m, 'write', { path: 'outer/flink.txt', content: 'outer wrote\n' })).success, true);
    if (existsSync(env.at('outer/flink.txt'))) rmSync(env.at('outer/flink.txt'));
    symlinkSync(env.at('outer/a/b/x.txt'), env.at('outer/flink.txt'));
    const unforced = await call(m, 'materialize', { path: 'outer/flink.txt' });
    assert.equal(unforced.data.count, 0);
    assert.equal(skippedReason(unforced.data, 'flink.txt'), 'flink.txt: cannot verify disk copy ("outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place) — fix it and materialize again');
    const forced = await call(m, 'materialize', { path: 'outer/flink.txt', force: true });
    assert.equal(forced.data.count, 0);
    assert.equal(skippedReason(forced.data, 'flink.txt'), 'flink.txt: not written: "outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place');
    assert.equal(readFileSync(env.at('outer/a/b/x.txt'), 'utf8'), "the inner mount's\n");
  });

  test('a deletion stored before a link into it took the path\'s place is refused by a forced push, through a final link and through a directory link', async (t) => {
    // anima-research/agent-framework#530's unlink side. On `main` the push
    // unlinked the final link, and through the directory link it unlinked
    // the inner mount's file.
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the inner mount's\n");
    env.write('outer/flink.txt', "the outer mount's\n");
    env.write('outer/alias/x.txt', "the outer mount's\n");
    const m = await env.open(t, [mount('outer', env.at('outer'), { followSymlinks: true }), mount('inner', env.at('outer/a/b'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    for (const path of ['outer/flink.txt', 'outer/alias/x.txt']) assert.equal((await call(m, 'delete', { path })).success, true, path);
    rmSync(env.at('outer/flink.txt'));
    symlinkSync(env.at('outer/a/b/x.txt'), env.at('outer/flink.txt'));
    rmSync(env.at('outer/alias'), { recursive: true });
    symlinkSync(env.at('outer/a/b'), env.at('outer/alias'));
    const finalLink = await call(m, 'materialize', { path: 'outer/flink.txt', force: true, applyDeletions: true });
    assert.equal(skippedReason(finalLink.data, 'flink.txt'), 'flink.txt: not unlinked: "outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place');
    const throughDir = await call(m, 'materialize', { path: 'outer/alias/x.txt', force: true, applyDeletions: true });
    assert.equal(skippedReason(throughDir.data, 'alias/x.txt'), 'alias/x.txt: not unlinked: "outer/alias" leads into mount "inner", nested in mount "outer": use "inner" in its place');
    assert.equal(lstatSync(env.at('outer/flink.txt')).isSymbolicLink(), true, 'the link stays');
    assert.equal(readFileSync(env.at('outer/a/b/x.txt'), 'utf8'), "the inner mount's\n");
  });

  test('a copy taken in through a file link before the nested mount was configured is no longer vouched for by its fingerprint', async (t) => {
    // A listing's pass takes a file whose recorded fingerprint still matches
    // as unchanged, without reading it, so only the observation of the link
    // can say it now leads into another mount's directory.
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the inner mount's\n");
    symlinkSync(env.at('outer/a/b/x.txt'), env.at('outer/flink.txt'));
    // Each module trusts this filesystem's ctime, whatever it is, so the
    // fingerprint vouches, as on Linux's.
    const trust = (m: WorkspaceModule) => (m as any).ctimeTrust.set(realpathSync(env.at('outer')), statSync(env.at('outer/a/b/x.txt'), { bigint: true }).dev.toString());
    const before = new WorkspaceModule({ mounts: [mount('outer', env.at('outer'), { followSymlinks: true })] });
    trust(before);
    before.initStore(env.store);
    await before.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    await new Promise((r) => setTimeout(r, 2100)); // past the racy window, so the fingerprint the sync records vouches
    assert.equal((await call(before, 'sync', {})).success, true);
    await before.stop();
    assert.deepEqual(env.tree('outer'), ['a/b/x.txt', 'flink.txt']);
    const m = new WorkspaceModule({ mounts: [mount('outer', env.at('outer'), { followSymlinks: true }), mount('inner', env.at('outer/a/b'))] });
    trust(m);
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    t.after(() => m.stop().catch(() => {}));
    const ls = await call(m, 'ls', { path: 'outer' });
    assert.equal(ls.success, true, ls.error);
    const entry = (ls.data.entries as Array<{ name: string; state?: string; note?: string }>).find((e) => e.name === 'flink.txt');
    assert.deepEqual({ state: entry?.state, note: entry?.note }, {
      state: 'unverified', note: '"outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place',
    });
  });

  test('a directory replaced by a link into it is the nested mount\'s: a forced push of a copy held from before writes nothing (#324)', async (t) => {
    const env = new Env(t);
    env.write('outer/alias/x.txt', 'old copy\n');
    env.write('outer/a/b/keep.txt', 'inner\n');
    const m = await env.open(t, [mount('outer', env.at('outer'), { followSymlinks: true }), mount('inner', env.at('outer/a/b'))]);
    assert.equal((await call(m, 'read', { path: 'outer/alias/x.txt' })).success, true);
    rmSync(env.at('outer/alias'), { recursive: true });
    symlinkSync(env.at('outer/a/b'), env.at('outer/alias'));
    env.write('outer/a/b/x.txt', 'inner v2\n');
    const materialize = await call(m, 'materialize', { path: 'outer/alias/x.txt', force: true });
    assert.equal(materialize.data.count, 0);
    assert.equal(skippedReason(materialize.data, 'alias/x.txt'), 'alias/x.txt: not written: "outer/alias" leads into mount "inner", nested in mount "outer": use "inner" in its place');
    assert.equal(readFileSync(env.at('outer/a/b/x.txt'), 'utf8'), 'inner v2\n');
    await readsBack(m, 'inner/x.txt', 'inner v2');
    for (const [name, input] of [
      ['edit', { path: 'outer/alias/x.txt', oldString: 'old', newString: 'outer-edited' }],
      ['write', { path: 'outer/alias/y.txt', content: 'outer wrote y\n' }],
      ['delete', { path: 'outer/alias/x.txt' }],
    ] as const) {
      const res = await call(m, name, input);
      assert.equal(res.error, leadsInto(String(input.path), 'outer', 'inner', `inner/${String(input.path).slice('outer/alias/'.length)}`), name);
    }
    assert.equal(existsSync(env.at('outer/a/b/y.txt')), false);
    assert.equal(readFileSync(env.at('outer/a/b/x.txt'), 'utf8'), 'inner v2\n');
  });

  test('the disk reader refuses a path whose directory became a link into it after the tools\' check', async (t) => {
    const env = new Env(t);
    env.write('work/l/x.txt', "the outer mount's\n");
    env.write('work/nested/sub/x.txt', 'inner file\n');
    const m = await env.open(t, [mount('work', env.at('work'), { followSymlinks: true }), mount('inner', env.at('work/nested'))]);
    let swapped = false;
    await withFsp('lstat', (lstat) => async (path: string, ...rest: unknown[]) => {
      // The reader's lstat of the path comes after the tools' check, which
      // found it the outer mount's: the directory becomes a link between.
      if (!swapped && String(path) === env.at('work/l/x.txt')) {
        swapped = true;
        renameSync(env.at('work/l'), env.at('work/l-was'));
        symlinkSync('nested/sub', env.at('work/l'));
      }
      return lstat(path, ...rest);
    }, async () => {
      await assert.rejects(m.readFileFromDisk('work/l/x.txt'), (err: unknown) => {
        assert.ok(err instanceof WorkspaceReadError, String(err));
        assert.equal(err.code, 'other_mount');
        assert.equal(err.message, '"work/l/x.txt" leads into mount "inner", nested in mount "work": use "inner/sub/x.txt" in its place');
        return true;
      });
    });
    assert.equal(swapped, true);
  });

  test('read_image refuses a path whose directory became a link into it after the tools\' check, over the copy held from before', async (t) => {
    // The copy isn't an image, so a disk refusal read as "not found" would
    // answer the copy's failure instead (#468's case, which this pins now
    // that the tools' check refuses the write that used to store the copy).
    const env = new Env(t);
    env.write('work/l/img.png', 'not an image\n');
    env.write('work/nested/sub/img.png', 'the inner mount\'s\n');
    const m = await env.open(t, [mount('work', env.at('work'), { followSymlinks: true }), mount('inner', env.at('work/nested'))]);
    assert.equal((await call(m, 'sync', {})).success, true);
    assert.ok(env.tree('work').includes('l/img.png'), 'the outer mount holds the copy');
    let swapped = false;
    await withFsp('lstat', (lstat) => async (path: string, ...rest: unknown[]) => {
      if (!swapped && String(path) === env.at('work/l/img.png')) {
        swapped = true;
        renameSync(env.at('work/l'), env.at('work/l-was'));
        symlinkSync('nested/sub', env.at('work/l'));
      }
      return lstat(path, ...rest);
    }, async () => {
      const image = await call(m, 'read_image', { path: 'work/l/img.png' });
      assert.equal(image.success, false);
      assert.equal(image.error, '"work/l/img.png" leads into mount "inner", nested in mount "work": use "inner/sub/img.png" in its place');
    });
    assert.equal(swapped, true);
  });
});

describe('a root placed at each start', () => {
  test('a root moved while the module was stopped is placed where it is at the next start', async (t) => {
    const env = new Env(t);
    env.write('outer/a/b/x.txt', 'under a/b\n');
    env.write('outer/c/y.txt', 'under c\n');
    symlinkSync(env.at('outer/a/b'), env.at('via'));
    const m = await env.open(t, [mount('outer', env.at('outer')), mount('inner', env.at('via'))]);
    const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
    assert.equal((await call(m, 'read', { path: 'outer/c/y.txt' })).success, true);
    await m.stop();
    rmSync(env.at('via'));
    symlinkSync(env.at('outer/c'), env.at('via'));
    await m.start({ ...ctx, isRestart: true } as unknown as ModuleContext);
    const read = await call(m, 'read', { path: 'outer/c/y.txt' });
    assert.equal(read.error, '"outer/c/y.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/y.txt".');
    await readsBack(m, 'outer/a/b/x.txt', 'under a/b');
  });
});

describe('a link into a nested mount\'s directory, on a mount that doesn\'t follow symlinks', () => {
  test('a path that is itself a link into it is refused with the mount it leads into, by the tools and the disk reader, and nothing is stored', async (t) => {
    // On `main`, readFileFromDisk answered `symlink` ("Symlinks are not
    // allowed"), and a write stored a draft that no push could write.
    const env = new Env(t);
    env.write('work/nested/x.txt', 'inner file\n');
    symlinkSync('nested/x.txt', env.at('work/flink.txt'));
    const m = await env.open(t, [mount('work', env.at('work')), mount('inner', env.at('work/nested'))]);
    const refusal = 'work/flink.txt: "work/flink.txt" is a symlink to "work/nested/x.txt", which this mount does not follow; it lies in mount "inner", nested in mount "work": use "inner/x.txt" in place of "work/flink.txt"';
    for (const [name, input] of [['read', { path: 'work/flink.txt' }], ['write', { path: 'work/flink.txt', content: 'via work\n' }]] as const) {
      const res = await call(m, name, input);
      assert.equal(res.error, refusal, name);
    }
    assert.deepEqual(env.tree('work'), [], 'nothing was stored');
    await assert.rejects(m.readFileFromDisk('work/flink.txt'), (err: unknown) => {
      assert.ok(err instanceof WorkspaceReadError, String(err));
      assert.equal(err.code, 'other_mount');
      assert.equal(err.message, refusal);
      return true;
    });
    await readsBack(m, 'inner/x.txt', 'inner file');
  });

  test('a write through a link to a place not made yet in it is refused before anything is stored', async (t) => {
    const env = new Env(t);
    env.write('work/nested/keep.txt', 'inner\n');
    symlinkSync('nested/new.txt', env.at('work/flink.txt'));
    const m = await env.open(t, [mount('work', env.at('work')), mount('inner', env.at('work/nested'))]);
    // #468's words for a link whose target isn't there to name.
    const write = await call(m, 'write', { path: 'work/flink.txt', content: 'via work\n' });
    assert.equal(write.success, false);
    assert.equal(write.error, 'work/flink.txt: "work/flink.txt" is a symlink, which this mount does not follow');
    assert.deepEqual(env.tree('work'), [], 'nothing was stored');
    assert.equal(existsSync(env.at('work/nested/new.txt')), false);
  });

  test('a write through it is refused before anything is stored, with the link\'s own refusal', async (t) => {
    // The readers and pushes give this refusal already (#468). A write used
    // to store a draft that no push could write.
    const env = new Env(t);
    env.write('work/nested/sub/x.txt', 'inner file\n');
    symlinkSync('nested/sub', env.at('work/l'));
    const m = await env.open(t, [mount('work', env.at('work')), mount('inner', env.at('work/nested'))]);
    const write = await call(m, 'write', { path: 'work/l/new.txt', content: 'via work\n' });
    assert.equal(write.success, false);
    assert.equal(write.error, 'work/l/new.txt: "work/l" is a symlink to "work/nested/sub", which this mount does not follow; it lies in mount "inner", nested in mount "work": use "inner/sub" in place of "work/l"');
    assert.deepEqual(env.tree('work'), [], 'nothing was stored');
  });
});

describe('the checks where disk is acted on, called directly as a push and a read call them', () => {
  /** A mount following symlinks, with `inner` nested at `a/b` and a file link `flink.txt` into it. */
  function rig(t: TestContext): { env: Env; view: MountView; rootReal: string } {
    const env = new Env(t);
    env.write('outer/a/b/x.txt', "the inner mount's");
    symlinkSync(env.at('outer/a/b/x.txt'), env.at('outer/flink.txt'));
    // Cast, so the file also compiles against code whose nested mounts carry
    // no real root, for the run of these tests on it.
    const nested = [{ dir: 'a/b', name: 'inner', real: realpathSync(env.at('outer/a/b')) }];
    const view = {
      root: env.at('outer'), name: 'outer', followSymlinks: true, maxFileSize: 1 << 20, ignore: [], others: ['a/b'], nested,
    } as MountView;
    return { env, view, rootReal: realpathSync(env.at('outer')) };
  }
  const reason = '"outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place';

  // These two pin the checks #282 added for slimepriestess's review (its
  // 577258f4, by Ada-1017), carried here with the reason this change gives.
  test('the contained write refuses a file it opens through a link into a nested mount', async (t) => {
    const { env, view, rootReal } = rig(t);
    const err = await writeContained(view, rootReal, 'flink.txt', Buffer.from('outer wrote'), { kind: 'any' }).then(() => null, (e) => e);
    assert.ok(err instanceof EffectFailed, String(err));
    assert.equal(err.message, reason);
    assert.equal(readFileSync(env.at('outer/a/b/x.txt'), 'utf8'), "the inner mount's", "the inner mount's file is as it was");
  });

  test('the contained unlink refuses a final link into a nested mount, and leaves the link and the file', async (t) => {
    const { env, view, rootReal } = rig(t);
    const err = await unlinkContained(view, rootReal, 'flink.txt', { kind: 'any' }).then(() => null, (e) => e);
    assert.ok(err instanceof EffectFailed, String(err));
    assert.equal(err.message, reason);
    assert.ok(lstatSync(env.at('outer/flink.txt')).isSymbolicLink(), 'the link is still there');
    assert.equal(readFileSync(env.at('outer/a/b/x.txt'), 'utf8'), "the inner mount's", "the inner mount's file is as it was");
  });

  test('the located read refuses a file it opens through a link into a nested mount', async (t) => {
    const { view, rootReal } = rig(t);
    assert.deepEqual(await readPath(view, rootReal, 'flink.txt', 1 << 20), { kind: 'unobserved', reason });
  });

  test('a directory made for a push isn\'t made where a link leads into a nested mount\'s root not made yet (G3)', async (t) => {
    const { env, view, rootReal } = rig(t);
    symlinkSync(env.at('outer/a'), env.at('outer/l'));
    const nested = [{ dir: 'a/c', name: 'later', real: join(realpathSync(env.at('outer/a')), 'c') }];
    const later = { ...view, nested } as MountView;
    assert.deepEqual(await checkDir(later, rootReal, 'l/c/d', { create: true }), {
      kind: 'unobserved', reason: '"outer/l/c" leads into mount "later", nested in mount "outer": use "later" in its place',
    });
    assert.equal(existsSync(env.at('outer/a/c')), false, "the nested mount's root wasn't made");
  });
});

describe('a watcher of a mount configured as a relative path', () => {
  test('hears a change beneath a root written with `./`', async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('m'));
    const path = `./${relative(process.cwd(), env.at('m'))}`;
    const batches: FsChange[][] = [];
    let ready = false;
    const watcher = new MountWatcher({ name: 'm', path, mode: 'read-write', watch: 'always', watchDebounceMs: 50 }, (batch) => batches.push(batch), { onReady: () => { ready = true; } });
    watcher.start();
    t.after(() => watcher.stop());
    for (let i = 0; i < 400 && !ready; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(ready, true, 'the watcher is ready');
    // On macOS a write right after onReady can come before the platform
    // delivers events, and goes unreported, so the test waits until they flow.
    await changesFlow(env.at('m'), batches, []);
    writeFileSync(env.at('m/x.txt'), 'x\n');
    const heard = () => batches.flat().some((c) => c.path === 'x.txt');
    for (let i = 0; i < 400 && !heard(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(heard(), `heard: ${JSON.stringify(batches.flat().filter((c) => !isProbe(c.path)))}`);
  });
});
