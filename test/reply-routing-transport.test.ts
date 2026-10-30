import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { type AdmissionInput } from '../src/mcpl/inbound-admission.js';
import { workOf, replyWork } from '../src/mcpl/reply-routing.js';
import { HeldStream, MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { eventually } from './helpers/coalescing-fixture.js';
const peer = fileURLToPath(new URL('./fixtures/reply-routing-server.mjs', import.meta.url));
const at = (channelId = 'room/one', serverId = 'endpoint-a') => ({ serverId, channelId });
const incoming = (id: string, target = 'room/one', channelId = target) => ({
  channelId, messageId: id, timestamp: '2026-01-01T00:00:00Z', author: { id: 'person', name: 'Person' },
  tags: ['chat:mention'], content: [{ type: 'text', text: id }],
  metadata: { replyIntent: { channelId: 'room/other' } },
});
const admission = (readOnly = false) => ({ timeoutMs: 1000, bind: (connection: any) => ({ connection, admit: (input: AdmissionInput) => {
  const item = input.item as any;
  return { store: true as const, mayWake: !readOnly, replyIntent: {
    channelId: item.channelId ?? item.origin?.mcplChannelId ?? 'room/one',
  } };
} }), isReplyIntent: () => true });
class PerTurn extends MockMembrane {
  override streamYielding(request: any) { this.calls.push(request); return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answer' }])]); }
}
async function wire(overrides: Record<string, any> = {}, frameworkConfig: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reply-routing-wire-'));
  const membrane = new PerTurn();
  let framework: AgentFramework;
  try {
    framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      ...frameworkConfig,
      mcplServers: ['endpoint-a', 'endpoint-b'].map(id => ({ id, command: process.execPath, args: [peer], enabledFeatureSets: ['feed'],
        inboundAdmission: admission(), replyAuthority: { timeoutMs: 1000, authorize: () => true, resolve: (input: any) => input.replyIntent }, ...overrides })),
    });
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  const f = framework as any;
  const connection = (id = 'endpoint-a') => f.mcplServerRegistry.getServer(id) as McplServerConnection;
  const send = (method: string, params: unknown, id = 'endpoint-a'): Promise<any> => connection(id).sendToolsCall('send', { method, params });
  const seen = async (id = 'endpoint-a'): Promise<any[]> => connection(id).sendToolsCall('seen', {}) as unknown as Promise<any[]>;
  for (const id of ['endpoint-a', 'endpoint-b']) await send('channels/register', { channels: ['room/one', 'room/other', 'topic:one', 'topic:two', 'topic:second', 'topic:live', 'topic:push/β', 'topic:module', 'topic:endpoint-a', 'topic:endpoint-b', 'topic:endpoint-a/β', 'topic:endpoint-b/β'].map(id => ({ id, type: 'synthetic', label: id, open: true })) }, id);
  const published = async (count: number, id = 'endpoint-a') => {
    const deadline = Date.now() + 10000;
    let sends: any[] = [];
    while (Date.now() < deadline) {
      sends = (await seen(id)).filter(e => e.method === 'channels/publish');
      if (sends.length >= count) return sends;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail(`expected ${count} publications on ${id}, got ${sends.length}`);
  };
  return { framework, f, membrane, connection, send, seen, published, async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('real stdio: two opted-in connections freeze their own channel and registered channel', async t => {
  const x = await wire(); t.after(x.close);
  for (const id of ['endpoint-a', 'endpoint-b']) {
    const r = await x.send('channels/incoming', { messages: [incoming(id, `topic:${id}/β`)] }, id);
    assert.equal(r.result.results[0].accepted, true);
  }
  await x.framework.runUntilIdle();
  assert.equal(x.membrane.calls.length, 2);
  for (const id of ['endpoint-a', 'endpoint-b']) {
    const seen = await x.seen(id);
    const sends = seen.filter(e => e.method === 'channels/publish');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].params.channelId, `topic:${id}/β`);
    assert.equal(JSON.stringify(sends).includes('replyIntent'), false);
  }
});

test('real stdio: unconfigured connections keep slice-A automatic routing', async t => {
  const x = await wire({ replyAuthority: undefined }); t.after(x.close);
  assert.equal((await x.send('channels/incoming', { messages: [incoming('ordinary')] })).result.results[0].accepted, true);
  await x.framework.runUntilIdle();
  assert.equal((await x.published(1))[0].params.channelId, 'room/one');
});

for (const destination of [null, { channelId: 'absent' }, { channelId: 'room/one', serverId: 'endpoint-b' }, { channelId: 'room/one', extra: true }]) {
  test(`real stdio: invalid destination ${JSON.stringify(destination)} stays admitted and private`, async t => {
    const x = await wire({ replyAuthority: { timeoutMs: 1000, authorize: () => true, resolve: () => destination } }); t.after(x.close);
    const r = await x.send('channels/incoming', { messages: [incoming('admitted-private')] });
    assert.equal(r.result.results[0].accepted, true);
    await x.framework.runUntilIdle(); assert.equal(x.membrane.calls.length, 1);
    assert.equal((await x.seen()).filter(e => e.method === 'channels/publish').length, 0);
    assert(JSON.stringify(x.membrane.calls).includes('prose stays private'));
    assert(JSON.stringify(x.framework.getAgent('assistant')!.getContextManager().getAllMessages()).includes('admitted-private'));
  });
}

test('real stdio: read-only arrival on another channel cannot repin a live bound turn', async t => {
  let readOnly = false;
  const base = admission();
  const x = await wire({ inboundAdmission: { ...base, bind: (connection: any) => {
    const bound = base.bind(connection); return { connection, admit: (input: AdmissionInput) => ({ ...bound.admit(input), mayWake: !readOnly }) };
  } } }); t.after(x.close);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  x.membrane.streamYielding = request => { x.membrane.calls.push(request); return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'bound answer' }])]); };
  await x.send('channels/incoming', { messages: [incoming('opening')] }); x.framework.start();
  await eventually(() => x.membrane.calls.length === 1);
  const open = x.f.openLogical.get('assistant'); const binding = open.reply;
  readOnly = true;
  assert.equal((await x.send('channels/incoming', { messages: [incoming('stored-only', 'other', 'room/other')] })).result.results[0].accepted, true);
  await eventually(() => JSON.stringify(x.framework.getAgent('assistant')!.getContextManager().getAllMessages()).includes('stored-only') || x.f.deferredMessages.some((row: any) => JSON.stringify(row).includes('stored-only')));
  assert.equal(open.reply, binding); assert.equal(open.locus.channelId, 'room/one');
  release(); await eventually(() => !x.f.openLogical.has('assistant'));
  const sends = await x.published(1);
  assert.equal(sends.length, 1); assert.equal(sends[0].params.channelId, 'room/one');
});

