/**
 * The modern engine over Streamable HTTP against servers on the 2025
 * revisions, which it reaches by negotiating at each connect: `server/discover`
 * first, then a 2025 `initialize` when the server shows no 2026-07-28. The
 * fixture is an in-process stateful 2025 server: the SDK's
 * WebStandardStreamableHTTPServerTransport with a session id per `initialize`,
 * serving the shared modern-tools fixture at the revision a test chooses. It
 * can forget its sessions, as a restarted server does, and answer a request
 * itself where an SDK server can't be made to answer as the case needs.
 *
 * What it pins, beside each 2025 revision connecting, listing and calling:
 * - 2026-07-28 still wins when the server offers it, a dual server included;
 * - every 2025 result is final: an answered result that fails its schema is a
 *   plain error, not an unknown outcome;
 * - list changes arrive on the session's standalone stream, which is opened
 *   and reopened for as long as the session lives, at the server's retry
 *   hint or the backoff. A reopen that can't replay what it missed refreshes
 *   the inventory; one that can doesn't. A request's cut stream is resumed
 *   only while its request lives;
 * - a 404 to a request carrying the session's id ends the session, except
 *   the stream's first open. The call whose POST met it is refused (404). A
 *   session that had answered gets a new one at once ('close', then
 *   'reconnect'); one that hadn't is a failed connect, backing off;
 * - `close()` DELETEs each session the server holds, bounded, and leaves an
 *   ended one alone;
 * - a server with no revision in common is a permanent verdict, read from
 *   the wire, with no reconnect loop; a handshake that failed without an
 *   answer is no verdict.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

import { WebStandardStreamableHTTPServerTransport, createMcpHandler, fromJsonSchema, type EventStore, type JSONRPCMessage, type McpServer } from '@modelcontextprotocol/server';
import { AgentFramework } from '../src/framework.js';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { McplProtocolVersionError, McplRequestError } from '../src/mcpl/server-connection.js';
import { MAX_TIMER_MS } from '../src/mcpl/protocol-family.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTTP_OFFER = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

type Message = { method?: unknown; id?: unknown; params?: Record<string, unknown> };
/** A request the test answers itself, at the HTTP layer. True once answered. */
type HandAnswer = (message: Message, res: ServerResponse) => boolean;

interface Seen {
  method: string;
  session: string | null;
  rpc: string | null;
  /** The JSON-RPC id of a request. */
  id: unknown;
  /** A GET that carried Last-Event-ID: a stream resumed. */
  resumed: boolean;
  status: number;
  at: number;
}

interface Fixture {
  url: string;
  /** Every request, with the status it was answered with. */
  seen: Seen[];
  /** Server-side tool events (`slow-aborted` and the like). */
  events: string[];
  /** The sessions the server holds, by id. */
  sessions: Map<string, WebStandardStreamableHTTPServerTransport>;
  /** Statuses for the next GETs without Last-Event-ID, used up in order,
   *  before the session's own stream. */
  getAnswers: number[];
  /** The same for GETs that resume a stream (with Last-Event-ID). */
  resumeAnswers: number[];
  /** Forget every session, as a restarted server has. With `cut`, also end
   *  their streams, as a restart's lost connections do. */
  forget(cut: boolean): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
};

/** A stateful server's answer to a request that carries an id it doesn't hold. */
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
  // The client going away cancels the server's stream, as a real server's would.
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

