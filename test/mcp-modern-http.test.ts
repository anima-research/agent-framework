/**
 * The modern engine over Streamable HTTP (room-284, shelf-487), against an
 * in-process SDK 2.x `createMcpHandler` that refuses legacy openings. This is
 * the one HTTP smoke path. It covers Connectome's own seams, and leaves the
 * SDK's conformance to the SDK:
 * - credentials: a cached bearer from `accessProvider`, refreshed once on 401;
 * - the required headers reach the server;
 * - a deadline aborts the request stream, which the server sees as cancellation;
 * - an auth wall is an `error-response` carrying the HTTP status, unless an
 *   earlier round of the call was answered, when it is a `no-response`.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Seen { method: string; auth: string | null; version: string | null; mcpMethod: string | null; mcpName: string | null }

/** A JSON-RPC request a test answers itself, at the HTTP layer, where an SDK
 *  server can't be made to answer as the case needs. True once answered. */
type HandAnswer = (message: { method?: unknown; id?: unknown; params?: Record<string, unknown> }, res: ServerResponse) => boolean;

async function startServer(accepted: (token: string | null) => boolean, answer?: HandAnswer): Promise<{ url: string; seen: Seen[]; events: string[]; server: Server }> {
  const { createServer } = await import(pathToFileURL(join(here, 'fixtures', 'modern-tools.mjs')).href) as {
    createServer: (opts: { log: (line: string) => void }) => unknown;
  };
  const seen: Seen[] = [];
  const events: string[] = [];
  const handler = createMcpHandler(() => createServer({ log: (line) => events.push(line) }) as never, { legacy: 'reject' });
  const server = createHttpServer(async (req, res) => {
    const auth = req.headers.authorization ?? null;
    seen.push({
      method: req.method ?? '',
      auth,
      version: (req.headers['mcp-protocol-version'] as string | undefined) ?? null,
      mcpMethod: (req.headers['mcp-method'] as string | undefined) ?? null,
      mcpName: (req.headers['mcp-name'] as string | undefined) ?? null,
    });
    if (!accepted(auth?.replace(/^Bearer /, '') ?? null)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (answer && req.method === 'POST') {
      let message: unknown;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { message = undefined; }
      if (message !== null && typeof message === 'object' && !Array.isArray(message) && answer(message as never, res)) return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }
    // The client closing its request stream is the HTTP binding's
    // cancellation: carry it into the handler as an abort.
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const response = await handler.fetch(new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      signal: abort.signal,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body as never).pipe(res);
    else res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, seen, events, server };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

test('HTTP: bearer from accessProvider, one refresh on 401, required headers, calls', async () => {
  const { url, seen, server } = await startServer((token) => token === 'token-2');
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  let issued = 0;
  const connection = await ModernMcpConnection.connect({
    id: 'remote',
    url,
    accessProvider: async () => `token-${++issued}`,
  });
  cleanups.push(() => connection.close());

  assert.equal(connection.transportKind, 'http');
  assert.equal(connection.protocolVersion, '2026-07-28');
  assert.deepEqual((await connection.callTool('echo', { text: 'over http' })).content, [{ type: 'text', text: 'echo:over http' }]);
  const only = await connection.callTool('structured_only', {});
  assert.deepEqual(only.structuredContent, { answer: 42, ok: false, nothing: null });

  assert.equal(issued, 2, 'token-1 was refused once, token-2 cached thereafter');
  const posts = seen.filter((s) => s.method === 'POST');
  assert.ok(posts.every((s) => s.version === '2026-07-28'), 'every POST names the revision');
  assert.ok(posts.every((s) => s.mcpMethod !== null), 'every POST names its method');
  assert.ok(posts.some((s) => s.mcpMethod === 'tools/call' && s.mcpName === 'echo'), 'tools/call names its tool');
  assert.ok(posts.slice(1).every((s) => s.auth === 'Bearer token-2'));
});

test('HTTP: a deadline aborts the request stream, and the server sees the cancellation', async () => {
  const { url, events, server } = await startServer(() => true);
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const connection = await ModernMcpConnection.connect({ id: 'remote', url, token: 't', requestTimeoutMs: 300 });
  cleanups.push(() => connection.close());
  await assert.rejects(connection.callTool('slow', { ms: 1500 }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /this host asked it to cancel/);
    return true;
  });
  const deadline = Date.now() + 3000;
  while (!events.includes('slow-aborted') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.includes('slow-aborted'), `server events: ${events.join(', ')}`);
});

test('HTTP: an argument JSON cannot write is refused before the wire, and raises no connection error (#556)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { url, seen, server } = await startServer(() => true);
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const connection = await ModernMcpConnection.connect({ id: 'remote', url, token: 't' });
  cleanups.push(() => connection.close());
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  const toolCalls = () => seen.filter((s) => s.method === 'POST' && s.mcpMethod === 'tools/call').length;
  const before = toolCalls();
  await assert.rejects(connection.callTool('echo', { text: 'x', n: 1n }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'not-sent');
    return true;
  });
  assert.equal(toolCalls(), before, 'no tools/call reached the server');
  assert.deepEqual(errors, []);
});

