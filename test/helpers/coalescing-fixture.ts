/**
 * Shared RFC-006 wire fixture: a loopback WebSocket MCPL server, a mock model
 * provider, and the framework under test. Used by test/mcpl-coalescing.test.ts
 * and by the subprocess-kill child (coalescing-kill-child.ts).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { FrameworkConfig } from '../../src/types/framework.js';
import { AgentFramework } from '../../src/framework.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './mock-membrane.js';

export const TS = '2026-09-30T00:00:00Z';
export const ok = () => createMockResponse([{ type: 'text', text: 'ok' }]);

export async function fixture(options: { server?: Record<string, unknown>; framework?: Partial<FrameworkConfig>; agents?: unknown[]; dir?: string; port?: number } = {}) {
  const wss = new WebSocketServer({ port: options.port ?? 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  let online = true;
  let socket: WebSocket;
  let next = 1000;
  const replies = new Map<number, (value: unknown) => void>();
  const renders: Array<Record<string, unknown>> = [];
  const hostCaps: Array<Record<string, unknown>> = [];
  const published: Array<Record<string, unknown>> = [];
  let renderer: (params: Record<string, unknown>) => Promise<unknown> = async () => ({ content: [{ type: 'text', text: 'document_diff' }] });
  wss.on('connection', (ws) => {
    if (!online) { ws.close(); return; }
    socket = ws;
    ws.on('message', async (bytes) => {
      const m = JSON.parse(String(bytes));
      if (!m.method) { replies.get(m.id)?.(m); replies.delete(m.id); return; }
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      if (m.method === 'initialize') {
        hostCaps.push(m.params.capabilities.experimental.mcpl);
        reply({ protocolVersion: '2024-11-05', capabilities: { tools: {}, experimental: { mcpl: {
          version: '0.5', pushEvents: true, inferenceRequest: true,
          channels: { incoming: true, register: true, lifecycle: true, publish: true },
          featureSets: { doc: { description: 'doc', uses: ['pushEvents'] } },
        } } }, serverInfo: { name: 'editor', version: '1' } });
      } else if (m.method === 'featureSets/update') reply({ accepted: true });
      else if (m.method === 'tools/list') reply({ tools: [] });
      else if (m.method === 'channels/publish') { published.push(m.params); if (m.id !== undefined) reply({ delivered: true }); }
      else if (m.method === 'channels/close') reply({ closed: true });
      else if (m.method === 'channels/open') reply({ channel: { id: m.params.channelId, type: 'discord', label: m.params.channelId } });
      else if (m.method === 'push/render') { renders.push(m.params); reply(await renderer(m.params)); }
      else if (m.id !== undefined) reply({});
    });
  });
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'coalescing-'));
  let framework: AgentFramework;
  const membrane = new MockMembrane();
  membrane.pushResponse(ok());
  const create = async (grantPush = true) => {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: (options.agents ?? [{ name: 'agent', model: 'test', systemPrompt: 'test' }]) as FrameworkConfig['agents'],
      modules: [], ...options.framework,
      mcplServers: [{ id: 'editor', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, enabledFeatureSets: ['doc'],
        ...options.server, ...(grantPush ? {} : { disabledCapabilities: ['pushEvents'] }) }],
    } as FrameworkConfig);
    return framework;
  };
  const send = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 3000);
    replies.set(id, (value) => { clearTimeout(timer); resolve(value); });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await create();
  return {
    get framework() { return framework; }, membrane, renders, hostCaps, published, create, send, dir,
    port: (wss.address() as AddressInfo).port,
    disconnect: () => socket.terminate(),
    online: (value: boolean) => { online = value; },
    register: (id = 'chat') => send('channels/register', { channels: [{ id, type: 'discord', label: id, metadata: { channelType: 'guild_text' } }] }),
    /** A coalesced channels/incoming message for platform message `m`. */
    channel: (eventId: string, text: string, flags: Record<string, unknown> = {}, channelId = 'chat', messageId = 'm') => ({
      channelId, messageId, eventId, timestamp: TS, author: { id: 'u', name: 'User' }, tags: ['chat:mention'],
      content: text ? [{ type: 'text', text }] : [], coalesce: { key: `message:${messageId}`, ...flags },
    }),
    /** A coalesced feature-set push. */
    params: (eventId: string, text: string, flags: Record<string, unknown> = {}) => ({
      featureSet: 'doc', eventId, timestamp: TS, coalesce: { key: 'document', ...flags },
      payload: { content: text ? [{ type: 'text', text }] : [] },
    }),
    renderer: (fn: typeof renderer) => { renderer = fn; },
    /** Serialized context of the primary agent. */
    context: (agent = 'agent') => JSON.stringify(framework.getAgent(agent)!.getContextManager().getAllMessages()),
    /** Serialized messages of the last model request (tool descriptions excluded). */
    lastRequest: () => JSON.stringify((membrane.calls.at(-1) as { messages?: unknown } | undefined)?.messages),
    turn: async () => { membrane.pushResponse(ok()); await framework.runUntilIdle(); },
    /** Every subsequent model call gets a complete 'ok' response (multi-turn tests). */
    alwaysRespond: () => {
      (membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
        membrane.calls.push(request as never);
        return new MockYieldingStream([ok()]);
      };
    },
    close: async () => {
      await framework.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function eventually(predicate: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert(Date.now() < deadline, `${what} did not settle`); await new Promise((r) => setTimeout(r, 10)); }
}


/** Simulate a crash: stop without the snapshot flush a clean stop performs. */
export async function crash(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const internals = f.framework as unknown as { flushCoalescingSnapshot: () => void; coalescingSaveTimer: ReturnType<typeof setTimeout> | null };
  if (internals.coalescingSaveTimer) clearTimeout(internals.coalescingSaveTimer);
  internals.coalescingSaveTimer = null;
  internals.flushCoalescingSnapshot = () => {};
  await f.framework.stop();
}