/** Every stream's events, kept for replay, as a resumable server keeps them.
 *  A priming event (an empty message) is stored but never replayed. */
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
  /** The revisions `initialize` can settle on. */
  versions?: string[];
  /** A status every GET without Last-Event-ID is answered with, instead of a
   *  stream. */
  get?: number;
  /** Keep every stream's events and give them ids, with a priming event on
   *  each request's stream (2025-11-25), so a cut stream can be resumed. With
   *  `retryMs`, the priming events carry that retry hint. */
  resumable?: { retryMs?: number };
  answer?: HandAnswer;
  /** DELETE is never answered. */
  deleteHangs?: boolean;
  /** Registers more tools on each session's server. */
  extra?: (server: McpServer) => void;
} = {}): Promise<Fixture> {
  const { createServer } = await tools();
  const seen: Seen[] = [];
  const events: string[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const getAnswers: number[] = [];
  const resumeAnswers: number[] = [];
  const eventStore = opts.resumable ? memoryEventStore() : undefined;
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let message: Message | undefined;
    try { message = body.length > 0 ? JSON.parse(body.toString('utf8')) as Message : undefined; } catch { message = undefined; }
    const session = (req.headers['mcp-session-id'] as string | undefined) ?? null;
    const resumed = req.headers['last-event-id'] !== undefined;
    const entry: Seen = {
      method: req.method ?? '', session, rpc: typeof message?.method === 'string' ? message.method : null, id: message?.id, resumed, status: 0, at: Date.now(),
    };
    seen.push(entry);
    const writeHead = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => ServerResponse;
    res.writeHead = ((status: number, ...rest: unknown[]) => { entry.status = status; return writeHead(status, ...rest); }) as never;
    if (req.method === 'POST' && message && opts.answer?.(message, res)) return;
    if (req.method === 'GET') {
      const status = resumed ? resumeAnswers.shift() : getAnswers.shift() ?? opts.get;
      if (status !== undefined) {
        res.writeHead(status).end();
        return;
      }
    }
    if (req.method === 'DELETE' && opts.deleteHangs) return;
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
  return {
    url,
    seen,
    events,
    sessions,
    getAnswers,
    resumeAnswers,
    async forget(cut: boolean) {
      const live = [...sessions.values()];
      sessions.clear();
      if (cut) for (const transport of live) await transport.close();
    },
  };
}

async function connect(fixture: { url: string }, extra: Partial<McplServerConfig> = {}): Promise<ModernMcpConnection> {
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, ...extra });
  // Out-of-band transport errors (a stream that didn't open) are expected here.
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
const count = (fixture: Fixture, what: (s: Seen) => boolean) => fixture.seen.filter(what).length;
const initializes = (fixture: Fixture) => fixture.seen.filter((s) => s.rpc === 'initialize');
const sessionOf = (connection: ModernMcpConnection) =>
  (connection as unknown as { session: { http?: { transport: { sessionId?: string } } } | null }).session?.http?.transport.sessionId;
/** The requests whose own abort the connection still holds: none, once each is answered or cancelled. */
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
    // The discover probe went first, without a session; then the 2025 handshake.
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

test('a 2025 result is final: one that fails its output schema is a plain error, not an unknown outcome', async () => {
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
    assert.match((err as Error).message, /answered tools\/call "typed", but the result can't be used: .*output schema/);
    return true;
  });
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
  // There's no subscription to keep on 2025: nothing tries to open one.
  await sleep(150);
  assert.deepEqual(errors.filter((message) => /subscription/.test(message)), []);
});

test('the standalone stream reopens after the server closes it, and the reopen refreshes the inventory', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  const streams = () => count(fixture, (s) => s.method === 'GET' && s.status === 200);
  await until(() => streams() === 1, 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await until(() => streams() === 2, 'the stream reopened');
  await until(() => changes === 1, 'the refresh after the reopen');
  // The reopened stream carries what the server announces.
  await connection.callTool('add_tool', {});
  await until(() => changes === 2, 'a list change on the reopened stream');
});

test('the standalone stream keeps trying while its session lives, past the transport\'s default two retries, backing off', async (t) => {
  t.mock.method(Math, 'random', () => 0.5); // no jitter
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 10, reconnectMaxIntervalMs: 1000 });
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  fixture.getAnswers.push(503, 503, 503, 503);
  const cut = Date.now();
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 2, 'the stream back after four failed tries');
  assert.equal(count(fixture, (s) => s.method === 'GET' && s.status === 503), 4);
  // The tries waited 10, 20, 40, 80 and 160 ms: the connection's backoff.
  const back = fixture.seen.filter((s) => s.method === 'GET' && s.status === 200)[1]!.at;
  assert.ok(back - cut >= 300, `the stream came back ${back - cut} ms after the cut`);
  await until(() => changes === 1, 'the refresh after the reopen');
  assert.ok(connection.isConnected);
});

