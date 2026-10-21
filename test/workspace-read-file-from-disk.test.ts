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
 *
 * Once the workspace has recorded the mount root's identity, the same read
 * refuses a root that is another directory: a link swapped in for it passed
 * containment, which compares canonical paths. It asks the root again while
 * it reads, and answers what it finds as before the read.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { ROOT_REPLACED, ROOT_UNAVAILABLE } from '../src/modules/workspace/observe.js';
import { changedAfterFstat, countingLoads, withFileHandle } from './helpers/file-handle.js';

/** A valid 1x1 PNG, for read_image. */
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');

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
  return { root, mountDir, store, workspace };
}

/** A workspace whose mount has a synced file, so the root's identity is recorded. */
async function recorded(t: TestContext) {
  const env = setup(t);
  writeFileSync(join(env.mountDir, 'a.txt'), 'inside');
  const synced = await env.workspace.handleToolCall({ id: 'seed', name: 'sync', input: { mount: 'work' } });
  assert.equal(synced.success, true, synced.error);
  const agreement = (env.workspace as unknown as { agreement: { rootIdentity(mount: string): unknown } }).agreement;
  assert.ok(agreement.rootIdentity('work'), 'the sync recorded the root');
  return env;
}

/** Run `fn` with node:fs/promises' `name` replaced by `make(original)`, as the module under test sees it. */
async function withFsPromises<T>(
  name: 'open' | 'lstat' | 'stat' | 'realpath',
  make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>,
  fn: () => Promise<T>,
): Promise<T> {
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

  const missing = await expectRefusal(workspace.readFileFromDisk('work/missing.txt'), 'not_found');
  assert.equal(missing.errno, 'ENOENT', 'the errno a host reads as no file');
  await expectRefusal(workspace.readFileFromDisk('work/dir'), 'directory');
  await expectRefusal(workspace.readFileFromDisk('work'), 'directory');
});

test('readBinaryFromDisk answers a file, a missing file, a directory and a file over maxBytes in its own words', async (t) => {
  const { mountDir, workspace } = setup(t);
  writeFileSync(join(mountDir, 'a.bin'), Buffer.from([0, 1, 2, 3]));
  mkdirSync(join(mountDir, 'dir'));
  const read = await workspace.readBinaryFromDisk('work/a.bin');
  assert.ok('data' in read, JSON.stringify(read));
  assert.deepEqual([...read.data], [0, 1, 2, 3]);
  assert.equal(read.absolutePath, join(mountDir, 'a.bin'));
  assert.deepEqual(await workspace.readBinaryFromDisk('work/missing.bin'), { error: 'File not found on disk: work/missing.bin' });
  // A path through a file is missing too, not the system's message with the
  // absolute path.
  assert.deepEqual(await workspace.readBinaryFromDisk('work/a.bin/x'), { error: 'File not found on disk: work/a.bin/x' });
  assert.deepEqual(await workspace.readBinaryFromDisk('work/dir'), { error: 'Not a file: work/dir' });
  assert.deepEqual(await workspace.readBinaryFromDisk('work/a.bin', { maxBytes: 3 }), { error: 'File too large: 4 > 3 bytes' });
  assert.ok('data' in (await workspace.readBinaryFromDisk('work/a.bin', { maxBytes: 4 })), 'a file of exactly maxBytes is read');
});

test("readBinaryFromDisk says a file it can't read is unreadable, whatever its size", async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('file modes don\'t keep this user out');
    return;
  }
  const { mountDir, workspace } = setup(t);
  writeFileSync(join(mountDir, 'locked.bin'), Buffer.alloc(8));
  chmodSync(join(mountDir, 'locked.bin'), 0o000);
  try {
    for (const opts of [{}, { maxBytes: 4 }]) {
      assert.deepEqual(await workspace.readBinaryFromDisk('work/locked.bin', opts), { error: 'Unable to read file: work/locked.bin' }, JSON.stringify(opts));
    }
  } finally {
    chmodSync(join(mountDir, 'locked.bin'), 0o600);
  }
});

