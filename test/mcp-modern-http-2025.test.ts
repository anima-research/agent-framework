import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

import { WebStandardStreamableHTTPServerTransport, createMcpHandler, fromJsonSchema, type EventStore, type JSONRPCMessage, type McpServer } from '@modelcontextprotocol/server';
import { AgentFramework } from '../src/framework.js';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { McplProtocolVersionError, McplRequestError } from '../src/mcpl/server-connection.js';
import { MAX_TIMER_MS } from '../src/mcpl/protocol-family.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import type { Module, ModuleContext, TraceEvent } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTTP_OFFER = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

type Message = { method?: unknown; id?: unknown; params?: Record<string, unknown> };
type HandAnswer = (message: Message, res: ServerResponse) => boolean;

interface Seen {
  method: string;
  session: string | null;
  rpc: string | null;
  id: unknown;
  resumed: boolean;
  lastEventId: string | null;
  status: number;
  at: number;
}

interface Fixture {
  url: string;
  seen: Seen[];
  events: string[];
  sessions: Map<string, WebStandardStreamableHTTPServerTransport>;
  getAnswers: number[];
  resumeAnswers: number[];
  holdGets(opts?: { from?: number; resumes?: boolean }): () => void;
  forget(cut: boolean): Promise<void>;
  upgrade(legacy: 'reject' | 'stateless'): Promise<void>;
  cutListens(count: number): void;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
};

const sessionNotFound = (res: ServerResponse): void => json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  const bodiless = req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD';
  return new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: bodiless ? undefined : body });
}

function pipe(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  // A stream's headers go out at once, as an SSE server sends them: Node
  // holds them back until the first byte of the body otherwise.
  res.flushHeaders();
  if (!response.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as never);
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function listen(server: Server): Promise<string> {
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
}

async function tools(): Promise<{ createServer: (opts: { log?: (line: string) => void; supportedProtocolVersions?: string[] }) => McpServer }> {
  return await import(pathToFileURL(join(here, 'fixtures', 'modern-tools.mjs')).href) as never;
}

function memoryEventStore(): EventStore {
  const events: Array<{ id: string; stream: string; message: JSONRPCMessage }> = [];
  return {
    async storeEvent(stream, message) {
      const id = `${stream}_${String(events.length).padStart(6, '0')}`;
      events.push({ id, stream, message });
      return id;
    },
    async replayEventsAfter(lastEventId, { send }) {
      const at = events.findIndex((event) => event.id === lastEventId);
      if (at < 0) return '';
      const { stream } = events[at]!;
      for (const event of events.slice(at + 1)) {
        if (event.stream === stream && 'jsonrpc' in event.message) await send(event.id, event.message);
      }
      return stream;
    },
  };
}

async function start2025(opts: {
  versions?: string[];
  get?: number;
  resumable?: { retryMs?: number };
  answer?: HandAnswer;
  deleteHangs?: boolean;
  extra?: (server: McpServer) => void;
  stateless?: boolean;
} = {}): Promise<Fixture> {
  const { createServer } = await tools();
  const seen: Seen[] = [];
  const events: string[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const getAnswers: number[] = [];
  const resumeAnswers: number[] = [];
  let held: { until: Promise<void>; from: number; resumes: boolean } | undefined;
  let opens = 0;
  let upgraded: ReturnType<typeof createMcpHandler> | undefined;
  let listensToCut = 0;
  const eventStore = opts.resumable ? memoryEventStore() : undefined;
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let message: Message | undefined;
    try { message = body.length > 0 ? JSON.parse(body.toString('utf8')) as Message : undefined; } catch { message = undefined; }
    const session = (req.headers['mcp-session-id'] as string | undefined) ?? null;
    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? null;
    const resumed = lastEventId !== null;
    const entry: Seen = {
      method: req.method ?? '', session, rpc: typeof message?.method === 'string' ? message.method : null, id: message?.id, resumed, lastEventId, status: 0, at: Date.now(),
    };
    seen.push(entry);
    const writeHead = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => ServerResponse;
    res.writeHead = ((status: number, ...rest: unknown[]) => { entry.status = status; return writeHead(status, ...rest); }) as never;
    if (req.method === 'POST' && message && opts.answer?.(message, res)) return;
    if (req.method === 'GET') {
      const open = resumed ? -1 : opens++;
      if (held && held.resumes === resumed && (resumed || open >= held.from)) await held.until;
      const status = resumed ? resumeAnswers.shift() : getAnswers.shift() ?? opts.get;
      if (status === 0) {
        req.socket.destroy();
        return;
      }
      if (status === -32022) {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2025-11-25' } } });
        return;
      }
      if (status !== undefined) {
        res.writeHead(status).end();
        return;
      }
    }
    if (upgraded) {
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const response = await upgraded.fetch(new Request(toRequest(req, body), { signal: abort.signal }));
      if (message?.method === 'subscriptions/listen' && listensToCut > 0 && response.body) {
        listensToCut--;
        await primeAndCut(res, response);
        return;
      }
      pipe(res, response);
      return;
    }
    if (req.method === 'DELETE' && opts.deleteHangs) return;
    if (opts.stateless) {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = createServer({ log: (line) => events.push(line), ...(opts.versions ? { supportedProtocolVersions: opts.versions } : {}) });
      opts.extra?.(mcp);
      await mcp.connect(transport);
      pipe(res, await transport.handleRequest(toRequest(req, body)));
      return;
    }
    if (session !== null) {
      const transport = sessions.get(session);
      if (!transport) {
        sessionNotFound(res);
        return;
      }
      pipe(res, await transport.handleRequest(toRequest(req, body)));
      return;
    }
    if (req.method === 'POST' && message?.method === 'initialize') {
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, transport); },
        onsessionclosed: (id) => { sessions.delete(id); },
        ...(eventStore ? { eventStore, retryInterval: opts.resumable?.retryMs } : {}),
      });
      const mcp = createServer({ log: (line) => events.push(line), ...(opts.versions ? { supportedProtocolVersions: opts.versions } : {}) });
      opts.extra?.(mcp);
      await mcp.connect(transport);
      pipe(res, await transport.handleRequest(toRequest(req, body)));
      return;
    }
    // A stateful 2025 server answers anything else without a session id 400,
    // the discover probe included: the client's cue to fall back.
    json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
  });
  const url = await listen(server);
  cleanups.push(async () => { for (const transport of sessions.values()) await transport.close(); });
  const forget = async (cut: boolean): Promise<void> => {
    const live = [...sessions.values()];
    sessions.clear();
    if (cut) for (const transport of live) await transport.close();
  };
  return {
    url,
    seen,
    events,
    sessions,
    getAnswers,
    resumeAnswers,
    holdGets({ from = 0, resumes = false } = {}) {
      let release!: () => void;
      held = { until: new Promise<void>((resolve) => { release = resolve; }), from, resumes };
      return () => {
        held = undefined;
        release();
      };
    },
    forget,
    async upgrade(legacy) {
      upgraded = createMcpHandler(() => createServer({ log: (line) => events.push(line) }) as never, legacy === 'reject' ? { legacy: 'reject' } : {});
      await forget(true);
    },
    cutListens(count) {
      listensToCut = count;
    },
  };
}

async function primeAndCut(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.write('id: primed-0\ndata:\n\n');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(value);
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  res.end();
}

