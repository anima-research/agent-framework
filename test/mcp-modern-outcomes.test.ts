/**
 * The modern engine's request outcomes and lifetime against what actually
 * crossed the wire (room-284 review, Theo #53300 / Petra #53269). A
 * hand-written server logs every request, and each case checks the reported
 * outcome against that log:
 * - an SDK-local rejection before dispatch is `not-sent` (0 calls on the wire);
 * - a result that fails validation is an answer that can't be used (1 call,
 *   answered), never a claimed server error;
 * - a JSON-RPC error on the wire is `error-response` with its code and data;
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
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { StdioTransport } from '../src/mcpl/transport.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerConfig } from '../src/mcpl/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'modern-raw-server.mjs');

interface LogEntry { event: string; method?: string; id?: unknown; tool?: string; pid?: number; launch: number }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function scratchLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'modern-raw-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'wire.jsonl');
}

const wire = (log: string): LogEntry[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry) : [];
const calls = (log: string, tool: string) => wire(log).filter((e) => e.method === 'tools/call' && e.tool === tool).length;

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
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
  const log = scratchLog();
  const connection = await connect('invalid-schema', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('op', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'not-sent');
    assert.match(err.message, /tools\/call "op" was not sent: .*invalid outputSchema/);
    return true;
  });
  assert.equal(calls(log, 'op'), 0);
});

test('a result that fails its outputSchema was answered: a plain error, not a server error', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('op', {}), (err: unknown) => {
    assert.ok(!(err instanceof McplRequestError), 'no request outcome is claimed');
    assert.match((err as Error).message, /answered tools\/call "op", but the result can't be used: .*output schema/);
    return true;
  });
  assert.equal(calls(log, 'op'), 1);
});

test('a JSON-RPC error on the wire is error-response with its code and data', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('err', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'error-response');
    assert.equal(err.code, -32603);
    assert.deepEqual(err.data, { why: 'on purpose' });
    assert.match(err.message, /returned error for tools\/call "err": \[-32603\] boom/);
    return true;
  });
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
  let reconnected = false;
  connection.on('reconnect', () => { reconnected = true; });
  await connection.callTool('die', {});
  await until(() => reconnected, 'reconnect');
  // Launch 2 refuses its first listen too; the newer generation reopens it.
  await until(() => wire(log).filter((e) => e.method === 'subscriptions/listen' && e.launch === 2).length >= 2, 'a second listen on launch 2');
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await new Promise((r) => setTimeout(r, 50));
  const before = changes;
  await connection.callTool('touch', {});
  await until(() => changes > before, 'the announced change on launch 2');
});

test('close() during a reconnect handshake ends the launch it was waiting on, and stops', async () => {
  const log = scratchLog();
  const connection = await connect('hang-discover-later', log, { reconnect: true, reconnectIntervalMs: 30, reconnectMaxIntervalMs: 60 });
  await connection.callTool('die', {});
  await until(() => wire(log).some((e) => e.launch === 2 && e.method === 'server/discover'), 'launch 2 waiting on discover');
  const second = wire(log).find((e) => e.launch === 2 && e.event === 'start')!;
  await connection.close();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await until(() => !alive(second.pid!), 'the hanging launch has exited', 3000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(wire(log).filter((e) => e.event === 'start').length, 2, 'no launch after close');
  assert.equal(connection.isConnected, false);
});

test('an input_required continuation keeps its evidence: the second leg decides the outcome', async () => {
  const log = scratchLog();
  const connection = await connect('', log, { requestTimeoutMs: 600 });
  await connection.listTools();
  await assert.rejects(connection.callTool('cont', { leg2: 'error' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'error-response');
    assert.equal(err.code, -32603);
    assert.deepEqual(err.data, { leg: 2, state: 'state-for-error' });
    return true;
  });
  await assert.rejects(connection.callTool('cont', { leg2: 'hang' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /Cancellation was requested/);
    return true;
  });
  assert.equal(calls(log, 'cont'), 4, 'two legs each');
});

test('a deadline between continuation rounds is no-response, and claims no cancellation', async () => {
  // The SDK pauses 250 ms before a state-only round. With a shorter budget,
  // the deadline passes inside that pause whenever leg 1 answers in time.
  const log = scratchLog();
  const connection = await connect('', log, { requestTimeoutMs: 240 });
  await connection.listTools();
  await assert.rejects(connection.callTool('cont', { leg2: 'ok' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(
      err.message,
      /did not finish tools\/call "cont" within 240ms: it asked for another round \(input_required\), and the deadline passed before that round was sent, so nothing was in flight to cancel\. The outcome is unknown/,
    );
    assert.doesNotMatch(err.message, /Cancellation was requested|answered/);
    return true;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls(log, 'cont'), 1, 'only leg 1 reached the wire');
  assert.equal(wire(log).filter((e) => e.method === 'notifications/cancelled').length, 0, 'nothing was cancelled');
});

test('a connection lost between continuation rounds is no-response, not an answer', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('cont', { leg1: 'exit', leg2: 'ok' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(
      err.message,
      /did not finish tools\/call "cont": it asked for another round \(input_required\), and the call ended before that round was sent: Not connected\. The outcome is unknown/,
    );
    return true;
  });
  assert.equal(calls(log, 'cont'), 1);
});

test('a continuation this client cannot go on with is no-response: the server may have acted', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  // Input this client can't supply: it advertises no elicitation.
  await assert.rejects(connection.callTool('cont', { leg1: 'elicit' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /it asked for another round \(input_required\), and the call ended before that round was sent: Cannot fulfil input request 'confirm'/);
    return true;
  });
  assert.equal(calls(log, 'cont'), 1);
  // A server that sheds load on every round meets the rounds cap: the first
  // leg and ten retries.
  await assert.rejects(connection.callTool('cont', { leg2: 'again' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /the call ended before that round was sent: Multi-round-trip request 'tools\/call' still required input after 10 rounds/);
    return true;
  });
  assert.equal(calls(log, 'cont'), 1 + 11);
});

test('a result type this revision does not define, or none, is not a final answer: no-response', async () => {
  const log = scratchLog();
  const connection = await connect('', log);
  await connection.listTools();
  await assert.rejects(connection.callTool('task', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /did not finish tools\/call "task": its answer was not a complete result: Unsupported result type 'task'.*The outcome is unknown/);
    return true;
  });
  await assert.rejects(connection.callTool('bare', {}), (err: unknown) => {
    assert.ok(err instanceof McplRequestError, String(err));
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /did not finish tools\/call "bare": its answer was not a complete result: .*missing required resultType.*The outcome is unknown/);
    return true;
  });
  assert.equal(calls(log, 'task'), 1);
  assert.equal(calls(log, 'bare'), 1);
});

test('concurrent continuations never cross their evidence', async () => {
  const log = scratchLog();
  const connection = await connect('', log, { requestTimeoutMs: 2000 });
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
  const transport = StdioTransport.spawn({ id: 'stuck', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'] });
  const child = (transport as unknown as { child: { pid: number; kill: (signal?: string) => boolean } }).child;
  const realKill = child.kill.bind(child);
  child.kill = () => true; // signals never arrive: the child outlives both bounds
  cleanups.push(() => { realKill('SIGKILL'); });
  await assert.rejects(transport.close(), /did not exit within 2000ms of SIGKILL; it could not be reaped/);
  // Calls share the one attempt and its verdict.
  await assert.rejects(transport.close(), /could not be reaped/);
});

test('a failed launch that cannot be reaped halts reconnecting; close() settles it', async () => {
  const log = scratchLog();
  const realSpawn = StdioTransport.spawn;
  const stuck: Array<{ pid: number; kill: (signal?: string) => boolean }> = [];
  let launches = 0;
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = (config) => {
    const transport = realSpawn.call(StdioTransport, config);
    if (++launches > 1) {
      // From the second launch on, signals never arrive.
      const child = (transport as unknown as { child: { pid: number; kill: (signal?: string) => boolean } }).child;
      const realKill = child.kill.bind(child);
      child.kill = () => true;
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
  await until(() => failures.some((f) => f.permanent), 'a permanent reconnect failure', 9000);
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
  (StdioTransport as unknown as { spawn: typeof StdioTransport.spawn }).spawn = (config) => {
    const transport = realSpawn.call(StdioTransport, config);
    const child = (transport as unknown as { child: { pid: number; kill: (signal?: string) => boolean } }).child;
    const realKill = child.kill.bind(child);
    child.kill = () => true; // teardown can't reap it
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