test('HTTP: a request the server answers with HTTP 500 is reported once, to its caller and in one log line, not as a connection error (#556)', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  const { url, server } = await startServer(() => true, (message, res) => {
    if (message.method !== 'tools/call') return false;
    res.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
    return true;
  });
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const connection = await ModernMcpConnection.connect({ id: 'remote', url, token: 't' });
  cleanups.push(() => connection.close());
  const failed = (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    return true;
  };
  // With no listener of the host's, the connection logs an 'error' itself,
  // so a second report would be a second line.
  await assert.rejects(connection.callTool('echo', { text: 'x' }), failed);
  // The quoted reason is the MCP SDK's own text around the server's body,
  // so the line is checked for what the framework says and the body alone.
  const said = lines.filter((line) => line.includes('boom'));
  assert.equal(said.length, 1, `one log line: ${JSON.stringify(lines)}`);
  assert.match(said[0]!, /^MCP server "remote" tools\/call echo failed with HTTP 500: ".*boom"$/);
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  await assert.rejects(connection.callTool('echo', { text: 'x' }), failed);
  assert.deepEqual(errors, []);
});

test('HTTP: a credential the server keeps refusing fails the connect, naming 401', async () => {
  const { url, server } = await startServer(() => false);
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  await assert.rejects(ModernMcpConnection.connect({ id: 'remote', url, token: 'stale' }), /401/);
});

test('HTTP: an auth wall on a call is an error-response with the status in data', async () => {
  let allow = true;
  const { url, server } = await startServer(() => allow);
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const connection = await ModernMcpConnection.connect({ id: 'remote', url, token: 't' });
  cleanups.push(() => connection.close());
  allow = false;
  await assert.rejects(connection.callTool('echo', { text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'error-response');
    // The status is HTTP's, not a JSON-RPC code: it rides in data.
    assert.equal((err.data as { httpStatus?: number }).httpStatus, 401);
    return true;
  });
});

test("HTTP: an auth wall's status stays this host's number when the server's configuration can't be read", async (t) => {
  t.mock.method(console, 'error', () => {});
  let allow = true;
  let unreadable = false;
  const { url, server } = await startServer(() => allow);
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  // An `env` getter that throws, as the framework's own can, makes the
  // server's text withheld; the status is this host's, not the server's.
  const config = { id: 'remote', url, token: 't' };
  Object.defineProperty(config, 'env', { enumerable: true, get: () => { if (unreadable) throw new Error('unreadable'); return undefined; } });
  const connection = await ModernMcpConnection.connect(config);
  cleanups.push(() => { unreadable = false; return connection.close(); });
  allow = false;
  unreadable = true;
  await assert.rejects(connection.callTool('echo', { text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'error-response');
    // The server's own data is withheld, and the status stays.
    assert.deepEqual(err.data, { httpStatus: 401 });
    return true;
  });
});

test('HTTP: an auth wall on a later round of a call is a no-response, since the first round may have acted', async (t) => {
  const consoleLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => consoleLines.push(args.map(String).join(' ')));
  // The SDK server can't be made to ask for another round, so `cont`, which
  // it doesn't list, is answered here: a state-only input_required for the
  // first round, then 401 for every later one.
  const states: unknown[] = [];
  const { url, server } = await startServer(() => true, (message, res) => {
    if (message.method !== 'tools/call' || message.params?.name !== 'cont') return false;
    const state = message.params.requestState;
    states.push(state);
    if (state === undefined) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: { resultType: 'input_required', requestState: 'state-1' },
      }));
    } else {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
    }
    return true;
  });
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const connection = await ModernMcpConnection.connect({ id: 'remote', url, token: 't' });
  cleanups.push(() => connection.close());
  await assert.rejects(connection.callTool('cont', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    // Not the error-response a refused first round gets: the server took
    // the first round, and may have acted on it.
    assert.equal(err.outcome, 'no-response');
    assert.equal(err.message, 'The "remote" server refused this host access partway through the request, after asking for more, ' +
      'so whether it took effect is unknown. Check its effect before trying again; if calling it again fails, ask whoever runs this host.');
    return true;
  });
  assert.ok(consoleLines.some((line) => /^MCP server "remote" refused a later round of tools\/call cont: HTTP 401 \(/.test(line)), consoleLines.join('\n'));
  assert.equal(states[0], undefined, 'the first round carried no state');
  assert.ok(states.length >= 2 && states.slice(1).every((s) => s === 'state-1'), `each later round carried it: ${JSON.stringify(states)}`);
});

