/**
 * The modern engine's request outcomes and lifetime against what actually
 * crossed the wire (room-284 review, Theo #53300 / Petra #53269). A
 * hand-written server logs every request, and each case checks the reported
 * outcome against that log:
 * - an SDK-local rejection before dispatch is `not-sent` (0 calls on the wire);
 * - a result that fails validation is an answer that can't be used (1 call,
 *   answered), never a claimed server error;
 * - a JSON-RPC error on the wire is `error-response` with its data, and its
 *   code goes to the log line;
 * - a call that ends after an `input_required` answer, before a final one, is
 *   `no-response`: at the deadline (with nothing in flight to cancel), with
 *   the connection gone, or when this client can't go on (PR #262 review);
 *   so is one whose answer has a result type this revision doesn't define,
 *   or none;
 * - a list-change subscription refused at connect is reopened;
 * - `close()` during a reconnect handshake ends the launch it was waiting on.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, SdkError, SdkErrorCode, SdkHttpError, UnsupportedProtocolVersionError } from '@modelcontextprotocol/client';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { StdioTransport, setStdioExitGraceForTests } from '../src/mcpl/transport.js';
import { McplProtocolVersionError, McplRequestError } from '../src/mcpl/server-connection.js';
import { MAX_TIMER_MS } from '../src/mcpl/protocol-family.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { jsonLines } from './helpers/json-lines.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'modern-raw-server.mjs');
const SHORT_GRACE_MS = 50;

interface LogEntry { event: string; method?: string; id?: unknown; tool?: string; pid?: number; launch: number }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The host's log lines (console.error) from here to the test's end. Call
 *  it before connecting, so it's restored after the connection closes. */
function hostLog(): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  cleanups.push(() => { console.error = original; });
  return lines;
}

/** Whether one of `lines` matches `pattern`, for an assertion's message too. */
const loggedLine = (lines: string[], pattern: RegExp) => assert.ok(lines.some((line) => pattern.test(line)), `${pattern} in:\n${lines.join('\n')}`);

/** A live connection's transport under the observed boundary, to stand in
 *  for its sends and its reports. */
const innerOf = (connection: ModernMcpConnection) =>
  (connection as unknown as { session: { wire: { inner: { onerror: (error: Error) => void; send: (...args: unknown[]) => Promise<void> } } } }).session.wire.inner;

function scratchLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'modern-raw-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'wire.jsonl');
}

const wire = (log: string): LogEntry[] => jsonLines<LogEntry>(log);
const calls = (log: string, tool: string) => wire(log).filter((e) => e.method === 'tools/call' && e.tool === tool).length;

/**
 * How long an `until` gives its event before it fails, naming what it
 * awaited. It's sized for a hang, not for speed: no `until` here asserts how
 * fast something happens, and the tests that do measure it themselves. A
 * bound a few seconds above a designed duration (a launch's start and
 * handshake, the transport's 2 s grace after SIGTERM and again after
 * SIGKILL) can fail a correct run on a loaded machine; this one fails it
 * only if the event is held back a whole minute. As the coalescing fixture's
 * REPLY_DEADLINE_MS does, it turns a wait that never ends into a failure
 * that names it, well inside the suite's own test timeout.
 */
const WAIT_MS = 60_000;

async function until(cond: () => boolean, what: string): Promise<void> {
  // The monotonic clock: a wall-clock step must not fail a wait that's on schedule.
  const deadline = performance.now() + WAIT_MS;
  while (!cond() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), `in time: ${what}`);
}

async function connect(flags: string, log: string, extra: Partial<McplServerConfig> = {}): Promise<ModernMcpConnection> {
  const connection = await ModernMcpConnection.connect({
    id: 'raw',
    command: process.execPath,
    args: [SERVER, flags, log],
    protocol: 'modern',
    ...extra,
  });
  cleanups.push(() => connection.close());
  return connection;
}

test('an outputSchema the SDK cannot compile rejects before dispatch: not-sent, nothing on the wire', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('invalid-schema', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('op', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'not-sent');
    assert.equal(err.message, 'The request wasn\'t sent: this host couldn\'t send it to the "raw" server, so nothing ran. ' +
      'If calling it again fails, ask whoever runs this host.');
    return true;
  });
  loggedLine(logged, /^MCP server "raw" tools\/call op not sent: .*invalid outputSchema/);
  assert.equal(calls(log, 'op'), 0);
});

test('an argument JSON cannot write is refused before the wire: not-sent, nothing on the wire (#556)', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const [args, why] of [[{ n: 1n }, /serialize a BigInt/], [cyclic, /circular structure/]] as const) {
    await assert.rejects(connection.callTool('op', args), (err: unknown) => {
      assert.ok(err instanceof McplRequestError, String(err));
      assert.equal(err.outcome, 'not-sent');
      assert.equal(err.message, 'The request wasn\'t sent: this host couldn\'t send it to the "raw" server, so nothing ran. ' +
        'If calling it again fails, ask whoever runs this host.');
      return true;
    });
    loggedLine(logged, new RegExp(`^MCP server "raw" tools/call op not sent: .*${why.source}`));
  }
  assert.equal(calls(log, 'op'), 0);
});

test("a send's own failure is its call's to report, and anything else its transport reports still reaches 'error' (#556)", async () => {
  hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  const inner = innerOf(connection);
  const realSend = inner.send.bind(inner);
  // Out of band, with no send in flight: reported at once.
  inner.onerror(new Error('out of band'));
  assert.deepEqual(errors, ['out of band']);
  // As the SDK's HTTP send does: the failure reported, then thrown. The call
  // reports what its send threw; whatever else came meanwhile is reported
  // once the send has settled, and what comes later, as from a stream the
  // send opened, at once.
  const thrown = new Error('the send failed');
  inner.send = async () => {
    setTimeout(() => inner.onerror(new Error('after the send')), 20);
    inner.onerror(new Error('beside the send'));
    inner.onerror(thrown);
    throw thrown;
  };
  await assert.rejects(connection.callTool('plain', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    return true;
  });
  assert.deepEqual(errors, ['out of band', 'beside the send']);
  await until(() => errors.length === 3, 'the later report');
  assert.deepEqual(errors, ['out of band', 'beside the send', 'after the send']);
  // A send that goes out: what its transport reported meanwhile is reported
  // once it has.
  inner.send = async (...args: unknown[]) => {
    inner.onerror(new Error('beside a send that went out'));
    return realSend(...args);
  };
  assert.deepEqual((await connection.callTool('plain', {})).content, [{ type: 'text', text: 'plain' }]);
  assert.deepEqual(errors.slice(3), ['beside a send that went out']);
});

/** A live connection's observed boundary, to send through it directly. */
const observedOf = (connection: ModernMcpConnection) =>
  (connection as unknown as { session: { wire: { send: (message: unknown) => Promise<void> } } }).session.wire;

test("a request or a response that isn't a call's leaves what its send threw to its sender too, as the connect and the SDK report it themselves (#556)", async () => {
  hostLog();
  const connection = await connect('', scratchLog());
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  const inner = innerOf(connection);
  // As the SDK's HTTP send does: the failure reported, then thrown.
  inner.send = async (message: unknown) => {
    const what = (message as { method?: string }).method ?? 'the response';
    inner.onerror(new Error(`beside ${what}`));
    const failed = new Error(`${what} failed`);
    inner.onerror(failed);
    throw failed;
  };
  await assert.rejects(observedOf(connection).send({ jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: {} }), /^Error: server\/discover failed$/);
  await assert.rejects(observedOf(connection).send({ jsonrpc: '2.0', id: 7, result: {} }), /^Error: the response failed$/);
  assert.deepEqual(errors, ['beside server/discover', 'beside the response']);
});

test("a notification's send keeps what its transport reports, its own failure included, at once even during a call's send, since its sender can swallow what it throws (#556)", async () => {
  hostLog();
  const connection = await connect('', scratchLog());
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  const observed = observedOf(connection);
  const inner = innerOf(connection);
  const cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } };
  let notifications = 0;
  let whileInFlight: string[] | undefined;
  inner.send = async (message: unknown) => {
    if ((message as { id?: unknown }).id === undefined) {
      // As the SDK's HTTP send does: the failure reported, then thrown, and
      // later a report from work the send started, as from a stream.
      const n = ++notifications;
      setTimeout(() => inner.onerror(new Error(`after notification ${n}`)), 20);
      const failed = new Error(`notification ${n} failed`);
      inner.onerror(failed);
      throw failed;
    }
    // A call's send, during which a notification fails, its sender
    // swallowing what it throws, as the SDK's listen teardown does.
    await observed.send(cancel).catch(() => {});
    await until(() => errors.includes('after notification 2'), "the later report of the call's notification");
    whileInFlight = [...errors];
    throw new Error("the call's send failed");
  };
  await assert.rejects(observed.send(cancel), /^Error: notification 1 failed$/);
  await until(() => errors.includes('after notification 1'), "the notification's later report");
  assert.deepEqual(errors, ['notification 1 failed', 'after notification 1']);
  await assert.rejects(connection.callTool('plain', {}), (err: unknown) => err instanceof McplRequestError && err.outcome === 'no-response');
  const all = ['notification 1 failed', 'after notification 1', 'notification 2 failed', 'after notification 2'];
  assert.deepEqual(whileInFlight, all, "reported while the call's send was still in flight");
  assert.deepEqual(errors, all);
});

