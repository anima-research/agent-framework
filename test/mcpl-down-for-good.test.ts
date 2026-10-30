import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { AgentFramework } from '../src/framework.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { setStdioLineBoundForTests } from '../src/mcpl/transport.js';
import { createMockResponse, HeldStream, MockMembrane } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

const LEGACY_FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));
const MODERN_FIXTURE = fileURLToPath(new URL('./fixtures/modern-mcp-server.mjs', import.meta.url));
const RAW_FIXTURE = fileURLToPath(new URL('./fixtures/modern-raw-server.mjs', import.meta.url));

const hook = process.env.CONNECTOME_OPS_WEBHOOK;
before(() => { process.env.CONNECTOME_OPS_WEBHOOK = 'http://127.0.0.1:9/ops'; });
after(() => {
  if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK;
  else process.env.CONNECTOME_OPS_WEBHOOK = hook;
});

const failsWith = (line: string) =>
  `console.error(${JSON.stringify(line)}); process.stdin.once('data', () => process.exit(1))`;

type Trace = Record<string, unknown> & { type: string };

interface Started {
  framework: AgentFramework;
  membrane: MockMembrane;
  traces: Trace[];
  logged: string[];
  posted: string[];
  dir: string;
}

let starting: Trace[] = [];

/** A framework with one server whose traces are recorded. With `hold`, a
 *  turn's model stream waits for it, so stop() waits too. */
async function start(t: TestContext, server: McplServerConfig, hold?: Promise<void>): Promise<Started> {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const posted: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    posted.push(JSON.parse(init.body).content);
    return new Response(null, { status: 204 });
  });
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-for-good-'));
  const traces: Trace[] = [];
  starting = traces;
  const membrane = new MockMembrane();
  if (hold) {
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      return new HeldStream(hold, [createMockResponse([{ type: 'text', text: 'done' }])]);
    };
  }
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [{
      name: 'watcher',
      async start() {},
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false }; },
      async onProcess(event: { type: string }) {
        return event.type === 'external-message'
          ? { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'hello' }] }], requestInference: true }
          : {};
      },
    } as never],
    maintenanceIntervalMs: 0,
    mcplServers: [server],
  });
  framework.onTrace((event) => traces.push(event as Trace), { replay: true });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { framework, membrane, traces, logged, posted, dir };
}

const downAlerts = (traces: Trace[]) => traces.filter((event) => event.type === 'ops:alert' && event.kind === 'mcpl-down');