test('a FIFO is refused at once by each disk reader, without waiting for a writer', async (t) => {
  if (process.platform === 'win32') {
    t.skip('no FIFOs on Windows');
    return;
  }
  const { mountDir, workspace } = setup(t);
  const fifo = join(mountDir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  // The bound only tells an answer from a wait for a writer that never
  // comes, so it's generous: a slow runner answers well inside it.
  const within = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} still waits on the FIFO after 10 s`)), 10_000).unref()),
  ]);
  // Nothing opens it: each reader refuses it at its lstat.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { open: (...args: any[]) => Promise<any> };
  const open = fsp.open;
  let opened = 0;
  fsp.open = (path: string, ...rest: any[]) => {
    if (String(path) === fifo) opened++;
    return open(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const err = await expectRefusal(within(workspace.readFileFromDisk('work/pipe'), 'readFileFromDisk'), 'not_found');
    assert.equal(err.message, 'Not a regular file: work/pipe');
    const image = await within(workspace.handleToolCall({ id: 'f', name: 'read_image', input: { path: 'work/pipe' } }), 'read_image');
    assert.equal(image.error, 'Not a regular file: work/pipe');
    assert.deepEqual(await within(workspace.readBinaryFromDisk('work/pipe'), 'readBinaryFromDisk'), { error: 'Not a file: work/pipe' });
    assert.equal(opened, 0, 'no reader opened the FIFO');
  } finally {
    fsp.open = open;
    syncBuiltinESMExports();
    // Release any open still waiting for a writer, so a failure ends the
    // test rather than holding the process.
    try {
      closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    } catch {
      // No reader waits (ENXIO): nothing to release.
    }
  }
});

test('a FIFO behind a symlink the mount follows is opened without waiting for a writer, and refused', async (t) => {
  if (process.platform === 'win32') {
    t.skip('no FIFOs on Windows');
    return;
  }
  const { mountDir, workspace } = setup(t, { followSymlinks: true });
  const fifo = join(mountDir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  if (!symlinkOrSkip(t, fifo, join(mountDir, 'pipe-link'))) return;
  const waited = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('readFileFromDisk still waits on the FIFO after 10 s')), 10_000).unref());
  try {
    const err = await expectRefusal(Promise.race([workspace.readFileFromDisk('work/pipe-link'), waited]), 'not_found');
    assert.equal(err.message, 'Not a regular file: work/pipe-link');
  } finally {
    try {
      closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    } catch {
      // No reader waits (ENXIO): nothing to release.
    }
  }
});

test("a directory on the way this user can't search is reported as the lookup's own failure, not as a symlink", async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('file modes don\'t keep this user out');
    return;
  }
  const { mountDir, workspace } = setup(t);
  mkdirSync(join(mountDir, 'a', 'b'), { recursive: true });
  writeFileSync(join(mountDir, 'a', 'b', 'x.txt'), 'x');
  chmodSync(join(mountDir, 'a'), 0o600);
  try {
    const err = await expectRefusal(workspace.readFileFromDisk('work/a/b/x.txt'), 'not_found');
    assert.equal(err.errno, 'EACCES');
    assert.equal(err.stage, 'lstat');
    assert.equal(err.message, 'Unable to read file: work/a/b/x.txt');
  } finally {
    chmodSync(join(mountDir, 'a'), 0o700);
  }
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

  // Final component is a regular file; only the directory hop is a symlink,
  // which a mount that doesn't follow symlinks refuses as one, with the code
  // for where it leads.
  const err = await expectRefusal(workspace.readFileFromDisk('work/linkdir/secret.txt'), 'escape');
  assert.equal(err.message, 'work/linkdir/secret.txt: "work/linkdir" is a symlink leading outside the mount, which this mount does not follow');
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

  const exact = await workspace.readFileFromDisk('work/big.txt', { maxBytes: 10_000 });
  assert.equal(exact.truncated, false, 'a file of exactly maxBytes goes on no further');
  assert.equal(exact.bytes.length, 10_000);

  const none = await workspace.readFileFromDisk('work/big.txt', { maxBytes: 0 });
  assert.deepEqual([none.bytes.length, none.truncated, none.size], [0, true, 10_000]);
  writeFileSync(join(mountDir, 'empty.txt'), '');
  const empty = await workspace.readFileFromDisk('work/empty.txt', { maxBytes: 0 });
  assert.deepEqual([empty.bytes.length, empty.truncated, empty.size], [0, false, 0]);

  await assert.rejects(workspace.readFileFromDisk('work/big.txt', { maxBytes: -1 }), RangeError);
});

test('maxBytes bounds the read itself: a file that grows past it after the open is still read no further', async (t) => {
  const { mountDir, workspace } = setup(t);
  const path = join(mountDir, 'log.txt');
  for (const start of ['a'.repeat(10), '']) {
    writeFileSync(path, start); // a file empty at the open, too: its fstat gives no size to read up to
    const { result: read, loaded } = await countingLoads(() => changedAfterFstat(path, () => appendFileSync(path, 'b'.repeat(5000)),
      () => workspace.readFileFromDisk('work/log.txt', { maxBytes: 100 })));
    assert.equal(read.bytes.toString(), (start + 'b'.repeat(5000)).slice(0, 100), 'its first maxBytes');
    assert.equal(read.truncated, true, 'the read found the file going on past maxBytes');
    assert.equal(read.size, start.length + 5000, 'its size once read, not the size the open\'s fstat gave');
    assert.ok(loaded <= 101, `loaded ${loaded} bytes: no more than maxBytes, and the one byte that shows the file goes on`);
  }
});

test('a truncated read reports a size past maxBytes even when the file shrinks under it once read', async (t) => {
  const { mountDir, workspace } = setup(t);
  const path = join(mountDir, 'log.txt');
  writeFileSync(path, 'a'.repeat(200));
  const ino = String(statSync(path, { bigint: true }).ino);
  let stats = 0;
  const read = await withFileHandle({
    stat: (stat) => async function (this: unknown, ...args: unknown[]) {
      const result = await stat.apply(this, args);
      if (String(result.ino) !== ino || ++stats === 1) return result; // the open's fstat
      truncateSync(path, 10); // the file shrinks before the fstat after the read
      return stat.apply(this, args);
    },
  }, () => workspace.readFileFromDisk('work/log.txt', { maxBytes: 100 }));
  assert.equal(stats, 2, 'the fstat after the read was made');
  assert.equal(read.bytes.toString(), 'a'.repeat(100));
  assert.equal(read.truncated, true, 'the read found the file going on past maxBytes');
  assert.equal(read.size, 101, 'the bytes the read found, where the fstat after it says 10');
});

test('a file that shrinks under maxBytes after the open is read to its end, and not reported truncated', async (t) => {
  const { mountDir, workspace } = setup(t);
  const path = join(mountDir, 'log.txt');
  writeFileSync(path, 'a'.repeat(5000));
  const read = await changedAfterFstat(path, () => truncateSync(path, 50),
    () => workspace.readFileFromDisk('work/log.txt', { maxBytes: 100 }));
  assert.equal(read.bytes.toString(), 'a'.repeat(50));
  assert.equal(read.truncated, false, 'the read reached the file\'s end');
  assert.equal(read.size, 50);
});

test('size is what the read found: a file that grows after the open, within maxBytes or with none, reports the bytes it gave', async (t) => {
  const { mountDir, workspace } = setup(t);
  const path = join(mountDir, 'log.txt');
  for (const options of [{}, { maxBytes: 100 }]) {
    writeFileSync(path, 'a'.repeat(10));
    const read = await changedAfterFstat(path, () => appendFileSync(path, 'b'.repeat(20)),
      () => workspace.readFileFromDisk('work/log.txt', options));
    assert.equal(read.bytes.toString(), 'a'.repeat(10) + 'b'.repeat(20), JSON.stringify(options));
    assert.equal(read.truncated, false);
    assert.equal(read.size, 30, `size agrees with the bytes (${JSON.stringify(options)})`);
  }
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

test('readBinaryFromDisk with maxBytes refuses a file that grows past it after the open, having loaded no more than maxBytes and one byte', async (t) => {
  const { mountDir, workspace } = setup(t);
  const path = join(mountDir, 'upload.bin');
  for (const start of [Buffer.alloc(10, 0x61), Buffer.alloc(0)]) {
    writeFileSync(path, start); // a file empty at the open, too: its fstat gives no size to read up to
    const { result, loaded } = await countingLoads(() => changedAfterFstat(path, () => appendFileSync(path, Buffer.alloc(5000, 0x62)),
      () => workspace.readBinaryFromDisk('work/upload.bin', { maxBytes: 100 })));
    assert.deepEqual(result, { error: `File too large: ${start.length + 5000} > 100 bytes` }, 'refused, with the size the read found');
    assert.ok(loaded <= 101, `loaded ${loaded} bytes: no more than maxBytes, and the one byte that shows the file goes on`);
  }
});

test('readBinaryFromDisk refuses a file found past maxBytes with a size past it, even when the file shrinks once read', async (t) => {
  const { mountDir, workspace } = setup(t);
  const path = join(mountDir, 'upload.bin');
  writeFileSync(path, Buffer.alloc(50, 0x61));
  const ino = String(statSync(path, { bigint: true }).ino);
  let stats = 0;
  const result = await withFileHandle({
    stat: (stat) => async function (this: unknown, ...args: unknown[]) {
      const found = await stat.apply(this, args);
      if (String(found.ino) !== ino) return found;
      stats++;
      if (stats === 1) appendFileSync(path, Buffer.alloc(5000, 0x62)); // grows after the open's fstat
      if (stats === 2) truncateSync(path, 10); // and shrinks before the fstat after the read
      return stats === 2 ? stat.apply(this, args) : found;
    },
  }, () => workspace.readBinaryFromDisk('work/upload.bin', { maxBytes: 100 }));
  assert.equal(stats, 2, 'the fstat after the read was made');
  assert.deepEqual(result, { error: 'File too large: 101 > 100 bytes' }, 'the bytes the read found, where the fstat after it says 10');
});

test('readBinaryFromDisk with maxBytes reads a file that grows after the open but stays within it, whole', async (t) => {
  const { mountDir, workspace } = setup(t);
  const path = join(mountDir, 'upload.bin');
  writeFileSync(path, Buffer.alloc(10, 0x61));
  const result = await changedAfterFstat(path, () => appendFileSync(path, Buffer.alloc(20, 0x62)),
    () => workspace.readBinaryFromDisk('work/upload.bin', { maxBytes: 100 }));
  assert.ok('data' in result, JSON.stringify(result));
  assert.deepEqual(result.data, Buffer.concat([Buffer.alloc(10, 0x61), Buffer.alloc(20, 0x62)]));
});

for (const replacement of ['link', 'directory'] as const) {
  const what = replacement === 'link' ? 'a link to a directory outside the mount' : "another directory at the root's path";
  test(`once the workspace has recorded the mount root, a root that is ${what} is refused by every disk reader, until a sync accepts it`, async (t) => {
    const { root, mountDir, workspace } = await recorded(t);
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'secret.txt'), 'SECRET');
    writeFileSync(join(elsewhere, 'pixel.png'), ONE_PIXEL_PNG);
    renameSync(mountDir, join(root, 'mount-away'));
    if (replacement === 'link') {
      if (!symlinkOrSkip(t, elsewhere, mountDir, 'dir')) return;
    } else {
      renameSync(elsewhere, mountDir); // as an unmounted drive's mountpoint would be
    }

    const replaced = `Mount unavailable: work: ${ROOT_REPLACED}`;
    const err = await expectRefusal(workspace.readFileFromDisk('work/secret.txt'), 'mount_unavailable');
    assert.equal(err.message, replaced);
    assert.equal(err.stage, 'root');
    assert.equal(err.errno, undefined, 'no errno: another directory is not a missing one');
    // Nor is anything beneath it absent: the workspace's own file isn't "not found" there.
    assert.equal((await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable')).message, replaced);
    assert.deepEqual(await workspace.readBinaryFromDisk('work/secret.txt'), { error: replaced });
    const image = await workspace.handleToolCall({ id: 'image', name: 'read_image', input: { path: 'work/pixel.png' } });
    assert.equal(image.error, replaced);

    // The remedy the refusal names: a sync with acceptRoot takes the root as it is now.
    const accepted = await workspace.handleToolCall({ id: 'accept', name: 'sync', input: { mount: 'work', acceptRoot: true } });
    assert.equal(accepted.success, true, accepted.error);
    assert.equal((await workspace.readFileFromDisk('work/secret.txt')).bytes.toString(), 'SECRET');
  });
}

test('a root replaced by another directory between its check and the open is refused, not read', async (t) => {
  const { root, mountDir, workspace } = await recorded(t);
  const file = join(mountDir, 'a.txt');
  let replaced = false;
  const err = await withFsPromises('open', (open) => async (path: unknown, ...rest: unknown[]) => {
    if (!replaced && String(path) === file) {
      replaced = true; // the root was checked; the file is about to be opened through its path
      renameSync(mountDir, join(root, 'mount-away'));
      mkdirSync(mountDir);
      writeFileSync(file, 'the replacement');
    }
    return open(path, ...rest);
  }, () => workspace.readFileFromDisk('work/a.txt').then(
    (read) => assert.fail(`read the replacement's file: ${read.bytes.toString()}`),
    (e: unknown) => e,
  ));
  assert.equal(replaced, true, 'the swap ran');
  assert.ok(err instanceof WorkspaceReadError && err.code === 'mount_unavailable', `refused: ${String(err)}`);
  assert.equal(err.message, `Mount unavailable: work: ${ROOT_REPLACED}`);
  assert.equal(err.stage, 'root');
});