test('a call\'s arguments go out as the caller wrote them, JSON.rawJSON numbers included (#556)', { skip: typeof (JSON as unknown as { rawJSON?: unknown }).rawJSON !== 'function' && 'JSON.rawJSON needs Node 21 or later' }, async () => {
  hostLog();
  const connection = await connect('', scratchLog());
  const inner = innerOf(connection);
  const realSend = inner.send.bind(inner);
  const written: string[] = [];
  inner.send = async (...args: unknown[]) => {
    written.push(JSON.stringify(args[0]));
    return realSend(...args);
  };
  const rawJSON = (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON;
  assert.deepEqual((await connection.callTool('plain', { id: rawJSON('9007199254740993'), huge: rawJSON('1e400') })).content, [{ type: 'text', text: 'plain' }]);
  const call = written.find((line) => line.includes('"tools/call"'));
  assert.ok(call?.includes('"arguments":{"id":9007199254740993,"huge":1e400}'), String(call));
});

test("another connection's report, made during this connection's send, is that connection's, at once (#556)", async () => {
  hostLog();
  const a = await connect('', scratchLog());
  const b = await connect('', scratchLog());
  const aErrors: string[] = [];
  const bErrors: string[] = [];
  a.on('error', (error: Error) => aErrors.push(error.message));
  b.on('error', (error: Error) => bErrors.push(error.message));
  const aInner = innerOf(a);
  const bInner = innerOf(b);
  let whileInFlight: string[] | undefined;
  aInner.send = async () => {
    bInner.onerror(new Error("b's report"));
    whileInFlight = [...bErrors];
    throw new Error("a's send failed");
  };
  await assert.rejects(a.callTool('plain', {}));
  assert.deepEqual(whileInFlight, ["b's report"], "reported while a's send was still in flight");
  assert.deepEqual(bErrors, ["b's report"]);
  assert.deepEqual(aErrors, []);
});

test('each send holds only what its own transport reported during it, so overlapping sends each leave their own failure to their call (#556)', async () => {
  hostLog();
  const connection = await connect('', scratchLog());
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  const inner = innerOf(connection);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  inner.send = async () => {
    if (++sends === 1) {
      inner.onerror(new Error('beside the first'));
      await gate;
      const first = new Error('the first send failed');
      inner.onerror(first);
      throw first;
    }
    const second = new Error('the second send failed');
    inner.onerror(second);
    throw second;
  };
  const first = connection.callTool('plain', {}).then(() => 'answered', (error: unknown) => error);
  await until(() => sends === 1, 'the first send');
  // The second send starts and ends while the first is still in flight.
  await assert.rejects(connection.callTool('plain', {}), (err: unknown) => err instanceof McplRequestError && err.outcome === 'no-response');
  assert.deepEqual(errors, [], "the second's failure is its call's, and the first's report waits for the first");
  release();
  const ended = await first;
  assert.ok(ended instanceof McplRequestError && ended.outcome === 'no-response', String(ended));
  assert.deepEqual(errors, ['beside the first']);
});

test('a result that fails its outputSchema was answered: a plain error, not a server error', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('op', {}), (err: unknown) => {
    assert.ok(!(err instanceof McplRequestError), 'no request outcome is claimed');
    assert.equal((err as Error).message, 'The "raw" server answered, but not in a form this host can read, so whether the request took effect ' +
      'is unknown. Check its effect before trying again.');
    return true;
  });
  loggedLine(logged, /^MCP server "raw" answered tools\/call op with a result this host can't use: .*output schema/);
  assert.equal(calls(log, 'op'), 1);
});

test("a JSON-RPC error on the wire is error-response with its data, the server's words in the message, and its code in the log", async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('err', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'error-response');
    assert.deepEqual(err.data, { why: 'on purpose' });
    assert.equal(err.message, 'The "raw" server answered with an error: boom');
    return true;
  });
  loggedLine(logged, /^MCP server "raw" answered tools\/call err with error -32603: boom$/);
  // The plain call on the same connection is unaffected.
  assert.deepEqual((await connection.callTool('plain', {})).content, [{ type: 'text', text: 'plain' }]);
});

