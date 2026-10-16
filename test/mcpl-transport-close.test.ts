/**
 * A transport whose child or connection goes a way the transport didn't
 * choose:
 *   - StdioTransport.close() for a child that a signal not sent through its
 *     kill() has ended (an OOM kill, a crash), whose `killed` stays false, and
 *     a connect whose child ends that way during initialize;
 *   - a transport McplServerConnection keeps for close() while a reconnect's
 *     handshake finishes, and one a failed handshake is closing, each of
 *     which reports an error while nothing else listens for it;
 *   - a write to a child that has closed its stdin.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';

import { McplTransport, StdioTransport, type TransportCloseInfo } from '../src/mcpl/transport.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A transport whose close() waits on the test. */
class HeldTransport extends McplTransport {
  readonly kind = 'stdio' as const;
  calls = 0;
  constructor(private readonly held: Promise<void>) { super(); }
  writeLine(): void {}
  async close(): Promise<void> { this.calls++; await this.held; }
}

/** console.error's lines while a test runs. */
function captureConsoleError(t: TestContext): string[] {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  return logged;
}

/** Polls until the condition holds, failing after 5 s, so a regression fails
 *  the test rather than keeping the process alive. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((done) => { setTimeout(done, 5); });
  }
}

test('close() resolves for a child that a signal not sent through kill() has already ended', async () => {
  const transport = await StdioTransport.spawn({
    id: 'signalled',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1 << 30)'],
  });
  const child = (transport as unknown as { child: ChildProcess }).child;
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  process.kill(child.pid!, 'SIGKILL');
  const info = await closed;
  assert.equal(info.signal, 'SIGKILL');
  assert.equal(child.exitCode, null);
  assert.equal(child.killed, false, "the signal didn't come through ChildProcess.kill()");
  // Bounded, so a close() that waits for an 'exit' already past fails the
  // test rather than hanging it.
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    transport.close().then(() => 'closed'),
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still waiting after 2 s'), 2000); }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, 'closed');
});

test('a connect whose child a signal ends during initialize is refused, and its retries keep coming', { timeout: 10_000 }, async (t) => {
  const logged = captureConsoleError(t);
  // The child kills itself when initialize arrives, so the signal doesn't
  // come through the transport's kill(): its exitCode stays null and its
  // `killed` false. The failed handshake's close() must still end, or the
  // first connect never settles and no retry is ever scheduled.
  const connection = await McplServerConnection.connectWithReconnect(
    {
      id: 'signalled',
      command: process.execPath,
      args: ['-e', "process.stdin.once('data', () => process.kill(process.pid, 'SIGKILL'))"],
      reconnect: true,
      reconnectIntervalMs: 10,
      reconnectMaxIntervalMs: 10,
    },
    { version: '0.5' },
  );
  t.after(() => connection.close());
  const failed: Array<{ error: string; attempt: number }> = [];
  const twoRetries = new Promise<void>((resolve) => {
    connection.on('reconnect-failed', (event: { error: string; attempt: number }) => {
      failed.push(event);
      if (failed.length === 2) resolve();
    });
  });
  connection.ready();
  await twoRetries;

  assert.equal(connection.isConnected, false);
  assert.deepEqual(failed.map((event) => event.attempt), [1, 2]);
  for (const event of failed) {
    assert.equal(event.error, 'MCPL server "signalled" transport closed before handshake completed (child process exited)');
  }
  assert.ok(logged.some((line) => line.includes('initial connect failed, will retry')), logged.join('\n'));
});

test('a transport a reconnect gets after close() has begun logs the errors it reports while it closes, rather than throwing them', { timeout: 10_000 }, async (t) => {
  const handshake = deferred();
  const closing = deferred();
  const transport = new HeldTransport(closing.promise);
  t.mock.method(McplServerConnection as unknown as { handshake: () => Promise<unknown> }, 'handshake', async () => {
    await handshake.promise;
    return { transport, capabilities: null, droppedCapabilities: new Set(), mcpToolsAdvertised: false };
  });
  const connection = Reflect.construct(McplServerConnection, ['kept', null, null]) as McplServerConnection;
  const internals = connection as unknown as {
    closed: boolean;
    reconnectEnabled: boolean;
    config: unknown;
    hostCapabilities: unknown;
    attemptReconnect(): Promise<void>;
  };
  internals.closed = true;
  internals.reconnectEnabled = true;
  internals.config = { id: 'kept', command: 'unused', reconnect: true };
  internals.hostCapabilities = { version: '0.5' };
  const reconnecting = internals.attemptReconnect();
  // close() ends the reconnect in flight: once its handshake returns, the
  // attempt closes the transport it got, and close() waits for that.
  const closed = connection.close();
  handshake.resolve();
  await waitFor(() => transport.calls > 0, 'the ended reconnect to close the transport it got');

  const logged = captureConsoleError(t);
  assert.doesNotThrow(() => transport.emit('error', new Error('a malformed frame while close() waits')));
  closing.resolve();
  await reconnecting;
  await closed;
  assert.doesNotThrow(() => transport.emit('error', new Error('another, after close() has finished')));
  assert.equal(connection.isConnected, false);
  assert.ok(logged.some((line) => line.includes('a malformed frame while close() waits')), logged.join('\n'));
  assert.ok(logged.some((line) => line.includes('another, after close() has finished')), logged.join('\n'));
});

test("a failed handshake's transport logs an error it reports while it closes, rather than throwing it", { timeout: 10_000 }, async (t) => {
  const logged = captureConsoleError(t);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  await new Promise<void>((resolve) => { server.once('listening', () => resolve()); });
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id?: number; method?: string };
      if (request.method !== 'initialize') return;
      // Refuse initialize, then send a frame with a reserved opcode (0x3),
      // which the host's ws receiver rejects with an 'error' on its socket.
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'refused by the test server' } }));
      (socket as unknown as { _socket: Socket })._socket.write(Buffer.from([0x83, 0x00]));
    });
  });
  const { port } = server.address() as AddressInfo;

  await assert.rejects(
    McplServerConnection.connect({ id: 'malformed', url: `ws://127.0.0.1:${port}` }, { version: '0.5' }),
    /^Error: MCPL server "malformed" initialize error: refused by the test server$/,
  );
  // The malformed frame arrives with the refusal, or while the failed
  // handshake's close() runs.
  await waitFor(() => logged.some((line) => line.includes('after the handshake settled')), 'the frame\'s error to be logged');
  assert.ok(
    logged.some((line) => line === '[mcpl] malformed: transport error after the handshake settled: Invalid WebSocket frame: invalid opcode 3'),
    logged.join('\n'),
  );
});

/** Settles with the promise's value, or with `fallback` after 5 s, so a test that
 *  waits for something that never comes still reaches its cleanup. */
