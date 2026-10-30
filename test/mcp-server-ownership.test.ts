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
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentFramework, ModernMcpConnection, McplUnreapedLaunchError, ShutdownTimeoutError } from '../src/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { StdioTransport, setStdioExitGraceForTests } from '../src/mcpl/transport.js';
import type { McplServerConnection } from '../src/mcpl/server-connection.js';
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
const RECONNECT = { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 } as const;
/** A legacy server's connection, from the framework's registry. */
const legacyServer = (framework: AgentFramework, id: string) =>
  (framework as unknown as { mcplServerRegistry: { getServer(id: string): McplServerConnection | null } }).mcplServerRegistry.getServer(id)!;

/**
 * Stdio launches can't be signalled while `stuck.active` is set, so their
 * cleanup can't reap them; `kill` really ends one (Olive-1804's pattern).
 */
function unreapable(graceMs?: number): { active: boolean; stuck: Array<{ pid: number; kill: () => void }> } {
  const realSpawn = StdioTransport.spawn;
  const state = { active: true, stuck: [] as Array<{ pid: number; kill: () => void }> };
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (c) => {
    const transport = await realSpawn.call(StdioTransport, c);
    if (state.active) {
      const child = (transport as unknown as { child: ChildProcess & { pid: number } }).child;
      const realKill = child.kill.bind(child);
      child.kill = () => true;
      if (graceMs !== undefined) setStdioExitGraceForTests(child, graceMs);
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

const SHORT_GRACE_MS = 50;

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

    await framework.connectMcplServer(modern('m', '', log));
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
    await framework.connectMcplServer(modern('m', '', log));
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
    first.release();
    const config = modern('x', '', join(dir, 'raw.jsonl'));
    await assert.rejects(framework.connectMcplServer(config), /"x" is still being disconnected/, 'the first release left the second claim');
    second.release();
    await framework.connectMcplServer(config);
    assert.equal(status(framework, 'x')?.connected, true);
  });
});