test('a subscription refused at connect is reopened, and change awareness returns', async () => {
  const log = scratchLog();
  const connection = await connect('listen-fail-first', log, { reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await until(() => wire(log).filter((e) => e.method === 'subscriptions/listen').length >= 2, 'a second listen');
  // Reopening refreshes once, since changes may have been missed meanwhile.
  await until(() => changes >= 1, 'the refresh after reopening');
  const before = changes;
  const touched = await connection.callTool('touch', {});
  assert.deepEqual(touched.content, [{ type: 'text', text: 'touched' }]);
  await until(() => changes > before, 'the announced change');
});

test('awareness survives a reconnect whose first listen is refused again', async () => {
  const log = scratchLog();
  const connection = await connect('listen-fail-first', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  let atReconnect: number | null = null;
  connection.on('reconnect', () => { atReconnect = changes; });
  await connection.callTool('die', {});
  await until(() => atReconnect !== null, 'reconnect');
  // Launch 2 refuses its first listen too; the newer generation reopens it.
  // A reopened subscription is answered before the connection announces the
  // refresh it makes for changes it may have missed, so that announcement
  // marks the subscription accepted.
  await until(() => changes > atReconnect!, 'the reopened subscription answered on launch 2');
  assert.ok(wire(log).filter((e) => e.method === 'subscriptions/listen' && e.launch === 2).length >= 2, 'a second listen on launch 2');
  const before = changes;
  await connection.callTool('touch', {});
  await until(() => changes > before, 'the announced change on launch 2');
});

test('a child that exits during the connect-time subscribe fails the connect, rather than being adopted as connected (R1-2)', async () => {
  const log = scratchLog();
  await assert.rejects(connect('exit-on-listen-first', log), /closed its connection while connecting/);
  assert.ok(wire(log).some((e) => e.method === 'subscriptions/listen'), 'it exited at the subscribe');
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 1, 'one launch, and no reconnect');
});

test('with reconnect, a child that exits during the connect-time subscribe is a failed connect, and the next launch serves (R1-2)', async () => {
  const log = scratchLog();
  const connection = await connect('exit-on-listen-first', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  await until(() => connection.isConnected, 'connected on the next launch');
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 2, 'launch 1 failed its connect, and launch 2 serves');
  const plain = await connection.callTool('plain', {});
  assert.ok(plain.content.length > 0);
  assert.equal(calls(log, 'plain'), 1);
  assert.equal(wire(log).find((e) => e.method === 'tools/call')!.launch, 2);
});

/**
 * The first launch from here on, as the transport its spawn yields: whether
 * its pipe has failed, and when it reports its child unreaped. With `stuck`,
 * no signal reaches the child, so it outlives SIGTERM and SIGKILL, and
 * cleanup really ends it.
 */
function firstLaunch(stuck: boolean): { readonly pid: number; pipeFailed: () => Promise<void>; unreaped: Promise<void> } {
  const realSpawn = StdioTransport.spawn;
  let first: StdioTransport | null = null;
  let markUnreaped!: () => void;
  const unreaped = new Promise<void>((resolve) => { markUnreaped = resolve; });
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (config) => {
    const transport = await realSpawn.call(StdioTransport, config);
    if (first) return transport;
    first = transport;
    transport.once('unreaped', () => markUnreaped());
    if (stuck) {
      const child = (transport as unknown as { child: ChildProcess & { pid: number } }).child;
      const realKill = child.kill.bind(child);
      child.kill = () => true; // signals never arrive: the child outlives both bounds
      setStdioExitGraceForTests(child, SHORT_GRACE_MS);
      cleanups.push(async () => {
        realKill('SIGKILL');
        await until(() => !alive(child.pid), 'the stuck child killed');
      });
    }
    return transport;
  };
  cleanups.push(() => { (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn; });
  return {
    get pid() {
      assert.ok(first, 'a launch');
      return (first as unknown as { child: { pid: number } }).child.pid;
    },
    pipeFailed: () => until(() => first?.stdioStopCause !== undefined, "the launch's pipe to fail"),
    unreaped,
  };
}

/**
 * The connect-time list-change subscribe, failed once `when` settles, as a
 * subscribe whose acknowledgement never comes fails at its timeout: the SDK
 * reports it and resolves the connect anyway. It's still written; only its
 * end moves, to the event a test is about.
 */
function failSubscribeWhen(when: Promise<unknown>): void {
  const real = Client.prototype.listen;
  Client.prototype.listen = function (this: Client, ...args: Parameters<Client['listen']>) {
    const listening = real.apply(this, args);
    listening.catch(() => { /* it ends later, at its own timeout or the client's close */ });
    return Promise.race([listening, when.then(() => { throw new Error('no acknowledgement came'); })]);
  };
  cleanups.push(() => { Client.prototype.listen = real; });
}

test("a connect whose stdio pipe failed, and whose child was found unreaped before the connect resolved, fails holding the launch, rather than reading as connected", async () => {
  const log = scratchLog();
  const launch = firstLaunch(true);
  // The subscribe went to a child that had closed its stdin, so it's never
  // acknowledged. It ends once the transport has found the child unreaped,
  // when there was no session yet to lose.
  failSubscribeWhen(launch.unreaped);
  const connection = ModernMcpConnection.create({ id: 'raw', command: process.execPath, args: [SERVER, 'deaf-at-discover', log], protocol: 'modern' });
  cleanups.push(() => connection.close());
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  const closes: unknown[] = [];
  connection.on('close', (info: unknown) => closes.push(info));
  await assert.rejects(connection.start(), /^Error: MCP server "raw": this host stopped using the server's stdio while connecting \(write EPIPE\)$/);
  assert.equal(connection.isConnected, false);
  assert.equal(connection.holdsUnreapedChild, true);
  // The hold is reported once, by the connect's own cleanup.
  const held = errors.filter((m) => /Not starting another launch while it may still be running/.test(m));
  assert.equal(held.length, 1, errors.join('\n'));
  assert.match(held[0]!, new RegExp(`^MCP server "raw": stdio child \\d+ of MCP server "raw" did not exit within ${SHORT_GRACE_MS}ms of SIGKILL; it could not be reaped\\. `));
  assert.deepEqual(closes, [], 'it never connected, so nothing closed');
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 1, 'one launch');
  // close() retries the reap: refused while the child runs, then done.
  await assert.rejects(connection.close(), /could not be reaped/);
  process.kill(launch.pid, 'SIGKILL');
  await until(() => !alive(launch.pid), 'the child to be killed');
  await connection.close();
  assert.equal(connection.holdsUnreapedChild, false);
});

test("a connect whose stdio pipe failed fails even when it resolves while its child is still running and unreported: the check reads the pipe", async () => {
  const log = scratchLog();
  const launch = firstLaunch(false);
  // The subscribe ends as soon as the pipe has failed. The child ignores
  // SIGTERM, so it runs until SIGKILL, 2 s on, and nothing has reported it.
  let runningAtEnd: boolean | undefined;
  failSubscribeWhen(launch.pipeFailed().then(() => { runningAtEnd = alive(launch.pid); }));
  const connection = ModernMcpConnection.create({ id: 'raw', command: process.execPath, args: [SERVER, 'deaf-at-discover,ignore-sigterm', log], protocol: 'modern' });
  cleanups.push(() => connection.close());
  connection.on('error', () => { /* the subscribe's failure, reported by the SDK */ });
  await assert.rejects(connection.start(), /^Error: MCP server "raw": this host stopped using the server's stdio while connecting \(write EPIPE\)$/);
  assert.equal(runningAtEnd, true, 'the child was still running when the subscribe ended');
  assert.equal(connection.isConnected, false);
  assert.equal(connection.holdsUnreapedChild, false);
  assert.equal(alive(launch.pid), false, "gone once the connect failed: the connect's close reaped it");
});

test("a connect whose stdio pipe failed reads that way when the failure has already ended the child", async () => {
  const log = scratchLog();
  // The subscribe meets EPIPE, the transport ends the child with SIGTERM,
  // and the close ends the subscribe.
  await assert.rejects(connect('deaf-at-discover', log), /^Error: MCP server "raw": this host stopped using the server's stdio while connecting \(write EPIPE\)$/);
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 1, 'one launch');
});

/**
 * The stdio line under a connection's live session, reached from inside, to
 * stand for a loss read from a failed pipe while the child still runs: the
 * transport closes before the child has exited (R1-1).
 */
function liveLine(connection: ModernMcpConnection): { markClosed: (info: { reason: string }) => void; child: ChildProcess & { pid: number } } {
  const session = (connection as unknown as { session: { wire: { inner: { line: unknown } } } | null }).session;
  assert.ok(session, 'a live session');
  return session.wire.inner.line as never;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a transport lost while its child still runs is reaped before the reconnect, so no second child runs beside the first (R1-1)', async () => {
  const log = scratchLog();
  const connection = await connect('', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  const first = wire(log).find((e) => e.event === 'start')!.pid!;
  liveLine(connection).markClosed({ reason: 'stdio pipe failed' });
  await until(() => wire(log).filter((e) => e.event === 'start').length === 2, 'the next launch');
  assert.equal(alive(first), false, 'the first child was gone when the second started');
  await until(() => connection.isConnected, 'connected on the next launch');
});

test('close() during a lost transport\'s reap waits for its child to exit (R1-1)', async () => {
  const log = scratchLog();
  const connection = await connect('ignore-sigterm', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  const first = wire(log).find((e) => e.event === 'start')!.pid!;
  liveLine(connection).markClosed({ reason: 'stdio pipe failed' });
  await connection.close();
  assert.equal(alive(first), false, 'dead when close() resolved');
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 1, 'no launch after close');
});

test('a lost transport whose child can\'t be reaped halts reconnecting (R1-1)', async () => {
  const log = scratchLog();
  const connection = await connect('', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  const errors: string[] = [];
  connection.on('error', (error: Error) => errors.push(error.message));
  const failures: Array<{ error: string; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (failure: { error: string; permanent?: boolean }) => failures.push(failure));
  const line = liveLine(connection);
  const realKill = line.child.kill.bind(line.child);
  line.child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(line.child, SHORT_GRACE_MS);
  // Before the connection's close(), which then reaps an exited child.
  cleanups.push(async () => {
    realKill('SIGKILL');
    await until(() => !alive(line.child.pid), 'the held child killed');
  });
  line.markClosed({ reason: 'stdio pipe failed' });
  await until(() => errors.some((m) => /Not starting another launch while it may still be running/.test(m)), 'the launch held as unreaped');
  assert.equal(connection.willReconnect, false);
  // No later attempt will come, so the halt is a permanent failure, which the
  // framework raises as an alert.
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.permanent, true);
  assert.match(failures[0]!.error, /reconnecting is halted/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 1, 'no second launch');
});

test("without reconnect, a lost transport whose child can't be reaped is a permanent failure that says nothing of reconnecting (R1-1)", async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  connection.on('error', () => { /* the held launch, reported */ });
  const failures: Array<{ error: string; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (failure: { error: string; permanent?: boolean }) => failures.push(failure));
  const line = liveLine(connection);
  const realKill = line.child.kill.bind(line.child);
  line.child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(line.child, SHORT_GRACE_MS);
  cleanups.push(async () => {
    realKill('SIGKILL');
    await until(() => !alive(line.child.pid), 'the held child killed');
  });
  line.markClosed({ reason: 'stdio pipe failed' });
  await until(() => failures.length > 0, 'the permanent failure');
  assert.equal(failures[0]!.permanent, true);
  assert.match(failures[0]!.error, /the previous launch could not be reaped/);
  assert.doesNotMatch(failures[0]!.error, /reconnecting/);
});

test("a close() during a lost transport's failing reap reports the failure itself, with no reconnect failure beside it (R1-1)", async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  const failures: unknown[] = [];
  connection.on('reconnect-failed', (failure: unknown) => failures.push(failure));
  connection.on('error', () => { /* the held launch, reported */ });
  const line = liveLine(connection);
  const realKill = line.child.kill.bind(line.child);
  line.child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(line.child, SHORT_GRACE_MS);
  cleanups.push(async () => {
    realKill('SIGKILL');
    await until(() => !alive(line.child.pid), 'the held child killed');
  });
  line.markClosed({ reason: 'stdio pipe failed' });
  // The host closes it while the lost child's reap runs: the close's
  // rejection is the report, so no permanent failure goes out beside it.
  await assert.rejects(connection.close());
  assert.deepEqual(failures, []);
});

test("a 'close' listener that throws doesn't skip a lost transport's reap (R1-1)", async () => {
  const log = scratchLog();
  const connection = await connect('ignore-sigterm', log);
  const first = wire(log).find((e) => e.event === 'start')!.pid!;
  cleanups.push(() => { try { process.kill(first, 'SIGKILL'); } catch { /* reaped already */ } });
  connection.on('close', () => { throw new Error('a listener failed'); });
  try {
    liveLine(connection).markClosed({ reason: 'stdio pipe failed' });
  } catch { /* the listener's own error, wherever it surfaces */ }
  // The child ignores SIGTERM, so its reap ends with SIGKILL after 2 s.
  await until(() => !alive(first), "the lost child's reap");
});

test('close() marks a connection closed at once, so a start() in the same turn launches nothing', async () => {
  const log = scratchLog();
  const connection = ModernMcpConnection.create({ id: 'raw', command: process.execPath, args: [SERVER, '', log], protocol: 'modern' });
  const closing = connection.close();
  assert.equal(connection.isClosed, true, 'closed from the call on');
  await connection.start();
  await closing;
  assert.equal(connection.isConnected, false);
  assert.equal((connection as unknown as { generation: number }).generation, 0, 'no launch began');
});

/** The pid of each child StdioTransport.spawn starts from here on, from the spawn itself. */
function spawnedPids(): number[] {
  const realSpawn = StdioTransport.spawn;
  const pids: number[] = [];
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (config) => {
    const transport = await realSpawn.call(StdioTransport, config);
    pids.push((transport as unknown as { child: { pid: number } }).child.pid);
    return transport;
  };
  cleanups.push(() => { (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn; });
  return pids;
}

test("a read error on a stdio child's stderr is reported through the transport's 'error', and one on stdout ends the child; neither is thrown with nothing listening", async () => {
  const transport = await StdioTransport.spawn({ id: 'pipes', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'] });
  cleanups.push(() => transport.close());
  const child = (transport as unknown as { child: import('node:child_process').ChildProcess }).child;
  const closed = new Promise<{ reason?: string }>((resolve) => { transport.once('close', resolve); });
  assert.doesNotThrow(() => child.stderr!.emit('error', new Error('stderr read failed')), 'stderr, nothing listening');
  const errors: string[] = [];
  transport.on('error', (error: Error) => errors.push(error.message));
  child.stderr!.emit('error', new Error('stderr read failed'));
  assert.deepEqual(errors, ['stderr read failed']);
  // stdout carries the protocol: the child is ended, and its close names
  // the error instead of an 'error'.
  assert.doesNotThrow(() => child.stdout!.emit('error', new Error('stdout read failed')), 'stdout');
  const info = await closed;
  assert.match(info.reason ?? '', /this host had stopped using the server's stdio \(stdout read failed\)/);
  assert.deepEqual(errors, ['stderr read failed']);
});

test('close() right after start() ends a modern stdio connect still spawning, without waiting out its discover probe', async () => {
  const log = scratchLog();
  const pids = spawnedPids();
  const connection = ModernMcpConnection.create({ id: 'raw', command: process.execPath, args: [SERVER, 'hang-discover', log], protocol: 'modern' });
  const began = performance.now();
  const started = connection.start().then(() => null, (error: unknown) => error);
  await connection.close();
  const tookMs = performance.now() - began;
  assert.ok(tookMs < 15_000, `close() took ${tookMs} ms, not the discover probe's 30 s`);
  // The child may be ended before it can log its start, so its pid comes
  // from the spawn.
  assert.equal(pids.length, 1, 'one launch');
  assert.equal(alive(pids[0]!), false, 'the child is gone once close() resolved');
  await started;
  const endedMs = performance.now() - began;
  assert.ok(endedMs < 15_000, `the connect ended after ${endedMs} ms, not the discover probe's 30 s`);
  assert.equal(connection.isConnected, false);
});

test('close() during a reconnect handshake ends the launch it was waiting on, and stops', async () => {
  const log = scratchLog();
  const connection = await connect('hang-discover-later', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  await connection.callTool('die', {});
  await until(() => wire(log).some((e) => e.launch === 2 && e.method === 'server/discover'), 'launch 2 waiting on discover');
  const second = wire(log).find((e) => e.launch === 2 && e.event === 'start')!;
  const began = performance.now();
  await connection.close();
  const tookMs = performance.now() - began;
  assert.ok(tookMs < 15_000, `close() took ${tookMs} ms, not the connect's 30 s`);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(second.pid!), false, 'the hanging launch is gone once close() resolved');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 2, 'no launch after close');
  assert.equal(connection.isConnected, false);
});

test('an input_required continuation keeps its evidence: the second leg decides the outcome', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('cont', { leg2: 'error' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'error-response');
    assert.match(err.message, /^The "raw" server answered with an error: /);
    assert.deepEqual(err.data, { leg: 2, state: 'state-for-error' });
    return true;
  });
  loggedLine(logged, /^MCP server "raw" answered tools\/call cont with error -32603: /);
  // Only the call meant to time out gets a short deadline, on a connection
  // of its own: the call above, which must be answered, keeps the default.
  // The deadline covers the whole call, leg 1's answer included, so it gives
  // leg 1 the 1.5 s the deadline test below does.
  const hangLog = scratchLog();
  const hanging = await connect('', hangLog, { requestTimeoutMs: 1500 });
  await hanging.listTools();
  await assert.rejects(hanging.callTool('cont', { leg2: 'hang' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.equal(err.message, 'The "raw" server didn\'t answer within 1.5 seconds, so whether the request took effect is unknown: ' +
      'this host asked it to cancel, and it may still complete on the server. ' +
      'Check its effect before trying again, since repeating something that changes state may do it twice.');
    return true;
  });
  loggedLine(logged, /^MCP server "raw" didn't answer tools\/call cont within 1500ms; cancellation requested$/);
  assert.equal(calls(log, 'cont'), 2, 'two legs');
  // The server logs a leg as it reads it, and the deadline doesn't wait
  // for that, so the hang leg is awaited.
  await until(() => calls(hangLog, 'cont') === 2, 'the second leg on the wire');
});

test('a deadline between continuation rounds is no-response, and claims no cancellation', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log, { requestTimeoutMs: 1500 });
  await connection.listTools();
  // Hold the round between leg 1's answer and leg 2 explicitly, so the
  // deadline passes with nothing in flight by construction. Leg 1 asks for
  // elicitation input, and an input handler registered on the session's
  // client holds until the deadline aborts it, ending as the SDK's own pause
  // does. Don't replace this with a deadline timed against the SDK's internal
  // pause before a state-only round: that races leg 1 under load.
  let held = false;
  const client = (connection as unknown as { session: { client: { _requestHandlers: Map<string, unknown> } } }).session.client;
  client._requestHandlers.set('elicitation/create', (_request: unknown, ctx: { mcpReq: { signal: AbortSignal } }) => {
    held = true;
    const signal = ctx.mcpReq.signal;
    return new Promise((_, reject) => {
      const stop = () => reject(signal.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal.reason)));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
  });
  await assert.rejects(connection.callTool('cont', { leg1: 'elicit' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.equal(err.message, 'The "raw" server didn\'t finish the request: it asked for more from this host, and the time ran out ' +
      'before this host sent it, so whether the request took effect is unknown. Check its effect before trying again.');
    assert.doesNotMatch(err.message, /cancel|answered/);
    return true;
  });
  loggedLine(logged, /^MCP server "raw" did not finish tools\/call cont within 1500ms: it asked for another round \(input_required\), and the deadline passed before that round was sent$/);
  assert.ok(held, 'the round was held');
  // The wire is ordered: once a later call has reached the server, any
  // second leg sent before it would have too.
  await connection.callTool('plain', {});
  assert.equal(calls(log, 'plain'), 1);
  assert.equal(calls(log, 'cont'), 1, 'only leg 1 reached the wire');
  assert.equal(wire(log).filter((e) => e.method === 'notifications/cancelled').length, 0, 'nothing was cancelled');
});

test('a connection lost between continuation rounds is no-response, not an answer', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  // The server stops reading before it answers leg 1, and exits once that
  // answer is written, so leg 2 can't reach it. What this host meets first
  // decides what it can say, and each account is the true one for what it
  // saw:
  // - leg 1's answer, then the exit before the SDK's pacing (250 ms) lets
  //   leg 2 go: the call ended before this host sent leg 2;
  // - the exit before it reads leg 1's answer (the transport closes on the
  //   child's exit), or its own write of leg 2 into the closed pipe, if
  //   this process is held up for the pacing between reading the answer
  //   and the exit: to it, the connection closed before the server
  //   answered.
  const accounts = [
    {
      message: 'The "raw" server didn\'t finish the request: it asked for more from this host, and the call ended ' +
        'before this host sent it, so whether the request took effect is unknown. Check its effect before trying again.',
      line: /^MCP server "raw" did not finish tools\/call cont: it asked for another round \(input_required\), and the call ended before that round was sent: "Not connected\."$/,
    },
    {
      message: 'The connection to the "raw" server closed before it answered, so whether the request took effect is unknown. ' +
        'This host won\'t reconnect to it on its own. If you need it, ask whoever runs this host.',
      line: /^MCP server "raw" tools\/call cont failed: "Connection closed"$/,
    },
  ];
  const failure = await connection.callTool('cont', { leg1: 'exit', leg2: 'ok' }).then(() => null, (err: unknown) => err);
  assert.ok(failure instanceof McplRequestError, String(failure));
  assert.equal(failure.outcome, 'no-response');
  const account = accounts.find((a) => a.message === failure.message);
  assert.ok(account, `one of the two accounts, not: ${failure.message}`);
  // The line carries the SDK's reason, which records how the call ended, so
  // it pins the account to the order: a host that gave the generic close
  // after reading leg 1's answer would log that with "Not connected", the
  // reason, and fail here.
  loggedLine(logged, account.line);
  assert.equal(calls(log, 'cont'), 1, 'only leg 1 reached the server');
});

test('a continuation this client cannot go on with is no-response: the server may have acted', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  // Input this client can't supply: it advertises no elicitation.
  await assert.rejects(connection.callTool('cont', { leg1: 'elicit' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /^The "raw" server didn't finish the request: it asked for more from this host, and the call ended before this host sent it/);
    return true;
  });
  loggedLine(logged, /it asked for another round \(input_required\), and the call ended before that round was sent: "Cannot fulfil input request 'confirm'/);
  assert.equal(calls(log, 'cont'), 1);
  // A server that sheds load on every round meets the rounds cap: the first
  // leg and ten retries.
  await assert.rejects(connection.callTool('cont', { leg2: 'again' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /and the call ended before this host sent it, so whether the request took effect is unknown/);
    return true;
  });
  loggedLine(logged, /the call ended before that round was sent: "Multi-round-trip request 'tools\/call' still required input after 10 rounds/);
  assert.equal(calls(log, 'cont'), 1 + 11);
});

test('a result type this revision does not define, or none, is not a final answer: no-response', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('task', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.equal(err.message, 'The "raw" server\'s answer wasn\'t a complete result, so whether the request took effect is unknown. ' +
      'Check its effect before trying again.');
    return true;
  });
  loggedLine(logged, /^MCP server "raw" did not finish tools\/call task: its answer was not a complete result: "Unsupported result type 'task'/);
  await assert.rejects(connection.callTool('bare', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /^The "raw" server's answer wasn't a complete result, so whether the request took effect is unknown/);
    return true;
  });
  loggedLine(logged, /^MCP server "raw" did not finish tools\/call bare: its answer was not a complete result: .*missing required resultType/);
  assert.equal(calls(log, 'task'), 1);
  assert.equal(calls(log, 'bare'), 1);
});

test('concurrent continuations never cross their evidence', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  const [failing, passing, failingToo] = await Promise.allSettled([
    connection.callTool('cont', { leg2: 'error' }),
    connection.callTool('cont', { leg2: 'ok' }),
    connection.callTool('cont', { leg2: 'error' }),
  ]);
  for (const settled of [failing, failingToo]) {
    assert.equal(settled.status, 'rejected');
    const err = (settled as PromiseRejectedResult).reason;
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'error-response');
    assert.deepEqual(err.data, { leg: 2, state: 'state-for-error' });
  }
  assert.equal(passing.status, 'fulfilled');
  assert.deepEqual((passing as PromiseFulfilledResult<{ content: unknown }>).value.content, [{ type: 'text', text: 'leg 2 done (state-for-ok)' }]);
});

test('a JSON line that is not a JSON-RPC message is a diagnostic, never a crash', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  const diagnostics: string[] = [];
  connection.on('error', (e: Error) => diagnostics.push(e.message));
  await connection.listTools();
  assert.deepEqual((await connection.callTool('nullframe', {})).content, [{ type: 'text', text: 'after the noise' }]);
  await until(() => diagnostics.length >= 4, 'four diagnostics');
  assert.ok(diagnostics.every((d) => /sent a malformed JSON-RPC message/.test(d)), diagnostics.join(' | '));
  assert.equal(connection.isConnected, true);
  assert.deepEqual((await connection.callTool('plain', {})).content, [{ type: 'text', text: 'plain' }]);
});

