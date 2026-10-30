import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { WebSocketTransport } from '../src/mcpl/transport.js';
import type { McplServerConfig } from '../src/mcpl/types.js';

const credential = () => `CANARY-${randomBytes(24).toString('hex')}`;
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const config = (url: string): McplServerConfig => ({ id: 'codes', url,
  credentialRequired: true, tokenTransport: 'header', accessProvider: async () => credential() } as McplServerConfig);
async function refusal(status: number) {
  const sockets = new Set<net.Socket>();
  let upgrades = 0;
  const server = http.createServer();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (_req, socket) => {
    upgrades++;
    // Neither peer-controlled status-like string is an admissible source.
    socket.end(`HTTP/1.1 ${status} peer says ${status === 401 ? 500 : 401}\r\nLocation: /redirect\r\nContent-Length: 17\r\nConnection: close\r\n\r\npeer-body-says-403`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/mcpl`, sockets,
    get upgrades() { return upgrades; },
    async close() { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); } };
}

for (const status of [401, 403, 404, 500, 301, 302, 303, 307, 308]) {
  test(`direct strict ${status} classification ignores peer text`, async () => {
    const server = await refusal(status);
    try {
      let settlements = 0;
      const result = await WebSocketTransport.open(config(server.url)).then(t => {
        settlements++; void t.close(); return 'unexpected open';
      }, error => { settlements++; return (error as Error).message; });
      const reason = status === 401 || status === 403 ? 'credential-rejected' : 'connection-failed';
      assert.equal(result, `MCPL server "codes": ${reason}`);
      await pause(20);
      assert.equal(settlements, 1);
      assert.equal(server.upgrades, 1, 'redirect is never followed');
      assert.equal(server.sockets.size, 0, 'server-side socket closed');
      assert.ok(!result.includes('peer'));
    } finally { await server.close(); }
  });
}

test('strict response listener removes itself and the open timer', async () => {
  for (const status of [401, 403, 404, 500, 302]) {
    const server = await refusal(status);
    const originalOnce = WebSocket.prototype.once;
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let client: WebSocket | undefined;
    let listeners = 0;
    WebSocket.prototype.once = function(this: WebSocket, event: string | symbol, listener: (...args: any[]) => void) {
      if (event === 'unexpected-response') { client = this; listeners++; }
      return originalOnce.call(this, event, listener);
    } as typeof originalOnce;
    globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      const timer = set(fn, ms, ...args); if (ms === 15_000) timers.add(timer); return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => { timers.delete(timer); clear(timer); }) as typeof clearTimeout;
    try {
      await assert.rejects(WebSocketTransport.open(config(server.url)), new RegExp((status === 401 || status === 403 ? 'credential-rejected' : 'connection-failed') + '$'));
      await pause(20);
      assert.equal(listeners, 1, 'strict-only structured-status listener installed once');
      assert.ok(client);
      assert.equal(client.listenerCount('unexpected-response'), 0);
      assert.equal(client.listenerCount('open'), 0);
      assert.equal(client.readyState, WebSocket.CLOSED);
      assert.equal(timers.size, 0);
      // The deliberate late-error swallow handler is not a leaked dial callback.
      assert.equal(client.listenerCount('error'), 1);
    } finally { WebSocket.prototype.once = originalOnce; globalThis.setTimeout = set; globalThis.clearTimeout = clear; await server.close(); }
  }
});

for (const flag of [undefined, false, null]) test(`legacy flag ${flag} installs no structured-status listener`, async () => {
  const server = await refusal(404); const original = WebSocket.prototype.once; let added = 0;
  WebSocket.prototype.once = function(this: WebSocket, event: string | symbol, listener: (...args: any[]) => void) {
    if (event === 'unexpected-response') added++;
    return original.call(this, event, listener);
  } as typeof original;
  try {
    await assert.rejects(WebSocketTransport.open({ ...config(server.url), credentialRequired: flag } as McplServerConfig));
    assert.equal(added, 0);
  } finally { WebSocket.prototype.once = original; await server.close(); }
});

for (const already of [false, true]) test(`strict provider wait abort (already=${already}) is connection-failed`, async () => {
  const server = await refusal(401); const controller = new AbortController(); let release!: (s: string) => void;
  const pending = new Promise<string>(r => { release = r; });
  try {
    if (already) controller.abort();
    const dial = WebSocketTransport.open({ ...config(server.url), accessProvider: () => pending }, controller.signal);
    controller.abort();
    await assert.rejects(dial, { message: 'MCPL server "codes": connection-failed' });
    release(credential()); await pause(20); assert.equal(server.upgrades, 0);
  } finally { release(credential()); await server.close(); }
});

test('strict connection refused is connection-failed', async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  await assert.rejects(WebSocketTransport.open(config(`ws://127.0.0.1:${port}/mcpl`)), { message: 'MCPL server "codes": connection-failed' });
});

for (const mode of ['TLS failure', 'open timeout', 'abort while connecting'] as const) {
  test(`direct strict ${mode} is connection-failed`, { timeout: 5000 }, async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.resume();
      if (mode === 'TLS failure') socket.once('data', () => socket.end('HTTP/1.1 500 Not TLS\r\n\r\n'));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const controller = new AbortController();
    const c = config(`${mode === 'TLS failure' ? 'wss' : 'ws'}://127.0.0.1:${(server.address() as net.AddressInfo).port}/mcpl`);
    const set = globalThis.setTimeout;
    let shortened = 0;
    if (mode === 'open timeout') {
      globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
        if (ms === 15_000) { ms = 50; shortened++; }
        return set(fn, ms, ...args);
      }) as typeof setTimeout;
    }
    try {
      const dial = WebSocketTransport.open(c, controller.signal);
      if (mode === 'abort while connecting') { await once(server, 'connection'); controller.abort(); }
      await assert.rejects(dial, { message: 'MCPL server "codes": connection-failed' });
      if (mode === 'open timeout') assert.equal(shortened, 1);
      await pause(20); assert.equal(sockets.size, 0);
    } finally { globalThis.setTimeout = set; for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); }
  });
}

