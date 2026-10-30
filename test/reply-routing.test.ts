import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, Module } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry, destinationKey } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';

import { RequiredAdmission } from '../src/mcpl/inbound-admission.js';
import { withReplyConsumer, admissionRoutingFields } from '../src/mcpl/reply-admission.js';
import { replyConsumer, replyWork, replyOwner, workOf, type ReplyBinding } from '../src/mcpl/reply-routing.js';
const reply = (channelId = 'room/one', override = channelId) => ({ channelId: override });
const at = (channelId = 'room/one', serverId = 'endpoint-a') => ({ serverId, channelId });
/** Private scaffolding: real admission mints bindings; a recording double replaces transport. */
function registryFor(active?: (name: string) => any) {
  const publishes: any[] = [];
  const admissions = new Map<string, RequiredAdmission>();
  const peers = new Map<string, any>();
  for (const serverId of ['endpoint-a', 'endpoint-b']) {
    const admission = new RequiredAdmission({ timeoutMs: 1000, bind: connection => ({ connection, admit: input => ({ store: true, mayWake: true, replyIntent: input.item }) }), isReplyIntent: () => true }, serverId);
    admission.bind(1); admissions.set(serverId, admission);
    peers.set(serverId, { requiresReplyBinding: true, requiredAdmission: admission,
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsPublish: async (params: any) => { publishes.push({ serverId, ...params }); return { delivered: true, messageId: `m${publishes.length}` }; },
      sendChannelsOutgoingChunk() {}, sendChannelsOutgoingComplete() {},
      sendChannelsOpen: async (p: any) => ({ opened: true, channel: { id: p.channelId, type: 'synthetic', label: p.channelId } }),
    });
  }
  const registry = new ChannelRegistry({ getServer: (id: string) => peers.get(id) } as any, {} as any, () => {}, () => {}, { activeChannelResolver: active });
  for (const serverId of peers.keys()) for (const channelId of ['room/one', 'room/other', 'topic:second', 'topic:alpha/β|room/other']) {
    (registry as any).channels.set(destinationKey(at(channelId, serverId)), { serverId, open: true,
      descriptor: { id: channelId, label: channelId, type: 'synthetic', address: {} } });
  }
  const binding = async (root: { channelId: string }, serverId = 'endpoint-a'): Promise<ReplyBinding> => {
    const admission = admissions.get(serverId)!;
    const ingress = withReplyConsumer(admission.capture(() => undefined), replyConsumer({ timeoutMs: 1000, authorize: () => true, resolve: input => input.replyIntent as any }, (_, target) => !!registry.getDescriptor(target)), new AbortController().signal);
    const verdict = await ingress.admit('channels/incoming', root);
    assert.equal(verdict.store, true);
    return admissionRoutingFields(verdict).routing as ReplyBinding;
  };
  const request = async (root: { channelId: string }, serverId = 'endpoint-a', reason = 'channel-message') => ({
    agentName: 'assistant', reason, source: serverId, timestamp: Date.now(), channelId: root.channelId,
    channelServerId: serverId, addressed: true, [replyWork]: [await binding(root, serverId)],
  });
  return { registry, publishes, admissions, peers, binding, request };
}
class PerTurnMembrane extends MockMembrane {
  private turn = 0;
  override streamYielding(request: NormalizedRequest) {
    this.calls.push(request);
    return new MockYieldingStream([this.responses[this.turn++] ?? createMockResponse([{ type: 'text', text: 'reply' }])]);
  }
}
async function frameworkFor(responses?: NormalizedResponse[], modules: Module[] = [], physicalWindowTokens?: number, agentConfig: Partial<AgentConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reply-routing-'));
  const membrane = new PerTurnMembrane();
  for (const response of responses ?? []) membrane.pushResponse(response);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting: 'locus',
      ...(physicalWindowTokens ? { physicalWindowTokens, maxTokens: 4_000 } : {}), ...agentConfig, }],
    modules, syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const f = framework as any;
  const reg = registryFor((name) => f.turnRouting.get(name)?.locus ?? f.turnRouting.get(name)?.triggerChannel);
  f.channelRegistry = reg.registry;
  const enqueue = async (root: ReturnType<typeof reply>, reason = 'channel-message', serverId = 'endpoint-a') => { f.pendingRequests.push(await reg.request(root, serverId, reason)); };
  return { ...reg, framework, f, membrane, enqueue,
    async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}


test('automatic speech publishes the frozen channel, never a later default', async () => {
  const x = registryFor();
  try {
    x.registry.noteDelivered(at('room/other'), 'later', 'topic:later');
    const result = await x.registry.routeSpeech('assistant', 'answer', at(), await x.binding(reply()));
    assert.equal(result?.delivered, true);
    assert.equal(x.publishes[0].channelId, 'room/one');
    assert.equal(x.publishes[0].channelId, 'room/one');
  } finally { x.registry.stopAll(); }
});

