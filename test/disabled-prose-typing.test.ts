/**
 * A disabled prose routing turn's typing indicator (docs/disabled-prose-routing.md):
 * shown where the turn's wake came from, by the rule explicit mode's turns
 * follow, since neither mode has a locus.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ChannelRef, InferenceRequest } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { bindAsConversationFork } from './helpers/dendrite.js';
import { ChannelRegistry, destinationKey } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

type Internals = {
  initializeMcpl(servers: []): Promise<void>;
  channelRegistry: ChannelRegistry;
  mcplServerRegistry: McplServerRegistry;
  pendingRequests: InferenceRequest[];
  eventGate: { requestInferenceFn(agentName: string, reason: string, source: string, provenance?: Record<string, unknown>): void };
  tuneOutCoordinator: unknown;
};

const a: ChannelRef = { serverId: 'a', channelId: 'general' };
const b: ChannelRef = { serverId: 'b', channelId: 'general' };

/** A disabled-mode agent with a real channel registry whose servers a and b
 *  each register `general`, and record each typing start and stop. */
async function residentWith(t: TestContext, opts: { gate?: boolean; beforeInference?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-disabled-typing-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    modules: [],
    ...(opts.gate ? { gate: { config: { policies: [], default: 'skip' as const } } } : {}),
  });
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const i = framework as unknown as Internals;
  await i.initializeMcpl([]);
  const typing: string[] = [];
  const servers = new Map(['a', 'b'].map((id) => [id, {
    id,
    isConnected: true,
    stopReconnecting() {},
    policyEstablished: true,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async () => ({ delivered: true, messageId: `${id}-m` }),
    sendChannelsTyping: (channelId: string, _metadata: unknown, op?: string) => {
      typing.push(`${id} ${op === 'stop' ? 'stop' : 'start'} ${channelId}`);
    },
    sendChannelsOpen: async () => ({}),
    sendBeforeInference: async () => { opts.beforeInference?.(); return { contextInjections: [] }; },
  }]));
  t.mock.method(i.mcplServerRegistry, 'getServer', (id: string) => servers.get(id) as never);
  // The start's hooks reach the servers only where a test asks for them.
  if (opts.beforeInference) t.mock.method(i.mcplServerRegistry, 'getAllServers', () => [...servers.values()] as never);
  const map = (i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
  for (const ref of [a, b]) {
    map.set(destinationKey(ref), { serverId: ref.serverId, descriptor: { id: 'general', type: 'chat', label: '#general' }, open: true });
  }
  let started = 0;
  framework.onTrace((e) => { if ((e as { type: string }).type === 'inference:started') started++; });
  // Each turn writes plain speech, which disabled mode keeps private.
  const turn = () => membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
  const run = async () => { await framework.runUntilIdle(); };
  return { framework, i, typing, started: () => started, turn, run };
}

const starts = (typing: string[]) => typing.filter((c) => c.includes(' start '));

test('a disabled turn shows typing in the channel of the message that woke it, with its server, until the turn ends', async (t) => {
  const r = await residentWith(t);
  r.turn();
  r.i.pendingRequests.push({
    agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'b', timestamp: Date.now(),
    channelId: 'general', channelServerId: 'b', addressed: true,
  });
  await r.run();
  assert.equal(r.started(), 1, 'control: the turn ran');
  assert.deepEqual([...new Set(starts(r.typing))], ['b start general'], `typing showed on b's general only: ${r.typing.join(', ')}`);
  assert.equal(r.typing.at(-1), 'b stop general', `and the turn's end stopped it: ${r.typing.join(', ')}`);
});

test("a disabled turn the gate woke for an addressed message shows typing in that message's channel", async (t) => {
  const r = await residentWith(t, { gate: true });
  r.turn();
  r.i.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', {
    channelId: 'general', routeChannelId: 'general', routeServerId: 'a', counterparty: 'U1', at: Date.now(),
  });
  await r.run();
  assert.equal(r.started(), 1, 'control: the turn ran');
  assert.deepEqual([...new Set(starts(r.typing))], ['a start general'], r.typing.join(', '));
});