test('a modern connect is refused while a legacy connect for the same id is still handshaking, before it reads anything', async () => {
  await withFramework(async ({ framework, dir }) => {
    const legacyLog = join(dir, 'legacy.log');
    const modernLog = join(dir, 'raw.jsonl');
    const pending = framework.connectMcplServer(legacy('same', 'slow', legacyLog, { SLOW_INIT_MS: '800' }));
    await until(() => launches(legacyLog).length === 1, 'the legacy launch, handshaking');
    await assert.rejects(framework.connectMcplServer(modern('same', '', modernLog)), /^Error: MCPL server "same" has a connect in flight; try again once it settles$/);
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
    // The handshake never finishes on its own, so only the disconnect can
    // end the connect.
    const pending = framework.connectMcplServer(legacy('same', 'slow', log, { SLOW_INIT_MS: '3600000' }));
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

test("legacy: a disconnect during a handshake whose child can't be reaped rejects, and the server stays registered until a retried disconnect confirms the exit", async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'legacy.log');
    const reaping = unreapable(SHORT_GRACE_MS);
    // The handshake never finishes on its own, so only the disconnect ends
    // the connect. Its cleanup can't reap the child, so the connect leaves
    // the closed connection that owns it registered, after the disconnect's
    // first removal found nothing there: the disconnect checks again once
    // the connect has settled.
    const pending = framework.connectMcplServer(legacy('l', 'slow', log, { SLOW_INIT_MS: '3600000' }));
    const connectFailure = pending.then(() => null, (error: unknown) => error);
    await until(() => launches(log).length === 1, 'the legacy launch, handshaking');
    await assert.rejects(
      framework.disconnectMcplServer('l'),
      /could not be reaped\. MCP server "l" stays registered, closed, until its exit is confirmed: disconnect it again to retry the reap$/,
    );
    assert.match(String(await connectFailure), /MCP server "l" was not connected: it was disconnected while connecting; its cleanup also failed: .*could not be reaped/);
    assert.equal(status(framework, 'l')?.connected, false, 'still listed, closed');
    await assert.rejects(framework.connectMcplServer(legacy('l', 'ok', log)), /"l" is already registered \(not connected and not reconnecting: disconnect it first\)/);
    assert.equal(launches(log).length, 1, 'no launch beside the unreaped child');

    await killAndWait(reaping.stuck[0]!);
    reaping.active = false;
    await framework.disconnectMcplServer('l');
    assert.equal(status(framework, 'l'), undefined, 'the retried disconnect completed');
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
    const reaping = unreapable(SHORT_GRACE_MS);
    await framework.connectMcplServer(config);
    assert.ok(toolsOf(framework, 'm').length > 0);
    await assert.rejects(
      framework.disconnectMcplServer('m'),
      /could not be reaped\. MCP server "m" stays registered, closed, until its exit is confirmed: disconnect it again to retry the reap/,
    );
    assert.equal(status(framework, 'm')?.connected, false, 'still listed, closed');
    assert.equal(toolsOf(framework, 'm').length, 0, 'closed either way, so its tools left the list');
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
    const reaping = unreapable(SHORT_GRACE_MS);
    await framework.connectMcplServer(config);
    assert.ok(toolsOf(framework, 'l').length > 0);
    await assert.rejects(
      framework.disconnectMcplServer('l'),
      /could not be reaped\. MCP server "l" stays registered, closed, until its exit is confirmed: disconnect it again to retry the reap/,
    );
    assert.equal(status(framework, 'l')?.connected, false, 'still listed, closed');
    assert.equal(toolsOf(framework, 'l').length, 0, 'closed either way, so its tools left the list');
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
    const reaping = unreapable(SHORT_GRACE_MS);
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

test('modern, with reconnect: a failed first connect whose launch cannot be reaped fails, and stays registered until a disconnect confirms the exit', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    const reaping = unreapable(SHORT_GRACE_MS);
    // No retry can come beside a launch that may still run, so the connect
    // fails rather than reporting a server that will never serve.
    await assert.rejects(
      framework.connectMcplServer({ ...modern('m', 'reject-discover', log), reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 }),
      /server\/discover .*; its cleanup also failed: .*could not be reaped\. MCP server "m" stays registered, closed, until its exit is confirmed: disconnect it to retry the reap/,
    );
    await assert.rejects(framework.connectMcplServer(modern('m', '', log)), /"m" is already registered \(not connected and not reconnecting/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(launches(log).length, 1, 'nothing launched beside it');

    await killAndWait(reaping.stuck[0]!);
    reaping.active = false;
    await framework.disconnectMcplServer('m');
    await framework.connectMcplServer(modern('m', '', log));
    assert.equal(status(framework, 'm')?.connected, true);
  });
});

test("at startup, a server with reconnect whose first launch can't be reaped is traced as not retrying, and alerts, on both engines", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'raw.jsonl');
  const reaping = unreapable(SHORT_GRACE_MS);
  const traces: Array<{ type: string; serverId?: string; willRetry?: boolean; kind?: string; agentName?: string }> = [];
  const watcher = {
    name: 'trace-watcher',
    async start(ctx: { onTrace(listener: (event: unknown) => void): void }) { ctx.onTrace((event) => traces.push(event as never)); },
    async stop() {},
    getTools: () => [],
    handleToolCall: async () => ({ success: false, error: 'no tools', isError: true }),
    onProcess: async () => ({}),
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [watcher as never],
    mcplServers: [
      { ...modern('m', 'reject-discover', log), reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 },
      { ...legacy('l', 'error', join(dir, 'legacy.log')), reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 },
    ],
  });
  cleanups.push(async () => {
    for (const stuck of reaping.stuck) await killAndWait(stuck);
    await framework.stop().catch(() => {});
  });
  for (const id of ['m', 'l']) {
    const failed = traces.filter((t) => t.type === 'mcpl:server-connect-failed' && t.serverId === id);
    // No retry can come beside a launch that may still run, and only a
    // disconnect retries its reap: the operator is told.
    assert.equal(failed.length, 1, id);
    assert.equal(failed[0]!.willRetry, false, id);
    assert.equal(traces.filter((t) => t.type === 'ops:alert' && t.kind === 'mcpl-down' && t.agentName === id).length, 1, id);
  }
});