async function waitFor(what: string, predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function legacyPid(events: string): Promise<number> {
  await waitFor("the fixture's first event", () => jsonLines(events).length > 0);
  return jsonLines<{ pid: number }>(events)[0]!.pid;
}

const lastStarted = (startLog: string) => Number(readFileSync(startLog, 'utf8').trim().split('\n').at(-1)!.split(' ')[1]);

test('a legacy server that fails at startup with no retry following is said to the operator once, by an mcpl-down alert without its stderr', { timeout: 30_000 }, async (t) => {
  const { traces, posted } = await start(t, {
    id: 'bridge', command: process.execPath, args: ['-e', failsWith('Error: getaddrinfo EAI_AGAIN gateway.example.invalid')],
  });
  const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.equal(failed?.willRetry, false);
  const alerts = downAlerts(traces);
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.equal(alerts[0]!.agentName, 'bridge');
  assert.equal(
    alerts[0]!.message,
    `MCPL server not connected at startup, and this host won't retry it on its own: ${failed?.error}`,
  );
  assert.equal(posted.length, 1);
  assert.ok(posted[0]!.endsWith(`mcpl-down: ${alerts[0]!.message}`), posted[0]);
  assert.ok(!posted[0]!.includes('EAI_AGAIN'), posted[0]);
});

test('a modern stdio server that fails at startup with no retry following is said to the operator once too', { timeout: 30_000 }, async (t) => {
  const { traces, posted } = await start(t, {
    id: 'bridge', command: process.execPath, args: ['-e', failsWith('Error: getaddrinfo EAI_AGAIN gateway.example.invalid')], protocol: 'modern',
  });
  const alerts = downAlerts(traces);
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.match(String(alerts[0]!.message), /^MCPL server not connected at startup, and this host won't retry it on its own: /);
  assert.equal(posted.length, 1);
  assert.ok(!posted[0]!.includes('EAI_AGAIN'), posted[0]);
});

test('a server that connected at startup but whose setup then failed raises no "not connected" alert, with or without reconnect', { timeout: 30_000 }, async (t) => {
  t.mock.method(AgentFramework.prototype as never, 'registerMcplServerFeatures' as never, (async () => { throw new Error('setup failed'); }) as never);
  for (const reconnect of [false, true]) {
    const { framework, traces } = await start(t, {
      id: 'live', command: process.execPath, args: [LEGACY_FIXTURE], enabledFeatureSets: ['chat'], ...(reconnect ? { reconnect: true } : {}),
    });
    const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
    assert.equal(failed?.willRetry, reconnect, `reconnect ${reconnect}`);
    assert.equal(framework.listMcplServers().find((server) => server.id === 'live')?.connected, true, `reconnect ${reconnect}`);
    assert.deepEqual(downAlerts(traces), [], `reconnect ${reconnect}`);
  }
});

test('a legacy server whose child exits during startup\'s setup, with reconnect, raises no alert at startup', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-setup-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = join(dir, 'events.jsonl');
  t.mock.method(AgentFramework.prototype as never, 'registerMcplServerFeatures' as never, (async () => {
    process.kill(await legacyPid(events), 'SIGKILL');
    await waitFor('the close', () => starting.some((event) => event.type === 'mcpl:server-closed'));
    throw new Error('setup failed: the server went away');
  }) as never);
  const { traces } = await start(t, {
    id: 'exits', command: process.execPath, args: [LEGACY_FIXTURE], env: { EVENTS_PATH: events }, enabledFeatureSets: ['chat'],
    reconnect: true, reconnectIntervalMs: 600_000,
  });
  assert.equal(traces.find((event) => event.type === 'mcpl:server-closed')?.signal, 'SIGKILL', JSON.stringify(traces.map((event) => event.type)));
  const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.equal(failed?.willRetry, true, JSON.stringify(traces.map((event) => event.type)));
  assert.deepEqual(downAlerts(traces), []);
});

test('a server that fails at startup and will be retried raises no alert at startup, in either engine', { timeout: 30_000 }, async (t) => {
  for (const protocol of ['legacy', 'modern'] as const) {
    const { traces } = await start(t, {
      id: `bridge-${protocol}`, command: process.execPath, args: ['-e', failsWith('down')], protocol,
      reconnect: true, reconnectIntervalMs: 600_000,
    });
    const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
    assert.equal(failed?.willRetry, true, protocol);
    assert.deepEqual(downAlerts(traces), [], protocol);
  }
});

test('a connected legacy server that closes on its own with no reconnect coming is said to the operator once', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const crash = join(dir, 'crash');
  const { traces, posted } = await start(t, {
    id: 'bridge', command: process.execPath, args: [LEGACY_FIXTURE], env: { CRASH_PATH: crash }, enabledFeatureSets: ['chat'],
  });
  assert.deepEqual(downAlerts(traces), []);
  writeFileSync(crash, '');
  await waitFor('the close', () => traces.some((event) => event.type === 'mcpl:server-closed'));
  const alerts = downAlerts(traces);
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.equal(alerts[0]!.agentName, 'bridge');
  assert.equal(alerts[0]!.message, "MCPL server closed (child process exited, code 9), and this host won't reconnect it on its own");
  assert.equal(posted.length, 1);
});

