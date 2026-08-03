import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { EventGate } from '../src/gate/event-gate.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { GateConfig } from '../src/gate/types.js';
import type { ChannelsIncomingParams } from '../src/mcpl/types.js';
import type { ProcessEvent } from '../src/types/index.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-roundtrip');

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeGate(config: GateConfig) {
  const configPath = join(TMP_DIR, 'gate.json');
  writeFileSync(configPath, JSON.stringify(config));
  return new EventGate({
    configPath,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
}

function makeRegistry(shouldTriggerInference?: (c: string, m: Record<string, unknown>) => boolean) {
  const pushed: ProcessEvent[] = [];
  const registry = new ChannelRegistry(
    {} as never,
    {} as never,
    (ev) => pushed.push(ev),
    () => {},
    shouldTriggerInference ? { shouldTriggerInference } : undefined,
  );
  // §14.5: incoming no longer mints unknown channels — seed what a
  // conforming server's channels/register would have created.
  for (const id of ['zulip:tracker-miner-f', 'zulip:other-channel']) {
    (registry as unknown as { channels: Map<string, unknown> }).channels.set(`zulip:${id}`, {
      serverId: 'zulip', descriptor: { id, type: 'zulip', label: id }, open: false,
    });
  }

  return { registry, pushed };
}

function incomingParams(channelId: string, text: string): ChannelsIncomingParams {
  return {
    messages: [{
      channelId,
      messageId: 'msg-1',
      author: { id: '42', name: 'Alice' },
      timestamp: new Date().toISOString(),
      content: [{ type: 'text', text }],
    }],
  };
}

// ---------------------------------------------------------------------------
// Contract: ChannelRegistry emits eventType='mcpl:channel-incoming' to the gate
// ---------------------------------------------------------------------------

describe('ChannelRegistry → shouldTriggerInference contract', () => {
  it('emits eventType="mcpl:channel-incoming" in callback metadata', () => {
    const seen: Array<Record<string, unknown>> = [];
    const { registry } = makeRegistry((_content, metadata) => {
      seen.push(metadata);
      return true;
    });

    registry.handleIncoming('zulip', incomingParams('zulip:tracker-miner-f', 'hi'));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].eventType, 'mcpl:channel-incoming');
    assert.strictEqual(seen[0].serverId, 'zulip');
    assert.strictEqual(seen[0].channelId, 'zulip:tracker-miner-f');
  });
});

// ---------------------------------------------------------------------------
// Roundtrip: a recipe-shaped channel policy fires for a channel-incoming event
// ---------------------------------------------------------------------------

describe('ChannelRegistry + EventGate roundtrip', () => {
  it('channel-scoped policy triggers inference on matching channel-incoming', () => {
    const gate = makeGate({
      default: 'skip',
      policies: [
        {
          name: 'tracker-channel',
          match: { scope: ['mcpl:channel-incoming'], channel: 'zulip:tracker-miner-f' },
          behavior: 'always',
        },
      ],
    });

    const { registry, pushed } = makeRegistry(gate.asShouldTriggerCallback());

    registry.handleIncoming('zulip', incomingParams('zulip:tracker-miner-f', 'question in channel'));

    assert.strictEqual(pushed.length, 1);
    const event = pushed[0] as { type: string; triggerInference?: boolean };
    assert.strictEqual(event.type, 'mcpl:channel-incoming');
    assert.strictEqual(event.triggerInference, true);
  });

  it('default:skip wins when no policy matches the channel', () => {
    const gate = makeGate({
      default: 'skip',
      policies: [
        {
          name: 'tracker-channel',
          match: { scope: ['mcpl:channel-incoming'], channel: 'zulip:tracker-miner-f' },
          behavior: 'always',
        },
      ],
    });

    const { registry, pushed } = makeRegistry(gate.asShouldTriggerCallback());

    registry.handleIncoming('zulip', incomingParams('zulip:other-channel', 'noise'));

    assert.strictEqual(pushed.length, 1);
    const event = pushed[0] as { type: string; triggerInference?: boolean };
    assert.strictEqual(event.triggerInference, false);
  });
});