/** The stdio line under a modern server's live session, reached from inside,
 *  to stand for a loss read from a failed pipe while the child still runs. */
function liveLineOf(framework: AgentFramework, id: string): { markClosed: (info: { reason: string }) => void; child: ChildProcess & { pid: number } } {
  const connection = (framework as unknown as { modernServers(): Map<string, { session: { wire: { inner: { line: unknown } } } | null }> }).modernServers().get(id);
  assert.ok(connection?.session, 'a live session');
  return connection.session.wire.inner.line as never;
}

test('modern, without reconnect: a server lost on its own holds its id until its child is reaped, then leaves', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    await framework.connectMcplServer(modern('m', 'ignore-sigterm', log));
    assert.ok(toolsOf(framework, 'm').length > 0);
    const line = liveLineOf(framework, 'm');
    line.markClosed({ reason: 'stdio pipe failed' });
    // The child ignores SIGTERM, so its reap takes about 2 s: meanwhile the
    // id is held, and nothing launches beside the child.
    await assert.rejects(framework.connectMcplServer(modern('m', '', log)), /"m" is already registered/);
    await until(() => toolsOf(framework, 'm').length === 0, 'its tools left the list once its reap is confirmed', 10_000);
    assert.equal(alive(line.child.pid), false, 'its child had exited');
    assert.equal(launches(log).length, 1, 'nothing launched beside it');
    await framework.connectMcplServer(modern('m', '', log));
    assert.equal(status(framework, 'm')?.connected, true, 'the id is free');
  });
});

for (const reconnect of [false, true]) {
test(`modern, ${reconnect ? 'with' : 'without'} reconnect: a server lost on its own whose child can't be reaped stays registered, alerts, and its tools leave`, async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'raw.jsonl');
    const alerts: string[] = [];
    framework.onTrace((event) => {
      const traced = event as { type: string; kind?: string; agentName?: string };
      if (traced.type === 'ops:alert') alerts.push(`${traced.kind} ${traced.agentName}`);
    });
    await framework.connectMcplServer({ ...modern('m', '', log), ...(reconnect ? RECONNECT : {}) });
    assert.ok(toolsOf(framework, 'm').length > 0);
    const line = liveLineOf(framework, 'm');
    const realKill = line.child.kill.bind(line.child);
    line.child.kill = () => true; // signals never arrive: the child outlives both bounds
    setStdioExitGraceForTests(line.child, SHORT_GRACE_MS);
    cleanups.push(() => { realKill('SIGKILL'); });
    line.markClosed({ reason: 'stdio pipe failed' });
    await until(() => alerts.includes('mcpl-down m'), 'the halt raised as an alert', 10_000);
    await until(() => toolsOf(framework, 'm').length === 0, 'its tools left the list');
    assert.equal(status(framework, 'm')?.connected, false, 'still registered, not connected');
    await assert.rejects(framework.connectMcplServer(modern('m', '', log)), /"m" is already registered \(not connected and not reconnecting/);
    assert.equal(launches(log).length, 1, 'nothing launched beside it');
    assert.deepEqual(alerts.filter((alert) => alert === 'mcpl-down m'), ['mcpl-down m'], 'one alert');

    realKill('SIGKILL');
    await until(() => !alive(line.child.pid), 'the held child killed');
    await framework.disconnectMcplServer('m');
    assert.equal(status(framework, 'm'), undefined);
  });
});
}

