import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { InferenceRouter } from '../src/mcpl/inference-router.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { createMockResponse } from './helpers/mock-membrane.js';

function harness(connection = Object.assign(new EventEmitter(), { id: 'srv' })) {
  const traces: any[] = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  // Main's trace listeners are registrations (#318), which onTrace makes.
  framework.traceListeners = [];
  framework.onTrace((event: unknown) => traces.push(event));
  framework.wireMcplEvents(connection, { id: connection.id });
  return { framework, connection, traces };
}

function responder() {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  return {
    results,
    errors,
    id: 17,
    respond(result: unknown) { results.push(result); },
    respondError(code: number, message: string, data?: unknown) {
      errors.push({ code, message, data });
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const failureTraces = (traces: any[]) => traces.filter((t) => t.type === 'mcpl:request-handler-error');

for (const [event, field] of [['channels-register', 'channels'], ['channels-changed', 'added']] as const) {
  test(event + ': lifecycle persistence failure after ACK is traced without another response', async () => {
    const { framework, connection, traces } = harness();
    const server = {
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      async sendChannelsOpen() { return {}; },
      async sendChannelsClose() { return {}; },
    };
    const registry = new ChannelRegistry(
      { getServer: () => server } as never,
      {} as never,
      () => {},
      () => {},
    );
    // Inject the reported failure at the real Chronicle append boundary.
    // A descriptor without a label avoids the unrelated label-history write.
    (registry as any).store = {
      appendToStateJson() { throw new Error('injected lifecycle-store failure'); },
    };
    registry.setSubscriptionPolicy('srv', 'auto');
    framework.channelRegistry = registry;
    const reply = responder();
    connection.emit(event, { [field]: [{ id: 'room', type: 'test', direction: 'bidirectional' }] }, reply);
    // Synchronously, before reconciliation's first await settles.
    assert.equal(reply.results.length, 1, 'ACK precedes reconciliation');
    await settle();

    assert.equal(reply.results.length, 1, 'and nothing else is answered');
    assert.equal(reply.errors.length, 0, 'an accepted registration must not get a second response');
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].serverId, 'srv');
    assert.equal(failures[0].event, event);
    assert.equal(failures[0].requestId, 17);
    assert.equal(failures[0].responseAttempted, true);
    assert.match(failures[0].error, /injected lifecycle-store failure/);
  });
}

for (const [event, component, method] of [
  ['channels-register', 'channelRegistry', 'handleRegister'],
  ['channels-changed', 'channelRegistry', 'handleChanged'],
  ['channels-incoming', 'channelRegistry', 'handleIncoming'],
  ['push-event', 'pushHandler', 'handlePushEvent'],
  ['inference-request', 'inferenceRouter', 'handleInferenceRequest'],
] as const) {
  test(event + ': rejection before a response gets one JSON-RPC internal error', async () => {
    const { framework, connection, traces } = harness();
    framework[component] = {
      async [method]() {
        await Promise.resolve();
        throw new Error('handler failed before response');
      },
    };
    const reply = responder();
    connection.emit(event, {}, reply);
    await settle();

    assert.equal(reply.results.length, 0);
    // The server gets the standard message; the handler's own text stays home.
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].event, event);
    assert.equal(failures[0].responseAttempted, false);
    assert.match(failures[0].error, /handler failed before response/);
  });
}

test('a notification\'s rejection is traced, with no request id', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { async handleChanged() { throw new Error('notification failed'); } };
  connection.emit('channels-changed', {});
  await settle();
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].requestId, undefined);
  assert.match(failures[0].error, /notification failed/);
});

test('a synchronous handler throw is contained and answered', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { descriptorsForServer() { throw new Error('list failed'); } };
  const reply = responder();
  assert.doesNotThrow(() => connection.emit('channels-list', {}, reply));
  await settle();
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /list failed/);
});

test('a success response whose write throws has sent nothing, so the request gets one internal-error reply', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { descriptorsForServer() { return []; } };
  const reply = responder();
  let tries = 0;
  reply.respond = () => { tries++; throw new Error('the result could not be encoded'); };
  assert.doesNotThrow(() => connection.emit('channels-list', {}, reply));
  await settle();
  assert.equal(tries, 1);
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
  assert.equal(failureTraces(traces)[0].responseAttempted, false);
});

test('a failed error response is traced without an escaping rejection', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { async handleRegister() { throw new Error('original failure'); } };
  const reply = responder();
  let writes = 0;
  reply.respondError = () => { writes++; throw new Error('error response transport failed'); };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(writes, 1);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /original failure/);
  assert.match(failures[0].responseError, /error response transport failed/);
});

test('inference responders retain request IDs and their transport\'s chunk sender, and successful handling stays synchronous', async () => {
  const { framework, connection, traces } = harness();
  framework.inferenceRouter = {
    handleInferenceRequest(_server: string, _params: unknown, reply: any) {
      assert.equal(reply.requestId, 17);
      reply.sendChunk({ requestId: 17, index: 0, delta: 'a' });
      reply.respond({ accepted: true });
    },
  };
  const chunks: unknown[] = [];
  const reply = { ...responder(), sendChunk: (chunk: unknown) => { chunks.push(chunk); } };
  connection.emit('inference-request', {}, reply);
  assert.deepEqual(chunks, [{ requestId: 17, index: 0, delta: 'a' }], 'chunks go out through the request\'s own sender');
  assert.deepEqual(reply.results, [{ accepted: true }]);
  await settle();
  assert.equal(reply.errors.length, 0);
  assert.equal(failureTraces(traces).length, 0);
});

