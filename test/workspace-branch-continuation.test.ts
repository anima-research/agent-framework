/**
 * Materialize branch guard: lineage, not identity.
 *
 * An out-of-band repair/treatment branches the store and leaves it on a child
 * branch forked at the parent's head. That child is a linear continuation of
 * exactly the history that was materialized — writing from it can never
 * clobber divergent disk state, so the guard must pass (and heal the pin at
 * boot). Genuine divergence — a branch forked BEFORE the last materialized
 * sequence — must still refuse, with `force: true` as the deliberate
 * override. One mount's stale pin must never block another mount.
 *
 * Regression tests for the Sill 08-24..26 stuck-materialize incident.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { WorkspaceModuleState } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';

function makeCtx(opts: { isRestart: boolean; saved?: WorkspaceModuleState }): ModuleContext {
  return {
    isRestart: opts.isRestart,
    getState: <T,>() => (opts.saved ?? null) as T | null,
    setState: () => {},
    pushEvent: () => {},
  } as unknown as ModuleContext;
}

function setup(t: TestContext, mountNames: string[] = ['work']) {
  const root = mkdtempSync(join(tmpdir(), 'af-ws-branch-'));
  const dirs: Record<string, string> = {};
  for (const name of mountNames) {
    dirs[name] = join(root, name);
    mkdirSync(dirs[name], { recursive: true });
  }
  const store = JsStore.openOrCreate({ path: join(root, 'ws.chronicle') });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const makeModule = () =>
    new WorkspaceModule({
      mounts: mountNames.map((name) => ({
        name, path: dirs[name], mode: 'read-write' as const, watch: 'never' as const,
      })),
    });
  return { store, dirs, makeModule };
}

type MountStatus = {
  lastMaterializedSeq: number;
  pendingChanges: number;
  lastMaterializedBranch: string | null;
  canMaterialize: boolean;
};

async function statusOf(module: WorkspaceModule, mount = 'work'): Promise<MountStatus> {
  const res = await module.handleToolCall({ id: 't', name: 'status', input: {} });
  assert.equal(res.success, true, `status failed: ${res.error}`);
  return (res.data as Record<string, MountStatus>)[mount];
}

/** Write a file + materialize on the current branch; returns saved state. */
async function materializeBaseline(
  module: WorkspaceModule,
): Promise<WorkspaceModuleState> {
  let res = await module.handleToolCall({
    id: 'w1', name: 'write', input: { path: 'work/base.txt', content: 'baseline' },
  });
  assert.equal(res.success, true, `write failed: ${res.error}`);
  res = await module.handleToolCall({ id: 'm1', name: 'materialize', input: {} });
  assert.equal(res.success, true, `materialize failed: ${res.error}`);
  const status = await statusOf(module);
  return {
    mounts: {
      work: {
        lastMaterializedSeq: status.lastMaterializedSeq,
        lastMaterializedBranchId: status.lastMaterializedBranch ?? undefined,
      },
    },
  };
}

test('descendant branch (fork at head) materializes without force and re-pins', async (t) => {
  const { store, dirs, makeModule } = setup(t);
  const module = makeModule();
  module.initStore(store);
  await module.start(makeCtx({ isRestart: false }));
  await materializeBaseline(module);

  // Out-of-band-style switch: child forked at the parent's head.
  store.createBranch('repair/test', store.currentBranch().name);
  store.switchBranch('repair/test');
  const childId = store.currentBranch().id;

  let res = await module.handleToolCall({
    id: 'w2', name: 'write', input: { path: 'work/repair.txt', content: 'on child' },
  });
  assert.equal(res.success, true, `write failed: ${res.error}`);

  const before = await statusOf(module);
  assert.equal(before.canMaterialize, true, 'linear continuation must be materializable');

  res = await module.handleToolCall({ id: 'm2', name: 'materialize', input: {} });
  assert.equal(res.success, true, `materialize must pass on descendant branch: ${res.error}`);
  assert.equal(readFileSync(join(dirs.work, 'repair.txt'), 'utf8'), 'on child');

  const after = await statusOf(module);
  assert.equal(after.lastMaterializedBranch, childId, 're-pinned to current branch');
});

