/**
 * The legacy engine's lifetime contract: one owner for every launch, the
 * rule the modern engine keeps.
 * - a configuration it can't use is refused before anything is dialed, and
 *   never turned into a retry stub;
 * - concurrent close() calls share one teardown and its verdict;
 * - a failed launch that can't be reaped is held, never orphaned: connect()
 *   hands its owner to the caller, connectWithReconnect() and the reconnect
 *   loop halt, and close() retries the reap;
 * - a handshake whose stdio pipe failed fails, even when it's answered, so
 *   no connection is adopted that can't write to its child;
 * - close() during a reconnect handshake ends that launch before resolving;
 * - no reconnect launches while the previous child may still be running.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { McplServerConnection, McplUnreapedLaunchError, stderrTailOf } from '../src/mcpl/server-connection.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import { StdioTransport, openTransport, setStdioExitGraceForTests } from '../src/mcpl/transport.js';
import { createServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'legacy-version-server.mjs');
const HOST_CAPS: McplHostCapabilities = { version: '0.5', pushEvents: true };
const LONGER_THAN_ANY_START_MS = 60_000;

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

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + LONGER_THAN_ANY_START_MS;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), `${what}, within ${LONGER_THAN_ANY_START_MS} ms`);
}

function config(mode: string, log: string, extra: Partial<McplServerConfig> = {}): McplServerConfig {
  return { id: 'legacy', command: process.execPath, args: [SERVER, mode, log], ...extra };
}
const RECONNECT = { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 } as const;
const SHORT_GRACE_MS = 50;

/**
 * Launches from the `from`-th on can't be signalled, so their cleanup can't
 * reap them (Olive-1804's pattern in mcp-modern-outcomes). `kill` really ends
 * one, and `unreaped` settles when its transport reports it unreaped; cleanup
 * restores spawning and ends any left.
 */
function unreapableFrom(from: number, graceMs?: number): Array<{ pid: number; kill: () => void; unreaped: Promise<void> }> {
  const realSpawn = StdioTransport.spawn;
  const stuck: Array<{ pid: number; kill: () => void; unreaped: Promise<void> }> = [];
  let launches = 0;
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (c) => {
    const transport = await realSpawn.call(StdioTransport, c);
    if (++launches >= from) {
      const child = (transport as unknown as { child: ChildProcess & { pid: number } }).child;
      const realKill = child.kill.bind(child);
      child.kill = () => true;
      if (graceMs !== undefined) setStdioExitGraceForTests(child, graceMs);
      const unreaped = new Promise<void>((resolve) => { transport.once('unreaped', () => resolve()); });
      stuck.push({ pid: child.pid, kill: () => { realKill('SIGKILL'); }, unreaped });
    }
    return transport;
  };
  cleanups.push(() => {
    (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn;
    for (const s of stuck) s.kill();
  });
  return stuck;
}

/**
 * The first launch from here on, as the transport its spawn yields, and for
 * each line that transport hands over, whether it came in the same callback
 * as the line before it.
 */
function firstLaunch(): { transport: () => StdioTransport | undefined; sameCallback: boolean[] } {
  const realSpawn = StdioTransport.spawn;
  let first: StdioTransport | undefined;
  const sameCallback: boolean[] = [];
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (c) => {
    const transport = await realSpawn.call(StdioTransport, c);
    if (first) return transport;
    first = transport;
    // A callback's lines are handed over with no microtask between them.
    let inCallback = false;
    transport.on('line', () => {
      sameCallback.push(inCallback);
      inCallback = true;
      queueMicrotask(() => { inCallback = false; });
    });
    return transport;
  };
  cleanups.push(() => { (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn; });
  // The launch is ended once its test is over too, so a test that fails
  // before its handshake ends doesn't leave the child running.
  cleanups.push(() => first?.close().catch(() => {}));
  return { transport: () => first, sameCallback };
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
  // A refusal is synchronous with the connect call; 200 ms covers several
  // reconnect intervals (20–40 ms) in which a stub would have dialed.
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
  assert.deepEqual(order.sort(), ['first:gone', 'second:gone']);
});

test('a close that cannot reap fails, and so do concurrent ones; a later close re-checks and settles', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1, SHORT_GRACE_MS);
  const connection = await McplServerConnection.connect(config('ok', log), HOST_CAPS);
  connection.ready();
  const settled: string[] = [];
  const outcome = (name: string) => [() => settled.push(`${name}:ok`), (e: Error) => settled.push(`${name}:${e.message}`)] as const;
  const first = connection.close().then(...outcome('first'));
  const second = connection.close().then(...outcome('second'));
  // The teardown sends SIGTERM, waits the grace, sends SIGKILL and waits the
  // grace again before it gives up, so at half the grace it is still pending.
  await new Promise((r) => setTimeout(r, SHORT_GRACE_MS / 2));
  assert.deepEqual(settled, [], 'neither resolves while the teardown is pending');
  await Promise.all([first, second]);
  assert.equal(settled.length, 2);
  assert.match(settled[0]!, /^first:stdio child \d+ of MCP server "legacy" did not exit within \d+ms of SIGKILL; it could not be reaped/);
  assert.match(settled[1]!, /^second:.*could not be reaped/, 'the second shares the attempt and its verdict, rather than claiming success');
  await killAndWait(stuck[0]!);
  await connection.close();
});

