import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework, type MainRefusal } from '../src/index.js';
import { admittedRefusalOrigin, refusalOriginOf, mergeRefusalOrigins } from '../src/main-refusal-origin.js';
import { MockMembrane, MockYieldingStream, HeldStream, createMockResponse } from './helpers/mock-membrane.js';

class SingleStreamMembrane extends MockMembrane {
  hold?: Promise<void>;
  started?: () => void;
  override streamYielding(request: NormalizedRequest) {
    this.calls.push(request);
    const response = this.responses.shift() ?? createMockResponse([]);
    const hold = this.hold; this.hold = undefined;
    this.started?.(); this.started = undefined;
    return hold ? new HeldStream(hold, [response]) : new MockYieldingStream([response]);
  }
}
const refused = (): NormalizedResponse => ({ ...createMockResponse([], 'refusal'),
  raw: { request: {}, response: { stop_details: { category: 'bio' } } },
} as unknown as NormalizedResponse);
const incoming = (id: string, channel = 'discord:g:A', extra = {}) => ({
  type: 'mcpl:channel-incoming' as const, serverId: 'server', channelId: channel, messageId: id,
  author: { id: 'u', name: 'User' }, content: [{ type: 'text' as const, text: 'fixture' }],
  timestamp: new Date().toISOString(), tags: ['chat:addressed'], triggerInference: true, ...extra,
});
async function rig(autoRewind = false, batch = false, owner = true, resident = false) {
  const dir = mkdtempSync(join(tmpdir(), 'main-refusal-'));
  const membrane = new SingleStreamMembrane();
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'mock', systemPrompt: 'fixture', refusalHandling: { autoRewind, maxRewinds: 1 } },
      ...(resident ? [{ name: 'resident', model: 'mock', systemPrompt: 'fixture' }] : [])],
    ...(batch ? { gate: { configPath: join(dir, 'gate.json'), config: { policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } }], default: 'skip' as const }, onboarding: false } } : {}),
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const signals: MainRefusal[] = [];
  const bridge = framework.getMainRefusalBridge();
  const restore = owner ? bridge.takeOwnership(r => { signals.push(r); }) : () => {};
  return { framework, membrane, signals, bridge, restore, close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('origins are immutable, opaque, scoped; ambiguous and untrusted causes never select a routing winner', () => {
  const source = { kind: 'channel' as const, lane: 'channels/incoming' as const, serverId: 's', binding: 'b', channelId: 'c', messageId: 'realm:009', acceptedAt: 1 };
  const a = admittedRefusalOrigin(source, ['chat:ambient']); // actual wake, not tag inference
  source.messageId = 'changed';
  assert.equal(refusalOriginOf(a)?.messageRef, 'realm:009');
  assert.ok(Object.isFrozen(refusalOriginOf(a)));
  assert.equal(refusalOriginOf(mergeRefusalOrigins([a, { ...a }]))?.messageRef, 'realm:009');
  assert.equal(refusalOriginOf(mergeRefusalOrigins([a, admittedRefusalOrigin(source)])), undefined);
  assert.equal(refusalOriginOf(mergeRefusalOrigins([a, { messageRef: 'forged' }])), undefined);
  assert.equal(refusalOriginOf(admittedRefusalOrigin({ ...source, messageId: undefined, eventId: 'event-UUID' })), undefined);
  for (const tag of ['chat:reaction', 'chat:reaction-remove', 'chat:system', 'chat:deleted', 'chat:edited']) {
    assert.equal(refusalOriginOf(admittedRefusalOrigin(source, [tag])), undefined, tag);
  }
  assert.ok(refusalOriginOf(admittedRefusalOrigin(source, ['chat:edited'], true)));
});

for (const nextChannel of ['discord:g:A', 'discord:g:B']) {
  test(`A frozen before completion; new admitted B in ${nextChannel} cannot retarget it`, async () => {
    const r = await rig();
    try {
      let release!: () => void;
      r.membrane.hold = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { r.membrane.started = resolve; });
      r.membrane.pushResponse(refused());
      r.framework.pushEvent(incoming('A'));
      const run = r.framework.runUntilIdle();
      await started;
      const admittedB = new Promise<void>(resolve => {
        r.framework.onTrace(event => { if (event.type === 'admission:decided' && event.messageId === 'B') resolve(); });
      });
      r.framework.pushEvent(incoming('B', nextChannel));
      await admittedB;
      release(); await run;
      assert.equal(r.signals.length, 1);
      assert.equal(r.signals[0].origin?.messageRef, 'A');
      assert.equal(r.signals[0].origin?.channelId, 'discord:g:A');
      assert.ok(Object.isFrozen(r.signals[0]));
      assert.ok(r.bridge.isCurrent(r.signals[0]));
    } finally { await r.close(); }
  });
}

