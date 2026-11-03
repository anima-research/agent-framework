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
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { open, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { DISK_AGREEMENT_RECORD_TYPE, DiskAgreement, onlyDeviceDiffers, sameRootIdentity } from '../src/modules/workspace/disk-agreement.js';
import { RecordJournal } from '../src/record-journal.js';
import { RACY_WINDOW_MS, ROOT_ON_ANOTHER_DEVICE, ROOT_REPLACED, confirmAbsent, filesystemKeepsBirthTime, fingerprintVouches, fsTypeKeepsBirthTime, fsTypeTrustsCtime, inOtherMount, observePath, provenAbsent, readPath, walkScope, type MountView } from '../src/modules/workspace/observe.js';
import { EffectFailed, syncDirectories, unlinkContained, writeContained } from '../src/modules/workspace/effects.js';
import { pushPaths, settleAdoptionBeforeMutation } from '../src/modules/workspace/reconcile.js';
import type { MountConfig, WorkspaceConfig } from '../src/modules/workspace/types.js';
import type { FsChange } from '../src/modules/workspace/watcher.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent } from '../src/types/events.js';
import { changedAfterFstat, withFileHandle } from './helpers/file-handle.js';
import { changesFlow, isProbe } from './helpers/watcher-flow.js';

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

  async open(mount: Partial<MountConfig> = {}, config: Partial<WorkspaceConfig> = {}, beforeStart?: (m: WorkspaceModule) => void): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({
      mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', ...mount }],
      ...config,
    });
    m.initStore(this.store);
    beforeStart?.(m);
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
  return res.structured ?? res.data;
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

/** The workspace's text for a path, unformatted, as a read shows it: after its path is settled against disk. */
async function contentOf(m: WorkspaceModule, path: string): Promise<string> {
  const data = await call(m, 'read', { path: `work/${path}`, offsetChars: 0, limitChars: 1_000_000 });
  return data.content as string;
}

/** The text the store holds for a path on the selected branch, read without a pass. */
function storedOf(env: Env, path: string): string | null {
  const entry = env.store.treeGet(TREE, path);
  if (!entry) return null;
  return env.store.getBlob(entry.blobHash)!.toString('utf-8');
}

/** Written through the workspace and materialized: S = D = P. */
async function seedSynced(env: Env, m: WorkspaceModule, path: string, content: string): Promise<void> {
  await call(m, 'write', { path: `work/${path}`, content });
  await call(m, 'materialize', { path: `work/${path}` });
  assert.equal(env.readDisk(path), content);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clockPastTheRacyWindow(t: TestContext): void {
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow.call(Date) + RACY_WINDOW_MS + 100);
}

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
async function withFsPromises<T>(name: 'readdir' | 'lstat' | 'open' | 'realpath' | 'statfs', make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>, fn: () => Promise<T>): Promise<T> {
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
    assert.match(error, /^The deletion of "work\/b\.txt" is stored in the workspace, so don't send it again\. Its push to disk didn't complete: /);
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
    // Read from the store: a read would settle the path against disk itself.
    assert.equal(storedOf(env, 'a.txt'), "other's draft", "other's draft is untouched");
    env.store.switchBranch(main);
    assert.equal(storedOf(env, 'a.txt'), 'v1', 'and main took nothing either');
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

/** The walk's reason for an editor's swap or backup file. */
const EDITOR = "an editor's swap or backup file";

/** Waits, polling, until `ok` holds. It asks once more at its bound, so a process held past the bound fails only a wait whose condition still doesn't hold. */
async function until(ok: () => boolean, what: string, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
  if (ok()) return;
  assert.fail(what);
}

/**
 * Waits until each named mount's watcher hands `m` a change, so what a test
 * writes there next is written while changes are delivered: ready says
 * chokidar's first scan is done, not that the platform delivers events
 * (changesFlow). Its probes land in each mount's root, where the mount takes
 * them in, so a test's results leave them out (isProbe).
 */
async function watchersFlow(m: WorkspaceModule, roots: Record<string, string>): Promise<void> {
  const heard = new Map(Object.keys(roots).map((name) => [name, [] as FsChange[][]]));
  const internals = m as unknown as { handleFsChanges(mount: string, changes: FsChange[]): Promise<void> };
  const handle = internals.handleFsChanges.bind(m);
  internals.handleFsChanges = (mount, changes) => {
    heard.get(mount)?.push(changes);
    return handle(mount, changes);
  };
  for (const [name, root] of Object.entries(roots)) await changesFlow(root, heard.get(name)!, []);
}

describe("editors' swap and backup files are passed over by name (connectome-host #278)", () => {

  test('a sync without a path passes over them by their own whole name, wherever they are, and counts them', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    // A directory with such a name is passed over with what lies beneath it.
    for (const f of ['.gate.json.swp', '.gate.json.swx', 'gate.json~', '.x.subl3f9.tmp', 'deep/dir/.notes.md.swp', 'drafts~/x.txt']) env.writeDisk(f, 'editor state');
    // Not editors' names: one dot before `swp`, no leading dot, another
    // backup suffix, a tilde mid-name, Sublime's form not the whole name, and
    // a plain name under a directory with a dot in its name.
    const taken = ['gate.json', 'notes.swp', 'report.v2.swp', 'backup.txt.bak', 'notes~draft.md', 'notes.sublime.tmpl', 'a.subl.tmp.csv', '.cfg/notes.swp'];
    for (const f of taken) env.writeDisk(f, 'taken in');

    const data = await call(m, 'sync', {});
    assert.equal(data.totalSynced, taken.length);
    assert.deepEqual(env.store.treeList(TREE).map((e: { path: string }) => e.path).sort(), [...taken].sort());
    assert.deepEqual(data.passedOver, [{ mount: 'work', reason: EDITOR, count: 6 }]);
    assert.equal((await listing(m)).has('gate.json~'), false, 'a listing passes over them too');

    // Naming a path beneath such a directory syncs it, and says why a sync
    // without one won't.
    const named = await call(m, 'sync', { path: 'work/drafts~/x.txt' });
    assert.equal(named.totalSynced, 1);
    assert.deepEqual(named.ignored, [{ mount: 'work', path: 'drafts~/x.txt',
      note: "it has an editor's swap or backup file name, or lies under one, so a sync without a path won't maintain it" }]);
  });

  test('a stored copy is treated as one the ignore list covers: a change on disk is passed over, a deletion is taken', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['*.md'] });
    env.writeDisk('LOG.md', 'v1');
    env.writeDisk('gate.json~', 'v1');

    // Naming a path syncs it, and the result says a sync without one won't.
    const named = await call(m, 'sync', { path: 'work/gate.json~' });
    assert.equal(named.totalSynced, 1);
    assert.deepEqual(named.ignored, [{ mount: 'work', path: 'gate.json~',
      note: "it has an editor's swap or backup file name, or lies under one, so a sync without a path won't maintain it" }]);
    await call(m, 'sync', { path: 'work/LOG.md' });
    const stored = (f: string) => env.store.treeGet(TREE, f)?.blobHash;
    const v1 = { 'LOG.md': stored('LOG.md'), 'gate.json~': stored('gate.json~') };
    assert.ok(v1['LOG.md'] && v1['gate.json~'], 'both are stored');

    env.writeDisk('LOG.md', 'v2');
    env.writeDisk('gate.json~', 'v2');
    const bare = await call(m, 'sync', {});
    assert.equal(bare.totalSynced, 0);
    for (const f of ['LOG.md', 'gate.json~'] as const) {
      assert.equal(stored(f), v1[f], `${f}: the stored copy stays as it was`);
      assert.equal((await listing(m)).get(f)?.state, 'unverified', f);
      // A grep that reaches it by its own path passes over it too.
      await call(m, 'grep', { pattern: 'v', path: `work/${f}` });
      assert.equal(stored(f), v1[f], `${f}: nor by a grep naming it`);
    }
    assert.deepEqual((bare.incomplete as Array<{ path: string; reason: string }>).map(({ path, reason }) => [path, reason]).sort(),
      [['LOG.md', 'ignored by the mount'], ['gate.json~', EDITOR]]);

    // A complete listing of the directory lacks them: absent, as anything it lacks.
    env.rmDisk('LOG.md');
    env.rmDisk('gate.json~');
    await call(m, 'sync', {});
    for (const f of ['LOG.md', 'gate.json~']) assert.equal(env.store.treeGet(TREE, f), null, `${f}: its deletion is taken`);
  });

  test('a materialize treats a stored copy as any file the workspace holds, as it treats one the ignore list covers', async (t) => {
    const env = new Env(t);
    const m = await env.open({ ignore: ['*.md'] });
    const files = ['LOG.md', 'gate.json~', 'plain.txt'];
    const disk = (f: string) => (existsSync(env.disk(f)) ? readFileSync(env.disk(f), 'utf8') : null);
    for (const f of files) {
      env.writeDisk(f, 'v1');
      await call(m, 'sync', { path: `work/${f}` });
    }
    const main = env.store.currentBranch().name;
    env.store.createBranch('earlier', main);
    // Deleted on disk, and the deletion taken in by a sync without a path.
    for (const f of files) env.rmDisk(f);
    await call(m, 'sync', {});
    for (const f of files) assert.equal(env.store.treeGet(TREE, f), null, f);

    // A branch whose history holds them writes them back where disk lacks them.
    env.store.switchBranch('earlier');
    await m.materializeMount('work');
    for (const f of files) assert.equal(disk(f), 'v1', `${f} is written back`);

    // A change the workspace owes goes to disk while disk has the copy they agreed on.
    for (const f of files) await call(m, 'write', { path: `work/${f}`, content: 'v2' });
    const owed = await call(m, 'materialize', { path: 'work' });
    assert.deepEqual((owed.materialized as Array<{ path: string }>).map((w) => w.path).sort(), [...files].sort());
    for (const f of files) assert.equal(disk(f), 'v2', f);

    // A change disk made is left alone, as a conflict, unless forced.
    for (const f of files) {
      await call(m, 'write', { path: `work/${f}`, content: 'v3' });
      env.writeDisk(f, 'edited on disk');
    }
    const left = await call(m, 'materialize', { path: 'work' });
    assert.deepEqual((left.skipped as Array<{ reason: string }>).map((s) => s.reason.split(':')[0]).sort(), [...files].sort());
    for (const s of left.skipped as Array<{ reason: string }>) assert.match(s.reason, /\(conflict: both-changed\)/);
    for (const f of files) assert.equal(disk(f), 'edited on disk', f);
    await call(m, 'materialize', { path: 'work', force: true });
    for (const f of files) assert.equal(disk(f), 'v3', `${f}: forced`);
  });
});

describe('a listing, glob or grep inside a directory passed over by design', () => {
  for (const [kind, ignore, dir, reason] of [
    ["an editor's name", [], 'drafts~', EDITOR],
    ['a bare-name ignore entry', ['node_modules'], 'node_modules', 'ignored by the mount'],
    ['a path ignore entry', ['cache/**'], 'cache', 'ignored by the mount'],
  ] as const) {
    test(`takes nothing in there and names the region, so it tracks nothing (${kind})`, async (t) => {
      const env = new Env(t);
      env.writeDisk(`${dir}/a.txt`, 'x');
      env.writeDisk(`${dir}/pkg/index.js`, 'x');
      const m = await env.open({ ignore: [...ignore] });
      // The region says why, and how to take what's there in on purpose.
      const region = (path: string) => ({ path, reason: `${reason}: a sync that names this path takes in what's there, editors' files aside` });
      // At the directory, and at a scope beneath it, which a directory above
      // passes over too.
      for (const scope of [dir, `${dir}/pkg`]) {
        for (const recursive of [false, true]) {
          const ls = await call(m, 'ls', { path: `work/${scope}`, recursive });
          assert.deepEqual(ls.entries, [], `ls ${scope} (recursive ${recursive})`);
          assert.deepEqual(ls.incomplete, [region(scope)], `ls ${scope} (recursive ${recursive}) names the region`);
        }
        const globbed = await call(m, 'glob', { pattern: '**', path: `work/${scope}` });
        assert.deepEqual(globbed.matches, [], `glob ${scope}`);
        assert.deepEqual(globbed.incomplete, [region(`work/${scope}`)], `glob ${scope}`);
        const grepped = await call(m, 'grep', { pattern: 'x', path: `work/${scope}` });
        assert.deepEqual(grepped.results, [], `grep ${scope}`);
        assert.deepEqual(grepped.incomplete, [region(`work/${scope}`)], `grep ${scope}`);
      }
      assert.deepEqual(env.store.treeList(TREE), [], 'nothing beneath it is tracked');
      // A sync that names it still syncs what's there (#276).
      const named = await call(m, 'sync', { path: `work/${dir}` });
      assert.equal(named.totalSynced, 2);
      const stored = () => env.store.treeList(TREE).map((e: { path: string; blobHash: string }) => `${e.path} ${e.blobHash}`).sort();
      const before = stored();
      assert.deepEqual(before.map((e) => e.split(' ')[0]), [`${dir}/a.txt`, `${dir}/pkg/index.js`], 'the named sync stored both');
      // The copies it stored are listed, unobserved, and a change on disk
      // isn't taken in by a listing, glob or grep there.
      env.writeDisk(`${dir}/a.txt`, 'changed on disk');
      const listed = await listing(m, `work/${dir}`);
      assert.deepEqual([...listed.keys()].sort(), [`${dir}/a.txt`, `${dir}/pkg/index.js`]);
      for (const e of listed.values()) assert.equal(e.state, 'unverified', `${e.path} is unobserved`);
      await call(m, 'glob', { pattern: '**', path: `work/${dir}` });
      await call(m, 'grep', { pattern: 'x', path: `work/${dir}` });
      assert.deepEqual(stored(), before, 'nothing was taken in');
    });
  }
});

describe('a file tool naming a path passed over by design', () => {
  // The last column: what a sync without a path then reports under skipped.
  // Beneath a directory passed over by design, no walk can show the deleted
  // file gone either, so its evidence is reported too, as on main; a file
  // passed over by its own name is shown absent by the walk of its directory.
  for (const [kind, ignore, read, edit, gone, skipped] of [
    ['beneath a directory an ignore entry covers', ['node_modules'], 'node_modules/pkg/index.d.ts', 'node_modules/pkg/edit.d.ts', 'node_modules/pkg/gone.d.ts',
      ['node_modules/pkg/edit.d.ts', 'node_modules/pkg/gone.d.ts', 'node_modules/pkg/index.d.ts']],
    ['that an ignore entry covers by its own name', ['*.log'], 'build.log', 'edit.log', 'gone.log', ['build.log', 'edit.log']],
    ["that is an editor's backup file", [], 'draft.md~', 'edit.md~', 'gone.md~', ['draft.md~', 'edit.md~']],
  ] as const) {
    test(`reads, edits and deletes a file ${kind} that the store doesn't hold, as a sync naming it takes it in (#276)`, async (t) => {
      const env = new Env(t);
      for (const f of [read, edit, gone]) env.writeDisk(f, `${f} v1\n`);
      const m = await env.open({ ignore: [...ignore], autoMaterialize: true });
      await call(m, 'sync', {});
      assert.deepEqual(env.store.treeList(TREE), [], 'a sync without a path passes over all three');
      assert.equal((await call(m, 'read', { path: `work/${read}` })).content, `     1\t${read} v1`);
      await call(m, 'edit', { path: `work/${edit}`, oldString: 'v1', newString: 'v2' });
      assert.equal(env.readDisk(edit), `${edit} v2\n`, 'the edit reached disk');
      assert.equal((await call(m, 'delete', { path: `work/${gone}` })).deleted, true);
      assert.equal(existsSync(env.disk(gone)), false, 'the deletion reached disk');
      const paths = () => env.store.treeList(TREE).map((e: { path: string }) => e.path).sort();
      assert.deepEqual(paths(), [edit, read].sort(), 'the read and the edit took their files in');
      // What they took in stays passed over by a sync without a path, which says so.
      const bare = await call(m, 'sync', {});
      assert.deepEqual((bare.skipped as Array<{ path: string }>).map((s) => s.path).sort(), [...skipped]);
      assert.deepEqual(paths(), [edit, read].sort());
    });
  }

  // A read names its path too, so a held file passed over by design is read
  // as any held file is: disk's change, and disk's deletion, are taken in
  // first.
  for (const [kind, ignore, path] of [
    ['beneath a directory an ignore entry covers', ['node_modules'], 'node_modules/pkg/a.txt'],
    ['that an ignore entry covers by its own name', ['*.log'], 'build.log'],
  ] as const) {
    test(`a read of a held file ${kind} takes disk's change and disk's deletion in first, as a read of any held file does`, async (t) => {
      const env = new Env(t);
      env.writeDisk(path, 'v1\n');
      const m = await env.open({ ignore: [...ignore] });
      await call(m, 'sync', { path: `work/${path}` });
      const stored = () => {
        const entry = env.store.treeGet(TREE, path);
        return entry ? env.store.getBlob(entry.blobHash)!.toString('utf-8') : null;
      };
      assert.equal(stored(), 'v1\n', 'the named sync stored it');
      env.writeDisk(path, 'v2\n');
      const changed = await call(m, 'read', { path: `work/${path}` });
      assert.equal(changed.content, '     1\tv2', "the read shows disk's text");
      assert.match(String(changed.note), /Disk's copy had changed since the workspace last agreed with it, so it was taken in first/);
      assert.equal(stored(), 'v2\n', "and stores disk's change");
      env.rmDisk(path);
      const gone = await refused(m, 'read', { path: `work/${path}` });
      assert.equal(gone, `The read did nothing: there's no file at "work/${path}" any more: disk's copy was deleted since the workspace last agreed with it, and the workspace took that in first. ls or glob lists the files that exist.`);
      assert.equal(stored(), null, "and disk's deletion is stored");
    });
  }

  test('edit_many edits files passed over by design, each by its path, as a sync naming them takes them in (#276)', async (t) => {
    const env = new Env(t);
    env.writeDisk('node_modules/pkg/a.d.ts', 'a v1\n');
    env.writeDisk('build.log', 'log v1\n');
    const m = await env.open({ ignore: ['node_modules', '*.log'], autoMaterialize: true });
    await call(m, 'sync', {});
    assert.deepEqual(env.store.treeList(TREE), [], 'a sync without a path passes over both');
    await call(m, 'edit_many', { edits: [
      { path: 'work/node_modules/pkg/a.d.ts', oldString: 'v1', newString: 'v2' },
      { path: 'work/build.log', oldString: 'v1', newString: 'v2' },
    ] });
    assert.equal(env.readDisk('node_modules/pkg/a.d.ts'), 'a v2\n', 'the edits reached disk');
    assert.equal(env.readDisk('build.log'), 'log v2\n');
    assert.deepEqual(env.store.treeList(TREE).map((e: { path: string }) => e.path).sort(), ['build.log', 'node_modules/pkg/a.d.ts']);
  });

  test("the nested mount's refusal comes first, and the lazy pass takes nothing in from another mount's directory", async (t) => {
    const env = new Env(t);
    env.writeDisk('node_modules/pkg/inner.txt', 'inner');
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', ignore: ['node_modules'] },
      { name: 'deep', path: env.disk('node_modules/pkg'), mode: 'read-write', watch: 'never' },
    ] });
    for (const [tool, input] of [
      ['read', { path: 'work/node_modules/pkg/inner.txt' }],
      ['edit', { path: 'work/node_modules/pkg/inner.txt', oldString: 'inner', newString: 'outer' }],
      ['delete', { path: 'work/node_modules/pkg/inner.txt' }],
    ] as const) {
      const said = await refused(m, tool, input);
      assert.ok(said.includes('mount "deep"') && said.includes('"deep/inner.txt"'), `${tool}: ${said}`);
    }
    const many = await refused(m, 'edit_many', { edits: [{ path: 'work/node_modules/pkg/inner.txt', oldString: 'inner', newString: 'outer' }] });
    assert.ok(many.includes('mount "deep"') && many.includes('"deep/inner.txt"') && many.includes('which neither reads nor writes it'), `edit_many: ${many}`);
    // The lazy pass itself, reached past the refusal, observes nothing there.
    const mount = (m as any).mounts.get('work');
    await (m as any).withMount(mount, () => (m as any).ensureSynced(mount, 'node_modules/pkg/inner.txt'));
    assert.deepEqual(env.store.treeList(TREE), [], 'the outer store gains nothing');
    assert.equal(env.readDisk('node_modules/pkg/inner.txt'), 'inner');
  });
});

describe('a mount nested inside another', () => {
  test('is passed over by the outer mount as the directory it is, and nothing else is', async (t) => {
    const env = new Env(t);
    for (const f of ['top.txt', 'cat.txt', 'a/b/inner.txt', 'c/near.txt', 'sub/c', 'sub/x/c/f.txt', '..cache/f.txt']) env.writeDisk(f, f);
    const m = await env.open({}, { mounts: [
      // `a/b` listed by hand covers the nested mount's directory too, and the
      // walk still passes it over as that mount's.
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', ignore: ['a/b'] },
      { name: 'deep', path: env.disk('a/b'), mode: 'read-write', watch: 'never' },
      { name: 'near', path: env.disk('c'), mode: 'read-write', watch: 'never' },
      // A name that only begins with two dots is inside the outer mount.
      { name: 'dots', path: env.disk('..cache'), mode: 'read-write', watch: 'never' },
    ] });
    const OTHER = "another mount's directory";
    const bare = await call(m, 'sync', { mount: 'work' });
    // None of the nested mounts' files, and the entries that only share a
    // nested mount's name.
    const tree = () => env.store.treeList(TREE).map((e: { path: string }) => e.path).sort();
    // cat.txt only begins with the nested mount c's name.
    assert.deepEqual(tree(), ['cat.txt', 'sub/c', 'sub/x/c/f.txt', 'top.txt']);
    assert.deepEqual((bare.passedOver as Array<{ reason: string; count: number }>).filter((p) => p.reason === OTHER).map((p) => p.count), [3],
      'it passes over the three nested mounts, each as its directory');
    // A sync that names a nested mount's directory, or a path beneath it,
    // takes nothing in, and its region gives no advice: no sync of this
    // mount does.
    for (const [path, use] of [['a/b', 'deep'], ['a/b/inner.txt', 'deep/inner.txt'], ['c', 'near']]) {
      const named = await call(m, 'sync', { path: `work/${path}` });
      assert.equal(named.totalSynced, 0, path);
      assert.deepEqual((named.ignored as Array<{ note: string }>).map((i) => i.note),
        [`it lies in mount "${use.split('/')[0]}", nested in this one, which no sync of this mount takes in: use "${use}"`], path);
      // A named file is a paths pass, which makes no region; a directory's
      // walk names it, with the mount that holds it.
      assert.deepEqual(((named.incomplete ?? []) as Array<{ path: string; reason: string }>).map((r) => [r.path, r.reason]),
        path === 'a/b/inner.txt' ? [] : [[path, `it lies in mount "${use}", nested in this one: use "${use}"`]], path);
    }
    // A listing, glob or grep of it lists and searches nothing beneath it,
    // takes nothing in, and names the region under `incomplete`.
    for (const [tool, input, list, region] of [
      ['ls', { path: 'work/a/b' }, 'entries', 'a/b'],
      ['glob', { path: 'work/a/b', pattern: '*' }, 'matches', 'work/a/b'],
      ['grep', { path: 'work/a/b', pattern: 'inner' }, 'results', 'work/a/b'],
    ] as const) {
      const listed = await call(m, tool, input as Record<string, unknown>);
      assert.deepEqual(listed[list], [], `${tool} lists nothing beneath it`);
      assert.deepEqual((listed.incomplete as Array<{ path: string; reason: string }>).map((r) => [r.path, r.reason]),
        [[region, 'it lies in mount "deep", nested in this one: use "deep"']], tool);
    }
    assert.deepEqual(tree(), ['cat.txt', 'sub/c', 'sub/x/c/f.txt', 'top.txt'], 'nothing of theirs was taken in');
    // A file that only shares a nested mount's name is this mount's, named or not.
    env.writeDisk('sub/c', 'changed');
    const subc = await call(m, 'sync', { path: 'work/sub/c' });
    assert.equal(subc.totalSynced, 1);
  });

  test("never reaches the outer mount's tree while both mounts' watchers run", async (t) => {
    const env = new Env(t);
    env.writeDisk('top.txt', 'top');
    env.writeDisk('a/b/inner.txt', 'inner');
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'always', watchDebounceMs: 50 },
      { name: 'deep', path: env.disk('a/b'), mode: 'read-write', watch: 'always', watchDebounceMs: 50 },
    ] });
    const mount = (m as any).mounts.get('work');
    const deep = (m as any).mounts.get('deep');
    const tree = () => env.store.treeList(TREE).map((e: { path: string }) => e.path).sort();
    const deepTree = () => env.store.treeList('workspace/deep/tree').map((e: { path: string }) => e.path).sort();
    await until(() => !!mount.watcherReadyAt && !!deep.watcherReadyAt && tree().includes('top.txt') && deepTree().includes('inner.txt'),
      'both watchers are ready and their catch-up scans ran');
    await watchersFlow(m, { work: env.dir, deep: env.disk('a/b') });
    // The inner mount takes its new file in, so the change has reached the
    // watchers; the outer mount's own new file, written after it, is taken
    // in after that. (MountWatcher's own test pins the outer watcher's filter.)
    env.writeDisk('a/b/new.txt', 'nested');
    await until(() => deepTree().includes('new.txt'), 'the inner mount takes its new file in');
    env.writeDisk('later.txt', 'outer');
    await until(() => tree().includes('later.txt'), 'the outer mount takes its own new file in');
    // The handshake's probe in the outer mount's root is its own; one beneath a/b would be the inner mount's.
    assert.deepEqual(tree().filter((p) => p.includes('/') || !isProbe(p)), ['later.txt', 'top.txt']);
  });
});