for (const mode of ['locus', 'hybrid']) for (const bound of [true, false]) test(`N1: successful all-except agent-tool preserves frozen reply with injected null locus (${bound}, ${mode})`, async t => {
  const x = await wire({}, { tuneOut: { enabled: true }, agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting: mode }] }); t.after(x.close);
  const open = x.f.routingOf('assistant'); x.f.openLogical.set('assistant', open);
  if (bound) {
    // Actual ingress mints the binding, then private scaffolding installs only the open-turn precondition.
    await x.send('channels/incoming', { messages: [incoming('cause')] });
    const event = await x.f.queue.pop();
    const work = workOf(event);
    assert.equal(work.length, 1);
    open.reply = work[0];
  }
  open.locus = null;
  const binding = open.reply;
  const result = await x.f.handleTuneOutTool('assistant', { scope: 'all-except', channelId: 'room/other', serverId: 'endpoint-a', durationSeconds: 120 }, [], open);
  assert.equal(result.success, true, result.error);
  assert.equal(open.reply, binding);
  if (bound) assert.equal(open.locus, null); else assert.equal(open.locus.channelId, 'room/other');
  assert.equal(x.f.tuneOutCoordinator.getAllExcept().params.except.channelId, 'room/other');
});

for (const mode of ['locus', 'explicit', 'conflict', 'no-turn', 'silent', 'disabled', 'heartbeat', 'off'] as const) test(`N2: actual sleep announcement uses its frozen binding (${mode})`, async t => {
  const x = await wire({}, { gate: { config: { policies: [] }, judge: { enabled: false } } }); t.after(x.close);
  await x.send('channels/incoming', { messages: [incoming('cause')] });
  const event = await x.f.queue.pop(); const binding = workOf(event)[0]; assert(binding);
  const open = x.f.routingOf('assistant'); open.reply = binding; open.locus = at(); open.pin = at(mode === 'conflict' ? 'room/other' : 'room/one');
  if (mode !== 'no-turn') x.f.openLogical.set('assistant', open);
  if (mode === 'silent') x.f.activeTurnTriggers.set('assistant', { suppressProse: true });
  if (mode === 'heartbeat') { open.heartbeat = true; delete open.locus; }
  const agent = x.framework.getAgent('assistant')! as any;
  agent.proseRouting = mode === 'explicit' || mode === 'conflict' ? 'explicit' : mode === 'disabled' ? 'disabled' : 'locus';
  // Drive the actual channel-open tool before announcing; it must succeed without moving the binding.
  x.f.dispatchChannelToolCall('assistant', { id: 'open-before-sleep', name: 'channel_open', input: { channelId: 'endpoint-a:room/other' }, callerTurnId: open.turnId });
  await eventually(() => x.f.queue.queue.some((event: any) => event.type === 'tool-result' && event.callId === 'open-before-sleep'));
  const opened = x.f.queue.queue.find((event: any) => event.type === 'tool-result' && event.callId === 'open-before-sleep');
  assert.equal(opened.result.success, true);
  // A different channel became the registry default after the turn was frozen.
  x.f.channelRegistry.noteDelivered(at('room/other'), 'later', 'later-context');
  x.f.dispatchSleepToolCall('assistant', { id: 'sleep-call', name: 'sleep', input: { seconds: 60, announce: mode !== 'off' }, ...(mode === 'no-turn' ? {} : { callerTurnId: open.turnId }) });
  // seen is a wire round-trip after the fire-and-forget announcement; poll only where one is expected.
  let sends: any[] = [];
  for (let i = 0; i < 100; i++) {
    sends = (await x.seen()).filter(e => e.method === 'channels/publish');
    if (sends.length || !['locus', 'explicit'].includes(mode)) break;
    await new Promise(r => setTimeout(r, 10));
  }
  if (mode === 'locus' || mode === 'explicit') {
    assert.equal(sends.length, 1); assert.equal(sends[0].params.channelId, 'room/one');
  } else assert.equal(sends.length, 0);
});