test('automatic speech cannot replace the frozen connector or channel', async () => {
  const x = registryFor();
  try {
    assert.equal(await x.registry.routeSpeech('assistant', 'answer', at('room/other'), await x.binding(reply())), null);
    assert.equal(await x.registry.routeSpeech('assistant', 'answer', { serverId: 'other', channelId: 'room/one' }, await x.binding(reply())), null);
    assert.deepEqual(x.publishes, []);
  } finally { x.registry.stopAll(); }
});

test('recipient connections refuse automatic speech without an admitted envelope', async () => {
  const x = registryFor();
  try {
    assert.equal(await x.registry.routeSpeech('assistant', 'answer', at()), null);
    assert.deepEqual(x.publishes, []);
  } finally { x.registry.stopAll(); }
});

test('separate addressed roots queued together each get their own turn', async () => {
  const x = await frameworkFor();
  try {
    await x.enqueue(reply());
    await x.enqueue(reply('topic:second'));
    await x.framework.runUntilIdle();
    assert.deepEqual(x.publishes.map(p => p.channelId), [
      'room/one', 'topic:second',
    ]);
    assert.equal(x.membrane.calls.length, 2);
  } finally { await x.close(); }
});

test('the turn snapshots its envelope before asynchronous compilation', async () => {
  const x = await frameworkFor();
  const root = reply();
  try {
    const cm = x.framework.getAgent('assistant')!.getContextManager();
    const compile = cm.compile.bind(cm);
    cm.compile = async (...args: Parameters<typeof cm.compile>) => {
      root.channelId = 'room/other';
      (root as any).serverId = 'endpoint-b';
      return compile(...args);
    };
    await x.enqueue(root);
    await x.framework.runUntilIdle();
    assert.equal(x.publishes[0]?.channelId, 'room/one');
    assert.equal(x.publishes[0]?.serverId, 'endpoint-a');
  } finally { await x.close(); }
});

test('a later context arrival cannot move an open bound turn', async () => {
  const x = await frameworkFor();
  try {
    const cm = x.framework.getAgent('assistant')!.getContextManager();
    const compile = cm.compile.bind(cm);
    cm.compile = async (...args: Parameters<typeof cm.compile>) => {
      const routing = x.f.openLogical.get('assistant');
      x.f.repinTurnLocus(x.framework.getAgent('assistant'), routing, at('room/other'), 'arrival');
      return compile(...args);
    };
    await x.enqueue(reply());
    await x.framework.runUntilIdle();
    assert.equal(x.publishes[0]?.channelId, 'room/one');
  } finally { await x.close(); }
});

test('holds do not coalesce two roots sharing a timestamp and channel', async () => {
  const x = await frameworkFor();
  try {
    const held: any[] = [];
    const request = { agentName: 'assistant', reason: 'channel-message', source: 'endpoint-a', timestamp: 1, channelId: 'room/one' };
    x.f.holdRequest(held, { ...request, [replyWork]: [await x.binding(reply())] });
    x.f.holdRequest(held, { ...request, [replyWork]: [await x.binding(reply('topic:second'))] });
    assert.equal(held.length, 2);
  } finally { await x.close(); }
});

test('explicit channel_publish still honours its chosen destination', async () => {
  const x = registryFor(() => at());
  try {
    const result = await x.registry.handleChannelToolCall('channel_publish', { channelId: 'room/other', serverId: 'endpoint-a', content: 'explicit answer' },
      { kind: 'agent', agentName: 'assistant', inTurn: true });
    assert.equal(result.success, true);
    assert.equal(x.publishes[0].channelId, 'room/other');
  } finally { x.registry.stopAll(); }
});

test('a retry keeps its opening root and leaves a later root for another turn', async () => {
  const x = await frameworkFor();
  try {
    const cm = x.framework.getAgent('assistant')!.getContextManager();
    const compile = cm.compile.bind(cm);
    let first = true;
    cm.compile = async (...args: Parameters<typeof cm.compile>) => {
      if (first) {
        first = false;
        await x.enqueue(reply('topic:second'));
        throw new Error('temporary compile failure');
      }
      return compile(...args);
    };
    x.f.errorPolicy = { maxRetries: 1, onInferenceError: () => ({ retry: true, delayMs: 0 }) };
    await x.enqueue(reply());
    await x.framework.runUntilIdle();
    assert.deepEqual(x.publishes.map(p => p.channelId), ['room/one', 'topic:second']);
  } finally { await x.close(); }
});

