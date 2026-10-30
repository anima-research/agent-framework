/**
 * What a stdio server writes to stderr before its handshake fails, and the
 * last stderr line it writes without a newline (#339):
 *   - a connect whose server exits before it answers initialize, or never
 *     answers it, carries the last of the server's stderr on its error, as
 *     `stderrTail`, bounded, and never in its message;
 *   - a refusal at the server's exit takes that tail once the server's stderr
 *     has ended, waiting at most STDERR_END_WAIT_MS for a process that shares
 *     the stream;
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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { STDERR_TAIL_CHARS, StdioTransport, setStdioExitGraceForTests } from '../src/mcpl/transport.js';
import { McplServerConnection, McplUnreapedLaunchError, stderrTailOf, withStderr } from '../src/mcpl/server-connection.js';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** `promise`, or `fallback` once `ms` (15 s) have passed, so a wait can't hang
 *  the file, and a slow runner isn't mistaken for a defect. */
function within<T, F>(promise: Promise<T>, fallback: F, ms = 15_000): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A server script's last step: it exits once the host's initialize line
 *  arrives, before answering it. A server that exits at once races the host's
 *  initialize write instead: a write that meets the closed pipe fails with
 *  EPIPE, and the close's reason names that failure ("…, and this host had
 *  stopped using the server's stdio (write EPIPE)") whenever it is handled
 *  before the exit, which only scheduling decides. Exiting after the line arrives leaves the host nothing
 *  to write once the server is gone. */
const EXIT_ON_INITIALIZE = "process.stdin.once('data', () => process.exit(1))";

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
  const transport = new (StdioTransport as unknown as new (child: unknown, rl: unknown, serverId: string) => StdioTransport)(child, new EventEmitter(), 'stand-in');
  const lines: string[] = [];
  transport.on('stderr', (line: string) => lines.push(line));
  return { stderr, transport, lines };
}

