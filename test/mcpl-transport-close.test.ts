/**
 * A transport whose child or connection goes a way the transport didn't
 * choose:
 *   - StdioTransport.close() for a child that a signal not sent through its
 *     kill() has ended (an OOM kill, a crash), whose `killed` stays false, and
 *     a connect whose child ends that way during initialize;
 *   - a transport McplServerConnection keeps for close() while a reconnect's
 *     handshake finishes, and one a failed handshake is closing, each of
 *     which reports an error while nothing else listens for it;
 *   - an error on a child's stdin or stdout, which ends the child, and one on
 *     its stderr, which doesn't; a handshake whose child exits at once; a
 *     connected server that closes its stdin, and one that only stops
 *     reading; and the framework's trace of a close's reason.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';

import { McplTransport, StdioTransport, type TransportCloseInfo } from '../src/mcpl/transport.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { AgentFramework } from '../src/framework.js';

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

test('close() resolves for a child that a signal not sent through kill() has already ended', { timeout: 10_000 }, async () => {
  const transport = await StdioTransport.spawn({
    id: 'signalled',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1 << 30)'],
  });
  const child = (transport as unknown as { child: ChildProcess }).child;
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  process.kill(child.pid!, 'SIGKILL');
  const info = await within(closed, null);
  assert.ok(info, "the child's close arrived within 5 s");
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

test('a transport kept for close() during a reconnect logs the errors it reports, rather than throwing them', { timeout: 10_000 }, async (t) => {
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
  // close() disables reconnect, waits for the handshake in flight, and then
  // closes the transport it handed back.
  const closed = connection.close();
  handshake.resolve();
  await reconnecting;
  await waitFor(() => transport.calls > 0, 'close() to reach the kept transport');

  const logged = captureConsoleError(t);
  assert.doesNotThrow(() => transport.emit('error', new Error('a malformed frame while close() waits')));
  closing.resolve();
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

/** Settles with the promise's value, or with `fallback` after `ms` (5 s), so a
 *  test that waits for something that never comes still reaches its cleanup. */
async function within<T, F>(promise: Promise<T>, fallback: F, ms = 5000): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
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

test("a failed write to a child's stdin ends the child, and the transport's close names the failure", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'deaf-write');
  const errors: string[] = [];
  transport.on('error', (error: Error) => { errors.push(error.message); });
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  // The child has closed its stdin and is still running: the write's
  // EPIPE leaves the transport unable to reach it.
  transport.writeLine('{}');
  const info = await within(closed, null);
  assert.ok(info, 'the transport closed within 5 s');
  assert.equal(info.signal, 'SIGTERM', 'the transport ended the child');
  assert.equal(info.reason, 'child process exited, and its pipe failed with write EPIPE');
  assert.deepEqual(errors, [], "the close is the report: no 'error' is emitted");
});

test("a read error on a child's stdout ends the child the same way, and nothing is thrown", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'pipes-stdout');
  const child = (transport as unknown as { child: ChildProcess }).child;
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  // Nothing listens for 'error' on the transport: an error thrown from the
  // stream would fail this test as an uncaught exception.
  child.stdout!.destroy(new Error('injected stdout read failure'));
  const info = await within(closed, null);
  assert.ok(info, 'the transport closed within 5 s');
  assert.equal(info.signal, 'SIGTERM');
  assert.equal(info.reason, 'child process exited, and its pipe failed with injected stdout read failure');
});

test("a read error on a child's stderr reaches the transport's 'error' listener once, ends nothing, and with no listener isn't thrown", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'pipes-stderr');
  const child = (transport as unknown as { child: ChildProcess }).child;
  const heard: string[] = [];
  const onError = (error: Error) => { heard.push(error.message); };
  transport.on('error', onError);
  child.stderr!.destroy(new Error('injected stderr read failure'));
  // A destroyed stream emits its 'error' on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  transport.off('error', onError);
  assert.deepEqual(heard, ['injected stderr read failure']);
  assert.equal(child.exitCode, null, 'stderr carries diagnostics only: the child is still running');
  assert.equal(child.killed, false);

  // With nothing listening, the same error is neither thrown (that would fail
  // this test as an uncaught exception) nor the end of the child.
  const unheard = await spawnDeafChild(t, 'pipes-stderr-unheard');
  const unheardChild = (unheard as unknown as { child: ChildProcess }).child;
  assert.equal(unheard.listenerCount('error'), 0);
  unheardChild.stderr!.destroy(new Error('injected stderr read failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unheardChild.exitCode, null);
  assert.equal(unheardChild.killed, false);
});