test('a real inference handler whose result write throws answers with its own error, its only reply, and the failed write is reported', async () => {
  const { framework, connection, traces } = harness();
  framework.inferenceRouter = new InferenceRouter(
    // The shared helper's response, so a change that has the router read more
    // of a response gives this test that field along with every other test.
    { async complete() { return createMockResponse([{ type: 'text', text: 'done' }]); } } as never,
    { isInHook: false } as never,
    { validateInbound() {} } as never,
    { default: 'test-model' },
    (event) => traces.push(event),
  );
  const reply = responder();
  let resultWrites = 0;
  // A write that throws has sent nothing, as when a result can't be encoded.
  reply.respond = () => { resultWrites++; throw new Error('the result could not be encoded'); };
  connection.emit('inference-request', {
    featureSet: 'test', messages: [{ role: 'user', content: 'hello' }],
  }, reply);
  await settle();
  assert.equal(resultWrites, 1);
  // The router's own catch answers, as in 0.22.x, and the wrapper sends no
  // internal-error reply after it.
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'the result could not be encoded', data: undefined }]);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /the result could not be encoded/);
  assert.equal(failures[0].responseAttempted, true);
});

test('a real inference handler whose inference fails answers -32603 with the failure\'s own message, as in 0.22.x, and no handler failure is reported', async () => {
  const { framework, connection, traces } = harness();
  framework.inferenceRouter = new InferenceRouter(
    { async complete() { throw new Error('the provider refused the request'); } } as never,
    { isInHook: false } as never,
    { validateInbound() {} } as never,
    { default: 'test-model' },
    (event) => traces.push(event),
  );
  const reply = responder();
  connection.emit('inference-request', {
    featureSet: 'test', messages: [{ role: 'user', content: 'hello' }],
  }, reply);
  await settle();
  // The router answers the failure itself, so the wrapper sees none.
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'the provider refused the request', data: undefined }]);
  assert.deepEqual(failureTraces(traces), []);
});

test('an error response followed by a handler rejection is not answered again', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respondError(-32602, 'bad params');
      throw new Error('after error response');
    },
  };
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.errors.length, 1);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /after error response/);
  assert.equal(failureTraces(traces)[0].responseAttempted, true);
});

class ResponseTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void {
    this.lines.push(line);
  }
  async close(): Promise<void> {}
}

function wireHarness() {
  const transport = new ResponseTransport();
  // Use real connection routing and response encoding without launching a server.
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  (connection as any).allowHostCommands = true;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  const h = harness(connection);
  connection.ready();
  const request = (method = 'host/command') => transport.emit('line', JSON.stringify({
    jsonrpc: '2.0', id: 17, method, params: { command: 'maintain' },
  }));
  return { ...h, transport, request };
}

for (const kind of ['bigint', 'circular', 'throwing toJSON'] as const) {
  test('host-command ' + kind + ' serialization failure receives one internal-error response', async () => {
    const { framework, traces, transport, request } = wireHarness();
    let calls = 0;
    const circular: any = {};
    circular.self = circular;
    const progress = kind === 'bigint' ? { count: 1n } : kind === 'circular' ? circular : {
      toJSON() { calls++; throw new Error('snapshot serialization failed'); },
    };
    framework.handleHostCommand = async () => ({ progress });
    request();
    await settle();
    assert.equal(transport.lines.length, 1, 'encoding failed before any result bytes were written');
    const reply = JSON.parse(transport.lines[0]!);
    assert.equal(reply.id, 17);
    assert.equal(reply.error.code, -32603);
    assert.equal(reply.result, undefined);
    assert.equal(reply.error.message, 'Internal error');
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].responseAttempted, false);
    // JSON.stringify's own message says why.
    assert.match(failures[0].error, kind === 'bigint' ? /BigInt/
      : kind === 'circular' ? /circular structure/
        : /snapshot serialization failed/);
    if (kind === 'throwing toJSON') assert.equal(calls, 1, 'results are encoded only once');
  });
}

test('unserializable error data also permits one encodable error response', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respondError(-32602, 'bad input', { count: 1n });
    },
  };
  request('channels/register');
  await settle();
  assert.equal(transport.lines.length, 1);
  assert.equal(JSON.parse(transport.lines[0]!).error.code, -32603);
  assert.equal(failureTraces(traces)[0].responseAttempted, false);
});

test('a swallowed pre-write encoding failure still receives a fallback response', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      try { reply.respond({ count: 1n }); } catch { /* handler swallowed the error */ }
    },
  };
  request('channels/register');
  await settle();
  assert.equal(transport.lines.length, 1);
  assert.equal(JSON.parse(transport.lines[0]!).error.code, -32603);
  assert.equal(failureTraces(traces)[0].responseAttempted, false);
  assert.match(failureTraces(traces)[0].error, /BigInt/);
});

test('post-response failures reach stderr when no trace subscriber is attached', async (t) => {
  const { framework, connection } = harness();
  framework.traceListeners = [];
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respond({ registered: [] });
      throw new Error('headless reconciliation failed');
    },
  };
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.results.length, 1);
  assert.equal(reply.errors.length, 0);
  assert.equal(errors.length, 1);
  // One line, its text through log-value.
  assert.equal(errors[0]?.length, 1);
  assert.match(String(errors[0]?.[0]), /^\[mcpl\] srv channels-register handler failed: "headless reconciliation failed"$/);
});

for (const mode of ['handshake', 'connected', 'throwing-listener']) {
  test('separate stdio host survives inbound ' + mode + ' faults and processes later messages', () => {
    const probe = spawnSync(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./fixtures/mcpl-inbound-host-probe.mjs', import.meta.url)), mode,
    ], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /continued/);
  });
}