test('the standalone stream\'s first open is tried again after a failure that may pass, each one reported, and then carries list changes', async (t) => {
  t.mock.method(Math, 'random', () => 0.5); // no jitter
  const fixture = await start2025({ versions: ['2025-06-18'] });
  // The SDK makes this open once; the connection tries it again.
  fixture.getAnswers.push(503, 429);
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  cleanups.push(() => connection.close());
  await connection.start();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open after two failures');
  assert.deepEqual(fixture.seen.filter((s) => s.method === 'GET').map((s) => s.status), [503, 429, 200]);
  assert.deepEqual(errors, [
    'MCP server "remote" did not open its list-change stream (HTTP 503); trying again',
    'MCP server "remote" did not open its list-change stream (HTTP 429); trying again',
  ]);
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.callTool('add_tool', {});
  await until(() => changes === 1, 'the list change on the stream that opened');
});

test('a request stream resumed before the standalone stream first opens doesn\'t make that open a reopen', async (t) => {
  t.mock.method(Math, 'random', () => 0.5); // no jitter
  // The call's resume comes at the server's 50 ms hint; the first open's retry at 400 ms.
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: { retryMs: 50 } });
  fixture.getAnswers.push(503);
  const connection = await connect(fixture, { reconnectIntervalMs: 400, reconnectMaxIntervalMs: 800 });
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  const calling = connection.callTool('slow', { ms: 150 });
  await until(() => fixture.events.includes('slow-start'), 'the call running');
  const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
  fixture.sessions.get(sessionOf(connection)!)!.closeSSEStream(callId as never);
  await calling; // its answer came on the resumed stream
  assert.ok(fixture.seen.some((s) => s.method === 'GET' && s.resumed && s.status === 200), 'the call\'s stream resumed');
  await until(() => count(fixture, (s) => s.method === 'GET' && !s.resumed && s.status === 200) === 1, 'the standalone stream open at last');
  await sleep(100);
  assert.equal(changes, 0, 'its first open relisted nothing');
});

test('a first open refused in a way that won\'t pass (501) isn\'t tried again', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'], get: 501 });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await sleep(150);
  assert.equal(count(fixture, (s) => s.method === 'GET'), 1);
  assert.ok(connection.isConnected);
});

test('a standalone stream resumed with Last-Event-ID has what it missed replayed, and relists nothing', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: {} });
  const connection = await connect(fixture, { reconnectIntervalMs: 200, reconnectMaxIntervalMs: 400 });
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  // An event with an id reaches the stream, so its reopen can ask for what came after.
  await connection.callTool('add_tool', {});
  await until(() => changes === 1, 'the first list change');
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  // While the stream is down (its reopen waits 200 ms), the server announces another.
  await connection.callTool('add_tool', {});
  await until(() => count(fixture, (s) => s.method === 'GET' && s.resumed && s.status === 200) === 1, 'the stream resumed');
  await until(() => changes === 2, 'the missed change, replayed');
  await sleep(150);
  assert.equal(changes, 2, 'the resume relisted nothing');
});

test('a standalone resume refused with 400 opens again without its event id, and relists what it missed', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: {} });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  // An event with an id, so the stream's return asks for what came after it.
  await connection.callTool('add_tool', {});
  await until(() => changes === 1, 'the first list change');
  // The server no longer holds that id.
  fixture.resumeAnswers.push(400);
  fixture.sessions.get(sessionOf(connection)!)!.closeStandaloneSSEStream();
  await until(() => changes === 2, 'the relist after the stream came back without replay');
  const gets = fixture.seen.filter((s) => s.method === 'GET').map((s) => [s.resumed, s.status]);
  assert.deepEqual(gets, [[false, 200], [true, 400], [false, 200]]);
  // The stream that came back carries what the server announces next.
  await connection.callTool('add_tool', {});
  await until(() => changes === 3, 'a list change on the stream that came back');
});