test('a legacy close alert names a signal that ended the child, and leaves out a WebSocket peer\'s close text', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-signal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = join(dir, 'events.jsonl');
  const killed = await start(t, { id: 'killed', command: process.execPath, args: [LEGACY_FIXTURE], env: { EVENTS_PATH: events }, enabledFeatureSets: ['chat'] });
  const pid = await legacyPid(events);
  process.kill(pid, 'SIGKILL');
  await waitFor('the alert', () => downAlerts(killed.traces).length > 0);
  assert.match(String(downAlerts(killed.traces)[0]!.message), /^MCPL server closed \(.*signal SIGKILL\), and this host won't reconnect it on its own$/);

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
  const dropped = await start(t, { id: 'dropped', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/mcpl` });
  await waitFor('the socket', () => sockets.length > 0);
  sockets[0]!.close(4000, 'the peer said this privately');
  await waitFor('the alert', () => downAlerts(dropped.traces).length > 0);
  assert.equal(downAlerts(dropped.traces)[0]!.message, "MCPL server closed (code 4000), and this host won't reconnect it on its own");
});

test('a connected server the host stops or restarts raises no alert, in either engine', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const server of [
    { id: 'legacy', command: process.execPath, args: [LEGACY_FIXTURE], enabledFeatureSets: ['chat'] },
    { id: 'modern', command: process.execPath, args: [MODERN_FIXTURE, join(dir, 'starts')], protocol: 'modern' as const },
  ]) {
    const restarted = await start(t, server);
    await restarted.framework.restartMcplServer(server.id);
    assert.ok(restarted.traces.some((event) => event.type === 'mcpl:server-closed'), `${server.id} restart closed it`);
    assert.deepEqual(downAlerts(restarted.traces), [], `${server.id} restart`);
    const stopped = await start(t, server);
    await stopped.framework.stop();
    assert.ok(stopped.traces.some((event) => event.type === 'mcpl:server-closed'), `${server.id} stop closed it`);
    assert.deepEqual(downAlerts(stopped.traces), [], `${server.id} stop`);
  }
});

test('a connected legacy server the host disconnects, or one that closes and reconnects, raises no alert', { timeout: 30_000 }, async (t) => {
  const removed = await start(t, { id: 'removed', command: process.execPath, args: [LEGACY_FIXTURE], enabledFeatureSets: ['chat'] });
  await removed.framework.disconnectMcplServer('removed');
  assert.ok(removed.traces.some((event) => event.type === 'mcpl:server-closed'));
  assert.deepEqual(downAlerts(removed.traces), []);

  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-reconnect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const crash = join(dir, 'crash');
  const back = await start(t, {
    id: 'back', command: process.execPath, args: [LEGACY_FIXTURE], env: { CRASH_PATH: crash }, enabledFeatureSets: ['chat'],
    reconnect: true, reconnectIntervalMs: 50,
  });
  writeFileSync(crash, '');
  await waitFor('the reconnect', () => back.traces.some((event) => event.type === 'mcpl:server-reconnected'));
  assert.deepEqual(downAlerts(back.traces), []);
});

test('a connected modern stdio server that closes on its own with no reconnect coming is said to the operator once, and one the host disconnects is not', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-modern-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const startLog = join(dir, 'starts');
  const lost = await start(t, { id: 'lost', command: process.execPath, args: [MODERN_FIXTURE, startLog], protocol: 'modern' });
  process.kill(lastStarted(startLog), 'SIGKILL');
  await waitFor('the alert', () => downAlerts(lost.traces).length > 0);
  const alerts = downAlerts(lost.traces);
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.equal(alerts[0]!.message, "MCP server closed (child process exited, signal SIGKILL), and this host won't reconnect it on its own");
  const closed = lost.traces.find((event) => event.type === 'mcpl:server-closed');
  assert.equal(closed?.signal, 'SIGKILL');

  const removedLog = join(dir, 'removed-starts');
  const removed = await start(t, { id: 'removed', command: process.execPath, args: [MODERN_FIXTURE, removedLog], protocol: 'modern' });
  await removed.framework.disconnectMcplServer('removed');
  assert.ok(removed.traces.some((event) => event.type === 'mcpl:server-closed'));
  assert.deepEqual(downAlerts(removed.traces), []);

  const backLog = join(dir, 'back-starts');
  const back = await start(t, { id: 'back', command: process.execPath, args: [MODERN_FIXTURE, backLog], protocol: 'modern', reconnect: true, reconnectIntervalMs: 50 });
  process.kill(lastStarted(backLog), 'SIGKILL');
  await waitFor('the reconnect', () => back.traces.some((event) => event.type === 'mcpl:server-reconnected'));
  assert.deepEqual(downAlerts(back.traces), []);
});

test("a modern stdio server's failed first connect logs and traces the last of its stderr, redacted, with or without a retry to follow", { timeout: 30_000 }, async (t) => {
  for (const reconnect of [false, true]) {
    const { traces, logged } = await start(t, {
      id: `needs-token-${reconnect}`, command: process.execPath, protocol: 'modern',
      args: ['-e', `console.error('fatal: DISCORD_TOKEN ' + process.env.DISCORD_TOKEN + ' was refused'); process.stdin.once('data', () => process.exit(1))`],
      env: { DISCORD_TOKEN: 'tok-0123456789abcdef' },
      ...(reconnect ? { reconnect: true, reconnectIntervalMs: 50, reconnectMaxIntervalMs: 50 } : {}),
    });
    const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
    assert.equal(failed?.stderrTail, 'fatal: DISCORD_TOKEN redacted was refused', `reconnect ${reconnect}`);
    if (reconnect) {
      await waitFor('a failed retry', () => traces.some((event) => event.type === 'mcpl:server-connect-failed' && event.attempt === 1));
      const retry = traces.find((event) => event.type === 'mcpl:server-connect-failed' && event.attempt === 1);
      assert.equal(retry?.stderrTail, 'fatal: DISCORD_TOKEN redacted was refused');
    }
    const opening = reconnect ? `MCP server "needs-token-true" initial connect failed, will retry` : 'Failed to connect MCPL server "needs-token-false"';
    assert.ok(
      logged.some((line) => line.startsWith(opening) && line.endsWith('stderr: "fatal: DISCORD_TOKEN redacted was refused"')),
      logged.join('\n'),
    );
    assert.ok(!logged.join('\n').includes('tok-0123456789abcdef'));
    assert.ok(!JSON.stringify(downAlerts(traces)).includes('was refused'));
  }
});

test("a modern stdio server that closes while its first connect subscribes logs and traces the last of its stderr too", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-listen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `echo 'fatal: the bridge lost its gateway' >&2; exec "$0" "$1" exit-on-listen-first "$2"`;
  const { traces, logged } = await start(t, {
    id: 'raw', command: '/bin/sh', protocol: 'modern',
    args: ['-c', script, process.execPath, RAW_FIXTURE, join(dir, 'log.jsonl')],
  });
  const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.match(String(failed?.error), /closed its connection while connecting/);
  assert.equal(failed?.stderrTail, 'fatal: the bridge lost its gateway');
  assert.ok(
    logged.some((line) => line.startsWith('Failed to connect MCPL server "raw"') && line.endsWith('stderr: "fatal: the bridge lost its gateway"')),
    logged.join('\n'),
  );
});

test("a modern stdio server's failed first connect waits for its stderr to end, so a line a process sharing it writes after the exit is in its tail", { timeout: 30_000 }, async (t) => {
  const sharer = "const pid = ' + process.pid + '; const t = setInterval(() => { try { process.kill(pid, 0) } catch { clearInterval(t); process.stderr.write(\\'written after the exit\\', () => require(\\'fs\\').closeSync(2)) } }, 5)";
  const { traces } = await start(t, {
    id: 'shares-stderr', command: process.execPath, protocol: 'modern',
    args: ['-e', [
      "console.error('fatal: DISCORD_TOKEN is not set')",
      `require('child_process').spawn(process.execPath, ['-e', '${sharer}'], { stdio: ['ignore', 'ignore', 'inherit'] })`,
      "process.stdin.once('data', () => process.exit(1))",
    ].join('; ')],
  });
  const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.equal(failed?.stderrTail, 'fatal: DISCORD_TOKEN is not set\nwritten after the exit');
});

test("a modern stdio server's retry that ends in a version verdict carries the last of its stderr, and alerts once", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'log.jsonl');
  const script = `echo 'fatal: this build speaks another revision' >&2; exec "$0" "$1" other-revision-later "$2"`;
  const { traces } = await start(t, {
    id: 'verdict', command: '/bin/sh', protocol: 'modern', reconnect: true, reconnectIntervalMs: 50,
    args: ['-c', script, process.execPath, RAW_FIXTURE, log],
  });
  const first = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as { pid: number };
  process.kill(first.pid, 'SIGTERM');
  await waitFor('the verdict', () => downAlerts(traces).length > 0);
  const failed = traces.filter((event) => event.type === 'mcpl:server-connect-failed');
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.equal(failed[0]!.attempt, 1);
  assert.equal(failed[0]!.willRetry, false);
  assert.equal(failed[0]!.stderrTail, 'fatal: this build speaks another revision');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(downAlerts(traces).length, 1, JSON.stringify(downAlerts(traces)));
});

test("a modern stdio server refused at its first connect for its protocol revision carries the last of its stderr", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-revision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `echo 'fatal: this build speaks another revision' >&2; exec "$0" "$1" other-revision "$2"`;
  const { traces } = await start(t, {
    id: 'revision', command: '/bin/sh', protocol: 'modern',
    args: ['-c', script, process.execPath, RAW_FIXTURE, join(dir, 'log.jsonl')],
  });
  const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.equal(failed?.willRetry, false);
  assert.equal(failed?.stderrTail, 'fatal: this build speaks another revision');
  assert.equal(downAlerts(traces).length, 1, JSON.stringify(downAlerts(traces)));
});

/** A server of either engine whose child, on SIGTERM, runs `onTerm` (as a
 *  server that catches the signal does), or dies by it when there's none. */
function connectedServer(engine: 'legacy' | 'modern', id: string, dir: string, onTerm?: string, module?: string): { config: McplServerConfig; pid: () => Promise<number> } {
  const preload = [
    ...(onTerm === undefined ? [] : ['--import', `data:text/javascript,process.on("SIGTERM",()=>{${onTerm}})`]),
    ...(module === undefined ? [] : ['--import', `data:text/javascript,${encodeURIComponent(module)}`]),
  ];
  if (engine === 'legacy') {
    const events = join(dir, `${id}.jsonl`);
    return {
      config: { id, command: process.execPath, args: [...preload, LEGACY_FIXTURE], env: { EVENTS_PATH: events }, enabledFeatureSets: ['chat'] },
      pid: () => legacyPid(events),
    };
  }
  const starts = join(dir, `${id}.starts`);
  return { config: { id, command: process.execPath, args: [...preload, MODERN_FIXTURE, starts], protocol: 'modern' }, pid: async () => lastStarted(starts) };
}

/** The child gets `signal`, and once its loss is handled, as when a service
 *  manager signals the host and its children together and the host's stop()
 *  comes after, the host stops. */
async function lostThenStopped(t: TestContext, engine: 'legacy' | 'modern', id: string, signal: NodeJS.Signals, onTerm?: string): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-ended-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = connectedServer(engine, id, dir, onTerm);
  const started = await start(t, server.config);
  process.kill(await server.pid(), signal);
  await waitFor('the loss', () => started.traces.some((event) => event.type === 'mcpl:server-closed'));
  if (engine === 'modern') {
    const servers = (started.framework as unknown as { modernServers(): Map<string, unknown> }).modernServers();
    await waitFor('its reap', () => !servers.has(id));
  }
  await started.framework.stop();
  return started;
}

test('a connected server whose child ends as asked, by SIGTERM, SIGINT or SIGHUP, or by exiting 0, 143, 130 or 129, raises no alert, in either engine', { timeout: 90_000 }, async (t) => {
  for (const engine of ['legacy', 'modern'] as const) {
    for (const [ending, sent, onTerm, code, signal] of [
      ['dies by SIGTERM', 'SIGTERM', undefined, null, 'SIGTERM'],
      ['dies by SIGINT', 'SIGINT', undefined, null, 'SIGINT'],
      ['dies by SIGHUP', 'SIGHUP', undefined, null, 'SIGHUP'],
      ['catches SIGTERM and exits 0', 'SIGTERM', 'process.exit(0)', 0, null],
      ['exits 143, as a shell reports its child\'s SIGTERM', 'SIGTERM', 'process.exit(143)', 143, null],
      ['exits 130, as a shell reports its child\'s SIGINT', 'SIGTERM', 'process.exit(130)', 130, null],
      ['exits 129, as a shell reports its child\'s SIGHUP', 'SIGTERM', 'process.exit(129)', 129, null],
    ] as const) {
      const { traces } = await lostThenStopped(t, engine, `ended-${engine}-${code ?? signal}`, sent, onTerm);
      const closed = traces.find((event) => event.type === 'mcpl:server-closed');
      assert.deepEqual([closed?.code, closed?.signal], [code, signal], `${engine}, ${ending}`);
      assert.deepEqual(downAlerts(traces), [], `${engine}, ${ending}`);
    }
  }
});

test('a connected server whose child exits 1, or is killed by SIGKILL, is said to the operator once, in either engine', { timeout: 60_000 }, async (t) => {
  for (const engine of ['legacy', 'modern'] as const) {
    for (const [ending, signal, onTerm, how] of [
      ['exits 1', 'SIGTERM', 'process.exit(1)', 'code 1'],
      ['is killed by SIGKILL', 'SIGKILL', undefined, 'signal SIGKILL'],
    ] as const) {
      const id = `failed-${engine}-${signal}`;
      const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-failed-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const server = connectedServer(engine, id, dir, onTerm);
      const { traces } = await start(t, server.config);
      process.kill(await server.pid(), signal);
      await waitFor(`the alert: ${engine}, ${ending}`, () => downAlerts(traces).length > 0);
      const alerts = downAlerts(traces);
      assert.equal(alerts.length, 1, `${engine}, ${ending}: ${JSON.stringify(alerts)}`);
      assert.equal(alerts[0]!.message, `${engine === 'legacy' ? 'MCPL' : 'MCP'} server closed (child process exited, ${how}), and this host won't reconnect it on its own`);
    }
  }
});