async function connect(fixture: { url: string }, extra: Partial<McplServerConfig> = {}): Promise<ModernMcpConnection> {
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, ...extra });
  connection.on('error', () => {});
  cleanups.push(() => connection.close());
  await connection.start();
  return connection;
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `in time: ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function releaser(): { path: string; release: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-2025-release-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'go');
  return { path, release: () => writeFileSync(path, '') };
}
const outlive = (intervalMs: number) => sleep(intervalMs + 15);
const count = (fixture: Fixture, what: (s: Seen) => boolean) => fixture.seen.filter(what).length;
const initializes = (fixture: Fixture) => fixture.seen.filter((s) => s.rpc === 'initialize');
const sessionOf = (connection: ModernMcpConnection) =>
  (connection as unknown as { session: { http?: { transport: { sessionId?: string } } } | null }).session?.http?.transport.sessionId;
const streamOpened = (connection: ModernMcpConnection) =>
  (connection as unknown as { session: { http?: { streamOpened: boolean } } | null }).session?.http?.streamOpened === true;
const heldAborts = (connection: ModernMcpConnection) =>
  (connection as unknown as { session: { wire: { aborts: Map<unknown, unknown> } } }).session.wire.aborts.size;

for (const version of ['2025-03-26', '2025-06-18', '2025-11-25']) {
  test(`a server on ${version} connects at that revision, lists and calls`, async () => {
    const fixture = await start2025({ versions: [version] });
    const connection = await connect(fixture);
    assert.equal(connection.protocolVersion, version);
    const names = (await connection.listTools()).map((tool) => tool.name);
    assert.ok(names.includes('echo') && names.includes('slow'), names.join());
    assert.deepEqual((await connection.callTool('echo', { text: 'hi' })).content, [{ type: 'text', text: 'echo:hi' }]);
    assert.deepEqual((await connection.callTool('structured_only', {})).structuredContent, { answer: 42, ok: false, nothing: null });
    assert.equal(fixture.seen[0]!.rpc, 'server/discover');
    assert.equal(initializes(fixture).length, 1);
    assert.ok(fixture.seen.filter((s) => s.rpc === 'tools/call').every((s) => s.session !== null), 'every call carried the session id');
    assert.equal(heldAborts(connection), 0, 'nothing kept for requests that were answered');
  });
}

test('a dual server that also serves 2025 traffic connects at 2026-07-28, and sends no initialize', async () => {
  const { createServer } = await tools();
  const handler = createMcpHandler(() => createServer({}) as never);
  const rpcs: string[] = [];
  const url = await listen(createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    try { rpcs.push(String((JSON.parse(body.toString('utf8')) as Message).method)); } catch { /* a GET */ }
    pipe(res, await handler.fetch(toRequest(req, body)));
  }));
  const connection = await connect({ url });
  assert.equal(connection.protocolVersion, '2026-07-28');
  assert.deepEqual((await connection.callTool('echo', { text: 'x' })).content, [{ type: 'text', text: 'echo:x' }]);
  assert.ok(!rpcs.includes('initialize'), rpcs.join());
});

test('a 2025 result is final: one that fails its output schema is a plain error, not a no-response outcome', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const obj = (properties = {}) => fromJsonSchema({ type: 'object', properties });
  const fixture = await start2025({
    versions: ['2025-06-18'],
    extra: (server) => server.registerTool('typed', { description: 'A typed result', inputSchema: obj(), outputSchema: obj({ n: { type: 'number' } }) },
      async () => ({ content: [], structuredContent: { n: 1 } })),
    // The SDK server checks its own output, so the bad result is answered here.
    answer: (message, res) => {
      if (message.method !== 'tools/call' || message.params?.name !== 'typed') return false;
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [], structuredContent: { n: 'one' } } });
      return true;
    },
  });
  const connection = await connect(fixture);
  await connection.listTools();
  await assert.rejects(connection.callTool('typed', {}), (err: unknown) => {
    assert.ok(!(err instanceof McplRequestError), `no request outcome is claimed: ${String(err)}`);
    assert.equal((err as Error).message, 'The "remote" server answered, but not in a form this host can read, so whether the request took effect is unknown. Check its effect before trying again.');
    return true;
  });
  assert.ok(logged.some((line) => /^MCP server "remote" answered tools\/call typed with a result this host can't use: .*output schema/.test(line)), logged.join('\n'));
});

test('a list change on a 2025 session is announced, and the next listing has the new tool', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.callTool('add_tool', {});
  await until(() => changes > 0, 'the list change');
  assert.ok((await connection.listTools()).some((tool) => tool.name === 'added_1'));
  await sleep(150);
  assert.deepEqual(errors.filter((message) => /subscription/.test(message)), []);
});

test('the standalone stream reopens after the server closes it, and the reopen refreshes the inventory', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  const streams = () => count(fixture, (s) => s.method === 'GET' && s.status === 200);
  await until(() => streamOpened(connection), 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await until(() => streams() === 2, 'the stream reopened');
  await until(() => changes === 1, 'the refresh after the reopen');
  await connection.callTool('add_tool', {});
  await until(() => changes === 2, 'a list change on the reopened stream');
});

test('the standalone stream keeps trying while its session lives, past the transport\'s default two retries, backing off', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 10, reconnectMaxIntervalMs: 1000 });
  await until(() => streamOpened(connection), 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  fixture.getAnswers.push(503, 503, 503, 503);
  const cut = Date.now();
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 2, 'the stream back after four failed tries');
  assert.equal(count(fixture, (s) => s.method === 'GET' && s.status === 503), 4);
  const back = fixture.seen.filter((s) => s.method === 'GET' && s.status === 200)[1]!.at;
  assert.ok(back - cut >= 300, `the stream came back ${back - cut} ms after the cut`);
  await until(() => changes === 1, 'the refresh after the reopen');
  assert.ok(connection.isConnected);
});

test('the standalone stream\'s first open is tried again after a failure that may pass, each one reported, and then carries list changes', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const fixture = await start2025({ versions: ['2025-06-18'] });
  // The SDK makes this open once; the connection tries it again.
  fixture.getAnswers.push(503, 429);
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  cleanups.push(() => connection.close());
  await connection.start();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open after two failures');
  assert.deepEqual(fixture.seen.filter((s) => s.method === 'GET').map((s) => s.status), [503, 429, 200]);
  assert.deepEqual(errors, [
    'MCP server "remote" did not open its list-change stream (HTTP 503); trying again',
    'MCP server "remote" did not open its list-change stream (HTTP 429); trying again',
  ]);
  await until(() => changes === 1, 'the relist once the stream opened');
  await connection.callTool('add_tool', {});
  await until(() => changes === 2, 'the list change on the stream that opened');
});

test('a request stream resumed while the first open is trying again leaves that open its own: one stream, one relist', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: { retryMs: 50 } });
  fixture.getAnswers.push(503);
  const reopen = fixture.holdGets({ from: 1 });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await until(() => count(fixture, (s) => s.method === 'GET' && !s.resumed) === 2, 'the first open trying again, held');
  const tool = releaser();
  const calling = connection.callTool('slow', { release: tool.path });
  await until(() => fixture.events.includes('slow-start'), 'the call running');
  const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
  fixture.sessions.get(sessionOf(connection)!)!.closeSSEStream(callId as never);
  await until(() => fixture.seen.some((s) => s.method === 'GET' && s.resumed && s.status === 200), 'the call\'s stream resumed');
  tool.release();
  await calling;
  assert.equal(streamOpened(connection), false, 'the resume opened no standalone stream');
  reopen();
  await until(() => streamOpened(connection), 'the standalone stream open at last');
  assert.equal(changes, 1);
  assert.deepEqual(fixture.seen.filter((s) => s.method === 'GET' && !s.resumed).map((s) => s.status), [503, 200]);
});

test('a request stream resumed before the first open is answered leaves that open a first one, which relists once', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: { retryMs: 50 } });
  const release = fixture.holdGets();
  const connection = await connect(fixture);
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await until(() => fixture.seen.some((s) => s.method === 'GET' && !s.resumed), 'the first open sent, and held');
  const calling = connection.callTool('slow', { ms: 150 });
  await until(() => fixture.events.includes('slow-start'), 'the call running');
  const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
  fixture.sessions.get(sessionOf(connection)!)!.closeSSEStream(callId as never);
  await calling;
  assert.ok(fixture.seen.some((s) => s.method === 'GET' && s.resumed && s.status === 200), 'the call\'s stream resumed');
  assert.equal(streamOpened(connection), false, 'the resume opened no standalone stream');
  release();
  await until(() => streamOpened(connection), 'the standalone stream open');
  assert.equal(changes, 1);
});

test('a first open answered after the connection is up relists, so a change announced before the stream opened isn\'t missed', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const release = fixture.holdGets();
  const connection = await connect(fixture);
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.listTools();
  await connection.callTool('add_tool', {});
  release();
  await until(() => changes === 1, 'the relist once the stream opened');
  assert.ok((await connection.listTools()).some((tool) => tool.name === 'added_1'));
});

test('a first open\'s failed try reports nothing once its session has ended', async (t) => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const real = globalThis.fetch;
  let cancelled: (() => void) | undefined;
  let first = true;
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    if (!first || (init?.method ?? 'GET') !== 'GET') return real(url, init);
    first = false;
    return new Response(new ReadableStream({ cancel: () => new Promise<void>((resolve) => { cancelled = resolve; }) }), { status: 503 });
  });
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  cleanups.push(() => connection.close());
  await connection.start();
  await until(() => cancelled !== undefined, 'the first open\'s 503, its body being cancelled');
  await fixture.forget(false);
  await assert.rejects(connection.callTool('echo', {}));
  cancelled!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors.filter((message) => /trying again/.test(message)), []);
});

for (const status of [408, 409, 500, 502, 504, 507, 522, 0]) {
  test(`a first open that meets ${status === 0 ? 'a dropped connection' : `HTTP ${status}`} is tried again, reported, and relists once it opens`, async (t) => {
    t.mock.method(Math, 'random', () => 0.5);
    const fixture = await start2025({ versions: ['2025-06-18'] });
    fixture.getAnswers.push(status);
    const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
    const errors: string[] = [];
    connection.on('error', (error: Error) => errors.push(error.message));
    let changes = 0;
    connection.on('tools-list-changed', () => changes++);
    cleanups.push(() => connection.close());
    await connection.start();
    await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open after the failure');
    assert.deepEqual(fixture.seen.filter((s) => s.method === 'GET').map((s) => s.status), [status, 200]);
    assert.equal(errors.length, 1, errors.join(' | '));
    assert.match(errors[0]!, status === 0
      ? /^MCP server "remote" did not open its list-change stream \(.+\); trying again$/
      : new RegExp(`^MCP server "remote" did not open its list-change stream \\(HTTP ${status}\\); trying again$`));
    await until(() => changes === 1, 'the relist once the stream opened');
  });
}

for (const status of [501, 505]) {
  test(`a first open refused with HTTP ${status}, which won't pass, isn't tried again`, async () => {
    const fixture = await start2025({ versions: ['2025-06-18'], get: status });
    const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
    const errors: string[] = [];
    connection.on('error', (error: Error) => errors.push(error.message));
    cleanups.push(() => connection.close());
    await connection.start();
    // The refusal went back to the SDK, which reports it.
    await until(() => errors.some((message) => /Failed to open SSE stream/.test(message)), 'the SDK reporting the refusal');
    await sleep(150);
    assert.equal(count(fixture, (s) => s.method === 'GET'), 1);
    assert.ok(!errors.some((message) => /trying again/.test(message)));
    assert.ok(connection.isConnected);
  });
}

test('a first open that opens only after failed tries relists what changed meanwhile', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  fixture.getAnswers.push(503);
  const reopen = fixture.holdGets({ from: 1 });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.callTool('add_tool', {});
  assert.equal(count(fixture, (s) => s.method === 'GET' && s.status === 200), 0, 'the change went by before the stream opened');
  reopen();
  await until(() => changes === 1, 'the relist once the stream opened');
  assert.ok((await connection.listTools()).some((tool) => tool.name === 'added_1'));
});

test('a first open whose failed tries go on through the SDK\'s credential retry relists once it opens', async () => {
  // A 503, which the first open tries again, then a 401, which the SDK
  // retries itself, as a new GET, after refreshing the credential.
  const fixture = await start2025();
  fixture.getAnswers.push(503, 401);
  let tokenReads = 0;
  let release!: () => void;
  const refreshed = new Promise<void>((resolve) => { release = resolve; });
  const connection = await connect(fixture, {
    reconnectIntervalMs: 20,
    reconnectMaxIntervalMs: 40,
    accessProvider: async () => {
      if (++tokenReads === 1) return 'initial-token';
      await refreshed;
      return 'refreshed-token';
    },
  });
  let relists = 0;
  connection.on('tools-list-changed', () => relists++);
  await connection.listTools();
  await until(() => tokenReads >= 2, 'the credential refresh, held after the 401');
  release();
  await until(() => fixture.seen.some((s) => s.method === 'GET' && s.status === 200), 'the stream open after a 503 and a 401');
  await until(() => relists === 1, 'one relist once it opens');
  await sleep(50);
  assert.equal(relists, 1);
  assert.deepEqual(fixture.seen.filter((s) => s.method === 'GET' && !s.resumed).map((s) => s.status), [503, 401, 200]);
});

test('a first open refused with 401, which the SDK retries itself after refreshing the credential, relists once it opens', async () => {
  const fixture = await start2025();
  fixture.getAnswers.push(401);
  let tokenReads = 0;
  let release!: () => void;
  const refreshed = new Promise<void>((resolve) => { release = resolve; });
  const connection = await connect(fixture, {
    accessProvider: async () => {
      if (++tokenReads === 1) return 'initial-token';
      await refreshed;
      return 'refreshed-token';
    },
  });
  let relists = 0;
  connection.on('tools-list-changed', () => relists++);
  await until(() => tokenReads >= 2, 'the credential refresh, held after the 401');
  release();
  await until(() => fixture.seen.some((s) => s.method === 'GET' && s.status === 200), 'the stream open after the 401');
  await until(() => relists === 1, 'one relist once it opens');
  await sleep(50);
  assert.equal(relists, 1);
  assert.deepEqual(fixture.seen.filter((s) => s.method === 'GET' && !s.resumed).map((s) => s.status), [401, 200]);
});

test('a 2025 server that issues no session id keeps its stream as one that does: the first open is tried again, and a reopen relists', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  // The id is optional in 2025, and a stream doesn't need one. The SDK's
  // stateless server opens no stream, so this one answers by hand.
  const gets: Array<{ status: number; session: boolean }> = [];
  const streams: ServerResponse[] = [];
  const server = createHttpServer(async (req, res) => {
    const session = req.headers['mcp-session-id'] !== undefined;
    if (req.method === 'GET') {
      const status = gets.length === 0 ? 503 : 200;
      gets.push({ status, session });
      if (status === 503) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write(': open\n\n');
      streams.push(res);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Message;
    if (message.method === 'initialize') {
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'sessionless', version: '1' } } });
    } else if (message.method === 'tools/list') {
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    } else if (message.id === undefined) {
      res.writeHead(202).end();
    } else {
      // server/discover, which a 2025 server doesn't know.
      json(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  });
  const connection = await connect({ url: await listen(server) }, { reconnectIntervalMs: 100, reconnectMaxIntervalMs: 200 });
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  assert.equal(connection.protocolVersion, '2025-11-25');
  assert.equal(sessionOf(connection), undefined);
  await until(() => streams.length === 1, 'the stream open at its second try');
  await until(() => changes === 1, 'the open after a failed try relists');
  streams[0]!.end();
  await until(() => streams.length === 2, 'the stream open again');
  await until(() => changes === 2, 'the reopen relists');
  assert.deepEqual(gets, [{ status: 503, session: false }, { status: 200, session: false }, { status: 200, session: false }]);
});

test('a standalone stream resumed with Last-Event-ID has what it missed replayed, and relists nothing', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: {} });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await until(() => streamOpened(connection), 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.callTool('add_tool', {});
  await until(() => changes === 1, 'the first list change');
  const resume = fixture.holdGets({ resumes: true });
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await connection.callTool('add_tool', {});
  assert.equal(count(fixture, (s) => s.method === 'GET' && s.resumed && s.status === 200), 0, 'the change went by while the stream was down');
  resume();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.resumed && s.status === 200) === 1, 'the stream resumed');
  await until(() => changes === 2, 'the missed change, replayed');
  await sleep(150);
  assert.equal(changes, 2, 'the resume relisted nothing');
});

test('a standalone resume refused with 400 opens again without its event id, and relists', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: {} });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await until(() => streamOpened(connection), 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.callTool('add_tool', {});
  await until(() => changes === 1, 'the first list change');
  fixture.resumeAnswers.push(400);
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await until(() => changes === 2, 'the relist after the stream came back without replay');
  const gets = fixture.seen.filter((s) => s.method === 'GET').map((s) => [s.resumed, s.status]);
  assert.deepEqual(gets, [[false, 200], [true, 400], [false, 200]]);
  await connection.callTool('add_tool', {});
  await until(() => changes === 3, 'a list change on the stream that came back');
});

test('a standalone resume refused with 400, whose open again without its event id meets -32022, ends the session there: a new session starts', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: {} });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await until(() => streamOpened(connection), 'the stream open');
  const first = sessionOf(connection)!;
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.callTool('add_tool', {});
  await until(() => changes === 1, 'the first list change');
  await outlive(20);
  const events: string[] = [];
  for (const name of ['close', 'reconnect']) connection.on(name, () => events.push(name));
  fixture.resumeAnswers.push(400, 400, 400);
  fixture.getAnswers.push(-32022);
  fixture.sessions.get(first)!.closeStandaloneSSEStream();
  await until(() => events.includes('reconnect'), 'the new session');
  assert.deepEqual(events, ['close', 'reconnect']);
  assert.notEqual(sessionOf(connection), first);
  const gets = fixture.seen.filter((s) => s.method === 'GET' && s.session === first).map((s) => [s.resumed, s.status]);
  assert.deepEqual(gets, [[false, 200], [true, 400], [false, 400]], 'the session ended at the first -32022');
});

test('the server\'s retry hint paces the stream\'s return, end to end', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: { retryMs: 300 } });
  const connection = await connect(fixture, { reconnectIntervalMs: 60_000, reconnectMaxIntervalMs: 60_000 });
  await until(() => streamOpened(connection), 'the stream open');
  await connection.callTool('echo', { text: 'x' });
  const cut = Date.now();
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 2, 'the stream back at the hint');
  const back = fixture.seen.filter((s) => s.method === 'GET' && s.status === 200)[1]!.at;
  assert.ok(back - cut >= 250, `the stream came back ${back - cut} ms after the cut, sooner than the hint`);
});

for (const held of [false, true]) {
  test(`a cut request stream is resumed for as long as its request lives, and not after its deadline${held ? ', though the cancel\'s POST never settles' : ''}`, async () => {
    const fixture = await start2025({
      versions: ['2025-11-25'],
      resumable: {},
      answer: (message) => held && message.method === 'notifications/cancelled',
    });
    const connection = await connect(fixture, { requestTimeoutMs: 400, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
    await connection.listTools();
    fixture.resumeAnswers.push(400, ...Array<number>(1000).fill(503));
    const calling = connection.callTool('slow', { release: releaser().path });
    await until(() => fixture.events.includes('slow-start'), 'the call running');
    const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
    fixture.sessions.get(sessionOf(connection)!)!.closeSSEStream(callId as never);
    await assert.rejects(calling, (err: unknown) => {
      assert.ok(err instanceof McplRequestError, String(err));
      assert.equal(err.outcome, 'no-response');
      assert.match(err.message, /^The "remote" server didn't answer within [\d.]+ seconds?, so whether the request took effect is unknown: this host asked it to cancel/);
      return true;
    });
    const resumes = () => count(fixture, (s) => s.method === 'GET' && s.resumed);
    assert.ok(resumes() > 1, 'the stream was resumed, past the 400, while the call lived');
    let settled = resumes();
    for (const deadline = Date.now() + 2000; ;) {
      await sleep(100);
      const now = resumes();
      if (now === settled) break;
      settled = now;
      assert.ok(Date.now() < deadline, `the resumes still going: ${now}`);
    }
    await sleep(300);
    assert.equal(resumes(), settled, 'no resume after the call ended');
    assert.equal(count(fixture, (s) => s.method === 'GET' && !s.resumed), 1);
    assert.equal(count(fixture, (s) => s.rpc === 'notifications/cancelled'), 1);
    assert.ok(connection.isConnected);
  });
}

test('a stream retry waits the server\'s hint first, and never less than the backoff after a failed try', (t) => {
  const connection = ModernMcpConnection.create({ id: 'remote', url: 'http://127.0.0.1:1/mcp', reconnectIntervalMs: 100, reconnectMaxIntervalMs: 10_000_000 });
  t.mock.method(Math, 'random', () => 0.5);
  const delays: number[] = [];
  t.mock.method(globalThis, 'setTimeout', ((_fn: () => void, ms: number) => { delays.push(ms); return { unref() {} }; }) as never);
  const retry = (connection as unknown as { streamRetry: (reconnect: () => void, hinted: number, attempt: number) => unknown }).streamRetry;
  retry(() => {}, 0, 0);
  retry(() => {}, 50, 0);
  retry(() => {}, 10, 3);
  retry(() => {}, 100_000, 1);
  retry(() => {}, 2 ** 40, 0);
  assert.deepEqual(delays, [100, 50, 800, 100_000, MAX_TIMER_MS]);
});

test('on 2026-07-28 a listen stream whose resume keeps failing is given up after the transport\'s two retries, and the keeper reopens it and relists', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const fixture = await start2025();
  await fixture.upgrade('reject');
  fixture.cutListens(1);
  fixture.resumeAnswers.push(...Array<number>(10).fill(503));
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  assert.equal(connection.protocolVersion, '2026-07-28');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await until(() => count(fixture, (s) => s.rpc === 'subscriptions/listen') === 2, 'the keeper reopened the subscription');
  await until(() => changes === 1, 'the reopened subscription relists');
  await sleep(100);
  assert.equal(count(fixture, (s) => s.method === 'GET' && s.resumed), 2, 'two resumes, the transport\'s own limit, and no more');
});

test('on 2026-07-28 a call whose stream the transport gives up on fails then, not at its deadline', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  t.mock.method(Math, 'random', () => 0.5);
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method !== 'tools/call') return false;
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end('id: primed-call\ndata:\n\n');
      return true;
    },
  });
  await fixture.upgrade('reject');
  fixture.resumeAnswers.push(...Array<number>(10).fill(503));
  const connection = await connect(fixture, { requestTimeoutMs: 10_000, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  assert.equal(connection.protocolVersion, '2026-07-28');
  const began = Date.now();
  await assert.rejects(connection.callTool('echo', { text: 'lost' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response', err.message);
    assert.equal(err.message, 'The request to the "remote" server failed before an answer came back, so whether it took effect is unknown. Check its effect before trying again.');
    return true;
  });
  assert.ok(logged.some((line) => line.startsWith('MCP server "remote" tools/call echo failed: ') && line.includes('the stream that would carry its answer ended, and could not be resumed')), logged.join('\n'));
  assert.equal(count(fixture, (s) => s.method === 'GET' && s.resumed), 2, 'the transport\'s two retries, then the call failed');
  assert.ok(connection.isConnected);
});

test('on 2026-07-28 an earlier round whose stream ends after the next round went out leaves the call alone', async () => {
  let firstStream: ServerResponse | undefined;
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method !== 'tools/call' || message.params?.name !== 'cont') return false;
      if (message.params.requestState === undefined) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { resultType: 'input_required', requestState: 'state-1' } })}\n\n`);
        firstStream = res;
        return true;
      }
      firstStream?.end();
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] },
        }));
      }, 100);
      return true;
    },
  });
  await fixture.upgrade('reject');
  const connection = await connect(fixture);
  assert.equal(connection.protocolVersion, '2026-07-28');
  const result = await connection.callTool('cont', {});
  assert.deepEqual(result.content, [{ type: 'text', text: 'done' }]);
  assert.equal(count(fixture, (s) => s.rpc === 'tools/call'), 2, 'two rounds');
});