test('a separate stdio host whose server answers initialize with an error message no template can convert is refused well before the handshake times out, and survives', () => {
  const probe = spawnSync(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('./fixtures/mcpl-initialize-error-probe.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /refused/);
});

test("an initialize error's message is bounded, as a server's text in the framework's errors is", { timeout: 30_000 }, async () => {
  // Its message has a line break and runs past 200 code points.
  const server = String.raw`
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const request = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32603, message:'first line\nsecond' + 'x'.repeat(300)}}) + '\n');
    }
  }
});
`;
  await assert.rejects(
    McplServerConnection.connect({ id: 'srv', command: process.execPath, args: ['-e', server] }, { version: '0.5' }),
    { message: `MCPL server "srv" initialize error: first line?second${'x'.repeat(183)}…` },
  );
});

for (const value of [null, 42, 'hi', true, []]) {
  test('non-object inbound ' + JSON.stringify(value) + ' leaves the next notification deliverable', () => {
    const { connection, transport } = wireHarness();
    let received = false;
    connection.removeAllListeners('tools-list-changed');
    connection.on('tools-list-changed', () => { received = true; });
    assert.doesNotThrow(() => transport.emit('line', JSON.stringify(value)));
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
    assert.equal(received, true);
  });
}

for (const release of ['live', 'ready', 'readyControlPlane'] as const) {
  test('synchronous notification failure is contained during ' + release + ' dispatch and traced', (t) => {
    const transport = new ResponseTransport();
    const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
    const { traces } = harness(connection);
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const seen: number[] = [];
    connection.removeAllListeners('tools-list-changed');
    connection.on('tools-list-changed', (params: { sequence: number }) => {
      if (params.sequence === 1) throw new Error('raw notification failed');
      seen.push(params.sequence);
    });
    if (release === 'live') connection.ready();
    const send = (sequence: number) => transport.emit('line', JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { sequence },
    }));
    assert.doesNotThrow(() => { send(1); send(2); });
    if (release !== 'live') assert.doesNotThrow(() => connection[release]());
    assert.deepEqual(seen, [2]);
    assert.equal(traces.filter((e) => e.type === 'mcpl:server-error').length, 1);
    assert.equal(errors.length, 1);
  });
}

for (const value of [null, 42, 'hi', true, []]) {
  test('non-object inbound ' + JSON.stringify(value) + ' is dropped and logged by its length as JSON that isn\'t an object, with no failure report', (t) => {
    const { connection, transport } = wireHarness();
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const reported: unknown[] = [];
    connection.on('error', (error: unknown) => { reported.push(error); });
    const line = JSON.stringify(value);
    transport.emit('line', line);
    assert.deepEqual(errors, [[`MCP server "srv" sent a line of length ${line.length} that is JSON but not an object, so it was dropped`]]);
    assert.deepEqual(reported, []);
  });
}

for (const [line, length, why] of [
  ['[info] listening on 3000', 24, "isn't JSON"],
  ['\u{1F600} not json', 10, "isn't JSON"],
  ['\u2028', 1, "isn't JSON"],
  [' \t{"jsonrpc":', 13, "starts like a JSON object but doesn't parse"],
] as const) {
  test(`a dropped line ${JSON.stringify(line)} is logged by its length in characters and why it was dropped, never its content`, (t) => {
    const { transport } = wireHarness();
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    transport.emit('line', line);
    assert.deepEqual(errors, [[`MCP server "srv" sent a line of length ${length} that ${why}, so it was dropped`]]);
  });
}

test('the first three dropped lines on a connection are logged, then one line says more go unlogged, and another connection starts its own three', (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const first = wireHarness();
  for (const line of ['one', 'two', '', 'three', 'four', 'five']) first.transport.emit('line', line);
  const second = wireHarness();
  second.transport.emit('line', 'again');
  const dropped = (length: number) => [`MCP server "srv" sent a line of length ${length} that isn't JSON, so it was dropped`];
  assert.deepEqual(errors, [
    dropped(3), dropped(3), dropped(5),
    ['MCP server "srv" sent another line that isn\'t a JSON object, so it was dropped; more such lines on this connection are dropped without a log line'],
    dropped(5),
  ]);
});

test('a throwing orphaned-response listener is contained, and later messages still arrive', (t) => {
  const { connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.prependListener('orphaned-response', () => { throw new Error('orphan listener failed'); });
  let received = false;
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', () => { received = true; });
  // A response to no pending request, carrying state, is surfaced as orphaned.
  assert.doesNotThrow(() => transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 999, result: { state: {} } })));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal(received, true);
  assert.equal(traces.filter((e) => e.type === 'mcpl:server-error').length, 1);
});

test('a method that is not a string is not dispatched, even if it stringifies to a known method', () => {
  const { connection, transport } = wireHarness();
  let received = false;
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', () => { received = true; });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: ['notifications/tools/list_changed'] }));
  assert.equal(received, false);
  // The control: the same method as a string is dispatched in this setup.
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal(received, true);
});

test('tools-observe: a synchronous failure is answered with one internal error', async () => {
  const { connection, traces } = harness();
  Object.defineProperty(connection, 'toolObserveFilter', { set() { throw new Error('filter store failed'); } });
  const reply = responder();
  assert.doesNotThrow(() => connection.emit('tools-observe', { rules: [] }, reply));
  await settle();
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /filter store failed/);
});

test('model-info: an error write that throws has sent nothing, so one internal-error reply is tried, and neither throw escapes', async () => {
  const { connection, traces } = harness();
  const reply = responder();
  const tried: Array<{ code: number; message: string }> = [];
  reply.respondError = (code: number, message: string) => { tried.push({ code, message }); throw new Error('response transport failed'); };
  assert.doesNotThrow(() => connection.emit('model-info', {}, reply));
  await settle();
  assert.equal(tried.length, 2);
  assert.equal(tried[0]!.code, -32601);
  assert.match(tried[0]!.message, /model\/info unavailable/);
  assert.deepEqual(tried[1], { code: -32603, message: 'Internal error' });
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].responseAttempted, false);
  assert.match(failures[0].error, /response transport failed/);
  assert.equal(failures[0].responseFailure, undefined, 'the write failure is the error itself, not repeated');
  assert.match(failures[0].responseError, /response transport failed/);
});