test('a failed connect that cannot be reaped hands its owner to the caller, who can retry the reap', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1, SHORT_GRACE_MS);
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

test("a handshake answered after its stdio pipe failed fails, holding a child that outlived SIGKILL, rather than adopting a connection that can't write to it", async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1, SHORT_GRACE_MS);
  const connecting = McplServerConnection.connect(config('deaf-ping', log), HOST_CAPS).then(() => null, (e: unknown) => e);
  // The server closed its stdin and pinged this host, whose answer met EPIPE.
  // The reap gives up on the child while the handshake still waits, with
  // nothing listening for that yet; only then does the server answer.
  await until(() => stuck.length === 1, 'the launch');
  await stuck[0]!.unreaped;
  process.kill(stuck[0]!.pid, 'SIGUSR2');
  const error = await connecting;
  assert.ok(error instanceof McplUnreapedLaunchError, String(error));
  assert.match(error.message, /^MCPL server "legacy": this host stopped using the server's stdio during the handshake \(write EPIPE\); its cleanup also failed: stdio child \d+ of MCP server "legacy" did not exit within \d+ms of SIGKILL; it could not be reaped$/);
  const owner = error.connection;
  assert.equal(owner.isConnected, false);
  assert.equal(owner.willReconnect, false);
  await assert.rejects(owner.close(), /could not be reaped/, 'still running: the reap fails again');
  await killAndWait(stuck[0]!);
  await owner.close();
});