test('a mount whose directory is gone, or is a file, is unavailable before anything beneath it is looked at, with the errno a path there gets', async (t) => {
  const { root, mountDir, workspace } = setup(t);
  writeFileSync(join(mountDir, 'a.txt'), 'inside');
  renameSync(mountDir, join(root, 'mount-away'));
  const gone = await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable');
  assert.equal(gone.message, 'Mount unavailable: work');
  assert.equal(gone.errno, 'ENOENT');
  // readBinaryFromDisk answers with the refusal's message, where it said "File not found on disk".
  assert.deepEqual(await workspace.readBinaryFromDisk('work/a.txt'), { error: 'Mount unavailable: work' });
  writeFileSync(mountDir, 'a file where the directory was');
  const file = await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable');
  assert.equal(file.message, `Mount unavailable: work: ${ROOT_UNAVAILABLE}`);
  assert.equal(file.errno, 'ENOTDIR');
  assert.deepEqual(await workspace.readBinaryFromDisk('work/a.txt'), { error: `Mount unavailable: work: ${ROOT_UNAVAILABLE}` });
});

// The root is checked before anything beneath it, and asked again before
// the read answers anything about a path beneath it: a missing file, a file
// that changed, or the file it goes on to read. Each time, what is at the
// root's path then decides the code and errno, as at the first check.
const MOMENTS = {
  // The file's lstat, the first thing looked up beneath the root.
  'before the file is found': { call: 'lstat', nth: 1, after: false },
  // The file's realpath, its recheck once it's open.
  'between the open and the file\'s recheck': { call: 'realpath', nth: 1, after: false },
  // The stat of the file's canonical path, the last check before the root's own.
  'once the file is open': { call: 'stat', nth: 1, after: true },
} as const;
for (const [moment, { call, nth, after }] of Object.entries(MOMENTS)) {
  for (const state of ['removed', 'replaced by a file', 'replaced by another directory', 'replaced by another directory holding the file'] as const) {
    const skip = process.platform === 'win32' && moment !== 'before the file is found'
      ? 'it renames the directory of a file the read holds open, which Windows may refuse'
      : false;
    test(`a root ${state} ${moment} is refused with the code and errno the root's check gives that state`, { skip }, async (t) => {
      const { root, mountDir, workspace } = await recorded(t);
      const file = join(mountDir, 'a.txt');
      const at = call === 'stat' ? realpathSync(file) : file;
      let calls = 0;
      let moved = false;
      const move = () => {
        moved = true;
        renameSync(mountDir, join(root, 'mount-away'));
        if (state === 'replaced by a file') writeFileSync(mountDir, 'a file where the directory was');
        if (state.startsWith('replaced by another directory')) mkdirSync(mountDir);
        if (state === 'replaced by another directory holding the file') writeFileSync(file, 'the replacement');
      };
      const err = await withFsPromises(call, (original) => async (path: unknown, ...rest: unknown[]) => {
        if (moved || String(path) !== at || ++calls !== nth) return original(path, ...rest);
        if (!after) move();
        const result = await original(path, ...rest);
        if (after) move();
        return result;
      }, () => workspace.readFileFromDisk('work/a.txt').then(
        (read) => assert.fail(`read through the moved root: ${read.bytes.toString()}`),
        (e: unknown) => e,
      ));
      assert.equal(moved, true, 'the root moved');
      assert.ok(err instanceof WorkspaceReadError && err.code === 'mount_unavailable', `refused as unavailable: ${String(err)}`);
      assert.equal(err.stage, 'root');
      if (state.startsWith('replaced by another directory')) {
        assert.equal(err.message, `Mount unavailable: work: ${ROOT_REPLACED}`);
        assert.equal(err.errno, undefined, 'no errno: another directory is not a missing one');
      } else {
        assert.equal(err.message, `Mount unavailable: work: ${ROOT_UNAVAILABLE}`);
        assert.equal(err.errno, state === 'removed' ? 'ENOENT' : 'ENOTDIR', 'the errno a root in that state gets before the read');
      }
    });
  }
}

