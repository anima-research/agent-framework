/**
 * One owner per MCP server id across both engines (room-293, greptile's
 * review of PR #262 and Iris-1827's invariant): from a connect's admission
 * until its teardown is done, exactly one owner holds an id.
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

import { AgentFramework } from '../src/index.js';
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

test('a disconnect during a legacy connect waits for it to land, then removes it whole', async () => {
  await withFramework(async ({ framework, dir }) => {
    const log = join(dir, 'legacy.log');
    const pending = framework.connectMcplServer(legacy('same', 'slow', log, { SLOW_INIT_MS: '600' }));
    await until(() => launches(log).length === 1, 'the legacy launch, handshaking');
    const disconnecting = framework.disconnectMcplServer('same');
    await assert.rejects(framework.connectMcplServer(legacy('same', 'ok', log)), /"same" is still being disconnected/);
    await Promise.all([pending, disconnecting]);
    assert.equal(status(framework, 'same'), undefined);
    assert.deepEqual(toolsOf(framework, 'same'), []);
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
