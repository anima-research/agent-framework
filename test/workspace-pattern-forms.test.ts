/**
 * A mount's `ignore` and `include` read one grammar: the gitignore forms a
 * config copied from a `.gitignore` uses, each as gitignore reads it, and a
 * pattern of any other form is refused when the module is built.
 */

import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { FsChange } from '../src/modules/workspace/watcher.js';
import type { ModuleContext } from '../src/types/module.js';

const TREE = 'workspace/work/tree';
const FORMS = 'The list reads these of gitignore\'s forms: a name, matched at any depth, with "*" and "?" within it; '
  + 'a trailing "/" to match only directories; a leading or inner "/" for a path from the mount\'s root; '
  + 'a leading "**/" before one name; and a trailing "/**" for what lies beneath a directory.';

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-forms-'));
  readonly dir = join(this.root, 'work');
  readonly store: JsStore;
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext, files: string[]) {
    mkdirSync(this.dir, { recursive: true });
    for (const f of files) {
      mkdirSync(dirname(join(this.dir, f)), { recursive: true });
      writeFileSync(join(this.dir, f), f);
    }
    this.store = JsStore.openOrCreate({ path: join(this.root, 'ws.chronicle') });
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  async open(mount: Partial<MountConfig>): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', ...mount }] });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }

  tree(): string[] {
    return this.store.treeList(TREE).map((e: { path: string }) => e.path).sort();
  }
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<any> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, true, `${name} ${JSON.stringify(input)} failed: ${res.error}`);
  return res.structured ?? res.data;
}

/** What a sync without a path takes in, with `mount`'s lists. */
async function synced(t: TestContext, files: string[], mount: Partial<MountConfig>): Promise<string[]> {
  const env = new Env(t, files);
  await call(await env.open(mount), 'sync', { mount: 'work' });
  return env.tree();
}

