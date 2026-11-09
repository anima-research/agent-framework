import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import { AgentFramework, serverConfigProblems } from '../src/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const LOGGED = fileURLToPath(new URL('./fixtures/logged-launch.mjs', import.meta.url));
const LEGACY_FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));
const MODERN_FIXTURE = fileURLToPath(new URL('./fixtures/modern-mcp-server.mjs', import.meta.url));

type Trace = Record<string, unknown> & { type: string; seenAt: number };
type Engine = 'legacy' | 'modern';

function server(engine: Engine, id: string, scratch: string, extra: Record<string, string> = {}): McplServerConfig {
  const env = { LAUNCHES_PATH: join(scratch, 'launches'), ...extra };
  return engine === 'legacy'
    ? { id, command: process.execPath, args: [LOGGED, LEGACY_FIXTURE], env, enabledFeatureSets: ['chat'], reconnect: true, reconnectIntervalMs: 100 }
    : { id, command: process.execPath, args: [LOGGED, MODERN_FIXTURE, join(scratch, 'starts')], env, protocol: 'modern', reconnect: true, reconnectIntervalMs: 100 };
}

async function started(t: TestContext, config: McplServerConfig, scratch: string) {
  const printed: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  const posted: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    posted.push(JSON.parse(init.body).content);
    return new Response(null, { status: 204 });
  });
  const hook = process.env.CONNECTOME_OPS_WEBHOOK;
  process.env.CONNECTOME_OPS_WEBHOOK = 'http://127.0.0.1:9/ops';
  const traces: Trace[] = [];
  const framework = await AgentFramework.create({
    storePath: join(scratch, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [],
    maintenanceIntervalMs: 0,
    mcplServers: [config],
  });
  framework.onTrace((event) => traces.push({ ...(event as Record<string, unknown> & { type: string }), seenAt: Date.now() }), { replay: true });
  t.after(async () => {
    try {
      await framework.stop();
    } finally {
      if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK;
      else process.env.CONNECTOME_OPS_WEBHOOK = hook;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  const launches = () => {
    const path = join(scratch, 'launches');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [at, pid] = line.split(' ');
      return { at: Number(at), pid: Number(pid) };
    });
  };
  const of = (type: string) => traces.filter((event) => event.type === type);
  return {
    framework,
    posted,
    printed,
    launches,
    failed: () => of('mcpl:server-connect-failed'),
    reconnected: () => of('mcpl:server-reconnected'),
    alerts: () => of('ops:alert').filter((event) => event.kind === 'mcpl-down'),
  };
}

function scratchDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `mcpl-${name}-`));
}

