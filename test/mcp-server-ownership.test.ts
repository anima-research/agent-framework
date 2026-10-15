/**
 * One owner per MCP server id across both engines: from a connect's
 * admission until its teardown is done, exactly one owner holds an id.
 * - a connect is refused while a connect or disconnect for the id is in
 *   flight, a legacy handshake included;
 * - a disconnect waits for what held the id before it, so nothing it removes
 *   belongs to a later connection, and each release frees only its own claim;
 * - a teardown that can't confirm a child exited isn't finished: the server
 *   stays registered, closed, a connect is refused, and a retried disconnect
 *   completes once the exit is confirmed.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentFramework, ModernMcpConnection, McplUnreapedLaunchError, ShutdownTimeoutError } from '../src/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { StdioTransport } from '../src/mcpl/transport.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, 'fixtures', 'modern-raw-server.mjs');
const LEGACY = join(here, 'fixtures', 'legacy-version-server.mjs');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
/** Launch pids from a raw modern server's JSONL log, or a legacy start log. */
const launches = (file: string): number[] => lines(file).flatMap((l) => {
  if (l.startsWith('start ')) return [Number(l.slice('start '.length))];
  const entry = JSON.parse(l) as { event?: string; pid?: number };
  return entry.event === 'start' ? [entry.pid!] : [];
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), `in time: ${what}`);
}

async function withFramework(fn: (h: { framework: AgentFramework; dir: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  try {
    await fn({ framework, dir });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const modern = (id: string, flags: string, log: string): McplServerConfig =>
  ({ id, command: process.execPath, args: [RAW, flags, log], protocol: 'modern' });
const legacy = (id: string, mode: string, log: string, env: Record<string, string> = {}): McplServerConfig =>
  ({ id, command: process.execPath, args: [LEGACY, mode, log], env });
const status = (framework: AgentFramework, id: string) => framework.listMcplServers().find((s) => s.id === id);
const toolsOf = (framework: AgentFramework, id: string) => framework.getAllTools().map((t) => t.name).filter((n) => n.startsWith(`mcpl--${id}--`));
const call = (name: string) => ({ id: `t-${Math.random()}`, name, input: {} });

/**
 * Stdio launches can't be signalled while `stuck.active` is set, so their
 * cleanup can't reap them; `kill` really ends one (Olive-1804's pattern).
 */
function unreapable(): { active: boolean; stuck: Array<{ pid: number; kill: () => void }> } {
  const realSpawn = StdioTransport.spawn;
  const state = { active: true, stuck: [] as Array<{ pid: number; kill: () => void }> };
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = (c) => {
    const transport = realSpawn.call(StdioTransport, c);
    if (state.active) {
      const child = (transport as unknown as { child: { pid: number; kill: (signal?: string) => boolean } }).child;
      const realKill = child.kill.bind(child);
      child.kill = () => true;
      state.stuck.push({ pid: child.pid, kill: () => { realKill('SIGKILL'); } });
    }
    return transport;
  };
  cleanups.push(() => {
    (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn;
    for (const s of state.stuck) s.kill();
  });
  return state;
}

async function killAndWait(stuck: { pid: number; kill: () => void }): Promise<void> {
  stuck.kill();
  await until(() => !alive(stuck.pid), `child ${stuck.pid} gone`);
}

test('a connect during a disconnect is refused; once the teardown is done, the new server is listed and routed', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    // A child that ignores SIGTERM keeps the teardown in flight for ~2 s.
    const config = modern('m', 'ignore-sigterm', log);
    await framework.connectMcplServer(config);
    const disconnecting = framework.disconnectMcplServer('m');
    await assert.rejects(framework.connectMcplServer(config), /MCP server "m" is still being disconnected/);
    assert.equal(launches(log).length, 1, 'nothing launched beside the closing child');
    await disconnecting;
    assert.equal(status(framework, 'm'), undefined);

    await framework.connectMcplServer(config);
    assert.equal(status(framework, 'm')?.connected, true, 'listed: its routing was not erased');
    assert.ok(toolsOf(framework, 'm').includes('mcpl--m--plain'));
    assert.deepEqual((await framework.executeToolCall(call('mcpl--m--plain'))).data, [{ type: 'text', text: 'plain' }]);
  });
});

test('two simultaneous disconnects both settle, in order, and leave the id free', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    const config = modern('m', 'ignore-sigterm', log);
    await framework.connectMcplServer(config);
    const order: string[] = [];
    const first = framework.disconnectMcplServer('m').then(() => order.push('first'));
    const second = framework.disconnectMcplServer('m').then(() => order.push('second'));
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(status(framework, 'm'), undefined);
    assert.equal(alive(launches(log)[0]!), false);
    await framework.connectMcplServer(config);
    assert.equal(status(framework, 'm')?.connected, true);
  });
});

