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
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

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

test('an error response is error-response, with its code and data kept', async () => {
  connection = await McplServerConnection.connect(config(), HOST_CAPS);
  const err = await rejectsWith(connection.sendToolsCall('fail', {}), 'error-response');
  assert.equal(err.code, -32001);
  assert.deepEqual(err.data, { posted: ['111'] });
  assert.match(err.message, /returned error for tools\/call: \[-32001\] POSTED: part 1 of 2/);
});

test('a request nobody answers is no-response, and the message is unchanged', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 200 }), HOST_CAPS);
  const err = await rejectsWith(connection.sendToolsCall('stuck', {}), 'no-response');
  assert.match(err.message, /did not respond to tools\/call/);
});

test('a connection lost while awaiting is no-response', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 10_000 }), HOST_CAPS);
  await rejectsWith(connection.sendToolsCall('exit', {}), 'no-response');
});

test('a request on a closed connection is not-sent', async () => {
  connection = await McplServerConnection.connect(config(), HOST_CAPS);
  await connection.close();
  const err = await rejectsWith(connection.sendToolsCall('fail', {}), 'not-sent');
  assert.match(err.message, /Cannot send request: connection to "outcome" is closed/);
  connection = null;
});

test('McplRequestError is an Error that keeps its message and name', () => {
  const err = new McplRequestError('boom', 'not-sent');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'McplRequestError');
  assert.equal(err.message, 'boom');
});