test('a line that is not JSON is dropped and logged by its length, never its content', async (t) => {
  const log = scratchLog();
  const connection = await connect('', log);
  connection.on('error', () => {});
  await connection.listTools();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  assert.deepEqual((await connection.callTool('nullframe', {})).content, [{ type: 'text', text: 'after the noise' }]);
  t.mock.restoreAll();
  assert.deepEqual(logged, ['MCP server "raw" sent a line of length 21 that isn\'t JSON, so it was dropped']);
});

test('a modern stdio connection logs the first three lines that are not JSON, then one line says more go unlogged', async (t) => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  assert.deepEqual((await connection.callTool('noise', {})).content, [{ type: 'text', text: 'after the logs' }]);
  t.mock.restoreAll();
  assert.deepEqual(logged, [
    'MCP server "raw" sent a line of length 5 that isn\'t JSON, so it was dropped',
    'MCP server "raw" sent a line of length 5 that isn\'t JSON, so it was dropped',
    'MCP server "raw" sent a line of length 5 that isn\'t JSON, so it was dropped',
    'MCP server "raw" sent another line that isn\'t a JSON object, so it was dropped; more such lines on this connection are dropped without a log line',
  ]);
});

test('a result holding U+2028 and U+2029 inside a string arrives whole', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  assert.deepEqual((await connection.callTool('separators', {})).content, [{ type: 'text', text: 'one\u2028two\u2029three' }]);
});