test('tool waits and injected context keep the opening envelope while a later addressed root waits', async () => {
  let x: Awaited<ReturnType<typeof frameworkFor>>;
  const module: Module = {
    name: 'work', async start() {}, async stop() {}, async onProcess() { return {}; },
    getTools: () => [{ name: 'lookup', description: 'synthetic lookup', inputSchema: { type: 'object', properties: {} } }],
    async handleToolCall() {
      await x.enqueue(reply('topic:second'));
      x.f.addMessage('user', [{ type: 'text', text: 'context that arrived during the lookup' }], {
        serverId: 'endpoint-a', channelId: 'room/other', routingVersion: 1, wakeAllowed: false, replyRoot: 'topic:forged',
      });
      await new Promise(r => setTimeout(r, 10));
      return { success: true, data: 'lookup result' };
    },
  };
  x = await frameworkFor(undefined, [module]);
  try {
    let first = true;
    const stream = x.membrane.streamYielding.bind(x.membrane);
    x.membrane.streamYielding = (request) => {
      if (!first) return stream(request);
      first = false; x.membrane.calls.push(request);
      return new MockYieldingStream([
        createMockResponse([{ type: 'tool_use', id: 'lookup-1', name: 'work--lookup', input: {} }], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'the opening answer' }]),
      ], true);
    };
    await x.enqueue(reply());
    await x.framework.runUntilIdle();
    assert.deepEqual(x.publishes.map(p => p.channelId), [
      'room/one', 'topic:second',
    ]);
  } finally { await x.close(); }
});

test('opening another channel is not an implicit redirect of the frozen reply', async () => {
  const x = await frameworkFor();
  try {
    x.membrane.streamYielding = (request) => {
      x.membrane.calls.push(request);
      return new MockYieldingStream([
        createMockResponse([{ type: 'tool_use', id: 'open-1', name: 'channel_open', input: { channelId: 'endpoint-a:room/other' } }], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'still answering the opening root' }]),
      ], true);
    };
    await x.enqueue(reply());
    await x.framework.runUntilIdle();
    assert.deepEqual(x.publishes.map(p => p.channelId), ['room/one']);
  } finally { await x.close(); }
});


