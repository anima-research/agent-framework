import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { buildWebSocketUrl, isWebSocketTransport } from '../src/mcpl/transport.js';
import type { McplHostCapabilities } from '../src/mcpl/types.js';

const HOST_CAPS: McplHostCapabilities = { version: '0.4', pushEvents: true, featureSets: true };

/**
 * A minimal in-process MCPL server over WebSocket: answers the initialize
 * handshake, tools/list, and an `echo` tools/call. One JSON-RPC message per WS
 * frame (as McplServerConnection sends). `onSocket` lets a test grab the raw
 * socket to simulate a mid-session drop.
 */
function startMockMcplWsServer(onSocket?: (ws: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    onSocket?.(ws);
    ws.on('message', (data) => {
      let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      switch (msg.method) {
        case 'initialize':
          reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
          break;
        case 'notifications/initialized':
          break; // notification, no reply
        case 'tools/list':
          reply({ tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
          break;
        case 'tools/call': {
          const text = String(msg.params?.arguments?.text ?? '');
          reply({ content: [{ type: 'text', text }] });
          break;
        }
        default:
          break;
      }
    });
  });
  return wss;
}

function wsUrl(wss: WebSocketServer): string {
  const port = (wss.address() as AddressInfo).port;
  return `ws://127.0.0.1:${port}/mcpl`;
}

function waitListening(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => (wss.address() ? resolve() : wss.once('listening', () => resolve())));
}

test('buildWebSocketUrl validates protocol and appends the token as a query param', () => {
  assert.equal(
    buildWebSocketUrl({ id: 's', url: 'wss://example.com/mcpl' }),
    'wss://example.com/mcpl',
  );
  assert.equal(
    buildWebSocketUrl({ id: 's', url: 'wss://example.com/mcpl', token: 'sekret' }),
    'wss://example.com/mcpl?token=sekret',
  );
  // Preserves an existing query.
  assert.equal(
    buildWebSocketUrl({ id: 's', url: 'wss://example.com/mcpl?v=2', token: 'abc' }),
    'wss://example.com/mcpl?v=2&token=abc',
  );
  assert.throws(() => buildWebSocketUrl({ id: 's', url: 'http://example.com' }), /ws:\/\/ or wss:\/\//);
  assert.throws(() => buildWebSocketUrl({ id: 's', command: 'x' }), /requires "url"/);
});

test('isWebSocketTransport selects the transport from config shape', () => {
  assert.equal(isWebSocketTransport({ id: 's', url: 'wss://x/y' }), true);
  assert.equal(isWebSocketTransport({ id: 's', url: 'wss://x/y', transport: 'websocket' }), true);
  assert.equal(isWebSocketTransport({ id: 's', command: 'node' }), false);
  // Explicit transport wins over shape.
  assert.equal(isWebSocketTransport({ id: 's', command: 'node', transport: 'stdio' }), false);
  assert.equal(isWebSocketTransport({ id: 's', url: 'wss://x', command: 'node' }), false); // url+command → stdio unless transport says otherwise
});

test('connects over WebSocket, negotiates capabilities, lists tools, and round-trips a call', async () => {
  const wss = startMockMcplWsServer();
  await waitListening(wss);
  try {
    const conn = await McplServerConnection.connect({ id: 'editor', url: wsUrl(wss) }, HOST_CAPS);
    conn.ready();

    // Handshake negotiated MCPL capabilities over WS.
    assert.ok(conn.capabilities, 'expected MCPL capabilities from the handshake');
    assert.equal(conn.capabilities?.pushEvents, true);

    // tools/list round-trips.
    const list = await conn.sendToolsList();
    assert.deepEqual(list.tools.map((t) => t.name), ['echo']);

    // tools/call round-trips.
    const result = await conn.sendToolsCall('echo', { text: 'hello over wss' });
    const block = (result.content as Array<{ type: string; text?: string }>)[0];
    assert.equal(block.text, 'hello over wss');

    await conn.close();
  } finally {
    wss.close();
  }
});

test('a failed WebSocket dial rejects with a clear error (no reconnect)', async () => {
  // Nothing is listening on this port.
  await assert.rejects(
    McplServerConnection.connect({ id: 'dead', url: 'ws://127.0.0.1:1/mcpl' }, HOST_CAPS),
    /WebSocket connect (failed|timed out)/,
  );
});

// A tiny stdio MCPL server: reads NDJSON on stdin, answers the same three
// methods on stdout, and writes one line to stderr on boot (to prove stderr
// still surfaces after the transport refactor). Kept inline so the test is
// self-contained.
const STDIO_SERVER = `
let buf = '';
process.stderr.write('mock stdio server up\\n');
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
    else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: String((m.params && m.params.arguments && m.params.arguments.text) || '') }] });
  }
});
`;

test('stdio transport still handshakes, lists tools, round-trips a call, and surfaces stderr', async () => {
  const conn = await McplServerConnection.connect(
    { id: 'stdiosrv', command: process.execPath, args: ['-e', STDIO_SERVER] },
    HOST_CAPS,
  );
  const stderrLines: string[] = [];
  conn.on('stderr', (p: { line: string }) => stderrLines.push(p.line));
  conn.ready();

  assert.ok(conn.capabilities, 'stdio handshake should negotiate capabilities');

  const list = await conn.sendToolsList();
  assert.deepEqual(list.tools.map((t) => t.name), ['echo']);

  const result = await conn.sendToolsCall('echo', { text: 'over stdio' });
  const block = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(block.text, 'over stdio');

  // stderr forwarding preserved (buffered pre-listener, flushed on subscribe).
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(stderrLines.some((l) => l.includes('mock stdio server up')), 'stderr line should surface');

  await conn.close();
});

test('reconnect: an unexpected socket drop triggers a background reconnect', async () => {
  let sockets: WebSocket[] = [];
  const wss = startMockMcplWsServer((ws) => sockets.push(ws));
  await waitListening(wss);
  try {
    const conn = await McplServerConnection.connect(
      { id: 'editor', url: wsUrl(wss), reconnect: true, reconnectIntervalMs: 100 },
      HOST_CAPS,
    );
    conn.ready();

    const reconnected = new Promise<void>((resolve) => conn.once('reconnect', () => resolve()));

    // Force-drop the server side of the current socket.
    assert.equal(sockets.length, 1);
    sockets[0].terminate();

    await reconnected; // background reconnect must fire
    // The new socket works: a call round-trips post-reconnect.
    const result = await conn.sendToolsCall('echo', { text: 'after reconnect' });
    const block = (result.content as Array<{ type: string; text?: string }>)[0];
    assert.equal(block.text, 'after reconnect');

    await conn.close();
  } finally {
    wss.close();
  }
});