test('a hold releases only its own claim: a disconnect queued behind another still holds the id', async () => {
  await withFramework(async ({ framework, dir }) => {
    const hold = (framework as unknown as {
      holdMcpServerId: (id: string, kind: 'connect' | 'disconnect') => { previous: Promise<void> | undefined; release: () => void };
    }).holdMcpServerId.bind(framework);
    const first = hold('x', 'disconnect');
    const second = hold('x', 'disconnect');
    assert.equal(first.previous, undefined);
    let secondMayRun = false;
    void second.previous!.then(() => { secondMayRun = true; });
    first.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(secondMayRun, true, 'the second runs once the first has settled');
    const config = modern('x', '', join(dir, 'raw.jsonl'));
    await assert.rejects(framework.connectMcplServer(config), /"x" is still being disconnected/, 'the first release left the second claim');
    second.release();
    await framework.connectMcplServer(config);
    assert.equal(status(framework, 'x')?.connected, true);
  });
});

test('a modern connect is refused while a legacy connect for the same id is still handshaking', async () => {
  await withFramework(async ({ framework, dir }) => {
    const legacyLog = join(dir, 'legacy.log');
    const modernLog = join(dir, 'raw.jsonl');
    const pending = framework.connectMcplServer(legacy('same', 'slow', legacyLog, { SLOW_INIT_MS: '800' }));
    await until(() => launches(legacyLog).length === 1, 'the legacy launch, handshaking');
    await assert.rejects(framework.connectMcplServer(modern('same', '', modernLog)), /MCPL server "same" is already registered/);
    assert.equal(launches(modernLog).length, 0, 'the modern server was never launched');
    await pending;
    const served = status(framework, 'same')!;
    assert.equal(served.family, 'legacy');
    assert.equal(served.connected, true);
    assert.deepEqual((await framework.executeToolCall(call('mcpl--same--a1'))).data, [{ type: 'text', text: 'ok' }], 'its tools reach the legacy server');
  });
});

test('a disconnect during a legacy handshake ends that connect at once, and removes it whole', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'legacy.log');
    const pending = framework.connectMcplServer(legacy('same', 'slow', log, { SLOW_INIT_MS: '600' }));
    await until(() => launches(log).length === 1, 'the legacy launch, handshaking');
    const disconnecting = framework.disconnectMcplServer('same');
    await assert.rejects(framework.connectMcplServer(legacy('same', 'ok', log)), /"same" is still being disconnected/);
    await assert.rejects(pending, /MCP server "same" was not connected: it was disconnected while connecting/);
    await disconnecting;
    assert.equal(status(framework, 'same'), undefined);
    assert.deepEqual(toolsOf(framework, 'same'), []);
    assert.equal(alive(launches(log)[0]!), false, 'its child was reaped');
    assert.equal(launches(log).length, 1, 'and nothing else launched');
  });
});

test('a disconnect during a modern connect ends it at once', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    const pending = framework.connectMcplServer(modern('m', 'hang-discover', log));
    await until(() => lines(log).some((l) => l.includes('server/discover')), 'the launch waiting on discover');
    const began = Date.now();
    await framework.disconnectMcplServer('m');
    await assert.rejects(pending, /MCP server "m" was not connected: it was disconnected while connecting/);
    // A generous bound, well below the 30 s connect timeout it rules out.
    assert.ok(Date.now() - began < 20_000, 'not after the 30 s connect timeout');
    assert.equal(status(framework, 'm'), undefined);
    assert.equal(alive(launches(log)[0]!), false, 'its child was reaped');
  });
});

test('modern: a disconnect that cannot reap keeps the server registered; a connect is refused until a retried disconnect confirms the exit', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    const config = modern('m', '', log);
    const reaping = unreapable();
    await framework.connectMcplServer(config);
    await assert.rejects(
      framework.disconnectMcplServer('m'),
      /could not be reaped\. MCP server "m" stays registered, closed, until its exit is confirmed: disconnect it again to retry the reap/,
    );
    assert.equal(status(framework, 'm')?.connected, false, 'still listed, closed');
    await assert.rejects(framework.connectMcplServer(config), /"m" is already registered \(not connected and not reconnecting: disconnect it first\)/);
    assert.equal(launches(log).length, 1, 'no launch beside the unreaped child');

    await killAndWait(reaping.stuck[0]!);
    reaping.active = false;
    await framework.disconnectMcplServer('m');
    assert.equal(status(framework, 'm'), undefined, 'the retried disconnect completed');
    await framework.connectMcplServer(config);
    assert.equal(status(framework, 'm')?.connected, true, 'the id is free');
  });
});