test('a method named after an Object.prototype member is not buffered while the planes are paused', () => {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  // Before ready(), inbound events wait in the buffer; an unknown method must not take a slot.
  for (const method of ['constructor', '__proto__', 'toString', 'no/such-method']) {
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method }));
  }
  assert.equal((connection as any).bufferedEvents.length, 0);
  // The control: a known notification does wait in the buffer here.
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal((connection as any).bufferedEvents.length, 1);
});

test('a handler that swallows an encoding failure and then fails reports its own error, and the failed write beside it', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      try { reply.respond({ count: 1n }); } catch { /* swallowed */ }
      throw new Error('db down');
    },
  };
  request('channels/register');
  await settle();
  assert.equal(transport.lines.length, 1, 'no bytes of the result went out, so one internal-error reply does');
  assert.deepEqual(JSON.parse(transport.lines[0]!).error, { code: -32603, message: 'Internal error' });
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /db down/);
  assert.match(failures[0].responseFailure, /BigInt/);
  assert.equal(failures[0].responseAttempted, false);
});

test('an answer tried after the reply is refused without throwing, so the handler reports its own error', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respond({ registered: [] });
      try {
        await Promise.resolve();
        throw new Error('store append failed');
      } catch (error) {
        reply.respondError(-32603, 'could not record the registration');
        throw error;
      }
    },
  };
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.results.length, 1);
  assert.equal(reply.errors.length, 0, 'the second answer is never written');
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /store append failed/);
  assert.deepEqual(failures[0].refusedResponse, { kind: 'error', code: -32603, message: 'could not record the registration' });
  assert.equal(failures[0].responseAttempted, true);
});

test('a handler that answers twice and resolves is still reported', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respond({ registered: [] });
      reply.respondError(-32602, 'second thoughts');
    },
  };
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.results.length, 1);
  assert.equal(reply.errors.length, 0);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /second time/);
  assert.deepEqual(failures[0].refusedResponse, { kind: 'error', code: -32602, message: 'second thoughts' });
});

test('a rejection whose reason cannot be printed is reported and answered, with no unhandled rejection', async () => {
  const { framework, connection, traces } = harness();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    framework.channelRegistry = {
      async handleRegister() { throw Object.create(null); },
    };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(typeof failures[0].error, 'string');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a request for a method nothing handles is answered -32601; such a notification is ignored', (t) => {
  const { transport } = wireHarness();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'no/such-method' }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 32, method: ['host/command'] }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 33, method: 7 }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'no/such-notification' }));
  const replies = transport.lines.map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code, r.error?.message]), [
    [31, -32601, 'Method not found'],
    [32, -32601, 'Method not found'],
    [33, -32601, 'Method not found'],
  ]);
  // One line per answered request, naming the method; none for the notification.
  assert.deepEqual(logged, [
    "[mcpl] srv: answered -32601 to a request for method no/such-method, which this host doesn't handle",
    "[mcpl] srv: answered -32601 to a request for a method of type object, which this host doesn't handle",
    "[mcpl] srv: answered -32601 to a request for a method of type number, which this host doesn't handle",
  ]);
});

test('a dispatch failure names the event, the request and what failed', (t) => {
  const { connection, transport, traces } = wireHarness();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  connection.prependListener('channels-list', () => { throw new Error('listener exploded'); });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'channels/list' }));
  const errors = traces.filter((e) => e.type === 'mcpl:server-error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /inbound dispatch failed for channels-list \(request 41\): listener exploded/);
  // The stderr line says the same, through log-value.
  assert.ok(logged.includes('[mcpl] srv: inbound dispatch failed for channels-list (request 41): "listener exploded"'), logged.join('\n'));
});

test('a manifest-changed handler that throws is reported as a handler failure', async (t) => {
  const { framework, connection, traces } = harness();
  t.mock.method(console, 'error', () => {});
  framework.handleManifestChanged = async () => { throw new Error('manifest fetch failed'); };
  connection.emit('manifest-changed', { revision: 'r2' });
  await settle();
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'manifest-changed');
  assert.equal(failures[0].requestId, undefined);
  assert.match(failures[0].error, /manifest fetch failed/);
});

test('a manifest fetch that fails is only logged, as in 0.22.x: the previous manifest stands, and no handler failure is reported', async (t) => {
  const { framework, connection, traces } = harness();
  const errors = t.mock.method(console, 'error', () => {});
  framework.manifestRefreshState = new Map();
  framework.mcplServerConfigs = new Map([['srv', { id: 'srv' }]]);
  // What a refresh changes: the grant, the feature sets, and the manifest it
  // adopts with its tracking.
  const changed: string[] = [];
  const previous = {
    capabilities: { version: '0.5' },
    manifestState: { lastValidatedRevision: 'r1', lastFetchedAt: 1 },
    droppedCapabilities: new Set<string>(),
  };
  Object.assign(connection, previous, { establishGrant() { changed.push('grant'); } });
  framework.featureSetManager = { initializeServer() { changed.push('feature sets'); } };
  (connection as any).sendManifestRequest = async () => { throw new Error('the server is gone'); };
  connection.emit('manifest-changed', { revision: 'r2' });
  await settle();
  assert.deepEqual(failureTraces(traces), []);
  assert.deepEqual(errors.mock.calls.map((call) => String(call.arguments[0])), [
    '[mcpl] srv: mcpl/manifest fetch failed — previous manifest stands (§17.5): the server is gone',
  ]);
  assert.deepEqual(changed, []);
  assert.equal((connection as any).capabilities, previous.capabilities);
  assert.deepEqual((connection as any).manifestState, { lastValidatedRevision: 'r1', lastFetchedAt: 1 });
  assert.equal((connection as any).droppedCapabilities, previous.droppedCapabilities);
});