test('a handshake fails when its answer is read in the same callback as a ping whose answer met EPIPE, and its cleanup reaps the child', async () => {
  const log = scratchLog();
  const launch = firstLaunch();
  const connecting = McplServerConnection.connect(config('deaf-ping-answered', log), HOST_CAPS).then(() => null, (e: unknown) => e);
  // The server has closed its stdin and said so on stderr, and that line is
  // in this host's stderr tail. Only then does it write a ping and its answer
  // together, so this host reads both in one callback: its answer to the ping
  // meets EPIPE, which is reported only once that callback has returned.
  await until(() => /deaf-ping: stdin closed/.test(launch.transport()?.stderrTail ?? ''), "the server's stderr line");
  const [pid] = starts(log);
  process.kill(pid!, 'SIGUSR2');
  const error = await connecting;
  assert.deepEqual(launch.sameCallback, [false, true], 'the ping and the answer were read in one callback');
  assert.ok(error instanceof Error && !(error instanceof McplUnreapedLaunchError), String(error));
  assert.match(String(error), /^Error: MCPL server "legacy": this host stopped using the server's stdio during the handshake \(write EPIPE\)$/);
  assert.match(stderrTailOf(error) ?? '', /deaf-ping: stdin closed/, "the server's stderr goes with it, as with the handshake's other failures");
  assert.equal(alive(pid!), false, "gone once the connect failed: the handshake's cleanup reaped it");
});

test('with reconnect too, a failed first launch that cannot be reaped throws, handing over its owner, as without', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1, SHORT_GRACE_MS);
  const error = await McplServerConnection.connectWithReconnect(config('error', log, RECONNECT), HOST_CAPS).then(() => null, (e: unknown) => e);
  // No stub: no retry starts beside a child that may still be running.
  assert.ok(error instanceof McplUnreapedLaunchError, String(error));
  assert.match(error.message, /initialize failed on purpose; its cleanup also failed: .*could not be reaped/);
  const owner = error.connection;
  cleanups.push(() => owner.close().catch(() => {}));
  assert.equal(owner.willReconnect, false);
  await assert.rejects(owner.close(), /could not be reaped/, 'still running: the reap fails again');
  await killAndWait(stuck[0]!);
  await owner.close();
  assert.equal(starts(log).length, 1, 'no launch beside the unreaped one');
});

test('a reconnect launch that cannot be reaped halts reconnecting; close() settles it once it has exited', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(2, SHORT_GRACE_MS);
  const connection = await McplServerConnection.connectWithReconnect(config('ok-then-error', log, RECONNECT), HOST_CAPS);
  cleanups.push(() => connection.close().catch(() => {}));
  connection.ready();
  const failures: Array<{ error: string; attempt: number; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (f) => failures.push(f));
  await assert.rejects(connection.sendToolsCall('die', {}));
  await until(() => failures.some((f) => f.permanent), 'a permanent reconnect failure');
  assert.match(failures.find((f) => f.permanent)!.error, /initialize failed on purpose; the previous launch could not be reaped .*reconnecting is halted/);
  assert.equal(connection.willReconnect, false);
  // 300 ms is several reconnect intervals (20–40 ms): a retry would have launched.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(starts(log).length, 2, 'no third launch while the second is unreaped');
  await assert.rejects(connection.close(), /could not be reaped/);
  await killAndWait(stuck[0]!);
  await connection.close();
});