for (const outcome of ['throw', 'timeout', 'close', 'stop'] as const) test(`real stdio: routing consumer ${outcome} releases admission without effects`, async t => {
  let entered = false;
  let signal: AbortSignal | undefined;
  let release!: (v: any) => void;
  const waiting = new Promise(resolve => { release = resolve; });
  const x = await wire({ inboundAdmission: { ...admission(), timeoutMs: outcome === 'timeout' ? 50 : 1000 }, replyAuthority: {
    timeoutMs: outcome === 'timeout' ? 50 : 1000, authorize: () => true, resolve: (input: any) => {
      entered = true; signal = input.signal;
      if (outcome === 'throw') throw Error('private error');
      return waiting;
    },
  } }); t.after(x.close);
  const connection = x.connection();
  const pending = x.send('channels/incoming', { messages: [incoming('refused-body')] });
  const settled = pending.catch(() => undefined);
  await eventually(() => entered);
  if (outcome === 'close') await connection.close();
  if (outcome === 'stop') await x.framework.stop();
  const response = await settled;
  if (outcome === 'throw' || outcome === 'timeout') {
    assert.equal(response.result.results[0].accepted, true);
    await x.framework.runUntilIdle();
  }
  assert.equal((connection.requiredAdmission as any).pending.size, 0);
  if (outcome !== 'throw') assert.equal(signal?.aborted, true);
  release({ channelId: 'room/one' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal((connection.requiredAdmission as any).pending.size, 0);
  assert.equal(x.membrane.calls.length, outcome === 'throw' || outcome === 'timeout' ? 1 : 0);
});

test('real stdio: queued reply cannot publish to a replacement registration', async t => {
  const x = await wire(); t.after(x.close);
  await x.send('channels/incoming', { messages: [incoming('old-registration')] });
  await x.send('channels/register', { channels: [{ id: 'room/one', type: 'synthetic', label: 'Replacement' }] });
  await x.framework.runUntilIdle();
  assert.equal((await x.seen()).filter(e => e.method === 'channels/publish').length, 0);
});

test('real stdio: hint-free push carries the admitted destination', async t => {
  const x = await wire(); t.after(x.close);
  const r = await x.send('push/event', { featureSet: 'feed', eventId: 'push-one', timestamp: '2026-01-01T00:00:00Z',
    origin: { mcplChannelId: 'room/one' }, payload: { content: [{ type: 'text', text: 'push reply' }] }, tags: ['chat:mention'] });
  assert.equal(r.result.accepted, true);
  await x.framework.runUntilIdle();
  const sends = (await x.seen()).filter(e => e.method === 'channels/publish');
  assert.equal(sends.length, 1); assert.equal(sends[0].params.channelId, 'room/one');
});

test('real stdio: debounce preserves two separate admitted reply destinations', async t => {
  const x = await wire({}, { gate: { judge: { enabled: false }, config: { policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 20 } }], default: 'skip' } } }); t.after(x.close);
  await x.send('channels/incoming', { messages: [incoming('one', 'topic:one'), incoming('two', 'topic:two')] });
  x.framework.start();
  await eventually(() => x.membrane.calls.length === 2);
  await eventually(() => !x.f.openLogical.has('assistant'));
  const sends = await x.published(2);
  assert.deepEqual(sends.map(e => e.params.channelId), ['topic:one', 'topic:two']);
});