test('legacy: a disconnect that cannot reap keeps the server registered; a connect is refused until a retried disconnect confirms the exit', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'legacy.log');
    const config = legacy('l', 'ok', log);
    const reaping = unreapable();
    await framework.connectMcplServer(config);
    await assert.rejects(
      framework.disconnectMcplServer('l'),
      /could not be reaped\. MCP server "l" stays registered, closed, until its exit is confirmed: disconnect it again to retry the reap/,
    );
    assert.equal(status(framework, 'l')?.connected, false, 'still listed, closed');
    await assert.rejects(framework.connectMcplServer(config), /"l" is already registered \(not connected and not reconnecting: disconnect it first\)/);
    assert.equal(launches(log).length, 1, 'no launch beside the unreaped child');

    await killAndWait(reaping.stuck[0]!);
    reaping.active = false;
    await framework.disconnectMcplServer('l');
    assert.equal(status(framework, 'l'), undefined, 'the retried disconnect completed');
    await framework.connectMcplServer(config);
    assert.equal(status(framework, 'l')?.connected, true, 'the id is free');
  });
});

test('modern: a failed connect whose cleanup cannot reap stays registered until a disconnect confirms the exit', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    const reaping = unreapable();
    // The SDK reports a refused server/discover as a failed version negotiation.
    await assert.rejects(
      framework.connectMcplServer(modern('m', 'reject-discover', log)),
      /server\/discover .*; its cleanup also failed: .*could not be reaped\. MCP server "m" stays registered, closed, until its exit is confirmed: disconnect it to retry the reap/,
    );
    await assert.rejects(framework.connectMcplServer(modern('m', '', log)), /"m" is already registered \(not connected and not reconnecting/);
    assert.equal(launches(log).length, 1);

    await killAndWait(reaping.stuck[0]!);
    reaping.active = false;
    await framework.disconnectMcplServer('m');
    await framework.connectMcplServer(modern('m', '', log));
    assert.equal(status(framework, 'm')?.connected, true);
  });
});

test("modern: ModernMcpConnection.connect hands back the connection that owns a launch its cleanup couldn't reap", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'raw.jsonl');
  const reaping = unreapable();
  const failed = await ModernMcpConnection.connect(modern('m', 'reject-discover', log)).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failed instanceof McplUnreapedLaunchError, String(failed));
  assert.ok(failed.connection instanceof ModernMcpConnection, 'the owner of the launch');
  assert.match(failed.message, /its cleanup also failed: .*could not be reaped/);
  assert.equal(launches(log).length, 1);
  await killAndWait(reaping.stuck[0]!);
  reaping.active = false;
  // Its close() retries the reap, and resolves once the exit is confirmed.
  await failed.connection.close();
});

test('legacy: a failed connect whose cleanup cannot reap stays registered until a disconnect confirms the exit', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'legacy.log');
    const reaping = unreapable();
    await assert.rejects(
      framework.connectMcplServer(legacy('l', 'error', log)),
      /initialize failed on purpose; its cleanup also failed: .*could not be reaped\. MCP server "l" stays registered, closed, until its exit is confirmed: disconnect it to retry the reap/,
    );
    await assert.rejects(framework.connectMcplServer(legacy('l', 'ok', log)), /"l" is already registered \(not connected and not reconnecting/);
    assert.equal(launches(log).length, 1);

    await killAndWait(reaping.stuck[0]!);
    reaping.active = false;
    await framework.disconnectMcplServer('l');
    await framework.connectMcplServer(legacy('l', 'ok', log));
    assert.equal(status(framework, 'l')?.connected, true);
  });
});