describe("another mount's directory, to the outer mount's file tools and pushes", () => {
  const nested = (env: Env): Partial<WorkspaceConfig> => ({ mounts: [
    { name: 'work', path: env.dir, mode: 'read-write', watch: 'never' },
    { name: 'deep', path: env.disk('a/b'), mode: 'read-write', watch: 'never' },
  ] });

  test('every file tool of the outer mount refuses a path there, naming the mount that holds it and the path to use', async (t) => {
    const env = new Env(t);
    env.writeDisk('top.txt', 'top');
    env.writeDisk('a/b/inner.txt', 'inner');
    const m = await env.open({}, nested(env));
    for (const [tool, input, use] of [
      ['read', { path: 'work/a/b/inner.txt' }, 'deep/inner.txt'],
      ['write', { path: 'work/a/b/inner.txt', content: 'outer' }, 'deep/inner.txt'],
      ['edit', { path: 'work/a/b/inner.txt', oldString: 'inner', newString: 'outer' }, 'deep/inner.txt'],
      ['delete', { path: 'work/a/b/inner.txt' }, 'deep/inner.txt'],
      ['write', { path: 'work/a/b/sub/new.txt', content: 'outer' }, 'deep/sub/new.txt'],
      ['read', { path: 'work/a/b' }, 'deep'],
    ] as const) {
      const said = await refused(m, tool, input as Record<string, unknown>);
      assert.ok(said.includes('mount "deep"') && said.includes(`"${use}"`), `${tool} ${input.path}: ${said}`);
    }
    // edit and edit_many refuse such a path as they check it, before any pass
    // (parseFilePath), and edit_many stores none of its edits, the outer
    // mount's own included.
    const nestedRefusal = '"work/a/b/inner.txt" lies in mount "deep", nested in mount "work", which neither reads nor writes it: use "deep/inner.txt".';
    assert.equal(await refused(m, 'edit', { path: 'work/a/b/inner.txt', oldString: 'inner', newString: 'outer' }), `The edit did nothing: ${nestedRefusal}`);
    assert.equal(await refused(m, 'edit_many', { edits: [{ path: 'work/a/b/inner.txt', oldString: 'inner', newString: 'outer' }] }),
      `The edit_many call stored none of its edits: 1 problem.\n\nedit 1: ${nestedRefusal}`);
    assert.equal(await refused(m, 'edit_many', { edits: [
      { path: 'work/top.txt', oldString: 'top', newString: 'TOP' },
      { path: 'work/a/b/inner.txt', oldString: 'inner', newString: 'outer' },
    ] }), `The edit_many call stored none of its edits: 1 problem.\n\nedit 2: ${nestedRefusal}`);
    assert.match((await call(m, 'read', { path: 'work/top.txt' })).content, /^ +1\ttop$/, "the outer mount's own file is as it was");
    assert.equal(env.readDisk('a/b/inner.txt'), 'inner');
    assert.equal(existsSync(env.disk('a/b/sub/new.txt')), false);
    assert.equal(env.store.treeList(TREE).some((e: { path: string }) => e.path.startsWith('a/b/')), false, 'the outer store gains nothing there');
    await assert.rejects(m.readFileFromDisk('work/a/b/inner.txt'), (err: unknown) => (err as { code?: string }).code === 'other_mount');
    assert.equal(m.resolveAbsolutePath('work/a/b/inner.txt'), null);
    const binary = await m.readBinary('work/a/b/inner.txt');
    assert.ok('error' in binary && binary.error.includes('"deep/inner.txt"'), JSON.stringify(binary));
    const fromDisk = await m.readBinaryFromDisk('work/a/b/inner.txt');
    assert.ok('error' in fromDisk && fromDisk.error.includes('"deep/inner.txt"'), JSON.stringify(fromDisk));
    const written = await m.writeBinary('work/a/b/img.png', Buffer.from('png'), 'image/png');
    assert.ok(!written.success && String(written.error).includes('"deep/img.png"'), JSON.stringify(written));
    const image = await refused(m, 'read_image', { path: 'work/a/b/img.png' });
    assert.ok(image.includes('"deep/img.png"'), image);
    // The path it names works, and the outer mount's own files stay its own.
    assert.match((await call(m, 'read', { path: 'deep/inner.txt' })).content, /inner/);
    assert.match((await call(m, 'read', { path: 'work/top.txt' })).content, /top/);
  });

  test('a spelling that lands in its directory is refused as the path it lands on, and one that lands beside it is not', async (t) => {
    const env = new Env(t);
    env.writeDisk('top.txt', 'top');
    env.writeDisk('a/b/inner.txt', 'inner');
    const m = await env.open({}, nested(env));
    for (const path of ['work/./a/b/inner.txt', 'work/a/c/../b/inner.txt', 'work/a//b/inner.txt']) {
      const said = await refused(m, 'read', { path });
      assert.ok(said.includes('mount "deep"') && said.includes('"deep/inner.txt"'), `${path}: ${said}`);
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) => (err as { code?: string }).code === 'other_mount', path);
      assert.equal(m.resolveAbsolutePath(path), null, path);
      const fromDisk = await m.readBinaryFromDisk(path);
      assert.ok('error' in fromDisk && fromDisk.error.includes('"deep/inner.txt"'), `${path}: ${JSON.stringify(fromDisk)}`);
    }
    // A spelling that climbs back out of it is the outer mount's own path,
    // judged where it lands: read through what doesn't touch the store.
    env.writeDisk('a/x.txt', 'x');
    for (const [path, content] of [['work/a/b/../x.txt', 'x'], ['work/a/b/../../top.txt', 'top']]) {
      assert.equal((await m.readFileFromDisk(path)).bytes.toString(), content, path);
      assert.notEqual(m.resolveAbsolutePath(path), null, path);
    }
  });

  test("grep of the outer mount returns nothing of its copy of a path there, and names the region", async (t) => {
    const env = new Env(t);
    env.writeDisk('top.txt', 'top');
    env.writeDisk('a/b/inner.txt', 'inner');
    let m = await env.open();
    await call(m, 'sync', {});
    await env.shutdown(m);
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open({}, nested(env));
    const bytes = Buffer.from('stale outer copy');
    env.store.treeSet(TREE, 'a/b/inner.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
    const regions = (found: { incomplete?: Array<{ path: string; reason: string }> }) => (found.incomplete ?? []).map((r) => [r.path, r.reason]);
    // Beneath a scope, the nested directory is passed over by design.
    const whole = await call(m, 'grep', { path: 'work', pattern: 'stale' });
    assert.deepEqual(whole.results, []);
    assert.deepEqual(regions(whole), []);
    // Named, it's the answer to what was asked: its region names the holder.
    // A doubled separator is the same path, named in its one spelling.
    for (const [path, named, use] of [['work/a/b', 'work/a/b', 'deep'], ['work/a/b/inner.txt', 'work/a/b/inner.txt', 'deep/inner.txt'], ['work/a//b/inner.txt', 'work/a/b/inner.txt', 'deep/inner.txt']]) {
      const found = await call(m, 'grep', { path, pattern: 'stale' });
      assert.deepEqual(found.results, [], path);
      assert.deepEqual(regions(found), [[named, `it lies in mount "deep", nested in this one: use "${use}"`]], path);
    }
    // A file there the outer store doesn't hold is named too.
    env.writeDisk('a/b/other.txt', 'stale words');
    const unheld = await call(m, 'grep', { path: 'work/a/b/other.txt', pattern: 'stale' });
    assert.deepEqual(unheld.results, []);
    assert.deepEqual(regions(unheld), [['work/a/b/other.txt', 'it lies in mount "deep", nested in this one: use "deep/other.txt"']]);
  });

  test('every nested-mount check reads a path as disk access lands it: doubled and trailing separators and dot segments included', () => {
    for (const [path, inside] of [
      ['a/b', true], ['a/b/x', true], ['a//b/x', true], ['a/b/', true], ['./a/b/x', true], ['a/c/../b/x', true],
      ['a/b/../x', false], ['a/bc/x', false], ['a', false], ['', false],
    ] as const) assert.equal(inOtherMount(path, ['a/b']), inside, path);
  });

  test("a path into the nested directory is read in the outer mount's one spelling: a climb above the root and a separator after the mount's name are refused, and a `..` or a trailing separator names what it reaches", async (t) => {
    const env = new Env(t);
    env.writeDisk('a/x.txt', 'x');
    env.writeDisk('a/b/inner.txt', 'inner');
    const m = await env.open({}, nested(env));
    // A `..` with nothing before it to take back climbs above the root, even
    // where it comes back in by the mount directory's own name.
    assert.match(await refused(m, 'ls', { path: 'work/../work/a/b' }), /climbs above the root of mount "work"/);
    // A separator right after the mount's name would make the rest an absolute path.
    assert.match(await refused(m, 'ls', { path: 'work//a/b' }), /has a separator right after mount "work"/);
    // A `..` that takes back the nested directory's name names its parent.
    const listed = async (path: string) => (await call(m, 'ls', { path })).entries;
    assert.deepEqual(await listed('work/a/b/..'), await listed('work/a'));
    // A trailing separator names the directory itself.
    await call(m, 'write', { path: 'work/a/y.txt', content: 'y' });
    const withSlash = await call(m, 'materialize', { path: 'work/a/' });
    assert.deepEqual(withSlash.materialized, [{ mount: 'work', path: 'a/y.txt' }]);
    await call(m, 'write', { path: 'work/a/y.txt', content: 'y, again' });
    const plain = await call(m, 'materialize', { path: 'work/a' });
    assert.deepEqual(plain.materialized, withSlash.materialized);
    assert.deepEqual(Object.keys(plain).sort(), Object.keys(withSlash).sort());
    assert.equal(env.readDisk('a/b/inner.txt'), 'inner', "the nested mount's file is as it was");
  });

  test('a doubled or trailing separator is the nested directory too: a sync or a listing of it takes nothing in, and no push of the outer mount writes there', async (t) => {
    const env = new Env(t);
    env.writeDisk('top.txt', 'top');
    env.writeDisk('a/b/inner.txt', 'inner');
    const m = await env.open({}, nested(env));
    const nestedKeys = () => env.store.treeList(TREE).map((e: { path: string }) => e.path).filter((p: string) => inOtherMount(p, ['a/b']));
    for (const path of ['work/a//b', 'work/a/b/', 'work/a//b/inner.txt']) {
      const synced = await call(m, 'sync', { path });
      assert.equal(synced.totalSynced, 0, path);
      assert.deepEqual(nestedKeys(), [], `${path}: nothing of theirs taken in`);
      const listed = await call(m, 'ls', { path });
      assert.deepEqual(listed.entries, [], path);
    }
    // An outer copy spelled that way, as chronicle keeps it.
    const bytes = Buffer.from('outer copy');
    env.store.treeSet(TREE, 'a//b/inner.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
    await call(m, 'materialize', {});
    await m.materializeMount('work');
    assert.equal(env.readDisk('a/b/inner.txt'), 'inner', "the nested mount's file is as it was");
  });

  test("an outer copy in a nested mount's directory is passed over by design: no sync reports it incomplete, no count or bare materialize takes it up, and listings name its holder", async (t) => {
    const env = new Env(t);
    env.writeDisk('top.txt', 'top');
    env.writeDisk('a/b/inner.txt', 'inner');
    let m = await env.open();
    await call(m, 'sync', {});
    await env.shutdown(m);
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open({}, nested(env));
    const bytes = Buffer.from('stale outer copy');
    env.store.treeSet(TREE, 'a/b/inner.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
    // A conflict and a workspace deletion recorded there, as main's bug could leave them.
    const intents = (m as any).intents.get('work');
    intents.put('a/b/inner.txt', { conflict: { kind: 'both-changed', at: Date.now(), disk: null } });
    intents.put('a/b/gone.txt', { tombstone: { hash: 'f'.repeat(64) } });
    const bare = await call(m, 'sync', { mount: 'work' });
    assert.deepEqual(bare.incomplete ?? [], [], 'nothing incomplete: the sync looked everywhere it should');
    assert.deepEqual((bare.passedOver as Array<{ reason: string; count: number }>).filter((p) => p.reason === "another mount's directory").map((p) => p.count), [1]);
    const status = (await call(m, 'status', {})).work;
    assert.deepEqual([status.pendingChanges, status.conflicts, status.pendingWorkspaceDeletions], [0, 0, 0]);
    const pushed = await call(m, 'materialize', {});
    assert.equal(JSON.stringify(pushed).includes('a/b/'), false, JSON.stringify(pushed));
    assert.equal(env.readDisk('a/b/inner.txt'), 'inner');
    // A materialize naming an ancestor, forced, leaves it out too.
    const ancestor = await call(m, 'materialize', { path: 'work/a', force: true });
    assert.equal(JSON.stringify(ancestor).includes('a/b/'), false, JSON.stringify(ancestor));
    assert.equal(env.readDisk('a/b/inner.txt'), 'inner');
    // The copy stays in the outer branch's tree, and a listing shows it with its holder.
    assert.ok(env.store.treeGet(TREE, 'a/b/inner.txt'));
    const listed = await call(m, 'ls', { path: 'work', recursive: true });
    const entry = (listed.entries as Array<{ path: string; note?: string }>).find((e) => e.path === 'a/b/inner.txt');
    assert.equal(entry?.note, 'it lies in mount "deep", nested in this one: use "deep/inner.txt"');
    const globbed = await call(m, 'glob', { path: 'work', pattern: '**/*.txt' });
    const match = (globbed.matches as Array<{ path: string; note?: string }>).find((e) => e.path === 'work/a/b/inner.txt');
    assert.equal(match?.note, 'it lies in mount "deep", nested in this one: use "deep/inner.txt"');
  });

  test("a materialize naming a path in a nested mount's directory, however spelled, pushes nothing and names the holder", async (t) => {
    const env = new Env(t);
    env.writeDisk('a/b/inner.txt', 'inner');
    let m = await env.open();
    await call(m, 'sync', {});
    await env.shutdown(m);
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open({}, nested(env));
    const bytes = Buffer.from('outer copy');
    env.store.treeSet(TREE, 'a/b/inner.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
    for (const [path, use] of [['work/a/b', 'deep'], ['work/a/b/', 'deep'], ['work/a//b/inner.txt', 'deep/inner.txt'], ['work/a/b/inner.txt', 'deep/inner.txt']]) {
      const pushed = await call(m, 'materialize', { path, force: true });
      assert.deepEqual(pushed.materialized ?? [], [], path);
      assert.ok(JSON.stringify(pushed.skipped ?? []).includes(`use \\"${use}\\"`), `${path}: ${JSON.stringify(pushed)}`);
    }
    assert.equal(env.readDisk('a/b/inner.txt'), 'inner');
  });

  test('a mount configured with a relative path contains its own paths and its root, generated files included', async (t) => {
    const env = new Env(t);
    env.writeDisk('a/b/inner.txt', 'inner');
    env.writeDisk('top.txt', 'top');
    const rel = relative(process.cwd(), env.dir);
    assert.ok(!isAbsolute(rel), 'the test runs from somewhere the mount can be named relative to');
    const m = await env.open({}, { mounts: [
      { name: 'work', path: rel, mode: 'read-write', watch: 'never' },
      { name: 'deep', path: relative(process.cwd(), env.disk('a/b')), mode: 'read-write', watch: 'never' },
    ] });
    assert.match((await call(m, 'read', { path: 'work/top.txt' })).content, /top/);
    assert.ok((await call(m, 'ls', { path: 'work' })).entries.some((e: { name: string }) => e.name === 'top.txt'), 'the root lists');
    assert.deepEqual((await call(m, 'ls', { path: 'deep' })).entries.map((e: { name: string }) => e.name), ['inner.txt']);
    const said = await refused(m, 'read', { path: 'work/a/b/inner.txt' });
    assert.ok(said.includes('use "deep/inner.txt"'), said);
    m.registerGeneratedTextFile('work/generated.md', () => 'generated', 'resident');
    const generated = await m.handleToolCall({ id: 't', name: 'read', callerAgentName: 'resident', input: { path: 'work/generated.md' } });
    assert.equal(generated.success, true, generated.error);
    assert.match(JSON.stringify(generated.structured), /generated/);
  });

  test('the path a refusal names works on a mount whose root is configured with a trailing separator', async (t) => {
    const env = new Env(t);
    env.writeDisk('a/b/inner.txt', 'inner');
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir + '/', mode: 'read-write', watch: 'never' },
      { name: 'deep', path: env.disk('a/b') + '/', mode: 'read-write', watch: 'never' },
    ] });
    const said = await refused(m, 'read', { path: 'work/a/b' });
    assert.ok(said.includes('use "deep"'), said);
    const listed = await call(m, 'ls', { path: 'deep' });
    assert.deepEqual((listed.entries as Array<{ name: string }>).map((e) => e.name), ['inner.txt']);
    assert.match((await call(m, 'read', { path: 'deep/inner.txt' })).content, /inner/);
  });

  test('a path in a mount nested two deep is named by its innermost mount', async (t) => {
    const env = new Env(t);
    env.writeDisk('a/b/c/x.txt', 'x');
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never' },
      { name: 'deep', path: env.disk('a/b'), mode: 'read-write', watch: 'never' },
      { name: 'deeper', path: env.disk('a/b/c'), mode: 'read-write', watch: 'never' },
    ] });
    for (const path of ['work/a/b/c/x.txt', 'deep/c/x.txt']) {
      const said = await refused(m, 'read', { path });
      assert.ok(said.includes('mount "deeper"') && said.includes('"deeper/x.txt"'), `${path}: ${said}`);
    }
  });

  test("no push of the outer mount writes a path there that its store holds: a bare materialize leaves it out, and a named one says why, forced or not", async (t) => {
    const env = new Env(t);
    env.writeDisk('top.txt', 'top');
    env.writeDisk('a/b/inner.txt', 'inner');
    // The outer mount stored it before the inner one was configured.
    let m = await env.open();
    await call(m, 'sync', {});
    assert.ok(env.store.treeGet(TREE, 'a/b/inner.txt'));
    await env.shutdown(m);
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open({}, nested(env));
    // Its copy moves on, as a write through the outer mount once left it.
    const bytes = Buffer.from('outer copy');
    env.store.treeSet(TREE, 'a/b/inner.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
    const SKIPPED = 'a/b/inner.txt: it lies in mount "deep", nested in this one, which no push of this mount writes: use "deep/inner.txt"';
    const reasons = (pushed: { skipped?: Array<{ reason: string }> }) =>
      (pushed.skipped ?? []).map((x) => x.reason).filter((r) => r.startsWith('a/b/inner.txt'));
    // A bare materialize leaves it out: it isn't this mount's to push.
    const bare = await call(m, 'materialize', { mount: 'work' });
    assert.deepEqual(reasons(bare), []);
    // Named, the caller is told whose it is, forced or not.
    const forced = await call(m, 'materialize', { path: 'work/a/b/inner.txt', force: true });
    assert.deepEqual(reasons(forced), [SKIPPED]);
    // An undo's or a branch switch's push, forced over every tree path.
    const written = await m.materializeMount('work');
    assert.equal(written.some((p) => p.endsWith('a/b/inner.txt')), false);
    assert.equal(env.readDisk('a/b/inner.txt'), 'inner', "the inner mount's file is as it was");
  });

  test('a nested mount beneath a directory the ignore list covers is still another mount\'s directory to a sync that names a path', async (t) => {
    const env = new Env(t);
    env.writeDisk('vendor/own.txt', 'own');
    env.writeDisk('vendor/lib/x.txt', 'x');
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', ignore: ['vendor'] },
      { name: 'lib', path: env.disk('vendor/lib'), mode: 'read-write', watch: 'never' },
    ] });
    const OTHER = 'it lies in mount "lib", nested in this one, which no sync of this mount takes in: use "lib/x.txt"';
    const file = await call(m, 'sync', { path: 'work/vendor/lib/x.txt' });
    assert.equal(file.totalSynced, 0);
    assert.deepEqual((file.ignored as Array<{ note: string }>).map((i) => i.note), [OTHER]);
    // Naming the ignored directory takes in its own files (#276), and none of the nested mount's.
    await call(m, 'sync', { path: 'work/vendor' });
    const tree = env.store.treeList(TREE).map((e: { path: string }) => e.path).sort();
    assert.deepEqual(tree, ['vendor/own.txt']);
  });
});

describe('a named sync of a directory, beneath which a directory is passed over by design', () => {
  test('keeps a copy stored beneath the passed-over directory, whether that directory is there or gone', async (t) => {
    const env = new Env(t);
    env.writeDisk('src/main.txt', 'main');
    env.writeDisk('src/cache/x', 'v1');
    const m = await env.open({ ignore: ['cache'] });
    await call(m, 'sync', { path: 'work/src/cache/x' });
    const v1 = env.store.treeGet(TREE, 'src/cache/x')?.blobHash;
    assert.ok(v1, 'a sync naming the file stores it (#276)');
    env.writeDisk('src/cache/x', 'v2');
    await call(m, 'sync', { path: 'work/src' });
    assert.equal(env.store.treeGet(TREE, 'src/cache/x')?.blobHash, v1, 'present and changed: unobserved');
    rmSync(env.disk('src/cache'), { recursive: true, force: true });
    await call(m, 'sync', { path: 'work/src' });
    assert.equal(env.store.treeGet(TREE, 'src/cache/x')?.blobHash, v1, 'gone: still unobserved, not taken as deleted');
    // Naming the passed-over directory itself takes in what's there, as #276 has it.
    await call(m, 'sync', { path: 'work/src/cache' });
    assert.equal(env.store.treeGet(TREE, 'src/cache/x'), null, 'a sync naming it takes its deletion');
  });
});

describe('a copy stored beneath a directory passed over by design', () => {
  for (const [kind, ignore, dir, reason] of [
    ['the ignore list covers', ['cache/**'], 'cache', 'ignored by the mount'],
    ["with an editor's name", [], 'drafts~', EDITOR],
  ] as const) {
    test(`is unobserved there, and stays when it is deleted on disk, since no walk lists that directory (${kind})`, async (t) => {
      const env = new Env(t);
      env.writeDisk(`${dir}/x`, 'v1');
      const m = await env.open({ ignore: [...ignore] });
      await call(m, 'sync', { path: `work/${dir}/x` });
      const v1 = env.store.treeGet(TREE, `${dir}/x`)?.blobHash;
      assert.ok(v1, 'a named sync stores it');
      env.writeDisk(`${dir}/x`, 'v2');
      const bare = await call(m, 'sync', {});
      assert.deepEqual((bare.incomplete as Array<{ path: string; reason: string }>).map(({ path, reason }) => [path, reason]), [[dir, reason]]);
      assert.equal((await listing(m)).get(`${dir}/x`)?.state, 'unverified');
      assert.equal(env.store.treeGet(TREE, `${dir}/x`)?.blobHash, v1, 'a change on disk is passed over');
      // A grep that names the file reaches it by its path, and still takes
      // nothing in: what the mount passes over by design stays unobserved,
      // however a pass reaches it.
      await call(m, 'grep', { pattern: 'v', path: `work/${dir}/x` });
      assert.equal(env.store.treeGet(TREE, `${dir}/x`)?.blobHash, v1, 'nor by a grep naming it');
      env.rmDisk(`${dir}/x`);
      await call(m, 'sync', {});
      assert.ok(env.store.treeGet(TREE, `${dir}/x`), 'a sync without a path leaves it as it was');
      // With the directory itself gone, the root's listing would prove the
      // copy absent, but the mount passes over that directory by design.
      rmSync(env.disk(dir), { recursive: true, force: true });
      await call(m, 'sync', {});
      assert.ok(env.store.treeGet(TREE, `${dir}/x`), 'and so does one after the directory is gone');
    });
  }
});

describe("an editor's save by rename, with the watcher running", () => {
  test('reaches a wake as a change, not a deletion, when the new copy is written at once, and the new file goes on being watched', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    // A short debounce, so a pass can run soon after the rename.
    const m = await env.open({ watch: 'always', watchDebounceMs: 50 });
    const mount = (m as any).mounts.get('work');
    const blob = () => env.store.treeGet(TREE, 'gate.json')?.blobHash;
    await until(() => !!mount.watcherReadyAt && blob() !== undefined, 'the watcher is ready and the catch-up scan took gate.json');
    await watchersFlow(m, { work: env.dir });
    const v1 = blob();
    env.events.length = 0;

    // vim's save with a backup: the old file moves aside, the new one is
    // written in its place, and the backup is removed.
    renameSync(env.disk('gate.json'), env.disk('gate.json~'));
    env.writeDisk('gate.json', 'v2');
    unlinkSync(env.disk('gate.json~'));
    const named = (type: string, path: string) => env.events.some((e: any) => e.type === type && e.paths?.includes(path));
    await until(() => blob() !== v1 && named('workspace:modified', 'work/gate.json'), 'the save is taken in, as a change');
    // The watcher passes over the backup by its name, and the until above has seen a batch carrying gate.json
    // handled. A probe written now, and the mount's turn after it, cover any further batch delivered before the
    // probe's and any pass queued before its own, so the checks below see what the save has led to by then.
    await watchersFlow(m, { work: env.dir });
    await (m as any).mountTurns.get('work');
    assert.ok(!named('workspace:deleted', 'work/gate.json'), 'no wake sees a deletion');
    assert.ok(!env.events.some((e: any) => e.paths?.includes('work/gate.json~')), 'nor the backup');
    assert.equal(env.store.treeGet(TREE, 'gate.json~'), null);

    const v2 = blob();
    env.writeDisk('gate.json', 'v3');
    await until(() => blob() !== undefined && blob() !== v2, 'a later edit of the new file is taken in');
  });
});

describe('the catch-up pass at start', () => {
  /**
   * Run `fn` with chokidar's own directory reads (chokidar's and readdirp's) made to wait first, as `wait` says.
   * `reads.delayed` counts the reads that waited, so a test can show the delay reached chokidar.
   */
  async function withChokidarReaddir<T>(wait: () => Promise<void>, fn: (reads: { delayed: number }) => Promise<T>): Promise<T> {
    const fromChokidar = () => /node_modules\/(chokidar|readdirp)\//.test(new Error().stack ?? '');
    const reads = { delayed: 0 };
    return withFsPromises('readdir', (original) => async function (this: unknown, ...args: any[]) {
      if (fromChokidar()) {
        reads.delayed++;
        await wait();
      }
      return original.apply(this, args);
    }, () => fn(reads));
  }
  /** A wait that ends when `open` is called. */
  const gate = () => {
    let isOpen = false;
    let release!: () => void;
    const opened = new Promise<void>((r) => { release = r; });
    const g = {
      held: 0,
      wait: () => { if (!isOpen) g.held++; return opened; },
      open: () => { isOpen = true; release(); },
    };
    return g;
  };
  const storedText = (env: Env, f: string) => {
    const e = env.store.treeGet(TREE, f);
    return e ? env.store.getBlob(e.blobHash)?.toString('utf8') : undefined;
  };
  /** Counts the catch-up passes `m` starts, from before it starts. */
  const countPasses = (m: WorkspaceModule) => {
    const counted = { passes: 0 };
    const initialScan = (m as any).initialScan.bind(m);
    (m as any).initialScan = (name: string) => { counted.passes++; return initialScan(name); };
    return counted;
  };
  /** For each catch-up pass `m` starts from now on, its mount's `watcherReadyAt` as the pass starts: null before any ready. */
  const readyAtPasses = (m: WorkspaceModule) => {
    const readyAt: Array<number | null> = [];
    const initialScan = (m as any).initialScan.bind(m);
    (m as any).initialScan = (name: string) => {
      readyAt.push((m as any).mounts.get(name)?.watcherReadyAt ?? null);
      return initialScan(name);
    };
    return readyAt;
  };
  const passesEnded = (m: WorkspaceModule) => {
    const started: Promise<unknown>[] = [];
    const initialScan = (m as any).initialScan.bind(m);
    (m as any).initialScan = (name: string) => {
      const pass = initialScan(name);
      started.push(pass);
      return pass;
    };
    return async () => {
      for (let seen = -1; seen !== started.length;) {
        seen = started.length;
        await new Promise((r) => setTimeout(r, 0));
        await Promise.allSettled(started);
      }
    };
  };
  const ctxFor = (env: Env) => ({
    isRestart: false,
    getState: () => null,
    setState: () => {},
    pushEvent: (e: ProcessEvent) => env.events.push(e),
  } as unknown as ModuleContext);
  /** Let real time pass while setTimeout may be mocked. */
  const elapse = async (ms: number) => {
    for (const end = performance.now() + ms; performance.now() < end;) await new Promise((r) => setImmediate(r));
  };
  const reattached = (env: Env) => env.events.some((e) => e.type === 'workspace:watcher-reattached');
  /**
   * Asserts the passes counted once the watcher is ready: `expected` with no re-attach, and at most one more for each
   * re-attach the watcher reports, since a re-attached watcher's ready runs its own pass (here always long before its
   * own bound). A watcher can re-attach just after its first ready. On macOS, by libuv's src/unix/fsevents.c, an
   * FSEvents event for the watched directory itself, when it carries no modification flags, reaches fs.watch as a
   * rename under the directory's own name, and there, holding no root, the watcher re-attaches at any rename named
   * like its root.
   */
  const assertPassesOnceReady = (env: Env, passes: number, expected: number) => {
    const reattaches = env.events.filter((e) => e.type === 'workspace:watcher-reattached').length;
    assert.ok(passes >= expected && passes <= expected + reattaches,
      `expected ${expected} passes, and at most one more per re-attach; got ${passes} with ${reattaches} re-attaches`);
  };

  // On macOS a write made right after ready can fall before libuv's FSEventStream exists and go unreported until a
  // later change in its directory, which this change doesn't close, so the two tests that write then and wait for
  // the watcher run on Linux.
  test("starts once the watcher is ready, so a change made after the pass took a file in reaches the store while chokidar's scan is held behind any pass started beside it", { skip: process.platform !== 'linux' }, async (t) => {
    const env = new Env(t);
    for (let i = 0; i < 20; i++) env.writeDisk(`d${i % 4}/f${i}.txt`, 'v1');
    const scan = gate();
    let gaveUp = false;
    const heldAtMost = new Promise<void>((r) => setTimeout(() => { gaveUp = true; r(); }, 15_000).unref());
    await withChokidarReaddir(() => Promise.race([scan.wait(), heldAtMost]), async () => {
      let readyAt: Array<number | null> = [];
      let ended: () => Promise<unknown> = async () => {};
      await env.open({ watch: 'always', watchDebounceMs: 50 }, {}, (m) => { readyAt = readyAtPasses(m); ended = passesEnded(m); });
      await until(() => scan.held > 0, "some of chokidar's directory reads waited at the closed gate", 15_000);
      await ended();
      scan.open();
      assert.equal(gaveUp, false, 'the start returned, and the passes it started ended, while chokidar was held');
      await until(() => storedText(env, 'd0/f0.txt') === 'v1', 'the catch-up pass took d0/f0.txt in', 15_000);
      assert.ok(readyAt.length > 0 && readyAt.every((at) => at !== null),
        `each catch-up pass started once the watcher was ready (its watcherReadyAt as each started: ${JSON.stringify(readyAt)})`);
      env.writeDisk('d0/f0.txt', 'v2');
      await until(() => storedText(env, 'd0/f0.txt') === 'v2', 'the change made after the pass reached the store', 10_000);
    });
  });

  test('a re-attached watcher runs its pass at its own ready, so a change after that pass reaches the store', { skip: process.platform !== 'linux' }, async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    // The root poll is past the test's deadline, so only the re-attach below happens.
    const m = await env.open({ watch: 'always', watchDebounceMs: 50, watchRootPollMs: 60_000 });
    const mount = (m as any).mounts.get('work');
    await until(() => !!mount.watcherReadyAt && storedText(env, 'gate.json') === 'v1', 'the first pass took gate.json in');
    const firstReadyAt: number = mount.watcherReadyAt;
    const readyAt = readyAtPasses(m);
    const ended = passesEnded(m);
    const scan = gate();
    let gaveUp = false;
    const heldAtMost = new Promise<void>((r) => setTimeout(() => { gaveUp = true; r(); }, 15_000).unref());
    for (; Date.now() <= firstReadyAt;) await new Promise((r) => setImmediate(r));
    await withChokidarReaddir(() => Promise.race([scan.wait(), heldAtMost]), async () => {
      const reattaching: Promise<void> = (m as any).watchers.get('work').reattach();
      // chokidar's close removes its listeners first, so once reattach() has begun closing the old instance, no
      // watcher reports this write.
      env.writeDisk('gate.json', 'v2');
      await reattaching;
      await until(() => scan.held > 0, "some of chokidar's directory reads waited at the closed gate", 15_000);
      await ended();
      scan.open();
      assert.equal(gaveUp, false, 'the re-attach returned, and the passes started since ended, while chokidar was held');
      await until(() => reattached(env), 'the watcher re-attached');
      await until(() => storedText(env, 'gate.json') === 'v2', 'gate.json\'s v2 was taken in', 15_000);
      // The re-attach leaves watcherReadyAt as the first ready set it, until the re-attached watcher's own ready.
      assert.ok(readyAt.length > 0 && readyAt.every((at) => at !== null && at !== firstReadyAt),
        `the re-attached watcher's pass started at its own ready (first ready ${firstReadyAt}; watcherReadyAt as each pass started: ${JSON.stringify(readyAt)})`);
      env.writeDisk('gate.json', 'v3');
      await until(() => storedText(env, 'gate.json') === 'v3', "the change made after the re-attach reached the store", 15_000);
    });
  });

  test('starts at the bound when the watcher is not ready by then, and again at the ready that comes later', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    const scan = gate();
    await withChokidarReaddir(scan.wait, async () => {
      let counted = { passes: 0 };
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const m = await env.open({ watch: 'always', watchDebounceMs: 50 }, {}, (m) => { counted = countPasses(m); });
        await elapse(200);
        assert.equal(counted.passes, 0, 'no pass before the watcher is ready or the bound comes');
        t.mock.timers.tick(29_999);
        assert.equal(counted.passes, 0, 'no pass a millisecond before the bound');
        t.mock.timers.tick(1);
        assert.equal(counted.passes, 1, 'a pass at the bound');
        t.mock.timers.reset();
        await until(() => storedText(env, 'gate.json') === 'v1', "the bound's pass took gate.json in");
        // chokidar's scan ends: its ready runs the pass again, for what changed while the first ran beside the scan.
        scan.open();
        const mount = (m as any).mounts.get('work');
        await until(() => !!mount.watcherReadyAt, 'the watcher became ready');
        // Counted a little after ready, so a second pass the same ready started late would show.
        await elapse(200);
        assertPassesOnceReady(env, counted.passes, 2);
      } finally {
        t.mock.timers.reset();
      }
    });
  });

  test("an error before ready doesn't start the pass; the watcher's ready does", async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    const scan = gate();
    await withChokidarReaddir(scan.wait, async () => {
      let counted = { passes: 0 };
      const m = await env.open({ watch: 'always', watchDebounceMs: 50 }, {}, (m) => { counted = countPasses(m); });
      // An error chokidar reports while its scan goes on, sent as chokidar's own 'error' event.
      (m as any).watchers.get('work').watcher.emit('error', Object.assign(new Error("EACCES: permission denied, scandir 'sub'"), { code: 'EACCES' }));
      assert.ok(env.events.some((e) => e.type === 'workspace:watcher-error'), 'the error was reported');
      // With the scan still held, a pass the error scheduled for later would show here.
      await elapse(100);
      assert.equal(counted.passes, 0, 'no pass at the error');
      scan.open();
      const mount = (m as any).mounts.get('work');
      await until(() => !!mount.watcherReadyAt && storedText(env, 'gate.json') === 'v1', 'the pass ran at ready');
      await elapse(200);
      assertPassesOnceReady(env, counted.passes, 1);
    });
  });

  test("a watcher re-attached just after its ready runs one more pass, which the count allows", async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    let counted = { passes: 0 };
    const m = await env.open({ watch: 'always', watchDebounceMs: 50 }, {}, (m) => { counted = countPasses(m); });
    const mount = (m as any).mounts.get('work');
    await until(() => !!mount.watcherReadyAt && storedText(env, 'gate.json') === 'v1', 'the pass ran at ready');
    // The watcher re-attaches, as it does on macOS, where it holds no root, at the rename an FSEvents event on the root
    // itself arrives as.
    await (m as any).watchers.get('work').reattach();
    await until(() => counted.passes >= 2, "the re-attached watcher's ready ran its pass");
    await elapse(200);
    assert.ok(reattached(env), 'the watcher re-attached');
    assertPassesOnceReady(env, counted.passes, 1);
  });

  test('a re-attach before the first ready restarts the bound, so the new watcher gets its own', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    // No chokidar scan ends here, so neither watcher becomes ready, and the root poll (an interval, not mocked) finds
    // the replaced root. The old root is moved aside, not removed, so the new one can't take its inode: the first
    // watcher's scan never reached the root's own watch, so no rename event would tell it.
    await withChokidarReaddir(() => new Promise(() => {}), async (reads) => {
      let counted = { passes: 0 };
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        await env.open({ watch: 'always', watchDebounceMs: 50, watchRootPollMs: 50 }, {}, (m) => { counted = countPasses(m); });
        // The root is replaced only once the first watcher's scan is held at its first read. Before that, chokidar's
        // stat of the root could land between the rename and the mkdir, and chokidar becomes ready at once on that
        // error, which would start a pass here.
        for (const end = performance.now() + 10_000; reads.delayed === 0 && performance.now() < end;) await elapse(5);
        assert.ok(reads.delayed > 0, "the first watcher's scan reached its held read");
        t.mock.timers.tick(20_000);
        renameSync(env.dir, `${env.dir}.old`);
        mkdirSync(env.dir, { recursive: true });
        for (const end = performance.now() + 10_000; !reattached(env) && performance.now() < end;) await elapse(25);
        assert.ok(reattached(env), 'the watcher re-attached');
        t.mock.timers.tick(10_000);
        assert.equal(counted.passes, 0, "no pass at the first watcher's bound");
        t.mock.timers.tick(19_999);
        assert.equal(counted.passes, 0, "no pass a millisecond before the re-attached watcher's bound");
        t.mock.timers.tick(1);
        assert.equal(counted.passes, 1, "a pass at the re-attached watcher's bound");
      } finally {
        t.mock.timers.reset();
      }
    });
  });

  test('a module stopping before its watcher is ready starts no pass at the bound, during the stop or after it', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    await withChokidarReaddir(() => new Promise(() => {}), async () => {
      let counted = { passes: 0 };
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const m = await env.open({ watch: 'always', watchDebounceMs: 50 }, {}, (m) => { counted = countPasses(m); });
        // The bound comes while stop() waits on the watcher's own stop.
        const stopping = m.stop();
        t.mock.timers.tick(30_000);
        await stopping;
        t.mock.timers.tick(30_000);
        assert.equal(counted.passes, 0, 'no pass while the module stopped, or after');
      } finally {
        t.mock.timers.reset();
      }
    });
  });

  test("a module started again before its first watcher is ready runs only the new watcher's pass", async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', 'v1');
    await withChokidarReaddir(() => new Promise(() => {}), async () => {
      let counted = { passes: 0 };
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const m = await env.open({ watch: 'always', watchDebounceMs: 50 }, {}, (m) => { counted = countPasses(m); });
        await m.stop();
        await m.start(ctxFor(env));
        t.mock.timers.tick(30_000);
        assert.equal(counted.passes, 1, "the old watcher's bound starts no pass, the new one's does");
      } finally {
        t.mock.timers.reset();
      }
    });
  });
});