test("a connect whose server exits before it answers initialize carries the last of the server's stderr as `stderrTail`, not in its message", { timeout: 30_000 }, async () => {
  const refused = await refusal('needs-token', [
    "console.error('fatal: DISCORD_TOKEN is not set')",
    "process.stderr.write('exiting with code 1')",
    EXIT_ON_INITIALIZE,
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
  assert.deepEqual(await refusal('quiet', EXIT_ON_INITIALIZE), {
    message: 'MCPL server "quiet" transport closed before handshake completed (child process exited)',
    stderrTail: undefined,
  });
});

test(`the error keeps at most the last ${STDERR_TAIL_CHARS} code units of stderr, after a '\u2026'`, { timeout: 30_000 }, async () => {
  const refused = await refusal('chatty', `process.stderr.write('a'.repeat(5000) + 'b'.repeat(${STDERR_TAIL_CHARS - 3}) + 'end'); ${EXIT_ON_INITIALIZE}`);
  assert.equal(refused.message, 'MCPL server "chatty" transport closed before handshake completed (child process exited)');
  assert.equal(refused.stderrTail, `\u2026${'b'.repeat(STDERR_TAIL_CHARS - 3)}end`);
});

test('a server that writes 256 KB to stderr just before it exits is refused with the last of it', { timeout: 30_000 }, async () => {
  // Past a pipe's buffer, so the parent reads it in many chunks while the child
  // writes; the child exits once its write has gone into the pipe and the
  // initialize line has arrived.
  const refused = await refusal('burst', `process.stderr.write('x'.repeat(256 * 1024) + 'the end', () => ${EXIT_ON_INITIALIZE})`);
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
      args: ['-e', `console.error('fatal: DISCORD_TOKEN ' + process.env.DISCORD_TOKEN + ' was refused'); ${EXIT_ON_INITIALIZE}`],
      env: { DISCORD_TOKEN: 'tok-0123456789abcdef' },
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
  // The log lines are records, so the server's credentials are redacted
  // there, and the event carries the failed connect's tail, redacted as the
  // host gets it on the error.
  const stderr = '. The last of its stderr:\n  stderr: "fatal: DISCORD_TOKEN redacted was refused"';
  const first = await within(connectFailed, null);
  assert.ok(first, 'the first connect failed and was reported within 15 s');
  assert.deepEqual(first, { error: failure, stderrTail: 'fatal: DISCORD_TOKEN redacted was refused', attempt: 0 });
  assert.ok(logged.includes(`MCPL server "needs-token" initial connect failed, will retry: ${failure}${stderr}`), logged.join('\n'));
  const event = await within(reconnectFailed, null);
  assert.ok(event, 'a reconnect attempt failed within 15 s');
  assert.equal(event.error, failure);
  assert.equal(event.stderrTail, 'fatal: DISCORD_TOKEN redacted was refused');
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
  framework.wireMcplEvents(connection, { id: 'needs-token', command: 'needs-token', env: { API_TOKEN: 'sk-0123456789abcdef' } });
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
  // The trace is a record, so the server's credential is redacted in it.
  assert.equal(trace?.stderrTail, 'fatal: token redacted was refused');
  assert.equal(traces.find((event) => event.type === 'ops:alert')?.message, `MCPL server unreachable (attempt 5): ${error}`);
  // What the operator's webhook is sent, which posts outside the process.
  assert.equal(posted.length, 1);
  assert.ok(posted[0]!.endsWith(`mcpl-down: MCPL server unreachable (attempt 5): ${error}`), posted[0]);
  assert.ok(!posted[0]!.includes('sk-0123456789abcdef'));
});

test("a failed initial connect's trace keeps the server's stderr with its credentials redacted, as a reconnect's does", () => {
  const { connection, traces } = alertingFramework();
  const error = 'MCPL server "needs-token" transport closed before handshake completed (child process exited)';
  connection.emit('connect-failed', { error, stderrTail: 'fatal: token sk-0123456789abcdef was refused', attempt: 0 });
  assert.equal(traces.find((event) => event.type === 'mcpl:server-connect-failed')?.stderrTail, 'fatal: token redacted was refused');
});

test('a reconnect failure with no stderr, such as a spawn error, is traced with no `stderrTail` and alerted by its error', () => {
  const { connection, traces } = alertingFramework();
  const error = 'MCPL server "needs-token" could not be started: spawn not-a-command ENOENT';
  connection.emit('reconnect-failed', { error, attempt: 5 });
  assert.equal('stderrTail' in (traces.find((event) => event.type === 'mcpl:server-connect-failed') ?? {}), false);
  assert.equal(traces.find((event) => event.type === 'ops:alert')?.message, `MCPL server unreachable (attempt 5): ${error}`);
});

test("at startup, a failed connect's trace and log line carry the server's stderr with its credentials redacted", { timeout: 30_000 }, async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-stderr-tail-'));
  const traces: Array<Record<string, unknown>> = [];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [{
      name: 'watcher',
      async start(ctx: { onTrace(listener: (event: unknown) => void): void }) { ctx.onTrace((event) => traces.push(event as never)); },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false }; },
      async onProcess() { return {}; },
    } as never],
    mcplServers: [{
      id: 'needs-token',
      command: process.execPath,
      args: ['-e', `console.error('fatal: DISCORD_TOKEN ' + process.env.DISCORD_TOKEN + ' was refused'); ${EXIT_ON_INITIALIZE}`],
      env: { DISCORD_TOKEN: 'tok-0123456789abcdef' },
    }],
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.equal(failed?.stderrTail, 'fatal: DISCORD_TOKEN redacted was refused');
  assert.ok(
    logged.some((line) => line.startsWith('Failed to connect MCPL server "needs-token"') && line.endsWith('stderr: "fatal: DISCORD_TOKEN redacted was refused"')),
    logged.join('\n'),
  );
  assert.ok(!logged.join('\n').includes('tok-0123456789abcdef'));
});