const manifestFetchFloorMs = (AgentFramework as any).MANIFEST_FETCH_FLOOR_MS as number;

test('a manifest refresh deferred by the fetch floor reports a failure other than its fetch\'s, as the announcement\'s own run does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const { framework, connection, traces } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  // The last refresh completed just now, so this announcement waits out the floor.
  framework.manifestRefreshState = new Map([[connection, { inFlight: false, queued: false, lastCompletedAt: 100_000 }]]);
  // Each run reads the server's configuration before anything else: the
  // announcement's own run finds it, and the deferred run fails there.
  let lookups = 0;
  framework.mcplServerConfigs = {
    get() {
      lookups++;
      if (lookups > 1) throw new Error('the deferred refresh failed before its fetch');
      return { id: 'srv' };
    },
  };
  connection.emit('manifest-changed', { revision: 'r2' });
  await settle();
  assert.deepEqual(failureTraces(traces), [], 'nothing has run yet');
  t.mock.timers.tick(manifestFetchFloorMs);
  await settle();
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'manifest-changed');
  assert.equal(failures[0].requestId, undefined);
  assert.match(failures[0].error, /the deferred refresh failed before its fetch/);
  assert.ok(lines.includes('[mcpl] srv manifest-changed handler failed: "the deferred refresh failed before its fetch"'), lines.join('\n'));
});

test('a manifest refresh queued behind a fetch in flight reports a failure other than its fetch\'s, after the first run\'s failed fetch is only logged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const { framework, connection, traces } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  framework.manifestRefreshState = new Map();
  // Each run reads the server's configuration before anything else: both
  // announcements' own runs find it, and the queued re-run fails there.
  let lookups = 0;
  framework.mcplServerConfigs = {
    get() {
      lookups++;
      if (lookups > 2) throw new Error('the queued refresh failed before its fetch');
      return { id: 'srv' };
    },
  };
  let failFetch!: (error: Error) => void;
  (connection as any).sendManifestRequest = () => new Promise((_resolve, reject) => { failFetch = reject; });
  connection.emit('manifest-changed', { revision: 'r2' });
  // This one arrives while the first fetch is in flight, so it queues a re-run.
  connection.emit('manifest-changed', { revision: 'r3' });
  failFetch(new Error('the server is gone'));
  await settle();
  assert.deepEqual(failureTraces(traces), [], 'a failed fetch is only logged');
  assert.deepEqual(lines, ['[mcpl] srv: mcpl/manifest fetch failed — previous manifest stands (§17.5): the server is gone']);
  t.mock.timers.tick(manifestFetchFloorMs);
  await settle();
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'manifest-changed');
  assert.match(failures[0].error, /the queued refresh failed before its fetch/);
  assert.equal(lookups, 3);
  assert.ok(lines.includes('[mcpl] srv manifest-changed handler failed: "the queued refresh failed before its fetch"'), lines.join('\n'));
});

test('a server\'s error answer that no template can convert settles the host\'s request: a manifest fetch answered so is logged and leaves no refresh in flight', async (t) => {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  const { framework, traces } = harness(connection);
  connection.ready();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  framework.manifestRefreshState = new Map();
  framework.mcplServerConfigs = new Map([['srv', { id: 'srv' }]]);
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'mcpl/manifestChanged', params: { revision: 'r2' } }));
  const fetch = JSON.parse(transport.lines.at(-1)!);
  assert.equal(fetch.method, 'mcpl/manifest');
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: fetch.id, error: { code: { toString: 1 }, message: { toString: 1 } } }));
  await settle();
  assert.deepEqual(lines, [
    `MCPL server "srv" answered mcpl/manifest (id=${fetch.id}) with error "{\\"toString\\":1}": "{\\"toString\\":1}"`,
    '[mcpl] srv: mcpl/manifest fetch failed — previous manifest stands (§17.5): The "srv" server answered with an error without saying what went wrong, so whether the request took effect is unknown. Check its effect before trying again.',
  ]);
  assert.deepEqual(traces.filter((e) => e.type === 'mcpl:server-error' || e.type === 'mcpl:request-handler-error'), []);
  assert.equal(framework.manifestRefreshState.get(connection).inFlight, false);
});

test('a server\'s error message in the error a host request rejects with is bounded: control, format and line characters replaced, and cut after 200 code points; its code goes to the log line instead, as logValue prints it', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  connection.ready();
  const fetched = connection.sendManifestRequest();
  const fetch = JSON.parse(transport.lines.at(-1)!);
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: fetch.id, error: { code: -32000, message: `line one\nline two\u202e${'x'.repeat(300)}` } }));
  await assert.rejects(fetched, {
    message: `The "srv" server answered with an error: line one?line two?${'x'.repeat(182)}…`,
  });
  // JSON-RPC's code is an integer, but a server can send a string, and it's
  // the server's text as much as the message is.
  const again = connection.sendManifestRequest();
  const second = JSON.parse(transport.lines.at(-1)!);
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: second.id, error: { code: `E\nx\u202e${'y'.repeat(300)}`, message: 'refused' } }));
  await assert.rejects(again, {
    message: 'The "srv" server answered with an error: refused',
  });
  // The code is the operator's, so it's in the log line, escaped and cut there.
  assert.ok(lines.some((line) => line.startsWith(`MCPL server "srv" answered mcpl/manifest (id=${second.id}) with error "E\\nx\\u202e${'y'.repeat(252)}"…(304): refused`)), lines.join('\n'));
});

