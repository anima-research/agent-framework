/**
 * The legacy engine's lifetime contract (room-293, greptile's review of
 * PR #262): one owner for every launch, the rule the modern engine keeps.
 * - a configuration it can't use is refused before anything is dialed, and
 *   never turned into a retry stub;
 * - concurrent close() calls share one teardown and its verdict;
 * - a failed launch that can't be reaped is held, never orphaned: connect()
 *   hands its owner to the caller, connectWithReconnect() and the reconnect
 *   loop halt, and close() retries the reap;
 * - close() during a reconnect handshake ends that launch before resolving;
 * - no reconnect launches while the previous child may still be running.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { McplServerConnection, McplUnreapedLaunchError } from '../src/mcpl/server-connection.js';
import { StdioTransport } from '../src/mcpl/transport.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'legacy-version-server.mjs');
const HOST_CAPS: McplHostCapabilities = { version: '0.5', pushEvents: true };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function scratchLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-lifetime-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'starts.log');
}

/** The pid of each launch, in order. */
const starts = (log: string): number[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => Number(l.split(' ')[1])) : [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), `in time: ${what}`);
}

function config(mode: string, log: string, extra: Partial<McplServerConfig> = {}): McplServerConfig {
  return { id: 'legacy', command: process.execPath, args: [SERVER, mode, log], ...extra };
}
const RECONNECT = { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 } as const;

/**
 * Launches from the `from`-th on can't be signalled, so their cleanup can't
 * reap them (Olive-1804's pattern in mcp-modern-outcomes). `kill` really ends
 * one; cleanup restores spawning and ends any left.
 */