async function within<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), 5000); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** A child that closes its end of stdin and stays alive, so a write fails with
 *  EPIPE before any 'exit'. Its close is registered with the test as soon as it
 *  spawns, so a wait that never ends can't leave the child running. */
async function spawnDeafChild(t: TestContext, id: string): Promise<StdioTransport> {
  const transport = await StdioTransport.spawn({
    id,
    command: process.execPath,
    args: ['-e', "require('fs').closeSync(0); console.log('stdin closed'); setInterval(() => {}, 1 << 30)"],
  });
  t.after(() => transport.close());
  const ready = await within(new Promise<boolean>((resolve) => { transport.once('line', () => resolve(true)); }), false);
  assert.ok(ready, 'the child said it had closed its stdin within 5 s');
  return transport;
}

test("a failed write to a child's stdin reaches the transport's 'error' listener", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'deaf-heard');
  const reported = new Promise<NodeJS.ErrnoException>((resolve) => { transport.once('error', resolve); });
  transport.writeLine('{}');
  const error = await within(reported, null);
  assert.ok(error, "the write's failure reached the transport's 'error' listener within 5 s");
  assert.equal(error.code, 'EPIPE');
});

test("a failed write to a child's stdin with nothing listening is not thrown", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'deaf-unheard');
  const child = (transport as unknown as { child: ChildProcess }).child;
  const failed = new Promise<void>((resolve) => { child.stdin!.once('close', () => resolve()); });
  transport.writeLine('{}');
  // The EPIPE destroys stdin; an 'error' nothing caught would have failed
  // this test as an uncaught exception by the time its 'close' arrives.
  assert.equal(await within(failed.then(() => 'closed'), 'still open after 5 s'), 'closed');
  assert.equal(transport.listenerCount('error'), 0);
});

test("a read error on a child's stdout or stderr reaches the transport's 'error' listener once", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'pipes-heard');
  const child = (transport as unknown as { child: ChildProcess }).child;
  for (const [name, stream] of [['stdout', child.stdout!], ['stderr', child.stderr!]] as const) {
    const heard: string[] = [];
    const onError = (error: Error) => { heard.push(error.message); };
    transport.on('error', onError);
    stream.destroy(new Error(`injected ${name} read failure`));
    // A destroyed stream emits its 'error' on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    transport.off('error', onError);
    assert.deepEqual(heard, [`injected ${name} read failure`]);
  }
});

test("a read error on a child's stdout or stderr with nothing listening is not thrown", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'pipes-unheard');
  const child = (transport as unknown as { child: ChildProcess }).child;
  child.stdout!.destroy(new Error('injected stdout read failure'));
  child.stderr!.destroy(new Error('injected stderr read failure'));
  // Both errors are emitted on the next tick; one nothing caught would have
  // failed this test as an uncaught exception by then.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.listenerCount('error'), 0);
});

test("a read error on a child's stdout that arrives while close() runs reaches the listener, not thrown", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'pipes-closing');
  const child = (transport as unknown as { child: ChildProcess }).child;
  const heard: string[] = [];
  transport.on('error', (error: Error) => { heard.push(error.message); });
  // destroy() emits the error on the next tick, after close() has closed
  // readline, which takes readline's own listener off the stream.
  child.stdout!.destroy(new Error('injected stdout read failure'));
  await transport.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heard, ['injected stdout read failure']);
});
