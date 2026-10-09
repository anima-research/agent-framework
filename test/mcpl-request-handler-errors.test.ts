import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { InferenceRouter } from '../src/mcpl/inference-router.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';

function harness(connection = Object.assign(new EventEmitter(), { id: 'srv' })) {
  const traces: any[] = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.traceListeners = [(event: unknown) => traces.push(event)];
  framework.wireMcplEvents(connection);
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
    await settle();

    assert.equal(reply.results.length, 1, 'ACK still precedes reconciliation');
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
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'handler failed before response', data: undefined }]);
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].event, event);
    assert.equal(failures[0].responseAttempted, false);
  });
}

test('notification rejection is traced without inventing a response', async () => {
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
  assert.equal(reply.errors.length, 1);
  assert.equal(failureTraces(traces).length, 1);
});

test('a throwing success response is not retried as an error response', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { descriptorsForServer() { return []; } };
  const reply = responder();
  let writes = 0;
  reply.respond = () => { writes++; throw new Error('response transport failed'); };
  assert.doesNotThrow(() => connection.emit('channels-list', {}, reply));
  await settle();
  assert.equal(writes, 1);
  assert.equal(reply.errors.length, 0);
  assert.equal(failureTraces(traces)[0].responseAttempted, true);
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

test('inference responders retain request IDs and successful handling stays synchronous', async () => {
  const { framework, connection, traces } = harness();
  framework.inferenceRouter = {
    handleInferenceRequest(_server: string, _params: unknown, reply: any) {
      assert.equal(reply.requestId, 17);
      reply.respond({ accepted: true });
    },
  };
  const reply = responder();
  connection.emit('inference-request', {}, reply);
  assert.deepEqual(reply.results, [{ accepted: true }]);
  await settle();
  assert.equal(reply.errors.length, 0);
  assert.equal(failureTraces(traces).length, 0);
});

test('real inference handler cannot turn a failed result write into a second response', async () => {
  const { framework, connection, traces } = harness();
  framework.inferenceRouter = new InferenceRouter(
    {
      async complete() {
        return {
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as never,
    { isInHook: false } as never,
    { validateInbound() {} } as never,
    null,
    (event) => traces.push(event),
  );
  const reply = responder();
  let resultWrites = 0;
  reply.respond = () => { resultWrites++; throw new Error('partially written result'); };
  connection.emit('inference-request', {
    featureSet: 'test', messages: [{ role: 'user', content: 'hello' }],
  }, reply);
  await settle();
  assert.equal(resultWrites, 1);
  assert.equal(reply.errors.length, 0, 'the inner inference catch must not send another reply');
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /partially written result/);
  assert.equal(failures[0].responseAttempted, true);
});

test('a swallowed response-write failure still produces a diagnostic', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      try { reply.respond({}); } catch { /* Simulate a handler swallowing a transport error. */ }
    },
  };
  const reply = responder();
  reply.respond = () => { throw new Error('swallowed write failure'); };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.errors.length, 0);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /swallowed write failure/);
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

test('host command response-write failure is traced without a second reply', async () => {
  const { framework, connection, traces } = harness();
  framework.handleHostCommand = async () => ({ done: true });
  const reply = responder();
  reply.respond = () => { throw new Error('host response failed'); };
  connection.emit('host-command', {}, reply);
  await settle();
  assert.equal(reply.errors.length, 0);
  assert.match(failureTraces(traces)[0].error, /host response failed/);
});

class ResponseTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  failWrite = false;
  writeLine(line: string): void {
    this.lines.push(line);
    if (this.failWrite) throw new TypeError('transport failed after a partial write');
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
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].responseAttempted, false);
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
});

test('a real transport write failure remains single-attempt after serialization', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.handleHostCommand = async () => ({ maintained: true });
  transport.failWrite = true;
  request();
  await settle();
  assert.equal(transport.lines.length, 1, 'a possibly partial write must not get a second reply');
  assert.deepEqual(JSON.parse(transport.lines[0]!).result, { maintained: true });
  assert.equal(failureTraces(traces)[0].responseAttempted, true);
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
  assert.match(String(errors[0]?.[0]), /srv.*channels-register/);
  assert.match(String(errors[0]?.[1]), /headless reconciliation failed/);
});

for (const mode of ['handshake', 'connected', 'throwing-listener']) {
  test('separate stdio host survives inbound ' + mode + ' faults and processes later messages', () => {
    const probe = spawnSync(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./fixtures/mcpl-inbound-host-probe.mjs', import.meta.url)), mode,
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /continued/);
  });
}

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

for (const value of [null, 42, 'hi', true]) {
  test('non-object inbound ' + JSON.stringify(value) + ' is ignored like a non-JSON line, with no failure report', (t) => {
    const { connection, transport } = wireHarness();
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const reported: unknown[] = [];
    connection.on('error', (error: unknown) => { reported.push(error); });
    transport.emit('line', JSON.stringify(value));
    assert.deepEqual(errors, []);
    assert.deepEqual(reported, []);
  });
}

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
});

test('tools-observe: a synchronous failure is answered with one internal error', async () => {
  const { connection, traces } = harness();
  Object.defineProperty(connection, 'toolObserveFilter', { set() { throw new Error('filter store failed'); } });
  const reply = responder();
  assert.doesNotThrow(() => connection.emit('tools-observe', { rules: [] }, reply));
  await settle();
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'filter store failed', data: undefined }]);
  assert.equal(failureTraces(traces).length, 1);
});

test('model-info: a throwing error write is traced without escaping or a second write', async () => {
  const { connection, traces } = harness();
  const reply = responder();
  let writes = 0;
  reply.respondError = () => { writes++; throw new Error('response transport failed'); };
  assert.doesNotThrow(() => connection.emit('model-info', {}, reply));
  await settle();
  assert.equal(writes, 1);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].responseAttempted, true);
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
});
