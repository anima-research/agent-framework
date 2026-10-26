import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ToolResult } from '../src/types/events.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4560000000049454e44ae426082', 'hex');

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-disk-field-'));
  const dirs = { drafts: join(root, 'drafts'), pushed: join(root, 'pushed'), direct: join(root, 'direct') };
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    writeFileSync(join(dir, 'b.txt'), 'beta\n');
    writeFileSync(join(dir, 'old.txt'), 'old\n');
  }
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [
      { name: 'drafts', path: dirs.drafts, mode: 'read-write', watch: 'never' },
      { name: 'pushed', path: dirs.pushed, mode: 'read-write', watch: 'never', autoMaterialize: true },
      { name: 'direct', path: dirs.direct, mode: 'read-write', backend: 'direct' },
    ] as MountConfig[],
  });
  workspace.initStore(store);
  await workspace.start({
    isRestart: false,
    getState: () => null,
    setState: () => {},
    pushEvent: () => {},
    notifyOps: () => {},
  } as unknown as ModuleContext);
  t.after(async () => {
    await workspace.stop().catch(() => {});
    if (!store.isClosed()) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const result = await workspace.handleToolCall({ id: name, name, input, callerAgentName: 'scout' });
    assert.equal(result.success, true, `${name} ${JSON.stringify(input)}: ${result.error}`);
    return result;
  };
  const fields = (result: ToolResult) => (result.structured ?? result.data) as Record<string, unknown>;
  const headerLines = (result: ToolResult) => (result.data as Array<{ text: string }>)[0]!.text.split('\n');
  const disk = (mount: keyof typeof dirs, rel: string): string | null =>
    (existsSync(join(dirs[mount], rel)) ? readFileSync(join(dirs[mount], rel), 'latin1') : null);
  const status = async (mount: keyof typeof dirs) =>
    fields(await call('status', { mount }))[mount] as { pendingChanges: number; conflicts: number; pendingWorkspaceDeletions: number };
  return { workspace, store, dirs, call, fields, headerLines, disk, status };
}

test('on a mount without autoMaterialize, each answer that writes names the materialize its change waits for, and disk has the change only after it', async (t) => {
  const { workspace, call, fields, headerLines, disk } = await setup(t);

  const written = await call('write', { path: 'drafts/new.txt', content: 'new\n' });
  assert.equal(fields(written).disk, 'waits for materialize');
  assert.equal(disk('drafts', 'new.txt'), null);

  const edited = await call('edit', { path: 'drafts/a.txt', oldString: 'alpha', newString: 'ALPHA' });
  assert.equal(fields(edited).disk, 'waits for materialize');
  assert.ok(headerLines(edited).includes('disk: waits for materialize'), headerLines(edited).join('\n'));
  assert.equal(disk('drafts', 'a.txt'), 'alpha\n');

  const many = await call('edit_many', { edits: [
    { path: 'drafts/a.txt', oldString: 'ALPHA', newString: 'Alpha' },
    { path: 'drafts/b.txt', oldString: 'beta', newString: 'Beta' },
  ] });
  assert.equal(fields(many).disk, 'waits for materialize');
  assert.ok(headerLines(many).includes('disk: waits for materialize'), headerLines(many).join('\n'));
  assert.equal(disk('drafts', 'b.txt'), 'beta\n');

  const image = await workspace.writeBinary('drafts/pic.png', PNG, 'image/png');
  assert.equal(image.success, true, image.error);
  assert.equal((image.data as Record<string, unknown>).disk, 'waits for materialize');
  assert.equal(disk('drafts', 'pic.png'), null);

  const deleted = await call('delete', { path: 'drafts/old.txt' });
  assert.equal(fields(deleted).disk, 'waits for materialize with applyDeletions');
  assert.equal(disk('drafts', 'old.txt'), 'old\n');

  await call('materialize', { path: 'drafts' });
  assert.deepEqual(
    [disk('drafts', 'new.txt'), disk('drafts', 'a.txt'), disk('drafts', 'b.txt'), disk('drafts', 'pic.png'), disk('drafts', 'old.txt')],
    ['new\n', 'Alpha\n', 'Beta\n', PNG.toString('latin1'), 'old\n'],
    'a materialize writes the files, and leaves the deletion',
  );
  await call('materialize', { path: 'drafts', applyDeletions: true });
  assert.equal(disk('drafts', 'old.txt'), null, 'a materialize with applyDeletions removes the file');
});

for (const mount of ['pushed', 'direct'] as const) {
  test(`on ${mount === 'pushed' ? 'a mount with autoMaterialize' : 'a direct mount'}, each answer that writes says done, and disk has the change as it answers`, async (t) => {
    const { workspace, call, fields, headerLines, disk } = await setup(t);

    assert.equal(fields(await call('write', { path: `${mount}/new.txt`, content: 'new\n' })).disk, 'done');
    assert.equal(disk(mount, 'new.txt'), 'new\n');

    const edited = await call('edit', { path: `${mount}/a.txt`, oldString: 'alpha', newString: 'ALPHA' });
    assert.equal(fields(edited).disk, 'done');
    assert.ok(headerLines(edited).includes('disk: done'), headerLines(edited).join('\n'));
    assert.equal(disk(mount, 'a.txt'), 'ALPHA\n');

    const many = await call('edit_many', { edits: [
      { path: `${mount}/a.txt`, oldString: 'ALPHA', newString: 'Alpha' },
      { path: `${mount}/b.txt`, oldString: 'beta', newString: 'Beta' },
    ] });
    assert.equal(fields(many).disk, 'done');
    assert.ok(headerLines(many).includes('disk: done'), headerLines(many).join('\n'));
    assert.deepEqual([disk(mount, 'a.txt'), disk(mount, 'b.txt')], ['Alpha\n', 'Beta\n']);

    const image = await workspace.writeBinary(`${mount}/pic.png`, PNG, 'image/png');
    assert.equal(image.success, true, image.error);
    assert.equal((image.data as Record<string, unknown>).disk, 'done');
    assert.equal(disk(mount, 'pic.png'), PNG.toString('latin1'));

    assert.equal(fields(await call('delete', { path: `${mount}/old.txt` })).disk, 'done');
    assert.equal(disk(mount, 'old.txt'), null);
  });
}

