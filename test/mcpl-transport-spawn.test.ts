/**
 * Spawning a stdio MCPL server's child: one whose command can't be spawned
 * (a command that doesn't exist, say), which Node reports on a tick after
 * spawn() returns, as an 'error' with no 'exit' after it; one with no command;
 * and one that writes and exits at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StdioTransport, type TransportCloseInfo } from '../src/mcpl/transport.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';

const missing = '/nonexistent/mcpl-server-that-is-not-here';

test('spawn() rejects a command that cannot be spawned, naming the server and keeping the cause', { timeout: 10_000 }, async () => {
  await assert.rejects(StdioTransport.spawn({ id: 'missing', command: missing }), (err: Error) => {
    assert.equal(err.message, `MCPL server "missing" could not be started: spawn ${missing} ENOENT`);
    assert.equal((err.cause as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
    return true;
  });
});

test('spawn() rejects a config without a command', { timeout: 10_000 }, async () => {
  await assert.rejects(
    StdioTransport.spawn({ id: 'commandless' }),
    /^Error: MCPL server "commandless": stdio transport requires "command" \(none provided\)$/,
  );
});

test('a child that writes a line and exits at once: spawn() resolves, and its line and its close both arrive', { timeout: 10_000 }, async () => {
  const transport = await StdioTransport.spawn({ id: 'brief', command: process.execPath, args: ['-e', "console.log('hello')"] });
  const [line, info] = await Promise.all([
    new Promise<string>((resolve) => { transport.once('line', resolve); }),
    new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); }),
  ]);
  assert.equal(line, 'hello');
  assert.equal(info.code, 0);
  await transport.close();
});

test('a reconnect whose command cannot be spawned fails that attempt and schedules the next', { timeout: 10_000 }, async (t) => {
  // The retries run from scheduleReconnect's timer. After a timer callback,
  // Node runs the tick that reports a failed spawn before any promise
  // continuation, so the handshake, which listens only once it has the
  // transport, could not catch it there.
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'missing', command: missing, reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 10 },
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

  assert.deepEqual(failed.map((event) => event.attempt), [1, 2]);
  for (const event of failed) {
    assert.equal(event.error, `MCPL server "missing" could not be started: spawn ${missing} ENOENT`);
  }
  assert.ok(logged.some((line) => line.includes('reconnect failed') && line.includes('ENOENT')), logged.join('\n'));
  assert.equal(connection.isConnected, false);
});
