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
import type { ModuleContext, Module, ProcessState, EventResponse } from '../src/types/module.js';
import type { ProcessEvent, ToolCall, ToolResult, ToolDefinition } from '../src/types/events.js';
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

test('relay client auths and forwards messages under its own bot identity', async (t) => {
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
  t.after(async () => {
    await module.stop();
    await server.close();
  });
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

});

test('relay client ignores heartbeats and drops relay traffic while down', async (t) => {
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
  t.after(async () => {
    await module.stop();
    await server.close();
  });
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

});

test('relay client reconnects with backoff and re-authenticates', async (t) => {
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
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'first auth');
  assert.equal(server.connections, 1);

  server.authedSockets[0].terminate();
  await waitFor(() => server.connections >= 2 && module.isConnected, 3000, 'reconnect + re-auth');

});

test('relay client keeps retrying after auth rejection', async (t) => {
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
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => server.connections >= 3, 3000, 'repeated attempts');
  assert.equal(module.isConnected, false);

  server.rejectAuth = false;
  await waitFor(() => module.isConnected, 3000, 'recovers once auth allowed');

});

test('interruption from the relay maps to abortInference with keepText', async (t) => {
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
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  emit(startedTrace('assistant', 'chan-9'));
  emit({
    type: 'inference:tokens',
    agentName: 'assistant',
    channelId: 'chan-9',
    content: 'Hey! Yes, I can hear you loud and clear',
    blockType: 'text',
    blockIndex: 0,
    timestamp: T0,
  } as TraceEvent);
  await waitFor(() => server.received.length >= 2, 3000, 'turn streamed');
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

});

test('interruption naming an unknown channel is dropped even with a single candidate', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  // One tracked agent — but the interruption names a channel we never
  // streamed to. Guessing here could abort an unrelated turn.
  emit(startedTrace('assistant', 'chan-a'));
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-b', spokenText: 'x', reason: 'manual', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(aborts.length, 0, 'unknown channel never falls back to the single candidate');

});

test('interruption without a channel falls back to the single tracked agent', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  emit(startedTrace('assistant', 'chan-a'));
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', spokenText: '', reason: 'manual', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'fallback abort');
  assert.equal(aborts[0].agentName, 'assistant');
  assert.equal(aborts[0].keepText, undefined, 'empty spokenText carries no keepText');

});

test('stale interruption (spokenText from a previous utterance) is dropped', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
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

  // Utterance 2 = a NEW activation; the old report races in again — stale,
  // dropped. (A new block within the SAME activation is not a new utterance:
  // whole-activation clients legitimately report earlier blocks' text — see
  // the iOS-style test below.)
  emit(startedTrace('assistant', 'chan-7'));
  emit(blockStart(1));
  emit(chunk('Fresh words now', 1));
  await waitFor(() => server.received.length >= 7, 3000, 'utterance 2 streamed');
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

});

test('channel tracking is bounded; evicted channels no longer address interruptions', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
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

});

test('relay client does not reconnect after the relay replaces its connection', async (t) => {
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
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  server.authedSockets[0].close(1000, 'Replaced by new connection');
  await waitFor(() => !module.isConnected, 3000, 'replacement noticed');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.connections, 1, 'no reconnect after being replaced');

});

test('backoff resets only after the connection stays authenticated', async (t) => {
  const server = await startMockBotServer();
  const { ctx } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    reconnectInitialMs: 30,
    reconnectMaxMs: 500,
    // Wide enough that a CPU-starved runner cannot let the stability timer
    // fire between the second re-auth and the growth assertion below.
    backoffResetAfterMs: 800,
    logger: silentLogger,
  });
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
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

});

test('watchdog: a silent link is presumed dead and re-dialed', async (t) => {
  const server = await startMockBotServer();
  const { ctx } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    reconnectInitialMs: 30,
    heartbeatTimeoutMs: 400,
    logger: silentLogger,
  });
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');
  assert.equal(server.connections, 1);

  // The mock server never heartbeats (the real relay does, every ~2s), so
  // the watchdog must tear the link down and the client must re-dial.
  await waitFor(() => server.connections >= 2, 5000, 'watchdog re-dial');
});

test('watchdog: heartbeats keep the link alive', async (t) => {
  const server = await startMockBotServer();
  const { ctx } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    heartbeatTimeoutMs: 400,
    logger: silentLogger,
  });
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  const hb = setInterval(() => {
    for (const ws of server.authedSockets) {
      try {
        ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
      } catch {
        // socket may be mid-teardown; the assertion below still judges
      }
    }
  }, 100);
  t.after(() => clearInterval(hb));

  await new Promise((r) => setTimeout(r, 900));
  assert.equal(server.connections, 1, 'no re-dial while heartbeats flow');
  assert.equal(module.isConnected, true);
});

