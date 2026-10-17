/**
 * What a stdio server writes to stderr before its handshake fails, and the
 * last stderr line it writes without a newline (#339):
 *   - a connect whose server exits before it answers initialize, or never
 *     answers it, carries the last of the server's stderr on its error, as
 *     `stderrTail`, bounded, and never in its message;
 *   - a transport decodes stderr as one stream, keeps its last code units
 *     across reads, and emits a last line that has no newline once the stream
 *     ends;
 *   - the host's log line prints that stderr and the mcpl:server-connect-failed
 *     trace carries it; the mcpl-down ops alert, which posts outside the
 *     process with nothing to redact it, names a failed handshake without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { STDERR_TAIL_CHARS, StdioTransport } from '../src/mcpl/transport.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { AgentFramework } from '../src/framework.js';

/** `promise`, or `fallback` once `ms` (15 s) have passed, so a wait can't hang
 *  the file, and a slow runner isn't mistaken for a defect. */
function within<T, F>(promise: Promise<T>, fallback: F, ms = 15_000): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** How a connect to a server running `script` is refused: the error's message
 *  and its `stderrTail`. */
async function refusal(id: string, script: string, ms?: number): Promise<{ message: string; stderrTail?: string }> {
  const connect = McplServerConnection.connect({ id, command: process.execPath, args: ['-e', script] }, { version: '0.5' })
    .then(() => ({ message: 'connected' }), (error: Error & { stderrTail?: string }) => ({ message: error.message, stderrTail: error.stderrTail }));
  return within(connect, { message: 'still connecting' }, ms);
}

/** A transport on a stand-in child, whose stderr chunks the test chooses. */
function standIn(): { stderr: EventEmitter; transport: StdioTransport; lines: string[] } {
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(), stdout: new EventEmitter(), stderr, killed: false, exitCode: null, signalCode: null,
  });
  const transport = new (StdioTransport as unknown as new (child: unknown, rl: unknown) => StdioTransport)(child, new EventEmitter());
  const lines: string[] = [];
  transport.on('stderr', (line: string) => lines.push(line));
  return { stderr, transport, lines };
}

test("a connect whose server exits before it answers initialize carries the last of the server's stderr as `stderrTail`, not in its message", { timeout: 30_000 }, async () => {
  const refused = await refusal('needs-token', [
    "console.error('fatal: DISCORD_TOKEN is not set')",
    "process.stderr.write('exiting with code 1')",
    'process.exit(1)',
  ].join('; '));
  assert.deepEqual(refused, {
    message: 'MCPL server "needs-token" transport closed before handshake completed (child process exited)',
    stderrTail: 'fatal: DISCORD_TOKEN is not set\nexiting with code 1',
  });
});

test("a server whose stderr ends with a newline is refused with its last line and no newline after it", { timeout: 30_000 }, async () => {
  const refused = await refusal('needs-token', "console.error('fatal: DISCORD_TOKEN is not set'); process.exit(1)");
  assert.equal(refused.stderrTail, 'fatal: DISCORD_TOKEN is not set');
});

test("a server that writes nothing to stderr is refused as before, with no `stderrTail`", { timeout: 30_000 }, async () => {
  assert.deepEqual(await refusal('quiet', 'process.exit(1)'), {
    message: 'MCPL server "quiet" transport closed before handshake completed (child process exited)',
    stderrTail: undefined,
  });
});

test(`the error keeps at most the last ${STDERR_TAIL_CHARS} code units of stderr, after a '\u2026'`, { timeout: 30_000 }, async () => {
  const refused = await refusal('chatty', `process.stderr.write('a'.repeat(5000) + 'b'.repeat(${STDERR_TAIL_CHARS - 3}) + 'end'); process.exit(1)`);
  assert.equal(refused.message, 'MCPL server "chatty" transport closed before handshake completed (child process exited)');
  assert.equal(refused.stderrTail, `\u2026${'b'.repeat(STDERR_TAIL_CHARS - 3)}end`);
});

test('a server that writes 256 KB to stderr just before it exits is refused with the last of it', { timeout: 30_000 }, async () => {
  // Past a pipe's buffer, so the parent reads it in many chunks while the child
  // writes; the child exits once its write has been taken.
  const refused = await refusal('burst', "process.stderr.write('x'.repeat(256 * 1024) + 'the end', () => process.exit(1))");
  assert.equal(refused.message, 'MCPL server "burst" transport closed before handshake completed (child process exited)');
  assert.equal(refused.stderrTail, `\u2026${'x'.repeat(STDERR_TAIL_CHARS - 7)}the end`);
});

