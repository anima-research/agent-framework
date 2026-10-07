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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { DiskAgreement } from '../src/modules/workspace/disk-agreement.js';
import { fingerprintVouches, filesystemTrustsCtime } from '../src/modules/workspace/observe.js';
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
    assert.deepEqual(written, ['draft.txt', 'legacy-missing.txt'], 'drafts and missing legacy copies are written; conflicts refused');
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
    assert.equal(await stateOf(m, 'a.txt'), 'workspace-draft', 'the intent resolves by disk on any branch');
    env.store.switchBranch(main);
    assert.equal(await stateOf(m, 'a.txt'), 'synced');
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
    env.writeDisk('shot.png', ONE_PX_PNG);

    const data = await call(m, 'grep', { pattern: 'needle' });
    const hits = (data.results as Array<{ file: string; state: string; version: string; matches: Array<{ text: string }> }>)
      .map((r) => `${r.file} ${r.state} ${r.version}: ${r.matches[0]!.text}`);
    assert.deepEqual(hits, [
      'work/conflict.txt conflict workspace: needle in the workspace',
      'work/conflict.txt conflict conflicting-disk: needle on disk',
      'work/draft.txt workspace-draft workspace: needle two',
      'work/synced.txt synced workspace: needle one',
    ]);
    assert.deepEqual((data.skipped as Array<{ file: string }>).map((s) => s.file), ['work/shot.png']);

    const one = await call(m, 'grep', { pattern: 'needle', path: 'work/draft.txt' });
    assert.deepEqual((one.results as Array<{ file: string }>).map((r) => r.file), ['work/draft.txt']);
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

  test('a scan that outlasts its deadline is reported incomplete, and still finishes', async (t) => {
    const env = new Env(t);
    const m = await env.open({ watch: 'on-agent-action' }, { agentActionScanDeadlineMs: 50 });
    env.writeDisk('late.txt', 'arrives late');
    const mount = (m as any).mounts.get('work');
    const held = (m as any).withMount(mount, () => sleep(400)); // another pass holds the mount

    await m.onToolBatchComplete('agent');
    const status = await call(m, 'status', {});
    assert.equal(status.work.lastAgentActionScan.complete, false);
    assert.match(status.work.lastAgentActionScan.reason, /still scanning/);
    assert.ok(env.events.some((e) => e.type === 'workspace:agent-action-scan-incomplete'));
    assert.equal(env.store.treeGet(TREE, 'late.txt'), null, 'nothing was claimed before the scan ran');

    await held;
    await (m as any).mountTurns.get('work');
    assert.notEqual(env.store.treeGet(TREE, 'late.txt'), null, 'the scan finished afterwards');
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
