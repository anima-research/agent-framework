/**
 * The modern engine over Streamable HTTP (room-284, shelf-487), against an
 * in-process SDK 2.x `createMcpHandler` that refuses legacy openings. This is
 * the one HTTP smoke path. It covers Connectome's own seams, and leaves the
 * SDK's conformance to the SDK:
 * - credentials: a cached bearer from `accessProvider`, refreshed once on 401;
 * - the required headers reach the server;
 * - a deadline aborts the request stream, which the server sees as cancellation;
 * - an auth wall is an `error-response` carrying the HTTP status.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Seen { method: string; auth: string | null; version: string | null; mcpMethod: string | null; mcpName: string | null }

async function startServer(accepted: (token: string | null) => boolean): Promise<{ url: string; seen: Seen[]; events: string[]; server: Server }> {
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
    assert.match(err.message, /Cancellation was requested/);
    return true;
  });
  const deadline = Date.now() + 3000;
  while (!events.includes('slow-aborted') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.includes('slow-aborted'), `server events: ${events.join(', ')}`);
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
    assert.equal(err.code, undefined);
    assert.equal((err.data as { httpStatus?: number }).httpStatus, 401);
    return true;
  });
});
