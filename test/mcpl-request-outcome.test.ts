/**
 * McplRequestError: a request that produced no result says which of three
 * things happened, as a fact rather than a message to parse.
 *   not-sent        refused before anything was written (connection closed)
 *   error-response  the server answered with a JSON-RPC error (code, data kept)
 *   no-response     the request was handed to the transport and no answer
 *                   came back (timeout, or the connection closed while
 *                   awaiting): it may or may not have reached the server
 * Callers that act in the world (publishing speech, placing reactions) need
 * the difference: only `not-sent` proves the server never saw the request.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { McplServerConnection, McplRequestError } from '../src/mcpl/server-connection.js';
import { McplRequestError as FromMcplIndex } from '../src/mcpl/index.js';
import { McplRequestError as FromPackageRoot } from '../src/index.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

test('McplRequestError is exported from the mcpl index and the package root', () => {
  assert.equal(FromMcplIndex, McplRequestError);
  assert.equal(FromPackageRoot, McplRequestError);
});

// Stdio server: answers initialize; tools/call 'fail' gets a JSON-RPC error
// with data, 'stuck' gets nothing, 'exit' kills the process mid-request.
const SERVER = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n');
    if (m.method === 'initialize') out({ result: { protocolVersion: '2024-11-05', capabilities: {} } });
    else if (m.method === 'tools/call' && m.params.name === 'fail') {
      out({ error: { code: -32001, message: 'POSTED: part 1 of 2', data: { posted: ['111'] } } });
    } else if (m.method === 'tools/call' && m.params.name === 'exit') {
      process.exit(3);
    }
    // 'stuck': deliberately no response.
  }
});
setInterval(() => {}, 1 << 30);
`;

const HOST_CAPS: McplHostCapabilities = { version: '0.4', pushEvents: true, contextHooks: { beforeInference: true }, featureSets: true };
const config = (overrides?: Partial<McplServerConfig>): McplServerConfig =>
  ({ id: 'outcome', command: process.execPath, args: ['-e', SERVER], ...overrides });

let connection: McplServerConnection | null = null;
afterEach(async () => {
  await connection?.close();
  connection = null;
});

const rejectsWith = async (promise: Promise<unknown>, outcome: McplRequestError['outcome']): Promise<McplRequestError> => {
  let caught: unknown;
  await assert.rejects(promise, (err: unknown) => { caught = err; return true; });
  assert.ok(caught instanceof McplRequestError, `expected McplRequestError, got ${String(caught)}`);
  assert.equal((caught as McplRequestError).outcome, outcome);
  return caught as McplRequestError;
};

test('an error response is error-response, with its data kept and the server\'s words in the message', async () => {
  connection = await McplServerConnection.connect(config(), HOST_CAPS);
  const err = await rejectsWith(connection.sendToolsCall('fail', {}), 'error-response');
  assert.deepEqual(err.data, { posted: ['111'] });
  // The method, id and code are the operator's, in the log (mcpl-agent-words).
  assert.equal(err.message, 'The "outcome" server answered with an error: POSTED: part 1 of 2');
});

test('a request nobody answers is no-response', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 200 }), HOST_CAPS);
  const err = await rejectsWith(connection.sendToolsCall('stuck', {}), 'no-response');
  assert.match(err.message, /^The "outcome" server didn't answer within 0\.2 seconds, so whether the request took effect is unknown/);
});

test('a connection lost while awaiting is no-response', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 10_000 }), HOST_CAPS);
  const err = await rejectsWith(connection.sendToolsCall('exit', {}), 'no-response');
  // The loss itself rejects it, not the request's own deadline.
  assert.match(err.message, /^The connection to the "outcome" server closed before it answered/);
});

test('closing the connection while a request awaits its answer rejects it as no-response', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 10_000 }), HOST_CAPS);
  const pending = connection.sendToolsCall('stuck', {});
  // The request fails as the close begins, and the close resolves once the
  // child has exited, so the rejection is observed before the close is awaited.
  const rejected = rejectsWith(pending, 'no-response');
  await connection.close();
  await rejected;
  connection = null;
});

test('channels/open keeps a deadline when requestTimeoutMs is 0, as channels/publish does', { timeout: 10_000 }, async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 0 }), HOST_CAPS);
  (connection as unknown as { publishDeadlineMs: number }).publishDeadlineMs = 200;
  const err = await rejectsWith(connection.sendChannelsOpen({ type: 'channel', address: { id: 'nowhere' } } as never), 'no-response');
  assert.match(err.message, /^The "outcome" server didn't answer within 0\.2 seconds/);
});

test('a request on a closed connection is not-sent', async () => {
  connection = await McplServerConnection.connect(config(), HOST_CAPS);
  await connection.close();
  const err = await rejectsWith(connection.sendToolsCall('fail', {}), 'not-sent');
  assert.equal(err.message, 'The request wasn\'t sent: this host closed its connection to the "outcome" server, so nothing ran. ' +
    'If calling it again fails, ask whoever runs this host.');
  connection = null;
});

test('McplRequestError is an Error that keeps its message and name', () => {
  const err = new McplRequestError('boom', 'not-sent');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'McplRequestError');
  assert.equal(err.message, 'boom');
});

test('a synchronous write rejection is not-sent, leaves no pending request, and does not poison the next request', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  connection = await McplServerConnection.connect(config(), HOST_CAPS);
  const state = connection as unknown as {
    transport: { writeLine(json: string): void; emit(event: string, line: string): boolean };
    pendingRequests: Map<unknown, unknown>;
  };
  const write = state.transport.writeLine.bind(state.transport);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let unwrittenId: unknown;
  const lateRenders: unknown[] = [];
  connection.on('orphaned-render-response', (event) => lateRenders.push(event));
  // connect() buffers data-plane events until the caller has wired listeners.
  connection.ready();
  connection.emit('orphaned-render-response', { params: { featureSet: 'test', key: 'observer-probe', eventId: 'probe' }, result: { content: [] } });
  assert.equal(lateRenders.length, 1, 'the observer is armed, so absence of a later event is meaningful');
  lateRenders.length = 0;
  state.transport.writeLine = (json) => { unwrittenId = JSON.parse(json).id; throw new Error('synthetic write rejection'); };
  const err = await rejectsWith(connection.sendPushRender({ featureSet: 'test', key: 'unwritten', eventId: 'e1', notices: [], dropped: 0 }), 'not-sent');
  assert.equal(err.message, 'The request wasn\'t sent: this host couldn\'t write it to the "outcome" server, so nothing ran. Try again later.');
  // The method, id and the transport's words go to the log.
  assert.ok(errors.mock.calls.some((call) => /^MCPL server "outcome": writing push\/render \(id=\d+\) failed: "synthetic write rejection"$/.test(String(call.arguments[0]))),
    errors.mock.calls.map((call) => String(call.arguments[0])).join('\n'));
  assert.equal(state.pendingRequests.size, 0, 'nothing remains awaiting an unwritten request');
  t.mock.timers.tick(5000);
  state.transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: unwrittenId, result: { content: [] } }));
  assert.deepEqual(lateRenders, [], 'an unwritten render cannot surface a late-response event after its old watchdog deadline');
  t.mock.timers.reset();
  state.transport.writeLine = write;
  const next = await rejectsWith(connection.sendToolsCall('fail', {}), 'error-response');
  assert.deepEqual(next.data, { posted: ['111'] }, 'a subsequent written request still reaches the real server');
});