test('a throw from the wired tools/list_changed handler is contained, traced and logged as the other handlers\' are', (t) => {
  const { framework, connection, traces } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  framework.handleToolsListChanged = () => { throw new Error('the tool list refresh failed'); };
  connection.emit('tools-list-changed');
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'tools-list-changed');
  assert.equal(failures[0].requestId, undefined);
  assert.equal(failures[0].error, 'the tool list refresh failed');
  assert.deepEqual(lines, ['[mcpl] srv tools-list-changed handler failed: "the tool list refresh failed"']);
});

test('mcpl/manifestChanged and tools/list_changed sent as requests are answered with an empty result as they are admitted, whatever their handlers do', async (t) => {
  const { framework, connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  const manifestParams: unknown[] = [];
  framework.handleManifestChanged = async (_connection: unknown, params: unknown) => {
    manifestParams.push(params);
    throw new Error('manifest fetch failed');
  };
  const seen: Array<{ answered: number; params: unknown; responder: unknown }> = [];
  // A listener in place of the framework's tools-list-changed one, to see
  // when it runs and with what.
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', (params: unknown, responder?: unknown) => {
    seen.push({ answered: transport.lines.length, params, responder });
  });
  // An id of 0 makes a request like any other id.
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'notifications/tools/list_changed', params: { sequence: 4 } }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'mcpl/manifestChanged', params: { revision: 'r2' } }));
  await settle();
  assert.deepEqual(transport.lines.map((line) => JSON.parse(line)), [
    { jsonrpc: '2.0', id: 0, result: {} },
    { jsonrpc: '2.0', id: 0, result: {} },
  ]);
  // Each is handled as its notification is, with its params and no
  // responder, once its answer is written.
  assert.deepEqual(seen, [{ answered: 1, params: { sequence: 4 }, responder: undefined }]);
  assert.deepEqual(manifestParams, [{ revision: 'r2' }]);
  // The failed manifest refresh is reported, and answers nothing more.
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'manifest-changed');
  assert.equal(failures[0].requestId, undefined);
});

test('a request form that arrives before the framework wires the connection is answered when its plane opens', async (t) => {
  t.mock.method(console, 'error', () => {});
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  // Nothing on the host listens yet, and both planes are closed, so it's held.
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'notifications/tools/list_changed' }));
  assert.deepEqual(transport.lines, []);
  harness(connection);
  const seen: unknown[] = [];
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', (_params: unknown, responder?: unknown) => { seen.push(responder); });
  connection.ready();
  await settle();
  assert.deepEqual(transport.lines.map((line) => JSON.parse(line)), [{ jsonrpc: '2.0', id: 0, result: {} }]);
  assert.deepEqual(seen, [undefined]);
});

function stagedHarness() {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  const { framework } = harness(connection);
  const refreshed: Array<{ revision?: string }> = [];
  framework.handleManifestChanged = async (_connection: unknown, params: { revision?: string }) => { refreshed.push(params); };
  // The control plane open and the data plane paused, as in a quiesce.
  connection.readyControlPlane();
  return { connection, transport, refreshed };
}

test('a request-form mcpl/manifestChanged held while the data plane is paused is answered, and its params passed on, when the data plane opens', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { connection, transport, refreshed } = stagedHarness();
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'mcpl/manifestChanged', params: { revision: 'r2' } }));
  await settle();
  assert.deepEqual(transport.lines, [], 'held: mcpl/manifestChanged is a data-plane event');
  assert.deepEqual(refreshed, []);
  connection.ready();
  await settle();
  assert.deepEqual(transport.lines.map((line) => JSON.parse(line)), [{ jsonrpc: '2.0', id: 3, result: {} }]);
  assert.deepEqual(refreshed, [{ revision: 'r2' }]);
});

test('a request-form notifications/tools/list_changed is answered at once while the data plane is paused, since the control plane carries it', (t) => {
  t.mock.method(console, 'error', () => {});
  const { connection, transport } = stagedHarness();
  const seen: unknown[] = [];
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', (params: unknown, responder?: unknown) => { seen.push({ params, responder }); });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'notifications/tools/list_changed', params: { sequence: 9 } }));
  assert.deepEqual(transport.lines.map((line) => JSON.parse(line)), [{ jsonrpc: '2.0', id: 4, result: {} }]);
  assert.deepEqual(seen, [{ params: { sequence: 9 }, responder: undefined }]);
});

test('a request form held at the buffer cap is kept, and answered when its plane opens, while the oldest notifications are dropped', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { connection, transport, refreshed } = stagedHarness();
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'mcpl/manifestChanged', params: { revision: 'held' } }));
  // 1,100 notifications pass the cap of 1,000 held notifications by 100. The
  // request form is counted apart, against the budget for held requests.
  for (let i = 0; i < 1_100; i++) {
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'mcpl/manifestChanged', params: { revision: `n${i}` } }));
  }
  connection.ready();
  await settle();
  assert.deepEqual(transport.lines.map((line) => JSON.parse(line)), [{ jsonrpc: '2.0', id: 5, result: {} }]);
  assert.equal(refreshed.length, 1_001);
  assert.deepEqual(refreshed.slice(0, 2), [{ revision: 'held' }, { revision: 'n100' }]);
  assert.deepEqual(refreshed.at(-1), { revision: 'n1099' });
  assert.deepEqual(errors.mock.calls.map((call) => String(call.arguments[0])), [
    '[mcpl] srv: buffered-event cap (1000) — dropped 1 responder-less event(s) while the plane is paused',
    '[mcpl] srv: flushing 1001 buffered event(s) synchronously (long pause backlog; 100 dropped at cap)',
  ]);
});

test('with nothing listening for them, their request forms are still answered -32601', (t) => {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  connection.ready();
  t.mock.method(console, 'error', () => {});
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'notifications/tools/list_changed' }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'mcpl/manifestChanged' }));
  assert.deepEqual(transport.lines.map((line) => JSON.parse(line)), [
    { jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Method not found' } },
    { jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Method not found' } },
  ]);
});

