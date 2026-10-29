import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, Membrane } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

const FIXTURE = [
  join(import.meta.dirname, 'fixtures/flaky-mcpl-server.mjs'),
  join(import.meta.dirname, '../../test/fixtures/flaky-mcpl-server.mjs'),
].find((p) => existsSync(p))!;

const STOPPED = { code: -32000, message: 'the host stopped while handling this request' };

const until = async (check: () => boolean, what: string, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function silentProvider() {
  let sent = 0;
  let dropped = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (String(req.url).includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      sent += 1;
      res.on('close', () => { dropped += 1; });
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent: () => sent,
    dropped: () => dropped,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Internals = {
  initializeMcpl(servers: unknown[], routing: unknown): Promise<void>;
  inferenceRouter: Record<string, unknown>;
  wireMcplEvents(connection: unknown, config: unknown): void;
};

async function hostWithRouter(membrane: Membrane): Promise<AgentFramework> {
  const fw = await AgentFramework.create({
    storePath: join(mkdtempSync(join(tmpdir(), 'af-inference-abort-')), 'store'),
    membrane,
    agents: [{ name: 'assistant', model: 'claude-opus-5-5', systemPrompt: 'test' }],
    modules: [],
  });
  const internals = fw as unknown as Internals;
  await internals.initializeMcpl([], { default: 'claude-opus-5-5' });
  internals.inferenceRouter.featureSetManager = { validateInbound: () => {} };
  return fw;
}

const membraneFor = (base: string) =>
  new Membrane(new AnthropicAdapter({ apiKey: 'test-key', baseURL: base, cacheKeepalive: { enabled: false } } as never));

const request = (stream: boolean) => ({
  featureSet: 'memory.consolidation',
  stream,
  messages: [{ role: 'user', content: 'Summarize.' }],
  preferences: { maxTokens: 100 },
});

function registeredConnection(fw: AgentFramework) {
  const connection = Object.assign(new EventEmitter(), {
    id: 'srv',
    closed: false,
    stopReconnecting: () => {},
    close: async () => { connection.closed = true; },
  });
  const internals = fw as unknown as Internals & { mcplServerRegistry: { servers: Map<string, unknown> } };
  internals.mcplServerRegistry.servers.set('srv', connection);
  internals.wireMcplEvents(connection, { id: 'srv', url: 'wss://h/mcp?token=wireToken0123456789' });
  return connection;
}

let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => {});
  cleanup = [];
});