// A mount configured through a link, re-pointed to another directory while a
// read runs, as a blue-green deploy swaps one. The directory the read checked
// is untouched: only the configured path's realpath shows that the mount is
// now another directory.
for (const [moment, { call, nth, after }] of Object.entries(MOMENTS)) {
  const skip = process.platform === 'win32' ? 'it renames a link over the mount\'s link, which Windows may refuse' : false;
  test(`a mount configured through a link that is re-pointed ${moment} is refused as replaced, not read`, { skip }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'af-read-from-disk-'));
    let store: JsStore | undefined;
    t.after(() => {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    });
    const blue = join(root, 'blue');
    const green = join(root, 'green');
    mkdirSync(blue);
    mkdirSync(green);
    writeFileSync(join(blue, 'a.txt'), 'blue');
    writeFileSync(join(green, 'a.txt'), 'green');
    const link = join(root, 'current');
    if (!symlinkOrSkip(t, blue, link, 'dir')) return;
    store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
    const workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: link, mode: 'read-write', watch: 'never' }] });
    workspace.initStore(store);
    const synced = await workspace.handleToolCall({ id: 'seed', name: 'sync', input: { mount: 'work' } });
    assert.equal(synced.success, true, synced.error);

    const file = join(link, 'a.txt');
    const at = call === 'stat' ? realpathSync(file) : file;
    let calls = 0;
    let moved = false;
    const repoint = () => {
      moved = true;
      symlinkSync(green, join(root, 'next'), 'dir');
      renameSync(join(root, 'next'), link);
    };
    const err = await withFsPromises(call, (original) => async (path: unknown, ...rest: unknown[]) => {
      if (moved || String(path) !== at || ++calls !== nth) return original(path, ...rest);
      if (!after) repoint();
      const result = await original(path, ...rest);
      if (after) repoint();
      return result;
    }, () => workspace.readFileFromDisk('work/a.txt').then(
      (read) => assert.fail(`read through the re-pointed link: ${read.bytes.toString()}`),
      (e: unknown) => e,
    ));
    assert.equal(moved, true, 'the link was re-pointed');
    assert.ok(err instanceof WorkspaceReadError && err.code === 'mount_unavailable', `refused as unavailable: ${String(err)}`);
    assert.equal(err.message, `Mount unavailable: work: ${ROOT_REPLACED}`);
    assert.equal(err.stage, 'root');
    assert.equal(err.errno, undefined, 'no errno: another directory is not a missing one');
  });
}