for (const missingStreamOwner of [false, true]) test(`a tool-driven budget restart keeps the frozen envelope despite later context and another root (missing stream owner: ${missingStreamOwner})`, async () => {
  let x: Awaited<ReturnType<typeof frameworkFor>>;
  const module: Module = {
    name: 'work', async start() {}, async stop() {}, async onProcess() { return {}; },
    getTools: () => [{ name: 'fetch', description: 'synthetic fetch', inputSchema: { type: 'object', properties: {} } }],
    async handleToolCall() {
      // Exercise a real budget boundary without its stream-owner entry.
      // A streamless state cannot cross the current budget guards.
      if (missingStreamOwner) x.f.replyStreamOwners.delete((x.framework.getAgent('assistant')!.state as any).stream);
      await x.enqueue(reply('topic:second'));
      x.f.addMessage('user', [{ type: 'text', text: 'later context during the budget restart' }], {
        serverId: 'endpoint-a', channelId: 'room/other', routingVersion: 1, wakeAllowed: false, replyRoot: 'topic:forged',
      });
      return { success: true, data: { blob: 'x'.repeat(30_000) } };
    },
  };
  x = await frameworkFor([
    createMockResponse([{ type: 'text', text: 'the resumed opening answer' }]),
    createMockResponse([{ type: 'text', text: 'the later root answer' }]),
  ], [module], 200_000);
  const traces: string[] = [];
  x.framework.onTrace(event => traces.push(event.type));
  try {
    let first = true;
    const stream = x.membrane.streamYielding.bind(x.membrane);
    x.membrane.streamYielding = request => {
      if (!first) return stream(request);
      first = false; x.membrane.calls.push(request);
      const round = createMockResponse([{ type: 'tool_use', id: 'fetch-1', name: 'work--fetch', input: {} }], 'tool_use');
      (round as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
      return new MockYieldingStream([round], true);
    };
    await x.enqueue(reply());
    x.framework.start();
    for (let i = 0; i < 300 && (x.membrane.calls.length < 3 || x.publishes.length < 2); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(traces.includes('inference:stream_restarted'), 'the real context-budget restart path ran');
    assert.deepEqual(x.publishes.map(p => p.channelId), [
      'room/one', 'topic:second',
    ]);
    assert.equal(x.membrane.calls.length, 3, 'one tool stream, one continuation, one later root');
    assert.ok(JSON.stringify(x.membrane.calls[1]).includes('later context during the budget restart'));
  } finally { await x.close(); }
});

for (const direct of [false, true]) test(`a recipient wake waits rather than joining an unowned open logical turn (${direct ? 'direct start' : 'scheduler'})`, async () => {
  const x = await frameworkFor();
  try {
    // Explicitly inject the otherwise independently tested scheduling precondition.
    const open = x.f.routingOf('assistant');
    x.f.openLogical.set('assistant', open);
    x.f.turnRouting.set('assistant', open);
    await x.enqueue(reply());
    if (direct) {
      x.f.acquirePrimaryProviderGate('assistant');
      await x.f.startAgentStream(x.framework.getAgent('assistant'), x.f.pendingRequests.shift(), 0, true);
      assert.equal(x.f.providerGate('assistant').primaryDepth, 0, 'a parked admission is released when the wake is requeued');
    }
    else await x.f.processInferenceRequests();
    assert.equal(x.membrane.calls.length, 0, 'the recipient cannot join or redirect the earlier turn');
    assert.equal(x.f.pendingRequests.length, 1, 'the admitted wake remains queued');
    assert.equal(workOf(x.f.pendingRequests[0])[0]?.destination?.channelId, 'room/one');
    assert.equal(x.f.openLogical.get('assistant'), open);
    x.f.openLogical.delete('assistant');
    await x.framework.runUntilIdle();
    assert.deepEqual(x.publishes.map(p => p.channelId), ['room/one']);
  } finally { await x.close(); }
});

test('a recipient arriving during a non-recipient budget restart waits for its own turn', async () => {
  let x: Awaited<ReturnType<typeof frameworkFor>>;
  const module: Module = {
    name: 'work', async start() {}, async stop() {}, async onProcess() { return {}; },
    getTools: () => [{ name: 'fetch', description: 'synthetic fetch', inputSchema: { type: 'object', properties: {} } }],
    async handleToolCall() {
      await x.enqueue(reply());
      return { success: true, data: { blob: 'x'.repeat(30_000) } };
    },
  };
  x = await frameworkFor([
    createMockResponse([{ type: 'text', text: 'previous turn completed' }]),
    createMockResponse([{ type: 'text', text: 'recipient answer' }]),
  ], [module], 200_000);
  const traces: string[] = [];
  x.framework.onTrace(event => traces.push(event.type));
  try {
    let first = true;
    const stream = x.membrane.streamYielding.bind(x.membrane);
    x.membrane.streamYielding = request => {
      if (!first) return stream(request);
      first = false; x.membrane.calls.push(request);
      const round = createMockResponse([{ type: 'tool_use', id: 'fetch-open', name: 'work--fetch', input: {} }], 'tool_use');
      (round as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
      return new MockYieldingStream([round], true);
    };
    x.f.pendingRequests.push({ agentName: 'assistant', reason: 'external-message', source: 'test', timestamp: Date.now() });
    x.framework.start();
    for (let i = 0; i < 500 && (x.membrane.calls.length < 3 || x.publishes.length < 1); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(traces.includes('inference:stream_restarted'), 'the production continuation path ran');
    assert.equal(x.membrane.calls.length, 3, 'previous stream, previous continuation, then the recipient turn');
    assert.deepEqual(x.publishes.map(p => p.channelId), ['room/one']);
    assert.ok(JSON.stringify(x.publishes[0]).includes('recipient answer'));
  } finally { await x.close(); }
});

test('a silent recipient direct start does not join or defer behind the open prose turn', async () => {
  const x = await frameworkFor();
  let completed = false;
  x.framework.onTrace(event => { if (event.type === 'inference:completed') completed = true; });
  try {
    const open = x.f.routingOf('assistant');
    x.f.openLogical.set('assistant', open);
    await x.enqueue(reply());
    const trigger = { ...x.f.pendingRequests.shift(), suppressProse: true };
    await x.f.startAgentStream(x.framework.getAgent('assistant'), trigger);
    for (let i = 0; i < 500 && !completed; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(x.membrane.calls.length, 1, 'the silent start runs instead of being requeued');
    assert.ok(completed, 'the silent stream completed before checking the preserved prose turn');
    assert.equal(x.f.pendingRequests.length, 0);
    assert.equal(x.f.openLogical.get('assistant'), open);
    assert.equal(open.reply, undefined, 'the prose turn never adopts the silent envelope');
    assert.deepEqual(x.publishes, [], 'silent starts publish no automatic prose');
    const silent = x.f.turnRouting.get('assistant');
    assert.notEqual(silent, open);
    assert.equal(silent.reply, workOf(trigger)[0]);
    completed = false;
    await x.f.startAgentStream(x.framework.getAgent('assistant'), { ...trigger, reason: 'context_budget_restart' });
    for (let i = 0; i < 500 && !completed; i++) await new Promise(r => setTimeout(r, 10));
    assert(completed);
    assert.equal(x.f.turnRouting.get('assistant'), silent, 'the existing resume uses the latest silent routing; no recovery contract is added');
    assert.equal(x.f.openLogical.get('assistant'), open);
    assert.equal(open.reply, undefined);
    assert.deepEqual(x.publishes, []);
  } finally { await x.close(); }
});

// Predicate witnesses deliberately bypass scheduler ownership filtering.
test('N3/N4: tuple keys and request equality retain every admitted identity', async () => {
  const x = await frameworkFor();
  try {
    const a = await x.request(reply()); a.timestamp = 1;
    const copy = { ...a, timestamp: 2 };
    const key = x.f.pendingRequestKey(a);
    assert.equal(key, x.f.pendingRequestKey(copy), 'identical work absorbs only its newest request');
    assert.equal(x.f.sameInferenceRequest(a, { ...a }), true);
    for (const request of [await x.request(reply('topic:second')), await x.request(reply('room/one', 'room/other')),
      await x.request(reply(), 'endpoint-b'), await x.request(reply())]) {
      Object.assign(request, { timestamp: a.timestamp, channelId: a.channelId, source: a.source, channelServerId: a.channelServerId });
      assert.notEqual(x.f.pendingRequestKey(request), key);
      assert.equal(x.f.sameInferenceRequest(a, request), false);
      const held: any[] = []; x.f.holdRequest(held, a); x.f.holdRequest(held, request); assert.equal(held.length, 2);
    }
    const tuple = JSON.parse(key)[1][0];
    assert.deepEqual(tuple.slice(1, 5), ['endpoint-a', 1, 'endpoint-a', 'room/one'], 'each destination component is present independent of work identity');
    x.admissions.get('endpoint-a')!.bind(2);
    const nextEpoch = await x.request(reply());
    assert.notEqual(x.f.pendingRequestKey(nextEpoch), key);
    assert.equal(x.f.sameInferenceRequest(a, { ...nextEpoch, timestamp: 1 }), false);
    x.f.quiesced = true;
    x.f.pendingRequests.push(a, copy, nextEpoch);
    await x.f.processInferenceRequests();
    assert.equal(x.f.pendingRequests.length, 2);
    assert(x.f.pendingRequests.includes(copy));
  } finally { await x.close(); }
});

test('opaque separators, colliding channels and stale epochs cannot redirect publication', async () => {
  const x = registryFor();
  try {
    const a = await x.binding(reply('topic:alpha/β|room/other'));
    const b = await x.binding(reply('topic:alpha/β|room/other'), 'endpoint-b');
    assert.equal((await x.registry.routeSpeech('a', 'one', a.destination!, a))?.delivered, true);
    assert.equal((await x.registry.routeSpeech('b', 'two', b.destination!, b))?.delivered, true);
    assert.deepEqual(x.publishes.map(p => p.serverId), ['endpoint-a', 'endpoint-b']);
    x.admissions.get('endpoint-a')!.bind(2);
    assert.equal(await x.registry.routeSpeech('a', 'stale', at(), a), null);
    assert.equal(await x.registry.routeSpeech('a', 'forged', at(), { ...a } as ReplyBinding), null);
    assert.equal(x.publishes.length, 2);
    const registeredChannel = await x.binding({ channelId: 'room/one' });
    await x.registry.routeSpeech('a', 'registered channel', at(), registeredChannel);
    assert.equal(x.publishes[2].channelId, 'room/one');
  } finally { x.registry.stopAll(); }
});

for (const mutation of ['epoch', 'grant', 'registration']) test(`automatic publish rechecks ${mutation} after lifecycle wait, before open/send`, async () => {
  const x = registryFor();
  try {
    const binding = await x.binding(reply());
    const r = x.registry as any;
    const entry = r.channels.get(destinationKey(at()));
    r.hasPendingLifecycle = () => true;
    r.waitForOpenChannel = async () => {
      if (mutation === 'epoch') x.admissions.get('endpoint-a')!.bind(2);
      if (mutation === 'grant') x.peers.get('endpoint-a').grant = new CapabilityGrant(new Set(), []);
      if (mutation === 'registration') r.channels.set(destinationKey(at()), { ...entry });
      return entry;
    };
    let opens = 0; r.openChannelNow = () => { opens++; throw Error('must not open'); };
    assert.equal(await x.registry.routeSpeech('a', 'answer', at(), binding), null);
    assert.equal(opens, 0); assert.equal(x.publishes.length, 0);
  } finally { x.registry.stopAll(); }
});

test('a merged duplicate keeps its private owner through a setup retry', async () => {
  const x = await frameworkFor();
  try {
    const request = await x.request(reply());
    x.f.pendingRequests.push(request, { ...request });
    const cm = x.framework.getAgent('assistant')!.getContextManager();
    const compile = cm.compile.bind(cm); let first = true;
    cm.compile = async (...args: Parameters<typeof cm.compile>) => { if (first) { first = false; throw Error('retry setup'); } return compile(...args); };
    x.f.errorPolicy = { maxRetries: 1, onInferenceError: () => ({ retry: true, delayMs: 0 }) };
    await x.framework.runUntilIdle();
    assert.equal(x.membrane.calls.length, 1); assert.equal(x.publishes[0]?.channelId, 'room/one');
    assert.equal(x.f.pendingRequests.length, 0);
  } finally { await x.close(); }
});


for (const owner of [-1, Number.MAX_SAFE_INTEGER]) test(`a forged or unknown owner ${owner} is dropped without borrowing a successor or retaining provider admission`, async () => {
  const x = await frameworkFor();
  try {
    const request = { ...await x.request(reply()), [replyOwner]: owner };
    x.f.providerGate('assistant').primaryPending = true;
    x.f.providerAccelerationRecoveries.set('assistant', {});
    const dropped: any[] = [];
    x.framework.onTrace(event => { if (event.type === 'inference:request_dropped') dropped.push(event); });
    x.f.pendingRequests.push(request);
    await x.f.processInferenceRequests();
    assert.equal(x.f.pendingRequests.length, 0);
    assert.equal(x.membrane.calls.length, 0);
    assert.equal(dropped[0]?.reason, 'reply_owner_ended');
    assert.equal(x.f.providerGate('assistant').primaryPending, false);
    const successor = x.f.routingOf('assistant'); x.f.openLogical.set('assistant', successor);
    x.f.acquirePrimaryProviderGate('assistant');
    await x.f.startAgentStream(x.framework.getAgent('assistant'), request, 0, true);
    assert.equal(x.f.providerGate('assistant').primaryDepth, 0);
    assert.equal(x.f.openLogical.get('assistant'), successor);
    assert.equal(x.membrane.calls.length, 0);
  } finally { await x.close(); }
});

test('autoContinue opens a fresh bound turn in the same frozen channel', async () => {
  const x = await frameworkFor(undefined, [], undefined, { autoContinue: { maxConsecutive: 1 } });
  try {
    const turns: any[] = [];
    const cm = x.framework.getAgent('assistant')!.getContextManager();
    const compile = cm.compile.bind(cm);
    cm.compile = async (...args: Parameters<typeof cm.compile>) => {
      turns.push(x.f.openLogical.get('assistant'));
      x.registry.noteDelivered(at('room/other'), 'later', 'topic:later');
      return compile(...args);
    };
    await x.enqueue(reply());
    await x.framework.runUntilIdle();
    assert.equal(x.membrane.calls.length, 2, 'the post-turn continuation must run');
    assert.equal(turns.length, 2);
    assert.notEqual(turns[0].turnId, turns[1].turnId, 'new turn, not an ended owner');
    assert.equal(turns[0].reply, turns[1].reply, 'same admitted cause');
    assert.deepEqual(x.publishes.map(p => p.channelId),
      ['room/one', 'room/one']);
  } finally { await x.close(); }
});

for (const forced of [false, true]) test(`a bound ${forced ? 'unstick' : 'refusal'} rewind retry opens a fresh turn`, async () => {
  const x = await frameworkFor([
    createMockResponse([], 'refusal'),
    createMockResponse([{ type: 'text', text: 'recovered answer' }]),
  ], [], undefined, { refusalHandling: { autoRewind: true, maxRewinds: 1 } });
  try {
    x.f.addMessage('user', [{ type: 'text', text: 'input to rewind' }]);
    // Install only the host's forced-session precondition; the refusal,
    // history shed, request creation and retry all take the production path.
    if (forced) x.f.forcedRewind.set('assistant', { remaining: 1, removed: [] });
    await x.enqueue(reply());
    await x.framework.runUntilIdle();
    assert.equal(x.membrane.calls.length, 2, 'the rewind retry must run');
    assert.equal(x.publishes.at(-1)?.channelId, 'room/one');
    assert.match(JSON.stringify(x.framework.getAgent('assistant')!.getContextManager().getAllMessages()), /refusal-rewind/);
  } finally { await x.close(); }
});

for (const reason of ['prose-continuation', 'inference-failure-rewind-retry']) test(`a settled bound turn carries work without its ended owner into ${reason}`, async () => {
  const x = await frameworkFor();
  try {
    x.f.addMessage('user', [{ type: 'text', text: 'input to rewind' }]);
    await x.enqueue(reply());
    await x.framework.runUntilIdle();
    const prior = x.f.turnRouting.get('assistant');
    assert.equal(x.f.openLogical.has('assistant'), false);
    if (reason === 'prose-continuation') {
      // Install the parsed prose-continuation flag after the real turn settles.
      prior.continuation = true;
      x.f.requestProseContinuation(x.framework.getAgent('assistant'), prior);
    } else {
      for (let i = 0; i < 3; i++) x.f.noteInferenceExhausted('assistant', 'invalid request', false, 'invalid_request');
    }
    const queued = x.f.pendingRequests.find((r: any) => r.reason === reason);
    assert.ok(queued, 'the production continuation producer queued a request');
    assert.equal(queued[replyOwner], undefined, 'a new turn cannot carry an ended owner');
    assert.equal(workOf(queued)[0], prior.reply);
    x.registry.noteDelivered(at('room/other'), 'later', 'topic:later');
    await x.framework.runUntilIdle();
    assert.equal(x.membrane.calls.length, 2);
    assert.notEqual(x.f.turnRouting.get('assistant').turnId, prior.turnId);
    assert.equal(x.publishes.at(-1)?.channelId, 'room/one');
  } finally { await x.close(); }
});

for (const [bound, token] of [[true, true], [true, false], [false, true]]) test(`stale scheduler diagnostics retain age, throttle and quiesce suppression (reply=${bound}, token=${token})`, async t => {
  const x = await frameworkFor(); t.after(x.close);
  const traces: any[] = [], lines: string[] = [];
  x.framework.onTrace((event: any) => { if (event.type === 'inference:request_stale') traces.push(event); });
  const log = console.error;
  console.error = (...args: any[]) => { const line = args.join(' '); if (line.startsWith('[inference-stale]')) lines.push(line); else log(...args); };
  t.after(() => { console.error = log; });
  // Labelled leaked-turn scaffold: idle state with an open logical turn.
  const open = x.f.routingOf('assistant');
  if (bound) open.reply = await x.binding(reply());
  x.f.openLogical.set('assistant', open);
  if (token) x.f.activeTurnTokens.set('assistant', Symbol('test turn'));
  const now = Date.now();
  const requests = [
    { agentName: 'assistant', reason: 'module-wake', source: 'test', timestamp: now - 45_000 },
    { agentName: 'assistant', reason: 'timer-wake', source: 'test', timestamp: now - 35_000 },
  ];
  x.f.pendingRequests.push(...requests);
  x.f.quiesced = true;
  await x.f.processInferenceRequests();
  assert.equal(traces.length, 0); assert.equal(lines.length, 0);
  x.f.quiesced = false;
  await x.f.processInferenceRequests();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].requestCount, 2);
  assert(traces[0].oldestRequestAge >= 45_000);
  assert.equal(traces[0].agentStatus, bound ? (token ? 'idle+turn-alive+reply-deferred' : 'idle+reply-deferred') : 'idle+turn-alive');
  assert.equal(lines.length, 1);
  assert(lines[0].includes(`busy (${traces[0].agentStatus})`));
  await x.f.processInferenceRequests();
  assert.equal(traces.length, 1); assert.equal(lines.length, 1);
  // Advance only the diagnostic throttle; the pending requests keep their original age.
  x.f.staleWarnAt.set('assistant', now - 60_001);
  await x.f.processInferenceRequests();
  assert.equal(traces.length, 2); assert.equal(lines.length, 2);
  assert.deepEqual(x.f.pendingRequests.map((r: any) => r.timestamp).sort(), requests.map(r => r.timestamp).sort());
  assert.equal(x.membrane.calls.length, 0);
  x.f.openLogical.delete('assistant'); x.f.activeTurnTokens.delete('assistant'); x.f.pendingRequests.length = 0;
});

test('reply-deferred diagnostic includes the mixed pending snapshot before a continuation runs', async t => {
  const x = await frameworkFor(); t.after(x.close);
  const traces: any[] = [];
  x.framework.onTrace((event: any) => { if (event.type === 'inference:request_stale') traces.push(event); });
  const binding = await x.binding(reply());
  const open = x.f.routingOf('assistant'); open.reply = binding; x.f.openLogical.set('assistant', open);
  const wake = { agentName: 'assistant', reason: 'timer-wake', source: 'test', timestamp: Date.now() - 45_000 };
  const continuation = { agentName: 'assistant', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(),
    [replyWork]: [binding], [replyOwner]: open.turnId };
  // Stop only the provider start; the production scheduler must still select the continuation.
  const starts: any[] = [];
  x.f.startAgentStream = async (_agent: any, request: any) => { starts.push(request); };
  x.f.pendingRequests.push(wake, continuation);
  await x.f.processInferenceRequests();
  assert.equal(traces.length, 1); assert.equal(traces[0].requestCount, 2);
  assert.equal(starts.length, 1); assert.equal(starts[0].reason, 'context_budget_restart');
  assert.deepEqual(x.f.pendingRequests, [wake]);
  x.f.openLogical.delete('assistant'); x.f.activeTurnTokens.delete('assistant'); x.f.pendingRequests.length = 0;
});

for (const reason of ['automatic_reply_binding_missing', 'automatic_reply_target_mismatch', 'automatic_reply_stale',
  'automatic_reply_ungranted'] as const) {
  test(`publish refusal: ${reason} is observable before open or send`, async t => {
    const x = registryFor(); t.after(() => x.registry.stopAll());
    const binding = await x.binding(reply());
    const peer = x.peers.get('endpoint-a')!;
    (x.registry as any).channels.get(destinationKey(at())).open = false;
    assert.equal(x.registry.speechOpens(at()), true, 'an allowed send would need to open first');
    let opens = 0;
    peer.sendChannelsOpen = async () => { opens++; throw Error('refused publication must not open'); };
    const target: any = { ...at(), binding, routed: true };
    if (reason === 'automatic_reply_binding_missing') delete target.binding;
    if (reason === 'automatic_reply_target_mismatch') target.channelId = 'different';
    if (reason === 'automatic_reply_stale') x.admissions.get('endpoint-a')!.invalidate();
    if (reason === 'automatic_reply_ungranted') peer.grant = new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter(p => p !== 'channels.publish')), []);
    const outcome = await x.registry.publish('assistant', 'must not escape', target);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.reason, reason);
    assert.equal(opens, 0); assert.deepEqual(x.publishes, []);
  });
}


