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

async function wake(proseRouting: 'disabled' | 'explicit', request: Record<string, unknown> | 'silent') {
  const x = await make(proseRouting);
  try {
    if (request === 'silent') {
      (x.framework as any).handleMcplPushEvent({
        type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
        eventId: 'hb-1', content: [], timestamp: new Date().toISOString(),
        origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-05 12:00:00 PT' },
        inferenceId: 'inf-1', triggerInference: true,
      });
    } else {
      (x.framework as any).pendingRequests.push({ agentName: 'assistant', timestamp: Date.now(), ...request });
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

  it('leaves explicit mode unchanged: a batched gate wake shows no typing', async () => {
    assert.deepEqual(await wake('explicit', { reason: 'gate', source: 'gate', wakeChannelId: 'zulip:support' }), []);
    assert.deepEqual(
      await wake('explicit', { reason: 'channel-message', source: 'zulip', channelId: 'zulip:support', addressed: true }),
      ['zulip:support'],
    );
  });
});

/**
 * The real path: an incoming channel message goes through the ChannelRegistry,
 * a debounced EventGate wake (which carries only wakeChannelId), and the
 * tune-out coordinator; typing is recorded at the registry's sendTypingFn.
 */
async function makeRealPath(tunedOut: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'disabled-typing-real-'));
  const membrane = { streamYielding: () => new MockYieldingStream([createMockResponse([])]) };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane as any,
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting: 'disabled' }],
    modules: [],
    gate: { config: { default: 'always', policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 50 } }] } },
  } as any);
  const typing: { channelId: string; op: string }[] = [];
  const server = { grant: new CapabilityGrant(new Set(['channels.typing']), []) };
  const servers = { getServer: () => server } as any;
  const f = framework as any;
  const registry = new ChannelRegistry(servers, {} as any, (e: any) => f.pushEvent(e), () => {}, {
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
  if (tunedOut) {
    registry.enterTuneOut('zulip', 'zulip:support', {
      epochId: 'epoch-1', cadenceSeconds: 3600, backlogCap: 20, maxWakes: 5, startedAtSequence: f.store.currentSequence(),
    } as any, 'agent-tool' as any);
  }
  registry.handleIncoming('zulip', { messages: [{
    channelId: 'zulip:support', messageId: 'm1', author: { id: 'u1', name: 'Human' },
    timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'ambient traffic' }],
    tags: ['chat:ambient', 'chat:from-human'],
  }] } as any);
  await framework.runUntilIdle();
  await new Promise((r) => setTimeout(r, 120)); // let the debounce fire
  await framework.runUntilIdle();
  const result = { typing, intervals: (registry as any).typingIntervals.size as number };
  await framework.stop(); rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('typing with proseRouting disabled, through the real gate and registry', () => {
  it('a debounced ambient wake types where it came from, then stops', async () => {
    const { typing, intervals } = await makeRealPath(false);
    assert.deepEqual(typing, [{ channelId: 'zulip:support', op: 'start' }, { channelId: 'zulip:support', op: 'stop' }]);
    assert.equal(intervals, 0);
  });

  it('a tuned-out channel shows no typing, even when its traffic reaches the gate', async () => {
    const { typing } = await makeRealPath(true);
    assert.deepEqual(typing, []);
  });
});