test('real stdio: concurrent turns on different agents retain colliding channel identities', async t => {
  const x = await wire({}, { agents: ['assistant', 'second'].map(name => ({ name, model: 'test', systemPrompt: 'test' })) }); t.after(x.close);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  x.membrane.streamYielding = request => { x.membrane.calls.push(request); return new HeldStream(held, [createMockResponse([{ type: 'text', text: 'answer' }])]); };
  for (const [id, agent] of [['endpoint-a', 'assistant'], ['endpoint-b', 'second']]) {
    await x.send('channels/incoming', { messages: [incoming(agent!, `topic:${id}`)] }, id);
    // Private scaffolding supplies host-side fanout; this is not a wire authorization field.
    const event = x.f.queue.queue.find((e: any) => e.serverId === id && workOf(e).length);
    assert(event); event.targetAgents = [agent];
  }
  x.framework.start(); await eventually(() => x.f.openLogical.size === 2);
  assert.equal(x.membrane.calls.length, 2); release();
  await eventually(() => x.f.openLogical.size === 0);
  for (const id of ['endpoint-a', 'endpoint-b']) {
    const sends = await x.published(1, id);
    assert.equal(sends.length, 1); assert.equal(sends[0].params.channelId, `topic:${id}`);
  }
});

// Integration with the shared model/awaited tool dispatcher and pending module startup.
test('real stdio: model sleep dispatch announces only in the admitted channel', async t => {
  const x = await wire({}, { gate: { config: { policies: [] }, judge: { enabled: false } } }); t.after(x.close);
  x.membrane.streamYielding = request => {
    x.membrane.calls.push(request);
    // Change the default after a real admitted turn has opened, before its tool dispatch.
    x.f.channelRegistry.noteDelivered(at('room/other'), 'later', 'topic:later');
    return new MockYieldingStream([createMockResponse([
      { type: 'tool_use', id: 'sleep-bound', name: 'sleep', input: { seconds: 60, message: 'bound sleep' } },
    ], 'tool_use')]);
  };
  assert.equal((await x.send('channels/incoming', { messages: [incoming('sleep-cause')] })).result.results[0].accepted, true);
  await x.framework.runUntilIdle();
  const sends = await x.published(1);
  assert.equal(x.membrane.calls.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.channelId, 'room/one');
  assert.equal(sends[0].params.channelId, 'room/one');
  assert.equal((await x.seen('endpoint-b')).filter(e => e.method === 'channels/publish').length, 0);
});

