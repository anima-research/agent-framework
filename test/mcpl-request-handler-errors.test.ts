import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { InferenceRouter } from '../src/mcpl/inference-router.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';

function harness() {
  const traces: any[] = [];
  const connection = Object.assign(new EventEmitter(), { id: 'srv' });
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