test("HTTP: an echoed path in a tool transport failure or a JSON-RPC error is redacted in the log and kept from the caller's and the agent's text", async (t) => {
  const consoleLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => consoleLines.push(args.map(String).join(' ')));
  const secret = 'pathSecret0123456789';
  let rpc = true;
  const { url, server } = await startServer(() => true, (message, res) => {
    if (message.method !== 'tools/call') return false;
    if (rpc) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: secret, data: { echoed: secret } } }));
    } else {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(`Cannot POST /api/mcp/s/${secret}/mcp`);
    }
    return true;
  });
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const connection = await ModernMcpConnection.connect({ id: 'remote', url: url.replace('/mcp', `/api/mcp/s/${secret}/mcp`) });
  cleanups.push(() => connection.close());
  await assert.rejects(connection.callTool('echo', {}), (error: unknown) => {
    assert.ok(error instanceof McplRequestError);
    // The server's words and data reach the caller with the url's
    // credential redacted, as an error the framework hands a host does.
    assert.equal(error.message, 'The "remote" server answered with an error: redacted');
    assert.deepEqual(error.data, { echoed: 'redacted' });
    assert.equal(error.outcome, 'error-response');
    return true;
  });
  rpc = false;
  await assert.rejects(connection.callTool('echo', {}), (error: unknown) => {
    assert.ok(error instanceof McplRequestError);
    // The transport's words are the operator's: the log has them, redacted.
    assert.equal(error.message, 'The request to the "remote" server failed before an answer came back, so whether it took effect is unknown. ' +
      'Check its effect before trying again.');
    assert.equal(error.outcome, 'no-response');
    return true;
  });
  // The status is only in the SDK's error, so the log names it.
  assert.ok(consoleLines.some(line => /^MCP server "remote" tools\/call echo failed with HTTP 500: .*Cannot POST \/api\/mcp\/s\/redacted\/mcp/.test(line)), consoleLines.join('\n'));
  // The answer's log line is a record of the server's text, so it's redacted.
  assert.ok(consoleLines.includes('MCP server "remote" answered tools/call echo with error -32603: redacted'), consoleLines.join('\n'));
  assert.ok(!consoleLines.join('\n').includes(secret));
  const dir = mkdtempSync(join(tmpdir(), 'mcp-tool-transport-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [],
    mcplServers: [{ id: 'remote', url: url.replace('/mcp', `/api/mcp/s/${secret}/mcp`) }],
  });
  try {
    const result = await framework.executeToolCall({ id: 'echo-failed', name: 'mcpl--remote--echo', input: {} });
    assert.equal(result.success, false);
    assert.match(result.error!, /^The request to the "remote" server failed before an answer came back/);
    assert.ok(!JSON.stringify(result).includes(secret), 'the model-facing tool result contains no path credential');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP: a 403 refusal's response body, which can echo the url, stays out of the request error's data", () => {
  // The SDK attaches the body as `text` to its step-up 403; staging step-up
  // takes an OAuth provider, so the refusal is handed to the connection's
  // reading of a failed request directly.
  const connection = Object.create(ModernMcpConnection.prototype) as {
    id: string; config: unknown;
    requestFailure(what: string, record: unknown, error: unknown): Error;
  };
  connection.id = 'remote';
  connection.config = { id: 'remote', url: 'https://h/api/mcp/s/pathSecret0123456789/mcp' };
  const refusal = new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'Server returned 403 insufficient_scope', {
    status: 403, statusText: 'Forbidden for /api/mcp/s/pathSecret0123456789/mcp', text: 'denied for /api/mcp/s/pathSecret0123456789/mcp',
  });
  const err = connection.requestFailure('tools/call "echo"', { method: 'tools/call', handedOff: true, answer: 'none' }, refusal);
  assert.ok(err instanceof McplRequestError);
  assert.equal(err.outcome, 'error-response');
  assert.equal((err.data as { httpStatus?: number }).httpStatus, 403);
  assert.equal((err.data as { text?: unknown }).text, undefined);
  assert.ok(!JSON.stringify(err.data).includes('pathSecret'), JSON.stringify(err.data));
});

for (const [what, headers] of [
  ['a plain 403', {}],
  ['an insufficient_scope 403', { 'www-authenticate': 'Bearer error="insufficient_scope", scope="tools"' }],
] as const) {
  test(`HTTP: ${what} on a first-round call is an error-response with the status in data, over the wire`, async () => {
    const { url, server } = await startServer(() => true, (message, res) => {
      if (message.method !== 'tools/call') return false;
      res.writeHead(403, { 'content-type': 'text/plain', ...headers }).end('forbidden here');
      return true;
    });
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
    const connection = await ModernMcpConnection.connect({ id: 'remote', url, token: 't' });
    cleanups.push(() => connection.close());
    await assert.rejects(connection.callTool('echo', { text: 'x' }), (err: unknown) => {
      assert.ok(err instanceof McplRequestError);
      assert.equal(err.outcome, 'error-response', err.message);
      assert.equal((err.data as { httpStatus?: number }).httpStatus, 403);
      assert.equal((err.data as { text?: unknown }).text, undefined);
      return true;
    });
  });
}

