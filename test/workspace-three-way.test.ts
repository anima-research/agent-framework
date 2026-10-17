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
import { TOOL_BATCH_HOOK_TIMEOUT_MS } from '../src/module-registry.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, constants as fsConstants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { open, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { DISK_AGREEMENT_RECORD_TYPE, DiskAgreement } from '../src/modules/workspace/disk-agreement.js';
import { RecordJournal } from '../src/record-journal.js';
import { confirmAbsent, fingerprintVouches, filesystemTrustsCtime, fsTypeTrustsCtime, observePath, provenAbsent, readPath, walkScope, type MountView } from '../src/modules/workspace/observe.js';
import { EffectFailed, syncDirectories, unlinkContained, writeContained } from '../src/modules/workspace/effects.js';
import { pushPaths, settleAdoptionBeforeMutation } from '../src/modules/workspace/reconcile.js';
import type { MountConfig, WorkspaceConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent } from '../src/types/events.js';
import { changedAfterFstat, withFileHandle } from './helpers/file-handle.js';

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

  /** Start a module as a restart that finds `state` saved as its module state. */
  async openRestarted(state: unknown, mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', ...mount }] });
    m.initStore(this.store);
    await m.start({
      isRestart: true,
      getState: () => state,
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

/** The hash evidence and disk facts carry for this text. */
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Run `fn` with each file a pass reads switching branches as `onRead` says,
 * once per file, just before its read starts: at a FileHandle readFile, or at
 * a handle's first FileHandle read at position 0 (a file that grew past the
 * size limit is read from its start again, on the same handle, to hash it).
 * Any other such read in the window counts too, such as a write's
 * verification or a listing's head read.
 */
async function withReadHook<T>(onRead: (calls: number) => void, fn: () => Promise<T>): Promise<T> {
  let calls = 0;
  const started = new WeakSet<object>();
  return withFileHandle({
    readFile: (readFile) => async function (this: unknown, ...args: unknown[]) {
      onRead(++calls);
      return readFile.apply(this, args);
    },
    read: (read) => async function (this: object, ...args: unknown[]) {
      if (args[3] === 0 && !started.has(this)) {
        started.add(this);
        onRead(++calls);
      }
      return read.apply(this, args);
    },
  }, fn);
}

/** Run `fn` with node:fs/promises' `name` replaced by `make(original)`, as the code under test sees it. */
async function withFsPromises<T>(name: 'readdir' | 'lstat' | 'open' | 'realpath', make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>, fn: () => Promise<T>): Promise<T> {
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

describe('a deletion another branch put on disk', () => {
  for (const how of ['a sync', 'a path sync'] as const) {
    test(`settles this branch's tombstone, and ${how} adopts a new disk file there as new, giving up nothing`, async (t) => {
      // P is global: this branch's S (absent) equals P (absent, from the other
      // branch's unlink), so the new file is only a disk change. The rule
      // decides by P whenever it's known; a tombstone guards only without it.
      const env = new Env(t);
      const m = await env.open();
      await seedSynced(env, m, 'a.txt', 'v1');
      const main = env.store.currentBranch().name;
      env.store.createBranch('other', main);
      await call(m, 'delete', { path: 'work/a.txt' }); // main's own deletion, never pushed
      env.store.switchBranch('other');
      await call(m, 'delete', { path: 'work/a.txt' });
      await call(m, 'materialize', { applyDeletions: true }); // other removes it from disk: P is absent
      assert.equal(existsSync(env.disk('a.txt')), false);
      env.writeDisk('a.txt', 'new, from the shell');
      env.store.switchBranch(main);

      const data = await call(m, 'sync', how === 'a sync' ? {} : { path: 'work/a.txt' });
      assert.deepEqual(data.results, [{ mount: 'work', synced: ['a.txt'], conflicts: [] }], 'taken in, with nothing discarded');
      assert.equal(await stateOf(m, 'a.txt'), 'synced');
      assert.equal(await contentOf(m, 'a.txt'), 'new, from the shell');
    });
  }
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

  test("a deletion whose record can't be read is unverified, never resurrected, until a path sync replaces it", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    env.legacyEntry('legacy.txt', 'old');
    env.writeDisk('legacy.txt', 'old');
    await call(m, 'delete', { path: 'work/legacy.txt' }); // the tombstone is all that keeps it deleted: no evidence
    const record = env.store.treeGet('workspace/work/intent', 'legacy.txt');
    assert.ok(record, 'the tombstone is recorded');
    await env.shutdown(m);
    rmSync(join(env.storePath, 'blobs', record.blobHash.slice(0, 2), record.blobHash)); // and its blob is lost
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open();

    const e = await entryOf(m, 'legacy.txt');
    assert.equal(e?.state, 'unverified');
    assert.match(String(e?.note), /branch intent can't be read/);
    await call(m, 'sync', {});
    assert.equal(env.store.treeGet(TREE, 'legacy.txt'), null, 'not taken back in from disk');

    await call(m, 'sync', { path: 'work/legacy.txt' }); // the operator's word: take disk's state
    assert.equal(await stateOf(m, 'legacy.txt'), 'synced');
    assert.equal(await contentOf(m, 'legacy.txt'), 'old');
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

  test('asked on one branch, adopts nothing on another selected before its turn', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.store.switchBranch('other');
    await call(m, 'write', { path: 'work/a.txt', content: "other's draft" });
    env.store.switchBranch(main);
    env.writeDisk('a.txt', 'from the shell');

    // Asked on main, queued behind a turn the mount is busy with.
    const mount = (m as any).mounts.get('work');
    let release!: () => void;
    let busy!: Promise<void>;
    await new Promise<void>((started) => {
      busy = (m as any).withMount(mount, () => new Promise<void>((r) => { release = r; started(); }));
    });
    const syncing = call(m, 'sync', { path: 'work/a.txt' });
    env.store.switchBranch('other');
    release();
    await busy;
    const data = await syncing;
    assert.match(JSON.stringify(data.incomplete), /the selected branch changed before this sync ran/);
    assert.deepEqual(data.results, []);
    assert.equal(await contentOf(m, 'a.txt'), "other's draft", "other's draft is untouched");
    env.store.switchBranch(main);
    assert.equal(await contentOf(m, 'a.txt'), 'v1', 'and main took nothing either');
  });

  test("lists a deletion it gives up for a disk copy the workspace can't hold, though no workspace entry changes", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'text');
    await call(m, 'delete', { path: 'work/a.txt' });
    env.writeDisk('a.txt', ONE_PX_PNG); // binary: never stored
    const data = await call(m, 'sync', { path: 'work/a.txt' });
    assert.deepEqual(data.results, [{ mount: 'work', synced: [], conflicts: [], discarded: [{ path: 'a.txt', was: 'conflict' }] }],
      'the workspace deletion (a conflict once disk changed) is given up, with no op: the workspace copy was already gone');
    assert.equal(await stateOf(m, 'a.txt'), 'disk-only');
  });
});

describe('a sync says what it passed over (agent-framework #276)', () => {
  test('a sync without a path counts what the mount ignores, by mount and reason', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['*.md', 'node_modules'] });
    env.writeDisk('LOG.md', 'an append-heavy log\n');
    env.writeDisk('node_modules/a/index.js', 'one');
    env.writeDisk('node_modules/b/index.js', 'two');
    env.writeDisk('kept.txt', 'taken in');

    const data = await call(m, 'sync', {});
    assert.equal(data.totalSynced, 1, 'only kept.txt is looked at');
    assert.deepEqual(data.passedOver, [{ mount: 'work', reason: 'ignored by the mount', count: 2 }],
      'LOG.md and node_modules, the directory counted once');
    assert.equal(data.ignored, undefined, 'nothing was named, so nothing is listed as ignored');

    const quiet = await call(m, 'sync', {});
    assert.equal(quiet.totalSynced, 0);
    assert.deepEqual(quiet.passedOver, [{ mount: 'work', reason: 'ignored by the mount', count: 2 }],
      'a 0 still says what it did not look at');
  });

  test('a symlink the mount follows was looked at, so it is not counted as passed over', async (t) => {
    const env = new Env(t);
    const m = await env.open({ followSymlinks: true });
    env.writeDisk('real.txt', 'the target');
    symlinkSync(env.disk('real.txt'), env.disk('link.txt'));

    const data = await call(m, 'sync', {});
    assert.equal(data.totalSynced, 2, 'the link is followed and taken in, beside its target');
    assert.equal(data.passedOver, undefined);
  });

  test("a named directory the ignore list covers is synced, its contents included", async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['build/**'] });
    env.writeDisk('build/out.txt', 'built');
    env.writeDisk('build/sub/deep.txt', 'deeper');

    const bare = await call(m, 'sync', {});
    assert.equal(bare.totalSynced, 0);
    assert.deepEqual(bare.passedOver, [{ mount: 'work', reason: 'ignored by the mount', count: 1 }]);

    const named = await call(m, 'sync', { path: 'work/build' });
    assert.equal(named.totalSynced, 2, 'both files beneath the named directory');
    assert.equal(await contentOf(m, 'build/sub/deep.txt'), 'deeper');
    assert.deepEqual(named.ignored, [{ mount: 'work', path: 'build',
      note: "this mount's ignore list covers it, so a sync without a path won't maintain it" }]);
    assert.equal(named.passedOver, undefined, 'nothing beneath the named directory was passed over');
  });

  test('naming an ignored directory sets aside only the patterns that cover it: one that covers something inside it still applies', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['build/**', '*.md'] });
    env.writeDisk('build/out.txt', 'built');
    env.writeDisk('build/LOG.md', 'log');

    const named = await call(m, 'sync', { path: 'work/build' });
    assert.equal(named.totalSynced, 1, 'out.txt only');
    assert.equal(await contentOf(m, 'build/out.txt'), 'built');
    assert.equal(env.store.treeGet('workspace/work/tree', 'build/LOG.md'), null, 'LOG.md stays untracked');
    assert.deepEqual(named.ignored.map(({ path }: { path: string }) => path), ['build']);
    assert.deepEqual(named.passedOver, [{ mount: 'work', reason: 'ignored by the mount', count: 1 }], 'LOG.md was passed over');
  });

  test('a listing of a directory the ignore list covers keeps the ignore, and tracks nothing beneath it', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['build/**'] });
    env.writeDisk('build/sub/a.txt', 'ignored');
    const listed = await call(m, 'ls', { path: 'work/build/sub', recursive: true });
    assert.ok(!(listed.entries as Entry[]).some((e) => e.path === 'build/sub/a.txt' && e.state === 'synced'),
      `the file isn't listed as tracked: ${JSON.stringify(listed.entries)}`);
    assert.equal(env.store.treeGet(TREE, 'build/sub/a.txt'), null, 'nothing beneath the ignored directory is tracked');
    const globbed = await call(m, 'glob', { pattern: 'work/build/**' });
    assert.equal(env.store.treeGet(TREE, 'build/sub/a.txt'), null, `nor after a glob: ${JSON.stringify(globbed)}`);
  });

  test('a symlink is reported by path, not counted as passed over: not followed, or a link to a directory', async (t) => {
    const env = new Env(t);
    const plain = await env.open();
    env.writeDisk('real.txt', 'the target');
    symlinkSync(env.disk('real.txt'), env.disk('link.txt'));
    const notFollowed = await call(plain, 'sync', {});
    assert.equal(notFollowed.passedOver, undefined);
    assert.ok((notFollowed.skipped as Array<{ path: string; reason: string }>).some((s) => s.path === 'link.txt'),
      `the link is listed under skipped, got ${JSON.stringify(notFollowed.skipped)}`);

    const env2 = new Env(t);
    const following = await env2.open({ followSymlinks: true });
    env2.writeDisk('dir/inside.txt', 'in a directory');
    symlinkSync(env2.disk('dir'), env2.disk('dirlink'));
    const followed = await call(following, 'sync', {});
    assert.equal(followed.passedOver, undefined);
    const skip = (followed.skipped as Array<{ path: string; reason: string }>).find((s) => s.path === 'dirlink');
    assert.match(String(skip?.reason), /a symlink to a directory, not walked/);
  });

  test('an ignored region hides only what lies beneath it, not a sibling sharing its name prefix', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['build', 'build2'] });
    env.writeDisk('build2/kept.txt', 'tracked, beneath the ignored build2');
    env.writeDisk('build/out.txt', 'ignored, and never tracked');
    await call(m, 'sync', { path: 'work/build2/kept.txt' }); // named, so tracked
    const bare = await call(m, 'sync', {});
    assert.deepEqual((bare.incomplete as Array<{ path: string }>).map((r) => r.path), ['build2'],
      'build2 hides a tracked path');
    assert.deepEqual(bare.passedOver, [{ mount: 'work', reason: 'ignored by the mount', count: 1 }],
      'build hides nothing tracked: build2/kept.txt is not beneath it, though it shares the name prefix');
  });

  test('a path the mount ignores is taken when named, and the result says a bare sync will not maintain it', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['*.md', 'vendor'] });
    env.writeDisk('LOG.md', 'an append-heavy log\n');
    env.writeDisk('vendor/lib/notes.txt', 'beneath an ignored directory');

    const named = await call(m, 'sync', { path: 'work/LOG.md' });
    assert.equal(named.totalSynced, 1);
    assert.deepEqual(named.ignored, [{ mount: 'work', path: 'LOG.md',
      note: "this mount's ignore list covers it, so a sync without a path won't maintain it" }]);
    assert.equal(await contentOf(m, 'LOG.md'), 'an append-heavy log\n');

    const nested = await call(m, 'sync', { path: 'work/vendor/lib/notes.txt' });
    assert.equal(nested.totalSynced, 1);
    assert.deepEqual(nested.ignored?.map((i: { path: string }) => i.path), ['vendor/lib/notes.txt'],
      'covered through the directory above it, which the list names');

    env.writeDisk('plain.txt', 'not ignored');
    const control = await call(m, 'sync', { path: 'work/plain.txt' });
    assert.equal(control.totalSynced, 1);
    assert.equal(control.ignored, undefined, 'a path the ignore list does not cover gets no note');

    // Now tracked, both ignored regions hide something the workspace holds:
    // a bare sync reports them under `incomplete`, and never counts them too.
    const bare = await call(m, 'sync', {});
    const regions = (bare.incomplete as Array<{ mount: string; path: string; reason: string }>)
      .filter((r) => r.reason === 'ignored by the mount').map((r) => r.path).sort();
    assert.deepEqual(regions, ['LOG.md', 'vendor']);
    assert.equal(bare.passedOver, undefined, 'a region reported as incomplete is not also passed over');
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

  test("this branch agreeing with disk leaves another branch's pending adoption for that branch to resolve", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.writeDisk('a.txt', 'B');
    m = await env.fault(m, 'sync', 'after-intent'); // main's adoption of B, pending
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending');

    env.store.switchBranch('other');
    await call(m, 'write', { path: 'work/a.txt', content: 'B' });
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'other agrees with disk');
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending', "and leaves main's adoption pending");

    env.store.switchBranch(main);
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'main resolves its own adoption');
    assert.equal(await contentOf(m, 'a.txt'), 'B');
  });

  test('an adoption intended over a pending one carries the evidence that settled it, so a crash before it lands redoes it', async (t) => {
    const env = new Env(t);
    let m = await pendingAdoption(env); // S = A, an adoption of B pending
    env.writeDisk('a.txt', 'C');
    m = await env.fault(m, 'sync', 'after-intent'); // settles B's (S is A) and intends C
    const p = (m as any).agreement.get('work', 'a.txt');
    assert.equal(p.kind, 'pending');
    assert.deepEqual(p.prior && { kind: p.prior.kind, hash: p.prior.hash }, { kind: 'content', hash: sha('A') },
      "its prior is A, as the settled adoption left it, not the pending record's");
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'from A, the adoption of C is redone');
    assert.equal(await contentOf(m, 'a.txt'), 'C');
  });

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

  test('an append that fails inside the store leaves no decision to stale evidence: passes refuse until a reopen, which finds the evidence', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'A' });
    await call(m, 'materialize', { path: 'work/a.txt' });
    const main = env.store.currentBranch().name;
    env.store.createBranch('draft-c', main);
    env.store.switchBranch('draft-c');
    await call(m, 'write', { path: 'work/a.txt', content: 'C' });
    env.store.switchBranch(main);
    await call(m, 'write', { path: 'work/a.txt', content: 'B' });
    env.writeDisk('a.txt', 'B');

    // The pass that agrees at B appends that evidence, and the append throws
    // after it landed, as Chronicle's does when the log's periodic sync fails.
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const store = env.store as unknown as { appendJson: (type: string, payload: any) => unknown };
    const append = store.appendJson;
    let fired = false;
    store.appendJson = function (this: unknown, type: string, payload: any) {
      const record = append.call(this, type, payload);
      if (!fired && type === 'workspace/disk-agreement' && payload.t === 'set' && payload.value?.hash === sha('B')) {
        fired = true;
        throw new Error('injected: the append landed, then the store failed');
      }
      return record;
    };
    try {
      assert.match(await refused(m, 'ls', { path: 'work', recursive: true }), /injected: the append landed/);
    } finally {
      store.appendJson = append;
    }
    assert.equal(fired, true);

    // Its evidence would still say A, so the draft branch's listing would read
    // C against A on disk B as both-changed and record a sticky conflict. It
    // refuses instead, and records nothing.
    env.store.switchBranch('draft-c');
    assert.match(await refused(m, 'ls', { path: 'work', recursive: true }), /evidence is unavailable until the store is reopened/);
    assert.match(await refused(m, 'materialize', { path: 'work/a.txt' }), /evidence is unavailable until the store is reopened/);
    const intents = (m as unknown as { intents: Map<string, { get(path: string): { conflict?: unknown } | undefined }> }).intents;
    assert.equal(intents.get('work')!.get('a.txt')?.conflict, undefined, 'no conflict was recorded');

    // Reopened, the store has the evidence at B, and the draft is a draft.
    m = await env.restart(m);
    env.store.switchBranch('draft-c');
    const entry = (await call(m, 'ls', { path: 'work', recursive: true })).entries.find((e: { path: string }) => e.path === 'a.txt');
    assert.equal(entry.state, 'workspace-draft');
    assert.equal(readFileSync(join(env.dir, 'a.txt'), 'utf8'), 'B', 'disk is untouched');
  });

  test('a checkpoint check after an ambiguous append reconciles first, like every entry point', (t) => {
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
    const journal = (agreement as unknown as { journal: { needsReconcile: boolean } }).journal;
    assert.equal(journal.needsReconcile, true);
    agreement.maybeCheckpoint();
    assert.equal(journal.needsReconcile, false, 'read back before deciding whether to checkpoint');
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

  test("a push whose root is replaced while it observes records nothing it saw there", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'A' });
    await call(m, 'materialize', { path: 'work/a.txt' });
    await call(m, 'write', { path: 'work/a.txt', content: 'C' });
    const agreement = (m as any).agreement;
    const agreed = agreement.get('work', 'a.txt');
    const rootReal = realpathSync(env.dir);
    const away = `${env.dir}-away`;
    const mount = (m as any).mounts.get('work');
    const runtime = await (m as any).runtime(mount);
    let replaced = false;
    // Once the push has checked the root, it's replaced by one holding the
    // workspace's draft, which the push then observes.
    const pushed = await withFsPromises('lstat', (lstat) => async (path: unknown, ...rest: unknown[]) => {
      if (!replaced && (String(path) === join(env.dir, 'a.txt') || String(path) === join(rootReal, 'a.txt'))) {
        replaced = true;
        renameSync(env.dir, away);
        mkdirSync(env.dir);
        writeFileSync(join(env.dir, 'a.txt'), 'C');
      }
      return lstat(path, ...rest);
    }, () => pushPaths(env.store, agreement, runtime, ['a.txt'], {}));
    assert.equal(replaced, true);
    assert.deepEqual(pushed.written, []);
    assert.match(JSON.stringify(pushed.skipped), /not the directory disk last agreed with/);
    assert.deepEqual(agreement.get('work', 'a.txt'), agreed, "the replacement's copy isn't recorded as agreed");
    assert.equal(readFileSync(join(away, 'a.txt'), 'utf8'), 'A');
  });

  test('a push whose write is refused untouched puts back the evidence its own planning settled, not the stale intent', async (t) => {
    if (IS_ROOT) return t.skip('root writes through file permissions');
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'A' });
    await call(m, 'materialize', { path: 'work/a.txt' });
    await call(m, 'write', { path: 'work/a.txt', content: 'C' });
    const agreement = (m as any).agreement;
    const agreed = agreement.get('work', 'a.txt');
    // An earlier push of C announced its write and stopped before the effect:
    // disk still holds A, which this push's planning resolves the intent to.
    agreement.intend('work', 'a.txt', {
      effect: 'disk', prior: agreed, expect: { kind: 'content', hash: sha('C') }, branchId: env.store.currentBranch().id,
    }, { durable: true });
    assert.equal(agreement.get('work', 'a.txt').kind, 'pending');
    const mount = (m as any).mounts.get('work');
    const runtime = await (m as any).runtime(mount);
    let pushed;
    try {
      pushed = await pushPaths(env.store, agreement, runtime, ['a.txt'], {
        beforeEffect: () => chmodSync(env.disk('a.txt'), 0o444),
      });
    } finally {
      chmodSync(env.disk('a.txt'), 0o644);
    }
    assert.deepEqual(pushed.written, []);
    assert.match(JSON.stringify(pushed.skipped), /not written/);
    const now = agreement.get('work', 'a.txt');
    assert.equal(now.kind, 'content', `the resolved evidence, not the stale intent: ${JSON.stringify(now)}`);
    assert.equal(now.hash, agreed.hash);
    assert.equal(env.readDisk('a.txt'), 'A');
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

  test("#169's saved baselines aren't evidence: an empty mountpoint at the next start deletes nothing, and agreement records what disk still holds", async (t) => {
    // A store that ran #169: entries with no disk-agreement evidence, and the
    // stop-time baselines it saved in module state, which name no root.
    const env = new Env(t);
    await env.shutdown(await env.open()); // the mount's tree state exists, as #169 left it
    env.store = JsStore.openOrCreate({ path: env.storePath });
    env.legacyEntry('a.txt', 'alpha');
    env.legacyEntry('b.txt', 'beta');
    const saved = { mounts: { work: { lastMaterializedSeq: 1, materializedHashes: { 'a.txt': sha('alpha'), 'b.txt': sha('beta') }, refusedPaths: [] } } };

    // The drive isn't mounted yet: its mountpoint is an empty directory.
    const m = await env.openRestarted(saved);
    const listed = await listing(m);
    for (const path of ['a.txt', 'b.txt']) {
      assert.equal(listed.get(path)?.state, 'disk-missing-provenance-unknown', `${path} is kept, not adopted as a deletion`);
    }
    assert.equal(await contentOf(m, 'a.txt'), 'alpha');
    assert.equal(await contentOf(m, 'b.txt'), 'beta');

    // The drive comes back: what disk agrees with is recorded, root first.
    env.writeDisk('a.txt', 'alpha');
    env.writeDisk('b.txt', 'beta, edited in the shell');
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
    assert.equal((await entryOf(m, 'b.txt'))?.conflict?.kind, 'unknown-provenance', 'a differing copy is a conflict, never adopted from a baseline');
    assert.equal(await contentOf(m, 'b.txt'), 'beta');
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

    const respelled = new DiskAgreement(env.store);
    respelled.open([{ name: 'work', root: '/srv/work/' }]);
    assert.deepEqual(respelled.get('work', 'f1.txt'), { kind: 'content', hash: 'h1', size: 1 }, 'the same path spelled with a trailing slash keeps its evidence');

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

  test('the ctime trust gate takes exactly the listed filesystems, and only on Linux', async (t) => {
    for (const trusted of [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0xf2f52010, 0x2fc12fc1, 0x794c7630]) {
      assert.equal(fsTypeTrustsCtime(trusted), true, trusted.toString(16));
    }
    // NFS, FUSE, SMB2 and 9p maintain no ctime it can trust.
    for (const untrusted of [0x6969, 0x65735546, 0xfe534d42, 0x01021997]) {
      assert.equal(fsTypeTrustsCtime(untrusted), false, untrusted.toString(16));
    }
    assert.equal(fsTypeTrustsCtime(BigInt(0xef53)), true, 'a bigint f_type reads the same');
    const env = new Env(t);
    const expected = process.platform === 'linux' && fsTypeTrustsCtime((await statfs(env.dir)).type);
    assert.equal(await filesystemTrustsCtime(env.dir), expected);
  });

  // The racy window itself is pinned by fingerprintVouches' unit assertions
  // above: reaching it here would take a write that leaves mtime and ctime
  // unchanged, which no restore can do, since ctime can't be set.
  test('no restored timestamp hides a change: utimes, cp -p, and a write right after a hash', async (t) => {
    const env = new Env(t);
    const m = await env.open();
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

    env.writeDisk('f.txt', 'dddd'); // just after the last hash
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(await contentOf(m, 'f.txt'), 'dddd');
  });
});