test('on a 2025 revision a call whose stream ends with neither its answer nor an event id fails then, not at its deadline', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const fixture = await start2025({
    versions: ['2025-06-18'],
    answer: (message, res) => {
      if (message.method !== 'tools/call') return false;
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end();
      return true;
    },
  });
  const connection = await connect(fixture, { requestTimeoutMs: 10_000 });
  await connection.listTools();
  const began = Date.now();
  await assert.rejects(connection.callTool('echo', { text: 'lost' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response', err.message);
    assert.equal(err.message, 'The request to the "remote" server failed before an answer came back, so whether it took effect is unknown. Check its effect before trying again.');
    return true;
  });
  assert.ok(logged.some((line) => line.startsWith('MCP server "remote" tools/call echo failed: ') && line.includes('the stream that would carry its answer ended, and could not be resumed')), logged.join('\n'));
  await until(() => count(fixture, (s) => s.rpc === 'notifications/cancelled') === 1, 'the call cancelled');
  assert.ok(connection.isConnected, 'the session stays');
});

for (const ended of ['as its answer asks for another', 'once the next round is out, unanswered'] as const) {
  test(`on 2026-07-28 a round whose stream ends ${ended} leaves the call alone`, async () => {
    // The transport calls a request's stream-end callback after its answer
    // too. Here round 1's stream ends after its answer, an input_required:
    // in the same turn, before the SDK sends round 2, or once round 2 is out
    // and not yet answered. Failing the call then would lose round 2. Each
    // round is held at the transport (an own `send` keeps its options and
    // sends nothing) and answered through the transport's onmessage.
    const fixture = await start2025();
    await fixture.upgrade('reject');
    const connection = await connect(fixture);
    assert.equal(connection.protocolVersion, '2026-07-28');
    const transport = (connection as unknown as { session: { http: { transport: { send: (message: Message, options?: { onRequestStreamEnd?: () => void }) => Promise<void>; onmessage?: (message: unknown) => void } } } }).session.http.transport;
    const held: Array<{ id: unknown; end?: () => void }> = [];
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if (message.method !== 'tools/call') return send(message, options);
      held.push({ id: message.id, end: options?.onRequestStreamEnd });
    };
    const calling = connection.callTool('cont', {});
    await until(() => held.length === 1, 'round 1 handed to the transport');
    assert.equal(typeof held[0]!.end, 'function', 'the call\'s request carries a stream-end callback');
    transport.onmessage!({ jsonrpc: '2.0', id: held[0]!.id, result: { resultType: 'input_required', requestState: 'state-1' } });
    if (ended === 'as its answer asks for another') held[0]!.end!();
    await until(() => held.length === 2, 'round 2 handed to the transport');
    if (ended === 'once the next round is out, unanswered') held[0]!.end!();
    transport.onmessage!({ jsonrpc: '2.0', id: held[1]!.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] } });
    const result = await calling;
    assert.deepEqual(result.content, [{ type: 'text', text: 'done' }]);
  });
}