test('the server\'s retry hint paces the stream\'s return, end to end', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], resumable: { retryMs: 300 } });
  // The base interval is a minute: only the hint brings the stream back within the test.
  const connection = await connect(fixture, { reconnectIntervalMs: 60_000, reconnectMaxIntervalMs: 60_000 });
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open');
  // A request's priming event carries the hint.
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
      // A cancel that hangs: the server never answers its POST.
      answer: (message) => held && message.method === 'notifications/cancelled',
    });
    const connection = await connect(fixture, { requestTimeoutMs: 400, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
    await connection.listTools();
    // Every resume fails, as from a server whose event store lost the stream:
    // a 400 for the id, then outages.
    fixture.resumeAnswers.push(400, ...Array<number>(1000).fill(503));
    const calling = connection.callTool('slow', { ms: 5000 });
    await until(() => fixture.events.includes('slow-start'), 'the call running');
    const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
    fixture.sessions.get(sessionOf(connection)!)!.closeSSEStream(callId as never);
    await assert.rejects(calling, (err: unknown) => {
      assert.ok(err instanceof McplRequestError, String(err));
      assert.equal(err.outcome, 'no-response');
      assert.match(err.message, /Cancellation was requested; the outcome is unknown/);
      return true;
    });
    const resumes = () => count(fixture, (s) => s.method === 'GET' && s.resumed);
    assert.ok(resumes() > 1, 'the stream was resumed, past the 400, while the call lived');
    // A resume already under way may still land; then the count holds for
    // longer than the 20-40 ms between tries.
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
    // A request's resume isn't the standalone stream: nothing opened beside it.
    assert.equal(count(fixture, (s) => s.method === 'GET' && !s.resumed), 1);
    assert.equal(count(fixture, (s) => s.rpc === 'notifications/cancelled'), 1);
    assert.ok(connection.isConnected);
  });
}

test('a stream retry waits the server\'s hint first, and never less than the backoff after a failed try', (t) => {
  const connection = ModernMcpConnection.create({ id: 'remote', url: 'http://127.0.0.1:1/mcp', reconnectIntervalMs: 100, reconnectMaxIntervalMs: 10_000_000 });
  t.mock.method(Math, 'random', () => 0.5); // no jitter
  const delays: number[] = [];
  t.mock.method(globalThis, 'setTimeout', ((_fn: () => void, ms: number) => { delays.push(ms); return { unref() {} }; }) as never);
  const retry = (connection as unknown as { streamRetry: (reconnect: () => void, hinted: number, attempt: number) => unknown }).streamRetry;
  retry(() => {}, 0, 0); // no hint: the base interval
  retry(() => {}, 50, 0); // the hint, as given, even below the base interval
  retry(() => {}, 10, 3); // after failed tries: the backoff, not the short hint
  retry(() => {}, 100_000, 1); // a hint longer than the backoff
  retry(() => {}, 2 ** 40, 0); // never past the timer limit
  assert.deepEqual(delays, [100, 50, 800, 100_000, MAX_TIMER_MS]);
});

test('a session the server ended under a call: the call is refused with 404, and a new session starts at once', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'] });
  // No `reconnect`: a session that served gets a new one anyway.
  const connection = await connect(fixture);
  await connection.listTools();
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
    assert.equal(err.code, undefined);
    assert.deepEqual(err.data, { httpStatus: 404 });
    assert.match(err.message, /refused tools\/call "echo": HTTP 404\. The server had ended this connection's session, so the request was not run\./);
    return true;
  });
  // The new session is still starting: down, and coming back.
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

test('close() while the new session starts stops it: nothing reconnects, and no second close', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'] });
  const connection = await connect(fixture);
  await connection.listTools();
  const events: string[] = [];
  for (const event of ['close', 'reconnect', 'reconnect-failed']) connection.on(event, () => events.push(event));
  await fixture.forget(false);
  await connection.callTool('echo', {}).catch(() => {});
  assert.equal(connection.willReconnect, true, 'the new session is starting');
  await connection.close();
  // The session's end emitted 'close'; closing during the restart adds none.
  assert.deepEqual(events, ['close']);
  await sleep(100);
  assert.deepEqual(events, ['close']);
  assert.equal(connection.isConnected, false);
});

