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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { McplTransport, StdioTransport, setStdioExitGraceForTests, setStdioLineBoundForTests, type TransportCloseInfo } from '../src/mcpl/transport.js';
import { McplRequestError, McplServerConnection } from '../src/mcpl/server-connection.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** What a record of a server's text says when the server's configuration
 *  can't be read to redact it. */
const WITHHELD = "[withheld: the server's configuration couldn't be read to redact this]";

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
async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((done) => { setTimeout(done, 5); });
  }
}

const UNREAPABLE_GRACE_MS = 50;

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

for (const unreadable of [false, true]) test(`a transport a reconnect gets after close() has begun logs the errors it reports while it closes${unreadable ? ", withheld when the server's configuration can't be read," : ','} rather than throwing them`, { timeout: 10_000 }, async (t) => {
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
  if (unreadable) Object.defineProperty(internals.config, 'env', { enumerable: true, get() { throw new Error('this configuration cannot be read'); } });
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
  if (unreadable) {
    const withheld = `[mcpl] kept: a transport closed before it served reported an error: ${WITHHELD}`;
    assert.equal(logged.filter((line) => line === withheld).length, 2, logged.join('\n'));
  } else {
    assert.ok(logged.some((line) => line.includes('a malformed frame while close() waits')), logged.join('\n'));
    assert.ok(logged.some((line) => line.includes('another, after close() has finished')), logged.join('\n'));
  }
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

for (const unreadable of [false, true]) test(`a failed handshake's transport error is logged ${unreadable ? "withheld when the server's configuration can't be read" : "without the server's credentials"}`, { timeout: 10_000 }, async (t) => {
  const logged = captureConsoleError(t);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  await new Promise<void>((resolve) => { server.once('listening', () => resolve()); });
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id?: number; method?: string };
      if (request.method !== 'initialize') return;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'refused by the test server' } }));
      (socket as unknown as { _socket: Socket })._socket.write(Buffer.from([0x83, 0x00]));
    });
  });
  const { port } = server.address() as AddressInfo;
  // The frame's error text, "invalid opcode 3", quotes this token.
  const config: McplServerConfig = { id: 'malformed', url: `ws://127.0.0.1:${port}`, token: 'invalid opcode' };
  if (unreadable) Object.defineProperty(config, 'env', { enumerable: true, get() { throw new Error('this configuration cannot be read'); } });
  await assert.rejects(McplServerConnection.connect(config, { version: '0.5' }), (error: Error) => {
    assert.equal(error.message, `MCPL server "malformed" initialize error: ${unreadable ? WITHHELD : 'refused by the test server'}`);
    return true;
  });
  await waitFor(() => logged.some((line) => line.includes('after the handshake settled')), 'the frame\'s error to be logged');
  const text = unreadable ? WITHHELD : 'Invalid WebSocket frame: redacted 3';
  assert.ok(
    logged.some((line) => line === `[mcpl] malformed: transport error after the handshake settled: ${text}`),
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
  assert.equal(info.reason, 'child process exited, and this host had stopped using the server\'s stdio (write EPIPE)');
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
  assert.equal(info.reason, 'child process exited, and this host had stopped using the server\'s stdio (injected stdout read failure)');
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
  assert.equal(child.killed, false, 'stderr carries diagnostics only: nothing ended the child');

  // With nothing listening, the same error is neither thrown (that would fail
  // this test as an uncaught exception) nor the end of the child.
  const unheard = await spawnDeafChild(t, 'pipes-stderr-unheard');
  const unheardChild = (unheard as unknown as { child: ChildProcess }).child;
  assert.equal(unheard.listenerCount('error'), 0);
  unheardChild.stderr!.destroy(new Error('injected stderr read failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unheardChild.killed, false);
});

test("a read error on a child's stdout that arrives while close() runs is not thrown", { timeout: 10_000 }, async (t) => {
  const transport = await spawnDeafChild(t, 'pipes-closing');
  const child = (transport as unknown as { child: ChildProcess }).child;
  // destroy() emits the error on the next tick, so it arrives while close() runs.
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
    assert.match(refusal, /^MCPL server "exits-at-once" transport closed before handshake completed \(child process exited(, and this host had stopped using the server's stdio \(write EPIPE\))?\)$/);
    if (refusal.includes('stopped using the server\'s stdio')) withPipeError++;
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
    /^The connection to the "deaf-after-initialize" server closed before it answered, so whether the request took effect is unknown\. Check its effect before trying again; this host is reconnecting to it\.$/,
  );
  assert.equal((await within(closed, null, 15_000))?.reason, 'child process exited, and this host had stopped using the server\'s stdio (write EPIPE)');
  assert.equal(await within(reconnected.then(() => 'reconnected'), 'no reconnect within 15 s', 15_000), 'reconnected');
});

test("the framework's mcpl:server-closed trace carries the transport's reason, and leaves a WebSocket server's own close text off", () => {
  const framework = Object.create(AgentFramework.prototype) as {
    traceListeners: unknown[];
    onTrace(listener: (event: Record<string, unknown>) => void): void;
    wireMcplEvents(connection: unknown, config: unknown): void;
  };
  framework.traceListeners = [];
  const closes: Array<Record<string, unknown>> = [];
  framework.onTrace((event) => { if (event.type === 'mcpl:server-closed') closes.push(event); });
  const connection = Object.assign(new EventEmitter(), { id: 'srv', willReconnect: true });
  framework.wireMcplEvents(connection, { id: 'srv' });
  connection.emit('close', null, 'SIGTERM', {
    transport: 'stdio', code: null, signal: 'SIGTERM', byHost: false,
    reason: 'child process exited, and this host had stopped using the server\'s stdio (write EPIPE)',
  });
  connection.emit('close', 4001, null, {
    transport: 'websocket', code: 4001, signal: null, byHost: false, reason: 'token expired', reasonFromPeer: true,
  });
  connection.emit('close', null, null);
  assert.deepEqual(closes.map(({ code, signal, reason }) => ({ code, signal, reason })), [
    { code: null, signal: 'SIGTERM', reason: 'child process exited, and this host had stopped using the server\'s stdio (write EPIPE)' },
    { code: 4001, signal: null, reason: null },
    { code: null, signal: null, reason: null },
  ]);
});

test("the framework's close handler withdraws the closed transport's channel confirmations first, before anything else it does", () => {
  const framework = Object.create(AgentFramework.prototype) as {
    traceListeners: unknown[];
    channelRegistry: unknown;
    featureSetManager: unknown;
    noteMcplServerClosed(id: string): void;
    dropMcplToolClasses(id: string): void;
    onTrace(listener: (event: Record<string, unknown>) => void): void;
    wireMcplEvents(connection: unknown, config: unknown): void;
  };
  framework.traceListeners = [];
  const order: string[] = [];
  framework.channelRegistry = { transportClosed: (id: string) => { order.push(`transportClosed ${id}`); } };
  framework.featureSetManager = { removeServer: (id: string) => { order.push(`removeServer ${id}`); } };
  framework.noteMcplServerClosed = (id) => { order.push(`noteMcplServerClosed ${id}`); };
  framework.dropMcplToolClasses = (id) => { order.push(`dropMcplToolClasses ${id}`); };
  framework.onTrace((event) => { order.push(`trace ${String(event.type)}`); });
  const connection = Object.assign(new EventEmitter(), { id: 'srv', willReconnect: true });
  framework.wireMcplEvents(connection, { id: 'srv' });
  // emit() runs the listener synchronously: what it did is done when emit returns
  connection.emit('close', null, null);
  assert.equal(order[0], 'transportClosed srv', order.join(', '));
});

test("after a transport closes and reconnects, channel_open asks the server again rather than answering already open", async () => {
  const sent: string[] = [];
  const connection = Object.assign(new EventEmitter(), {
    id: 'srv',
    transportEpoch: 0,
    willReconnect: true,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async (params: { channelId: string }) => {
      sent.push(`open ${params.channelId} on transport ${connection.transportEpoch}`);
      return { channel: { id: params.channelId, type: 'test', label: params.channelId, direction: 'bidirectional' as const, address: { value: 'a' } } };
    },
    sendChannelsClose: async (params: { channelId: string }) => { sent.push(`close ${params.channelId}`); return { closed: true }; },
  });
  const servers = { getServer: (id: string) => (id === 'srv' ? connection : null) } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(servers, {} as FeatureSetManager, () => {}, () => {});
  const framework = Object.create(AgentFramework.prototype) as {
    traceListeners: unknown[];
    channelRegistry: ChannelRegistry;
    wireMcplEvents(connection: unknown, config: unknown): void;
  };
  framework.traceListeners = [];
  framework.channelRegistry = registry;
  framework.wireMcplEvents(connection, { id: 'srv' });
  const open = async () => ((await registry.handleChannelToolCall('channel_open', { serverId: 'srv', channelId: 'x' })).data ?? {}) as { status?: string };

  await registry.handleRegister('srv', { channels: [{ id: 'x', type: 'test', label: 'x', direction: 'bidirectional', address: { value: 'a' } }] });
  assert.equal((await open()).status, 'opened');
  // The transport drops, and the connection reconnects in place on a new
  // transport; the server hasn't registered its channels again yet.
  connection.transportEpoch++;
  connection.emit('close', null, null, { transport: 'stdio', code: null, signal: null, byHost: false });
  assert.equal(registry.isChannelOpen({ serverId: 'srv', channelId: 'x' }), false, "the closed transport's confirmation went with it");
  connection.transportEpoch++;
  sent.length = 0;
  assert.notEqual((await open()).status, 'already open');
  assert.deepEqual(sent, ['open x on transport 2'], 'the open goes to the new transport');
  assert.equal(registry.isChannelOpen({ serverId: 'srv', channelId: 'x' }), true, "the new transport's receipt confirms it");
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
  assert.match(await within(answer, 'still waiting after 5 s'), /^The "stops-reading" server didn't answer within 0\.5 seconds, so whether the request took effect is unknown/);
  assert.equal(closed, false, 'nothing closed the connection');
  assert.equal(connection.isConnected, true, 'the connection is still up');
});

/** A child that closes its end of stdin and ignores SIGTERM, appending a line
 *  to `signals` for each SIGTERM it gets, so only SIGKILL ends it. */
async function spawnDeafStubbornChild(t: TestContext, id: string, signals: string): Promise<StdioTransport> {
  const transport = await StdioTransport.spawn({
    id,
    command: process.execPath,
    args: ['-e', [
      "const fs = require('fs');",
      `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(signals)}, 'SIGTERM\\n'));`,
      "fs.closeSync(0); console.log('stdin closed'); setInterval(() => {}, 1 << 30);",
    ].join(' ')],
  });
  t.after(() => transport.close().catch(() => {}));
  const ready = await within(new Promise<boolean>((resolve) => { transport.once('line', () => resolve(true)); }), false);
  assert.ok(ready, 'the child said it had closed its stdin within 5 s');
  return transport;
}

function signalsFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-pipe-signals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'signals.txt');
}
const received = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

test("a failed write to a child that ignores SIGTERM ends it with SIGKILL 2 s later, and the close still names the failure", { timeout: 15_000 }, async (t) => {
  const signals = signalsFile(t);
  const transport = await spawnDeafStubbornChild(t, 'deaf-stubborn', signals);
  const logged = captureConsoleError(t);
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  transport.writeLine('{}');
  await waitFor(() => transport.stdioStopCause !== undefined, 'the write to fail');
  assert.equal(transport.stdioStopCause?.message, 'write EPIPE', 'writes are refused from here on');
  const info = await within(closed, null, 8000);
  assert.ok(info, 'the transport closed within 8 s');
  assert.equal(info.signal, 'SIGKILL', 'SIGKILL ended the child');
  assert.equal(info.reason, 'child process exited, and this host had stopped using the server\'s stdio (write EPIPE)');
  assert.equal(received(signals), 1, 'one SIGTERM, then SIGKILL');
  assert.equal(logged.filter((line) => line.includes('ignored SIGTERM for 2000ms')).length, 1, logged.join('\n'));
});

test("a child given a test's exit grace waits only that grace after a pipe failure, as after SIGTERM and SIGKILL", { timeout: 15_000 }, async (t) => {
  // Hooks run in the order they're added, and the mocked clock lasts into them, so
  // this one goes first: when a failed assertion leaves the escalation partway, it
  // puts back real timers and kill() and ends the child, so the helper's close() ends.
  let restore = () => {};
  t.after(() => restore());
  const signals = signalsFile(t);
  const transport = await spawnDeafStubbornChild(t, 'deaf-short-grace', signals);
  captureConsoleError(t);
  const child = (transport as unknown as { child: ChildProcess & { kill: (signal?: number | string) => boolean } }).child;
  const realKill = child.kill.bind(child);
  const sent: string[] = [];
  child.kill = (signal?: number | string) => { sent.push(String(signal ?? 'SIGTERM')); return true; }; // it can exit by no means
  setStdioExitGraceForTests(child, 50);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  restore = () => { t.mock.timers.reset(); child.kill = realKill; realKill('SIGKILL'); };
  const settle = () => new Promise<void>((done) => { setImmediate(done); });
  transport.writeLine('{}');
  for (const deadline = Date.now() + 5000; transport.stdioStopCause === undefined; await settle()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the write to fail');
  }
  t.mock.timers.tick(49);
  await settle();
  assert.deepEqual(sent, [], 'nothing is sent within the 50 ms the child has to exit after the pipe error');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(sent, ['SIGTERM'], 'SIGTERM once those 50 ms end');
  t.mock.timers.tick(50);
  await settle();
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL'], 'SIGKILL 50 ms later');
  const unreaped = new Promise<Error>((resolve) => { transport.once('unreaped', resolve); });
  t.mock.timers.tick(50);
  assert.match((await unreaped).message, /did not exit within 50ms of SIGKILL; it could not be reaped$/);
});

test("close() during a pipe failure's escalation shares its attempt: one SIGTERM, one SIGKILL", { timeout: 15_000 }, async (t) => {
  const signals = signalsFile(t);
  const transport = await spawnDeafStubbornChild(t, 'deaf-shared', signals);
  const logged = captureConsoleError(t);
  transport.writeLine('{}');
  await waitFor(() => received(signals) === 1, 'the pipe failure to send SIGTERM');
  // close() comes inside the 2 s the child has before SIGKILL, and resolves
  // once that SIGKILL has ended it, with no SIGTERM of its own.
  const child = (transport as unknown as { child: ChildProcess }).child;
  assert.ok(child.exitCode === null && child.signalCode === null, 'close() comes while the child still runs');
  await transport.close();
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(received(signals), 1, 'close() sent no second SIGTERM');
  assert.equal(logged.filter((line) => line.includes('sending SIGKILL')).length, 1, logged.join('\n'));
});

test("a pipe failure whose child outlives SIGKILL too leaves the transport open and says 'unreaped'; a close() once the child has exited reaps it", { timeout: 20_000 }, async (t) => {
  const signals = signalsFile(t);
  const transport = await spawnDeafStubbornChild(t, 'deaf-unreaped', signals);
  captureConsoleError(t);
  const child = (transport as unknown as { child: ChildProcess & { kill: (signal?: string) => boolean } }).child;
  const realKill = child.kill.bind(child);
  child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(child, UNREAPABLE_GRACE_MS);
  t.after(() => { realKill('SIGKILL'); });
  const unreaped = new Promise<Error>((resolve) => { transport.once('unreaped', resolve); });
  transport.writeLine('{}');
  const failure = await within(unreaped, null, 10_000);
  assert.ok(failure, "'unreaped' within 10 s");
  assert.match(failure.message, new RegExp(`^stdio child \\d+ of MCP server "deaf-unreaped" did not exit within ${UNREAPABLE_GRACE_MS}ms of SIGKILL; it could not be reaped$`));
  assert.equal(transport.closed, false, 'the transport stays open, owning the child');
  // The child exits at last: its exit closes the transport, naming the pipe
  // failure, and the first close() after it re-checks the failed attempt
  // rather than repeating its verdict.
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  realKill('SIGKILL');
  assert.equal((await within(closed, null))?.reason, 'child process exited, and this host had stopped using the server\'s stdio (write EPIPE)');
  await transport.close();
});

test("a host close() during an unreapable child's pipe escalation reports the failure itself, with no 'unreaped'", { timeout: 20_000 }, async (t) => {
  const signals = signalsFile(t);
  const transport = await spawnDeafStubbornChild(t, 'deaf-host-close', signals);
  captureConsoleError(t);
  const child = (transport as unknown as { child: ChildProcess & { kill: (signal?: string) => boolean } }).child;
  const realKill = child.kill.bind(child);
  const sent: string[] = [];
  let closed: Promise<void> | undefined;
  let closing!: () => void;
  const closeCalled = new Promise<void>((resolve) => { closing = resolve; });
  child.kill = (signal?: number | string) => {
    sent.push(String(signal ?? 'SIGTERM'));
    if (!closed) queueMicrotask(() => { closed = transport.close(); closing(); });
    return true;
  };
  setStdioExitGraceForTests(child, 50);
  t.after(() => { realKill('SIGKILL'); });
  let saidUnreaped = false;
  transport.on('unreaped', () => { saidUnreaped = true; });
  transport.writeLine('{}');
  await closeCalled;
  await assert.rejects(closed!, /could not be reaped/);
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL'], "the host's close shares the escalation's attempt");
  assert.equal(saidUnreaped, false);
});

test("after a pipe fails nothing more is written, a second pipe error starts nothing, and a close() while the child runs rejects again without a signal", { timeout: 20_000 }, async (t) => {
  // A child that ignores SIGTERM and keeps its stdin open: only its stdout
  // fails here, so a write would still reach it.
  const transport = await StdioTransport.spawn({
    id: 'read-failed',
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1 << 30);"],
  });
  t.after(() => transport.close().catch(() => {}));
  captureConsoleError(t);
  assert.ok(await within(new Promise<boolean>((resolve) => { transport.once('line', () => resolve(true)); }), false), 'the child is up');
  const child = (transport as unknown as { child: ChildProcess & { kill: (signal?: string) => boolean } }).child;
  const realKill = child.kill.bind(child);
  let signalled = 0;
  child.kill = () => { signalled++; return true; }; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(child, UNREAPABLE_GRACE_MS);
  t.after(() => { realKill('SIGKILL'); });
  const stdin = child.stdin!;
  const realWrite = stdin.write.bind(stdin);
  let written = 0;
  (stdin as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => { written++; return (realWrite as (...a: unknown[]) => boolean)(...args); };
  let unreaped = 0;
  const first = new Promise<void>((resolve) => { transport.on('unreaped', () => { unreaped++; resolve(); }); });

  transport.writeLine('{"before":true}');
  assert.equal(written, 1, 'a write goes out while the pipes hold');
  child.stdout!.emit('error', new Error('read failed'));
  assert.equal(transport.stdioStopCause?.message, 'read failed');
  transport.writeLine('{"after":true}');
  assert.equal(written, 1, 'nothing more is written once a pipe has failed');
  child.stdin!.emit('error', new Error('write EPIPE'));
  assert.equal(transport.stdioStopCause?.message, 'read failed', 'the first failure is the one kept');

  assert.ok(await within(first.then(() => true), false, 10_000), "'unreaped' within 10 s");
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(unreaped, 1, "one 'unreaped' for the one failed attempt");
  assert.equal(signalled, 2, 'SIGTERM, then SIGKILL');
  // While the child runs, close() fails with the same verdict and sends no
  // signal of its own.
  await assert.rejects(transport.close(), /could not be reaped/);
  assert.equal(signalled, 2, 'close() sent no signal');
});

/** A legacy MCPL server that answers initialize, then, once the initialized
 *  notification is in, closes its stdin, ignoring SIGTERM, and says so on
 *  stderr. */
const DEAF_AND_STUBBORN = [
  "process.on('SIGTERM', () => console.error('ignored SIGTERM'));",
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "rl.on('line', (line) => {",
  '  const message = JSON.parse(line);',
  "  if (message.method === 'initialize') {",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, serverInfo: { name: 'deaf-and-stubborn', version: '0.0.0' } } }) + '\\n');",
  "  } else if (message.method === 'notifications/initialized') {",
  "    process.stdin.once('close', () => { try { require('fs').closeSync(0); } catch {} console.error('closed stdin'); });",
  '    rl.close(); process.stdin.destroy();',
  '  }',
  '});',
  'setInterval(() => {}, 1 << 30);',
].join('\n');

