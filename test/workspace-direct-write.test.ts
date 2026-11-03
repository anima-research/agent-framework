/**
 * A writable direct mount (MountConfig.backend 'direct' with a mode that
 * writes): its write, edit, edit_many and delete land on disk when they
 * answer, or don't happen, and an edit's answer is a 'chronicle' mount's.
 * And the framework's own files pass over it.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { RecordJournal } from '../src/record-journal.js';
import { FileChanged, ROOT_MOVED, STAGED_PREFIX, WriteRefused, checkUnchanged, directWriteTestSeam, discard, identityOf, stageContained } from '../src/modules/workspace/direct-write.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ToolResult } from '../src/types/events.js';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-direct-write-'));
  readonly ref = join(this.root, 'ref');
  readonly storePath = join(this.root, 'ws.chronicle');
  store: JsStore;
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    mkdirSync(this.ref, { recursive: true });
    this.store = JsStore.openOrCreate({ path: this.storePath });
    t.after(async () => {
      directWriteTestSeam.afterStage = undefined;
      directWriteTestSeam.beforeRename = undefined;
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  file(rel: string, content: string | Buffer): void {
    mkdirSync(dirname(join(this.ref, rel)), { recursive: true });
    writeFileSync(join(this.ref, rel), content);
  }

  text(rel: string): string {
    return readFileSync(join(this.ref, rel), 'utf8');
  }

  /** The staged files left anywhere beneath the mount's root. */
  staged(): string[] {
    return (readdirSync(this.ref, { recursive: true }) as string[]).filter((p) => p.split('/').at(-1)!.startsWith(STAGED_PREFIX));
  }

  /** A module whose `ref` mount is direct and names no mode, so it's writable, unless `mount` says otherwise. */
  async open(mount: Partial<MountConfig> = {}, more: MountConfig[] = []): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({
      mounts: [{ name: 'ref', path: this.ref, backend: 'direct', ...mount } as MountConfig, ...more],
    });
    m.initStore(this.store);
    await m.start({
      isRestart: false,
      getState: () => null,
      setState: () => {},
      pushEvent: () => {},
      notifyOps: () => {},
    } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }

  /** Stop a module, as a session ends, saving what its stop saves. */
  async close(m: WorkspaceModule): Promise<void> {
    await m.stop();
    this.live = this.live.filter((x) => x !== m);
  }

  stateIds(): string[] {
    return this.store.listStates().map((s) => s.id).sort();
  }
}

function call(m: WorkspaceModule, name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  return m.handleToolCall({ id: name, name, input, callerAgentName: 'scout' });
}

async function data<T = Record<string, unknown>>(m: WorkspaceModule, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const result = await call(m, name, input);
  assert.equal(result.success, true, `${name} ${JSON.stringify(input)}: ${result.error}`);
  return (result.structured ?? result.data) as T;
}

async function failure(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<string> {
  const result = await call(m, name, input);
  assert.equal(result.success, false, `${name} ${JSON.stringify(input)} succeeded: ${JSON.stringify(result.data)}`);
  return result.error!;
}

const mode = (path: string) => statSync(path).mode & 0o7777;

test('write, edit, edit_many and delete on a direct mount with no mode land on disk when they answer, and nothing goes into the store', async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'alpha\nbeta\n');
  env.file('src/b.ts', 'one\ntwo\n');
  env.file('old.txt', 'old\n');
  const m = await env.open();
  const states = env.stateIds();

  const written = await data<{ path: string; size: number; hash: string }>(m, 'write', { path: 'ref/new/dir/c.ts', content: 'gamma\n' });
  assert.deepEqual([written.path, written.size, typeof written.hash], ['ref/new/dir/c.ts', 6, 'string']);
  assert.equal(env.text('new/dir/c.ts'), 'gamma\n');
  assert.equal((await data<{ replacements: number }>(m, 'edit', { path: 'ref/src/a.ts', oldString: 'beta', newString: 'BETA' })).replacements, 1);
  assert.equal(env.text('src/a.ts'), 'alpha\nBETA\n');
  await data(m, 'edit_many', { edits: [{ path: 'ref/src/a.ts', oldString: 'alpha', newString: 'ALPHA' }, { path: 'ref/src/b.ts', oldString: 'two', newString: 'TWO' }] });
  assert.deepEqual([env.text('src/a.ts'), env.text('src/b.ts')], ['ALPHA\nBETA\n', 'one\nTWO\n']);
  assert.deepEqual(await data(m, 'delete', { path: 'ref/old.txt' }), { path: 'ref/old.txt', deleted: true, disk: 'done' });
  assert.throws(() => statSync(join(env.ref, 'old.txt')), { code: 'ENOENT' });

  // A new file takes the mode a shell's would.
  const umask = process.umask();
  assert.equal(mode(join(env.ref, 'new/dir/c.ts')), 0o666 & ~umask);
  assert.deepEqual(env.staged(), []);
  assert.deepEqual(env.stateIds(), states, 'no state was made');
  // Reads see disk's copy straight after.
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/src/b.ts' })).content, '     1\tone\n     2\tTWO');
});

test('ls without a path and status say a direct mount that names no mode is writable', async (t) => {
  const env = new Env(t);
  const m = await env.open();
  const ls = await data<{ mounts: Array<Record<string, unknown>> }>(m, 'ls');
  assert.equal(ls.mounts[0]!.mode, 'read-write');
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.mode, 'read-write');
  const ro = await env.open({ mode: 'read-only' });
  assert.equal((await data<{ mounts: Array<Record<string, unknown>> }>(ro, 'ls')).mounts[0]!.mode, 'read-only');
});

test('an edited 0755 script stays 0755 and runnable, and an edited file keeps its own mode', { skip: process.platform === 'win32' ? 'no modes' : false }, async (t) => {
  const env = new Env(t);
  env.file('run.sh', '#!/bin/sh\necho before\n');
  chmodSync(join(env.ref, 'run.sh'), 0o755);
  env.file('secret.txt', 'key\n');
  chmodSync(join(env.ref, 'secret.txt'), 0o600);
  // Bits a umask would take off a new file, and a special bit its owner may set.
  env.file('open.txt', 'open\n');
  chmodSync(join(env.ref, 'open.txt'), 0o777);
  env.file('setuid.sh', '#!/bin/sh\n');
  chmodSync(join(env.ref, 'setuid.sh'), 0o4755);
  const m = await env.open();
  await data(m, 'edit', { path: 'ref/run.sh', oldString: 'before', newString: 'after' });
  await data(m, 'write', { path: 'ref/secret.txt', content: 'other key\n' });
  await data(m, 'edit', { path: 'ref/open.txt', oldString: 'open', newString: 'still open' });
  await data(m, 'write', { path: 'ref/setuid.sh', content: '#!/bin/sh\necho\n' });
  assert.equal(mode(join(env.ref, 'run.sh')), 0o755);
  assert.equal(mode(join(env.ref, 'secret.txt')), 0o600);
  assert.equal(mode(join(env.ref, 'open.txt')), 0o777);
  assert.equal(mode(join(env.ref, 'setuid.sh')), 0o4755);
  // A new file takes the umask as it is when it's made, not as it was when the module loaded.
  const umask = process.umask(0o077);
  try {
    await data(m, 'write', { path: 'ref/new-private.txt', content: 'mine\n' });
  } finally {
    process.umask(umask);
  }
  assert.equal(mode(join(env.ref, 'new-private.txt')), 0o600);
  // And the identity a write checks names the file's real owner and group.
  const own = identityOf(lstatSync(join(env.ref, 'run.sh'), { bigint: true }));
  assert.deepEqual([own.uid, own.gid], [BigInt(process.getuid!()), BigInt(statSync(join(env.ref, 'run.sh')).gid)]);
  // A file its owner made read-only is refused, as a push's write is.
  if (!IS_ROOT) {
    env.file('locked.txt', 'locked\n');
    chmodSync(join(env.ref, 'locked.txt'), 0o444);
    assert.equal(await failure(m, 'write', { path: 'ref/locked.txt', content: 'no\n' }), `The write did nothing to "ref/locked.txt": a file the host's process may not write (permission denied): its mode or owner keeps that process out, and calling again is refused until the file's owner, or whoever runs the host, changes that.`);
    assert.match(await failure(m, 'edit', { path: 'ref/locked.txt', oldString: 'locked', newString: 'no' }), /a file the host's process may not write \(permission denied\)/);
    assert.equal(env.text('locked.txt'), 'locked\n');
    assert.equal(mode(join(env.ref, 'locked.txt')), 0o444);
    // And one made read-only after the call staged its bytes, just before the rename.
    env.file('late.txt', 'late\n');
    directWriteTestSeam.afterStage = () => chmodSync(join(env.ref, 'late.txt'), 0o444);
    assert.match(await failure(m, 'write', { path: 'ref/late.txt', content: 'no\n' }), /a file the host's process may not write \(permission denied\)/);
    directWriteTestSeam.afterStage = undefined;
    assert.equal(env.text('late.txt'), 'late\n');
    assert.deepEqual(env.staged(), []);
  }
  const ran = spawnSync(join(env.ref, 'run.sh'), { encoding: 'utf8' });
  assert.equal(ran.stdout, 'after\n');
});

test("a direct edit's answer is a 'chronicle' mount's for the same edit, changed region included", async (t) => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const edit = { path: 'ref/f.txt', oldString: 'line 12\nline 13', newString: 'line twelve\nline thirteen\nline 13.5' };
  const many = { edits: [{ path: 'ref/f.txt', oldString: 'line 20', newString: 'line twenty' }, { path: 'ref/g.txt', oldString: 'line 2\n', newString: '' }] };

  const chronicleEnv = new Env(t);
  chronicleEnv.file('f.txt', text);
  chronicleEnv.file('g.txt', text);
  const chronicle = await chronicleEnv.open({ backend: 'chronicle', mode: 'read-write', watch: 'never', autoMaterialize: true });
  const fromChronicle = [await data(chronicle, 'edit', edit), await data(chronicle, 'edit_many', { edits: [{ ...edit, oldString: 'line twelve', newString: 'line 12' }] })];
  const chronicleMany = await data(chronicle, 'edit_many', many);

  const directEnv = new Env(t);
  directEnv.file('f.txt', text);
  directEnv.file('g.txt', text);
  const direct = await directEnv.open();
  const fromDirect = [await data(direct, 'edit', edit), await data(direct, 'edit_many', { edits: [{ ...edit, oldString: 'line twelve', newString: 'line 12' }] })];
  const directMany = await data(direct, 'edit_many', many);

  assert.deepEqual(fromDirect, fromChronicle);
  assert.deepEqual(directMany, chronicleMany);
  assert.match(String((fromDirect[0] as { changed: string }).changed), /line twelve/);
  assert.equal(directEnv.text('f.txt'), chronicleEnv.text('f.txt'));
});

test("a change another writer makes between an edit's read and its rename is kept, with the edit applied again on top of it", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'head\nmiddle\ntail\n');
  const m = await env.open();
  let staged = 0;
  directWriteTestSeam.afterStage = () => {
    if (staged++ === 0) writeFileSync(join(env.ref, 'f.txt'), 'head\nmiddle\ntail\nanother writer\n');
  };
  const answer = await data<{ note?: string }>(m, 'edit', { path: 'ref/f.txt', oldString: 'middle', newString: 'MIDDLE' });
  assert.equal(env.text('f.txt'), 'head\nMIDDLE\ntail\nanother writer\n');
  assert.equal(staged, 2);
  assert.equal(answer.note, "Disk's copy changed while this call was being applied, so it was read again, and the edit applied to its new text.");
  assert.deepEqual(env.staged(), []);
});