describe("a file's mode is kept with its bytes", () => {
  const modeOf = (env: Env, f: string) => statSync(env.disk(f)).mode & 0o777;
  const storedMode = (env: Env, f: string) => env.store.treeGet(TREE, f)?.mode;

  test('a file taken in records its mode, and a file the workspace writes again gets it back, whatever the umask', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('run.sh', '#!/bin/sh\necho hi\n');
    chmodSync(env.disk('run.sh'), 0o755);
    env.writeDisk('secret.txt', 'token');
    chmodSync(env.disk('secret.txt'), 0o600);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'run.sh'), 0o100755);
    assert.equal(storedMode(env, 'secret.txt'), 0o100600);
    await call(m, 'write', { path: 'work/run.sh', content: '#!/bin/sh\necho hello\n' });
    assert.equal(storedMode(env, 'run.sh'), 0o100755, 'an overwrite keeps the mode, as an edit does');

    // Under a umask that would mask each of them: 022 leaves secret.txt
    // readable by others, and 077 takes run.sh's execute bits for the group
    // and others.
    for (const mask of [0o022, 0o077]) {
      env.rmDisk('run.sh');
      env.rmDisk('secret.txt');
      const umask = process.umask(mask);
      try {
        for (const f of ['run.sh', 'secret.txt']) await call(m, 'materialize', { path: `work/${f}`, force: true });
      } finally {
        process.umask(umask);
      }
      assert.equal(modeOf(env, 'run.sh'), 0o755, `umask ${mask.toString(8)}`);
      assert.equal(modeOf(env, 'secret.txt'), 0o600, `umask ${mask.toString(8)}`);
    }
  });

  test("writeBinary's overwrite keeps the file's mode, as the write tool's does", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('run.sh', 'echo run\n');
    chmodSync(env.disk('run.sh'), 0o755);
    await call(m, 'sync', {});
    assert.equal((await m.writeBinary('work/run.sh', Buffer.from('echo run v2\n'), 'text/x-sh')).success, true);
    assert.equal(storedMode(env, 'run.sh'), 0o100755);
  });

  test("with evidence agreeing with neither side's mode, disk's is taken in: an unknown never moves disk", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('w.sh', 'echo w\n');
    chmodSync(env.disk('w.sh'), 0o644);
    await call(m, 'sync', {});
    // The store at 0o755, the evidence at 0o600, disk at 0o644: as an older
    // version that kept the entry's mode through an edit and re-created the
    // file at 0o644 leaves them.
    const e = env.store.treeGet(TREE, 'w.sh')!;
    env.store.treeSet(TREE, 'w.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
    const agreement = (m as any).agreement as DiskAgreement;
    agreement.set('work', 'w.sh', { kind: 'content', hash: e.blobHash, size: e.size, mode: 0o600 });
    agreement.barrier();
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'w.sh'), 0o100644);
    assert.equal(modeOf(env, 'w.sh'), 0o644);
  });

  test("a forced materialize over bytes and a mode disk changed gives the file the store's", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('f.sh', 'echo f\n');
    chmodSync(env.disk('f.sh'), 0o755);
    await call(m, 'sync', {});
    env.writeDisk('f.sh', 'echo changed on disk\n');
    chmodSync(env.disk('f.sh'), 0o644);
    await call(m, 'materialize', { path: 'work/f.sh', force: true });
    assert.equal(env.readDisk('f.sh'), 'echo f\n');
    assert.equal(modeOf(env, 'f.sh'), 0o755);
  });

  test('a file re-created by a branch switch gets its mode back, though the evidence never rewinds', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('b.sh', 'echo b\n');
    chmodSync(env.disk('b.sh'), 0o750);
    await call(m, 'sync', {});
    const main = env.store.currentBranch().name;
    env.store.createBranch('with-b', main);
    await call(m, 'delete', { path: 'work/b.sh' });
    await call(m, 'materialize', { applyDeletions: true });
    assert.equal(existsSync(env.disk('b.sh')), false);

    env.store.switchBranch('with-b');
    await m.materializeMount('work');
    assert.equal(env.readDisk('b.sh'), 'echo b\n');
    assert.equal(modeOf(env, 'b.sh'), 0o750);
  });

  /** A push of `paths` whose `beforeEffect` runs between planning and each effect. */
  async function pushModes(env: Env, m: WorkspaceModule, paths: string[], opts: Parameters<typeof pushPaths>[4]) {
    const mount = (m as any).mounts.get('work');
    return pushPaths(env.store, (m as any).agreement, await (m as any).runtime(mount), paths, opts);
  }

  /** The store at 0o755 and disk with its evidence at 0o644, on the same bytes: a push applies the store's mode. */
  async function owedMode(env: Env, m: WorkspaceModule, f: string): Promise<void> {
    env.writeDisk(f, 'echo owed\n');
    chmodSync(env.disk(f), 0o644);
    await call(m, 'sync', {});
    const e = env.store.treeGet(TREE, f)!;
    env.store.treeSet(TREE, f, { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
  }

  test("a mode disk changes between a push's planning and its chmod is kept, and taken in by the next sync", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await owedMode(env, m, 'x.sh');
    const pushed = await pushModes(env, m, ['x.sh'], { beforeEffect: () => chmodSync(env.disk('x.sh'), 0o600) });
    assert.equal(modeOf(env, 'x.sh'), 0o600);
    assert.deepEqual(pushed.written, []);
    assert.match(pushed.skipped.map((x) => x.reason).join(' | '), /mode changed since it was checked/);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'x.sh'), 0o100600);

    // A write that carries the store's mode leaves a mode changed in the
    // gap too: its bytes land, and the evidence keeps the mode disk agreed.
    await owedMode(env, m, 'w.sh');
    await call(m, 'write', { path: 'work/w.sh', content: 'echo new bytes\n' });
    const written = await pushModes(env, m, ['w.sh'], { beforeEffect: () => chmodSync(env.disk('w.sh'), 0o600) });
    assert.deepEqual(written.written, ['w.sh']);
    assert.equal(env.readDisk('w.sh'), 'echo new bytes\n');
    assert.equal(modeOf(env, 'w.sh'), 0o600);
    assert.equal((m as any).agreement.get('work', 'w.sh')?.mode, 0o644, 'the evidence records the mode disk agreed, not the one the push asked for');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'w.sh'), 0o100600);
  });

  test("a write whose file was given setgid since planning drops it before the bytes and keeps the person's permission bits", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const full = (f: string) => statSync(env.disk(f)).mode & 0o7777;
    await owedMode(env, m, 's.sh');
    await call(m, 'write', { path: 'work/s.sh', content: 'echo new bytes\n' });
    // setgid without group execute, which a write on Linux leaves, so only
    // the drop takes it away.
    const pushed = await pushModes(env, m, ['s.sh'], { beforeEffect: () => chmodSync(env.disk('s.sh'), 0o2700) });
    assert.deepEqual(pushed.written, ['s.sh']);
    assert.equal(env.readDisk('s.sh'), 'echo new bytes\n');
    assert.equal(full('s.sh'), 0o700, "setgid gone before the bytes; the person's 0o700 stays, as the guard keeps a mode set since planning");
  });

  test('a mode-only push refuses a file whose bytes changed, or that became a link or a directory, after planning, and says what gets past it', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await owedMode(env, m, 'y.sh');
    let pushed = await pushModes(env, m, ['y.sh'], { beforeEffect: () => writeFileSync(env.disk('y.sh'), 'changed\n') });
    assert.equal(modeOf(env, 'y.sh'), 0o644, 'changed bytes: refused');
    assert.deepEqual(pushed.written, []);

    await owedMode(env, m, 'z.sh');
    const outside = join(env.root, 'outside.sh');
    writeFileSync(outside, 'outside\n');
    chmodSync(outside, 0o600);
    pushed = await pushModes(env, m, ['z.sh'], { beforeEffect: () => { rmSync(env.disk('z.sh')); symlinkSync(outside, env.disk('z.sh')); } });
    assert.equal(statSync(outside).mode & 0o777, 0o600, 'a link swapped in: its target is untouched');
    assert.deepEqual(pushed.written, []);
    assert.deepEqual(pushed.skipped.map((x) => x.reason), [
      "not given the workspace's mode: a symlink, which this mount does not follow — materializing again won't change that; "
        + 'whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere',
    ]);

    await owedMode(env, m, 'd.sh');
    pushed = await pushModes(env, m, ['d.sh'], { beforeEffect: () => { rmSync(env.disk('d.sh')); mkdirSync(env.disk('d.sh')); } });
    assert.deepEqual(pushed.written, []);
    assert.deepEqual(pushed.skipped.map((x) => x.reason), [
      "not given the workspace's mode: not a regular file — materializing again won't change that; "
        + 'whoever runs this host can put a regular file there, and materializing again then gets past it',
    ]);
  });

  test("a private file's bytes are never written at a wider mode, and a widening comes after the bytes", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('secret.txt', 'token');
    chmodSync(env.disk('secret.txt'), 0o600);
    env.writeDisk('grow.sh', 'echo grow\n');
    chmodSync(env.disk('grow.sh'), 0o644);
    await call(m, 'sync', {});
    env.rmDisk('secret.txt');
    await call(m, 'write', { path: 'work/grow.sh', content: 'echo grown\n' });
    const e = env.store.treeGet(TREE, 'grow.sh')!;
    env.store.treeSet(TREE, 'grow.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });

    // The mode each file has when its bytes are written.
    const seen: number[] = [];
    const handle = await open(env.disk('grow.sh'), 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const writeFile = proto.writeFile;
    proto.writeFile = async function (this: any, ...args: unknown[]) {
      seen.push(Number((await this.stat()).mode & 0o777));
      return writeFile.apply(this, args);
    };
    try {
      await call(m, 'materialize', { path: 'work/secret.txt', force: true });
      await call(m, 'materialize', { path: 'work/grow.sh' });
    } finally {
      proto.writeFile = writeFile;
    }
    assert.deepEqual(seen, [0o600, 0o644], 'the new private file had its mode before its bytes; the widened one got its bytes first');
    assert.equal(modeOf(env, 'secret.txt'), 0o600);
    assert.equal(modeOf(env, 'grow.sh'), 0o755);
  });

  test("a push stopped after a file's bytes, before its mode, applies the mode when it's run again", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    // 0o640 to 0o604: the bits it removes go before the bytes, the ones it adds after.
    env.writeDisk('mixed.txt', 'v1');
    chmodSync(env.disk('mixed.txt'), 0o640);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/mixed.txt', content: 'v2' });
    const e = env.store.treeGet(TREE, 'mixed.txt')!;
    env.store.treeSet(TREE, 'mixed.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100604 });

    // The second chmod, after the bytes, fails as a stop there would leave it.
    const handle = await open(env.disk('mixed.txt'), 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const chmod = proto.chmod;
    let calls = 0;
    proto.chmod = async function (this: any, ...args: unknown[]) {
      if (++calls === 2) throw new Error('stopped');
      return chmod.apply(this, args);
    };
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      proto.chmod = chmod;
    }
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o600, 'the bytes landed at the narrower mode');

    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o604, 'run again, the push completes with the mode');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'and the store keeps it');
  });

  /**
   * Makes the `nth` call of a FileHandle method throw, on whichever file
   * makes it, as a stop there would leave the push: each test that uses it
   * pushes one file, so the stop is that file's. Returns what puts it back.
   */
  async function stopAt(method: 'stat' | 'chmod' | 'truncate' | 'sync', nth: number): Promise<() => void> {
    // Any file will do: it's opened only to reach FileHandle's prototype.
    const handle = await open(process.execPath, 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const original = proto[method];
    let calls = 0;
    proto[method] = async function (this: any, ...args: unknown[]) {
      if (++calls === nth) throw new Error('stopped');
      return original.apply(this, args);
    };
    return () => { proto[method] = original; };
  }

  /**
   * Makes every FileHandle chmod refused, as the kernel refuses one on
   * another user's file (EPERM). Returns what puts it back.
   */
  async function refuseChmod(code: 'EPERM' | 'EACCES' = 'EPERM'): Promise<() => void> {
    const handle = await open(process.execPath, 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const original = proto.chmod;
    proto.chmod = async function () {
      throw Object.assign(new Error(`${code}: refused, fchmod`), { code });
    };
    return () => { proto.chmod = original; };
  }

  /** A file at 0o640 on disk and in the store, with new bytes owed at 0o604: the push narrows to 0o600 before the bytes. */
  async function narrowingPush(env: Env, m: WorkspaceModule, f: string): Promise<void> {
    env.writeDisk(f, 'v1');
    chmodSync(env.disk(f), 0o640);
    await call(m, 'sync', {});
    await call(m, 'write', { path: `work/${f}`, content: 'v2' });
    const e = env.store.treeGet(TREE, f)!;
    env.store.treeSet(TREE, f, { blobHash: e.blobHash, size: e.size, mode: 0o100604 });
  }

  const storedText = (env: Env, f: string) => env.store.getBlob(env.store.treeGet(TREE, f)!.blobHash)?.toString('utf8');

  /** Sets a file's mode just after a write's bytes go in, as another process could. Returns what puts writeFile back. */
  async function chmodDuringWrite(env: Env, f: string, mode: number): Promise<() => void> {
    const handle = await open(process.execPath, 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const writeFile = proto.writeFile;
    proto.writeFile = async function (this: any, ...args: unknown[]) {
      const r = await writeFile.apply(this, args);
      chmodSync(env.disk(f), mode);
      return r;
    };
    return () => { proto.writeFile = writeFile; };
  }

  test('where modes go unobserved, a push that creates a file gives it no mode from the store', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('c.txt', 'v1');
    chmodSync(env.disk('c.txt'), 0o600);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'c.txt'), 0o100600, 'a POSIX host recorded the mode');
    (m as any).modesObserved = false;
    rmSync(env.disk('c.txt'));
    const umask = process.umask(0o022);
    try {
      await call(m, 'materialize', { path: 'work/c.txt', force: true });
    } finally {
      process.umask(umask);
    }
    assert.equal(env.readDisk('c.txt'), 'v1');
    assert.equal(modeOf(env, 'c.txt'), 0o644, 'created as a file is without a mode, under the umask');
    assert.equal(storedMode(env, 'c.txt'), 0o100600, 'and the store keeps its mode');
  });

  // An entry from before the evidence that disk lacks: only a push naming it writes it, creating the file.
  for (const force of [true, false]) {
    test(`${force ? 'a forced' : 'an unforced'} push that creates its file, whose mode is set while its bytes go in, ${force ? "ends at the store's mode" : 'keeps the mode set then'}`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      const bytes = Buffer.from('fresh');
      env.store.treeSet(TREE, 'u.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o100600 });
      const restore = await chmodDuringWrite(env, 'u.txt', 0o644);
      try {
        const pushed = await pushModes(env, m, ['u.txt'], { named: true, ...(force ? { force: true } : {}) });
        assert.deepEqual(pushed.written, ['u.txt']);
      } finally {
        restore();
      }
      assert.equal(env.readDisk('u.txt'), 'fresh');
      assert.equal(modeOf(env, 'u.txt'), force ? 0o600 : 0o644);
    });
  }

  test("a refused chmod to the store's mode for a file a forced push creates, with no mode owed when it planned, names the store's mode", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('g.txt', 'v1');
    chmodSync(env.disk('g.txt'), 0o664);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/g.txt', content: 'v2' });
    const umask = process.umask(0o022);
    const restore = await refuseChmod();
    let pushed: Awaited<ReturnType<typeof pushModes>>;
    try {
      pushed = await pushModes(env, m, ['g.txt'], { force: true, beforeEffect: () => rmSync(env.disk('g.txt')) });
    } finally {
      restore();
      process.umask(umask);
    }
    assert.deepEqual(pushed.written, ['g.txt']);
    assert.equal(modeOf(env, 'g.txt'), 0o644, 'created under the umask, the chmod refused');
    assert.deepEqual(pushed.modesKept.map((k) => k.reason), [
      "written, its mode left at 0644: the kernel refused the chmod, so the workspace's (0664) isn't given, and a sync takes disk's mode in",
    ]);
  });

  // 0o664 is one the umask narrows at creation, so the file is given it exactly.
  for (const mode of [0o600, 0o664]) {
    test(`a forced push that finds the file removed since its planning creates it at the store's mode, ${mode.toString(8)}, though disk had that mode when it planned`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      env.writeDisk('p.txt', 'private v1');
      chmodSync(env.disk('p.txt'), mode);
      await call(m, 'sync', {});
      await call(m, 'write', { path: 'work/p.txt', content: 'private v2' });
      const umask = process.umask(0o022);
      try {
        const pushed = await pushModes(env, m, ['p.txt'], { force: true, beforeEffect: () => rmSync(env.disk('p.txt')) });
        assert.deepEqual(pushed.written, ['p.txt']);
      } finally {
        process.umask(umask);
      }
      assert.equal(env.readDisk('p.txt'), 'private v2');
      assert.equal(modeOf(env, 'p.txt'), mode);
    });
  }

  test("a forced push over a stale copy that finds the file removed since its planning creates it at the store's mode", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('q.txt', 'v1');
    chmodSync(env.disk('q.txt'), 0o600);
    await call(m, 'sync', {});
    env.writeDisk('q.txt', 'changed on disk');
    assert.equal(modeOf(env, 'q.txt'), 0o600);
    const umask = process.umask(0o022);
    try {
      const pushed = await pushModes(env, m, ['q.txt'], { force: true, beforeEffect: () => rmSync(env.disk('q.txt')) });
      assert.deepEqual(pushed.written, ['q.txt']);
    } finally {
      process.umask(umask);
    }
    assert.equal(env.readDisk('q.txt'), 'v1');
    assert.equal(modeOf(env, 'q.txt'), 0o600, 'never created wider than its mode');
  });

  test("a bare sync after a narrowing push stopped before its bytes leaves the old bytes' own mode for a sync that names the file", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'a bare sync takes nothing in');
    await call(m, 'sync', { path: 'work/mixed.txt' });
    assert.equal(storedText(env, 'mixed.txt'), 'v1', "the named sync took disk's bytes");
    assert.equal(storedMode(env, 'mixed.txt'), 0o100640, "with the mode they had, not the push's narrowed one");
  });

  test('a push after a bare sync completes a narrowing push stopped before its bytes: the new bytes at the new mode', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    await call(m, 'sync', {});
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
    await call(m, 'sync', {});
    assert.deepEqual([storedText(env, 'mixed.txt'), storedMode(env, 'mixed.txt')], ['v2', 0o100604], 'and a sync then finds disk agreeing');
  });

  for (const between of ['nothing', 'a bare sync']) {
    test(`a push that runs again over a narrowing push stopped before its bytes, and stops before its own bytes too, with ${between} between, leaves the old bytes' own mode for a sync that names the file`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await narrowingPush(env, m, 'mixed.txt');
      for (let stop = 0; stop < 2; stop++) {
        if (stop === 1 && between === 'a bare sync') await call(m, 'sync', {});
        const restore = await stopAt('truncate', 1);
        try {
          await call(m, 'materialize', { path: 'work/mixed.txt' });
        } finally {
          restore();
        }
      }
      assert.equal(modeOf(env, 'mixed.txt'), 0o600, 'the old bytes at the narrowed mode');
      await call(m, 'sync', {});
      assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'a bare sync takes nothing in');
      await call(m, 'sync', { path: 'work/mixed.txt' });
      assert.equal(storedText(env, 'mixed.txt'), 'v1', "the named sync took disk's bytes");
      assert.equal(storedMode(env, 'mixed.txt'), 0o100640, "with the mode they had, not the push's narrowed one");
    });
  }

  test('a narrowing push stopped before its bytes twice is completed by the next push: the new bytes at the new mode', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    for (let stop = 0; stop < 2; stop++) {
      const restore = await stopAt('truncate', 1);
      try {
        await call(m, 'materialize', { path: 'work/mixed.txt' });
      } finally {
        restore();
      }
    }
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
    await call(m, 'sync', {});
    assert.deepEqual([storedText(env, 'mixed.txt'), storedMode(env, 'mixed.txt')], ['v2', 0o100604], 'and a sync then finds disk agreeing');
  });

  test("after a narrowing push stopped before its bytes twice, the old bytes set back to their own mode are no change: the next push gives the store's mode", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    for (let stop = 0; stop < 2; stop++) {
      const restore = await stopAt('truncate', 1);
      try {
        await call(m, 'materialize', { path: 'work/mixed.txt' });
      } finally {
        restore();
      }
    }
    chmodSync(env.disk('mixed.txt'), 0o640);
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604, 'the mode they last agreed on takes the store\'s');
  });

  test("a push that runs again over a pure narrowing stopped before its bytes, where disk already has the store's mode, and stops before its own bytes too, leaves the old bytes' own mode", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('p.txt', 'v1');
    chmodSync(env.disk('p.txt'), 0o644);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/p.txt', content: 'v2' });
    const e = env.store.treeGet(TREE, 'p.txt')!;
    env.store.treeSet(TREE, 'p.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100600 });
    for (let stop = 0; stop < 2; stop++) {
      const restore = await stopAt('truncate', 1);
      try {
        await call(m, 'materialize', { path: 'work/p.txt' });
      } finally {
        restore();
      }
    }
    assert.equal(modeOf(env, 'p.txt'), 0o600, 'the old bytes at the narrowed mode, which is the store\'s');
    await call(m, 'sync', { path: 'work/p.txt' });
    assert.deepEqual([storedText(env, 'p.txt'), storedMode(env, 'p.txt')], ['v1', 0o100644], "the named sync took disk's bytes with the mode they had");
  });

  test("a sync naming the file whose adoption doesn't land, after a narrowing push stopped before its bytes, leaves the store's change owed, and the next push gives the store's mode", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    // The store refuses the adoption's tree commit, after its intent is durable.
    const store = env.store as unknown as { treeSet: (...args: unknown[]) => unknown };
    const treeSet = store.treeSet;
    let refused = 0;
    store.treeSet = function (this: unknown, ...args: unknown[]) {
      if (args[1] === 'mixed.txt') {
        refused++;
        throw new Error('refused');
      }
      return treeSet.apply(env.store, args);
    };
    try {
      await call(m, 'sync', { path: 'work/mixed.txt' }).catch(() => undefined);
    } finally {
      store.treeSet = treeSet;
    }
    assert.equal(refused, 1, 'the sync reached its tree commit');
    const left = (m as any).agreement.get('work', 'mixed.txt') as { kind: string; effect?: string };
    assert.deepEqual([left.kind, left.effect], ['pending', 'adopt'], "the adoption's intent is left");
    assert.equal(storedText(env, 'mixed.txt'), 'v2', "the adoption didn't land");
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
  });

  test("on a filesystem whose ctime isn't trusted, a narrowing push stopped before its bytes is settled once the store holds disk's bytes at disk's mode", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('p.txt', 'v1');
    chmodSync(env.disk('p.txt'), 0o644);
    await call(m, 'sync', {});
    // No fingerprint vouches for a file here, so only the evidence itself can be stale.
    (m as any).ctimeTrust.set(realpathSync((m as any).mounts.get('work').config.path), null);
    await call(m, 'write', { path: 'work/p.txt', content: 'v2' });
    const e = env.store.treeGet(TREE, 'p.txt')!;
    env.store.treeSet(TREE, 'p.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100600 });
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/p.txt' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'p.txt'), 0o600, "the old bytes at the narrowed mode, which is the store's");
    await call(m, 'write', { path: 'work/p.txt', content: 'v1' });
    await call(m, 'materialize', {});
    const p = (m as any).agreement.get('work', 'p.txt') as { kind: string; mode?: number };
    assert.deepEqual([p.kind, p.mode], ['content', 0o600], 'the agreement replaces the stopped push');
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 0, 'and nothing is owed');
  });

  test("a push that runs again over a narrowing push stopped before its bytes, where the store's entry now records no mode, leaves the new bytes as disk has them for a sync that names the file", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    let restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    // The entry goes back to recording no mode, as one from before modes were recorded.
    const e = env.store.treeGet(TREE, 'mixed.txt')!;
    env.store.treeSet(TREE, 'mixed.txt', { blobHash: e.blobHash, size: e.size, mode: 0o644 });
    // Run again, the push writes its bytes and stops before making them durable.
    restore = await stopAt('sync', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.deepEqual([env.readDisk('mixed.txt'), modeOf(env, 'mixed.txt')], ['v2', 0o600], 'the new bytes at the narrowed mode, which it gives none over');
    await call(m, 'sync', { path: 'work/mixed.txt' });
    assert.equal(storedMode(env, 'mixed.txt'), 0o100600, "the named sync took disk's mode, as the store records none");
  });

  for (const force of [true, false]) {
    test(`${force ? 'a forced' : 'an unforced'} narrowing whose mode is set while its bytes go in ${force ? "ends at the store's mode" : 'keeps the mode set then'}`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      env.writeDisk('n.txt', 'v1');
      chmodSync(env.disk('n.txt'), 0o640);
      await call(m, 'sync', {});
      await call(m, 'write', { path: 'work/n.txt', content: 'v2' });
      const e = env.store.treeGet(TREE, 'n.txt')!;
      env.store.treeSet(TREE, 'n.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100600 });
      const restore = await chmodDuringWrite(env, 'n.txt', 0o644);
      try {
        await pushModes(env, m, ['n.txt'], force ? { force: true } : {});
      } finally {
        restore();
      }
      assert.equal(env.readDisk('n.txt'), 'v2');
      assert.equal(modeOf(env, 'n.txt'), force ? 0o600 : 0o644);
    });
  }

  test("a push stopped after narrowing a file's mode, before its bytes, left a mode of its own: no sync takes it in, and run again it writes the bytes before it widens", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('mixed.txt'), 'v1');
    assert.equal(modeOf(env, 'mixed.txt'), 0o600, 'the old bytes, at the narrowed mode');

    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'a sync takes nothing in');
    assert.equal(storedText(env, 'mixed.txt'), 'v2');

    // Run again: the bytes go in at the narrowed mode, and then it widens.
    const seen: number[] = [];
    const handle = await open(env.disk('mixed.txt'), 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const writeFile = proto.writeFile;
    proto.writeFile = async function (this: any, ...args: unknown[]) {
      seen.push(Number((await this.stat()).mode & 0o777));
      return writeFile.apply(this, args);
    };
    try {
      await call(m, 'materialize', {});
    } finally {
      proto.writeFile = writeFile;
    }
    assert.deepEqual(seen, [0o600], 'the new bytes at the narrowed mode, never the old ones at the new mode');
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
  });

  test('a sync naming a file whose push stopped before its bytes takes them in with their own mode, and the next push gives disk that mode back', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    await call(m, 'sync', { path: 'work/mixed.txt' });
    assert.equal(storedText(env, 'mixed.txt'), 'v1', 'the sync took disk\'s bytes');
    assert.equal(storedMode(env, 'mixed.txt'), 0o100640, 'with the mode they had, not the push\'s narrowed one');
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o640, 'and disk gets that mode back');
  });

  test("a sync naming a file whose push stopped after its bytes keeps the mode the push meant, and the next push completes it", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('chmod', 2);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o600);
    await call(m, 'sync', { path: 'work/mixed.txt' });
    assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'the mode the push meant, not the one it left');
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
  });

  test("a sync naming a file whose push stopped after its bytes records the mode the push meant, even where the entry's mode moved since", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('chmod', 2);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    // The same bytes, with another mode, as a branch holding them could give.
    const e = env.store.treeGet(TREE, 'mixed.txt')!;
    env.store.treeSet(TREE, 'mixed.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100644 });
    await call(m, 'sync', { path: 'work/mixed.txt' });
    assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'disk\'s bytes, with the mode the push meant them to have');
  });

  test('a mode set on disk after a push stopped is kept: run again, the push writes its bytes and says so, and a sync takes the mode in', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('chmod', 2);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    // None of the push's own modes (0o640, 0o600, 0o604).
    chmodSync(env.disk('mixed.txt'), 0o660);
    const again = await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o660);
    assert.match(keptReasons(again), /mixed\.txt: written, keeping disk's mode \(0660\)/);
    assert.doesNotMatch(skippedReasons(again), /mixed\.txt/, 'a written path is no refusal');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'mixed.txt'), 0o100660);
  });

  test("a push completing its own stopped one, whose narrowing to the workspace's newer mode the kernel refuses, is refused before its bytes: the mode disk has is the push's own, so the narrowing stays owed", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const stop = await stopAt('chmod', 2);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      stop();
    }
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o600, "the new bytes at the push's narrowed mode");
    // The workspace's mode moves to one narrower than disk's.
    const e = env.store.treeGet(TREE, 'mixed.txt')!;
    env.store.treeSet(TREE, 'mixed.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100400 });
    const restore = await refuseChmod();
    let again: Record<string, unknown>;
    try {
      again = await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'mixed.txt'), 0o600);
    assert.equal(skippedReasons(again),
      "mixed.txt: not written: the kernel refused to narrow its mode from 0600 to the workspace's 0400, as it does for a file another user owns, and new bytes aren't written wider than their mode: a retry is refused the same way until the file's owner or an administrator narrows it");
    assert.equal(keptReasons(again), '', 'no mode of disk\'s own to keep');
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 1, 'still owed');
  });

  test("a forced push gives disk the store's mode where disk's changed after planning, as it gives its bytes", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await owedMode(env, m, 'x.sh');
    const pushed = await pushModes(env, m, ['x.sh'], { force: true, beforeEffect: () => chmodSync(env.disk('x.sh'), 0o600) });
    assert.deepEqual(pushed.written, ['x.sh']);
    assert.equal(modeOf(env, 'x.sh'), 0o755);
  });

  test("a write drops setuid and setgid before its bytes, whether or not it narrows the mode, and keeps the sticky bit", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const full = (f: string) => statSync(env.disk(f)).mode & 0o7777;
    // setgid without group execute, which a write on Linux leaves; setuid,
    // which root's write leaves; each widened, or written at the mode it has.
    const cases: Array<[string, number, number]> = [['g.sh', 0o2744, 0o755], ['u.sh', 0o4744, 0o755], ['same.sh', 0o2755, 0o755]];
    // The sticky bit, where this platform lets a regular file have one, as
    // Linux, where CI runs, does: alone, which the write leaves, and with
    // setgid, which the chmod before the bytes drops while it keeps sticky.
    env.writeDisk('k.sh', 'echo k\n');
    try { chmodSync(env.disk('k.sh'), 0o1744); } catch { /* not on this platform */ }
    const sticky = (full('k.sh') & 0o1000) !== 0;
    if (process.platform === 'linux') assert.ok(sticky, 'Linux keeps a sticky bit on a regular file');
    if (sticky) cases.push(['k.sh', 0o1744, 0o755], ['kg.sh', 0o3744, 0o755]);
    else t.diagnostic('this platform keeps no sticky bit on a regular file: its cases are left out');
    for (const [f, mode] of cases) {
      if (f !== 'k.sh') env.writeDisk(f, `echo ${f}\n`);
      chmodSync(env.disk(f), mode);
    }
    await call(m, 'sync', {});
    for (const [f, , to] of cases) {
      await call(m, 'write', { path: `work/${f}`, content: `echo ${f} v2\n` });
      const e = env.store.treeGet(TREE, f)!;
      env.store.treeSet(TREE, f, { blobHash: e.blobHash, size: e.size, mode: 0o100000 | to });
    }
    await call(m, 'materialize', {});
    for (const [f] of cases) assert.equal(env.readDisk(f), `echo ${f} v2\n`, f);
    assert.equal(full('g.sh'), 0o755, 'setgid gone, whoever writes');
    assert.equal(full('u.sh'), 0o755, 'setuid gone, whoever writes');
    assert.equal(full('same.sh'), 0o755, 'setgid gone though the write leaves the permission bits as they were');
    if (sticky) {
      assert.equal(full('k.sh'), 0o1755, 'the sticky bit kept');
      assert.equal(full('kg.sh'), 0o1755, 'setgid gone and the sticky bit kept through the chmod before the bytes');
    }
  });

  test("a write whose drop of setuid and setgid the kernel refuses carries on under the kernel's rule for a write", async (t) => {
    if (process.platform !== 'linux') return t.skip("needs Linux's rule for a write");
    const env = new Env(t);
    const m = await env.open();
    const full = (f: string) => statSync(env.disk(f)).mode & 0o7777;
    // setgid without group execute, which a write on Linux leaves.
    env.writeDisk('g.sh', 'echo g\n');
    chmodSync(env.disk('g.sh'), 0o2744);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/g.sh', content: 'echo g v2\n' });
    const e = env.store.treeGet(TREE, 'g.sh')!;
    env.store.treeSet(TREE, 'g.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100744 });
    // As on another user's file: the kernel refuses this process's chmods.
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', {});
    } finally {
      restore();
    }
    assert.equal(env.readDisk('g.sh'), 'echo g v2\n', 'written');
    assert.equal(full('g.sh'), 0o2744, 'setgid without group execute, as the kernel leaves it');
    assert.doesNotMatch(skippedReasons(pushed), /g\.sh/);
  });

  for (const force of [false, true]) {
    test(`a narrowing write whose chmod the kernel refuses writes nothing${force ? ', forced too, since the narrowing is the workspace\'s own' : ''}: new bytes aren't written wider than their mode`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      await narrowingPush(env, m, 'r.txt');
      const restore = await refuseChmod();
      let pushed: Record<string, unknown>;
      try {
        pushed = await call(m, 'materialize', { path: 'work/r.txt', ...(force ? { force: true } : {}) });
      } finally {
        restore();
      }
      assert.equal(env.readDisk('r.txt'), 'v1', 'no bytes written');
      assert.equal(modeOf(env, 'r.txt'), 0o640);
      assert.equal(skippedReasons(pushed),
        "r.txt: not written: the kernel refused to narrow its mode from 0640 to 0600, within the workspace's 0604, as it does for a file another user owns, and new bytes aren't written wider than their mode: a retry is refused the same way until the file's owner or an administrator narrows it");
      assert.equal(keptReasons(pushed), '', 'nothing written');
      const agreed = (m as any).agreement.get('work', 'r.txt') as { kind: string; mode?: number };
      assert.deepEqual({ kind: agreed.kind, mode: agreed.mode }, { kind: 'content', mode: 0o640 }, 'the evidence as it was: no intent pending, the mode still owed');
      // Once the process may chmod it, the push goes through.
      await call(m, 'materialize', { path: 'work/r.txt' });
      assert.equal(env.readDisk('r.txt'), 'v2');
      assert.equal(modeOf(env, 'r.txt'), 0o604);
    });
  }

  test("a forced write of the workspace's own narrowing over bytes disk changed, whose chmod the kernel refuses, writes nothing: the narrowing stays owed", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('q.txt', 'v1');
    chmodSync(env.disk('q.txt'), 0o644);
    await call(m, 'sync', {});
    // The workspace narrows the mode; someone edits the bytes and leaves the mode.
    const e = env.store.treeGet(TREE, 'q.txt')!;
    env.store.treeSet(TREE, 'q.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100600 });
    env.writeDisk('q.txt', 'edited on disk');
    chmodSync(env.disk('q.txt'), 0o644);
    const before = (m as any).agreement.get('work', 'q.txt') as { kind: string; mode?: number };
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', { path: 'work/q.txt', force: true });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('q.txt'), 'edited on disk', 'no bytes written');
    assert.equal(modeOf(env, 'q.txt'), 0o644);
    assert.equal(skippedReasons(pushed),
      "q.txt: not written: the kernel refused to narrow its mode from 0644 to the workspace's 0600, as it does for a file another user owns, and new bytes aren't written wider than their mode: a retry is refused the same way until the file's owner or an administrator narrows it");
    assert.equal(keptReasons(pushed), '', 'nothing written');
    const after = (m as any).agreement.get('work', 'q.txt') as { kind: string; mode?: number };
    assert.deepEqual({ kind: after.kind, mode: after.mode }, { kind: before.kind, mode: before.mode }, 'the evidence as it was');
  });

  for (const code of ['EPERM', 'EACCES'] as const) {
    test(`a widening write whose chmod the kernel refuses (${code}) keeps its bytes at disk's mode, says so, and leaves no mode owed: a sync takes disk's in`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      env.writeDisk('w.sh', 'echo w\n');
      chmodSync(env.disk('w.sh'), 0o644);
      await call(m, 'sync', {});
      await call(m, 'write', { path: 'work/w.sh', content: 'echo w v2\n' });
      const e = env.store.treeGet(TREE, 'w.sh')!;
      env.store.treeSet(TREE, 'w.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
      const restore = await refuseChmod(code);
      let pushed: Record<string, unknown>;
      try {
        pushed = await call(m, 'materialize', {});
      } finally {
        restore();
      }
      assert.equal(env.readDisk('w.sh'), 'echo w v2\n', 'the bytes are in');
      assert.equal(modeOf(env, 'w.sh'), 0o644, "disk's mode kept");
      assert.equal(keptReasons(pushed),
        "w.sh: written, its mode left at 0644: the kernel refused the chmod, so the workspace's (0755) isn't given, and a sync takes disk's mode in");
      assert.doesNotMatch(skippedReasons(pushed), /w\.sh/, 'a written path is no refusal');
      const agreed = (m as any).agreement.get('work', 'w.sh') as { kind: string; mode?: number };
      assert.deepEqual({ kind: agreed.kind, mode: agreed.mode }, { kind: 'content', mode: undefined }, 'the push completed, recording no mode');
      await call(m, 'sync', {});
      assert.equal(storedMode(env, 'w.sh'), 0o100644, "a sync takes disk's mode in");
      const again = await call(m, 'materialize', {});
      assert.equal(`${skippedReasons(again)}${keptReasons(again)}`, '', 'nothing owed');
    });
  }

  test("a created file whose exact mode the kernel refuses is written at the mode it was created at, and disk's mode is taken in", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/n.txt', content: 'new\n' });
    const e = env.store.treeGet(TREE, 'n.txt')!;
    env.store.treeSet(TREE, 'n.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100664 });
    const mask = process.umask(0o022);
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', {});
    } finally {
      restore();
      process.umask(mask);
    }
    assert.equal(env.readDisk('n.txt'), 'new\n');
    assert.equal(modeOf(env, 'n.txt'), 0o644, 'the mode the umask left it');
    assert.equal(keptReasons(pushed),
      "n.txt: written, its mode left at 0644: the kernel refused the chmod, so the workspace's (0664) isn't given, and a sync takes disk's mode in");
    assert.doesNotMatch(skippedReasons(pushed), /n\.txt/);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'n.txt'), 0o100644);
  });

  for (const tool of ['write', 'edit', 'edit_many', 'writeBinary'] as const) {
    test(`an autoMaterialize ${tool} whose mode stays as disk had it succeeds, and its result says so: its bytes reached disk`, async (t) => {
      const env = new Env(t);
      const m = await env.open({ autoMaterialize: true });
      env.writeDisk('a.sh', 'echo a\n');
      chmodSync(env.disk('a.sh'), 0o644);
      await call(m, 'sync', {});
      const e = env.store.treeGet(TREE, 'a.sh')!;
      env.store.treeSet(TREE, 'a.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
      const restore = await refuseChmod();
      let done: Record<string, unknown>;
      // The text the model reads of an edit's receipt.
      let text = '';
      const edited = async (name: 'edit' | 'edit_many', input: Record<string, unknown>) => {
        const result = await m.handleToolCall({ id: 't', name, input });
        assert.equal(result.success, true, result.error);
        text = (result.data as Array<{ text: string }>)[0]!.text;
        return result.structured as Record<string, unknown>;
      };
      try {
        done = tool === 'write'
          ? await call(m, 'write', { path: 'work/a.sh', content: 'echo a v2\n' })
          : tool === 'edit'
            ? await edited('edit', { path: 'work/a.sh', oldString: 'echo a', newString: 'echo a v2' })
            : tool === 'edit_many'
              // edit_many gives it in the file's entry.
              ? ((await edited('edit_many', { edits: [{ path: 'work/a.sh', oldString: 'echo a', newString: 'echo a v2' }] })).files as Array<Record<string, unknown>>)[0]!
              : ((await m.writeBinary('work/a.sh', Buffer.from('echo a v2\n'), 'text/x-sh')).data as Record<string, unknown>);
      } finally {
        restore();
      }
      assert.equal(env.readDisk('a.sh'), 'echo a v2\n');
      assert.equal(modeOf(env, 'a.sh'), 0o644, "disk's mode kept");
      const kept = "written, its mode left at 0644: the kernel refused the chmod, so the workspace's (0755) isn't given, and a sync takes disk's mode in";
      assert.equal(done.modeKept, kept);
      // The model reads it too: in edit's header, and on edit_many's line for the file.
      if (tool === 'edit') assert.match(text, new RegExp(`\\nmodeKept: ${kept.replace(/[()]/g, '\\$&')}\\n--- changed ---\\n`));
      if (tool === 'edit_many') assert.match(text, new RegExp(`\\n--- files ---\\nwork/a\\.sh: size 10, replacements 1, edits 1; modeKept: ${kept.replace(/[()]/g, '\\$&')}\\n`));
      assert.equal(env.events.filter((x) => (x as { type?: string }).type === 'workspace:materialize-failed').length, 0);
    });
  }

  test('an autoMaterialize edit_many that disk takes in part notes each file it took at the mode disk had, as its success answer does', async (t) => {
    const env = new Env(t);
    const m = await env.open({ autoMaterialize: true });
    env.writeDisk('a.sh', 'echo a\n');
    chmodSync(env.disk('a.sh'), 0o644);
    env.writeDisk('linked.txt', 'shared\n');
    await call(m, 'sync', {});
    // A file with other hard links isn't written, so its push is refused.
    linkSync(env.disk('linked.txt'), env.disk('linked-too.txt'));
    const e = env.store.treeGet(TREE, 'a.sh')!;
    env.store.treeSet(TREE, 'a.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
    const restore = await refuseChmod();
    let error: string;
    try {
      error = await refused(m, 'edit_many', { edits: [
        { path: 'work/a.sh', oldString: 'echo a', newString: 'echo a v2' },
        { path: 'work/linked.txt', oldString: 'shared', newString: 'SHARED' },
      ] });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('a.sh'), 'echo a v2\n');
    assert.equal(modeOf(env, 'a.sh'), 0o644, "disk's mode kept");
    // The file disk refused makes one event, and the file it took makes none.
    assert.deepEqual(env.events.filter((x) => (x as { type?: string }).type === 'workspace:materialize-failed')
      .map((x) => { const { mount, path, op } = x as unknown as { mount: string; path: string; op: string }; return [mount, path, op]; }),
    [['work', 'linked.txt', 'write']]);
    assert.match(error, /\n\nDisk took 1 of the call's 2 files\. This file's push didn't complete:\n\nwork\/linked\.txt: not written: a file with other hard links[^\n]*\n\nDisk took work\/a\.sh: written, its mode left at 0644: the kernel refused the chmod, so the workspace's \(0755\) isn't given, and a sync takes disk's mode in\.$/);
  });

  test("an autoMaterialize write whose narrowing the kernel refuses fails, saying why and from which mode to which, in the write tools' frame", async (t) => {
    const env = new Env(t);
    const m = await env.open({ autoMaterialize: true });
    env.writeDisk('r.txt', 'v1');
    chmodSync(env.disk('r.txt'), 0o644);
    await call(m, 'sync', {});
    const e = env.store.treeGet(TREE, 'r.txt')!;
    env.store.treeSet(TREE, 'r.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100600 });
    const restore = await refuseChmod();
    let said: string;
    try {
      said = await refused(m, 'write', { path: 'work/r.txt', content: 'private v2' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('r.txt'), 'v1', 'no bytes written');
    assert.match(said, /a retry is refused the same way until the file's owner or an administrator narrows it/);
    assert.match(said, /the kernel refused to narrow its mode from 0644 to the workspace's 0600/);
    assert.match(said, /^The write of "work\/r\.txt" is stored in the workspace, so don't send it again\. Its push to disk didn't complete: /);
    assert.doesNotMatch(said, /next materialize call/);
  });

  test("a forced write over a mode disk widened, whose narrowing the kernel refuses, writes its bytes at disk's mode, as an unforced write would, and says so", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('p.txt', 'private');
    chmodSync(env.disk('p.txt'), 0o600);
    await call(m, 'sync', {});
    // Someone widens it; the workspace then owes new bytes at its 0600.
    chmodSync(env.disk('p.txt'), 0o644);
    await call(m, 'write', { path: 'work/p.txt', content: 'private v2' });
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', { path: 'work/p.txt', force: true });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('p.txt'), 'private v2', 'the bytes are written');
    assert.equal(modeOf(env, 'p.txt'), 0o644);
    assert.equal(skippedReasons(pushed), '', 'nothing refused');
    assert.deepEqual(pushed.modesKept, [{ mount: 'work', path: 'p.txt',
      reason: "written, its mode left at 0644: the kernel refused to narrow it to the workspace's 0600, so disk keeps its mode, and a sync takes it in" }]);
    const agreed = (m as any).agreement.get('work', 'p.txt') as { kind: string; mode?: number };
    assert.deepEqual({ kind: agreed.kind, mode: agreed.mode }, { kind: 'content', mode: 0o600 }, 'recorded as an unforced write records it: the mode disk changed since');
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 0, 'nothing owed');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'p.txt'), 0o100644, "a sync takes disk's mode in");
  });

  test("a forced write over bytes and a mode disk changed, whose narrowing the kernel refuses, writes the workspace's bytes at disk's mode, recorded as an unforced write would be", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('p.txt', 'private');
    chmodSync(env.disk('p.txt'), 0o600);
    await call(m, 'sync', {});
    // Someone edits it and widens it; the workspace's copy is unchanged.
    env.writeDisk('p.txt', 'edited on disk');
    chmodSync(env.disk('p.txt'), 0o644);
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', { path: 'work/p.txt', force: true });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('p.txt'), 'private', "force writes the workspace's bytes");
    assert.equal(modeOf(env, 'p.txt'), 0o644);
    assert.equal(skippedReasons(pushed), '', 'nothing refused');
    assert.equal(keptReasons(pushed),
      "p.txt: written, its mode left at 0644: the kernel refused to narrow it to the workspace's 0600, so disk keeps its mode, and a sync takes it in");
    const agreed = (m as any).agreement.get('work', 'p.txt') as { kind: string; mode?: number };
    assert.deepEqual({ kind: agreed.kind, mode: agreed.mode }, { kind: 'content', mode: 0o600 }, 'the mode disk last agreed with, so a sync reads 0644 as disk\'s change');
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 0, 'nothing owed');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'p.txt'), 0o100644, "a sync takes disk's mode in");
  });

  test("a forced write over a mode disk narrowed, whose widening the kernel refuses, writes its bytes at disk's mode, recorded as an unforced write would be", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('g.txt', 'shared');
    chmodSync(env.disk('g.txt'), 0o644);
    await call(m, 'sync', {});
    // Someone narrows it; the workspace then owes new bytes at its 0644.
    chmodSync(env.disk('g.txt'), 0o600);
    await call(m, 'write', { path: 'work/g.txt', content: 'shared v2' });
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', { path: 'work/g.txt', force: true });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('g.txt'), 'shared v2', 'the bytes are written');
    assert.equal(modeOf(env, 'g.txt'), 0o600);
    assert.equal(skippedReasons(pushed), '', 'nothing refused');
    assert.equal(keptReasons(pushed),
      "g.txt: written, its mode left at 0600: the kernel refused the chmod, so the workspace's (0644) isn't given, and a sync takes disk's mode in");
    const agreed = (m as any).agreement.get('work', 'g.txt') as { kind: string; mode?: number };
    assert.deepEqual({ kind: agreed.kind, mode: agreed.mode }, { kind: 'content', mode: 0o644 }, 'the mode disk last agreed with, as an unforced write records it');
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 0, 'nothing owed');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'g.txt'), 0o100600, "a sync takes disk's mode in");
  });

  test("a forced write over a setuid file whose mode disk changed, whose drop the kernel refuses, goes on to the widening and says that was refused", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('u.sh', 'echo u\n');
    chmodSync(env.disk('u.sh'), 0o644);
    await call(m, 'sync', {});
    // Someone narrows it and sets setuid; the workspace then owes new bytes at its 0644.
    chmodSync(env.disk('u.sh'), 0o4600);
    await call(m, 'write', { path: 'work/u.sh', content: 'echo u v2\n' });
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', { path: 'work/u.sh', force: true });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('u.sh'), 'echo u v2\n', 'the bytes are written');
    assert.equal(modeOf(env, 'u.sh'), 0o600);
    assert.equal(skippedReasons(pushed), '', 'nothing refused');
    assert.equal(keptReasons(pushed),
      "u.sh: written, its mode left at 0600: the kernel refused the chmod, so the workspace's (0644) isn't given, and a sync takes disk's mode in",
      'the refused drop is no narrowing');
  });

  // Someone widens the file, or narrows it; the store still holds the mode they agreed on.
  for (const { kind, agreed, changed, shown } of [
    { kind: 'narrowing', agreed: 0o600, changed: 0o644, shown: '0600' },
    { kind: 'widening', agreed: 0o755, changed: 0o700, shown: '0755' },
  ]) {
    test(`a forced ${kind} over a mode disk changed, which the kernel refuses, leaves the path as it was: disk keeps its mode, and a sync takes it in`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      env.writeDisk('p.txt', 'private');
      chmodSync(env.disk('p.txt'), agreed);
      await call(m, 'sync', {});
      chmodSync(env.disk('p.txt'), changed);
      const before = (m as any).agreement.get('work', 'p.txt') as { kind: string; mode?: number };
      const restore = await refuseChmod();
      let pushed: Record<string, unknown>;
      try {
        pushed = await call(m, 'materialize', { path: 'work/p.txt', force: true });
      } finally {
        restore();
      }
      assert.equal(modeOf(env, 'p.txt'), changed);
      assert.equal(skippedReasons(pushed),
        `p.txt: not given the workspace's mode (${shown}): the kernel refused the chmod, so disk keeps its mode, and a sync takes it in`);
      const after = (m as any).agreement.get('work', 'p.txt') as { kind: string; mode?: number };
      assert.deepEqual({ kind: after.kind, mode: after.mode }, { kind: before.kind, mode: before.mode }, 'the evidence as it was');
      assert.equal(after.mode, agreed);
      assert.equal((await call(m, 'status', {})).work.pendingChanges, 0, 'nothing owed');
      await call(m, 'sync', {});
      assert.equal(storedMode(env, 'p.txt'), 0o100000 | changed, "a sync takes disk's mode in");
    });
  }

  test("a mode-only push whose narrowing the kernel refuses stays owed: disk's wider mode isn't taken in, and once the chmod is allowed it's given", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('p.txt', 'private');
    chmodSync(env.disk('p.txt'), 0o644);
    await call(m, 'sync', {});
    const e = env.store.treeGet(TREE, 'p.txt')!;
    env.store.treeSet(TREE, 'p.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100600 });
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', { path: 'work/p.txt' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'p.txt'), 0o644);
    assert.equal(skippedReasons(pushed),
      "p.txt: not given the workspace's mode (0600): the kernel refused to narrow it, as it does for a file another user owns, so it stays owed: a retry is refused the same way until the file's owner or an administrator narrows it");
    const agreed = (m as any).agreement.get('work', 'p.txt') as { kind: string; mode?: number };
    assert.deepEqual({ kind: agreed.kind, mode: agreed.mode }, { kind: 'content', mode: 0o644 }, 'the evidence as it was');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'p.txt'), 0o100600, "disk's wider mode isn't taken in");
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 1, 'still owed');
    await call(m, 'materialize', { path: 'work/p.txt' });
    assert.equal(modeOf(env, 'p.txt'), 0o600);
  });

  test("a mode-only push whose widening the kernel refuses changes nothing on disk, says why, and leaves no mode owed: a sync takes disk's in", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await owedMode(env, m, 'o.sh');
    const restore = await refuseChmod();
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', { path: 'work/o.sh' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'o.sh'), 0o644);
    assert.equal(skippedReasons(pushed),
      "o.sh: not given the workspace's mode (0755): the kernel refused the chmod, and a sync takes disk's mode in");
    const agreed = (m as any).agreement.get('work', 'o.sh') as { kind: string; mode?: number };
    assert.deepEqual({ kind: agreed.kind, mode: agreed.mode }, { kind: 'content', mode: undefined }, 'no mode recorded');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'o.sh'), 0o100644, "a sync takes disk's mode in");
    const again = await call(m, 'materialize', {});
    assert.equal(skippedReasons(again), '', 'nothing owed');
  });

  test("the drop of setuid and setgid comes before the bytes: a stop at the truncate finds it made", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const full = (f: string) => statSync(env.disk(f)).mode & 0o7777;
    env.writeDisk('d.sh', 'echo d\n');
    chmodSync(env.disk('d.sh'), 0o2744);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/d.sh', content: 'echo d v2\n' });
    const e = env.store.treeGet(TREE, 'd.sh')!;
    env.store.treeSet(TREE, 'd.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100744 });
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/d.sh' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('d.sh'), 'echo d\n', 'stopped before the bytes');
    assert.equal(full('d.sh'), 0o744, 'setgid already gone');
  });

  const skippedReasons = (pushed: Record<string, unknown>) => ((pushed.skipped ?? []) as Array<{ reason: string }>).map((x) => x.reason).join(' | ');
  /** A materialize's notes on written paths whose mode stayed as disk had it. */
  const keptReasons = (pushed: Record<string, unknown>) =>
    ((pushed.modesKept ?? []) as Array<{ path: string; reason: string }>).map((x) => `${x.path}: ${x.reason}`).join(' | ');

  test("a write that narrows a file's mode drops setgid before the bytes, where the kernel's rule for a write would leave it", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const full = (f: string) => statSync(env.disk(f)).mode & 0o7777;
    // setgid without group execute: a write on Linux leaves it, so only the
    // chmod before the bytes takes it away.
    env.writeDisk('s.sh', 'echo s\n');
    chmodSync(env.disk('s.sh'), 0o2764);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/s.sh', content: 'echo s v2\n' });
    const e = env.store.treeGet(TREE, 's.sh')!;
    env.store.treeSet(TREE, 's.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100744 });
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('s.sh'), 'echo s v2\n');
    assert.equal(full('s.sh'), 0o744, 'setgid gone before the bytes');
  });

  test("a push that changes only a file's mode keeps its setuid, setgid and sticky bits", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const full = (f: string) => statSync(env.disk(f)).mode & 0o7777;
    env.writeDisk('m.sh', 'echo m\n');
    chmodSync(env.disk('m.sh'), 0o7644);
    await call(m, 'sync', {});
    const e = env.store.treeGet(TREE, 'm.sh')!;
    env.store.treeSet(TREE, 'm.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
    await call(m, 'materialize', {});
    assert.equal(full('m.sh'), 0o7755);
  });

  test("a mode set on a file while its bytes are written is kept: the push doesn't widen over it, and says so", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const handle = await open(env.disk('mixed.txt'), 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const writeFile = proto.writeFile;
    proto.writeFile = async function (this: any, ...args: unknown[]) {
      const done = await writeFile.apply(this, args);
      chmodSync(env.disk('mixed.txt'), 0o660);
      return done;
    };
    let pushed: Record<string, unknown>;
    try {
      pushed = await call(m, 'materialize', {});
    } finally {
      proto.writeFile = writeFile;
    }
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o660);
    assert.match(keptReasons(pushed), /mixed\.txt: written, keeping disk's mode \(0660\)/);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'mixed.txt'), 0o100660, 'a sync takes the mode in');
  });

  test("a forced write widens a file's mode over one set while its bytes are written, as it gives its bytes", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const handle = await open(env.disk('mixed.txt'), 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    const writeFile = proto.writeFile;
    proto.writeFile = async function (this: any, ...args: unknown[]) {
      const done = await writeFile.apply(this, args);
      chmodSync(env.disk('mixed.txt'), 0o660);
      return done;
    };
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt', force: true });
    } finally {
      proto.writeFile = writeFile;
    }
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
  });

  test("a push that wrote bytes without changing the mode, stopped after them, keeps a mode set since when it's run again", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('same.txt', 'v1');
    chmodSync(env.disk('same.txt'), 0o644);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/same.txt', content: 'v2' });
    const restore = await stopAt('sync', 1);
    try {
      await call(m, 'materialize', { path: 'work/same.txt' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('same.txt'), 'v2');
    assert.equal(modeOf(env, 'same.txt'), 0o644);
    chmodSync(env.disk('same.txt'), 0o600);
    const again = await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'same.txt'), 0o600, 'none of the push\'s own modes, so it\'s kept');
    assert.match(keptReasons(again), /same\.txt: written, keeping disk's mode \(0600\)/);
  });

  test("a push that kept a mode disk changed, stopped after its bytes, keeps it when it's run again", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('kept.txt', 'v1');
    chmodSync(env.disk('kept.txt'), 0o644);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/kept.txt', content: 'v2' });
    chmodSync(env.disk('kept.txt'), 0o600);
    const restore = await stopAt('sync', 1);
    try {
      await call(m, 'materialize', { path: 'work/kept.txt' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('kept.txt'), 'v2');
    assert.equal(modeOf(env, 'kept.txt'), 0o600, 'the push declined the store\'s mode');
    const again = await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'kept.txt'), 0o600, 'and run again, it still does');
    assert.match(keptReasons(again), /kept\.txt: written, keeping disk's mode \(0600\)/);
  });

  test("a push that kept a mode disk changed, stopped after its bytes, gives the store's mode when run again where a person set back the mode they last agreed on", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('back.txt', 'v1');
    chmodSync(env.disk('back.txt'), 0o644);
    await call(m, 'sync', {});
    // The workspace's bytes and mode both move on, and disk's mode does too.
    await call(m, 'write', { path: 'work/back.txt', content: 'v2' });
    const e = env.store.treeGet(TREE, 'back.txt')!;
    env.store.treeSet(TREE, 'back.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
    chmodSync(env.disk('back.txt'), 0o600);
    const restore = await stopAt('sync', 1);
    try {
      await call(m, 'materialize', { path: 'work/back.txt' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'back.txt'), 0o600, 'the push kept disk\'s mode');
    // A person sets back the mode disk and the workspace last agreed on. It
    // carries no change of disk's own, so the store's applies, as it would
    // had nobody touched the file.
    chmodSync(env.disk('back.txt'), 0o644);
    const again = await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'back.txt'), 0o755);
    assert.doesNotMatch(skippedReasons(again), /back\.txt/);
  });

  test("a push stopped after its new bytes, at a mode of its own, gives the store's mode as it stands when it's run again", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('chmod', 2);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'mixed.txt'), 0o600, 'the new bytes at the narrowed mode');
    // The store's mode moves meanwhile, as a branch switch moves it: the
    // completion gives what the workspace wants now, not what the stopped
    // push meant (0o604).
    const e = env.store.treeGet(TREE, 'mixed.txt')!;
    env.store.treeSet(TREE, 'mixed.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100644 });
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o644);
  });

  test("a forced push stopped after its new bytes, whose file a person gives back the mode it found, keeps that mode when an ordinary push runs again", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    // A person's mode since the agreement, which a forced push goes over:
    // it narrows 0o660 to 0o600 before the bytes, to widen to 0o604 after.
    chmodSync(env.disk('mixed.txt'), 0o660);
    const restore = await stopAt('chmod', 2);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt', force: true });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'mixed.txt'), 0o600, 'the new bytes at the narrowed mode');
    // 0o660, the mode the push narrowed from: a push that narrows never
    // leaves its new bytes there, and it isn't the agreed one (0o640), so
    // it's a person's, set since the push stopped.
    chmodSync(env.disk('mixed.txt'), 0o660);
    const again = await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o660);
    assert.match(keptReasons(again), /mixed\.txt: written, keeping disk's mode \(0660\)/);
  });

  test("a push stopped after it widened its new bytes' mode, before they were made durable, is its own: run again, it completes without a word", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('sync', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604, 'widened before the stop');
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'a sync takes nothing in');
    const again = await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
    assert.doesNotMatch(skippedReasons(again), /mixed\.txt/);
  });

  test("a push stopped after it widened its new bytes' mode gives the store's mode as it stands when run again", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('sync', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'mixed.txt'), 0o604, 'widened before the stop');
    // The store's mode moves meanwhile, as a branch switch moves it.
    const e = env.store.treeGet(TREE, 'mixed.txt')!;
    env.store.treeSet(TREE, 'mixed.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100644 });
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'mixed.txt'), 0o644);
  });

  test("a push that created a file, stopped after its bytes, gives the store's mode as it stands when run again", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('seed.txt', 'seed');
    await call(m, 'sync', {});
    // A file the store holds with a mode and disk lacks, as after a branch switch.
    const bytes = Buffer.from('new');
    env.store.treeSet(TREE, 'n.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o100600 });
    const restore = await stopAt('sync', 1);
    try {
      await call(m, 'materialize', { path: 'work/n.txt' });
    } finally {
      restore();
    }
    assert.equal(env.readDisk('n.txt'), 'new');
    assert.equal(modeOf(env, 'n.txt'), 0o600, 'created at its mode');
    const e = env.store.treeGet(TREE, 'n.txt')!;
    env.store.treeSet(TREE, 'n.txt', { blobHash: e.blobHash, size: e.size, mode: 0o100640 });
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'n.txt'), 0o640);
  });

  test("a file a push creates is no wider than its mode from its creation, so a stop before its bytes leaves it so", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('seed.txt', 'seed');
    await call(m, 'sync', {});
    const bytes = Buffer.from('private');
    env.store.treeSet(TREE, 'p.txt', { blobHash: env.store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o100600 });
    // The first look at the file after its creation.
    const restore = await stopAt('stat', 1);
    try {
      await call(m, 'materialize', { path: 'work/p.txt' });
    } finally {
      restore();
    }
    assert.ok(existsSync(env.disk('p.txt')), 'created before the stop');
    assert.equal(modeOf(env, 'p.txt') & ~0o600, 0, 'no wider than its mode');
  });

  test("a push stopped after narrowing a file's mode, resolved after the workspace is opened again, is still its own", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await narrowingPush(env, m, 'mixed.txt');
    const restore = await stopAt('truncate', 1);
    try {
      await call(m, 'materialize', { path: 'work/mixed.txt' });
    } finally {
      restore();
    }
    assert.equal(modeOf(env, 'mixed.txt'), 0o600);
    m = await env.restart(m);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'mixed.txt'), 0o100604, 'a sync after the restart takes nothing in');
    assert.equal(storedText(env, 'mixed.txt'), 'v2');
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('mixed.txt'), 'v2');
    assert.equal(modeOf(env, 'mixed.txt'), 0o604);
  });

  test("a write where nothing records an agreed mode says so when it keeps disk's", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('old.txt', 'v1');
    chmodSync(env.disk('old.txt'), 0o644);
    await call(m, 'sync', {});
    const e = env.store.treeGet(TREE, 'old.txt')!;
    // Evidence from before modes were recorded: no mode.
    const agreement = (m as any).agreement as DiskAgreement;
    agreement.set('work', 'old.txt', { kind: 'content', hash: e.blobHash, size: e.size });
    agreement.barrier();
    await call(m, 'write', { path: 'work/old.txt', content: 'v2' });
    chmodSync(env.disk('old.txt'), 0o600);
    const pushed = await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'old.txt'), 0o600);
    assert.equal(keptReasons(pushed),
      "old.txt: written, keeping disk's mode (0600), which differs from the workspace's (0644), and nothing records which side changed it — sync this path to take disk's mode in, or materialize this path with force to apply the workspace's");
  });

  test("where modes go unobserved, as on Windows, none is taken in or applied, the evidence records none, and no entry is owed one", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('w.sh', 'echo w\n');
    chmodSync(env.disk('w.sh'), 0o644);
    await call(m, 'sync', {});
    const agreement = (m as any).agreement as DiskAgreement;
    const agreedMode = () => (agreement.get('work', 'w.sh') as { mode?: number } | undefined)?.mode;
    assert.equal(agreedMode(), 0o644);
    (m as any).modesObserved = false;
    chmodSync(env.disk('w.sh'), 0o755);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'w.sh'), 0o100644, 'disk\'s mode isn\'t taken in');
    assert.equal(agreedMode(), undefined, 'the evidence drops the mode a POSIX host recorded: this host saw none');
    const e = env.store.treeGet(TREE, 'w.sh')!;
    env.store.treeSet(TREE, 'w.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100700 });
    assert.equal((await call(m, 'status', {})).work.pendingChanges, 0, 'no entry is owed a mode');
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'w.sh'), 0o755, 'the store\'s mode isn\'t applied');
    // A write of new bytes applies none either, and its evidence records none.
    await call(m, 'write', { path: 'work/w.sh', content: 'echo w v2\n' });
    const w = env.store.treeGet(TREE, 'w.sh')!;
    env.store.treeSet(TREE, 'w.sh', { blobHash: w.blobHash, size: w.size, mode: 0o100700 });
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('w.sh'), 'echo w v2\n');
    assert.equal(modeOf(env, 'w.sh'), 0o755, 'no mode applied with the bytes');
    assert.equal(agreedMode(), undefined, 'the completion records no mode');
    await call(m, 'sync', { path: 'work/w.sh' });
    assert.equal(agreedMode(), undefined, 'nor does a sync naming the path');
    // A host that observes modes reads the evidence as unknown and takes disk's in.
    (m as any).modesObserved = true;
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'w.sh'), 0o100755, "disk's mode, taken in as unknown");
    assert.equal(modeOf(env, 'w.sh'), 0o755, 'an unknown never moves disk');
  });

  test("where modes go unobserved, a push's completion records no mode, though the evidence it replaces had one", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('c.sh', 'echo c\n');
    chmodSync(env.disk('c.sh'), 0o755);
    await call(m, 'sync', {});
    const agreement = (m as any).agreement as DiskAgreement;
    assert.equal((agreement.get('work', 'c.sh') as { mode?: number }).mode, 0o755, 'a POSIX host recorded it');
    (m as any).modesObserved = false;
    await call(m, 'write', { path: 'work/c.sh', content: 'echo c v2\n' });
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('c.sh'), 'echo c v2\n');
    assert.equal((agreement.get('work', 'c.sh') as { mode?: number }).mode, undefined, 'the completion claims no mode this host saw none of');
  });

  test("a tracked binary file keeps a mode disk changed: its push writes the bytes and says so", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await m.writeBinary('work/blob.bin', Buffer.from([0, 1, 2, 3, 0, 255]), 'application/octet-stream');
    await call(m, 'materialize', {});
    chmodSync(env.disk('blob.bin'), 0o644);
    // A sync fills in the entry's mode from disk's, on the same bytes.
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'blob.bin'), 0o100644);
    chmodSync(env.disk('blob.bin'), 0o600);
    await m.writeBinary('work/blob.bin', Buffer.from([0, 9, 9, 9, 0, 255]), 'application/octet-stream');
    const pushed = await call(m, 'materialize', {});
    assert.deepEqual([...readFileSync(env.disk('blob.bin'))], [0, 9, 9, 9, 0, 255]);
    assert.equal(modeOf(env, 'blob.bin'), 0o600);
    assert.match(keptReasons(pushed), /blob\.bin: written, keeping disk's mode \(0600\)/);
  });

  test('a read of a held file whose mode alone changed on disk takes the mode in, and says nothing of its text', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('tool.sh', 'echo tool\n');
    chmodSync(env.disk('tool.sh'), 0o644);
    await call(m, 'sync', {});
    chmodSync(env.disk('tool.sh'), 0o755);
    const data = await call(m, 'read', { path: 'work/tool.sh' });
    assert.equal(data.content, '     1\techo tool');
    assert.equal(data.note, undefined, "a mode taken in alone isn't a change to the text");
    assert.equal(storedMode(env, 'tool.sh'), 0o100755, 'the read took the mode in');
  });

  test('a chmod on disk is taken in as a change on the same bytes, and makes no event', async (t) => {
    const env = new Env(t);
    const m = await env.open({ wakeOnChange: true });
    env.writeDisk('tool.sh', 'echo tool\n');
    chmodSync(env.disk('tool.sh'), 0o644);
    await call(m, 'sync', {});
    const blob = env.store.treeGet(TREE, 'tool.sh')!.blobHash;
    env.events.length = 0;

    chmodSync(env.disk('tool.sh'), 0o755);
    const data = await call(m, 'sync', {});
    assert.equal(data.totalSynced, 1);
    assert.equal(env.store.treeGet(TREE, 'tool.sh')!.blobHash, blob);
    assert.equal(storedMode(env, 'tool.sh'), 0o100755);
    assert.deepEqual(env.events.filter((e: any) => e.paths?.includes('work/tool.sh')), [], 'a mode alone makes no event, so nothing wakes on it');

    // A sync that names the path takes it in the same way.
    chmodSync(env.disk('tool.sh'), 0o750);
    await call(m, 'sync', { path: 'work/tool.sh' });
    assert.equal(storedMode(env, 'tool.sh'), 0o100750);
    assert.deepEqual(env.events.filter((e: any) => e.paths?.includes('work/tool.sh')), []);

    // New bytes with a new mode wake as before.
    env.writeDisk('tool.sh', 'echo tool v2\n');
    chmodSync(env.disk('tool.sh'), 0o700);
    await call(m, 'sync', {});
    const changed = env.events.find((e: any) => e.type === 'workspace:modified' && e.paths?.includes('work/tool.sh')) as ProcessEvent;
    assert.ok(changed, 'new bytes make an event, naming the file');
    assert.equal((await m.onProcess(changed, {} as never)).requestInference, true);
    assert.equal(storedMode(env, 'tool.sh'), 0o100700);
  });

  test("a mode from before modes were recorded is a placeholder: it never moves disk, and takes disk's mode once their bytes agree", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('old.sh', 'echo old\n');
    chmodSync(env.disk('old.sh'), 0o755);
    await call(m, 'sync', {});
    // As an older version left them: the entry at 0o644 whatever disk had,
    // and evidence without a mode.
    const e = env.store.treeGet(TREE, 'old.sh')!;
    env.store.treeSet(TREE, 'old.sh', { blobHash: e.blobHash, size: e.size, mode: 0o644 });
    const agreement = (m as any).agreement as DiskAgreement;
    agreement.set('work', 'old.sh', { kind: 'content', hash: e.blobHash, size: e.size });
    agreement.barrier();
    env.events.length = 0;

    await call(m, 'materialize', { path: 'work/old.sh', force: true });
    assert.equal(modeOf(env, 'old.sh'), 0o755, 'a forced push of the entry leaves the mode alone');
    const data = await call(m, 'sync', {});
    assert.equal(data.totalSynced, 0, 'taking a mode where the entry had none is no change');
    assert.equal(storedMode(env, 'old.sh'), 0o100755);
    assert.deepEqual(env.events.filter((ev: any) => ev.paths?.includes('work/old.sh')), []);

    // The evidence took disk's mode at that look too: a branch whose entry
    // records another mode now has it applied.
    env.store.treeSet(TREE, 'old.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100700 });
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'old.sh'), 0o700);
  });

  test("a push leaves a mode disk changed since alone and doesn't record it; forced, disk takes the store's", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('z.sh', 'echo z\n');
    chmodSync(env.disk('z.sh'), 0o644);
    await call(m, 'sync', {});
    chmodSync(env.disk('z.sh'), 0o755);

    const left = await call(m, 'materialize', { path: 'work/z.sh' });
    assert.equal(skippedReasons(left),
      "z.sh: disk's mode (0755) changed since it last agreed with the workspace's (0644) — sync this path to take disk's mode in, or materialize this path with force to apply the workspace's",
      'the push says why it left the mode');
    assert.equal(modeOf(env, 'z.sh'), 0o755);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'z.sh'), 0o100755, "the next sync still sees disk's change");

    chmodSync(env.disk('z.sh'), 0o600);
    await call(m, 'materialize', { path: 'work/z.sh', force: true });
    assert.equal(modeOf(env, 'z.sh'), 0o755);
    assert.equal((await entryOf(m, 'z.sh'))?.state, 'synced');
  });

  test("the store's mode goes to disk as a chmod where disk still has the mode they last agreed on", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('x.sh', 'echo x\n');
    chmodSync(env.disk('x.sh'), 0o755);
    await call(m, 'sync', {});
    chmodSync(env.disk('x.sh'), 0o644);
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'x.sh'), 0o100644);
    // As an undo to before that sync leaves it: the store at 0o755, disk and
    // its evidence at 0o644.
    const e = env.store.treeGet(TREE, 'x.sh')!;
    env.store.treeSet(TREE, 'x.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
    const entry = await entryOf(m, 'x.sh');
    assert.equal(entry?.state, 'workspace-draft');
    assert.match(entry?.note ?? '', /mode \(0755\) differs from disk's \(0644\)/);

    const mtime = statSync(env.disk('x.sh')).mtimeMs;
    await call(m, 'materialize', {});
    assert.equal(modeOf(env, 'x.sh'), 0o755, 'a bare materialize applies what disk owes');
    assert.equal(statSync(env.disk('x.sh')).mtimeMs, mtime, 'a chmod, not a rewrite');
    assert.equal((await entryOf(m, 'x.sh'))?.state, 'synced');
  });

  test('a write of new bytes leaves a mode disk changed since, and the next sync takes that mode in', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('y.sh', 'echo y\n');
    chmodSync(env.disk('y.sh'), 0o644);
    await call(m, 'sync', {});
    await call(m, 'write', { path: 'work/y.sh', content: 'echo y2\n' });
    chmodSync(env.disk('y.sh'), 0o755);

    await call(m, 'materialize', { path: 'work/y.sh' });
    assert.equal(env.readDisk('y.sh'), 'echo y2\n');
    assert.equal(modeOf(env, 'y.sh'), 0o755, "the push doesn't revert disk's mode");
    await call(m, 'sync', {});
    assert.equal(storedMode(env, 'y.sh'), 0o100755);
    assert.equal(modeOf(env, 'y.sh'), 0o755);
  });

  test('a chmod of a file the workspace holds but would not take in keeps it held, on the same bytes', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await m.writeBinary('work/blob.bin', Buffer.from([0, 1, 2, 3, 0, 255]), 'application/octet-stream');
    await call(m, 'materialize', { path: 'work/blob.bin' });
    chmodSync(env.disk('blob.bin'), 0o644);
    await call(m, 'sync', {});
    const held = env.store.treeGet(TREE, 'blob.bin')!;
    assert.equal(held.mode, 0o100644);

    chmodSync(env.disk('blob.bin'), 0o600);
    await call(m, 'sync', {});
    const after = env.store.treeGet(TREE, 'blob.bin');
    assert.equal(after?.blobHash, held.blobHash, 'still held');
    assert.equal(after?.mode, 0o100600);
  });

  test("an edit takes in a mode disk changed since, as its pass takes any change on disk, and writes at it: its text didn't change, so it says nothing of disk's copy", async (t) => {
    const env = new Env(t);
    const m = await env.open({ autoMaterialize: true });
    env.writeDisk('s.sh', 'echo a\n');
    chmodSync(env.disk('s.sh'), 0o644);
    await call(m, 'sync', {});
    chmodSync(env.disk('s.sh'), 0o755);
    const done = await call(m, 'edit', { path: 'work/s.sh', oldString: 'echo a', newString: 'echo b' });
    assert.equal(env.readDisk('s.sh'), 'echo b\n');
    assert.equal(done.note, undefined, "no word of disk's copy having changed: only its mode did");
    assert.equal(done.modeKept, undefined, 'and nothing is left owed');
    assert.equal(modeOf(env, 's.sh'), 0o755);
    assert.equal(storedMode(env, 's.sh'), 0o100755, "the workspace records disk's mode");
  });

  test("an edit after a widening the kernel refused takes disk's mode in with its pass, as a sync would, and writes at it", async (t) => {
    const env = new Env(t);
    const m = await env.open({ autoMaterialize: true });
    env.writeDisk('a.sh', 'echo a\n');
    chmodSync(env.disk('a.sh'), 0o644);
    await call(m, 'sync', {});
    const e = env.store.treeGet(TREE, 'a.sh')!;
    env.store.treeSet(TREE, 'a.sh', { blobHash: e.blobHash, size: e.size, mode: 0o100755 });
    const restore = await refuseChmod();
    let first: Record<string, unknown>;
    try {
      first = await call(m, 'write', { path: 'work/a.sh', content: 'echo a v2\n' });
    } finally {
      restore();
    }
    assert.match(String(first.modeKept), /a sync takes disk's mode in$/);
    const done = await call(m, 'edit', { path: 'work/a.sh', oldString: 'echo a v2', newString: 'echo a v3' });
    assert.equal(env.readDisk('a.sh'), 'echo a v3\n');
    assert.equal(done.note, undefined);
    assert.equal(done.modeKept, undefined, 'nothing records which side changed the mode, and the pass took disk\'s in, so there is nothing to keep');
    assert.equal(modeOf(env, 'a.sh'), 0o644);
    assert.equal(storedMode(env, 'a.sh'), 0o100644);
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
      assert.match(await refused(m, 'read', { path: 'work/gone.txt' }), /^The read did nothing: there's no file at "work\/gone\.txt"/);
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
    const after = env.store.treeGet(TREE, 'img/shot.png');
    assert.deepEqual(after && { blobHash: after.blobHash, size: after.size }, { blobHash: stored!.blobHash, size: stored!.size }, 'still held, unchanged');
    // The entry was written without a mode, and takes disk's now their bytes agree.
    assert.equal(after?.mode, 0o100000 | (statSync(env.disk('img/shot.png')).mode & 0o777));
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
    assert.match(error, /^The edit did nothing: oldString isn't in work\/a\.txt\./, 'the entry is disk\'s C by then, so an edit of A has nothing to replace');
    assert.equal(await contentOf(m, 'a.txt'), 'C');
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
  });

  test('an edit of a path the ignore list covers sees the disk version its settled adoption takes in too, since it names the path', async (t) => {
    const env = new Env(t);
    let m = await pendingAdoption(env);
    m = await env.restart(m, { ignore: ['a.txt'] });
    assert.equal((m as any).agreement.get('work', 'a.txt').kind, 'pending');
    env.writeDisk('a.txt', 'C');
    const error = await refused(m, 'edit', { path: 'work/a.txt', oldString: 'A', newString: 'B' });
    assert.match(error, /^The edit did nothing: oldString isn't in work\/a\.txt\./, 'the entry is disk\'s C by then, so an edit of A has nothing to replace');
    assert.match(error, /Disk's copy had changed since the workspace last agreed with it, so it was taken in first/);
    assert.equal(await contentOf(m, 'a.txt'), 'C');
  });

  test('a delete of a path the ignore list covers settles its pending adoption first too, since it names the path, and deletes what the workspace then holds', async (t) => {
    // Since #456 an edit makes a pass of its own; write, delete and
    // writeBinary settle through settleBeforeMutation's.
    const env = new Env(t);
    let m = await pendingAdoption(env);
    m = await env.restart(m, { ignore: ['a.txt'] });
    env.writeDisk('a.txt', 'C');
    await call(m, 'delete', { path: 'work/a.txt' });
    // The deletion is of disk's C, which the settled adoption took in, so a
    // materialize of the path that applies deletions carries it to disk.
    // Settled at the commit instead, from the adoption's B, it would leave C
    // as a copy disk changed since.
    await call(m, 'materialize', { path: 'work/a.txt', applyDeletions: true });
    assert.equal(existsSync(env.disk('a.txt')), false, "disk's C, the copy the deletion took in, is unlinked");
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

  test('a settled adoption records the mode of the entry it landed as', async (t) => {
    const env = new Env(t);
    const m = await pendingAdoption(env);
    const agreement = (m as any).agreement as DiskAgreement;
    const pending = agreement.get('work', 'a.txt') as { kind: string; expect?: { hash: string } };
    // The adoption landed: the store holds B, at the mode disk gave it.
    const bytes = Buffer.from('B');
    const blobHash = env.store.storeBlob(bytes, 'text/plain');
    assert.equal(blobHash, pending.expect?.hash, "the store's B is the content the adoption expects");
    env.store.treeSet(TREE, 'a.txt', { blobHash, size: bytes.byteLength, mode: 0o100600 });
    settleAdoptionBeforeMutation(env.store, agreement, { name: 'work', treeStateId: TREE }, 'a.txt');
    const settled = agreement.get('work', 'a.txt') as { kind: string; mode?: number };
    assert.deepEqual({ kind: settled.kind, mode: settled.mode }, { kind: 'content', mode: 0o600 });
  });

  test("where modes go unobserved, an adoption settled by a push or by a mutation records no mode: the entry's isn't disk's there", async (t) => {
    for (const settle of ['push', 'mutation'] as const) {
      const env = new Env(t);
      const m = await pendingAdoption(env);
      const agreement = (m as any).agreement as DiskAgreement;
      const pending = agreement.get('work', 'a.txt') as { kind: string; expect?: { hash: string }; prior?: { mode?: number } };
      assert.ok(pending.prior?.mode !== undefined, 'the prior evidence records a mode');
      const bytes = Buffer.from('B');
      const blobHash = env.store.storeBlob(bytes, 'text/plain');
      env.store.treeSet(TREE, 'a.txt', { blobHash, size: bytes.byteLength, mode: 0o100600 });
      (m as any).modesObserved = false;
      if (settle === 'push') await call(m, 'materialize', { path: 'work/a.txt' });
      else settleAdoptionBeforeMutation(env.store, agreement, { name: 'work', treeStateId: TREE }, 'a.txt');
      const settled = agreement.get('work', 'a.txt') as { kind: string; hash?: string; mode?: number };
      assert.deepEqual({ kind: settled.kind, hash: settled.hash, mode: settled.mode }, { kind: 'content', hash: blobHash, mode: undefined }, settle);
    }
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

  test("where modes go unobserved, the writer records no mode in a pending intent, its own modes or its prior's", (t) => {
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store, { modesObserved: () => false });
    agreement.open([{ name: 'work', root: '/srv/work' }]);
    agreement.intend('work', 'a.txt', {
      effect: 'disk', prior: { kind: 'content', hash: 'h', size: 1, mode: 0o755 }, expect: { kind: 'content', hash: 'h2' },
      branchId: 'b', modes: { from: 0o755, to: 0o700 },
    });
    const pending = agreement.get('work', 'a.txt') as { kind: string; prior?: { mode?: number }; modes?: unknown };
    assert.equal(pending.kind, 'pending');
    assert.equal(pending.prior?.mode, undefined, "the prior's mode");
    assert.equal(pending.modes, undefined, 'its own modes');
    // A restore of a POSIX host's record writes it without its mode too.
    agreement.restore('work', 'b.txt', { kind: 'content', hash: 'h', size: 1, mode: 0o644 });
    assert.equal((agreement.get('work', 'b.txt') as { mode?: number }).mode, undefined);
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

  test('a rebuild whose append fails partway leaves memory as it was, whole, with the identity a disk read checks', (t) => {
    // Nothing reaches this today: after the open, a rebuild finds every
    // mount's record and appends none. A later open with a moved mount does.
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store);
    agreement.open([{ name: 'work', root: '/srv/work' }, { name: 'other', root: '/srv/other' }]);
    const identity = { dev: '1', ino: '2' };
    agreement.recordRootIdentity('other', identity);
    const store = env.store as unknown as { appendJson: (type: string, payload: unknown) => unknown };
    const append = store.appendJson;
    store.appendJson = function (this: unknown, type: string, payload: unknown) {
      if (type === DISK_AGREEMENT_RECORD_TYPE) throw new Error('injected: the store refused the append');
      return append.call(this, type, payload);
    };
    try {
      // 'work' has moved, so the rebuild appends its record before it reaches 'other'.
      assert.throws(() => agreement.open([{ name: 'work', root: '/srv/moved' }, { name: 'other', root: '/srv/other' }]), /injected/);
    } finally {
      store.appendJson = append;
    }
    // Through a structural type, so this builds against a DiskAgreement
    // without the accessor too, and fails there rather than not building.
    const read = agreement as unknown as { rootIdentityForRead(mount: string): unknown };
    assert.deepEqual(read.rootIdentityForRead('other'), identity, 'the mount after the failed append keeps its identity');
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
    assert.match(await refused(m, 'ls', { path: 'work', recursive: true }), /^The ls did nothing: the workspace can't check its files against disk until its store is reopened/);
    assert.match(await refused(m, 'materialize', { path: 'work/a.txt' }), /^The materialize did nothing: the workspace can't check its files against disk until its store is reopened/);
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
      assert.match(await refused(m, 'ls', { path: 'work' }), /^The ls of "work" stopped on an error the workspace didn't expect: an input\/output error on the disk\./);
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
    proto.sync = async function () {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
    };
    let res;
    try {
      res = await call(m, 'materialize', {});
    } finally {
      proto.sync = sync;
    }
    assert.deepEqual(res.materialized, []);
    assert.match(res.skipped[0].reason, /a\.txt: could not make the write durable \(file fsync\): an input\/output error on the disk — whether disk holds the change isn't known until it's checked: a materialize of this path checks it and says how it ended$/);
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
    assert.match(failing.result.skipped[0].reason, /a\/b\/c\.txt: could not make the write durable \(directory fsync of a\): an input\/output error on the disk — whether disk holds the change isn't known until it's checked: a materialize of this path checks it and says how it ended$/);
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
      assert.match(pushed.skipped[0]!.reason, /^not unlinked: a file appeared at this path since it was checked — materializing again with applyDeletions checks it afresh$/);
      assert.equal(env.readDisk('gone.txt'), 'a new file from the shell');
      assert.deepEqual((m as any).agreement.get('work', 'gone.txt'), pending, 'still owed, as before');
    });

    test('confirming an unlink names a pipe that appeared since as what it is, and leaves it', { skip: process.platform === 'win32' ? 'no FIFOs' : false }, async (t) => {
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
        beforeEffect: () => assert.equal(spawnSync('mkfifo', [env.disk('gone.txt')]).status, 0, 'mkfifo'),
      });
      assert.deepEqual(pushed.deleted, []);
      assert.match(pushed.skipped[0]!.reason, /^not unlinked: a pipe, socket or device appeared at this path since it was checked — materializing again with applyDeletions checks it afresh$/);
      assert.ok(lstatSync(env.disk('gone.txt')).isFIFO(), 'the pipe stays');
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
  test('the ctime trust gate never trusts NFS, FUSE, SMB2 or 9p', () => {
    // NFS, FUSE, SMB2 and 9p maintain no ctime it can trust.
    for (const untrusted of [0x6969, 0x65735546, 0xfe534d42, 0x01021997]) {
      assert.equal(fsTypeTrustsCtime(untrusted), false, untrusted.toString(16));
    }
  });

  test('a filesystem keeps a birth time fixed only where it is listed, and only on Linux', async (t) => {
    for (const fixed of [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0xf2f52010, 0x2fc12fc1]) {
      assert.equal(fsTypeKeepsBirthTime(fixed), true, fixed.toString(16));
    }
    // overlayfs gives a directory copied up from a lower layer a later birth time; NFS, FUSE, SMB2 and 9p report what their server or backing gives.
    for (const unfixed of [0x794c7630, 0x6969, 0x65735546, 0xfe534d42, 0x01021997]) {
      assert.equal(fsTypeKeepsBirthTime(unfixed), false, unfixed.toString(16));
    }
    assert.equal(fsTypeKeepsBirthTime(BigInt(0xef53)), true, 'a bigint f_type reads the same');
    const env = new Env(t);
    const expected = process.platform === 'linux' && fsTypeKeepsBirthTime((await statfs(env.dir)).type);
    assert.equal(await filesystemKeepsBirthTime(env.dir), expected);
  });

  test('no restored timestamp hides a change: utimes, cp -p, and a write right after a hash', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'f.txt', 'aaaa');
    const old = new Date(Date.now() - 60_000);
    utimesSync(env.disk('f.txt'), old, old);
    const before = statSync(env.disk('f.txt'));

    env.writeDisk('f.txt', 'bbbb'); // same size
    utimesSync(env.disk('f.txt'), before.atime, before.mtime);
    // Read from the store, so only the listing's pass looks at disk.
    assert.equal(storedOf(env, 'f.txt'), 'aaaa', 'nothing has looked at disk yet');
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(storedOf(env, 'f.txt'), 'bbbb', 'utimes restoring mtime: rehashed and adopted');

    env.writeDisk(join('..', 'src.txt'), 'cccc');
    utimesSync(join(env.root, 'src.txt'), before.atime, before.mtime);
    const cp = spawnSync('cp', ['-p', join(env.root, 'src.txt'), env.disk('f.txt')]);
    assert.equal(cp.status, 0, `cp -p: ${cp.stderr}`);
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(storedOf(env, 'f.txt'), 'cccc', 'cp -p: rehashed and adopted');

    env.writeDisk('f.txt', 'dddd'); // just after the last hash
    assert.equal(await stateOf(m, 'f.txt'), 'synced');
    assert.equal(storedOf(env, 'f.txt'), 'dddd');
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
    clockPastTheRacyWindow(t);
    await call(m, 'sync', {}); // a full recheck rehashes, and records the fingerprint the stamps changed
    const agreement = (m as any).agreement;
    const now = statSync(env.disk('f.txt'), { bigint: true });
    const recorded = agreement.get('work', 'f.txt');
    assert.ok(fingerprintVouches(recorded?.fp, { size: Number(now.size), mtimeNs: now.mtimeNs.toString(), ctimeNs: now.ctimeNs.toString(), ino: now.ino.toString(), dev: now.dev.toString() }, true),
      'the first recheck recorded a fingerprint that vouches for the file');
    const records = () => env.store.getRecordIdsByType(DISK_AGREEMENT_RECORD_TYPE).length;
    const before = records();
    await call(m, 'sync', {});
    await call(m, 'sync', {});
    assert.equal(records(), before, 'the same file, the same stamps: nothing to re-record');
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

  test('a deletion leaves a pipe, a socket, or a link to a directory or a pipe, forced or not, and none is left for applyDeletions; a forced one removes a followed link to a regular file', { skip: process.platform === 'win32' ? 'no FIFOs' : false }, async (t) => {
    const env = new Env(t);
    const m = await env.open({ followSymlinks: true });
    for (const path of ['p', 's', 'd', 'f', 'r', 'x']) {
      await seedSynced(env, m, path, 'v1');
      await call(m, 'delete', { path: `work/${path}` });
      rmSync(env.disk(path));
    }
    assert.equal(spawnSync('mkfifo', [env.disk('p')]).status, 0, 'mkfifo');
    // A listening socket is a socket file; closing the server removes it.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(env.disk('s'), resolve);
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    mkdirSync(env.disk('target'));
    symlinkSync(env.disk('target'), env.disk('d'));
    assert.equal(spawnSync('mkfifo', [env.disk('fifo')]).status, 0, 'mkfifo');
    symlinkSync(env.disk('fifo'), env.disk('f'));
    env.writeDisk('file', 'a regular file');
    symlinkSync(env.disk('file'), env.disk('r'));
    mkdirSync(env.disk('x'));

    const noPush = (what: string) => `disk has ${what}, and no push unlinks it, forced or not — ask whoever runs this host if it should go`;
    const pipe = noPush('a pipe, socket or device at this path, or a symlink to one');
    const toDirectory = noPush('a symlink to a directory at this path');
    const directory = 'disk has a directory at this path, and no push unlinks one, forced or not — if it should go, move or remove it on disk';
    const reasons = (data: Record<string, unknown>, paths: string[]) => ((data.skipped as Array<{ reason: string }> | undefined) ?? [])
      .map((s) => s.reason).filter((reason) => paths.some((p) => reason.startsWith(`${p}: `))).sort();

    // Before any force, the push refuses each in the same words, offering no force.
    const unforced = await call(m, 'materialize', { applyDeletions: true });
    assert.deepEqual(reasons(unforced, ['d', 'f', 'p', 's', 'x']), [`d: ${toDirectory}`, `f: ${pipe}`, `p: ${pipe}`, `s: ${pipe}`, `x: ${directory}`]);

    // Forced without applyDeletions, they're refused in the same words, not
    // left for applyDeletions, which wouldn't unlink them either.
    const forcedAlone = await call(m, 'materialize', { force: true });
    assert.deepEqual(reasons(forcedAlone, ['d', 'f', 'p', 's', 'r', 'x']), [`d: ${toDirectory}`, `f: ${pipe}`, `p: ${pipe}`, `s: ${pipe}`, `x: ${directory}`]);
    assert.deepEqual(forcedAlone.workspaceDeletionsLeftOnDisk, [{ mount: 'work', path: 'r' }], 'only the link to a regular file waits for applyDeletions');

    const data = await call(m, 'materialize', { applyDeletions: true, force: true });
    assert.deepEqual(reasons(data, ['d', 'f', 'p', 's', 'r', 'x']), [
      `d: not unlinked: ${toDirectory}`,
      `f: not unlinked: ${pipe}`,
      `p: not unlinked: ${pipe}`,
      `s: not unlinked: ${pipe}`,
      `x: not unlinked: ${directory}`,
    ]);
    assert.deepEqual(data.deleted, [{ mount: 'work', path: 'r' }], 'the followed link to a regular file is removed');
    assert.throws(() => lstatSync(env.disk('r')), { code: 'ENOENT' }, 'the link itself is gone');
    assert.equal(env.readDisk('file'), 'a regular file', 'and the file it led to stays');
    assert.ok(lstatSync(env.disk('p')).isFIFO(), 'the pipe is still there');
    assert.ok(lstatSync(env.disk('s')).isSocket(), 'the socket is still there');
    for (const link of ['d', 'f']) assert.ok(lstatSync(env.disk(link)).isSymbolicLink(), `the link ${link} is still there`);
    assert.ok(lstatSync(env.disk('target')).isDirectory(), 'and the directory one leads to');
    assert.ok(lstatSync(env.disk('fifo')).isFIFO(), 'and the pipe the other leads to');
    assert.ok(lstatSync(env.disk('x')).isDirectory(), 'the directory is still there');
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

  test("a FIFO swapped in at a checked directory's path doesn't hold up its sync", { skip: process.platform === 'win32' ? 'no FIFOs or directory syncs' : false }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.disk('sub'), { recursive: true });
    const rootReal = realpathSync(env.dir);
    const dir = join(rootReal, 'sub');
    let swapped = false;
    const synced = withFsPromises('open', (original) => async (...args: any[]) => {
      if (!swapped && args[0] === dir) {
        swapped = true; // checked as a directory, then a FIFO put at its path before the sync opens it
        rmSync(dir, { recursive: true });
        assert.equal(spawnSync('mkfifo', [dir]).status, 0, 'mkfifo');
      }
      return original(...args);
    }, () => syncDirectories(viewOf(env.dir), rootReal, ['sub']));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const failed = await Promise.race([synced, new Promise<never>((_, reject) => {
        // Only a sync held by the FIFO comes near this: without one, it settles at once.
        timer = setTimeout(() => reject(new Error('the sync waited on the FIFO')), 10_000);
      })]);
      assert.equal(swapped, true, 'the swap ran');
      assert.match(failed.get('sub') ?? '', /changed while it was observed/);
    } finally {
      clearTimeout(timer);
      // An open still waiting on the FIFO is let go before the mount is removed.
      try {
        closeSync(openSync(dir, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
      } catch {
        // ENXIO: nothing is waiting.
      }
      await synced.catch(() => {});
    }
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
    assert.equal(storedOf(env, 'a.txt'), 'edited before the wrap', 'the third sync wrapped to a.txt');
  });

  test('names that sort apart by UTF-8 byte and by UTF-16 code unit are each taken once across capped syncs', async (t) => {
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
    assert.deepEqual([...taken].sort(), ['b.txt', '\u{1F600}.txt', '\uFF21.txt'].sort(), 'each name once');
  });

  test('a disk edit past the cap reaches the workspace on a later bare sync', async (t) => {
    const env = new Env(t);
    const m = await env.open({ walkCap: 2 });
    for (const f of ['a.txt', 'b.txt', 'c.txt']) await seedSynced(env, m, f, f);
    env.writeDisk('c.txt', 'edited past the cap');
    await call(m, 'sync', {});
    await call(m, 'sync', {});
    assert.equal(storedOf(env, 'c.txt'), 'edited past the cap');
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
    assert.equal(storedOf(env, 'a/1.txt'), 'edited before the wrap');
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
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt']);
    await call(m, 'sync', { path: 'work/d' });
    await call(m, 'sync', { path: 'work/d' });
    await call(m, 'sync', {});
    assert.ok(syncedNames(env).includes('c.txt'), 'the next bare sync resumes after b.txt');
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
    // Read from the store: a read of l3 would pass over l3 itself.
    assert.equal(storedOf(env, 'l3'), 'target zz/t3.txt');
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
    assert.equal(storedOf(env, 'm/1.txt'), 'm/1.txt edited while it was gone');
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
    assert.deepEqual(syncedNames(env), ['a.txt', 'b.txt']);
    // Another directory takes the root's place, holding the same files.
    renameSync(env.dir, `${env.dir}-away`);
    mkdirSync(env.dir);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) env.writeDisk(f, f);
    await call(m, 'sync', { mount: 'work', acceptRoot: true });
    // From the new root's start: a.txt and b.txt. Resuming after the old
    // place would have taken c.txt, then a.txt.
    assert.equal(env.store.treeGet(TREE, 'c.txt'), null, 'c.txt not taken');
  });

  test('a pass that records only a place binds no root, so a replaced root is read as it is', async (t) => {
    const env = new Env(t);
    // A file too large to take in: the passes record no evidence for it.
    env.writeDisk('a.txt', 'more than one byte');
    const m = await env.open({ walkCap: 1, maxFileSize: 1 });
    const agreement = (m as any).agreementOrThrow();
    await call(m, 'sync', {});
    assert.equal(agreement.walkResumesAfter('work', ''), undefined, 'the walk covered the mount');
    env.writeDisk('b.txt', 'more than one byte');
    await call(m, 'sync', {});
    assert.equal(agreement.walkResumesAfter('work', ''), 'a.txt', 'a capped walk keeps its place');
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

  test('a model of the walk: on random trees that change between passes, each pass takes the cyclic window after its place', async (t) => {
    const env = new Env(t);
    const rootReal = realpathSync(env.dir);
    const view = { root: env.dir, followSymlinks: false, maxFileSize: 1 << 20, ignore: [], others: [] } as unknown as MountView;
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

describe('a search starts at the directory its pattern names', () => {
  const matchesOf = async (m: WorkspaceModule, input: Record<string, unknown>): Promise<string[]> =>
    ((await call(m, 'glob', input)).matches as Array<{ path: string }>).map((match) => match.path);
  const grepped = async (m: WorkspaceModule, input: Record<string, unknown>): Promise<string[]> =>
    ((await call(m, 'grep', input)).results as Array<{ file: string }>).map((result) => result.file);
  /**
   * At a walk cap of 2, a walk of the whole mount takes a's first two files
   * and stops before z, and a walk of z takes its own two and stops before
   * z/deep.
   */
  const pastTheCap = (env: Env): void => {
    for (const f of ['a/1.txt', 'a/2.txt', 'a/3.txt', 'z/1.txt', 'z/2.txt']) env.writeDisk(f, 'filler');
    env.writeDisk('z/deep/x.ts', 'a needle');
    env.writeDisk('z/deep/y.ts', 'nothing here');
  };

  // glob and grep each on a mount of its own, so neither answers from what
  // the other's pass took into the store.
  const eachOnItsOwn = async (t: TestContext, open: (env: Env) => Promise<WorkspaceModule>, globbed: [Record<string, unknown>, string[]], grep: [Record<string, unknown>, string[]]): Promise<void> => {
    assert.deepEqual(await matchesOf(await open(new Env(t)), globbed[0]), globbed[1], JSON.stringify(globbed[0]));
    assert.deepEqual(await grepped(await open(new Env(t)), grep[0]), grep[1], JSON.stringify(grep[0]));
  };

  // Each search runs on a mount of its own: one before it would have taken
  // z/deep's files in, and a walk reports what the store holds wherever it
  // stopped.
  test('past the walk cap, glob finds the files in the directory its pattern names', async (t) => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ pattern: '**/*.ts' }, []],
      [{ pattern: 'z/deep/*.ts' }, ['work/z/deep/x.ts', 'work/z/deep/y.ts']],
      [{ path: 'work/z', pattern: 'deep/*.ts' }, ['work/z/deep/x.ts', 'work/z/deep/y.ts']],
      // A pattern with no literal directory starts at the path.
      [{ path: 'work/z/deep', pattern: '*.ts' }, ['work/z/deep/x.ts', 'work/z/deep/y.ts']],
    ];
    for (const [input, want] of cases) {
      const env = new Env(t);
      pastTheCap(env);
      const m = await env.open({ walkCap: 2 });
      assert.deepEqual(await matchesOf(m, input), want, JSON.stringify(input));
    }
  });

  test('past the walk cap, grep searches what its filter names, from the deeper of the filter\'s directory and its path', async (t) => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ pattern: 'needle' }, []],
      [{ pattern: 'needle', glob: 'z/deep/*.ts' }, ['work/z/deep/x.ts']],
      [{ pattern: 'needle', path: 'work/z', glob: 'z/deep/**' }, ['work/z/deep/x.ts']],
      [{ pattern: 'needle', path: 'work/z/deep', glob: 'z/**' }, ['work/z/deep/x.ts']],
      [{ pattern: 'needle', path: 'work/z/deep', glob: 'z/deep/*.ts' }, ['work/z/deep/x.ts']],
    ];
    for (const [input, want] of cases) {
      const env = new Env(t);
      pastTheCap(env);
      const m = await env.open({ walkCap: 2 });
      assert.deepEqual(await grepped(m, input), want, JSON.stringify(input));
    }
  });

  // In the mount its first segment names, a pattern is read mount-prefixed,
  // so its walk starts at z/deep: a walk from the root would stop at the cap
  // and name regions outside z/deep.
  test('past the walk cap, a mount-prefixed pattern walks from the directory the rest of it names, in glob and in grep\'s filter', async (t) => {
    const outside = (regions: Array<{ path: string }> | undefined) => (regions ?? []).filter((r) => !r.path.startsWith('work/z/deep'));
    // Where the mount also holds part of a directory named like itself, the
    // pattern isn't read as written there, so nothing walks it.
    for (const partial of [false, true]) {
      const layout = (env: Env): void => {
        pastTheCap(env);
        if (partial) for (const f of ['work/z/1.txt', 'work/z/2.txt', 'work/z/3.txt']) env.writeDisk(f, 'filler');
      };
      const globs: Array<[Record<string, unknown>, string[]]> = [
        [{ pattern: 'work/z/deep/*.ts' }, ['work/z/deep/x.ts', 'work/z/deep/y.ts']],
        [{ pattern: 'work/z/deep/**/*.ts' }, ['work/z/deep/x.ts', 'work/z/deep/y.ts']],
        [{ path: 'work/z', pattern: 'work/z/deep/*.ts' }, ['work/z/deep/x.ts', 'work/z/deep/y.ts']],
      ];
      for (const [input, want] of globs) {
        const env = new Env(t);
        layout(env);
        const m = await env.open({ walkCap: 2 });
        const found = await call(m, 'glob', input);
        const what = JSON.stringify({ partial, ...input });
        assert.deepEqual(found.matches.map((match: { path: string }) => match.path), want, what);
        assert.deepEqual(outside(found.incomplete), [], what);
      }
      const greps: Array<[Record<string, unknown>, string[]]> = [
        [{ pattern: 'needle', glob: 'work/z/deep/*.ts' }, ['work/z/deep/x.ts']],
        [{ pattern: 'needle', path: 'work/z', glob: 'work/z/deep/**' }, ['work/z/deep/x.ts']],
      ];
      for (const [input, want] of greps) {
        const env = new Env(t);
        layout(env);
        const m = await env.open({ walkCap: 2 });
        const searched = await call(m, 'grep', input);
        const what = JSON.stringify({ partial, ...input });
        assert.deepEqual(searched.results.map((result: { file: string }) => result.file), want, what);
        assert.deepEqual(outside(searched.incomplete), [], what);
      }
    }
  });

  // In a mount holding a directory named like itself, a pattern written
  // relative to the mount, as main reads every pattern, now reads
  // mount-prefixed: `work/z/deep/*.ts` names the mount's own z/deep, not
  // work/z/deep inside it. The tools show that file as work/work/z/deep/q.ts,
  // and that pattern finds it, past the cap too.
  test('in a mount holding a directory named like itself, a pattern naming the mount reads mount-prefixed only', async (t) => {
    for (const cap of [undefined, 2]) {
      const layout = async (env: Env): Promise<WorkspaceModule> => {
        if (cap) pastTheCap(env); else env.writeDisk('z/deep/x.ts', 'a needle');
        env.writeDisk('work/z/deep/q.ts', 'a needle');
        return env.open(cap ? { walkCap: cap } : {});
      };
      await eachOnItsOwn(t, layout,
        [{ pattern: 'work/z/deep/*.ts' }, cap ? ['work/z/deep/x.ts', 'work/z/deep/y.ts'] : ['work/z/deep/x.ts']],
        [{ pattern: 'needle', glob: 'work/z/deep/*.ts' }, ['work/z/deep/x.ts']]);
      await eachOnItsOwn(t, layout,
        [{ pattern: 'work/work/z/deep/*.ts' }, ['work/work/z/deep/q.ts']],
        [{ pattern: 'needle', glob: 'work/work/z/deep/*.ts' }, ['work/work/z/deep/q.ts']]);
      // With a path inside that directory, glob's pattern relative to the
      // path reads as main reads it. grep's filter, which main reads relative
      // to the mount, reads mount-prefixed there too, and names the mount's
      // own z/deep, outside the path, so it's refused, naming the filter that
      // reaches beneath the path, which finds the file.
      assert.deepEqual(await matchesOf(await layout(new Env(t)), { path: 'work/work', pattern: 'z/deep/*.ts' }), ['work/work/z/deep/q.ts']);
      const m = await layout(new Env(t));
      assert.match(
        await refused(m, 'grep', { pattern: 'needle', path: 'work/work', glob: 'work/z/deep/*.ts' }),
        /is read mount-prefixed, from the root of mount "work", so no file within "work\/work" matches it\. To filter beneath it, write "work\/work\/z\/deep\/\*\.ts"\.$/,
      );
      assert.deepEqual(await grepped(m, { pattern: 'needle', path: 'work/work', glob: 'work/work/z/deep/*.ts' }), ['work/work/z/deep/q.ts']);
    }
  });

  // A walk named at a directory sets aside the ignore patterns that cover it,
  // so a mount-prefixed pattern finds what lies beneath an ignored directory
  // it names: here node_modules, in a direct mount's default ignore list.
  test('on a direct mount, a mount-prefixed pattern finds what lies beneath the ignored directory it names', async (t) => {
    const env = new Env(t);
    env.writeDisk('node_modules/pkg/b.js', 'a needle');
    env.writeDisk('work/node_modules/pkg/a.js', 'a needle');
    const m = await env.open({ backend: 'direct', mode: 'read-only' } as Partial<MountConfig>);
    assert.deepEqual(await matchesOf(m, { pattern: 'work/node_modules/pkg/*.js' }), ['work/node_modules/pkg/b.js']);
    assert.deepEqual(await grepped(m, { pattern: 'needle', glob: 'work/node_modules/pkg/*.js' }), ['work/node_modules/pkg/b.js']);
    assert.deepEqual(await matchesOf(m, { pattern: 'work/work/node_modules/pkg/*.js' }), ['work/work/node_modules/pkg/a.js']);
  });

  // A pass reports what the workspace tracks beneath its scope whatever disk
  // shows, so a mount-prefixed pattern lists a draft written where disk has
  // no directory.
  test('a mount-prefixed pattern lists what the workspace holds where disk has no directory', async (t) => {
    const want = ['work/z/deep/new.ts', 'work/z/deep/x.ts'];
    await eachOnItsOwn(t, async (env) => {
      env.writeDisk('z/deep/x.ts', 'a needle');
      const m = await env.open();
      await call(m, 'write', { path: 'work/z/deep/new.ts', content: 'a needle' });
      return m;
    }, [{ pattern: 'work/z/deep/*.ts' }, want], [{ pattern: 'needle', glob: 'work/z/deep/*.ts' }, want]);
    await eachOnItsOwn(t, async (env) => {
      const m = await env.open();
      await call(m, 'write', { path: 'work/q/new.ts', content: 'a needle' });
      return m;
    }, [{ pattern: 'work/q/*.ts' }, ['work/q/new.ts']], [{ pattern: 'needle', glob: 'work/q/*.ts' }, ['work/q/new.ts']]);
  });

  // Each list is what a walk of the whole mount finds: the test passes on
  // the code before searches started at their pattern's directory too.
  test('within the cap, each pattern finds what a walk of the whole mount finds, and leaves nothing incomplete', async (t) => {
    const env = new Env(t);
    for (const f of ['README.md', 'src/a.ts', 'src/lib/b.ts', 'src/lib/c.js', 'test/a.test.ts']) env.writeDisk(f, 'a needle');
    const m = await env.open();
    const cases: Array<[string, string[]]> = [
      ['**/*.ts', ['src/a.ts', 'src/lib/b.ts', 'test/a.test.ts']],
      ['src/*.ts', ['src/a.ts']],
      ['src/lib/b.ts', ['src/lib/b.ts']],
      ['src/{lib,x}/*.js', ['src/lib/c.js']],
      ['src/l?b/*', ['src/lib/b.ts', 'src/lib/c.js']],
      ['README.md', ['README.md']],
      // A segment that's empty, `.` or `..` ends the directory, and none matches.
      ['./src/*.ts', []],
      ['../work/src/*.ts', []],
      ['src//a.ts', []],
      // A directory that isn't there, and one beneath a file.
      ['nowhere/*.ts', []],
      ['README.md/*.ts', []],
    ];
    for (const [pattern, expected] of cases) {
      const want = expected.map((p) => `work/${p}`);
      const found = await call(m, 'glob', { pattern });
      assert.deepEqual(found.matches.map((match: { path: string }) => match.path), want, `glob ${pattern}`);
      assert.deepEqual(found.incomplete ?? [], [], `glob ${pattern}`);
      const searched = await call(m, 'grep', { pattern: 'needle', glob: pattern });
      assert.deepEqual(searched.results.map((result: { file: string }) => result.file), want, `grep's filter ${pattern}`);
      assert.deepEqual(searched.incomplete ?? [], [], `grep's filter ${pattern}`);
    }
  });

  test('a wildcard segment walks from above it, even where a directory has its name', async (t) => {
    const env = new Env(t);
    for (const dir of ['lib', 'l?b', 'a', 'b', '{a,b}', '*']) env.writeDisk(`${dir}/x.ts`, 'a needle');
    const m = await env.open();
    const cases: Array<[string, string[]]> = [
      ['l?b/x.ts', ['l?b', 'lib']],
      ['{a,b}/x.ts', ['a', 'b']],
      ['*/x.ts', ['lib', 'l?b', 'a', 'b', '{a,b}', '*']],
    ];
    for (const [pattern, dirs] of cases) {
      const want = dirs.map((dir) => `work/${dir}/x.ts`).sort();
      assert.deepEqual((await matchesOf(m, { pattern })).sort(), want, `glob ${pattern}`);
      assert.deepEqual((await grepped(m, { pattern: 'needle', glob: pattern })).sort(), want, `grep's filter ${pattern}`);
    }
  });

  test('a path and a grep filter, or a mount-prefixed glob pattern, whose directories don\'t overlap are refused, searching nothing and taking nothing in', async (t) => {
    const env = new Env(t);
    env.writeDisk('src/a.ts', 'a needle');
    env.writeDisk('test/a.test.ts', 'a needle');
    env.writeDisk('testing/a.ts', 'a needle');
    const m = await env.open();
    assert.match(await refused(m, 'grep', { pattern: 'needle', path: 'work/test', glob: 'src/**' }), /so no file within "work\/test" matches it/);
    // A sibling whose name starts with the path's lies outside it.
    assert.match(await refused(m, 'grep', { pattern: 'needle', path: 'work/test', glob: 'testing/**' }), /so no file within "work\/test" matches it/);
    // glob's mount-prefixed pattern there is refused too, before any walk.
    assert.match(await refused(m, 'glob', { path: 'work/test', pattern: 'work/src/**' }), /so no file within "work\/test" matches it/);
    for (const path of ['test/a.test.ts', 'src/a.ts', 'testing/a.ts']) {
      assert.equal(env.store.treeGet(TREE, path), null, `no pass took in ${path}`);
    }
  });

  // On a case-insensitive disk, as macOS's is by default, a walk started at
  // `SRC` would name src's files `SRC/…` and take them in beside their own.
  // Elsewhere there's no `SRC` to walk, and this holds either way.
  test('a pattern that spells its directory in another case walks from where disk lists it, finds nothing, and takes nothing in under that spelling', async (t) => {
    const env = new Env(t);
    env.writeDisk('src/a.ts', 'a needle');
    const m = await env.open();
    assert.deepEqual(await matchesOf(m, { pattern: 'SRC/*.ts' }), []);
    assert.deepEqual(await grepped(m, { pattern: 'needle', glob: 'SRC/*.ts' }), []);
    assert.equal(env.store.treeGet(TREE, 'SRC/a.ts'), null);
    assert.ok(!env.eventsOf('workspace:created').flatMap((e) => e.paths).includes('work/SRC/a.ts'));
    // The walk started from the root, where disk lists `src`, and took the
    // file in under its own spelling.
    assert.notEqual(env.store.treeGet(TREE, 'src/a.ts'), null);
  });

  test('a pattern whose directory disk doesn\'t list walks from the deepest directory it does', async (t) => {
    const env = new Env(t);
    pastTheCap(env);
    const m = await env.open({ walkCap: 2 });
    // From z, the walk stops before z/deep.
    const found = await call(m, 'glob', { pattern: 'z/nowhere/*.ts' });
    assert.deepEqual(found.matches, []);
    assert.deepEqual(found.incomplete?.map((r: { path: string }) => r.path), ['work/z/deep'], JSON.stringify(found));
    const searched = await call(m, 'grep', { pattern: 'needle', glob: 'z/nowhere/*.ts' });
    assert.deepEqual(searched.results, []);
    assert.deepEqual(searched.incomplete?.map((r: { path: string }) => r.path), ['work/z/deep'], JSON.stringify(searched));
  });

  test('a search that starts lower takes in and announces only what lies beneath its start, and doesn\'t count as the first whole sync', async (t) => {
    const env = new Env(t);
    env.writeDisk('src/a.ts', 'one');
    env.writeDisk('docs/b.md', 'two');
    const m = await env.open();
    await call(m, 'glob', { pattern: 'src/*.ts' });
    assert.notEqual(env.store.treeGet(TREE, 'src/a.ts'), null, 'beneath the start: taken in');
    assert.equal(env.store.treeGet(TREE, 'docs/b.md'), null, 'elsewhere: left to a pass that covers it');
    assert.deepEqual(env.eventsOf('workspace:created').flatMap((e) => e.paths), ['work/src/a.ts']);
    assert.equal((await call(m, 'status', {})).work.initialSyncDone, false);
    await call(m, 'grep', { pattern: 'one', glob: 'src/*.ts' });
    assert.equal((await call(m, 'status', {})).work.initialSyncDone, false, 'nor a grep whose filter names a directory');
    await call(m, 'glob', { pattern: '**/*.md' });
    assert.notEqual(env.store.treeGet(TREE, 'docs/b.md'), null);
    assert.equal((await call(m, 'status', {})).work.initialSyncDone, true, 'a pattern with no literal directory walks the whole mount');
  });

  test('a pattern into a directory the mount passes over by design names that directory, as a search given it as its path does', async (t) => {
    const env = new Env(t);
    env.writeDisk('vendor/lib/x.js', 'x');
    env.writeDisk('a/b/sub/y.js', 'y');
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', ignore: ['vendor'] },
      { name: 'deep', path: env.disk('a/b'), mode: 'read-write', watch: 'never' },
    ] });
    // An ignored directory, and another mount's: nothing beneath either is
    // listed to choose the start.
    for (const [dir, beneath] of [['vendor', 'lib'], ['a/b', 'sub']]) {
      const viaPath = await call(m, 'glob', { path: `work/${dir}`, pattern: '**' });
      assert.equal(viaPath.incomplete?.length, 1, JSON.stringify(viaPath));
      assert.equal(viaPath.incomplete[0].path, `work/${dir}`);
      const found = await call(m, 'glob', { pattern: `${dir}/${beneath}/*.js` });
      assert.deepEqual(found.matches, [], dir);
      assert.deepEqual(found.incomplete, viaPath.incomplete, `glob ${dir}`);
      const searched = await call(m, 'grep', { pattern: '.', glob: `${dir}/${beneath}/*.js` });
      assert.deepEqual(searched.results, [], dir);
      assert.deepEqual(searched.incomplete, viaPath.incomplete, `grep's filter ${dir}`);
    }
  });

  test('a pattern through a symlinked directory reaches nothing past the link, as a walk of the whole mount does', async (t) => {
    const env = new Env(t);
    env.writeDisk('real/x.ts', 'x');
    symlinkSync('real', env.disk('link'));
    const outside = mkdtempSync(join(tmpdir(), 'ws-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'sub', 'y.ts'), 'y');
    symlinkSync(outside, env.disk('out'));
    const m = await env.open();
    // A link inside the mount, one leading out of it, and a directory
    // beyond one: each is passed over, as a walk from the root passes it.
    for (const pattern of ['link/*.ts', 'out/sub/*.ts']) {
      assert.deepEqual(await matchesOf(m, { pattern }), [], `glob ${pattern}`);
      assert.deepEqual(await grepped(m, { pattern: '.', glob: pattern }), [], `grep's filter ${pattern}`);
    }
    for (const path of ['link/x.ts', 'out/sub/y.ts']) {
      assert.equal(env.store.treeGet(TREE, path), null, `nothing taken in at ${path}`);
    }
    // A path through the link that leads out is refused, naming the link,
    // and nothing past it is listed to choose a deeper start.
    const viaPath = await call(m, 'glob', { path: 'work/out', pattern: 'sub/*.ts' });
    assert.deepEqual(viaPath.matches, []);
    assert.deepEqual(viaPath.incomplete?.map((r: { path: string }) => r.path), ['work/out'], JSON.stringify(viaPath));
  });
});

describe('the mount boundary', () => {
  test('a root replaced during an absence proof proves nothing: the replacement lacks what the original still holds', async (t) => {
    const env = new Env(t);
    mkdirSync(env.disk('sub'), { recursive: true });
    env.writeDisk('sub/a.txt', 'A');
    const st = statSync(env.dir, { bigint: true });
    const view = { root: env.dir, rootIdentity: { dev: String(st.dev), ino: String(st.ino) }, followSymlinks: false, maxFileSize: 1e6, ignore: [], others: [] } as unknown as MountView;
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
    assert.ok(!(typeof proof === 'object' && 'by' in proof), `no absence is proven: ${JSON.stringify(proof)}`);
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
    assert.match(reasons, /link\.txt: not written: disk has a symlink at this path, which this mount does not follow, and no push writes through one, forced or not/);
    // This mount doesn't follow symlinks, so a symlinked directory on the way
    // is refused as such, wherever it leads.
    assert.match(reasons, /linkdir\/inner\.txt: not written: "work\/linkdir" is a symlink leading outside the mount, which this mount does not follow/);
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
      assert.match(pushed.skipped[0]!.reason, /^not written: "work\/sub" is a symlink leading outside the mount, which this mount does not follow; followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it$/);
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
    assert.match(pushed.skipped[0]!.reason, /^not unlinked: "work\/sub" is a symlink leading outside the mount, which this mount does not follow; followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it$/);
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
    assert.match(pushed.skipped[0]!.reason, /^not written: disk changed since it was checked — materializing again checks it afresh$/);
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
    assert.match(pushed.skipped[0]!.reason, /^not written: something appeared at this path since it was checked — materializing again checks it afresh$/);
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
    assert.match(pushed.skipped[0]!.reason, /disk changed since it was checked — materializing again checks it afresh$/);
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
    assert.match(skip, /check the file, then materialize it with force to overwrite it, or sync this path/);
    assert.equal(env.readDisk('a.txt'), 'v2, cut off');
    await call(m, 'materialize', { force: true });
    assert.equal(env.readDisk('a.txt'), 'v2');
  });

  test('an interrupted path whose disk copy is deleted since says disk has no copy, and force writes the workspace copy back', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    await call(m, 'write', { path: 'work/a.txt', content: 'v2' });
    m = await env.fault(m, 'materialize', 'after-intent');
    env.writeDisk('a.txt', 'v2, cut off');
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.kind, 'interrupted');
    env.rmDisk('a.txt');
    const skip = JSON.stringify(await call(m, 'materialize', {}));
    assert.match(skip, /a\.txt: disk has no copy of this file \(conflict: interrupted\) — sync this path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back"/);
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
    assert.deepEqual(data.incomplete, [{ path: 'sub', reason: 'the directory changed while the walk ran — listing it checks it afresh' }]);
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
      // A mount that follows symlinks finds where this one leads; one that
      // doesn't refuses the link itself, wherever it leads.
      assert.match(error, followSymlinks ? /outside the mount/ : /"work\/escape" is a symlink leading outside the mount, which this mount does not follow/);
      assert.doesNotMatch(error, /OUTSIDE_SENTINEL/);
      const scoped = await call(m, 'ls', { path: 'work/escape', recursive: true });
      assert.deepEqual(scoped.entries, []);
      assert.deepEqual(scoped.incomplete, [{
        path: 'escape',
        reason: followSymlinks
          ? 'the directory resolves outside the mount — listing it won\'t change that; nothing done through this mount reaches where it resolves, and whoever runs this host can mount that place'
          : '"work/escape" is a symlink leading outside the mount, which this mount does not follow; followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it',
      }]);
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
    assert.deepEqual(data.incomplete, [{ path: '', reason: "the mount root is unavailable — listing it won't change that; whoever runs this host can put the mount's directory back at its path, and the workspace then reaches it" }]);
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

  test("a conflict's disk version with CRLF ends is searched and shown as read shows its lines, and says so", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', 'disk says ALPHA\r\nsecond\r\n');
    await call(m, 'write', { path: 'work/a.txt', content: 'workspace says GAMMA\n' });
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.diskCopy, 'stored');
    const data = await call(m, 'grep', { pattern: 'ALPHA$' });
    assert.deepEqual(data.results.map((r: { version: string; lineEndings?: string; matches: Array<{ text: string }> }) => [r.version, r.lineEndings, r.matches[0]!.text]),
      [['conflicting-disk', 'CRLF', 'disk says ALPHA']]);
    // A CR pattern searched only the disk version's CRLF ends, and says why it
    // finds no CR there.
    const cr = await call(m, 'grep', { pattern: '\\r$' });
    assert.deepEqual(cr.results, []);
    assert.match(cr.note, /^The pattern names a CR, and 1 file searched has CRLF line ends: work\/a\.txt \(CRLF in its conflicting-disk version\)\. /);
  });

  test("a conflict whose workspace copy and disk version both have CRLF ends and a BOM is named once in each note, as the workspace's copy", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', '\uFEFFdisk says ALPHA\r\n');
    await call(m, 'write', { path: 'work/a.txt', content: '\uFEFFworkspace says GAMMA\r\n' });
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.diskCopy, 'stored');
    const cr = await call(m, 'grep', { pattern: '\\r$' });
    assert.deepEqual(cr.results, []);
    assert.match(cr.note, /^The pattern names a CR, and 1 file searched has CRLF line ends: work\/a\.txt \(CRLF\)\. /);
    const bom = await call(m, 'grep', { pattern: '^\\uFEFF' });
    assert.deepEqual(bom.results, []);
    assert.match(bom.note, /^The pattern names U\+FEFF, and 1 file searched starts with a BOM: work\/a\.txt\. /);
  });

  test("a conflict whose workspace copy starts with a BOM and whose disk version has CRLF ends is named in each note for the version that has it", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', 'disk says ALPHA\r\n');
    await call(m, 'write', { path: 'work/a.txt', content: '\uFEFFworkspace says GAMMA\n' });
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.diskCopy, 'stored');
    const cr = await call(m, 'grep', { pattern: '\\r$' });
    assert.deepEqual(cr.results, []);
    assert.match(cr.note, /^The pattern names a CR, and 1 file searched has CRLF line ends: work\/a\.txt \(CRLF in its conflicting-disk version\)\. /);
    const bom = await call(m, 'grep', { pattern: '^\\uFEFF' });
    assert.deepEqual(bom.results, []);
    assert.match(bom.note, /^The pattern names U\+FEFF, and 1 file searched starts with a BOM: work\/a\.txt\. /);
  });

  test("a U+FEFF pattern over a conflict whose disk version alone starts with a BOM gets the note, which names only the workspace's copy as what read shows", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', '\uFEFFdisk says ALPHA\n');
    await call(m, 'write', { path: 'work/a.txt', content: 'workspace says GAMMA\n' });
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.diskCopy, 'stored');
    const data = await call(m, 'grep', { pattern: '^\\uFEFF' });
    assert.deepEqual(data.results, []);
    assert.equal(data.note, "The pattern names U+FEFF, and 1 file searched starts with a BOM: work/a.txt (in its conflicting-disk version). "
      + "Lines are matched as read shows them, and a BOM isn't part of the first line. read with offsetChars shows any BOM the workspace's copy has.");
    // The workspace's copy, which read shows, has none.
    assert.equal((await call(m, 'read', { path: 'work/a.txt', offsetChars: 0 })).content, 'workspace says GAMMA\n');
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

  test("a conflict's recorded disk version with CRLF ends and a BOM is named as that version in each note", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'v1');
    env.writeDisk('a.txt', '\uFEFFdisk says ALPHA\r\n');
    await call(m, 'write', { path: 'work/a.txt', content: 'workspace says GAMMA\n' });
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.diskCopy, 'stored');
    env.writeDisk('a.txt', 'disk now says BETA\n');
    assert.equal((await entryOf(m, 'a.txt'))?.conflict?.diskChangedSinceRecorded, true);
    const cr = await call(m, 'grep', { pattern: '\\r$' });
    assert.deepEqual(cr.results, []);
    assert.match(cr.note, /^The pattern names a CR, and 1 file searched has CRLF line ends: work\/a\.txt \(CRLF in its recorded-disk version\)\. /);
    const bom = await call(m, 'grep', { pattern: '^\\uFEFF' });
    assert.deepEqual(bom.results, []);
    assert.match(bom.note, /^The pattern names U\+FEFF, and 1 file searched starts with a BOM: work\/a\.txt \(in its recorded-disk version\)\. /);
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

  async function conflictWithBothVersionsLost(t: TestContext): Promise<{ env: Env; m: WorkspaceModule }> {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'conflict.txt', 'nothing');
    env.writeDisk('conflict.txt', 'needle on disk');
    await call(m, 'write', { path: 'work/conflict.txt', content: 'needle in the workspace' });
    const listed = (await call(m, 'ls', { path: 'work' })).entries.find((e: { name: string }) => e.name === 'conflict.txt');
    assert.equal(listed?.conflict?.diskCopy, 'stored');
    await env.shutdown(m);
    for (const text of ['needle on disk', 'needle in the workspace']) rmSync(join(env.storePath, 'blobs', sha(text).slice(0, 2), sha(text)));
    env.store = JsStore.openOrCreate({ path: env.storePath });
    m = await env.open();
    return { env, m };
  }

  test("a conflict's disk version missing from the store is searched from disk while disk still holds it", async (t) => {
    const { m } = await conflictWithBothVersionsLost(t);
    const data = await call(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(data.results.map((r: { file: string; version: string; matches: Array<{ text: string }> }) => [r.file, r.version, r.matches.map((x) => x.text)]),
      [['work/conflict.txt', 'conflicting-disk', ['needle on disk']]]);
    assert.deepEqual(data.skipped, [
      { file: 'work/conflict.txt', reason: "the workspace's copy is missing from the store, and disk's copy holds other contents, so it was not searched" },
    ]);
  });

  test("a version missing from the store that disk can't restore is listed as not searched, not taken for no match", async (t) => {
    const { env, m } = await conflictWithBothVersionsLost(t);
    env.rmDisk('conflict.txt');
    const data = await call(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(data.results, []);
    assert.deepEqual((data.skipped ?? []).map((x: { reason: string }) => x.reason), [
      "the workspace's copy is missing from the store, and disk has no copy, so it was not searched",
      'conflict: the disk version recorded with the conflict is missing from the store, and disk has no copy, so it was not searched',
    ]);
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
    assert.deepEqual(scan.incomplete, [{ path: 'locked', reason: "cannot list (permission denied) — listing it won't change that; whoever runs this host can change the permissions, and the workspace then reaches it" }]);
    const event = env.events.find((e) => e.type === 'workspace:agent-action-scan-incomplete') as unknown as
      | { mount: string; incomplete: Array<{ path: string; reason: string }> } | undefined;
    assert.equal(event?.mount, 'work');
    assert.deepEqual(event?.incomplete, [{ path: 'locked', reason: "cannot list (permission denied) — listing it won't change that; whoever runs this host can change the permissions, and the workspace then reaches it" }]);
  });

  test('a scan that outlasts its deadline is reported incomplete, and still finishes', async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 50 });
    env.writeDisk('late.txt', 'arrives late');
    const mount = (m as any).mounts.get('work');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = (m as any).withMount(mount, () => gate); // another pass holds the mount

    try {
      await m.onToolBatchComplete('agent');
      const status = await call(m, 'status', {});
      assert.equal(status.work.lastAgentActionScan.complete, false);
      assert.equal(status.work.lastAgentActionScan.withinDeadline, false);
      assert.match(status.work.lastAgentActionScan.reason, /deadline exceeded \(50 ms\); the scan continues/);
      assert.ok(env.events.some((e) => e.type === 'workspace:agent-action-scan-incomplete'));
      assert.equal(env.store.treeGet(TREE, 'late.txt'), null, 'nothing was claimed before the scan ran');
    } finally {
      release();
    }
    await held;
    await (m as any).mountTurns.get('work');
    assert.notEqual(env.store.treeGet(TREE, 'late.txt'), null, 'the scan finished afterwards');
    const status = await call(m, 'status', {});
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
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = mod.withMount(mount, () => gate); // another pass holds the mount
    env.writeDisk('a.txt', 'from the batches');
    const batches = Promise.all([m.onToolBatchComplete('agent'), m.onToolBatchComplete('agent'), m.onToolBatchComplete('agent')]);
    release();
    await batches;
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
    // Another pass holds the mount until the test lets it go.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = mod.withMount(mount, () => gate);

    let scan: any;
    try {
      await m.onToolBatchComplete('agent'); // held to its deadline
      // A batch held for its scan would now wait out 20 s, with the mount still held: far past until's bound.
      mod.config.agentActionScanDeadlineMs = 20_000;
      env.writeDisk('later.txt', 'from the second batch');
      let returned = false;
      const second = m.onToolBatchComplete('agent').then(() => { returned = true; });
      await until(() => returned, 'the second batch returned while the earlier scan still held the mount');
      await second;
      scan = (await call(m, 'status', {})).work.lastAgentActionScan;
      assert.match(scan.reason, /an earlier scan is still running past its deadline/);
    } finally {
      release();
    }

    await held;
    await mod.mountTurns.get('work');
    assert.equal(passes, 1, 'the second batch shared the scan still waiting');
    assert.notEqual(env.store.treeGet(TREE, 'later.txt'), null, "the second batch's change was scanned");
    // The late scan is over (its bookkeeping settles a few ticks after the
    // mount's turn), so the next batch is held for its own scan again.
    await new Promise((resolve) => setImmediate(resolve));
    await m.onToolBatchComplete('agent');
    scan = (await call(m, 'status', {})).work.lastAgentActionScan;
    assert.deepEqual({ complete: scan.complete, withinDeadline: scan.withinDeadline }, { complete: true, withinDeadline: true },
      'the next batch returned once its own scan had finished, within its deadline');
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
      await until(() => passes >= 2, 'the second scan started');
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
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 50 });
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
      await until(() => passes >= 2, 'the second scan started');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(passes, 2, 'the second scan runs');
      // A batch held for its scan would now wait out 20 s, with the second scan still held: far past until's bound.
      mod.config.agentActionScanDeadlineMs = 20_000;
      let returned = false;
      const third = m.onToolBatchComplete('agent').then(() => { returned = true; }); // while the late second scan still runs
      await until(() => returned, 'the third batch returned while the late second scan still ran');
      await third;
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
    assert.deepEqual(data.incomplete, [{ path: '', reason: 'the selected branch kept changing while the scan ran — listing it checks it afresh' }]);
  });

  test("a read whose disk check gives up on a branch that keeps changing says it shows the workspace's copy, and why", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    const data = await withReadHook((n) => env.store.switchBranch(n % 2 === 1 ? 'other' : main),
      () => call(m, 'read', { path: 'work/a.txt' }));
    assert.equal(data.content, '     1\tA');
    assert.equal(data.note, "The path couldn't be checked against disk (the selected branch kept changing while the scan ran), so this read shows the workspace's copy. Read again to check it.");
    // A character page says so too, and so does a line page under a result
    // limit, each read starting on main, as the first did.
    const switching = (n: number) => env.store.switchBranch(n % 2 === 1 ? 'other' : main);
    env.store.switchBranch(main);
    const chars = await withReadHook(switching, () => call(m, 'read', { path: 'work/a.txt', offsetChars: 0, limitChars: 10 }));
    assert.equal(chars.content, 'A');
    assert.equal(chars.note, data.note);
    env.store.switchBranch(main);
    const limited = await withReadHook(switching, () => m.handleToolCall({ id: 't', name: 'read', input: { path: 'work/a.txt' }, resultMaxChars: 1_000 }));
    assert.equal(limited.success, true, String(limited.error));
    assert.equal((limited.structured as { note?: string }).note, data.note);
  });

  test("a read of a conflict on a read-only mount names only the sync, since nothing writes the workspace's copy there", async (t) => {
    const env = new Env(t);
    const m = await env.open({ mode: 'read-only' });
    env.writeDisk('a.txt', 'v1\n');
    await call(m, 'sync', {});
    const main = env.store.currentBranch().name;
    env.store.createBranch('earlier', main);
    env.writeDisk('a.txt', 'v2\n');
    await call(m, 'sync', {});
    // The earlier branch holds the copy disk had before, and disk then changes again.
    env.store.switchBranch('earlier');
    env.writeDisk('a.txt', 'v3 from a shell\n');
    const data = await call(m, 'read', { path: 'work/a.txt' });
    assert.equal(data.content, '     1\tv1');
    assert.equal(data.note, "The path is in conflict with disk (both-changed): this read shows the workspace's copy. "
      + "Sync the path to keep disk's copy and give up the workspace's. The mount is read-only, so nothing writes the workspace's copy to disk.");
  });

  test("a read of a file the workspace doesn't hold, whose disk check gives up, says disk couldn't be checked", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    env.writeDisk('b.txt', 'B');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    const error = await withReadHook((n) => env.store.switchBranch(n % 2 === 1 ? 'other' : main),
      () => refused(m, 'read', { path: 'work/b.txt' }));
    assert.equal(error, `The read did nothing: "work/b.txt" isn't in the workspace, and disk couldn't be checked: the selected branch kept changing while the scan ran. Make the same call again, which checks disk first.`);
  });

  /**
   * Run `fn` with the selected branch changing during each of a pass's
   * gathers, so the pass decides nothing, and then no more: each file a gather
   * reads switches the branch, three times in all, as many as a pass gathers.
   */
  const whileBranchKeepsChanging = <T>(env: Env, fn: () => Promise<T>): Promise<T> => {
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    return withReadHook((n) => { if (n <= 3) env.store.switchBranch(n % 2 === 1 ? 'other' : main); }, fn);
  };
  const KEPT_CHANGING = 'the selected branch kept changing while the scan ran';
  /**
   * Date a file's mtime past now, so no fingerprint recorded for it vouches
   * (fingerprintVouches needs the hash taken past the racy window after the
   * change), and every gather of a pass reads it.
   */
  const unvouched = (env: Env, path: string) => {
    const later = new Date(Date.now() + 60_000);
    utimesSync(env.disk(path), later, later);
  };

  test('a file the workspace doesn\'t hold, under a pass that decided nothing, is answered as unchecked by delete, readBinary, edit and edit_many, not as not found', async (t) => {
    const answers: Record<string, string> = {};
    for (const tool of ['delete', 'readBinary', 'edit', 'edit_many'] as const) {
      const env = new Env(t);
      const m = await env.open();
      env.writeDisk('new.txt', 'hello on disk\n');
      const input = tool === 'delete' ? { path: 'work/new.txt' }
        : tool === 'edit' ? { path: 'work/new.txt', oldString: 'hello', newString: 'bye' }
          : { edits: [{ path: 'work/new.txt', oldString: 'hello', newString: 'bye' }] };
      answers[tool] = await whileBranchKeepsChanging(env, async () => {
        if (tool === 'readBinary') {
          const read = await m.readBinary('work/new.txt');
          return 'error' in read ? read.error : `read ${read.data.length} bytes`;
        }
        const res = await m.handleToolCall({ id: 't', name: tool, input });
        assert.equal(res.success, false, JSON.stringify(res));
        return String(res.error);
      });
      // Disk's file is untouched, and the same call, made again, finds it.
      assert.equal(env.readDisk('new.txt'), 'hello on disk\n');
      if (tool === 'readBinary') {
        const again = await m.readBinary('work/new.txt');
        assert.ok('data' in again && again.data.toString() === 'hello on disk\n', JSON.stringify(again));
      } else {
        const again = await m.handleToolCall({ id: 't', name: tool, input });
        assert.equal(again.success, true, `${tool} again: ${JSON.stringify(again)}`);
      }
    }
    const unchecked = `"work/new.txt" isn't in the workspace, and disk couldn't be checked: ${KEPT_CHANGING}. Make the same call again, which checks disk first.`;
    assert.deepEqual(answers, {
      delete: `The delete did nothing: ${unchecked}`,
      readBinary: unchecked,
      edit: `work/new.txt couldn't be checked against disk (${KEPT_CHANGING}), so the edit changed nothing. Make the same call again, which checks disk first.`,
      edit_many: 'The edit_many call stored none of its edits: 1 problem.\n\n'
        + `edit 1: work/new.txt couldn't be checked against disk (${KEPT_CHANGING}), so edit 1 changed nothing. Make the same call again, which checks disk first.`,
    });
  });

  for (const autoMaterialize of [true, false]) {
    test(`an edit of a file the workspace holds, under a pass that decided nothing, changes nothing on either branch or disk, and says to try again (${autoMaterialize ? 'a mount that pushes' : "one that doesn't push"})`, async (t) => {
      for (const disk of ['unchanged', 'changed'] as const) {
        const env = new Env(t);
        const m = await env.open({ autoMaterialize });
        await seedSynced(env, m, 'a.txt', 'A line\n');
        const main = env.store.currentBranch().name;
        if (disk === 'changed') env.writeDisk('a.txt', 'disk says A2\n');
        unvouched(env, 'a.txt');
        const edit = await whileBranchKeepsChanging(env, () => m.handleToolCall({ id: 't', name: 'edit', input: { path: 'work/a.txt', oldString: 'A line', newString: 'A edited' } }));
        assert.equal(edit.success, false, JSON.stringify(edit));
        assert.equal(edit.error, `work/a.txt couldn't be checked against disk (${KEPT_CHANGING}), so the edit changed nothing. Make the same call again, which checks disk first.`, disk);
        // So does edit_many's, the branch left on `other` by the edit's pass
        // changing under its three gathers in turn.
        assert.equal(env.store.currentBranch().name, 'other');
        const many = await withReadHook((n) => { if (n <= 3) env.store.switchBranch(n % 2 === 1 ? main : 'other'); },
          () => m.handleToolCall({ id: 't', name: 'edit_many', input: { edits: [{ path: 'work/a.txt', oldString: 'A line', newString: 'A edited' }] } }));
        assert.equal(many.success, false, JSON.stringify(many));
        assert.equal(many.error, 'The edit_many call stored none of its edits: 1 problem.\n\n'
          + `edit 1: work/a.txt couldn't be checked against disk (${KEPT_CHANGING}), so edit 1 changed nothing. Make the same call again, which checks disk first.`, disk);
        // Disk is as it was, and each branch's workspace copy is the one the
        // edits found, read from the store, which no pass changes.
        const onDisk = disk === 'changed' ? 'disk says A2\n' : 'A line\n';
        assert.equal(env.readDisk('a.txt'), onDisk);
        const treeStateId = (m as any).mounts.get('work').treeStateId as string;
        for (const branch of [main, 'other']) {
          env.store.switchBranch(branch);
          const entry = env.store.treeGet(treeStateId, 'a.txt');
          assert.equal(entry && env.store.getBlob(entry.blobHash)?.toString(), 'A line\n', `${disk} on ${branch}`);
        }
        // Made again, the edit checks disk: it applies to the text disk holds,
        // and where disk changed, that text no longer has the old line.
        env.store.switchBranch(main);
        const again = await m.handleToolCall({ id: 't', name: 'edit', input: { path: 'work/a.txt', oldString: 'A line', newString: 'A edited' } });
        if (disk === 'unchanged') assert.equal(again.success, true, JSON.stringify(again));
        else assert.match(String(again.error), /^The edit did nothing: oldString isn't in work\/a\.txt\./);
      }
    });
  }

  test('edit_many under a pass that decided nothing refuses every file it names, held or not, and stores nothing on any branch', async (t) => {
    const env = new Env(t);
    const m = await env.open({ autoMaterialize: true });
    await seedSynced(env, m, 'a.txt', 'A line\n');
    await seedSynced(env, m, 'b.txt', 'B line\n');
    env.writeDisk('new.txt', 'N line\n');
    for (const path of ['a.txt', 'b.txt', 'new.txt']) unvouched(env, path);
    // Each file a gather reads selects a branch made for it, so every gather
    // ends on another branch than it began on, however many files it reads.
    const branches = [env.store.currentBranch().name];
    const many = await withReadHook((n) => {
      const name = `churn-${n}`;
      env.store.createBranch(name, env.store.currentBranch().name);
      env.store.switchBranch(name);
      branches.push(name);
    }, () => m.handleToolCall({ id: 't', name: 'edit_many', input: { edits: [
      { path: 'work/a.txt', oldString: 'A line', newString: 'A edited' },
      { path: 'work/b.txt', oldString: 'B line', newString: 'B edited' },
      { path: 'work/new.txt', oldString: 'N line', newString: 'N edited' },
    ] } }));
    assert.equal(many.success, false, JSON.stringify(many));
    const refused = (i: number, path: string) => `edit ${i}: work/${path} couldn't be checked against disk (${KEPT_CHANGING}), so edit ${i} changed nothing. Make the same call again, which checks disk first.`;
    assert.equal(many.error, ['The edit_many call stored none of its edits: 3 problems.', refused(1, 'a.txt'), refused(2, 'b.txt'), refused(3, 'new.txt')].join('\n\n'));
    assert.deepEqual(['a.txt', 'b.txt', 'new.txt'].map((p) => env.readDisk(p)), ['A line\n', 'B line\n', 'N line\n']);
    const treeStateId = (m as any).mounts.get('work').treeStateId as string;
    for (const branch of branches) {
      env.store.switchBranch(branch);
      const text = (path: string) => { const entry = env.store.treeGet(treeStateId, path); return entry ? env.store.getBlob(entry.blobHash)?.toString() : null; };
      assert.deepEqual([text('a.txt'), text('b.txt'), text('new.txt')], ['A line\n', 'B line\n', null], branch);
    }
  });

  test('readBinary and delete answer alike for a file the workspace doesn\'t hold whose disk copy couldn\'t be read', { skip: IS_ROOT ? 'root reads every file' : false }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.writeDisk('new.txt', 'hello on disk\n');
    chmodSync(env.disk('new.txt'), 0o000);
    const read = await m.readBinary('work/new.txt');
    const deleted = await m.handleToolCall({ id: 't', name: 'delete', input: { path: 'work/new.txt' } });
    assert.ok('error' in read, JSON.stringify(read));
    assert.match(read.error, /^"work\/new\.txt" isn't in the workspace, and disk couldn't be checked: .+$/);
    assert.equal(deleted.error, `The delete did nothing: ${read.error}`);
  });

  test("an edit under a pass that decided, with a region left incomplete, applies to the workspace's copy and says so, where one that decided nothing refuses", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A line\n');
    // Another directory where the mount's root was: a pass decides every
    // path as disk couldn't check it, and leaves the root's region incomplete.
    renameSync(env.dir, join(env.root, 'unmounted'));
    mkdirSync(env.dir);
    writeFileSync(join(env.dir, 'a.txt'), 'A line\n');
    const edit = await m.handleToolCall({ id: 't', name: 'edit', input: { path: 'work/a.txt', oldString: 'A line', newString: 'A edited' } });
    assert.equal(edit.success, true, JSON.stringify(edit));
    assert.match(JSON.stringify(edit.structured), /couldn't be checked against disk \(the mount root is not the directory disk last agreed with/);
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
    const pin = async () => {
      const { work } = await call(m, 'status', {});
      return { seq: work.lastMaterializedSeq, branch: work.lastMaterializedBranch };
    };
    const pinned = await pin();
    assert.notEqual(pinned.seq, (saved as { mounts: { work: { lastMaterializedSeq: number } } }).mounts.work.lastMaterializedSeq);
    await m.start({ isRestart: true, getState: () => saved, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    (env as any).live.push(m);
    assert.deepEqual(await pin(), pinned);
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
    const pin = async () => {
      const { work } = await call(m, 'status', {});
      return { pin: work.lastMaterializedBranch, seq: work.lastMaterializedSeq };
    };
    const before = await pin();
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
    assert.deepEqual(await pin(), before, 'pin and watermark as they were');
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
    const status = async () => (await call(m, 'status', {})).work;
    assert.equal((await status()).lastMaterializedBranch, null, 'never pinned');
    const main = env.store.currentBranch().name;
    env.store.createBranch('other', main);
    await call(m, 'write', { path: 'work/b.txt', content: 'B' }); // owed on main
    const seq = (await status()).lastMaterializedSeq;

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
    const after = await status();
    assert.equal(after.lastMaterializedBranch, null, 'still unpinned');
    assert.equal(after.lastMaterializedSeq, seq, 'watermark as it was');
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
    // What's in flight holds the mount until the later work is queued behind it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    void (m as any).withMount(mount, () => gate);
    // stop waits on the tails it takes with Promise.allSettled, which calls each tail's then. The later work is
    // queued once stop is waiting on this tail, so it comes after the tails stop took, whatever stop awaits first.
    const tail = (m as any).mountTurns.get('work');
    let stopWaits = false;
    const then = tail.then;
    tail.then = function (this: Promise<void>, ...args: unknown[]) { stopWaits = true; return then.apply(this, args); };
    const stopping = m.stop();
    await until(() => stopWaits, 'stop waits on what was in flight');
    let finished = false;
    // Appended while stop waits, as a watcher callback or a late scan would be.
    void (m as any).withMount(mount, async () => {
      await sleep(100);
      finished = true;
    });
    release();
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
    assert.match(await refused(m, 'status', { mount: 'nowhere' }), /^The status did nothing: "mount" is "nowhere", which is no mount's name/);
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
    const forced = await call(m, 'materialize', { force: true });
    assert.deepEqual(forced.materialized.map((w: { path: string }) => w.path), ['new.txt']);
    assert.equal(env.readDisk('b.txt'), 'b.txt v1, appended in a shell', 'force without a path does not revert it');

    const bare = await call(m, 'materialize', {});
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
    assert.equal(storedOf(env, 'a.txt'), 'v2 from a shell', 'disk adopted: a tree change disk already holds');
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
    return { dev: String(s.dev), ino: String(s.ino), ...(s.birthtimeNs > 0n && s.birthtimeNs !== s.ctimeNs ? { born: String(s.birthtimeNs) } : {}) };
  };
  const bumped = (n: string) => String(BigInt(n) + 1n);
  const earlier = (n: string) => String(BigInt(n) - 1_000_000n);
  /** Record `identity` as the mount's root, as an earlier process might have, and start a new one. */
  async function recordedAs(env: Env, m: WorkspaceModule, identity: { dev: string; ino: string; born?: string }): Promise<WorkspaceModule> {
    (m as any).agreement.write({ t: 'root', mount: 'work', identity }, {});
    (m as any).agreement.barrier();
    return env.restart(m);
  }
  const rootEntries = (m: WorkspaceModule) => (m as any).agreement.journal.load().entries.filter((e: any) => e.entry.t === 'root');

  test('the root disk agreed under is recorded with the first evidence, again once its birth time can be read, and not with every piece of evidence', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.equal((m as any).agreement.rootIdentity('work'), undefined, 'nothing recorded before any evidence');
    const before = identityOf(env.dir);
    await seedSynced(env, m, 'a.txt', 'A');
    assert.deepEqual((m as any).agreement.rootIdentity('work'), before, 'as the push found it, before it wrote');
    await seedSynced(env, m, 'b.txt', 'B');
    await call(m, 'sync', {});
    await seedSynced(env, m, 'c.txt', 'C');
    await call(m, 'sync', {});
    assert.deepEqual((m as any).agreement.rootIdentity('work'), identityOf(env.dir));
    const rootEntries = (m as any).agreement.journal.load().entries.filter((e: any) => e.entry.t === 'root');
    assert.equal(rootEntries.length, before.born === undefined && identityOf(env.dir).born !== undefined ? 2 : 1, 'recorded again only to learn its birth time');
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

  test('acceptRoot on an empty directory made in the root\'s place keeps the stored files, and a materialize of each path writes it back', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await seedSynced(env, m, 'sub/b.txt', 'B');
    unmount(env);

    assert.deepEqual((await call(m, 'sync', { mount: 'work', acceptRoot: true })).rootsAccepted, ['work']);
    await call(m, 'sync', {});
    assert.equal(await stateOf(m, 'a.txt'), 'disk-missing-provenance-unknown', 'the next sync and ls keep a.txt, which disk lacks');
    assert.equal(await stateOf(m, 'sub/b.txt'), 'disk-missing-provenance-unknown', 'and sub/b.txt');
    assert.equal(await contentOf(m, 'a.txt'), 'A', 'the next sync and ls keep a.txt');
    assert.equal(await contentOf(m, 'sub/b.txt'), 'B', 'and sub/b.txt');
    assert.equal(env.eventsOf('workspace:deleted').length, 0, 'nothing was taken as deleted');

    const skipped = (await call(m, 'materialize', {})).skipped.map((s: any) => s.reason);
    for (const path of ['a.txt', 'sub/b.txt']) {
      assert.ok(skipped.some((r: string) => r.startsWith(`${path}: `) && r.includes('materialize this path to write it')), `a materialize of the mount names ${path}'s step`);
      await call(m, 'materialize', { path: `work/${path}` });
    }
    assert.equal(env.readDisk('a.txt'), 'A');
    assert.equal(env.readDisk('sub/b.txt'), 'B');
  });

  /** The root's identity with a birth time that can be read, after chmods that move its ctime where it can't yet, or a skip where none with a fraction of a second can be. */
  function rootWithBirthTime(t: TestContext, env: Env): { dev: string; ino: string; born: string } | null {
    let now = identityOf(env.dir);
    for (const until = Date.now() + 1000; now.born === undefined && Date.now() < until; now = identityOf(env.dir)) {
      chmodSync(env.dir, statSync(env.dir).mode & 0o7777);
    }
    if (now.born === undefined || BigInt(now.born) % 1_000_000_000n === 0n) {
      t.skip('no birth time with a fraction of a second, apart from its ctime, can be read for this directory here');
      return null;
    }
    return now as { dev: string; ino: string; born: string };
  }

  test('a root on another device with the same inode and birth time is the same directory: its evidence stays, and drafts go out', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await seedSynced(env, m, 'b.txt', 'B');
    await call(m, 'write', { path: 'work/a.txt', content: 'A2, a draft over a synced file' });
    const now = rootWithBirthTime(t, env);
    if (!now) return;
    // What a reboot that renumbered the volume leaves: the recorded root on another device.
    m = await recordedAs(env, m, { ...now, dev: bumped(now.dev) });
    const entriesBefore = rootEntries(m).length;

    // An agent following the remedy for a drive back under a new device number sets nothing aside.
    const accepted = await call(m, 'sync', { mount: 'work', acceptRoot: true });
    assert.equal(accepted.rootsAccepted, undefined, 'acceptRoot finds nothing to accept');
    assert.equal(accepted.incomplete, undefined, 'nothing was left unobserved');
    const entries = rootEntries(m);
    assert.equal(entries.length, entriesBefore + 1, 'the root was recorded again');
    assert.deepEqual(entries.at(-1).entry.identity, now, 'on the device it is on now');
    assert.equal(entries.at(-1).entry.reset, undefined, 'not accepted: the evidence stays');

    const materialized = await call(m, 'materialize', {});
    assert.equal(materialized.skipped, undefined, 'nothing skipped');
    assert.equal(env.readDisk('a.txt'), 'A2, a draft over a synced file', 'the draft over a synced file went out');
    await call(m, 'sync', {});
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
    assert.equal(await stateOf(m, 'b.txt'), 'synced');
    assert.equal(env.eventsOf('workspace:deleted').length, 0, 'nothing was taken as deleted');
  });

  test('a materialize on a renumbered root, with nothing run before it, writes the draft and records the root on its new device', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await call(m, 'write', { path: 'work/a.txt', content: 'A2, a draft over a synced file' });
    const now = rootWithBirthTime(t, env);
    if (!now) return;
    m = await recordedAs(env, m, { ...now, dev: bumped(now.dev) });
    const entriesBefore = rootEntries(m).length;

    const materialized = await call(m, 'materialize', {});
    assert.equal(materialized.skipped, undefined, 'nothing skipped');
    assert.equal(env.readDisk('a.txt'), 'A2, a draft over a synced file', 'the draft went out');
    const entries = rootEntries(m);
    assert.equal(entries.length, entriesBefore + 1, 'the root was recorded again, once');
    assert.deepEqual(entries.at(-1).entry.identity, now, 'on the device it is on now');
    assert.equal(entries.at(-1).entry.reset, undefined, 'not accepted: the evidence stays');
  });

  test('another directory offered as a recorded root leaves the record as it is', (t) => {
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store);
    agreement.open([{ name: 'work', root: env.dir }]);
    const recorded = { dev: '1', ino: '2', born: '5' };
    agreement.recordRootIdentity('work', recorded);
    agreement.recordRootIdentity('work', { dev: '1', ino: '4', born: '5' }); // another inode
    agreement.recordRootIdentity('work', { dev: '3', ino: '2', born: '6' }); // another device and birth time
    agreement.recordRootIdentity('work', { dev: '3', ino: '2' }); // another device, no birth time
    assert.deepEqual(agreement.rootIdentity('work'), recorded);
  });

  test('a stat with no birth time leaves a recorded birth time as it is', (t) => {
    const env = new Env(t);
    const agreement = new DiskAgreement(env.store);
    agreement.open([{ name: 'work', root: env.dir }]);
    agreement.recordRootIdentity('work', { dev: '1', ino: '2', born: '3' });
    agreement.recordRootIdentity('work', { dev: '1', ino: '2' });
    assert.deepEqual(agreement.rootIdentity('work'), { dev: '1', ino: '2', born: '3' });
  });

  test('identities on different devices with another inode, another birth time, or no birth time to compare are different directories', () => {
    for (const bornFixed of [true, false]) {
      assert.equal(sameRootIdentity({ dev: '1', ino: '2', born: '5' }, { dev: '3', ino: '4', born: '5' }, bornFixed), false, 'another inode');
      assert.equal(sameRootIdentity({ dev: '1', ino: '2', born: '5' }, { dev: '3', ino: '2', born: '6' }, bornFixed), false, 'another birth time');
      assert.equal(sameRootIdentity({ dev: '1', ino: '2' }, { dev: '3', ino: '2' }, bornFixed), false);
      assert.equal(sameRootIdentity({ dev: '1', ino: '2', born: '5' }, { dev: '3', ino: '2' }, bornFixed), false);
      assert.equal(sameRootIdentity({ dev: '1', ino: '2' }, { dev: '3', ino: '2', born: '5' }, bornFixed), false);
    }
  });

  test('two volume roots on different devices born in the same whole second are different directories', () => {
    // As two ext4 filesystems an installer made in one second show them: inode 2, and a birth time in whole seconds.
    const second = '1792560071000000000';
    for (const bornFixed of [true, false]) {
      assert.equal(sameRootIdentity({ dev: '65028', ino: '2', born: second }, { dev: '65027', ino: '2', born: second }, bornFixed), false);
      assert.equal(sameRootIdentity({ dev: '65028', ino: '2', born: second }, { dev: '65028', ino: '2', born: second }, bornFixed), true, 'on one device, as before');
    }
  });

  test('a root recorded without its birth time gains it at the next pass, which keeps it across a restart', async (t) => {
    const env = new Env(t);
    let m = await env.open(); // a mount with no files: the pass records nothing else
    chmodSync(env.dir, 0o755);
    const now = rootWithBirthTime(t, env);
    if (!now) return;
    m = await recordedAs(env, m, { dev: now.dev, ino: now.ino });

    await call(m, 'sync', {});
    assert.equal((m as any).agreement.paths('work').length, 0, 'no evidence was recorded');
    assert.deepEqual((m as any).agreement.rootIdentity('work'), now, 'the birth time was');
    m = await env.restart(m);
    assert.deepEqual((m as any).agreement.rootIdentity('work'), now, 'and it was there after a restart');
  });

  const rootRegion = (answer: any) => answer.incomplete?.find((r: any) => (r.mount ?? 'work') === 'work' && r.path === '')?.reason;
  const bornAt = (born: string) => {
    const ns = BigInt(born);
    return `${new Date(Number(ns / 1_000_000_000n) * 1000).toISOString().replace(/\.000Z$/, '')}.${String(ns % 1_000_000_000n).padStart(9, '0')}Z`;
  };
  const shown = (root: Record<string, any>) =>
    Object.fromEntries(Object.entries(root).map(([key, value]) => [key, value?.born !== undefined ? { ...value, born: bornAt(value.born) } : value]));

  test('status shows a birth time as an ISO time in UTC to the nanosecond, every digit below the second kept', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const { dev, ino } = identityOf(env.dir);
    for (const [born, time] of [
      ['1893456000123456789', '2030-01-01T00:00:00.123456789Z'],
      ['1893456000000000042', '2030-01-01T00:00:00.000000042Z'],
      ['1893456000000000000', '2030-01-01T00:00:00.000000000Z'],
      ['253402300800000000001', '+010000-01-01T00:00:00.000000001Z'],
    ]) {
      m = await recordedAs(env, m, { dev, ino, born });
      assert.equal((await call(m, 'status', { mount: 'work' })).work.root.recorded.born, time, born);
      assert.equal((m as any).agreement.rootIdentity('work').born, born, `${born}: the record keeps its own form`);
    }
  });

  test('with nothing recorded, status takes any directory at the root\'s path as the root', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    renameSync(env.dir, `${env.dir}-away`);
    mkdirSync(env.dir);
    assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({
      recorded: null,
      now: identityOf(env.dir),
      note: 'nothing is recorded of this root yet, so any directory at its path is taken as it; the first sync that takes in a file, or materialize that writes one, records it',
    }));
    env.writeDisk('a.txt', 'A');
    const synced = await call(m, 'sync', {});
    assert.equal(rootRegion(synced), undefined, 'a sync uses it');
    assert.ok(synced.results.some((r: any) => r.synced?.includes('a.txt')), 'and takes in its file');
  });

  for (const [what, change, directoryThere] of [
    ['another directory', (env: Env) => { unmount(env); }, true],
    ['nothing', (env: Env) => { renameSync(env.dir, `${env.dir}-away`); }, false],
    ['a file', (env: Env) => { renameSync(env.dir, `${env.dir}-away`); writeFileSync(env.dir, 'not a directory'); }, false],
  ] as const) {
    test(`status names a mount with ${what} at its root's path in the words sync lists: for that mount from disk, beside the identity recorded and the one there now; for every mount as its last pass found it, and when`, async (t) => {
      const env = new Env(t);
      const m = await env.open();
      const recorded = identityOf(env.dir);
      await seedSynced(env, m, 'a.txt', 'A');
      change(env);

      assert.equal((await call(m, 'status', {})).work.root, undefined, 'every mount: the last pass, before the change, could use the root');
      const one = (await call(m, 'status', { mount: 'work' })).work;
      const before = new Date().toISOString();
      const listed = rootRegion(await call(m, 'sync', {}));
      assert.equal(typeof listed, 'string');
      assert.deepEqual(one.root, shown({ recorded, now: directoryThere ? identityOf(env.dir) : null, unavailable: listed }), 'that mount: as disk shows it now');
      assert.equal(one.canMaterialize, false);
      const every = (await call(m, 'status', {})).work;
      assert.deepEqual(Object.keys(every.root).sort(), ['lastPassAt', 'unavailable']);
      assert.equal(every.root.unavailable, listed, 'every mount: the last pass\'s words');
      assert.ok(every.root.lastPassAt >= before && every.root.lastPassAt <= new Date().toISOString(), 'and when it ran');
      assert.equal(every.canMaterialize, false);
    });
  }

  test('status for every mount reads no root from disk', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const rootReal = realpathSync(env.dir);
    let reads = 0;
    const counting = (name: 'lstat' | 'realpath' | 'statfs') => (fn: () => Promise<unknown>) => withFsPromises(name, (original) => async (path: string, ...rest: unknown[]) => {
      if (String(path) === rootReal || String(path) === env.dir) reads++;
      return original(path, ...rest);
    }, fn);
    await counting('lstat')(() => counting('realpath')(() => counting('statfs')(() => call(m, 'status', {}))));
    assert.equal(reads, 0);
    await counting('lstat')(() => call(m, 'status', { mount: 'work' }));
    assert.ok(reads > 0, 'status for that mount does read it');
  });

  test('status for every mount shows the root as the last pass found it, where that pass decided nothing too', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    unmount(env);
    const mount = (m as any).mounts.get('work');
    const pass = await (m as any).withMount(mount, () => (m as any).passUnlocked(mount, { kind: 'dir', dir: '', recursive: true }, { branchId: 'a branch the pass is not on' }));
    assert.equal(typeof pass.undecided, 'string', 'the pass decided nothing');
    const every = (await call(m, 'status', {})).work.root;
    assert.equal(every.unavailable, rootRegion(await call(m, 'sync', {})));
  });

  test('status shows a root a pass can use only when asked for that mount: as recorded, or renumbered with its birth time', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    await call(m, 'sync', {});
    const recorded = identityOf(env.dir);
    assert.equal((await call(m, 'status', {})).work.root, undefined, 'as recorded, every mount');
    assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded, now: recorded }), 'as recorded, that mount');
    const now = rootWithBirthTime(t, env);
    if (!now) return;
    const renumbered = { ...now, dev: bumped(now.dev) };
    m = await recordedAs(env, m, renumbered);
    assert.equal((await call(m, 'status', {})).work.root, undefined, 'renumbered, every mount');
    assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: renumbered, now }), 'renumbered, that mount');
  });

  test('a root with the recorded inode on another device, and no birth time recorded, is named as that by status, sync, ls, materialize and read, and acceptRoot takes it', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const now = identityOf(env.dir);
    const recorded = { dev: bumped(now.dev), ino: now.ino };
    m = await recordedAs(env, m, recorded);
    await call(m, 'write', { path: 'work/c.txt', content: 'C, a draft' });

    assert.equal(ROOT_REPLACED, 'the mount root is not the directory disk last agreed with (an unmounted drive, a directory moved aside, or a replaced one); whoever runs this host can say which: a drive they can reconnect, a directory moved aside they can put back, and a replaced directory a sync of the mount with acceptRoot takes as it is now');
    assert.equal(ROOT_ON_ANOTHER_DEVICE, 'the mount root has the inode disk last agreed with, but another device number: a reboot can renumber a volume, and another volume mounted at the same place can have a root with the same inode; whoever runs this host can say which, and if it is the same directory, a sync of the mount with acceptRoot takes it as it is now; if not, they can mount the right volume');
    const one = (await call(m, 'status', { mount: 'work' })).work;
    assert.deepEqual(one.root, shown({ recorded, now, unavailable: ROOT_ON_ANOTHER_DEVICE }));
    assert.equal(one.canMaterialize, false, 'canMaterialize says what materialize will do');
    assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_ON_ANOTHER_DEVICE);
    assert.equal((await call(m, 'status', {})).work.root.unavailable, ROOT_ON_ANOTHER_DEVICE, 'every mount: as the last pass found it');
    assert.equal(rootRegion(await call(m, 'ls', { path: 'work' })), ROOT_ON_ANOTHER_DEVICE);
    const materialized = await call(m, 'materialize', {});
    assert.deepEqual(materialized.skipped, [{ mount: 'work', reason: `c.txt: ${ROOT_ON_ANOTHER_DEVICE}` }]);
    assert.equal(existsSync(join(env.dir, 'c.txt')), false, 'nothing was written');
    assert.equal(
      await refused(m, 'read', { path: 'work/elsewhere.txt' }),
      `The read did nothing: "work/elsewhere.txt" isn't in the workspace, and disk couldn't be checked: ${ROOT_ON_ANOTHER_DEVICE}.`,
    );

    const accepted = await call(m, 'sync', { mount: 'work', acceptRoot: true });
    assert.deepEqual(accepted.rootsAccepted, ['work']);
    assert.equal((await call(m, 'status', {})).work.root, undefined);
    assert.equal((await call(m, 'status', {})).work.canMaterialize, true);
    assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: now, now }), 'the root as it is now is the one recorded');
    await call(m, 'materialize', {});
    assert.equal(env.readDisk('c.txt'), 'C, a draft', 'the draft went out');
  });

  async function withRootBorn<T>(env: Env, born: bigint, fn: () => Promise<T>): Promise<T> {
    const rootReal = realpathSync(env.dir);
    return withFsPromises('lstat', (lstat) => async (path: string, ...rest: unknown[]) => {
      const info = await lstat(path, ...rest);
      return String(path) === rootReal ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { birthtimeNs: born }) : info;
    }, fn);
  }

  const EXT4 = 0xef53;
  const OVERLAYFS = 0x794c7630;
  /** Run `fn` with statfs giving the root's filesystem as `type`. */
  async function withRootFsType<T>(env: Env, type: number, fn: () => Promise<T>): Promise<T> {
    const rootReal = realpathSync(env.dir);
    return withFsPromises('statfs', (statfs) => async (path: string, ...rest: unknown[]) => {
      const info = await statfs(path, ...rest);
      return String(path) === rootReal ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { type }) : info;
    }, fn);
  }

  test('a root with the recorded inode on another device is named as that where its birth time is the recorded one in whole seconds, or earlier, and as another directory where it is later', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('the born-later rule applies only where Linux names a filesystem that keeps a birth time fixed');
      return;
    }
    const env = new Env(t);
    await withRootFsType(env, EXT4, async () => {
      let m = await env.open();
      await seedSynced(env, m, 'a.txt', 'A');
      const now = rootWithBirthTime(t, env);
      if (!now) return;
      const second = String((BigInt(now.born) / 1_000_000_000n - 1n) * 1_000_000_000n);
      m = await recordedAs(env, m, { dev: bumped(now.dev), ino: now.ino, born: second });
      assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_REPLACED, 'a whole second against a birth time below it');
      await withRootBorn(env, BigInt(second), async () => {
        assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_ON_ANOTHER_DEVICE, 'the same whole second tells nothing');
        assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_ON_ANOTHER_DEVICE, 'and still nothing on a second look');
      });
      await withRootBorn(env, BigInt(second) + 1_000_000_000n, async () => {
        assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_REPLACED, 'a whole second later');
      });
      await withRootBorn(env, BigInt(second) - 1_000_000_000n, async () => {
        assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_ON_ANOTHER_DEVICE, 'a whole second earlier, as utimes can move it');
      });
      m = await recordedAs(env, m, { dev: bumped(now.dev), ino: now.ino, born: earlier(now.born) });
      assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_REPLACED, 'born below the second, after the recorded one');
      m = await recordedAs(env, m, { dev: bumped(now.dev), ino: now.ino, born: bumped(now.born) });
      assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_ON_ANOTHER_DEVICE, 'born below the second, before the recorded one');
    });
  });

  test('a root with the recorded inode on its own device, born after the recorded one, is another directory where its filesystem keeps a birth time fixed, as ext4 does for a directory made again in a removed one\'s place; one born before it is the same', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('the born-later rule applies only where Linux names a filesystem that keeps a birth time fixed');
      return;
    }
    const env = new Env(t);
    await withRootFsType(env, EXT4, async () => {
      let m = await env.open();
      await seedSynced(env, m, 'a.txt', 'A');
      const now = rootWithBirthTime(t, env);
      if (!now) return;
      const recorded = { dev: now.dev, ino: now.ino, born: earlier(now.born) };
      m = await recordedAs(env, m, recorded);
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded, now, unavailable: ROOT_REPLACED }));
      assert.equal(rootRegion(await call(m, 'sync', {})), ROOT_REPLACED);
      assert.deepEqual((await call(m, 'sync', { mount: 'work', acceptRoot: true })).rootsAccepted, ['work']);
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: now, now }));

      const later = { dev: now.dev, ino: now.ino, born: bumped(now.born) };
      m = await recordedAs(env, m, later);
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: later, now }), 'a birth time earlier than the recorded one');
      assert.equal(rootRegion(await call(m, 'sync', {})), undefined);
    });
  });

  test('a root with the recorded inode born after the recorded one is the recorded root where its filesystem doesn\'t keep a birth time fixed, as overlayfs gives a directory it copies up a later one, and on another device it is named as device-only', async (t) => {
    const env = new Env(t);
    const unfixed = <T>(fn: () => Promise<T>) => (process.platform === 'linux' ? withRootFsType(env, OVERLAYFS, fn) : fn());
    await unfixed(async () => {
      let m = await env.open();
      await seedSynced(env, m, 'a.txt', 'A');
      const now = rootWithBirthTime(t, env);
      if (!now) return;
      const recorded = { dev: now.dev, ino: now.ino, born: earlier(now.born) };
      m = await recordedAs(env, m, recorded);
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded, now }));
      env.writeDisk('b.txt', 'B');
      const synced = await call(m, 'sync', {});
      assert.equal(rootRegion(synced), undefined, 'a sync uses it');
      assert.ok(synced.results.some((r: any) => r.synced?.includes('b.txt')), 'and takes in its file');
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded, now: identityOf(env.dir) }), 'the record keeps its birth time');

      m = await recordedAs(env, m, { ...recorded, dev: bumped(now.dev) });
      assert.equal((await call(m, 'status', { mount: 'work' })).work.root.unavailable, ROOT_ON_ANOTHER_DEVICE, 'another device');
    });
  });

  test('a birth time equal to the ctime, as where statx is unavailable and the ctime stands in, is no birth time: on its own device the root is the one recorded, and on another it is named as device-only', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const { dev, ino } = identityOf(env.dir);
    const ctime = statSync(env.dir, { bigint: true }).ctimeNs;
    const then = String(ctime - 5_000_000_000n);
    m = await recordedAs(env, m, { dev, ino, born: then });
    await withRootBorn(env, ctime, async () => {
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: { dev, ino, born: then }, now: { dev, ino } }), 'its own device');
      assert.equal(rootRegion(await call(m, 'sync', {})), undefined);
    });
    m = await recordedAs(env, m, { dev: bumped(dev), ino, born: then });
    await withRootBorn(env, ctime, async () => {
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: { dev: bumped(dev), ino, born: then }, now: { dev, ino }, unavailable: ROOT_ON_ANOTHER_DEVICE }), 'another device');
    });
  });

  test('identities: the same directory, and where only the device tells them apart, for every pair of birth times recorded and now, where the filesystem keeps a birth time fixed and where it doesn\'t', () => {
    const second = '1792560071000000000';
    const nextSecond = '1792560072000000000';
    const frac = '1792560071123456789';
    const fracAfter = '1792560071123456790';
    const cases: Array<[string, string | undefined, string | undefined, boolean, boolean, boolean]> = [
      ['neither', undefined, undefined, true, false, true],
      ['recorded only', frac, undefined, true, false, true],
      ['now only', undefined, frac, true, false, true],
      ['the same whole second', second, second, true, false, true],
      ['a whole second, then none', second, undefined, true, false, true],
      ['none, then a whole second', undefined, second, true, false, true],
      ['a whole second later', second, nextSecond, false, false, false],
      ['a whole second earlier', nextSecond, second, true, false, true],
      ['below the second, later than a whole second', second, frac, false, false, false],
      ['a whole second, earlier than one below it', frac, second, true, false, true],
      ['the same below the second', frac, frac, true, true, false],
      ['below the second, later', frac, fracAfter, false, false, false],
      ['below the second, earlier', fracAfter, frac, true, false, true],
    ];
    const withBorn = (dev: string, born: string | undefined) => ({ dev, ino: '2', ...(born !== undefined ? { born } : {}) });
    for (const [label, recorded, now, sameDevice, otherDevice, deviceOnly] of cases) {
      assert.equal(sameRootIdentity(withBorn('1', recorded), withBorn('1', now), true), sameDevice, `${label}: one device`);
      assert.equal(onlyDeviceDiffers(withBorn('1', recorded), withBorn('1', now), true), false, `${label}: one device is never device-only`);
      assert.equal(sameRootIdentity(withBorn('1', recorded), withBorn('3', now), true), otherDevice, `${label}: another device, same directory`);
      assert.equal(onlyDeviceDiffers(withBorn('1', recorded), withBorn('3', now), true), deviceOnly, `${label}: another device, device-only`);
      assert.equal(sameRootIdentity(withBorn('1', recorded), withBorn('1', now), false), true, `${label}, not fixed: one device`);
      assert.equal(onlyDeviceDiffers(withBorn('1', recorded), withBorn('1', now), false), false, `${label}, not fixed: one device is never device-only`);
      assert.equal(sameRootIdentity(withBorn('1', recorded), withBorn('3', now), false), otherDevice, `${label}, not fixed: another device, same directory`);
      assert.equal(onlyDeviceDiffers(withBorn('1', recorded), withBorn('3', now), false), !otherDevice, `${label}, not fixed: another device, device-only`);
    }
    for (const bornFixed of [true, false]) {
      assert.equal(sameRootIdentity({ dev: '1', ino: '2' }, { dev: '1', ino: '4' }, bornFixed), false, 'another inode');
      assert.equal(onlyDeviceDiffers({ dev: '1', ino: '2' }, { dev: '3', ino: '4' }, bornFixed), false, 'another inode, another device');
    }
  });

  test('status for a mount with nothing in it answers while the store\'s record of disk can\'t be read back, its root unavailable with the step that reopens it, and one with files refuses as before', async (t) => {
    const env = new Env(t);
    const emptyDir = join(env.root, 'empty');
    mkdirSync(emptyDir);
    const mounts = [
      { name: 'work', path: env.dir, mode: 'read-write' as const, watch: 'never' as const },
      { name: 'empty', path: emptyDir, mode: 'read-write' as const, watch: 'never' as const },
    ];
    await env.shutdown(await (async () => {
      const first = await env.open({}, { mounts });
      await seedSynced(env, first, 'a.txt', 'A');
      return first;
    })());
    env.store = JsStore.openOrCreate({ path: env.storePath });
    const ids = env.store.getRecordIdsByType.bind(env.store);
    (env.store as any).getRecordIdsByType = (type: string) => {
      if (type === DISK_AGREEMENT_RECORD_TYPE) throw new Error('injected: reading the record back failed');
      return ids(type);
    };
    const m = new WorkspaceModule({ mounts });
    (env as any).live.push(m);
    assert.throws(() => m.initStore(env.store), /injected/);
    (env.store as any).getRecordIdsByType = ids;
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);

    const empty = (await call(m, 'status', { mount: 'empty' })).empty;
    assert.equal(empty.fileCount, 0);
    assert.deepEqual(empty.root, shown({
      now: identityOf(emptyDir),
      unavailable: 'the root disk last agreed with can\'t be read until the store is reopened: reading back its record of what disk last agreed with failed. Calling again won\'t change that; whoever runs this host can reopen it with a restart.',
    }));
    const refusal = 'The status did nothing: the workspace can\'t check its files against disk until its store is reopened: reading back its record of what disk last agreed with failed. Calling again won\'t change that; whoever runs this host can reopen it with a restart.';
    assert.equal(await refused(m, 'status', { mount: 'work' }), refusal);
    assert.equal(await refused(m, 'status', {}), refusal);
  });

  test('status for a mount with nothing in it, opened while an append to the record of disk fails, gives that cause for its root', async (t) => {
    const env = new Env(t);
    const store = env.store as unknown as { appendJson: (type: string, payload: unknown) => unknown };
    const append = store.appendJson;
    store.appendJson = function (this: unknown, type: string, payload: unknown) {
      if (type === DISK_AGREEMENT_RECORD_TYPE) throw new Error('injected: the store refused the append');
      return append.call(this, type, payload);
    };
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: env.dir, mode: 'read-write', watch: 'never' }] });
    (env as any).live.push(m);
    try {
      assert.throws(() => m.initStore(env.store), /injected/);
    } finally {
      store.appendJson = append;
    }
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);

    assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({
      now: identityOf(env.dir),
      unavailable: 'the root disk last agreed with can\'t be read until the store is reopened: an append to its record of what disk last agreed with failed inside the store, so that record may lack what the append held. Calling again won\'t change that; whoever runs this host can reopen it with a restart.',
    }));
    assert.ok((await refused(m, 'sync', {})).includes('the workspace can\'t check its files against disk until its store is reopened: an append to its record of what disk last agreed with failed inside the store, so that record may lack what the append held. Calling again won\'t change that; whoever runs this host can reopen it with a restart.'), 'the refusal keeps its words');
  });

  test('status answers for a mount with nothing in it while the store awaits reopening, as before, with no note of what a sync would record', async (t) => {
    const env = new Env(t);
    const emptyDir = join(env.root, 'empty');
    mkdirSync(emptyDir);
    const m = await env.open({}, { mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never' },
      { name: 'empty', path: emptyDir, mode: 'read-write', watch: 'never' },
    ] });
    env.writeDisk('a.txt', 'A');
    const store = env.store as unknown as { appendJson: (type: string, payload: any) => unknown };
    const append = store.appendJson;
    store.appendJson = function (this: unknown, type: string, payload: any) {
      const record = append.call(this, type, payload);
      if (type === DISK_AGREEMENT_RECORD_TYPE) throw new Error('injected: the append landed, then the store failed');
      return record;
    };
    try {
      await m.handleToolCall({ id: 's', name: 'sync', input: { mount: 'work' } });
    } finally {
      store.appendJson = append;
    }
    assert.equal((m as any).agreement.awaitsReopen, true);
    assert.deepEqual((await call(m, 'status', { mount: 'empty' })).empty.root, shown({ recorded: null, now: identityOf(emptyDir) }));
  });

  test('status for one mount says nothing is recorded of a root that has taken in nothing, and a sync that takes in a file, or a materialize that writes one, records it', async (t) => {
    const nothing = 'nothing is recorded of this root yet, so any directory at its path is taken as it; the first sync that takes in a file, or materialize that writes one, records it';
    for (const first of ['sync', 'materialize'] as const) {
      const env = new Env(t);
      const m = await env.open();
      const now = identityOf(env.dir);
      assert.equal((await call(m, 'status', {})).work.root, undefined, `${first}: every mount`);
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: null, now, note: nothing }), `${first}: that mount`);
      if (first === 'sync') {
        env.writeDisk('a.txt', 'A');
        await call(m, 'sync', {});
      } else {
        await call(m, 'write', { path: 'work/a.txt', content: 'A' });
        await call(m, 'materialize', {});
        assert.equal(env.readDisk('a.txt'), 'A');
      }
      const after = identityOf(env.dir);
      const fixed = process.platform === 'linux';
      const expected = first === 'sync' || after.born === undefined || !fixed ? { recorded: first === 'sync' ? after : now, now: after }
        : { recorded: now, now: after, note: 'no birth time is recorded of this root yet, so a directory made again in its place with the same inode can\'t be told from it; the next sync or ls of this mount records it' };
      const root = fixed ? await withRootFsType(env, EXT4, async () => (await call(m, 'status', { mount: 'work' })).work.root) : (await call(m, 'status', { mount: 'work' })).work.root;
      assert.deepEqual(root, shown(expected), `${first}: recorded`);
    }
  });

  test('status for a read-only mount with nothing recorded names only the sync that records its root', async (t) => {
    const env = new Env(t);
    const m = await env.open({ mode: 'read-only' });
    const now = identityOf(env.dir);
    assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: null, now, note: 'nothing is recorded of this root yet, so any directory at its path is taken as it; the first sync that takes in a file records it' }));
    env.writeDisk('a.txt', 'A');
    await call(m, 'sync', {});
    const after = identityOf(env.dir);
    assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: after, now: after }), 'the sync recorded it');
  });

  test('status for one mount says no birth time is recorded of a root recorded without one, where its filesystem keeps a birth time fixed, and the next ls or sync records it; elsewhere it gives no note', async (t) => {
    const unrecorded = 'no birth time is recorded of this root yet, so a directory made again in its place with the same inode can\'t be told from it; the next sync or ls of this mount records it';
    for (const next of ['ls', 'sync'] as const) {
      const env = new Env(t);
      let m = await env.open();
      await seedSynced(env, m, 'a.txt', 'A');
      const now = rootWithBirthTime(t, env);
      if (!now) return;
      const recorded = { dev: now.dev, ino: now.ino };
      m = await recordedAs(env, m, recorded);
      assert.equal((await call(m, 'status', {})).work.root, undefined, `${next}: every mount`);
      if (process.platform === 'linux') {
        await withRootFsType(env, OVERLAYFS, async () => {
          assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded, now }), `${next}: no note where birth times aren't fixed`);
        });
        await withRootFsType(env, EXT4, async () => {
          assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded, now, note: unrecorded }), `${next}: that mount`);
        });
      } else {
        assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded, now }), `${next}: no note off Linux`);
      }
      await call(m, next, next === 'ls' ? { path: 'work' } : {});
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: now, now }), `${next}: recorded`);
    }
  });

  test('status for one mount adds no note where the directory has no birth time to record', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await seedSynced(env, m, 'a.txt', 'A');
    const { dev, ino } = identityOf(env.dir);
    m = await recordedAs(env, m, { dev, ino });
    // No filesystem the tests run on gives a directory no birth time, so lstat stands in for one.
    await withRootBorn(env, 0n, async () => {
      assert.deepEqual((await call(m, 'status', { mount: 'work' })).work.root, shown({ recorded: { dev, ino }, now: { dev, ino } }));
    });
  });

  test('acceptRoot takes a whole mount, not a path', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.match(await refused(m, 'sync', { path: 'work/a.txt', acceptRoot: true }), /whole mount/);
  });
});

// anima-research/agent-framework#530 (slimepriestess): an outer mount's forced
// materialize through a file link wrote into a nested mount's file. Her probe,
// as the issue gives it.
for (const autoMaterialize of [false, true]) test(`a forced materialize through a file link into a nested mount leaves the inner mount's file alone (autoMaterialize ${autoMaterialize})`, async (t) => {
  const env = new Env(t);
  env.writeDisk('a/b/x.txt', "the inner mount's");
  const m = await env.open({}, { mounts: [
    { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', followSymlinks: true, autoMaterialize },
    { name: 'deep', path: env.disk('a/b'), mode: 'read-write', watch: 'never' },
  ] });
  await m.handleToolCall({ id: 't', name: 'write', input: { path: 'work/flink.txt', content: 'outer wrote' } });
  if (existsSync(env.disk('flink.txt'))) rmSync(env.disk('flink.txt'));
  symlinkSync(env.disk('a/b/x.txt'), env.disk('flink.txt'));
  await m.handleToolCall({ id: 't', name: 'materialize', input: { path: 'work/flink.txt', force: true } });
  assert.equal(readFileSync(env.disk('a/b/x.txt'), 'utf8'), "the inner mount's");
});