test('stop() closes every connection, keeps the ones it cannot reap registered, and rejects with each failure; once they have exited, a retry completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const reaping = unreapable();
  await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
  await framework.connectMcplServer(legacy('l', 'ok', join(dir, 'legacy.log')));
  await assert.rejects(framework.stop(), (error) => {
    assert.ok(error instanceof AggregateError, String(error));
    assert.equal(error.errors.length, 2, 'one failure from each engine');
    assert.match(error.message, /stdio child \d+ of MCP server "m" did not exit within \d+ms of SIGKILL; it could not be reaped/);
    assert.match(error.message, /stdio child \d+ of MCP server "l" did not exit within \d+ms of SIGKILL; it could not be reaped/);
    return true;
  });
  const internals = framework as unknown as {
    modernServers(): Map<string, unknown>;
    mcplServerRegistry: { getServer(id: string): unknown };
  };
  assert.ok(internals.modernServers().has('m'), 'the modern one it could not reap keeps its id');
  assert.ok(internals.mcplServerRegistry.getServer('l'), 'and so does the legacy one');
  for (const stuck of reaping.stuck) await killAndWait(stuck);
  // The failed stop left its store open, so it can be retried: the retry
  // confirms both exits and frees the ids.
  await framework.stop();
  assert.equal(internals.modernServers().has('m'), false);
  assert.equal(internals.mcplServerRegistry.getServer('l'), null);
});

test('a teardown that cannot confirm the exit traces no close; the retry that confirms it traces one, on both engines', async () => {
  await withFramework(async ({ framework, dir }) => {
    const closed: string[] = [];
    framework.onTrace((event) => { if (event.type === 'mcpl:server-closed') closed.push(event.serverId); });
    const reaping = unreapable();
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
    await framework.connectMcplServer(legacy('l', 'ok', join(dir, 'legacy.log')));
    await Promise.all(['m', 'l'].map((id) => assert.rejects(
      framework.disconnectMcplServer(id),
      new RegExp(`stdio child \\d+ of MCP server "${id}" did not exit .*stays registered, closed`),
    )));
    assert.deepEqual(closed, [], 'neither is traced closed while its child may still be running');
    for (const stuck of reaping.stuck) await killAndWait(stuck);
    await framework.disconnectMcplServer('m');
    await framework.disconnectMcplServer('l');
    assert.deepEqual(closed.sort(), ['l', 'm'], 'each is traced closed once, by the retry that confirms its exit');
  });
});

test("stop()'s teardown budget bounds a modern server's close too, and the server stays registered while its close is pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const pending = { close: async () => { await released; } };
  const modernServers = (framework as unknown as { modernServers(): Map<string, unknown> }).modernServers();
  modernServers.set('m', pending);
  await assert.rejects(framework.stop(50), (error) =>
    error instanceof ShutdownTimeoutError && error.pending.includes('mcp:m'));
  assert.equal(modernServers.get('m'), pending, 'still registered while its close is pending');
  release();
  await framework.stop();
  assert.equal(modernServers.has('m'), false, 'removed once its close completed');
});

test("a failed startup's cleanup closes both engines' connections, each whatever the other's close did", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const reaping = unreapable();
  try {
    await framework.connectMcplServer(legacy('l', 'ok', join(dir, 'legacy.log')));
    reaping.active = false;
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await (framework as unknown as { closeMcpConnectionsAfterFailedStartup(): Promise<void> }).closeMcpConnectionsAfterFailedStartup();
    } finally {
      console.error = realError;
    }
    const internals = framework as unknown as {
      modernServers(): Map<string, unknown>;
      mcplServerRegistry: { getServer(id: string): unknown };
    };
    assert.equal(internals.modernServers().has('m'), false, 'the modern connection was closed and let go, though the legacy close failed');
    assert.equal(status(framework, 'm')?.connected, false);
    assert.ok(internals.mcplServerRegistry.getServer('l'), 'the one it could not reap stays registered');
    assert.equal(status(framework, 'l')?.connected, false, 'closed');
    assert.match(JSON.stringify(errors), /could not be reaped/, 'and the failure is logged, not thrown');
  } finally {
    // Whatever the assertions found, end the stuck child so stop() can reap it.
    for (const stuck of reaping.stuck) await killAndWait(stuck);
    await framework.stop();
  }
});

test('a restart whose new configuration is refused leaves the running server as it was', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    await framework.connectMcplServer(modern('m', '', log));
    await assert.rejects(
      framework.restartMcplServer('m', { id: 'm', url: 'ftp://127.0.0.1/x' }),
      /MCP server "m" configuration: .*url must be/,
    );
    assert.equal(status(framework, 'm')?.connected, true, 'still connected');
    assert.equal(launches(log).length, 1, 'never torn down or relaunched');
    assert.ok(toolsOf(framework, 'm').length > 0, 'its tools still listed');
  });
});

