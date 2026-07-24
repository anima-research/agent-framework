/**
 * RelayClientModule — the outbound relay client (framework agents → external
 * TTS relay, ChapterX-style).
 *
 * Unit half: an in-process mock /bot server covers auth, message forwarding
 * with the connection's bot identity, heartbeat tolerance, interruption →
 * abortInference(keepText) with the staleness guard and channel-addressing
 * rules, reconnect with backoff (including the replaced-connection stop and
 * the stability-gated backoff reset), channel-tracking bounds, and
 * drop-when-down.
 *
 * E2E half (skipped when the reference repo is absent): spawns the REAL
 * melodeus-tts-relay, runs a REAL AgentFramework with the module installed,
 * and asserts a VoiceClientSim on the relay's /tts side hears a framework
 * agent's streamed turn — then interrupts it back through the same path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

import { AgentFramework } from '../src/framework.js';
import { RelayClientModule } from '../src/modules/voice-relay/index.js';
import type { RelayLogger } from '../src/modules/voice-relay/types.js';
import type { TraceEvent } from '../src/types/trace.js';
import type { ModuleContext, Module } from '../src/types/module.js';
import type { ProcessEvent } from '../src/types/events.js';
import type { ContentBlock } from '@animalabs/membrane';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import {
  VoiceClientSim,
  TOKENS,
  writeRelayConfig,
  referenceRelayAvailable,
  spawnReferenceRelay,
} from './helpers/voice-relay-sims.js';

const silentLogger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Mock /bot relay server
// ---------------------------------------------------------------------------

interface MockBotServer {
  url: string;
  connections: number;
  received: Array<Record<string, unknown>>;
  authedSockets: WsSocket[];
  rejectAuth: boolean;
  close(): Promise<void>;
}

async function startMockBotServer(): Promise<MockBotServer> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const state: MockBotServer = {
    url: '',
    connections: 0,
    received: [],
    authedSockets: [],
    rejectAuth: false,
    close: async () => {
      for (const ws of state.authedSockets) ws.terminate();
      wss.close();
      await new Promise((r) => http.close(r));
    },
  };

  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/bot') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.connections++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'auth') {
          if (state.rejectAuth) {
            ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
            ws.close(4003, 'Invalid token');
            return;
          }
          state.authedSockets.push(ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          return;
        }
        state.received.push(msg);
      });
    });
  });

  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  state.url = `ws://127.0.0.1:${addr.port}`;
  return state;
}

/** Minimal ModuleContext: the client module only uses onTrace. */
function stubCtx(): { ctx: ModuleContext; emit: (e: TraceEvent) => void } {
  const listeners: Array<(e: TraceEvent) => void> = [];
  const ctx = {
    onTrace: (l: (e: TraceEvent) => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  } as unknown as ModuleContext;
  return { ctx, emit: (e) => [...listeners].forEach((l) => l(e)) };
}

function fakeFramework(): {
  framework: AgentFramework;
  aborts: Array<{ agentName: string; reason?: string; keepText?: string }>;
} {
  const aborts: Array<{ agentName: string; reason?: string; keepText?: string }> = [];
  const framework = {
    abortInference: (agentName: string, opts?: string | { reason?: string; keepText?: string }) => {
      const o = typeof opts === 'string' ? { reason: opts } : opts ?? {};
      aborts.push({ agentName, reason: o.reason, keepText: o.keepText });
      return true;
    },
  } as unknown as AgentFramework;
  return { framework, aborts };
}

async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const T0 = 1_710_900_000_000;

function startedTrace(agentName: string, channelId?: string): TraceEvent {
  return { type: 'inference:started', agentName, channelId, timestamp: T0 } as TraceEvent;
}

// ---------------------------------------------------------------------------
// Unit: mock server
// ---------------------------------------------------------------------------

test('relay client auths and forwards messages under its own bot identity', async () => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    username: 'Opus 4.5',
    logger: silentLogger,
  });
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  emit(startedTrace('assistant', 'chan-1'));
  emit({
    type: 'inference:content_block',
    agentName: 'assistant',
    channelId: 'chan-1',
    phase: 'block_start',
    blockType: 'text',
    blockIndex: 0,
    timestamp: T0,
  } as TraceEvent);
  emit({
    type: 'inference:tokens',
    agentName: 'assistant',
    channelId: 'chan-1',
    content: 'Hello ',
    blockType: 'text',
    blockIndex: 0,
    timestamp: T0,
  } as TraceEvent);
  emit({
    type: 'inference:tokens',
    agentName: 'assistant',
    channelId: 'chan-1',
    content: 'world',
    blockType: 'text',
    blockIndex: 0,
    timestamp: T0,
  } as TraceEvent);
  emit({
    type: 'inference:content_block',
    agentName: 'assistant',
    channelId: 'chan-1',
    phase: 'block_complete',
    blockType: 'text',
    blockIndex: 0,
    timestamp: T0,
  } as TraceEvent);
  emit({ type: 'inference:completed', agentName: 'assistant', channelId: 'chan-1', durationMs: 5, timestamp: T0 } as TraceEvent);

  await waitFor(() => server.received.length >= 6, 3000, 'relay messages');
  const types = server.received.map((m) => m.type);
  assert.deepEqual(types, [
    'activation_start',
    'block_start',
    'chunk',
    'chunk',
    'block_complete',
    'activation_end',
  ]);
  for (const m of server.received) {
    assert.equal(m.botId, 'opus45', 'botId on the wire is the connection identity, not agentName');
    assert.equal(m.username, 'Opus 4.5');
    assert.equal(m.channelId, 'chan-1');
  }
  const complete = server.received.find((m) => m.type === 'block_complete');
  assert.equal(complete?.content, 'Hello world');
  const end = server.received.find((m) => m.type === 'activation_end');
  assert.equal(end?.reason, 'complete');

  await module.stop();
  await server.close();
});

