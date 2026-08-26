/**
 * Regression tests for issue #72: WorkspaceModule restart restoration must be
 * second-callback-safe.
 *
 * Host ordering is start(ctx) BEFORE initStore(store). Restoration used to
 * loop over this.mounts inside start(), which is empty at that moment, so
 * every restart silently reset lastMaterializedSeq/lastMaterializedBranchId
 * to 0/null — misleading pendingChanges, null lastMaterializedBranch, and a
 * disabled materialize branch guard. These tests drive BOTH lifecycle orders
 * and require identical restored status and guard behavior.
 *
 * Mounts use watch: 'never' — the lifecycle under test is state restoration,
 * not chokidar.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'af-ws-restore-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'ws.chronicle') });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const makeModule = () =>
    new WorkspaceModule({
      mounts: [{ name: 'work', path: mountDir, mode: 'read-write', watch: 'never' }],
    });
  return { store, mountDir, makeModule };
}

type MountStatus = {
  lastMaterializedSeq: number;
  pendingChanges: number;
  lastMaterializedBranch: string | null;
  canMaterialize: boolean;
};

async function statusOf(module: WorkspaceModule): Promise<MountStatus> {
  const res = await module.handleToolCall({ id: 't', name: 'status', input: {} });
  assert.equal(res.success, true, `status failed: ${res.error}`);
  return (res.data as Record<string, MountStatus>).work;
}

/** Run a "previous session": write, materialize, write again (pending), and
 *  return the state a restart would be handed. */
async function runFirstSession(store: JsStore, makeModule: () => WorkspaceModule) {
  const module = makeModule();
  module.initStore(store);
  await module.start(makeCtx({ isRestart: false }));

  let res = await module.handleToolCall({
    id: 'w1', name: 'write', input: { path: 'work/one.txt', content: 'first' },
  });
  assert.equal(res.success, true, `write failed: ${res.error}`);
  res = await module.handleToolCall({ id: 'm1', name: 'materialize', input: {} });
  assert.equal(res.success, true, `materialize failed: ${res.error}`);
  // Advance the tree past the materialized baseline so a correct restore
  // shows pendingChanges > 0.
  res = await module.handleToolCall({
    id: 'w2', name: 'write', input: { path: 'work/two.txt', content: 'second' },
  });
  assert.equal(res.success, true, `write failed: ${res.error}`);

  const status = await statusOf(module);
  assert.ok(status.lastMaterializedSeq > 0, 'first session materialized');
  assert.ok(status.pendingChanges > 0, 'first session left pending changes');
  const saved: WorkspaceModuleState = {
    mounts: {
      work: {
        lastMaterializedSeq: status.lastMaterializedSeq,
        lastMaterializedBranchId: status.lastMaterializedBranch ?? undefined,
      },
    },
  };
  return { saved, expected: status };
}

test('restart restores mount state in Host order (start before initStore)', async (t) => {
  const { store, makeModule } = setup(t);
  const { saved, expected } = await runFirstSession(store, makeModule);

  const restarted = makeModule();
  // Host ordering: start() first, mounts don't exist yet.
  await restarted.start(makeCtx({ isRestart: true, saved }));
  restarted.initStore(store);

  const status = await statusOf(restarted);
  assert.equal(status.lastMaterializedSeq, expected.lastMaterializedSeq);
  assert.equal(status.lastMaterializedBranch, expected.lastMaterializedBranch);
  assert.equal(status.pendingChanges, expected.pendingChanges);
  assert.equal(status.canMaterialize, true, 'same branch stays materializable');
});

test('both lifecycle orders restore identical status', async (t) => {
  const { store, makeModule } = setup(t);
  const { saved } = await runFirstSession(store, makeModule);

  const hostOrder = makeModule();
  await hostOrder.start(makeCtx({ isRestart: true, saved }));
  hostOrder.initStore(store);

  const reverseOrder = makeModule();
  reverseOrder.initStore(store);
  await reverseOrder.start(makeCtx({ isRestart: true, saved }));

  assert.deepEqual(await statusOf(hostOrder), await statusOf(reverseOrder));
});

test('materialize branch guard survives restart in both orders', async (t) => {
  const { store, makeModule } = setup(t);
  // A saved state naming a branch that is NOT the store's current branch —
  // with the order bug this silently degraded to canMaterialize: true and a
  // permitted materialize.
  const saved: WorkspaceModuleState = {
    mounts: { work: { lastMaterializedSeq: 0, lastMaterializedBranchId: 'branch-elsewhere' } },
  };

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
    assert.equal(status.lastMaterializedBranch, 'branch-elsewhere', `${order}: branch restored`);
    assert.equal(status.canMaterialize, false, `${order}: mismatched branch must not be materializable`);

    const res = await module.handleToolCall({ id: 'm', name: 'materialize', input: {} });
    assert.equal(res.success, false, `${order}: branch guard must refuse`);
    assert.match(String(res.error), /diverged from the branch last materialized/, `${order}: guard reason`);
  }
});

test('a fresh (non-restart) start still initializes mounts at zero', async (t) => {
  const { store, makeModule } = setup(t);
  const module = makeModule();
  await module.start(makeCtx({ isRestart: false }));
  module.initStore(store);

  const status = await statusOf(module);
  assert.equal(status.lastMaterializedSeq, 0);
  assert.equal(status.lastMaterializedBranch, null);
  assert.equal(status.canMaterialize, true);
});