test('restart after out-of-band branch switch heals the pin at boot (both orders)', async (t) => {
  const { store, makeModule } = setup(t);
  const first = makeModule();
  first.initStore(store);
  await first.start(makeCtx({ isRestart: false }));
  const saved = await materializeBaseline(first);
  const parentId = saved.mounts.work.lastMaterializedBranchId;
  assert.ok(parentId, 'baseline pinned a branch');

  // Offline repair: branch at head, leave the store on the child.
  store.createBranch('repair/offline', store.currentBranch().name);
  store.switchBranch('repair/offline');
  const childId = store.currentBranch().id;
  assert.notEqual(childId, parentId);

  for (const order of ['host', 'reverse'] as const) {
    const module = makeModule();
    if (order === 'host') {
      await module.start(makeCtx({ isRestart: true, saved }));
      module.initStore(store);
    } else {
      module.initStore(store);
      await module.start(makeCtx({ isRestart: true, saved }));
    }

    const status = await statusOf(module);
    assert.equal(status.lastMaterializedBranch, childId, `${order}: pin healed to current branch`);
    assert.equal(status.canMaterialize, true, `${order}: materializable after heal`);

    const res = await module.handleToolCall({ id: 'm', name: 'materialize', input: {} });
    assert.equal(res.success, true, `${order}: materialize passes after heal: ${res.error}`);
  }
});

test('genuinely divergent branch refuses without force, materializes with force', async (t) => {
  const { store, dirs, makeModule } = setup(t);
  const module = makeModule();
  module.initStore(store);
  await module.start(makeCtx({ isRestart: false }));

  // Two materialized generations on main, so a fork between them diverges.
  await materializeBaseline(module);
  const forkAt = store.currentSequence();
  let res = await module.handleToolCall({
    id: 'w2', name: 'write', input: { path: 'work/newer.txt', content: 'newer on main' },
  });
  assert.equal(res.success, true);
  res = await module.handleToolCall({ id: 'm2', name: 'materialize', input: {} });
  assert.equal(res.success, true);

  // Fork BEFORE the last materialized sequence: disk now holds records the
  // child branch never had.
  store.createBranchAt('divergent', store.currentBranch().name, forkAt);
  store.switchBranch('divergent');

  res = await module.handleToolCall({
    id: 'w3', name: 'write', input: { path: 'work/div.txt', content: 'divergent' },
  });
  assert.equal(res.success, true);

  const status = await statusOf(module);
  assert.equal(status.canMaterialize, false, 'divergent branch must not be materializable');

  res = await module.handleToolCall({ id: 'm3', name: 'materialize', input: {} });
  assert.equal(res.success, false, 'divergent branch must refuse without force');
  assert.match(String(res.error), /diverged/);
  assert.match(String(res.error), /force: true/, 'error names the reachable remedy');
  assert.equal(existsSync(join(dirs.work, 'div.txt')), false, 'nothing written on refusal');

  res = await module.handleToolCall({ id: 'm4', name: 'materialize', input: { force: true } });
  assert.equal(res.success, true, `force must override: ${res.error}`);
  assert.equal(readFileSync(join(dirs.work, 'div.txt'), 'utf8'), 'divergent');

  const after = await statusOf(module);
  assert.equal(after.lastMaterializedBranch, store.currentBranch().id, 'force re-pins');
  assert.equal(after.canMaterialize, true, 'materializable again after force');
});

test('one mount\'s stale pin does not block other mounts', async (t) => {
  const { store, dirs, makeModule } = setup(t, ['work', 'notes']);
  // Saved state: `work` pinned to a branch that no longer exists (unprovable
  // ancestry → blocked); `notes` never materialized (unpinned → free).
  const saved: WorkspaceModuleState = {
    mounts: { work: { lastMaterializedSeq: 1, lastMaterializedBranchId: 'branch-gone' } },
  };
  const module = makeModule();
  module.initStore(store);
  await module.start(makeCtx({ isRestart: true, saved }));

  let res = await module.handleToolCall({
    id: 'w1', name: 'write', input: { path: 'notes/note.txt', content: 'note' },
  });
  assert.equal(res.success, true, `write failed: ${res.error}`);

  // Materialize-all: notes must land on disk; work is reported skipped.
  res = await module.handleToolCall({ id: 'm1', name: 'materialize', input: {} });
  assert.equal(res.success, true, `unblocked mount must materialize: ${res.error}`);
  assert.equal(readFileSync(join(dirs.notes, 'note.txt'), 'utf8'), 'note');
  const skipped = (res.data as { skipped?: Array<{ mount: string }> }).skipped ?? [];
  assert.deepEqual(skipped.map((s) => s.mount), ['work'], 'blocked mount reported as skipped');

  // Targeting the blocked mount alone still refuses.
  res = await module.handleToolCall({ id: 'm2', name: 'materialize', input: { mount: 'work' } });
  assert.equal(res.success, false, 'blocked mount alone must refuse');
});