describe('trust and identity at the point of use', () => {
  /** A view of `dir` as the effects and reads take one. */
  const viewOf = (dir: string, extra: Partial<MountView> = {}): MountView =>
    ({ root: dir, followSymlinks: false, maxFileSize: 1 << 20, ignore: [], ...extra }) as MountView;

  test('a fingerprint vouches only for a file on the filesystem whose ctime was checked', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'f.txt', 'aaaa');
    env.writeDisk('f.txt', 'bbbb'); // same size: only a read tells
    const st = statSync(env.disk('f.txt'), { bigint: true });
    const fp = { size: 4, mtimeNs: st.mtimeNs.toString(), ctimeNs: st.ctimeNs.toString(), ino: st.ino.toString(), dev: st.dev.toString() };
    const newest = Number((st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs) / 1_000_000n);
    // Evidence whose fingerprint matches the file as it is now, with the old
    // bytes' hash: only a fingerprint that vouches would keep it.
    (m as any).agreement.set('work', 'f.txt', { kind: 'content', hash: sha('aaaa'), size: 4, fp: { ...fp, hashedAt: newest + 5_000 } });
    const rootReal = realpathSync(env.dir);
    (m as any).ctimeTrust.set(rootReal, st.dev.toString()); // the file's own filesystem was checked
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(await contentOf(m, 'f.txt'), 'aaaa', 'vouched for, so not read');
    (m as any).ctimeTrust.set(rootReal, (st.dev + 1n).toString()); // another device's filesystem was
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(await contentOf(m, 'f.txt'), 'bbbb', 'a file on a filesystem never checked is read, and the change adopted');
  });

  test('a recheck of an unchanged file records nothing', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'f.txt', 'aaaa');
    (m as any).ctimeTrust.set(realpathSync(env.dir), statSync(env.disk('f.txt'), { bigint: true }).dev.toString());
    const old = new Date(Date.now() - 60_000);
    utimesSync(env.disk('f.txt'), old, old);
    await sleep(2100); // past the racy window of the ctime that utimes set
    await call(m, 'sync', {}); // a full recheck rehashes, and records the fingerprint the stamps changed
    const agreement = (m as any).agreement;
    const set = agreement.set.bind(agreement);
    let appended = 0;
    agreement.set = (...args: unknown[]) => { appended++; return set(...args); };
    try {
      await call(m, 'sync', {});
      await call(m, 'sync', {});
    } finally {
      agreement.set = set;
    }
    assert.equal(appended, 0, 'the same file, the same stamps: nothing to re-record');
  });

  test('an unlink never removes a file put at its path after the one it hashed', async (t) => {
    const env = new Env(t);
    env.writeDisk('a.txt', 'old');
    const target = env.disk('a.txt');
    const rootReal = realpathSync(env.dir);
    let replaced = false;
    const err = await withFsPromises('open', (original) => async (...args: any[]) => {
      const handle = await original(...args);
      if (!replaced && args[0] === join(rootReal, 'a.txt')) {
        replaced = true; // after the hash's descriptor opened: a new file takes the name
        writeFileSync(join(env.root, 'swap'), 'new');
        renameSync(join(env.root, 'swap'), target);
      }
      return handle;
    }, () => unlinkContained(viewOf(env.dir), rootReal, 'a.txt', { kind: 'content', hash: sha('old') }).then(() => null, (e) => e));
    assert.ok(replaced, 'the swap ran');
    assert.ok(err instanceof EffectFailed, `refused: ${err}`);
    assert.equal(readFileSync(target, 'utf8'), 'new', 'the file now at the path is untouched');
  });

  test('an unlink refused outright touched nothing, so its evidence goes back at once', { skip: IS_ROOT ? 'root unlinks anywhere' : false }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'locked/a.txt', 'v1');
    await call(m, 'delete', { path: 'work/locked/a.txt' });
    chmodSync(env.disk('locked'), 0o555);
    let data;
    try {
      data = await call(m, 'materialize', { applyDeletions: true });
    } finally {
      chmodSync(env.disk('locked'), 0o755);
    }
    assert.match(JSON.stringify(data), /not unlinked: could not unlink the file/, `reported as untouched: ${JSON.stringify(data)}`);
    assert.equal((m as any).agreement.get('work', 'locked/a.txt').kind, 'content', 'the evidence is as it was, not pending');
    assert.equal(env.readDisk('locked/a.txt'), 'v1');
  });

  test('a FIFO swapped in at a path neither blocks a read nor a write', { skip: process.platform === 'win32' ? 'no FIFOs' : false }, async (t) => {
    const env = new Env(t);
    const rootReal = realpathSync(env.dir);
    const swapIn = (path: string) => {
      rmSync(path);
      assert.equal(spawnSync('mkfifo', [path]).status, 0, 'mkfifo');
    };
    const bounded = <T>(what: string, run: Promise<T>) => Promise.race([
      run,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} blocked on the FIFO`)), 3000)),
    ]);
    for (const how of ['read', 'write'] as const) {
      env.writeDisk(`${how}.txt`, 'regular');
      const path = join(rootReal, `${how}.txt`);
      // The read opens the path under the view's root as given; where the
      // temp directory is reached through a symlink (macOS's /var), that
      // isn't the real path.
      const named = join(env.dir, `${how}.txt`);
      let swapped = false;
      const outcome = await withFsPromises('open', (original) => async (...args: any[]) => {
        if (!swapped && (args[0] === path || args[0] === named)) {
          swapped = true; // between any lstat and this open
          swapIn(path);
        }
        return original(...args);
      }, () => bounded(how, how === 'read'
        ? readPath(viewOf(env.dir), rootReal, 'read.txt', 1 << 20)
        : writeContained(viewOf(env.dir), rootReal, 'write.txt', Buffer.from('x'), { kind: 'any' }).then(() => 'written', (e) => e)));
      assert.ok(swapped, `${how}: the swap ran`);
      if (how === 'read') assert.deepEqual(outcome, { kind: 'unobserved', reason: 'not a regular file' });
      else assert.ok(outcome instanceof EffectFailed && /not a regular file/.test(outcome.message), `write refused: ${outcome}`);
    }
  });

  // A fractional limit, too, which allows the whole bytes in it.
  for (const limit of [1024, 1024.5]) {
    test(`a file within the size limit (${limit}) at its fstat that grows past it before the read is hashed as oversize, not loaded whole`, async (t) => {
      const env = new Env(t);
      const rootReal = realpathSync(env.dir);
      env.writeDisk('grow.txt', 'a'.repeat(100));
      const path = env.disk('grow.txt');
      const read = await changedAfterFstat(path, () => appendFileSync(path, 'b'.repeat(4000)),
        () => readPath(viewOf(env.dir), rootReal, 'grow.txt', limit));
      assert.equal(read.kind, 'read');
      if (read.kind !== 'read') return;
      assert.equal(read.bytes, null, 'over the limit as read, so not kept, and so not ingested');
      assert.equal(read.size, 4100, 'hashed to its end');
      assert.equal(read.hash, createHash('sha256').update('a'.repeat(100) + 'b'.repeat(4000)).digest('hex'));
      assert.equal(read.head.toString(), 'a'.repeat(100) + 'b'.repeat(4000), 'its head, as for any oversize file');
    });
  }

  test('a file that grows within the size limit after its fstat is read whole, as the read found it', async (t) => {
    const env = new Env(t);
    const rootReal = realpathSync(env.dir);
    env.writeDisk('grow.txt', 'a'.repeat(10));
    const path = env.disk('grow.txt');
    const grown = 'a'.repeat(10) + 'b'.repeat(200 * 1024);
    const read = await changedAfterFstat(path, () => appendFileSync(path, 'b'.repeat(200 * 1024)),
      () => readPath(viewOf(env.dir), rootReal, 'grow.txt', 1024 * 1024));
    assert.equal(read.kind, 'read');
    if (read.kind !== 'read') return;
    assert.equal(read.bytes?.toString(), grown, 'read on, in larger buffers, past the 10 bytes its fstat gave');
    assert.equal(read.size, grown.length);
    assert.equal(read.fp.size, grown.length, 'the fingerprint gives the size of the bytes hashed');
    assert.equal(read.hash, createHash('sha256').update(grown).digest('hex'));
  });

  /** A root identified as it is now, and a way to replace it: renamed away, with an empty `sub` in its place. */
  const replaceable = (env: Env) => {
    mkdirSync(env.disk('sub'), { recursive: true });
    const st = statSync(env.dir, { bigint: true });
    const view = viewOf(env.dir, { rootIdentity: { dev: st.dev.toString(), ino: st.ino.toString() } });
    const away = `${env.dir}-away`;
    const replace = () => {
      renameSync(env.dir, away);
      mkdirSync(join(env.dir, 'sub'), { recursive: true });
    };
    return { view, rootReal: realpathSync(env.dir), away, replace };
  };
  const isSub = (env: Env, rootReal: string, path: unknown) =>
    String(path) === join(env.dir, 'sub') || String(path) === join(rootReal, 'sub');

  test('a write whose root is replaced after it was checked, before its parent is found, writes nothing there', async (t) => {
    const env = new Env(t);
    const { view, rootReal, replace } = replaceable(env);
    let replaced = false;
    const err = await withFsPromises('realpath', (realpath) => async (path: unknown, ...rest: unknown[]) => {
      if (!replaced && isSub(env, rootReal, path)) {
        replaced = true;
        replace();
      }
      return realpath(path, ...rest);
    }, () => writeContained(view, rootReal, 'sub/a.txt', Buffer.from('content'), { kind: 'any' }).then(() => null, (e) => e));
    assert.equal(replaced, true);
    assert.ok(err instanceof EffectFailed && /not the directory disk last agreed with/.test(err.message), `refused, naming the root: ${err}`);
    const there = join(env.dir, 'sub/a.txt');
    assert.equal(existsSync(there) ? readFileSync(there, 'utf8') : '', '', 'no content reached the replacement');
  });

  test("an edit made while a forced write is checked isn't overwritten", async (t) => {
    const env = new Env(t);
    env.writeDisk('a.txt', 'before');
    const rootReal = realpathSync(env.dir);
    const target = join(rootReal, 'a.txt');
    let edited = false;
    const err = await withFsPromises('realpath', (realpath) => async (path: unknown, ...rest: unknown[]) => {
      if (!edited && String(path) === target) {
        edited = true;
        writeFileSync(target, 'before, and an edit');
      }
      return realpath(path, ...rest);
    }, () => writeContained(viewOf(env.dir), rootReal, 'a.txt', Buffer.from('overwrite'), { kind: 'any' }).then(() => null, (e) => e));
    assert.equal(edited, true);
    assert.ok(err instanceof EffectFailed && !err.touched, `refused untouched: ${err}`);
    assert.equal(readFileSync(target, 'utf8'), 'before, and an edit');
  });

  test("an edit made after a file was hashed for its unlink isn't deleted", async (t) => {
    const env = new Env(t);
    mkdirSync(env.disk('sub'), { recursive: true });
    env.writeDisk('sub/a.txt', 'old');
    const rootReal = realpathSync(env.dir);
    const target = join(rootReal, 'sub/a.txt');
    let subChecks = 0;
    let edited = false;
    // The parent is resolved once to find it and again to check it is still
    // there, which comes after the hash and before the unlink: the edit lands
    // in between.
    const err = await withFsPromises('realpath', (realpath) => async (path: unknown, ...rest: unknown[]) => {
      if (isSub(env, rootReal, path) && ++subChecks === 2) {
        edited = true;
        writeFileSync(target, 'old, edited');
      }
      return realpath(path, ...rest);
    }, () => unlinkContained(viewOf(env.dir), rootReal, 'sub/a.txt', { kind: 'content', hash: createHash('sha256').update('old').digest('hex') })
      .then(() => null, (e) => e));
    assert.equal(edited, true);
    assert.ok(err instanceof EffectFailed && !err.touched, `refused untouched: ${err}`);
    assert.equal(readFileSync(target, 'utf8'), 'old, edited');
  });

  test('a directory sync under a root replaced before the directory was found reports it, not a success', async (t) => {
    const env = new Env(t);
    const { view, rootReal, replace } = replaceable(env);
    let replaced = false;
    const failed = await withFsPromises('realpath', (realpath) => async (path: unknown, ...rest: unknown[]) => {
      if (!replaced && isSub(env, rootReal, path)) {
        replaced = true;
        replace();
      }
      return realpath(path, ...rest);
    }, () => syncDirectories(view, rootReal, ['sub']));
    assert.equal(replaced, true);
    assert.match(failed.get('sub') ?? '', /not the directory disk last agreed with/);
  });

  test("an effect under a replaced root acts on nothing, whatever its caller checked", async (t) => {
    const env = new Env(t);
    const rootReal = realpathSync(env.dir);
    const st = statSync(env.dir, { bigint: true });
    const view = viewOf(env.dir, { rootIdentity: { dev: st.dev.toString(), ino: st.ino.toString() } });
    renameSync(env.dir, join(env.root, 'unmounted'));
    mkdirSync(join(env.dir, 'sub'), { recursive: true }); // another directory where the drive was, with a same-named subdirectory
    const err = await writeContained(view, rootReal, 'sub/a.txt', Buffer.from('x'), { kind: 'absent' }).then(() => null, (e) => e);
    assert.ok(err instanceof EffectFailed, `refused: ${err}`);
    assert.equal(existsSync(join(env.dir, 'sub', 'a.txt')), false, 'nothing written in the replacement');
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

  test('a capped walk proves absent what a listing lacks, and leaves unverified what it did not take', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await seedSynced(env, m, f, f);
    env.rmDisk('c.txt');
    const mount = (m as any).mounts.get('work');
    const pass = await (m as any).withMount(mount, () =>
      (m as any).passUnlocked(mount, { kind: 'dir', dir: '', recursive: true }, { cap: 2 }));
    // The root's listing, read whole, has no c.txt: a deletion is seen
    // wherever the walk lists, whichever files it took.
    assert.equal(env.store.treeGet(TREE, 'c.txt'), null);
    // d.txt is there, past the cap: unverified by this pass, and kept.
    assert.equal(pass.reports.get('d.txt')?.state, 'unverified');
    assert.notEqual(env.store.treeGet(TREE, 'd.txt'), null);
    assert.ok(pass.incomplete.some((r: { reason: string }) => /walk cap \(2\) was reached/.test(r.reason)));
  });
});

describe('a mount larger than its walk cap (agent-framework #272)', () => {
  const syncedNames = (env: Env) => env.store.treeList(TREE).map((e) => e.path).sort();

  test('repeated bare syncs resume where the last stopped, so together they take the whole mount', async (t) => {
    const env = new Env(t);
    // Written out of order: the walk takes each directory's files by name,
    // then its subdirectories by name.
    for (const f of ['b/y.txt', 'z.txt', 'a.txt', 'b/x.txt', 'm.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });

    const first = await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'm.txt'], 'the first two in the walk order');
    assert.ok(first.incomplete.some((r: { reason: string }) => /walk cap \(2\) was reached.*resumes after work\/m\.txt/.test(r.reason)),
      JSON.stringify(first.incomplete));

    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b/x.txt', 'm.txt', 'z.txt'], 'the next two, after m.txt');

    // The last one, then the walk wraps to the start for the second: the
    // mount is covered, and a.txt is looked at again.
    env.writeDisk('a.txt', 'edited before the wrap');
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b/x.txt', 'b/y.txt', 'm.txt', 'z.txt']);
    assert.equal(await contentOf(m, 'a.txt'), 'edited before the wrap', 'the third sync wrapped to a.txt');
  });

  test('the walk takes files by name, whatever order they were written in', async (t) => {
    const env = new Env(t);
    // Neither the order written nor its reverse starts with the three
    // smallest names. Node's readdir already returns these names sorted on
    // Linux, so this pins the order where readdir doesn't sort them; the next
    // test is the one that fails on Linux if the walk stops sorting.
    for (const f of ['g.txt', 'c.txt', 'h.txt', 'a.txt', 'f.txt', 'b.txt', 'e.txt', 'd.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 3 });
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt']);
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']);
  });

  test('names that sort apart by UTF-8 byte and by UTF-16 code unit are each taken once: the walk visits files in the order it resumes by', async (t) => {
    const env = new Env(t);
    // U+FF21 comes before U+1F600 by UTF-8 byte, the order Node's readdir
    // returns on Linux, and after it by UTF-16 code unit, the walk's order.
    for (const f of ['b.txt', '\uFF21.txt', '\u{1F600}.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 1 });
    const taken: string[] = [];
    for (let i = 0; i < 3; i++) {
      const before = new Set(syncedNames(env));
      await call(m, 'sync', {});
      taken.push(...syncedNames(env).filter((n) => !before.has(n)));
    }
    assert.deepEqual(taken, ['b.txt', '\u{1F600}.txt', '\uFF21.txt']);
  });

  test('a disk edit past the cap reaches the workspace on a later bare sync', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['a.txt', 'b.txt', 'c.txt']) await seedSynced(env, m, f, f);
    env.writeDisk('c.txt', 'edited past the cap');
    await call(m, 'sync', {});
    await call(m, 'sync', {});
    assert.equal(await contentOf(m, 'c.txt'), 'edited past the cap');
  });

  test('a deletion in a directory larger than the cap is proven by a listing read whole', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['big/a.txt', 'big/b.txt', 'big/c.txt', 'big/d.txt', 'big/e.txt']) await seedSynced(env, m, f, f);
    env.rmDisk('big/e.txt');
    // The first bare sync takes a.txt and b.txt; big's listing lacks e.txt.
    await call(m, 'sync', {});
    assert.equal(env.store.treeGet(TREE, 'big/e.txt'), null);
    assert.notEqual(env.store.treeGet(TREE, 'big/d.txt'), null);
  });

  test('a listing, and an agent-action scan, prove a deletion in a directory larger than the cap too', async (t) => {
    for (const via of ['ls', 'agent-action'] as const) {
      const env = new Env(t);
      const m = await env.open({ walkCap: 2, ...(via === 'agent-action' ? { watch: 'on-agent-action' } : {}) });
      for (const f of ['big/a.txt', 'big/b.txt', 'big/c.txt', 'big/d.txt', 'big/e.txt']) await seedSynced(env, m, f, f);
      env.rmDisk('big/e.txt');
      // Each takes a.txt and b.txt; big's listing, read whole, lacks e.txt.
      if (via === 'ls') await call(m, 'ls', { path: 'work/big' });
      else await m.onToolBatchComplete('agent');
      assert.equal(env.store.treeGet(TREE, 'big/e.txt'), null, via);
      assert.notEqual(env.store.treeGet(TREE, 'big/d.txt'), null, via);
    }
  });

  test('a listing starts at its scope every time, and leaves no place behind', async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    const listed = async () => [...(await listing(m)).keys()].sort();
    assert.deepEqual(await listed(), ['a.txt', 'b.txt']);
    assert.deepEqual(await listed(), ['a.txt', 'b.txt'], 'the same files again');
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), undefined);
  });

  test('a directory sync resumes for its own scope', async (t) => {
    const env = new Env(t);
    for (const f of ['d/a.txt', 'd/b.txt', 'd/c.txt', 'top.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    const first = await call(m, 'sync', { path: 'work/d' });
    assert.deepEqual(syncedNames(env), ['d/a.txt', 'd/b.txt']);
    assert.ok(first.incomplete.some((r: { path: string; reason: string }) =>
      r.path === 'd' && r.reason === 'the walk cap (2) was reached: the next sync of this directory resumes after work/d/b.txt'),
      JSON.stringify(first.incomplete));
    await call(m, 'sync', { path: 'work/d' });
    assert.deepEqual(syncedNames(env), ['d/a.txt', 'd/b.txt', 'd/c.txt']);
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), undefined, 'the mount root keeps its own place');
  });

  test('the place survives a restart: the next bare sync resumes after it', async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) env.writeDisk(f, f);
    let m = await env.open({ walkCap: 2 });
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt']);
    m = await env.restart(m, { walkCap: 2 });
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt', 'd.txt'], 'c.txt and d.txt, not a.txt and b.txt again');
  });

  test('walkCap must be a positive integer, and the refusal names the value it was given', () => {
    const refused: Array<[unknown, string]> = [
      [0, '0'], [-1, '-1'], [1.5, '1.5'], [Number.POSITIVE_INFINITY, 'Infinity'], [Number.NaN, 'NaN'],
      [2 ** 53, '9007199254740992'], ['5000', '"5000"'], [10n, '10n'], [null, 'null'],
    ];
    for (const [walkCap, shown] of refused) {
      assert.throws(
        () => new WorkspaceModule({ mounts: [{ name: 'work', path: '/tmp', mode: 'read-write', walkCap: walkCap as number }] }),
        (err: Error) => err.message.startsWith('[workspace] Mount "work": walkCap must be a positive integer')
          && err.message.endsWith(`, not ${shown}`),
        `walkCap ${String(walkCap)}`,
      );
    }
    assert.doesNotThrow(() => new WorkspaceModule({ mounts: [{ name: 'work', path: '/tmp', mode: 'read-write', walkCap: 12_000 }] }));
  });

  test('a walk whose last file uses up the cap covered its scope: no place, nothing past the cap', async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    const synced = await call(m, 'sync', {});
    assert.equal(synced.incomplete, undefined, JSON.stringify(synced.incomplete));
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), undefined);
  });

  test('a resumed pass that takes every file reports nothing past the cap and clears its place', async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) env.writeDisk(f, f);
    let m = await env.open({ walkCap: 2 });
    await call(m, 'sync', {});
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), 'b.txt');
    // A larger cap: the pass resumes after b.txt, takes c.txt, wraps and
    // takes a.txt and b.txt, and stops short of the cap.
    m = await env.restart(m, { walkCap: 5 });
    const synced = await call(m, 'sync', {});
    assert.equal(synced.incomplete, undefined, JSON.stringify(synced.incomplete));
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), undefined);
  });

  test('directories before and after the place: the after stretch takes a later sibling, the wrap an earlier one', async (t) => {
    const env = new Env(t);
    for (const f of ['a/1.txt', 'a/2.txt', 'a/3.txt', 'm/1.txt', 'm/2.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a/1.txt', 'a/2.txt']);
    // After a/2.txt: a/3.txt, then m/, the sibling after a/.
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a/1.txt', 'a/2.txt', 'a/3.txt', 'm/1.txt']);
    // After m/1.txt: m/2.txt, then the wrap reaches a/, which lies before the place.
    env.writeDisk('a/1.txt', 'edited before the wrap');
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a/1.txt', 'a/2.txt', 'a/3.txt', 'm/1.txt', 'm/2.txt']);
    assert.equal(await contentOf(m, 'a/1.txt'), 'edited before the wrap');
  });

  test('once the cap is reached no further directory is listed, so a deletion there waits for a pass that lists it', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 1 });
    await seedSynced(env, m, 'z/q.txt', 'q');
    env.rmDisk('z/q.txt');
    for (const f of ['a.txt', 'b.txt']) env.writeDisk(f, f);
    const synced = await call(m, 'sync', {});
    assert.notEqual(env.store.treeGet(TREE, 'z/q.txt'), null, 'z/ was not listed: nothing proven');
    assert.ok(synced.incomplete.some((r: { mount: string; path: string; reason: string }) => r.mount === 'work' && r.path === 'z' && /not visited/.test(r.reason)),
      JSON.stringify(synced.incomplete));
  });

  test('the capped pass says once where the next resumes, and each unreached path gets the reason of the region nearest it', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 1 });
    await seedSynced(env, m, 'z/q.txt', 'q');
    for (const f of ['a.txt', 'b.txt']) env.writeDisk(f, f);
    const synced = await call(m, 'sync', {});
    const resumes = synced.incomplete.filter((r: { reason: string }) => /resumes after/.test(r.reason));
    assert.deepEqual(resumes.map((r: { mount: string; path: string; reason: string }) => [r.mount, r.path, r.reason]),
      [['work', '', 'the walk cap (1) was reached: the next sync of the mount resumes after work/a.txt']]);
    // z/q.txt sits beneath z/, which wasn't listed: its reason is z/'s, not
    // that of the root, which holds an untaken b.txt.
    const skipped = synced.skipped?.find((x: { path: string }) => x.path === 'z/q.txt');
    assert.match(skipped?.reason ?? '', /not visited: the walk cap \(1\) was reached/, JSON.stringify(synced.skipped));
  });

  test("the sync tool's description says how the walk takes turns", async (t) => {
    const env = new Env(t);
    const m = await env.open({});
    const sync = m.getTools().find((tool: { name: string }) => tool.name === 'sync');
    assert.ok(sync);
    assert.match(sync.description, /the next sync of the same mount or directory picks up where the last turn stopped/);
    assert.match(sync.description, /its own catch-up scan, at start and when its watcher reattaches, takes turns with its whole-mount syncs/);
  });

  test("a watched mount's capped sync names its catch-up scan as the other turn", async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 1 });
    // Read as a watched mount from here; opened unwatched, so no watcher runs.
    (m as any).mounts.get('work').config.watch = 'always';
    const synced = await call(m, 'sync', {});
    assert.ok(synced.incomplete.some((r: { path: string; reason: string }) => r.path === ''
      && r.reason === 'the walk cap (1) was reached: the next sync of the mount, or its catch-up scan if that comes first, resumes after work/a.txt'),
      JSON.stringify(synced.incomplete));
  });

  test("an agent-action scan takes the mount's start after every batch, and leaves the syncs' place alone", async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) env.writeDisk(f, f);
    const m = await env.open({ watch: 'on-agent-action', walkCap: 2 });
    const agreement = (m as any).agreementOrThrow();
    const stored = (p: string) => {
      const e = env.store.treeGet(TREE, p);
      return e ? env.store.getBlob(e.blobHash)?.toString('utf8') : null;
    };
    const capReports = () => env.events.filter((e) => e.type === 'workspace:agent-action-scan-incomplete').length;
    // What a shell tool did to the first file in the walk's order is in the
    // workspace after every batch, and each capped scan says where the cap
    // stopped it.
    for (const edit of ['edit one', 'edit number two', 'the third edit, longest']) {
      env.writeDisk('a.txt', edit);
      const reported = capReports();
      await m.onToolBatchComplete('agent');
      assert.equal(stored('a.txt'), edit);
      assert.equal(capReports(), reported + 1, 'the batch\'s scan reported its cap');
    }
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt'], 'the same two files every time');
    assert.equal(agreement.walkResumesAfter('work', ''), undefined, 'and no place');
    // A bare sync keeps its place, and a batch's scan between two syncs
    // doesn't move it.
    await call(m, 'sync', {});
    assert.equal(agreement.walkResumesAfter('work', ''), 'b.txt');
    await m.onToolBatchComplete('agent');
    assert.equal(agreement.walkResumesAfter('work', ''), 'b.txt');
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    // A file a shell tool deleted among them is gone after the batch.
    env.rmDisk('b.txt');
    await m.onToolBatchComplete('agent');
    assert.equal(stored('b.txt'), null);
  });

  test("a watched mount's catch-up scan resumes where the last stopped", async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    await (m as any).initialScan('work');
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt']);
    await (m as any).initialScan('work');
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  });

  test('glob and grep take the same files every time and leave no place', async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) env.writeDisk(f, 'v');
    const m = await env.open({ walkCap: 2 });
    const globbed = async () => (await call(m, 'glob', { pattern: '**' })).matches.map((x: { path: string }) => x.path).sort();
    const first = await globbed();
    assert.deepEqual(await globbed(), first);
    const grepped = async () => JSON.stringify(await call(m, 'grep', { pattern: 'v' }));
    const once = await grepped();
    assert.equal(await grepped(), once);
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), undefined);
  });

  test("a directory sync leaves the mount root's place as it was", async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd/x.txt', 'd/y.txt', 'd/z.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    await call(m, 'sync', {});
    const agreement = (m as any).agreementOrThrow();
    assert.equal(agreement.walkResumesAfter('work', ''), 'b.txt');
    await call(m, 'sync', { path: 'work/d' });
    await call(m, 'sync', { path: 'work/d' });
    assert.equal(agreement.walkResumesAfter('work', ''), 'b.txt');
  });

  test("a pass that can't list its scope's directory leaves the place as it was", { skip: IS_ROOT ? 'root reads every directory' : false }, async (t) => {
    const env = new Env(t);
    for (const f of ['d/a.txt', 'd/b.txt', 'd/c.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    await call(m, 'sync', { path: 'work/d' });
    const agreement = (m as any).agreementOrThrow();
    assert.equal(agreement.walkResumesAfter('work', 'd'), 'd/b.txt');
    chmodSync(env.disk('d'), 0o000);
    try {
      const blocked = await call(m, 'sync', { path: 'work/d' });
      assert.ok(blocked.incomplete?.some((r: { reason: string }) => /cannot list/.test(r.reason)), JSON.stringify(blocked));
      assert.equal(agreement.walkResumesAfter('work', 'd'), 'd/b.txt', 'the place stands');
    } finally {
      chmodSync(env.disk('d'), 0o755);
    }
    await call(m, 'sync', { path: 'work/d' });
    assert.ok(syncedNames(env).includes('d/c.txt'), 'the next pass resumed after d/b.txt');
  });

  test('a directory replaced between the two stretches of a resumed walk proves nothing absent from its old listing', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 3 });
    for (const f of ['s/a.txt', 's/b.txt', 's/c.txt', 's/z.txt', 't/x.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', {}); // takes s/a, s/b, s/c: the place is s/c.txt
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), 's/c.txt');
    env.rmDisk('s/z.txt');
    // The next pass lists s/ (without z.txt) on the after stretch, then t/.
    // While t/ is listed, s/ is replaced by a directory that holds z.txt, so
    // the wrap's second visit to s/ meets another directory.
    let swapped = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!swapped && String(path).endsWith(`${'/'}t`)) {
        swapped = true;
        renameSync(env.disk('s'), join(env.root, 's-away'));
        for (const f of ['a.txt', 'b.txt', 'c.txt', 'z.txt']) env.writeDisk(`s/${f}`, `s/${f}`);
      }
      return readdir(path, ...rest);
    }, async () => {
      const synced = await call(m, 'sync', {});
      assert.ok(synced.incomplete?.some((r: { mount: string; path: string; reason: string }) => r.mount === 'work' && r.path === 's' && /changed while the walk ran/.test(r.reason)),
        JSON.stringify(synced.incomplete));
      // The pass took one file of its three, t/x.txt: nothing it left is the cap's.
      assert.ok(!synced.incomplete.some((r: { reason: string }) => /walk cap/.test(r.reason)), JSON.stringify(synced.incomplete));
    });
    assert.ok(swapped);
    assert.notEqual(env.store.treeGet(TREE, 's/z.txt'), null, 's/z.txt is on disk in the new s/: not proven absent');
  });

  test("a directory sync's scope replaced between the two stretches proves nothing absent from its old listing", async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 3 });
    for (const f of ['d/a.txt', 'd/b.txt', 'd/c.txt', 'd/z.txt', 'd/t/x.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', { path: 'work/d' }); // takes d/a, d/b, d/c: the place is d/c.txt
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', 'd'), 'd/c.txt');
    env.rmDisk('d/z.txt');
    // The scope's own directory is replaced while the after stretch lists
    // d/t/, so the wrap comes back to another d/, which holds z.txt.
    let swapped = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!swapped && String(path).endsWith(`${'/'}d${'/'}t`)) {
        swapped = true;
        renameSync(env.disk('d'), join(env.root, 'd-away'));
        for (const f of ['a.txt', 'b.txt', 'c.txt', 'z.txt', 't/x.txt']) env.writeDisk(`d/${f}`, `d/${f}`);
      }
      return readdir(path, ...rest);
    }, async () => {
      const synced = await call(m, 'sync', { path: 'work/d' });
      assert.ok(synced.incomplete?.some((r: { path: string; reason: string }) => /changed while the walk ran/.test(r.reason) && /(^|\/)d$/.test(r.path)),
        JSON.stringify(synced.incomplete));
    });
    assert.ok(swapped);
    assert.notEqual(env.store.treeGet(TREE, 'd/z.txt'), null, 'd/z.txt is on disk in the new d/: not proven absent');
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', 'd'), 'd/c.txt', 'a pass whose scope changed under it leaves the place');
  });

  test('when a directory is replaced, the listings read beneath it before stop proving anything too', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 3 });
    for (const f of ['d/a.txt', 'd/b.txt', 'd/c.txt', 'd/t/k.txt', 'd/u/x.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', { path: 'work/d' }); // takes d/a, d/b, d/c: the place is d/c.txt
    env.rmDisk('d/t/k.txt');
    // The after stretch lists d/t/ (without k.txt), then d/ is replaced while
    // d/u/ is listed; the new d/t/ holds k.txt.
    let swapped = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!swapped && String(path).endsWith(`${'/'}d${'/'}u`)) {
        swapped = true;
        renameSync(env.disk('d'), join(env.root, 'd-away'));
        for (const f of ['a.txt', 'b.txt', 'c.txt', 't/k.txt', 'u/x.txt']) env.writeDisk(`d/${f}`, `d/${f}`);
      }
      return readdir(path, ...rest);
    }, () => call(m, 'sync', { path: 'work/d' }));
    assert.ok(swapped);
    assert.notEqual(env.store.treeGet(TREE, 'd/t/k.txt'), null, "d/t/'s listing came from the replaced d/: it proves nothing absent");
  });

  test("a replaced scope's subdirectory before the place isn't reported as the cap's", async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 3 });
    const files = ['d/a/f.txt', 'd/m/m1.txt', 'd/m/m2.txt', 'd/m/m3.txt', 'd/m/m4.txt', 'd/z/q.txt'];
    for (const f of files) await seedSynced(env, m, f, f);
    await call(m, 'sync', { path: 'work/d' }); // takes d/a/f, d/m/m1, d/m/m2: the place is d/m/m2.txt
    // The after stretch takes d/m/m3 and d/m/m4 (two of three), then lists
    // d/z/, while d/ is replaced; the wrap then meets another d/.
    let swapped = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!swapped && String(path).endsWith(`${'/'}d${'/'}z`)) {
        swapped = true;
        renameSync(env.disk('d'), join(env.root, 'd-away'));
        for (const f of files) env.writeDisk(f, f);
      }
      return readdir(path, ...rest);
    }, async () => {
      const synced = await call(m, 'sync', { path: 'work/d' });
      assert.ok(synced.incomplete?.some((r: { path: string; reason: string }) => /changed while the walk ran/.test(r.reason) && /(^|\/)d$/.test(r.path)),
        JSON.stringify(synced.incomplete));
      assert.ok(!synced.incomplete.some((r: { reason: string }) => /walk cap/.test(r.reason)), JSON.stringify(synced.incomplete));
    });
    assert.ok(swapped);
  });

  test('a subdirectory proven missing beneath a scope that is then replaced proves nothing absent', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 3 });
    const files = ['d/a.txt', 'd/b.txt', 'd/c.txt', 'd/k/x.txt', 'd/u/q.txt', 'd/z/y.txt'];
    for (const f of files) await seedSynced(env, m, f, f);
    await call(m, 'sync', { path: 'work/d' }); // takes d/a, d/b, d/c: the place is d/c.txt
    // While the after stretch lists d/k/, d/u/ is removed, so the walk proves
    // it missing; while it lists d/z/, d/ is replaced by a directory holding
    // every file again, u/q.txt included (as a delete-and-recreate would).
    let removed = false;
    let swapped = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!removed && String(path).endsWith(`${'/'}d${'/'}k`)) {
        removed = true;
        rmSync(env.disk('d/u'), { recursive: true, force: true });
      }
      if (!swapped && String(path).endsWith(`${'/'}d${'/'}z`)) {
        swapped = true;
        renameSync(env.disk('d'), join(env.root, 'd-away'));
        for (const f of files) env.writeDisk(f, f);
      }
      return readdir(path, ...rest);
    }, () => call(m, 'sync', { path: 'work/d' }));
    assert.ok(removed && swapped);
    assert.notEqual(env.store.treeGet(TREE, 'd/u/q.txt'), null, 'd/u/q.txt is on disk in the new d/: not proven absent');
  });

  test('a directory listed on the after stretch that is a symlink on the wrap proves nothing absent from its old listing', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 3 });
    for (const f of ['s/a.txt', 's/b.txt', 's/c.txt', 's/z.txt', 't/x.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', {}); // takes s/a, s/b, s/c: the place is s/c.txt
    env.rmDisk('s/z.txt');
    // While t/ is listed, s/ becomes a link to a directory that holds z.txt.
    // The wrap's check of s/ fails, so its listing from the after stretch
    // describes a directory that isn't there.
    let swapped = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!swapped && String(path).endsWith(`${'/'}t`)) {
        swapped = true;
        renameSync(env.disk('s'), join(env.root, 's-away'));
        writeFileSync(join(env.root, 's-away', 'z.txt'), 's/z.txt');
        symlinkSync(join(env.root, 's-away'), env.disk('s'));
      }
      return readdir(path, ...rest);
    }, () => call(m, 'sync', {}));
    assert.ok(swapped);
    assert.notEqual(env.store.treeGet(TREE, 's/z.txt'), null, "s/'s old listing proves nothing once s/ isn't that directory");
  });

  test('a directory proven missing on the after stretch and back by the wrap proves nothing absent', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['m/1.txt', 'm/2.txt', 'm/3.txt', 'z/q.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', {}); // takes m/1, m/2: the place is m/2.txt
    // The root's listing shows m/, which is gone by the time the after
    // stretch checks it, so the walk proves m/ missing; while it lists z/,
    // m/ comes back.
    let removed = false;
    let restored = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!removed && String(path) === realpathSync(env.dir)) {
        const listed = await readdir(path, ...rest);
        removed = true;
        rmSync(env.disk('m'), { recursive: true });
        return listed;
      }
      if (!restored && String(path).endsWith(`${'/'}z`)) {
        restored = true;
        for (const f of ['m/1.txt', 'm/2.txt', 'm/3.txt']) env.writeDisk(f, f);
      }
      return readdir(path, ...rest);
    }, () => call(m, 'sync', {}));
    assert.ok(removed && restored);
    // The wrap lists the m/ there now and takes m/1.txt from it.
    for (const f of ['m/1.txt', 'm/2.txt', 'm/3.txt']) assert.notEqual(env.store.treeGet(TREE, f), null, `${f} is on disk`);
  });

  test('a link takes a place under the cap as a file does, so a followed link past the cap is read on a later pass', async (t) => {
    const env = new Env(t);
    for (const f of ['zz/t1.txt', 'zz/t2.txt', 'zz/t3.txt']) env.writeDisk(f, `target ${f}`);
    env.writeDisk('a.txt', 'a');
    for (const n of ['1', '2', '3']) symlinkSync(env.disk(`zz/t${n}.txt`), env.disk(`l${n}`));
    const m = await env.open({ walkCap: 2, followSymlinks: true });
    // The root's entries in order: a.txt, l1, l2, l3; the cap takes a.txt and l1.
    const first = await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'l1'], JSON.stringify(first));
    assert.ok(first.incomplete.some((r: { path: string; reason: string }) => r.path === '' && /before everything here was taken/.test(r.reason)),
      JSON.stringify(first.incomplete));
    // Like a file past the cap, an untracked link the pass didn't take isn't reported by path.
    assert.ok(!(first.skipped ?? []).some((x: { path: string }) => x.path === 'l2' || x.path === 'l3'), JSON.stringify(first.skipped));
    await call(m, 'sync', {}); // l2 and l3: the place is l3
    assert.deepEqual(syncedNames(env), ['a.txt', 'l1', 'l2', 'l3']);
    // A tracked link the next pass doesn't take isn't read through either:
    // the third pass takes zz/t1.txt and zz/t2.txt, not l3.
    env.writeDisk('zz/t3.txt', 'changed behind l3');
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'l1', 'l2', 'l3', 'zz/t1.txt', 'zz/t2.txt'], 'the third pass took zz/t1.txt and zz/t2.txt');
    assert.equal(await contentOf(m, 'l3'), 'target zz/t3.txt');
  });

  test('a directory proven missing on the after stretch that is an in-mount link on the wrap proves nothing absent', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['m/1.txt', 'm/2.txt', 'm/3.txt', 'z/q.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', {}); // takes m/1, m/2: the place is m/2.txt
    // After the root is listed, m/ moves to m-away/ (in the mount), so the
    // after stretch proves m/ missing; while z/ is listed, m becomes a link
    // to m-away/, which holds all three files.
    let moved = false;
    let linked = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!moved && String(path) === realpathSync(env.dir)) {
        const listed = await readdir(path, ...rest);
        moved = true;
        renameSync(env.disk('m'), env.disk('m-away'));
        return listed;
      }
      if (!linked && String(path).endsWith(`${'/'}z`)) {
        linked = true;
        symlinkSync(env.disk('m-away'), env.disk('m'));
      }
      return readdir(path, ...rest);
    }, () => call(m, 'sync', {}));
    assert.ok(moved && linked);
    for (const f of ['m/1.txt', 'm/2.txt', 'm/3.txt']) assert.notEqual(env.store.treeGet(TREE, f), null, `${f} is on disk through the link m: not proven absent`);
  });

  test('a subdirectory proven missing on the after stretch stays missing when its parent is the same directory on the wrap', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['d/a.txt', 'd/b.txt', 'd/q/x.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', {}); // takes d/a, d/b: the place is d/b.txt; d/q is left
    env.rmDisk('d/a.txt'); // so the next pass takes one of its two
    // d/ is listed with q/ in it; q/ is gone by the time the after stretch
    // checks it, so the walk proves d/q missing. d/ itself is untouched.
    let removed = false;
    let synced: any;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!removed && String(path).endsWith(`${'/'}d`)) {
        const listed = await readdir(path, ...rest);
        removed = true;
        rmSync(env.disk('d/q'), { recursive: true });
        return listed;
      }
      return readdir(path, ...rest);
    }, async () => {
      synced = await call(m, 'sync', {});
    });
    assert.ok(removed);
    assert.ok(!(synced.incomplete ?? []).some((r: { reason: string }) => /walk cap/.test(r.reason)), `the pass took one of its two: ${JSON.stringify(synced.incomplete)}`);
    assert.equal(env.store.treeGet(TREE, 'd/q/x.txt'), null, 'd/q was proven missing: d/q/x.txt is gone from disk');
  });

  test('a tracked link the cap leaves is unverified for the cap, as a tracked file is, and listed under incomplete only by its directory', async (t) => {
    const env = new Env(t);
    for (const f of ['zz/t1.txt', 'zz/t2.txt', 'zz/t3.txt']) env.writeDisk(f, `target ${f}`);
    env.writeDisk('a.txt', 'a');
    for (const n of ['1', '2', '3']) symlinkSync(env.disk(`zz/t${n}.txt`), env.disk(`l${n}`));
    const m = await env.open({ walkCap: 2, followSymlinks: true });
    await call(m, 'sync', {}); // a.txt, l1
    await call(m, 'sync', {}); // l2, l3: the place is l3
    const third = await call(m, 'sync', {}); // zz/t1.txt, zz/t2.txt
    for (const p of ['a.txt', 'l1', 'l2', 'l3']) {
      const reason = (third.skipped ?? []).find((x: { path: string }) => x.path === p)?.reason;
      assert.match(reason ?? '', /walk cap \(2\) was reached/, `${p}: ${reason}`);
    }
    assert.ok(!(third.incomplete ?? []).some((r: { path: string }) => ['l1', 'l2', 'l3'].includes(r.path)), JSON.stringify(third.incomplete));
  });

  test("a replaced directory's untaken links and ignored names are no longer counted, as the cap's or as passed over", async (t) => {
    const env = new Env(t);
    for (const f of ['s/a.txt', 's/b.txt', 's/c.txt', 's/x.log', 't/x.txt']) env.writeDisk(f, f);
    symlinkSync(env.disk('t/x.txt'), env.disk('s/aa-link'));
    const m = await env.open({ walkCap: 3, ignore: ['*.log'] });
    await call(m, 'sync', {}); // s/a.txt, s/aa-link, s/b.txt: the place is s/b.txt
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), 's/b.txt');
    // The after stretch takes s/c.txt and lists t/, while s/ is replaced; the
    // wrap then meets another s/, so the old listing's a.txt, aa-link and
    // x.log (ignored) describe nothing there.
    let swapped = false;
    let synced: any;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!swapped && String(path).endsWith(`${'/'}t`)) {
        swapped = true;
        renameSync(env.disk('s'), join(env.root, 's-away'));
        for (const f of ['s/a.txt', 's/b.txt', 's/c.txt']) env.writeDisk(f, f);
      }
      return readdir(path, ...rest);
    }, async () => {
      synced = await call(m, 'sync', {});
    });
    assert.ok(swapped);
    assert.ok(synced.incomplete.some((r: { path: string; reason: string }) => r.path === 's' && /changed while the walk ran/.test(r.reason)), JSON.stringify(synced.incomplete));
    // The pass took two entries of its three: nothing is the cap's.
    assert.ok(!synced.incomplete.some((r: { reason: string }) => /walk cap/.test(r.reason)), JSON.stringify(synced.incomplete));
    assert.equal(synced.passedOver, undefined, JSON.stringify(synced.passedOver));
  });

  test('a directory gone when the after stretch lists it, and back by the wrap, is listed afresh there', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['m/1.txt', 'm/2.txt', 'm/3.txt', 'z/q.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', {}); // takes m/1, m/2: the place is m/2.txt
    // m/ is there when it's checked and gone when it's listed, so the after
    // stretch proves it missing; while z/ is listed, it comes back, with an
    // edit to m/1.txt the wrap takes.
    let removed = false;
    let restored = false;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (!removed && String(path).endsWith(`${'/'}m`)) {
        removed = true;
        rmSync(env.disk('m'), { recursive: true });
      }
      if (!restored && String(path).endsWith(`${'/'}z`)) {
        restored = true;
        env.writeDisk('m/1.txt', 'm/1.txt edited while it was gone');
        for (const f of ['m/2.txt', 'm/3.txt']) env.writeDisk(f, f);
      }
      return readdir(path, ...rest);
    }, () => call(m, 'sync', {}));
    assert.ok(removed && restored);
    assert.equal(await contentOf(m, 'm/1.txt'), 'm/1.txt edited while it was gone');
  });

  test('a directory sync whose own directory is gone when the after stretch lists it, and another by the wrap, proves nothing absent', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['d/1.txt', 'd/2.txt', 'd/3.txt']) await seedSynced(env, m, f, f);
    await call(m, 'sync', { path: 'work/d' }); // takes d/1, d/2: the place is d/2.txt
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', 'd'), 'd/2.txt');
    // d/ is there when the walk checks it and gone when the after stretch
    // lists it, so the walk proves it missing; by the wrap's listing another
    // d/ holds the same three files.
    let calls = 0;
    let synced: any;
    await withFsPromises('readdir', (readdir) => async (path: string, ...rest: unknown[]) => {
      if (String(path).endsWith(`${'/'}d`)) {
        calls++;
        if (calls === 1) renameSync(env.disk('d'), join(env.root, 'd-away'));
        if (calls === 2) for (const f of ['d/1.txt', 'd/2.txt', 'd/3.txt']) env.writeDisk(f, f);
      }
      return readdir(path, ...rest);
    }, async () => {
      synced = await call(m, 'sync', { path: 'work/d' });
    });
    assert.ok(calls >= 2, 'the wrap listed d/ again');
    for (const f of ['d/1.txt', 'd/2.txt', 'd/3.txt']) assert.notEqual(env.store.treeGet(TREE, f), null, `${f} is on disk in the new d/: not proven absent`);
    assert.ok(synced.incomplete.some((r: { path: string; reason: string }) => r.path === 'd' && /changed while the walk ran/.test(r.reason)), JSON.stringify(synced.incomplete));
  });

  test('an accepted new root starts with no place', async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    await call(m, 'sync', {});
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), 'b.txt');
    // Another directory takes the root's place, holding the same files.
    renameSync(env.dir, `${env.dir}-away`);
    mkdirSync(env.dir);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) env.writeDisk(f, f);
    await call(m, 'sync', { mount: 'work', acceptRoot: true });
    // From the new root's start: a.txt and b.txt. Resuming after the old
    // place would have taken c.txt, then a.txt.
    assert.equal(env.store.treeGet(TREE, 'c.txt'), null, 'c.txt not taken');
    assert.equal((m as any).agreementOrThrow().walkResumesAfter('work', ''), 'b.txt');
  });

  test('a pass that records only a place binds no root, so a replaced root is read as it is', async (t) => {
    const env = new Env(t);
    // A file too large to take in: the passes record no evidence for it.
    env.writeDisk('a.txt', 'more than one byte');
    const m = await env.open({ walkCap: 1, maxFileSize: 1 });
    const agreement = (m as any).agreementOrThrow();
    await call(m, 'sync', {});
    assert.equal(agreement.walkResumesAfter('work', ''), undefined, 'the walk covered the mount');
    assert.equal(agreement.rootIdentity('work'), undefined, 'and bound no root');
    env.writeDisk('b.txt', 'more than one byte');
    await call(m, 'sync', {});
    assert.equal(agreement.walkResumesAfter('work', ''), 'a.txt', 'a capped walk keeps its place');
    assert.equal(agreement.rootIdentity('work'), undefined, 'and binds no root either');
    // Another directory takes the root's place. With no evidence to guard,
    // the mount reads it as it is, and the walk takes its turn after the
    // place there.
    renameSync(env.dir, `${env.dir}-away`);
    mkdirSync(env.dir);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) env.writeDisk(f, 'more than one byte');
    const synced = await call(m, 'sync', {});
    assert.ok(!synced.incomplete.some((r: { reason: string }) => /disk last agreed with/.test(r.reason)), JSON.stringify(synced.incomplete));
    assert.equal(agreement.walkResumesAfter('work', ''), 'b.txt');
  });

  test("a whole mount's catch-up scan takes turns with its bare syncs", async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    await call(m, 'sync', {});
    await (m as any).initialScan('work');
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt', 'd.txt'], 'the scan took the next two');
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'], 'and the sync the two after those');
  });

  test('a pass that moves only its place makes no store sync', async (t) => {
    const env = new Env(t);
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) env.writeDisk(f, f);
    const m = await env.open({ walkCap: 2 });
    // Without ctime trust no fingerprint vouches, so no pass re-records one
    // once the files are older than the racy window, however slowly this
    // runs: what's left to record is the place alone.
    (m as any).ctimeTrust.set(realpathSync(env.dir), null);
    await call(m, 'sync', {});
    await call(m, 'sync', {});
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    const agreement = (m as any).agreementOrThrow();
    const sync = env.store.sync.bind(env.store);
    let syncs = 0;
    env.store.sync = () => {
      syncs++;
      return sync();
    };
    // Nothing on disk changes from here, so each pass records only where it
    // stopped: a place that's lost costs coverage, never a decision.
    const places: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) {
      await call(m, 'sync', {});
      places.push(agreement.walkResumesAfter('work', ''));
    }
    assert.deepEqual(places, ['b.txt', 'd.txt', 'b.txt', 'd.txt'], 'the place moved on every pass');
    assert.equal(syncs, 0, 'with no store sync');
  });

  test('a model of the walk: on random trees that change between passes, each pass takes the cyclic window after its place', async (t) => {
    const env = new Env(t);
    const rootReal = realpathSync(env.dir);
    const view = { root: env.dir, followSymlinks: false, maxFileSize: 1 << 20, ignore: [] } as unknown as MountView;
    // A seeded generator, so a failure replays.
    let seed = 272;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    // U+FF21 sorts before U+1F600 by UTF-8 byte and after it by UTF-16 code
    // unit, the walk's order; U+E000 sorts before both by UTF-8 byte and
    // between them by UTF-16 code unit.
    const names = ['a', 'b', 'm', 'z', '\uFF21', '\u{1F600}', '\uE000'];
    const pick = <T>(xs: T[]): T => xs[rand(xs.length)]!;
    const randomPath = (): string => {
      const parts: string[] = [];
      for (let depth = rand(3); depth > 0; depth--) parts.push(pick(names));
      return [...parts, `${pick(names)}.${rand(4) === 0 ? 'lnk' : 'txt'}`].join('/');
    };
    const add = (path: string): void => {
      const full = env.disk(path);
      mkdirSync(dirname(full), { recursive: true });
      if (lstatSync(full, { throwIfNoEntry: false })) return;
      if (path.endsWith('.lnk')) symlinkSync('nowhere', full); // dangling: an entry that isn't a file
      else writeFileSync(full, path);
    };
    /** Every entry that isn't a directory, as readdir shows it now. */
    const entries = (dir = ''): string[] => {
      const out: string[] = [];
      for (const d of readdirSync(env.disk(dir), { withFileTypes: true })) {
        const path = dir ? `${dir}/${d.name}` : d.name;
        if (d.isDirectory()) out.push(...entries(path));
        else out.push(path);
      }
      return out;
    };
    // The walk's order, worked out independently: in each directory, its
    // entries that aren't directories by name, then its subdirectories by
    // name, each with everything beneath it.
    const order = (a: string, b: string): number => {
      const pa = a.split('/');
      const pb = b.split('/');
      for (let i = 0; ; i++) {
        const leafA = i === pa.length - 1;
        const leafB = i === pb.length - 1;
        if (leafA !== leafB) return leafA ? -1 : 1;
        if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
        if (leafA) return 0;
      }
    };

    for (let tree = 0; tree < 25; tree++) {
      rmSync(env.dir, { recursive: true, force: true });
      mkdirSync(env.dir);
      for (let i = 4 + rand(16); i > 0; i--) add(randomPath());
      const cap = 1 + rand(8);
      let place: string | undefined;
      for (let pass = 0; pass < 12; pass++) {
        // Changes between passes: entries added, removed, the place itself
        // removed, and whole directories removed.
        for (let change = rand(4); change > 0; change--) {
          const now = entries();
          const kind = rand(4);
          if (kind === 0 || now.length === 0) add(randomPath());
          else if (kind === 1) rmSync(env.disk(pick(now)));
          else if (kind === 2 && place !== undefined && now.includes(place)) rmSync(env.disk(place));
          else {
            const dirs = now.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')));
            if (dirs.length > 0) rmSync(env.disk(pick(dirs)), { recursive: true, force: true });
          }
        }
        const all = entries().sort(order);
        const after = place === undefined ? [] : all.filter((p) => order(p, place!) > 0);
        const upto = place === undefined ? all : all.filter((p) => order(p, place!) <= 0);
        const window = [...after, ...upto].slice(0, cap);
        const walk = await walkScope(view, rootReal, '', true, cap, place === undefined ? {} : { resumeAfter: place });
        const taken = [...walk.files, ...walk.othersTaken];
        const where = `tree ${tree}, pass ${pass}, cap ${cap}, after ${place}`;
        assert.deepEqual(taken.sort(order), [...window].sort(order), `${where}: took the cyclic window`);
        for (const p of all) assert.equal(provenAbsent(walk, p), false, `${where}: ${p} is on disk`);
        if (walk.stoppedAfter !== undefined) assert.equal(walk.stoppedAfter, window.at(-1), `${where}: the place is the last entry taken`);
        else assert.ok(all.length <= cap, `${where}: no place only once the walk took everything`);
        place = walk.stoppedAfter;
      }
    }
  });

  test('places go through a checkpoint, and a scope a walk covered stays cleared', (t) => {
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store);
    agreement.open([{ name: 'work', root: env.dir }]);
    agreement.recordWalk('work', '', 'x.txt');
    agreement.recordWalk('work', 'd', 'd/y.txt');
    agreement.recordWalk('work', 'e', 'e/z.txt');
    agreement.recordWalk('work', 'e', null);
    for (let i = 0; i < 1100; i++) agreement.set('work', `f${i}.txt`, { kind: 'absent' });
    agreement.maybeCheckpoint();
    assert.equal((agreement as any).journal.entriesSinceCheckpoint, 0, 'a checkpoint was written');
    agreement.barrier();
    const reopened = new DiskAgreement(env.store);
    reopened.open([{ name: 'work', root: env.dir }]);
    assert.equal(reopened.walkResumesAfter('work', ''), 'x.txt');
    assert.equal(reopened.walkResumesAfter('work', 'd'), 'd/y.txt');
    assert.equal(reopened.walkResumesAfter('work', 'e'), undefined);
  });

  test("a place's journal entry carries no path, and an entry of a kind this version doesn't know changes nothing", (t) => {
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store);
    agreement.open([{ name: 'work', root: env.dir }]);
    agreement.set('work', 'a.txt', { kind: 'absent' });
    agreement.recordWalk('work', '', 'a.txt');
    agreement.barrier();
    // agent-framework 0.22 replays an entry it doesn't know as a forget of
    // entry.path: a place with a path would forget that path's evidence.
    const journal = new RecordJournal<Record<string, unknown>, unknown>(env.store, { type: DISK_AGREEMENT_RECORD_TYPE });
    const walks = journal.load().entries.map(({ entry }) => entry).filter((e) => e.t === 'walk');
    assert.equal(walks.length, 1);
    assert.equal('path' in walks[0]!, false, JSON.stringify(walks[0]));
    // A later version's entry this one doesn't know leaves the evidence alone.
    journal.append({ t: 'a-later-kind', mount: 'work', path: 'a.txt' });
    const reopened = new DiskAgreement(env.store);
    reopened.open([{ name: 'work', root: env.dir }]);
    assert.deepEqual(reopened.get('work', 'a.txt'), { kind: 'absent' });
    assert.equal(reopened.walkResumesAfter('work', ''), 'a.txt');
  });
});

describe('the mount boundary', () => {
  test('a root replaced during an absence proof proves nothing: the replacement lacks what the original still holds', async (t) => {
    const env = new Env(t);
    mkdirSync(env.disk('sub'), { recursive: true });
    env.writeDisk('sub/a.txt', 'A');
    const st = statSync(env.dir, { bigint: true });
    const view = { root: env.dir, rootIdentity: { dev: String(st.dev), ino: String(st.ino) }, followSymlinks: false, maxFileSize: 1e6, ignore: [] } as unknown as MountView;
    const away = `${env.dir}-away`;
    // The code checks the root by its resolved path (on macOS the temp
    // directory is under /var, a symlink to /private/var).
    const rootReal = realpathSync(env.dir);
    let swapped = false;
    // Once the root has been checked, it's renamed away and an empty one put
    // in its place, with the same subdirectory.
    const proof = await withFsPromises('lstat', (lstat) => async (path: string, ...rest: unknown[]) => {
      const info = await lstat(path, ...rest);
      if (!swapped && String(path) === rootReal) {
        swapped = true;
        renameSync(env.dir, away);
        mkdirSync(join(env.dir, 'sub'), { recursive: true });
      }
      return info;
    }, () => confirmAbsent(view, rootReal, 'sub/a.txt'));
    assert.equal(swapped, true);
    assert.equal(typeof proof, 'string', `no absence is proven: ${JSON.stringify(proof)}`);
    assert.equal(readFileSync(join(away, 'sub/a.txt'), 'utf8'), 'A', 'the original still holds the file');
  });

  test('a root replaced after a walk listed it decides nothing: no deletion is taken from the replacement', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a/f.txt', content: 'F' });
    await call(m, 'materialize', { path: 'work/a/f.txt' });
    const rootReal = realpathSync(env.dir);
    const away = `${env.dir}-away`;
    let replaced = false;
    // Once the walk has listed the root, the root is replaced by one whose
    // `a` is empty: the walk then lists the replacement's `a`.
    const result = await withFsPromises('readdir', (readdir) => async (path: unknown, ...rest: unknown[]) => {
      const entries = await readdir(path, ...rest);
      if (!replaced && String(path) === rootReal) {
        replaced = true;
        renameSync(env.dir, away);
        mkdirSync(join(env.dir, 'a'), { recursive: true });
      }
      return entries;
    }, () => call(m, 'sync', {}));
    assert.equal(replaced, true);
    assert.notEqual(env.store.treeGet('workspace/work/tree', 'a/f.txt'), null, 'the workspace keeps the file');
    assert.notEqual((m as unknown as { agreement: DiskAgreement }).agreement.get('work', 'a/f.txt')?.kind, 'absent');
    assert.match(JSON.stringify(result), /not the directory disk last agreed with/);
    assert.equal(readFileSync(join(away, 'a/f.txt'), 'utf8'), 'F');
  });

  test('a root replaced during a pass takes no deletion: the entry and its evidence stay', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/sub/a.txt', content: 'A' });
    await call(m, 'materialize', { path: 'work/sub/a.txt' });
    const file = env.disk('sub/a.txt');
    const away = `${env.dir}-away`;
    // The pass observes paths under the root's resolved path (on macOS the
    // temp directory is under /var, a symlink to /private/var).
    const rootReal = realpathSync(env.dir);
    const fileReal = join(rootReal, 'sub/a.txt');
    unlinkSync(file);
    let restored = false;
    let swapped = false;
    // The pass finds the file gone, then it's put back, and the root is
    // replaced by one whose subdirectory lacks it before absence is proven.
    await withFsPromises('lstat', (lstat) => async (path: string, ...rest: unknown[]) => {
      let info;
      try {
        info = await lstat(path, ...rest);
      } catch (err) {
        if (!restored && String(path) === fileReal && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          writeFileSync(file, 'A');
          restored = true;
        }
        throw err;
      }
      if (restored && !swapped && String(path) === rootReal) {
        renameSync(env.dir, away);
        mkdirSync(join(env.dir, 'sub'), { recursive: true });
        swapped = true;
      }
      return info;
    }, () => {
      // The pass a watcher's change to that path runs.
      const internals = m as unknown as { mounts: Map<string, unknown>; passUnlocked(mount: unknown, scope: unknown): Promise<unknown> };
      return internals.passUnlocked(internals.mounts.get('work'), { kind: 'paths', paths: ['sub/a.txt'] });
    });
    assert.equal(restored, true);
    assert.equal(swapped, true);
    assert.notEqual(env.store.treeGet('workspace/work/tree', 'sub/a.txt'), null, 'the workspace keeps the file');
    assert.notEqual((m as unknown as { agreement: DiskAgreement }).agreement.get('work', 'sub/a.txt')?.kind, 'absent');
    assert.equal(readFileSync(join(away, 'sub/a.txt'), 'utf8'), 'A');
  });

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
    assert.match(pushed.skipped[0]!.reason, /^not written: something appeared at this path since it was checked$/);
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

  test("a forced push of a stale path whose workspace copy is missing from the store says so", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', 'v2, from the shell'); // S = P, D changed: a forced push would overwrite it
    await env.shutdown(m);
    rmSync(join(env.storePath, 'blobs', sha('v1').slice(0, 2), sha('v1'))); // the store lost the workspace copy
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open();
    const data = await call(m, 'materialize', { path: 'work/a.txt', force: true });
    assert.match(JSON.stringify(data), /the workspace copy is missing from the store/, `reported, not dropped: ${JSON.stringify(data)}`);
    assert.equal(env.readDisk('a.txt'), 'v2, from the shell');
  });

  test("an interrupted path's refusal says what disk may hold, and that force writes the workspace copy", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
    m = await env.fault(m, 'materialize', 'after-intent');
    env.writeDisk('a.txt', 'v2, cut off'); // neither what was being written nor what disk agreed with
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.kind, 'interrupted');
    const data = await call(m, 'materialize', {});
    const skip = JSON.stringify(data);
    assert.match(skip, /match neither what was being written there nor what disk last agreed with/);
    assert.match(skip, /pass force to write the workspace copy over it/);
    assert.equal(env.readDisk('a.txt'), 'v2, cut off');
    await call(m, 'materialize', { force: true });
    assert.equal(env.readDisk('a.txt'), 'v2');
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

describe('grep, when the branch or the store changes under it', () => {
  test("a pass whose branch is no longer selected isn't read with another branch's content: grep runs it again, then gives up", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'needle on main');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    env.store.switchBranch('other');
    await call(m, 'write', { path: 'work/a.txt', content: 'needle on other' });
    env.store.switchBranch(main);
    // Every pass is followed by a switch to the other branch before grep
    // reads the tree that goes with it.
    const internals = m as unknown as { passUnlocked: (...args: unknown[]) => Promise<unknown> };
    const real = internals.passUnlocked.bind(m);
    internals.passUnlocked = async (...args: unknown[]) => {
      const result = await real(...args);
      env.store.switchBranch(env.store.currentBranch().name === main ? 'other' : main);
      return result;
    };
    const data = await call(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(data.results, [], JSON.stringify(data.results));
    assert.match(JSON.stringify(data.incomplete), /the selected branch kept changing while grep ran/);
  });

  test("a version missing from the store is listed as not searched, not taken for no match", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'conflict.txt', 'nothing');
    env.writeDisk('conflict.txt', 'needle on disk');
    await call(m, 'write', { path: 'work/conflict.txt', content: 'needle in the workspace' });
    const listed = (await call(m, 'ls', { path: 'work' })).entries.find((e: { name: string }) => e.name === 'conflict.txt');
    assert.equal(listed?.conflict?.diskCopy, 'stored');
    // Both stored versions go missing.
    const store = env.store as unknown as { getBlob: (hash: string) => Buffer | null };
    const getBlob = store.getBlob.bind(env.store);
    const gone = new Set([sha('needle on disk'), sha('needle in the workspace')]);
    store.getBlob = (hash: string) => (gone.has(hash) ? null : getBlob(hash));
    const data = await call(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(data.results, []);
    const reasons = (data.skipped ?? []).map((x: { reason: string }) => x.reason).join('\n');
    assert.match(reasons, /the workspace copy is missing from the store/);
    assert.match(reasons, /the disk version recorded with the conflict is missing from the store/);
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

  test('batches that come while a scan waits share it: one runs, at most one waits', async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 5_000 });
    const mod = m as any;
    const mount = mod.mounts.get('work');
    let passes = 0;
    const pass = mod.passUnlocked.bind(mod);
    mod.passUnlocked = (...args: unknown[]) => { passes++; return pass(...args); };
    const held = mod.withMount(mount, () => sleep(200)); // another pass holds the mount
    env.writeDisk('a.txt', 'from the batches');
    await Promise.all([m.onToolBatchComplete('agent'), m.onToolBatchComplete('agent'), m.onToolBatchComplete('agent')]);
    await held;
    assert.equal(passes, 1, 'three batches, one scan');
    assert.notEqual(env.store.treeGet(TREE, 'a.txt'), null);
    assert.equal((await call(m, 'status', {})).work.lastAgentActionScan.withinDeadline, true);
  });

  test("while a scan runs past its deadline, a later batch isn't held, and its scan comes after", async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 50 });
    const mod = m as any;
    const mount = mod.mounts.get('work');
    let passes = 0;
    const pass = mod.passUnlocked.bind(mod);
    mod.passUnlocked = (...args: unknown[]) => { passes++; return pass(...args); };
    const held = mod.withMount(mount, () => sleep(400));

    await m.onToolBatchComplete('agent'); // held to its deadline
    env.writeDisk('later.txt', 'from the second batch');
    const started = Date.now();
    await m.onToolBatchComplete('agent');
    assert.ok(Date.now() - started < 40, 'the second batch was not held');
    let scan = (await call(m, 'status', {})).work.lastAgentActionScan;
    assert.match(scan.reason, /an earlier scan is still running past its deadline/);

    await held;
    await mod.mountTurns.get('work');
    assert.equal(passes, 1, 'the second batch shared the scan still waiting');
    assert.notEqual(env.store.treeGet(TREE, 'later.txt'), null, "the second batch's change was scanned");
    // The late scan is over (its bookkeeping settles a few ticks after the
    // mount's turn), so the next batch is held for its own scan again, which
    // may itself miss 50 ms on a loaded machine: that's its own miss.
    await new Promise((resolve) => setImmediate(resolve));
    await m.onToolBatchComplete('agent');
    scan = (await call(m, 'status', {})).work.lastAgentActionScan;
    assert.doesNotMatch(scan.reason ?? '', /an earlier scan is still running/);
  });

  test("a scan queued behind a late one puts its own outcome on status, which the late one's doesn't overwrite", async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 50 });
    const mod = m as any;
    // Stand-ins for the two scans' passes: the first runs, then waits to be
    // released, and each says a different region couldn't be observed.
    const pass = mod.passUnlocked.bind(mod);
    const gates = [0, 1].map(() => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve; }); return { open, shut }; });
    let passes = 0;
    mod.passUnlocked = async (...args: unknown[]) => {
      const n = ++passes;
      const result = await pass(...args);
      await gates[n - 1]!.shut;
      return { ...result, incomplete: [{ path: n === 1 ? 'FIRST' : 'SECOND', reason: 'stand-in' }] };
    };
    const events: Array<{ type: string; incomplete?: Array<{ path: string }> }> = [];
    mod.ctx = { ...mod.ctx, pushEvent: (e: { type: string }) => { events.push(e); } };
    // A failed assertion mustn't leave a scan waiting on its gate: the
    // module's stop at cleanup would wait for it.
    try {
      await m.onToolBatchComplete('agent'); // its scan starts, and runs past the deadline
      await m.onToolBatchComplete('agent'); // not held: its own scan is queued behind the first
      const status = async () => (await call(m, 'status', {})).work.lastAgentActionScan;
      assert.match((await status()).reason, /an earlier scan is still running past its deadline/);
      gates[0]!.open();
      for (let i = 0; i < 100 && passes < 2; i++) await sleep(10);
      await new Promise((resolve) => setImmediate(resolve));
      // The first scan is done and the second runs: the first's outcome is not
      // the second batch's.
      assert.match((await status()).reason, /an earlier scan is still running past its deadline/, "the older scan doesn't speak for the newer batch");
      gates[1]!.open();
      await mod.mountTurns.get('work');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(passes, 2, 'the second batch had a scan of its own');
      const last = await status();
      assert.equal(last.complete, true);
      assert.equal(last.withinDeadline, false, 'its batch was never held for it');
      assert.deepEqual(last.incomplete?.map((r: { path: string }) => r.path), ['SECOND'], JSON.stringify(last));
      const regions = events.flatMap((e) => (e.incomplete ?? []).map((r) => r.path));
      assert.deepEqual(regions.sort(), ['FIRST', 'SECOND'], 'each scan still reports its regions as an event');
    } finally {
      for (const gate of gates) gate.open();
    }
  });

  test("a batch that comes while a late scan's successor still runs isn't held either", async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 300 });
    const mod = m as any;
    // Each scan's pass runs, then waits to be released.
    const pass = mod.passUnlocked.bind(mod);
    const gates = [0, 1, 2].map(() => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve; }); return { open, shut }; });
    let passes = 0;
    mod.passUnlocked = async (...args: unknown[]) => {
      const n = ++passes;
      const result = await pass(...args);
      await gates[n - 1]!.shut;
      return result;
    };
    try {
      await m.onToolBatchComplete('agent'); // its scan runs past the deadline
      await m.onToolBatchComplete('agent'); // not held: its scan is queued behind the first, late from the start
      gates[0]!.open(); // the first scan finishes, and the second starts
      for (let i = 0; i < 100 && passes < 2; i++) await sleep(10);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(passes, 2, 'the second scan runs');
      const started = Date.now();
      await m.onToolBatchComplete('agent'); // while the late second scan still runs
      const held = Date.now() - started;
      assert.ok(held < 150, `the third batch was not held (${held} ms, deadline 300 ms)`);
      assert.match((await call(m, 'status', {})).work.lastAgentActionScan.reason, /an earlier scan is still running past its deadline/);
    } finally {
      for (const gate of gates) gate.open();
    }
  });

  test("a scan deadline within 1 s of the framework's hook bound is lowered below it, with a warning", async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 60_000 });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      assert.equal((m as any).agentActionScanDeadlineMs(), TOOL_BATCH_HOOK_TIMEOUT_MS - 1_000);
      assert.equal((m as any).agentActionScanDeadlineMs(), TOOL_BATCH_HOOK_TIMEOUT_MS - 1_000);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.filter((w) => w.includes('agentActionScanDeadlineMs 60000')).length, 1, 'warned once');
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

    // The root check locates the root and reads its identity (lstat of its real path).
    const fsp = createRequire(import.meta.url)('node:fs/promises') as { lstat: (...args: unknown[]) => Promise<unknown> };
    const lstat = fsp.lstat;
    const rootReal = realpathSync(env.dir);
    let first = true;
    fsp.lstat = async function (path: unknown, ...rest: unknown[]) {
      const result = await lstat(path, ...rest);
      if (first && path === rootReal) {
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
      fsp.lstat = lstat;
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
  test("a materialize between initStore and start keeps its pin: the saved one, older, isn't applied over it", async (t) => {
    const env = new Env(t);
    const first = await env.open();
    await call(first, 'write', { path: 'work/a.txt', content: 'A' });
    await call(first, 'materialize', { path: 'work/a.txt' });
    let saved: unknown;
    (first as any).ctx.setState = (state: unknown) => { saved = state; };
    await env.shutdown(first);
    env.store = JsStore.openOrCreate({ path: env.storePath });
    // The next process materializes before its start, then starts as a restart.
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: env.dir, mode: 'read-write', watch: 'never' }] });
    m.initStore(env.store);
    await call(m, 'write', { path: 'work/b.txt', content: 'B' });
    await call(m, 'materialize', { path: 'work/b.txt' });
    const mount = (m as any).mounts.get('work');
    const pinned = { seq: mount.lastMaterializedSeq, branch: mount.lastMaterializedBranchId };
    assert.notEqual(pinned.seq, (saved as { mounts: { work: { lastMaterializedSeq: number } } }).mounts.work.lastMaterializedSeq);
    await m.start({ isRestart: true, getState: () => saved, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    (env as any).live.push(m);
    assert.deepEqual({ seq: mount.lastMaterializedSeq, branch: mount.lastMaterializedBranchId }, pinned);
  });

  test('the module takes no work after it has stopped and saved its pins, until it starts again', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a.txt', content: 'A' });
    let saved: { mounts: Record<string, { lastMaterializedSeq: number }> } | undefined;
    (m as any).ctx.setState = (state: typeof saved) => { saved = state; };
    await m.stop();
    // After stop has saved the pins and watermarks, nothing more changes them.
    const after = await m.handleToolCall({ id: 't', name: 'materialize', input: { path: 'work/a.txt' } });
    assert.equal(after.success, false);
    assert.match(String(after.error), /has stopped/);
    assert.equal(existsSync(env.disk('a.txt')), false, 'nothing was written after the stop');
    assert.equal((await m.writeBinary('work/late.bin', Buffer.from('x'), 'application/octet-stream')).success, false);
    assert.deepEqual(await m.readBinary('work/a.txt'), { error: 'The workspace has stopped: it takes no more work until it starts again' });
    assert.deepEqual(await m.materializeMount('work'), []);
    assert.equal(existsSync(env.disk('a.txt')), false);
    assert.ok(saved, 'stop saved its state');
    // Started again, it takes work again.
    await m.start({ isRestart: true, getState: () => saved, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    await call(m, 'materialize', { path: 'work/a.txt' });
    assert.equal(env.readDisk('a.txt'), 'A');
  });

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

describe('a named mount, and a path the workspace and disk hold differently', () => {
  test("status reports the mount it's asked about, and a materialize of a read-only mount says it wrote nothing there", async (t) => {
    const env = new Env(t);
    const second = join(env.root, 'second');
    mkdirSync(second);
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never' },
      { name: 'second', path: second, mode: 'read-only', watch: 'never' },
    ] } as Partial<WorkspaceConfig>);
    const status = await call(m, 'status', { mount: 'work' });
    assert.deepEqual(Object.keys(status.mounts ?? status), ['work'], JSON.stringify(status));
    assert.match(await refused(m, 'status', { mount: 'nowhere' }), /Unknown mount: nowhere/);
    const done = await call(m, 'materialize', { mount: 'second' });
    assert.equal(done.count, 0);
    assert.match(JSON.stringify(done.skipped), /a read-only mount: materialize writes nothing to it/);
  });

  test('a path sync takes in a file disk has where the workspace holds a directory, and drops what was beneath', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'd/x.txt', 'x');
    rmSync(env.disk('d'), { recursive: true });
    env.writeDisk('d', 'now a file');
    const data = await call(m, 'sync', { path: 'work/d' });
    assert.equal(env.store.treeGet('workspace/work/tree', 'd/x.txt'), null, 'what was beneath is gone');
    const entry = env.store.treeGet('workspace/work/tree', 'd');
    assert.ok(entry, `the file is taken in: ${JSON.stringify(data)}`);
    assert.equal(env.store.getBlob(entry!.blobHash)?.toString('utf8'), 'now a file');
  });

  test("a path sync where disk has a directory over a workspace file takes in what's beneath, and says the file wasn't checked", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'f', 'a file');
    rmSync(env.disk('f'));
    mkdirSync(env.disk('f'));
    env.writeDisk('f/y.txt', 'y');
    const data = await call(m, 'sync', { path: 'work/f' });
    assert.ok(env.store.treeGet('workspace/work/tree', 'f/y.txt'), 'what disk has beneath is taken in');
    assert.match(JSON.stringify(data.skipped ?? []), /"path":"f".*disk could not be checked: a directory/);
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

describe('the mount root', () => {
  /** What a drive's unmount looks like from the mount: the root goes, and the watcher makes an empty one. */
  function unmount(env: Env): string {
    const away = `${env.dir}-away`;
    renameSync(env.dir, away); // kept, so the new root can't reuse its inode
    mkdirSync(env.dir);
    return away;
  }
  function remount(env: Env, away: string): void {
    rmSync(env.dir, { recursive: true });
    renameSync(away, env.dir);
  }
  const identityOf = (path: string) => {
    const s = statSync(path, { bigint: true });
    return { dev: String(s.dev), ino: String(s.ino) };
  };

  test('the root disk agreed under is recorded with the first evidence', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.equal((m as any).agreement.rootIdentity('work'), undefined, 'nothing recorded before any evidence');
    await seedSynced(env, m, 'a.txt', 'A');
    assert.deepEqual((m as any).agreement.rootIdentity('work'), identityOf(env.dir));
    await seedSynced(env, m, 'b.txt', 'B');
    await call(m, 'sync', {});
    const rootEntries = (m as any).agreement.journal.load().entries.filter((e: any) => e.entry.t === 'root');
    assert.equal(rootEntries.length, 1, 'recorded once, not with every piece of evidence');
  });

  test('a root replaced by an empty directory is unavailable, and the tree keeps every entry', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await seedSynced(env, m, 'sub/b.txt', 'B');
    const away = unmount(env);

    await (m as any).initialScan('work'); // the reattach
    assert.notEqual(env.store.treeGet(TREE, 'a.txt'), null, 'a.txt is still in the tree');
    assert.notEqual(env.store.treeGet(TREE, 'sub/b.txt'), null, 'sub/b.txt is still in the tree');
    assert.equal(env.eventsOf('workspace:deleted').length, 0, 'no deletion was announced');
    const synced = await call(m, 'sync', {});
    assert.equal(synced.totalSynced, 0, 'a plain sync adopts nothing either');
    assert.match(synced.incomplete?.[0]?.reason ?? '', /not the directory disk last agreed with/);
    assert.match(synced.incomplete[0].reason, /acceptRoot/, 'the reason names the remedy');
    assert.notEqual(env.store.treeGet(TREE, 'a.txt'), null, 'still in the tree after the sync');

    remount(env, away);
    await (m as any).initialScan('work');
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'back, and agreed as before');
    assert.equal(await stateOf(m, 'sub/b.txt'), 'synced');
  });

  test('the recorded root survives a restart', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await env.shutdown(m);
    unmount(env); // a host that starts while the drive is away
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open();
    await (m as any).initialScan('work');
    assert.notEqual(env.store.treeGet(TREE, 'a.txt'), null, 'still in the tree');
    assert.equal(env.eventsOf('workspace:deleted').length, 0, 'no deletion was announced');
  });

  test('a replaced root takes no writes, forced or not', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await call(m, 'write', { path: 'work/c.txt', content: 'C, a draft' });
    await call(m, 'write', { path: 'work/sub/d.txt', content: 'D, a draft' });
    unmount(env);
    mkdirSync(env.disk('sub')); // a mountpoint with leftovers of its own: a directory a write could reach

    for (const input of [{}, { force: true }, { path: 'work/c.txt', force: true }, { path: 'work/sub/d.txt', force: true }]) {
      const res = await m.handleToolCall({ id: 't', name: 'materialize', input });
      assert.equal(existsSync(env.disk('c.txt')), false, `${JSON.stringify(input)} wrote nothing`);
      assert.equal(existsSync(env.disk('sub/d.txt')), false, `${JSON.stringify(input)} wrote nothing beneath the root`);
      assert.equal(existsSync(env.disk('a.txt')), false, `${JSON.stringify(input)} restored nothing`);
      assert.match(JSON.stringify(res), /not the directory disk last agreed with/, `${JSON.stringify(input)} says why`);
    }
  });

  for (const op of ['materialize', 'sync'] as const) {
    test(`the root is recorded before the first evidence, so a ${op} killed after its intent leaves both`, async (t) => {
      const env = new Env(t);
      if (op === 'sync') env.writeDisk('a.txt', 'A, a shell file to adopt');
      let m = await env.open();
      if (op === 'materialize') await call(m, 'write', { path: 'work/a.txt', content: 'A, a draft' });
      assert.equal((m as any).agreement.paths('work').length, 0, 'no evidence before the operation');
      m = await env.fault(m, op, 'after-intent');
      assert.equal((m as any).agreement.get('work', 'a.txt')?.kind, 'pending', 'the intent is durable');
      assert.deepEqual((m as any).agreement.rootIdentity('work'), identityOf(env.dir), 'and so is the root it was made under');
    });
  }

  test('a push that only learns an agreement records the root too', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.legacyEntry('a.txt', 'A'); // in the tree, and the same on disk, with no evidence yet
    env.writeDisk('a.txt', 'A');
    await call(m, 'materialize', { path: 'work/a.txt' });
    assert.equal((m as any).agreement.get('work', 'a.txt')?.kind, 'content', 'the push learned the agreement');
    assert.equal(statSync(env.disk('a.txt')).size, 1);
    assert.deepEqual((m as any).agreement.rootIdentity('work'), identityOf(env.dir), 'and recorded the root it was learned under');
  });

  test("a pass records the root with the evidence it gathers", async (t) => {
    const env = new Env(t);
    env.writeDisk('a.txt', 'A'); // on disk before the workspace knows anything
    const m = await env.open();
    await call(m, 'sync', {});
    assert.deepEqual((m as any).agreement.rootIdentity('work'), identityOf(env.dir));
    unmount(env);
    await (m as any).initialScan('work');
    assert.notEqual(env.store.treeGet(TREE, 'a.txt'), null, 'still in the tree');
  });

  test('a checkpoint keeps the recorded root', async (t) => {
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store);
    agreement.open([{ name: 'work', root: env.dir }]);
    agreement.recordRootIdentity('work', { dev: '1', ino: '2' });
    for (let i = 0; i < 1100; i++) agreement.set('work', `f${i}.txt`, { kind: 'absent' });
    agreement.maybeCheckpoint();
    agreement.barrier();
    const reopened = new DiskAgreement(env.store);
    reopened.open([{ name: 'work', root: env.dir }]);
    assert.deepEqual(reopened.rootIdentity('work'), { dev: '1', ino: '2' });
    assert.equal(reopened.paths('work').length, 1100);
  });

  test('a mount configured at another path starts with no recorded root', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const elsewhere = join(env.root, 'elsewhere');
    mkdirSync(elsewhere);
    m = await env.restart(m, { path: elsewhere });
    assert.equal((m as any).agreement.rootIdentity('work'), undefined, 'evidence about another directory is not carried over');
  });

  test('acceptRoot takes a replaced root, with its evidence set aside', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await seedSynced(env, m, 'sub/b.txt', 'B');
    unmount(env);
    env.writeDisk('a.txt', 'A'); // the new root holds the same a.txt, no sub/b.txt, and a new c.txt
    env.writeDisk('c.txt', 'C');

    const synced = await call(m, 'sync', { mount: 'work', acceptRoot: true });
    assert.deepEqual(synced.rootsAccepted, ['work']);
    assert.deepEqual((m as any).agreement.rootIdentity('work'), identityOf(env.dir), 'the new root is recorded');
    assert.equal(await stateOf(m, 'a.txt'), 'synced', 'agreed again');
    assert.equal(await contentOf(m, 'c.txt'), 'C', "the new root's own file is taken in");
    assert.notEqual(env.store.treeGet(TREE, 'sub/b.txt'), null, 'a file the new root lacks stays in the workspace');
    assert.equal(env.eventsOf('workspace:deleted').length, 0, 'nothing was taken as deleted');

    const again = await call(m, 'sync', { mount: 'work', acceptRoot: true });
    assert.equal(again.rootsAccepted, undefined, 'the recorded root is not accepted twice');
  });

  test('acceptRoot takes a whole mount, not a path', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.match(await refused(m, 'sync', { path: 'work/a.txt', acceptRoot: true }), /whole mount/);
  });
});