test('legacy, with reconnect: a reconnect that meets a protocol-version verdict halts for good, alerts, and its tools leave', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'legacy.log');
    const alerts: string[] = [];
    framework.onTrace((event) => {
      const traced = event as { type: string; kind?: string; agentName?: string };
      if (traced.type === 'ops:alert') alerts.push(`${traced.kind} ${traced.agentName}`);
    });
    // The first launch serves; every later one refuses the revision.
    await framework.connectMcplServer({ ...legacy('l', 'ok-then-reject', log), ...RECONNECT });
    assert.ok(toolsOf(framework, 'l').length > 0);
    await legacyServer(framework, 'l').sendToolsCall('die', {}).catch(() => { /* the session ends */ });
    await until(() => alerts.includes('mcpl-down l'), 'the halt raised as an alert', 10_000);
    await until(() => toolsOf(framework, 'l').length === 0, 'its tools left the list');
    assert.equal(launches(log).length, 2, 'no attempt after the verdict');
  });
});

for (const engine of ['legacy', 'modern'] as const) {
  test(`${engine}: a connect that stop() ends, whose cleanup can't reap its child, says the framework stopped and offers no disconnect`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [],
    });
    const reaping = unreapable(SHORT_GRACE_MS);
    const log = join(dir, engine === 'legacy' ? 'legacy.log' : 'raw.jsonl');
    // Neither connect finishes on its own: the legacy handshake waits an
    // hour, and the modern server never answers discover.
    const pending = framework.connectMcplServer(engine === 'legacy'
      ? legacy('s', 'slow', log, { SLOW_INIT_MS: '3600000' })
      : modern('s', 'hang-discover', log)).then(() => null, (error: unknown) => error as Error);
    await until(
      () => (engine === 'legacy' ? launches(log).length === 1 : lines(log).some((l) => l.includes('server/discover'))),
      'the connect in flight',
    );
    await assert.rejects(framework.stop(), /could not be reaped/);
    const refused = await pending;
    assert.match(
      refused?.message ?? 'connected',
      /^MCP server "s" was not connected: the framework stopped while it was connecting; its cleanup also failed: .*could not be reaped\. MCP server "s" stays registered, closed, until its exit is confirmed$/,
    );
    for (const stuck of reaping.stuck) await killAndWait(stuck);
    reaping.active = false;
    await framework.stop();
  });
}

test("modern: ModernMcpConnection.connect hands back the connection that owns a launch its cleanup couldn't reap", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'raw.jsonl');
  const reaping = unreapable(SHORT_GRACE_MS);
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

for (const reconnect of [false, true]) {
test(`legacy${reconnect ? ', with reconnect' : ''}: a failed connect whose cleanup cannot reap stays registered until a disconnect confirms the exit`, async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'legacy.log');
    const reaping = unreapable(SHORT_GRACE_MS);
    await assert.rejects(
      framework.connectMcplServer({ ...legacy('l', 'error', log), ...(reconnect ? RECONNECT : {}) }),
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
}

test('stop() closes every connection, keeps the ones it cannot reap registered, and rejects with each failure; once they have exited, a retry completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const reaping = unreapable(SHORT_GRACE_MS);
  await framework.connectMcplServer(modern('m', '', join(dir, 'raw.jsonl')));
  await framework.connectMcplServer(legacy('l', 'ok', join(dir, 'legacy.log')));
  const closed: string[] = [];
  framework.onTrace((event) => { if (event.type === 'mcpl:server-closed') closed.push(event.serverId); });
  await assert.rejects(framework.stop(), (error) => {
    assert.ok(error instanceof AggregateError, String(error));
    assert.equal(error.errors.length, 2, 'one failure from each engine');
    assert.match(error.message, new RegExp(`stdio child \\d+ of MCP server "m" did not exit within ${SHORT_GRACE_MS}ms of SIGKILL; it could not be reaped`));
    assert.match(error.message, new RegExp(`stdio child \\d+ of MCP server "l" did not exit within ${SHORT_GRACE_MS}ms of SIGKILL; it could not be reaped`));
    return true;
  });
  assert.deepEqual(closed, [], 'neither close is confirmed');
  for (const stuck of reaping.stuck) await killAndWait(stuck);
  // The failed stop left its store open, so it can be retried: the retry
  // confirms both exits.
  await framework.stop();
  assert.deepEqual([...closed].sort(), ['l', 'm'], 'the retry reached both, and confirmed each close once');
});

