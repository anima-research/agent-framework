/**
 * WorkspaceModule.readFileFromDisk — filesystem-enforced mount containment
 * for peer modules (issue #129).
 *
 * `resolveAbsolutePath()` is lexical: an in-mount symlink targeting an outside
 * file passes it, and a peer that then `fs.readFile`s the returned path reads
 * the outside content (connectome-host #101 pulled such a file into a
 * system-position injection). `readFileFromDisk()` is the workspace-owned read
 * that enforces the mount's `followSymlinks` policy and canonical containment,
 * so peers stop reimplementing the boundary.
 *
 * Symlink cases create real symlinks; on Windows that needs a privilege the
 * test runner may not have (EPERM), in which case those cases are skipped —
 * the non-symlink cases still run everywhere.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';

function setup(t: TestContext, options?: { followSymlinks?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'af-read-from-disk-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'work', path: mountDir, mode: 'read-write', watch: 'never', followSymlinks: options?.followSymlinks }],
  });
  workspace.initStore(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, mountDir, workspace };
}

/** Create a symlink, or skip the test when the platform refuses (Windows without the privilege). */
function symlinkOrSkip(t: TestContext, target: string, linkPath: string, type?: 'file' | 'dir' | 'junction'): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`symlink creation not permitted on this platform (${code})`);
      return false;
    }
    throw err;
  }
}