test('a disabled turn the gate woke for ambient messages alone shows no typing, as an explicit turn shows none', async (t) => {
  const r = await residentWith(t, { gate: true });
  r.turn();
  // An ambient batch names where it came from for telemetry only (wakeChannelId), never a channel to route by.
  r.i.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', { channelId: 'general', counterparty: 'U1', at: Date.now() });
  await r.run();
  assert.equal(r.started(), 1, 'control: the turn ran');
  assert.deepEqual(starts(r.typing), [], r.typing.join(', '));
});

test('a disabled conversation fork shows typing on its home channel, and not where a gate batch routes another channel', async (t) => {
  const r = await residentWith(t, { gate: true });
  t.after(bindAsConversationFork(r.framework, 'scout', a));
  r.turn();
  r.i.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', {
    channelId: 'general', routeChannelId: 'general', routeServerId: 'b', counterparty: 'U1', at: Date.now(),
  });
  await r.run();
  assert.equal(r.started(), 1, "control: the turn ran");
  assert.ok(!starts(r.typing).includes('b start general'), `no typing in b's general, which isn't its home: ${r.typing.join(', ')}`);

  r.typing.length = 0;
  r.turn();
  r.i.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', {
    channelId: 'general', routeChannelId: 'general', routeServerId: 'a', counterparty: 'U1', at: Date.now(),
  });
  await r.run();
  assert.equal(r.started(), 2, 'control: the second turn ran');
  assert.deepEqual([...new Set(starts(r.typing))], ['a start general'], `typing on its home: ${r.typing.join(', ')}`);
});

test('a silent wake shows no typing in a disabled turn, though its wake names a channel', async (t) => {
  const r = await residentWith(t);
  r.turn();
  r.i.pendingRequests.push({
    agentName: 'scout', reason: 'mcpl:push-event', source: 'heartbeat', timestamp: Date.now(),
    channelId: 'general', channelServerId: 'a', suppressProse: true,
  });
  await r.run();
  assert.equal(r.started(), 1, 'control: the turn ran');
  assert.deepEqual(starts(r.typing), [], r.typing.join(', '));
});

test('a disabled turn shows typing where its waiting wake came from, though that channel was tuned out after the wake was queued', async (t) => {
  const r = await residentWith(t);
  // The channel is held by the time the turn starts. The turn is still at
  // work on that channel's own message, as an explicit mode turn is.
  r.i.tuneOutCoordinator = new Proxy({
    holdFor: (serverId: string, channelId: string) => (serverId === 'a' && channelId === 'general' ? { epochId: 'e1' } : null),
  } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => null) });
  r.turn();
  r.i.pendingRequests.push({
    agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'a', timestamp: Date.now(),
    channelId: 'general', channelServerId: 'a', addressed: true,
  });
  await r.run();
  assert.equal(r.started(), 1, 'control: the turn ran');
  assert.deepEqual([...new Set(starts(r.typing))], ['a start general'], r.typing.join(', '));
});

test("a disabled turn shows its typing again when its stream starts, where something else stopped it during the start's hooks", async (t) => {
  let i: Internals | undefined;
  let cleared = 0;
  // Another turn's end stops every channel's typing (ChannelRegistry.stopTyping()).
  const r = await residentWith(t, { beforeInference: () => { if (cleared++ === 0) i!.channelRegistry.stopTyping(); } });
  i = r.i;
  r.turn();
  r.i.pendingRequests.push({
    agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'a', timestamp: Date.now(),
    channelId: 'general', channelServerId: 'a', addressed: true,
  });
  await r.run();
  assert.ok(cleared > 0, "control: the start's hooks ran");
  const stopped = r.typing.indexOf('a stop general');
  assert.ok(stopped > 0 && r.typing.indexOf('a start general') < stopped, `control: typing showed, then was stopped: ${r.typing.join(', ')}`);
  assert.ok(r.typing.slice(stopped + 1).includes('a start general'), `and showed again in the same channel: ${r.typing.join(', ')}`);
});