test('a teardown that cannot confirm the exit traces no close; the retry that confirms it traces one, on both engines', async () => {
  await withFramework(async ({ framework, dir }) => {
    const closed: string[] = [];
    framework.onTrace((event) => { if (event.type === 'mcpl:server-closed') closed.push(event.serverId); });
    const reaping = unreapable(SHORT_GRACE_MS);
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
  const pending = { stopReconnecting() {}, close: async () => { await released; } };
  const modernServers = (framework as unknown as { modernServers(): Map<string, unknown> }).modernServers();
  modernServers.set('m', pending);
  await assert.rejects(framework.stop(50), (error) =>
    error instanceof ShutdownTimeoutError && error.pending.includes('mcp:m'));
  assert.equal(modernServers.get('m'), pending, 'still registered while its close is pending');
  release();
  await framework.stop();
  assert.equal(modernServers.has('m'), false, 'removed once its close completed');
});

test("a modern server's tool prefix meets another server's under #469's rule, at a runtime connect and a restart, whichever family is first", async () => {
  await withFramework(async ({ framework, dir }) => {
    const modernLog = join(dir, 'raw.jsonl');
    // A modern server first, under `foo`.
    await framework.connectMcplServer({ ...modern('m', '', modernLog), toolPrefix: 'foo' });
    await assert.rejects(framework.connectMcplServer({ ...legacy('l', 'ok', join(dir, 'legacy.log')), toolPrefix: 'foo--bar' }),
      /toolPrefix "foo--bar" meets server "m"'s toolPrefix "foo"/, 'a legacy server whose prefix meets it');
    await assert.rejects(framework.connectMcplServer({ ...modern('m2', '', join(dir, 'raw2.jsonl')), toolPrefix: 'foo-' }),
      /toolPrefix "foo-" meets server "m"'s toolPrefix "foo"/, 'a modern server whose prefix meets it');
    // A legacy server first, under `bar`.
    await framework.connectMcplServer({ ...legacy('l2', 'ok', join(dir, 'legacy2.log')), toolPrefix: 'bar' });
    await assert.rejects(framework.connectMcplServer({ ...modern('m3', '', join(dir, 'raw3.jsonl')), toolPrefix: 'bar--baz' }),
      /toolPrefix "bar--baz" meets server "l2"'s toolPrefix "bar"/, 'a modern server whose prefix meets a legacy one');
    // A restart that would move the modern server to a prefix meeting the legacy one's is refused before its teardown.
    await assert.rejects(framework.restartMcplServer('m', { ...modern('m', '', modernLog), toolPrefix: 'bar-' }),
      /toolPrefix "bar-" meets server "l2"'s toolPrefix "bar"/, 'a restart into a prefix that meets another');
    assert.equal(status(framework, 'm')?.connected, true, 'the refused restart left the server up');
    for (const id of ['l', 'm2', 'm3']) assert.equal(status(framework, id), undefined, `${id} was never connected`);
  });
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
    release();
    await refreshing;
    const names = framework.getAllTools().map((t) => t.name);
    assert.deepEqual(toolsOf(framework, 'm'), [], `the old connection's listing isn't published: ${names.join(', ')}`);
    assert.ok(names.some((n) => n.startsWith('second--')), names.join(', '));
  });
});

test('a server whose listing a later refresh failed is listed again when the earlier listing is dropped', async () => {
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
    let mode: 'hold' | 'refuse' | 'answer' = 'hold';
    let held = false;
    connection.listTools = async () => {
      if (mode === 'refuse') throw new Error('refused while another listing is open');
      const tools = await realList();
      if (mode === 'hold') { held = true; await gate; }
      return tools;
    };
    // The first refresh lists m and holds the answer.
    const first = internals.refreshMcplTools();
    await until(() => held, 'the first refresh holds its listing of m');
    // A later refresh, whose request m refuses, publishes first, without m.
    mode = 'refuse';
    await internals.refreshMcplTools();
    assert.deepEqual(toolsOf(framework, 'm'), [], "the later refresh published no listing of m");
    // The first refresh's listing is older, so it's dropped, and one more
    // refresh lists m again.
    mode = 'answer';
    release();
    await first;
    await until(() => toolsOf(framework, 'm').length > 0, "one more refresh brings m's tools back");
  });
});

for (const engine of ['legacy', 'modern'] as const) {
  test(`${engine}: a listing begun before its server's session closed doesn't bring back the class hints the close dropped`, async () => {
    await withFramework(async ({ framework, dir }) => {
      const base = engine === 'legacy' ? legacy('s', 'ok', join(dir, 'legacy.log')) : modern('s', '', join(dir, 'raw.jsonl'));
      // It reconnects, but not before the test is over.
      await framework.connectMcplServer({ ...base, reconnect: true, reconnectIntervalMs: 60_000, reconnectMaxIntervalMs: 60_000 });
      type Tool = { name: string; _meta?: Record<string, unknown> };
      type Server = { on(event: 'close', listener: () => void): void; sendToolsList(): Promise<{ tools: Tool[] }>; listTools(): Promise<Tool[]> };
      const internals = framework as unknown as {
        mcplServerRegistry: { getServer(id: string): Server };
        modernServers(): Map<string, Server>;
        refreshMcplTools(): Promise<void>;
      };
      const server = engine === 'legacy' ? internals.mcplServerRegistry.getServer('s') : internals.modernServers().get('s')!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      // The session about to close declares its tools `files`.
      const classed = (tools: Tool[]): Tool[] => tools.map((tool) => ({ ...tool, _meta: { ...tool._meta, 'mcpl/class': ['files'] } }));
      if (engine === 'legacy') {
        const real = server.sendToolsList.bind(server);
        server.sendToolsList = async () => { const result = await real(); held = true; await gate; return { ...result, tools: classed(result.tools) }; };
      } else {
        const real = server.listTools.bind(server);
        server.listTools = async () => { const tools = classed(await real()); held = true; await gate; return tools; };
      }
      const refreshing = internals.refreshMcplTools();
      await until(() => held, 'the refresh holds its listing');
      let closed = false;
      server.on('close', () => { closed = true; });
      await framework.executeToolCall(call('mcpl--s--die')).catch(() => {});
      await until(() => closed, 'the session closes, and the server waits to reconnect');
      release();
      await refreshing;
      const kept = framework.listToolClasses().filter((tool) => tool.serverId === 's' && tool.class.includes('files'));
      assert.deepEqual(kept, [], "no tool keeps the closed session's class");
      assert.deepEqual(framework.getAllTools().filter((tool) => tool.name.startsWith('mcpl--s--')), [], "nor are the closed session's tools published");
    });
  });
}

/** Hold modern server `id`'s listings once they've answered, until
 *  release(): every one, or only the first `first`. */
function holdListings(framework: AgentFramework, id: string, first = Infinity): { held: () => number; release: () => void } {
  const connection = (framework as unknown as { modernServers(): Map<string, { listTools(): Promise<unknown[]> }> }).modernServers().get(id)!;
  const realList = connection.listTools.bind(connection);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = 0;
  connection.listTools = async () => {
    const tools = await realList();
    if (held >= first) return tools;
    held += 1;
    await gate;
    return tools;
  };
  return { held: () => held, release };
}

test("a disconnect during a connect's tool listing ends the connect", async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(modern('a', '', join(dir, 'raw-a.jsonl')));
    const a = holdListings(framework, 'a');
    const servers = (framework as unknown as { modernServers(): Map<string, unknown> }).modernServers();
    const connecting = framework.connectMcplServer(modern('m', '', join(dir, 'raw-m.jsonl')));
    await until(() => a.held() > 0, "m's connect, listing tools, waits on a");
    // The disconnect removes m whole while that listing waits. Its own
    // refresh then waits on a too, so it's awaited once a answers.
    const disconnecting = framework.disconnectMcplServer('m');
    await until(() => !servers.has('m'), 'm is removed');
    a.release();
    await assert.rejects(connecting, /MCP server "m" was not connected: it was disconnected or lost while its tools were being listed/);
    await disconnecting;
  });
});

