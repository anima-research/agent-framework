import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

import { AgentFramework } from '../src/framework.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { createMockResponse, HeldStream, MockMembrane } from './helpers/mock-membrane.js';

const LEGACY_FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));
const MODERN_FIXTURE = fileURLToPath(new URL('./fixtures/modern-mcp-server.mjs', import.meta.url));

type Trace = Record<string, unknown> & { type: string };
type Lost = 'before' | 'during' | 'at start';

async function waitFor(what: string, predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A server of either engine with reconnect, behind a shell that records each
 *  launch's pid as it spawns; 'at start', every launch fails before its
 *  handshake. A model stream holds the framework's stop() until released.
 *  Returns the launches when stop() began and once it had settled. */
async function stopHeld(t: TestContext, engine: 'legacy' | 'modern', lost: Lost, holdMs: number) {
  t.mock.method(console, 'error', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-no-reconnect-after-stop-'));
  const launchLog = join(dir, 'launches');
  const pids = () => (existsSync(launchLog) ? readFileSync(launchLog, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
  // A launch's shell writes its pid once it runs, so one spawned just before
  // stop() may write it after the count is taken: the launches running then
  // are counted too, by their command line.
  const running = (): number[] => {
    try {
      return execFileSync('pgrep', ['-f', launchLog.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { encoding: 'utf8' })
        .split('\n').filter(Boolean).map(Number);
    } catch (err) {
      // pgrep exits 1 when no process matches.
      if ((err as { status?: number }).status === 1) return [];
      throw err;
    }
  };
  const launched = new Set<number>();
  const count = (also: number[] = []) => { for (const pid of [...pids(), ...also]) launched.add(pid); return launched.size; };
  t.after(() => {
    for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  const run = lost === 'at start'
    ? 'exit 1'
    : `exec "$0" ${engine === 'legacy' ? `"${LEGACY_FIXTURE}"` : `"${MODERN_FIXTURE}" "${join(dir, 'modern-starts')}"`}`;
  const server: McplServerConfig = {
    id: 'bridge',
    command: '/bin/sh',
    args: ['-c', `echo $$ >> "${launchLog}"; ${run}`, process.execPath],
    ...(engine === 'legacy' ? { enabledFeatureSets: ['chat'] } : { protocol: 'modern' as const }),
    reconnect: true,
    reconnectIntervalMs: 50,
    reconnectMaxIntervalMs: 50,
  };
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const membrane = new MockMembrane();
  membrane.streamYielding = (request) => {
    membrane.calls.push(request);
    return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'done' }])]);
  };
  const traces: Trace[] = [];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [{
      name: 'watcher',
      async start(ctx: { onTrace(listener: (event: unknown) => void): void }) { ctx.onTrace((event) => traces.push(event as Trace)); },
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
  await waitFor('the first launch', () => pids().length >= 1);
  framework.start();
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} } as never);
  await waitFor('a model stream held open', () => membrane.calls.length === 1);
  const lose = async () => {
    process.kill(pids()[0]!, 'SIGTERM');
    await waitFor('the loss', () => traces.some((event) => event.type === 'mcpl:server-closed'));
  };
  if (lost === 'before') await lose();
  const stopping = framework.stop();
  const atStop = count(running());
  if (lost === 'during') await lose();
  setTimeout(release, holdMs);
  await stopping;
  return { atStop, after: count(), reconnected: traces.filter((event) => event.type === 'mcpl:server-reconnected').length };
}

test('once stop() has begun, a server with reconnect launches no child again, in either engine: lost before the stop, lost during it, or failing since its start', { timeout: 90_000 }, async (t) => {
  const seen = [];
  for (const lost of ['before', 'during', 'at start'] as const) {
    for (const engine of ['legacy', 'modern'] as const) {
      const { atStop, after, reconnected } = await stopHeld(t, engine, lost, 300);
      seen.push({ engine, lost, launchedDuringStop: after - atStop, reconnected });
    }
  }
  assert.deepEqual(seen, (['before', 'during', 'at start'] as const).flatMap((lost) => (['legacy', 'modern'] as const).map((engine) => ({
    engine, lost, launchedDuringStop: 0, reconnected: 0,
  }))));
});

test("once stop() has begun, a legacy reconnect still waiting on its access provider doesn't dial when the provider answers", { timeout: 30_000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-no-reconnect-after-stop-ws-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  await new Promise<void>((resolve) => (wss.address() ? resolve() : wss.once('listening', () => resolve())));
  const sockets: WebSocket[] = [];
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
  let providerCalls = 0;
  let answer!: (token: string) => void;
  const later = new Promise<string>((resolve) => { answer = resolve; });
  const accessProvider = async () => (++providerCalls === 1 ? 'first' : later);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => { release(); answer('late'); });
  const membrane = new MockMembrane();
  membrane.streamYielding = (request) => {
    membrane.calls.push(request);
    return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'done' }])]);
  };
  const traces: Trace[] = [];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [{
      name: 'watcher',
      async start(ctx: { onTrace(listener: (event: unknown) => void): void }) { ctx.onTrace((event) => traces.push(event as Trace)); },
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
    mcplServers: [{ id: 'remote', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/mcpl`, accessProvider, reconnect: true, reconnectIntervalMs: 50 }],
  });
  await waitFor('the first dial', () => sockets.length === 1);
  framework.start();
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} } as never);
  await waitFor('a model stream held open', () => membrane.calls.length === 1);
  sockets[0]!.close(1011, 'going away');
  await waitFor('the retry asking its provider', () => providerCalls === 2);
  const stopping = framework.stop();
  answer('second');
  setTimeout(release, 300);
  await stopping;
  assert.deepEqual({ dials: sockets.length, reconnected: traces.filter((event) => event.type === 'mcpl:server-reconnected').length }, { dials: 1, reconnected: 0 });
});