test('a mount with no recorded identity is asked about its root mid-read too', async (t) => {
  const { root, mountDir, workspace } = setup(t);
  const file = join(mountDir, 'a.txt');
  writeFileSync(file, 'inside');
  let moved = false;
  const err = await withFsPromises('lstat', (lstat) => async (path: unknown, ...rest: unknown[]) => {
    if (!moved && String(path) === file) {
      moved = true; // the root was checked, with no identity to compare; the file is looked up next
      renameSync(mountDir, join(root, 'mount-away'));
      mkdirSync(mountDir);
    }
    return lstat(path, ...rest);
  }, () => workspace.readFileFromDisk('work/a.txt').then(
    (read) => assert.fail(`read through the moved root: ${read.bytes.toString()}`),
    (e: unknown) => e,
  ));
  assert.equal(moved, true, 'the root moved');
  assert.ok(err instanceof WorkspaceReadError && err.code === 'mount_unavailable', `refused as unavailable: ${String(err)}`);
  assert.equal(err.stage, 'root');
  assert.equal(err.errno, undefined, 'not reported missing from the directory put in its place');
});

test('while the disk evidence awaits reopening, a read goes on, checked against the root identity last recorded', async (t) => {
  const { root, mountDir, store, workspace } = await recorded(t);
  writeFileSync(join(mountDir, 'b.txt'), 'more');
  // An append to the evidence fails inside the store, so the evidence can't
  // be read again until the store is reopened.
  const patched = store as unknown as { appendJson: (type: string, payload: unknown) => unknown };
  const append = patched.appendJson;
  patched.appendJson = function (this: unknown, type: string, payload: unknown) {
    if (type === 'workspace/disk-agreement') throw new Error('injected: the store refused the append');
    return append.call(this, type, payload);
  };
  try {
    const synced = await workspace.handleToolCall({ id: 'sync', name: 'sync', input: { mount: 'work' } });
    assert.equal(synced.success, false, 'the sync that would record b.txt failed');
  } finally {
    patched.appendJson = append;
  }
  const again = await workspace.handleToolCall({ id: 'again', name: 'sync', input: { mount: 'work' } });
  assert.match(again.error ?? '', /until the store is reopened/, 'the evidence awaits reopening');

  assert.equal((await workspace.readFileFromDisk('work/a.txt')).bytes.toString(), 'inside', 'the mount\'s own file is read');
  renameSync(mountDir, join(root, 'mount-away'));
  mkdirSync(mountDir);
  writeFileSync(join(mountDir, 'a.txt'), 'the replacement');
  const err = await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable');
  assert.equal(err.message, `Mount unavailable: work: ${ROOT_REPLACED}`, 'another directory is refused, as before the failure');
});