test('a failed request is answered -32603 with its own id, while its trace bounds a string id and leaves out one that is neither a string nor a number', async (t) => {
  const { framework, traces, transport } = wireHarness();
  t.mock.method(console, 'error', () => {});
  framework.channelRegistry = { async handleRegister() { throw new Error('register failed'); } };
  for (const id of ['a\u0000b\nc\u202e', true]) {
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id, method: 'channels/register', params: { channels: [] } }));
  }
  await settle();
  assert.deepEqual(
    transport.lines.map((line) => JSON.parse(line)).map((reply) => [reply.id, reply.error?.code]),
    [['a\u0000b\nc\u202e', -32603], [true, -32603]],
  );
  assert.deepEqual(failureTraces(traces).map((trace) => trace.requestId), ['a?b?c?', undefined]);
});

test('the failure trace keeps a request id only when it is a string or a number, and bounds a long string', async (t) => {
  const { framework, connection, traces } = harness();
  t.mock.method(console, 'error', () => {});
  framework.channelRegistry = { async handleRegister() { throw new Error('register failed'); } };
  for (const id of [{ nested: [1] }, 'x'.repeat(2000), 0]) {
    connection.emit('channels-register', {}, { ...responder(), id });
  }
  await settle();
  assert.deepEqual(failureTraces(traces).map((trace) => trace.requestId), [undefined, `${'x'.repeat(500)}…`, 0]);
});

test('a failed internal-error reply reaches stderr too', async (t) => {
  const { framework, connection } = harness();
  framework.traceListeners = [];
  framework.channelRegistry = { async handleRegister() { throw new Error('register failed'); } };
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const reply = responder();
  reply.respondError = () => { throw new Error('internal-error reply could not be written'); };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /channels-register handler failed: "register failed"/);
  assert.match(lines[0]!, /the internal-error reply failed too: "internal-error reply could not be written"/);
  // Its failure is the internal-error reply's, not a reply write of the handler's own.
  assert.doesNotMatch(lines[0]!, /its reply write had failed/);
});

test("an 'error' listener that throws is caught and logged, and the next message still arrives", (t) => {
  const { connection, transport } = wireHarness();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(String(args[0])); });
  connection.removeAllListeners('error');
  connection.on('error', () => { throw new Error('error listener exploded'); });
  connection.prependListener('channels-list', () => { throw new Error('listener exploded'); });
  let received = false;
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', () => { received = true; });
  assert.doesNotThrow(() => transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'channels/list' })));
  assert.ok(logged.some((line) => line.includes(`an 'error' listener failed: "error listener exploded"`)), logged.join('\n'));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal(received, true);
});

test('a synchronous handler that swallows an encoding failure is reported and answered once', async () => {
  const { framework, traces } = harness();
  const listener = framework.containedInboundHandler('srv', 'test-sync', (_params: unknown, reply: any) => {
    try { reply.respond({ count: 1n }); } catch { /* swallowed, synchronously */ }
  });
  const writes: unknown[] = [];
  listener({}, {
    id: 61,
    // Encode before writing, as the connection does, so a reply that can't
    // be encoded throws with nothing sent.
    respond(result: unknown) {
      JSON.stringify(result);
      writes.push(result);
    },
    respondError(code: number, message: string) { writes.push({ code, message }); },
  });
  await settle();
  assert.deepEqual(writes, [{ code: -32603, message: 'Internal error' }]);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'test-sync');
  assert.match(failures[0].error, /BigInt/);
});

test("a stderr line whose listener throws is contained like any inbound event", (t) => {
  const { connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.prependListener('stderr', () => { throw new Error('stderr listener exploded'); });
  assert.doesNotThrow(() => transport.emit('stderr', 'a line from the server'));
  const errors = traces.filter((e) => e.type === 'mcpl:server-error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /inbound dispatch failed for stderr: stderr listener exploded/);
});

test('a rejection no printer can inspect still reaches the trace first', async (t) => {
  const { framework, connection, traces } = harness();
  // Print as console.error does: every argument goes through util.inspect.
  t.mock.method(console, 'error', (...args: unknown[]) => { for (const arg of args) inspect(arg); });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    // String() throws on it, and so does printing it.
    const hostile = {
      [inspect.custom]() { throw new Error('inspect refused'); },
      [Symbol.toPrimitive]() { throw new Error('toPrimitive refused'); },
    };
    framework.channelRegistry = { async handleRegister() { throw hostile; } };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(typeof failures[0].error, 'string');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test("a trace listener that throws a value no printer can inspect is logged as text, the listeners after it still get the trace, and nothing escapes", async (t) => {
  const { framework, connection, traces } = harness();
  // Print as console.error does: an argument that isn't a string goes
  // through util.inspect, so logging the listener's throw raw throws too.
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '));
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  // With no prototype, a template can't convert it either: only
  // describeCause's text keeps the fallback line from throwing.
  const hostile = Object.assign(Object.create(null), { [inspect.custom]() { throw new Error('inspect refused'); } });
  const offHostile = framework.onTrace(() => { throw hostile; });
  const after: any[] = [];
  const offAfter = framework.onTrace((event: unknown) => after.push(event));
  // The handler's own error can't be put in a template either, so the
  // report must convert it.
  const primary = Object.assign(new Error('register failed'), {
    [Symbol.toPrimitive]() { throw new Error('toPrimitive refused'); },
  });
  try {
    framework.channelRegistry = { async handleRegister() { throw primary; } };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
    assert.equal(failureTraces(traces).length, 1, 'the listener before the throwing one has the trace');
    assert.equal(failureTraces(after).length, 1, 'the listener after the throwing one has it too');
    // Both lines, in whichever order they're written.
    assert.deepEqual([...logged].sort(), [
      'Trace listener error: "[object Object]"',
      '[mcpl] srv channels-register handler failed: "register failed"',
    ]);
  } finally {
    offHostile();
    offAfter();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a request for an event nothing on the host listens for is answered -32601', (t) => {
  const { connection, transport } = wireHarness();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  connection.removeAllListeners('channels-list');
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'channels/list' }));
  const replies = transport.lines.map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code, r.error?.message]), [[71, -32601, 'Method not found']]);
  assert.deepEqual(logged, ['[mcpl] srv: answered -32601 to channels-list, which nothing on this host handles']);
});