function unreapableFrom(from: number): Array<{ pid: number; kill: () => void }> {
  const realSpawn = StdioTransport.spawn;
  const stuck: Array<{ pid: number; kill: () => void }> = [];
  let launches = 0;
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = (c) => {
    const transport = realSpawn.call(StdioTransport, c);
    if (++launches >= from) {
      const child = (transport as unknown as { child: { pid: number; kill: (signal?: string) => boolean } }).child;
      const realKill = child.kill.bind(child);
      child.kill = () => true;
      stuck.push({ pid: child.pid, kill: () => { realKill('SIGKILL'); } });
    }
    return transport;
  };
  cleanups.push(() => {
    (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn;
    for (const s of stuck) s.kill();
  });
  return stuck;
}

async function killAndWait(stuck: { pid: number; kill: () => void }): Promise<void> {
  stuck.kill();
  await until(() => !alive(stuck.pid), `child ${stuck.pid} gone`);
}

test('a configuration the engine cannot use is refused before anything is dialed, and never retried', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
  let dials = 0;
  wss.on('connection', (socket) => { dials++; socket.close(); });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/mcpl`;

  const modernOnWs = { id: 'ws', url, protocol: 'modern' as const };
  await assert.rejects(McplServerConnection.connect(modernOnWs, HOST_CAPS), /"protocol" applies only to stdio/);
  // With reconnect too: a configuration error is thrown, not turned into a
  // stub that retries it forever.
  await assert.rejects(McplServerConnection.connectWithReconnect({ ...modernOnWs, ...RECONNECT }, HOST_CAPS), /"protocol" applies only to stdio/);
  await assert.rejects(
    McplServerConnection.connectWithReconnect({ id: 'ftp', url: 'ftp://127.0.0.1/x', ...RECONNECT }, HOST_CAPS),
    /url must be ws:\/\/ or wss:\/\//,
  );
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(dials, 0, 'nothing was dialed');
});

test('concurrent close() calls share the teardown: none resolves while the child still runs', async () => {
  const log = scratchLog();
  const connection = await McplServerConnection.connect(config('ok', log, { env: { IGNORE_SIGTERM: '1' } }), HOST_CAPS);
  connection.ready();
  const [pid] = starts(log);
  const order: string[] = [];
  const first = connection.close().then(() => order.push(`first:${alive(pid!) ? 'alive' : 'gone'}`));
  const second = connection.close().then(() => order.push(`second:${alive(pid!) ? 'alive' : 'gone'}`));
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:gone', 'second:gone']);
});

test('a close that cannot reap fails, and so do concurrent ones; a later close re-checks and settles', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1);
  const connection = await McplServerConnection.connect(config('ok', log), HOST_CAPS);
  connection.ready();
  const settled: string[] = [];
  const outcome = (name: string) => [() => settled.push(`${name}:ok`), (e: Error) => settled.push(`${name}:${e.message}`)] as const;
  const first = connection.close().then(...outcome('first'));
  const second = connection.close().then(...outcome('second'));
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(settled, [], 'neither resolves while the teardown is pending');
  await Promise.all([first, second]);
  assert.equal(settled.length, 2);
  assert.match(settled[0]!, /^first:MCPL server "legacy" did not close cleanly: .*could not be reaped/);
  assert.match(settled[1]!, /^second:.*could not be reaped/, 'the second re-checked, rather than claiming success');
  await killAndWait(stuck[0]!);
  await connection.close();
});

test('a failed connect that cannot be reaped hands its owner to the caller, who can retry the reap', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1);
  const error = await McplServerConnection.connect(config('error', log), HOST_CAPS).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof McplUnreapedLaunchError, String(error));
  assert.match(error.message, /initialize failed on purpose; its cleanup also failed: .*could not be reaped/);
  assert.match((error.cause as Error).message, /initialize failed on purpose/);
  const owner = error.connection;
  assert.equal(owner.isConnected, false);
  assert.equal(owner.willReconnect, false);
  await assert.rejects(owner.close(), /could not be reaped/, 'still running: the reap fails again');
  await killAndWait(stuck[0]!);
  await owner.close();
});

test('with reconnect, a failed first launch that cannot be reaped halts instead of retrying', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1);
  const connection = await McplServerConnection.connectWithReconnect(config('error', log, RECONNECT), HOST_CAPS);
  cleanups.push(() => connection.close().catch(() => {}));
  const failures: Array<{ error: string; attempt: number; permanent?: boolean }> = [];
  connection.on('connect-failed', (f) => failures.push(f));
  connection.ready();
  await until(() => failures.length > 0, 'the connect-failed event');
  assert.equal(failures[0]!.permanent, true);
  assert.match(failures[0]!.error, /initialize failed on purpose; the previous launch could not be reaped .*reconnecting is halted/);
  assert.equal(connection.willReconnect, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(starts(log).length, 1, 'no launch beside the unreaped one');
  await killAndWait(stuck[0]!);
  await connection.close();
});

test('a reconnect launch that cannot be reaped halts reconnecting; close() settles it once it has exited', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(2);
  const connection = await McplServerConnection.connectWithReconnect(config('ok-then-error', log, RECONNECT), HOST_CAPS);
  cleanups.push(() => connection.close().catch(() => {}));
  connection.ready();
  const failures: Array<{ error: string; attempt: number; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (f) => failures.push(f));
  await assert.rejects(connection.sendToolsCall('die', {}));
  await until(() => failures.some((f) => f.permanent), 'a permanent reconnect failure');
  assert.match(failures.find((f) => f.permanent)!.error, /initialize failed on purpose; the previous launch could not be reaped .*reconnecting is halted/);
  assert.equal(connection.willReconnect, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(starts(log).length, 2, 'no third launch while the second is unreaped');
  await assert.rejects(connection.close(), /could not be reaped/);
  await killAndWait(stuck[0]!);
  await connection.close();
});

test('close() during a reconnect handshake ends that launch before resolving, and nothing is adopted', async () => {
  const log = scratchLog();
  const connection = await McplServerConnection.connectWithReconnect(config('ok-then-hang', log, RECONNECT), HOST_CAPS);
  connection.ready();
  let reconnected = false;
  connection.on('reconnect', () => { reconnected = true; });
  await assert.rejects(connection.sendToolsCall('die', {}));
  await until(() => starts(log).length === 2, 'the reconnect launch, waiting on initialize');
  const second = starts(log)[1]!;
  const began = Date.now();
  await connection.close();
  assert.ok(Date.now() - began < 5_000, 'promptly: the handshake was ended, not waited out (30 s)');
  assert.equal(alive(second), false, 'the launch in flight was reaped before close() resolved');
  assert.equal(reconnected, false);
  assert.equal(connection.isConnected, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(starts(log).length, 2, 'and no later launch');
});

test('a recycle during a reconnect in flight starts no second attempt, and close() still ends the one in flight', async () => {
  // Iris-1827's interleaving (room-293 #55410): before, the recycle's attempt
  // took close()'s ownership of the first, which outlived a successful close.
  const log = scratchLog();
  const connection = await McplServerConnection.connectWithReconnect(config('ok-then-hang', log, RECONNECT), HOST_CAPS);
  connection.ready();
  await assert.rejects(connection.sendToolsCall('die', {}));
  await until(() => starts(log).length === 2, 'the reconnect launch, waiting on initialize');
  await connection.reconnectAfterFailure();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(starts(log).length, 2, 'no second attempt beside the one in flight');
  const began = Date.now();
  await connection.close();
  assert.ok(Date.now() - began < 5_000, 'promptly');
  assert.deepEqual(starts(log).filter(alive), [], 'every launch reaped when close() resolved');
});

test('a reconnect never launches while the previous child may still be running', async () => {
  const log = scratchLog();
  const connection = await McplServerConnection.connectWithReconnect(
    config('ok', log, { ...RECONNECT, env: { IGNORE_SIGTERM: '1' } }),
    HOST_CAPS,
  );
  cleanups.push(() => connection.close().catch(() => {}));
  connection.ready();
  const [first] = starts(log);
  let reconnected = false;
  connection.on('reconnect', () => { reconnected = true; });
  // Recycle it as the framework does after an awareness failure: the host
  // closes the transport itself, and the child ignores SIGTERM for 2 s.
  const recycled = connection.reconnectAfterFailure();
  await until(() => starts(log).length === 2, 'the next launch');
  assert.equal(alive(first!), false, 'it started only once the first child was gone');
  await recycled;
  await until(() => reconnected, 'reconnected');
});