test("a sync with acceptRoot whose append fails leaves reads refusing the root it was to accept", async (t) => {
  const { root, mountDir, store, workspace } = await recorded(t);
  renameSync(mountDir, join(root, 'mount-away'));
  mkdirSync(mountDir);
  writeFileSync(join(mountDir, 'a.txt'), 'the replacement');
  const patched = store as unknown as { appendJson: (type: string, payload: unknown) => unknown };
  const append = patched.appendJson;
  patched.appendJson = function (this: unknown, type: string, payload: unknown) {
    if (type === 'workspace/disk-agreement') throw new Error('injected: the store refused the append');
    return append.call(this, type, payload);
  };
  try {
    const accepted = await workspace.handleToolCall({ id: 'accept', name: 'sync', input: { mount: 'work', acceptRoot: true } });
    assert.equal(accepted.success, false, 'the sync whose append failed fails');
  } finally {
    patched.appendJson = append;
  }
  // The identity in memory is still the one from before: append comes before apply.
  const err = await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable');
  assert.equal(err.message, `Mount unavailable: work: ${ROOT_REPLACED}`);
});

/**
 * Mounts recorded in a store, which is then closed and opened again, as at a
 * restart, by a workspace whose mounts are `again`, with `breaking` making the
 * store fail as that open reads or writes the disk evidence. Its initStore
 * throws; the workspace is returned for reads all the same.
 */