test("a reconnect stub held as unreaped before its first ready() still delivers its connect-failed and its permanent failure there", async () => {
  const log = scratchLog();
  // The first launch fails its handshake and is reaped, so a stub reconnects;
  // the second fails too, and its cleanup can't reap it.
  const stuck = unreapableFrom(2, SHORT_GRACE_MS);
  const connection = await McplServerConnection.connectWithReconnect(config('error', log, RECONNECT), HOST_CAPS);
  cleanups.push(() => connection.close().catch(() => {}));
  const reports: Array<{ event: string; attempt: number; permanent?: boolean }> = [];
  connection.on('connect-failed', (f: { attempt: number }) => reports.push({ event: 'connect-failed', ...f }));
  connection.on('reconnect-failed', (f: { attempt: number; permanent?: boolean }) => reports.push({ event: 'reconnect-failed', ...f }));
  await until(() => connection.holdsUnreapedChild, 'the reconnect launch held');
  assert.equal(connection.willReconnect, false);
  assert.equal(reports.length, 0, 'held until the first release');
  connection.ready();
  assert.deepEqual(
    reports.map((r) => [r.event, r.event === 'connect-failed' ? r.attempt : r.permanent === true]),
    [['connect-failed', 0], ['reconnect-failed', true]],
  );
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
  await until(() => starts(log).length === 2, 'the reconnect launch has started (its start line)');
  const second = starts(log)[1]!;
  const began = Date.now();
  await connection.close();
  // A generous bound, well below the 30 s handshake timeout it rules out.
  assert.ok(Date.now() - began < 20_000, 'promptly: the handshake was ended, not waited out (30 s)');
  assert.equal(alive(second), false, 'the launch in flight was reaped before close() resolved');
  assert.equal(reconnected, false);
  assert.equal(connection.isConnected, false);
  // Several reconnect intervals (20–40 ms) later, still nothing.
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
  await until(() => starts(log).length === 2, 'the reconnect launch has started (its start line)');
  await connection.reconnectAfterFailure();
  // Several reconnect intervals (20–40 ms) later, still only the one in flight.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(starts(log).length, 2, 'no second attempt beside the one in flight');
  const began = Date.now();
  await connection.close();
  assert.ok(Date.now() - began < 20_000, 'promptly: well before the 30 s handshake timeout');
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

test('registry: an id stays held through its reap, and a second add is refused while one is connecting', async () => {
  const log = scratchLog();
  const registry = new McplServerRegistry();
  // A child that ignores SIGTERM keeps its reap going for about 2 s.
  const removing = (async () => {
    await registry.addServer(config('ok', log, { env: { IGNORE_SIGTERM: '1' } }), HOST_CAPS);
    return registry.removeServer('legacy');
  })();
  await until(() => registry.getServer('legacy') !== null, 'registered');
  await until(() => starts(log).length === 1, 'launched');
  await until(() => existsSync(`${log}.sigterm`), 'the reap to begin');
  await assert.rejects(registry.addServer(config('ok', log), HOST_CAPS), /already registered/, 'held while its reap runs');
  await removing;
  assert.equal(registry.getServer('legacy'), null, 'freed once the exit is confirmed');
  assert.equal(starts(log).length, 1, 'nothing launched beside it');

  // Two adds at once: the second is refused while the first is connecting.
  const slow = registry.addServer(config('slow', log, { env: { SLOW_INIT_MS: '300' } }), HOST_CAPS);
  await assert.rejects(registry.addServer(config('ok', log), HOST_CAPS), /already registered/);
  await slow;
  await registry.removeServer('legacy');
});

test('registry: a connection whose reap fails stays registered, through close() and closeAll(), until a retry confirms the exit', async () => {
  const log = scratchLog();
  const registry = new McplServerRegistry();
  const stuck = unreapableFrom(1, SHORT_GRACE_MS);
  const connection = await registry.addServer(config('ok', log), HOST_CAPS);
  // Its own close() can't reap: the registry keeps it, holding the id.
  await assert.rejects(connection.close(), /could not be reaped/);
  assert.equal(registry.getServer('legacy'), connection, 'still registered after its own close');
  // closeAll() reports it, and keeps it.
  await assert.rejects(registry.closeAll(), /could not be reaped/);
  assert.equal(registry.getServer('legacy'), connection, 'still registered after closeAll');
  await assert.rejects(registry.addServer(config('ok', log), HOST_CAPS), /already registered/);
  // removeServer retries the reap; once the child is gone it succeeds.
  await assert.rejects(registry.removeServer('legacy'), /could not be reaped/);
  assert.equal(registry.getServer('legacy'), connection);
  await killAndWait(stuck[0]!);
  await registry.removeServer('legacy');
  assert.equal(registry.getServer('legacy'), null);
});

test('registry: closeAll closes every connection, removes the ones it reaped, and keeps and reports the one it could not', async () => {
  const log = scratchLog();
  const registry = new McplServerRegistry();
  const stuck = unreapableFrom(2, SHORT_GRACE_MS);
  const fine = await registry.addServer({ ...config('ok', log), id: 'fine' }, HOST_CAPS);
  const held = await registry.addServer({ ...config('ok', log), id: 'held' }, HOST_CAPS);
  await assert.rejects(registry.closeAll(), /could not be reaped/);
  assert.equal(registry.getServer('fine'), null, 'the one it reaped is removed');
  assert.equal(fine.isConnected, false);
  assert.equal(registry.getServer('held'), held, 'the one it could not reap stays');
  await killAndWait(stuck[0]!);
  await registry.removeServer('held');
});

test('a reconnect whose previous child cannot be reaped holds it and halts reconnecting', async () => {
  const log = scratchLog();
  const stuck = unreapableFrom(1, SHORT_GRACE_MS);
  const connection = await McplServerConnection.connectWithReconnect(config('ok', log, RECONNECT), HOST_CAPS);
  cleanups.push(() => connection.close().catch(() => {}));
  connection.ready();
  const failures: Array<{ error: string; attempt: number; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (f) => failures.push(f));
  // Recycle it as the framework does: the host closes the transport, whose
  // child can't be reaped, and the loop then finds that child still held.
  await connection.reconnectAfterFailure().catch(() => {});
  await until(() => failures.some((f) => f.permanent), 'a permanent reconnect failure');
  assert.match(failures.find((f) => f.permanent)!.error, /could not be reaped/);
  assert.equal(connection.willReconnect, false);
  // Several reconnect intervals (20–40 ms) later, nothing launched beside it.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(starts(log).length, 1);
  await killAndWait(stuck[0]!);
  await connection.close();
});

test('a WebSocket dial whose connection is closed meanwhile ends at once, not at the open timeout', async () => {
  // A listener that accepts and never answers the upgrade.
  const sockets: Socket[] = [];
  const server = createServer((socket) => { sockets.push(socket); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/mcpl`;
  const abort = new AbortController();
  const began = Date.now();
  const dial = openTransport({ id: 'ws', url }, abort.signal);
  await until(() => sockets.length === 1, 'the dial reached the listener');
  abort.abort();
  await assert.rejects(dial, /WebSocket connect abandoned: the connection was closed/);
  assert.ok(Date.now() - began < 5_000, 'well before the 15 s open timeout');
});

test("a write to a stdio child that has just exited is never thrown, and isn't reported as an error: the exit's close names it", (t) => {
  const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stderr: new EventEmitter(), killed: false, exitCode: null });
  const rl = new EventEmitter();
  const transport = new (StdioTransport as unknown as new (c: unknown, r: unknown, id: string) => StdioTransport)(child, rl, 'legacy');
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  assert.doesNotThrow(() => child.stdin.emit('error', epipe), 'with nothing listening');
  const reported: unknown[] = [];
  transport.on('error', (error) => reported.push(error));
  child.stdin.emit('error', epipe);
  assert.deepEqual(reported, [], "the stdin carries the protocol, so the exit's close reports it");
  const closed: Array<{ reason?: string }> = [];
  transport.on('close', (info: { reason?: string }) => closed.push(info));
  child.emit('exit', 0, null);
  assert.match(closed[0]?.reason ?? '', /this host had stopped using the server's stdio \(write EPIPE\)/);
});

test('close() during a WebSocket reconnect dial returns promptly, ending the dial', async () => {
  // The first upgrade gets a minimal MCPL server; every later one hangs, so
  // the reconnect's dial would wait out its 15 s open timeout.
  const http = createHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  const hung: Socket[] = [];
  let upgrades = 0;
  http.on('upgrade', (request, socket, head) => {
    if (++upgrades === 1) wss.handleUpgrade(request, socket as Socket, head, (ws) => wss.emit('connection', ws, request));
    else hung.push(socket as Socket);
  });
  let first: import('ws').WebSocket | undefined;
  wss.on('connection', (ws) => {
    first = ws;
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as { id?: number; method?: string };
      if (message.id === undefined) return;
      const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {} } : {};
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { for (const s of hung) s.destroy(); wss.close(); http.close(() => r()); }));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/mcpl`;

  const connection = await McplServerConnection.connectWithReconnect({ id: 'ws', url, ...RECONNECT }, HOST_CAPS);
  connection.ready();
  first!.close();
  await until(() => upgrades === 2, 'the reconnect is dialing');
  const began = Date.now();
  await connection.close();
  assert.ok(Date.now() - began < 5_000, 'promptly: the dial was ended, not waited out (15 s)');
  assert.equal(connection.isConnected, false);
});