test("a read error on a child's stdout that arrives while close() runs is not thrown", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'pipes-closing');
  const child = (transport as unknown as { child: ChildProcess }).child;
  // destroy() emits the error on the next tick, after close() has closed
  // readline, which takes readline's own listener off the stream.
  child.stdout!.destroy(new Error('injected stdout read failure'));
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  await transport.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await closed).reason, 'closed by host', "the host's close came first, and the error changes nothing");
});

test('a handshake whose child exits at once is refused by its close, never by a pipe error that raced the exit', { timeout: 30_000 }, async () => {
  // `false` exits before its stdin is read, so the initialize write can fail
  // with EPIPE before or after the exit: the maintainer's review measured 4
  // of 10 runs with the EPIPE first. Either way the refusal is the close's.
  let withPipeError = 0;
  for (let run = 0; run < 10; run++) {
    const refusal = await McplServerConnection.connect({ id: 'exits-at-once', command: 'false' }, { version: '0.5' })
      .then(() => 'connected', (error: Error) => error.message);
    assert.match(refusal, /^MCPL server "exits-at-once" transport closed before handshake completed \(child process exited(, and its pipe failed with write EPIPE)?\)$/);
    if (refusal.includes('its pipe failed')) withPipeError++;
  }
  // Not asserted: whether a run raced is the platform's. Logged for the reader.
  console.log(`# ${withPipeError} of 10 refusals named a pipe error that raced the exit`);
});

test('a server that closes its stdin is ended: a request fails with the disconnect, and the connection reconnects', { timeout: 60_000 }, async (t) => {
  // Answers initialize, then, once the initialized notification is in, closes
  // its stdin and says so on stderr, staying alive. (A server that only stops
  // reading, leaving its stdin open, raises no error: the parent's writes are
  // buffered, and its requests end at their timeout.)
  const deafAfterInitialize = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  if (message.method === 'initialize') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, serverInfo: { name: 'deaf-after-initialize', version: '0.0.0' } } }) + '\\n');",
    "  } else if (message.method === 'notifications/initialized') {",
    // Node keeps a stdio descriptor open when its stream is destroyed, so the
    // read end is closed by hand once the stream is done with it. The line on
    // stderr comes after, so a write that follows it fails.
    "    process.stdin.once('close', () => { try { require('fs').closeSync(0); } catch {} console.error('closed stdin'); });",
    '    rl.close(); process.stdin.destroy();',
    '  }',
    '});',
    'setInterval(() => {}, 1 << 30);',
  ].join('\n');
  const connection = await McplServerConnection.connectWithReconnect(
    {
      id: 'deaf-after-initialize',
      command: process.execPath,
      args: ['-e', deafAfterInitialize],
      reconnect: true,
      reconnectIntervalMs: 10,
      reconnectMaxIntervalMs: 10,
    },
    { version: '0.5' },
  );
  t.after(() => connection.close());
  assert.equal(connection.isConnected, true);
  const deaf = new Promise<void>((resolve) => {
    connection.on('stderr', ({ line }: { line: string }) => { if (line === 'closed stdin') resolve(); });
  });
  const closed = new Promise<{ reason?: string }>((resolve) => {
    connection.once('close', (_code: unknown, _signal: unknown, info: { reason?: string }) => resolve(info));
  });
  const reconnected = new Promise<void>((resolve) => { connection.once('reconnect', () => resolve()); });
  connection.ready();
  assert.equal(await within(deaf.then(() => 'deaf'), 'no word from the server within 15 s', 15_000), 'deaf');

  // Its timeout is 30 s, so an answer within 15 s comes from the transport's close.
  const answer = connection.sendManifestRequest(30_000).then(() => 'answered', (error: Error) => error.message);
  assert.match(
    await within(answer, 'still waiting after 15 s', 15_000),
    /^MCPL server "deaf-after-initialize" disconnected unexpectedly \(code=n\/a, signal=SIGTERM, reason=child process exited, and its pipe failed with write EPIPE\) while awaiting mcpl\/manifest/,
  );
  assert.equal((await within(closed, null, 15_000))?.reason, 'child process exited, and its pipe failed with write EPIPE');
  assert.equal(await within(reconnected.then(() => 'reconnected'), 'no reconnect within 15 s', 15_000), 'reconnected');
});

