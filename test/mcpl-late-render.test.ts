/**
 * A push/render answered after its timeout (#398, RFC-006 §5.3–§5.4). The host
 * has materialized the batch's fallback by then, and the late result is
 * discarded, which RFC-006 §11 asks a host that keeps an audit record to
 * record, linked by eventId. The connection reports it as an orphaned
 * response naming the render's featureSet, key, eventId and, for a
 * channel-scoped subject, channelId, with a late JSON-RPC error as `error`,
 * and the framework's wiring records it beside the coalescer's other records,
 * as a mcpl:coalescing late-render. orphaned-response is a control-plane
 * event, so a paused data plane neither holds it nor spends a slot of its
 * bound on it. A late tool call stays a mcpl:orphaned-response.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { PushRenderParams } from '../src/mcpl/push-coalescer.js';

class LineTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void { this.lines.push(line); }
  async close(): Promise<void> {}
}

const RENDER: PushRenderParams = { featureSet: 'fs', key: 'k1', eventId: 'e7', notices: [], dropped: 0 };

/** A real connection, wired by the framework, whose push/render has timed out. */
async function timedOutRender(t: TestContext, params: PushRenderParams = RENDER) {
  const transport = new LineTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  const traces: Array<{ type: string; [key: string]: unknown }> = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.traceListeners = [];
  framework.onTrace((event: never) => traces.push(event));
  framework.wireMcplEvents(connection, { id: 'srv' });
  const orphans: unknown[] = [];
  connection.on('orphaned-response', (info: unknown) => orphans.push(info));
  connection.ready();
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const render = connection.sendPushRender(params);
  const { id } = JSON.parse(transport.lines[0]!) as { id: number };
  t.mock.timers.tick(5_000);
  await assert.rejects(render, /didn't answer within/);
  const answerLate = (answer: object = { result: { content: [{ type: 'text', text: 'late' }] } }) =>
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
  const recorded = () => traces
    .filter((e) => e.type === 'mcpl:coalescing' || e.type === 'mcpl:orphaned-response')
    .map(({ timestamp: _timestamp, ...rest }) => rest);
  return { connection, transport, traces, orphans, id, answerLate, recorded };
}

const lateRender = { type: 'mcpl:coalescing', kind: 'late-render', serverId: 'srv', eventId: 'e7', featureSet: 'fs', key: 'k1', discarded: true };

test('a push/render answered after its timeout is recorded as a discarded late-render, linked by its eventId', async (t) => {
  const { orphans, id, answerLate, recorded } = await timedOutRender(t);
  answerLate();
  // The connection's one event for a response whose request timed out.
  assert.deepEqual(orphans, [{ id, method: 'push/render', hadState: false, hadCheckpoint: false, featureSet: 'fs', key: 'k1', eventId: 'e7' }]);
  assert.deepEqual(recorded(), [lateRender]);
});

test('a late push/render error is recorded as a late-render with its code and message, and a late null result as a late-render', async (t) => {
  const failed = await timedOutRender(t);
  failed.answerLate({ error: { code: -32603, message: 'render exploded' } });
  assert.deepEqual(failed.orphans, [{
    id: failed.id, method: 'push/render', hadState: false, hadCheckpoint: false, featureSet: 'fs', key: 'k1', eventId: 'e7',
    error: { code: -32603, message: 'render exploded' },
  }]);
  assert.deepEqual(failed.recorded(), [{ ...lateRender, error: '[-32603] render exploded' }]);
  t.mock.timers.reset();
  const empty = await timedOutRender(t);
  empty.answerLate({ result: null });
  assert.deepEqual(empty.recorded(), [lateRender]);
});

test("a late error's text is recorded with its control characters replaced, cut to 500 code points", async (t) => {
  const { answerLate, recorded } = await timedOutRender(t);
  answerLate({ error: { code: -32603, message: `line one\nline two\u202e${'x'.repeat(600)}` } });
  const head = '[-32603] line one?line two?';
  assert.deepEqual(recorded(), [{ ...lateRender, error: `${head}${'x'.repeat(500 - head.length)}…` }]);
});

test("a channel-scoped push/render answered late names its channel", async (t) => {
  const { answerLate, recorded } = await timedOutRender(t, { ...RENDER, featureSet: '', channelId: 'discord:guild:42' });
  answerLate();
  assert.deepEqual(recorded(), [{ ...lateRender, featureSet: '', channelId: 'discord:guild:42' }]);
});

test('a late answer to a tool call whose deadline passed is still recorded as mcpl:orphaned-response, never as a late-render, with its error when it was one', async (t) => {
  const { connection, transport, recorded } = await timedOutRender(t);
  const lateCall = async () => {
    const call = connection.sendToolsCallWithDeadline('stuck', {}, 75);
    const { id } = JSON.parse(transport.lines.at(-1)!) as { id: number };
    t.mock.timers.tick(75);
    await assert.rejects(call, /whether the request took effect is unknown/);
    return id;
  };
  const answered = await lateCall();
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: answered, result: { content: [] } }));
  const failed = await lateCall();
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: failed, error: { code: -32603, message: 'tool failed' } }));
  assert.deepEqual(recorded(), [
    { type: 'mcpl:orphaned-response', serverId: 'srv', responseId: answered, method: 'tools/call', hadState: false, hadCheckpoint: false },
    { type: 'mcpl:orphaned-response', serverId: 'srv', responseId: failed, method: 'tools/call', hadState: false, hadCheckpoint: false, error: '[-32603] tool failed' },
  ]);
});

test('a late answer carrying both a result and an error, which JSON-RPC forbids, keeps its error in the record', async (t) => {
  const { connection, transport, answerLate, recorded } = await timedOutRender(t);
  const both = { result: { content: [], state: { step: 2 } }, error: { code: -32603, message: 'tool failed' } };
  answerLate(both);
  const call = connection.sendToolsCallWithDeadline('stuck', {}, 75);
  const { id } = JSON.parse(transport.lines.at(-1)!) as { id: number };
  t.mock.timers.tick(75);
  await assert.rejects(call, /whether the request took effect is unknown/);
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id, ...both }));
  assert.deepEqual(recorded(), [
    { ...lateRender, error: '[-32603] tool failed' },
    { type: 'mcpl:orphaned-response', serverId: 'srv', responseId: id, method: 'tools/call', hadState: true, hadCheckpoint: false, error: '[-32603] tool failed' },
  ]);
});

test('while the data plane is paused, a late push/render answer is recorded at once and takes no slot', async (t) => {
  const { connection, answerLate, recorded } = await timedOutRender(t);
  // A quiesce: control traffic flows, data is held.
  connection.pauseDataPlane();
  answerLate();
  assert.equal((connection as any).bufferedEvents.length, 0);
  assert.deepEqual(recorded(), [lateRender]);
});
