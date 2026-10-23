/**
 * A transport error on a connection nothing listens to for 'error' (#391).
 * EventEmitter throws an 'error' with no listener, and a transport reports its
 * errors from I/O callbacks, where nothing catches the throw: it ended the
 * process. McplServerConnection is exported, and a probe, a playtest or a
 * harness holding one often attaches no 'error' listener (the framework
 * always does). The error is logged instead, and given to listeners when
 * there are any, a throwing one caught as #208's inbound failures are.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport, StdioTransport, WebSocketTransport } from '../src/mcpl/transport.js';

class LineTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'websocket' as const;
  writeLine(): void {}
  async close(): Promise<void> {}
}

function bareConnection(t: TestContext) {
  const transport = new LineTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.ready();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  return { connection, transport, logged, reset };
}

test("a transport error on a connection with no 'error' listener is logged, never thrown", (t) => {
  const { connection, transport, logged, reset } = bareConnection(t);
  assert.equal(connection.listenerCount('error'), 0);
  assert.doesNotThrow(() => transport.emit('error', reset));
  assert.deepEqual(logged, ['[mcpl] srv: transport error: "read ECONNRESET"']);
});

test("with an 'error' listener, a transport error is the listener's, and nothing is logged", (t) => {
  const { connection, transport, logged, reset } = bareConnection(t);
  const reported: Error[] = [];
  connection.on('error', (error: Error) => reported.push(error));
  transport.emit('error', reset);
  assert.deepEqual(reported.map((error) => error.message), ['MCPL server "srv" transport error: read ECONNRESET']);
  assert.deepEqual(logged, []);
});

test("an 'error' listener that throws on a transport error is caught and logged, with the error it was handling", (t) => {
  const { connection, transport, logged, reset } = bareConnection(t);
  connection.on('error', () => { throw new Error('listener exploded'); });
  assert.doesNotThrow(() => transport.emit('error', reset));
  assert.deepEqual(logged, [
    `[mcpl] srv: an 'error' listener failed: "listener exploded", handling ${JSON.stringify('MCPL server "srv" transport error: read ECONNRESET')}`,
  ]);
});

// A transport reports its own errors through reportError, which gives them to
// its 'error' listeners, or logs them when it has none: from its creation
// until the handshake attaches a listener, it has none (#391's rule, at the
// transport's own forwarders).
test("a transport with nothing listening for 'error' logs its errors, and gives them to a listener once there is one", (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  // Stand-ins for a spawned child and a socket, as the stdin test in
  // mcpl-request-handler-errors.test.ts uses.
  const child = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, exitCode: null, signalCode: null,
  });
  const stdio = new (StdioTransport as any)(child, new EventEmitter(), 'child-srv') as StdioTransport;
  const ws = new EventEmitter();
  // The socket's configuration and the url it dialed, which its errors are masked with.
  const socket = new (WebSocketTransport as any)(ws, { id: 'ws-srv', url: 'ws://127.0.0.1:1/mcpl' }, 'ws://127.0.0.1:1/mcpl') as WebSocketTransport;
  assert.doesNotThrow(() => child.emit('error', new Error('kill EPERM')));
  assert.doesNotThrow(() => child.stderr.emit('error', new Error('read EIO')));
  assert.doesNotThrow(() => ws.emit('error', new Error('Invalid WebSocket frame: invalid opcode 3')));
  assert.deepEqual(logged, [
    '[mcpl] child-srv: a stdio transport error, with nothing listening for it: "kill EPERM"',
    '[mcpl] child-srv: a stdio transport error, with nothing listening for it: "read EIO"',
    '[mcpl] ws-srv: a websocket transport error, with nothing listening for it: "Invalid WebSocket frame: invalid opcode 3"',
  ]);
  const reported: string[] = [];
  stdio.on('error', (error: Error) => reported.push(error.message));
  socket.on('error', (error: Error) => reported.push(error.message));
  child.emit('error', new Error('kill EPERM'));
  child.stderr.emit('error', new Error('read EIO'));
  ws.emit('error', new Error('read ECONNRESET'));
  assert.deepEqual(reported, ['kill EPERM', 'read EIO', 'read ECONNRESET']);
  assert.equal(logged.length, 3, 'nothing more is logged once a listener has them');
});

test('a WebSocket server that sends a malformed frame with its upgrade response is refused, and the connecting process survives', () => {
  // The server's frame arrives with the 101, and ws raises its error before
  // the handshake has attached a listener to the new transport.
  const probe = spawnSync(process.execPath, [
    fileURLToPath(new URL('./fixtures/mcpl-ws-upgrade-error-probe.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, `stdout: ${probe.stdout}\nstderr: ${probe.stderr}`);
  assert.match(probe.stdout, /^refused after \d+ ms: MCPL server "probe" transport closed before handshake completed/m);
  assert.match(probe.stderr, /\[mcpl\] probe: a websocket transport error, with nothing listening for it: "Invalid WebSocket frame: invalid opcode 3"/);
});
