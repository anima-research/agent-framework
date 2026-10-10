/**
 * Materialize freshness guard (#109): files get modified by two hands — the
 * workspace layer AND direct shell/tool edits. `materialize` used to assume
 * it was the only writer: a bulk materialize overwrote 217 shell-edited
 * files with stale workspace copies (2026-08-11 production incident; second
 * single-file occurrence in the issue thread, stopped only by an incidental
 * branch-guard refusal).
 *
 * The guard compares the disk content's hash against `materializedHashes`
 * (what the layer last wrote): a mismatch means another writer changed the
 * file, and the path is refused LOUDLY — listed in the result, not resolved
 * silently in either direction — unless `force: true`.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { WorkspaceModuleState } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';

function makeCtx(opts: {
  saved?: WorkspaceModuleState;
  onSave?: (state: WorkspaceModuleState) => void;
} = {}): ModuleContext {
  return {
    isRestart: opts.saved !== undefined,
    getState: <T,>() => (opts.saved ?? null) as T | null,
    setState: (state: WorkspaceModuleState) => opts.onSave?.(state),
    pushEvent: () => {},
  } as unknown as ModuleContext;
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'af-ws-fresh-'));
  const dir = join(root, 'work');
  mkdirSync(dir, { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'ws.chronicle') });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const makeModule = () => {
    const m = new WorkspaceModule({
      mounts: [{ name: 'work', path: dir, mode: 'read-write' as const, watch: 'never' as const }],
    });
    m.initStore(store);
    return m;
  };
  return { store, dir, module: makeModule(), makeModule };
}

type MaterializeData = {
  materialized: Array<{ mount: string; path: string }>;
  skipped?: Array<{ mount: string; reason: string }>;
};

async function call(module: WorkspaceModule, name: string, input: Record<string, unknown>) {
  const res = await module.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, true, `${name} failed: ${res.error}`);
  return res;
}

/** Baseline: script.sh written through the workspace and materialized once. */
async function seedBaseline(module: WorkspaceModule, dir: string): Promise<void> {
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v1' });
  const res = await call(module, 'materialize', {});
  const data = res.data as MaterializeData;
  assert.deepEqual(data.materialized.map((m) => m.path), ['script.sh']);
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo v1');
}

test('a shell-edited file is refused loudly, not silently reverted; force overrides', async (t) => {
  const { dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  // Another hand edits the file on disk; the agent edits the workspace copy.
  writeFileSync(join(dir, 'script.sh'), 'echo edited-by-shell');
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v2-stale-base' });

  const res = await call(module, 'materialize', {});
  const data = res.data as MaterializeData;
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo edited-by-shell',
    'the shell edit must survive the materialize');
  assert.equal(data.materialized.length, 0, 'nothing silently written');
  const skip = (data.skipped ?? []).find((s) => s.reason.includes('script.sh'));
  assert.ok(skip, `divergence must be listed in the result, got: ${JSON.stringify(data)}`);
  assert.match(skip!.reason, /stale copy/, 'reason names the failure class');
  assert.match(skip!.reason, /force/, 'reason names the override');

  // force is the deliberate override — workspace copy wins, visibly.
  const forced = await call(module, 'materialize', { force: true });
  assert.deepEqual((forced.data as MaterializeData).materialized.map((m) => m.path), ['script.sh']);
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo v2-stale-base');
});