test("an edit whose match another writer's change removed is refused, with that writer's text left as it is", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'head\nmiddle\ntail\n');
  const m = await env.open();
  directWriteTestSeam.afterStage = () => writeFileSync(join(env.ref, 'f.txt'), 'head\nrewritten\ntail\n');
  const error = await failure(m, 'edit', { path: 'ref/f.txt', oldString: 'middle', newString: 'MIDDLE' });
  assert.match(error, /^The edit did nothing: /);
  assert.match(error, /Disk's copy changed while this call was being applied, so it was read again, and the edit looked in its new text\./);
  assert.equal(env.text('f.txt'), 'head\nrewritten\ntail\n');
  assert.deepEqual(env.staged(), []);
});

test('a file another writer changes at every attempt is refused after the third, with nothing written', async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'middle\n');
  const m = await env.open();
  // Each change grows the file, so a kernel that stamps from a coarse clock
  // shows it too.
  let n = 0;
  directWriteTestSeam.afterStage = () => writeFileSync(join(env.ref, 'f.txt'), `middle\nchange ${'!'.repeat(++n)}\n`);
  assert.equal(
    await failure(m, 'edit', { path: 'ref/f.txt', oldString: 'middle', newString: 'MIDDLE' }),
    'ref/f.txt kept changing on disk while this edit was being applied (3 attempts), so nothing was written. Read it again before retrying.',
  );
  assert.equal(n, 3);
  assert.equal(env.text('f.txt'), 'middle\nchange !!!\n');
  assert.deepEqual(env.staged(), []);
  n = 0;
  env.file('g.txt', 'middle\n');
  directWriteTestSeam.afterStage = () => {
    writeFileSync(join(env.ref, 'g.txt'), `middle\nchange ${'!'.repeat(++n)}\n`);
  };
  assert.equal(
    await failure(m, 'edit_many', { edits: [{ path: 'ref/f.txt', oldString: 'change !!!', newString: 'three' }, { path: 'ref/g.txt', oldString: 'middle', newString: 'MIDDLE' }] }),
    "Another writer kept changing this call's files on disk while it was being applied: each of its 3 attempts found one changed since its read (ref/g.txt), so nothing was written. Read it again before retrying.",
  );
  assert.equal(env.text('f.txt'), 'middle\nchange !!!\n');
});

test("the check before an edit's rename compares the file's bytes as well as its identity, so a same-size change a coarse clock leaves unstamped is seen", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'aaaa\n');
  const root = realpathSync(env.ref);
  const view = { root, name: 'ref', followSymlinks: false, maxFileSize: 1 << 20, ignore: [], others: [] };
  const staged = await stageContained(view, root, 'f.txt', Buffer.from('new\n'));
  const stamped = () => identityOf(lstatSync(join(env.ref, 'f.txt'), { bigint: true }));
  // The file as the edit read it.
  assert.doesNotThrow(() => checkUnchanged(staged, { identity: stamped(), bytes: Buffer.from('aaaa\n') }));
  // Another writer's change of the same size, whose identity a coarse clock
  // would leave as the read found it: here the identity is taken after it.
  writeFileSync(join(env.ref, 'f.txt'), 'bbbb\n');
  assert.throws(() => checkUnchanged(staged, { identity: stamped(), bytes: Buffer.from('aaaa\n') }), FileChanged);
  // And the identity is compared too: a file re-moded or re-owned under
  // the call has the same bytes, and its mode, owner and group are fields of
  // the identity, whatever the clock. Each is pinned on its own: the
  // identity taken after the chmod, with only that field as it was before.
  const before = stamped();
  chmodSync(join(env.ref, 'f.txt'), 0o600);
  const after = stamped();
  const bytes = Buffer.from('bbbb\n');
  assert.doesNotThrow(() => checkUnchanged(staged, { identity: after, bytes }));
  assert.throws(() => checkUnchanged(staged, { identity: { ...after, mode: before.mode }, bytes }), FileChanged);
  assert.throws(() => checkUnchanged(staged, { identity: { ...after, uid: after.uid + 1n }, bytes }), FileChanged);
  assert.throws(() => checkUnchanged(staged, { identity: { ...after, gid: after.gid + 1n }, bytes }), FileChanged);
  // The identity is taken after the bytes are read: a file another writer
  // renames over the path while they're read, after the read got the old
  // ones, is a change. The read is synchronous, so it's stood in for here.
  const fs = createRequire(import.meta.url)('node:fs') as { readSync: (...args: unknown[]) => number };
  const readSync = fs.readSync;
  fs.readSync = (...args: unknown[]) => {
    const got = readSync(...args);
    writeFileSync(join(env.root, 'theirs.txt'), 'cccc\n');
    renameSync(join(env.root, 'theirs.txt'), join(env.ref, 'f.txt'));
    fs.readSync = readSync;
    syncBuiltinESMExports();
    return got;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => checkUnchanged(staged, { identity: stamped(), bytes }), FileChanged);
  } finally {
    fs.readSync = readSync;
    syncBuiltinESMExports();
  }
  assert.equal(env.text('f.txt'), 'cccc\n');
  await discard(staged);
  assert.deepEqual(env.staged(), []);
});

test('a symlink swapped in for the file while an edit or a write is applied is refused, and neither the link nor its target is changed', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'middle\n');
  const outside = join(env.root, 'outside.txt');
  writeFileSync(outside, 'outside\n');
  const m = await env.open();
  const swap = () => {
    unlinkSync(join(env.ref, 'f.txt'));
    symlinkSync(outside, join(env.ref, 'f.txt'));
  };
  directWriteTestSeam.afterStage = swap;
  assert.match(await failure(m, 'edit', { path: 'ref/f.txt', oldString: 'middle', newString: 'MIDDLE' }), /it became a symlink while this call was being applied, so the edit changed nothing/);
  assert.equal(readlinkSync(join(env.ref, 'f.txt')), outside);
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  unlinkSync(join(env.ref, 'f.txt'));
  env.file('f.txt', 'middle\n');
  assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), 'The write did nothing to "ref/f.txt": it became a symlink while this call was being applied. Calling again checks it afresh.');
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  assert.deepEqual(env.staged(), []);
});

test('a hard-linked file gets a file of its own at its path, the other link keeps the old text, and the answer names it', { skip: process.platform === 'win32' ? 'hard links differ' : false }, async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'shared\n');
  const store = join(env.root, 'store-copy.txt');
  linkSync(join(env.ref, 'f.txt'), store);
  env.file('g.txt', 'shared too\n');
  linkSync(join(env.ref, 'g.txt'), join(env.root, 'g-copy.txt'));
  const m = await env.open();
  const edited = await data<{ note?: string }>(m, 'edit', { path: 'ref/f.txt', oldString: 'shared', newString: 'mine' });
  assert.equal(edited.note, 'ref/f.txt had another hard link, which keeps its old text: the edit gave this path a file of its own.');
  assert.deepEqual([env.text('f.txt'), readFileSync(store, 'utf8')], ['mine\n', 'shared\n']);
  assert.equal(lstatSync(join(env.ref, 'f.txt')).nlink, 1);
  const written = await data<{ note?: string }>(m, 'write', { path: 'ref/g.txt', content: 'mine too\n' });
  assert.equal(written.note, 'ref/g.txt had another hard link, which keeps its old text: the write gave this path a file of its own.');
  assert.equal(readFileSync(join(env.root, 'g-copy.txt'), 'utf8'), 'shared too\n');
});