test("the framework's mcpl:server-closed trace carries the transport's reason, and leaves a WebSocket server's own close text off", () => {
  const framework = Object.create(AgentFramework.prototype) as {
    traceListeners: unknown[];
    onTrace(listener: (event: Record<string, unknown>) => void): void;
    wireMcplEvents(connection: unknown): void;
  };
  framework.traceListeners = [];
  const closes: Array<Record<string, unknown>> = [];
  framework.onTrace((event) => { if (event.type === 'mcpl:server-closed') closes.push(event); });
  const connection = Object.assign(new EventEmitter(), { id: 'srv', willReconnect: true });
  framework.wireMcplEvents(connection);
  connection.emit('close', null, 'SIGTERM', {
    transport: 'stdio', code: null, signal: 'SIGTERM', byHost: false,
    reason: 'child process exited, and its pipe failed with write EPIPE',
  });
  connection.emit('close', 4001, null, {
    transport: 'websocket', code: 4001, signal: null, byHost: false, reason: 'token expired', reasonFromPeer: true,
  });
  connection.emit('close', null, null);
  assert.deepEqual(closes.map(({ code, signal, reason }) => ({ code, signal, reason })), [
    { code: null, signal: 'SIGTERM', reason: 'child process exited, and its pipe failed with write EPIPE' },
    { code: 4001, signal: null, reason: null },
    { code: null, signal: null, reason: null },
  ]);
});

test("a server that stops reading its stdin without closing it stays connected, and a request ends at its own timeout", { timeout: 20_000 }, async (t) => {
  // Answers initialize, then, once the initialized notification is in, stops
  // reading and says so on stderr, keeping its stdin open and staying alive.
  const stopsReading = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  if (message.method === 'initialize') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, serverInfo: { name: 'stops-reading', version: '0.0.0' } } }) + '\\n');",
    "  } else if (message.method === 'notifications/initialized') {",
    "    rl.pause(); process.stdin.pause(); console.error('stopped reading');",
    '  }',
    '});',
    'setInterval(() => {}, 1 << 30);',
  ].join('\n');
  const connection = await McplServerConnection.connectWithReconnect(
    {
      id: 'stops-reading',
      command: process.execPath,
      args: ['-e', stopsReading],
      reconnect: true,
      reconnectIntervalMs: 10,
      reconnectMaxIntervalMs: 10,
    },
    { version: '0.5' },
  );
  t.after(() => connection.close());
  assert.equal(connection.isConnected, true);
  const deaf = new Promise<void>((resolve) => {
    connection.on('stderr', ({ line }: { line: string }) => { if (line === 'stopped reading') resolve(); });
  });
  let closed = false;
  connection.once('close', () => { closed = true; });
  connection.ready();
  assert.equal(await within(deaf.then(() => 'deaf'), 'no word from the server within 5 s'), 'deaf');

  // Nothing fails the write, so only the request's own 500 ms timeout ends it.
  const answer = connection.sendManifestRequest(500).then(() => 'answered', (error: Error) => error.message);
  assert.match(await within(answer, 'still waiting after 5 s'), /^MCPL server "stops-reading" did not respond to mcpl\/manifest \(id=\d+\) within 500ms/);
  assert.equal(closed, false, 'nothing closed the connection');
  assert.equal(connection.isConnected, true, 'the connection is still up');
});