// ---------------------------------------------------------------------------
// ChannelRegistry: legacy policy seeds durable desired state exactly once
// ---------------------------------------------------------------------------

describe('ChannelRegistry subscriptionPolicy', () => {
  function makeServerStub() {
    const opens: Array<{ type: string; address: unknown }> = [];
    const closes: Array<{ channelId: string }> = [];
    const server = {
      // Post-policy state: full grant so subscription reconciliation runs
      // (§14.1 skips lifecycle for ungranted servers).
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsOpen: async (args: { type: string; address: unknown }) => { opens.push(args); },
      sendChannelsClose: async (args: { channelId: string }) => { closes.push(args); return { closed: true }; },
    };
    const serverRegistry = { getServer: () => server } as unknown as ConstructorParameters<typeof ChannelRegistry>[0];
    return { opens, closes, serverRegistry };
  }

  const channels = [
    { id: 'zulip:tracker-miner-f', type: 'zulip-stream' as const, address: { streamId: 1 }, name: 'tracker-miner-f' },
    { id: 'zulip:general', type: 'zulip-stream' as const, address: { streamId: 2 }, name: 'general' },
    { id: 'zulip:random', type: 'zulip-stream' as const, address: { streamId: 3 }, name: 'random' },
  ];
  const registerParams = { channels } as unknown as ChannelsIncomingParams;

  it('defaults closed when there is no legacy policy or server bootstrap preference', async () => {
    const { opens, closes, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});

    await registry.handleRegister('zulip', registerParams as never);

    assert.strictEqual(opens.length, 0);
    assert.strictEqual(closes.length, 3);
  });

  it("'manual' opens nothing but still registers the channels", async () => {
    const { opens, closes, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});
    registry.setSubscriptionPolicy('zulip', 'manual');

    await registry.handleRegister('zulip', registerParams as never);

    assert.strictEqual(opens.length, 0);
    assert.strictEqual(closes.length, 3);
    assert.strictEqual(registry.getOpenChannels().length, 0);
  });

  it('string[] allow-list opens only matching channels', async () => {
    const { opens, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});
    registry.setSubscriptionPolicy('zulip', ['zulip:tracker-miner-f']);

    await registry.handleRegister('zulip', registerParams as never);

    assert.strictEqual(opens.length, 1);
    assert.deepStrictEqual(opens[0].address, { streamId: 1 });
  });

  it("legacy 'auto' opens every channel during migration", async () => {
    const { opens, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});
    registry.setSubscriptionPolicy('zulip', 'auto');

    await registry.handleRegister('zulip', registerParams as never);

    assert.strictEqual(opens.length, 3);
  });

  it('does not apply a migrated allow-list to channels discovered later', async () => {
    const { opens, closes, serverRegistry } = makeServerStub();
    const registry = new ChannelRegistry(serverRegistry, {} as never, () => {}, () => {});
    registry.setSubscriptionPolicy('zulip', ['zulip:tracker-miner-f']);
    await registry.handleRegister('zulip', registerParams as never);

    await registry.handleChanged('zulip', {
      added: [{
        id: 'zulip:new', type: 'zulip-stream', label: 'new', direction: 'bidirectional',
        address: { streamId: 4 },
      }],
    });

    assert.strictEqual(opens.filter((o) => (o.address as { streamId?: number }).streamId === 4).length, 0);
    assert.ok(closes.some((c) => c.channelId === 'zulip:new'));
  });
});

