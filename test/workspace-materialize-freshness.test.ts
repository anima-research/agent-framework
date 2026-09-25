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
import type { ModuleContext } from '../src/types/module.js';

function makeCtx(): ModuleContext {
  return {
    isRestart: false,
    getState: <T,>() => null as T | null,
    setState: () => {},
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
  const module = new WorkspaceModule({
    mounts: [{ name: 'work', path: dir, mode: 'read-write' as const, watch: 'never' as const }],
  });
  module.initStore(store);
  return { store, dir, module };
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

test('sync-then-materialize resolves the divergence in the disk direction', async (t) => {
  const { dir, module } = setup(t);
  await module.start(makeCtx());
  await seedBaseline(module, dir);

  writeFileSync(join(dir, 'script.sh'), 'echo edited-by-shell');
  await call(module, 'write', { path: 'work/script.sh', content: 'echo v2' });
  await call(module, 'materialize', {}); // refused, listed

  // The remedy the skip reason points at: adopt the disk version.
  await call(module, 'sync', {});
  const res = await call(module, 'materialize', {});
  assert.equal(((res.data as MaterializeData).skipped ?? []).length, 0,
    'after sync the tree matches disk — nothing left to refuse');
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
