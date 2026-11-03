/**
 * A mount's `include` is its boundary: a file or link it doesn't cover is
 * outside the mount, for walks, the watcher's pass, materialize (even when the
 * workspace's history holds the file from before the include), sync, and the
 * agent's own reads and writes, which are refused with that reason.
 * connectome-host can give its `_config` mount, which versions the host's
 * config files, an include naming them, and a file saved beside them then
 * stays out of its history and is never written back (connectome-host #278).
 */

import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { EffectFailed, unlinkContained, writeContained } from '../src/modules/workspace/effects.js';
import { coversLanding, insideMount, parsedSpelling, pathSegments, readPath, type MountView } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { FsChange } from '../src/modules/workspace/watcher.js';
import type { ModuleContext } from '../src/types/module.js';
import { changesFlow, isProbe } from './helpers/watcher-flow.js';

const TREE = 'workspace/work/tree';
const OUTSIDE = "outside the mount's include";

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-include-'));
  readonly dir = join(this.root, 'work');
  readonly storePath = join(this.root, 'ws.chronicle');
  store: JsStore;
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    mkdirSync(this.dir, { recursive: true });
    this.store = JsStore.openOrCreate({ path: this.storePath });
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  async open(mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', ...mount }] });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }

  /** Stop a module, as a restart's process exit would, keeping the store open for the next one. */
  async stop(m: WorkspaceModule): Promise<void> {
    await m.stop();
    this.live = this.live.filter((x) => x !== m);
  }

  writeDisk(path: string, content: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  tree(): string[] {
    return this.store.treeList(TREE).map((e: { path: string }) => e.path).sort();
  }
}

/** Make a FIFO at `path`, or false where the disk can't hold one, as the FUSE passthrough can't. */
function madeFifo(path: string): boolean {
  try {
    execFileSync('mkfifo', [path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<any> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, true, `${name} ${JSON.stringify(input)} failed: ${res.error}`);
  return res.structured ?? res.data;
}

async function refused(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<string> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, false, `${name} ${JSON.stringify(input)} unexpectedly succeeded`);
  return String(res.error);
}

/** readFileFromDisk's refusal of `path`, as its code and message. */
async function diskRefusal(m: WorkspaceModule, path: string): Promise<string> {
  let message = '';
  await assert.rejects(m.readFileFromDisk(path), (err: unknown) => {
    message = `${(err as WorkspaceReadError).code}: ${String((err as Error).message)}`;
    return err instanceof WorkspaceReadError;
  });
  return message;
}

/** A workspace with `work` and `inner` nested in it at `inner/`, whose include covers `*.json` only. */
async function openNested(env: Env, followSymlinks: boolean): Promise<WorkspaceModule> {
  const m = new WorkspaceModule({ mounts: [
    { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', followSymlinks },
    { name: 'inner', path: join(env.dir, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
  ] });
  m.initStore(env.store);
  await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  return m;
}

async function listed(m: WorkspaceModule): Promise<string[]> {
  const data = await call(m, 'ls', { path: 'work', recursive: true });
  return (data.entries as Array<{ path: string }>).map((e) => e.path).sort();
}

describe('mount include', () => {
  test('the walk takes only what include covers: names and extension globs at any depth, a directory glob beneath it', async (t) => {
    const env = new Env(t);
    // Beside them, a directory whose name starts with `docs` and a file whose
    // name ends in `md` without the dot: each pattern's boundary holds. An
    // editor's swap file is passed over as one, before the include judges it.
    for (const path of ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'notes.md', 'other.txt', 'sub/gate.json', 'sub/x.md', 'sub/y.txt', 'docs/a/b.txt', 'docsx/c.txt', 'readmemd', '.gate.json.swp']) {
      env.writeDisk(path, `${path}\n`);
    }
    const m = await env.open({ include: ['gate.json', '*.md', 'docs/**'] });
    assert.deepEqual(await listed(m), ['docs/a/b.txt', 'gate.json', 'notes.md', 'sub/gate.json', 'sub/x.md']);
    assert.deepEqual(env.tree(), ['docs/a/b.txt', 'gate.json', 'notes.md', 'sub/gate.json', 'sub/x.md'], 'nothing else is versioned');
    const data = await call(m, 'sync', {});
    const byReason = (data.passedOver as Array<{ reason: string; count: number }>).map((p) => [p.reason, p.count]).sort();
    assert.deepEqual(byReason, [["an editor's swap or backup file", 1], [OUTSIDE, 6]], 'a sync says what it passed over, and why');
    for (const path of ['work', 'work/sub']) {
      const found = await call(m, 'grep', { path, pattern: 'gate' });
      assert.deepEqual((found.results as Array<{ file: string }>).map((r) => r.file).sort(),
        path === 'work' ? ['work/gate.json', 'work/sub/gate.json'] : ['work/sub/gate.json'], `grep over ${path} searches only what the include covers`);
      const globbed = await call(m, 'glob', { path, pattern: '**' });
      assert.deepEqual((globbed.matches as Array<{ path: string }>).map((x) => x.path).sort(),
        path === 'work' ? ['work/docs/a/b.txt', 'work/gate.json', 'work/notes.md', 'work/sub/gate.json', 'work/sub/x.md'] : ['work/sub/gate.json', 'work/sub/x.md'],
        `glob over ${path} lists only what the include covers`);
    }
  });

  test('a name or extension glob covers a file by its own name, and nothing beneath a directory it matches', async (t) => {
    const env = new Env(t);
    for (const path of ['gate.json', 'sub/gate.json', 'sub/gate.json.d/x.txt', 'x/gate.json/notes.txt', 'notes.md/inner.txt', 'docs/a/b.txt']) {
      env.writeDisk(path, `${path}\n`);
    }
    const m = await env.open({ include: ['gate.json', '*.md', 'docs/**'] });
    assert.deepEqual(await listed(m), ['docs/a/b.txt', 'gate.json', 'sub/gate.json']);
    assert.deepEqual(env.tree(), ['docs/a/b.txt', 'gate.json', 'sub/gate.json'], 'nothing beneath a directory named like a covered file is versioned');
    assert.match((await call(m, 'read', { path: 'work/sub/gate.json' })).content, /\tsub\/gate\.json$/m, 'a file by its own name, at any depth');
    // A directory named like a covered file holds nothing the include
    // covers, the agent's own writes included.
    for (const [name, input] of [
      ['read', { path: 'work/x/gate.json/notes.txt' }],
      ['read', { path: 'work/notes.md/inner.txt' }],
      ['write', { path: 'work/x/gate.json/run.sh', content: 'echo hi\n' }],
      ['write', { path: 'work/notes.md/new.txt', content: 'x' }],
      ['grep', { path: 'work/x/gate.json/notes.txt', pattern: 'notes' }],
      ['glob', { path: 'work/x/gate.json/notes.txt', pattern: '*' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include: mount "work" holds only gate\.json, \*\.md, docs\/\*\*/, `${name} ${input.path}`);
    }
    assert.equal(m.resolveAbsolutePath('work/x/gate.json/notes.txt'), null);
    // A listing names each directory directly beneath its path, whether or
    // not anything beneath it is covered, and shows only covered files.
    const entries = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string; type: string }>)
      .map((e) => `${e.type} ${e.name}`);
    assert.deepEqual(await entries('work'), ['directory docs', 'directory notes.md', 'directory sub', 'directory x', 'file gate.json']);
    assert.deepEqual(await entries('work/x'), ['directory gate.json']);
    assert.deepEqual(await entries('work/x/gate.json'), []);
    // A directory disk has, with nothing covered beneath it, is still a scope.
    assert.deepEqual((await call(m, 'glob', { path: 'work/x', pattern: '**' })).matches, []);
    // The directory a `dir/**` pattern names needs no covering: it's no file,
    // and it's a scope, as a directory beneath a name pattern is.
    assert.equal(m.resolveAbsolutePath('work/docs'), null);
    assert.deepEqual(await entries('work/docs'), ['directory a']);
    assert.deepEqual(((await call(m, 'glob', { path: 'work/docs', pattern: '**' })).matches as Array<{ path: string }>).map((x) => x.path), ['work/docs/a/b.txt']);
    await call(m, 'materialize', {});
    assert.equal(existsSync(join(env.dir, 'x/gate.json/run.sh')), false, 'nothing was written beneath it');
    assert.deepEqual(env.tree(), ['docs/a/b.txt', 'gate.json', 'sub/gate.json']);
  });

  test('a name outside the include that is no directory is refused, as read refuses it, on disk, in history or nowhere, and a directory is still a scope', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('secrets.env', 'on disk\n');
    let m = await env.open();
    await call(m, 'write', { path: 'work/cached.env', content: 'in history only\n' });
    await env.stop(m);
    assert.equal(existsSync(join(env.dir, 'cached.env')), false, 'the mount doesn\'t materialize on write');
    m = await env.open({ include: ['gate.json'] });
    // On disk, in history alone, and nowhere: the five tools that take a
    // directory as their scope answer each the same, as read does.
    for (const name of ['secrets.env', 'cached.env', 'nothing-here.env']) {
      const path = `work/${name}`;
      const said = `"${path}" is outside the mount's include: mount "work" holds only gate.json. `
        + 'The host\'s operator sets the include in the mount\'s configuration, so calling again with this path changes nothing.';
      for (const [tool, input] of [
        ['sync', { path }], ['materialize', { path }], ['grep', { path, pattern: 'x' }], ['glob', { path, pattern: '*' }], ['ls', { path }], ['read', { path }],
      ] as const) {
        const text = await refused(m, tool, input as Record<string, unknown>);
        assert.equal(text, `The ${tool} did nothing: ${said}`, `${tool} ${name}`);
      }
    }
    // A directory gone from disk is still a scope while history holds an
    // entry beneath it.
    await call(m, 'write', { path: 'work/old/gate.json', content: '{"old":true}\n' });
    assert.equal(existsSync(join(env.dir, 'old')), false);
    const old = await call(m, 'materialize', { path: 'work/old' });
    assert.deepEqual(old.materialized, [{ mount: 'work', path: 'old/gate.json' }]);
    assert.equal(readFileSync(join(env.dir, 'old/gate.json'), 'utf8'), '{"old":true}\n');
  });

  test('a path outside include is refused, with the reason, by every tool that names a file', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('.gate.json.swp', 'swap\n');
    env.writeDisk('sub/gate.json', '{}\n');
    env.writeDisk('sub/notes.txt', 'notes\n');
    const m = await env.open({ include: ['gate.json'] });
    for (const [name, input] of [
      ['write', { path: 'work/notes.txt', content: 'x' }],
      ['read', { path: 'work/.gate.json.swp' }],
      ['read_image', { path: 'work/.gate.json.swp' }],
      ['edit', { path: 'work/.gate.json.swp', oldString: 'swap', newString: 'swapped' }],
      ['delete', { path: 'work/.gate.json.swp' }],
      ['sync', { path: 'work/.gate.json.swp' }],
      ['materialize', { path: 'work/.gate.json.swp' }],
      ['grep', { path: 'work/.gate.json.swp', pattern: 'swap' }],
      ['glob', { path: 'work/.gate.json.swp', pattern: '*' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include: mount "work" holds only gate\.json/, name);
    }
    // edit_many refuses an uncovered path beside a covered one in the
    // include's words, and stores none of its edits.
    const many = await refused(m, 'edit_many', { edits: [
      { path: 'work/gate.json', oldString: '{}', newString: '[]' },
      { path: 'work/.gate.json.swp', oldString: 'swap', newString: 'swapped' },
    ] });
    assert.match(many, /^The edit_many call stored none of its edits: 1 problem\.\n\nedit 2: "work\/\.gate\.json\.swp" is outside the mount's include: mount "work" holds only gate\.json/, many);
    assert.match((await call(m, 'read', { path: 'work/gate.json' })).content, /\t\{\}$/m);
    // A `..` takes back the segment before it, as on any mount, before
    // anything looks the path up, so the include judges the path every tool
    // acts on: one that reaches a file the include doesn't cover is refused
    // as that file is, showing the path as given.
    for (const path of ['work/gate.json/../.gate.json.swp', 'work/sub/../.gate.json.swp']) {
      const said = `"${path}" is outside the mount's include: mount "work" holds only gate.json.`;
      for (const name of ['read', 'read_image', 'write', 'edit', 'delete', 'sync', 'materialize', 'grep', 'glob', 'ls']) {
        const input = name === 'grep' || name === 'glob' ? { path, pattern: 'swap' } : name === 'write' ? { path, content: 'x' }
          : name === 'edit' ? { path, oldString: '{}', newString: '[]' } : { path };
        assert.ok((await refused(m, name, input)).includes(said), `${name} ${path}`);
      }
      const binary = await m.readBinary(path);
      assert.ok('error' in binary && binary.error.includes(said), `readBinary ${path}`);
      const fromDisk = await m.readBinaryFromDisk(path);
      assert.ok('error' in fromDisk && fromDisk.error.includes(said), `readBinaryFromDisk ${path}`);
      const written = await m.writeBinary(path, Buffer.from([1]), 'image/png');
      assert.ok(String(written.error).includes(said), `writeBinary ${path}`);
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) =>
        err instanceof WorkspaceReadError && err.code === 'outside_include' && err.message.includes(said), `readFileFromDisk ${path}`);
      assert.equal(m.resolveAbsolutePath(path), null, `resolveAbsolutePath ${path}`);
    }
    // And one that reaches a covered file reaches that file.
    assert.match((await call(m, 'read', { path: 'work/sub/../gate.json' })).content, /\t\{\}$/m);
    assert.equal((await m.readFileFromDisk('work/sub/../gate.json')).bytes.toString(), '{}\n');
    assert.equal(m.resolveAbsolutePath('work/sub/../gate.json'), join(env.dir, 'gate.json'));
    assert.equal(m.resolveAbsolutePath('work/sub/..'), env.dir);
    // A path is read in one spelling: a trailing `/`, a `.` segment or an
    // empty one names the file it names without them, refused as that file is.
    for (const path of ['work/.gate.json.swp/', 'work/./.gate.json.swp', 'work/sub/./notes.txt', 'work/sub//notes.txt', 'work/sub/notes.txt/']) {
      for (const name of ['read', 'sync', 'materialize', 'grep']) {
        const input = name === 'grep' ? { path, pattern: 'notes' } : { path };
        assert.match(await refused(m, name, input), /outside the mount's include: mount "work" holds only gate\.json/, `${name} ${path}`);
      }
    }
    assert.deepEqual(env.tree().filter((p) => p !== 'gate.json'), [], 'nothing outside the include was versioned');
    const write = await m.writeBinary('work/image.png', Buffer.from([1, 2, 3]), 'image/png');
    assert.equal(write.success, false);
    assert.match(String(write.error), /outside the mount's include/);
    const read = await m.readBinary('work/.gate.json.swp');
    assert.ok('error' in read && /outside the mount's include/.test(read.error));
    const fromDisk = await m.readBinaryFromDisk('work/.gate.json.swp');
    assert.ok('error' in fromDisk && /outside the mount's include/.test(fromDisk.error));
    await assert.rejects(m.readFileFromDisk('work/.gate.json.swp'), (err: unknown) =>
      err instanceof WorkspaceReadError && err.code === 'outside_include');
    assert.equal(m.resolveAbsolutePath('work/.gate.json.swp'), null, 'outside the mount, as a path that leaves it is');
    assert.equal(m.resolveAbsolutePath('work/gate.json'), join(env.dir, 'gate.json'));
    assert.equal(m.resolveAbsolutePath('work/./gate.json'), join(env.dir, 'gate.json'));
    // The mount's root is inside: connectome-host resolves it by the mount's
    // name alone.
    for (const path of ['work', 'work/', 'work/.']) assert.equal(m.resolveAbsolutePath(path), env.dir, path);
    // A sync that names a directory takes what's covered beneath it.
    const sub = await call(m, 'sync', { path: 'work/sub' });
    assert.equal(sub.totalSynced, 1, 'sub/gate.json');
    assert.equal(sub.ignored, undefined);
    // A file tool refuses a directory the include doesn't cover as it
    // refuses a file: one on disk and in history, one on disk alone, and one
    // only the workspace's history has.
    mkdirSync(join(env.dir, 'empty'));
    await call(m, 'write', { path: 'work/drafts/gate.json', content: '{}' });
    assert.equal(existsSync(join(env.dir, 'drafts')), false, 'the mount doesn\'t materialize on write, so disk has no drafts/');
    for (const dir of ['sub', 'empty', 'drafts']) {
      assert.match(await refused(m, 'read', { path: `work/${dir}` }), /outside the mount's include/, dir);
      assert.match(await refused(m, 'write', { path: `work/${dir}`, content: 'x' }), /outside the mount's include/, dir);
      assert.equal(m.resolveAbsolutePath(`work/${dir}`), null, dir);
    }
    assert.equal((await m.writeBinary('work/empty', Buffer.from([1]), 'image/png')).success, false);
    assert.deepEqual(env.tree().filter((p) => p !== 'gate.json'), ['drafts/gate.json', 'sub/gate.json']);
    await assert.rejects(m.readFileFromDisk('work/empty'), (err: unknown) =>
      err instanceof WorkspaceReadError && err.code === 'outside_include');
  });

  test('a name history holds as a file the include doesn\'t cover, where disk now has a directory, is a scope, as a listing names it', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('backup', 'from before the include\n');
    let m = await env.open();
    await listed(m);
    await env.stop(m);
    // Disk replaces the file history holds at backup with a directory holding
    // a covered file, and a whole-mount sync takes that file in beside it, as
    // a host would meet it: history then holds both.
    rmSync(join(env.dir, 'backup'));
    env.writeDisk('backup/gate.json', '{"in":"backup"}\n');
    m = await env.open({ include: ['gate.json'] });
    const backup = env.store.treeGet(TREE, 'backup')!.blobHash;
    await call(m, 'sync', {});
    assert.deepEqual(env.tree(), ['backup', 'backup/gate.json', 'gate.json']);
    const entries = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string; type: string }>)
      .map((e) => `${e.type} ${e.name}`);
    assert.deepEqual(await entries('work'), ['directory backup', 'file gate.json']);
    // Every tool that takes a directory as its scope takes it, as the listing
    // names it, and the ones that name a file refuse it.
    assert.deepEqual(await entries('work/backup'), ['file gate.json']);
    assert.deepEqual(((await call(m, 'glob', { path: 'work/backup', pattern: '*' })).matches as Array<{ path: string }>).map((x) => x.path), ['work/backup/gate.json']);
    assert.equal((await call(m, 'grep', { path: 'work/backup', pattern: 'backup' })).totalMatches, 1);
    // A sync naming it takes in disk's change beneath it, and a materialize
    // naming it writes the workspace's.
    env.writeDisk('backup/gate.json', '{"in":"backup","v":2}\n');
    await call(m, 'sync', { path: 'work/backup' });
    assert.match((await call(m, 'read', { path: 'work/backup/gate.json' })).content, /"v":2/);
    await call(m, 'write', { path: 'work/backup/gate.json', content: '{"in":"backup","v":3}\n' });
    await call(m, 'materialize', { path: 'work/backup' });
    assert.equal(readFileSync(join(env.dir, 'backup/gate.json'), 'utf8'), '{"in":"backup","v":3}\n');
    for (const [name, input] of [
      ['read', { path: 'work/backup' }],
      ['edit', { path: 'work/backup', oldString: 'from', newString: 'changed' }],
      ['delete', { path: 'work/backup' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include/, name);
    }
    await assert.rejects(m.readFileFromDisk('work/backup'), (err: unknown) =>
      err instanceof WorkspaceReadError && err.code === 'outside_include');
    assert.equal(m.resolveAbsolutePath('work/backup'), null);
    // The history file stays as it was, beside what the directory holds.
    assert.equal(env.store.treeGet(TREE, 'backup')?.blobHash, backup);
    assert.deepEqual(env.tree(), ['backup', 'backup/gate.json', 'gate.json']);
  });

  test('a name the include doesn\'t cover, with covered files beneath it in history, is a scope whether disk has a file there or nothing, and the file is left as it is', async (t) => {
    const answers = async (onDisk: 'a file' | 'nothing'): Promise<string[]> => {
      const said: string[] = [];
      for (const [tool, input] of [
        ['ls', { path: 'work/x' }], ['sync', { path: 'work/x' }], ['materialize', { path: 'work/x' }],
        ['grep', { path: 'work/x', pattern: 'a' }], ['glob', { path: 'work/x', pattern: '*' }],
      ] as const) {
        const env = new Env(t);
        env.writeDisk('gate.json', '{}\n');
        env.writeDisk('x/gate.json', '{}\n');
        let m = await env.open();
        await listed(m);
        await env.stop(m);
        rmSync(join(env.dir, 'x'), { recursive: true });
        if (onDisk === 'a file') env.writeDisk('x', 'a file outside the include\n');
        m = await env.open({ include: ['gate.json'] });
        const top = ((await call(m, 'ls', { path: 'work' })).entries as Array<{ name: string; type: string }>).map((e) => `${e.type} ${e.name}`);
        assert.deepEqual(top, ['directory x', 'file gate.json'], `${onDisk}: the listing names x`);
        const res = await m.handleToolCall({ id: 't', name: tool, input: input as Record<string, unknown> });
        said.push(`${tool} ${res.success ? JSON.stringify(res.structured ?? res.data) : `refused: ${res.error}`}`);
        if (onDisk === 'a file') assert.equal(readFileSync(join(env.dir, 'x'), 'utf8'), 'a file outside the include\n', `${tool} leaves the file`);
      }
      return said;
    };
    for (const line of [...await answers('a file'), ...await answers('nothing')]) assert.doesNotMatch(line, /^\w+ refused/, line);
  });

  test('grep naming a covered file searches that file alone, whether only disk or only history holds it', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    const m = await env.open({ include: ['*.md', 'gate.json'] });
    await call(m, 'write', { path: 'work/notes/a.md', content: 'needle in history\n' });
    assert.equal(existsSync(join(env.dir, 'notes/a.md')), false, 'only history holds it');
    env.writeDisk('b.md', 'needle on disk\n');
    assert.equal(env.store.treeGet(TREE, 'b.md'), null, 'only disk holds it');
    for (const path of ['work/notes/a.md', 'work/b.md']) {
      const found = await call(m, 'grep', { path, pattern: 'needle' });
      assert.deepEqual((found.results as Array<{ file: string }>).map((r) => r.file), [path], path);
    }
  });

  test('a path through a link, with no covered history beneath it, is no scope, as no listing names it, while a directory ignore covers is one', async (t) => {
    const env = new Env(t);
    const outside = join(env.root, 'outside');
    mkdirSync(join(outside, 'sub'), { recursive: true });
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('real/sub/gate.json', '{}\n');
    env.writeDisk('build/gate.json', '{}\n');
    symlinkSync(outside, join(env.dir, 'out'));
    symlinkSync(join(env.dir, 'real'), join(env.dir, 'in'));
    const m = await env.open({ include: ['gate.json'], ignore: ['build'] });
    const top = ((await call(m, 'ls', { path: 'work' })).entries as Array<{ name: string; type: string }>).map((e) => `${e.type} ${e.name}`);
    assert.deepEqual(top, ['directory real', 'file gate.json'], 'the listing names neither link, nor the ignored directory');
    // Beyond a link, a directory that's there and a name with nothing there
    // are refused as outside the include, wherever the link leads.
    const texts = new Set<string>();
    for (const path of ['work/out/sub', 'work/out/nope', 'work/in/sub', 'work/in/nope']) {
      for (const [tool, input] of [
        ['ls', { path }], ['sync', { path }], ['materialize', { path }], ['grep', { path, pattern: 'a' }], ['glob', { path, pattern: '*' }],
      ] as const) {
        const text = await refused(m, tool, input as Record<string, unknown>);
        assert.ok(text.startsWith(`The ${tool} did nothing: `), text);
        texts.add(text.slice(`The ${tool} did nothing: `.length).replace(path, 'PATH'));
      }
    }
    assert.equal(texts.size, 1, [...texts].join(' | '));
    assert.match([...texts][0]!, /^"PATH" is outside the mount's include/);
    // A directory the ignore list covers isn't listed, and is a scope when
    // it's named, as a sync that names it takes in what's there (#276).
    assert.equal(env.store.treeGet(TREE, 'build/gate.json'), null);
    await call(m, 'sync', { path: 'work/build' });
    assert.notEqual(env.store.treeGet(TREE, 'build/gate.json'), null, 'a sync naming it takes in the covered file there');
    assert.deepEqual(((await call(m, 'ls', { path: 'work/build' })).entries as Array<{ name: string }>).map((e) => e.name), ['gate.json']);
  });

  test('a name covered history lies beneath, where disk has since put a link, is a scope: a mount that follows symlinks answers it through the link, and one that doesn\'t refuses the link', async (t) => {
    for (const followSymlinks of [false, true]) {
      for (const leadsOut of [false, true]) {
        const env = new Env(t);
        const outside = join(env.root, 'outside');
        mkdirSync(join(outside, 'sub'), { recursive: true });
        env.writeDisk('gate.json', '{}\n');
        env.writeDisk('lnk/gate.json', '{"was":"lnk"}\n');
        env.writeDisk('real/sub/gate.json', '{}\n');
        let m = await env.open({ include: ['gate.json'], followSymlinks });
        await call(m, 'sync', {});
        await env.stop(m);
        // Disk replaces the directory history recorded with a link.
        rmSync(join(env.dir, 'lnk'), { recursive: true });
        symlinkSync(leadsOut ? outside : join(env.dir, 'real'), join(env.dir, 'lnk'));
        m = await env.open({ include: ['gate.json'], followSymlinks });
        const label = `followSymlinks ${followSymlinks}, ${leadsOut ? 'out of the mount' : 'in the mount'}`;
        const top = ((await call(m, 'ls', { path: 'work' })).entries as Array<{ name: string; type: string }>).map((e) => `${e.type} ${e.name}`);
        assert.ok(top.includes('directory lnk'), `${label}: covered history implies lnk: ${top.join(', ')}`);
        const beneath = await call(m, 'ls', { path: 'work/lnk' });
        const said = JSON.stringify(beneath);
        const names = (beneath.entries as Array<{ name: string }>).map((e) => e.name);
        if (!followSymlinks) {
          // No link on a path is followed: nothing beyond it is read, and the listing says why. The include
          // doesn't cover the link, so the listing tells nothing of where it leads.
          assert.ok(!names.includes('sub'), `${label}: ${said}`);
          assert.match(said, /\\"work\/lnk\\" is a symlink, which this mount does not follow/, label);
          assert.ok(!said.includes('real') && !said.includes('outside the mount'), `${label}: ${said}`);
        } else if (leadsOut) {
          // A link out of the mount: the scope is taken, and nothing beyond it is read.
          assert.match(said, /resolves outside the mount/, label);
        } else {
          // A link to a directory in the mount: the listing names what lies beyond it.
          assert.ok(names.includes('sub'), `${label}: ${said}`);
        }
      }
    }
  });

  test("a link's refusal names an inside target only where a tool could name it, a file the include covers or a directory, and only for a link the include covers", async (t) => {
    const env = new Env(t);
    env.writeDisk('secret.txt', 'not the mount\'s\n');
    env.writeDisk('notes.md', 'covered\n');
    env.writeDisk('real/gate.json', '{}\n');
    // Links among a covered path's directories: to an uncovered file, to a
    // covered file, and to a directory.
    symlinkSync(join(env.dir, 'secret.txt'), join(env.dir, 'gate.json'));
    symlinkSync(join(env.dir, 'notes.md'), join(env.dir, 'x.md'));
    symlinkSync(join(env.dir, 'real'), join(env.dir, 'lnk'));
    symlinkSync(join(env.dir, 'real'), join(env.dir, 'dir.md'));
    const m = await env.open({ include: ['gate.json', '*.md'] });
    const refusal = async (path: string): Promise<string> => {
      let message = '';
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) => { message = String((err as Error).message); return err instanceof WorkspaceReadError; });
      return message;
    };
    const uncovered = await refusal('work/gate.json/y.md');
    assert.match(uncovered, /"work\/gate\.json" is a symlink, which this mount does not follow/);
    assert.ok(!uncovered.includes('secret'), uncovered);
    assert.match(await refusal('work/x.md/y.md'), /"work\/x\.md" is a symlink to "work\/notes\.md", which this mount does not follow/);
    assert.match(await refusal('work/dir.md/gate.json'),
      /"work\/dir\.md" is a symlink to "work\/real", which this mount does not follow; use "work\/real" in place of "work\/dir\.md", or whoever runs this host can set followSymlinks: true on mount "work"; either way, the mount reaches only what its include covers there/);
    // A link the include doesn't cover is outside the mount itself: its refusal tells nothing of where it leads.
    const outside = await refusal('work/lnk/gate.json');
    assert.match(outside, /"work\/lnk" is a symlink, which this mount does not follow; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere$/);
    assert.ok(!outside.includes('real'), outside);
    // It's named as the parse reads the path, whatever empty, `.` or `..` segment the caller's text holds before it.
    for (const given of ['work/./lnk/gate.json', 'work/sub/../lnk/gate.json', 'work/.//lnk/gate.json']) {
      assert.match(await refusal(given), /"work\/lnk" is a symlink, which this mount does not follow; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere$/, given);
    }
    // Nor does a listing or a sync of the mount name the uncovered target.
    for (const [name, input] of [['ls', { path: 'work' }], ['ls', { path: 'work', recursive: true }], ['sync', {}]] as Array<[string, Record<string, unknown>]>) {
      const said = JSON.stringify(await call(m, name, input));
      assert.ok(!said.includes('secret'), `${name} ${JSON.stringify(input)}: ${said}`);
    }
  });

  test("a link the include's names don't cover is reported as on a mount without an include, as a symlink not walked, where it leads to a directory on a mount that follows links and wherever it leads on one that doesn't; a followed link to a file or to nothing is outside the include", async (t) => {
    const OUTSIDE_INCLUDE = "outside the mount's include";
    type Sync = { incomplete?: Array<{ path: string; reason: string }>; skipped?: Array<{ path: string; reason: string }>; passedOver?: Array<{ reason: string; count: number }> };
    type Entries = { entries: Array<{ path?: string; name?: string; type: string; state?: string; note?: string }> };
    const open = async (followSymlinks: boolean, include?: string[]): Promise<WorkspaceModule> => {
      const env = new Env(t);
      env.writeDisk('real/a.json', '{}\n');
      symlinkSync('real', join(env.dir, 'link'));
      symlinkSync(join('real', 'a.json'), join(env.dir, 'x.txt'));
      symlinkSync('nowhere', join(env.dir, 'gone'));
      const m = await env.open({ followSymlinks, ...(include ? { include } : {}) });
      // What's read through the link is judged by its path and where it lands, both of which `*.json` covers.
      if (followSymlinks) assert.equal(((await call(m, 'read', { path: 'work/link/a.json' })).content as string).trim(), '1\t{}');
      return m;
    };
    const byPath = (list: Array<{ path: string; reason: string }> | undefined): Record<string, string> => Object.fromEntries((list ?? []).map((r) => [r.path, r.reason]));
    for (const follow of [true, false]) {
      const m = await open(follow, ['*.json']);
      const synced = await call(m, 'sync', {}) as Sync;
      const label = `${follow ? 'following' : 'not following'} links: ${JSON.stringify(synced)}`;
      if (follow) {
        // Beneath it, history the read took in: the link's region, and what that history is skipped for, read as on
        // a mount without an include.
        const plain = await call(await open(follow), 'sync', {}) as Sync;
        assert.equal(byPath(plain.incomplete)['link'], 'a symlink, not walked', JSON.stringify(plain));
        assert.equal(byPath(synced.incomplete)['link'], 'a symlink, not walked', label);
        assert.equal(byPath(plain.skipped)['link/a.json'], 'disk could not be checked: a symlink, not walked — a sync of this path checks it', JSON.stringify(plain));
        assert.equal(byPath(synced.skipped)['link/a.json'], byPath(plain.skipped)['link/a.json'], `${label}; ${JSON.stringify(plain)}`);
        // A link to a file, and one that leads nowhere, are judged by their names, which the include leaves out.
        assert.equal(synced.passedOver?.find((p) => p.reason === OUTSIDE_INCLUDE)?.count, 2, label);
      } else {
        // A mount that follows no link resolves none to tell where it leads: with nothing tracked beneath them, the
        // link to a directory, the one to a file and the one that leads nowhere are each counted with that reason,
        // and the walk took everything else.
        assert.equal(synced.passedOver?.find((p) => p.reason === 'a symlink, not walked')?.count, 3, label);
        assert.equal(synced.passedOver?.find((p) => p.reason === OUTSIDE_INCLUDE), undefined, label);
        assert.deepEqual(synced.incomplete ?? [], [], label);
      }
      // No listing takes the link's own name as a file, nor calls what lies beneath it outside the include.
      const listed = await call(m, 'ls', { path: 'work', recursive: true }) as Entries;
      assert.ok(!listed.entries.some((e) => (e.path ?? e.name) === 'link' && e.type === 'file'), JSON.stringify(listed));
      assert.ok(listed.entries.every((e) => e.note !== OUTSIDE_INCLUDE), JSON.stringify(listed));
    }
  });

  test("a link into a nested mount's directory names its target only where that mount's own include covers it, and the outer include covers the link", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/kept.json', '{}\n');
    env.writeDisk('inner/hidden.txt', 'not the inner mount\'s\n');
    env.writeDisk('inner/sub/a.json', '{}\n');
    symlinkSync(join(env.dir, 'inner/hidden.txt'), join(env.dir, 'h.md'));
    symlinkSync(join(env.dir, 'inner/kept.json'), join(env.dir, 'k.md'));
    symlinkSync(join(env.dir, 'inner/sub'), join(env.dir, 'd'));
    symlinkSync(join(env.dir, 'inner/sub'), join(env.dir, 'd.md'));
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', include: ['*.md', '*.json'] },
      { name: 'inner', path: join(env.dir, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    try {
      const refusal = async (path: string): Promise<string> => {
        let message = '';
        await assert.rejects(m.readFileFromDisk(path), (err: unknown) => {
          message = `${(err as WorkspaceReadError).code}: ${String((err as Error).message)}`;
          return err instanceof WorkspaceReadError;
        });
        return message;
      };
      // The inner mount's include leaves hidden.txt out, so neither it nor the mount is named, and the code says no
      // more than the message: a link the mount doesn't follow, as for any other target the agent can't name.
      const left = await refusal('work/h.md/y.md');
      assert.match(left, /^parent_symlink: .*"work\/h\.md" is a symlink, which this mount does not follow/);
      assert.ok(!left.includes('hidden') && !left.includes('inner'), left);
      // At the path itself, the link keeps `symlink`, where one whose refusal names the mount gets `other_mount`.
      const atPath = await refusal('work/h.md');
      assert.match(atPath, /^symlink: /);
      assert.ok(!atPath.includes('hidden') && !atPath.includes('inner'), atPath);
      assert.match(await refusal('work/k.md'), /^other_mount: .*use "inner\/kept\.json"/);
      assert.match(await refusal('work/k.md/y.md'), /^other_mount: .*use "inner\/kept\.json"/);
      assert.match(await refusal('work/d.md/a.json'), /^other_mount: .*use "inner\/sub"/);
      // A link the outer include doesn't cover tells nothing of where it leads, the nested mount included.
      const uncovered = await refusal('work/d/a.json');
      assert.match(uncovered, /^parent_symlink: .*"work\/d" is a symlink, which this mount does not follow; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere$/);
      assert.ok(!uncovered.includes('inner'), uncovered);
      assert.match(await refusal('work/./x/../d/a.json'), /^parent_symlink: .*"work\/d" is a symlink, which this mount does not follow; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere$/);
    } finally {
      await m.stop();
    }
  });

  test("through a link a mount follows, a place in a nested mount's directory is named only where it's a directory or a file that mount's include covers, and is otherwise refused as leaving the mount", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/kept.json', '{}\n');
    env.writeDisk('inner/hidden.txt', 'not the inner mount\'s\n');
    env.writeDisk('inner/sub/a.json', '{}\n');
    env.writeDisk('inner/sub/b.txt', 'not the inner mount\'s either\n');
    env.writeDisk('h.txt', 'needle\n');
    symlinkSync(join(env.dir, 'inner/kept.json'), join(env.dir, 'k.json'));
    symlinkSync(join(env.dir, 'inner/missing.txt'), join(env.dir, 'm.txt'));
    symlinkSync(join(env.dir, 'inner/sub'), join(env.dir, 'd'));
    const m = await openNested(env, true);
    try {
      // The workspace holds h.txt from before disk made it a link to a file the inner mount's include leaves out.
      await call(m, 'sync', {});
      rmSync(join(env.dir, 'h.txt'));
      symlinkSync(join(env.dir, 'inner/hidden.txt'), join(env.dir, 'h.txt'));
      // A file the inner mount's include leaves out, there or missing, is no mount's: the path leaves this one,
      // in the words each refusal has for that, naming neither the inner mount nor the file.
      // Beneath such a file, the path to use would name it, so it isn't named either.
      for (const path of ['work/h.txt', 'work/m.txt', 'work/d/b.txt', 'work/h.txt/a.json', 'work/d/b.txt/a.json']) {
        const left = await diskRefusal(m, path);
        assert.equal(left, `escape: Symlink escape detected: ${path}`);
        const read = await refused(m, 'read', { path });
        assert.ok(read.startsWith(`The read did nothing: ${JSON.stringify(path)} leads through a symlink to a place outside its mount`) && !read.includes('inner'), read);
        // Nothing of the inner mount's file is searched, and nothing names it as that mount's: a sync or a
        // listing may name the directory `d` leads into, which that mount shows.
        const unnamed = (answer: string): boolean => !answer.includes("inner mount's") && !answer.includes('hidden')
          && !answer.includes('inner/sub/b.txt') && !answer.includes('inner/missing');
        const said = JSON.stringify(await call(m, 'grep', { path, pattern: 'mount' }));
        assert.ok(unnamed(said), `grep ${path}: ${said}`);
        for (const [name, input] of [['sync', { path }], ['ls', { path }]] as Array<[string, Record<string, unknown>]>) {
          const answer = JSON.stringify(await call(m, name, input));
          assert.ok(unnamed(answer), `${name} ${path}: ${answer}`);
        }
      }
      // The sync says a link to the file leaves the mount, and beneath a link to a directory, it names that
      // directory, as a listing would, and not the file.
      assert.deepEqual((await call(m, 'sync', { path: 'work/h.txt' })).skipped, [
        { mount: 'work', path: 'h.txt', reason: 'disk could not be checked: a symlink that leaves the mount — syncing this path again won\'t change that; nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it' },
      ]);
      assert.deepEqual((await call(m, 'sync', { path: 'work/d/b.txt' })).skipped, [
        { mount: 'work', path: 'd/b.txt', reason: 'disk could not be checked: "work/d" leads into mount "inner", nested in mount "work": use "inner/sub" in its place' },
      ]);
      const searched = await call(m, 'grep', { path: 'work', pattern: 'needle' });
      assert.equal(searched.totalMatches, 0);
      assert.deepEqual(searched.skipped.filter((s: { file: string }) => s.file === 'work/h.txt'), [{ file: 'work/h.txt', reason: 'Symlink escape detected: work/h.txt' }]);
      // A file the inner mount's include covers, and a directory, are that mount's, and named.
      assert.match(await diskRefusal(m, 'work/k.json'), /^other_mount: .*use "inner\/kept\.json"/);
      assert.match(await diskRefusal(m, 'work/d/a.json'), /^other_mount: .*use "inner\/sub\/a\.json"/);
      assert.match(await diskRefusal(m, 'work/d'), /^other_mount: .*use "inner\/sub"\./);
      assert.deepEqual((await call(m, 'ls', { path: 'work/d' })).incomplete, [
        { path: 'd', reason: '"work/d" leads into mount "inner", nested in mount "work": use "inner/sub" in its place' },
      ]);
      const synced = JSON.stringify((await call(m, 'sync', {})).skipped);
      assert.ok(synced.includes('use \\"inner/sub\\" in its place') && synced.includes('use \\"inner/kept.json\\" in its place'), synced);
      assert.ok(synced.includes('"path":"h.txt","reason":"disk could not be checked: a symlink that leaves the mount — syncing this path again won\'t change that; '
        + 'nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it"') && !synced.includes('hidden'), synced);
    } finally {
      await m.stop();
    }
    // A mount that doesn't follow links refuses the link itself, and names the target where the inner mount's include covers it.
    const unfollowed = await openNested(env, false);
    try {
      const left = await diskRefusal(unfollowed, 'work/h.txt');
      assert.match(left, /^symlink: .*"work\/h\.txt" is a symlink, which this mount does not follow/);
      assert.ok(!left.includes('hidden') && !left.includes('inner'), left);
      assert.match(await diskRefusal(unfollowed, 'work/k.json'), /^other_mount: .*use "inner\/kept\.json"/);
    } finally {
      await unfollowed.stop();
    }
  });

  test("through a link a mount follows, a nested mount without an include beside one with an include keeps every place there its own, as without any include", async (t) => {
    const env = new Env(t);
    env.writeDisk('plain/sub/a.txt', "the plain mount's\n");
    env.writeDisk('plain/f.txt', "the plain mount's\n");
    symlinkSync('sub', join(env.dir, 'plain/l2'));
    symlinkSync(join(env.dir, 'plain/l2'), join(env.dir, 'px'));
    symlinkSync(join(env.dir, 'plain/f.txt'), join(env.dir, 'pf'));
    env.writeDisk('inner/kept.json', '{}\n');
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'inner', path: join(env.dir, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
      { name: 'plain', path: join(env.dir, 'plain'), mode: 'read-write', watch: 'never' },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    try {
      // Past the plain mount's own link, and beneath its file, the place is the plain mount's, named as it reads.
      assert.match(await diskRefusal(m, 'work/px/a.txt'), /^other_mount: .*use "plain\/sub\/a\.txt"/);
      assert.match(await diskRefusal(m, 'work/pf/x.txt'), /^other_mount: .*use "plain\/f\.txt\/x\.txt"/);
    } finally {
      await m.stop();
    }
  });

  test("through a link a mount follows, the innermost nested mount holds a place, and one with an include names only what it covers", async (t) => {
    const env = new Env(t);
    env.writeDisk('plain/d/kept.json', '{}\n');
    env.writeDisk('plain/d/hidden.txt', "not the deep mount's\n");
    // A link of the plain mount's own, to the deep mount's root, and the outer mount's links through it.
    symlinkSync('d', join(env.dir, 'plain/pl'));
    symlinkSync(join(env.dir, 'plain/pl/kept.json'), join(env.dir, 'pq'));
    symlinkSync(join(env.dir, 'plain/pl/hidden.txt'), join(env.dir, 'ph'));
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'plain', path: join(env.dir, 'plain'), mode: 'read-write', watch: 'never' },
      { name: 'deep', path: join(env.dir, 'plain/d'), mode: 'read-write', watch: 'never', include: ['*.json'] },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    try {
      assert.match(await diskRefusal(m, 'work/pq'), /^other_mount: .*use "deep\/kept\.json"/);
      assert.equal(await diskRefusal(m, 'work/ph'), 'escape: Symlink escape detected: work/ph');
    } finally {
      await m.stop();
    }
  });

  test("through a link a mount follows, a mount without an include nested in one with an include holds every place in its own directory", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/kept.json', '{}\n');
    env.writeDisk('inner/plain/f.txt', "the plain mount's\n");
    symlinkSync(join(env.dir, 'inner/plain/f.txt'), join(env.dir, 'ip'));
    // A `..` out of the plain mount's directory comes back into the inner mount's (written as a string, since
    // join would take the `..` out).
    symlinkSync(`${env.dir}/inner/plain/../kept.json`, join(env.dir, 'ik'));
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'inner', path: join(env.dir, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
      { name: 'plain', path: join(env.dir, 'inner/plain'), mode: 'read-write', watch: 'never' },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    try {
      // The plain mount's file is its own, though the inner mount's include, around it, doesn't cover it.
      assert.match(await diskRefusal(m, 'work/ip'), /^other_mount: .*use "plain\/f\.txt"/);
      assert.match(await diskRefusal(m, 'work/ik'), /^other_mount: .*use "inner\/kept\.json"/);
    } finally {
      await m.stop();
    }
  });

  test("a forced materialize over a link to a place the nested mount's include leaves out writes nothing there, and names neither that mount nor the place", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/hidden.txt', "not the inner mount's\n");
    env.writeDisk('inner/sub/a.json', '{}\n');
    const links: Array<[string, string]> = [
      ['h.txt', join(env.dir, 'inner/hidden.txt')],
      ['m.txt', join(env.dir, 'inner/missing.txt')],
      // Through a file the include leaves out, or a name that isn't there, the open fails ENOTDIR or ENOENT.
      ['u1.json', `${env.dir}/inner/hidden.txt/../sub/a.json`],
      ['u2.json', `${env.dir}/inner/absent.txt/../sub/a.json`],
    ];
    for (const [path] of links) env.writeDisk(path, `outer ${path}\n`);
    const m = await openNested(env, true);
    try {
      await call(m, 'sync', {});
      for (const [path, target] of links) {
        await call(m, 'write', { path: `work/${path}`, content: `new ${path}\n` });
        rmSync(join(env.dir, path));
        symlinkSync(target, join(env.dir, path));
      }
      const forced = await call(m, 'materialize', { path: 'work', force: true });
      assert.deepEqual((forced.skipped as Array<{ reason: string }>).map((s) => s.reason.split(':')[0]).sort(), links.map(([path]) => path).sort());
      for (const { reason } of forced.skipped as Array<{ reason: string }>) {
        assert.match(reason, /^[^:]+: not written: /, reason);
        assert.ok(!reason.includes('inner') && !reason.includes('hidden') && !reason.includes('missing'), reason);
      }
      assert.equal(readFileSync(join(env.dir, 'inner/hidden.txt'), 'utf8'), "not the inner mount's\n");
      assert.equal(existsSync(join(env.dir, 'inner/missing.txt')), false);
    } finally {
      await m.stop();
    }
  });

  test("a walk through a link to a directory above a nested mount's directory passes over that directory, and names none of that mount's files", async (t) => {
    const env = new Env(t);
    env.writeDisk('a/sub/in/secret.txt', "not the inner mount's\n");
    env.writeDisk('a/sub/in/kept.json', '{}\n');
    env.writeDisk('a/sub/own.txt', "the outer mount's\n");
    symlinkSync(join(env.dir, 'a'), join(env.dir, 'link'));
    // With and without an include on the nested mount: its directory is another mount's either way.
    for (const include of [['*.json'], undefined]) {
      const m = new WorkspaceModule({ mounts: [
        { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', followSymlinks: true },
        { name: 'inner', path: join(env.dir, 'a/sub/in'), mode: 'read-write', watch: 'never', ...(include ? { include } : {}) },
      ] });
      m.initStore(env.store);
      await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
      try {
        const listing = await call(m, 'ls', { path: 'work/link/sub', recursive: true });
        assert.deepEqual(listing.entries.map((e: { path: string }) => e.path), ['link/sub/own.txt'], JSON.stringify(include));
        // A listing that doesn't descend passes over that directory too, rather than naming it as one of its own.
        const shallow = await call(m, 'ls', { path: 'work/link/sub' });
        assert.deepEqual((shallow.entries as Array<{ name: string; type: string }>).map((e) => `${e.type} ${e.name}`), ['file own.txt'], JSON.stringify(include));
        const synced = await call(m, 'sync', { path: 'work/link/sub' });
        const grepped = await call(m, 'grep', { path: 'work/link/sub', pattern: 'mount' });
        // Grep searched the outer mount's own file there, and the sync walked the scope and passed over the
        // nested mount's directory, as another mount's.
        assert.deepEqual((grepped.results as Array<{ file: string }>).map((r) => r.file), ['work/link/sub/own.txt'], JSON.stringify(include));
        assert.deepEqual(synced.passedOver, [{ mount: 'work', reason: "another mount's directory", count: 1 }], JSON.stringify(synced));
        const answers = JSON.stringify([listing, synced, grepped]);
        assert.ok(!answers.includes('secret') && !answers.includes('kept.json'), answers);
      } finally {
        await m.stop();
      }
    }
  });

  test('ignore still applies to what include covers, and a capped walk owes nothing outside the include', async (t) => {
    const env = new Env(t);
    for (const path of ['a.json', 'skip.json', 'note.txt', 'x/1.txt', 'x/2.txt', 'y/1.json', 'z/2.json']) env.writeDisk(path, `${path}\n`);
    const m = await env.open({ include: ['*.json'], ignore: ['skip.json'], walkCap: 2 });
    const data = await call(m, 'sync', {});
    // The walk takes a.json, lists x, takes y/1.json and is at its cap.
    assert.deepEqual(env.tree(), ['a.json', 'y/1.json']);
    const byReason = (data.passedOver as Array<{ reason: string; count: number }>).map(({ reason, count }) => [reason, count]).sort();
    assert.deepEqual(byReason, [['ignored by the mount', 1], [OUTSIDE, 3]]);
    assert.deepEqual((data.incomplete as Array<{ path: string; reason: string }>).map(({ path, reason }) => [path, reason]), [
      ['', 'the walk cap (2) was reached: the next sync of the mount resumes after work/y/1.json'],
      ['z', "not visited: the walk cap (2) was reached; naming this path walks only it, and whoever runs this host can raise the mount's walkCap"],
    ], 'z is left by the cap, and x, holding only files outside the include, is no region the cap left');
  });

  test('history from before the include stays as it is, and no materialize writes it back', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{"v":1}\n');
    env.writeDisk('gate.json.bak', 'backup\n');
    env.writeDisk('gate.json.unreadable-1', 'a kept copy\n');
    let m = await env.open();
    await listed(m);
    // And a draft disk never had, in a directory disk doesn't have either,
    // and one beneath a directory named like the file the include will cover.
    await call(m, 'write', { path: 'work/old/notes.txt', content: 'a draft\n' });
    await call(m, 'write', { path: 'work/x/gate.json/run.sh', content: 'echo hi\n' });
    assert.deepEqual(env.tree(), ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh'], 'without include, every file is versioned');
    const main = env.store.currentBranch().name;
    env.store.createBranch('earlier', main);
    rmSync(join(env.dir, 'gate.json.bak'));
    rmSync(join(env.dir, 'gate.json.unreadable-1'));
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    assert.deepEqual(await listed(m), ['gate.json']);
    assert.deepEqual(env.tree(), ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh'],
      'a listing decides nothing outside the include, though disk no longer has those files');
    const top = await call(m, 'ls', { path: 'work' });
    assert.deepEqual((top.entries as Array<{ name: string }>).map((e) => e.name), ['gate.json'], 'no directory shows for history outside the include');
    env.store.switchBranch('earlier');
    const named = await m.handleToolCall({ id: 't', name: 'materialize', input: { path: 'work/old/notes.txt' } });
    assert.match(String(named.error), /outside the mount's include/);
    // A covered change on that branch, which the same call writes: the push ran.
    await call(m, 'write', { path: 'work/gate.json', content: '{"v":2}\n' });
    const written = await m.materializeMount('work');
    assert.deepEqual(written, ['gate.json'], 'the covered change is written, and nothing outside the include');
    assert.equal(readFileSync(join(env.dir, 'gate.json'), 'utf8'), '{"v":2}\n');
    for (const path of ['gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh']) assert.equal(existsSync(join(env.dir, path)), false, path);
    assert.deepEqual(env.tree(), ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh'], 'the earlier branch\'s history outside the include is left as it was');
    const status = await call(m, 'status', {});
    assert.equal(status.work.fileCount, 1, 'only gate.json is the mount\'s');
    assert.equal(status.work.pendingChanges, 0, 'and nothing outside it is owed to disk');
    const all = await call(m, 'materialize', {});
    assert.equal(all.count, 0);
    assert.equal(existsSync(join(env.dir, 'gate.json.bak')), false);
    // A directory that only history outside the include holds is no scope:
    // no listing names it, so it's refused as a name with nothing there is.
    assert.match(await refused(m, 'materialize', { path: 'work/old' }), /outside the mount's include/);
    mkdirSync(join(env.dir, 'old'));
    const old = await call(m, 'materialize', { path: 'work/old' });
    assert.deepEqual(old.materialized, []);
    assert.equal(old.skipped, undefined);
    assert.deepEqual(old.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'a materialize naming a directory counts what it left out, and why, naming none of it');
    assert.equal(existsSync(join(env.dir, 'old/notes.txt')), false);
  });

  test('a dir/** pattern covers what lies beneath its directory, and not a file of that name', async (t) => {
    const env = new Env(t);
    env.writeDisk('docs', 'a file named like the directory\n');
    let m = await env.open();
    await listed(m);
    assert.deepEqual(env.tree(), ['docs'], 'without include, the file is versioned');
    rmSync(join(env.dir, 'docs'));
    await env.stop(m);

    m = await env.open({ include: ['docs/**'] });
    await call(m, 'materialize', {});
    assert.equal(existsSync(join(env.dir, 'docs')), false, 'history from before the include isn\'t written back');
    env.writeDisk('docs', 'on disk again\n');
    assert.deepEqual(await listed(m), []);
    const data = await call(m, 'sync', {});
    assert.deepEqual(data.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'a walk passes over it');
    assert.deepEqual(env.tree(), ['docs'], 'and history keeps the earlier entry as it was');
    for (const [name, input] of [
      ['read', { path: 'work/docs' }],
      ['write', { path: 'work/docs', content: 'x' }],
      ['ls', { path: 'work/docs' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include: mount "work" holds only docs\/\*\*/, `${name} ${input.path}`);
    }
    assert.equal(m.resolveAbsolutePath('work/docs'), null);
    assert.equal(readFileSync(join(env.dir, 'docs'), 'utf8'), 'on disk again\n');
  });

  test('a covered file whose directory disk has replaced with a regular file the include doesn\'t cover is gone after a full sync', async (t) => {
    const env = new Env(t);
    env.writeDisk('x/gate.json', '{"needle": 1}\n');
    env.writeDisk('a/y/gate.json', '{"needle": 2}\n');
    const m = await env.open({ include: ['gate.json'] });
    await call(m, 'sync', {});
    assert.deepEqual(env.tree(), ['a/y/gate.json', 'x/gate.json']);
    for (const dir of ['x', 'a/y']) {
      rmSync(join(env.dir, dir), { recursive: true, force: true });
      writeFileSync(join(env.dir, dir), 'now a file\n');
    }
    // The walk passes over `x` and `a/y`, outside the include, and as regular
    // files they hold nothing beneath them: the sync records each covered file
    // as gone, as it would where its directory had gone altogether.
    await call(m, 'sync', {});
    assert.deepEqual(env.tree(), [], 'history records the covered files as gone');
    assert.deepEqual(await listed(m), []);
    assert.equal((await call(m, 'grep', { path: 'work', pattern: 'needle' })).totalMatches, 0);
  });

  test('history beneath a name the include leaves out, which disk has as a FIFO or a regular file, is taken as absent', async (t) => {
    for (const what of ['a regular file', 'a FIFO']) {
      const env = new Env(t);
      env.writeDisk('top.json', '{}\n');
      if (what === 'a regular file') env.writeDisk('n', 'outside the include\n');
      if (what === 'a FIFO' && !madeFifo(join(env.dir, 'n'))) {
        t.diagnostic('this disk holds no FIFO, so the FIFO state is skipped');
        continue;
      }
      const m = new WorkspaceModule({ mounts: [{ name: 'work', path: env.dir, mode: 'read-write', watch: 'never', include: ['*.json'] }] });
      m.initStore(env.store);
      const bytes = Buffer.from('{}\n');
      env.store.treeSet(TREE, 'n/k.json', { blobHash: env.store.storeBlob(bytes, 'application/json'), size: bytes.length, mode: 0o644 });
      await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
      try {
        // Nothing lies beneath anything that isn't a directory or a link, so the walk proves the covered entry
        // absent rather than leaving it unverified.
        await call(m, 'sync', {});
        const listing = JSON.stringify(await call(m, 'ls', { path: 'work', recursive: true }));
        assert.match(listing, /"path":"n\/k\.json","state":"disk-missing-provenance-unknown"/, `${what}: ${listing}`);
      } finally {
        await m.stop();
      }
    }
  });

  test("on a mount that follows links, the include is judged where a path lands as well as where it's named: a covered link to a covered file reads through, and a covered path that reaches a file the include leaves out leaves the mount", async (t) => {
    const env = new Env(t);
    env.writeDisk('data.json', '{"through": 1}\n');
    env.writeDisk('later.json', '{"later": 1}\n');
    env.writeDisk('secret.txt', "not the mount's\n");
    env.writeDisk('elsewhere/x.txt', "not the mount's either\n");
    env.writeDisk('elsewhere/sub/y.txt', "not the mount's either\n");
    mkdirSync(join(env.dir, 'box'));
    symlinkSync('data.json', join(env.dir, 'alias.json'));
    symlinkSync('secret.txt', join(env.dir, 'notes.json'));
    symlinkSync('elsewhere', join(env.dir, 'via'));
    const m = await env.open({ include: ['*.json', 'via/**', 'box/**'], followSymlinks: true });
    assert.match((await call(m, 'read', { path: 'work/alias.json' })).content, /"through": 1/, 'a covered link to a covered file reads through');
    // A link at the path itself, and one on its way: the file tools refuse it before anything is stored, in
    // the words a nested mount's place its include leaves out gets, and so does the disk read.
    for (const path of ['work/notes.json', 'work/via/x.txt']) {
      for (const [tool, input] of [['read', { path }], ['write', { path, content: 'x' }], ['edit', { path, oldString: 'not', newString: 'now' }], ['delete', { path }]] as const) {
        const said = await refused(m, tool, input);
        assert.ok(said.startsWith(`The ${tool} did nothing: ${JSON.stringify(path)} leads through a symlink to a place outside its mount`), `${tool} ${path}: ${said}`);
      }
      assert.equal(await diskRefusal(m, path), `escape: Symlink escape detected: ${path}`, path);
    }
    const created = await refused(m, 'write', { path: 'work/via/new.txt', content: 'x' });
    assert.ok(created.startsWith('The write did nothing: "work/via/new.txt" leads through a symlink to a place outside its mount'), `a file it would create where the link leads: ${created}`);
    // A covered directory where the link leads is a directory to the file tools, not a place that leaves the
    // mount: the include judges files.
    const directory = await refused(m, 'read', { path: 'work/via/sub' });
    assert.ok(/directory/i.test(directory) && !directory.includes('escape'), directory);
    // A sync, named or not, stores none of it, grep matches none of it, and a listing from where a link leads
    // (`via/sub` is covered, so it's a directory) names none of it.
    await call(m, 'sync', {});
    for (const path of ['work/notes.json', 'work/via/x.txt', 'work/via/sub']) await m.handleToolCall({ id: 't', name: 'sync', input: { path } });
    assert.deepEqual(env.tree(), ['alias.json', 'data.json', 'later.json'], 'nothing a link leads to that the include leaves out is stored');
    for (const path of ['work', 'work/via/sub', 'work/notes.json']) {
      assert.equal((await call(m, 'grep', { path, pattern: "not the mount's" })).totalMatches, 0, `grep ${path}`);
    }
    const listing = JSON.stringify(await call(m, 'ls', { path: 'work/via/sub' }));
    assert.ok(!listing.includes('y.txt'), `a listing from where a link leads names no file the include leaves out there: ${listing}`);

    // Where disk puts the link after the change was taken, no materialize, forced or not, writes through it,
    // creates a file where it leads, or removes it.
    await call(m, 'write', { path: 'work/later.json', content: '{"over": 1}\n' });
    await call(m, 'write', { path: 'work/box/new.txt', content: 'made\n' });
    await call(m, 'delete', { path: 'work/alias.json' });
    rmSync(join(env.dir, 'later.json'));
    symlinkSync('secret.txt', join(env.dir, 'later.json'));
    rmSync(join(env.dir, 'box'), { recursive: true });
    symlinkSync('elsewhere', join(env.dir, 'box'));
    rmSync(join(env.dir, 'alias.json'));
    symlinkSync('secret.txt', join(env.dir, 'alias.json'));
    for (const force of [false, true]) {
      const pushed = await call(m, 'materialize', { path: 'work', force, applyDeletions: true });
      const reasons = JSON.stringify(pushed.skipped ?? []);
      for (const path of ['later.json', 'box/new.txt', 'alias.json']) assert.ok(reasons.includes(path), `force ${force}, ${path}: ${reasons}`);
      assert.equal(readFileSync(join(env.dir, 'secret.txt'), 'utf8'), "not the mount's\n", `force ${force}: the file a link leads to keeps its bytes`);
      assert.ok(lstatSync(join(env.dir, 'later.json')).isSymbolicLink() && lstatSync(join(env.dir, 'alias.json')).isSymbolicLink(), `force ${force}: both links stay`);
      assert.equal(existsSync(join(env.dir, 'elsewhere/new.txt')), false, `force ${force}: nothing is made where a link leads`);
    }
  });

  test("a copy history took in before the include, at a covered path whose landing the include leaves out, is neither vouched for nor searched", async (t) => {
    const env = new Env(t);
    env.writeDisk('secret.dat', "needle: not the mount's\n");
    env.writeDisk('site/docs/x.txt', "needle: not the mount's either\n");
    symlinkSync('secret.dat', join(env.dir, 'x.json'));
    symlinkSync('site/docs', join(env.dir, 'docs'));
    // Past the racy window, so the first sync records fingerprints old enough to vouch, as history a mount
    // holds from before its include would.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    let m = await env.open({ followSymlinks: true });
    await call(m, 'sync', {});
    // A walk goes through no link, so the file beneath one is taken in by name.
    await call(m, 'sync', { path: 'work/docs/x.txt' });
    assert.ok(env.tree().includes('x.json') && env.tree().includes('docs/x.txt'), `without an include, both are taken in: ${env.tree()}`);
    await env.stop(m);
    // The stat of each is unchanged, so a pass would vouch for its copy without opening it: a link at the
    // path, and one on its way.
    m = await env.open({ followSymlinks: true, include: ['*.json', 'docs/**'] });
    await call(m, 'sync', {});
    await m.handleToolCall({ id: 't', name: 'sync', input: { path: 'work/docs/x.txt' } });
    for (const path of ['work', 'work/x.json', 'work/docs', 'work/docs/x.txt']) {
      assert.equal((await call(m, 'grep', { path, pattern: 'needle' })).totalMatches, 0, `grep ${path}`);
    }
  });

  test("on a mount that follows links, a covered path whose landing realpath can't resolve is refused by every file tool, so no copy history took in before the include through it is served and nothing is written through it", async (t) => {
    const env = new Env(t);
    env.writeDisk('secret.dat', "needle: not the mount's\n");
    symlinkSync('secret.dat', join(env.dir, 'c.json'));
    let m = await env.open({ followSymlinks: true });
    await call(m, 'sync', {});
    assert.ok(env.tree().includes('c.json'), `without an include, it's taken in: ${env.tree()}`);
    await env.stop(m);
    // Disk turns the link into a loop, so where it lands can't be told.
    rmSync(join(env.dir, 'c.json'));
    symlinkSync('loop.json', join(env.dir, 'c.json'));
    symlinkSync('c.json', join(env.dir, 'loop.json'));
    m = await env.open({ followSymlinks: true, include: ['*.json'] });
    const read = await refused(m, 'read', { path: 'work/c.json' });
    const loop = 'where "work/c.json" leads on disk can\'t be resolved: too many symlinks, or a loop of them.';
    assert.ok(read.includes(loop) && !read.includes('needle'), read);
    await assert.rejects(m.readFileFromDisk('work/c.json'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'not_found');
    const written = await refused(m, 'write', { path: 'work/c.json', content: 'written through a loop\n' });
    assert.ok(written.includes(loop), written);
    const deleted = await refused(m, 'delete', { path: 'work/c.json' });
    assert.ok(deleted.includes(loop), deleted);
    assert.ok(lstatSync(join(env.dir, 'c.json')).isSymbolicLink() && lstatSync(join(env.dir, 'loop.json')).isSymbolicLink(), 'both links stay');
    assert.equal(readFileSync(join(env.dir, 'secret.dat'), 'utf8'), "needle: not the mount's\n");
  });

  test("on a mount that follows links, a covered path beneath a directory this process can't search is refused, since where it lands can't be told", { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a directory permissions keep this process out of' : false }, async (t) => {
    const env = new Env(t);
    env.writeDisk('locked/x.json', '{}\n');
    const m = await env.open({ followSymlinks: true, include: ['*.json'] });
    chmodSync(join(env.dir, 'locked'), 0o000);
    try {
      for (const [name, input] of [['read', { path: 'work/locked/x.json' }], ['write', { path: 'work/locked/x.json', content: '[]\n' }], ['delete', { path: 'work/locked/x.json' }]] as const) {
        const why = await refused(m, name, input);
        assert.ok(why.includes('where "work/locked/x.json" leads on disk can\'t be resolved: permission denied.'), `${name}: ${why}`);
      }
      await assert.rejects(m.readFileFromDisk('work/locked/x.json'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'not_found');
    } finally {
      chmodSync(join(env.dir, 'locked'), 0o755);
    }
  });

  // Linux's kernel follows 40 links in one resolution and refuses a 41st.
  // realBeneath follows as many links as the kernel does, so a chain of 40 is
  // taken, and one of 41 is refused where realpath refuses it. This pins
  // Linux's limit, so it runs on Linux.
  test("on a mount that follows links, a covered path through 40 links to a file not made yet is taken, and one through 41 is refused, as the kernel resolves them", { skip: process.platform !== 'linux' ? "pins Linux's limit of 40 links in one resolution" : false }, async (t) => {
    for (const links of [40, 41]) {
      const env = new Env(t);
      // c0.json -> c1.json -> ... -> new.json, which isn't there yet.
      for (let i = 0; i < links; i++) symlinkSync(i === links - 1 ? 'new.json' : `c${i + 1}.json`, join(env.dir, `c${i}.json`));
      const m = await env.open({ followSymlinks: true, include: ['*.json'] });
      if (links === 40) {
        await call(m, 'write', { path: 'work/c0.json', content: '{}\n' });
        const done = await call(m, 'materialize', { mount: 'work' });
        assert.ok(JSON.stringify(done.skipped).includes('c0.json: cannot verify disk copy'), JSON.stringify(done));
        assert.equal(existsSync(join(env.dir, 'new.json')), false, 'nothing is written through the chain');
        assert.ok(lstatSync(join(env.dir, 'c0.json')).isSymbolicLink(), 'and the link stays');
      } else {
        for (const [name, input] of [['read', { path: 'work/c0.json' }], ['write', { path: 'work/c0.json', content: '{}\n' }], ['delete', { path: 'work/c0.json' }]] as const) {
          const why = await refused(m, name, input);
          assert.ok(why.includes('where "work/c0.json" leads on disk can\'t be resolved: too many symlinks, or a loop of them.'), `${name}: ${why}`);
        }
        await assert.rejects(m.readFileFromDisk('work/c0.json'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'not_found');
      }
      await env.stop(m);
    }
  });

  test("a path that meets no link is judged where it's named, whatever spelling realpath gives where it lands, and one through a link where it lands, as disk spells it", async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'af-ws-include-landing-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'Docs'));
    writeFileSync(join(root, 'Docs', 'a.txt'), 'covered\n');
    mkdirSync(join(root, 'site'));
    writeFileSync(join(root, 'site', 'b.txt'), "not the mount's\n");
    symlinkSync('site', join(root, 'via'));
    const view = { include: ['Docs/**', 'via/**'] };
    const rootReal = realpathSync(root);
    // On macOS and Windows realpath gives disk's stored names, which can differ from a workspace entry's
    // spelling the parse kept: here it lands spelled otherwise, with no link on the way, which only a disk that
    // folds names gives, where both spellings are the one file.
    if (existsSync(join(root, 'docs'))) {
      assert.equal(await coversLanding(view, rootReal, join(rootReal, 'docs', 'a.txt'), 'Docs/a.txt'), true);
    }
    // Through a link, where it lands is judged, and the include doesn't cover `site/b.txt`.
    assert.equal(await coversLanding(view, rootReal, join(rootReal, 'site', 'b.txt'), 'via/b.txt'), false);
    // A landing spelled otherwise than folding makes it, with no link left on the way, as after a link was
    // swapped for a directory between the realpath and the walk, is judged where it lands too.
    assert.equal(await coversLanding(view, rootReal, join(rootReal, 'site', 'b.txt'), 'Docs/a.txt'), false);
    // So is one where neither spelling is there at any level and the two differ by more than folding, which
    // the folding check before the level walk tells apart: a file a write would create at `bb/new.txt` isn't
    // one named `aa/new.txt`.
    assert.equal(await coversLanding({ include: ['aa/**'] }, rootReal, join(rootReal, 'bb', 'new.txt'), 'aa/new.txt'), false);
    // Without an include, every file is covered.
    assert.equal(await coversLanding({}, rootReal, join(rootReal, 'site', 'b.txt'), 'via/b.txt'), true);
    // Spelled otherwise only as folding makes it, through a link, where disk tells case apart: a link `vx` to a
    // directory `VX` the include leaves out is judged where it lands.
    mkdirSync(join(root, 'VX'));
    writeFileSync(join(root, 'VX', 'c.txt'), "not the mount's either\n");
    if (!existsSync(join(root, 'vx'))) {
      symlinkSync('VX', join(root, 'vx'));
      assert.equal(await coversLanding({ include: ['vx/**'] }, rootReal, join(rootReal, 'VX', 'c.txt'), 'vx/c.txt'), false);
    }
    // Where disk tells case apart, a link `qz` to `QZ` swapped for a directory `qz` between the realpath and the
    // walk leaves no link on the way, but the path as named is another file than the one the link led to, so the
    // landing is judged.
    mkdirSync(join(root, 'QZ'));
    writeFileSync(join(root, 'QZ', 'c.txt'), "where the link led, not the mount's\n");
    if (!existsSync(join(root, 'qz'))) {
      mkdirSync(join(root, 'qz'));
      writeFileSync(join(root, 'qz', 'c.txt'), 'what the directory put in its place holds\n');
      assert.equal(await coversLanding({ include: ['qz/**'] }, rootReal, join(rootReal, 'QZ', 'c.txt'), 'qz/c.txt'), false);
    }
    // Where disk tells case apart, a link at the path itself, however disk got it there, is no level of the
    // landing's own: `gt.json` leads to `GT.JSON`, which the include leaves out.
    writeFileSync(join(root, 'GT.JSON'), "not the mount's\n");
    if (!existsSync(join(root, 'gt.json'))) {
      symlinkSync('GT.JSON', join(root, 'gt.json'));
      assert.equal(await coversLanding({ include: ['gt.json'] }, rootReal, join(rootReal, 'GT.JSON'), 'gt.json'), false);
    }
    // On a disk that folds names, a file a write would create beneath a directory the path names in another
    // spelling than disk's lands where it's named: neither side has the file, and the directory is one. Judged
    // where it lands instead, as disk spells it, `notes/new.txt` is one `Notes/**` doesn't cover.
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.txt'), 'covered as named\n');
    const notes = { include: ['Notes/**'] };
    // Where disk tells case apart, `Notes` is a level only the path as named has, so each lands at `notes/`.
    const folds = existsSync(join(root, 'NOTES'));
    assert.equal(await coversLanding(notes, rootReal, join(rootReal, 'notes', 'a.txt'), 'Notes/a.txt'), folds);
    assert.equal(await coversLanding(notes, rootReal, join(rootReal, 'notes', 'new.txt'), 'Notes/new.txt'), folds);
    assert.equal(await coversLanding(notes, rootReal, join(rootReal, 'notes', 'deep', 'new.txt'), 'Notes/deep/new.txt'), folds);
  });

  test("history the outer mount took in where a nested mount now holds the directory is no mount's where that mount's include leaves it out: no listing, sync or grep names it", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/secret.txt', "needle: not the inner mount's\n");
    env.writeDisk('inner/private/p.txt', "not the inner mount's either\n");
    env.writeDisk('inner/public/k.json', '{}\n');
    env.writeDisk('inner/k.json', '{}\n');
    const before = await env.open();
    await call(before, 'sync', {});
    assert.ok(env.tree().includes('inner/secret.txt'), `taken in before the mount was nested: ${env.tree()}`);
    await env.stop(before);
    // Only history implies `inner/private` and `inner/public` now.
    rmSync(join(env.dir, 'inner/private'), { recursive: true, force: true });
    rmSync(join(env.dir, 'inner/public'), { recursive: true, force: true });
    const m = await openNested(env, false);
    try {
      const listing = JSON.stringify(await call(m, 'ls', { path: 'work', recursive: true }));
      assert.ok(!listing.includes('secret') && !listing.includes('private'), listing);
      // Nor does a listing of that mount's directory name a directory only such history implies, while one
      // that history that mount covers implies is named.
      const there = await call(m, 'ls', { path: 'work/inner' });
      assert.ok(!JSON.stringify(there).includes('private') && !JSON.stringify(there).includes('secret'), JSON.stringify(there));
      assert.ok(JSON.stringify(there).includes('public'), JSON.stringify(there));
      // status counts what the listings name: k.json and public/k.json.
      assert.equal((await call(m, 'status', {})).work.fileCount, 2);
      const synced = JSON.stringify(await call(m, 'sync', {}));
      assert.ok(!synced.includes('secret'), synced);
      assert.equal((await call(m, 'grep', { path: 'work', pattern: 'needle' })).totalMatches, 0);
      assert.ok(env.tree().includes('inner/secret.txt'), 'history keeps it as it was');
    } finally {
      await m.stop();
    }
  });

  test("a directory gone from disk is a scope where history the mount's own listing names lies beneath it, and not where only history in a nested mount's directory that mount's include leaves out does", async (t) => {
    for (const [entries, scope] of [[['old/inner/secret.json'], false], [['old/inner/secret.json', 'old/inner/gate.json'], true]] as const) {
      const env = new Env(t);
      for (const path of entries) env.writeDisk(path, '{}\n');
      const before = await env.open({ include: ['*.json'] });
      await call(before, 'sync', {});
      await env.stop(before);
      rmSync(join(env.dir, 'old'), { recursive: true, force: true });
      const m = new WorkspaceModule({ mounts: [
        { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', include: ['*.json'] },
        { name: 'inner', path: join(env.dir, 'old', 'inner'), mode: 'read-write', watch: 'never', include: ['gate.json'] },
      ] });
      m.initStore(env.store);
      await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
      try {
        const listed = await call(m, 'ls', { path: 'work' }) as { entries: Array<{ path?: string; name?: string }> };
        assert.equal(listed.entries.some((e) => (e.path ?? e.name) === 'old'), scope, JSON.stringify(listed));
        for (const name of ['ls', 'sync', 'glob', 'grep']) {
          const input = name === 'grep' || name === 'glob' ? { path: 'work/old', pattern: 'x' } : { path: 'work/old' };
          const res = await m.handleToolCall({ id: 't', name, input });
          if (scope) assert.equal(res.success, true, `${name}: ${res.error}`);
          else assert.match(String(res.error), /"work\/old" is outside the mount's include/, name);
        }
      } finally {
        await m.stop();
      }
    }
  });

  test("on a mount that doesn't follow links, a link at the path itself is `symlink` however the path is spelled", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/hidden.txt', 'outside the include\n');
    env.writeDisk('inner/k.json', '{}\n');
    symlinkSync('inner/hidden.txt', join(env.dir, 'probe'));
    const m = await openNested(env, false);
    try {
      for (const path of ['work/probe', 'work/./probe', 'work/probe/']) {
        assert.match(await diskRefusal(m, path), /^symlink: /, path);
      }
    } finally {
      await m.stop();
    }
  });

  test('a covered file whose directory disk has replaced with a link the include doesn\'t cover stays in history, as a file beneath any link does', async (t) => {
    const env = new Env(t);
    env.writeDisk('x/gate.json', '{"needle": 1}\n');
    env.writeDisk('elsewhere/gate.json', '{"needle": 2}\n');
    const m = await env.open({ include: ['gate.json'], followSymlinks: true });
    await call(m, 'sync', {});
    rmSync(join(env.dir, 'x'), { recursive: true, force: true });
    symlinkSync(join(env.dir, 'elsewhere'), join(env.dir, 'x'));
    // A walk doesn't go through a link, and on a mount that follows links
    // `x/gate.json` may be a file through it, so a full sync proves nothing
    // about it, with or without an include.
    await call(m, 'sync', {});
    assert.ok(env.tree().includes('x/gate.json'), 'history keeps the covered file beneath the link');
  });

  test('a deletion the workspace holds outside the include is left alone by a materialize, and counted only by one that names its directory', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('sub/gate.json.bak', 'backup\n');
    let m = await env.open();
    await listed(m);
    // The mount doesn't materialize on write, so the deletion is held, owed to disk.
    await call(m, 'delete', { path: 'work/sub/gate.json.bak' });
    assert.equal((await call(m, 'status', {})).work.pendingWorkspaceDeletions, 1, 'without the include, status counts it');
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    const status = await call(m, 'status', {});
    assert.equal(status.work.pendingWorkspaceDeletions, 0, 'status doesn\'t count it');
    for (const input of [{}, { path: 'work' }]) {
      const all = await call(m, 'materialize', { ...input, applyDeletions: true });
      assert.equal(all.skipped, undefined, `a materialize of the whole mount (${JSON.stringify(input)}) doesn't take it up, so has nothing to report`);
      assert.equal(all.passedOver, undefined, `nor to count (${JSON.stringify(input)})`);
    }
    const named = await call(m, 'materialize', { path: 'work/sub', applyDeletions: true });
    assert.equal(named.skipped, undefined);
    assert.deepEqual(named.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'one that names its directory counts what it left there');
    assert.equal(existsSync(join(env.dir, 'sub/gate.json.bak')), true, 'and disk keeps the file');
  });

  test('a sync naming a directory with a trailing separator records what it takes in under each file\'s one spelling', async (t) => {
    // #351: the separator was kept, so the walk joined each name to the
    // directory with a second one.
    const env = new Env(t);
    env.writeDisk('d/a.txt', 'a\n');
    const m = await env.open();
    const first = await call(m, 'sync', { path: 'work/d/' });
    assert.deepEqual(first.results.flatMap((r: { synced: string[] }) => r.synced), ['d/a.txt']);
    assert.deepEqual(env.tree(), ['d/a.txt']);
    const names = ((await call(m, 'ls', { path: 'work/d' })).entries as Array<{ name: string }>).map((e) => e.name);
    assert.deepEqual(names, ['a.txt'], 'and no entry with an empty name');
    assert.equal((await call(m, 'sync', { path: 'work/d' })).totalSynced, 0, 'the plain spelling finds nothing more to take in');
  });

  test('without an include, a path is read in one spelling too, so history names the file the disk operation reaches', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/./a.txt', content: 'a\n' });
    await call(m, 'write', { path: 'work/b//c.txt', content: 'c\n' });
    await call(m, 'write', { path: 'work/sub/../d.txt', content: 'd\n' });
    assert.deepEqual(env.tree(), ['a.txt', 'b/c.txt', 'd.txt']);
    await call(m, 'write', { path: 'work/a.txt/', content: 'a, again\n' });
    assert.deepEqual(env.tree(), ['a.txt', 'b/c.txt', 'd.txt'], 'a trailing slash names the same file');
    // A `..` that climbs back to the root names the root.
    const names = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string }>).map((e) => e.name);
    assert.deepEqual(await names('work/b/..'), await names('work'));
    // A directory named with a trailing slash is that directory.
    const out = await call(m, 'materialize', { path: 'work/b/' });
    assert.deepEqual(out.materialized, [{ mount: 'work', path: 'b/c.txt' }]);
    assert.equal(readFileSync(join(env.dir, 'b/c.txt'), 'utf8'), 'c\n');
    // A separator straight after the mount's name would make the rest an
    // absolute path, so it's refused, even where that path lies inside the
    // mount (main refused only one outside it). The guard refuses these
    // before anything reads a `..` in them.
    const absolute = /has a separator right after mount "work", which makes it an absolute path/;
    writeFileSync(join(env.root, 'outside.txt'), 'outside\n');
    for (const path of ['work//a.txt', `work/${env.dir}/a.txt`, `work//..${env.dir}/a.txt`, `work//..${env.dir}/../outside.txt`]) {
      for (const name of ['read', 'write', 'sync']) {
        assert.match(await refused(m, name, name === 'write' ? { path, content: 'x' } : { path }), absolute, `${name} ${path}`);
      }
      assert.equal(m.resolveAbsolutePath(path), null, path);
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'traversal', path);
    }
    // A `..` with nothing before it to take back climbs above the root, and is
    // refused whatever it reaches: here it comes back in by the mount
    // directory's own name, `work`.
    const climbs = /climbs above the root of mount "work"/;
    for (const path of ['work/../work/a.txt', 'work/b/../../work/a.txt', 'work/..', 'work/../outside.txt']) {
      for (const name of ['read', 'write']) {
        assert.match(await refused(m, name, name === 'write' ? { path, content: 'x' } : { path }), climbs, `${name} ${path}`);
      }
      assert.equal(m.resolveAbsolutePath(path), null, path);
    }
    assert.deepEqual(env.tree(), ['a.txt', 'b/c.txt', 'd.txt'], 'nothing those spellings named was stored');
    assert.equal(readFileSync(join(env.root, 'outside.txt'), 'utf8'), 'outside\n');
  });

  test('without an include, glob and grep read their path in one spelling too, and refuse a climb above the root', async (t) => {
    // F208: they took a path with a `.` or `..` segment as written, so the
    // store refused the key each made from it ("Invalid tree path").
    const env = new Env(t);
    env.writeDisk('src/a.ts', 'export const a = 1;\n');
    const m = await env.open();
    await call(m, 'sync', {});
    for (const path of ['work/src/../src', 'work/./src']) {
      const globbed = await call(m, 'glob', { pattern: '*.ts', path });
      assert.deepEqual((globbed.matches as Array<{ path: string }>).map((e) => e.path), ['work/src/a.ts'], `glob ${path}`);
      const grepped = await call(m, 'grep', { pattern: 'export', path });
      assert.deepEqual((grepped.results as Array<{ file: string }>).map((r) => r.file), ['work/src/a.ts'], `grep ${path}`);
    }
    // Out of the root and back in by the mount directory's own name.
    const climbs = /climbs above the root of mount "work"/;
    assert.match(await refused(m, 'glob', { pattern: '*.ts', path: 'work/../work/src' }), climbs, 'glob');
    assert.match(await refused(m, 'grep', { pattern: 'export', path: 'work/../work/src' }), climbs, 'grep');
  });

  test('an entry an earlier version stored under another spelling is outside the mount', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a/b.txt', content: 'b\n' });
    await call(m, 'materialize', {});
    // What main stored for `work/a//b.txt`, `work/c/` and `work/d//e.txt`:
    // the path as written. main had written the last one to disk, and the
    // file has been edited there since.
    const stale = Buffer.from('stale\n');
    const entry = { blobHash: env.store.storeBlob(stale, 'text/plain'), size: stale.length, mode: 0o644 };
    for (const key of ['a//b.txt', 'c/', 'd//e.txt']) env.store.treeSet(TREE, key, entry);
    env.writeDisk('d/e.txt', 'edited on disk\n');
    const status = (await call(m, 'status', {})).work;
    assert.equal(status.fileCount, 1, 'status counts only a/b.txt');
    assert.equal(status.pendingChanges, 0);
    assert.equal(status.conflicts, 0);
    const names = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string }>).map((e) => e.name).sort();
    assert.deepEqual(await names('work/a'), ['b.txt'], 'no directory named "" beside it');
    assert.deepEqual(await names('work'), ['a', 'd'], 'and no entry named "c/"');
    assert.deepEqual(await listed(m), ['a/b.txt', 'd/e.txt']);
    const synced = await call(m, 'sync', {});
    assert.equal(synced.totalConflicts, 0, 'a sync decides nothing about them');
    assert.deepEqual(env.tree(), ['a//b.txt', 'a/b.txt', 'c/', 'd//e.txt', 'd/e.txt'], 'it took in d/e.txt, and history keeps the old keys as they were');
    for (const input of [{}, { path: 'work' }, { path: 'work/a' }, { path: 'work/d' }]) {
      const out = await call(m, 'materialize', input);
      assert.equal(out.skipped, undefined, `materialize ${JSON.stringify(input)} neither takes them up nor reports them`);
      assert.equal(out.passedOver, undefined, `nor counts them (${JSON.stringify(input)})`);
    }
    const read = await call(m, 'read', { path: 'work/a//b.txt' });
    assert.match(read.content, /\tb$/m, 'the spelling names a/b.txt');
    assert.doesNotMatch(read.content, /stale/, 'not the old key');
    assert.equal(readFileSync(join(env.dir, 'a/b.txt'), 'utf8'), 'b\n', 'and no materialize wrote the old key over it');
    assert.equal(readFileSync(join(env.dir, 'd/e.txt'), 'utf8'), 'edited on disk\n', 'nor d//e.txt over d/e.txt');
  });

  test('a conflict the workspace holds outside the include is left alone by a materialize, and counted only by one that names its directory', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('docs/n.md', 'disk\n');
    let m = await env.open();
    // History gets its own copy of a file disk holds, with nothing to say
    // which is newer, so the materialize that names it records a conflict.
    await call(m, 'write', { path: 'work/docs/n.md', content: 'history\n' });
    await call(m, 'materialize', { path: 'work/docs' });
    assert.equal((await call(m, 'status', {})).work.conflicts, 1, 'without the include, status counts it');
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    assert.equal((await call(m, 'status', {})).work.conflicts, 0, 'status doesn\'t count it');
    for (const input of [{}, { path: 'work' }]) {
      const all = await call(m, 'materialize', input);
      assert.equal(all.skipped, undefined, `a materialize of the whole mount (${JSON.stringify(input)}) doesn't take it up, so has nothing to report`);
      assert.equal(all.passedOver, undefined, `nor to count (${JSON.stringify(input)})`);
    }
    const named = await call(m, 'materialize', { path: 'work/docs' });
    assert.equal(named.skipped, undefined);
    assert.deepEqual(named.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'one that names its directory counts what it left there');
    // With no history entry left at the path, the conflict alone is what the
    // named materialize finds there.
    env.store.treeRemove(TREE, 'docs/n.md');
    const again = await call(m, 'materialize', { path: 'work/docs' });
    assert.equal(again.skipped, undefined);
    assert.deepEqual(again.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'the conflict alone is counted');
    assert.equal(readFileSync(join(env.dir, 'docs/n.md'), 'utf8'), 'disk\n', 'and disk keeps its copy');
  });

  test('text the host registers is served under an include, at every spelling that reaches it, and never written', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    const m = await env.open({ include: ['gate.json'] });
    m.registerGeneratedTextFile('work/notes.md', () => 'generated\n', 'resident');
    for (const path of ['work/notes.md', 'work/sub/../notes.md']) {
      const read = await m.handleToolCall({ id: 't', name: 'read', input: { path }, callerAgentName: 'resident' });
      assert.equal(read.success, true, `${path}: ${read.error}`);
      assert.match(JSON.stringify(read.structured), /generated/, path);
      const write = await m.handleToolCall({ id: 't', name: 'write', input: { path, content: 'x' }, callerAgentName: 'resident' });
      assert.match(String(write.error), /is generated from your tool presentation, so it's read-only/, path);
    }
    assert.equal(existsSync(join(env.dir, 'notes.md')), false);
    assert.deepEqual(env.tree(), [], 'and history holds none of it');
  });

  test('a path is split at "/", and at "\\" where that is the separator', () => {
    assert.deepEqual(pathSegments('gate.json/..\\gate.json~', '\\'), ['gate.json', '..', 'gate.json~'], 'on Windows a "\\" climb is a climb');
    assert.deepEqual(pathSegments('./a//b/.\\c\\', '\\'), ['a', 'b', 'c']);
    assert.deepEqual(pathSegments('a\\b', '/'), ['a\\b'], 'where the separator is "/", "\\" is part of a name');
    assert.deepEqual(pathSegments('', '/'), []);
    // Only a path spelled as parsing spells one is inside its mount.
    for (const path of ['', 'a', 'a/b.txt', 'a\\b']) assert.equal(parsedSpelling(path, '/'), true, path);
    for (const path of ['a//b', 'c/', '/x', './x', 'a/./b', 'a/../b', '..']) assert.equal(parsedSpelling(path, '/'), false, path);
    assert.equal(parsedSpelling('a\\b', '\\'), false, 'on Windows "\\" is a separator');
    assert.equal(insideMount('gate.json/../secret.txt', ['gate.json']), false, 'a ".." key is outside whatever the include covers');
    assert.equal(insideMount('a//b.txt', undefined), false, 'and a key no spelling names is outside a mount without an include');
    assert.equal(insideMount('sub/gate.json', ['gate.json']), true);
  });

  test('a change outside include, even to a file history holds, is no change to the mount', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{"v":1}\n');
    env.writeDisk('gate.json.bak', 'backup 1\n');
    let m = await env.open();
    await listed(m);
    const before = env.store.treeGet(TREE, 'gate.json.bak')!.blobHash;
    const gateBefore = env.store.treeGet(TREE, 'gate.json')!.blobHash;
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    env.writeDisk('gate.json.bak', 'backup 2, edited after the include\n');
    env.writeDisk('gate.json', '{"v":2}\n');
    // The watcher's handler, as a debounced batch would call it: its pass takes the covered edit, and
    // leaves the backup's history entry as it was.
    await (m as unknown as { handleFsChanges(mount: string, changes: Array<{ path: string; op: string }>): Promise<void> })
      .handleFsChanges('work', [{ path: 'gate.json.bak', op: 'modified' }, { path: 'gate.json', op: 'modified' }]);
    assert.notEqual(env.store.treeGet(TREE, 'gate.json')!.blobHash, gateBefore, 'gate.json\'s edit is taken');
    assert.equal(env.store.treeGet(TREE, 'gate.json.bak')!.blobHash, before, 'the backup\'s history entry is untouched');
    // And a sync of the whole mount after it, too.
    await call(m, 'sync', {});
    assert.equal(env.store.treeGet(TREE, 'gate.json.bak')!.blobHash, before, 'the backup\'s history entry is still untouched');
    assert.equal(readFileSync(join(env.dir, 'gate.json.bak'), 'utf8'), 'backup 2, edited after the include\n');
  });

  test('with the watcher running, a change outside the include takes no pass of the mount and wakes no one', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{"v":1}\n');
    const events: Array<{ type: string; paths?: string[] }> = [];
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'always', watchDebounceMs: 50, include: ['gate.json'] },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: (e: unknown) => events.push(e as { type: string; paths?: string[] }) } as unknown as ModuleContext);
    try {
      const internals = m as unknown as {
        mounts: Map<string, { watcherReadyAt?: number }>;
        handleFsChanges(mount: string, changes: Array<{ path: string; op: string }>): Promise<void>;
        passUnlocked(mount: unknown, scope: { kind: string; paths?: string[] }): Promise<unknown>;
        withMount(mount: unknown, run: () => Promise<unknown>): Promise<unknown>;
      };
      const until = async (done: () => boolean, what: string): Promise<void> => {
        for (const started = Date.now(); !done(); await new Promise((r) => setTimeout(r, 20))) {
          if (Date.now() - started > 10_000) assert.fail(`timed out: ${what}`);
        }
      };
      await until(() => !!internals.mounts.get('work')!.watcherReadyAt && env.store.treeGet(TREE, 'gate.json') !== null,
        'the watcher is ready and the catch-up scan took gate.json');
      // Each batch the watcher hands over, with its handling and the turns of the mount it took, each turn of
      // the mount taken, and each pass of the mount from here on. The handler asks for its turn, if it takes
      // one, before its first await, so the turns counted across its call are its batch's own: anything else
      // the watcher hands over meanwhile, as macOS's watcher may with a late event, counts only for itself.
      const batches: Array<{ paths: string[]; handled: Promise<void>; turns: number }> = [];
      const heard: FsChange[][] = [];
      const passes: string[][] = [];
      let turns = 0;
      const handle = internals.handleFsChanges.bind(m);
      internals.handleFsChanges = (mount, changes) => {
        const before = turns;
        const handled = handle(mount, changes);
        batches.push({ paths: changes.map((c) => c.path), handled, turns: turns - before });
        heard.push(changes as FsChange[]);
        return handled;
      };
      const withMount = internals.withMount.bind(m);
      internals.withMount = (mount, run) => { turns++; return withMount(mount, run); };
      // A watcher's batch takes a pass of the paths it names; the catch-up scan after ready is the mount's.
      const pass = internals.passUnlocked.bind(m);
      internals.passUnlocked = (mount, scope) => { if (scope.kind === 'paths') passes.push(scope.paths ?? []); return pass(mount, scope); };
      const named = (path: string): boolean => events.some((e) => e.paths?.includes(path));
      // Ready says chokidar's first scan is done, not that the platform
      // delivers events: on macOS a file written before then goes unreported,
      // so the test waits until changes flow. Its probes lie outside the
      // include too, so a batch of them takes no turn of the mount either.
      await changesFlow(env.dir, heard, []);
      events.length = 0;
      turns = 0;
      env.writeDisk('notes.txt', 'outside the include\n');
      await until(() => batches.some((b) => b.paths.includes('notes.txt')), 'the watcher reports the uncovered file');
      // Each batch's handling has ended, so whatever it would take, it has taken.
      for (const b of batches) await b.handled;
      const seen = JSON.stringify(batches.map((b) => ({ paths: b.paths, turns: b.turns })));
      // A batch of nothing but uncovered paths, the uncovered file and the handshake's probes, takes no turn
      // of the mount, and the handshake's own batches make sure there is one. A batch that hands the file
      // over beside something the include covers takes its turn for that, and its pass leaves the uncovered
      // file out.
      const uncovered = batches.filter((b) => b.paths.every((p) => p === 'notes.txt' || isProbe(p)));
      assert.ok(uncovered.length > 0, `a batch of uncovered paths came: ${seen}`);
      for (const b of uncovered) assert.equal(b.turns, 0, `no turn of the mount is taken for it: ${seen}`);
      assert.ok(passes.every((paths) => !paths.includes('notes.txt')), `no pass of the mount names it: ${JSON.stringify(passes)}; ${seen}`);
      assert.ok(!named('work/notes.txt'), `and no event: ${JSON.stringify(events)}`);
      // A covered change, as a control: the watcher reports it, a pass takes it in, and its event goes out.
      const fromGate = batches.length;
      env.writeDisk('gate.json', '{"v":2}\n');
      await until(() => named('work/gate.json'), 'the covered change is taken in');
      // Its batch's own count sees its turn. A handler that awaited before asking for its turn would leave every
      // batch's count at 0, and the uncovered batch's assertion above would pass whatever the handler decided.
      assert.ok(batches.slice(fromGate).some((b) => b.paths.includes('gate.json') && b.turns > 0),
        `the covered change's batch takes a turn of the mount, and its own count sees it: ${JSON.stringify(batches.map((b) => ({ paths: b.paths, turns: b.turns })))}`);
      assert.ok(passes.length > 0 && passes.every((paths) => !paths.includes('notes.txt')), JSON.stringify(passes));
      assert.equal(env.store.treeGet(TREE, 'notes.txt'), null);
    } finally {
      await m.stop();
    }
  });

  test('ls without a path lists each mount with its include, where it has one', async (t) => {
    const env = new Env(t);
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', include: ['gate.json', '*.md'] },
      { name: 'plain', path: join(env.root, 'plain'), mode: 'read-only', watch: 'never' },
    ] });
    m.initStore(env.store);
    assert.deepEqual((await call(m, 'ls', {})).mounts, [
      { name: 'work', path: env.dir, mode: 'read-write', include: ['gate.json', '*.md'] },
      { name: 'plain', path: join(env.root, 'plain'), mode: 'read-only' },
    ]);
  });

  test("a path in a nested mount's directory is that mount's, whether or not the outer include covers it: every tool names the mount that holds it", async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('x.txt', 'stale words\n');
    env.writeDisk('a/b/x.txt', 'stale words\n');
    env.writeDisk('a/b/gate.json', '{"deep":1}\n');
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', include: ['gate.json'] },
      { name: 'deep', path: join(env.dir, 'a/b'), mode: 'read-write', watch: 'never' },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    try {
      const tools: Array<[string, Record<string, unknown>]> = [
        ['read', {}], ['write', { content: 'x' }], ['delete', {}], ['ls', {}], ['glob', { pattern: '*' }],
        ['grep', { pattern: 'stale' }], ['sync', {}], ['materialize', {}],
      ];
      // Uncovered and covered alike: the holder is named, and the include isn't.
      for (const [path, use] of [['work/a/b/x.txt', 'deep/x.txt'], ['work/a/b/gate.json', 'deep/gate.json']]) {
        for (const [name, extra] of tools) {
          const res = await m.handleToolCall({ id: 't', name, input: { path, ...extra } });
          const said = JSON.stringify(res.success ? res.structured ?? res.data : String(res.error));
          assert.ok(said.includes(`use \\"${use}\\"`), `${name} ${path}: ${said}`);
          assert.ok(!said.includes(OUTSIDE), `${name} ${path}: ${said}`);
        }
        await assert.rejects(m.readFileFromDisk(path), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount');
        assert.equal(m.resolveAbsolutePath(path), null);
      }
      // Where no nested mount holds it, the include still refuses it.
      for (const [name, extra] of tools) {
        assert.match(await refused(m, name, { path: 'work/x.txt', ...extra }), /outside the mount's include/, name);
      }
      // A `..` takes back the segment before it, so the path is the nested mount's as it reads.
      assert.match(await refused(m, 'read', { path: 'work/a/b/../b/x.txt' }), /use "deep\/x\.txt"/);
    } finally {
      await m.stop();
    }
  });

  test('the framework keeps its own files only in a writable mount without an include', (t) => {
    const env = new Env(t);
    const config = { name: 'config', path: join(env.root, 'config'), mode: 'read-write' as const, watch: 'never' as const, include: ['gate.json'] };
    const both = new WorkspaceModule({ mounts: [config, { name: 'work', path: env.dir, mode: 'read-write', watch: 'never' }] });
    both.initStore(env.store);
    assert.deepEqual(both.getMounts(), [
      { name: 'config', mode: 'read-write', include: ['gate.json'] },
      { name: 'work', mode: 'read-write' },
    ]);
    // Where tool-results/ and refs/ go.
    const firstWritable = (ws: WorkspaceModule): string | null =>
      (AgentFramework.prototype as unknown as { firstWritableMountName(w: WorkspaceModule): string | null }).firstWritableMountName.call(null, ws);
    assert.equal(firstWritable(both), 'work');
    const only = new WorkspaceModule({ mounts: [config] });
    only.initStore(env.store);
    assert.equal(firstWritable(only), null, 'as a setup with no writable mount');
  });

  test('a pattern holding "\\" is refused on every platform, where "/" is the separator too', () => {
    // Refused as the module is built, as include is checked.
    const build = (pattern: string) => () => new WorkspaceModule({ mounts: [{ name: 'work', path: '/tmp/x', mode: 'read-write', include: [pattern] } as MountConfig] });
    for (const pattern of ['sub\\gate.json', 'a\\b', '*.j\\son', 'docs\\x/**']) assert.throws(build(pattern), /isn't read/, pattern);
    for (const pattern of ['gate.json', '*.json', 'docs/**']) assert.doesNotThrow(build(pattern), pattern);
  });

  test('include is checked when the module is built, and the refusal names the mount and what it refused', () => {
    const mount = (include: unknown): MountConfig => ({ name: 'work', path: '/tmp/x', mode: 'read-write', include } as MountConfig);
    const refusal = (include: unknown, said: string): void => {
      assert.throws(() => new WorkspaceModule({ mounts: [mount(include)] }), (err: unknown) => err instanceof Error
        && err.message.startsWith(`[workspace] Mount "work": ${said}`),
      said);
    };
    for (const bad of [[], 42, 'gate.json']) refusal(bad, `include must be a non-empty list of patterns, not ${JSON.stringify(bad)}`);
    for (const entry of ['/**', '', '.', '..', './**', '../**', 'a/../**', 'a\\b.json', undefined]) {
      refusal([entry], `include pattern ${JSON.stringify(entry) ?? String(entry)} isn't read: `);
    }
    refusal([1n], 'include pattern 1n isn\'t read: ');
    refusal({ pattern: 1n }, 'include must be a non-empty list of patterns, not [object Object]');
    refusal(['gate.json', '!gate.json'], 'include pattern "!gate.json" isn\'t read: ');
    for (const good of [['gate.json'], ['*.md', 'gate.js'], ['docs/**'], ['a/b/**'], ['sub/file.txt'], ['foo*'], ['*'], ['*.'], ['*.js*'], ['a/*/**'], ['fixtures/'], ['/gate.json'], ['[id].tsx']]) {
      assert.doesNotThrow(() => new WorkspaceModule({ mounts: [mount(good)] }), JSON.stringify(good));
    }
  });
});