test('a session the server ended while idle: the stream\'s reopen meets 404, and a new session starts', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  await until(() => count(fixture, (s) => s.method === 'GET' && s.status === 200) === 1, 'the stream open');
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

test('a cut request stream whose resume meets 404 ends the session, though no standalone stream ever opened', async () => {
  const fixture = await start2025({ versions: ['2025-11-25'], get: 405, resumable: {} });
  const connection = await connect(fixture, { reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  let reconnects = 0;
  connection.on('reconnect', () => reconnects++);
  const calling = connection.callTool('slow', { ms: 5000 });
  await until(() => fixture.events.includes('slow-start'), 'the call running');
  const sid = sessionOf(connection)!;
  const transport = fixture.sessions.get(sid)!;
  const callId = fixture.seen.find((s) => s.rpc === 'tools/call')!.id;
  // A restart: the session is forgotten, and the call's stream cut after its priming event.
  await fixture.forget(false);
  transport.closeSSEStream(callId as never);
  await assert.rejects(calling, (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    // Its POST was answered: the server may have run it.
    assert.equal(err.outcome, 'no-response', err.message);
    assert.match(err.message, /The outcome is unknown: the server may already have acted on the call\./);
    return true;
  });
  await until(() => reconnects === 1, 'the new session');
  assert.ok(fixture.seen.some((s) => s.method === 'GET' && s.resumed && s.session === sid && s.status === 404), 'the resume met 404');
  assert.equal(count(fixture, (s) => s.method === 'GET' && !s.resumed), 2, 'one standalone GET per session, each refused');
  assert.equal(count(fixture, (s) => s.rpc === 'tools/call'), 1, 'the cut call was not replayed');
});

test('a session that ends before it answered is a failed connect: refused, reported, and not restarted at once', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture); // no `reconnect`
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
    const connection = await connect(fixture);
    if (answered) await connection.listTools();
    const events: string[] = [];
    for (const event of ['close', 'reconnect-failed', 'reconnect']) connection.on(event, () => events.push(event));
    const internals = connection as unknown as { session: unknown; sessionEnded: (session: unknown) => void };
    const session = internals.session;
    // Two requests of the session met 404, one after the other.
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
    t.mock.method(Math, 'random', () => 0.5); // no jitter
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

test('a restart that meets a revision verdict, with reconnect set, stops for good as any reconnect does: alerted, and still registered', async () => {
  let downgraded = false;
  const fixture = await start2025({
    versions: ['2025-06-18'],
    answer: (message, res) => {
      if (message.method !== 'initialize' || !downgraded) return false;
      // The restarted server speaks only legacy MCP now.
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'downgraded', version: '1' } } });
      return true;
    },
  });
  const connection = await connect(fixture, { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
  await connection.listTools();
  const events: string[] = [];
  connection.on('close', () => events.push(`close willReconnect=${connection.willReconnect}`));
  connection.on('reconnect-failed', (f: { attempt: number; permanent?: boolean }) => events.push(`reconnect-failed ${f.attempt}${f.permanent ? ' permanent' : ''}`));
  connection.on('reconnect', () => events.push('reconnect'));
  downgraded = true;
  await fixture.forget(false);
  await connection.callTool('echo', {}).catch(() => {});
  await until(() => events.length === 2, 'the verdict');
  await sleep(150);
  // As attemptReconnect does after a verdict: no further try, and no 'close'
  // saying the server is gone, since a reconnecting server stays registered.
  assert.deepEqual(events, ['close willReconnect=true', 'reconnect-failed 1 permanent']);
  assert.equal(connection.willReconnect, false);
  assert.equal(initializes(fixture).length, 2, 'nothing tried after the verdict');
});

test('behind a load balancer without sticky sessions, each new session ends unanswered, and the backoff grows', async (t) => {
  t.mock.method(Math, 'random', () => 0.5); // no jitter: each wait is its nominal backoff
  // Every request after the handshake reaches a node that doesn't hold the session.
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
  // As the framework does, list after every (re)connect.
  connection.on('reconnect', () => { void connection.listTools().catch(() => {}); });
  await connection.listTools().catch(() => {});
  await until(() => initializes(fixture).length >= 4, 'three new sessions');
  assert.deepEqual(attempts.slice(0, 3), [1, 2, 3]);
  const [, second, third, fourth] = initializes(fixture).map((s) => s.at);
  // Lower bounds only: each wait is at least its backoff, 20 ms doubling.
  assert.ok(third! - second! >= 75, `the third session waited ${third! - second!} ms`);
  assert.ok(fourth! - third! >= 155, `the fourth session waited ${fourth! - third!} ms`);
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
    assert.match(err.message, /Cancellation was requested/);
    return true;
  });
  await until(() => fixture.events.includes('slow-aborted'), 'the server seeing the cancellation');
  assert.equal(count(fixture, (s) => s.rpc === 'notifications/cancelled'), 1);
  assert.equal(heldAborts(connection), 0, 'nothing kept for the cancelled request');
});

