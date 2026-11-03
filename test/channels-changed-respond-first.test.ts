import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

/**
 * #160: a server that serves one request at a time and announces a channel
 * from inside a request (a `refresh_channels` tool call) cannot read the
 * channels/open or channels/close that reconciling sends until its
 * `channels/changed` is answered. The mock models exactly that: every
 * lifecycle request the host sends stays unread until the responder fires.
 */
function makeSerializedServer() {
  const order: string[] = [];
  let release!: () => void;
  const loopFree = new Promise<void>((resolve) => { release = resolve; });

  const serve = (kind: 'open' | 'close') => async (params: { channelId?: string }) => {
    order.push(`${kind}-sent:${params.channelId}`);
    await loopFree;
    order.push(`${kind}-served:${params.channelId}`);
    return {};
  };
  const mockServer = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: serve('open'),
    sendChannelsClose: serve('close'),
  };
  const registry = new ChannelRegistry(
    { getServer: (_id: string) => mockServer } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
  );

  let response: unknown;
  const responder = {
    respond: (result: unknown) => {
      order.push('responded');
      response = result;
      release();
    },
  };
  return { registry, responder, order, response: () => response };
}

function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('channels/changed answers before reconciling, so a serialized server is not deadlocked (#160)', async () => {
  const { registry, responder, order, response } = makeSerializedServer();
  registry.setSubscriptionPolicy('zulip', ['zulip:devops']);

  await withinMs(
    registry.handleChanged('zulip', {
      added: [
        { id: 'zulip:devops', type: 'zulip', label: '#devops', direction: 'bidirectional' },
        { id: 'zulip:random', type: 'zulip', label: '#random', direction: 'bidirectional' },
      ],
    } as never, responder),
    2000,
    'handleChanged',
  );

  assert.deepEqual(response(), {
    results: [
      { id: 'zulip:devops', accepted: true },
      { id: 'zulip:random', accepted: true },
    ],
  });
  assert.equal(order[0], 'responded', `the response goes out before any lifecycle request: ${order.join(', ')}`);
  // Reconciliation still runs to completion after the response: the policy
  // channel is opened, the other is closed.
  assert.ok(order.includes('open-served:zulip:devops'), order.join(', '));
  assert.ok(order.includes('close-served:zulip:random'), order.join(', '));
});

test('channels/changed with nothing added still answers once, without reconciling', async () => {
  const { registry, responder, order, response } = makeSerializedServer();

  await withinMs(
    registry.handleChanged('zulip', { removed: ['zulip:gone'] } as never, responder),
    2000,
    'handleChanged',
  );

  assert.deepEqual(order, ['responded']);
  assert.deepEqual(response(), {
    results: [{ id: 'zulip:gone', accepted: false, reason: 'not registered' }],
  });
});
