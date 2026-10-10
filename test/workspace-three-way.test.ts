/**
 * Truthful workspace listings under the three-way rule (shelf-383): disk (D),
 * the workspace store (S) and physical disk-agreement evidence (P), with
 * branch-local intent (tombstones, store origin, sticky conflicts).
 *
 * Each describe block covers one entry of the shelf's "done when" list. Faults
 * are real: a child process (fixtures/workspace-fault.mjs) runs an operation
 * and dies by SIGKILL between intent, effect and completion, and a torn tail
 * is a truncated records.log.
 */

import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, constants as fsConstants, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { DiskAgreement } from '../src/modules/workspace/disk-agreement.js';
import { fingerprintVouches, filesystemTrustsCtime, observePath } from '../src/modules/workspace/observe.js';
import { pushPaths, settleAdoptionBeforeMutation } from '../src/modules/workspace/reconcile.js';
import type { MountConfig, WorkspaceConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent } from '../src/types/events.js';

const FAULT_FIXTURE = join(import.meta.dirname, 'fixtures/workspace-fault.mjs');
const TREE = 'workspace/work/tree';
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

type Entry = {
  path: string;
  state: string;
  size?: number;
  mimeType?: string;
  conflict?: { kind: string; diskCopy: string; diskChangedSinceRecorded: boolean };
  note?: string;
};

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-3way-'));
  readonly dir = join(this.root, 'work');
  readonly storePath = join(this.root, 'ws.chronicle');
  store: JsStore;
  events: ProcessEvent[] = [];
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

  async open(mount: Partial<MountConfig> = {}, config: Partial<WorkspaceConfig> = {}): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({
      mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', ...mount }],
      ...config,
    });
    m.initStore(this.store);
    await m.start({
      isRestart: false,
      getState: () => null,
      setState: () => {},
      pushEvent: (e: ProcessEvent) => this.events.push(e),
    } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }

  /** Stop a module and close the store, as a process exit would. */
  async shutdown(m: WorkspaceModule): Promise<void> {
    await m.stop();
    this.live = this.live.filter((x) => x !== m);
    this.store.close();
  }

  /** A fresh process: reopen the store and start a new module on it. */
  async restart(m: WorkspaceModule, mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    await this.shutdown(m);
    this.store = JsStore.openOrCreate({ path: this.storePath });
    return this.open(mount);
  }

  /** Run one operation in a child that dies by SIGKILL at `killAt`, then reopen. */
  async fault(m: WorkspaceModule, op: 'materialize' | 'sync' | 'write', killAt: 'after-intent' | 'after-effect'): Promise<WorkspaceModule> {
    await this.shutdown(m);
    const child = spawnSync(process.execPath, [FAULT_FIXTURE, this.storePath, this.dir, op, killAt], { encoding: 'utf-8' });
    assert.equal(child.signal, 'SIGKILL', `the child died at ${killAt} (status ${child.status}, stderr: ${child.stderr})`);
    this.store = JsStore.openOrCreate({ path: this.storePath });
    return this.open();
  }

  disk(path: string): string {
    return join(this.dir, path);
  }

  readDisk(path: string): string {
    return readFileSync(this.disk(path), 'utf8');
  }

  writeDisk(path: string, content: string | Buffer): void {
    mkdirSync(dirname(this.disk(path)), { recursive: true });
    writeFileSync(this.disk(path), content);
  }

  rmDisk(path: string): void {
    rmSync(this.disk(path));
  }

  /** A workspace entry written straight into the tree: no evidence, no intent (a pre-383 store). */
  legacyEntry(path: string, content: string): void {
    const bytes = Buffer.from(content);
    const blobHash = this.store.storeBlob(bytes, 'text/plain');
    this.store.treeSet(TREE, path, { blobHash, size: bytes.byteLength, mode: 0o644 });
  }

  eventsOf(type: string): Array<{ paths: string[]; conflicts?: string[] }> {
    return this.events.filter((e) => e.type === type) as unknown as Array<{ paths: string[]; conflicts?: string[] }>;
  }
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<any> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, true, `${name} ${JSON.stringify(input)} failed: ${res.error}`);
  return res.data;
}

async function refused(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<string> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, false, `${name} ${JSON.stringify(input)} unexpectedly succeeded`);
  return String(res.error);
}

async function listing(m: WorkspaceModule, path = 'work'): Promise<Map<string, Entry>> {
  const data = await call(m, 'ls', { path, recursive: true });
  return new Map((data.entries as Entry[]).map((e) => [e.path, e]));
}

async function entryOf(m: WorkspaceModule, path: string): Promise<Entry | undefined> {
  return (await listing(m)).get(path);
}

async function stateOf(m: WorkspaceModule, path: string): Promise<string> {
  return (await entryOf(m, path))?.state ?? 'not listed';
}

/** The workspace's text for a path, unformatted. */
async function contentOf(m: WorkspaceModule, path: string): Promise<string> {
  const data = await call(m, 'read', { path: `work/${path}`, offsetChars: 0, limitChars: 1_000_000 });
  return data.content as string;
}