test('a write whose process dies before its rename leaves the old file whole, and the staged file beside it carries its name', { skip: process.platform === 'win32' ? 'no SIGKILL' : false }, async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old and whole\n');
  const module = new URL('../src/modules/workspace/direct-write.js', import.meta.url).href;
  const script = `
    const { stageContained, renameInto, directWriteTestSeam } = await import(${JSON.stringify(module)});
    const view = { root: ${JSON.stringify(realpathSync(env.ref))}, name: 'ref', followSymlinks: false, maxFileSize: 1 << 20, ignore: [], others: [] };
    const staged = await stageContained(view, ${JSON.stringify(realpathSync(env.ref))}, 'f.txt', Buffer.from('new\\n'));
    directWriteTestSeam.beforeRename = () => process.kill(process.pid, 'SIGKILL');
    renameInto(staged);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(env.text('f.txt'), 'old and whole\n');
  const left = env.staged();
  assert.equal(left.length, 1);
  assert.match(left[0]!, /^\.workspace-staged-.+$/);
  assert.equal(env.text(left[0]!), 'new\n');
  // ls shows it under that name, as a file of the mount's.
  const m = await env.open();
  assert.ok((await data<{ entries: Array<{ name: string }> }>(m, 'ls', { path: 'ref' })).entries.some((e) => e.name === left[0]));
});

test("a deletion whose unlink fails after reaching the file says the file may be gone, and one disk refuses outright says it did nothing", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = fsp.unlink!;
  const failWith = (code: string) => {
    fsp.unlink = async (path: unknown) => {
      if (String(path).endsWith('f.txt')) throw Object.assign(new Error(`${code}: failed`), { code });
      return original(path);
    };
    syncBuiltinESMExports();
  };
  const position = () => (m as unknown as { directHeads: Map<string, Map<string, unknown>> }).directHeads.get('ref')?.has('scout') ?? false;
  try {
    failWith('EACCES');
    assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }),
      'The delete did nothing to "ref/f.txt": could not unlink the file: permission denied. Calling again won\'t change that; whoever runs this host can change the permissions.');
    assert.equal(position(), false, 'a deletion disk refused outright is no write of the agent\'s');
    failWith('EIO');
    assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }),
      'The delete of "ref/f.txt" failed after it reached the file, so the file may be gone: could not unlink the file: an input/output error on the disk. ls shows whether it is.');
    assert.equal(position(), true, 'one that may have landed is taken as the agent\'s write');
  } finally {
    fsp.unlink = original;
    syncBuiltinESMExports();
  }
  assert.equal(env.text('f.txt'), 'old\n');
});

test('a staged file swapped for a link before the rename is refused, and the link\'s target is left as it was', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const outside = join(env.root, 'outside.txt');
  writeFileSync(outside, 'outside\n');
  const m = await env.open();
  directWriteTestSeam.afterStage = () => {
    const [temp] = env.staged();
    unlinkSync(join(env.ref, temp!));
    symlinkSync(outside, join(env.ref, temp!));
  };
  assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), 'The write did nothing to "ref/f.txt": another writer replaced the staged copy of the new text before it could be renamed over the file, which is as it was. Calling again writes it afresh.');
  assert.equal(env.text('f.txt'), 'old\n');
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  // What the other writer put at the staged name is theirs, and stays.
  const [left] = env.staged();
  assert.ok(left && lstatSync(join(env.ref, left)).isSymbolicLink(), `left: ${JSON.stringify(readdirSync(env.ref))}`);
  // And a regular file put there, which can take the staged file's inode number.
  rmSync(join(env.ref, left));
  directWriteTestSeam.afterStage = () => {
    const [temp] = env.staged();
    unlinkSync(join(env.ref, temp!));
    writeFileSync(join(env.ref, temp!), 'theirs\n');
  };
  assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), 'The write did nothing to "ref/f.txt": another writer replaced the staged copy of the new text before it could be renamed over the file, which is as it was. Calling again writes it afresh.');
  assert.equal(env.text('f.txt'), 'old\n');
  const [theirs] = env.staged();
  assert.equal(theirs && env.text(theirs), 'theirs\n');
  rmSync(join(env.ref, theirs!));
  // Whether a file made there takes the freed inode number is the file
  // system's choice, so the same comparison is pinned on the staged file
  // itself, rewritten in place: its device and inode stay, and its bytes
  // aren't the call's.
  directWriteTestSeam.afterStage = () => {
    const [temp] = env.staged();
    writeFileSync(join(env.ref, temp!), 'rewritten\n');
  };
  assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), 'The write did nothing to "ref/f.txt": another writer replaced the staged copy of the new text before it could be renamed over the file, which is as it was. Calling again writes it afresh.');
  assert.equal(env.text('f.txt'), 'old\n');
});

test("a replaced file's staged copy is the owner's alone until it takes the file's mode", { skip: process.platform === 'win32' ? 'no modes' : false }, async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  chmodSync(join(env.ref, 'f.txt'), 0o644);
  const m = await env.open();
  const probe = await open(join(env.ref, 'f.txt'), 'r');
  const proto = Object.getPrototypeOf(probe) as { writeFile: (this: unknown, ...args: unknown[]) => Promise<void> };
  await probe.close();
  const writeFile = proto.writeFile;
  const seen: number[] = [];
  proto.writeFile = async function (this: unknown, ...args: unknown[]) {
    const [temp] = env.staged();
    seen.push(mode(join(env.ref, temp!)));
    return writeFile.apply(this, args);
  };
  // Under a umask that would leave a new file readable by others.
  const umask = process.umask(0o022);
  try {
    await data(m, 'write', { path: 'ref/f.txt', content: 'new\n' });
  } finally {
    process.umask(umask);
    proto.writeFile = writeFile;
  }
  assert.deepEqual(seen, [0o600], 'while its bytes were written');
  assert.equal(mode(join(env.ref, 'f.txt')), 0o644, 'and the file has its own mode after');
  assert.equal(env.text('f.txt'), 'new\n');
});

test("the staged file is moded through its own handle, so a file swapped in at its name before the mode change keeps its mode, and the rename is refused", { skip: process.platform === 'win32' ? 'no modes' : false }, async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  chmodSync(join(env.ref, 'f.txt'), 0o640);
  const m = await env.open();
  const probe = await open(join(env.ref, 'f.txt'), 'r');
  const proto = Object.getPrototypeOf(probe) as { chmod: (this: unknown, mode: number) => Promise<void> };
  await probe.close();
  const chmod = proto.chmod;
  proto.chmod = async function (this: unknown, mode: number) {
    const [temp] = env.staged();
    renameSync(join(env.ref, temp!), join(env.root, 'aside'));
    writeFileSync(join(env.ref, temp!), 'theirs\n', { mode: 0o600 });
    return chmod.call(this, mode);
  };
  try {
    assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), 'The write did nothing to "ref/f.txt": another writer replaced the staged copy of the new text before it could be renamed over the file, which is as it was. Calling again writes it afresh.');
  } finally {
    proto.chmod = chmod;
  }
  const [theirs] = env.staged();
  assert.equal(mode(join(env.ref, theirs!)), 0o600, 'the file at the staged name kept its own mode');
  assert.equal(mode(join(env.root, 'aside')), 0o640, 'the handle moded the file it opened');
  assert.equal(env.text('f.txt'), 'old\n');
});

test('a staged file whose write fails once made is removed, and says why', async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  const probe = await open(join(env.ref, 'f.txt'), 'r');
  const proto = Object.getPrototypeOf(probe) as { writeFile: (this: unknown, ...args: unknown[]) => Promise<void> };
  await probe.close();
  const writeFile = proto.writeFile;
  proto.writeFile = async function () {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  try {
    assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), `The write did nothing to "ref/f.txt": cannot write the staged file beside it (no space left on the disk). Calling again won't change that; whoever runs this host can free space on its disk.`);
  } finally {
    proto.writeFile = writeFile;
  }
  assert.deepEqual(env.staged(), []);
  assert.equal(env.text('f.txt'), 'old\n');
  // A file another writer put at the staged name before the failure is theirs, and stays.
  proto.writeFile = async function () {
    const [temp] = env.staged();
    renameSync(join(env.ref, temp!), join(env.root, 'aside'));
    writeFileSync(join(env.ref, temp!), 'theirs\n');
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  try {
    assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), `The write did nothing to "ref/f.txt": cannot write the staged file beside it (no space left on the disk). Calling again won't change that; whoever runs this host can free space on its disk.`);
  } finally {
    proto.writeFile = writeFile;
  }
  const [theirs] = env.staged();
  assert.equal(theirs && env.text(theirs), 'theirs\n');
  assert.equal(env.text('f.txt'), 'old\n');
});

test("a landed write whose position can't be read from the store still answers that it landed", async (t) => {
  const env = new Env(t);
  const m = await env.open();
  const currentBranch = env.store.currentBranch;
  env.store.currentBranch = () => {
    throw new Error('zz-store-unreadable');
  };
  const error = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    await data(m, 'write', { path: 'ref/a.txt', content: 'one\n' });
  } finally {
    env.store.currentBranch = currentBranch;
    console.error = error;
  }
  assert.equal(env.text('a.txt'), 'one\n');
  assert.ok(logged.some((args) => String(args[0]).includes("could not record a direct write's position")), JSON.stringify(logged));
});

test('a write whose file\'s directory is replaced after staging does nothing, and says the directory changed', async (t) => {
  const env = new Env(t);
  env.file('d/f.txt', 'old\n');
  const m = await env.open();
  directWriteTestSeam.afterStage = () => {
    renameSync(join(env.ref, 'd'), join(env.ref, 'd-moved'));
    mkdirSync(join(env.ref, 'd'));
  };
  assert.equal(await failure(m, 'write', { path: 'ref/d/f.txt', content: 'new\n' }), 'The write did nothing to "ref/d/f.txt": the directory changed since it was checked. Calling again checks it afresh.');
  assert.equal(env.text('d-moved/f.txt'), 'old\n');
  assert.throws(() => statSync(join(env.ref, 'd/f.txt')), { code: 'ENOENT' });
});