test('on a mount without autoMaterialize, deleting a file disk never had says done, and nothing waits for a materialize', async (t) => {
  const { call, fields, disk, status } = await setup(t);
  await call('write', { path: 'drafts/scratch.txt', content: 'scratch\n' });
  const deleted = await call('delete', { path: 'drafts/scratch.txt' });
  assert.equal(fields(deleted).disk, 'done');
  assert.equal(disk('drafts', 'scratch.txt'), null);
  const { pendingChanges, pendingWorkspaceDeletions } = await status('drafts');
  assert.deepEqual([pendingChanges, pendingWorkspaceDeletions], [0, 0]);
});

test('on a mount without autoMaterialize, writing the bytes disk already agreed it has says done, and nothing waits for a materialize', async (t) => {
  const { call, fields, status } = await setup(t);
  await call('read', { path: 'drafts/a.txt' });
  assert.equal(fields(await call('write', { path: 'drafts/a.txt', content: 'alpha\n' })).disk, 'done');
  assert.equal((await status('drafts')).pendingChanges, 0);
});

test('a change to a path in conflict with disk says so, edit_many says so whichever of its files is in conflict, and an unforced materialize leaves it', async (t) => {
  const { dirs, call, fields, headerLines, disk, status } = await setup(t);
  await call('edit', { path: 'drafts/a.txt', oldString: 'alpha', newString: 'ALPHA' });
  writeFileSync(join(dirs.drafts, 'a.txt'), 'someone else\n');
  await call('materialize', { path: 'drafts/a.txt' });
  assert.equal((await status('drafts')).conflicts, 1, 'the materialize met the conflict');

  const edited = await call('edit', { path: 'drafts/a.txt', oldString: 'ALPHA', newString: 'Alpha' });
  assert.equal(fields(edited).disk, 'in conflict with disk');
  assert.ok(headerLines(edited).includes('disk: in conflict with disk'), headerLines(edited).join('\n'));
  const conflictFirst = await call('edit_many', { edits: [
    { path: 'drafts/a.txt', oldString: 'Alpha', newString: 'ALPHA' },
    { path: 'drafts/b.txt', oldString: 'beta', newString: 'Beta' },
  ] });
  assert.equal(fields(conflictFirst).disk, 'in conflict with disk', 'the file in conflict first');
  const conflictLast = await call('edit_many', { edits: [
    { path: 'drafts/b.txt', oldString: 'Beta', newString: 'BETA' },
    { path: 'drafts/a.txt', oldString: 'ALPHA', newString: 'Alpha' },
  ] });
  assert.equal(fields(conflictLast).disk, 'in conflict with disk', 'the file in conflict last');
  await call('materialize', { path: 'drafts' });
  assert.equal(disk('drafts', 'a.txt'), 'someone else\n', 'an unforced materialize leaves disk\'s copy');
  assert.equal(fields(await call('delete', { path: 'drafts/a.txt' })).disk, 'in conflict with disk');
});

test('edit_many answers waits for materialize when one of its files waits and another is back at the bytes disk agreed it has, in either order', async (t) => {
  const { call, fields } = await setup(t);
  await call('edit', { path: 'drafts/a.txt', oldString: 'alpha', newString: 'ALPHA' });
  const restoredFirst = await call('edit_many', { edits: [
    { path: 'drafts/a.txt', oldString: 'ALPHA', newString: 'alpha' },
    { path: 'drafts/b.txt', oldString: 'beta', newString: 'Beta' },
  ] });
  assert.equal(fields(restoredFirst).disk, 'waits for materialize', 'the restored file first');
  const restoredLast = await call('edit_many', { edits: [
    { path: 'drafts/a.txt', oldString: 'alpha', newString: 'ALPHA' },
    { path: 'drafts/b.txt', oldString: 'Beta', newString: 'beta' },
  ] });
  assert.equal(fields(restoredLast).disk, 'waits for materialize', 'the restored file last');
  assert.equal(fields(await call('edit', { path: 'drafts/a.txt', oldString: 'ALPHA', newString: 'alpha' })).disk, 'done', 'the edited file is back at the bytes disk agreed it has');
});

test("a change's disk value is the branch it landed on, when the branch changes during the call", async (t) => {
  const { store, workspace, call, fields } = await setup(t);
  await call('read', { path: 'drafts/a.txt' });
  const main = store.currentBranch().name;
  store.createBranch('other', main);
  const tree = (workspace as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('drafts')!.treeStateId;
  const read = store.treeGet(tree, 'a.txt')!.blobHash;
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const getBlob = store.getBlob;
  s.getBlob = (...args) => {
    if (args[0] === read) queueMicrotask(() => store.switchBranch('other'));
    return getBlob.apply(store, args as never);
  };
  let edited: ToolResult;
  try {
    edited = await call('edit', { path: 'drafts/a.txt', oldString: 'alpha', newString: 'ALPHA' });
  } finally {
    delete s.getBlob;
  }
  assert.equal(store.currentBranch().name, 'other', 'the branch changed during the call');
  assert.equal(fields(edited).disk, 'waits for materialize');
  store.switchBranch(main);
});