async function reopenedBroken(
  t: TestContext,
  first: Array<{ name: string; path: string }>,
  again: Array<{ name: string; path: string }>,
  breaking: (store: Record<string, (...args: any[]) => unknown>) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'af-read-from-disk-'));
  const path = join(root, 'workspace.chronicle');
  let store: JsStore | undefined;
  t.after(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const mounts = (list: typeof first) => list.map(({ name, path: dir }) => ({ name, path: join(root, dir), mode: 'read-write' as const, watch: 'never' as const }));
  for (const { path: dir } of [...first, ...again]) mkdirSync(join(root, dir), { recursive: true });
  for (const { path: dir } of first) writeFileSync(join(root, dir, 'a.txt'), `inside ${dir}`);
  store = JsStore.openOrCreate({ path });
  const before = new WorkspaceModule({ mounts: mounts(first) });
  before.initStore(store);
  for (const { name } of first) {
    const synced = await before.handleToolCall({ id: `seed-${name}`, name: 'sync', input: { mount: name } });
    assert.equal(synced.success, true, synced.error);
  }
  store.close();
  store = JsStore.openOrCreate({ path });
  breaking(store as unknown as Record<string, (...args: any[]) => unknown>);
  const workspace = new WorkspaceModule({ mounts: mounts(again) });
  assert.throws(() => workspace.initStore(store!), /injected/, 'the open fails');
  return { root, workspace };
}