describe('ChannelRegistry durable lifecycle', () => {
  const oneChannel = [{
    id: 'discord:g1:c1',
    type: 'discord',
    label: '#general',
    direction: 'bidirectional' as const,
    address: { guildId: 'g1', channelId: 'c1' },
  }];

  function memoryStore() {
    let registered = false;
    const events: unknown[] = [];
    return {
      registerState: () => {
        if (registered) throw new Error('State already exists');
        registered = true;
      },
      getStateJson: () => events,
      appendToStateJson: (_id: string, event: unknown) => events.push(event),
    };
  }

  it('restores desired state from Chronicle and reconciles it after reconnect', async () => {
    const store = memoryStore();
    const first = makeLifecycleServer();
    const registry1 = new ChannelRegistry(first.registry, {} as never, () => {}, () => {}, {
      store: store as never,
    });
    registry1.setSubscriptionPolicy('discord', 'auto');
    await registry1.handleRegister('discord', { channels: oneChannel });
    await registry1.handleChannelToolCall('channel_close', { channelId: 'discord:g1:c1' });

    const second = makeLifecycleServer();
    const registry2 = new ChannelRegistry(second.registry, {} as never, () => {}, () => {}, {
      store: store as never,
    });
    // Even a contradictory legacy setting cannot override a completed migration.
    registry2.setSubscriptionPolicy('discord', 'auto');
    await registry2.handleRegister('discord', { channels: oneChannel });

    assert.deepStrictEqual(second.opens, []);
    assert.deepStrictEqual(second.closes, ['discord:g1:c1']);
    assert.strictEqual(registry2.getDesiredState('discord', 'discord:g1:c1'), 'closed');
  });

  it('declines a closed-channel invitation with an optional acknowledgment', async () => {
    const server = makeLifecycleServer();
    const registry = new ChannelRegistry(server.registry, {} as never, () => {}, () => {});
    registry.setSubscriptionPolicy('discord', 'manual');
    await registry.handleRegister('discord', { channels: oneChannel });

    const result = await registry.handleChannelToolCall('channel_decline', {
      channelId: 'discord:g1:c1',
      messageId: 'm1',
      acknowledge: '👀',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(server.acks, [{
      channelId: 'discord:g1:c1', messageId: 'm1', intent: 'seen-not-opening', value: '👀',
    }]);
    assert.strictEqual(registry.isChannelOpen('discord:g1:c1'), false);
  });

  it('requires serverId only when two MCPLs expose the same channel id', async () => {
    const openedBy: string[] = [];
    const servers = new Map(['alpha', 'beta'].map((serverId) => [serverId, {
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsOpen: async () => {
        openedBy.push(serverId);
        return { channel: { ...oneChannel[0], id: 'shared' } };
      },
      sendChannelsClose: async () => ({ closed: true }),
    }]));
    const registry = new ChannelRegistry(
      { getServer: (id: string) => servers.get(id) } as never,
      {} as never,
      () => {},
      () => {},
    );
    const descriptor = { ...oneChannel[0], id: 'shared' };
    registry.setSubscriptionPolicy('alpha', 'manual');
    registry.setSubscriptionPolicy('beta', 'manual');
    await registry.handleRegister('alpha', { channels: [descriptor] });
    await registry.handleRegister('beta', { channels: [descriptor] });

    const ambiguous = await registry.handleChannelToolCall('channel_open', { channelId: 'shared' });
    assert.strictEqual(ambiguous.success, false);
    assert.match(ambiguous.error ?? '', /ambiguous/);

    const exact = await registry.handleChannelToolCall('channel_open', {
      channelId: 'shared', serverId: 'beta',
    });
    assert.strictEqual(exact.success, true);
    assert.deepStrictEqual(openedBy, ['beta']);
  });

  function makeLifecycleServer() {
    const opens: string[] = [];
    const closes: string[] = [];
    const acks: unknown[] = [];
    const server = {
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsOpen: async (args: { channelId?: string }) => {
        opens.push(args.channelId ?? '');
        return { channel: oneChannel[0] };
      },
      sendChannelsClose: async (args: { channelId: string }) => {
        closes.push(args.channelId);
        return { closed: true };
      },
      sendChannelsAcknowledge: async (args: unknown) => {
        acks.push(args);
        return { acknowledged: true, representation: '👀' };
      },
    };
    return {
      opens,
      closes,
      acks,
      registry: { getServer: () => server } as unknown as ConstructorParameters<typeof ChannelRegistry>[0],
    };
  }
});