for (const entry of ['scheduler', 'direct start'] as const) test(`a stale context_budget_restart ends its logical turn through ${entry}`, async () => {
  const x = await frameworkFor();
  const agent = x.framework.getAgent('assistant')!;
  try {
    const request = await x.request(reply(), 'endpoint-a', 'context_budget_restart');
    const routing = x.f.routingOf('assistant');
    routing.reply = workOf(request)[0];
    x.f.openLogical.set('assistant', routing);
    // Defensive mismatch scaffold, not a demonstrated production path.
    // The earlier frame has already released its token.
    (request as any)[replyOwner] = routing.turnId + 1;
    const guard = agent.toolResultGuard;
    guard.setOverride(true);
    guard.storeResults([{ type: 'text', text: 'guarded result' }], [], [], undefined, undefined);
    guard.recovering = true;
    assert.equal(guard.hasPending, true);
    let settled: Error | undefined;
    x.f.ephemeralRuns.set('assistant', { settle: {
      reject: (error: Error) => { settled = error; },
      resolve: () => assert.fail('a dropped continuation must reject'),
    } });
    x.f.deferredMessages.push({
      id: 'stale-continuation-write', seq: 1, heldAt: Date.now(), forAgent: 'assistant',
      participant: 'user', content: [{ type: 'text', text: 'deferred until continuation ends' }],
    });
    const traces: any[] = [];
    x.framework.onTrace(event => {
      traces.push({ ...event, open: x.f.openLogical.has('assistant'), pendingGuard: guard.hasPending });
    });
    if (entry === 'scheduler') {
      x.f.pendingRequests.push(request);
      await x.f.processInferenceRequests();
    } else {
      x.f.acquirePrimaryProviderGate('assistant');
      await x.f.startAgentStream(agent, request, 0, true);
      assert.equal(x.f.providerGate('assistant').primaryDepth, 0);
    }
    assert.deepEqual(traces.filter(t => t.type === 'inference:aborted').map(t => t.reason),
      ["a turn's continuation was dropped before it started"]);
    const drop = traces.find(t => t.type === 'inference:request_dropped');
    assert.equal(drop?.reason, 'reply_owner_ended');
    assert.equal(drop?.open, false, 'logical turn cleanup precedes the drop trace');
    assert.equal(drop?.pendingGuard, false, 'guard cleanup precedes the drop trace');
    assert.equal(x.f.openLogical.has('assistant'), false);
    assert.equal(x.f.settledTurns.has(routing), true, 'the routing is marked ended, not reusable as a live turn');
    assert.equal(guard.hasPending, false);
    assert.equal(guard.recovering, false);
    assert.match(settled?.message ?? '', /its admitted reply owner ended/);
    assert.equal(x.f.deferredMessages.length, 0);
    assert.ok(agent.getContextManager().getAllMessages().some(message =>
      message.content.some(block => block.type === 'text' && block.text === 'deferred until continuation ends')));
    assert.equal(x.f.hasTurn('assistant'), false);
    assert.equal(x.membrane.calls.length, 0);
    x.f.ephemeralRuns.delete('assistant');
    await x.enqueue(reply('topic:next'));
    await x.framework.runUntilIdle();
    assert.equal(x.membrane.calls.length, 1, 'a later wake runs after the drop');
    assert.equal(x.f.pendingRequests.length, 0);
  } finally {
    x.f.ephemeralRuns.delete('assistant');
    x.f.openLogical.delete('assistant');
    await x.close();
  }
});