test('real stdio: awaited sleep cannot borrow a live admitted turn to announce', async t => {
  const x = await wire({}, { gate: { config: { policies: [] }, judge: { enabled: false } } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await x.close(); });
  x.membrane.streamYielding = request => {
    x.membrane.calls.push(request);
    return new HeldStream(held, [createMockResponse([{ type: 'text', text: 'bound answer' }])]);
  };
  await x.send('channels/incoming', { messages: [incoming('held-cause')] });
  x.framework.start();
  await eventually(() => x.membrane.calls.length === 1);
  const open = x.f.openLogical.get('assistant');
  const binding = open.reply; assert(binding);
  x.f.channelRegistry.noteDelivered(at('room/other'), 'later', 'topic:later');
  const answer = await x.framework.executeToolCall({ id: 'awaited-sleep', name: 'sleep',
    input: { seconds: 60, message: 'must not be sent' }, callerAgentName: 'assistant' });
  assert.equal(answer.success, true);
  assert.equal(answer.endTurn, true);
  assert.equal(x.f.openLogical.get('assistant'), open);
  assert.equal(open.reply, binding);
  assert.equal((await x.seen()).filter(e => e.method === 'channels/publish').length, 0);
  const wake = await x.framework.executeToolCall({ id: 'awaited-wake', name: 'wake', input: {}, callerAgentName: 'assistant' });
  assert.equal(wake.success, true);
  release();
  await eventually(() => !x.f.openLogical.has('assistant'));
  const sends = await x.published(1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.channelId, 'room/one');
  assert.equal(sends[0].params.channelId, 'room/one');
});