test('a session the server ended under a call: the call is refused with 404, and a new session starts at once', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  const first = sessionOf(connection);
  let reconnects = 0;
  connection.on('reconnect', () => reconnects++);
  const closes: boolean[] = [];
  connection.on('close', () => closes.push(connection.willReconnect));
  await fixture.forget(false);
  // Ending the session closes its client, which fails the call at once, ahead
  // of the transport's own 404 error. The refusal is still the call's answer.
  await assert.rejects(connection.callTool('echo', { text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'error-response', err.message);
    assert.deepEqual(err.data, { httpStatus: 404 });
    assert.equal(err.message, 'The "remote" server had ended this connection\'s session, so the request didn\'t run. This host is reconnecting to it; try again later.');
    return true;
  });
  assert.equal(connection.isConnected, false);
  assert.equal(connection.willReconnect, true);
  await until(() => reconnects === 1, 'the new session');
  assert.deepEqual(closes, [true], 'reported closed once, with a new session coming');
  assert.ok(connection.isConnected);
  assert.notEqual(sessionOf(connection), first);
  assert.equal(connection.protocolVersion, '2025-11-25');
  assert.deepEqual((await connection.callTool('echo', { text: 'again' })).content, [{ type: 'text', text: 'echo:again' }]);
  assert.equal(count(fixture, (s) => s.rpc === 'tools/call' && s.status === 404), 1, 'the refused call was not replayed');
});

test('a session the server ended before it answered anything: the call is refused with 404, and without `reconnect` the agent is told nothing reconnects', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'] });
  const connection = await connect(fixture);
  await fixture.forget(false);
  await assert.rejects(connection.callTool('echo', { text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'error-response', err.message);
    assert.deepEqual(err.data, { httpStatus: 404 });
    assert.equal(err.message, 'The "remote" server had ended this connection\'s session, so the request didn\'t run. ' +
      "This host won't reconnect to it on its own. If you need it, ask whoever runs this host.");
    return true;
  });
  assert.equal(connection.willReconnect, false);
  assert.equal(count(fixture, (s) => s.rpc === 'tools/call' && s.status === 404), 1, 'the refused call was not replayed');
});

test('close() while the new session starts stops it: nothing reconnects, and no second close', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  const events: string[] = [];
  for (const event of ['close', 'reconnect', 'reconnect-failed']) connection.on(event, () => events.push(event));
  await fixture.forget(false);
  await connection.callTool('echo', {}).catch(() => {});
  assert.equal(connection.willReconnect, true, 'the new session is starting');
  await connection.close();
  assert.deepEqual(events, ['close']);
  await sleep(100);
  assert.deepEqual(events, ['close']);
  assert.equal(connection.isConnected, false);
});

test('a session the server ended while idle: the stream\'s reopen meets 404, and a new session starts', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await until(() => streamOpened(connection), 'the stream open');
  await outlive(20);
  const first = sessionOf(connection)!;
  let reconnects = 0;
  connection.on('reconnect', () => reconnects++);
  await fixture.forget(true);
  await until(() => reconnects === 1, 'the new session');
  assert.ok(fixture.seen.some((s) => s.method === 'GET' && s.session === first && s.status === 404), 'the reopen met 404');
  assert.notEqual(sessionOf(connection), first);
  assert.equal(initializes(fixture).length, 2);
  assert.deepEqual((await connection.callTool('echo', { text: 'x' })).content, [{ type: 'text', text: 'echo:x' }]);
});

