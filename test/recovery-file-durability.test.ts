/**
 * The recovery files (host mode here) are written as a temp file synced and
 * renamed over the record, with the directory and its parent synced after
 * the rename. These drive the record through the framework, recording the
 * node:fs calls each write makes. (#291 took the deferral queue away, and
 * with it the deferred-writes record this file once drove too, rewritten
 * at each write made while quiesced.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

async function withFramework(
  fn: (framework: AgentFramework, recovery: string, dir: string) => Promise<void>,
  config: { hostModePath?: (dir: string) => string } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-durability-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    ...(config.hostModePath ? { hostModePath: config.hostModePath(dir) } : {}),
  });
  try {
    framework.start();
    await fn(framework, join(dir, 'store', 'recovery'), dir);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface FsCall { call: 'open' | 'fsync' | 'close' | 'rename' | 'unlink'; path?: string; to?: string; fd?: number }

/** Runs `fn` with node:fs's openSync, fsyncSync, closeSync, renameSync and unlinkSync recorded in order, each fd
 *  named by the path it was opened for. `fail` may return an error for an fsync or an unlink to throw instead. */
async function recordingFs(
  fn: () => Promise<unknown>,
  fail?: (call: FsCall) => Error | undefined,
): Promise<FsCall[]> {
  const calls: FsCall[] = [];
  const opened = new Map<number, string>();
  const original = {
    openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync,
  };
  fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
    const fd = (original.openSync as (...args: unknown[]) => number)(path, ...rest);
    opened.set(fd, String(path));
    calls.push({ call: 'open', path: String(path), fd });
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((fd: number) => {
    const call: FsCall = { call: 'fsync', path: opened.get(fd), fd };
    calls.push(call);
    const error = fail?.(call);
    if (error) throw error;
    original.fsyncSync(fd);
  }) as typeof fs.fsyncSync;
  fs.closeSync = ((fd: number) => {
    calls.push({ call: 'close', path: opened.get(fd), fd });
    original.closeSync(fd);
  }) as typeof fs.closeSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    calls.push({ call: 'rename', path: String(from), to: String(to) });
    original.renameSync(from, to);
  }) as typeof fs.renameSync;
  fs.unlinkSync = ((path: fs.PathLike) => {
    const call: FsCall = { call: 'unlink', path: String(path) };
    calls.push(call);
    const error = fail?.(call);
    if (error) throw error;
    original.unlinkSync(path);
  }) as typeof fs.unlinkSync;
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
  return calls;
}

const fsError = (code: string, syscall: string) => Object.assign(new Error(`${code}: i/o error, ${syscall}`), { code, syscall });
const isTemporaryOf = (record: string, path: string | undefined) =>
  path !== undefined && path.startsWith(`${record}.`) && path.endsWith('.tmp');

/** The rename that put a record in place, and the temp file it renamed. */
function recordRename(calls: FsCall[], record: string): { at: number; temporary: string } {
  const at = calls.findIndex((c) => c.call === 'rename' && c.to === record);
  assert.ok(at >= 0, `a rename onto ${record}: ${JSON.stringify(calls)}`);
  const temporary = calls[at].path!;
  assert.ok(isTemporaryOf(record, temporary), temporary);
  return { at, temporary };
}

/** The temp file synced before its rename onto `record`, and `directory` synced after it. */
function assertSyncedAround(calls: FsCall[], record: string, directory: string): void {
  const rename = recordRename(calls, record);
  const tempSync = calls.findIndex((c) => c.call === 'fsync' && c.path === rename.temporary);
  assert.ok(tempSync >= 0 && tempSync < rename.at, `the temp file synced before the rename: ${JSON.stringify(calls)}`);
  assert.ok(
    calls.some((c, i) => i > rename.at && c.call === 'fsync' && c.path === directory),
    `${directory} synced after the rename: ${JSON.stringify(calls)}`,
  );
}

/** Every descriptor opened on a path `ours` names is closed before its number is opened again. */
function assertEachClosed(calls: FsCall[], ours: (path: string | undefined) => boolean): void {
  calls.forEach((c, i) => {
    if (c.call !== 'open' || !ours(c.path)) return;
    const next = calls.findIndex((d, j) => j > i && d.fd === c.fd && (d.call === 'close' || d.call === 'open'));
    assert.ok(next >= 0 && calls[next]!.call === 'close', `${c.path} (fd ${c.fd}) closed: ${JSON.stringify(calls)}`);
  });
}