describe('ignore reads gitignore\'s forms', () => {
  test('a trailing "/" passes over a directory of that name at any depth, and not a file of that name', async (t) => {
    const env = new Env(t, ['build/a.js', 'x/build/b.js', 'x/build/inner/build/c.js', 'y/build', 'keep.txt']);
    const m = await env.open({ ignore: ['build/'] });
    await call(m, 'sync', { mount: 'work' });
    assert.deepEqual(env.tree(), ['keep.txt', 'y/build']);
    // A sync that names a path says when the list covers it, which it does for the directory and not the file.
    const file = await call(m, 'sync', { path: 'work/y/build' });
    assert.equal(file.ignored, undefined);
    const directory = await call(m, 'sync', { path: 'work/x/build' });
    assert.deepEqual(directory.ignored, [{ mount: 'work', path: 'x/build',
      note: "this mount's ignore list covers it, so a sync without a path won't maintain it" }]);
    // The pattern that covers a named directory doesn't apply beneath it (#276), at any depth.
    assert.deepEqual(env.tree(), ['keep.txt', 'x/build/b.js', 'x/build/inner/build/c.js', 'y/build']);
  });

  test('a sync naming a path where disk has a file, and history has entries beneath it, doesn\'t say a directory-only pattern covers the file', async (t) => {
    const env = new Env(t, ['build/a.js']);
    const m = await env.open({ ignore: ['build/'] });
    await call(m, 'sync', { path: 'work/build' });
    assert.deepEqual(env.tree(), ['build/a.js']);
    rmSync(join(env.dir, 'build'), { recursive: true });
    writeFileSync(join(env.dir, 'build'), 'a build script');
    const file = await call(m, 'sync', { path: 'work/build' });
    assert.equal(file.ignored, undefined);
  });

  test('a listing naming a file that a directory-only pattern names doesn\'t say the list covers it', async (t) => {
    const env = new Env(t, ['build', 'keep.txt']);
    const m = await env.open({ ignore: ['build/'] });
    const res = await m.handleToolCall({ id: 't', name: 'ls', input: { path: 'work/build' } });
    assert.ok(!JSON.stringify(res).includes('ignored by the mount'), JSON.stringify(res));
  });

  test('a file the watcher reports, named like a directory-only pattern, is taken in', async (t) => {
    const env = new Env(t, ['keep.txt']);
    const m = await env.open({ ignore: ['build/'] });
    await call(m, 'sync', { mount: 'work' });
    mkdirSync(join(env.dir, 'sub'));
    writeFileSync(join(env.dir, 'sub/build'), 'a build script');
    const changes: FsChange[] = [{ path: 'sub/build', op: 'created' }];
    await (m as unknown as { handleFsChanges(mount: string, changes: FsChange[]): Promise<void> }).handleFsChanges('work', changes);
    assert.deepEqual(env.tree(), ['keep.txt', 'sub/build']);
  });

  test('a leading or inner "/" anchors a pattern at the mount\'s root', async (t) => {
    const files = ['dist/x.js', 'sub/dist/y.js', 'a/b/c.txt', 'z/a/b/d.txt', 'out/o.txt', 'q/out/p.txt', 'keep.txt'];
    assert.deepEqual(await synced(t, files, { ignore: ['/dist', 'a/b', '/out/'] }), ['keep.txt', 'q/out/p.txt', 'sub/dist/y.js', 'z/a/b/d.txt']);
  });

  test('a leading "**/" before one name matches it at any depth', async (t) => {
    assert.deepEqual(await synced(t, ['cache/a', 'x/cache/b', 'x/y/cache', 'keep.txt'], { ignore: ['**/cache'] }), ['keep.txt']);
    assert.deepEqual(await synced(t, ['cache/a', 'x/cache/b', 'x/y/cache', 'keep.txt'], { ignore: ['**/cache/'] }), ['keep.txt', 'x/y/cache']);
    assert.deepEqual(await synced(t, ['cache/a', 'x/cache/b', 'x/y/cache', 'keep.txt'], { ignore: ['**/cache/**'] }), ['keep.txt', 'x/y/cache']);
  });

  test('a trailing "/**" passes over what lies beneath a directory from the root, and not a file of its name', async (t) => {
    assert.deepEqual(await synced(t, ['gen', 'tmp/t.txt', 'x/tmp/u.txt', 'keep.txt'], { ignore: ['gen/**', 'tmp/**'] }), ['gen', 'keep.txt', 'x/tmp/u.txt']);
  });

  test('a "?" stands for a "[" in a name, which an ignore pattern can\'t hold', async (t) => {
    assert.deepEqual(await synced(t, ['[id].tsx', 'x/[id].tsx', 'other.tsx'], { ignore: ['?id].tsx'] }), ['other.tsx']);
  });

  test('on a mount that follows links, a link counts as what it leads to: a directory for a directory-only pattern, a file not', async (t) => {
    const env = new Env(t, ['real/a.txt', 'file.txt']);
    symlinkSync('real', join(env.dir, 'build'));
    symlinkSync('file.txt', join(env.dir, 'bin'));
    const m = await env.open({ ignore: ['build/', 'bin/'], followSymlinks: true });
    const IGNORED_NOTE = "this mount's ignore list covers it, so a sync without a path won't maintain it";
    const listingSays = async (path: string) => JSON.stringify(await m.handleToolCall({ id: 't', name: 'ls', input: { path } }));
    assert.match(await listingSays('work/build'), /ignored by the mount/);
    assert.deepEqual((await call(m, 'sync', { path: 'work/build' })).ignored, [{ mount: 'work', path: 'build', note: IGNORED_NOTE }]);
    assert.doesNotMatch(await listingSays('work/bin'), /ignored by the mount/);
    assert.equal((await call(m, 'sync', { path: 'work/bin' })).ignored, undefined);
  });

  test('"*" and "?" match within a name, and "*.ext" matches as before', async (t) => {
    const files = ['npm-debug.log', 'npm-debug.log.1', '.env', 'x/.env.local', 'test.txt', 'tent.txt', 'teest.txt', 'a.md', 'x/b.md', 'keep.txt'];
    assert.deepEqual(await synced(t, files, { ignore: ['npm-debug.log*', '.env*', 'te?t.txt', '*.md'] }), ['keep.txt', 'teest.txt']);
  });
});