test('a server upgraded in place to refuse 2025: the call it refused with -32022 is refused, not replayed, and a new connect settles on 2026-07-28', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const fixture = await start2025({ versions: ['2025-06-18'], get: 405 });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  const events: string[] = [];
  for (const name of ['close', 'reconnect']) connection.on(name, () => events.push(name));
  await fixture.upgrade('reject');
  await assert.rejects(connection.callTool('echo', { text: 'refused' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'error-response', err.message);
    assert.ok(logged.some((line) => line.startsWith('MCP server "remote" answered tools/call echo with error -32022: ')), logged.join('\n'));
    assert.deepEqual((err.data as { supported?: unknown } | undefined)?.supported, ['2026-07-28']);
    assert.equal(err.message, 'The "remote" server refused this session\'s revision, so the request didn\'t run. This host is reconnecting to it; try again later.');
    return true;
  });
  await until(() => events.includes('reconnect'), 'the new connect');
  assert.deepEqual(events, ['close', 'reconnect']);
  assert.equal(connection.protocolVersion, '2026-07-28');
  const result = await connection.callTool('echo', { text: 'after' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'echo:after' }]);
  assert.deepEqual(fixture.seen.filter((s) => s.rpc === 'tools/call').map((s) => s.status), [400, 200], 'the refused call was not replayed');
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 0, 'a session the server let go gets no DELETE');
});

test('a server upgraded in place to serve 2025 statelessly: the stream\'s reopen meets 405, and a new connect settles on 2026-07-28', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the standalone stream open');
  await outlive(20);
  const events: string[] = [];
  for (const name of ['close', 'reconnect']) connection.on(name, () => events.push(name));
  await fixture.upgrade('stateless');
  await until(() => events.includes('reconnect'), 'the new connect');
  assert.ok(fixture.seen.some((s) => s.method === 'GET' && s.status === 405), 'the stream\'s reopen met 405');
  assert.deepEqual(events, ['close', 'reconnect']);
  assert.equal(connection.protocolVersion, '2026-07-28');
  const result = await connection.callTool('echo', { text: 'after' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'echo:after' }]);
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 0, 'a session the server let go gets no DELETE');
});

test('a 2025 server without session ids, upgraded in place to refuse 2025: the refused call is refused, and a new connect settles on 2026-07-28', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const fixture = await start2025({ versions: ['2025-06-18'], stateless: true });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  assert.equal(sessionOf(connection), undefined);
  const events: string[] = [];
  for (const name of ['close', 'reconnect']) connection.on(name, () => events.push(name));
  await fixture.upgrade('reject');
  await assert.rejects(connection.callTool('echo', { text: 'refused' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'error-response', err.message);
    assert.ok(logged.some((line) => line.startsWith('MCP server "remote" answered tools/call echo with error -32022: ')), logged.join('\n'));
    assert.equal(err.message, 'The "remote" server refused this session\'s revision, so the request didn\'t run. This host is reconnecting to it; try again later.');
    return true;
  });
  await until(() => events.includes('reconnect'), 'the new connect');
  assert.equal(connection.protocolVersion, '2026-07-28');
});

test('a 2025 connection without a session id has no session for a 404 to end: the call fails, and the connection stays', async () => {
  const fixture = await start2025({
    versions: ['2025-06-18'],
    stateless: true,
    answer: (message, res) => {
      if (message.method !== 'tools/call' || (message.params as { arguments?: { text?: unknown } } | undefined)?.arguments?.text !== 'lost') return false;
      json(res, 404, { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Not found' } });
      return true;
    },
  });
  const connection = await connect(fixture);
  await connection.listTools();
  const events: string[] = [];
  for (const name of ['close', 'reconnect', 'reconnect-failed']) connection.on(name, () => events.push(name));
  await assert.rejects(connection.callTool('echo', { text: 'lost' }));
  const result = await connection.callTool('echo', { text: 'after' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'echo:after' }]);
  await sleep(50);
  assert.deepEqual(events, []);
  assert.equal(initializes(fixture).length, 1);
});

test('a cut request stream whose resume meets 404 ends the session, though no standalone stream ever opened', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], get: 405, resumable: {} });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  let reconnects = 0;
  connection.on('reconnect', () => reconnects++);
  const calling = connection.callTool('slow', { release: releaser().path });
  await until(() => fixture.events.includes('slow-start'), 'the call running');
  const sid = sessionOf(connection)!;
  const transport = fixture.sessions.get(sid)!;
  const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
  await fixture.forget(false);
  transport.closeSSEStream(callId as never);
  const refused = assert.rejects(calling, (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response', err.message);
    assert.equal(err.message, 'The connection to the "remote" server closed before it answered, so whether the request took effect is unknown. Check its effect before trying again; this host is reconnecting to it.');
    return true;
  });
  await until(() => reconnects === 1, 'the new session');
  await refused;
  assert.ok(fixture.seen.some((s) => s.method === 'GET' && s.resumed && s.session === sid && s.status === 404), 'the resume met 404');
  // The new session's first GET goes out once its initialized notification
  // is accepted, unawaited, so it can still be on its way at 'reconnect'.
  await until(() => count(fixture, (s) => s.method === 'GET' && !s.resumed) === 2, 'the new session\'s first GET');
  await sleep(50);
  assert.equal(count(fixture, (s) => s.method === 'GET' && !s.resumed), 2, 'one standalone GET per session, each refused');
  assert.equal(count(fixture, (s) => s.rpc === 'tools/call'), 1, 'the cut call was not replayed');
});

test('a cut request stream whose resume meets 405 ends the session, and the call fails then, not at its deadline', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], get: 405, resumable: {} });
  const connection = await connect(fixture, { requestTimeoutMs: 10_000, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  let reconnects = 0;
  connection.on('reconnect', () => reconnects++);
  const calling = connection.callTool('slow', { release: releaser().path });
  await until(() => fixture.events.includes('slow-start'), 'the call running');
  const sid = sessionOf(connection)!;
  const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
  // The server no longer serves the session's streams, as the SDK's 2026
  // handler answers a 2025 session's GETs; the call's stream is cut after
  // its priming event.
  fixture.resumeAnswers.push(405);
  fixture.sessions.get(sid)!.closeSSEStream(callId as never);
  await assert.rejects(calling, (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response', err.message);
    assert.equal(err.message, 'The connection to the "remote" server closed before it answered, so whether the request took effect is unknown. Check its effect before trying again; this host is reconnecting to it.');
    return true;
  });
  await until(() => reconnects === 1, 'the new session');
  assert.ok(fixture.seen.some((s) => s.method === 'GET' && s.resumed && s.session === sid && s.status === 405), 'the resume met 405');
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 0, 'a session the server let go gets no DELETE');
  assert.equal(count(fixture, (s) => s.rpc === 'tools/call'), 1, 'the cut call was not replayed');
});

test('a call whose stream is cut again before it carried a new event fails at its deadline as no-response, and its session lives on', async () => {
  // SEP-1699's polling, done twice. The SDK resumes a stream cut again
  // before it carried a new event id without its id (typescript-sdk#2499),
  // which the server can't take as this call's stream, so the answer never
  // arrives. An SDK release with the fix gets the call answered, and this
  // fails: the README's sentence on a stream cut twice changes with it.
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: {} });
  const connection = await connect(fixture, { requestTimeoutMs: 3000, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  let reconnects = 0;
  connection.on('reconnect', () => reconnects++);
  await connection.listTools();
  await until(() => count(fixture, (s) => s.method === 'GET' && !s.resumed && s.status === 200) === 1, 'the standalone stream open');
  const transport = fixture.sessions.get(sessionOf(connection)!)!;
  const tool = releaser();
  const calling = connection.callTool('slow', { release: tool.path });
  await until(() => fixture.events.includes('slow-start'), 'the call running');
  const call = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
  transport.closeSSEStream(call as never);
  await until(() => count(fixture, (s) => s.method === 'GET' && s.resumed && s.status === 200) === 1, 'the first resume, with its id');
  transport.closeSSEStream(call as never);
  tool.release();
  await assert.rejects(calling, (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /^The "remote" server didn't answer within 3 seconds, so whether the request took effect is unknown/);
    return true;
  });
  assert.equal(reconnects, 0, "the session wasn't restarted");
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 0, "the session wasn't ended");
  assert.ok(connection.isConnected);
});

test('a session that ends before it answered is a failed connect: refused, reported, and not restarted at once', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture);
  const failed: Array<{ error: string; attempt: number }> = [];
  connection.on('reconnect-failed', (f) => failed.push(f));
  let closes = 0;
  connection.on('close', () => closes++);
  await fixture.forget(false);
  await assert.rejects(connection.callTool('echo', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'error-response');
    assert.deepEqual(err.data, { httpStatus: 404 });
    return true;
  });
  await until(() => closes === 1, 'the connection reported lost');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.attempt, 1);
  assert.match(failed[0]!.error, /ended its session \(HTTP 404\) before the session answered a request/);
  assert.equal(connection.isConnected, false);
  assert.equal(connection.willReconnect, false);
  await sleep(150);
  assert.equal(initializes(fixture).length, 1, 'no new session at once');
});

for (const answered of [false, true]) {
  test(`a second 404 for a session already ended changes nothing (${answered ? 'answered' : 'unanswered'})`, async () => {
    const fixture = await start2025({ versions: ['2025-06-18'] });
    const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
    if (answered) {
      await connection.listTools();
      await outlive(20);
    }
    const events: string[] = [];
    for (const event of ['close', 'reconnect-failed', 'reconnect']) connection.on(event, () => events.push(event));
    const internals = connection as unknown as { session: unknown; sessionEnded: (session: unknown) => void };
    const session = internals.session;
    internals.sessionEnded.call(connection, session);
    internals.sessionEnded.call(connection, session);
    if (answered) {
      await until(() => events.includes('reconnect'), 'the new session');
      assert.deepEqual(events, ['close', 'reconnect']);
      assert.equal(initializes(fixture).length, 2, 'one new session');
    } else {
      assert.deepEqual(events, ['reconnect-failed', 'close']);
    }
  });
}