test('real stdio: pending module start does not delay routing consumer cancellation on stop', async t => {
  let signal: AbortSignal | undefined;
  let releaseRoute!: (value: any) => void;
  const route = new Promise(resolve => { releaseRoute = resolve; });
  const x = await wire({ inboundAdmission: { ...admission(), timeoutMs: 60000 }, replyAuthority: {
    timeoutMs: 1000, authorize: () => true, resolve: (input: any) => { signal = input.signal; return route; },
  } });
  let releaseStart!: () => void;
  const starting = new Promise<void>(resolve => { releaseStart = resolve; });
  let entered = false, moduleStopped = false, frameworkStopped = false;
  t.after(async () => { releaseStart(); releaseRoute({ channelId: 'room/one' }); await x.close(); });
  const adding = x.framework.addModule({ name: 'pending-start',
    async start() { entered = true; await starting; },
    async stop() { moduleStopped = true; },
    async onProcess() { return {}; }, getTools: () => [],
    async handleToolCall() { throw Error('No tool calls expected'); },
  }).then(() => undefined, error => error);
  await eventually(() => entered);
  const connection = x.connection();
  const pending = x.send('channels/incoming', { messages: [incoming('cancel-before-start-settles')] }).catch(() => undefined);
  await eventually(() => signal !== undefined);
  const stopping = x.framework.stop().then(() => { frameworkStopped = true; });
  await eventually(() => signal!.aborted);
  assert.equal((connection.requiredAdmission as any).pending.size, 0);
  assert.equal(moduleStopped, false);
  assert.equal(frameworkStopped, false);
  assert.equal(x.membrane.calls.length, 0);
  releaseStart();
  const error = await adding;
  assert(error instanceof Error);
  assert.match(error.message, /addModule\(\) refused: the framework is stopping/);
  await stopping; await pending;
  assert.equal(moduleStopped, true);
  releaseRoute({ channelId: 'room/one' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((connection.requiredAdmission as any).pending.size, 0);
  assert.equal(x.membrane.calls.length, 0);
});

for (const resolver of ['null', 'throw'] as const) for (const held of [false, true]) {
  test(`real stdio: direct inference bypasses ${resolver} resolver (held=${held})`, async t => {
    let calls = 0;
    const x = await wire({ replyAuthority: { timeoutMs: 1000, authorize: () => true, resolve: () => {
      calls++;
      if (resolver === 'throw') throw Error('resolver is only for automatic replies');
      return null;
    } } }); t.after(x.close);
    x.f.inferenceRouter.resolveModel = () => 'test';
    if (held) await x.framework.quiesce({ reason: 'test' });
    const result = x.send('inference/request', { featureSet: 'feed', messages: [{ role: 'user', content: 'direct answer' }] });
    if (held) {
      await eventually(() => (x.connection() as any).bufferedEvents.length === 1);
      await x.framework.resume();
    }
    const response = await result;
    assert.equal(calls, 0, 'direct RPC answers must not resolve a channel');
    assert.equal(response.error, undefined);
    assert(response.result);
    assert.equal(x.membrane.calls.length, 1);
    assert.equal((await x.seen()).filter(e => e.method === 'channels/publish').length, 0);
  });
}

test('real stdio: push still invokes its resolver and publishes the bound channel', async t => {
  const lanes: string[] = [];
  const x = await wire({ replyAuthority: { timeoutMs: 1000, authorize: () => true, resolve: (input: AdmissionInput) => {
    lanes.push(input.lane); return { channelId: 'topic:push/β' };
  } } }); t.after(x.close);
  const response = await x.send('push/event', { featureSet: 'feed', eventId: 'bound-push', timestamp: '2026-01-01T00:00:00Z',
    origin: { mcplChannelId: 'room/one' }, payload: { content: [{ type: 'text', text: 'push cause' }] }, tags: ['chat:mention'] });
  assert.equal(response.result.accepted, true);
  await x.framework.runUntilIdle();
  assert.deepEqual(lanes, ['push/event']);
  assert.equal((await x.published(1))[0].params.channelId, 'topic:push/β');
});

test('real stdio: held routing stays sequential while direct inference releases at provider dispatch', async t => {
  const resolved: string[] = [], dispatched: string[] = [];
  let releaseResolver!: () => void, releaseProvider!: () => void;
  const resolverWait = new Promise<void>(r => { releaseResolver = r; });
  const providerWait = new Promise<void>(r => { releaseProvider = r; });
  const x = await wire({ inboundAdmission: { ...admission(), timeoutMs: 5000 }, replyAuthority: { timeoutMs: 1000, authorize: () => true, resolve: async (input: any) => {
    assert.notEqual(input.lane, 'inference/request');
    const id = input.item.messageId ?? input.item.eventId;
    resolved.push(id);
    if (id === 'first') await resolverWait;
    return input.replyIntent;
  } } });
  const pending: Promise<any>[] = [];
  t.after(async () => { releaseResolver(); releaseProvider(); await Promise.allSettled(pending); await x.close(); });
  x.f.inferenceRouter.resolveModel = () => 'test';
  x.f.inferenceRouter.membrane = { complete: async () => {
    dispatched.push('inference'); await providerWait; return createMockResponse([{ type: 'text', text: 'direct response' }]);
  } };
  const push = x.f.queue.push.bind(x.f.queue);
  const bindings: any[] = [];
  x.f.queue.push = (event: any) => {
    if (event.type === 'mcpl:channel-incoming' || event.type === 'mcpl:push-event') {
      dispatched.push(event.messageId ?? event.eventId); bindings.push(...workOf(event));
    }
    return push(event);
  };
  await x.framework.quiesce({ reason: 'test' });
  const first = x.send('channels/incoming', { messages: [incoming('first'), incoming('second', 'topic:second')] });
  let answered = false;
  const inference = x.send('inference/request', { featureSet: 'feed', messages: [{ role: 'user', content: 'slow provider' }] })
    .then(value => { answered = true; return value; });
  const last = x.send('push/event', { featureSet: 'feed', eventId: 'push', timestamp: '2026-01-01T00:00:00Z',
    origin: { mcplChannelId: 'room/one' }, payload: { content: [{ type: 'text', text: 'push' }] } });
  pending.push(first, inference, last);
  await eventually(() => (x.connection() as any).bufferedEvents.length === 3);
  assert.deepEqual(resolved, []);
  await x.framework.resume();
  await eventually(() => resolved.length === 1);
  const live = x.send('channels/incoming', { messages: [incoming('live', 'topic:live')] }); pending.push(live);
  await eventually(() => (x.connection() as any).bufferedEvents.length === 3);
  assert.deepEqual(resolved, ['first']);
  releaseResolver();
  await eventually(() => dispatched.length === 5);
  assert.deepEqual(dispatched, ['first', 'second', 'inference', 'push', 'live']);
  assert.deepEqual(resolved, ['first', 'second', 'push', 'live']);
  assert.equal(answered, false, 'a direct provider call cannot hold later routed storage');
  assert.equal(bindings.length, 4);
  assert.deepEqual(bindings.map(b => b.destination?.channelId), ['room/one', 'topic:second', 'room/one', 'topic:live']);
  assert.equal((await first).result.results.every((r: any) => r.accepted), true);
  assert.equal((await last).result.accepted, true); assert.equal((await live).result.results[0].accepted, true);
  releaseProvider(); assert.equal((await inference).error, undefined);
});

for (const lane of ['channels/incoming', 'push/event'] as const) for (const mayWake of [true, false]) {
  test(`real stdio: routed ${lane} module wake respects only mayWake=${mayWake} despite gate decline`, async t => {
    let moduleCalls = 0, resolves = 0;
    const requester: any = { name: 'requester', start: async () => {}, stop: async () => {}, getTools: () => [],
      handleToolCall: async () => ({ success: true }), onProcess: async (event: any) => {
        if (event.type !== 'mcpl:channel-incoming' && event.type !== 'mcpl:push-event') return {};
        moduleCalls++; assert.equal(event.triggerInference, false); return { requestInference: true };
      } };
    const x = await wire({ inboundAdmission: admission(!mayWake), shouldTriggerInference: () => false,
      replyAuthority: { timeoutMs: 1000, authorize: () => true, resolve: (input: any) => { resolves++; return { channelId: 'topic:module' }; } },
    }, { modules: [requester] }); t.after(x.close);
    await x.send(lane, lane === 'channels/incoming' ? { messages: [incoming('module')] } : {
      featureSet: 'feed', eventId: 'module', timestamp: '2026-01-01T00:00:00Z', origin: { mcplChannelId: 'room/one' },
      payload: { content: [{ type: 'text', text: 'module cause' }] },
    });
    await x.framework.runUntilIdle();
    assert.equal(moduleCalls, 1); assert.equal(resolves, mayWake ? 1 : 0);
    assert.equal(x.membrane.calls.length, mayWake ? 1 : 0);
    const sends = (await x.seen()).filter(e => e.method === 'channels/publish');
    assert.equal(sends.length, mayWake ? 1 : 0);
    if (mayWake) assert.equal(sends[0].params.channelId, 'topic:module');
  });
}

for (const lane of ['channels/incoming', 'push/event'] as const) test(`real stdio: required routed ${lane} coalescing refuses before the resolver`, async t => {
  let resolves = 0;
  const x = await wire({ replyAuthority: { timeoutMs: 1000, authorize: () => true, resolve: () => { resolves++; return { channelId: 'room/one' }; } } }); t.after(x.close);
  const item: any = lane === 'channels/incoming' ? incoming('coalesced') : {
    featureSet: 'feed', eventId: 'coalesced', timestamp: '2026-01-01T00:00:00Z',
    origin: { mcplChannelId: 'room/one' }, payload: { content: [{ type: 'text', text: 'coalesced' }] },
  };
  item.coalesce = { key: 'subject', initial: true };
  const result = await x.send(lane, lane === 'channels/incoming' ? { messages: [item] } : item);
  const receipt = lane === 'channels/incoming' ? result.result.results[0] : result.result;
  assert.equal(receipt.accepted, false); assert.equal(receipt.reason, 'admission_unsupported');
  assert.equal(resolves, 0);
  await x.framework.runUntilIdle(); assert.equal(x.membrane.calls.length, 0);
});

test('real stdio: an unrelated module wake does not borrow the last admitted binding', async t => {
  const requester: any = { name: 'requester', start: async () => {}, stop: async () => {}, getTools: () => [],
    handleToolCall: async () => ({ success: true }), onProcess: async (event: any) =>
      event.type === 'test:timer' ? { requestInference: true } : {} };
  const x = await wire({}, { modules: [requester], agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test',
    proseRouting: 'locus' }] }); t.after(x.close);
  await x.send('channels/incoming', { messages: [incoming('earlier')] });
  await x.framework.runUntilIdle();
  const before = (await x.seen()).filter(e => e.method === 'channels/publish').length;
  assert.equal(before, 1);
  const failures: any[] = [];
  x.framework.onTrace((event: any) => { if (JSON.stringify(event).includes('automatic_reply_binding_missing')) failures.push(event); });
  // Labelled home-channel scaffold; a timer still has no admitted reply work.
  x.f.homeOf = () => at();
  // Synthetic timer delivery enters the real module processing path with no receipt.
  await x.f.queue.push({ type: 'test:timer', source: 'timer', timestamp: Date.now() });
  await x.framework.runUntilIdle();
  assert.equal(x.membrane.calls.length, 2);
  assert.equal((await x.seen()).filter(e => e.method === 'channels/publish').length, before);
  assert(failures.length > 0);
});