test('a deletion whose mount root is replaced after its open is refused, and the file in the new root stays', async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  // The root is replaced once the deletion's open of the file closes: after
  // that open's own checks, before the unlink. A FileHandle's close is its
  // own property, so it's wrapped on each handle the file's open returns.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalOpen = fsp.open!;
  let swapped = false;
  fsp.open = async (...args: unknown[]) => {
    const handle = await originalOpen(...args) as { close: () => Promise<void> };
    if (String(args[0]).endsWith('f.txt')) {
      const close = handle.close;
      handle.close = async () => {
        await close.call(handle);
        if (swapped) return;
        swapped = true;
        renameSync(env.ref, `${env.ref}-moved`);
        mkdirSync(env.ref);
        writeFileSync(join(env.ref, 'f.txt'), 'new root\n');
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }), `The delete did nothing to "ref/f.txt": ${ROOT_MOVED}.`);
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.ok(swapped, 'the root was replaced during the call');
  assert.equal(env.text('f.txt'), 'new root\n');
  assert.equal(readFileSync(join(`${env.ref}-moved`, 'f.txt'), 'utf8'), 'old\n');
  // Replaced while the open itself runs: refused in the same words, not a read's.
  rmSync(`${env.ref}-moved`, { recursive: true });
  let during = false;
  fsp.open = async (...args: unknown[]) => {
    if (!during && String(args[0]).endsWith('f.txt')) {
      during = true;
      renameSync(env.ref, `${env.ref}-moved`);
      mkdirSync(env.ref);
      writeFileSync(join(env.ref, 'f.txt'), 'newer root\n');
    }
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }), `The delete did nothing to "ref/f.txt": ${ROOT_MOVED}.`);
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.ok(during);
  assert.equal(env.text('f.txt'), 'newer root\n');
  assert.equal(readFileSync(join(`${env.ref}-moved`, 'f.txt'), 'utf8'), 'new root\n');
});

test('a write refuses a pipe swapped in for its file before the rename, and leaves it', { skip: process.platform === 'win32' ? 'no FIFOs' : false }, async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  directWriteTestSeam.afterStage = () => {
    unlinkSync(join(env.ref, 'f.txt'));
    assert.equal(spawnSync('mkfifo', [join(env.ref, 'f.txt')]).status, 0);
  };
  assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), `The write did nothing to "ref/f.txt": not a regular file. Calling again won't change that; whoever runs this host can put a regular file there.`);
  assert.ok(lstatSync(join(env.ref, 'f.txt')).isFIFO());
  assert.deepEqual(env.staged(), []);
});

test('a write or an edit whose rename fails leaves the file as it was and no staged file, and says why', async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  directWriteTestSeam.beforeRename = () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); };
  assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), 'The write did nothing to "ref/f.txt": cannot rename the staged file over it (an input/output error on the disk). Calling again may work; if it fails the same way, whoever runs this host can check the disk.');
  assert.equal(
    await failure(m, 'edit', { path: 'ref/f.txt', oldString: 'old', newString: 'new' }),
    'ref/f.txt: cannot rename the staged file over it (an input/output error on the disk), so the edit changed nothing. Calling again may work; if it fails the same way, whoever runs this host can check the disk.',
  );
  assert.equal(env.text('f.txt'), 'old\n');
  assert.deepEqual(env.staged(), []);
});

test("edit_many on a direct mount: a file another writer changes after the plan has the call's edits applied again before any file is written", async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'a1\n');
  env.file('b.txt', 'b1\n');
  const m = await env.open();
  let staged = 0;
  const renamed: string[] = [];
  directWriteTestSeam.afterStage = () => {
    if (staged++ === 0) writeFileSync(join(env.ref, 'b.txt'), 'b1\nfrom another writer\n');
  };
  directWriteTestSeam.beforeRename = (path) => { renamed.push(`${staged}:${path.split('/').at(-1)}`); };
  const answer = await data<{ files: Array<{ path: string; note?: string }> }>(m, 'edit_many', {
    edits: [{ path: 'ref/a.txt', oldString: 'a1', newString: 'A1' }, { path: 'ref/b.txt', oldString: 'b1', newString: 'B1' }],
  });
  assert.deepEqual([env.text('a.txt'), env.text('b.txt')], ['A1\n', 'B1\nfrom another writer\n']);
  assert.deepEqual([...renamed].sort(), ['2:a.txt', '2:b.txt'], 'every rename came in the second attempt');
  assert.deepEqual(answer.files.map((f) => f.note), [
    undefined,
    "Disk's copy of ref/b.txt changed while this call was being applied, so it was read again, and edit 2 applied to its new text.",
  ]);
});

test('edit_many on a direct mount whose staging fails writes no file', { skip: IS_ROOT || process.platform === 'win32' ? 'root writes every directory' : false }, async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'a1\n');
  env.file('locked/b.txt', 'b1\n');
  const m = await env.open();
  chmodSync(join(env.ref, 'locked'), 0o555);
  let error: string;
  try {
    error = await failure(m, 'edit_many', {
      edits: [{ path: 'ref/a.txt', oldString: 'a1', newString: 'A1' }, { path: 'ref/locked/b.txt', oldString: 'b1', newString: 'B1' }],
    });
  } finally {
    chmodSync(join(env.ref, 'locked'), 0o755);
  }
  assert.match(error, /^The edit_many call wrote none of its edits: 1 problem\.\n\nedit 2: ref\/locked\/b\.txt: cannot make the staged file in its directory \(permission denied\): a direct write needs to write the file's directory as well as the file, so edit 2 changed nothing\. No file was written\. Calling again won't change that; whoever runs this host can change the permissions\.$/);
  assert.deepEqual([env.text('a.txt'), env.text('locked/b.txt')], ['a1\n', 'b1\n']);
  assert.deepEqual(env.staged(), []);
});