test('malformed frames (null, primitives, bad JSON) do not crash the client', async (t) => {
  const server = await startMockBotServer();
  const { ctx } = stubCtx();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  for (const frame of ['null', '123', '"x"', '[1,2]', 'not json at all']) {
    server.authedSockets[0].send(frame);
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(module.isConnected, true, 'client survives hostile frames');
});

test('unverifiable spokenText aborts the turn but never dictates keepText', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  // The turn starts BEFORE the socket authenticates: the tracker (a trace
  // listener) records the channel, but the activation_start is dropped at
  // the socket check, so no accumulator entry exists — the report below is
  // genuinely unverifiable. It may stop the turn but its text must not be
  // committed as words the agent said.
  emit(startedTrace('assistant', 'chan-2'));
  await waitFor(() => module.isConnected, 3000, 'auth');

  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-2', spokenText: 'words we never streamed', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'abort goes through');
  assert.equal(aborts[0].agentName, 'assistant');
  assert.equal(aborts[0].keepText, undefined, 'unverifiable text is not kept');
});

test('a non-empty report while the current utterance has voiced nothing is dropped as stale', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  // Turn N streamed and finished; its late report arrives only after turn
  // N+1's activation_start has been SENT (accumulator present but empty —
  // N+1 is still thinking). Real clients never report non-empty spokenText
  // for an utterance that voiced nothing, so this can only describe turn N
  // and must not cut off N+1.
  const ev = (e: Record<string, unknown>): TraceEvent =>
    ({ agentName: 'assistant', channelId: 'chan-3', timestamp: T0, ...e } as unknown as TraceEvent);
  emit(startedTrace('assistant', 'chan-3'));
  emit(ev({ type: 'inference:tokens', content: 'Turn one words', blockType: 'text', blockIndex: 0 }));
  emit(ev({ type: 'inference:completed', durationMs: 5 }));
  emit(startedTrace('assistant', 'chan-3')); // N+1: activation_start sent, no text yet
  await waitFor(() => server.received.filter((m) => m.type === 'activation_start').length >= 2, 3000, 'both activations sent');

  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-3', spokenText: 'Turn one words', reason: 'user_speech', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(aborts.length, 0, 'the stale report must not abort the fresh turn');

  // Once N+1 voices text, a matching report lands normally.
  emit(ev({ type: 'inference:tokens', content: 'Turn two words', blockType: 'text', blockIndex: 0 }));
  await waitFor(() => server.received.filter((m) => m.type === 'chunk').length >= 2, 3000, 'turn two streamed');
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-3', spokenText: 'Turn two', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'the live turn is interruptible');
  assert.equal(aborts[0].keepText, 'Turn two');
});

test("narrator-markup asterisks are ignored when matching a client's report", async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  emit(startedTrace('assistant', 'chan-4'));
  emit({
    type: 'inference:tokens',
    agentName: 'assistant',
    channelId: 'chan-4',
    content: '*looks up* Hello there, how are you',
    blockType: 'text',
    blockIndex: 0,
    timestamp: T0,
  } as TraceEvent);
  await waitFor(() => server.received.some((m) => m.type === 'chunk'), 3000, 'turn streamed');

  // The iOS client voices `*action*` spans via its narrator voice and
  // reports them WITHOUT the asterisks (segments trimmed and concatenated),
  // so the report for the text above arrives as "looks upHello there".
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-4', spokenText: 'looks upHello there', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'narrated turn is interruptible');
  assert.equal(aborts[0].keepText, 'looks upHello there');
});

test('the fatal replaced-connection stop also tears down the trace subscriptions', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    reconnectInitialMs: 20,
    logger: silentLogger,
  });
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');
  emit(startedTrace('assistant', 'chan-1'));
  assert.equal(module.trackedChannelCount, 1);

  server.authedSockets[0].close(1000, 'Replaced by new connection');
  await waitFor(() => !module.isConnected, 3000, 'replacement noticed');

  // A permanently-down module must not keep tracking or translating: the
  // maps are cleared and later traces are ignored entirely.
  assert.equal(module.trackedChannelCount, 0, 'tracking cleared on the fatal stop');
  const before = server.received.length;
  emit(startedTrace('assistant', 'chan-2'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(module.trackedChannelCount, 0, 'tracker unsubscribed');
  assert.equal(server.received.length, before);
});