test("a handshake that times out carries the last of the server's stderr", { timeout: 60_000 }, async () => {
  // A server that waits for a token it never gets, and says so: refused when
  // the handshake's 30 s timeout runs out.
  const refused = await refusal('waits-for-token', "console.error('waiting for DISCORD_TOKEN'); setInterval(() => {}, 1 << 30)", 45_000);
  assert.deepEqual(refused, {
    message: 'MCPL server "waits-for-token" initialize handshake timed out',
    stderrTail: 'waiting for DISCORD_TOKEN',
  });
});

test('a stdio transport emits a last stderr line that has no newline once the stream ends', { timeout: 30_000 }, async (t) => {
  const transport = await StdioTransport.spawn({
    id: 'last-line',
    command: process.execPath,
    args: ['-e', "process.stderr.write('first line\\nlast line, no newline'); process.exit(0)"],
  });
  t.after(() => transport.close());
  const lines: string[] = [];
  const both = new Promise<void>((resolve) => {
    transport.on('stderr', (line: string) => { lines.push(line); if (lines.length === 2) resolve(); });
  });
  assert.equal(await within(both.then(() => 'both'), 'not both within 15 s'), 'both');
  assert.deepEqual(lines, ['first line', 'last line, no newline']);
  assert.equal(transport.stderrTail, 'first line\nlast line, no newline');
});

test("stderr is decoded as one stream: a character whose bytes arrive in two reads stays whole, in its line and in the tail", () => {
  const { stderr, transport, lines } = standIn();
  // 'café\n' with the two bytes of 'é' in two reads, then an emoji split 2 + 2.
  stderr.emit('data', Buffer.from([0x63, 0x61, 0x66, 0xc3]));
  stderr.emit('data', Buffer.from([0xa9, 0x0a]));
  const emoji = Buffer.from('\u{1F600}');
  stderr.emit('data', Buffer.concat([Buffer.from('ok '), emoji.subarray(0, 2)]));
  stderr.emit('data', emoji.subarray(2));
  stderr.emit('end');
  assert.deepEqual(lines, ['café', 'ok \u{1F600}']);
  assert.equal(transport.stderrTail, 'café\nok \u{1F600}');
});

test(`stderr's tail is kept across reads: exactly ${STDERR_TAIL_CHARS} code units keep no '\u2026', one more drops the first`, () => {
  const { stderr, transport } = standIn();
  stderr.emit('data', Buffer.from('a'.repeat(1000)));
  stderr.emit('data', Buffer.from('b'.repeat(1000)));
  stderr.emit('data', Buffer.from('c'.repeat(STDERR_TAIL_CHARS - 2000)));
  assert.equal(transport.stderrTail, 'a'.repeat(1000) + 'b'.repeat(1000) + 'c'.repeat(STDERR_TAIL_CHARS - 2000));
  stderr.emit('data', Buffer.from('d'));
  assert.equal(transport.stderrTail, '\u2026' + 'a'.repeat(999) + 'b'.repeat(1000) + 'c'.repeat(STDERR_TAIL_CHARS - 2000) + 'd');
});

test("stderr's tail never opens inside a surrogate pair", () => {
  const { stderr, transport } = standIn();
  // The cut falls between the emoji's two UTF-16 halves; the low half goes too.
  stderr.emit('data', Buffer.from('\u{1F600}' + 'x'.repeat(STDERR_TAIL_CHARS - 1)));
  assert.equal(transport.stderrTail, '\u2026' + 'x'.repeat(STDERR_TAIL_CHARS - 1));
});

test('a stderr stream that ends after a newline emits no empty last line', () => {
  const { stderr, lines } = standIn();
  stderr.emit('data', Buffer.from('one\ntwo\n'));
  stderr.emit('end');
  assert.deepEqual(lines, ['one', 'two']);
});