test('close() reaps: a child that ignores SIGTERM is killed before close resolves', async () => {
  const log = scratchLog();
  const connection = await connect('ignore-sigterm', log);
  const pid = wire(log).find((e) => e.event === 'start')!.pid!;
  await connection.close();
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  assert.equal(alive(pid), false, 'dead when close() resolved');
  assert.ok(wire(log).some((e) => e.event === 'sigterm-ignored'), 'it really did ignore SIGTERM');
});

test('a child that cannot be reaped fails close() explicitly, never a claimed exit', async () => {
  const transport = await StdioTransport.spawn({ id: 'stuck', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'] });
  const child = (transport as unknown as { child: ChildProcess & { pid: number } }).child;
  const realKill = child.kill.bind(child);
  child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(child, SHORT_GRACE_MS);
  cleanups.push(() => { realKill('SIGKILL'); });
  await assert.rejects(transport.close(), new RegExp(`^Error: stdio child \\d+ of MCP server "stuck" did not exit within ${SHORT_GRACE_MS}ms of SIGKILL; it could not be reaped$`));
  // Calls share the one attempt and its verdict.
  await assert.rejects(transport.close(), /could not be reaped/);
});

test('a failed launch that cannot be reaped halts reconnecting; close() settles it', async () => {
  const log = scratchLog();
  const realSpawn = StdioTransport.spawn;
  const stuck: Array<{ pid: number; kill: ChildProcess['kill'] }> = [];
  let launches = 0;
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (config) => {
    const transport = await realSpawn.call(StdioTransport, config);
    if (++launches > 1) {
      // From the second launch on, signals never arrive.
      const child = (transport as unknown as { child: ChildProcess & { pid: number } }).child;
      const realKill = child.kill.bind(child);
      child.kill = () => true;
      setStdioExitGraceForTests(child, SHORT_GRACE_MS);
      stuck.push({ pid: child.pid, kill: realKill });
    }
    return transport;
  };
  cleanups.push(() => {
    (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn;
    for (const s of stuck) s.kill('SIGKILL');
  });
  const connection = await connect('reject-discover-later', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  const failures: Array<{ error: string; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (f) => failures.push(f));
  connection.on('error', () => {});
  await connection.callTool('die', {});
  await until(() => failures.some((f) => f.permanent), 'a permanent reconnect failure');
  const halted = failures.find((f) => f.permanent)!;
  assert.match(halted.error, /the previous launch could not be reaped .*reconnecting is halted/);
  assert.equal(connection.willReconnect, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 2, 'no third launch while the second is unreaped');
  // The stuck child goes away; close() re-checks it and settles cleanly.
  stuck[0]!.kill('SIGKILL');
  await until(() => { try { process.kill(stuck[0]!.pid, 0); return false; } catch { return true; } }, 'the stuck child gone');
  await connection.close();
});

test('concurrent close() calls share one teardown and its verdict; a later close re-checks', async () => {
  const log = scratchLog();
  const realSpawn = StdioTransport.spawn;
  let stuck: { pid: number; kill: (signal?: string) => boolean } | null = null;
  // Every signal teardown sends: one teardown escalates once, SIGTERM then SIGKILL.
  const signals: Array<string | undefined> = [];
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = async (config) => {
    const transport = await realSpawn.call(StdioTransport, config);
    const child = (transport as unknown as { child: { pid: number; kill: (signal?: string) => boolean } }).child;
    const realKill = child.kill.bind(child);
    child.kill = (signal?: string) => { signals.push(signal); return true; }; // teardown can't reap it
    stuck = { pid: child.pid, kill: realKill };
    return transport;
  };
  cleanups.push(() => {
    (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = realSpawn;
    stuck?.kill('SIGKILL');
  });
  const connection = await connect('', log);
  const settled: string[] = [];
  const first = connection.close().then(() => settled.push('first:ok'), () => settled.push('first:failed'));
  const second = connection.close().then(() => settled.push('second:ok'), () => settled.push('second:failed'));
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(settled, [], 'neither resolves while teardown is pending');
  await Promise.all([first, second]);
  assert.deepEqual(settled, ['first:failed', 'second:failed'], 'one verdict, in order');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'one teardown, shared: the second close sent no signals of its own');
  // Once the child is gone, a later close re-checks and settles.
  stuck!.kill('SIGKILL');
  await until(() => { try { process.kill(stuck!.pid, 0); return false; } catch { return true; } }, 'the child gone');
  await connection.close();
});

test('start() runs once: a second call shares the first connect, and no second session opens beside it', async () => {
  const log = scratchLog();
  const connection = ModernMcpConnection.create({ id: 'raw', command: process.execPath, args: [SERVER, '', log], protocol: 'modern' });
  cleanups.push(() => connection.close());
  const first = connection.start();
  assert.equal(connection.start(), first, 'the same promise while connecting');
  await first;
  assert.equal(connection.start(), first, 'and once connected');
  await connection.start();
  assert.equal(connection.isConnected, true);
  const launches = wire(log).filter((e) => e.event === 'start');
  assert.equal(launches.length, 1, 'one launch');
  await connection.close();
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  assert.equal(alive(launches[0]!.pid!), false, 'close() reaped the only child');
});

test('a send the stdio line refused before writing anything is not-sent', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  // The line is closed, while the session still stands: the transport
  // refuses the write, so nothing reached the server.
  const line = (connection as unknown as { session: { wire: { inner: { line: { _closed: boolean } } } } }).session.wire.inner.line;
  line._closed = true;
  try {
    await assert.rejects(connection.callTool('plain', {}), (err: unknown) => {
      assert.ok(err instanceof McplRequestError, String(err));
      assert.equal(err.outcome, 'not-sent');
      assert.equal(err.message, 'The request wasn\'t sent: this host couldn\'t send it to the "raw" server, so nothing ran. ' +
        'If calling it again fails, ask whoever runs this host.');
      return true;
    });
    loggedLine(logged, /^MCP server "raw" tools\/call plain not sent: .*stdio transport is closed/);
  } finally {
    line._closed = false;
  }
  assert.equal(calls(log, 'plain'), 0);
});

test('a plain call whose child dies before answering is no-response', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  connection.on('error', () => {});
  await connection.listTools();
  await assert.rejects(connection.callTool('vanish', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    // The connection closed under it: the legacy engine's words, and this
    // connection doesn't reconnect.
    assert.equal(err.message, 'The connection to the "raw" server closed before it answered, so whether the request took effect is unknown. ' +
      "This host won't reconnect to it on its own. If you need it, ask whoever runs this host.");
    return true;
  });
  loggedLine(logged, /^MCP server "raw" tools\/call vanish failed: /);
  assert.equal(calls(log, 'vanish'), 1, 'the call reached the server');
});

test("a request this host's close cuts off reads as the legacy engine's: the server didn't answer before this host closed its connection", async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  // The second leg is never answered, so only the close ends the call.
  const pending = connection.callTool('cont', { leg2: 'hang' });
  const failure = pending.then(() => null, (error: unknown) => error);
  await until(() => calls(log, 'cont') === 2, 'the second leg on the wire');
  await connection.close();
  const err = await failure;
  assert.ok(err instanceof McplRequestError, String(err));
  assert.equal(err.outcome, 'no-response');
  assert.equal(err.message, 'The "raw" server didn\'t answer before this host closed its connection, so whether the request took effect is unknown. ' +
    'Check its effect before trying again.');
  loggedLine(logged, /^MCP server "raw" tools\/call cont failed: /);
});

for (const reconnect of [true, false]) {
test(`a call with no session to send it on is not-sent: after a loss, whether this host is reconnecting${reconnect ? '' : ' (it is not)'}; after this host's close, only that`, async () => {
  const log = scratchLog();
  // A reconnect a minute away, so the connection stays lost while it's asked.
  const connection = await connect('', log, reconnect ? { reconnect: true, reconnectIntervalMs: 60_000, reconnectMaxIntervalMs: 60_000 } : {});
  connection.on('error', () => { /* the loss */ });
  await connection.listTools();
  await assert.rejects(connection.callTool('vanish', {}), {
    message: 'The connection to the "raw" server closed before it answered, so whether the request took effect is unknown. ' +
      (reconnect ? 'Check its effect before trying again; this host is reconnecting to it.' : "This host won't reconnect to it on its own. If you need it, ask whoever runs this host."),
  });
  await until(() => !connection.isConnected, 'the connection lost');
  const refused = async (message: string) => assert.rejects(connection.callTool('plain', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'not-sent');
    assert.equal(err.message, message);
    return true;
  });
  await refused('The request wasn\'t sent: the connection to the "raw" server is closed, so nothing ran. ' +
    (reconnect ? 'This host is reconnecting to it; try again later.' : "This host won't reconnect to it on its own. If you need it, ask whoever runs this host."));
  await connection.close();
  await refused('The request wasn\'t sent: this host closed its connection to the "raw" server, so nothing ran. ' +
    'If calling it again fails, ask whoever runs this host.');
  assert.equal(calls(log, 'plain'), 0, 'nothing reached a server');
});
}