test('whole-activation report spanning blocks is accepted (iOS-style client)', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  const ev = (e: Record<string, unknown>): TraceEvent =>
    ({ agentName: 'assistant', channelId: 'chan-5', timestamp: T0, ...e } as unknown as TraceEvent);
  emit(startedTrace('assistant', 'chan-5'));
  emit(ev({ type: 'inference:content_block', phase: 'block_start', blockType: 'text', blockIndex: 0 }));
  emit(ev({ type: 'inference:tokens', content: 'First sentence. ', blockType: 'text', blockIndex: 0 }));
  emit(ev({ type: 'inference:content_block', phase: 'block_start', blockType: 'text', blockIndex: 1 }));
  emit(ev({ type: 'inference:tokens', content: 'Second thought', blockType: 'text', blockIndex: 1 }));
  await waitFor(() => server.received.length >= 5, 3000, 'both blocks streamed');

  // The iOS client accumulates spokenText across the WHOLE activation, so a
  // legitimate mid-turn report starts with block 0's text even though the
  // stream is already in block 1. It must abort, and keep what was heard.
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-5', spokenText: 'First sentence. Sec', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'whole-activation report accepted');
  assert.equal(aborts[0].keepText, 'First sentence. Sec');
});

test('a late report for a channel the agent has left cannot abort its new turn', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({ url: server.url, botId: 'opus45', token: 'tok', logger: silentLogger });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  const ev = (channelId: string, e: Record<string, unknown>): TraceEvent =>
    ({ agentName: 'assistant', channelId, timestamp: T0, ...e } as unknown as TraceEvent);

  // Turn 1 on chan-a streams and completes.
  emit(startedTrace('assistant', 'chan-a'));
  emit(ev('chan-a', { type: 'inference:tokens', content: 'Old turn words', blockType: 'text', blockIndex: 0 }));
  emit(ev('chan-a', { type: 'inference:completed', durationMs: 5 }));
  // Turn 2 on chan-b is now streaming.
  emit(startedTrace('assistant', 'chan-b'));
  emit(ev('chan-b', { type: 'inference:tokens', content: 'New turn words', blockType: 'text', blockIndex: 0 }));
  // Wire: activation_start, chunk, activation_end (turn 1) + activation_start, chunk (turn 2).
  await waitFor(() => server.received.length >= 5, 3000, 'both turns streamed');

  // A late chan-a report (voice audio outlives the turn) still matches
  // chan-a's retained accumulator — but the agent is mid-turn on chan-b now,
  // so aborting would kill the wrong turn. Must be dropped.
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-a', spokenText: 'Old turn', reason: 'user_speech', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(aborts.length, 0, 'late report for the finished turn is dropped');

  // A report for the channel the agent is ACTUALLY on still works.
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-b', spokenText: 'New turn', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, 'active-channel report aborts');
  assert.equal(aborts[0].keepText, 'New turn');
});

test('agents filter scopes streaming and interruption addressing', async (t) => {
  const server = await startMockBotServer();
  const { ctx, emit } = stubCtx();
  const { framework, aborts } = fakeFramework();
  const module = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    agents: ['mine'],
    logger: silentLogger,
  });
  module.bind(framework);
  await module.start(ctx);
  t.after(async () => {
    await module.stop();
    await server.close();
  });
  await waitFor(() => module.isConnected, 3000, 'auth');

  const ev = (agentName: string, channelId: string, e: Record<string, unknown>): TraceEvent =>
    ({ agentName, channelId, timestamp: T0, ...e } as unknown as TraceEvent);
  emit(startedTrace('mine', 'chan-m'));
  emit(ev('mine', 'chan-m', { type: 'inference:tokens', content: 'Mine speaking', blockType: 'text', blockIndex: 0 }));
  emit(startedTrace('other', 'chan-o'));
  emit(ev('other', 'chan-o', { type: 'inference:tokens', content: 'Other speaking', blockType: 'text', blockIndex: 0 }));
  await waitFor(() => server.received.length >= 2, 3000, "the filtered-in agent's turn streamed");
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(
    server.received.every((m) => m.channelId === 'chan-m'),
    `only the listed agent streams (got ${JSON.stringify(server.received.map((m) => m.channelId))})`,
  );

  // The unlisted agent's channel was never tracked → its interruption drops.
  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-o', spokenText: '', reason: 'manual', timestamp: T0 }),
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(aborts.length, 0);

  server.authedSockets[0].send(
    JSON.stringify({ type: 'interruption', channelId: 'chan-m', spokenText: 'Mine speak', reason: 'user_speech', timestamp: T0 }),
  );
  await waitFor(() => aborts.length === 1, 3000, "the listed agent's interruption lands");
  assert.equal(aborts[0].agentName, 'mine');
});