test("a connect and a reconnect that fail their handshakes report the server's stderr as `stderrTail`, and the host's log lines print it, each line through log-value", { timeout: 30_000 }, async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const connection = await McplServerConnection.connectWithReconnect(
    {
      id: 'needs-token',
      command: process.execPath,
      args: ['-e', "console.error('fatal: DISCORD_TOKEN is not set'); process.exit(1)"],
      reconnect: true,
      reconnectIntervalMs: 10,
      reconnectMaxIntervalMs: 10,
    },
    { version: '0.5' },
  );
  t.after(() => connection.close());
  type Failed = { error: string; stderrTail?: string; attempt: number };
  const connectFailed = new Promise<Failed>((resolve) => { connection.once('connect-failed', resolve); });
  const reconnectFailed = new Promise<Failed>((resolve) => { connection.once('reconnect-failed', resolve); });
  // The stub holds its lifecycle events until the host says it's ready.
  connection.ready();
  const failure = 'MCPL server "needs-token" transport closed before handshake completed (child process exited)';
  const stderr = '. The last of its stderr:\n  stderr: "fatal: DISCORD_TOKEN is not set"';
  const first = await within(connectFailed, null);
  assert.ok(first, 'the first connect failed and was reported within 15 s');
  assert.deepEqual(first, { error: failure, stderrTail: 'fatal: DISCORD_TOKEN is not set', attempt: 0 });
  assert.ok(logged.includes(`MCPL server "needs-token" initial connect failed, will retry: ${failure}${stderr}`), logged.join('\n'));
  const event = await within(reconnectFailed, null);
  assert.ok(event, 'a reconnect attempt failed within 15 s');
  assert.equal(event.error, failure);
  assert.equal(event.stderrTail, 'fatal: DISCORD_TOKEN is not set');
  assert.ok(logged.includes(`MCPL server "needs-token" reconnect failed: ${failure}${stderr}`), logged.join('\n'));
});

/** A prototype instance with only what wiring, tracing and opsAlert touch, as
 *  test/ops-alert.test.ts builds one, wired to a stand-in connection. */
function alertingFramework() {
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.opsAlertLastSent = new Map<string, number>();
  framework.opsAlertCooldownMs = 15 * 60_000;
  framework.logFailure = () => {};
  framework.traceListeners = [];
  const traces: Array<Record<string, unknown>> = [];
  framework.onTrace((event: Record<string, unknown>) => traces.push(event));
  const connection = Object.assign(new EventEmitter(), { id: 'needs-token', willReconnect: true });
  framework.wireMcplEvents(connection);
  return { connection, traces };
}

test("the mcpl-down ops alert names a failed handshake without the server's stderr, which the trace keeps as `stderrTail`", (t) => {
  const posted: string[] = [];
  const hook = process.env.CONNECTOME_OPS_WEBHOOK;
  process.env.CONNECTOME_OPS_WEBHOOK = 'http://127.0.0.1:9/ops';
  t.after(() => { if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK; else process.env.CONNECTOME_OPS_WEBHOOK = hook; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    posted.push(JSON.parse(init.body).content);
    return new Response(null, { status: 204 });
  });
  const { connection, traces } = alertingFramework();

  const error = 'MCPL server "needs-token" transport closed before handshake completed (child process exited)';
  const stderrTail = 'fatal: token sk-0123456789abcdef was refused';
  connection.emit('reconnect-failed', { error, stderrTail, attempt: 5 });

  const trace = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.equal(trace?.error, error);
  assert.equal(trace?.stderrTail, stderrTail);
  assert.equal(traces.find((event) => event.type === 'ops:alert')?.message, `MCPL server unreachable (attempt 5): ${error}`);
  // What the operator's webhook is sent, which posts outside the process.
  assert.equal(posted.length, 1);
  assert.ok(posted[0]!.endsWith(`mcpl-down: MCPL server unreachable (attempt 5): ${error}`), posted[0]);
  assert.ok(!posted[0]!.includes('sk-0123456789abcdef'));
});

test('a reconnect failure with no stderr, such as a spawn error, is traced with no `stderrTail` and alerted by its error', () => {
  const { connection, traces } = alertingFramework();
  const error = 'MCPL server "needs-token" could not be started: spawn not-a-command ENOENT';
  connection.emit('reconnect-failed', { error, attempt: 5 });
  assert.equal('stderrTail' in (traces.find((event) => event.type === 'mcpl:server-connect-failed') ?? {}), false);
  assert.equal(traces.find((event) => event.type === 'ops:alert')?.message, `MCPL server unreachable (attempt 5): ${error}`);
});