test("a workspace whose open couldn't read its disk evidence back refuses disk reads, with no directory's errno only where there's none", async (t) => {
  const mount = [{ name: 'work', path: 'mount' }];
  const { root, workspace } = await reopenedBroken(t, mount, mount, (store) => {
    const ids = store.getRecordIdsByType!;
    store.getRecordIdsByType = function (this: unknown, type: string) {
      if (String(type).startsWith('workspace/disk-agreement')) throw new Error('injected: the store could not be read');
      return ids.call(this, type);
    };
  });
  const err = await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable');
  assert.equal(err.stage, 'root');
  assert.match(err.message, /^Mount unavailable: work: Disk-agreement evidence is unavailable until the store is reopened/);
  assert.equal(err.errno, undefined, 'a directory is there');
  rmSync(join(root, 'mount'), { recursive: true });
  writeFileSync(join(root, 'mount'), 'a file where the directory was');
  const file = await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable');
  assert.equal(file.errno, 'ENOTDIR', 'no directory is there, whatever the evidence');
});

test("a workspace whose open failed to record a changed mount refuses disk reads of every mount, the ones after it included", async (t) => {
  // The first mount's directory changed since the evidence was recorded, so
  // the open appends its record first, and that append fails in the store.
  const { root, workspace } = await reopenedBroken(t,
    [{ name: 'work', path: 'mount' }, { name: 'other', path: 'other' }],
    [{ name: 'work', path: 'moved' }, { name: 'other', path: 'other' }],
    (store) => {
      const append = store.appendJson!;
      store.appendJson = function (this: unknown, type: string, payload: unknown) {
        if (type === 'workspace/disk-agreement') throw new Error('injected: the store refused the append');
        return append.call(this, type, payload);
      };
    });
  // A directory put at the later mount's root is refused, not read unchecked.
  renameSync(join(root, 'other'), join(root, 'other-away'));
  mkdirSync(join(root, 'other'));
  writeFileSync(join(root, 'other', 'a.txt'), 'the replacement');
  const other = await expectRefusal(workspace.readFileFromDisk('other/a.txt'), 'mount_unavailable');
  assert.match(other.message, /^Mount unavailable: other: Disk-agreement evidence is unavailable until the store is reopened/);
  const work = await expectRefusal(workspace.readFileFromDisk('work/a.txt'), 'mount_unavailable');
  assert.match(work.message, /^Mount unavailable: work: Disk-agreement evidence is unavailable until the store is reopened/);
});