test('edit_many on a direct mount whose rename fails partway names each file\'s outcome, and leaves the written ones written', async (t) => {
  const env = new Env(t);
  for (const name of ['a', 'b', 'c']) env.file(`${name}.txt`, `${name}1\n`);
  const m = await env.open();
  directWriteTestSeam.beforeRename = (path) => {
    if (path.endsWith('b.txt')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  const error = await failure(m, 'edit_many', { edits: ['a', 'b', 'c'].map((name) => ({ path: `ref/${name}.txt`, oldString: `${name}1`, newString: `${name.toUpperCase()}1` })) });
  assert.equal(error, [
    "The edit_many call wrote 1 of its 3 files before the next one's write failed: cannot rename the staged file over it (no space left on the disk). "
      + 'Whoever runs this host can free space on its disk. '
      + "Nothing puts the written files back, so finish or revert them: in each written file, each of its edits replaced its oldString with its newString. Each file's outcome:",
    'ref/a.txt: written',
    'ref/b.txt: not written, as it was (its write failed)',
    'ref/c.txt: not written, as it was',
  ].join('\n\n'));
  assert.deepEqual(['a', 'b', 'c'].map((name) => env.text(`${name}.txt`)), ['A1\n', 'b1\n', 'c1\n']);
  assert.deepEqual(env.staged(), []);
});

test("a partway answer over its budget leaves outcomes out, counts them, and keeps within the budget", async (t) => {
  const env = new Env(t);
  const names = Array.from({ length: 40 }, (_, i) => `file-with-a-longish-name-${String(i).padStart(2, '0')}.txt`);
  for (const name of names) env.file(name, 'x1\n');
  const m = await env.open();
  directWriteTestSeam.beforeRename = (path) => {
    if (path.endsWith(names.at(-1)!)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  const result = await m.handleToolCall({
    id: 'tight', name: 'edit_many', callerAgentName: 'scout', resultMaxChars: 1000,
    input: { edits: names.map((n) => ({ path: `ref/${n}`, oldString: 'x1', newString: 'X1' })) },
  });
  assert.equal(result.success, false);
  assert.ok(result.error!.length <= 1000, `${result.error!.length} characters`);
  assert.match(result.error!, /^The edit_many call wrote 39 of its 40 files before the next one's write failed/);
  assert.match(result.error!, /\[To keep this answer within 1,000 characters, it leaves out the outcomes of \d+ more files\. Reading a file shows it as disk has it now\.\]$/);
});

test('a partway answer names the hard links a written file split from, as a whole answer does', { skip: process.platform === 'win32' ? 'hard links need privileges' : false }, async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'a1\n');
  env.file('b.txt', 'b1\n');
  linkSync(join(env.ref, 'a.txt'), join(env.root, 'a-elsewhere.txt'));
  const m = await env.open();
  directWriteTestSeam.beforeRename = (path) => {
    if (path.endsWith('b.txt')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  const error = await failure(m, 'edit_many', { edits: [{ path: 'ref/a.txt', oldString: 'a1', newString: 'A1' }, { path: 'ref/b.txt', oldString: 'b1', newString: 'B1' }] });
  assert.match(error, /ref\/a\.txt had another hard link, which keeps its old text: the call gave this path a file of its own\./);
  assert.equal(readFileSync(join(env.root, 'a-elsewhere.txt'), 'utf8'), 'a1\n');
});

test('a write whose mount root is replaced after staging does nothing, and says a new call works beneath the directory there now', async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  directWriteTestSeam.afterStage = () => {
    renameSync(env.ref, `${env.ref}-moved`);
    mkdirSync(env.ref);
  };
  assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), `The write did nothing to "ref/f.txt": ${ROOT_MOVED}.`);
  assert.equal(readFileSync(join(`${env.ref}-moved`, 'f.txt'), 'utf8'), 'old\n');
});

test('writeBinary to a direct mount for a branch the store leaves before the rename writes nothing, and says the branch was left', async (t) => {
  const env = new Env(t);
  env.file('img.bin', 'old');
  const m = await env.open();
  const main = env.store.currentBranch().name;
  directWriteTestSeam.afterStage = () => {
    env.store.createBranch('zz-elsewhere', main);
    env.store.switchBranch('zz-elsewhere');
  };
  const left = await m.writeBinary('ref/img.bin', Buffer.from('new'), 'application/octet-stream', { branch: main });
  assert.deepEqual([left.success, left.error, left.data], [false, 'the workspace had left the branch this file is for', { branchLeft: true }]);
  assert.equal(env.text('img.bin'), 'old');
  assert.deepEqual(env.staged(), []);
  // A request already for a left branch makes no directory and stages nothing.
  directWriteTestSeam.afterStage = undefined;
  const early = await m.writeBinary('ref/new-dir/img.bin', Buffer.from('new'), 'application/octet-stream', { branch: main });
  assert.deepEqual([early.success, early.data], [false, { branchLeft: true }]);
  assert.throws(() => statSync(join(env.ref, 'new-dir')), { code: 'ENOENT' });
  // On the branch it names, it writes.
  env.store.switchBranch(main);
  const written = await m.writeBinary('ref/img.bin', Buffer.from('new'), 'application/octet-stream', { branch: main });
  assert.equal(written.success, true, written.error);
  assert.equal(env.text('img.bin'), 'new');
});

test("each agent's position is saved at stop in a global record and loaded before any write, so a write after the restart is judged against it", async (t) => {
  const env = new Env(t);
  // Positions as a session leaves them at its stop: the scout's on this
  // branch, the helper's and the guide's on branches gone since.
  const first = await env.open();
  const branch = env.store.currentBranch().id;
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const headsOf = (m: WorkspaceModule) => (m as unknown as { directHeads: Heads }).directHeads;
  headsOf(first).set('ref', new Map([
    ['scout', { branchId: branch, after: 0, notice: null }],
    ['helper', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }],
    ['guide', { branchId: 'zz-another-branch-gone-since', after: 1, notice: 'zz-a-notice-gone-since' }],
  ]));
  await env.close(first);
  // Loaded when the store is handed over, so a write before the start is
  // judged against them: the scout's moves its position on, since its
  // history holds the saved one; the guide's doesn't, since no branch here
  // holds the saved one.
  const m = new WorkspaceModule({ mounts: [{ name: 'ref', path: env.ref, backend: 'direct' } as MountConfig] });
  t.after(() => m.stop().catch(() => {}));
  m.initStore(env.store);
  await data(m, 'write', { path: 'ref/a.txt', content: 'one\n' });
  const guided = await m.handleToolCall({ id: 'guide-write', name: 'write', input: { path: 'ref/b.txt', content: 'two\n' }, callerAgentName: 'guide' });
  assert.equal(guided.success, true, guided.error);
  assert.equal(env.text('b.txt'), 'two\n');
  await m.start({ isRestart: true, getState: () => null, setState: () => {}, pushEvent: () => {}, notifyOps: () => {} } as unknown as ModuleContext);
  const heads = headsOf(m).get('ref')!;
  assert.ok(heads.get('scout')!.after > 0, "the scout's position moved on");
  assert.equal(m.headMoveNotice('scout'), null);
  assert.deepEqual(m.headMoveNotice('helper')?.mounts, ['ref'], "the helper's saved position is kept, and no branch holds it");
  assert.deepEqual({ ...heads.get('guide')! }, { branchId: 'zz-another-branch-gone-since', after: 1, notice: 'zz-a-notice-gone-since' }, "the guide's write didn't move its saved position");
  assert.deepEqual(m.headMoveNotice('guide')?.mounts, ['ref']);
});

test("saved positions follow their mount's root: a mount left out of one session keeps them for the next, and one whose path changed gets none", async (t) => {
  const env = new Env(t);
  const other = join(env.root, 'other');
  mkdirSync(other);
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const headsOf = (m: WorkspaceModule) => (m as unknown as { directHeads: Heads }).directHeads;
  const gone = { branchId: 'zz-a-branch-gone-since', after: 1, notice: null };
  const first = await env.open({}, [{ name: 'side', path: other, mode: 'read-write', backend: 'direct' }]);
  headsOf(first).set('ref', new Map([['scout', { ...gone }]]));
  headsOf(first).set('side', new Map([['scout', { ...gone }]]));
  await env.close(first);
  // A session without `side`, with a new position on `ref`, so its stop saves.
  const second = await env.open();
  assert.deepEqual(second.headMoveNotice('scout')?.mounts, ['ref']);
  headsOf(second).get('ref')!.set('helper', { ...gone });
  const before = env.store.getRecordIdsByType('workspace/direct-heads/checkpoint').length;
  await env.close(second);
  assert.equal(env.store.getRecordIdsByType('workspace/direct-heads/checkpoint').length, before + 1);
  // `side` is back, at its own root: its position came through, so its notice does.
  const third = await env.open({}, [{ name: 'side', path: other, mode: 'read-write', backend: 'direct' }]);
  assert.deepEqual(third.headMoveNotice('scout')?.mounts, ['ref', 'side']);
  await env.close(third);
  // `side` now names another directory: the writes saved for it aren't beneath it.
  const elsewhere = join(env.root, 'elsewhere');
  mkdirSync(elsewhere);
  const fourth = await env.open({}, [{ name: 'side', path: elsewhere, mode: 'read-write', backend: 'direct' }]);
  assert.deepEqual(fourth.headMoveNotice('scout')?.mounts, ['ref']);
  assert.equal(headsOf(fourth).get('side')?.size ?? 0, 0);
  // A position of its own there, so this stop saves; the old root's entry is carried beside it.
  headsOf(fourth).set('side', new Map([['helper', { ...gone }]]));
  await env.close(fourth);
  // Back at its first root: the scout's writes there are still told.
  const fifth = await env.open({}, [{ name: 'side', path: other, mode: 'read-write', backend: 'direct' }]);
  assert.deepEqual(fifth.headMoveNotice('scout')?.mounts, ['ref', 'side']);
  assert.deepEqual(fifth.headMoveNotice('helper')?.mounts, ['ref'], "the helper's position on `side` is the other root's");
  await env.close(fifth);
  const sixth = await env.open({}, [{ name: 'side', path: elsewhere, mode: 'read-write', backend: 'direct' }]);
  assert.deepEqual(sixth.headMoveNotice('helper')?.mounts, ['ref', 'side']);
});

test("a history lookup that throws for one mount decides nothing at that start for every mount", async (t) => {
  const env = new Env(t);
  const other = join(env.root, 'other');
  mkdirSync(other);
  const m = await env.open({}, [{ name: 'side', path: other, mode: 'read-write', backend: 'direct' }]);
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const heads = (m as unknown as { directHeads: Heads }).directHeads;
  heads.set('ref', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: 'zz-notice-ref' }]]));
  heads.set('side', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: 'zz-notice-side' }]]));
  const asked: string[] = [];
  m.useHistory((_agent, id) => {
    asked.push(id);
    if (id === 'zz-notice-side') throw new Error('zz-lookup-failed');
    return false;
  });
  const error = console.error;
  console.error = () => {};
  try {
    // `ref` alone would be due; `side` can't be read, so the start decides nothing.
    assert.equal(m.headMoveNotice('scout'), null);
  } finally {
    console.error = error;
  }
  assert.ok(asked.includes('zz-notice-side'), 'premise: the mount whose lookup throws was asked');
});

test('a stop that would save what the start read adds no record, and one whose read failed saves none, so the last record stands', async (t) => {
  const env = new Env(t);
  const records = () => env.store.getRecordIdsByType('workspace/direct-heads/checkpoint').length;
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const headsOf = (m: WorkspaceModule) => (m as unknown as { directHeads: Heads }).directHeads;
  // No position, no record.
  await env.close(await env.open());
  assert.equal(records(), 0);
  const first = await env.open();
  headsOf(first).set('ref', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  await env.close(first);
  assert.equal(records(), 1);
  // A session that changed nothing.
  await env.close(await env.open());
  assert.equal(records(), 1);
  // A session whose read fails starts with no positions, says so, and saves none, though it has one of its own.
  const load = RecordJournal.prototype.load;
  // Only the positions' journal: the disk-agreement evidence keeps its own.
  RecordJournal.prototype.load = function (this: RecordJournal<unknown, unknown>) {
    if (this.type === 'workspace/direct-heads') throw new Error('zz-unreadable');
    return load.call(this);
  } as typeof load;
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  let failed: WorkspaceModule;
  try {
    failed = await env.open();
  } finally {
    RecordJournal.prototype.load = load;
    console.error = error;
  }
  assert.ok(logged.some((args) => String(args[0]).includes('could not read the saved direct-write positions')), JSON.stringify(logged));
  assert.equal(failed.headMoveNotice('scout'), null);
  await data(failed, 'write', { path: 'ref/a.txt', content: 'one\n' });
  await env.close(failed);
  assert.equal(records(), 1);
  const after = await env.open();
  assert.deepEqual(after.headMoveNotice('scout')?.mounts, ['ref'], 'the last record read stands');
  // A save that fails is logged, and the stop still ends.
  headsOf(after).get('ref')!.set('helper', { branchId: 'zz-another-branch-gone-since', after: 1, notice: null });
  const checkpoint = RecordJournal.prototype.checkpoint;
  RecordJournal.prototype.checkpoint = function (this: RecordJournal<unknown, unknown>, ...args: Parameters<typeof checkpoint>) {
    if (this.type === 'workspace/direct-heads') throw new Error('zz-unwritable');
    return checkpoint.apply(this, args);
  } as typeof checkpoint;
  logged.length = 0;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    await env.close(after);
  } finally {
    RecordJournal.prototype.checkpoint = checkpoint;
    console.error = error;
  }
  assert.ok(logged.some((args) => String(args[0]).includes('could not save the direct-write positions')), JSON.stringify(logged));
  assert.equal(records(), 1);
});