test('real malformed frame after open reports connection-failed', async t => {
  if (process.versions.bun) { t.skip('Bun closes malformed frames without emitting a socket error'); return; }
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(wss, 'listening');
  let transport: WebSocketTransport | undefined;
  try {
    transport = await WebSocketTransport.open(config(`ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}/mcpl`));
    const error = once(transport, 'error');
    const peer = [...wss.clients][0] as WebSocket & { _socket: net.Socket };
    peer._socket.write(Buffer.from([0x83, 0x00])); // reserved opcode, real wire
    const [reported] = await error;
    assert.equal((reported as Error).message, 'MCPL server "codes": connection-failed');
  } finally { for (const ws of wss.clients) ws.terminate(); await transport?.close(); await new Promise<void>(r => wss.close(() => r())); }
});


for (const status of [undefined, '401', NaN, Infinity]) {
  test(`strict refused upgrade without finite numeric status (${String(status)}) is engine-unsupported`, async () => {
    const server = await refusal(401);
    const emit = WebSocket.prototype.emit;
    // Keep a real upgrade and teardown, replacing only the runtime's status metadata.
    WebSocket.prototype.emit = function(this: WebSocket, event: string | symbol, ...args: any[]) {
      if (event === 'unexpected-response') args[1].statusCode = status;
      return emit.call(this, event, ...args);
    } as typeof emit;
    try {
      await assert.rejects(WebSocketTransport.open(config(server.url)), {
        message: 'MCPL server "codes": engine-unsupported',
      });
      assert.equal(server.upgrades, 1);
      await pause(20);
      assert.equal(server.sockets.size, 0);
    } finally { WebSocket.prototype.emit = emit; await server.close(); }
  });
}