test('close() DELETEs a live session, and leaves alone one the server ended', async () => {
  const fixture = await start2025({ versions: ['2025-06-18'] });
  const connection = await connect(fixture);
  await connection.listTools();
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
  // A close() that waited on the DELETE itself would never end: the test's
  // timeout is what catches that.
  await connection.close();
  const took = Date.now() - began;
  assert.ok(took >= 2900, `close() took ${took} ms, less than the DELETE's bound`);
  assert.equal(count(fixture, (s) => s.method === 'DELETE'), 1);
});

test('close() during a connect ends the session the server already issued', async () => {
  // The handshake stops after initialize: its notification is never answered.
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

/** A connect expected to meet a permanent verdict, with `reconnect` set to show nothing retries it. */
async function refused(fixture: Fixture): Promise<McplProtocolVersionError> {
  const connection = ModernMcpConnection.create({ id: 'remote', url: fixture.url, reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 });
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
  assert.deepEqual(verdict!.offered, HTTP_OFFER);
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
  assert.match(verdict.message, /does not support MCP 2026-07-28 \(it supports: 2099-01-01, 2025-06-18\)\. It lists 2025-06-18, which this client also speaks, but the SDK doesn't fall back to initialize after a refusal that names a newer revision\.$/);
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
  // A server that answers no discovery, but names 2026-07-28 in its initialize.
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

test('a failed initialize that refused nothing, after a discovery with no revision in common, is no verdict: it is retried', async () => {
  let initializeFailures = 1;
  const fixture = await start2025({
    answer: (message, res) => {
      if (message.method === 'server/discover') {
        json(res, 200, { jsonrpc: '2.0', id: message.id, result: { supportedVersions: ['2099-01-01'], capabilities: {} } });
        return true;
      }
      // An outage, not an answer about revisions; then the server is back.
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

// A discovery result listing a revision the client doesn't speak, or a
// -32022 error listing only one older than the client's, sends the client to
// the 2025 handshake, which fails here.
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
    mcplServers: [{ id: 'remote', url: fixture.url }],
  });
  cleanups.push(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const [status] = framework.listMcplServers();
  assert.equal(status!.family, 'modern');
  assert.equal(status!.transport, 'http');
  assert.equal(status!.protocolVersion, '2025-06-18');
  assert.ok(framework.getAllTools().some((tool) => tool.name === 'mcpl--remote--echo'));
  const lists = () => count(fixture, (s) => s.rpc === 'tools/list' && s.status === 200);
  const listed = lists();
  await fixture.forget(false);
  const failed = await framework.executeToolCall({ id: 'after-end', name: 'mcpl--remote--echo', input: { text: 'x' } });
  assert.equal(failed.success, false);
  assert.match(failed.error!, /HTTP 404\. The server had ended this connection's session, so the request was not run\./);
  // While the new session starts, the server stays registered, retrying.
  const [during] = framework.listMcplServers();
  assert.ok(during!.connected || during!.retrying, JSON.stringify(during));
  await until(() => initializes(fixture).length === 2 && lists() > listed, 'the new session, relisted');
  assert.ok(framework.getAllTools().some((tool) => tool.name === 'mcpl--remote--echo'));
  const echoed = await framework.executeToolCall({ id: 'after-restart', name: 'mcpl--remote--echo', input: { text: 'back' } });
  assert.equal(echoed.success, true, JSON.stringify(echoed));
});
