import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

async function make(proseRouting: 'disabled' | 'explicit') {
  const dir = mkdtempSync(join(tmpdir(), 'disabled-typing-af-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting }],
    modules: [],
  });
  const typing: string[] = [];
  (framework as any).channelRegistry = new Proxy({
    resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
    routeSpeech: async () => ({ delivered: true, channelId: 'world:commons' }),
    startTyping: (channel: string) => { typing.push(channel); },
    stopTyping: () => {},
    getChannelTools: () => [], getDescriptor: () => undefined,
  }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
  // In explicit mode, prose with no `>>` target keeps this run from going idle
  // (the mock answers every further call with prose); a turn with no prose ends.
  membrane.pushResponse(createMockResponse(
    (proseRouting === 'explicit' ? [] : [{ type: 'text', text: 'working on it' }]) as ContentBlock[]));
  return { dir, framework, typed: () => [...new Set(typing)] };
}

async function wake(
  proseRouting: 'disabled' | 'explicit',
  request: Record<string, unknown> | Record<string, unknown>[] | 'silent',
  homes: Record<string, string> = {},
) {
  const x = await make(proseRouting);
  for (const [agent, home] of Object.entries(homes)) (x.framework as any).conversationAgentHomes.set(agent, home);
  try {
    if (request === 'silent') {
      (x.framework as any).handleMcplPushEvent({
        type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
        eventId: 'hb-1', content: [], timestamp: new Date().toISOString(),
        origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-05 12:00:00 PT' },
        inferenceId: 'inf-1', triggerInference: true,
      });
    } else {
      const now = Date.now();
      for (const [i, r] of (Array.isArray(request) ? request : [request]).entries()) {
        (x.framework as any).pendingRequests.push({ agentName: 'assistant', timestamp: now + i, ...r });
      }
    }
    await x.framework.runUntilIdle();
    return x.typed();
  } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
}

describe('typing with proseRouting disabled', () => {
  it('shows typing on the channel the trigger came from', async () => {
    const typed = await wake('disabled', { reason: 'channel-message', source: 'zulip', channelId: 'zulip:support', addressed: true });
    assert.deepEqual(typed, ['zulip:support']);
  });

  it('shows typing where a batched gate wake came from (wakeChannelId)', async () => {
    const typed = await wake('disabled', { reason: 'gate', source: 'gate', wakeChannelId: 'zulip:support' });
    assert.deepEqual(typed, ['zulip:support']);
  });

  it('keeps a silent wake private: no typing', async () => {
    assert.deepEqual(await wake('disabled', 'silent'), []);
  });

  it('shows no typing for a wake that names no channel', async () => {
    assert.deepEqual(await wake('disabled', { reason: 'heartbeat', source: 'heartbeat' }), []);
  });

  it('a silent request batched with ordinary ones does not pick the turn\'s channel', async () => {
    const silent = { reason: 'heartbeat', source: 'heartbeat', suppressProse: true, channelId: 'zulip:private', wakeChannelId: 'zulip:private' };
    assert.deepEqual(await wake('disabled', [silent, { reason: 'heartbeat', source: 'heartbeat' }]), []);
    assert.deepEqual(
      await wake('disabled', [silent, { reason: 'channel-message', source: 'zulip', channelId: 'zulip:support' }]),
      ['zulip:support'],
    );
  });

  it('a gate wake types only where the channel\'s messages reach this agent', async () => {
    const gate = (ch: string) => ({ reason: 'gate', source: 'gate', wakeChannelId: ch });
    // This agent is the fork bound to zulip:b: only its home channel.
    assert.deepEqual(await wake('disabled', gate('zulip:a'), { assistant: 'zulip:b' }), []);
    assert.deepEqual(await wake('disabled', gate('zulip:b'), { assistant: 'zulip:b' }), ['zulip:b']);
    // Another fork owns zulip:a: not this agent's channel.
    assert.deepEqual(await wake('disabled', gate('zulip:a'), { 'fork-1': 'zulip:a' }), []);
    assert.deepEqual(await wake('disabled', gate('zulip:c'), { 'fork-1': 'zulip:a' }), ['zulip:c']);
  });

  it('leaves explicit mode unchanged: a batched gate wake shows no typing', async () => {
    assert.deepEqual(await wake('explicit', { reason: 'gate', source: 'gate', wakeChannelId: 'zulip:support' }), []);
    assert.deepEqual(
      await wake('explicit', { reason: 'channel-message', source: 'zulip', channelId: 'zulip:support', addressed: true }),
      ['zulip:support'],
    );
  });
});

/**
 * The real path: typing is recorded at the ChannelRegistry's sendTypingFn,
 * with the real EventGate (debounce) and TuneOutCoordinator in place.
 */
async function makeRealPath(opts: { tunedOut?: boolean; onStream?: (registry: ChannelRegistry) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'disabled-typing-real-'));
  let streams = 0;
  let registry!: ChannelRegistry;
  const membrane = {
    streamYielding: () => { streams++; opts.onStream?.(registry); return new MockYieldingStream([createMockResponse([])]); },
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane as any,
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting: 'disabled' }],
    modules: [],
    gate: { config: { default: 'always', policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } }] } },
  } as any);
  const typing: { channelId: string; op: string }[] = [];
  const server = { grant: new CapabilityGrant(new Set(['channels.typing']), []) };
  const servers = { getServer: () => server } as any;
  const f = framework as any;
  registry = new ChannelRegistry(servers, {} as any, (e: any) => f.pushEvent(e), () => {}, {
    store: f.store,
    shouldTriggerInference: f.eventGate.asShouldTriggerCallback(),
    sendTypingFn: (_s: string, channelId: string, _m: unknown, op?: string) => { typing.push({ channelId, op: op ?? 'start' }); },
  } as any);
  (registry as any).channels.set('zulip:zulip:support', {
    serverId: 'zulip', open: true,
    descriptor: { id: 'zulip:support', type: 'zulip-stream', address: { streamId: 1 }, label: 'support' },
  });
  f.channelRegistry = registry;
  f.tuneOutCoordinator = new TuneOutCoordinator(registry, servers, {
    addMessage: (p: any, c: any, m: any, a: any) => f.addMessage(p, c, m, a ? { forAgent: a } : undefined),
    requestInference: (agentName: string, reason: string, source: string) => f.pendingRequests.push({ agentName, reason, source, timestamp: Date.now() }),
    subconsciousName: () => 'Subconscious', primaryName: () => 'assistant',
    getStoredMessages: () => f.getAgent('assistant').getContextManager().getAllMessages(),
    currentSequence: () => f.store.currentSequence(), setSubconsciousAnchor() {},
    isForkBound: () => false, isPrivilegedAuthor: () => false, allowChannelSpeech: () => false,
    emitTrace: () => {},
  } as any);
  const tuneOut = () => registry.enterTuneOut('zulip', 'zulip:support', {
    epochId: 'epoch-1', cadenceSeconds: 3600, backlogCap: 20, maxWakes: 5, startedAtSequence: f.store.currentSequence(),
  } as any, 'agent-tool' as any);
  if (opts.tunedOut) tuneOut();
  return {
    framework, registry, typing, tuneOut,
    streams: () => streams,
    starts: () => typing.filter((t) => t.op === 'start').map((t) => t.channelId),
    async ambient() {
      registry.handleIncoming('zulip', { messages: [{
        channelId: 'zulip:support', messageId: 'm1', author: { id: 'u1', name: 'Human' },
        timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'ambient traffic' }],
        tags: ['chat:ambient', 'chat:from-human'],
      }] } as any);
      await framework.runUntilIdle();
      await new Promise((r) => setTimeout(r, 300)); // past the 100 ms debounce
      await framework.runUntilIdle();
    },
    async request(r: Record<string, unknown>) {
      f.pendingRequests.push({ agentName: 'assistant', timestamp: Date.now(), ...r });
      await framework.runUntilIdle();
    },
    async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('typing with proseRouting disabled, through the real gate and registry', () => {
  it('a debounced ambient wake types where it came from, then stops', async () => {
    const x = await makeRealPath();
    try {
      await x.ambient();
      assert.equal(x.streams(), 1, 'the gate wake ran a turn');
      assert.deepEqual(x.typing, [{ channelId: 'zulip:support', op: 'start' }, { channelId: 'zulip:support', op: 'stop' }]);
      assert.equal((x.registry as any).typingIntervals.size, 0);
    } finally { await x.close(); }
  });

  it('a tuned-out channel shows no typing when its traffic still reaches the gate', async () => {
    const x = await makeRealPath({ tunedOut: true });
    try {
      await x.ambient();
      assert.equal(x.streams(), 1, 'the gate wake ran a turn');
      assert.deepEqual(x.starts(), []);
    } finally { await x.close(); }
  });

  it('a tuned-out channel shows no typing for a push that names it, ambient or addressed', async () => {
    for (const addressed of [false, true]) {
      const x = await makeRealPath({ tunedOut: true });
      try {
        await x.request({ reason: 'mcpl:push-event', source: 'zulip', channelId: 'zulip:support', addressed });
        assert.equal(x.streams(), 1, 'the push ran a turn');
        assert.deepEqual(x.starts(), [], `addressed=${addressed}`);
      } finally { await x.close(); }
    }
  });

  it('tune-out entered mid-turn, before the stream starts, stops the typing already running there', async () => {
    let intervalsAfterTuneOut = -1;
    const x = await makeRealPath({
      onStream: (registry) => {
        x.tuneOut();
        intervalsAfterTuneOut = (registry as any).typingIntervals.size;
      },
    });
    try {
      await x.request({ reason: 'mcpl:push-event', source: 'zulip', channelId: 'zulip:support', addressed: true });
      assert.equal(x.streams(), 1);
      assert.equal(intervalsAfterTuneOut, 0, 'no refresh keeps running after tune-out');
      assert.deepEqual(x.typing, [{ channelId: 'zulip:support', op: 'start' }, { channelId: 'zulip:support', op: 'stop' }]);
    } finally { await x.close(); }
  });

  it('a silent wake that names channels still shows no typing', async () => {
    const x = await makeRealPath();
    try {
      await x.request({ reason: 'heartbeat', source: 'heartbeat', suppressProse: true, channelId: 'zulip:support', wakeChannelId: 'zulip:support' });
      assert.equal(x.streams(), 1);
      assert.deepEqual(x.starts(), []);
    } finally { await x.close(); }
  });
});