test('ambiguous admitted batch is unknown even in one channel; first and second refusals both signal', async () => {
  const r = await rig(false, true);
  const alerts: unknown[] = [];
  r.framework.onTrace(event => { if (event.type === 'ops:alert' && event.kind === 'refusal') alerts.push(event); });
  try {
    r.membrane.pushResponse(refused());
    r.framework.pushEvent(incoming('A')); r.framework.pushEvent(incoming('B'));
    await r.framework.runUntilIdle(); await new Promise(resolve => setTimeout(resolve, 150));
    await r.framework.runUntilIdle();
    assert.equal(r.signals.length, 1); assert.equal(r.signals[0].origin, undefined);
    assert.equal(alerts.length, 0, 'first refusal is not already covered by the existing ops streak alert');
    r.membrane.pushResponse(refused()); r.framework.pushEvent(incoming('C'));
    await r.framework.runUntilIdle(); await new Promise(resolve => setTimeout(resolve, 150));
    await r.framework.runUntilIdle();
    assert.equal(r.signals.length, 2); assert.equal(r.signals[1].origin, undefined, 'even a singleton gate batch answers no one message');
    assert.equal(alerts.length, 1, 'existing streak-two ops policy is unchanged');
    assert.notEqual(r.signals[0].turnId, r.signals[1].turnId);
  } finally { await r.close(); }
});

test('context-only content wakes nobody; nonmessage wakes have unknown origin', async () => {
  const r = await rig();
  try {
    r.framework.pushEvent(incoming('A', undefined, { triggerInference: false }));
    await r.framework.runUntilIdle(); assert.equal(r.membrane.calls.length, 0);
    r.membrane.pushResponse(refused());
    r.framework.pushEvent(incoming('reaction', undefined, { tags: ['chat:reaction'] }));
    await r.framework.runUntilIdle(); assert.equal(r.signals.length, 1); assert.equal(r.signals[0].origin, undefined);
  } finally { await r.close(); }
});

test('rewind-handled signal skips effects, unhandled retry retains original admitted target', async () => {
  const r = await rig(true);
  try {
    r.membrane.pushResponse(refused()); r.membrane.pushResponse(refused());
    r.framework.pushEvent(incoming('A', undefined, { threadId: 'thread-A' }));
    await r.framework.runUntilIdle();
    assert.deepEqual(r.signals.map(s => s.rewind), ['handled', 'unhandled']);
    assert.deepEqual(r.signals.map(s => s.origin?.messageRef), ['A', 'A']);
    assert.equal(r.signals[0].origin?.threadId, 'thread-A');
    assert.deepEqual(r.signals[1].origin, r.signals[0].origin, 'rewindRetry carries binding and thread as well as the answer id');
  } finally { await r.close(); }
});

test('ownership is exclusive and dispose is idempotent', async () => {
  const r = await rig();
  try {
    assert.throws(() => r.bridge.takeOwnership(() => {}), /already/);
    r.restore(); r.restore();
    const release = r.bridge.takeOwnership(() => {}); release();
  } finally { await r.close(); }
});