test('relay client ignores heartbeats and drops relay traffic while down', async () => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    reconnectInitialMs: 50_000, // long: keep it down after close
    logger: silentLogger,
  });
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  server.authedSockets[0].send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(module.isConnected, true, 'heartbeat does not disturb the connection');

  // Sever, then emit traces while down: dropped without error, none delivered.
  server.authedSockets[0].terminate();
  await waitFor(() => !module.isConnected, 3000, 'disconnect noticed');
  emit(startedTrace('assistant', 'chan-1'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.received.length, 0);

  await module.stop();
  await server.close();
});

test('relay client reconnects with backoff and re-authenticates', async () => {
  const server = await startMockBotServer();
  const { ctx } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    reconnectInitialMs: 30,
    reconnectMaxMs: 200,
    logger: silentLogger,
  });
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'first auth');
  assert.equal(server.connections, 1);

  server.authedSockets[0].terminate();
  await waitFor(() => server.connections >= 2 && module.isConnected, 3000, 'reconnect + re-auth');

  await module.stop();
  await server.close();
});

test('relay client keeps retrying after auth rejection', async () => {
  const server = await startMockBotServer();
  server.rejectAuth = true;
  const { ctx } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'bad',
    reconnectInitialMs: 20,
    reconnectMaxMs: 100,
    logger: silentLogger,
  });
  await module.start(ctx);
  await waitFor(() => server.connections >= 3, 3000, 'repeated attempts');
  assert.equal(module.isConnected, false);

  server.rejectAuth = false;
  await waitFor(() => module.isConnected, 3000, 'recovers once auth allowed');

  await module.stop();
  await server.close();
});

test('interruption from the relay maps to abortInference with keepText', async () => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    logger: silentLogger,
  });
  module.bind(framework);
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  emit(startedTrace('assistant', 'chan-9'));
  server.authedSockets[0].send(
    JSON.stringify({
      type: 'interruption',
      channelId: 'chan-9',
      spokenText: 'Hey! Yes, I can hear',
      reason: 'user_speech',
      timestamp: T0,
    }),
  );

  await waitFor(() => aborts.length === 1, 3000, 'abortInference call');
  assert.deepEqual(aborts[0], {
    agentName: 'assistant',
    reason: 'user_speech',
    keepText: 'Hey! Yes, I can hear',
  });

  // Unknown channel with several candidates → dropped, no spurious abort.
  emit(startedTrace('other-agent', 'chan-other'));
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-unknown', spokenText: 'x', reason: 'manual', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(aborts.length, 1);

  await module.stop();
  await server.close();
});