test("a deletion whose branch changes while its unlink runs keeps the agent's position where the call began", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  const began = env.store.currentBranch();
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const unlink = fsp.unlink!;
  let switches = 0;
  fsp.unlink = async (...args: unknown[]) => {
    switches++;
    env.store.createBranchAt(`zz-elsewhere-${switches}`, env.store.currentBranch().name, env.store.currentSequence());
    env.store.switchBranch(`zz-elsewhere-${switches}`);
    return unlink(...args);
  };
  syncBuiltinESMExports();
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const heads = (m as unknown as { directHeads: Heads }).directHeads;
  try {
    const before = env.store.currentSequence();
    await data(m, 'delete', { path: 'ref/f.txt' });
    assert.equal(switches, 1, 'the branch changed inside the unlink');
    assert.deepEqual({ ...heads.get('ref')!.get('scout')! }, { branchId: began.id, after: before, notice: null });
    // An agent with a position the branch it moved to holds: the position
    // moves to where the deletion began, so the next start judges the
    // deletion by the branch its turn was on.
    const moved = env.store.currentBranch();
    heads.get('ref')!.set('scout', { branchId: moved.id, after: -1, notice: null });
    env.file('g.txt', 'old\n');
    await data(m, 'delete', { path: 'ref/g.txt' });
    assert.equal(switches, 2);
    assert.deepEqual({ ...heads.get('ref')!.get('scout')! }, { branchId: moved.id, after: env.store.listBranches().find((b) => b.id === env.store.currentBranch().id)!.branchPoint, notice: null });
    assert.deepEqual(m.headMoveNotice('scout')?.mounts, ['ref'], 'the branch the head moved to lacks the deletion');
    // An older position whose notice is owed stays, so the notice still covers it.
    const owed = { branchId: 'zz-a-branch-gone-since', after: 1, notice: null };
    heads.get('ref')!.set('scout', { ...owed });
    env.file('h.txt', 'old\n');
    await data(m, 'delete', { path: 'ref/h.txt' });
    assert.equal(switches, 3);
    assert.deepEqual({ ...heads.get('ref')!.get('scout')! }, owed);
  } finally {
    fsp.unlink = unlink;
    syncBuiltinESMExports();
  }
});

test("the check before a rename reads at most one byte past what the edit read, and takes an empty pipe for a change", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'aaaa\n');
  const root = realpathSync(env.ref);
  const view = { root, name: 'ref', followSymlinks: false, maxFileSize: 1 << 20, ignore: [], others: [] };
  const staged = await stageContained(view, root, 'f.txt', Buffer.from('new\n'));
  const stamped = () => identityOf(lstatSync(join(env.ref, 'f.txt'), { bigint: true }));
  const read = Buffer.from('aaaa\n');
  const identity = stamped();
  const fs = createRequire(import.meta.url)('node:fs') as { readSync: (...args: unknown[]) => number };
  const readSync = fs.readSync;
  let asked = 0;
  let empty = false;
  fs.readSync = (...args: unknown[]) => {
    if (empty) throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' });
    asked += args[3] as number;
    return readSync(...args);
  };
  syncBuiltinESMExports();
  try {
    // Another writer made it far larger: no more than one byte past what the edit read is asked for.
    writeFileSync(join(env.ref, 'f.txt'), 'b'.repeat(1 << 20));
    assert.throws(() => checkUnchanged(staged, { identity, bytes: read }), FileChanged);
    assert.ok(asked <= read.length + 1, `asked for ${asked} bytes`);
    // A pipe with a writer and nothing in it yet answers EAGAIN: a change, as any other writer's.
    empty = true;
    assert.throws(() => checkUnchanged(staged, { identity, bytes: read }), FileChanged);
  } finally {
    fs.readSync = readSync;
    syncBuiltinESMExports();
  }
  await discard(staged);
});

test("the check before a rename tells a file gone from one this process may not write, and names any other failure", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'aaaa\n');
  const root = realpathSync(env.ref);
  const view = { root, name: 'ref', followSymlinks: false, maxFileSize: 1 << 20, ignore: [], others: [] };
  const staged = await stageContained(view, root, 'f.txt', Buffer.from('new\n'));
  const expected = { identity: identityOf(lstatSync(join(env.ref, 'f.txt'), { bigint: true })), bytes: Buffer.from('aaaa\n') };
  const fs = createRequire(import.meta.url)('node:fs') as { accessSync: (...args: unknown[]) => void };
  const accessSync = fs.accessSync;
  let code = '';
  fs.accessSync = () => {
    throw Object.assign(new Error(`${code}: failed`), { code });
  };
  syncBuiltinESMExports();
  try {
    code = 'ENOENT';
    assert.doesNotThrow(() => checkUnchanged(staged, null), 'a write makes the file anew');
    assert.throws(() => checkUnchanged(staged, expected), FileChanged);
    code = 'EPERM';
    assert.throws(() => checkUnchanged(staged, null), (err: unknown) => err instanceof WriteRefused && /^a file the host's process may not write \(not permitted\)/.test(err.message));
    code = 'EIO';
    assert.throws(() => checkUnchanged(staged, null), (err: unknown) => err instanceof WriteRefused && err.message === "cannot check that the host's process may write it (an input/output error on the disk)");
  } finally {
    fs.accessSync = accessSync;
    syncBuiltinESMExports();
  }
  await discard(staged);
});

test("a staged file whose handle fails to close is removed, and the write says why", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalOpen = fsp.open!;
  fsp.open = async (...args: unknown[]) => {
    const handle = await originalOpen(...args) as { close: () => Promise<void> };
    if (String(args[0]).includes(STAGED_PREFIX)) {
      const close = handle.close;
      handle.close = async () => {
        await close.call(handle);
        throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await failure(m, 'write', { path: 'ref/f.txt', content: 'new\n' }), 'The write did nothing to "ref/f.txt": cannot write the staged file beside it (an input/output error on the disk). Calling again may work; if it fails the same way, whoever runs this host can check the disk.');
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.deepEqual(env.staged(), []);
  assert.equal(env.text('f.txt'), 'old\n');
});

test("a deletion whose mount root can't be read says so, with its errno in plain words", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  const root = realpathSync(env.ref);
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const stat = fsp.stat!;
  let code = 'EACCES';
  fsp.stat = async (...args: unknown[]) => {
    if (args[0] === root) throw Object.assign(new Error(`${code}: failed`), { code });
    return stat(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }), `The delete did nothing to "ref/f.txt": the mount root can't be read: permission denied. Calling again won't change that; whoever runs this host can change the permissions.`);
    code = 'EPERM';
    assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }), `The delete did nothing to "ref/f.txt": the mount root can't be read: not permitted. Calling again won't change that; whoever runs this host can change the permissions.`);
    for (const gone of ['ENOENT', 'ENOTDIR']) {
      code = gone;
      assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }), `The delete did nothing to "ref/f.txt": the mount root isn't on disk. Calling again won't change that; whoever runs this host can put the mount's directory back at its path.`);
    }
    code = 'EIO';
    assert.equal(await failure(m, 'delete', { path: 'ref/f.txt' }), `The delete did nothing to "ref/f.txt": the mount root can't be read: an input/output error on the disk. Calling again may work; if it fails the same way, whoever runs this host can check the disk.`);
  } finally {
    fsp.stat = stat;
    syncBuiltinESMExports();
  }
  assert.equal(env.text('f.txt'), 'old\n');
});

test("a deletion while the mount root is gone is refused, and one once it's back works", async (t) => {
  const env = new Env(t);
  env.file('f.txt', 'old\n');
  const m = await env.open();
  const away = `${env.ref}-away`;
  renameSync(env.ref, away);
  try {
    const refused = await failure(m, 'delete', { path: 'ref/f.txt' });
    assert.match(refused, /^The delete did nothing to "ref\/f\.txt": /);
  } finally {
    renameSync(away, env.ref);
  }
  assert.equal(env.text('f.txt'), 'old\n');
  await data(m, 'delete', { path: 'ref/f.txt' });
  assert.equal(existsSync(join(env.ref, 'f.txt')), false);
});

test("a followed link whose file can't be looked at is refused with its errno in plain words, and one whose file went is a change", { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const env = new Env(t);
  env.file('real.txt', 'old\n');
  symlinkSync('real.txt', join(env.ref, 'link.txt'));
  const m = await env.open({ followSymlinks: true });
  const real = join(realpathSync(env.ref), 'real.txt');
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const lstat = fsp.lstat!;
  let code = 'EIO';
  fsp.lstat = async (...args: unknown[]) => {
    if (args[0] === real && code) throw Object.assign(new Error(`${code}: failed`), { code });
    return lstat(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await failure(m, 'write', { path: 'ref/link.txt', content: 'new\n' }), 'The write did nothing to "ref/link.txt": cannot stat the file the symlink leads to (an input/output error on the disk). Calling again may work; if it fails the same way, whoever runs this host can check the disk.');
    code = 'ENOENT';
    assert.match(await failure(m, 'write', { path: 'ref/link.txt', content: 'new\n' }), /changed/);
  } finally {
    fsp.lstat = lstat;
    syncBuiltinESMExports();
  }
  assert.equal(env.text('real.txt'), 'old\n');
});