test('failures are classified in order: nothing sent first, then the answers, then an HTTP refusal', () => {
  const logged = hostLog();
  const token = 'tok-0123456789abcdef';
  const connection = ModernMcpConnection.create({ id: 'raw', command: process.execPath, args: [SERVER, '', scratchLog()], protocol: 'modern', env: { API_TOKEN: token } });
  const classify = (record: Record<string, unknown>, error: unknown, method = 'tools/call', lost = false) =>
    (connection as unknown as {
      requestFailure: (what: string, record: unknown, error: unknown, timeoutMs?: number, lost?: boolean) => Error;
    }).requestFailure(method === 'tools/list' ? 'tools/list' : 'tools/call op', { method, handedOff: true, answer: 'none', continued: false, ...record }, error, 1000, lost);
  const refused = () => new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'Unauthorized', { status: 401 } as never);
  const outcome = (error: Error) => (error instanceof McplRequestError ? error.outcome : 'plain');

  const unsent = classify({ handedOff: false }, refused());
  assert.equal(outcome(unsent), 'not-sent', 'a refusal before anything was handed off');

  const first = classify({}, refused());
  assert.equal(outcome(first), 'error-response');
  assert.equal(((first as McplRequestError).data as { httpStatus?: number }).httpStatus, 401);
  assert.equal(first.message, 'The "raw" server refused this host access, so the request didn\'t run. If you need it, ask whoever runs this host.');
  loggedLine(logged, /^MCP server "raw" refused tools\/call op: HTTP 401 \(/);

  const later = classify({ continued: true }, refused());
  assert.equal(outcome(later), 'no-response', 'after an earlier leg asked for another round');
  assert.equal(later.message, 'The "raw" server refused this host access partway through the request, after asking for more, so whether it ' +
    'took effect is unknown. Check its effect before trying again; if calling it again fails, ask whoever runs this host.');
  loggedLine(logged, /^MCP server "raw" refused a later round of tools\/call op: HTTP 401 \(/);
  assert.equal(classify({ continued: true }, refused(), 'tools/list').message, 'The "raw" server refused this host access partway through ' +
    'the request, after asking for more. Listing changes nothing on the server, so it\'s safe to try again.');

  const silent = classify({ answer: 'error', error: { code: -32603, message: '  ' } }, new Error('the SDK\'s words'));
  assert.equal(outcome(silent), 'error-response');
  assert.equal(silent.message, 'The "raw" server answered with an error without saying what went wrong, so whether the request took effect ' +
    'is unknown. Check its effect before trying again.');
  loggedLine(logged, /^MCP server "raw" answered tools\/call op with error -32603: "\\u0020\\u0020"$/);

  // The server's words reach the caller and the log redacted, whatever
  // JSON value they are.
  const echoed = classify({ answer: 'error', error: { code: -32603, message: `bad token ${token}` } }, new Error('the SDK\'s words'));
  assert.equal(echoed.message, 'The "raw" server answered with an error: bad token redacted');
  loggedLine(logged, /^MCP server "raw" answered tools\/call op with error -32603: "bad\\u0020token\\u0020redacted"$/);
  classify({ answer: 'error', error: { code: -32603, message: { said: `bad token ${token}` } } }, new Error('the SDK\'s words'));
  assert.ok(logged.some((line) => line.endsWith('with error -32603: "{\\"said\\":\\"bad\\u0020token\\u0020redacted\\"}"')), logged.join('\n'));
  assert.ok(!logged.some((line) => line.includes(token)), 'no log line has the token');

  const unusableListing = classify({ answer: 'complete' }, new Error('the list failed its schema'), 'tools/list');
  assert.equal(outcome(unusableListing), 'plain');
  assert.equal(unusableListing.message, 'The "raw" server answered, but not in a form this host can read. ' +
    'Listing changes nothing on the server, so it\'s safe to try again.');

  const droppedListing = classify({}, new Error('socket hang up'), 'tools/list');
  assert.equal(outcome(droppedListing), 'no-response');
  assert.equal(droppedListing.message, 'The request to the "raw" server failed before an answer came back. ' +
    'Listing changes nothing on the server, so it\'s safe to try again.');
  loggedLine(logged, /^MCP server "raw" tools\/list failed: "socket hang up"$/);

  const listing = classify({}, new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out'), 'tools/list');
  assert.equal(outcome(listing), 'no-response');
  assert.equal(listing.message, 'The "raw" server didn\'t answer within 1 second, and this host asked it to cancel. ' +
    'Listing changes nothing on the server, so it\'s safe to try again.');
  assert.doesNotMatch(listing.message, /took effect|Check its effect/);
  loggedLine(logged, /^MCP server "raw" didn't answer tools\/list within 1000ms; cancellation requested$/);

  // A listing whose connection closed under it, and one this host's close
  // cut off: the effect clause is the listing's.
  const lostListing = classify({}, new Error('Connection closed'), 'tools/list', true);
  assert.equal(outcome(lostListing), 'no-response');
  assert.equal(lostListing.message, 'The connection to the "raw" server closed before it answered. ' +
    'Listing changes nothing on the server, so it\'s safe to try again.');
  (connection as unknown as { closedByHost: boolean }).closedByHost = true;
  const closedListing = classify({}, new Error('Connection closed'), 'tools/list', true);
  assert.equal(outcome(closedListing), 'no-response');
  assert.equal(closedListing.message, 'The "raw" server didn\'t answer before this host closed its connection. ' +
    'Listing changes nothing on the server, so it\'s safe to try again.');
});

test('a reconnect backoff never exceeds the timer limit', () => {
  const connection = ModernMcpConnection.create({
    id: 'raw', command: process.execPath, args: [SERVER, '', scratchLog()], protocol: 'modern',
    reconnect: true, reconnectIntervalMs: MAX_TIMER_MS, reconnectMaxIntervalMs: MAX_TIMER_MS,
  });
  const backoff = (connection as unknown as { backoffDelay: (failures: number) => number }).backoffDelay.bind(connection);
  const random = Math.random;
  Math.random = () => 0.999; // the jitter's top end
  try {
    assert.equal(backoff(1), MAX_TIMER_MS);
    assert.equal(backoff(30), MAX_TIMER_MS);
  } finally {
    Math.random = random;
  }
});

test('a new generation backs off its first reopen from the base interval', async () => {
  const log = scratchLog();
  const connection = await connect('listen-fail-first', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60_000 });
  const internals = connection as unknown as {
    relistenAttempts: number;
    generation: number;
    scheduleRelisten: (generation: number) => void;
  };
  // The previous generation had failed to reopen many times.
  internals.relistenAttempts = 9;
  const seen: Array<{ generation: number; attempts: number }> = [];
  const schedule = internals.scheduleRelisten.bind(connection);
  internals.scheduleRelisten = (generation: number) => {
    seen.push({ generation, attempts: internals.relistenAttempts });
    schedule(generation);
  };
  let reconnected = false;
  connection.on('reconnect', () => { reconnected = true; });
  await connection.callTool('die', {});
  await until(() => reconnected, 'reconnect');
  // Launch 2 refuses its first listen, so the new generation schedules a reopen.
  await until(() => seen.some((s) => s.generation === internals.generation), 'the new generation scheduling its reopen');
  assert.equal(seen.find((s) => s.generation === internals.generation)!.attempts, 0);
});

test('a server that shares no revision with this client is a configuration verdict: no retry', async () => {
  const log = scratchLog();
  const connection = ModernMcpConnection.create({
    id: 'raw', command: process.execPath, args: [SERVER, 'other-revision', log], protocol: 'modern',
    reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60,
  });
  cleanups.push(() => connection.close());
  await assert.rejects(connection.start(), (err: unknown) => {
    assert.ok(err instanceof McplProtocolVersionError, String(err));
    assert.equal(err.kind, 'rejected');
    assert.equal(err.offered, '2026-07-28');
    assert.deepEqual(err.supported, ['2099-01-01']);
    assert.match(err.message, /MCP server "raw" does not support MCP 2026-07-28 \(it supports: 2099-01-01\)\./);
    return true;
  });
  assert.equal(connection.willReconnect, false, 'nothing will retry it');
  assert.equal((connection as unknown as { reconnectTimer: unknown }).reconnectTimer, null);
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 1);
});

test('a legacy-only server is pointed to what reaches it: its configuration over stdio, stdio or WebSocket for an http url', () => {
  const refusal = new UnsupportedProtocolVersionError({ supported: ['2024-11-05'], requested: '2026-07-28' });
  const verdictFor = (config: Parameters<typeof ModernMcpConnection.create>[0]) =>
    (ModernMcpConnection.create(config) as unknown as { versionVerdict: (error: unknown) => McplProtocolVersionError | null }).versionVerdict(refusal)!;
  const stdio = verdictFor({ id: 'raw', command: process.execPath, args: [SERVER, '', scratchLog()], protocol: 'modern' });
  assert.match(stdio.message, /\(it supports: 2024-11-05\)\. It speaks legacy MCP: configure it without protocol: 'modern'\.$/);
  const http = verdictFor({ id: 'remote', url: 'http://127.0.0.1:1/mcp' });
  assert.match(http.message, /\(it supports: 2024-11-05\)\. It speaks only legacy MCP, which this client reaches over stdio or WebSocket \(ws:\/\/, wss:\/\/\), not http\(s\)\.$/);
  assert.doesNotMatch(http.message, /protocol: 'modern'/);
});

test('a reconnect that meets a revision the client does not share stops for good', async () => {
  const log = scratchLog();
  const connection = await connect('other-revision-later', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  const failures: Array<{ error: string; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (f) => failures.push(f));
  await connection.callTool('die', {});
  await until(() => failures.length > 0, 'the reconnect failing');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.permanent, true);
  assert.match(failures[0]!.error, /does not support MCP 2026-07-28 \(it supports: 2099-01-01\)/);
  assert.equal(connection.willReconnect, false);
  assert.equal((connection as unknown as { reconnectTimer: unknown }).reconnectTimer, null, 'no further attempt scheduled');
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 2);
});