test("a disconnect during a restart's tool listing ends the restart, which says the server is down", async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(modern('a', '', join(dir, 'raw-a.jsonl')));
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw-m.jsonl')));
    const servers = (framework as unknown as { modernServers(): Map<string, unknown> }).modernServers();
    const before = servers.get('m');
    // Hold a's listings made once the restart has registered the new m: its
    // connect's. The teardown's refresh, and the disconnect's below, come
    // while no m is registered, and pass.
    const a = servers.get('a') as { listTools(): Promise<unknown[]> };
    const realList = a.listTools.bind(a);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = 0;
    a.listTools = async () => {
      const tools = await realList();
      if (!servers.has('m') || servers.get('m') === before) return tools;
      held += 1;
      await gate;
      return tools;
    };
    const restarting = framework.restartMcplServer('m');
    // Handled here too, so an assertion that fails first leaves no
    // unhandled rejection behind.
    void restarting.catch(() => {});
    let disconnecting: Promise<void> | undefined;
    try {
      await until(() => held > 0, "the restart's connect, listing tools, waits on a");
      disconnecting = framework.disconnectMcplServer('m');
      await until(() => !servers.has('m'), 'the new m is removed');
    } finally {
      release();
    }
    await assert.rejects(restarting, /^Error: MCP server "m" is down: it was disconnected for its restart, and the restart's connect failed: MCP server "m" was not connected: it was disconnected or lost while its tools were being listed$/);
    await disconnecting;
  });
});