test('quiesce syncs the host-mode record\'s temp file before renaming it over the record, and the directory and its parent after, closing each and publishing the record at 0600', async () => {
  await withFramework(async (framework, recovery) => {
    const record = join(recovery, 'host-mode.json');
    const calls = await recordingFs(() => framework.quiesce({ reason: 'test' }));
    assertSyncedAround(calls, record, recovery);
    assertSyncedAround(calls, record, dirname(recovery));
    assertEachClosed(calls, (path) => isTemporaryOf(record, path) || path === recovery || path === dirname(recovery));
    assert.equal(statSync(record).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).quiesced, true);
  });
});

test('a directory a failed write had to make is synced into its parent by the next write', async () => {
  await withFramework(async (framework, _recovery, dir) => {
    const fresh = join(dir, 'fresh');
    const record = join(fresh, 'host-mode.json');
    assert.equal(existsSync(fresh), false);
    await recordingFs(
      () => framework.quiesce({ reason: 'first' }).catch(() => undefined),
      (c) => (c.call === 'fsync' && isTemporaryOf(record, c.path) ? fsError('EIO', 'fsync') : undefined),
    );
    assert.equal(existsSync(fresh), true, 'the failed write made the directory');
    const calls = await recordingFs(() => framework.quiesce({ reason: 'second' }));
    assertSyncedAround(calls, record, fresh);
    assertSyncedAround(calls, record, dir);
  }, { hostModePath: (dir) => join(dir, 'fresh', 'host-mode.json') });
});

test('a write whose directory can\'t be made says the record was left as it was, and tries to remove no temp file', async () => {
  await withFramework(async (framework, _recovery, dir) => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file where the record\'s directory goes');
    const record = join(blocker, 'host-mode.json');
    let error: unknown;
    const calls = await recordingFs(() => framework.quiesce({ reason: 'test' }).catch((e: unknown) => { error = e; }));
    assert.ok(error instanceof Error, String(error));
    const cause = error.cause as NodeJS.ErrnoException;
    assert.ok(typeof cause?.code === 'string', String(cause));
    assert.equal(error.message, `${record} was left as it was: ${cause.message}`);
    assert.equal((error as NodeJS.ErrnoException).code, cause.code);
    assert.ok(
      !calls.some((c) => (c.call === 'open' || c.call === 'unlink') && isTemporaryOf(record, c.path)),
      `no temp file opened or removed: ${JSON.stringify(calls)}`,
    );
  }, { hostModePath: (dir) => join(dir, 'blocker', 'host-mode.json') });
});

test('a host-mode record that can\'t be replaced leaves no temp file behind, and quiesce says the record was left as it was', async () => {
  await withFramework(async (framework, recovery) => {
    const record = join(recovery, 'host-mode.json');
    // A directory where the record goes, so the rename fails.
    mkdirSync(record, { recursive: true });
    let error: unknown;
    const calls = await recordingFs(() => framework.quiesce({ reason: 'test' }).catch((e: unknown) => { error = e; }));
    recordRename(calls, record);
    assert.ok(error instanceof Error, String(error));
    assert.match(error.message, new RegExp(`^${record.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was left as it was: EISDIR`));
    assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
    assert.deepEqual(readdirSync(recovery).filter((name) => name.endsWith('.tmp')), []);
  });
});

test('a quiesce whose temp file can\'t be synced closes it and rejects with the host still serving, the record as it was and no temp file', async () => {
  await withFramework(async (framework, recovery) => {
    const record = join(recovery, 'host-mode.json');
    await framework.quiesce({ reason: 'first' });
    await framework.resume();
    const before = readFileSync(record, 'utf8');
    let error: unknown;
    const calls = await recordingFs(
      () => framework.quiesce({ reason: 'test' }).catch((e: unknown) => { error = e; }),
      (c) => (c.call === 'fsync' && isTemporaryOf(record, c.path) ? fsError('EIO', 'fsync') : undefined),
    );
    assert.ok(error instanceof Error, String(error));
    assert.equal(error.message, `${record} was left as it was: EIO: i/o error, fsync`);
    assert.ok(!calls.some((c) => c.call === 'rename' && c.to === record), `no rename: ${JSON.stringify(calls)}`);
    assertEachClosed(calls, (path) => isTemporaryOf(record, path));
    assert.equal(framework.getHostModeStatus().quiesced, false, 'the host still serving');
    assert.equal(readFileSync(record, 'utf8'), before);
    assert.deepEqual(readdirSync(recovery).filter((name) => name.endsWith('.tmp')), []);
  });
});