test('close() during a connect waits for that connect\'s own cleanup, and reports what it could not reap', async () => {
  const log = scratchLog();
  const connection = ModernMcpConnection.create({ id: 'raw', command: process.execPath, args: [SERVER, 'hang-discover', log], protocol: 'modern' });
  connection.on('error', () => {});
  const statics = ModernMcpConnection as unknown as { closeSession: (session: unknown) => Promise<Error | null> };
  const real = statics.closeSession;
  let closes = 0;
  const unconfirmed = new Error('the child could not be confirmed gone (simulated)');
  // close() closes the generation first; the connect's own cleanup closes it
  // again, and that second close is the one that can't confirm the exit.
  statics.closeSession = async (session: unknown) => {
    const verdict = await real.call(ModernMcpConnection, session);
    return ++closes === 2 ? unconfirmed : verdict;
  };
  cleanups.push(() => { statics.closeSession = real; });
  const starting = connection.start();
  await until(() => wire(log).some((e) => e.method === 'server/discover'), 'the launch waiting on discover');
  await assert.rejects(connection.close(), (error) => error === unconfirmed, 'the failure itself, as the MCPL engine rethrows one');
  assert.equal(closes, 2, 'close() resolved only after the connect\'s own cleanup');
  await starting;
  statics.closeSession = real;
  await connection.close();
});