describe("an MCPL server's inference request the host stops", () => {
  for (const stream of [false, true]) {
    it(`stop() drops a ${stream ? 'streamed' : 'non-streamed'} request's provider call, and answers it as stopped before it closes the connection`, async () => {
      const provider = await silentProvider();
      cleanup.push(provider.close);
      const fw = await hostWithRouter(membraneFor(provider.base));
      const failures: string[] = [];
      fw.onTrace((event) => {
        const traced = event as { type: string; error?: unknown };
        if (traced.type === 'mcpl:inference_fail') failures.push(String(traced.error));
      });
      const connection = registeredConnection(fw);
      const answers: Array<{ beforeClose: boolean; result?: unknown; error?: { code: number; message: string } }> = [];
      connection.emit('inference-request', request(stream), {
        id: 7,
        respond: (result: unknown) => answers.push({ beforeClose: !connection.closed, result }),
        respondError: (code: number, message: string) => answers.push({ beforeClose: !connection.closed, error: { code, message } }),
        sendChunk: () => {},
      });
      await until(() => provider.sent() === 1, 'the provider call');

      await fw.stop();

      assert.equal(connection.closed, true, 'stop() closed the connection');
      assert.deepEqual(answers, [{ beforeClose: true, error: STOPPED }]);
      assert.deepEqual(failures, [STOPPED.message]);
      await until(() => provider.dropped() === 1, 'the provider call to be dropped', 2_000);
    });
  }

  it("a provider call that doesn't end on the abort holds stop() only to its budget, which names the request's server, and its late result goes nowhere", async () => {
    const fw = await hostWithRouter(membraneFor('http://127.0.0.1:9'));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let called = false;
    const router = (fw as unknown as Internals).inferenceRouter;
    router.membrane = {
      complete: async () => { called = true; await released; return createMockResponse([{ type: 'text', text: 'late' }]); },
    };
    cleanup.push(async () => { release(); await fw.stop(); });
    const traced: string[] = [];
    fw.onTrace((event) => {
      const { type } = event as { type: string };
      if (type.startsWith('mcpl:inference_') || type === 'mcpl:request-handler-error') traced.push(type);
    });
    const connection = registeredConnection(fw);
    const answers: Array<{ result?: unknown; error?: { code: number; message: string } }> = [];
    connection.emit('inference-request', request(false), {
      id: 7,
      respond: (result: unknown) => answers.push({ result }),
      respondError: (code: number, message: string) => answers.push({ error: { code, message } }),
    });
    await until(() => called, 'the provider call');

    const started = Date.now();
    await assert.rejects(fw.stop(300), (error: Error) => {
      assert.match(error.message, /^Shutdown timed out after 300 ms; pending: inference\/request:srv$/);
      return true;
    });
    const took = Date.now() - started;
    assert.ok(took >= 300 && took < 1_000, `stop() took ${took} ms`);

    release();
    await until(() => (router.running as Set<unknown>).size === 0, 'the request to end');
    assert.deepEqual(answers, [{ error: STOPPED }]);
    assert.deepEqual(traced, ['mcpl:inference_start', 'mcpl:inference_fail']);
  });

  it("a stop answer whose write throws is reported as the request handler's failure, and stop() still ends", async () => {
    const provider = await silentProvider();
    cleanup.push(provider.close);
    const fw = await hostWithRouter(membraneFor(provider.base));
    const handlerErrors: string[] = [];
    fw.onTrace((event) => {
      const traced = event as { type: string; error?: unknown };
      if (traced.type === 'mcpl:request-handler-error') handlerErrors.push(String(traced.error));
    });
    const connection = registeredConnection(fw);
    connection.emit('inference-request', request(false), {
      id: 7,
      respond: () => {},
      respondError: () => { throw new Error('the connection is gone'); },
    });
    await until(() => provider.sent() === 1, 'the provider call');

    await fw.stop();

    await until(() => handlerErrors.length === 1, 'the handler failure');
    assert.deepEqual(handlerErrors, ['the connection is gone']);
  });
});

describe("an MCPL server's inference request whose transport closes", () => {
  const TMP_DIR = join(import.meta.dirname, '../.test-tmp-inference-abort');
  const FLAG_FILE = join(TMP_DIR, 'server-healthy');
  const HOST_CAPS: McplHostCapabilities = { version: '0.5', pushEvents: true, contextHooks: { beforeInference: true }, featureSets: true };

  it("a disconnect mid-inference drops the request's provider call, and its trace says the transport closed", async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    cleanup.push(async () => rmSync(TMP_DIR, { recursive: true, force: true }));
    writeFileSync(FLAG_FILE, '');
    const provider = await silentProvider();
    cleanup.push(provider.close);
    const fw = await hostWithRouter(membraneFor(provider.base));
    cleanup.push(() => fw.stop());
    const failures: string[] = [];
    fw.onTrace((event) => {
      const traced = event as { type: string; error?: unknown };
      if (traced.type === 'mcpl:inference_fail') failures.push(String(traced.error));
    });
    const config: McplServerConfig = { id: 'flaky', command: process.execPath, args: [FIXTURE, FLAG_FILE], reconnect: false };
    const connection = await McplServerConnection.connect(config, HOST_CAPS);
    cleanup.push(() => connection.close());
    connection.establishGrant(new CapabilityGrant(new Set(['inferenceRequest']), []));
    (fw as unknown as Internals).wireMcplEvents(connection, config);
    connection.ready();
    (connection as unknown as { transport: EventEmitter }).transport
      .emit('line', JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'inference/request', params: request(false) }));
    await until(() => provider.sent() === 1, 'the provider call');

    connection.sendToolsList().catch(() => {});

    await until(() => provider.dropped() === 1, 'the provider call to be dropped', 2_000);
    await until(() => failures.length === 1, 'the failure trace');
    assert.deepEqual(failures, ['the transport the request came on closed']);
  });
});