test('stale continuations retain frame-owned tokens just as the agent-gone drop does', async () => {
  const remainingTokens: unknown[] = [];
  for (const entry of ['scheduler', 'direct start', 'agent gone'] as const) {
    const x = await frameworkFor();
    const agent = x.framework.getAgent('assistant')!;
    try {
      const request = await x.request(reply(), 'endpoint-a', 'context_budget_restart');
      const routing = x.f.routingOf('assistant');
      routing.reply = workOf(request)[0];
      (request as any)[replyOwner] = routing.turnId;
      x.f.openLogical.delete('assistant');
      x.f.activeTurnTokens.set('assistant', 99);
      const aborted: any[] = [];
      x.framework.onTrace(event => { if (event.type === 'inference:aborted') aborted.push(event); });
      if (entry === 'direct start') await x.f.startAgentStream(agent, request);
      else {
        if (entry === 'agent gone') x.f.agents.delete('assistant');
        x.f.pendingRequests.push(request);
        await x.f.processInferenceRequests();
      }
      assert.equal(aborted.length, 1);
      assert.equal(x.f.settledTurns.has(routing), true);
      remainingTokens.push(x.f.activeTurnTokens.get('assistant'));
    } finally {
      x.f.agents.set('assistant', agent);
      x.f.activeTurnTokens.delete('assistant');
      await x.close();
    }
  }
  assert.deepEqual(remainingTokens, [99, 99, 99], 'only the owning frame releases its token');
});
