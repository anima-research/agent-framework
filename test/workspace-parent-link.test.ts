/**
 * A mount that doesn't follow symlinks follows none among a path's parent
 * directories either. A link there, wherever it leads, makes the path
 * unobserved: no push writes, creates or unlinks a file through it, no sync
 * reads through it, and no read from disk returns its bytes. Before, an
 * inside link among the parents was followed, so the workspace acted on a
 * file under another path than the one it named: a deletion's push unlinked
 * the file behind the link, a write created or overwrote one there, and a
 * sync took its bytes in. A link among the parents that leads out of the
 * mount was refused before as well, and now gets the link's own answer. The
 * refusal names the link, and where it leads only where a tool could name
 * that: on a mount with an include, nothing of where a link the include
 * leaves out leads, and no target the include leaves out. Each kind of link
 * gets its own way on: for a link to a directory inside the mount, the path
 * to use in its place; for one leading out of the mount, nowhere, or to
 * something that isn't a directory, what gets past it. A mount that follows
 * links keeps following an inside one, and a root that is itself a link is
 * still the root.
 */

import { execFileSync } from 'node:child_process';
import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { checkDir, confirmAbsent, observePath, readPath, type MountView } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';

const TREE = 'workspace/work/tree';
/** The refusal of a path through the link at "work/l", wherever it leads. */
const LINKED = /"work\/l" is a symlink(?: to "work\/elsewhere"| leading outside the mount), which this mount does not follow/;

/**
 * The refusal of a path through the link at "work/l", exactly: for a link to
 * `elsewhere/`, naming it as the path to use, and the setting whoever runs
 * the host can change; for one leading out of the mount, saying so, and
 * where what it leads to can be named. Paths are spelled as the tools take
 * them.
 */
function linkedReason(target: 'inside' | 'outside'): string {
  return target === 'inside'
    ? '"work/l" is a symlink to "work/elsewhere", which this mount does not follow; use "work/elsewhere" in place of "work/l", or whoever runs this host can set followSymlinks: true on mount "work"'
    : '"work/l" is a symlink leading outside the mount, which this mount does not follow; followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it';
}

/**
 * The code a disk reader gives a path through the link at "work/l": as on
 * main, `escape` for a link leading outside the mount, so a caller choosing
 * advice by code gets the outside advice; `parent_symlink` for one inside it,
 * apart from `symlink`, a file that is itself a link.
 */
function linkedCode(target: 'inside' | 'outside'): 'parent_symlink' | 'escape' {
  return target === 'inside' ? 'parent_symlink' : 'escape';
}

/**
 * A materialize's refusal before it pushes, for a note that names its own way
 * on: the note alone, with no force.
 */