// ---------------------------------------------------------------------------
// Closed loop on CI: real framework + mock /bot server (no relay checkout)
// ---------------------------------------------------------------------------

/** One-shot tool that blocks until released, pinning the turn mid-flight. */
class HoldToolModule implements Module {
  readonly name = 'hold';
  toolStarted: Promise<void>;
  private signalStart!: () => void;
  private release!: (r: ToolResult) => void;
  private held: Promise<ToolResult>;

  constructor() {
    this.toolStarted = new Promise((r) => (this.signalStart = r));
    this.held = new Promise((r) => (this.release = r));
  }

  releaseTool(): void {
    this.release({ success: true, data: { ok: true } });
  }

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'hold', description: 'Blocks until released', inputSchema: { type: 'object', properties: {} } },
    ];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.signalStart();
    return this.held;
  }
  async onProcess(_e: ProcessEvent, _s: ProcessState): Promise<EventResponse> {
    return {};
  }
}

test('closed loop: a relay interruption aborts the live turn; the wire sees activation_end(abort) and context keeps the prefix', async (t) => {
  const server = await startMockBotServer();
  const tempDir = mkdtempSync(join(tmpdir(), 'relay-loop-'));
  const membrane = new MockMembrane();
  membrane.pushResponse(
    createMockResponse(
      [
        { type: 'text', text: 'The weather is sunny today' },
        { type: 'tool_use', id: 'c1', name: 'hold--hold', input: {} },
      ] as ContentBlock[],
      'tool_use',
    ),
  );
  const hold = new HoldToolModule();
  const clientModule = new RelayClientModule({
    url: server.url,
    botId: 'opus45',
    token: 'tok',
    logger: silentLogger,
  });
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'loop.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test.' }],
    modules: [hold as unknown as Module, clientModule as unknown as Module],
  });
  clientModule.bind(framework);
  t.after(async () => {
    await framework.stop();
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  await waitFor(() => clientModule.isConnected, 5000, 'module authed against mock relay');

  framework.pushEvent({
    type: 'mcpl:channel-incoming',
    serverId: 'test-server',
    channelId: 'chan-loop',
    messageId: 'm-loop-1',
    author: { id: 'u1', name: 'Nick' },
    content: [{ type: 'text', text: 'what is the weather' }],
    timestamp: new Date().toISOString(),
    triggerInference: true,
  } as unknown as ProcessEvent);
  const idle = framework.runUntilIdle();
  await hold.toolStarted;
  await waitFor(() => server.received.some((m) => m.type === 'chunk'), 5000, 'turn streamed to the relay');

  server.authedSockets[0].send(
    JSON.stringify({
      type: 'interruption',
      channelId: 'chan-loop',
      spokenText: 'The weather',
      reason: 'user_speech',
      timestamp: Date.now(),
    }),
  );
  await waitFor(
    () => server.received.some((m) => m.type === 'activation_end' && m.reason === 'abort'),
    5000,
    'abort reaches the wire as activation_end',
  );
  hold.releaseTool();
  await idle;

  const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
    queryMessages: (q: { participant?: string }) => {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
  };
  const texts = cm
    .queryMessages({ participant: 'assistant' })
    .messages.flatMap((m) => m.content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '');
  assert.ok(texts.includes('The weather'), `context keeps the spoken prefix (got ${JSON.stringify(texts)})`);
  assert.ok(
    !texts.includes('The weather is sunny today'),
    'the full unspoken sentence is not committed',
  );
});

// ---------------------------------------------------------------------------
// E2E: real relay + real framework
// ---------------------------------------------------------------------------

test(
  'e2e: a voice client hears a framework agent through the real relay, and interrupts it',
  { skip: referenceRelayAvailable() === null ? 'reference relay repo unavailable' : false },
  async (t) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'relay-client-e2e-'));
    // Cleanup via t.after so a failure at ANY point — including framework
    // creation — cannot orphan the spawned relay child or the temp dir.
    let relay: Awaited<ReturnType<typeof spawnReferenceRelay>> | null = null;
    let frameworkRef: AgentFramework | null = null;
    t.after(async () => {
      await frameworkRef?.stop();
      await relay?.stop();
      rmSync(tempDir, { recursive: true, force: true });
    });
    relay = await spawnReferenceRelay(writeRelayConfig(tempDir));
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
    frameworkRef = framework;
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

    await waitFor(() => clientModule.isConnected, 10_000, 'module authed against real relay');

    {
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
    }
  },
);