for (const mode of ['revoked', 'throw'] as const) test(`real stdio: send-time host authority ${mode} keeps prose private with notice; explicit sends work`, async t => {
  let live = true;
  const x = await wire({ replyAuthority: { timeoutMs: 1000, resolve: (input: any) => input.replyIntent,
    authorize: () => { if (live) return true; if (mode === 'throw') throw Error('secret-policy-detail'); return false; },
  } }); t.after(x.close);
  assert.equal((await x.send('channels/incoming', { messages: [incoming('approved-at-admission')] })).result.results[0].accepted, true);
  const cm = x.framework.getAgent('assistant')!.getContextManager(), compile = cm.compile.bind(cm);
  cm.compile = async (...args: Parameters<typeof cm.compile>) => { live = false; return compile(...args); };
  await x.framework.runUntilIdle();
  assert.equal(x.membrane.calls.length, 1);
  assert.equal((await x.seen()).filter(e => e.method === 'channels/publish').length, 0);
  const context = JSON.stringify(cm.getAllMessages());
  assert(context.includes('prose stays private')); assert(!context.includes('secret-policy-detail'));
  const result = await x.f.channelRegistry.handleChannelToolCall('channel_publish', { serverId: 'endpoint-a', channelId: 'room/other', content: 'separately authorized explicit send' },
    { kind: 'agent', agentName: 'assistant', inTurn: false });
  assert.equal(result.success, true);
  assert.equal((await x.published(1))[0].params.channelId, 'room/other');
});