test("a stop compares what it would save with what the start read whatever their order, and a root spelled another way is the same root", async (t) => {
  const env = new Env(t);
  const other = join(env.root, 'other');
  mkdirSync(other);
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const headsOf = (m: WorkspaceModule) => (m as unknown as { directHeads: Heads }).directHeads;
  const records = () => env.store.getRecordIdsByType('workspace/direct-heads/checkpoint').length;
  const first = await env.open({}, [{ name: 'side', path: other, mode: 'read-write', backend: 'direct' }]);
  headsOf(first).set('ref', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  headsOf(first).set('side', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  await env.close(first);
  assert.equal(records(), 1);
  // `side` carried, so it comes first in what this stop would save, and
  // `ref`'s path has a trailing slash: the same record, so none is added.
  const second = await env.open({ path: `${env.ref}/` });
  assert.deepEqual(second.headMoveNotice('scout')?.mounts, ['ref']);
  await env.close(second);
  assert.equal(records(), 1);
  // Two roots of one name: a session at the second saves its own entry after
  // the first's, carried; a session back at the first carries the second's
  // ahead of its own, the other order, and adds no record.
  const third = await env.open({ path: other });
  headsOf(third).set('ref', new Map([['helper', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  await env.close(third);
  assert.equal(records(), 2);
  await env.close(await env.open());
  assert.equal(records(), 2);
});

test("entries whose roots are two spellings a collator takes for one are still put in one order, so an unchanged stop adds no record", { skip: process.platform === 'darwin' ? 'APFS takes the two spellings for one name' : false }, async (t) => {
  const env = new Env(t);
  const composed = join(env.root, 'caf\u00e9');
  const decomposed = join(env.root, 'cafe\u0301');
  mkdirSync(composed);
  mkdirSync(decomposed);
  assert.equal(composed.localeCompare(decomposed), 0, "the collator takes them for one");
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const headsOf = (m: WorkspaceModule) => (m as unknown as { directHeads: Heads }).directHeads;
  const records = () => env.store.getRecordIdsByType('workspace/direct-heads/checkpoint').length;
  const at = (path: string) => env.open({}, [{ name: 'nf', path, mode: 'read-write', backend: 'direct' }]);
  const one = await at(composed);
  headsOf(one).set('nf', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  await env.close(one);
  // The composed root's entry carried ahead of the decomposed one's own.
  const two = await at(decomposed);
  headsOf(two).set('nf', new Map([['helper', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  await env.close(two);
  assert.equal(records(), 2);
  // Back at the composed root, whose save lists them the other way round.
  await env.close(await at(composed));
  assert.equal(records(), 2);
});

test("a saved record of another shape is refused at load, so the session starts with no positions, and its stop replaces the record", async (t) => {
  const head = { branchId: 'zz-a-branch-gone-since', after: 1 };
  const good = (env: Env) => ({ mount: 'ref', root: resolve(env.ref), agents: { scout: head } });
  const gone = { mount: 'gone', root: '/zz/elsewhere' };
  const shapes: Array<[string, (env: Env) => unknown]> = [
    ['a carried agent whose notice isn\'t text', (env) => [good(env), { ...gone, agents: { scout: { ...head, notice: 7 } } }]],
    ['a record that isn\'t a list', (env) => ({ ref: good(env) })],
    ['an entry whose mount isn\'t text', (env) => [good(env), { ...gone, mount: 3, agents: {} }]],
    ['an entry whose root isn\'t text', (env) => [good(env), { ...gone, root: 5, agents: {} }]],
    ['an entry whose agents are a list', (env) => [good(env), { ...gone, agents: [head] }]],
    ['an agent whose head is text', (env) => [good(env), { ...gone, agents: { scout: { ...head, after: '1' } } }]],
    ['an agent whose branch isn\'t text', (env) => [good(env), { ...gone, agents: { scout: { ...head, branchId: 9 } } }]],
  ];
  for (const [what, shape] of shapes) {
    await t.test(what, async (t) => {
      const env = new Env(t);
      const journal = new RecordJournal<never, unknown>(env.store, { type: 'workspace/direct-heads' });
      journal.load();
      journal.checkpoint(shape(env));
      const records = () => env.store.getRecordIdsByType('workspace/direct-heads/checkpoint').length;
      const logged: unknown[][] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => void logged.push(args);
      let m: WorkspaceModule;
      try {
        m = await env.open();
      } finally {
        console.error = error;
      }
      assert.ok(logged.some((args) => String(args[0]).includes("the saved direct-write positions aren't of the shape saved")), JSON.stringify(logged));
      assert.equal(m.headMoveNotice('scout'), null);
      await data(m, 'write', { path: 'ref/a.txt', content: 'one\n' });
      await env.close(m);
      assert.equal(records(), 2, 'the stop replaced it');
      // The next session reads the replacement: the write's position is there, and nothing is logged.
      logged.length = 0;
      console.error = (...args: unknown[]) => void logged.push(args);
      let next: WorkspaceModule;
      try {
        next = await env.open();
      } finally {
        console.error = error;
      }
      assert.deepEqual(logged, []);
      type Heads = Map<string, Map<string, { branchId: string }>>;
      assert.equal((next as unknown as { directHeads: Heads }).directHeads.get('ref')?.get('scout')?.branchId, env.store.currentBranch().id);
    });
  }
  await t.test('a session that writes nothing replaces it too', async (t) => {
    const env = new Env(t);
    const journal = new RecordJournal<never, unknown>(env.store, { type: 'workspace/direct-heads' });
    journal.load();
    journal.checkpoint({ ref: good(env) });
    const records = () => env.store.getRecordIdsByType('workspace/direct-heads/checkpoint').length;
    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await env.close(await env.open());
      assert.equal(records(), 2, 'the stop replaced it');
      logged.length = 0;
      await env.close(await env.open());
    } finally {
      console.error = error;
    }
    assert.deepEqual(logged, [], 'the next session reads the replacement');
    assert.equal(records(), 2, 'and, changing nothing, adds none');
  });
});

test("a mount configured store-backed keeps its direct positions for a session that configures it direct again, and isn't told of them", async (t) => {
  const env = new Env(t);
  type Heads = Map<string, Map<string, { branchId: string; after: number; notice: string | null }>>;
  const headsOf = (m: WorkspaceModule) => (m as unknown as { directHeads: Heads }).directHeads;
  const first = await env.open();
  headsOf(first).set('ref', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  await env.close(first);
  const stored = new WorkspaceModule({ mounts: [{ name: 'ref', path: env.ref, mode: 'read-write' }] });
  t.after(() => stored.stop().catch(() => {}));
  stored.initStore(env.store);
  await stored.start({ isRestart: true, getState: () => null, setState: () => {}, pushEvent: () => {}, notifyOps: () => {} } as unknown as ModuleContext);
  assert.equal(stored.headMoveNotice('scout'), null);
  await stored.stop();
  const again = await env.open();
  assert.deepEqual(again.headMoveNotice('scout')?.mounts, ['ref']);
});

test("a direct edit refuses what read doesn't show as text, and a file that isn't there, by read's words", async (t) => {
  const env = new Env(t);
  env.file('bin.dat', Buffer.from([0x61, 0, 0x62]));
  env.file('big.txt', 'x'.repeat(20));
  const m = await env.open({ maxFileSize: 10 });
  assert.equal(await failure(m, 'edit', { path: 'ref/bin.dat', oldString: 'a', newString: 'b' }), `The edit did nothing: "ref/bin.dat" is binary, so the workspace doesn't edit it as text. A write replaces the whole file, if that's what you mean to do.`);
  assert.equal(await failure(m, 'edit', { path: 'ref/big.txt', oldString: 'x', newString: 'y', replaceAll: true }), `The edit did nothing: "ref/big.txt" is 20 bytes, past the 10-byte limit this mount sets on a file, so the workspace doesn't edit it. The limit is the mount's maxFileSize setting, which only whoever runs the host can change.`);
  assert.equal(await failure(m, 'edit', { path: 'ref/none.txt', oldString: 'a', newString: 'b' }), 'The edit did nothing: there\'s no file at "ref/none.txt". ls or glob lists the files that exist.');
  assert.equal(await failure(m, 'delete', { path: 'ref/none.txt' }), 'The delete did nothing: there\'s no file at "ref/none.txt". ls or glob lists the files that exist.');
  assert.equal(await failure(m, 'write', { path: 'ref/big.txt', content: 'y'.repeat(11) }),
    'The write did nothing: "ref/big.txt" would be 11 bytes, past the 10-byte limit this mount sets on a file, so the workspace couldn\'t keep it. Content within the limit is written. '
    + "The limit is the mount's maxFileSize setting, which only whoever runs the host can change.");
});

test("a direct mount that doesn't follow links refuses a write, an edit or a deletion at a link, and one that follows them writes the file a link leads to inside the mount, leaving the link", { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const env = new Env(t);
  env.file('real.txt', 'real\n');
  symlinkSync('real.txt', join(env.ref, 'link.txt'));
  const outside = join(env.root, 'outside.txt');
  writeFileSync(outside, 'outside\n');
  symlinkSync(outside, join(env.ref, 'out.txt'));
  const strict = await env.open();
  assert.equal(await failure(strict, 'write', { path: 'ref/link.txt', content: 'new\n' }), `The write did nothing to "ref/link.txt": a symlink, which this mount does not follow. Calling again won't change that; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere.`);
  const notFollowed = `"ref/link.txt" is a symlink, and its mount doesn't follow symlinks, so the workspace's tools don't go through it. Calling again won't change that; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere.`;
  assert.equal(await failure(strict, 'edit', { path: 'ref/link.txt', oldString: 'real', newString: 'new' }), `The edit did nothing: ${notFollowed}`);
  assert.equal(await failure(strict, 'delete', { path: 'ref/link.txt' }), `The delete did nothing: ${notFollowed}`);

  const following = await env.open({ followSymlinks: true });
  await data(following, 'edit', { path: 'ref/link.txt', oldString: 'real', newString: 'edited' });
  assert.equal(readlinkSync(join(env.ref, 'link.txt')), 'real.txt');
  assert.equal(env.text('real.txt'), 'edited\n');
  await data(following, 'write', { path: 'ref/link.txt', content: 'written\n' });
  assert.equal(readlinkSync(join(env.ref, 'link.txt')), 'real.txt');
  assert.equal(env.text('real.txt'), 'written\n');
  assert.equal(await failure(following, 'write', { path: 'ref/out.txt', content: 'new\n' }), `The write did nothing to "ref/out.txt": a symlink that leaves the mount. Calling again won't change that; nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it.`);
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  const outsideDir = join(env.root, 'outside-dir');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, join(env.ref, 'outdir'));
  assert.equal(await failure(following, 'write', { path: 'ref/outdir/new.txt', content: 'new\n' }), `The write did nothing to "ref/outdir/new.txt": a parent directory resolves outside the mount. Calling again won't change that; nothing done through this mount reaches where it resolves, and whoever runs this host can mount that place.`);
  assert.equal(existsSync(join(outsideDir, 'new.txt')), false);
  // Two paths to one file in one edit_many would rename over each other, so
  // they're refused, with nothing written.
  const aliased = await failure(following, 'edit_many', {
    edits: [{ path: 'ref/link.txt', oldString: 'written', newString: 'one' }, { path: 'ref/real.txt', oldString: 'written', newString: 'two' }],
  });
  assert.match(aliased, /ref\/link\.txt and ref\/real\.txt are one file, reached through a link/);
  assert.equal(env.text('real.txt'), 'written\n');
  // And two hard links of one file, on either kind of mount.
  linkSync(join(env.ref, 'real.txt'), join(env.ref, 'hard.txt'));
  for (const mount of [strict, following]) {
    const hard = await failure(mount, 'edit_many', {
      edits: [{ path: 'ref/real.txt', oldString: 'written', newString: 'one' }, { path: 'ref/hard.txt', oldString: 'written', newString: 'two' }],
    });
    assert.match(hard, /ref\/real\.txt and ref\/hard\.txt are one file, reached through a link or as two hard links/);
  }
  assert.equal(env.text('real.txt'), 'written\n');
  unlinkSync(join(env.ref, 'hard.txt'));
  // A deletion removes the link itself, as a push's does.
  await data(following, 'delete', { path: 'ref/link.txt' });
  assert.throws(() => lstatSync(join(env.ref, 'link.txt')), { code: 'ENOENT' });
  assert.equal(env.text('real.txt'), 'written\n');
});

test("a direct write never lands in a mount nested in the direct one, or outside the direct mount's include", async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'a\n');
  // The nested mount inside the include, so its refusal is the nesting's.
  env.file('src/inner/x.txt', 'x\n');
  const m = await env.open({ include: ['src/**'] }, [{ name: 'inner', path: join(env.ref, 'src/inner'), mode: 'read-write', watch: 'never' }]);
  assert.match(await failure(m, 'write', { path: 'ref/src/inner/x.txt', content: 'no\n' }), /inner/);
  assert.match(await failure(m, 'write', { path: 'ref/README.md', content: 'no\n' }), /include/);
  assert.equal(env.text('src/inner/x.txt'), 'x\n');
  assert.throws(() => statSync(join(env.ref, 'README.md')), { code: 'ENOENT' });
  await data(m, 'write', { path: 'ref/src/b.ts', content: 'b\n' });
  assert.equal(env.text('src/b.ts'), 'b\n');
});

test('the staging itself refuses a landing the parse would have refused, so a link put on the way after the parse is met there', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const env = new Env(t);
  env.file('src/inner/x.txt', 'x\n');
  env.file('README.md', 'readme\n');
  // Links, as another writer could make them between a call's parse and its staging.
  symlinkSync('src/inner', join(env.ref, 'to-inner'));
  mkdirSync(join(env.ref, 'src/docs'));
  symlinkSync('../../README.md', join(env.ref, 'src/docs/readme.md'));
  mkdirSync(join(env.ref, 'other'));
  symlinkSync('../other', join(env.ref, 'src/elsewhere'));
  const root = realpathSync(env.ref);
  const view = {
    root, name: 'ref', followSymlinks: true, maxFileSize: 1 << 20, ignore: [], include: ['src/**'],
    nested: [{ dir: 'src/inner', name: 'inner', real: join(root, 'src/inner') }], others: ['src/inner'],
  };
  const refused = (pattern: RegExp) => (err: unknown) => err instanceof WriteRefused && pattern.test(err.message);
  await assert.rejects(stageContained(view as never, root, 'to-inner/x.txt', Buffer.from('no\n')), refused(/inner/));
  await assert.rejects(stageContained(view as never, root, 'src/docs/readme.md', Buffer.from('no\n')), refused(/^a symlink that leaves the mount$/));
  // A new file through a directory link, landing where the include leaves out.
  await assert.rejects(stageContained(view as never, root, 'src/elsewhere/new.txt', Buffer.from('no\n')), refused(/./));
  assert.throws(() => statSync(join(env.ref, 'other/new.txt')), { code: 'ENOENT' });
  assert.equal(env.text('src/inner/x.txt'), 'x\n');
  assert.equal(env.text('README.md'), 'readme\n');
  assert.deepEqual(env.staged(), []);
});

test('writeBinary writes a direct mount\'s disk, whole, as a write does', async (t) => {
  const env = new Env(t);
  const m = await env.open();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
  assert.deepEqual(await m.writeBinary('ref/img/dot.png', bytes, 'image/png', { agentName: 'scout' }), {
    success: true,
    data: { path: 'ref/img/dot.png', size: 7, mimeType: 'image/png', disk: 'done' },
  });
  assert.deepEqual(readFileSync(join(env.ref, 'img/dot.png')), bytes);
  assert.deepEqual(env.staged(), []);
});

test('materialize passes over a writable direct mount, naming it where the call names it', async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'a\n');
  const work = join(env.root, 'work');
  mkdirSync(work);
  const m = await env.open({ mode: 'read-write' }, [{ name: 'work', path: work, mode: 'read-write', watch: 'never' }]);
  const reason = "a direct mount: its writes are on disk as they're made, so there's nothing to write";
  assert.deepEqual((await data<{ skipped: unknown[] }>(m, 'materialize', { mount: 'ref' })).skipped, [{ mount: 'ref', reason }]);
  assert.deepEqual((await data<{ skipped: unknown[] }>(m, 'materialize', { path: 'ref/a.txt' })).skipped, [{ mount: 'ref', reason }]);
  assert.equal((await data<{ skipped?: unknown[] }>(m, 'materialize')).skipped, undefined, 'a bare materialize leaves it out, as a read-only mount');
  assert.deepEqual(await m.materializeMount('ref'), []);
  assert.equal(env.text('a.txt'), 'a\n');
});

test("getMounts says which mounts run direct, so the framework's own files pass over them", async (t) => {
  const env = new Env(t);
  const work = join(env.root, 'work');
  mkdirSync(work);
  const m = await env.open({}, [{ name: 'work', path: work, mode: 'read-write', watch: 'never' }]);
  assert.deepEqual(m.getMounts(), [
    { name: 'ref', mode: 'read-write', backend: 'direct' },
    { name: 'work', mode: 'read-write' },
  ]);
});

test("the writing tools' descriptions mention the direct kind only on a host with a writable direct mount", async (t) => {
  const env = new Env(t);
  const descriptions = (m: WorkspaceModule) => Object.fromEntries(m.getTools().map((tool) => [tool.name, tool.description]));
  const readOnly = descriptions(await env.open({ mode: 'read-only' }));
  const writable = descriptions(await env.open());
  for (const name of Object.keys(readOnly)) {
    if (name === 'write' || name === 'edit' || name === 'edit_many' || name === 'delete' || name === 'materialize') {
      assert.match(writable[name]!, name === 'materialize' ? /A direct mount writes its files to disk as they're made/ : /On a direct mount, .*head move/, name);
      assert.doesNotMatch(readOnly[name]!, /\bdirect\b/, name);
    } else {
      assert.equal(writable[name], readOnly[name], name);
    }
  }
});

test("a mount switched back to 'chronicle' takes in a direct run's writes as disk's own changes, and one switched to direct writes what disk has", async (t) => {
  const env = new Env(t);
  env.file('kept.ts', 'v1\n');
  env.file('gone.ts', 'soon gone\n');
  const first = await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never' });
  assert.equal((await data<{ count: number }>(first, 'ls', { path: 'ref', recursive: true })).count, 2);
  await first.stop();

  const direct = await env.open();
  await data(direct, 'edit', { path: 'ref/kept.ts', oldString: 'v1', newString: 'v2' });
  await data(direct, 'write', { path: 'ref/added.ts', content: 'new\n' });
  await data(direct, 'delete', { path: 'ref/gone.ts' });
  await direct.stop();

  const again = await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never' });
  assert.deepEqual((await data(again, 'ls', { path: 'ref', recursive: true })).entries, [
    { path: 'added.ts', state: 'synced', size: 4 },
    { path: 'kept.ts', state: 'synced', size: 3 },
  ]);
  assert.equal((await data<{ content: string }>(again, 'read', { path: 'ref/kept.ts' })).content, '     1\tv2');
  const status = (await data<Record<string, Record<string, unknown>>>(again, 'status')).ref!;
  assert.deepEqual([status.pendingChanges, status.conflicts], [0, 0]);
  await again.stop();

  // And direct again, from a store that now agrees with disk.
  const back = await env.open();
  await data(back, 'edit', { path: 'ref/kept.ts', oldString: 'v2', newString: 'v3' });
  assert.equal(env.text('kept.ts'), 'v3\n');
});