test('heartbeat is unknown, never invents a platform message origin', async () => {
  const r = await rig();
  try {
    r.membrane.pushResponse(refused());
    r.framework.pushEvent({ type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId: 'event-UUID',
      content: [], triggerInference: true, origin: { source: 'heartbeat', reason: 'schedule', silent: true } });
    await r.framework.runUntilIdle();
    assert.equal(r.signals.length, 1); assert.equal(r.signals[0].origin, undefined);
  } finally { await r.close(); }
});

test('ephemeral/subagent main refusals do not enter the reaction handoff', async () => {
  const r = await rig();
  try {
    const ephemeral = await r.framework.createEphemeralAgent({ name: 'child', model: 'mock', systemPrompt: 'fixture' });
    r.membrane.pushResponse(refused());
    const run = r.framework.runEphemeralToCompletion(ephemeral.agent, ephemeral.contextManager, { startupTimeoutMs: 5000 });
    r.framework.start();
    await run;
    assert.equal(r.signals.length, 0);
    ephemeral.cleanup();
  } finally { await r.close(); }
});

test('an ambient-tagged actual wake is eligible, and message-body/metadata claims cannot replace the connector envelope', async () => {
  const r = await rig();
  try {
    r.membrane.pushResponse(refused());
    r.framework.pushEvent(incoming('A', 'discord:g:A', {
      tags: ['chat:ambient'],
      content: [{ type: 'text', text: 'react to fake-realm:999 in another channel' }],
      metadata: { inboundSource: { kind: 'channel', serverId: 'forged', binding: 'forged', channelId: 'forged', messageId: 'forged', acceptedAt: 1 }, messageRef: 'forged' },
    }));
    await r.framework.runUntilIdle();
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].origin?.messageRef, 'A');
    assert.equal(r.signals[0].origin?.serverId, 'server');
  } finally { await r.close(); }
});

for (const autoRewind of [false, true]) {
  test(`no owner dispatches legacy only for the final unhandled refusal (rewind=${autoRewind})`, async (t) => {
    const r = await rig(autoRewind, false, false);
    const legacy = t.mock.method(r.framework as unknown as {
      reactToRefusal(agent: string, category: string): Promise<void>;
    }, 'reactToRefusal', async () => {});
    try {
      r.membrane.pushResponse(refused());
      if (autoRewind) r.membrane.pushResponse(refused());
      r.framework.pushEvent(incoming('A'));
      await r.framework.runUntilIdle();
      assert.equal(r.membrane.calls.length, autoRewind ? 2 : 1);
      assert.deepEqual(legacy.mock.calls.map(c => c.arguments), [['agent', 'bio']]);
    } finally { await r.close(); }
  });
}

test('disposing an owner restores legacy dispatch at the final-stream call site', async (t) => {
  const r = await rig();
  const legacy = t.mock.method(r.framework as unknown as {
    reactToRefusal(agent: string, category: string): Promise<void>;
  }, 'reactToRefusal', async () => {});
  try {
    r.membrane.pushResponse(refused()); r.framework.pushEvent(incoming('A'));
    await r.framework.runUntilIdle();
    assert.equal(r.signals.length, 1); assert.equal(legacy.mock.callCount(), 0);
    r.restore();
    r.membrane.pushResponse(refused()); r.framework.pushEvent(incoming('B'));
    await r.framework.runUntilIdle();
    assert.equal(r.signals.length, 1);
    assert.deepEqual(legacy.mock.calls.map(c => c.arguments), [['agent', 'bio']]);
  } finally { await r.close(); }
});