for (const revoke of [false, true]) test(`real stdio: same-destination causes share a turn and each must still authorize at send (revoke=${revoke})`, async t => {
  let live = true;
  const checked = new Set<string>();
  const x = await wire({ replyAuthority: { timeoutMs: 1000, resolve: (input: any) => input.replyIntent,
    authorize: (input: any) => { checked.add(input.item.messageId); return input.item.messageId !== 'second-cause' || live; },
  } }, { gate: { judge: { enabled: false }, config: { policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 20 } }], default: 'skip' } } }); t.after(x.close);
  assert.equal((await x.send('channels/incoming', { messages: [incoming('first-cause'), incoming('second-cause')] })).result.results.every((r: any) => r.accepted), true);
  const cm = x.framework.getAgent('assistant')!.getContextManager(), compile = cm.compile.bind(cm);
  cm.compile = async (...args: Parameters<typeof cm.compile>) => { if (revoke) live = false; return compile(...args); };
  checked.clear();
  x.framework.start();
  await eventually(() => x.membrane.calls.length > 0);
  await eventually(() => !x.f.openLogical.has('assistant'));
  if (!revoke) await x.published(1);
  assert.equal(x.membrane.calls.length, 1, 'compatible distinct admitted causes share one inference');
  assert.deepEqual([...checked].sort(), ['first-cause', 'second-cause']);
  const sends = (await x.seen()).filter(e => e.method === 'channels/publish');
  assert.equal(sends.length, revoke ? 0 : 1);
  if (revoke) assert(JSON.stringify(cm.getAllMessages()).includes('prose stays private'));
  else assert.equal(sends[0].params.channelId, 'room/one');
});

for (const lane of ['channels/incoming', 'push/event'] as const) test(`real stdio: ${lane} needs no publishable route to be admitted and wake`, async t => {
  const x = await wire({ replyAuthority: { timeoutMs: 1000, resolve: () => null, authorize: () => true } }); t.after(x.close);
  const r = await x.send(lane, lane === 'channels/incoming' ? { messages: [incoming('no-route')] } : {
    featureSet: 'feed', eventId: 'no-origin', timestamp: '2026-01-01T00:00:00Z', payload: { content: [{ type: 'text', text: 'push-without-route' }] }, tags: ['chat:mention'],
  });
  assert.equal(lane === 'channels/incoming' ? r.result.results[0].accepted : r.result.accepted, true);
  await x.framework.runUntilIdle();
  assert.equal(x.membrane.calls.length, 1);
  assert(JSON.stringify(x.membrane.calls).includes('prose stays private'));
  assert.equal((await x.seen()).filter(e => e.method === 'channels/publish').length, 0);
});