test("a long handler error is bounded in its trace, and its log line is cut with its length", async (t) => {
  const { framework, connection, traces } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  framework.channelRegistry = { async handleRegister() { throw new Error('x'.repeat(5000)); } };
  connection.emit('channels-register', {}, responder());
  await settle();
  const failure = traces.find((e) => e.type === 'mcpl:request-handler-error');
  assert.equal(failure?.error, `${'x'.repeat(500)}…`);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.length < 600, `logged ${lines[0]!.length} characters`);
  assert.ok(lines[0]!.endsWith('…(5000)'), lines[0]!.slice(-40));
});

test("the log line prints a failed reply write and a refused answer raw, and only the trace's copies are bounded", async (t) => {
  const { framework, connection, traces } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      // The first write throws, sending nothing; the second is written; the
      // third is refused.
      try { reply.respond({ registered: [] }); } catch { /* swallowed */ }
      reply.respond({ registered: [] });
      reply.respondError(-32602, 'second\u0007answer');
      throw new Error('handler\u0007failed');
    },
  };
  const reply = responder();
  const respond = reply.respond;
  let first = true;
  reply.respond = (result: unknown) => {
    if (first) { first = false; throw new Error('write\u0007broke'); }
    respond(result);
  };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.errors.length, 0, 'the written answer stands: no internal-error reply follows it');
  const failure = failureTraces(traces)[0];
  assert.equal(failure.responseAttempted, true);
  assert.equal(failure.error, 'handler?failed');
  assert.equal(failure.responseFailure, 'write?broke');
  assert.deepEqual(failure.refusedResponse, { kind: 'error', code: -32602, message: 'second?answer' });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes('handler failed: "handler\\u0007failed"'), lines[0]);
  assert.ok(lines[0]!.includes('its reply write had failed: "write\\u0007broke"'), lines[0]);
  assert.ok(lines[0]!.includes('it then tried to answer again with "error -32602: second\\u0007answer"'), lines[0]);
});

test('an answer the handler tried after its first, with a code no template can convert, is printed with describeCause\'s text for the code, and nothing escapes', async (t) => {
  const { framework, connection, traces } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  // A code with no prototype: a template throws on it.
  const code = Object.create(null) as number;
  try {
    framework.channelRegistry = {
      async handleRegister(_server: string, _params: unknown, reply: any) {
        reply.respond({ registered: [] });
        reply.respondError(code, 'again');
        throw new Error('register failed');
      },
    };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.equal(failureTraces(traces).length, 1);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes('handler failed: "register failed"'), lines[0]);
    assert.ok(lines[0]!.includes('it then tried to answer again with "error [object Object]: again"'), lines[0]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a throw out of the report on the async path is caught by its backstop and logged on a line of its own, and nothing escapes', async (t) => {
  const { framework, connection } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  // A defect in the report itself: its trace throws, with a text that
  // would print a second line raw.
  framework.emitTrace = () => { throw new Error('the trace failed\n[mcpl] srv forged'); };
  try {
    framework.channelRegistry = { async handleRegister() { throw new Error('register failed'); } };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }], 'the reply is sent before the trace');
    assert.deepEqual(lines, ["[mcpl] srv channels-register: the handler failure's report threw: \"the trace failed\\n[mcpl] srv forged\""]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a backstop whose own log line throws leaves nothing unhandled', async (t) => {
  const { framework, connection } = harness();
  t.mock.method(console, 'error', () => { throw new Error('the console is gone'); });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  framework.emitTrace = () => { throw new Error('the trace failed'); };
  try {
    framework.channelRegistry = { async handleRegister() { throw new Error('register failed'); } };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test("the log line prints a failed internal-error reply raw, and only the trace's copy is bounded", async (t) => {
  const { framework, connection, traces } = harness();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  framework.channelRegistry = { async handleRegister() { throw new Error('original failure'); } };
  const reply = responder();
  reply.respondError = () => { throw new Error('send\u0007failed'); };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(failureTraces(traces)[0].responseError, 'send?failed');
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes('the internal-error reply failed too: "send\\u0007failed"'), lines[0]);
});

test('a value printing cannot handle still leaves a stderr line naming the failure', async (t) => {
  const { framework, connection } = harness();
  framework.traceListeners = [];
  const lines: string[] = [];
  // Print as console.error does, and keep what it printed.
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map((a) => typeof a === 'string' ? a : inspect(a)).join(' ')); });
  const hostile = {
    [inspect.custom]() { throw new Error('inspect refused'); },
    toString() { return 'the hostile failure'; },
  };
  framework.channelRegistry = { async handleRegister() { throw hostile; } };
  connection.emit('channels-register', {}, responder());
  await settle();
  assert.equal(lines.length, 1);
  // The line is built from strings through log-value, so nothing inspects the value.
  assert.match(lines[0]!, /channels-register handler failed: "the hostile failure"$/);
});

test('log text from a server has control, format and separator characters replaced', (t) => {
  const { connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.prependListener('channels-list', () => { throw new Error('a\u2028b\u202ec\u0007d'); });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'channels/list' }));
  const errors = traces.filter((e) => e.type === 'mcpl:server-error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /: a\?b\?c\?d$/);
});