test('interruption naming an unknown channel is dropped even with a single candidate', async () => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  // One tracked agent — but the interruption names a channel we never
  // streamed to. Guessing here could abort an unrelated turn.
  emit(startedTrace('assistant', 'chan-a'));
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-b', spokenText: 'x', reason: 'manual', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(aborts.length, 0, 'unknown channel never falls back to the single candidate');

  await module.stop();
  await server.close();
});

test('interruption without a channel falls back to the single tracked agent', async () => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  emit(startedTrace('assistant', 'chan-a'));
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', spokenText: '', reason: 'manual', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'fallback abort');
  assert.equal(aborts[0].agentName, 'assistant');
  assert.equal(aborts[0].keepText, undefined, 'empty spokenText carries no keepText');

  await module.stop();
  await server.close();
});

test('stale interruption (spokenText from a previous utterance) is dropped', async () => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  const chunk = (content: string, blockIndex: number, blockType = 'text'): TraceEvent =>
    ({ type: 'inference:tokens', agentName: 'assistant', channelId: 'chan-7', content, blockType, blockIndex, timestamp: T0 } as TraceEvent);
  const blockStart = (blockIndex: number): TraceEvent =>
    ({ type: 'inference:content_block', agentName: 'assistant', channelId: 'chan-7', phase: 'block_start', blockType: 'text', blockIndex, timestamp: T0 } as TraceEvent);

  // Utterance 1 streams; a matching report interrupts it.
  emit(startedTrace('assistant', 'chan-7'));
  emit(blockStart(0));
  emit(chunk('Hello there ', 0));
  emit(chunk('general Kenobi', 0));
  await waitFor(() => server.received.length >= 4, 3000, 'utterance 1 streamed');
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-7', spokenText: 'Hello there gen', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'matching report aborts');
  assert.equal(aborts[0].keepText, 'Hello there gen');

  // Utterance 2 starts; the old report races in again — stale, dropped.
  emit(blockStart(1));
  emit(chunk('Fresh words now', 1));
  await waitFor(() => server.received.length >= 6, 3000, 'utterance 2 streamed');
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-7', spokenText: 'Hello there gen', reason: 'user_speech', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(aborts.length, 1, 'stale report does not abort the new utterance');

  // A report matching the CURRENT utterance still works.
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-7', spokenText: 'Fresh words', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 2, 3000, 'current-utterance report aborts');
  assert.equal(aborts[1].keepText, 'Fresh words');

  await module.stop();
  await server.close();
});

test('channel tracking is bounded; evicted channels no longer address interruptions', async () => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  for (let i = 0; i < 300; i++) emit(startedTrace(`agent-${i % 3}`, `chan-${i}`));
  assert.equal(module.trackedChannelCount, 256, 'tracking bounded at 256 channels');

  // chan-0 was evicted (oldest); chan-299 is still tracked.
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-0', spokenText: '', reason: 'manual', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(aborts.length, 0, 'evicted channel dropped');
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-299', spokenText: '', reason: 'manual', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'tracked channel aborts');
  assert.equal(aborts[0].agentName, 'agent-2');

  await module.stop();
  await server.close();
});

test('relay client does not reconnect after the relay replaces its connection', async () => {
  const server = await startMockBotServer();
  const { ctx } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    reconnectInitialMs: 20, // fast enough that a reconnect WOULD show up below
    logger: silentLogger,
  });
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'auth');

  server.authedSockets[0].close(1000, 'Replaced by new connection');
  await waitFor(() => !module.isConnected, 3000, 'replacement noticed');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.connections, 1, 'no reconnect after being replaced');

  await module.stop();
  await server.close();
});

test('backoff resets only after the connection stays authenticated', async () => {
  const server = await startMockBotServer();
  const { ctx } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    reconnectInitialMs: 30,
    reconnectMaxMs: 500,
    backoffResetAfterMs: 120,
    logger: silentLogger,
  });
  await module.start(ctx);
  await waitFor(() => module.isConnected, 3000, 'first auth');
  assert.equal(module.currentReconnectDelayMs, 30);

  // Two quick auth-then-drop cycles: the backoff must keep growing because
  // no connection survived the stability window.
  server.authedSockets[0].terminate();
  await waitFor(() => module.isConnected && server.connections >= 2, 3000, 'reconnect 1');
  server.authedSockets[1].terminate();
  await waitFor(() => module.isConnected && server.connections >= 3, 3000, 'reconnect 2');
  assert.ok(module.currentReconnectDelayMs >= 120, `backoff grew (got ${module.currentReconnectDelayMs})`);

  // Stay connected past the stability window: backoff returns to the floor.
  await waitFor(() => module.currentReconnectDelayMs === 30, 3000, 'stability reset');

  await module.stop();
  await server.close();
});