test("a disconnect still under way when a connect's tool listing ends fails the connect", async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(modern('a', '', join(dir, 'raw-a.jsonl')));
    const a = holdListings(framework, 'a');
    const servers = (framework as unknown as { modernServers(): Map<string, { close(): Promise<void>; isConnected: boolean }> }).modernServers();
    const connecting = framework.connectMcplServer(modern('m', '', join(dir, 'raw-m.jsonl')));
    await until(() => a.held() > 0, "m's connect, listing tools, waits on a");
    // m's close waits for the test, so its disconnect holds the id while m
    // is still registered and still connected.
    const m = servers.get('m')!;
    const realClose = m.close.bind(m);
    let openClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { openClose = resolve; });
    m.close = async () => { await closeGate; return realClose(); };
    let disconnected = false;
    const disconnecting = framework.disconnectMcplServer('m').then(() => { disconnected = true; });
    try {
      a.release();
      await assert.rejects(connecting, /MCP server "m" was not connected: it was disconnected or lost while its tools were being listed/);
      assert.equal(disconnected, false, 'the disconnect was still under way');
      assert.equal(status(framework, 'm')?.connected, true, 'with m still registered and connected');
    } finally {
      openClose();
      await disconnecting;
    }
  });
});

test("a disconnect that fails to reap during a connect's tool listing fails the connect", async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer(modern('a', '', join(dir, 'raw-a.jsonl')));
    // Only the connect's listing: the failed disconnect's own refresh lists
    // a too.
    const a = holdListings(framework, 'a', 1);
    const reaping = unreapable(SHORT_GRACE_MS);
    const connecting = framework.connectMcplServer(modern('m', '', join(dir, 'raw-m.jsonl')));
    await until(() => a.held() > 0, "m's connect, listing tools, waits on a");
    reaping.active = false;
    try {
      // The disconnect closes m and can't reap its child: m stays
      // registered, closed, and the disconnect has let go of the id.
      await assert.rejects(framework.disconnectMcplServer('m'), /could not be reaped/);
      assert.equal(status(framework, 'm')?.connected, false, 'still listed, closed');
      a.release();
      await assert.rejects(connecting, /MCP server "m" was not connected: it was disconnected or lost while its tools were being listed/);
    } finally {
      a.release();
      for (const stuck of reaping.stuck) await killAndWait(stuck);
    }
    await framework.disconnectMcplServer('m');
  });
});

