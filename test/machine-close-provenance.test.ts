import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

/**
 * Machine-close provenance + explicit-open protection (issue #5): closes
 * invoked by housekeeping modules must record their own decision source —
 * never 'agent-tool' — and must not override a channel the resident or
 * operator explicitly opened, unless the caller certifies an explicit idle
 * lease. The Mythos "channel settings keep getting reset" mechanism was
 * subscription-GC closes wearing the agent's badge.
 */

function makeRegistry() {
  const closeCalls: Array<{ channelId?: string }> = [];
  const mockServer = {
    // Post-policy state: full grant, so tests exercise delivery, not §5.3 denial.
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async (params: { channelId?: string }) => {
      closeCalls.push(params);
      return {};
    },
    sendChannelsPublish: async () => ({ delivered: true }),
  };
  const serverRegistry = {
    getServer: (_id: string) => mockServer,
  } as unknown as McplServerRegistry;

  const registry = new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
  );

  const internals = registry as unknown as {
    desiredStates: Map<string, { state: 'open' | 'closed'; source: string }>;
    lifecycleKey(serverId: string, channelId: string): string;
    setDesiredState(serverId: string, channelId: string, desired: 'open' | 'closed', source: string): void;
  };
  const desired = (channelId: string) =>
    internals.desiredStates.get(internals.lifecycleKey('discord', channelId));

  // Register the channel the way a live server would surface it.
  registry.handleIncoming('discord', {
    messages: [{
      channelId: 'c1',
      messageId: 'm1',
      author: { id: 'u1', name: 'Antra' },
      timestamp: '2026-07-28T00:00:00.000Z',
      content: [{ type: 'text' as const, text: 'hello' }],
      metadata: { channelName: '#commons' },
    }],
  });

  return { registry, internals, desired, closeCalls };
}

const MODULE_ORIGIN = { kind: 'module' as const };

test('a machine close of an explicitly-opened channel is refused, structurally', async () => {
  const { registry, desired, closeCalls } = makeRegistry();
  await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });
  assert.deepEqual(desired('c1'), { state: 'open', source: 'agent-tool' });

  const result = await registry.handleChannelToolCall(
    'channel_close',
    { channelId: 'c1', source: 'subscription-gc' },
    MODULE_ORIGIN,
  );
  assert.equal(result.success, false);
  assert.equal((result.data as { refusal?: string })?.refusal, 'explicit-open');
  // Stated intent survives: desired state untouched, nothing sent to the server.
  assert.deepEqual(desired('c1'), { state: 'open', source: 'agent-tool' });
  assert.equal(closeCalls.length, 0);
});

test('an explicit idle lease lets the machine close through, with honest provenance', async () => {
  const { registry, desired, closeCalls } = makeRegistry();
  await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });

  const result = await registry.handleChannelToolCall(
    'channel_close',
    { channelId: 'c1', source: 'subscription-gc', overrideExplicitOpen: true },
    MODULE_ORIGIN,
  );
  assert.equal(result.success, true);
  // The durable record names the janitor, not the agent.
  assert.deepEqual(desired('c1'), { state: 'closed', source: 'subscription-gc' });
  assert.equal(closeCalls.length, 1);
});

test('agent closes are recorded as agent-tool, exactly as before', async () => {
  const { registry, desired } = makeRegistry();
  await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });
  const result = await registry.handleChannelToolCall(
    'channel_close',
    { channelId: 'c1' },
    { kind: 'agent', agentName: 'mythos' },
  );
  assert.equal(result.success, true);
  assert.deepEqual(desired('c1'), { state: 'closed', source: 'agent-tool' });
});

test('machine closes of policy-opened channels proceed without a lease', async () => {
  const { registry, internals, desired, closeCalls } = makeRegistry();
  // A channel nobody explicitly chose — opened by delivery/policy.
  internals.setDesiredState('discord', 'c1', 'open', 'opened-by-delivery');

  const result = await registry.handleChannelToolCall(
    'channel_close',
    { channelId: 'c1', source: 'subscription-gc' },
    MODULE_ORIGIN,
  );
  assert.equal(result.success, true);
  assert.deepEqual(desired('c1'), { state: 'closed', source: 'subscription-gc' });
  assert.equal(closeCalls.length, 1);
});

test('forged machine fields on a MODEL-origin call are ignored: agent-tool is recorded', async () => {
  const { registry, desired, closeCalls } = makeRegistry();
  await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });

  // The schema omits these fields but does not reject extras — a model can
  // emit them. Trusted dispatch context must win over self-description.
  const result = await registry.handleChannelToolCall(
    'channel_close',
    { channelId: 'c1', source: 'subscription-gc', overrideExplicitOpen: true },
    { kind: 'agent', agentName: 'mythos' },
  );
  assert.equal(result.success, true);
  // The close succeeds (the resident may close their own channel) but the
  // record attributes it to them, not to housekeeping.
  assert.deepEqual(desired('c1'), { state: 'closed', source: 'agent-tool' });
  assert.equal(closeCalls.length, 1);
});

test('origin-less calls default to agent semantics (safe for legacy callers)', async () => {
  const { registry, desired } = makeRegistry();
  await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });
  const result = await registry.handleChannelToolCall('channel_close', {
    channelId: 'c1',
    source: 'subscription-gc',
    overrideExplicitOpen: true,
  });
  assert.equal(result.success, true);
  assert.deepEqual(desired('c1'), { state: 'closed', source: 'agent-tool' });
});

test('module-origin closes outside the closed source vocabulary are rejected loudly', async () => {
  const { registry, desired } = makeRegistry();
  await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });
  const result = await registry.handleChannelToolCall(
    'channel_close',
    { channelId: 'c1', source: 'gremlin-module' },
    MODULE_ORIGIN,
  );
  assert.equal(result.success, false);
  assert.equal(result.isError, true);
  assert.match(result.error ?? '', /Unknown machine close source/);
  assert.deepEqual(desired('c1'), { state: 'open', source: 'agent-tool' });
});