describe("the checks where disk is acted on, called directly as a push and a read call them, name a nested place only where that mount's include covers it", () => {
  // A path reaches these only when disk changes between the checks before them and the act, so each is
  // called here with the link already there, as workspace-nested-mount-roots' own tests call them.
  /** A mount following symlinks, with `inner` nested at `a/b`, its include covering `*.json`, and links into it. */
  function rig(t: TestContext): { at: (path: string) => string; view: MountView; rootReal: string } {
    const root = mkdtempSync(join(tmpdir(), 'af-ws-include-sites-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const at = (path: string): string => join(root, 'outer', path);
    mkdirSync(at('a/b/sub'), { recursive: true });
    writeFileSync(at('a/b/x.txt'), "the inner mount's, outside its include");
    writeFileSync(at('a/b/kept.json'), "the inner mount's");
    symlinkSync(at('a/b/x.txt'), at('hidden.txt'));
    symlinkSync(at('a/b/kept.json'), at('kept.json'));
    symlinkSync(at('a/b/sub'), at('d'));
    // An entry of the inner mount's own, a link its include leaves out, and an outer link through it.
    writeFileSync(at('a/b/sub/a.json'), "the inner mount's");
    symlinkSync('sub', at('a/b/l2'));
    symlinkSync(at('a/b/l2'), at('x'));
    const nested = [{ dir: 'a/b', name: 'inner', real: realpathSync(at('a/b')), include: ['*.json'] }];
    const view = { root: at(''), name: 'outer', followSymlinks: true, maxFileSize: 1 << 20, ignore: [], others: ['a/b'], nested } as MountView;
    return { at, view, rootReal: realpathSync(at('')) };
  }
  const leaves = 'a symlink that leaves the mount';
  const named = (path: string, use: string): string => `"outer/${path}" leads into mount "inner", nested in mount "outer": use "${use}" in its place`;

  test('the located read', async (t) => {
    const { at, view, rootReal } = rig(t);
    assert.deepEqual(await readPath(view, rootReal, 'hidden.txt', 1 << 20), { kind: 'unobserved', reason: leaves });
    assert.deepEqual(await readPath(view, rootReal, 'kept.json', 1 << 20), { kind: 'unobserved', reason: named('kept.json', 'inner/kept.json'), ownStep: true });
    // Past the inner mount's own link, the place is judged where the path leads, a file that mount covers.
    assert.deepEqual(await readPath(view, rootReal, 'x/a.json', 1 << 20), { kind: 'unobserved', reason: named('x/a.json', 'inner/sub/a.json'), ownStep: true });
  });

  test('the contained write, which leaves the file as it was', async (t) => {
    const { at, view, rootReal } = rig(t);
    for (const [path, reason] of [['hidden.txt', leaves], ['kept.json', named('kept.json', 'inner/kept.json')], ['x/a.json', named('x', 'inner/sub')]] as const) {
      const err = await writeContained(view, rootReal, path, Buffer.from('outer wrote'), { kind: 'any' }).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof EffectFailed, String(err));
      assert.equal(err.message, reason);
    }
    assert.equal(readFileSync(at('a/b/x.txt'), 'utf8'), "the inner mount's, outside its include");
    assert.equal(readFileSync(at('a/b/kept.json'), 'utf8'), "the inner mount's");
  });

  test("the contained write asks where a file lies before it reads it, and writes nothing through a link that leads nowhere into the nested directory", async (t) => {
    const { at, view, rootReal } = rig(t);
    // Expecting other bytes, the write would read the file to compare: where it lies is asked first.
    const err = await writeContained(view, rootReal, 'hidden.txt', Buffer.from('outer wrote'), { kind: 'content', hash: 'not its hash' }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof EffectFailed, String(err));
    assert.equal(err.message, leaves);
    // A link to a place the include leaves out that isn't there: the exclusive create meets the link, and
    // nothing is made there.
    symlinkSync(at('a/b/missing.txt'), at('missing.txt'));
    const dangling = await writeContained(view, rootReal, 'missing.txt', Buffer.from('outer wrote'), { kind: 'any' }).then(() => null, (e: unknown) => e);
    assert.ok(dangling instanceof EffectFailed, String(dangling));
    assert.ok(!dangling.message.includes('inner') && !dangling.message.includes('missing'), dangling.message);
    assert.equal(existsSync(at('a/b/missing.txt')), false);
    // Through an entry of the inner mount's own, a link to a file it covers: the place is that file, named
    // before anything reads it.
    symlinkSync('kept.json', at('a/b/l3'));
    symlinkSync(at('a/b/l3'), at('z.json'));
    const through = await writeContained(view, rootReal, 'z.json', Buffer.from('outer wrote'), { kind: 'content', hash: 'not its hash' }).then(() => null, (e: unknown) => e);
    assert.ok(through instanceof EffectFailed, String(through));
    assert.equal(through.message, named('z.json', 'inner/kept.json'));
    assert.equal(readFileSync(at('a/b/kept.json'), 'utf8'), "the inner mount's");
    // A mount that doesn't follow links refuses the link itself, as one it doesn't follow, wherever it leads.
    const unfollowed = await writeContained({ ...view, followSymlinks: false }, rootReal, 'hidden.txt', Buffer.from('outer wrote'), { kind: 'any' }).then(() => null, (e: unknown) => e);
    assert.ok(unfollowed instanceof EffectFailed, String(unfollowed));
    assert.equal(unfollowed.message, 'a symlink, which this mount does not follow');
  });

  test('the contained unlink of a link to a file or a directory, which leaves the link', async (t) => {
    const { at, view, rootReal } = rig(t);
    for (const [path, reason] of [['hidden.txt', leaves], ['kept.json', named('kept.json', 'inner/kept.json')], ['d', named('d', 'inner/sub')]] as const) {
      const err = await unlinkContained(view, rootReal, path, { kind: 'any' }).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof EffectFailed, String(err));
      assert.equal(err.message, reason);
      assert.ok(lstatSync(at(path)).isSymbolicLink(), `${path} is still there`);
    }
  });

  test("the contained unlink of a regular file reached through a link among its directories, where a nested mount's root lies, which leaves the file", async (t) => {
    const { at, view, rootReal } = rig(t);
    // A nested mount whose root disk has as a regular file, in a directory the outer mount reaches through a
    // link: the directory is the outer mount's, and the file at the root is that mount's place.
    mkdirSync(at('c'));
    writeFileSync(at('c/f'), "at the nested mount's root");
    symlinkSync(at('c'), at('e'));
    const filed = { ...view, others: [...view.others, 'c/f'], nested: [...(view.nested ?? []), { dir: 'c/f', name: 'filed', real: join(rootReal, 'c', 'f'), include: ['*.json'] }] } as MountView;
    const err = await unlinkContained(filed, rootReal, 'e/f', { kind: 'any' }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof EffectFailed, String(err));
    assert.equal(readFileSync(at('c/f'), 'utf8'), "at the nested mount's root");
  });

  test("the module's disk reads, past the parse that refuses first", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/hidden.txt', "not the inner mount's\n");
    env.writeDisk('inner/kept.json', '{}\n');
    env.writeDisk('inner/sub/a.json', '{}\n');
    symlinkSync(join(env.dir, 'inner/hidden.txt'), join(env.dir, 'h.txt'));
    symlinkSync(join(env.dir, 'inner/kept.json'), join(env.dir, 'k.json'));
    symlinkSync('sub', join(env.dir, 'inner/l2'));
    symlinkSync(join(env.dir, 'inner/l2'), join(env.dir, 'x'));
    const m = await openNested(env, true);
    try {
      const internals = m as unknown as {
        mounts: Map<string, unknown>;
        openContainedFile(mount: unknown, relativePath: string, mountPrefixedPath: string): Promise<unknown>;
      };
      const code = async (relativePath: string): Promise<string> => {
        const err = await internals.openContainedFile(internals.mounts.get('work'), relativePath, `work/${relativePath}`).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof WorkspaceReadError, String(err));
        return `${err.code}: ${err.message}`;
      };
      assert.equal(await code('h.txt'), 'escape: Symlink escape detected: work/h.txt');
      assert.match(await code('k.json'), /^other_mount: .*use "inner\/kept\.json"/);
      assert.match(await code('x/a.json'), /^other_mount: .*use "inner\/sub\/a\.json"/);
    } finally {
      await m.stop();
    }
  });

  test("each judges the mount's own include where a covered path lands, as it judges a nested mount's place", async (t) => {
    const { at, view, rootReal } = rig(t);
    writeFileSync(at('secret.txt'), 'outside the outer include');
    symlinkSync(at('secret.txt'), at('cover.json'));
    mkdirSync(at('elsewhere'));
    symlinkSync(at('elsewhere'), at('box'));
    writeFileSync(at('elsewhere/x.txt'), 'outside the outer include too');
    const own = { ...view, include: ['*.json', 'box/**'] } as MountView;
    assert.deepEqual(await readPath(own, rootReal, 'cover.json', 1 << 20), { kind: 'unobserved', reason: leaves });
    // In place through the link, and a file the write would create where a covered directory's link leads,
    // forced or expecting other bytes: where it lands is asked before anything reads it for a hash.
    for (const expect of [{ kind: 'any' }, { kind: 'content', hash: 'not its hash' }] as const) {
      // Only a forced write creates a file it doesn't find.
      for (const path of expect.kind === 'any' ? ['cover.json', 'box/new.txt'] : ['cover.json']) {
        const err = await writeContained(own, rootReal, path, Buffer.from('outer wrote'), expect).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof EffectFailed, String(err));
        assert.equal(err.message, leaves, `${path}, ${expect.kind}`);
      }
      // The link itself, and a regular file reached through a link among its directories.
      for (const path of ['cover.json', 'box/x.txt']) {
        const removed = await unlinkContained(own, rootReal, path, expect).then(() => null, (e: unknown) => e);
        assert.ok(removed instanceof EffectFailed, String(removed));
        assert.equal(removed.message, leaves, `${path}, ${expect.kind}`);
      }
    }
    assert.equal(readFileSync(at('secret.txt'), 'utf8'), 'outside the outer include');
    assert.equal(readFileSync(at('elsewhere/x.txt'), 'utf8'), 'outside the outer include too');
    assert.ok(lstatSync(at('cover.json')).isSymbolicLink(), 'the link stays');
    assert.equal(existsSync(at('elsewhere/new.txt')), false, 'nothing is made where the link leads');
  });

  test("a create judges where the file lands before anything is made, a nested mount's absent root included", async (t) => {
    const { at, view, rootReal } = rig(t);
    // A nested mount whose directory isn't there: a file the outer mount would create at its root is that
    // mount's place, so nothing is made there.
    const gone = { ...view, nested: [...(view.nested ?? []), { dir: 'gone', name: 'later', real: join(rootReal, 'gone'), include: ['*.json'] }] } as MountView;
    const err = await writeContained(gone, rootReal, 'gone', Buffer.from('outer wrote'), { kind: 'absent' }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof EffectFailed, String(err));
    assert.equal(err.touched, false, 'nothing was touched');
    assert.equal(existsSync(at('gone')), false, 'no file is left at the nested root');
  });

  test("the module's disk read judges the mount's own include where a covered path lands, past the parse that refuses first", async (t) => {
    const env = new Env(t);
    env.writeDisk('secret.txt', "not the mount's\n");
    symlinkSync('secret.txt', join(env.dir, 'cover.json'));
    const m = await env.open({ include: ['*.json'], followSymlinks: true });
    const internals = m as unknown as {
      mounts: Map<string, unknown>;
      openContainedFile(mount: unknown, relativePath: string, mountPrefixedPath: string): Promise<unknown>;
    };
    const err = await internals.openContainedFile(internals.mounts.get('work'), 'cover.json', 'work/cover.json').then(() => null, (e: unknown) => e);
    assert.ok(err instanceof WorkspaceReadError, String(err));
    assert.equal(`${err.code}: ${err.message}`, 'escape: Symlink escape detected: work/cover.json');
  });
});