async function waitFor(what: string, predicate: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function connectionOf(framework: AgentFramework, engine: Engine, id: string): { connectedAt: number } {
  const internals = framework as unknown as {
    mcplServerRegistry: { getServer(id: string): { connectedAt: number } };
    modernMcpConnections: Map<string, { connectedAt: number }>;
  };
  return engine === 'legacy' ? internals.mcplServerRegistry.getServer(id) : internals.modernMcpConnections.get(id)!;
}

async function endConnection(server: Awaited<ReturnType<typeof started>>, index: number, reportsBefore: number): Promise<void> {
  if (index > 0) await waitFor(`reconnect ${index}`, () => server.reconnected().length >= index);
  await waitFor(`launch ${index}`, () => server.launches().length > index);
  process.kill(server.launches()[index]!.pid, 'SIGTERM');
  await waitFor(`the end of connection ${index}`, () => server.failed().length > reportsBefore);
}

for (const engine of ['legacy', 'modern'] as const) {
  test(`${engine}: a server whose connections keep ending soon after their handshake fails an attempt each time, prints it, backs off, and alerts as one that never connects does`, { timeout: 60_000 }, async (t) => {
    const scratch = scratchDir('flaps');
    const flaps = await started(t, server(engine, 'flaps', scratch), scratch);
    const atClose: number[] = [];
    const connection = connectionOf(flaps.framework, engine, 'flaps') as unknown as { reconnectAttempts: number; on(event: 'close', listener: () => void): void };
    connection.on('close', () => atClose.push(connection.reconnectAttempts));
    for (let index = 0; index < 6; index += 1) await endConnection(flaps, index, index);
    assert.deepEqual(atClose, [1, 2, 3, 4, 5, 6]);
    await waitFor('the mcpl-down alert', () => flaps.alerts().length >= 1);

    const ends = flaps.failed();
    assert.deepEqual(ends.map((event) => event.attempt), [0, 1, 2, 3, 4, 5]);
    for (const event of ends) {
      assert.match(String(event.error), /^connected, then closed after \d+(\.\d)? s \(signal SIGTERM\)$/);
      assert.equal(event.willRetry, true);
    }
    const name = engine === 'legacy' ? 'MCPL server' : 'MCP server';
    const alert = String(flaps.alerts()[0]!.message);
    assert.ok(alert.startsWith(`${name} down (attempt 5): connected, then closed after`), alert);
    assert.ok(flaps.posted.some((text) => text.includes(`mcpl-down: ${name} down (attempt 5): `)), flaps.posted.join(' | '));

    const lines = (pattern: RegExp) => flaps.printed.filter((line) => pattern.test(line)).length;
    assert.equal(lines(new RegExp(`^${name} "flaps" initial connect failed, will retry: connected, then closed after`)), 1, flaps.printed.join('\n'));
    assert.equal(lines(new RegExp(`^${name} "flaps" reconnect failed: connected, then closed after`)), 5, flaps.printed.join('\n'));

    const launches = flaps.launches();
    assert.ok(launches[5]!.at - ends[4]!.seenAt >= 1200, `launch 5 came ${launches[5]!.at - ends[4]!.seenAt} ms after attempt 4's end`);
  });

  test(`${engine}: a connection that lasted, after two that didn't, starts the count afresh, and the reconnect that follows is attempt 1`, { timeout: 60_000 }, async (t) => {
    const scratch = scratchDir('lasts');
    const lasts = await started(t, server(engine, 'lasts', scratch), scratch);
    await endConnection(lasts, 0, 0);
    await endConnection(lasts, 1, 1);
    await waitFor('reconnect 2', () => lasts.reconnected().length >= 2);
    await waitFor('launch 2', () => lasts.launches().length > 2);
    connectionOf(lasts.framework, engine, 'lasts').connectedAt -= 301_000;
    process.kill(lasts.launches()[2]!.pid, 'SIGTERM');
    await waitFor('reconnect 3', () => lasts.reconnected().length >= 3);
    assert.equal(lasts.failed().length, 2, 'a connection that lasted is no failure');
    await endConnection(lasts, 3, 2);
    assert.deepEqual(lasts.reconnected().map((event) => event.attempts), [1, 2, 1]);
    assert.deepEqual(lasts.failed().map((event) => event.attempt), [0, 1, 1]);
  });

  test(`${engine}: a larger cap is the threshold: a connection of 301 s under a 600 s cap hadn't lasted`, { timeout: 60_000 }, async (t) => {
    const scratch = scratchDir('capped');
    const capped = await started(t, { ...server(engine, 'capped', scratch), reconnectMaxIntervalMs: 600_000 }, scratch);
    await waitFor('the first launch', () => capped.launches().length === 1);
    connectionOf(capped.framework, engine, 'capped').connectedAt -= 301_000;
    process.kill(capped.launches()[0]!.pid, 'SIGTERM');
    await waitFor('its end reported', () => capped.failed().length >= 1);
    assert.equal(capped.failed()[0]!.attempt, 0);
    const lived = /^connected, then closed after (\d+) s/.exec(String(capped.failed()[0]!.error));
    assert.ok(lived && Number(lived[1]) >= 301 && Number(lived[1]) < 600, String(capped.failed()[0]!.error));
  });

  test(`${engine}: a launch found unreapable after a connection that lasted halts with attempt 1, as before this change`, { timeout: 60_000 }, async (t) => {
    const scratch = scratchDir('halted');
    const halted = await started(t, server(engine, 'halted', scratch), scratch);
    await endConnection(halted, 0, 0);
    await endConnection(halted, 1, 1);
    await waitFor('reconnect 2', () => halted.reconnected().length >= 2);
    const connection = connectionOf(halted.framework, engine, 'halted') as unknown as {
      connectedAt: number;
      transport: { emit(event: 'unreaped', failure: Error): void };
      session: { generation: number };
      handleLost(generation: number, reason: string, unreaped?: Error): void;
    };
    connection.connectedAt -= 301_000;
    if (engine === 'legacy') connection.transport.emit('unreaped', new Error('it outlived SIGKILL'));
    else connection.handleLost(connection.session.generation, 'its stdio pipe failed', new Error('it outlived SIGKILL'));
    await waitFor('the halt', () => halted.failed().some((event) => event.willRetry === false));
    const halt = halted.failed().at(-1)!;
    assert.equal(halt.willRetry, false);
    assert.equal(halt.attempt, 1);
    assert.equal(halted.failed().length, 3, 'two short ends, then the halt');
  });

  test(`${engine}: a launch found unreapable while its connection is still short-lived halts once, with no short-lived report of that end`, { timeout: 60_000 }, async (t) => {
    const scratch = scratchDir('halted-short');
    const halted = await started(t, server(engine, 'halted', scratch), scratch);
    await endConnection(halted, 0, 0);
    await endConnection(halted, 1, 1);
    await waitFor('reconnect 2', () => halted.reconnected().length >= 2);
    const connection = connectionOf(halted.framework, engine, 'halted') as unknown as {
      willReconnect: boolean;
      transport: { emit(event: 'unreaped', failure: Error): void };
      session: { generation: number };
      handleLost(generation: number, reason: string, unreaped?: Error): void;
    };
    if (engine === 'legacy') connection.transport.emit('unreaped', new Error('it outlived SIGKILL'));
    else connection.handleLost(connection.session.generation, 'its stdio pipe failed', new Error('it outlived SIGKILL'));
    await waitFor('the halt', () => halted.failed().some((event) => event.willRetry === false));
    assert.equal(connection.willReconnect, false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const halt = halted.failed().at(-1)!;
    assert.equal(halt.willRetry, false);
    assert.equal(halt.attempt, 3);
    assert.equal(halted.failed().length, 3, 'two short ends, then the halt, with no short-lived report of the third end');
    assert.equal(halted.launches().length, 3, 'nothing launched after the halt');
  });

  test(`${engine}: a reconnect that fails before its handshake prints a line per attempt`, { timeout: 60_000 }, async (t) => {
    const scratch = scratchDir('stays-down');
    const token = 'sk-0123456789abcdef0123';
    const down = await started(t, server(engine, 'down', scratch, { FAIL_RELAUNCH: '1', API_TOKEN: token }), scratch);
    await endConnection(down, 0, 0);
    await waitFor('two failed reconnects', () => down.failed().length >= 3);
    const name = engine === 'legacy' ? 'MCPL server' : 'MCP server';
    const failedReconnects = down.printed.filter((line) => line.startsWith(`${name} "down" reconnect failed: `) && !line.includes('connected, then closed'));
    assert.ok(failedReconnects.length >= 2, down.printed.join('\n'));
    for (const line of failedReconnects) {
      assert.match(line, /stderr: "refusing to start with /, line);
      assert.ok(!line.includes(token), line);
    }
    const printing = connectionOf(down.framework, engine, 'down') as unknown as { printFailedAttempt(attempt: number, error: string): void };
    printing.printFailedAttempt(7, `a failure naming ${token}`);
    const last = down.printed.at(-1)!;
    assert.ok(last.startsWith(`${name} "down" reconnect failed: a failure naming `), last);
    assert.ok(!last.includes(token), last);
  });
}

test("legacy: the host's own recycle of a connection that hadn't lasted is that attempt's failure, worded as the host's", { timeout: 60_000 }, async (t) => {
  const scratch = scratchDir('recycled');
  const recycled = await started(t, server('legacy', 'recycled', scratch), scratch);
  await (connectionOf(recycled.framework, 'legacy', 'recycled') as unknown as { reconnectAfterFailure(): Promise<void> }).reconnectAfterFailure();
  await waitFor('the recycle reported', () => recycled.failed().length >= 1);
  assert.equal(recycled.failed()[0]!.attempt, 0);
  assert.match(String(recycled.failed()[0]!.error), /^connected, then closed by this host after \d+(\.\d)? s/);
  await waitFor('the reconnect', () => recycled.reconnected().length >= 1);
});

const agents = [{ name: 'agent', model: 'test', systemPrompt: 'test' }];

test('where the timings are used, a timing read as 0, below 0 or not a number fails that server at startup, naming the server and the field, and the others are brought up', { timeout: 60_000 }, async (t) => {
  const dir = scratchDir('timings');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => {});
  const writes = (path: string) => ({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path)}, '')`] });
  const legacyReconnecting = { ...writes(join(dir, 'never')), reconnect: true };
  const modernNotReconnecting = { ...writes(join(dir, 'never')), protocol: 'modern', reconnect: false };
  const httpNotReconnecting = { url: 'http://127.0.0.1:9/mcp' };
  let index = 0;
  for (const [field, value, shown, where] of [
    ['reconnectIntervalMs', 0, '0', legacyReconnecting],
    ['reconnectIntervalMs', -5, '-5', legacyReconnecting],
    ['reconnectMaxIntervalMs', Number.NaN, 'NaN', legacyReconnecting],
    ['reconnectMaxIntervalMs', 'abc', 'a string', legacyReconnecting],
    ['reconnectIntervalMs', 0, '0', modernNotReconnecting],
    ['reconnectIntervalMs', 0, '0', httpNotReconnecting],
  ] as const) {
    index++;
    const what = `${field} ${shown} on ${JSON.stringify(where)}`;
    const framework = await AgentFramework.create({
      storePath: join(dir, `store-${index}`),
      membrane: new MockMembrane().asMembrane(),
      agents,
      modules: [],
      maintenanceIntervalMs: 0,
      mcplServers: [
        { id: 'timed', ...where, [field]: value } as McplServerConfig,
        { id: 'good', ...writes(join(dir, `ran-${index}`)) },
      ],
    });
    try {
      const traces: Array<Record<string, unknown>> = [];
      framework.onTrace((event) => traces.push(event as unknown as Record<string, unknown>), { replay: true });
      const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed' && event.serverId === 'timed');
      assert.ok(failed, `no failed connect traced for ${what}`);
      assert.match(String(failed.error), new RegExp(field));
      assert.ok(String(failed.error).includes(`(got ${shown})`), String(failed.error));
      assert.equal(failed.willRetry, false);
      assert.ok(traces.some((event) => event.type === 'ops:alert' && event.kind === 'mcpl-down' && event.agentName === 'timed'), `no mcpl-down alert for ${what}`);
      assert.ok(existsSync(join(dir, `ran-${index}`)), `the other server wasn't brought up for ${what}`);
    } finally {
      await framework.stop();
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(existsSync(join(dir, 'never')), false, 'a server with an unusable timing was brought up');
  const problems = serverConfigProblems({ id: 'timed', ...writes(join(dir, 'never')), reconnect: true, reconnectIntervalMs: 0 });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0]!, /^MCP server "timed": reconnectIntervalMs .*\(got 0\)/);
});