function unverified(path: string, note: string): string {
  return `${path}: cannot verify disk copy (${note})`;
}

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-parent-link-'));
  readonly dir = join(this.root, 'work');
  store: JsStore;

  constructor(t: TestContext, dir?: string) {
    if (dir !== undefined) this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
    this.store = JsStore.openOrCreate({ path: join(this.root, 'ws.chronicle') });
    t.after(async () => {
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  async open(t: TestContext, mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', autoMaterialize: false, ...mount }] });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    t.after(() => m.stop().catch(() => {}));
    return m;
  }

  view(): MountView {
    // Cast, so the file also compiles against main's MountView, which has no
    // name, for the run of these tests on main's code.
    return { root: this.dir, name: 'work', followSymlinks: false, maxFileSize: 1 << 20, ignore: [], others: [] } as MountView;
  }

  writeDisk(path: string, content: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  /**
   * Replace the directory `l` with a link to a directory holding `x.txt`:
   * `elsewhere/` inside the mount, or `outside/` beside it. Returns the
   * directory the link leads to.
   */
  swapLForLink(target: 'inside' | 'outside', bytes = 'behind the link\n'): string {
    rmSync(join(this.dir, 'l'), { recursive: true, force: true });
    const away = target === 'inside' ? join(this.dir, 'elsewhere') : join(this.root, 'outside');
    mkdirSync(away, { recursive: true });
    writeFileSync(join(away, 'x.txt'), bytes);
    symlinkSync(away, join(this.dir, 'l'));
    return away;
  }
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<any> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, true, `${name} ${JSON.stringify(input)} failed: ${res.error}`);
  return res.structured ?? res.data;
}

/** Run `fn` with node:fs/promises' `name` replaced by `make(original)`, as the code under test sees it. */
async function withFsPromises<T>(name: 'realpath' | 'readlink' | 'lstat', make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>, fn: () => Promise<T>): Promise<T> {
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

/** The skipped reason for a path in a materialize's or a sync's result. */
function skippedReason(data: any, path: string): string {
  const entry = ((data.skipped ?? []) as Array<{ path?: string; reason: string }>)
    .find((s) => s.path === path || s.reason.startsWith(`${path}: `));
  assert.ok(entry, `nothing skipped for ${path}: ${JSON.stringify(data)}`);
  return entry.reason;
}

/** An observation's kind and reason, for an assertion's message. */
function shown(v: { kind: string; reason?: string }): string {
  return `${v.kind}${v.reason === undefined ? '' : `: ${v.reason}`}`;
}

describe('a symlinked parent on a mount that does not follow symlinks', () => {
  for (const target of ['inside', 'outside'] as const) {
    test(`a workspace deletion is not applied through it, forced or not (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'behind the link\n');
      const m = await env.open(t);
      await call(m, 'read', { path: 'work/l/x.txt' });
      await call(m, 'delete', { path: 'work/l/x.txt' });
      const away = env.swapLForLink(target);
      for (const force of [false, true]) {
        const data = await call(m, 'materialize', { path: 'work/l/x.txt', applyDeletions: true, force });
        assert.deepEqual(data.deleted ?? [], [], `force ${force}: nothing was deleted`);
        const reason = skippedReason(data, 'l/x.txt');
        if (force) assert.match(reason, LINKED, 'forced');
        else assert.equal(reason, unverified('l/x.txt', linkedReason(target)));
        assert.equal(readFileSync(join(away, 'x.txt'), 'utf8'), 'behind the link\n', `force ${force}: the file behind the link stays`);
      }
    });

    test(`no file is created through it, forced or not (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      await call(m, 'write', { path: 'work/l/new.txt', content: 'created\n' });
      const away = env.swapLForLink(target);
      for (const force of [false, true]) {
        const data = await call(m, 'materialize', { path: 'work/l/new.txt', force });
        assert.deepEqual(data.materialized, [], `force ${force}: nothing was written`);
        assert.equal(skippedReason(data, 'l/new.txt'), force ? `l/new.txt: not written: ${linkedReason(target)}` : unverified('l/new.txt', linkedReason(target)));
        assert.equal(existsSync(join(away, 'new.txt')), false, `force ${force}: nothing appeared behind the link`);
      }
    });

    test(`an edit is not written through it, forced or not, and the unforced refusal names the link and offers no force (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      await call(m, 'read', { path: 'work/l/x.txt' });
      await call(m, 'write', { path: 'work/l/x.txt', content: 'v2\n' });
      const away = env.swapLForLink(target, 'v1\n');
      const unforced = skippedReason(await call(m, 'materialize', { path: 'work/l/x.txt' }), 'l/x.txt');
      assert.equal(unforced, unverified('l/x.txt', linkedReason(target)));
      const forced = await call(m, 'materialize', { path: 'work/l/x.txt', force: true });
      assert.deepEqual(forced.materialized, []);
      assert.match(skippedReason(forced, 'l/x.txt'), LINKED);
      assert.equal(readFileSync(join(away, 'x.txt'), 'utf8'), 'v1\n', 'the file behind the link is as it was');
    });

    test(`write, edit and delete on a mount with autoMaterialize report their push refused, and nothing behind the link changes (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t, { autoMaterialize: true });
      await call(m, 'read', { path: 'work/l/x.txt' });
      const away = env.swapLForLink(target, 'v1\n');
      const refused = async (name: string, input: Record<string, unknown>) => {
        const res = await m.handleToolCall({ id: name, name, input });
        assert.equal(res.success, false, `${name} pushed through the link`);
        assert.ok(String(res.error).includes(linkedReason(target)), `${name}: ${res.error}`);
        assert.doesNotMatch(String(res.error), /pass force/, name);
      };
      await refused('write', { path: 'work/l/new.txt', content: 'created\n' });
      await refused('edit', { path: 'work/l/x.txt', oldString: 'v1', newString: 'v2' });
      await refused('delete', { path: 'work/l/x.txt' });
      assert.equal(existsSync(join(away, 'new.txt')), false, 'nothing was created behind the link');
      assert.equal(readFileSync(join(away, 'x.txt'), 'utf8'), 'v1\n', 'the file behind the link is as it was');
    });

    test(`an explicit sync doesn't read through it, and history keeps its copy (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      await call(m, 'read', { path: 'work/l/x.txt' });
      const before = env.store.treeGet(TREE, 'l/x.txt')!.blobHash;
      env.swapLForLink(target, 'other bytes\n');
      const data = await call(m, 'sync', { path: 'work/l/x.txt' });
      assert.ok(skippedReason(data, 'l/x.txt').endsWith(linkedReason(target)), skippedReason(data, 'l/x.txt'));
      assert.equal(env.store.treeGet(TREE, 'l/x.txt')?.blobHash, before, 'history holds what it held');
    });

    test(`readFileFromDisk and read_image refuse a path through it, naming the link and where it leads, with the code for where it leads (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      const away = env.swapLForLink(target);
      await assert.rejects(m.readFileFromDisk('work/l/x.txt'), (err: unknown) => {
        assert.ok(err instanceof WorkspaceReadError, String(err));
        assert.equal(err.code, linkedCode(target));
        assert.equal(err.message, `work/l/x.txt: ${linkedReason(target)}`);
        return true;
      });
      writeFileSync(join(away, 'img.png'), 'not read');
      const image = await m.handleToolCall({ id: 'i', name: 'read_image', input: { path: 'work/l/img.png' } });
      assert.equal(image.success, false);
      assert.equal(image.error, `The read_image did nothing: "work/l/img.png" can't be reached: ${linkedReason(target)}.`);
    });

    test(`read_image gives the link's refusal, not the workspace copy's failure, where that copy can't be read as an image (${target})`, async (t) => {
      // read_image tries the workspace's copy first. Where that read throws,
      // a disk refusal that came back as not_found would give way to the
      // copy's error, so the refusal keeps its own code.
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      await call(m, 'write', { path: 'work/l/img.png', content: 'not an image\n' });
      const away = env.swapLForLink(target);
      writeFileSync(join(away, 'img.png'), 'not read');
      const image = await m.handleToolCall({ id: 'i', name: 'read_image', input: { path: 'work/l/img.png' } });
      assert.equal(image.success, false);
      assert.equal(image.error, `The read_image did nothing: "work/l/img.png" can't be reached: ${linkedReason(target)}.`);
    });

    test(`a listing of the directory the link stands at says so instead of walking it (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      env.swapLForLink(target);
      const data = await call(m, 'ls', { path: 'work/l', recursive: true });
      assert.deepEqual(data.entries, []);
      assert.deepEqual(data.incomplete, [{ path: 'l', reason: linkedReason(target) }]);
    });

    test(`each primitive that finds a parent refuses it with the link's reason, whatever lies behind it (${target})`, async (t) => {
      // Each check sits at the point of use, so each is asked here directly:
      // through the tools, an earlier one usually answers first.
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const away = env.swapLForLink(target);
      mkdirSync(join(away, 'sub'));
      const view = env.view();
      const rootReal = realpathSync(env.dir);
      const dir = await checkDir(view, rootReal, 'l');
      assert.equal(shown(dir), `unobserved: ${linkedReason(target)}`, 'checkDir');
      const seen = await observePath(view, rootReal, 'l/x.txt');
      assert.equal(shown(seen), `unobserved: ${linkedReason(target)}`, 'observePath');
      const read = await readPath(view, rootReal, 'l/x.txt', 1 << 20);
      assert.equal(shown(read), `unobserved: ${linkedReason(target)}`, 'readPath');
      const readDir = await readPath(view, rootReal, 'l/sub', 1 << 20);
      assert.equal(shown(readDir), `unobserved: ${linkedReason(target)}`, 'readPath of a directory behind the link');
      const absent = await confirmAbsent(view, rootReal, 'l/nothing.txt') as unknown as { reason?: string };
      assert.equal(absent.reason, linkedReason(target), 'confirmAbsent');
    });

    test(`a ".." after a name that isn't there hides no link beyond it (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      env.swapLForLink(target);
      const expected = `work/nope/../l/x.txt: ${linkedReason(target)}`;
      await assert.rejects(m.readFileFromDisk('work/nope/../l/x.txt'), (err: unknown) => {
        assert.ok(err instanceof WorkspaceReadError, String(err));
        assert.equal(err.code, linkedCode(target));
        assert.equal(err.message, expected);
        return true;
      });
      assert.deepEqual(await m.readBinaryFromDisk('work/nope/../l/x.txt'), { error: expected });
      const seen = await observePath(env.view(), realpathSync(env.dir), 'nope/../l/x.txt');
      assert.equal(shown(seen), `unobserved: ${linkedReason(target)}`, 'observePath');
    });
  }

  test('a link to a directory beside the mount whose name starts with the mount\'s is outside it', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    rmSync(join(env.dir, 'l'), { recursive: true });
    mkdirSync(`${env.dir}-beside`);
    writeFileSync(join(`${env.dir}-beside`, 'x.txt'), 'beside\n');
    t.after(() => rmSync(`${env.dir}-beside`, { recursive: true, force: true }));
    symlinkSync(`${env.dir}-beside`, join(env.dir, 'l'));
    const seen = await observePath(env.view(), realpathSync(env.dir), 'l/x.txt');
    assert.equal(shown(seen), `unobserved: ${linkedReason('outside')}`);
  });

  test('a link to a file inside the mount names its target, and not the setting, which following it wouldn\'t answer', async (t) => {
    const env = new Env(t);
    env.writeDisk('file.txt', 'v1\n');
    symlinkSync(join(env.dir, 'file.txt'), join(env.dir, 'l'));
    const m = await env.open(t);
    const reason = '"work/l" is a symlink to "work/file.txt", which this mount does not follow; that isn\'t a directory, so nothing lies beneath it';
    const seen = await observePath(env.view(), realpathSync(env.dir), 'l/x.txt');
    assert.equal(shown(seen), `unobserved: ${reason}`);
    await assert.rejects(m.readFileFromDisk('work/l/x.txt'), (err: unknown) => {
      assert.ok(err instanceof WorkspaceReadError, String(err));
      assert.equal(err.code, 'parent_symlink');
      assert.equal(err.message, `work/l/x.txt: ${reason}`);
      return true;
    });
  });

  test('a disk reader through a link to a FIFO names it without the setting, and through a link to the root names the mount with it', async (t) => {
    const env = new Env(t);
    env.writeDisk('x.txt', 'v1\n');
    symlinkSync(env.dir, join(env.dir, 'r'));
    const reasons: Array<[string, string]> = [
      ['work/r/x.txt', 'work/r/x.txt: "work/r" is a symlink to "work", which this mount does not follow; use "work" in place of "work/r", or whoever runs this host can set followSymlinks: true on mount "work"'],
    ];
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(env.dir, 'pipe')]);
      symlinkSync(join(env.dir, 'pipe'), join(env.dir, 'f'));
      reasons.push(['work/f/x.txt', 'work/f/x.txt: "work/f" is a symlink to "work/pipe", which this mount does not follow; that isn\'t a directory, so nothing lies beneath it']);
    }
    const m = await env.open(t);
    for (const [path, reason] of reasons) {
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) => {
        assert.ok(err instanceof WorkspaceReadError, String(err));
        assert.equal(err.code, 'parent_symlink', path);
        assert.equal(err.message, reason);
        return true;
      });
    }
  });

  test('a link to the mount\'s root names the mount as its target', async (t) => {
    const env = new Env(t);
    env.writeDisk('x.txt', 'v1\n');
    symlinkSync(env.dir, join(env.dir, 'l'));
    const seen = await observePath(env.view(), realpathSync(env.dir), 'l/x.txt');
    assert.equal(shown(seen), 'unobserved: "work/l" is a symlink to "work", which this mount does not follow; use "work" in place of "work/l", or whoever runs this host can set followSymlinks: true on mount "work"');
  });

  test('a link into a nested mount\'s directory names the path to use in that mount, as other_mount, and not the setting, which would only reach into it', async (t) => {
    const env = new Env(t);
    env.writeDisk('nested/sub/x.txt', 'inner\n');
    symlinkSync('nested/sub', join(env.dir, 'l'));
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', autoMaterialize: true },
      { name: 'inner', path: join(env.dir, 'nested'), mode: 'read-write', watch: 'never', autoMaterialize: true },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    t.after(() => m.stop().catch(() => {}));
    const reason = '"work/l" is a symlink to "work/nested/sub", which this mount does not follow; it lies in mount "inner", nested in mount "work": use "inner/sub" in place of "work/l"';
    await assert.rejects(m.readFileFromDisk('work/l/x.txt'), (err: unknown) => {
      assert.ok(err instanceof WorkspaceReadError, String(err));
      // The code a path in the nested mount's directory gets (#460), so a host
      // that maps parent_symlink to the setting can't offer it here.
      assert.equal(err.code, 'other_mount');
      assert.equal(err.message, `work/l/x.txt: ${reason}`);
      return true;
    });
    const res = await m.handleToolCall({ id: 't', name: 'write', input: { path: 'work/l/new.txt', content: 'via work\n' } });
    assert.equal(res.success, false);
    assert.ok(String(res.error).includes(reason), String(res.error));
    assert.ok(!String(res.error).includes('followSymlinks'), String(res.error));
    assert.equal(existsSync(join(env.dir, 'nested', 'sub', 'new.txt')), false);
    // read_image gives the refusal too: the file tools refuse a path that
    // leads into a nested mount before looking for the workspace's copy.
    const image = await m.handleToolCall({ id: 'i', name: 'read_image', input: { path: 'work/l/img.png' } });
    assert.equal(image.success, false);
    assert.equal(image.error, `The read_image did nothing: "work/l/img.png" can't be reached: ${reason}.`);
  });

  test('a path that resolves to another spelling of itself, with no link on its way, is reached by each primitive', async (t) => {
    // On macOS or Windows, realpath spells a name as disk does, its case or
    // its Unicode normalization, where the path may spell it otherwise. That
    // other string is no symlink. Linux has no such spelling, so each answer
    // beneath the root is respelled here with a `.` after the root, which
    // still names the same file.
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const view = env.view();
    const rootReal = realpathSync(env.dir);
    const respell = (real: string) => (real.startsWith(rootReal + sep) ? `${rootReal}${sep}.${real.slice(rootReal.length)}` : real);
    await withFsPromises('realpath', (realpath) => async (...args: any[]) => respell(await realpath(...args)), async () => {
      assert.equal((await checkDir(view, rootReal, 'l')).kind, 'checked', 'checkDir');
      assert.equal((await observePath(view, rootReal, 'l/x.txt')).kind, 'file', 'observePath');
      assert.equal((await readPath(view, rootReal, 'l/x.txt', 1 << 20)).kind, 'read', 'readPath');
    });
  });

  for (const code of ['EIO', 'EPERM']) {
    test(`a directory on the way the walk can't ask whether it's a symlink (${code}) refuses the path, rather than letting a link beneath it through`, async (t) => {
      // EPERM too: only a directory this user can't search (EACCES) ends the
      // walk, since the caller's own lookup is then refused the same way.
      const env = new Env(t);
      env.writeDisk('elsewhere/x.txt', 'behind the link\n');
      env.writeDisk('elsewhere/img.png', 'not read');
      mkdirSync(join(env.dir, 'a'));
      symlinkSync(join(env.dir, 'elsewhere'), join(env.dir, 'a', 'l'));
      const m = await env.open(t);
      await call(m, 'write', { path: 'work/a/l/new.txt', content: 'new\n' });
      const failure = Object.assign(new Error(`${code}: readlink`), { code });
      const unsure = `cannot tell whether "work/a" is a symlink (${code === 'EIO'
        ? 'an input/output error on the disk); calling again may get past it; if it fails the same way, whoever runs this host can check the disk'
        : "not permitted); calling again won't change that; whoever runs this host can change the permissions, and calling again then gets past it"}`;
      await withFsPromises('readlink', (readlink) => async (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith(`${sep}a`)) throw failure;
        return readlink(path, ...rest);
      }, async () => {
        await assert.rejects(m.readFileFromDisk('work/a/l/x.txt'), (err: unknown) => {
          assert.ok(err instanceof WorkspaceReadError, String(err));
          assert.equal(err.code, 'not_found');
          assert.equal(err.errno, code);
          assert.equal(err.message, `Unable to read file: work/a/l/x.txt: ${unsure}`);
          return true;
        });
        const image = await m.handleToolCall({ id: 'i', name: 'read_image', input: { path: 'work/a/l/img.png' } });
        assert.equal(image.error, `The read_image did nothing: "work/a/l/img.png" can't be reached: ${unsure}.`, 'read_image passes the walk\'s words through');
        const dir = await checkDir(env.view(), realpathSync(env.dir), 'a/l');
        assert.equal(shown(dir), `unobserved: ${unsure}`);
        // A materialize gives the same reason, with its own way on, and no
        // force, which the push would refuse too.
        const pushed = await call(m, 'materialize', { path: 'work/a/l/new.txt' });
        assert.equal(skippedReason(pushed, 'a/l/new.txt'), unverified('a/l/new.txt', unsure));
      });
    });
  }

  test('a symlink on the way that leads nowhere, or loops, is named as one wherever it is met', async (t) => {
    const env = new Env(t);
    env.writeDisk('x.txt', 'v1\n');
    const m = await env.open(t);
    await call(m, 'write', { path: 'work/gone/new.txt', content: 'new\n' });
    await call(m, 'write', { path: 'work/loop/new.txt', content: 'new\n' });
    symlinkSync(join(env.dir, 'nothing-here'), join(env.dir, 'gone'));
    symlinkSync('loop', join(env.dir, 'loop'));
    const view = env.view();
    const rootReal = realpathSync(env.dir);
    for (const name of ['gone', 'loop']) {
      const reason = `"work/${name}" is a symlink that leads nowhere, which this mount does not follow; whoever runs this host can remove it or make it lead to what it stood for`;
      // Each primitive, asked directly, names it.
      assert.equal(shown(await checkDir(view, rootReal, name)), `unobserved: ${reason}`, `${name}: checkDir`);
      assert.equal(shown(await observePath(view, rootReal, `${name}/x.txt`)), `unobserved: ${reason}`, `${name}: observePath`);
      assert.equal(shown(await readPath(view, rootReal, `${name}/x.txt`, 1 << 20)), `unobserved: ${reason}`, `${name}: readPath`);
      const absent = await confirmAbsent(view, rootReal, `${name}/x.txt`) as unknown as { reason?: string };
      assert.equal(absent.reason, reason, `${name}: confirmAbsent`);
      const unforced = await call(m, 'materialize', { path: `work/${name}/new.txt` });
      assert.equal(skippedReason(unforced, `${name}/new.txt`), unverified(`${name}/new.txt`, reason), `${name}, unforced`);
      // Forced, the push makes the directories on the way: the link in the
      // way is named there too, not taken for a file.
      const forced = await call(m, 'materialize', { path: `work/${name}/new.txt`, force: true });
      assert.equal(skippedReason(forced, `${name}/new.txt`), `${name}/new.txt: not written: ${reason}`, `${name}, forced`);
      await assert.rejects(m.readFileFromDisk(`work/${name}/x.txt`), (err: unknown) => {
        assert.ok(err instanceof WorkspaceReadError, String(err));
        assert.equal(err.code, 'parent_symlink');
        assert.equal(err.message, `work/${name}/x.txt: ${reason}`);
        return true;
      });
    }
    assert.equal(existsSync(join(env.dir, 'nothing-here')), false, 'nothing was made where the link leads');
  });

  test('a directory swapped for a link after the walk is caught by the reader after the open', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    env.writeDisk('elsewhere/x.txt', 'behind the link\n');
    const m = await env.open(t);
    let swapped = false;
    await withFsPromises('lstat', (lstat) => async (path: string, ...rest: unknown[]) => {
      // The reader's lstat of the path comes after its walk: the directory
      // becomes a link between the two.
      if (!swapped && String(path) === join(env.dir, 'l', 'x.txt')) {
        swapped = true;
        renameSync(join(env.dir, 'l'), join(env.dir, 'l-was'));
        symlinkSync(join(env.dir, 'elsewhere'), join(env.dir, 'l'));
      }
      return lstat(path, ...rest);
    }, async () => {
      await assert.rejects(m.readFileFromDisk('work/l/x.txt'), (err: unknown) => {
        assert.ok(err instanceof WorkspaceReadError, String(err));
        assert.equal(err.code, 'parent_symlink');
        assert.equal(err.message, `work/l/x.txt: ${linkedReason('inside')}`);
        return true;
      });
    });
    assert.equal(swapped, true);
  });

  test('a symlink at the path itself gets no advice to pass force, which a forced push refuses too', async (t) => {
    const env = new Env(t);
    env.writeDisk('f.txt', 'v1\n');
    env.writeDisk('elsewhere/f.txt', 'behind the link\n');
    const m = await env.open(t);
    await call(m, 'read', { path: 'work/f.txt' });
    await call(m, 'write', { path: 'work/f.txt', content: 'v2\n' });
    rmSync(join(env.dir, 'f.txt'));
    symlinkSync(join(env.dir, 'elsewhere', 'f.txt'), join(env.dir, 'f.txt'));
    const link = 'disk has a symlink at this path, which this mount does not follow, and no push writes through one, forced or not — '
      + 'write the file under another path, or whoever runs this host can remove the link, and materializing again then gets past it';
    assert.equal(skippedReason(await call(m, 'materialize', { path: 'work/f.txt' }), 'f.txt'), `f.txt: ${link}`);
    assert.equal(skippedReason(await call(m, 'materialize', { path: 'work/f.txt', force: true }), 'f.txt'), `f.txt: not written: ${link}`);
    assert.equal(readFileSync(join(env.dir, 'elsewhere', 'f.txt'), 'utf8'), 'behind the link\n');
  });

  test('readBinaryFromDisk reads nothing through a link: the file itself leading out, a parent leading out, or a parent inside', async (t) => {
    const env = new Env(t);
    const outside = join(env.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SENTINEL');
    env.writeDisk('elsewhere/x.txt', 'INSIDE_TARGET');
    symlinkSync(join(outside, 'secret.txt'), join(env.dir, 'file-link.txt'));
    symlinkSync(outside, join(env.dir, 'out'));
    symlinkSync(join(env.dir, 'elsewhere'), join(env.dir, 'in'));
    const m = await env.open(t);
    assert.deepEqual(await m.readBinaryFromDisk('work/file-link.txt'), { error: 'Symlinks are not allowed: work/file-link.txt' });
    assert.deepEqual(await m.readBinaryFromDisk('work/out/secret.txt'), {
      error: 'work/out/secret.txt: "work/out" is a symlink leading outside the mount, which this mount does not follow; followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it',
    });
    assert.deepEqual(await m.readBinaryFromDisk('work/in/x.txt'), {
      error: 'work/in/x.txt: "work/in" is a symlink to "work/elsewhere", which this mount does not follow; use "work/elsewhere" in place of "work/in", or whoever runs this host can set followSymlinks: true on mount "work"',
    });
  });

  test('a regular parent directory is still read and written as before', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const m = await env.open(t);
    await call(m, 'read', { path: 'work/l/x.txt' });
    await call(m, 'write', { path: 'work/l/x.txt', content: 'v2\n' });
    assert.deepEqual((await call(m, 'materialize', { path: 'work/l/x.txt' })).materialized.map((e: { path: string }) => e.path), ['l/x.txt']);
    assert.equal(readFileSync(join(env.dir, 'l/x.txt'), 'utf8'), 'v2\n');
    assert.equal((await m.readFileFromDisk('work/l/x.txt')).bytes.toString(), 'v2\n');
  });
});

