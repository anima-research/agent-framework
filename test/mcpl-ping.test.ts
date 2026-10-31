/**
 * MCP's ping (#392): either side may send one, and the receiver answers
 * promptly with an empty result. A server's ping is answered on a connected
 * transport, whether or not its planes are paused, and during the initialize
 * handshake, where it must never be taken for the initialize response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';

class LineTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void { this.lines.push(line); }
  async close(): Promise<void> {}
}

function bareConnection() {
  const transport = new LineTransport();
  // Real routing and response encoding, without launching a server.
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  const receive = (message: unknown) => transport.emit('line', JSON.stringify(message));
  const written = () => transport.lines.map((line) => JSON.parse(line));
  return { connection, receive, written };
}

test('a ping on a connected transport is answered with an empty result; a ping notification is not', () => {
  const { connection, receive, written } = bareConnection();
  connection.ready();
  receive({ jsonrpc: '2.0', method: 'ping' });
  // 0 is a server's first id when its ids start at 0.
  receive({ jsonrpc: '2.0', id: 0, method: 'ping' });
  receive({ jsonrpc: '2.0', id: 1, method: 'ping' });
  receive({ jsonrpc: '2.0', id: 'p-2', method: 'ping' });
  assert.deepEqual(written(), [
    { jsonrpc: '2.0', id: 0, result: {} },
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 'p-2', result: {} },
  ]);
});

test('a ping with id null is answered with id null, and one with an invalid id gets -32600, at once while the planes are paused (#475)', (t) => {
  const { connection, receive, written } = bareConnection();
  t.mock.method(console, 'error', () => {});
  // Before ready() both planes are closed, as at startup.
  receive({ jsonrpc: '2.0', id: null, method: 'ping' });
  receive({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' });
  assert.deepEqual(written(), [
    { jsonrpc: '2.0', id: null, result: {} },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the id must be a string, a number or null, not an object' } },
  ]);
  assert.equal((connection as any).bufferedEvents.length, 0);
});

test('a ping is answered at once while the planes are paused, and nothing is held for it', () => {
  const { connection, receive, written } = bareConnection();
  // Before ready() both planes are closed, as at startup; a quiesce holds the
  // data plane the same way.
  receive({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(written(), [{ jsonrpc: '2.0', id: 3, result: {} }]);
  assert.equal((connection as any).bufferedEvents.length, 0);
});

// Stdio servers for the handshake. Each records every response the host
// writes it, by id and by whether it's a pong (an empty result) or an error,
// and once the pong it waits for has arrived it writes that list to stderr.
// - pings-first: pings with id 0 as soon as initialize arrives, as a server
//   whose own request ids start at 0 would, and answers initialize only once
//   its pong arrives.
// - one-chunk: as initialize arrives, writes in one chunk a request with id 0
//   that isn't a ping, a request whose method isn't a string, a ping sent as
//   a notification, a log notification, its initialize response, and a ping
//   with the id "late", which the connected transport answers.
// - null-ids: as initialize arrives, pings with id null and with an object
//   id, and answers initialize, then pings with the id "late", once its pong
//   for id null arrives.
const HANDSHAKE_SERVER = String.raw`
const mode = process.argv[1];
let buf = '';
const responses = [];
const line = (m) => JSON.stringify(m) + '\n';
const initResult = (id) => ({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } } } });
const report = () => process.stderr.write('responses:' + JSON.stringify(responses) + '\n');
let init = null;
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const text = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!text.trim()) continue;
    const m = JSON.parse(text);
    if (m.method === 'initialize') {
      init = m;
      if (mode === 'pings-first') {
        process.stdout.write(line({ jsonrpc: '2.0', id: 0, method: 'ping' }));
      } else if (mode === 'null-ids') {
        process.stdout.write(line({ jsonrpc: '2.0', id: null, method: 'ping' }) + line({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }));
      } else {
        process.stdout.write(
          line({ jsonrpc: '2.0', id: 0, method: 'roots/list' }) +
          line({ jsonrpc: '2.0', id: 0, method: 5 }) +
          line({ jsonrpc: '2.0', method: 'ping' }) +
          line({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'starting' } }) +
          line(initResult(init.id)) +
          line({ jsonrpc: '2.0', id: 'late', method: 'ping' }));
      }
    } else if (m.method === undefined) {
      const pong = m.error === undefined && m.result !== null && typeof m.result === 'object' && Object.keys(m.result).length === 0;
      responses.push(('id' in m ? JSON.stringify(m.id) : '(no id)') + ':' + (pong ? 'pong' : 'error ' + (m.error && m.error.code)));
      if (mode === 'pings-first' && m.id === 0 && pong) {
        process.stdout.write(line(initResult(init.id)));
        report();
      }
      if (mode === 'null-ids' && m.id === null && pong) {
        process.stdout.write(line(initResult(init.id)) + line({ jsonrpc: '2.0', id: 'late', method: 'ping' }));
      }
      if ((mode === 'one-chunk' || mode === 'null-ids') && m.id === 'late') report();
    }
  }
});
setInterval(() => {}, 1 << 30);
`;

/** Connects to a HANDSHAKE_SERVER and returns the capabilities the host took
 *  from the handshake, and the server's stderr report. */
async function handshakeWith(mode: 'pings-first' | 'one-chunk' | 'null-ids') {
  const connection = await McplServerConnection.connect(
    { id: 'pinger', command: process.execPath, args: ['-e', HANDSHAKE_SERVER, mode], requestTimeoutMs: 5_000 },
    { version: '0.5' },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // stderr is its own pipe, so its line may arrive after the response; the
    // wait ends at the line, with 10 s as its outer bound.
    const said = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the server wrote nothing to stderr within 10 s')), 10_000);
      connection.once('stderr', ({ line }: { line: string }) => resolve(line));
    });
    said.catch(() => {});
    connection.ready();
    const capabilities = connection.capabilities;
    return { capabilities, report: await said };
  } finally {
    clearTimeout(timer);
    await connection.close();
  }
}

test('a ping sent before the initialize response is answered, and is not taken for that response', async () => {
  const { capabilities, report } = await handshakeWith('pings-first');
  // The initialize response, which the server sent only after its pong, set the capabilities.
  assert.equal(capabilities?.pushEvents, true);
  assert.equal(report, 'responses:["0:pong"]');
});

test('during the handshake nothing that carries a method is taken for the initialize response, and only pings are answered', async () => {
  const { capabilities, report } = await handshakeWith('one-chunk');
  // Neither request with id 0 was taken for the response.
  assert.equal(capabilities?.pushEvents, true);
  // Nothing during the handshake was answered, the ping notification
  // included; the ping after the response, held while the connection
  // subscribed, was answered by the connected transport.
  assert.equal(report, 'responses:["\\"late\\":pong"]');
});

test('during the handshake a ping with id null is answered with id null, and one with an invalid id is ignored (#475)', async () => {
  const { capabilities, report } = await handshakeWith('null-ids');
  // The server answered initialize only once its pong for id null arrived.
  assert.equal(capabilities?.pushEvents, true);
  // The ping with an object id got nothing, and isn't echoed.
  assert.equal(report, 'responses:["null:pong","\\"late\\":pong"]');
});
