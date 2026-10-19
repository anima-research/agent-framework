/**
 * Configured home channel for no-trigger turns (heartbeats, timers).
 *
 * Without `homeChannel`, a turn with no triggering channel resolves its speech
 * locus to `defaultPublishChannel` — the most-recent inbound across ALL
 * channels — so a heartbeat check-in lands wherever a message last happened to
 * arrive. With it, such turns speak in the configured channel, while a fork's
 * home or a real triggering channel still wins.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { ChannelContext } from '../src/mcpl/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const HOME = 'discord:g1:home';
const BUSY = 'discord:g1:busy';
const TRIGGER = 'discord:g1:trigger';
const FORK_HOME = 'discord:g1:fork-home';

function makeRegistry(opts: {
  homeChannel?: string;
  homeChannelResolver?: (agentName: string) => string | undefined;
  activeChannelResolver?: (agentName: string) => string | undefined;
}) {
  const registry = new ChannelRegistry(
    { getServer: () => undefined } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    opts,
  );
  // The global most-recent-inbound locus: some unrelated channel was busy.
  (registry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = BUSY;
  return registry;
}

describe('homeChannel: speech locus for no-trigger turns', () => {
  it('a no-trigger turn resolves to the configured home channel, not the last-active one', () => {
    const registry = makeRegistry({ homeChannel: HOME, activeChannelResolver: () => undefined });
    assert.equal(registry.resolveLocus('agent'), HOME);
  });

  it('without homeChannel the global most-recent-inbound fallback is unchanged', () => {
    const registry = makeRegistry({ activeChannelResolver: () => undefined });
    assert.equal(registry.resolveLocus('agent'), BUSY);
  });

  it('a triggering channel still wins over the home channel', () => {
    const registry = makeRegistry({ homeChannel: HOME, activeChannelResolver: () => TRIGGER });
    assert.equal(registry.resolveLocus('agent'), TRIGGER);
  });

  it("a conversation fork's home still wins over everything", () => {
    const registry = makeRegistry({
      homeChannel: HOME,
      homeChannelResolver: () => FORK_HOME,
      activeChannelResolver: () => TRIGGER,
    });
    assert.equal(registry.resolveLocus('agent'), FORK_HOME);
  });
});

describe('FrameworkConfig.homeChannel reaches the ChannelRegistry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'home-channel-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a heartbeat-style turn (no trigger) on a trunk agent resolves to homeChannel', async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      homeChannel: HOME,
    });
    const internals = framework as unknown as {
      initializeMcpl(servers: unknown[], routing?: unknown): Promise<void>;
      channelRegistry: ChannelRegistry | null;
    };
    await internals.initializeMcpl([]);
    const registry = internals.channelRegistry!;
    (registry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = BUSY;
    assert.equal(registry.resolveLocus('scout'), HOME);
    await framework.stop();
  });
});

describe('homeChannel: a no-trigger turn is told, and published to, the home channel', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'home-channel-delivery-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * A trunk agent on the real ChannelRegistry, with HOME and BUSY registered
   * and open on a publish-capable mock server. Records every channels/publish
   * and every channel context the turn is given (what the agent is told).
   */
  async function setup(homeChannel?: string) {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      ...(homeChannel ? { homeChannel } : {}),
    });
    const internals = framework as unknown as {
      initializeMcpl(servers: unknown[], routing?: unknown): Promise<void>;
      channelRegistry: ChannelRegistry | null;
      pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
    };
    await internals.initializeMcpl([]);
    const registry = internals.channelRegistry!;

    const published: string[] = [];
    const server = {
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsPublish: async (params: { channelId?: string }) => {
        published.push(params.channelId ?? '');
        return { delivered: true, messageId: `out-${published.length}` };
      },
    };
    const raw = registry as unknown as {
      serverRegistry: McplServerRegistry;
      channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
      defaultPublishChannel: string | null;
      defaultPublishMessageId: string | null;
    };
    raw.serverRegistry = { getServer: () => server } as unknown as McplServerRegistry;
    for (const id of [HOME, BUSY]) {
      raw.channels.set(`discord:${id}`, { serverId: 'discord', descriptor: { id, type: 'discord', label: id }, open: true });
    }

    const told: Array<ChannelContext | undefined> = [];
    const build = registry.buildChannelContext.bind(registry);
    registry.buildChannelContext = (agentName?: string) => {
      const ctx = build(agentName);
      if (agentName === 'scout') told.push(ctx);
      return ctx;
    };

    /** Run one heartbeat-style turn (no triggering channel) that says `text`. */
    async function heartbeat(text: string) {
      membrane.pushResponse(createMockResponse([{ type: 'text', text }]));
      internals.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'framework', timestamp: Date.now() });
      await framework.runUntilIdle();
    }

    /** Some other channel had activity: the global most-recent-inbound locus. */
    function busyElsewhere() {
      raw.defaultPublishChannel = BUSY;
      raw.defaultPublishMessageId = 'busy-1';
    }

    function routingNotices(): string[] {
      return framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
        .flatMap((m) => m.content)
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && b.text.startsWith('[routing]'))
        .map((b) => b.text);
    }

    return { framework, published, told, heartbeat, busyElsewhere, routingNotices };
  }

  it('with activity in another channel, the heartbeat speaks in HOME, not the busy channel', async () => {
    const t = await setup(HOME);
    try {
      t.busyElsewhere();
      await t.heartbeat('heartbeat check-in');
      assert.deepEqual(t.published, [HOME], 'published to the home channel only');
      assert.ok(t.told.length > 0, 'the turn was given a channel context');
      for (const ctx of t.told) {
        assert.equal(ctx?.defaultOutgoing?.channelId, HOME, 'the agent is told its speech lands in HOME');
      }
      assert.ok(t.routingNotices().some((n) => n.includes(HOME)), 'the routing notice names HOME');
      assert.ok(!t.routingNotices().some((n) => n.includes(BUSY)), 'and never the busy channel');
    } finally {
      await t.framework.stop();
    }
  });

  it('with no prior inbound message at all, the heartbeat still speaks in HOME', async () => {
    const t = await setup(HOME);
    try {
      await t.heartbeat('first words');
      assert.deepEqual(t.published, [HOME]);
      for (const ctx of t.told) {
        assert.equal(ctx?.defaultOutgoing?.channelId, HOME);
      }
    } finally {
      await t.framework.stop();
    }
  });

  it('control: without homeChannel the same heartbeat follows the busy channel', async () => {
    const t = await setup();
    try {
      t.busyElsewhere();
      await t.heartbeat('heartbeat check-in');
      assert.deepEqual(t.published, [BUSY]);
      for (const ctx of t.told) {
        assert.equal(ctx?.defaultOutgoing?.channelId, BUSY);
      }
    } finally {
      await t.framework.stop();
    }
  });
});