/** Written through the workspace and materialized: S = D = P. */
async function seedSynced(env: Env, m: WorkspaceModule, path: string, content: string): Promise<void> {
  await call(m, 'write', { path: `work/${path}`, content });
  await call(m, 'materialize', { path: `work/${path}` });
  assert.equal(env.readDisk(path), content);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` with FileHandle.readFile switching branches as `onRead` says. */
async function withReadHook<T>(onRead: (calls: number) => void, fn: () => Promise<T>): Promise<T> {
  const probe = await open(join(tmpdir(), `read-hook-${process.pid}`), 'w');
  const proto = Object.getPrototypeOf(probe) as { readFile: (...args: unknown[]) => Promise<Buffer> };
  await probe.close();
  const readFile = proto.readFile;
  let calls = 0;
  proto.readFile = async function (this: unknown, ...args: unknown[]) {
    onRead(++calls);
    return readFile.apply(this, args);
  };
  try {
    return await fn();
  } finally {
    proto.readFile = readFile;
  }
}

/** Run `fn` with node:fs/promises' `name` replaced by `make(original)`, as the code under test sees it. */
async function withFsPromises<T>(name: 'readdir' | 'lstat' | 'open', make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>, fn: () => Promise<T>): Promise<T> {
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

/** A file or directory's identity, as a FileHandle's stat reports it. */
function idOf(path: string): string {
  const s = statSync(path);
  return `${s.dev}:${s.ino}`;
}

/**
 * Run `fn` recording what each FileHandle sync reaches (by identity), failing
 * those `fail` picks with an injected EIO.
 */
async function withSyncs<T>(env: Env, fail: (id: string, isDirectory: boolean) => boolean, fn: () => Promise<T>): Promise<{ result: T; synced: string[] }> {
  const probe = await open(join(env.root, 'sync-probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as { sync: (this: { stat: () => Promise<{ dev: number; ino: number; isDirectory: () => boolean }> }) => Promise<void> };
  await probe.close();
  const sync = proto.sync;
  const synced: string[] = [];
  proto.sync = async function () {
    const info = await this.stat();
    const id = `${info.dev}:${info.ino}`;
    if (fail(id, info.isDirectory())) throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
    synced.push(id);
    return sync.call(this);
  };
  try {
    return { result: await fn(), synced };
  } finally {
    proto.sync = sync;
  }
}

/** Swap a mount directory for a symlink to `target`, keeping the original as `saved`. */
function swapForSymlink(env: Env, dir: string, target: string, saved = 'saved'): void {
  renameSync(env.disk(dir), env.disk(saved));
  symlinkSync(target, env.disk(dir));
}


// ---------------------------------------------------------------------------

describe('each three-way case', () => {
  test('a disk-only change is ingested', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', 'v1, edited in the shell');
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
    assert.equal(await contentOf(m, 'a.txt'), 'v1, edited in the shell');
  });

  test('a store-only draft is kept through scans, watcher events, restarts and reattach', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'v2, a draft' });
    const kept = async (when: string): Promise<void> => {
      assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft', when);
      assert.equal(await contentOf(m, 'a.txt'), 'v2, a draft', `${when}: the draft survives`);
      assert.equal(env.readDisk('a.txt'), 'v1', `${when}: disk is untouched`);
    };
    await kept('after ls');
    await call(m, 'sync', {});
    await kept('after a full sync');
    await call(m, 'glob', { pattern: '**' });
    await call(m, 'grep', { pattern: 'v' });
    await kept('after glob and grep');
    await (m as any).handleFsChanges('work', [{ path: 'a.txt', op: 'modified' }]);
    await kept('after a watcher event');
    m = await env.restart(m);
    await kept('after a restart');
    await (m as any).initialScan('work');
    await kept('after a reattach scan');
  });

  test('agreement advances the baseline', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
    env.writeDisk('a.txt', 'v2'); // disk reaches the draft by another route
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
    // Had P stayed at v1, this edit would be "all three differ" — a conflict.
    env.writeDisk('a.txt', 'v3');
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'disk changed since it agreed at v2: adopted');
    assert.equal(await contentOf(m, 'a.txt'), 'v3');
  });

  test('both changed is a conflict, kept, and resolvable either way', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    for (const f of ['take-disk.txt', 'take-workspace.txt']) {
      await seedSynced(env, m, f, 'v1');
      env.writeDisk(f, 'v3, from the shell');
      await call(m, 'write', { path: `work/${f}`, content: 'v2, from the agent' });
    }
    const entries = await listing(m);
    for (const f of ['take-disk.txt', 'take-workspace.txt']) {
      const e = entries.get(f)!;
      assert.equal(e.state, 'conflict', f);
      assert.equal(e.conflict?.kind, 'both-changed', f);
      assert.equal(e.conflict?.diskCopy, 'stored', `${f}: the text disk version is kept in the store`);
    }
    await call(m, 'sync', {});
    const bulk = await call(m, 'materialize', {});
    assert.equal(bulk.materialized.length, 0, 'neither side overwrites the other unasked');
    assert.equal(env.readDisk('take-disk.txt'), 'v3, from the shell');
    assert.equal(await contentOf(m, 'take-workspace.txt'), 'v2, from the agent');

    await call(m, 'sync', { path: 'work/take-disk.txt' });
    assert.equal(await stateOf(m, 'take-disk.txt'), 'synced', 'a path sync resolves toward disk');
    assert.equal(await contentOf(m, 'take-disk.txt'), 'v3, from the shell');

    await call(m, 'materialize', { path: 'work/take-workspace.txt', force: true });
    assert.equal(await stateOf(m, 'take-workspace.txt'), 'synced', 'a forced materialize resolves toward the workspace');
    assert.equal(env.readDisk('take-workspace.txt'), 'v2, from the agent');
  });
});

describe('branches', () => {
  test('a switch to an earlier state while disk holds a later agreed version keeps the selected state as a draft', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    const main = env.store.currentBranch().name;
    env.store.createBranch('earlier', main);
    await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('a.txt'), 'v2');

    env.store.switchBranch('earlier');
    assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft', 'a rewind is a store-side difference, not a disk edit');
    await call(m, 'sync', {});
    assert.equal(await contentOf(m, 'a.txt'), 'v1', 'no scan ingests the later version into the earlier state');
    assert.equal(env.readDisk('a.txt'), 'v2', 'and nothing rewrote disk');

    env.store.switchBranch(main);
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
  });

  test("a file only in another branch's history is listed, neither ingested nor unlinked, and a path sync adopts it", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'shared');
    const main = env.store.currentBranch().name;
    env.store.createBranch('without-b', main);
    await seedSynced(env, m, 'b.txt', 'only on main');

    env.store.switchBranch('without-b');
    assert.equal(await stateOf(m, 'b.txt'), 'not-in-branch');
    assert.match(await refused(m, 'read', { path: 'work/b.txt' }), /not in this branch/);
    await call(m, 'sync', {});
    assert.equal(await stateOf(m, 'b.txt'), 'not-in-branch', 'a full sync does not ingest it');
    await call(m, 'materialize', { force: true, applyDeletions: true });
    assert.equal(env.readDisk('b.txt'), 'only on main', 'not even force with applyDeletions unlinks it');

    await call(m, 'sync', { path: 'work/b.txt' });
    assert.equal(await stateOf(m, 'b.txt'), 'synced');
    assert.equal(await contentOf(m, 'b.txt'), 'only on main');
  });
});

describe('workspace deletes', () => {
  test('a delete without autoMaterialize is never resurrected, reaches disk only with applyDeletions', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'delete', { path: 'work/a.txt' });
    assert.equal(env.readDisk('a.txt'), 'v1', 'disk keeps its copy');

    const stillDeleted = async (when: string): Promise<void> => {
      assert.equal(await stateOf(m, 'a.txt'), 'workspace-deleted', when);
      assert.match(await refused(m, 'read', { path: 'work/a.txt' }), /deleted in the workspace/, `${when}: a lazy read does not restore it`);
    };
    await stillDeleted('after ls');
    await call(m, 'sync', {});
    await stillDeleted('after a full sync');
    await (m as any).handleFsChanges('work', [{ path: 'a.txt', op: 'modified' }]);
    await stillDeleted('after a watcher event');
    m = await env.restart(m);
    await (m as any).initialScan('work');
    await stillDeleted('after a restart and its scan');

    const plain = await call(m, 'materialize', {});
    assert.deepEqual(plain.workspaceDeletionsLeftOnDisk, [{ mount: 'work', path: 'a.txt' }]);
    assert.equal(env.readDisk('a.txt'), 'v1', 'materialize never deletes by default');

    const applied = await call(m, 'materialize', { applyDeletions: true });
    assert.deepEqual(applied.deleted, [{ mount: 'work', path: 'a.txt' }]);
    assert.throws(() => env.readDisk('a.txt'), /ENOENT/);
    assert.equal(await stateOf(m, 'a.txt'), 'not listed');
  });

  test('a path sync cancels a workspace delete', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'delete', { path: 'work/a.txt' });
    await call(m, 'sync', { path: 'work/a.txt' });
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
    assert.equal(await contentOf(m, 'a.txt'), 'v1');
  });

  test('a legacy entry with no baseline, deleted in the workspace, stays deleted', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('legacy.txt', 'old');
    env.legacyEntry('legacy.txt', 'old');
    await call(m, 'delete', { path: 'work/legacy.txt' });
    assert.equal(await stateOf(m, 'legacy.txt'), 'workspace-deleted', 'the tombstone carries the deleted hash');
    await call(m, 'sync', {});
    await (m as any).initialScan('work');
    assert.equal(await stateOf(m, 'legacy.txt'), 'workspace-deleted');
    const applied = await call(m, 'materialize', { applyDeletions: true });
    assert.deepEqual(applied.deleted, [{ mount: 'work', path: 'legacy.txt' }]);
  });

  test('autoMaterialize unlinks under an intent, and refuses when disk changed since', async (t) => {
    const env = new Env(t);
    const m = await env.open({ autoMaterialize: true });
    await call(m, 'write', { path: 'work/a.txt', content: 'v1' });
    await call(m, 'write', { path: 'work/b.txt', content: 'v1' });
    assert.equal(env.readDisk('a.txt'), 'v1');
    await call(m, 'delete', { path: 'work/a.txt' });
    assert.throws(() => env.readDisk('a.txt'), /ENOENT/, 'unlinked');

    env.writeDisk('b.txt', 'edited in the shell');
    const error = await refused(m, 'delete', { path: 'work/b.txt' });
    assert.match(error, /did not unlink/);
    assert.equal(env.readDisk('b.txt'), 'edited in the shell', 'the shell edit survives');
  });
});

describe('a path sync', () => {
  test('takes disk\'s state for a whole directory, and lists each workspace change it discarded', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'src/existing.txt', 'v1');
    await call(m, 'write', { path: 'work/src/existing.txt', content: 'a draft' });
    await call(m, 'write', { path: 'work/src/new.txt', content: 'never materialized' });
    await seedSynced(env, m, 'src/gone.txt', 'v1');
    await call(m, 'delete', { path: 'work/src/gone.txt' });
    await seedSynced(env, m, 'src/shell.txt', 'v1');
    env.writeDisk('src/shell.txt', 'edited in the shell');

    const data = await call(m, 'sync', { path: 'work/src' });
    const result = (data.results as Array<{ mount: string; synced: string[]; discarded?: Array<{ path: string; was: string; op: string }> }>)[0]!;
    assert.deepEqual([...result.synced].sort(), ['src/existing.txt', 'src/gone.txt', 'src/new.txt', 'src/shell.txt']);
    assert.deepEqual([...(result.discarded ?? [])].sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'src/existing.txt', was: 'workspace-draft', op: 'modified' },
      { path: 'src/gone.txt', was: 'workspace-deleted', op: 'created' },
      { path: 'src/new.txt', was: 'workspace-draft', op: 'deleted' },
    ], 'a shell edit taken in discards nothing; the rest were the workspace\'s own changes');
    assert.equal(await contentOf(m, 'src/existing.txt'), 'v1');
    assert.equal(await stateOf(m, 'src/new.txt'), 'not listed', 'disk has no such file, so neither does the workspace');
  });
});

describe('disk counterparts that are not stored', () => {
  test('a binary counterpart keeps the draft and a disk reference that reports a later change', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.dat', 'text v1');
    env.writeDisk('a.dat', Buffer.from([1, 0, 2, 0, 3]));
    await call(m, 'write', { path: 'work/a.dat', content: 'text v2' });

    let e = await entryOf(m, 'a.dat');
    assert.equal(e?.state, 'conflict');
    assert.equal(e?.conflict?.diskCopy, 'referenced', 'binary: referenced, not stored');
    assert.equal(e?.conflict?.diskChangedSinceRecorded, false);

    env.writeDisk('a.dat', Buffer.from([9, 0, 9, 0]));
    e = await entryOf(m, 'a.dat');
    assert.equal(e?.state, 'conflict');
    assert.equal(e?.conflict?.diskChangedSinceRecorded, true, 'the reference says disk changed since');
    assert.equal(await contentOf(m, 'a.dat'), 'text v2', 'the draft is kept');
    await call(m, 'materialize', {});
    assert.deepEqual([...readFileSync(env.disk('a.dat'))], [9, 0, 9, 0], 'and nothing overwrote the disk file');
  });

  test('an oversize counterpart is referenced too', async (t) => {
    const env = new Env(t);
    const m = await env.open({ maxFileSize: 64 });
    await seedSynced(env, m, 'a.txt', 'small');
    env.writeDisk('a.txt', 'x'.repeat(200));
    await call(m, 'write', { path: 'work/a.txt', content: 'small v2' });
    const e = await entryOf(m, 'a.txt');
    assert.equal(e?.state, 'conflict');
    assert.equal(e?.conflict?.diskCopy, 'referenced');
  });
});

describe('disk-only files', () => {
  test('a shell-written PNG is listed disk-only with size and type, and read_image opens it', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('shot.png', ONE_PX_PNG);
    const data = await call(m, 'ls', { path: 'work' });
    const png = (data.entries as Array<Record<string, unknown>>).find((e) => e.name === 'shot.png');
    assert.deepEqual(png, { name: 'shot.png', type: 'file', state: 'disk-only', size: ONE_PX_PNG.length, mimeType: 'image/png' });
    const glob = await call(m, 'glob', { pattern: '*.png' });
    assert.deepEqual(glob.matches, [{ path: 'work/shot.png', state: 'disk-only', size: ONE_PX_PNG.length, mimeType: 'image/png' }]);
    const res = await m.handleToolCall({ id: 't', name: 'read_image', input: { path: 'work/shot.png' } });
    assert.equal(res.success, true, `read_image: ${res.error}`);
  });

  test('an untracked file over the size limit is listed from its head, never read whole or taken as evidence', async (t) => {
    const env = new Env(t);
    const m = await env.open({ maxFileSize: 1024 });
    const big = Buffer.concat([ONE_PX_PNG, Buffer.alloc(256 * 1024, 1)]);
    env.writeDisk('big.png', big);

    const probe = await open(join(env.root, 'read-probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
    await probe.close();
    const read = proto.read;
    let bytes = 0;
    proto.read = async function (this: unknown, ...args: unknown[]) {
      const result = await read.apply(this, args);
      bytes += result.bytesRead;
      return result;
    };
    let entry;
    try {
      entry = (await call(m, 'ls', { path: 'work' })).entries.find((e: { name: string }) => e.name === 'big.png');
    } finally {
      proto.read = read;
    }
    assert.deepEqual(entry, { name: 'big.png', type: 'file', state: 'disk-only', size: big.length, mimeType: 'image/png' });
    assert.ok(bytes <= 8192, `the listing read ${bytes} bytes of a ${big.length}-byte file`);
    assert.equal((m as any).agreement.get('work', 'big.png'), undefined, 'no evidence recorded');
  });
});

describe('shell deletions', () => {
  const mechanisms: Array<[string, (env: Env, m: WorkspaceModule) => Promise<WorkspaceModule>]> = [
    ['a watcher event', async (_env, m) => { await (m as any).handleFsChanges('work', [{ path: 'gone.txt', op: 'deleted' }]); return m; }],
    ['a full sync', async (_env, m) => { await call(m, 'sync', {}); return m; }],
    ['sync without a path, on the mount', async (_env, m) => { await call(m, 'sync', { mount: 'work' }); return m; }],
    ['a listing', async (_env, m) => { await call(m, 'ls', { path: 'work' }); return m; }],
    ['the post-restart scan', async (env, m) => { const r = await env.restart(m); await (r as any).initialScan('work'); return r; }],
    ['a reattach', async (_env, m) => { await (m as any).initialScan('work'); return m; }],
  ];
  for (const [name, run] of mechanisms) {
    test(`a shell rm of a synced file is removed by ${name}`, async (t) => {
      const env = new Env(t);
      let m = await env.open();
      await seedSynced(env, m, 'gone.txt', 'v1');
      env.rmDisk('gone.txt');
      m = await run(env, m);
      assert.equal(env.store.treeGet(TREE, 'gone.txt'), null, 'the tree entry is removed');
      assert.match(await refused(m, 'read', { path: 'work/gone.txt' }), /File not found/);
      assert.ok(env.eventsOf('workspace:deleted').some((e) => e.paths.includes('work/gone.txt')), 'a deleted event was pushed');
    });
  }

  test('a shell rm of a file with a newer unmaterialized edit is kept as a conflict', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'v2, not materialized' });
    env.rmDisk('a.txt');
    await (m as any).handleFsChanges('work', [{ path: 'a.txt', op: 'deleted' }]);
    const deleted = env.eventsOf('workspace:deleted').at(-1);
    assert.deepEqual(deleted?.conflicts, ['work/a.txt'], 'the event names the conflict');

    const e = await entryOf(m, 'a.txt');
    assert.equal(e?.state, 'conflict');
    assert.equal(e?.conflict?.kind, 'deleted-on-disk');
    assert.equal(e?.conflict?.diskCopy, 'absent');
    await call(m, 'sync', {});
    assert.equal(await contentOf(m, 'a.txt'), 'v2, not materialized', 'the edit survives a full sync');
    assert.equal((await call(m, 'materialize', {})).materialized.length, 0, 'refused without force');
    await call(m, 'materialize', { force: true });
    assert.equal(env.readDisk('a.txt'), 'v2, not materialized');
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
  });
});

describe('provenance', () => {
  test('store-origin drafts are distinguished from legacy unknowns', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/draft.txt', content: 'never materialized' });
    env.legacyEntry('legacy-missing.txt', 'store only');
    env.legacyEntry('legacy-same.txt', 'same');
    env.writeDisk('legacy-same.txt', 'same');
    env.legacyEntry('legacy-diff.txt', 'store side');
    env.writeDisk('legacy-diff.txt', 'disk side');
    await call(m, 'write', { path: 'work/collide.txt', content: 'from the agent' });
    env.writeDisk('collide.txt', 'from the shell');

    const entries = await listing(m);
    assert.equal(entries.get('draft.txt')?.state, 'workspace-draft');
    assert.equal(entries.get('legacy-missing.txt')?.state, 'disk-missing-provenance-unknown');
    assert.equal(entries.get('legacy-same.txt')?.state, 'synced');
    assert.equal(entries.get('legacy-diff.txt')?.state, 'conflict');
    assert.equal(entries.get('legacy-diff.txt')?.conflict?.kind, 'unknown-provenance');
    assert.equal(entries.get('collide.txt')?.state, 'conflict');
    assert.equal(entries.get('collide.txt')?.conflict?.kind, 'store-origin-collision');
    assert.equal(await contentOf(m, 'legacy-diff.txt'), 'store side', 'a legacy mismatch keeps the store side');

    const materialized = await call(m, 'materialize', {});
    const written = (materialized.materialized as Array<{ path: string }>).map((w) => w.path).sort();
    assert.deepEqual(written, ['draft.txt'], 'drafts are written; what has no evidence is left for a named call');
    assert.equal(existsSync(env.disk('legacy-missing.txt')), false, 'a shell rm of a pre-evidence file is not undone');
    // With no evidence there was no agreement for disk to have changed since,
    // and nothing says whether a missing copy was deleted or never written.
    const reasons = (materialized.skipped as Array<{ reason: string }>).map((s) => s.reason).sort();
    assert.deepEqual(reasons, [
      'collide.txt: disk holds a different copy, and nothing records which is newer (conflict: store-origin-collision) — ' +
        'sync this path to adopt the disk version, or materialize this path with force to overwrite it',
      'legacy-diff.txt: disk holds a different copy, and nothing records which is newer (conflict: unknown-provenance) — ' +
        'sync this path to adopt the disk version, or materialize this path with force to overwrite it',
      'legacy-missing.txt: disk has no copy, and nothing records whether it was deleted there or never written — ' +
        'sync this path to drop it from the workspace, or materialize this path to write it',
    ]);

    // Both remedies do what they say.
    const named = await call(m, 'materialize', { path: 'work/legacy-missing.txt' });
    assert.deepEqual(named.materialized.map((w: { path: string }) => w.path), ['legacy-missing.txt']);
    assert.equal(env.readDisk('legacy-missing.txt'), 'store only');
    env.legacyEntry('legacy-gone.txt', 'deleted in a shell');
    const synced = await call(m, 'sync', { path: 'work/legacy-gone.txt' });
    assert.deepEqual(synced.results[0].discarded,
      [{ path: 'legacy-gone.txt', was: 'disk-missing-provenance-unknown', op: 'deleted' }]);
    assert.equal(env.store.treeGet(TREE, 'legacy-gone.txt'), null, 'the path sync dropped it from the workspace');
  });
});

describe('restarts and faults', () => {
  test('baselines survive a restart', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    m = await env.restart(m);
    env.writeDisk('a.txt', 'v3, edited after the restart');
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'P survived: a disk-only change, not unknown provenance');
    assert.equal(await contentOf(m, 'a.txt'), 'v3, edited after the restart');
  });

  for (const killAt of ['after-intent', 'after-effect'] as const) {
    test(`a materialize killed ${killAt}, then branch selection`, async (t) => {
      const env = new Env(t);
      let m = await env.open();
      await seedSynced(env, m, 'a.txt', 'v1');
      const main = env.store.currentBranch().name;
      env.store.createBranch('before-v2', main);
      await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
      m = await env.fault(m, 'materialize', killAt);
      assert.equal(env.readDisk('a.txt'), killAt === 'after-intent' ? 'v1' : 'v2');

      env.store.switchBranch('before-v2');
      assert.equal(await stateOf(m, 'a.txt'), killAt === 'after-intent' ? 'synced' : 'workspace-draft',
        'the earlier branch reads disk by the resolved intent, never as a disk edit');
      env.store.switchBranch(main);
      if (killAt === 'after-intent') {
        assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft', 'the write never happened: still owed');
        await call(m, 'materialize', {});
        assert.equal(env.readDisk('a.txt'), 'v2');
      }
      assert.equal(await stateOf(m, 'a.txt'), 'synced');
      if (killAt === 'after-effect') {
        // Disk shows the write, but nothing proves the dead process made it
        // durable: listings record nothing, and the next push completes it.
        assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending');
        await call(m, 'materialize', {});
        assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'content');
      }
    });

    test(`a shell-edit ingest killed ${killAt}, then branch selection`, async (t) => {
      const env = new Env(t);
      let m = await env.open();
      await seedSynced(env, m, 'a.txt', 'v1');
      const main = env.store.currentBranch().name;
      env.store.createBranch('before-edit', main);
      env.writeDisk('a.txt', 'v3, from the shell');
      m = await env.fault(m, 'sync', killAt);

      env.store.switchBranch('before-edit');
      const e = await entryOf(m, 'a.txt');
      assert.equal(e?.state, 'conflict', 'disk may hold the only copy of the edit: listed, not pushed over');
      assert.equal(e?.conflict?.kind, 'interrupted');
      await call(m, 'materialize', { force: false });
      assert.equal(env.readDisk('a.txt'), 'v3, from the shell');

      env.store.switchBranch(main);
      assert.equal(await stateOf(m, 'a.txt'), 'synced', 'on its own branch the adoption completes or is redone');
      assert.equal(await contentOf(m, 'a.txt'), 'v3, from the shell');
    });

    test(`an autoMaterialize write of a new file killed ${killAt}, then a branch without it`, async (t) => {
      const env = new Env(t);
      let m = await env.open();
      await seedSynced(env, m, 'other.txt', 'x');
      const main = env.store.currentBranch().name;
      env.store.createBranch('without-new', main);
      m = await env.fault(m, 'write', killAt);

      env.store.switchBranch('without-new');
      assert.equal(await stateOf(m, 'new.txt'), killAt === 'after-intent' ? 'not listed' : 'not-in-branch',
        'never ingested into a branch that lacks it');
      await call(m, 'sync', {});
      assert.equal(env.store.treeGet(TREE, 'new.txt'), null);

      env.store.switchBranch(main);
      assert.equal(await stateOf(m, 'new.txt'), killAt === 'after-intent' ? 'workspace-draft' : 'synced');
      assert.equal(await contentOf(m, 'new.txt'), 'new file');
    });
  }

  /** S = P = D = A, with an adoption of the shell's B left pending (killed after its intent). */
  async function pendingAdoption(env: Env): Promise<WorkspaceModule> {
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    env.writeDisk('a.txt', 'B');
    m = await env.fault(m, 'sync', 'after-intent');
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending');
    return m;
  }

  test('a write of the pending adoption\'s content is not taken for the old adoption landing', async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env);
    env.writeDisk('a.txt', 'C'); // disk moves on
    await call(m, 'write', { path: 'work/a.txt', content: 'B' });
    assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft', 'the write is a draft over disk C');
    assert.equal(await contentOf(m, 'a.txt'), 'B', 'and it survives the scan');
    assert.equal(env.readDisk('a.txt'), 'C');
  });

  test('a path sync keeps a stored binary file that disk agrees with', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const res = await m.writeBinary('work/img/shot.png', ONE_PX_PNG, 'image/png');
    assert.equal(res.success, true, String(res.error));
    await call(m, 'materialize', { path: 'work/img/shot.png' });
    assert.deepEqual(readFileSync(env.disk('img/shot.png')), ONE_PX_PNG);
    const stored = env.store.treeGet(TREE, 'img/shot.png');
    assert.notEqual(stored, null);

    const synced = await call(m, 'sync', { path: 'work/img' });
    assert.deepEqual(synced.results ?? [], [], 'nothing to take from disk');
    assert.deepEqual(env.store.treeGet(TREE, 'img/shot.png'), stored, 'still held, unchanged');
    assert.equal(await stateOf(m, 'img/shot.png'), 'synced');
  });

  test('writeBinary settles the pending adoption first too', async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env);
    env.writeDisk('a.txt', 'C');
    const res = await m.writeBinary('work/a.txt', Buffer.from('B'), 'text/plain');
    assert.equal(res.success, true, String(res.error));
    assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft');
    assert.equal(await contentOf(m, 'a.txt'), 'B');
  });

  test('an edit sees the disk version the settled adoption takes in, not stale text', async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env);
    env.writeDisk('a.txt', 'C');
    const error = await refused(m, 'edit', { path: 'work/a.txt', oldString: 'A', newString: 'B' });
    assert.match(error, /String not found/, 'the entry is disk\'s C by then, so an edit of A has nothing to replace');
    assert.equal(await contentOf(m, 'a.txt'), 'C');
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
  });

  test('a delete settles the pending adoption first, and deletes what the workspace then holds', async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env);
    env.writeDisk('a.txt', 'C');
    await call(m, 'delete', { path: 'work/a.txt' });
    assert.equal(await stateOf(m, 'a.txt'), 'workspace-deleted');
    assert.equal(env.readDisk('a.txt'), 'C');
  });

  test('a write commits only once a pending adoption on its branch is settled, even if the scan could not settle it', async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env); // pending on main
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.writeDisk('a.txt', 'C');
    env.store.switchBranch('other'); // the write starts on another branch
    // Each of the settle pass's three gathers sees the branch change under it,
    // so it decides nothing and returns incomplete; the write commits on main.
    await withReadHook((n) => env.store.switchBranch(n % 2 === 1 ? main : 'other'),
      () => call(m, 'write', { path: 'work/a.txt', content: 'B' }));
    assert.equal(env.store.currentBranch().name, main);
    assert.notEqual((m as any).agreement.get('work', 'a.txt').kind, 'pending', 'settled at the commit');
    const e = await entryOf(m, 'a.txt');
    assert.equal(e?.state, 'conflict', 'B (the write) and C (disk) both changed since A');
    assert.equal(await contentOf(m, 'a.txt'), 'B', 'the write survives');
  });

  test('a failed barrier at the mutation precondition stays owed, and the next mutation discharges it first', async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env);
    const agreement = (m as any).agreement as DiskAgreement;
    const mount = { name: 'work', treeStateId: TREE };
    const set = DiskAgreement.prototype.set;
    const storeSync = env.store.sync;
    let armed = false;
    let syncs = 0;
    DiskAgreement.prototype.set = function (this: DiskAgreement, ...args: Parameters<typeof set>) {
      set.apply(this, args);
      armed = true; // the next sync is the barrier after the settlement
    };
    (env.store as unknown as { sync: () => void }).sync = function () {
      syncs++;
      if (armed) {
        armed = false;
        throw Object.assign(new Error('injected EIO at the precondition barrier'), { code: 'EIO' });
      }
      storeSync.call(env.store);
    };
    try {
      assert.throws(() => settleAdoptionBeforeMutation(env.store, agreement, mount, 'a.txt'), /precondition barrier/);
      DiskAgreement.prototype.set = set;
      assert.equal(agreement.get('work', 'a.txt')?.kind, 'content', 'settled in memory');
      assert.equal(agreement.needsBarrier, true, 'and still owed a barrier');
      syncs = 0;
      settleAdoptionBeforeMutation(env.store, agreement, mount, 'a.txt'); // P no longer looks pending
      assert.ok(syncs >= 1, 'the retry discharges the barrier before permitting the mutation');
      assert.equal(agreement.needsBarrier, false);
    } finally {
      DiskAgreement.prototype.set = set;
      (env.store as unknown as { sync: () => void }).sync = storeSync;
    }
    await call(m, 'write', { path: 'work/a.txt', content: 'B' });
  });

  test('evidence loaded at open owes a barrier: reading records back proves nothing about their durability', (t) => {
    const env = new Env(t);
    const writer = new DiskAgreement(env.store);
    writer.open([{ name: 'work', root: '/srv/work' }]);
    writer.set('work', 'a.txt', { kind: 'content', hash: 'h', size: 1 }); // no barrier after it
    const reader = new DiskAgreement(env.store);
    reader.open([{ name: 'work', root: '/srv/work' }]);
    assert.deepEqual(reader.get('work', 'a.txt'), { kind: 'content', hash: 'h', size: 1 });
    assert.equal(reader.needsBarrier, true);
    reader.barrier();
    assert.equal(reader.needsBarrier, false);
  });

  test('evidence is read only after an ambiguous append is reconciled', (t) => {
    const env = new Env(t);
    let failSync = false;
    const flaky = new Proxy(env.store, {
      get(target, prop) {
        if (prop === 'sync') {
          return () => {
            if (failSync) {
              failSync = false;
              throw Object.assign(new Error('injected EIO after the append'), { code: 'EIO' });
            }
            target.sync();
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const agreement = new DiskAgreement(flaky as JsStore);
    agreement.open([{ name: 'work', root: '/srv/work' }]);
    failSync = true;
    assert.throws(() => agreement.intend('work', 'a.txt', {
      effect: 'adopt', prior: null, expect: { kind: 'content', hash: 'h' }, branchId: 'b',
    }, { durable: true }), /injected EIO/);
    assert.equal(agreement.get('work', 'a.txt')?.kind, 'pending', 'the append that landed is read back, not the stale view');
    assert.equal(agreement.needsBarrier, true);
  });

  test('with disk unreadable at the write, the pending adoption settles by the tree', { skip: IS_ROOT ? 'root reads every file' : false }, async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env);
    env.writeDisk('a.txt', 'C');
    chmodSync(env.disk('a.txt'), 0o000);
    try {
      await call(m, 'write', { path: 'work/a.txt', content: 'B' });
    } finally {
      chmodSync(env.disk('a.txt'), 0o644);
    }
    const e = await entryOf(m, 'a.txt');
    assert.equal(e?.state, 'conflict', 'disk C and the write B both changed since A: kept apart');
    assert.equal(await contentOf(m, 'a.txt'), 'B');
  });

  test('a failed agreement barrier stays owed: the next pass settles it before deciding', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await call(m, 'write', { path: 'work/a.txt', content: 'B' });
    env.writeDisk('a.txt', 'B'); // D = S: an agreement, with no intent behind it
    const set = DiskAgreement.prototype.set;
    const storeSync = env.store.sync;
    let armed = false;
    let syncs = 0;
    DiskAgreement.prototype.set = function (this: DiskAgreement, ...args: Parameters<typeof set>) {
      set.apply(this, args);
      armed = true; // the next sync is the barrier that should make it durable
    };
    (env.store as unknown as { sync: () => void }).sync = function () {
      syncs++;
      if (armed) {
        armed = false;
        throw Object.assign(new Error('injected EIO at the barrier'), { code: 'EIO' });
      }
      storeSync.call(env.store);
    };
    try {
      assert.match(await refused(m, 'ls', { path: 'work' }), /injected EIO at the barrier/);
      assert.equal((m as any).agreement.needsBarrier, true, 'the obligation survives the failed pass');
      DiskAgreement.prototype.set = set;
      syncs = 0;
      await call(m, 'ls', { path: 'work' }); // nothing new to record
      assert.ok(syncs >= 1, 'the next pass still syncs');
      assert.equal((m as any).agreement.needsBarrier, false);
    } finally {
      DiskAgreement.prototype.set = set;
      (env.store as unknown as { sync: () => void }).sync = storeSync;
    }
  });

  for (const trigger of ['a scan', 'a materialize'] as const) {
    test(`an agreement advance is durable before ${trigger} returns`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'a.txt', 'A');
      await call(m, 'write', { path: 'work/a.txt', content: 'B' });
      env.writeDisk('a.txt', 'B'); // D = S: agreement, with no intent behind it
      const events: string[] = [];
      const set = DiskAgreement.prototype.set;
      const storeSync = env.store.sync;
      DiskAgreement.prototype.set = function (this: DiskAgreement, ...args: Parameters<typeof set>) {
        set.apply(this, args);
        events.push(`set ${args[1]}`);
      };
      (env.store as unknown as { sync: () => void }).sync = function () {
        events.push('sync');
        storeSync.call(env.store);
      };
      try {
        if (trigger === 'a scan') await call(m, 'ls', { path: 'work' });
        else await call(m, 'materialize', {});
      } finally {
        DiskAgreement.prototype.set = set;
        (env.store as unknown as { sync: () => void }).sync = storeSync;
      }
      const last = events.lastIndexOf('set a.txt');
      assert.ok(last >= 0, `the agreement was recorded (${events.join(', ')})`);
      assert.ok(events.indexOf('sync', last + 1) > last, `a barrier follows it (${events.join(', ')})`);
    });
  }

  test('a push completed after a branch switch settles only the branch it planned on', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'A' }); // a draft disk never had
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.store.switchBranch('other');
    await call(m, 'write', { path: 'work/a.txt', content: 'B' });
    env.writeDisk('a.txt', 'from the shell');
    assert.equal(await stateOf(m, 'a.txt'), 'conflict'); // other's own intent: a recorded conflict
    env.rmDisk('a.txt');
    const intents = (m as any).intents.get('work');
    const otherBefore = intents.get('a.txt');
    env.store.switchBranch(main);

    const mount = (m as any).mounts.get('work');
    const runtime = await (m as any).runtime(mount);
    const pushed = await pushPaths(env.store, (m as any).agreement, runtime, ['a.txt'], {
      beforeEffect: () => queueMicrotask(() => env.store.switchBranch('other')),
    });
    assert.equal(env.store.currentBranch().name, 'other', 'the switch landed while the push wrote');
    assert.deepEqual(pushed.written, ['a.txt']);
    assert.equal(env.readDisk('a.txt'), 'A');
    assert.deepEqual(intents.get('a.txt'), otherBefore, "the other branch's intent is untouched");
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'content', 'the physical evidence is updated');

    env.store.switchBranch(main);
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'its own branch settles by convergence');
    assert.equal(intents.get('a.txt'), null);
  });

  test('a failed durability barrier is reported, and its intent stays pending', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'v1' });
    const probe = await open(join(env.root, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const sync = proto.sync;
    let calls = 0;
    proto.sync = async function () {
      calls++;
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
    };
    let res;
    try {
      res = await call(m, 'materialize', {});
    } finally {
      proto.sync = sync;
    }
    assert.equal(calls, 1, 'the file barrier failed; nothing after it ran');
    assert.deepEqual(res.materialized, []);
    assert.match(res.skipped[0].reason, /a\.txt: could not make the write durable \(file fsync\): injected EIO/);
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending', 'no completion was recorded');
    const entry = await entryOf(m, 'a.txt');
    assert.equal(entry?.state, 'synced', 'the next observation decides from disk');
    assert.match(entry?.note ?? '', /materialize that has not completed/);
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending', 'and records nothing: only a push completes it');
  });

  test('a write into new directories syncs every directory up to the mount root before it completes', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a/b/c.txt', content: 'deep' });
    const { result, synced } = await withSyncs(env, () => false, () => call(m, 'materialize', {}));
    assert.deepEqual(result.materialized, [{ mount: 'work', path: 'a/b/c.txt' }]);
    for (const dir of ['a/b', 'a', '']) assert.ok(synced.includes(idOf(env.disk(dir))), `${dir || 'the mount root'} was synced`);
    assert.ok(synced.includes(idOf(env.disk('a/b/c.txt'))), 'and the file');
  });

  test('a retry after a failed directory barrier syncs the whole chain, including directories the failed attempt made', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a/b/c.txt', content: 'deep' });
    const failing = await withSyncs(env, (id) => existsSync(env.disk('a')) && id === idOf(env.disk('a')), () => call(m, 'materialize', {}));
    assert.deepEqual(failing.result.materialized, []);
    assert.match(failing.result.skipped[0].reason, /a\/b\/c\.txt: could not make the write durable \(directory fsync of a\): injected EIO/);
    assert.equal((m as any).agreement.get('work', 'a/b/c.txt').kind, 'pending');

    const retry = await withSyncs(env, () => false, () => call(m, 'materialize', {}));
    assert.deepEqual(retry.result.materialized, [{ mount: 'work', path: 'a/b/c.txt' }]);
    for (const dir of ['a/b', 'a', '']) assert.ok(retry.synced.includes(idOf(env.disk(dir))), `${dir || 'the mount root'} was synced again`);
    assert.equal((m as any).agreement.get('work', 'a/b/c.txt').kind, 'content', 'completed by the push that confirmed it');
  });

  describe('only a push completes a push', () => {
    /** A push of a.txt whose directory barrier failed: the file holds v2, its intent pending. */
    async function unconfirmedPush(env: Env, m: WorkspaceModule, path: string): Promise<unknown> {
      const res = await withSyncs(env, (_id, isDirectory) => isDirectory, () => call(m, 'materialize', {}));
      assert.match(res.result.skipped[0].reason, /could not make the write durable \(directory fsync of the mount root\)/);
      const pending = (m as any).agreement.get('work', path);
      assert.equal(pending.kind, 'pending');
      return pending;
    }

    test('a listing does not complete it, so losing its unbarriered write keeps the draft', async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'a.txt', 'v1');
      await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
      const pending = await unconfirmedPush(env, m, 'a.txt');

      const entry = await entryOf(m, 'a.txt');
      assert.equal(entry?.state, 'synced');
      assert.match(entry?.note ?? '', /materialize that has not completed/);
      assert.deepEqual((m as any).agreement.get('work', 'a.txt'), pending, 'exactly as the push left it');

      env.writeDisk('a.txt', 'v1'); // the write never reached stable storage
      assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft');
      assert.equal(await contentOf(m, 'a.txt'), 'v2', 'the draft is kept, not replaced by the older disk version');
    });

    test("a new file's store origin survives a listing, so losing the file leaves a draft", async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await call(m, 'write', { path: 'work/new.txt', content: 'new' });
      const pending = await unconfirmedPush(env, m, 'new.txt');
      assert.equal(await stateOf(m, 'new.txt'), 'synced');
      assert.deepEqual((m as any).agreement.get('work', 'new.txt'), pending);
      assert.equal((m as any).intents.get('work').get('new.txt')?.origin, 'store');

      env.rmDisk('new.txt');
      assert.equal(await stateOf(m, 'new.txt'), 'workspace-draft');
      assert.equal(await contentOf(m, 'new.txt'), 'new');
    });

    test('the next materialize redoes it, barriers and all, and completes it', async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'a.txt', 'v1');
      await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
      await unconfirmedPush(env, m, 'a.txt');

      const status = await call(m, 'status', {});
      assert.equal(status.work.pendingChanges, 1, 'still owed');
      const retry = await withSyncs(env, () => false, () => call(m, 'materialize', {}));
      assert.deepEqual(retry.result.materialized, [{ mount: 'work', path: 'a.txt' }]);
      assert.ok(retry.synced.includes(idOf(env.disk('a.txt'))), 'the file was written and synced again');
      assert.ok(retry.synced.includes(idOf(env.dir)), 'and its directory');
      assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'content');
      assert.equal((await entryOf(m, 'a.txt'))?.note, undefined);
      assert.equal((await call(m, 'status', {})).work.pendingChanges, 0);
    });

    test('a sync of the path chooses disk instead, replacing the pending push', async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'a.txt', 'v1');
      await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
      await unconfirmedPush(env, m, 'a.txt');
      env.writeDisk('a.txt', 'v3, from the shell');

      await call(m, 'sync', { path: 'work/a.txt' });
      const p = (m as any).agreement.get('work', 'a.txt');
      assert.equal(p.kind, 'content', 'an adoption, not a completion');
      assert.equal(await contentOf(m, 'a.txt'), 'v3, from the shell');
      assert.equal(await stateOf(m, 'a.txt'), 'synced');
    });

    test('a branch without the file neither replays its bytes nor unlinks it, and keeps it pending', async (t) => {
      const env = new Env(t);
      const m = await env.open();
      const main = env.store.currentBranch().name;
      env.store.createBranch('before-new', main);
      await call(m, 'write', { path: 'work/new.txt', content: 'new' });
      const pending = await unconfirmedPush(env, m, 'new.txt');

      env.store.switchBranch('before-new');
      assert.equal(await stateOf(m, 'new.txt'), 'not-in-branch');
      for (const input of [{}, { applyDeletions: true }, { force: true }]) {
        const res = await call(m, 'materialize', input);
        assert.deepEqual(res.materialized, []);
        assert.equal(res.deleted, undefined);
      }
      assert.equal(env.readDisk('new.txt'), 'new');
      assert.deepEqual((m as any).agreement.get('work', 'new.txt'), pending);

      env.store.switchBranch(main);
      const res = await call(m, 'materialize', {});
      assert.deepEqual(res.materialized, [{ mount: 'work', path: 'new.txt' }]);
      assert.equal((m as any).agreement.get('work', 'new.txt').kind, 'content');
    });

    test('confirming an unlink never removes a file that appeared since, force or not', async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'gone.txt', 'v1');
      await call(m, 'delete', { path: 'work/gone.txt' });
      await withSyncs(env, (_id, isDirectory) => isDirectory, () => call(m, 'materialize', { applyDeletions: true }));
      const pending = (m as any).agreement.get('work', 'gone.txt');
      assert.equal(pending.kind, 'pending');

      const mount = (m as any).mounts.get('work');
      const pushed = await pushPaths(env.store, (m as any).agreement, await (m as any).runtime(mount), ['gone.txt'], {
        force: true,
        beforeEffect: () => writeFileSync(env.disk('gone.txt'), 'a new file from the shell'),
      });
      assert.deepEqual(pushed.deleted, []);
      assert.match(pushed.skipped[0]!.reason, /^not unlinked: a file appeared at this path since it was checked$/);
      assert.equal(env.readDisk('gone.txt'), 'a new file from the shell');
      assert.deepEqual((m as any).agreement.get('work', 'gone.txt'), pending, 'still owed, as before');
    });

    test('an unlink whose directory is gone is confirmed by syncing the directory that lacks it', async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'sub/gone.txt', 'v1');
      await call(m, 'delete', { path: 'work/sub/gone.txt' });
      await withSyncs(env, (_id, isDirectory) => isDirectory, () => call(m, 'materialize', { applyDeletions: true }));
      assert.equal((m as any).agreement.get('work', 'sub/gone.txt').kind, 'pending');
      rmSync(env.disk('sub'), { recursive: true });

      const retry = await withSyncs(env, () => false, () => call(m, 'materialize', {}));
      assert.deepEqual(retry.result.deleted, [{ mount: 'work', path: 'sub/gone.txt' }]);
      assert.ok(retry.synced.includes(idOf(env.dir)), "the root, where the directory's removal is recorded, was synced");
      assert.deepEqual((m as any).agreement.get('work', 'sub/gone.txt'), { kind: 'absent' });
    });

    test('an unlink whose barrier failed is confirmed by the next materialize, not by a listing', async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'gone.txt', 'v1');
      await call(m, 'delete', { path: 'work/gone.txt' });
      const res = await withSyncs(env, (_id, isDirectory) => isDirectory, () => call(m, 'materialize', { applyDeletions: true }));
      assert.match(res.result.skipped[0].reason, /could not make the unlink durable \(directory fsync of the mount root\)/);
      assert.throws(() => env.readDisk('gone.txt'), /ENOENT/);
      assert.equal((m as any).agreement.get('work', 'gone.txt').kind, 'pending');
      await listing(m);
      assert.equal((m as any).agreement.get('work', 'gone.txt').kind, 'pending', 'a listing records nothing');
      let status = (await call(m, 'status', {})).work;
      assert.deepEqual([status.pendingChanges, status.pendingWorkspaceDeletions], [1, 1], 'still owed, and said so');

      const retry = await withSyncs(env, () => false, () => call(m, 'materialize', {}));
      assert.deepEqual(retry.result.deleted, [{ mount: 'work', path: 'gone.txt' }], 'confirmed without applyDeletions: it already reached disk');
      assert.ok(retry.synced.includes(idOf(env.dir)));
      assert.deepEqual((m as any).agreement.get('work', 'gone.txt'), { kind: 'absent' });
      status = (await call(m, 'status', {})).work;
      assert.deepEqual([status.pendingChanges, status.pendingWorkspaceDeletions], [0, 0]);
    });
  });

  test('a directory that cannot be synced on its filesystem does not fail the write', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'v1' });
    const probe = await open(join(env.root, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const sync = proto.sync;
    let calls = 0;
    proto.sync = async function (this: unknown) {
      calls++;
      if (calls === 2) throw Object.assign(new Error('fsync of a directory: EINVAL'), { code: 'EINVAL' });
      return sync.call(this);
    };
    let res;
    try {
      res = await call(m, 'materialize', {});
    } finally {
      proto.sync = sync;
    }
    assert.deepEqual(res.materialized, [{ mount: 'work', path: 'a.txt' }]);
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'content');
  });

  test('a torn record tail after a materialize, then branch selection', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    const main = env.store.currentBranch().name;
    env.store.createBranch('before-v2', main);
    await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
    await call(m, 'materialize', {});
    await env.shutdown(m);
    const log = join(env.storePath, 'records.log');
    truncateSync(log, statSync(log).size - 5); // tears the completion
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open();

    env.store.switchBranch('before-v2');
    assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft', 'the intent is decided by disk on any branch');
    env.store.switchBranch(main);
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending', 'and completed only by a push');
    await call(m, 'materialize', {});
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'content');
  });

  test('evidence checkpoints and replays; a moved mount root discards it', (t) => {
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store);
    agreement.open([{ name: 'work', root: '/srv/work' }]);
    for (let i = 0; i < 1100; i++) agreement.set('work', `f${i}.txt`, { kind: 'content', hash: `h${i}`, size: i });
    agreement.maybeCheckpoint();
    agreement.set('work', 'after.txt', { kind: 'absent' });

    const replayed = new DiskAgreement(env.store);
    replayed.open([{ name: 'work', root: '/srv/work' }]);
    assert.deepEqual(replayed.get('work', 'f1099.txt'), { kind: 'content', hash: 'h1099', size: 1099 });
    assert.deepEqual(replayed.get('work', 'after.txt'), { kind: 'absent' });

    const moved = new DiskAgreement(env.store);
    moved.open([{ name: 'work', root: '/srv/elsewhere' }]);
    assert.equal(moved.get('work', 'f1.txt'), undefined, 'evidence about another directory says nothing here');
  });
});

describe('fingerprints', () => {
  test('a recorded fingerprint vouches only for an unchanged, non-racy file on a ctime-keeping filesystem', () => {
    const fp = { size: 4, mtimeNs: '1000000000000', ctimeNs: '1000000000000', ino: '7', dev: '9' };
    const old = { ...fp, hashedAt: 1_000_000 + 5_000 };
    assert.equal(fingerprintVouches(old, fp, true), true);
    assert.equal(fingerprintVouches(old, fp, false), false, 'an unlisted filesystem type always rehashes');
    assert.equal(fingerprintVouches({ ...fp, hashedAt: 1_000_000 + 1_000 }, fp, true), false, 'hashed inside the racy window');
    assert.equal(fingerprintVouches(old, { ...fp, ctimeNs: '1000000000001' }, true), false, 'any field differing');
    assert.equal(fingerprintVouches(undefined, fp, true), false);
  });

  test('no restored timestamp hides a change: utimes, cp -p, and a write in the racy window', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.equal(typeof (await filesystemTrustsCtime(env.dir)), 'boolean');
    await seedSynced(env, m, 'f.txt', 'aaaa');
    await sleep(2100);
    await call(m, 'ls', { path: 'work' }); // records a fingerprint old enough to vouch
    const before = statSync(env.disk('f.txt'));

    env.writeDisk('f.txt', 'bbbb'); // same size
    utimesSync(env.disk('f.txt'), before.atime, before.mtime);
    assert.equal(await contentOf(m, 'f.txt'), 'aaaa', 'the read serves the store');
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(await contentOf(m, 'f.txt'), 'bbbb', 'utimes restoring mtime: rehashed and adopted');

    await sleep(2100);
    await call(m, 'ls', { path: 'work' });
    env.writeDisk(join('..', 'src.txt'), 'cccc');
    utimesSync(join(env.root, 'src.txt'), before.atime, before.mtime);
    const cp = spawnSync('cp', ['-p', join(env.root, 'src.txt'), env.disk('f.txt')]);
    assert.equal(cp.status, 0, `cp -p: ${cp.stderr}`);
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(await contentOf(m, 'f.txt'), 'cccc', 'cp -p: rehashed and adopted');

    env.writeDisk('f.txt', 'dddd'); // inside the racy window of the last hash
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(await contentOf(m, 'f.txt'), 'dddd');
  });
});

describe('incomplete walks', () => {
  test('a permission-denied subtree deletes nothing beneath it', { skip: IS_ROOT ? 'root reads every directory' : false }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'locked/a.txt', 'v1');
    chmodSync(env.disk('locked'), 0o000);
    try {
      const data = await call(m, 'ls', { path: 'work', recursive: true });
      const entry = (data.entries as Entry[]).find((e) => e.path === 'locked/a.txt');
      assert.equal(entry?.state, 'unverified');
      assert.ok((data.incomplete as Array<{ path: string; reason: string }>).some((r) => r.path === 'locked' && /cannot list/.test(r.reason)));
      await call(m, 'sync', {});
      assert.notEqual(env.store.treeGet(TREE, 'locked/a.txt'), null, 'nothing unvisited is deleted');
    } finally {
      chmodSync(env.disk('locked'), 0o755);
    }
  });

  test('an ignored subtree deletes nothing beneath it, and untracked ignored files are not listed', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['cache'] });
    await seedSynced(env, m, 'cache/x.txt', 'tracked');
    env.rmDisk('cache/x.txt');
    env.writeDisk('cache/y.txt', 'untracked');
    const entries = await listing(m);
    assert.equal(entries.get('cache/x.txt')?.state, 'unverified');
    assert.equal(entries.has('cache/y.txt'), false);
    await call(m, 'sync', {});
    assert.notEqual(env.store.treeGet(TREE, 'cache/x.txt'), null);
  });

  test('a capped walk deletes nothing it did not reach', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await seedSynced(env, m, f, f);
    env.rmDisk('c.txt');
    const mount = (m as any).mounts.get('work');
    const pass = await (m as any).withMount(mount, () =>
      (m as any).passUnlocked(mount, { kind: 'dir', dir: '', recursive: true }, { cap: 2 }));
    assert.equal(pass.reports.get('c.txt')?.state, 'unverified');
    assert.ok(pass.incomplete.some((r: { reason: string }) => /file cap/.test(r.reason)));
    assert.notEqual(env.store.treeGet(TREE, 'c.txt'), null);
  });
});

describe('the mount boundary', () => {
  test('not even a forced materialize writes through a symlink or a symlinked directory out of the mount', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const outside = join(env.root, 'outside.txt');
    writeFileSync(outside, 'outside, untouched');
    mkdirSync(join(env.root, 'outdir'));
    await call(m, 'write', { path: 'work/link.txt', content: 'from the workspace' });
    await call(m, 'write', { path: 'work/linkdir/inner.txt', content: 'from the workspace' });
    symlinkSync(outside, env.disk('link.txt'));
    symlinkSync(join(env.root, 'outdir'), env.disk('linkdir'));

    const res = await call(m, 'materialize', { force: true });
    const reasons = ((res.skipped ?? []) as Array<{ reason: string }>).map((s) => s.reason).join('\n');
    assert.match(reasons, /link\.txt: not written: a symlink, which this mount does not follow/);
    assert.match(reasons, /linkdir\/inner\.txt: not written: a parent directory resolves outside the mount/);
    assert.equal(readFileSync(outside, 'utf8'), 'outside, untouched');
    assert.throws(() => readFileSync(join(env.root, 'outdir', 'inner.txt')), /ENOENT/);
  });

  test('a file with other hard links is never written in place, forced or not: its other names keep their content', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const outside = join(env.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside original');
    linkSync(join(outside, 'secret.txt'), env.disk('h.txt'));
    assert.equal(await stateOf(m, 'h.txt'), 'synced', 'a listing takes it in: reading through the name in the mount');
    await call(m, 'write', { path: 'work/h.txt', content: 'written by the workspace' });
    const before = (m as any).agreement.get('work', 'h.txt');

    for (const force of [false, true]) {
      const res = await call(m, 'materialize', { force });
      assert.deepEqual(res.materialized, [], `force: ${force}`);
      const reasons = ((res.skipped ?? []) as Array<{ reason: string }>).map((s) => s.reason).join('\n');
      assert.match(reasons, /h\.txt: not written: a file with other hard links/, `force: ${force}`);
      assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside original', `force: ${force}`);
      assert.deepEqual((m as any).agreement.get('work', 'h.txt'), before, 'its evidence is exactly as before the intent');
    }
    assert.equal(await stateOf(m, 'h.txt'), 'workspace-draft', 'the draft is kept, still owed');
    assert.equal(await contentOf(m, 'h.txt'), 'written by the workspace');
  });

  test('an autoMaterialize write to a file linked elsewhere after it was taken in is refused, and the write says why', async (t) => {
    const env = new Env(t);
    const m = await env.open({ autoMaterialize: true });
    env.writeDisk('h.txt', 'shared original');
    assert.equal(await stateOf(m, 'h.txt'), 'synced');
    const outside = join(env.root, 'outside.txt');
    linkSync(env.disk('h.txt'), outside);

    const error = await refused(m, 'write', { path: 'work/h.txt', content: 'written by the workspace' });
    assert.match(error, /not written: a file with other hard links/);
    assert.equal(readFileSync(outside, 'utf8'), 'shared original');
    assert.equal(await contentOf(m, 'h.txt'), 'written by the workspace', 'the workspace keeps the write');
  });

  /** A push of `paths` whose `beforeEffect` runs between planning and the effect. */
  async function pushWith(env: Env, m: WorkspaceModule, paths: string[], opts: Parameters<typeof pushPaths>[4]) {
    const mount = (m as any).mounts.get('work');
    return pushPaths(env.store, (m as any).agreement, await (m as any).runtime(mount), paths, opts);
  }

  for (const force of [false, true]) {
    test(`a parent swapped out of the mount after planning gets nothing written outside it (force: ${force})`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'sub/a.txt', 'original');
      await call(m, 'write', { path: 'work/sub/a.txt', content: 'draft' });
      const outside = join(env.root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'a.txt'), 'outside, untouched');
      const before = (m as any).agreement.get('work', 'sub/a.txt');

      const pushed = await pushWith(env, m, ['sub/a.txt'], { force, beforeEffect: () => swapForSymlink(env, 'sub', outside) });
      assert.equal(readFileSync(join(outside, 'a.txt'), 'utf8'), 'outside, untouched');
      assert.deepEqual(pushed.written, []);
      assert.match(pushed.skipped[0]!.reason, /^not written: a parent directory resolves outside the mount$/);
      assert.deepEqual((m as any).agreement.get('work', 'sub/a.txt'), before, 'its evidence is exactly as before the intent');
      assert.equal(env.readDisk('saved/a.txt'), 'original');
    });
  }

  test('a workspace deletion is never applied through a parent swapped out of the mount after planning', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'sub/gone.txt', 'v1');
    await call(m, 'delete', { path: 'work/sub/gone.txt' });
    const outside = join(env.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'gone.txt'), 'outside, untouched');

    const pushed = await pushWith(env, m, ['sub/gone.txt'], { applyDeletions: true, beforeEffect: () => swapForSymlink(env, 'sub', outside) });
    assert.equal(readFileSync(join(outside, 'gone.txt'), 'utf8'), 'outside, untouched');
    assert.deepEqual(pushed.deleted, []);
    assert.match(pushed.skipped[0]!.reason, /^not unlinked: a parent directory resolves outside the mount$/);
  });

  test('a disk edit made after planning is not overwritten without force, and reads as a conflict', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
    const before = (m as any).agreement.get('work', 'a.txt');

    const pushed = await pushWith(env, m, ['a.txt'], { beforeEffect: () => writeFileSync(env.disk('a.txt'), 'edited meanwhile') });
    assert.equal(env.readDisk('a.txt'), 'edited meanwhile');
    assert.deepEqual(pushed.written, []);
    assert.match(pushed.skipped[0]!.reason, /^not written: disk changed since it was checked$/);
    assert.deepEqual((m as any).agreement.get('work', 'a.txt'), before);
    const entry = await entryOf(m, 'a.txt');
    assert.equal(entry?.state, 'conflict');
    assert.equal(entry?.conflict?.kind, 'both-changed', 'both sides changed since they last agreed');

    const forced = await pushWith(env, m, ['a.txt'], { force: true, beforeEffect: () => writeFileSync(env.disk('a.txt'), 'edited again') });
    assert.deepEqual(forced.written, ['a.txt'], 'force overrides freshness');
    assert.equal(env.readDisk('a.txt'), 'v2');
  });

  test('a file that appears after planning saw none is not overwritten', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/new.txt', content: 'from the workspace' });

    const pushed = await pushWith(env, m, ['new.txt'], { beforeEffect: () => writeFileSync(env.disk('new.txt'), 'from the shell') });
    assert.equal(env.readDisk('new.txt'), 'from the shell');
    assert.match(pushed.skipped[0]!.reason, /^not written: a file appeared at this path since it was checked$/);
    assert.equal((m as any).agreement.get('work', 'new.txt'), undefined, 'still unknown, as before the intent');
    assert.equal(await stateOf(m, 'new.txt'), 'conflict');
  });

  test('a hard link made after planning is caught where the write happens', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'the workspace draft' });
    const outside = join(env.root, 'outside.txt');
    const before = (m as any).agreement.get('work', 'a.txt');

    const pushed = await pushWith(env, m, ['a.txt'], { force: true, beforeEffect: () => linkSync(env.disk('a.txt'), outside) });
    assert.deepEqual(pushed.written, []);
    assert.match(pushed.skipped[0]!.reason, /^not written: a file with other hard links/);
    assert.equal(readFileSync(outside, 'utf8'), 'v1', 'the other name keeps its content');
    assert.deepEqual((m as any).agreement.get('work', 'a.txt'), before);
  });

  test('even a forced write never lands in a file renamed away after it was opened', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'the workspace draft' });
    let swapped = false;
    const pushed = await withFsPromises('open', (open) => async (path, flags, ...rest) => {
      const handle = await open(path, flags, ...rest);
      if (!swapped && basename(String(path)) === 'a.txt' && typeof flags === 'number' && (flags & fsConstants.O_WRONLY) !== 0) {
        swapped = true; // renamed away once opened, and a new file put at its path
        renameSync(env.disk('a.txt'), env.disk('backup.txt'));
        writeFileSync(env.disk('a.txt'), 'a new disk edit');
      }
      return handle;
    }, () => pushWith(env, m, ['a.txt'], { force: true }));
    assert.equal(swapped, true);
    assert.deepEqual(pushed.written, []);
    assert.match(pushed.skipped[0]!.reason, /disk changed since it was checked/);
    assert.equal(env.readDisk('backup.txt'), 'v1', 'the renamed file is untouched');
    assert.equal(env.readDisk('a.txt'), 'a new disk edit', 'and so is the file now at the path');
  });

  test('a refused write puts back whatever evidence the path had, an interrupted one included', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'sub/a.txt', 'original');
    await call(m, 'write', { path: 'work/sub/a.txt', content: 'draft' });
    const interrupted = { kind: 'interrupted', candidates: [{ kind: 'absent' }, { kind: 'content', hash: 'h' }] };
    (m as any).agreement.set('work', 'sub/a.txt', interrupted);
    mkdirSync(join(env.root, 'outside'));

    await pushWith(env, m, ['sub/a.txt'], { force: true, beforeEffect: () => swapForSymlink(env, 'sub', join(env.root, 'outside')) });
    assert.deepEqual((m as any).agreement.get('work', 'sub/a.txt'), interrupted);
  });

  test('a directory swapped out of the mount after its parent was listed is never walked', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('sub/a.txt', 'original');
    await call(m, 'sync', {});
    const outside = join(env.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside');

    let swapped = false;
    const data = await withFsPromises('readdir', (readdir) => async (...args) => {
      const listed = await readdir(...args);
      if (!swapped) {
        swapped = true; // after the root's listing, before its subdirectory's
        swapForSymlink(env, 'sub', outside);
      }
      return listed;
    }, () => call(m, 'ls', { path: 'work', recursive: true }));
    const states = new Map((data.entries as Entry[]).map((e) => [e.path, e.state]));
    assert.equal(states.has('sub/secret.txt'), false, 'no outside name is listed');
    assert.equal(states.get('sub/a.txt'), 'unverified');
    assert.deepEqual(data.incomplete, [{ path: 'sub', reason: 'the directory changed while the walk ran' }]);
    assert.notEqual(env.store.treeGet(TREE, 'sub/a.txt'), null, 'the agreed entry stays');
  });

  test("a directory that changes between being held and being listed contributes nothing", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('sub/a.txt', 'original');
    await call(m, 'sync', {});
    const outside = join(env.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside');

    let swapped = false;
    const data = await withFsPromises('readdir', (readdir) => async (path, ...rest) => {
      if (!swapped && basename(String(path)) === 'sub') {
        swapped = true; // the subdirectory's own listing reaches outside
        swapForSymlink(env, 'sub', outside);
      }
      return readdir(path, ...rest);
    }, () => call(m, 'ls', { path: 'work', recursive: true }));
    const states = new Map((data.entries as Entry[]).map((e) => [e.path, e.state]));
    assert.equal(swapped, true);
    assert.equal(states.has('sub/secret.txt'), false, 'no outside name is listed');
    assert.equal(states.get('sub/a.txt'), 'unverified');
    assert.notEqual(env.store.treeGet(TREE, 'sub/a.txt'), null, 'nothing is removed on its absence');
  });

  test('absence is proven by the directory that lacks the entry, not by its name', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    mkdirSync(env.disk('sub'));
    const mount = (m as any).mounts.get('work');
    const runtime = await (m as any).runtime(mount);
    env.writeDisk('replacement/a.txt', 'present in the replacement');
    let misses = 0;
    const seen = await withFsPromises('lstat', (lstat) => async (path, ...rest) => {
      try {
        return await lstat(path, ...rest);
      } catch (err) {
        // By name: the lookups may go through the lexical or the canonical path.
        if (basename(String(path)) === 'a.txt' && ++misses === 2) {
          // The empty directory that lacked it is replaced by one that has it.
          renameSync(env.disk('sub'), env.disk('old'));
          renameSync(env.disk('replacement'), env.disk('sub'));
        }
        throw err;
      }
    }, () => observePath(runtime.view, runtime.rootReal, 'sub/a.txt'));
    assert.equal(misses, 2);
    assert.equal(seen.kind, 'unobserved', 'not absent: the directory that lacked it is gone');
    assert.equal(env.readDisk('sub/a.txt'), 'present in the replacement');
  });

  test('a file standing where a directory was proves nothing once a directory is back', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('sub/a.txt', 'A');
    await call(m, 'sync', {});
    renameSync(env.disk('sub'), env.disk('saved'));
    writeFileSync(env.disk('sub'), 'a file, for a moment');
    let swapped = false;
    const data = await withFsPromises('lstat', (lstat) => async (path, ...rest) => {
      const info = await lstat(path, ...rest);
      // By name: the lookups may go through the lexical or the canonical path.
      if (!swapped && basename(String(path)) === 'sub' && info.isFile()) {
        swapped = true;
        rmSync(env.disk('sub'));
        renameSync(env.disk('saved'), env.disk('sub'));
      }
      return info;
    }, () => call(m, 'ls', { path: 'work/sub', recursive: true }));
    assert.equal(swapped, true);
    assert.equal((data.entries as Entry[]).find((e) => e.path === 'sub/a.txt')?.state, 'unverified');
    assert.notEqual(env.store.treeGet(TREE, 'sub/a.txt'), null, 'nothing removed while it was present');
  });

  test('a path beneath a dangling symlink is not proven absent', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('sub/a.txt', 'original');
    await call(m, 'sync', {});
    swapForSymlink(env, 'sub', join(env.root, 'nowhere'));

    await (m as any).handleFsChanges('work', [{ path: 'sub/a.txt', op: 'deleted' }]);
    assert.notEqual(env.store.treeGet(TREE, 'sub/a.txt'), null, 'a watcher event deleted nothing');
    renameSync(env.disk('saved'), env.disk('elsewhere'));
    rmSync(env.disk('sub'));
    await (m as any).handleFsChanges('work', [{ path: 'sub/a.txt', op: 'deleted' }]);
    assert.equal(env.store.treeGet(TREE, 'sub/a.txt'), null, 'a real deletion is still adopted');
  });

  for (const followSymlinks of [false, true]) {
    test(`a symlinked parent never lets a read, listing or grep reach outside the mount (followSymlinks: ${followSymlinks})`, async (t) => {
      const env = new Env(t);
      const m = await env.open({ followSymlinks });
      const outside = join(env.root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SENTINEL');
      symlinkSync(outside, env.disk('escape'));

      const error = await refused(m, 'read', { path: 'work/escape/secret.txt' });
      assert.match(error, /outside the mount/);
      assert.doesNotMatch(error, /OUTSIDE_SENTINEL/);
      const scoped = await call(m, 'ls', { path: 'work/escape', recursive: true });
      assert.deepEqual(scoped.entries, []);
      assert.deepEqual(scoped.incomplete, [{ path: 'escape', reason: 'the directory resolves outside the mount' }]);
      const whole = await listing(m);
      assert.equal([...whole.keys()].some((p) => p.startsWith('escape/')), false);
      assert.deepEqual((await call(m, 'grep', { pattern: 'OUTSIDE_SENTINEL' })).results, []);
      assert.deepEqual((await call(m, 'grep', { pattern: 'OUTSIDE_SENTINEL', path: 'work/escape/secret.txt' })).results, []);
      assert.equal(env.store.treeGet(TREE, 'escape/secret.txt'), null, 'nothing from outside was ingested');
    });
  }

  test('an unavailable root with nothing tracked says so instead of listing a verified empty directory', async (t) => {
    const env = new Env(t);
    const m = await env.open({ path: join(env.root, 'never-created'), mode: 'read-only' });
    const data = await call(m, 'ls', { path: 'work' });
    assert.deepEqual(data.entries, []);
    assert.deepEqual(data.incomplete, [{ path: '', reason: 'the mount root is unavailable' }]);
  });

  for (const followSymlinks of [false, true]) {
    test(`a mount whose configured root is a symlink to a directory works (followSymlinks: ${followSymlinks})`, async (t) => {
      const env = new Env(t);
      const linkedRoot = join(env.root, 'linked-root');
      symlinkSync(env.dir, linkedRoot);
      env.writeDisk('from-disk.txt', 'written through the real directory');
      const m = await env.open({ path: linkedRoot, followSymlinks });

      const data = await call(m, 'ls', { path: 'work', recursive: true });
      assert.equal(data.incomplete, undefined, 'the root is available');
      assert.deepEqual((data.entries as Entry[]).map((e) => [e.path, e.state]), [['from-disk.txt', 'synced']]);
      assert.equal(await contentOf(m, 'from-disk.txt'), 'written through the real directory');
      await seedSynced(env, m, 'from-workspace.txt', 'materialized through the link');
      env.rmDisk('from-disk.txt');
      await call(m, 'sync', {});
      assert.equal(env.store.treeGet(TREE, 'from-disk.txt'), null, 'a shell deletion is still adopted');
    });
  }

  test('a missing mount root is unavailable, not a deletion of everything in it', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    renameSync(env.dir, `${env.dir}.away`);
    try {
      assert.equal(await stateOf(m, 'a.txt'), 'unverified');
      await call(m, 'sync', {});
      assert.notEqual(env.store.treeGet(TREE, 'a.txt'), null, 'nothing was removed');
    } finally {
      renameSync(`${env.dir}.away`, env.dir);
    }
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
  });
});

describe('grep', () => {
  test('hits are labelled by version, and disk-only files are reported as skipped', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'synced.txt', 'needle one');
    await seedSynced(env, m, 'draft.txt', 'nothing');
    await call(m, 'write', { path: 'work/draft.txt', content: 'needle two' });
    await seedSynced(env, m, 'conflict.txt', 'nothing');
    env.writeDisk('conflict.txt', 'needle on disk');
    await call(m, 'write', { path: 'work/conflict.txt', content: 'needle in the workspace' });
    await seedSynced(env, m, 'binary-conflict.dat', 'nothing');
    env.writeDisk('binary-conflict.dat', Buffer.from([0x6e, 0, 0x65, 0]));
    await call(m, 'write', { path: 'work/binary-conflict.dat', content: 'needle beside a binary disk version' });
    env.writeDisk('shot.png', ONE_PX_PNG);

    const data = await call(m, 'grep', { pattern: 'needle' });
    const hits = (data.results as Array<{ file: string; state: string; version: string; matches: Array<{ text: string }> }>)
      .map((r) => `${r.file} ${r.state} ${r.version}: ${r.matches[0]!.text}`);
    assert.deepEqual(hits, [
      'work/binary-conflict.dat conflict workspace: needle beside a binary disk version',
      'work/conflict.txt conflict workspace: needle in the workspace',
      'work/conflict.txt conflict conflicting-disk: needle on disk',
      'work/draft.txt workspace-draft workspace: needle two',
      'work/synced.txt synced workspace: needle one',
    ]);
    const skipped = data.skipped as Array<{ file: string; reason: string }>;
    assert.deepEqual(skipped.map((s) => s.file), ['work/binary-conflict.dat', 'work/shot.png'],
      "a conflict's binary disk version is no more searched than a disk-only file, and says so");
    assert.match(skipped[0]!.reason, /^conflict: the disk version is binary or over the size limit/);

    const one = await call(m, 'grep', { pattern: 'needle', path: 'work/draft.txt' });
    assert.deepEqual((one.results as Array<{ file: string }>).map((r) => r.file), ['work/draft.txt']);
  });

  test("once disk changes again, a conflict's stored disk version is labelled as recorded, and what disk holds now as not searched", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', 'disk says ALPHA');
    await call(m, 'write', { path: 'work/a.txt', content: 'workspace says GAMMA' });
    const recorded = await entryOf(m, 'a.txt');
    assert.equal(recorded?.conflict?.kind, 'both-changed');
    assert.equal(recorded?.conflict?.diskCopy, 'stored');
    type Grep = { results: Array<{ file: string; state: string; version: string; matches: Array<{ text: string }> }>; skipped?: Array<{ file: string; reason: string }> };
    const hitsOf = (data: Grep) => data.results.map((r) => `${r.file} ${r.state} ${r.version}: ${r.matches[0]!.text}`);

    const current: Grep = await call(m, 'grep', { pattern: 'ALPHA' });
    assert.deepEqual(hitsOf(current), ['work/a.txt conflict conflicting-disk: disk says ALPHA'], 'while disk still holds it');
    assert.equal(current.skipped, undefined);

    env.writeDisk('a.txt', 'disk now says BETA');
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.diskChangedSinceRecorded, true);
    const alpha: Grep = await call(m, 'grep', { pattern: 'ALPHA' });
    assert.deepEqual(hitsOf(alpha), ['work/a.txt conflict recorded-disk: disk says ALPHA'], 'no longer what disk says');
    const beta: Grep = await call(m, 'grep', { pattern: 'BETA' });
    assert.deepEqual(hitsOf(beta), []);
    for (const data of [alpha, beta]) {
      assert.deepEqual(data.skipped?.map((s) => s.file), ['work/a.txt'], 'what disk holds now is listed as not searched');
      assert.match(data.skipped![0]!.reason, /^conflict: disk changed since the conflict was recorded/);
    }

    env.rmDisk('a.txt');
    const gone: Grep = await call(m, 'grep', { pattern: 'ALPHA' });
    assert.deepEqual(hitsOf(gone), ['work/a.txt conflict recorded-disk: disk says ALPHA'], 'disk now has no file at all');
    assert.equal(gone.skipped, undefined, 'and no disk file went unsearched');
    assert.equal(await contentOf(m, 'a.txt'), 'workspace says GAMMA', 'the draft is kept');
  });
});

describe('on-agent-action', () => {
  test('a completed tool batch brings disk changes in before the next inference', async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' });
    await seedSynced(env, m, 'edited.txt', 'v1');
    await seedSynced(env, m, 'removed.txt', 'v1');
    env.writeDisk('edited.txt', 'v2, by a shell command');
    env.rmDisk('removed.txt');
    env.writeDisk('created.txt', 'new');

    await m.onToolBatchComplete('agent');
    const blob = (p: string) => {
      const e = env.store.treeGet(TREE, p);
      return e ? env.store.getBlob(e.blobHash)?.toString('utf8') : null;
    };
    assert.equal(blob('edited.txt'), 'v2, by a shell command');
    assert.equal(blob('removed.txt'), null);
    assert.equal(blob('created.txt'), 'new');
    const status = await call(m, 'status', {});
    assert.equal(status.work.lastAgentActionScan.complete, true);
  });

  test('a scan that finishes without seeing everything says where, on status and as an event', { skip: IS_ROOT ? 'root reads every directory' : false }, async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' });
    await seedSynced(env, m, 'locked/a.txt', 'v1');
    chmodSync(env.disk('locked'), 0o000);
    try {
      await m.onToolBatchComplete('agent');
    } finally {
      chmodSync(env.disk('locked'), 0o755);
    }
    const scan = (await call(m, 'status', {})).work.lastAgentActionScan;
    assert.equal(scan.complete, true, 'it finished');
    assert.equal(scan.withinDeadline, true);
    assert.deepEqual(scan.incomplete, [{ path: 'locked', reason: 'cannot list (EACCES)' }]);
    const event = env.events.find((e) => e.type === 'workspace:agent-action-scan-incomplete') as unknown as
      | { mount: string; incomplete: Array<{ path: string; reason: string }> } | undefined;
    assert.equal(event?.mount, 'work');
    assert.deepEqual(event?.incomplete, [{ path: 'locked', reason: 'cannot list (EACCES)' }]);
  });

  test('a scan that outlasts its deadline is reported incomplete, and still finishes', async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 50 });
    env.writeDisk('late.txt', 'arrives late');
    const mount = (m as any).mounts.get('work');
    const held = (m as any).withMount(mount, () => sleep(400)); // another pass holds the mount

    await m.onToolBatchComplete('agent');
    let status = await call(m, 'status', {});
    assert.equal(status.work.lastAgentActionScan.complete, false);
    assert.equal(status.work.lastAgentActionScan.withinDeadline, false);
    assert.match(status.work.lastAgentActionScan.reason, /deadline exceeded \(50 ms\); the scan continues/);
    assert.ok(env.events.some((e) => e.type === 'workspace:agent-action-scan-incomplete'));
    assert.equal(env.store.treeGet(TREE, 'late.txt'), null, 'nothing was claimed before the scan ran');

    await held;
    await (m as any).mountTurns.get('work');
    assert.notEqual(env.store.treeGet(TREE, 'late.txt'), null, 'the scan finished afterwards');
    status = await call(m, 'status', {});
    assert.deepEqual(
      { complete: status.work.lastAgentActionScan.complete, withinDeadline: status.work.lastAgentActionScan.withinDeadline, reason: status.work.lastAgentActionScan.reason },
      { complete: true, withinDeadline: false, reason: 'finished after the deadline' },
    );
  });

  test('a branch switch while a pass reads disk makes it gather again, on the branch it then decides on', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.store.switchBranch('other');
    await call(m, 'write', { path: 'work/only-other.txt', content: 'a draft on other' });
    env.store.switchBranch(main);

    // The listing that lived through the switch is the one judged: a.txt's
    // fingerprint is too fresh to vouch, so the pass reads it.
    const data = await withReadHook((n) => { if (n === 1) env.store.switchBranch('other'); },
      () => call(m, 'ls', { path: 'work', recursive: true }));
    assert.equal(env.store.currentBranch().name, 'other');
    assert.equal(data.incomplete, undefined);
    const entries = new Map((data.entries as Entry[]).map((e) => [e.path, e.state]));
    assert.equal(entries.get('only-other.txt'), 'workspace-draft', "the new branch's draft is decided, not omitted");
    assert.equal(entries.get('a.txt'), 'synced');
  });

  test('a branch that keeps changing under a pass leaves it explicitly incomplete', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    const data = await withReadHook((n) => env.store.switchBranch(n % 2 === 1 ? 'other' : main),
      () => call(m, 'ls', { path: 'work', recursive: true }));
    assert.deepEqual(data.entries, []);
    assert.deepEqual(data.incomplete, [{ path: '', reason: 'the selected branch kept changing while the scan ran' }]);
  });

  test('a branch switched away during the root check and back during a read is decided on the branch enumerated', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    await call(m, 'write', { path: 'work/only-main.txt', content: 'a draft on main' });

    const fsp = createRequire(import.meta.url)('node:fs/promises') as { stat: (...args: unknown[]) => Promise<unknown> };
    const stat = fsp.stat;
    let first = true;
    fsp.stat = async function (path: unknown, ...rest: unknown[]) {
      const result = await stat(path, ...rest);
      if (first && path === env.dir) {
        first = false;
        env.store.switchBranch('other'); // A -> B before the candidates are read
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      const data = await withReadHook((n) => { if (n === 1) env.store.switchBranch(main); }, // B -> A during a read
        () => call(m, 'ls', { path: 'work', recursive: true }));
      assert.equal(first, false, 'the branch switched during the root check');
      assert.equal(env.store.currentBranch().name, main);
      const states = new Map((data.entries as Entry[]).map((e) => [e.path, e.state]));
      assert.equal(states.get('only-main.txt'), 'workspace-draft', "main's draft is in main's listing");
    } finally {
      fsp.stat = stat;
      syncBuiltinESMExports();
    }
  });

  test('a push whose selection was made on another branch writes nothing', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'A' });
    const mount = (m as any).mounts.get('work');
    const pushed = await pushPaths(env.store, (m as any).agreement, await (m as any).runtime(mount), ['a.txt'], { branchId: 'not-this-branch' });
    assert.deepEqual(pushed.written, []);
    assert.match(pushed.skipped[0]!.reason, /selected branch changed/);
    assert.throws(() => env.readDisk('a.txt'), /ENOENT/);
  });

  test('a branch change while the scan waits applies to the branch current when it decides', async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' });
    await seedSynced(env, m, 'a.txt', 'v1');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.writeDisk('new.txt', 'made during the batch');
    const mount = (m as any).mounts.get('work');
    const held = (m as any).withMount(mount, () => sleep(100));
    const scan = m.onToolBatchComplete('agent');
    env.store.switchBranch('other'); // the selection changes before the scan decides
    await held;
    await scan;

    assert.notEqual(env.store.treeGet(TREE, 'new.txt'), null, 'adopted on the branch current at decision time');
    env.store.switchBranch(main);
    assert.equal(env.store.treeGet(TREE, 'new.txt'), null, 'the old selection was not written with the observation');
    assert.equal(await stateOf(m, 'new.txt'), 'not-in-branch');
  });
});

describe('materialize, status and shutdown', () => {
  test('a materialize queued behind a pass is guarded on the branch it then selects on', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'base.txt', 'base');
    const forkAt = env.store.currentSequence();
    await seedSynced(env, m, 'newer.txt', 'newer on main'); // pinned past the fork
    const main = env.store.currentBranch().name;
    env.store.createBranchAt('divergent', main, forkAt);
    env.store.switchBranch('divergent');
    await call(m, 'write', { path: 'work/div.txt', content: 'divergent' });
    env.store.switchBranch(main);

    const mount = (m as any).mounts.get('work');
    const held = (m as any).withMount(mount, () => sleep(100));
    const queued = m.handleToolCall({ id: 't', name: 'materialize', input: {} });
    env.store.switchBranch('divergent'); // while it waits for its turn
    await held;
    const res = await queued;
    assert.equal(res.success, false, 'refused on the branch it would have written');
    assert.match(String(res.error), /diverged/);
    assert.equal(existsSync(env.disk('div.txt')), false, 'nothing written');
  });

  test('a materialize whose push is refused on a branch change leaves the pin, so the next one there is still guarded', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'base.txt', 'base');
    const forkAt = env.store.currentSequence();
    await seedSynced(env, m, 'newer.txt', 'newer on main'); // pinned past the fork
    const main = env.store.currentBranch();
    env.store.createBranchAt('divergent', main.name, forkAt);
    env.store.switchBranch('divergent');
    await call(m, 'write', { path: 'work/div.txt', content: 'divergent' });
    env.store.switchBranch(main.name);
    await call(m, 'write', { path: 'work/base.txt', content: 'base v2' }); // owed on main
    const mount = (m as any).mounts.get('work');
    const before = { pin: mount.lastMaterializedBranchId, seq: mount.lastMaterializedSeq };
    assert.equal(before.pin, main.id);

    // The selection is made on main; the branch changes while the push reads disk.
    let switched = false;
    const data = await withFsPromises('lstat', (lstat) => async (...args: any[]) => {
      if (!switched && String(args[0]).endsWith('base.txt')) {
        switched = true;
        env.store.switchBranch('divergent');
      }
      return lstat(...args);
    }, () => call(m, 'materialize', {}));
    assert.equal(switched, true, 'the branch changed while the push read disk');
    assert.deepEqual(data.materialized, []);
    assert.match(JSON.stringify(data.skipped), /selected branch changed/);
    assert.deepEqual({ pin: mount.lastMaterializedBranchId, seq: mount.lastMaterializedSeq }, before, 'pin and watermark as they were');
    assert.equal(env.readDisk('base.txt'), 'base');

    // So the next materialize, on the divergent branch, is still refused.
    assert.match(await refused(m, 'materialize', {}), /diverged/);
    assert.equal(existsSync(env.disk('div.txt')), false, 'nothing of the divergent branch written');
  });

  test('a first materialize refused on a branch change leaves an unpinned mount unpinned, though entries were in place', async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' });
    env.writeDisk('a.txt', 'A');
    await m.onToolBatchComplete('agent'); // adopted: in place on main, never materialized
    const mount = (m as any).mounts.get('work');
    assert.equal(mount.lastMaterializedBranchId, null, 'never pinned');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    await call(m, 'write', { path: 'work/b.txt', content: 'B' }); // owed on main
    const seq = mount.lastMaterializedSeq;

    let switched = false;
    const data = await withFsPromises('lstat', (lstat) => async (...args: any[]) => {
      if (!switched && String(args[0]).endsWith('b.txt')) {
        switched = true;
        env.store.switchBranch('other');
      }
      return lstat(...args);
    }, () => call(m, 'materialize', {}));
    assert.equal(switched, true, 'the branch changed while the push read disk');
    assert.deepEqual(data.materialized, []);
    assert.equal(mount.lastMaterializedBranchId, null, 'still unpinned');
    assert.equal(mount.lastMaterializedSeq, seq, 'watermark as it was');
  });

  test('status counts a workspace deletion as pending until a push applies it', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'gone.txt', 'v1');
    await call(m, 'delete', { path: 'work/gone.txt' });
    await call(m, 'materialize', {}); // left on disk: applyDeletions wasn't given
    let status = (await call(m, 'status', {})).work;
    assert.deepEqual([status.pendingChanges, status.pendingWorkspaceDeletions], [1, 1]);
    await call(m, 'materialize', { applyDeletions: true });
    status = (await call(m, 'status', {})).work;
    assert.deepEqual([status.pendingChanges, status.pendingWorkspaceDeletions], [0, 0]);
  });

  test("status counts a push that didn't reach disk as pending, past the watermark", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
    const failed = await withSyncs(env, () => true, () => call(m, 'materialize', {}));
    assert.deepEqual(failed.result.materialized, []);
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 1, 'the edit is still owed');
    await call(m, 'materialize', {});
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 0);
  });

  test('stop waits for work queued behind what was in flight when it began', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const mount = (m as any).mounts.get('work');
    void (m as any).withMount(mount, () => sleep(100));
    const stopping = m.stop();
    await sleep(10);
    let finished = false;
    // Appended after stop began, as a watcher callback or a late scan would be.
    void (m as any).withMount(mount, async () => {
      await sleep(100);
      finished = true;
    });
    await stopping;
    assert.equal(finished, true, 'nothing still runs once stop returns');
  });
});

describe("Mythos's shape", () => {
  test('one new PNG and three deleted logs in a 350-entry directory', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const name = (i: number) => `files/tmp/log-${String(i).padStart(3, '0')}.txt`;
    for (let i = 0; i < 350; i++) env.writeDisk(name(i), `log ${i}`);
    await call(m, 'sync', {});

    env.writeDisk('files/tmp/screenshot.png', ONE_PX_PNG);
    for (const i of [7, 123, 300]) env.rmDisk(name(i));

    const data = await call(m, 'ls', { path: 'work/files/tmp' });
    const entries = data.entries as Array<{ name: string; state: string; mimeType?: string }>;
    assert.equal(entries.length, 348);
    assert.deepEqual(entries.find((e) => e.name === 'screenshot.png'),
      { name: 'screenshot.png', type: 'file', state: 'disk-only', size: ONE_PX_PNG.length, mimeType: 'image/png' });
    for (const i of [7, 123, 300]) {
      assert.equal(entries.some((e) => e.name === `log-${String(i).padStart(3, '0')}.txt`), false, `log ${i} is gone`);
    }
    assert.equal(entries.filter((e) => e.state === 'synced').length, 347);
  });
});

// A field report from a host on main: after a restart lost the watermark, a
// bare `materialize` pushing one new file wrote the whole tree, a stale entry
// over its newer disk copy included.
describe('a bare materialize after a restart', () => {
  /** The paths each push of `m` was asked to take up, sorted. */
  function recordPushes(m: WorkspaceModule): string[][] {
    const seen: string[][] = [];
    const push = (m as any).pushUnlocked.bind(m);
    (m as any).pushUnlocked = (mount: unknown, paths: string[], opts: unknown) => {
      seen.push([...paths].sort());
      return push(mount, paths, opts);
    };
    return seen;
  }

  test('refuses a path with no evidence whose disk copy differs, and writes a new file', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'old.txt', 'materialized before the restart');
    await call(m, 'materialize', {});
    // A tree entry from before the evidence (no P, no #169 baseline), stale:
    // its disk copy was appended in a shell, and no pass has observed it.
    env.legacyEntry('notes.txt', 'line 1\n');
    env.writeDisk('notes.txt', 'line 1\nline 2, appended in a shell\n');
    m = await env.restart(m);
    assert.equal((await call(m, 'status', {})).work.lastMaterializedSeq, 0, 'the restart lost the watermark');

    await call(m, 'write', { path: 'work/new.txt', content: 'one small new file' });
    const refusal = {
      mount: 'work',
      reason: 'notes.txt: disk holds a different copy, and nothing records which is newer (conflict: unknown-provenance) — ' +
        'sync this path to adopt the disk version, or materialize this path with force to overwrite it',
    };
    const res = await call(m, 'materialize', {});
    assert.deepEqual(res.materialized.map((w: { path: string }) => w.path), ['new.txt']);
    assert.equal(env.readDisk('new.txt'), 'one small new file');
    assert.equal(env.readDisk('notes.txt'), 'line 1\nline 2, appended in a shell\n', 'the disk copy is untouched');
    assert.deepEqual(res.skipped, [refusal]);
    assert.equal((await entryOf(m, 'notes.txt'))?.conflict?.kind, 'unknown-provenance');

    // Nothing tells that disk copy from an older one, so force alone doesn't overwrite it either.
    const forced = await call(m, 'materialize', { force: true });
    assert.equal(forced.count, 0);
    assert.deepEqual(forced.skipped, [refusal]);
    assert.equal(env.readDisk('notes.txt'), 'line 1\nline 2, appended in a shell\n');
    await call(m, 'materialize', { path: 'work/notes.txt', force: true });
    assert.equal(env.readDisk('notes.txt'), 'line 1\n', 'naming the path with force does');
  });

  test('a whole-mount restore after a branch switch still overwrites a path with no evidence', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.legacyEntry('settings.json', '{"restored": true}');
    env.writeDisk('settings.json', '{"restored": false}');
    // materializeMount is the deliberate restore that follows an undo or branch switch: its scope is named.
    assert.deepEqual(await m.materializeMount('work'), ['settings.json']);
    assert.equal(env.readDisk('settings.json'), '{"restored": true}');
  });

  test('takes up only what the evidence says disk owes, and never reverts a newer disk copy', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await seedSynced(env, m, name, `${name} v1`);
    await call(m, 'materialize', {});
    // Disk moves on after it agreed; the tree hasn't seen it.
    env.writeDisk('b.txt', 'b.txt v1, appended in a shell');
    m = await env.restart(m);

    await call(m, 'write', { path: 'work/new.txt', content: 'new' });
    const pushes = recordPushes(m);
    const forced = await call(m, 'materialize', { force: true });
    assert.deepEqual(pushes, [['new.txt']], 'only the new file is taken up, even with force');
    assert.deepEqual(forced.materialized.map((w: { path: string }) => w.path), ['new.txt']);
    assert.equal(env.readDisk('b.txt'), 'b.txt v1, appended in a shell', 'force without a path does not revert it');

    const bare = await call(m, 'materialize', {});
    assert.deepEqual(pushes[1], [], 'nothing is owed');
    assert.equal(bare.count, 0);
    assert.equal(bare.skipped, undefined);

    await call(m, 'materialize', { path: 'work/b.txt', force: true });
    assert.equal(env.readDisk('b.txt'), 'b.txt v1', 'naming the path with force does');
  });

  test('pins the branch from the evidence when nothing is owed', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'a');
    const forkAt = env.store.currentSequence();
    await seedSynced(env, m, 'b.txt', 'b');
    m = await env.restart(m);
    assert.equal((await call(m, 'status', {})).work.lastMaterializedBranch, null, 'the restart lost the pin');

    const first = await call(m, 'materialize', {});
    assert.equal(first.count, 0, 'nothing is owed');
    const main = env.store.currentBranch();
    assert.equal((await call(m, 'status', {})).work.lastMaterializedBranch, main.id, 'disk holds this branch: pinned');

    // A branch that diverged before b.txt is refused, not let through.
    env.store.createBranchAt('child', main.name, forkAt);
    env.store.switchBranch('child');
    await call(m, 'write', { path: 'work/a.txt', content: 'a from child' });
    assert.match(await refused(m, 'materialize', {}), /diverged/);
    assert.equal(env.readDisk('a.txt'), 'a');
  });

  test('status counts what disk owes by the evidence, not every tree change since the watermark', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'materialize', {});
    env.writeDisk('a.txt', 'v2 from a shell');
    await call(m, 'sync', {});
    assert.equal(await contentOf(m, 'a.txt'), 'v2 from a shell', 'disk adopted: a tree change disk already holds');
    // An entry from before the evidence is unchecked, not unpushed.
    env.legacyEntry('legacy.txt', 'never checked');
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 0);

    await call(m, 'write', { path: 'work/a.txt', content: 'v3' });
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 1);
  });
});