// ---------------------------------------------------------------------------
// E2E: real relay + real framework
// ---------------------------------------------------------------------------

test(
  'e2e: a voice client hears a framework agent through the real relay, and interrupts it',
  { skip: referenceRelayAvailable() === null ? 'reference relay repo unavailable' : false },
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'relay-client-e2e-'));
    const relay = await spawnReferenceRelay(writeRelayConfig(tempDir));
    const membrane = new MockMembrane();
    const clientModule = new RelayClientModule({
      url: relay.url,
      botId: 'Opus45',
      token: TOKENS.bot,
      username: 'Opus 4.5',
      reconnectInitialMs: 100,
      logger: silentLogger,
    });

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'e2e.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test.' }],
      modules: [clientModule as unknown as Module],
    });
    clientModule.bind(framework);

    // Spy on abortInference to observe the interruption round-trip without
    // needing a stream to still be in flight when the (async) cut arrives.
    const aborts: Array<{ agentName: string; keepText?: string }> = [];
    const realAbort = framework.abortInference.bind(framework);
    framework.abortInference = ((agentName: string, opts?: string | { reason?: string; keepText?: string }) => {
      const o = typeof opts === 'string' ? { reason: opts } : opts ?? {};
      aborts.push({ agentName, keepText: o.keepText });
      return realAbort(agentName, opts as never);
    }) as typeof framework.abortInference;

    try {
      await waitFor(() => clientModule.isConnected, 10_000, 'module authed against real relay');

      const sim = new VoiceClientSim(relay.url);
      await sim.connect();
      const authReply = await sim.auth({ clientId: 'e2e-voice', token: TOKENS.client });
      assert.equal(authReply.type, 'auth_ok');
      await sim.subscribe(['chan-e2e']);

      membrane.pushResponse(
        createMockResponse([{ type: 'text', text: 'Hello from connectome' }] as ContentBlock[]),
      );
      framework.pushEvent({
        type: 'mcpl:channel-incoming',
        serverId: 'test-server',
        channelId: 'chan-e2e',
        messageId: 'm-e2e-1',
        author: { id: 'u1', name: 'Nick' },
        content: [{ type: 'text', text: 'hey assistant' }],
        timestamp: new Date().toISOString(),
        triggerInference: true,
      } as unknown as ProcessEvent);
      await framework.runUntilIdle();

      // Collect the streamed relay messages at the voice client until activation_end.
      const relayMessages: Array<Record<string, unknown>> = [];
      while (relayMessages.length === 0 || relayMessages[relayMessages.length - 1].type !== 'activation_end') {
        relayMessages.push(await sim.next(5000));
        if (relayMessages.length > 50) throw new Error(`stream never ended: ${JSON.stringify(relayMessages)}`);
      }

      assert.equal(relayMessages[0].type, 'activation_start');
      assert.equal(relayMessages[0].botId, 'Opus45');
      assert.equal(relayMessages[0].channelId, 'chan-e2e');
      const chunkText = relayMessages
        .filter((m) => m.type === 'chunk' && m.blockType === 'text')
        .map((m) => m.text)
        .join('');
      assert.equal(chunkText, 'Hello from connectome');
      const blockComplete = relayMessages.find((m) => m.type === 'block_complete');
      assert.equal(blockComplete?.content, 'Hello from connectome');
      const end = relayMessages[relayMessages.length - 1];
      assert.equal(end.reason, 'complete');
      assert.equal(end.username, 'Opus 4.5');

      // Interruption: voice client reports a cut through the real relay.
      sim.send({
        type: 'interruption',
        botId: 'Opus45',
        channelId: 'chan-e2e',
        spokenText: 'Hello from',
        reason: 'user_speech',
        timestamp: Date.now(),
      });
      await waitFor(() => aborts.length >= 1, 5000, 'interruption reached abortInference');
      assert.equal(aborts[0].agentName, 'assistant');
      assert.equal(aborts[0].keepText, 'Hello from');

      sim.close();
    } finally {
      await framework.stop();
      await relay.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