test('legacy: a connection that ends while its reconnect\'s policy exchange is pending still reports that attempt\'s failure, and that reconnect announces nothing', { timeout: 60_000 }, async (t) => {
  const scratch = scratchDir('policy');
  const pending = join(scratch, 'policy-pending');
  const release = join(scratch, 'policy-release');
  writeFileSync(release, '');
  const held = await started(t, server('legacy', 'held', scratch, { POLICY_PENDING_PATH: pending, POLICY_RELEASE_PATH: release }), scratch);
  await waitFor('the first policy exchange', () => existsSync(pending));
  rmSync(pending);
  rmSync(release);
  await endConnection(held, 0, 0);
  await waitFor('reconnect 1\'s policy exchange, held', () => existsSync(pending) && held.launches().length === 2);
  process.kill(held.launches()[1]!.pid, 'SIGTERM');
  await waitFor('the end of connection 1', () => held.failed().length > 1);
  assert.deepEqual(held.failed().map((event) => event.attempt), [0, 1]);
  assert.match(String(held.failed()[1]!.error), /^connected, then closed after \d+(\.\d)? s \(signal SIGTERM\)$/);
  assert.equal(held.reconnected().length, 0);
});

test('legacy: a WebSocket connection that a server closes before it lasted is that attempt\'s failure, worded with its close code', { timeout: 30_000 }, async (t) => {
  const scratch = scratchDir('ws-closed');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  await new Promise<void>((resolve) => (wss.address() ? resolve() : wss.once('listening', () => resolve())));
  const sockets: import('ws').WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as { id?: unknown; method?: string };
      if (message.id === undefined || message.id === null || message.method === undefined) return;
      const result = message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } } }
        : message.method === 'tools/list' ? { tools: [] } : {};
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  const closed = await started(t, { id: 'ws', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/mcpl`, reconnect: true, reconnectIntervalMs: 60_000 }, scratch);
  await waitFor('the socket', () => sockets.length > 0);
  sockets[0]!.close(4000, 'not now');
  await waitFor('its end reported', () => closed.failed().length >= 1);
  assert.equal(closed.failed()[0]!.attempt, 0);
  assert.match(String(closed.failed()[0]!.error), /^connected, then closed after \d+(\.\d)? s \(close code 4000\)$/);
});

for (const [label, fields] of [
  ['reconnect off', { reconnect: false, reconnectIntervalMs: 0 }],
  ['reconnect left out', { reconnectIntervalMs: 0, reconnectMaxIntervalMs: -1 }],
  ['a numeric string, with reconnect on', { reconnect: true, reconnectIntervalMs: '300000' }],
] as const) {
  test(`a timing that relaunches nothing loads: ${label}`, { timeout: 30_000 }, async (t) => {
    const scratch = scratchDir('loads');
    const { reconnect: _reconnect, reconnectIntervalMs: _interval, ...base } = server('legacy', 'loads', scratch);
    const config = { ...base, ...fields } as McplServerConfig;
    const loads = await started(t, config, scratch);
    assert.equal(loads.launches().length, 1);
  });
}

for (const engine of ['legacy', 'modern'] as const) {
  test(`${engine}: a restart to a reconnect interval of 0 is refused before the running server is torn down`, { timeout: 30_000 }, async (t) => {
    const scratch = scratchDir('restart');
    const { reconnect: _reconnect, reconnectIntervalMs: _interval, ...config } = server(engine, 'live', scratch);
    const live = await started(t, config, scratch);
    await waitFor('launch 0', () => live.launches().length >= 1);
    await assert.rejects(live.framework.restartMcplServer('live', { ...config, reconnect: true, reconnectIntervalMs: 0 }), /"live".*reconnectIntervalMs.*\(got 0\)/);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(live.launches().length, 1);
    assert.doesNotThrow(() => process.kill(live.launches()[0]!.pid, 0), 'the running server was torn down');
  });
}

test('connectMcplServer refuses a reconnect interval of 0, on either engine, before it launches anything', { timeout: 30_000 }, async (t) => {
  const scratch = scratchDir('connect');
  const { reconnect: _reconnect, reconnectIntervalMs: _interval, ...config } = server('legacy', 'live', scratch);
  const live = await started(t, config, scratch);
  await waitFor('launch 0', () => live.launches().length >= 1);
  for (const engine of ['legacy', 'modern'] as const) {
    const id = `added-${engine}`;
    await assert.rejects(live.framework.connectMcplServer({ ...server(engine, id, scratch), reconnectIntervalMs: 0 }), new RegExp(`"${id}".*reconnectIntervalMs.*\\(got 0\\)`));
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(live.launches().length, 1, 'nothing launched for either');
});