test('a legacy request made after a stdin failure is refused as not sent, and the server, which ignores SIGTERM, is killed and reconnected', { timeout: 60_000 }, async (t) => {
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'deaf-and-stubborn', command: process.execPath, args: ['-e', DEAF_AND_STUBBORN], reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 10 },
    { version: '0.5' },
  );
  t.after(() => connection.close());
  const logged = captureConsoleError(t);
  const stderr: string[] = [];
  connection.on('stderr', ({ line }: { line: string }) => { stderr.push(line); });
  const closed = new Promise<{ reason?: string; signal?: string | null }>((resolve) => {
    connection.once('close', (_code: unknown, _signal: unknown, info: { reason?: string; signal?: string | null }) => resolve(info));
  });
  const reconnected = new Promise<void>((resolve) => { connection.once('reconnect', () => resolve()); });
  connection.ready();
  await waitFor(() => stderr.includes('closed stdin'), 'the server to close its stdin');
  // The first write after that fails with EPIPE. It went out, so its request
  // waits for the close, as possibly executed.
  const first = connection.sendManifestRequest(30_000).then(() => null, (error: unknown) => error);
  await waitFor(() => stderr.includes('ignored SIGTERM'), 'the transport to send SIGTERM');
  // From here on nothing is written: a request is refused at once.
  await assert.rejects(connection.sendManifestRequest(30_000), (error: unknown) => {
    assert.ok(error instanceof Error && (error as { outcome?: string }).outcome === 'not-sent', String(error));
    assert.equal((error as Error).message, 'The request wasn\'t sent: this host can no longer write to the "deaf-and-stubborn" server, ' +
      'so nothing ran. This host is reconnecting to it; try again later.');
    return true;
  });
  // The pipe's error is the operator's, in the log.
  assert.ok(logged.some((line) => /^MCPL server "deaf-and-stubborn": \S+ not sent, since this host stopped using the server's stdio \(.*write EPIPE/.test(line)), logged.join('\n'));
  const info = await within(closed, null, 10_000);
  assert.equal(info?.signal, 'SIGKILL', 'SIGKILL ended it');
  assert.equal(info?.reason, 'child process exited, and this host had stopped using the server\'s stdio (write EPIPE)');
  const outcome = await within(first, 'still waiting', 10_000);
  assert.ok(outcome instanceof McplRequestError, `the written request failed with the close: ${String(outcome)}`);
  assert.equal(outcome.outcome, 'no-response', 'it went out, so it may have run');
  assert.equal(outcome.message, 'The connection to the "deaf-and-stubborn" server closed before it answered, so whether the request ' +
    'took effect is unknown. Check its effect before trying again; this host is reconnecting to it.');
  // How it closed, and the request it left unanswered, are the operator's, in the log.
  assert.ok(logged.some((line) => /^MCPL server "deaf-and-stubborn" disconnected \(.*signal=SIGKILL, reason=child process exited, and this host had stopped using the server's stdio \(write EPIPE\)\) with 1 request\(s\) unanswered: mcpl\/manifest/.test(line)), logged.join('\n'));
  assert.equal(await within(reconnected.then(() => 'reconnected'), 'no reconnect within 15 s', 15_000), 'reconnected');
});

function longLineOnManifest(name: string, ignoreTerm: boolean): string {
  return [
    ...(ignoreTerm ? ["process.on('SIGTERM', () => console.error('ignored SIGTERM'));"] : []),
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  if (message.method === 'initialize') {",
    `    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, serverInfo: { name: '${name}', version: '0.0.0' } } }) + '\\n');`,
    "  } else if (message.method === 'mcpl/manifest') {",
    "    process.stdout.write('x'.repeat(65_537));",
    '  }',
    '});',
    'setInterval(() => {}, 1 << 30);',
  ].join('\n');
}

const LONG_LINE_REASON = 'child process exited, and this host had stopped using the server\'s stdio (the server wrote a line on stdout longer than 65,536 UTF-16 code units)';

test('a server that writes a line longer than the bound is ended at once, with no exit grace: a request in flight fails with the disconnect, the close names the line, and the connection reconnects', { timeout: 60_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'long-line', command: process.execPath, args: ['-e', longLineOnManifest('long-line', false)], reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 10 },
    { version: '0.5' },
  );
  t.after(() => connection.close());
  setStdioExitGraceForTests((connection as unknown as { transport: { child: ChildProcess } }).transport.child, 60_000);
  const closed = new Promise<{ reason?: string; signal?: string | null; pipeFailed?: boolean }>((resolve) => {
    connection.once('close', (_code: unknown, _signal: unknown, info: { reason?: string; signal?: string | null; pipeFailed?: boolean }) => resolve(info));
  });
  const reconnected = new Promise<void>((resolve) => { connection.once('reconnect', () => resolve()); });
  connection.ready();
  const answer = connection.sendManifestRequest(30_000).then(() => 'answered', (error: Error) => error.message);
  assert.match(
    await within(answer, 'still waiting after 15 s', 15_000),
    /^The connection to the "long-line" server closed before it answered, so whether the request took effect is unknown\. Check its effect before trying again; this host is reconnecting to it\.$/,
  );
  const info = await within(closed, null, 15_000);
  assert.deepEqual({ signal: info?.signal, reason: info?.reason, pipeFailed: info?.pipeFailed }, { signal: 'SIGTERM', reason: LONG_LINE_REASON, pipeFailed: true });
  assert.equal(await within(reconnected.then(() => 'reconnected'), 'no reconnect within 15 s', 15_000), 'reconnected');
});

test('a request made after a line longer than the bound is refused as not sent, and the server, which ignores SIGTERM, is killed and reconnected', { timeout: 60_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'long-line-stubborn', command: process.execPath, args: ['-e', longLineOnManifest('long-line-stubborn', true)], reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 10 },
    { version: '0.5' },
  );
  t.after(() => connection.close());
  const logged = captureConsoleError(t);
  const stderr: string[] = [];
  connection.on('stderr', ({ line }: { line: string }) => { stderr.push(line); });
  const closed = new Promise<{ reason?: string; signal?: string | null }>((resolve) => {
    connection.once('close', (_code: unknown, _signal: unknown, info: { reason?: string; signal?: string | null }) => resolve(info));
  });
  const reconnected = new Promise<void>((resolve) => { connection.once('reconnect', () => resolve()); });
  connection.ready();
  const first = connection.sendManifestRequest(30_000).then(() => null, (error: unknown) => error);
  await waitFor(() => stderr.includes('ignored SIGTERM'), 'the transport to send SIGTERM');
  await assert.rejects(connection.sendManifestRequest(30_000), (error: unknown) => {
    assert.ok(error instanceof Error && (error as { outcome?: string }).outcome === 'not-sent', String(error));
    assert.equal((error as Error).message, 'The request wasn\'t sent: this host can no longer write to the "long-line-stubborn" server, ' +
      'so nothing ran. This host is reconnecting to it; try again later.');
    return true;
  });
  assert.ok(logged.some((line) => /^MCPL server "long-line-stubborn": \S+ not sent, since this host stopped using the server's stdio \(.*the server wrote a line on stdout longer than 65,536 UTF-16 code units/.test(line)), logged.join('\n'));
  const info = await within(closed, null, 10_000);
  assert.deepEqual({ signal: info?.signal, reason: info?.reason }, { signal: 'SIGKILL', reason: LONG_LINE_REASON });
  const outcome = await within(first, 'still waiting', 10_000);
  assert.ok(outcome instanceof McplRequestError, `the written request failed with the close: ${String(outcome)}`);
  assert.equal(outcome.outcome, 'no-response');
  assert.equal(await within(reconnected.then(() => 'reconnected'), 'no reconnect within 15 s', 15_000), 'reconnected');
});

const STDERR_DROPPED_NOTICE = '[a stderr line longer than 65,536 UTF-16 code units was dropped]';

test('a stderr line is dropped from the read that takes it past the bound, before its line end: the line before it arrives whole, one notice comes then, the rest of the line goes, the next line arrives whole, and the transport stays open', { timeout: 15_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  const script = "process.stderr.write('before\\n' + 'x'.repeat(65_537)); process.stdin.once('data', () => process.stderr.write('tail of it\\nnext\\n')); setInterval(() => {}, 1 << 30);";
  const transport = await StdioTransport.spawn({ id: 'long-stderr', command: process.execPath, args: ['-e', script] });
  t.after(() => transport.close());
  const lines: string[] = [];
  let noticed!: () => void;
  const notice = new Promise<void>((resolve) => { noticed = resolve; });
  let gotNext!: () => void;
  const next = new Promise<void>((resolve) => { gotNext = resolve; });
  transport.on('stderr', (line: string) => {
    lines.push(line);
    if (line === STDERR_DROPPED_NOTICE) noticed();
    if (line === 'next') gotNext();
  });
  assert.equal(await within(notice.then(() => 'notice'), 'no notice within 5 s, with the line end not yet written'), 'notice');
  transport.writeLine('go');
  assert.equal(await within(next.then(() => 'next'), 'no next line within 5 s'), 'next');
  assert.deepEqual({ lines, closed: transport.closed }, { lines: ['before', STDERR_DROPPED_NOTICE, 'next'], closed: false });
});

test('a stderr line of exactly the bound in UTF-16 code units, three times that in UTF-8, is held whole until something listens, as the newest held line', { timeout: 15_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  const script = "process.stderr.write('\u20ac'.repeat(65_536) + '\\n');";
  const transport = await StdioTransport.spawn({ id: 'stderr-at-bound', command: process.execPath, args: ['-e', script] });
  t.after(() => transport.close());
  await transport.stderrEnded(5_000);
  assert.equal((transport as unknown as { stderrDone: boolean }).stderrDone, true, "the child's stderr ended before anything listened");
  const lines: string[] = [];
  transport.on('stderr', (line: string) => { lines.push(line); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(lines, ['\u20ac'.repeat(65_536)]);
});

test('a stderr line whose line end comes in the read that takes it past the bound is dropped with one notice, and the next line arrives whole', { timeout: 15_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  const script = "process.stderr.write('y'.repeat(65_536)); process.stderr.write('y\\nlast\\n'); setInterval(() => {}, 1 << 30);";
  const transport = await StdioTransport.spawn({ id: 'long-stderr-ended', command: process.execPath, args: ['-e', script] });
  t.after(() => transport.close());
  const lines: string[] = [];
  const last = new Promise<void>((resolve) => transport.on('stderr', (line: string) => { lines.push(line); if (line === 'last') resolve(); }));
  assert.equal(await within(last.then(() => 'last'), 'no last line within 5 s'), 'last');
  assert.deepEqual({ lines, closed: transport.closed }, { lines: [STDERR_DROPPED_NOTICE, 'last'], closed: false });
});

test('stderr that arrives before anything listens is held to its newest 200 lines: the oldest go, with one notice saying how many, and the newest arrive in order', { timeout: 15_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  const script = "for (let i = 1; i <= 3000; i++) process.stderr.write(String(i).padStart(4, '0') + '\\n');";
  const transport = await StdioTransport.spawn({ id: 'stderr-flood', command: process.execPath, args: ['-e', script] });
  t.after(() => transport.close());
  await transport.stderrEnded(5_000);
  assert.equal((transport as unknown as { stderrDone: boolean }).stderrDone, true, "the child's stderr ended before anything listened");
  const lines: string[] = [];
  transport.on('stderr', (line: string) => { lines.push(line); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  const kept = Array.from({ length: 200 }, (_, k) => String(2801 + k).padStart(4, '0'));
  assert.deepEqual(lines, ['[2,800 earlier stderr lines were dropped: unread stderr is held to 200 lines and 65,536 UTF-16 code units]', ...kept]);
});

test('long stderr lines that arrive before anything listens are held to the bound in total: the oldest whole lines go, with one notice saying how many', { timeout: 15_000 }, async (t) => {
  setStdioLineBoundForTests(65_536);
  t.after(() => setStdioLineBoundForTests(undefined));
  const script = "for (let i = 1; i <= 3; i++) process.stderr.write(String(i) + 'x'.repeat(29_999) + '\\n');";
  const transport = await StdioTransport.spawn({ id: 'stderr-long-held', command: process.execPath, args: ['-e', script] });
  t.after(() => transport.close());
  await transport.stderrEnded(5_000);
  assert.equal((transport as unknown as { stderrDone: boolean }).stderrDone, true, "the child's stderr ended before anything listened");
  const lines: string[] = [];
  transport.on('stderr', (line: string) => { lines.push(line); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(lines, ['[1 earlier stderr line was dropped: unread stderr is held to 200 lines and 65,536 UTF-16 code units]', '2' + 'x'.repeat(29_999), '3' + 'x'.repeat(29_999)]);
});

test("a legacy server whose stdin fails and whose child outlives SIGKILL is held as a launch it can't reap: a permanent failure, and close() retries", { timeout: 60_000 }, async (t) => {
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'deaf-unreapable', command: process.execPath, args: ['-e', DEAF_AND_STUBBORN], reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 10 },
    { version: '0.5' },
  );
  captureConsoleError(t);
  const child = (connection as unknown as { transport: { child: ChildProcess & { kill: (signal?: string) => boolean } } }).transport.child;
  const realKill = child.kill.bind(child);
  child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(child, UNREAPABLE_GRACE_MS);
  t.after(async () => {
    realKill('SIGKILL');
    await waitFor(() => child.signalCode !== null, 'the held child killed');
    await connection.close();
  });
  const stderr: string[] = [];
  connection.on('stderr', ({ line }: { line: string }) => { stderr.push(line); });
  const order: string[] = [];
  const failures: Array<{ error: string; permanent?: boolean }> = [];
  connection.on('close', (_code: unknown, _signal: unknown, info: { reason?: string }) => {
    order.push(`close: ${info.reason} (holds its child: ${connection.holdsUnreapedChild})`);
  });
  connection.on('reconnect-failed', (failure: { error: string; permanent?: boolean }) => { order.push('reconnect-failed'); failures.push(failure); });
  connection.ready();
  await waitFor(() => stderr.includes('closed stdin'), 'the server to close its stdin');
  void connection.sendManifestRequest(30_000).catch(() => {}); // its write meets EPIPE
  await within(new Promise<void>((resolve) => { connection.once('reconnect-failed', () => resolve()); }), null, 10_000);
  assert.deepEqual(order, [
    'close: this host stopped using the server\'s stdio (write EPIPE), and the server\'s process outlived SIGKILL (holds its child: true)',
    'reconnect-failed',
  ]);
  assert.equal(failures[0]!.permanent, true);
  assert.match(failures[0]!.error, new RegExp(`^the previous launch could not be reaped \\(stdio child \\d+ of MCP server "deaf-unreapable" did not exit within ${UNREAPABLE_GRACE_MS}ms of SIGKILL; it could not be reaped\\); reconnecting is halted$`));
  assert.equal(connection.isConnected, false);
  assert.equal(connection.willReconnect, false);
  // close() retries the reap: refused while the child runs, then done.
  await assert.rejects(connection.close(), /could not be reaped/);
  realKill('SIGKILL');
  await waitFor(() => child.signalCode !== null, 'the child to be killed');
  await connection.close();
  assert.equal(connection.holdsUnreapedChild, false);
});

for (const release of ['ready', 'readyControlPlane'] as const) {
  test(`a legacy connection held as unreaped before its first ${release}() still delivers its permanent failure there, and nothing else`, { timeout: 60_000 }, async (t) => {
    const connection = await McplServerConnection.connectWithReconnect(
      { id: 'held-early', command: process.execPath, args: ['-e', DEAF_AND_STUBBORN], reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 10 },
      { version: '0.5' },
    );
    captureConsoleError(t);
    const transport = (connection as unknown as { transport: { stdioStopCause: Error | undefined; child: ChildProcess & { kill: (signal?: string) => boolean } } }).transport;
    const child = transport.child;
    const realKill = child.kill.bind(child);
    child.kill = () => true; // signals never arrive: the child outlives both bounds
    setStdioExitGraceForTests(child, UNREAPABLE_GRACE_MS);
    t.after(async () => {
      realKill('SIGKILL');
      await waitFor(() => child.signalCode !== null, 'the held child killed');
      await connection.close();
    });
    const failures: Array<{ error: string; permanent?: boolean }> = [];
    connection.on('reconnect-failed', (failure: { error: string; permanent?: boolean }) => { failures.push(failure); });
    const delivered: string[] = [];
    connection.on('stderr', ({ line }: { line: string }) => { delivered.push(line); });
    // The server closes its stdin once the handshake is done, so a write after
    // that meets EPIPE. (Before ready(), the connection holds its own events,
    // the server's stderr among them, so the writes say when.)
    await waitFor(() => {
      if (transport.stdioStopCause === undefined) void connection.sendManifestRequest(30_000).catch(() => {});
      return transport.stdioStopCause !== undefined;
    }, 'a write to meet EPIPE');
    await waitFor(() => connection.holdsUnreapedChild, 'the launch held', 10_000);
    assert.equal(connection.willReconnect, false);
    assert.equal(failures.length, 0, 'held until the first release');
    // The server's stderr line came before its pipe failed, and is held too.
    const heldStderr = () => (connection as unknown as { bufferedEvents: Array<{ event: string; args: unknown[] }> }).bufferedEvents
      .filter((item) => item.event === 'stderr')
      .map((item) => (item.args[0] as { line: string }).line);
    assert.ok(heldStderr().includes('closed stdin'), heldStderr().join('\n'));
    connection[release]();
    assert.equal(failures.length, 1, `${release}() delivered the permanent failure`);
    assert.equal(failures[0]!.permanent, true);
    assert.match(failures[0]!.error, /could not be reaped/);
    // The server's own traffic, its stderr among it, stays held.
    assert.deepEqual(delivered, [], 'nothing the server sent was delivered');
  });
}