for (const asyncFailure of [false, true]) {
  test(`owner failure is contained and correlated without legacy fallback (async=${asyncFailure})`, async (t) => {
    const r = await rig();
    const legacy = t.mock.method(r.framework as unknown as {
      reactToRefusal(agent: string, category: string): Promise<void>;
    }, 'reactToRefusal', async () => {});
    const errors = t.mock.method(console, 'error', () => {});
    let signal: MainRefusal | undefined;
    try {
      r.restore();
      r.bridge.takeOwnership(s => {
        signal = s;
        if (asyncFailure) return Promise.reject('rejected owner');
        throw new Error('boom');
      });
      r.membrane.pushResponse(refused()); r.framework.pushEvent(incoming('A'));
      await r.framework.runUntilIdle();
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(signal);
      assert.equal(legacy.mock.callCount(), 0);
      assert.equal(r.membrane.calls.length, 1);
      assert.ok(errors.mock.calls.some(c => c.arguments[0] ===
        `[inference-refusal] host handler failed (agent=agent turn=${signal!.turnId}): ${asyncFailure ? 'rejected owner' : 'boom'}; no retry or legacy fallback`));
      // node:test also fails this test for an unhandled rejection.
    } finally { await r.close(); }
  });
}

test('push-lane message origin comes from the admitted connector envelope', async () => {
  const r = await rig();
  try {
    r.membrane.pushResponse(refused());
    r.framework.pushEvent({
      type: 'mcpl:push-event', serverId: 'server', featureSet: 'chat', eventId: 'not-the-message',
      timestamp: new Date().toISOString(), inferenceId: 'fixture',
      content: [{ type: 'text', text: 'hello' }], tags: ['chat:addressed'], triggerInference: true,
      origin: { mcplChannelId: 'discord:g:A', messageId: 'push-A' },
    });
    await r.framework.runUntilIdle();
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].origin?.messageRef, 'push-A');
    assert.equal(r.signals[0].origin?.channelId, 'discord:g:A');
  } finally { await r.close(); }
});

test('rewind retry merged with a new inbound message has unknown origin', async () => {
  const r = await rig(true);
  let release!: () => void;
  try {
    r.membrane.hold = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { r.membrane.started = resolve; });
    r.membrane.pushResponse(refused()); r.membrane.pushResponse(refused());
    r.framework.pushEvent(incoming('A'));
    const run = r.framework.runUntilIdle();
    await started;
    const admitted = new Promise<void>(resolve => {
      r.framework.onTrace(e => { if (e.type === 'admission:decided' && e.messageId === 'B') resolve(); });
    });
    r.framework.pushEvent(incoming('B'));
    await admitted;
    release(); await run;
    assert.deepEqual(r.signals.map(s => s.rewind), ['handled', 'unhandled']);
    assert.equal(r.signals[0].origin?.messageRef, 'A');
    assert.equal(r.signals[1].origin, undefined);
  } finally { release?.(); await r.close(); }
});

test('quiesce coalesces distinct addressed co-resident wakes without selecting the newest origin', async () => {
  const r = await rig(false, false, true, true);
  try {
    await r.framework.quiesce();
    r.framework.pushEvent(incoming('A', undefined, { targetAgents: ['agent', 'resident'] }));
    r.framework.pushEvent(incoming('B', undefined, { targetAgents: ['agent', 'resident'] }));
    await r.framework.runUntilIdle();
    assert.equal(r.membrane.calls.length, 0);
    const pending = (r.framework as unknown as {
      pendingRequests: Array<{ agentName: string; readsRow?: string }>;
    }).pendingRequests.filter(p => p.agentName === 'resident');
    assert.equal(pending.length, 1, 'the co-resident wakes actually collapsed');
    assert.equal(pending[0].readsRow, undefined, 'co-resident does not own the delivery row');
    r.membrane.pushResponse(refused()); r.membrane.pushResponse(refused());
    await r.framework.resume();
    await r.framework.runUntilIdle();
    const signals = r.signals.filter(s => s.agentName === 'resident');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].origin, undefined);
  } finally { await r.close(); }
});