async function expectRefusal(promise: Promise<unknown>, code: WorkspaceReadError['code']): Promise<WorkspaceReadError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WorkspaceReadError, `expected WorkspaceReadError, got ${String(err)}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  assert.fail(`expected a WorkspaceReadError(${code}) but the read succeeded`);
}

test('a regular in-mount file can be read, with size and mtime reported', async (t) => {
  const { mountDir, workspace } = setup(t);
  writeFileSync(join(mountDir, 'AGENTS.md'), '# instructions\n');

  const result = await workspace.readFileFromDisk('work/AGENTS.md');
  assert.equal(result.bytes.toString('utf8'), '# instructions\n');
  assert.equal(result.size, Buffer.byteLength('# instructions\n'));
  assert.equal(result.truncated, false);
  assert.equal(result.mount, 'work');
  assert.ok(result.mtimeMs > 0);
  assert.ok(result.realPath.endsWith('AGENTS.md'));
});

test('nested paths read and reject lexical traversal / unknown mounts by code', async (t) => {
  const { mountDir, workspace } = setup(t);
  mkdirSync(join(mountDir, 'sub'), { recursive: true });
  writeFileSync(join(mountDir, 'sub', 'deep.txt'), 'deep');

  assert.equal((await workspace.readFileFromDisk('work/sub/deep.txt')).bytes.toString(), 'deep');

  const traversal = await expectRefusal(workspace.readFileFromDisk('work/../outside.txt'), 'traversal');
  assert.match(traversal.message, /traversal/i);
  await expectRefusal(workspace.readFileFromDisk('nope/file.txt'), 'unknown_mount');
});

test('missing files and directories are distinguished', async (t) => {
  const { mountDir, workspace } = setup(t);
  mkdirSync(join(mountDir, 'dir'));

  await expectRefusal(workspace.readFileFromDisk('work/missing.txt'), 'not_found');
  await expectRefusal(workspace.readFileFromDisk('work/dir'), 'directory');
  await expectRefusal(workspace.readFileFromDisk('work'), 'directory');
});

test('a final-component symlink to an outside file is rejected under the default no-follow policy', async (t) => {
  const { root, mountDir, workspace } = setup(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  if (!symlinkOrSkip(t, join(outside, 'secret.txt'), join(mountDir, 'AGENTS.md'), 'file')) return;

  // The lexical resolver is happy — that is exactly the gap.
  assert.ok(workspace.resolveAbsolutePath('work/AGENTS.md'));

  const err = await expectRefusal(workspace.readFileFromDisk('work/AGENTS.md'), 'symlink');
  assert.ok(!err.message.includes(root), 'refusal must not leak absolute paths');
});

test('an intermediate symlinked directory escaping the mount is rejected under no-follow', async (t) => {
  const { root, mountDir, workspace } = setup(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  if (!symlinkOrSkip(t, outside, join(mountDir, 'linkdir'), 'dir')) return;

  // Final component is a regular file; only the directory hop is a symlink.
  const err = await expectRefusal(workspace.readFileFromDisk('work/linkdir/secret.txt'), 'escape');
  assert.ok(!err.message.includes(root));
});

test('with followSymlinks, an in-mount target is followed but an outside target is still an escape', async (t) => {
  const { root, mountDir, workspace } = setup(t, { followSymlinks: true });
  writeFileSync(join(mountDir, 'real.txt'), 'inside');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  if (!symlinkOrSkip(t, join(mountDir, 'real.txt'), join(mountDir, 'alias.txt'), 'file')) return;
  if (!symlinkOrSkip(t, join(outside, 'secret.txt'), join(mountDir, 'leak.txt'), 'file')) return;

  const followed = await workspace.readFileFromDisk('work/alias.txt');
  assert.equal(followed.bytes.toString(), 'inside');
  assert.ok(followed.realPath.endsWith('real.txt'), 'realPath reports the canonical target');

  await expectRefusal(workspace.readFileFromDisk('work/leak.txt'), 'escape');
});

test('with followSymlinks, an in-mount symlink is followed only because policy allows it', async (t) => {
  const strict = setup(t);
  writeFileSync(join(strict.mountDir, 'real.txt'), 'inside');
  if (!symlinkOrSkip(t, join(strict.mountDir, 'real.txt'), join(strict.mountDir, 'alias.txt'), 'file')) return;
  // Same layout, default policy: the in-mount symlink is refused as a symlink,
  // not followed — containment would have passed, policy says no.
  await expectRefusal(strict.workspace.readFileFromDisk('work/alias.txt'), 'symlink');
});

test('a sibling-prefix directory is not beneath the mount', async (t) => {
  const { root, mountDir, workspace } = setup(t, { followSymlinks: true });
  const sibling = join(root, 'mount-other');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'x.txt'), 'sibling');
  if (!symlinkOrSkip(t, join(sibling, 'x.txt'), join(mountDir, 'x.txt'), 'file')) return;

  // `/mount-other/x.txt` starts with `/mount` as a string prefix — a naive
  // startsWith(root) check would accept it.
  await expectRefusal(workspace.readFileFromDisk('work/x.txt'), 'escape');
});

test('maxBytes performs a bounded prefix read and reports truncation', async (t) => {
  const { mountDir, workspace } = setup(t);
  const content = 'x'.repeat(10_000);
  writeFileSync(join(mountDir, 'big.txt'), content);

  const capped = await workspace.readFileFromDisk('work/big.txt', { maxBytes: 1024 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.bytes.length, 1024);
  assert.equal(capped.size, 10_000, 'size reports the full on-disk length');
  assert.equal(capped.bytes.toString(), 'x'.repeat(1024));

  const whole = await workspace.readFileFromDisk('work/big.txt', { maxBytes: 20_000 });
  assert.equal(whole.truncated, false);
  assert.equal(whole.bytes.length, 10_000);

  await assert.rejects(workspace.readFileFromDisk('work/big.txt', { maxBytes: -1 }), RangeError);
});

test('read_image keeps its historical error wording after sharing the containment core', async (t) => {
  // The image reader was the original owner of this algorithm; its messages
  // are pinned by workspace-read-image.test.ts. Spot-check the two codes the
  // shared core maps most delicately (not_found variants and directory).
  const { mountDir, workspace } = setup(t);
  mkdirSync(join(mountDir, 'folder'));
  const dir = await workspace.handleToolCall({ id: 'c1', name: 'read_image', input: { path: 'work/folder' } });
  assert.equal(dir.error, 'Path is a directory: work/folder');
  const missing = await workspace.handleToolCall({ id: 'c2', name: 'read_image', input: { path: 'work/nope.png' } });
  assert.equal(missing.error, 'File not found: work/nope.png');
});