describe('include reads gitignore\'s forms, for files', () => {
  test('a trailing "/" covers what lies beneath a directory of that name at any depth, and not a file of that name', async (t) => {
    const files = ['fixtures/a.json', 'x/fixtures/y/b.json', 'z/fixtures', 'other.txt'];
    assert.deepEqual(await synced(t, files, { include: ['fixtures/'] }), ['fixtures/a.json', 'x/fixtures/y/b.json']);
  });

  test('a leading or inner "/" covers a file by its path from the mount\'s root, with "*" within a name', async (t) => {
    const env = new Env(t, ['gate.json', 'x/gate.json', 'src/a.ts', 'src/x/b.ts', 'a.ts']);
    const m = await env.open({ include: ['/gate.json', 'src/*.ts'] });
    await call(m, 'sync', { mount: 'work' });
    assert.deepEqual(env.tree(), ['gate.json', 'src/a.ts']);
    const res = await m.handleToolCall({ id: 't', name: 'read', input: { path: 'work/x/gate.json' } });
    assert.equal(res.success, false);
    assert.match(String(res.error), /outside the mount's include/);
  });

  test('"**/" before one name, and a leading "/" with a trailing "/", read as in ignore', async (t) => {
    const files = ['docs/a.md', 'x/docs/b.md', 'cache/c', 'y/cache/d', 'cache.txt'];
    assert.deepEqual(await synced(t, files, { include: ['/docs/', '**/cache/'] }), ['cache/c', 'docs/a.md', 'y/cache/d']);
  });

  test('a "[" is read as itself, as 0.27.0 promised, with "*" and "?" beside it too', async (t) => {
    const files = ['[id].tsx', 'x/[id].tsx', '[id]-x.tsx', 'i.tsx', 'd.tsx'];
    assert.deepEqual(await synced(t, files, { include: ['[id].tsx'] }), ['[id].tsx', 'x/[id].tsx']);
    assert.deepEqual(await synced(t, files, { include: ['[id]*.tsx'] }), ['[id]-x.tsx', '[id].tsx', 'x/[id].tsx']);
  });
});

describe('a pattern of another form is refused when the module is built', () => {
  const mount = (ignore: unknown): MountConfig => ({ name: 'work', path: '/tmp/x', mode: 'read-write', ignore } as MountConfig);

  test('each refusal names the mount, the pattern and why, then the forms the list reads', () => {
    const cases: Array<[unknown, string]> = [
      ['!dist', 'a leading "!" makes an exception in a .gitignore, and this list has none, so leave it out'],
      ['#build', 'a leading "#" marks a comment in a .gitignore, so leave comments out of the list'],
      ['a\\b', '"\\" is an escape in a .gitignore and a separator on Windows, so no pattern here holds one, and "?" stands for one in a name'],
      ['[ab].txt', '"[" starts a character class in a .gitignore, which this list doesn\'t read, so write each name out, with "?" for a "[" in it'],
      ['dist ', 'a .gitignore drops trailing spaces, so remove them'],
      ['**', '"**" is read only as a leading "**/" before one name, or a trailing "/**"'],
      ['a/**/b', '"**" is read only as a leading "**/" before one name, or a trailing "/**"'],
      ['**/a/b', '"**" is read only as a leading "**/" before one name, or a trailing "/**"'],
      ['', 'it has an empty, "." or ".." segment, which names no entry'],
      ['/', 'it has an empty, "." or ".." segment, which names no entry'],
      ['/**', 'it has an empty, "." or ".." segment, which names no entry'],
      ['a//b', 'it has an empty, "." or ".." segment, which names no entry'],
      ['a/../b', 'it has an empty, "." or ".." segment, which names no entry'],
      [1n, "it isn't a string"],
      [undefined, "it isn't a string"],
    ];
    for (const [pattern, why] of cases) {
      const shown = typeof pattern === 'bigint' ? '1n' : JSON.stringify(pattern) ?? String(pattern);
      assert.throws(() => new WorkspaceModule({ mounts: [mount(['node_modules', pattern])] }), (err: unknown) => err instanceof Error
        && err.message === `[workspace] Mount "work": ignore pattern ${shown} isn't read: ${why}. ${FORMS}`, shown);
    }
    const include: MountConfig = { name: 'work', path: '/tmp/x', mode: 'read-write', include: ['gate.json', '!gate.json'] };
    assert.throws(() => new WorkspaceModule({ mounts: [include] }), (err: unknown) => err instanceof Error
      && err.message === `[workspace] Mount "work": include pattern "!gate.json" isn't read: ${cases[0]![1]}. ${FORMS}`, 'include');
  });

  test('ignore may be empty, and must be a list', () => {
    for (const ok of [[], ['node_modules/', '/dist', 'a/b', '**/x', '*.log', 'te?t', 'build/**', 'src/*.ts', '*']]) {
      assert.doesNotThrow(() => new WorkspaceModule({ mounts: [mount(ok)] }), JSON.stringify(ok));
    }
    for (const bad of ['node_modules', null, {}]) {
      assert.throws(() => new WorkspaceModule({ mounts: [mount(bad)] }), (err: unknown) => err instanceof Error
        && err.message === `[workspace] Mount "work": ignore must be a list of patterns, not ${JSON.stringify(bad)}`, String(bad));
    }
  });
});
