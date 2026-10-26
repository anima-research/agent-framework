/**
 * Test servers for MCPL RFC-014 host tests, each served in process
 * over WebSocket (ws://127.0.0.1:<port>/mcpl):
 *
 *  - serveToolsetServer: mcpl-core's reference `ToolsetServer` (RFC-014's server
 *    side), for end-to-end behaviour;
 *  - startScriptedServer: a raw JSON-RPC peer the test drives message by
 *    message, for what a conforming server never does on its own (a skipped
 *    rev, a duplicate eventId, a late result, a definition naming another
 *    toolset).
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McplConnection } from '@animalabs/mcpl-core';
import { ToolsetServer, type ToolsetServerSpec } from '@animalabs/mcpl-core/toolsets';

import { AgentFramework } from '../../src/index.js';
import type { McplServerConfig } from '../../src/mcpl/types.js';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolResult } from '../../src/index.js';
import { MockMembrane } from './mock-membrane.js';

export function urlOf(wss: WebSocketServer): string {
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/mcpl`;
}

export async function listening(wss: WebSocketServer): Promise<void> {
  if (wss.address()) return;
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
}

/** mcpl-core's ToolsetServer over WebSocket; every connection is `principal`'s. */
export async function serveToolsetServer(spec: ToolsetServerSpec, principal = 'agent:test') {
  const server = new ToolsetServer(spec);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const sockets = new Set<WebSocket>();
  /** Every request and notification method the server received, in order, across connections. */
  const received: string[] = [];
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { method?: unknown };
        if (typeof msg.method === 'string') received.push(msg.method);
      } catch { /* not JSON */ }
    });
    void server.serve(McplConnection.fromWebSocket(ws as never), principal);
  });
  await listening(wss);
  return {
    server,
    received,
    url: urlOf(wss),
    /** Drop every live connection (the host reconnects if configured to). */
    dropAll: () => { for (const ws of sockets) ws.terminate(); },
    close: () => new Promise<void>((resolve) => {
      for (const ws of sockets) ws.terminate();
      wss.close(() => resolve());
    }),
  };
}

export type Json = Record<string, unknown>;

/**
 * A raw MCPL peer: answers initialize (with `advert` as experimental.mcpl)
 * and featureSets/update itself, and hands every other message to `on`.
 * `send` writes one message; `request` sends a server→host request and
 * resolves with its answer.
 */
export async function startScriptedServer(opts: {
  advert: Json;
  tools: Json[];
  /** tools/list's `_meta["mcpl/rev"]`, read at each list. */
  listRev?: () => number | undefined;
  /** Answers a tools/list itself when it returns true. */
  onList?: (msg: Json, peer: ScriptedPeer) => boolean;
  on?: (msg: Json, peer: ScriptedPeer) => void;
}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const peers: ScriptedPeer[] = [];
  const received: Json[] = [];
  wss.on('connection', (ws) => {
    const peer = new ScriptedPeer(ws);
    peers.push(peer);
    ws.on('message', (data) => {
      let msg: Json;
      try { msg = JSON.parse(String(data)) as Json; } catch { return; }
      received.push(msg);
      if ('id' in msg && !('method' in msg)) { peer.answered(msg); return; }
      switch (msg.method) {
        case 'initialize':
          peer.hostCaps = ((msg.params as Json)?.capabilities as Json | undefined)?.experimental as Json | undefined;
          peer.reply(msg.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, experimental: { mcpl: { version: '0.5', pushEvents: true, ...opts.advert } } },
            serverInfo: { name: 'scripted', version: '1' },
          });
          return;
        case 'notifications/initialized':
          return;
        case 'featureSets/update':
          peer.policy.push(msg.params as Json);
          if (msg.id !== undefined) peer.reply(msg.id, { accepted: true });
          return;
        case 'tools/list': {
          if (opts.onList?.(msg, peer)) return;
          const rev = opts.listRev?.();
          peer.reply(msg.id, { tools: opts.tools, ...(rev !== undefined ? { _meta: { 'mcpl/rev': rev } } : {}) });
          return;
        }
        default:
          if (opts.on) opts.on(msg, peer);
          else if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
      }
    });
  });
  await listening(wss);
  return {
    url: urlOf(wss),
    peers,
    received,
    get peer(): ScriptedPeer { return peers[peers.length - 1]!; },
    close: () => new Promise<void>((resolve) => {
      for (const p of peers) p.ws.terminate();
      wss.close(() => resolve());
    }),
  };
}

export class ScriptedPeer {
  hostCaps: Json | undefined;
  readonly policy: Json[] = [];
  private nextId = 5000;
  private waiting = new Map<unknown, (msg: Json) => void>();
  constructor(readonly ws: WebSocket) {}
  send(msg: Json): void { this.ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg })); }
  reply(id: unknown, result: unknown): void { this.send({ id, result }); }
  error(id: unknown, code: number, message: string, data?: unknown): void { this.send({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } }); }
  notify(method: string, params: Json): void { this.send({ method, params }); }
  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ id, method, params });
    });
  }
  answered(msg: Json): void {
    const w = this.waiting.get(msg.id);
    if (w) { this.waiting.delete(msg.id); w(msg); }
  }
}

/** Wakes nothing; lets a test add a user message that triggers inference. */
class Quiet implements Module {
  readonly name = 'quiet';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
    }
    return {};
  }
}

/** A framework with one agent and the given MCPL servers. */
export async function makeFramework(servers: McplServerConfig[]) {
  const dir = mkdtempSync(join(tmpdir(), 'af-toolsets-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    modules: [new Quiet()],
    mcplServers: servers,
  });
  await framework.start();
  return {
    framework,
    membrane,
    async stop() {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** The text of every stored message in `agent`'s window, newest last. */
export function windowText(framework: AgentFramework, agent = 'scout'): string[] {
  const cm = framework.getAgent(agent)!.getContextManager();
  return cm.getAllMessages().map((m) => m.content.map((b) => {
    const block = b as { type: string; text?: unknown; content?: unknown };
    if (block.type === 'text') return String(block.text ?? '');
    if (block.type === 'tool_result') return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    return '';
  }).join('\n'));
}

/** A module tool call through the framework, as a host makes one. */
export function callTool(framework: AgentFramework, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return framework.executeToolCall({ id: `call-${Math.random().toString(36).slice(2, 10)}`, name, input } as never);
}

/** A result's text, whichever way the module returned it. */
export function resultText(result: ToolResult): string {
  if (result.isError) return String(result.error ?? '');
  if (typeof result.data === 'string') return result.data;
  if (Array.isArray(result.data)) return result.data.map((b) => (b as { text?: string }).text ?? `[${(b as { type: string }).type}]`).join('\n');
  return JSON.stringify(result.data);
}