describe('a deletion whose evidence holds no agreed disk copy', () => {
  // A push applies what the store changed since disk last agreed. Where the
  // agreement holds no copy, deleting the entry puts the store back at it,
  // so nothing on disk is the workspace's to unlink and no proof of absence
  // is owed, which a path beneath a link the mount doesn't follow could never
  // give. Before, such a deletion kept a tombstone no tool could clear while
  // the link stood.
  const pending = async (m: WorkspaceModule) => {
    const { pendingChanges, pendingWorkspaceDeletions } = (await call(m, 'status', {})).work;
    return { pendingChanges, pendingWorkspaceDeletions };
  };

  for (const target of ['inside', 'outside'] as const) {
    test(`a write through the link is refused, deleting the entry clears it, and nothing is pending (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t, { autoMaterialize: true });
      const away = env.swapLForLink(target);
      const write = await m.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/l/new.txt', content: 'new\n' } });
      assert.equal(write.success, false, 'the write pushed through the link');
      assert.ok(String(write.error).includes(linkedReason(target)), String(write.error));
      assert.deepEqual(await pending(m), { pendingChanges: 1, pendingWorkspaceDeletions: 0 }, 'the refused write is owed');
      assert.deepEqual(await call(m, 'delete', { path: 'work/l/new.txt' }), { path: 'work/l/new.txt', deleted: true, disk: 'done' });
      assert.deepEqual(await pending(m), { pendingChanges: 0, pendingWorkspaceDeletions: 0 });
      const pushed = await call(m, 'materialize', { path: 'work/l/new.txt', applyDeletions: true });
      assert.deepEqual([pushed.materialized, pushed.deleted ?? [], pushed.skipped ?? []], [[], [], []], JSON.stringify(pushed));
      assert.equal(existsSync(join(away, 'new.txt')), false, 'nothing appeared behind the link');
    });
  }

  test('a file disk last agreed it had deleted, written again and deleted beneath a link, leaves nothing pending', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const m = await env.open(t);
    await call(m, 'read', { path: 'work/l/x.txt' });
    await call(m, 'delete', { path: 'work/l/x.txt' });
    assert.deepEqual((await call(m, 'materialize', { path: 'work/l/x.txt', applyDeletions: true })).deleted.map((e: { path: string }) => e.path), ['l/x.txt']);
    const away = env.swapLForLink('inside');
    await call(m, 'write', { path: 'work/l/x.txt', content: 'v2\n' });
    await call(m, 'delete', { path: 'work/l/x.txt' });
    assert.deepEqual(await pending(m), { pendingChanges: 0, pendingWorkspaceDeletions: 0 });
    assert.equal(readFileSync(join(away, 'x.txt'), 'utf8'), 'behind the link\n');
  });

  test('a deletion of a copy disk agreed with keeps its tombstone beneath a link, and unlinks nothing', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const m = await env.open(t);
    await call(m, 'read', { path: 'work/l/x.txt' });
    const away = env.swapLForLink('inside', 'v1\n');
    await call(m, 'delete', { path: 'work/l/x.txt' });
    assert.deepEqual(await pending(m), { pendingChanges: 1, pendingWorkspaceDeletions: 1 });
    const pushed = await call(m, 'materialize', { path: 'work/l/x.txt', applyDeletions: true });
    assert.deepEqual(pushed.deleted ?? [], []);
    assert.equal(readFileSync(join(away, 'x.txt'), 'utf8'), 'v1\n', 'the file behind the link stays');
    assert.deepEqual(await pending(m), { pendingChanges: 1, pendingWorkspaceDeletions: 1 }, 'still guarded');
  });

  test('a draft written over a disk file the workspace never saw, then deleted, leaves that file alone and nothing pending', async (t) => {
    // Its push met a file it never saw (a recorded store-origin-collision).
    // Deleting the draft gives up the workspace's side, so the conflict has
    // nothing left to be about: disk's file is a sync's to observe.
    const env = new Env(t);
    env.writeDisk('c.txt', 'disk text\n');
    const m = await env.open(t, { autoMaterialize: true });
    const write = await m.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/c.txt', content: 'agent text\n' } });
    assert.equal(write.success, false, 'the draft pushed over a file it never saw');
    assert.match(String(write.error), /store-origin-collision/);
    // Its answer says that file wasn't unlinked, where 'deleted' alone would
    // read as gone from disk, and a result the guard withholds keeps it.
    const deleted = await m.handleToolCall({ id: 'd', name: 'delete', input: { path: 'work/c.txt' } });
    assert.equal(deleted.success, true, String(deleted.error));
    assert.deepEqual(deleted.data, {
      path: 'work/c.txt',
      deleted: true,
      disk: 'done',
      note: 'nothing was unlinked: when last observed, disk held a file at work/c.txt that the workspace never took in '
        + '(conflict: store-origin-collision), and a sync observes whatever disk holds there',
    });
    const { pendingChanges, conflicts, pendingWorkspaceDeletions } = (await call(m, 'status', {})).work;
    assert.deepEqual({ pendingChanges, conflicts, pendingWorkspaceDeletions }, { pendingChanges: 0, conflicts: 0, pendingWorkspaceDeletions: 0 });
    assert.equal(readFileSync(join(env.dir, 'c.txt'), 'utf8'), 'disk text\n', 'disk keeps its file');
    await call(m, 'sync', { path: 'work/c.txt' });
    assert.match((await call(m, 'read', { path: 'work/c.txt' })).content, /disk text/, 'a sync takes it in');
  });

  test('a file disk agreed it had deleted, written again while disk got another, then deleted, leaves disk\'s file and says so', async (t) => {
    // P is absent, and the workspace's copy and disk's new file both changed
    // since (a recorded both-changed conflict). The deletion gives up the
    // workspace's side: nothing is unlinked, and disk's file is a sync's.
    const env = new Env(t);
    env.writeDisk('x.txt', 'v1\n');
    const m = await env.open(t);
    await call(m, 'read', { path: 'work/x.txt' });
    await call(m, 'delete', { path: 'work/x.txt' });
    assert.deepEqual((await call(m, 'materialize', { path: 'work/x.txt', applyDeletions: true })).deleted.map((e: { path: string }) => e.path), ['x.txt']);
    await call(m, 'write', { path: 'work/x.txt', content: 'agent\n' });
    env.writeDisk('x.txt', 'someone else\n');
    assert.match(skippedReason(await call(m, 'materialize', { path: 'work/x.txt' }), 'x.txt'), /conflict: both-changed/);
    assert.deepEqual(await call(m, 'delete', { path: 'work/x.txt' }), {
      path: 'work/x.txt',
      deleted: true,
      disk: 'done',
      note: 'nothing was unlinked: when last observed, disk held a file at work/x.txt that the workspace never took in '
        + '(conflict: both-changed), and a sync observes whatever disk holds there',
    });
    const { pendingChanges, conflicts, pendingWorkspaceDeletions } = (await call(m, 'status', {})).work;
    assert.deepEqual({ pendingChanges, conflicts, pendingWorkspaceDeletions }, { pendingChanges: 0, conflicts: 0, pendingWorkspaceDeletions: 0 });
    assert.equal(readFileSync(join(env.dir, 'x.txt'), 'utf8'), 'someone else\n');
  });

  test('a deletion that clears a conflict naming no disk file answers without a note', async (t) => {
    // This branch records that disk lost the file it had changed (a
    // deleted-on-disk conflict, with no disk file). Another branch's pass
    // then records that disk has nothing there, so this branch's deletion
    // clears its intent, conflict and all. Disk held no file to leave alone,
    // so the answer says nothing of one.
    const env = new Env(t);
    env.writeDisk('x.txt', 'v1\n');
    const m = await env.open(t);
    await call(m, 'read', { path: 'work/x.txt' });
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    await call(m, 'write', { path: 'work/x.txt', content: 'agent\n' });
    rmSync(join(env.dir, 'x.txt'));
    assert.match(skippedReason(await call(m, 'materialize', { path: 'work/x.txt' }), 'x.txt'), /conflict: deleted-on-disk/);
    env.store.switchBranch('other');
    await call(m, 'sync', { path: 'work/x.txt' });
    assert.equal((m as any).agreement.get('work', 'x.txt')?.kind, 'absent', 'the other branch recorded disk\'s absence');
    env.store.switchBranch(main);
    assert.deepEqual(await call(m, 'delete', { path: 'work/x.txt' }), { path: 'work/x.txt', deleted: true, disk: 'done' });
    const { pendingChanges, conflicts, pendingWorkspaceDeletions } = (await call(m, 'status', {})).work;
    assert.deepEqual({ pendingChanges, conflicts, pendingWorkspaceDeletions }, { pendingChanges: 0, conflicts: 0, pendingWorkspaceDeletions: 0 });
  });

  test('a draft written over a disk file the workspace never saw, with no push, is deleted without touching that file', async (t) => {
    const env = new Env(t);
    env.writeDisk('c.txt', 'disk text\n');
    const m = await env.open(t);
    await call(m, 'write', { path: 'work/c.txt', content: 'agent text\n' });
    // No push met disk's file, so nothing records it, and the answer has no note.
    assert.deepEqual(await call(m, 'delete', { path: 'work/c.txt' }), { path: 'work/c.txt', deleted: true, disk: 'done' });
    assert.deepEqual(await pending(m), { pendingChanges: 0, pendingWorkspaceDeletions: 0 });
    assert.equal(readFileSync(join(env.dir, 'c.txt'), 'utf8'), 'disk text\n');
    await call(m, 'sync', { path: 'work/c.txt' });
    assert.match((await call(m, 'read', { path: 'work/c.txt' })).content, /disk text/, 'a sync takes it in');
  });

  test('a deletion keeps its tombstone where the evidence may hold a copy of ours: an agreed copy, a pending push, or an entry from before the evidence', async (t) => {
    const env = new Env(t);
    const m = await env.open(t);
    const agreement = (m as any).agreement;
    const blob = (text: string) => env.store.storeBlob(Buffer.from(text), 'text/plain');
    // A store-origin draft whose P says disk agreed with a copy: a push of
    // another branch, say, that landed.
    await call(m, 'write', { path: 'work/agreed.txt', content: 'v1\n' });
    agreement.set('work', 'agreed.txt', { kind: 'content', hash: env.store.treeGet(TREE, 'agreed.txt')!.blobHash, size: 3 });
    // A store-origin draft whose push is pending, with its bytes on disk: our
    // own effect shows there, never confirmed, so it may have landed.
    await call(m, 'write', { path: 'work/pushed.txt', content: 'v1\n' });
    agreement.intend('work', 'pushed.txt', { effect: 'disk', prior: null, expect: { kind: 'content', hash: env.store.treeGet(TREE, 'pushed.txt')!.blobHash }, branchId: env.store.currentBranch().id });
    env.writeDisk('pushed.txt', 'v1\n');
    // An entry from before the evidence: no P and no origin.
    env.store.treeSet(TREE, 'legacy.txt', { blobHash: blob('v1\n'), size: 3, mode: 0o644 });
    for (const path of ['agreed.txt', 'pushed.txt', 'legacy.txt']) await call(m, 'delete', { path: `work/${path}` });
    const deletions = (m as any).intents.get('work').list().filter(([, bi]: [string, { tombstone?: unknown }]) => bi.tombstone).map(([p]: [string]) => p).sort();
    assert.deepEqual(deletions, ['agreed.txt', 'legacy.txt', 'pushed.txt']);
    // The deletion's pass left the push pending: disk shows its bytes, never
    // confirmed, so nothing recorded them as a copy disk agreed with.
    assert.equal(agreement.get('work', 'pushed.txt')?.kind, 'pending');
  });

  test('a deletion over a pending push whose bytes never reached disk leaves nothing pending once a sync of the mount passes over it', async (t) => {
    // A push of a draft, with no prior, that left no file never created one.
    // While it's recorded as pending, the deletion reads it as a push that may
    // have landed; a pass over the path finds disk holding nothing there,
    // which settles the deletion and the push. A sync of the mount, not of the
    // path, which would take disk's state whatever the evidence.
    const env = new Env(t);
    const m = await env.open(t);
    const agreement = (m as any).agreement;
    await call(m, 'write', { path: 'work/unlanded.txt', content: 'v1\n' });
    agreement.intend('work', 'unlanded.txt', { effect: 'disk', prior: null, expect: { kind: 'content', hash: env.store.treeGet(TREE, 'unlanded.txt')!.blobHash }, branchId: env.store.currentBranch().id });
    await call(m, 'delete', { path: 'work/unlanded.txt' });
    await call(m, 'sync', {});
    const { pendingChanges, conflicts, pendingWorkspaceDeletions } = (await call(m, 'status', {})).work;
    assert.deepEqual({ pendingChanges, conflicts, pendingWorkspaceDeletions }, { pendingChanges: 0, conflicts: 0, pendingWorkspaceDeletions: 0 });
    assert.notEqual(agreement.get('work', 'unlanded.txt')?.kind, 'pending', 'the push is settled');
    assert.equal(existsSync(join(env.dir, 'unlanded.txt')), false);
  });

  test('a workspace draft disk never agreed with is deleted with nothing pending, on a plain mount too', async (t) => {
    const env = new Env(t);
    const m = await env.open(t);
    await call(m, 'write', { path: 'work/d/new.txt', content: 'draft\n' });
    assert.deepEqual(await pending(m), { pendingChanges: 1, pendingWorkspaceDeletions: 0 });
    await call(m, 'delete', { path: 'work/d/new.txt' });
    assert.deepEqual(await pending(m), { pendingChanges: 0, pendingWorkspaceDeletions: 0 });
  });
});

describe('a mount root that is itself a symlink', () => {
  test('is the root, and a path that climbs out of it and back in through its link is refused as a climb', async (t) => {
    const holder = mkdtempSync(join(tmpdir(), 'af-ws-parent-link-root-'));
    t.after(() => rmSync(holder, { recursive: true, force: true }));
    mkdirSync(join(holder, 'real'));
    symlinkSync(join(holder, 'real'), join(holder, 'm'));
    const env = new Env(t, join(holder, 'm'));
    env.writeDisk('d/x.txt', 'v1\n');
    const m = await env.open(t);
    assert.equal((await m.readFileFromDisk('work/d/x.txt')).bytes.toString(), 'v1\n');
    // A path that climbs out of the root and back in by the root's own link
    // is refused before anything is looked up: a `..` above the root climbs
    // above it whatever it reaches afterwards.
    await assert.rejects(m.readFileFromDisk('work/../m/d/x.txt'), /climbs above the root of mount "work"/);
    assert.equal((await call(m, 'read', { path: 'work/d/x.txt' })).content.includes('v1'), true);
  });
});

describe('a mount that follows symlinks', () => {
  test('still follows an inside link among a path\'s parents, and refuses one leading out', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const m = await env.open(t, { followSymlinks: true });
    await call(m, 'write', { path: 'work/l/new.txt', content: 'created\n' });
    const away = env.swapLForLink('inside');
    assert.deepEqual((await call(m, 'materialize', { path: 'work/l/new.txt' })).materialized.map((e: { path: string }) => e.path), ['l/new.txt']);
    assert.equal(readFileSync(join(away, 'new.txt'), 'utf8'), 'created\n', 'written behind the link, which this mount follows');
    assert.equal((await m.readFileFromDisk('work/l/x.txt')).bytes.toString(), 'behind the link\n');

    const env2 = new Env(t);
    env2.writeDisk('l/x.txt', 'v1\n');
    const m2 = await env2.open(t, { followSymlinks: true });
    env2.swapLForLink('outside');
    await assert.rejects(m2.readFileFromDisk('work/l/x.txt'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'escape');
  });

  test('readBinaryFromDisk reads through an inside link, and refuses one leading out before its size limit answers', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const m = await env.open(t, { followSymlinks: true });
    env.swapLForLink('inside');
    const read = await m.readBinaryFromDisk('work/l/x.txt');
    assert.ok('data' in read, JSON.stringify(read));
    assert.equal(read.data.toString(), 'behind the link\n');

    const env2 = new Env(t);
    env2.writeDisk('l/x.txt', 'v1\n');
    const m2 = await env2.open(t, { followSymlinks: true });
    env2.swapLForLink('outside', 'an outside file longer than the limit\n');
    for (const opts of [{}, { maxBytes: 4 }]) {
      assert.deepEqual(await m2.readBinaryFromDisk('work/l/x.txt', opts), { error: 'Symlink escape detected: work/l/x.txt' }, JSON.stringify(opts));
    }
  });
});