/** On SIGUSR1 the child closes its stdin, says so on stderr, and asks the host
 *  a ping, so the host's next write meets a closed pipe while the child still
 *  runs. A modern host drops the ping, so the test calls a tool instead.
 *  /dev/null takes fd 0 at once, as libuv assumes fds 0 to 2 stay taken (see
 *  deafen() in fixtures/modern-raw-server.mjs): on macOS, with fd 0 left free,
 *  the child was aborted by libuv's assertion `fd > STDERR_FILENO` when its
 *  first stderr write opened that pipe. */
const DEAF_ON_USR1 = 'import { closeSync, openSync } from "node:fs"; process.on("SIGUSR1", () => { closeSync(0); openSync("/dev/null", "r"); process.stderr.write("deaf\\n"); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "deaf", method: "ping" }) + "\\n"); });';

test('a connected server whose child the transport ends after a pipe failure is said to the operator once, though it dies by SIGTERM, in either engine', { timeout: 90_000 }, async (t) => {
  for (const engine of ['legacy', 'modern'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-pipe-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const server = connectedServer(engine, `pipe-${engine}`, dir, undefined, DEAF_ON_USR1);
    const { framework, traces } = await start(t, server.config);
    process.kill(await server.pid(), 'SIGUSR1');
    await waitFor(`its stdin closed: ${engine}`, () => traces.some((event) => event.type === 'mcpl:server-stderr' && event.line === 'deaf'));
    if (engine === 'modern') void framework.executeToolCall({ id: 'write', name: `mcpl--pipe-${engine}--echo`, input: { text: 'x' } }).catch(() => {});
    await waitFor(`the loss: ${engine}`, () => traces.some((event) => event.type === 'mcpl:server-closed'));
    const closed = traces.find((event) => event.type === 'mcpl:server-closed');
    assert.equal(closed?.signal, 'SIGTERM', engine);
    assert.match(String(closed?.reason), /^child process exited, and this host had stopped using the server's stdio \(/, engine);
    await waitFor(`the alert: ${engine}`, () => downAlerts(traces).length > 0);
    const alerts = downAlerts(traces);
    assert.equal(alerts.length, 1, `${engine}: ${JSON.stringify(alerts)}`);
    assert.match(String(alerts[0]!.message), /closed \(child process exited, and this host had stopped using the server's stdio \(.+\), signal SIGTERM\), and this host won't reconnect it on its own$/, engine);
  }
});

const LONG_LINE_ON_USR2 = 'process.on("SIGUSR2", () => { process.stdout.write("x".repeat(65_537)); });';

test('a connected server whose child the transport ends after a line on stdout longer than the bound is said to the operator once, though it dies by SIGTERM, in either engine', { timeout: 90_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  for (const engine of ['legacy', 'modern'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-long-line-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const server = connectedServer(engine, `long-line-${engine}`, dir, undefined, LONG_LINE_ON_USR2);
    const { traces } = await start(t, server.config);
    process.kill(await server.pid(), 'SIGUSR2');
    await waitFor(`the loss: ${engine}`, () => traces.some((event) => event.type === 'mcpl:server-closed'));
    const closed = traces.find((event) => event.type === 'mcpl:server-closed');
    assert.deepEqual(
      { signal: closed?.signal, reason: closed?.reason },
      { signal: 'SIGTERM', reason: 'child process exited, and this host had stopped using the server\'s stdio (the server wrote a line on stdout longer than 65,536 UTF-16 code units)' },
      engine,
    );
    await waitFor(`the alert: ${engine}`, () => downAlerts(traces).length > 0);
    const alerts = downAlerts(traces);
    assert.equal(alerts.length, 1, `${engine}: ${JSON.stringify(alerts)}`);
    assert.equal(alerts[0]!.message, `${engine === 'legacy' ? 'MCPL' : 'MCP'} server closed (child process exited, and this host had stopped using the server's stdio (the server wrote a line on stdout longer than 65,536 UTF-16 code units), signal SIGTERM), and this host won't reconnect it on its own`, engine);
  }
});

test('a server whose child exits on its own, code 1, after stop() has begun and before its close, raises no alert, in either engine', { timeout: 60_000 }, async (t) => {
  const seen = [];
  for (const engine of ['legacy', 'modern'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-in-stop-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    const id = `in-stop-${engine}`;
    const server = connectedServer(engine, id, dir, 'process.exit(1)');
    const { framework, membrane, traces, posted } = await start(t, server.config, held);
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} } as never);
    await waitFor(`a model stream held open: ${engine}`, () => membrane.calls.length === 1);
    const stopping = framework.stop();
    process.kill(await server.pid(), 'SIGTERM');
    await waitFor(`the loss: ${engine}`, () => traces.some((event) => event.type === 'mcpl:server-closed'));
    if (engine === 'modern') {
      const servers = (framework as unknown as { modernServers(): Map<string, unknown> }).modernServers();
      await waitFor('its reap', () => !servers.has(id));
    }
    release();
    await stopping;
    const closed = traces.find((event) => event.type === 'mcpl:server-closed');
    seen.push({ engine, code: closed?.code, willReconnect: closed?.willReconnect, alerts: downAlerts(traces).length, posted: posted.length });
  }
  assert.deepEqual(seen, [
    { engine: 'legacy', code: 1, willReconnect: false, alerts: 0, posted: 0 },
    { engine: 'modern', code: 1, willReconnect: false, alerts: 0, posted: 0 },
  ]);
});

function stdioStopCauseOf(framework: AgentFramework, engine: 'legacy' | 'modern', id: string): Error | undefined {
  if (engine === 'modern') {
    type Modern = { session: { stdio: { stdioStopCause?: Error } | null } | null };
    return (framework as unknown as { modernServers(): Map<string, Modern> }).modernServers().get(id)?.session?.stdio?.stdioStopCause;
  }
  type Legacy = { transport: { stdioStopCause?: Error } | null };
  const registry = (framework as unknown as { mcplServerRegistry: { getServer(id: string): unknown } | null }).mcplServerRegistry;
  return (registry?.getServer(id) as Legacy | undefined)?.transport?.stdioStopCause;
}

/** The close names the pipe only if the host has its write's failure before
 *  it handles the child's exit, so the test sends the SIGTERM itself, once the
 *  host has recorded that failure. The exit must then be handled within
 *  STDIO_EXIT_GRACE_MS of the failure, or the transport ends the child itself
 *  and the close raises an alert. */
test('a server whose child dies by SIGTERM after the host\'s write to it failed raises no alert, in either engine', { timeout: 60_000 }, async (t) => {
  const seen = [];
  for (const engine of ['legacy', 'modern'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-down-written-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const id = `written-${engine}`;
    const server = connectedServer(engine, id, dir, undefined, DEAF_ON_USR1);
    const { framework, traces, posted } = await start(t, server.config);
    const pid = await server.pid();
    process.kill(pid, 'SIGUSR1');
    await waitFor(`its stdin closed: ${engine}`, () => traces.some((event) => event.type === 'mcpl:server-stderr' && event.line === 'deaf'));
    if (engine === 'modern') void framework.executeToolCall({ id: 'write', name: `mcpl--${id}--echo`, input: { text: 'x' } }).catch(() => {});
    await waitFor(`the host's failed write: ${engine}`, () => stdioStopCauseOf(framework, engine, id) !== undefined);
    process.kill(pid, 'SIGTERM');
    await waitFor(`the loss: ${engine}`, () => traces.some((event) => event.type === 'mcpl:server-closed'));
    if (engine === 'modern') {
      const servers = (framework as unknown as { modernServers(): Map<string, unknown> }).modernServers();
      await waitFor('its reap', () => !servers.has(id));
    }
    const closed = traces.find((event) => event.type === 'mcpl:server-closed');
    seen.push({ engine, signal: closed?.signal, writeFailed: /this host had stopped using the server's stdio/.test(String(closed?.reason)), alerts: downAlerts(traces).length, posted: posted.length });
  }
  assert.deepEqual(seen, [
    { engine: 'legacy', signal: 'SIGTERM', writeFailed: true, alerts: 0, posted: 0 },
    { engine: 'modern', signal: 'SIGTERM', writeFailed: true, alerts: 0, posted: 0 },
  ]);
});