test("a refresh in flight when a server is disconnected doesn't bring its tools back", async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
    assert.ok(toolsOf(framework, 'm').length > 0);
    const internals = framework as unknown as {
      modernServers(): Map<string, { listTools(): Promise<unknown[]> }>;
      refreshMcplTools(): Promise<void>;
    };
    const connection = internals.modernServers().get('m')!;
    const realList = connection.listTools.bind(connection);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let listed = false;
    connection.listTools = async () => { const tools = await realList(); listed = true; await gate; return tools; };
    const refreshing = internals.refreshMcplTools();
    await until(() => listed, 'the refresh holds the server\'s list');
    await framework.disconnectMcplServer('m');
    release();
    await refreshing;
    assert.deepEqual(toolsOf(framework, 'm'), [], 'the earlier refresh, finishing last, published none of its tools');
  });
});

test("a server connected while a refresh waits keeps its own tool prefix, and the held refresh publishes nothing", async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
    const internals = framework as unknown as {
      modernServers(): Map<string, { listTools(): Promise<unknown[]> }>;
      refreshMcplTools(): Promise<void>;
    };
    const connection = internals.modernServers().get('m')!;
    const realList = connection.listTools.bind(connection);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let listed = false;
    connection.listTools = async () => { const tools = await realList(); listed = true; await gate; return tools; };
    const refreshing = internals.refreshMcplTools();
    await until(() => listed, "the refresh holds the first server's list");
    connection.listTools = realList;
    // Connected while the first refresh waits, under a prefix of its own.
    await framework.connectMcplServer({ ...modern('n', '', join(dir, 'raw-n.jsonl')), toolPrefix: 'custom' });
    // The held refresh finishes last, and publishes nothing: the connect's
    // own refresh, started after it, listed both servers.
    release();
    await refreshing;
    const names = framework.getAllTools().map((t) => t.name);
    assert.ok(names.some((n) => n.startsWith('custom--')), names.join(', '));
    assert.ok(!names.some((n) => n.startsWith('mcpl--n--')), names.join(', '));
  });
});

test("a refresh in flight when a server restarts under the same id publishes none of the old connection's listing", async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
    assert.ok(toolsOf(framework, 'm').length > 0);
    const internals = framework as unknown as {
      modernServers(): Map<string, { listTools(): Promise<unknown[]> }>;
      refreshMcplTools(): Promise<void>;
    };
    const connection = internals.modernServers().get('m')!;
    const realList = connection.listTools.bind(connection);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let listed = false;
    connection.listTools = async () => { const tools = await realList(); listed = true; await gate; return tools; };
    const refreshing = internals.refreshMcplTools();
    await until(() => listed, "the refresh holds the old connection's list");
    // Restarted under the same id, its tools now under another prefix.
    await framework.restartMcplServer('m', { ...modern('m', '', join(dir, 'raw-2.jsonl')), toolPrefix: 'second' });
    assert.notEqual(internals.modernServers().get('m'), connection, 'a new connection');
    release();
    await refreshing;
    const names = framework.getAllTools().map((t) => t.name);
    assert.deepEqual(toolsOf(framework, 'm'), [], `the old connection's listing isn't published: ${names.join(', ')}`);
    assert.ok(names.some((n) => n.startsWith('second--')), names.join(', '));
  });
});

test('a server lost for good, legacy or modern, leaves the tool list', async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(legacy('l', 'ok', join(dir, 'legacy.log')));
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
    assert.ok(toolsOf(framework, 'l').length > 0 && toolsOf(framework, 'm').length > 0);
    await framework.executeToolCall(call('mcpl--l--die')).catch(() => {});
    await framework.executeToolCall(call('mcpl--m--die')).catch(() => {});
    await until(() => toolsOf(framework, 'l').length === 0, 'the legacy server\'s tools gone');
    await until(() => toolsOf(framework, 'm').length === 0, 'the modern server\'s tools gone');
  });
});

test("a stdio server switched to the modern family is a new coalescing binding; a legacy configuration's binding is unchanged", async () => {
  await withFramework(async ({ framework }) => {
    const internals = framework as unknown as {
      mcplServerConfigs: Map<string, McplServerConfig>;
      coalescingBinding(id: string): string;
    };
    internals.mcplServerConfigs.set('s', { id: 's', command: 'srv', args: ['a'] });
    const legacyBinding = internals.coalescingBinding('s');
    const { createHash } = await import('node:crypto');
    assert.equal(
      legacyBinding,
      createHash('sha256').update(JSON.stringify(['s', null, 'srv', ['a']])).digest('hex').slice(0, 16),
      'the hash a stored legacy binding was made with',
    );
    internals.mcplServerConfigs.set('s', { id: 's', command: 'srv', args: ['a'], protocol: 'modern' });
    assert.notEqual(internals.coalescingBinding('s'), legacyBinding);
    internals.mcplServerConfigs.delete('s');
  });
});