for (const reconnect of [true, false]) {
  test(`a restart whose connect fails is attempt 1 of a reconnect: ${reconnect ? 'attempt 2 follows the doubled backoff' : 'without reconnect, the connection closes for good'}`, async (t) => {
    t.mock.method(Math, 'random', () => 0.5);
    let failInitialize = false;
    const fixture = await start2025({
      versions: ['2025-06-18'],
      answer: (message, res) => {
        if (message.method !== 'initialize' || !failInitialize) return false;
        failInitialize = false;
        res.writeHead(503).end();
        return true;
      },
    });
    const connection = await connect(fixture, { reconnect, reconnectIntervalMs: 50, reconnectMaxIntervalMs: 1000 });
    await connection.listTools();
    await outlive(50);
    const events: string[] = [];
    connection.on('close', () => events.push(`close willReconnect=${connection.willReconnect}`));
    connection.on('reconnect-failed', (f: { attempt: number }) => events.push(`reconnect-failed ${f.attempt}`));
    connection.on('reconnect', (r: { attempts: number }) => events.push(`reconnect ${r.attempts}`));
    failInitialize = true;
    await fixture.forget(false);
    await connection.callTool('echo', {}).catch(() => {});
    if (reconnect) {
      await until(() => events.includes('reconnect 2'), 'the second attempt connecting');
      assert.deepEqual(events, ['close willReconnect=true', 'reconnect-failed 1', 'reconnect 2']);
      const [, failed, retried] = initializes(fixture).map((s) => s.at);
      assert.ok(retried! - failed! >= 95, `the retry waited ${retried! - failed!} ms, less than the doubled backoff`);
    } else {
      await until(() => events.length === 3, 'the connection closing for good');
      assert.deepEqual(events, ['close willReconnect=true', 'reconnect-failed 1', 'close willReconnect=false']);
      await sleep(150);
      assert.equal(initializes(fixture).length, 2, 'nothing tried again');
    }
  });
}

test('an answered session\'s end counts failed connects afresh: a later session that ends unanswered is attempt 1', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  const failed: number[] = [];
  let reconnects = 0;
  connection.on('reconnect-failed', (f: { attempt: number }) => failed.push(f.attempt));
  connection.on('reconnect', () => reconnects++);
  const internals = connection as unknown as { session: unknown; sessionEnded: (session: unknown, cause: string) => void };
  const end = () => internals.sessionEnded.call(connection, internals.session, 'ended');
  end();
  await until(() => reconnects === 1, 'the reconnect after attempt 1');
  assert.deepEqual(failed, [1]);
  await connection.listTools();
  await outlive(20);
  end();
  await until(() => reconnects === 2, 'the new session');
  end();
  await until(() => failed.length === 2, 'its end');
  assert.deepEqual(failed, [1, 1]);
});

test('a restart that meets a revision verdict, with reconnect set, stops for good as any reconnect does: alerted, and still registered', async () => {
  let downgraded = false;
  const fixture = await start2025({
    versions: ['2025-06-18'],
    answer: (message, res) => {
      if (message.method !== 'initialize' || !downgraded) return false;
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'downgraded', version: '1' } } });
      return true;
    },
  });
  const connection = await connect(fixture, { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  const events: string[] = [];
  connection.on('close', () => events.push(`close willReconnect=${connection.willReconnect}`));
  connection.on('reconnect-failed', (f: { attempt: number; permanent?: boolean }) => events.push(`reconnect-failed ${f.attempt}${f.permanent ? ' permanent' : ''}`));
  connection.on('reconnect', () => events.push('reconnect'));
  downgraded = true;
  await fixture.forget(false);
  await connection.callTool('echo', {}).catch(() => {});
  await until(() => events.length === 2, 'the verdict');
  await sleep(150);
  assert.deepEqual(events, ['close willReconnect=true', 'reconnect-failed 1 permanent']);
  assert.equal(connection.willReconnect, false);
  assert.equal(initializes(fixture).length, 2, 'nothing tried after the verdict');
});

test('behind a load balancer without sticky sessions, each new session ends unanswered, and the backoff grows', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const fixture = await start2025({
    versions: ['2025-06-18'],
    get: 405,
    answer: (message, res) => {
      if (message.method !== 'tools/list') return false;
      sessionNotFound(res);
      return true;
    },
  });
  const connection = await connect(fixture, { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 10_000 });
  const attempts: number[] = [];
  connection.on('reconnect-failed', (f: { attempt: number }) => attempts.push(f.attempt));
  connection.on('reconnect', () => { void connection.listTools().catch(() => {}); });
  await connection.listTools().catch(() => {});
  await until(() => initializes(fixture).length >= 4, 'three new sessions');
  assert.deepEqual(attempts.slice(0, 3), [1, 2, 3]);
  const [, second, third, fourth] = initializes(fixture).map((s) => s.at);
  assert.ok(third! - second! >= 75, `the third session waited ${third! - second!} ms`);
  assert.ok(fourth! - third! >= 155, `the fourth session waited ${fourth! - third!} ms`);
});

const splitNodes = () => start2025({
  versions: ['2025-06-18'],
  get: 405,
  answer: (message, res) => {
    if (message.method !== 'tools/call') return false;
    sessionNotFound(res);
    return true;
  },
});

function lifecycle(connection: ModernMcpConnection): string[] {
  const events: string[] = [];
  connection.on('close', () => events.push(`close willReconnect=${connection.willReconnect}`));
  connection.on('reconnect-failed', (f: { attempt: number; error: string }) => events.push(`reconnect-failed ${f.attempt}: ${f.error}`));
  connection.on('reconnect', (r: { attempts: number }) => events.push(`reconnect ${r.attempts}`));
  return events;
}

for (const lived of [false, true]) {
  test(`behind a load balancer whose node that issued a session answers its relist, sessions the server ends on another node ${lived ? 'after the base interval each start a new one at once' : 'within the base interval are failed connects after the first, to the fifth attempt, where the framework alerts'}`, async (t) => {
    t.mock.method(Math, 'random', () => 0.5);
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const fixture = await splitNodes();
    const interval = lived ? 200 : 5000;
    const connection = await connect(fixture, { reconnect: true, reconnectIntervalMs: interval, reconnectMaxIntervalMs: lived ? 200 : 100 });
    const events = lifecycle(connection);
    const cycle = async () => {
      await connection.listTools();
      if (lived) clock += interval;
      await connection.callTool('echo', {}).catch(() => {});
    };
    if (lived) {
      await cycle();
      await until(() => events.length === 2, 'the first new session');
      await cycle();
      await until(() => events.length === 4, 'the second new session');
      assert.deepEqual(events, ['close willReconnect=true', 'reconnect 1', 'close willReconnect=true', 'reconnect 1'], 'each restarted at once, no failed connect');
      return;
    }
    connection.on('reconnect', () => { void cycle().catch(() => {}); });
    await cycle();
    await until(() => events.filter((e) => e.startsWith('reconnect-failed')).length >= 5, 'the fifth attempt', 10_000);
    assert.deepEqual(events.slice(0, 2), ['close willReconnect=true', 'reconnect 1']);
    const failed = events.filter((e) => e.startsWith('reconnect-failed')).slice(0, 5);
    assert.deepEqual(failed.map((e) => e.split(':')[0]), [1, 2, 3, 4, 5].map((n) => `reconnect-failed ${n}`));
    for (const line of failed) assert.match(line, /ended its session \(HTTP 404\) less than 5000 ms after the session started$/);
  });
}

for (const before of ['as the first', 'after a session that lived the base interval'] as const) {
  test(`without \`reconnect\`, an answered session the server ends young ${before} starts a new one at once, and a second young end in a row leaves the server gone`, async (t) => {
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const fixture = await splitNodes();
    const interval = 500;
    const connection = await connect(fixture, { reconnectIntervalMs: interval, reconnectMaxIntervalMs: 100 });
    const events = lifecycle(connection);
    const end = async (live: boolean) => {
      await connection.listTools();
      if (live) clock += interval;
      await connection.callTool('echo', {}).catch(() => {});
    };
    const expected: string[] = [];
    if (before !== 'as the first') {
      await end(true);
      expected.push('close willReconnect=true', 'reconnect 1');
      await until(() => events.length === expected.length, 'the lived session\'s new one');
    }
    await end(false);
    expected.push('close willReconnect=true', 'reconnect 1');
    await until(() => events.length === expected.length, 'the young session\'s new one');
    await end(false);
    expected.push(`reconnect-failed 1: MCP server "remote" ended its session (HTTP 404) less than ${interval} ms after the session started`, 'close willReconnect=false');
    await until(() => events.length === expected.length, 'the second young end');
    assert.deepEqual(events, expected);
    assert.equal(connection.willReconnect, false);
  });
}

test('after stopReconnecting(), a session the server ends isn\'t started again: the connection closes for good', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  const events: string[] = [];
  connection.on('close', () => events.push(`close willReconnect=${connection.willReconnect}`));
  for (const name of ['reconnect', 'reconnect-failed']) connection.on(name, () => events.push(name));
  connection.stopReconnecting();
  await fixture.forget(false);
  await assert.rejects(connection.callTool('echo', {}));
  await until(() => events.length > 0, 'the close');
  await sleep(100);
  assert.deepEqual(events, ['close willReconnect=false']);
  assert.equal(initializes(fixture).length, 1, 'no new session');
});