test('a temp file that can\'t be removed after a failed write is named in the log', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  await withFramework(async (framework, recovery) => {
    const record = join(recovery, 'host-mode.json');
    let error: unknown;
    const calls = await recordingFs(
      () => framework.quiesce({ reason: 'test' }).catch((e: unknown) => { error = e; }),
      (c) => (isTemporaryOf(record, c.path) && (c.call === 'fsync' || c.call === 'unlink') ? fsError(c.call === 'fsync' ? 'EIO' : 'EACCES', c.call) : undefined),
    );
    assert.ok(error instanceof Error, String(error));
    const unlink = calls.find((c) => c.call === 'unlink' && isTemporaryOf(record, c.path));
    assert.ok(unlink, JSON.stringify(calls));
    assert.ok(logged.some((line) => line.includes(`couldn't remove ${unlink.path} after a failed write`)), logged.join('\n'));
  });
});

test('on win32 the temp file is still synced, and no directory is opened to sync it', async () => {
  await withFramework(async (framework, recovery) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    let calls: FsCall[];
    try {
      calls = await recordingFs(() => framework.quiesce({ reason: 'test' }));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    const rename = recordRename(calls, join(recovery, 'host-mode.json'));
    assert.ok(calls.some((c, i) => i < rename.at && c.call === 'fsync' && c.path === rename.temporary), JSON.stringify(calls));
    assert.ok(
      !calls.some((c) => c.call === 'open' && (c.path === recovery || c.path === dirname(recovery))),
      `neither directory opened: ${JSON.stringify(calls)}`,
    );
  });
});

for (const which of ['directory', 'parent'] as const) {
  test(`a sync of the record's ${which} that fails after the rename leaves the new record in place and raises an ops alert naming it`, async () => {
    await withFramework(async (framework, recovery) => {
      const alerts: Array<{ kind: string; agentName: string; message: string; data?: Record<string, unknown> }> = [];
      (framework as unknown as { opsAlert: unknown }).opsAlert = (kind: string, agentName: string, message: string, opts?: { data?: Record<string, unknown> }) => {
        alerts.push({ kind, agentName, message, data: opts?.data });
      };
      const record = join(recovery, 'host-mode.json');
      const failing = which === 'directory' ? recovery : dirname(recovery);
      await recordingFs(() => framework.quiesce({ reason: 'test' }), (c) => (c.call === 'fsync' && c.path === failing ? fsError('EIO', 'fsync') : undefined));
      assert.equal(JSON.parse(readFileSync(record, 'utf8')).quiesced, true);
      assert.deepEqual(alerts, [{
        kind: 'recovery-sync',
        agentName: 'framework',
        message: `syncing ${failing} failed, so ${record} may not survive a crash: EIO: i/o error, fsync`,
        data: { record, directory: failing, code: 'EIO' },
      }]);
    });
  });
}

for (const code of ['EINVAL', 'EBADF'] as const) {
  test(`directory syncs refused with ${code}, as where the filesystem can't sync a directory, are let go with no ops alert and the new record in place`, async () => {
    await withFramework(async (framework, recovery) => {
      const alerts: unknown[] = [];
      (framework as unknown as { opsAlert: unknown }).opsAlert = (...args: unknown[]) => { alerts.push(args); };
      const record = join(recovery, 'host-mode.json');
      const directories = [recovery, dirname(recovery)];
      const calls = await recordingFs(
        () => framework.quiesce({ reason: 'test' }),
        (c) => (c.call === 'fsync' && directories.includes(c.path!) ? fsError(code, 'fsync') : undefined),
      );
      for (const directory of directories) assertSyncedAround(calls, record, directory);
      assertEachClosed(calls, (path) => path !== undefined && directories.includes(path));
      assert.equal(JSON.parse(readFileSync(record, 'utf8')).quiesced, true);
      assert.deepEqual(alerts, []);
    });
  });
}