test("a failed connect's stderr tail is found under the errors that wrap it, the nearest first, and a cause chain that loops ends", () => {
  const handshake = Object.assign(new Error('MCPL server "w" initialize handshake timed out'), { stderrTail: 'waiting for DISCORD_TOKEN' });
  const unreaped = new McplUnreapedLaunchError({ close: async () => {} }, handshake, new Error('it could not be reaped'));
  const refused = new Error(`${unreaped.message}. MCP server "w" stays registered, closed, until its exit is confirmed`, { cause: unreaped });
  assert.equal(stderrTailOf(unreaped), 'waiting for DISCORD_TOKEN');
  assert.equal(stderrTailOf(refused), 'waiting for DISCORD_TOKEN');
  assert.match(withStderr(refused, (text) => text), /^\. The last of its stderr:\n {2}stderr: "waiting for DISCORD_TOKEN"$/);
  // Three causes down, as when a disconnect ended the connect: the
  // framework's refusal over the ended one over the unreaped launch's error.
  const ended = new Error('MCP server "w" was not connected: it was disconnected while connecting', { cause: unreaped });
  assert.equal(stderrTailOf(new Error('stays registered', { cause: ended })), 'waiting for DISCORD_TOKEN');
  // An error's own tail comes before one further down.
  assert.equal(stderrTailOf(Object.assign(new Error('outer', { cause: handshake }), { stderrTail: 'its own' })), 'its own');
  // A chain that ends with no tail anywhere has none.
  assert.equal(stderrTailOf(new Error('outer', { cause: new Error('inner') })), undefined);
  // A chain that loops, with no tail in it, ends with none. Its links count
  // the reads of their cause, so a walk with no bound fails here rather
  // than hanging the file.
  let reads = 0;
  const first = new Error('first');
  const second = new Error('second');
  for (const [error, next] of [[first, second], [second, first]] as const) {
    Object.defineProperty(error, 'cause', {
      get() {
        if (++reads > 100) throw new Error('the walk did not stop');
        return next;
      },
    });
  }
  assert.equal(stderrTailOf(first), undefined);
});

test("at startup, a failed connect whose launch can't be reaped still traces and logs the server's stderr, redacted", { timeout: 30_000 }, async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  // The cleanup's signals don't reach the child, so its exit can't be
  // confirmed, and its pipe fails once it has said why on stderr, while it
  // still runs.
  const realSpawn = StdioTransport.spawn;
  const stuck: Array<() => Promise<void>> = [];
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (c) => {
    const transport = await realSpawn.call(StdioTransport, c);
    const child = (transport as unknown as { child: ChildProcess }).child;
    const realKill = child.kill.bind(child);
    child.kill = () => true;
    setStdioExitGraceForTests(child, 50);
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    stuck.push(() => { realKill('SIGKILL'); return exited; });
    transport.once('stderr', () => setImmediate(() => transport.emit('error', new Error('read EPIPE'))));
    return transport;
  };
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-stderr-tail-'));
  const traces: Array<Record<string, unknown>> = [];
  let framework: AgentFramework | undefined;
  t.after(async () => {
    (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn;
    // Each child really ends now, so stop() confirms its exit.
    await Promise.all(stuck.map((kill) => kill()));
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [{
      name: 'watcher',
      async start(ctx: { onTrace(listener: (event: unknown) => void): void }) { ctx.onTrace((event) => traces.push(event as never)); },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false }; },
      async onProcess() { return {}; },
    } as never],
    mcplServers: [{
      id: 'needs-token',
      command: process.execPath,
      args: ['-e', "console.error('fatal: DISCORD_TOKEN ' + process.env.DISCORD_TOKEN + ' was refused'); setInterval(() => {}, 1 << 30)"],
      env: { DISCORD_TOKEN: 'tok-0123456789abcdef' },
    }],
  });
  const failed = traces.find((event) => event.type === 'mcpl:server-connect-failed');
  assert.match(String(failed?.error), /its cleanup also failed: .*could not be reaped/);
  assert.equal(failed?.stderrTail, 'fatal: DISCORD_TOKEN redacted was refused');
  assert.ok(
    logged.some((line) => line.startsWith('Failed to connect MCPL server "needs-token"') && line.endsWith('stderr: "fatal: DISCORD_TOKEN redacted was refused"')),
    logged.join('\n'),
  );
  assert.ok(!logged.join('\n').includes('tok-0123456789abcdef'));
});

test("a refusal waits for the server's stderr to end, so a line that a process sharing it writes after the exit is in its tail", { timeout: 30_000 }, async () => {
  // The server starts a process that shares its stderr. That process writes its
  // line only once the host has reaped the server, which the host does as it
  // handles the exit, so a tail taken at the exit can't hold the line. It closes
  // its stderr as soon as the line is taken, which ends the stream.
  const sharer = "const pid = ' + process.pid + '; const t = setInterval(() => { try { process.kill(pid, 0) } catch { clearInterval(t); process.stderr.write(\\'written after the exit\\', () => require(\\'fs\\').closeSync(2)) } }, 5)";
  const refused = await refusal('shares-stderr', [
    "console.error('fatal: DISCORD_TOKEN is not set')",
    `require('child_process').spawn(process.execPath, ['-e', '${sharer}'], { stdio: ['ignore', 'ignore', 'inherit'] })`,
    "process.stdin.once('data', () => process.exit(1))",
  ].join('; '));
  assert.deepEqual(refused, {
    message: 'MCPL server "shares-stderr" transport closed before handshake completed (child process exited)',
    stderrTail: 'fatal: DISCORD_TOKEN is not set\nwritten after the exit',
  });
});