test('a server that closes its stdin and ignores SIGTERM is killed and reconnected, and a call made after the failure is refused as not sent', async () => {
  const logged = hostLog();
  const log = scratchLog();
  const connection = await connect('ignore-sigterm', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60, requestTimeoutMs: 30_000 });
  connection.on('error', () => { /* out-of-band SDK errors */ });
  const closes: string[] = [];
  connection.on('close', (info: { reason?: string }) => closes.push(info.reason ?? ''));
  await connection.callTool('deafen', {});
  await until(() => wire(log).some((e) => e.event === 'deaf'), 'the server to close its stdin');
  // The first write after that fails with EPIPE. It went out, so its call
  // isn't answered and isn't refused: it fails with the close.
  const first = connection.callTool('plain', {}).then(() => 'answered', (error: unknown) => error);
  await until(() => wire(log).some((e) => e.event === 'sigterm-ignored'), 'the transport to send SIGTERM');
  // From here on nothing is written: a call is refused at once, as not sent.
  await assert.rejects(connection.callTool('plain', {}), (error: unknown) => {
    assert.ok(error instanceof McplRequestError, String(error));
    assert.equal(error.outcome, 'not-sent');
    assert.equal(error.message, 'The request wasn\'t sent: this host can no longer write to the "raw" server, so nothing ran. ' +
      'This host is reconnecting to it; try again later.');
    return true;
  });
  loggedLine(logged, /^MCP server "raw" tools\/call plain not sent: ".*: this host stopped using the server's stdio \(write EPIPE\)"$/);
  // SIGKILL ends the child, and the connection reconnects as after any loss.
  await until(() => wire(log).filter((e) => e.event === 'start').length === 2 && connection.isConnected, 'the next launch, connected');
  assert.equal(closes.length, 1, closes.join('; '));
  const outcome = await first;
  assert.ok(outcome instanceof McplRequestError && outcome.outcome !== 'not-sent', `the written call failed with the close: ${String(outcome)}`);
  assert.deepEqual((await connection.callTool('plain', {})).content, [{ type: 'text', text: 'plain' }], 'the next launch answers');
});

test("a server that closes its stdin and outlives SIGKILL too is held as a launch that can't be reaped: a permanent failure, no second launch, and close() retries", async () => {
  const log = scratchLog();
  const connection = await connect('', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60, requestTimeoutMs: 30_000 });
  connection.on('error', () => { /* the held launch, reported */ });
  const failures: Array<{ error: string; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (failure: { error: string; permanent?: boolean }) => failures.push(failure));
  const line = liveLine(connection);
  const realKill = line.child.kill.bind(line.child);
  line.child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(line.child, SHORT_GRACE_MS);
  // Before the connection's close(), which then reaps an exited child.
  cleanups.push(async () => {
    realKill('SIGKILL');
    await until(() => !alive(line.child.pid), 'the held child killed');
  });
  // A call made as the connection closes, in the same turn as the loss.
  let duringClose: Promise<unknown> | undefined;
  connection.on('close', () => { duringClose ??= connection.callTool('plain', {}).then(() => 'answered', (error: unknown) => error); });
  await connection.callTool('deafen', {});
  await until(() => wire(log).some((e) => e.event === 'deaf'), 'the server to close its stdin');
  // Its write meets EPIPE, so it's pending when the child is found unreaped.
  const pending = connection.callTool('plain', {}).then(() => 'answered', (error: unknown) => error);
  await until(() => failures.length > 0, 'the permanent failure');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.permanent, true);
  assert.match(failures[0]!.error, new RegExp(`^this host stopped using the server's stdio \\(write EPIPE\\); the previous launch could not be reaped \\(stdio child \\d+ of MCP server "raw" did not exit within ${SHORT_GRACE_MS}ms of SIGKILL; it could not be reaped\\); reconnecting is halted$`));
  assert.equal(connection.isConnected, false);
  assert.equal(connection.willReconnect, false);
  assert.equal(connection.holdsUnreapedChild, true);
  // Neither the call the loss ended nor one made as it closed is told this
  // host is reconnecting: the launch is held before either is answered
  // (#540's review, R1-1).
  const ended = await pending;
  assert.ok(ended instanceof McplRequestError, String(ended));
  assert.equal(ended.outcome, 'no-response');
  assert.equal(ended.message, 'The connection to the "raw" server closed before it answered, so whether the request took effect is unknown. ' +
    "This host won't reconnect to it on its own. If you need it, ask whoever runs this host.");
  const refused = await duringClose;
  assert.ok(refused instanceof McplRequestError, String(refused));
  assert.equal(refused.outcome, 'not-sent');
  assert.equal(refused.message, 'The request wasn\'t sent: the connection to the "raw" server is closed, so nothing ran. ' +
    "This host won't reconnect to it on its own. If you need it, ask whoever runs this host.");
  await connection.lossReaped();
  assert.equal(failures.length, 1, "one permanent failure, not a second from the reap's verdict");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 1, 'no second launch');
  // close() retries the reap: refused while the child runs, then done.
  await assert.rejects(connection.close(), /could not be reaped/);
  realKill('SIGKILL');
  await until(() => !alive(line.child.pid), 'the child to be killed');
  await connection.close();
  assert.equal(connection.holdsUnreapedChild, false);
});

/** Hand a live connection the loss of its session, as the line's 'unreaped'
 *  does once the child outlived SIGKILL, here with a child that's well, so
 *  the reap ends it. It throws what a listener throws, to the test. */
const loseUnreaped = (connection: ModernMcpConnection) => {
  const internals = connection as unknown as { session: { generation: number }; handleLost: (generation: number, reason: string, unreaped?: Error) => void };
  internals.handleLost(internals.session.generation, 'its stdio pipe failed', new Error('it outlived SIGKILL'));
};

test("an unreaped launch's loss with a 'close' listener that throws still reaps the launch, holds it, reports the hold, and reports the permanent failure (#540's review, R1-1)", async () => {
  hostLog();
  const connection = await connect('', scratchLog());
  const child = liveLine(connection).child.pid;
  const seen: string[] = [];
  connection.on('error', () => seen.push('error'));
  connection.on('reconnect-failed', (failure: { permanent?: boolean }) => seen.push(failure.permanent ? 'permanent' : 'failed'));
  const failing = () => { seen.push('close'); throw new Error('a close listener failed'); };
  connection.on('close', failing);
  assert.throws(() => loseUnreaped(connection), /^Error: a close listener failed$/);
  connection.off('close', failing);
  assert.equal(connection.holdsUnreapedChild, true, 'held before the listener threw');
  await connection.lossReaped();
  assert.equal(alive(child), false, 'the reap ended the child');
  assert.deepEqual(seen, ['close', 'error', 'permanent']);
});

test("an unreaped launch's loss with an 'error' listener that throws still reaps the launch, closes the connection, and reports the permanent failure (#540's review, R1-1)", async () => {
  hostLog();
  const connection = await connect('', scratchLog());
  const child = liveLine(connection).child.pid;
  const seen: string[] = [];
  connection.on('close', () => seen.push('close'));
  connection.on('reconnect-failed', (failure: { permanent?: boolean }) => seen.push(failure.permanent ? 'permanent' : 'failed'));
  const failing = () => { seen.push('error'); throw new Error('an error listener failed'); };
  connection.on('error', failing);
  assert.throws(() => loseUnreaped(connection), /^Error: an error listener failed$/);
  connection.off('error', failing);
  connection.on('error', () => { /* the rest, reported */ });
  assert.equal(connection.holdsUnreapedChild, true);
  await connection.lossReaped();
  assert.equal(alive(child), false, 'the reap ended the child');
  assert.deepEqual(seen, ['close', 'error', 'permanent']);
});

test("a host that closes the connection as an unreaped launch's loss closes it gets close()'s failure, with no permanent failure beside it (#540's review, R1-1)", async () => {
  const log = scratchLog();
  const connection = await connect('', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60, requestTimeoutMs: 30_000 });
  connection.on('error', () => { /* the held launch, reported */ });
  const failures: unknown[] = [];
  connection.on('reconnect-failed', (failure: unknown) => failures.push(failure));
  const line = liveLine(connection);
  const realKill = line.child.kill.bind(line.child);
  line.child.kill = () => true; // signals never arrive: the child outlives both bounds
  setStdioExitGraceForTests(line.child, SHORT_GRACE_MS);
  // Before the connection's close(), which then reaps an exited child.
  cleanups.push(async () => {
    realKill('SIGKILL');
    await until(() => !alive(line.child.pid), 'the held child killed');
  });
  let closing: Promise<unknown> | undefined;
  connection.on('close', () => { closing ??= connection.close().then(() => 'closed', (error: unknown) => error); });
  await connection.callTool('deafen', {});
  await until(() => wire(log).some((e) => e.event === 'deaf'), 'the server to close its stdin');
  void connection.callTool('plain', {}).catch(() => { /* its write meets EPIPE, and the loss ends it */ });
  await until(() => closing !== undefined, 'the close made as the loss closes the connection');
  assert.match(String(await closing), /could not be reaped/);
  await connection.lossReaped();
  assert.deepEqual(failures, [], "close()'s rejection is the report");
});