test("a listing of a server whose disconnect failed to reap isn't published", async () => {
  await withFramework(async ({ framework, dir }) => {
    const reaping = unreapable();
    await framework.connectMcplServer(modern('m', '', join(dir, 'raw-m.jsonl')));
    reaping.active = false;
    assert.ok(toolsOf(framework, 'm').length > 0);
    type Tool = { name: string; _meta?: Record<string, unknown> };
    const internals = framework as unknown as {
      modernServers(): Map<string, { listTools(): Promise<Tool[]> }>;
      refreshMcplTools(): Promise<void>;
    };
    const connection = internals.modernServers().get('m')!;
    const realList = connection.listTools.bind(connection);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    connection.listTools = async () => {
      const tools = (await realList()).map((tool) => ({ ...tool, _meta: { ...tool._meta, 'mcpl/class': ['files'] } }));
      held = true;
      await gate;
      return tools;
    };
    const refreshing = internals.refreshMcplTools();
    await until(() => held, 'the refresh holds its listing of m');
    let disconnecting: Promise<void> | undefined;
    try {
      // The disconnect closes m, and its reap then fails, which takes
      // seconds; the refresh publishes meanwhile. A teardown that hasn't
      // confirmed the exit has emitted no 'close', so only m's state says
      // it's over.
      disconnecting = framework.disconnectMcplServer('m');
      await until(() => (connection as unknown as { isClosed: boolean }).isClosed, 'm closed by the disconnect');
      release();
      await refreshing;
      assert.deepEqual(toolsOf(framework, 'm'), [], "the closed connection's listing isn't published");
      assert.deepEqual(framework.listToolClasses().filter((tool) => tool.serverId === 'm' && tool.class.includes('files')), []);
      await assert.rejects(disconnecting, /could not be reaped/);
    } finally {
      release();
      await disconnecting?.catch(() => { /* its verdict is asserted above */ });
      for (const stuck of reaping.stuck) await killAndWait(stuck);
    }
    await framework.disconnectMcplServer('m');
  });
});

test('a listing begun before its server closed and reconnected is left out, and the new session is listed', async () => {
  await withFramework(async ({ framework, dir }) => {
    await framework.connectMcplServer({ ...modern('m', '', join(dir, 'raw.jsonl')), reconnect: true, reconnectIntervalMs: 50, reconnectMaxIntervalMs: 100 });
    type Tool = { name: string; _meta?: Record<string, unknown> };
    const internals = framework as unknown as {
      modernServers(): Map<string, { listTools(): Promise<Tool[]> }>;
      refreshMcplTools(): Promise<void>;
    };
    const connection = internals.modernServers().get('m')!;
    const realList = connection.listTools.bind(connection);
    // The first listing is the old session's, which declares `files`. The
    // second is the reconnect's own refresh, of the new session.
    const gates = [0, 1].map(() => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve; }); return { open, shut }; });
    let calls = 0;
    const answered: boolean[] = [];
    connection.listTools = async () => {
      const call = calls++;
      const tools = await realList();
      answered[call] = true;
      if (call > 1) return tools;
      await gates[call]!.shut;
      return call === 0 ? tools.map((tool) => ({ ...tool, _meta: { ...tool._meta, 'mcpl/class': ['files'] } })) : tools;
    };
    const refreshing = internals.refreshMcplTools();
    try {
      await until(() => answered[0] === true, "the refresh holds the old session's listing of m");
      await framework.executeToolCall(call('mcpl--m--die')).catch(() => {});
      // m's session closes and a new one starts: its reconnect lists it.
      await until(() => calls > 1, "m's reconnect lists its new session");
      gates[0]!.open();
      await refreshing;
      assert.deepEqual(toolsOf(framework, 'm'), [], "the old session's listing isn't published, though m is connected again");
      assert.deepEqual(framework.listToolClasses().filter((tool) => tool.serverId === 'm' && tool.class.includes('files')), []);
      gates[1]!.open();
      await until(() => toolsOf(framework, 'm').length > 0, "the new session's listing is published");
      assert.deepEqual(framework.listToolClasses().filter((tool) => tool.serverId === 'm' && tool.class.includes('files')), []);
    } finally {
      for (const gate of gates) gate.open();
    }
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