test('a refused path stays pending: the next materialize reports it again instead of dropping it', async (t) => {
  const { dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  writeFileSync(join(dir, 'script.sh'), 'echo edited-by-shell');
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v2' });

  const first = await call(module, 'materialize', {});
  assert.ok(((first.data as MaterializeData).skipped ?? []).length > 0);

  // If the watermark advanced past the refusal, this second call would diff
  // to nothing and the divergence would vanish from view — a loud refusal
  // decaying into a permanent silent one.
  const second = await call(module, 'materialize', {});
  const skip = ((second.data as MaterializeData).skipped ?? []).find((s) => s.reason.includes('script.sh'));
  assert.ok(skip, 'the divergent path must stay visible on subsequent materializes');
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo edited-by-shell');
});

test('syncing the path resolves the divergence in the disk direction; a full sync keeps the workspace edit', async (t) => {
  const { dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  writeFileSync(join(dir, 'script.sh'), 'echo edited-by-shell');
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v2' });
  await call(module, 'materialize', {}); // refused, listed

  // A full sync rechecks everything but never discards a pending workspace
  // edit (shelf-383): the divergence is still there to resolve deliberately.
  await call(module, 'sync', {});
  const still = await call(module, 'materialize', {});
  assert.ok(((still.data as MaterializeData).skipped ?? []).some((s) => s.reason.includes('script.sh')),
    'a full sync leaves the conflict for an explicit resolution');
  const read = await call(module, 'read', { path: 'work/script.sh' });
  assert.match(String((read.data as { content: string }).content), /echo v2/, 'the workspace edit survives');

  // The remedy the skip reason points at: sync this path to adopt the disk version.
  await call(module, 'sync', { path: 'work/script.sh' });
  const res = await call(module, 'materialize', {});
  assert.equal(((res.data as MaterializeData).skipped ?? []).length, 0,
    'after syncing the path the tree matches disk — nothing left to refuse');
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo edited-by-shell');
});

test('an unreadable but writable disk copy is refused, not treated as absent', async (t) => {
  const { dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  // Another hand edits the file and leaves it write-only: readFile fails
  // with EACCES while writeFile would still succeed.
  const file = join(dir, 'script.sh');
  writeFileSync(file, 'echo edited-by-shell');
  chmodSync(file, 0o200);
  try {
    readFileSync(file);
    t.skip('platform/user can still read a mode-0200 file (Windows or root)');
    return;
  } catch { /* unreadable, as intended */ }

  await call(module, 'write', { path: 'work/script.sh', content: 'echo v2' });
  const res = await call(module, 'materialize', {});
  const data = res.data as MaterializeData;
  chmodSync(file, 0o600);
  assert.equal(readFileSync(file, 'utf8'), 'echo edited-by-shell',
    'an edit we could not verify must survive the materialize');
  assert.equal(data.materialized.length, 0, 'nothing silently written');
  const skip = (data.skipped ?? []).find((s) => s.reason.includes('script.sh'));
  assert.ok(skip, `the unverifiable path must be listed, got: ${JSON.stringify(data)}`);
  assert.match(skip!.reason, /EACCES/, 'reason carries the filesystem error');
  assert.match(skip!.reason, /force/, 'reason names the override');

  // force still overwrites deliberately.
  chmodSync(file, 0o200);
  const forced = await call(module, 'materialize', { force: true });
  assert.deepEqual((forced.data as MaterializeData).materialized.map((m) => m.path), ['script.sh']);
  chmodSync(file, 0o600);
  assert.equal(readFileSync(file, 'utf8'), 'echo v2');
});

test('untouched disk copies and brand-new files materialize exactly as before', async (t) => {
  const { dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  // Agent-only edit (disk untouched since last materialize) + a new file.
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v2' });
  await call(module, 'write', { path: 'work/new.txt', content: 'fresh' });

  const res = await call(module, 'materialize', {});
  const data = res.data as MaterializeData;
  assert.deepEqual(data.materialized.map((m) => m.path).sort(), ['new.txt', 'script.sh']);
  assert.equal(data.skipped ?? undefined, undefined, 'no spurious refusals');
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo v2');
  assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'fresh');
});

test('after sync adopts a shell edit, the next agent edit materializes (baseline re-pinned)', async (t) => {
  const { dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  writeFileSync(join(dir, 'script.sh'), 'echo edited-by-shell');
  await call(module, 'sync', {});
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v3-on-top-of-shell' });

  // A stale baseline (still 'echo v1') would read the adopted edit as a new
  // external change and refuse this forever, sync or no sync.
  const res = await call(module, 'materialize', {});
  const data = res.data as MaterializeData;
  assert.equal(data.skipped ?? undefined, undefined, `no refusal expected, got: ${JSON.stringify(data)}`);
  assert.deepEqual(data.materialized.map((m) => m.path), ['script.sh']);
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo v3-on-top-of-shell');
});

test('a refusal does not hold back the sequence the branch guard reads', async (t) => {
  const { store, dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  // script.sh will be refused; other.txt is written in the same materialize.
  writeFileSync(join(dir, 'script.sh'), 'echo edited-by-shell');
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v2' });
  const forkAt = store.currentSequence();
  await call(module, 'write', { path: 'work/other.txt', content: 'from main' });
  const res = await call(module, 'materialize', {});
  assert.deepEqual((res.data as MaterializeData).materialized.map((m) => m.path), ['other.txt']);

  // A branch forked BEFORE other.txt was written never had it: disk holds
  // main's write, so this is divergence and the guard must refuse.
  store.createBranchAt('child', store.currentBranch().name, forkAt);
  store.switchBranch('child');
  await call(module, 'write', { path: 'work/other.txt', content: 'from child' });
  const blocked = await module.handleToolCall({ id: 't', name: 'materialize', input: {} });
  assert.equal(blocked.success, false, 'divergent branch must be refused');
  assert.match(String(blocked.error), /diverged/);
  assert.equal(readFileSync(join(dir, 'other.txt'), 'utf8'), 'from main');
});

test('a first materialize that finds every file in place still pins the branch', async (t) => {
  const { store, dir, module } = setup(t);
  await module.start(makeCtx());

  await call(module, 'write', { path: 'work/a.txt', content: 'a' });
  const forkAt = store.currentSequence();
  await call(module, 'write', { path: 'work/b.txt', content: 'b' });
  // Disk already holds the same bytes (e.g. restored from a backup).
  writeFileSync(join(dir, 'a.txt'), 'a');
  writeFileSync(join(dir, 'b.txt'), 'b');

  const first = await call(module, 'materialize', {});
  assert.equal((first.data as MaterializeData).materialized.length, 0, 'nothing needed writing');
  const status = (await call(module, 'status', {})).data as Record<string, { lastMaterializedBranch: string | null }>;
  assert.equal(status.work.lastMaterializedBranch, store.currentBranch().id, 'the branch is pinned');

  // So a branch that diverged before b.txt is refused rather than let through.
  store.createBranchAt('child', store.currentBranch().name, forkAt);
  store.switchBranch('child');
  await call(module, 'write', { path: 'work/a.txt', content: 'a from child' });
  const blocked = await module.handleToolCall({ id: 't', name: 'materialize', input: {} });
  assert.equal(blocked.success, false, 'divergent branch must be refused');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a');
});

test('baselines and refused paths survive a restart', async (t) => {
  const { dir, module, makeModule } = setup(t);
  let saved: WorkspaceModuleState | undefined;
  await module.start(makeCtx({ onSave: (s) => { saved = s; } }));
  await seedBaseline(module, dir);

  // One refusal before the restart, one divergence that happens across it.
  await call(module, 'write', { path: 'work/notes.txt', content: 'n1' });
  await call(module, 'materialize', {});
  writeFileSync(join(dir, 'notes.txt'), 'notes edited by shell');
  await call(module, 'write', { path: 'work/notes.txt', content: 'n2' });
  const before = await call(module, 'materialize', {});
  assert.ok(((before.data as MaterializeData).skipped ?? []).some((s) => s.reason.includes('notes.txt')));
  await module.stop();
  assert.ok(saved, 'state persisted on stop');

  writeFileSync(join(dir, 'script.sh'), 'echo edited-by-shell-while-down');
  const restarted = makeModule();
  await restarted.start(makeCtx({ saved }));
  await call(restarted, 'write', { path: 'work/script.sh', content: 'echo v2' });

  const res = await call(restarted, 'materialize', {});
  const data = res.data as MaterializeData;
  assert.equal(data.materialized.length, 0, `nothing silently written, got: ${JSON.stringify(data)}`);
  const reasons = (data.skipped ?? []).map((s) => s.reason);
  assert.ok(reasons.some((r) => r.includes('script.sh') && /stale copy/.test(r)), 'the guard holds after a restart');
  assert.ok(reasons.some((r) => r.includes('notes.txt')), 'the earlier refusal is still owed');
  assert.equal(readFileSync(join(dir, 'script.sh'), 'utf8'), 'echo edited-by-shell-while-down');
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'notes edited by shell');
});