for (const kind of ['restart', 'reconnect'] as const) {
  test(`after stopReconnecting(), a ${kind === 'restart' ? 'new session starting at once in place of one the server ended' : 'reconnect after a failed connect'} that is still connecting doesn't come up, and its session is let go`, async (t) => {
    t.mock.method(Math, 'random', () => 0.5);
    let discoveries = 0;
    let held: ServerResponse | undefined;
    const fixture = await start2025({
      versions: ['2025-06-18'],
      answer: (message, res) => {
        if (message.method !== 'server/discover' || ++discoveries === 1) return false;
        held = res;
        return true;
      },
    });
    const connection = await connect(fixture, { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
    if (kind === 'restart') await connection.listTools();
    const events = lifecycle(connection);
    await fixture.forget(false);
    await assert.rejects(connection.callTool('echo', {}));
    await until(() => held !== undefined, 'the new session\'s discovery, held');
    connection.stopReconnecting();
    json(held!, 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
    await until(() => count(fixture, (s) => s.method === 'DELETE') === 1 && !connection.willReconnect, 'the new session let go');
    assert.deepEqual(events, kind === 'restart'
      ? ['close willReconnect=true']
      : ['reconnect-failed 1: MCP server "remote" ended its session (HTTP 404) before the session answered a request', 'close willReconnect=true']);
    assert.equal(sessionOf(connection), undefined);
    assert.equal(fixture.sessions.size, 0);
    assert.equal(connection.willReconnect, false);
  });
}

test('in the framework, connects that land on 2025 while every later request is refused with -32022 back off, and the alert comes at its threshold', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const fixture = await start2025({
    versions: ['2025-06-18'],
    stateless: true,
    answer: (message, res) => {
      if (message.method === 'server/discover' || message.method === 'initialize' || message.method === 'notifications/initialized') return false;
      json(res, 400, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32022, message: 'Unsupported protocol version: 2025-06-18', data: { supported: ['2026-07-28'], requested: '2025-06-18' } } });
      return true;
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'mcp-2025-framework-'));
  const traces: TraceEvent[] = [];
  const watcher: Module = {
    name: 'trace-watcher',
    async start(ctx: ModuleContext) { ctx.onTrace((event) => traces.push(event)); },
    async stop() {},
    getTools: () => [],
    handleToolCall: async () => ({ success: false, error: 'no tools', isError: true }),
    onProcess: async () => ({}),
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [watcher],
    mcplServers: [{ id: 'remote', url: fixture.url, reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 1000 }],
  });
  cleanups.push(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  await until(() => traces.some((event) => event.type === 'ops:alert'), 'the alert', 10_000);
  const attempts = traces.filter((event) => event.type === 'mcpl:server-connect-failed').map((event) => (event as { attempt?: number }).attempt);
  assert.deepEqual(attempts.slice(0, 5), [1, 2, 3, 4, 5]);
  const alert = traces.find((event) => event.type === 'ops:alert') as { kind?: string; message?: string };
  assert.equal(alert.kind, 'mcpl-down');
  assert.match(alert.message ?? '', /attempt 5\b.*refused its session's revision \(HTTP 400, -32022\)/);
});

test('a request whose POST fails keeps nothing for the session\'s life', async () => {
  const fixture = await start2025({
    versions: ['2025-06-18'],
    answer: (message, res) => {
      if (message.method !== 'tools/call') return false;
      res.writeHead(500).end();
      return true;
    },
  });
  const connection = await connect(fixture);
  await connection.listTools();
  await assert.rejects(connection.callTool('echo', {}));
  assert.ok(connection.isConnected);
  assert.equal(heldAborts(connection), 0);
});

test('a deadline on a 2025 call: cancellation is POSTed, and the server sees the abort', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { requestTimeoutMs: 300 });
  await assert.rejects(connection.callTool('slow', { ms: 1500 }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /^The "remote" server didn't answer within 0\.3 seconds, so whether the request took effect is unknown: this host asked it to cancel/);
    return true;
  });
  await until(() => fixture.events.includes('slow-aborted'), 'the server seeing the cancellation');
  assert.equal(count(fixture, (s) => s.rpc === 'notifications/cancelled'), 1);
  assert.equal(heldAborts(connection), 0, 'nothing kept for the cancelled request');
});

test('close() at the moment a connect adopts its session ends that session once', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url });
  connection.on('error', () => {});
  const internals = connection as unknown as { establish: (session: unknown) => Promise<void> };
  const establish = internals.establish.bind(connection);
  let closing: Promise<void> | undefined;
  internals.establish = async (session: unknown) => {
    await establish(session);
    closing = connection.close();
  };
  const statics = ModernMcpConnection as unknown as { closeSession: (session: unknown) => Promise<Error | null> };
  const real = statics.closeSession;
  const closed: unknown[] = [];
  statics.closeSession = async (session: unknown) => {
    closed.push(session);
    return real.call(ModernMcpConnection, session);
  };
  cleanups.push(() => { statics.closeSession = real; });
  await connection.start();
  await closing;
  statics.closeSession = real;
  assert.equal(closed.length, 1, 'the session was closed once');
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 1);
});

test('close() DELETEs a live session, and leaves alone one the server ended', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await outlive(20);
  const ended = sessionOf(connection)!;
  let reconnects = 0;
  connection.on('reconnect', () => reconnects++);
  await fixture.forget(false);
  await connection.callTool('echo', {}).catch(() => {});
  await until(() => reconnects === 1, 'the new session');
  const live = sessionOf(connection)!;
  await connection.close();
  const deletes = fixture.seen.filter((s) => s.method === 'DELETE');
  assert.deepEqual(deletes.map((s) => [s.session, s.status]), [[live, 200]]);
  assert.ok(!deletes.some((s) => s.session === ended));
  assert.equal(fixture.sessions.size, 0, 'the server dropped the live session');
});

test('close() waits for a DELETE the server never answers only so long', { timeout: 20_000 }, async () => {
  const fixture = await start2025({ versions: ['2025-06-18'], deleteHangs: true });
  const connection = await connect(fixture);
  const began = Date.now();
  await connection.close();
  const took = Date.now() - began;
  assert.ok(took >= 2900, `close() took ${took} ms, less than the DELETE's bound`);
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 1);
});

test('close() while the stream\'s first open waits to try again sends no more tries, though the DELETE is never answered', { timeout: 20_000 }, async () => {
  const fixture = await start2025({ versions: ['2025-06-18'], get: 503, deleteHangs: true });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  let closing: Promise<void> | undefined;
  let tried = 0;
  connection.on('error', () => {
    if (closing) return;
    tried = count(fixture, (s) => s.method === 'GET');
    closing = connection.close();
  });
  await until(() => closing !== undefined, 'the first open failing');
  await closing;
  assert.equal(count(fixture, (s) => s.method === 'GET'), tried, 'no GET after close()');
});

test('close() during a connect ends the session the server already issued', async () => {
  let held: ServerResponse | undefined;
  const fixture = await start2025({
    versions: ['2025-06-18'],
    answer: (message, res) => {
      if (message.method !== 'notifications/initialized') return false;
      held = res;
      return true;
    },
  });
  cleanups.push(() => { held?.destroy(); });
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url });
  connection.on('error', () => {});
  const starting = connection.start().catch(() => {});
  await until(() => held !== undefined, 'the handshake waiting on its notification');
  assert.equal(fixture.sessions.size, 1, 'initialize was answered with a session');
  const [issued] = fixture.sessions.keys();
  await connection.close();
  await starting;
  assert.deepEqual(fixture.seen.filter((s) => s.method === 'DELETE').map((s) => [s.session, s.status]), [[issued, 200]]);
  assert.equal(fixture.sessions.size, 0);
});

test('a connect that fails after its initialize was answered DELETEs the session the server allocated, once', async () => {
  const fixture = await start2025({
    versions: ['2025-06-18'],
    answer: (message, res) => {
      if (message.method !== 'notifications/initialized') return false;
      res.writeHead(503).end('temporarily unavailable');
      return true;
    },
  });
  const connection = ModernMcpConnection.create({ id: 'failed-start', url: fixture.url });
  connection.on('error', () => {});
  cleanups.push(() => connection.close());
  await assert.rejects(connection.start(), (error: unknown) => (error as Error).name === 'SdkHttpError' && /temporarily unavailable/.test((error as Error).message));
  assert.equal(initializes(fixture).length, 1);
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 1, 'the session the server allocated is DELETEd');
  assert.equal(fixture.sessions.size, 0);
  await connection.close();
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 1, 'once');
});

for (const [what, get] of [['405', 405], ['404', 404]] as const) {
  test(`a server that answers the first GET ${what} has no stream: nothing ends, and it isn't asked again`, async () => {
    const fixture = await start2025({ versions: ['2025-06-18'], get });
    const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
    let events = 0;
    for (const event of ['close', 'reconnect', 'reconnect-failed']) connection.on(event, () => events++);
    await connection.listTools();
    assert.deepEqual((await connection.callTool('echo', { text: 'x' })).content, [{ type: 'text', text: 'echo:x' }]);
    await sleep(150);
    assert.equal(count(fixture, (s) => s.method === 'GET'), 1);
    assert.equal(initializes(fixture).length, 1);
    assert.equal(events, 0);
    assert.ok(connection.isConnected);
  });
}