test("a refusal waits for stderr to end only up to its bound, one second, so a process the server left running with it doesn't hold the refusal", { timeout: 30_000 }, async (t) => {
  // The server starts a process that inherits its stderr and outlives it, and
  // says which, so the test can end it. STDERR_END_WAIT_MS, stated here so that
  // a change to it is a change to this test.
  const boundMs = 1_000;
  // The refusal is timed from the server's exit as the host handles it. This
  // listener comes after the transport's own, which starts the wait, so it can
  // only shorten what's measured: by that gap and the clock's millisecond
  // steps, which the 50 ms allows for.
  let exitedAt = 0;
  const spawn = StdioTransport.spawn.bind(StdioTransport);
  t.mock.method(StdioTransport, 'spawn', async (config: Parameters<typeof StdioTransport.spawn>[0]) => {
    const transport = await spawn(config);
    (transport as unknown as { child: ChildProcess }).child.once('exit', () => { exitedAt = Date.now(); });
    return transport;
  });
  const refused = await refusal('holds-stderr', [
    "const held = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'ignore', 'inherit'] })",
    "console.error('holder ' + held.pid)",
    "process.stdin.once('data', () => process.exit(1))",
  ].join('; '));
  const took = Date.now() - exitedAt;
  const holder = Number(/^holder (\d+)$/.exec(refused.stderrTail ?? '')?.[1]);
  t.after(() => { try { process.kill(holder); } catch { /* already gone */ } });
  assert.equal(refused.message, 'MCPL server "holds-stderr" transport closed before handshake completed (child process exited)');
  assert.ok(holder > 0, String(refused.stderrTail));
  assert.ok(exitedAt > 0, 'the server exited');
  assert.ok(took >= boundMs - 50, `refused ${took} ms after the server's exit, before the bound`);
  assert.ok(took < boundMs + 8_000, `refused ${took} ms after the server's exit`);
});

test("a refusal holds the server's last stderr when the host handles the server's exit before reading that stderr", { timeout: 30_000 }, async (t) => {
  // Each stdio transport's stderr is paused as it is made, and resumed only once
  // the child's 'exit' listeners, the transport's own first, have run: an order
  // in which Node can deliver them.
  const spawn = StdioTransport.spawn.bind(StdioTransport);
  t.mock.method(StdioTransport, 'spawn', async (config: Parameters<typeof StdioTransport.spawn>[0]) => {
    const transport = await spawn(config);
    const child = (transport as unknown as { child: ChildProcess }).child;
    child.stderr!.pause();
    child.once('exit', () => setImmediate(() => child.stderr!.resume()));
    return transport;
  });
  const refused = await refusal('read-late', [
    "console.error('fatal: DISCORD_TOKEN is not set')",
    "process.stdin.once('data', () => process.exit(1))",
  ].join('; '));
  assert.deepEqual(refused, {
    message: 'MCPL server "read-late" transport closed before handshake completed (child process exited)',
    stderrTail: 'fatal: DISCORD_TOKEN is not set',
  });
});

test('a transport resolves stderrEnded once its stderr ends, at once after that, and after its bound if it never does', async () => {
  const { stderr, transport } = standIn();
  let ended = false;
  const waiting = transport.stderrEnded(60_000).then(() => { ended = true; });
  stderr.emit('data', Buffer.from('last words'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false, 'nothing settles it before the end');
  stderr.emit('end');
  assert.equal(await within(waiting.then(() => 'ended'), 'waited', 5_000), 'ended');
  assert.equal(transport.stderrTail, 'last words');
  assert.equal(await within(transport.stderrEnded(60_000).then(() => 'at once'), 'waited', 1_000), 'at once');

  const unended = standIn();
  assert.equal(await within(unended.transport.stderrEnded(10).then(() => 'bounded'), 'waited', 500), 'bounded');
});

test('a transport resolves stderrEnded when its stderr closes without ending, as an errored stream does', async () => {
  const { stderr, transport } = standIn();
  const waiting = transport.stderrEnded(60_000).then(() => 'closed');
  stderr.emit('close');
  assert.equal(await within(waiting, 'waited', 1_000), 'closed');
  assert.equal(await within(transport.stderrEnded(60_000).then(() => 'at once'), 'waited', 1_000), 'at once');
});