async function refused(fixture: Fixture, extra: Partial<McplServerConfig> = {}): Promise<McplProtocolVersionError> {
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40, ...extra });
  connection.on('error', () => {});
  cleanups.push(() => connection.close());
  let verdict: McplProtocolVersionError | undefined;
  await assert.rejects(connection.start(), (err: unknown) => {
    assert.ok(err instanceof McplProtocolVersionError, String(err));
    verdict = err;
    return true;
  });
  const asked = fixture.seen.length;
  assert.equal(connection.willReconnect, false);
  assert.equal((connection as unknown as { reconnectTimer: unknown }).reconnectTimer, null);
  await sleep(100);
  assert.equal(fixture.seen.length, asked, 'no reconnect loop');
  assert.equal(verdict!.offered, '2026-07-28');
  assert.deepEqual(verdict!.offeredRevisions, HTTP_OFFER);
  return verdict!;
}

test('a discovery refusal that lists no revision in common is a verdict, naming both sides', async () => {
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method !== 'server/discover') return false;
      json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2099-01-01'], requested: '2026-07-28' } } });
      return true;
    },
  });
  const verdict = await refused(fixture);
  assert.equal(verdict.kind, 'rejected');
  assert.deepEqual(verdict.supported, ['2099-01-01']);
  assert.equal(verdict.code, -32022);
  // The SDK refused the revision it asked for, and tried nothing else.
  assert.match(verdict.message, /^MCP server "remote" does not support MCP 2026-07-28 \(it supports: 2099-01-01\)\.$/);
  assert.equal(initializes(fixture).length, 0);
});

test('a discovery refusal naming a newer revision ends negotiation though it also lists a 2025 one, and says so', async () => {
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method !== 'server/discover') return false;
      json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2099-01-01', '2025-06-18'], requested: '2026-07-28' } } });
      return true;
    },
  });
  const verdict = await refused(fixture);
  assert.equal(verdict.kind, 'rejected');
  assert.match(verdict.message, /does not support MCP 2026-07-28 \(it supports: 2099-01-01, 2025-06-18\)\. It lists 2025-06-18, which this client also speaks, but the SDK negotiates no further after this refusal\.$/);
  assert.equal(initializes(fixture).length, 0);
});

test('an initialize answered with a revision the 2025 handshake doesn\'t accept is a mismatch, read from the wire', async () => {
  const fixture = await start2025({ versions: ['2024-11-05'] });
  const verdict = await refused(fixture);
  assert.equal(verdict.kind, 'mismatch');
  assert.equal(verdict.returned, '2024-11-05');
  assert.match(verdict.message, /^MCP server "remote" answered initialize with MCP 2024-11-05, which this client reaches over stdio or WebSocket \(ws:\/\/, wss:\/\/\), not http\(s\)\. Over http\(s\) this client's initialize accepts 2025-11-25, 2025-06-18 or 2025-03-26\.$/);
});

test('an initialize answered with 2026-07-28 is a mismatch: that revision is negotiated through discovery alone', async () => {
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method !== 'initialize') return false;
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2026-07-28', capabilities: {}, serverInfo: { name: 'half-upgraded', version: '1' } } });
      return true;
    },
  });
  const verdict = await refused(fixture);
  assert.equal(verdict.kind, 'mismatch');
  assert.equal(verdict.returned, '2026-07-28');
  assert.match(verdict.message, /answered initialize with MCP 2026-07-28, which this client negotiates through server\/discover, not initialize\./);
});

test('an initialize answered without a revision is a mismatch, read from the wire', async () => {
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method !== 'initialize') return false;
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { capabilities: {}, serverInfo: { name: 'unversioned', version: '1' } } });
      return true;
    },
  });
  const verdict = await refused(fixture);
  assert.equal(verdict.kind, 'mismatch');
  assert.equal(verdict.returned, null);
  assert.match(verdict.message, /^MCP server "remote" answered initialize without naming a protocol revision\. Over http\(s\) this client's initialize accepts 2025-11-25, 2025-06-18 or 2025-03-26\.$/);
});

test('a verdict read from the wire carries none of a credential the server\'s initialize or discovery quotes', async () => {
  const token = 'tok-0123456789abcdef';
  const mismatched = await start2025({
    answer: (message, res) => {
      if (message.method !== 'initialize') return false;
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: `v-${token}`, capabilities: {}, serverInfo: { name: 'echoing', version: '1' } } });
      return true;
    },
  });
  const mismatch = await refused(mismatched, { token });
  assert.equal(mismatch.kind, 'mismatch');
  assert.equal(mismatch.returned, 'v-redacted');
  assert.match(mismatch.message, /^MCP server "remote" answered initialize with MCP v-redacted\. /);
  // A -32022 discovery error whose list (an older revision, so the SDK goes on
  // to the 2025 handshake) and data quote it, then a refused initialize.
  const listing = await start2025({
    answer: (message, res) => {
      if (message.method === 'server/discover') {
        json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [`2024-10-07-${token}`], echoed: token } } });
        return true;
      }
      if (message.method === 'initialize') {
        json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        return true;
      }
      return false;
    },
  });
  const listed = await refused(listing, { token });
  assert.equal(listed.kind, 'rejected');
  assert.deepEqual(listed.supported, ['2024-10-07-redacted']);
  assert.equal(initializes(listing).length, 1, 'the 2025 handshake was tried');
  assert.match(listed.message, /\(it supports: 2024-10-07-redacted\)\.$/);
  for (const verdict of [mismatch, listed]) {
    assert.ok(!verdict.message.includes(token), verdict.message);
    assert.ok(!JSON.stringify(verdict).includes(token), JSON.stringify(verdict));
    assert.ok(!JSON.stringify(verdict.data ?? null).includes(token), JSON.stringify(verdict.data));
  }
  const spanning = '2024-10-07-a, 2024-10-07-b';
  const split = await start2025({
    answer: (message, res) => {
      if (message.method === 'server/discover') {
        json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2024-10-07-a', '2024-10-07-b'] } } });
        return true;
      }
      if (message.method === 'initialize') {
        json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        return true;
      }
      return false;
    },
  });
  const joined = await refused(split, { token: spanning });
  assert.equal(joined.kind, 'rejected');
  assert.ok(!joined.message.includes(spanning), joined.message);
  assert.match(joined.message, /\(it supports: redacted\)\.$/);
});

test('a failed initialize that refused nothing, after a discovery with no revision in common, is no verdict: it is retried', async () => {
  let initializeFailures = 1;
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method === 'server/discover') {
        json(res, 200, { jsonrpc: '2.0', id: message.id, result: { supportedVersions: ['2099-01-01'], capabilities: {} } });
        return true;
      }
      if (message.method === 'initialize' && initializeFailures-- > 0) {
        res.writeHead(503).end();
        return true;
      }
      return false;
    },
  });
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  connection.on('error', () => {});
  cleanups.push(() => connection.close());
  const failures: unknown[] = [];
  connection.on('connect-failed', (f) => failures.push(f));
  let reconnected = false;
  connection.on('reconnect', () => { reconnected = true; });
  await connection.start();
  await until(() => reconnected, 'the retry connecting');
  assert.equal(failures.length, 1);
  assert.equal(connection.protocolVersion, '2025-11-25');
  assert.equal(initializes(fixture).length, 2);
});

for (const [what, listing, listed] of [
  ['a discovery result', { result: { supportedVersions: ['2099-01-01'], capabilities: {} } }, ['2099-01-01']],
  ['a -32022 error', { error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2024-10-07'] } } }, ['2024-10-07']],
] as const) {
  test(`${what} listing no revision in common, then a failed initialize, is a verdict naming the list`, async () => {
    const fixture = await start2025({
      answer: (message, res) => {
        if (message.method === 'server/discover') {
          json(res, 200, { jsonrpc: '2.0', id: message.id, ...listing });
          return true;
        }
        if (message.method === 'initialize') {
          json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
          return true;
        }
        return false;
      },
    });
    const verdict = await refused(fixture);
    assert.equal(verdict.kind, 'rejected');
    assert.deepEqual(verdict.supported, listed);
    assert.equal(verdict.code, 'error' in listing ? -32022 : undefined);
    assert.match(verdict.message, new RegExp(`does not support MCP 2026-07-28, 2025-11-25, 2025-06-18 or 2025-03-26 \\(it supports: ${listed[0]}\\)\\.$`));
    assert.equal(initializes(fixture).length, 1, 'the fallback was tried once');
  });
}

test('in the framework: status shows the negotiated revision, and an ended session keeps the server and its tools', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const dir = mkdtempSync(join(tmpdir(), 'mcp-2025-framework-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [],
    mcplServers: [{ id: 'remote', url: fixture.url, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 }],
  });
  cleanups.push(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const [status] = framework.listMcplServers();
  assert.equal(status!.family, 'modern');
  assert.equal(status!.transport, 'http');
  assert.equal(status!.protocolVersion, '2025-06-18');
  assert.ok(framework.getAllTools().some((tool) => tool.name === 'mcpl--remote--echo'));
  const first = fixture.seen.find((s) => s.rpc === 'tools/list')!.session;
  await outlive(20);
  await fixture.forget(false);
  const failed = await framework.executeToolCall({ id: 'after-end', name: 'mcpl--remote--echo', input: { text: 'x' } });
  assert.equal(failed.success, false);
  assert.match(failed.error!, /The "remote" server had ended this connection's session, so the request didn't run\. This host is reconnecting to it; try again later\./);
  const [during] = framework.listMcplServers();
  assert.ok(during!.connected || during!.retrying, JSON.stringify(during));
  await until(() => fixture.seen.some((s) => s.rpc === 'tools/list' && s.status === 200 && s.session !== first), 'the new session, relisted');
  assert.ok(framework.getAllTools().some((tool) => tool.name === 'mcpl--remote--echo'));
  const echoed = await framework.executeToolCall({ id: 'after-restart', name: 'mcpl--remote--echo', input: { text: 'back' } });
  assert.equal(echoed.success, true, JSON.stringify(echoed));
});
