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
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry, destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelContext } from '../src/mcpl/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

const HOME = 'discord:g1:home';
const BUSY = 'discord:g1:busy';
const TRIGGER = 'discord:g1:trigger';
const FORK_HOME = 'discord:g1:fork-home';
const ref = (channelId: string): ChannelRef => ({ serverId: 'discord', channelId });

function makeRegistry(opts: {
  homeChannel?: string;
  homeChannelResolver?: (agentName: string) => ChannelRef | undefined;
  activeChannelResolver?: (agentName: string) => ChannelRef | null | undefined;
}) {
  const registry = new ChannelRegistry(
    { getServer: () => undefined } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { ...opts, latestInboundLocus: true },
  );
  const raw = registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
    defaultPublishChannel: ChannelRef | null;
  };
  for (const id of [HOME, BUSY, TRIGGER, FORK_HOME]) {
    raw.channels.set(destinationKey(ref(id)), { serverId: 'discord', descriptor: { id, type: 'discord', label: id }, open: true });
  }
  // The global most-recent-inbound locus: some unrelated channel was busy.
  raw.defaultPublishChannel = ref(BUSY);
  return registry;
}

describe('homeChannel: speech locus for no-trigger turns', () => {
  it('a no-trigger turn resolves to the configured home channel, not the last-active one', () => {
    const registry = makeRegistry({ homeChannel: HOME, activeChannelResolver: () => undefined });
    assert.deepEqual(registry.resolveLocus('agent'), ref(HOME));
  });

  it('without homeChannel the global most-recent-inbound fallback is unchanged', () => {
    const registry = makeRegistry({ activeChannelResolver: () => undefined });
    assert.deepEqual(registry.resolveLocus('agent'), ref(BUSY));
  });

  it('a triggering channel still wins over the home channel', () => {
    const registry = makeRegistry({ homeChannel: HOME, activeChannelResolver: () => ref(TRIGGER) });
    assert.deepEqual(registry.resolveLocus('agent'), ref(TRIGGER));
  });

  it("a conversation fork's home still wins over everything", () => {
    const registry = makeRegistry({
      homeChannel: HOME,
      homeChannelResolver: () => ref(FORK_HOME),
      activeChannelResolver: () => ref(TRIGGER),
    });
    assert.deepEqual(registry.resolveLocus('agent'), ref(FORK_HOME));
  });
});

describe('homeChannel: a no-trigger turn is told, and published to, the home channel', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
  let tempDir: string;
  let statusPath: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'home-channel-delivery-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.jsonl');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
  });

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const until = async (cond: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /**
   * A trunk agent on a real MCPL server with HOME and BUSY registered and
   * open. Channel messages are stored without waking it, and the previous
   * locus rule (latest inbound) is the fallback, so activity in BUSY is what
   * a turn with no channel of its own would otherwise follow.
   */
  async function setup(homeChannel?: string) {
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      speech: { locus: 'latest-inbound' },
      gate: { config: { policies: [], default: 'skip' } },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: {
          STATUS_PATH: statusPath, COMMAND_PATH: commandPath,
          CHANNELS: JSON.stringify([{ id: HOME, label: '#home' }, { id: BUSY, label: '#busy' }]),
        },
      }],
      ...(homeChannel ? { homeChannel } : {}),
    });
    await framework.start();
    const fw = framework;
    const internals = fw as unknown as {
      channelRegistry: ChannelRegistry;
      pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
    };
    await until(() => internals.channelRegistry.listChannelsRaw().length >= 2, 'registration');
    const registry = internals.channelRegistry;

    const context = (): ChannelContext | undefined => registry.buildChannelContext('scout', 'discord');

    const published = (): string[] => jsonLines<{ event: string; channelId?: string }>(statusPath)
      .filter((e) => e.event === 'publish').map((e) => e.channelId!);

    /** Run one turn that no channel message caused, which says `text`. */
    async function channelless(text: string) {
      membrane.pushResponse(createMockResponse([{ type: 'text', text }]));
      const before = membrane.calls.length;
      internals.pendingRequests.push({ agentName: 'scout', reason: 'test', source: 'framework', timestamp: Date.now() });
      await until(() => membrane.calls.length > before, 'turn start');
      await fw.runUntilIdle();
    }

    /** Some other channel had activity: the global most-recent-inbound locus. */
    async function busyElsewhere() {
      const delivered = () => fw.getAgent('scout')!.getContextManager().getAllMessages()
        .some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.includes('busy chatter')));
      appendFileSync(commandPath, JSON.stringify({ op: 'incoming', channelId: BUSY, messageId: 'busy-1', mode: 'ambient', text: 'busy chatter' }) + '\n');
      await until(delivered, 'the busy channel message delivered');
    }

    function routingNotices(): string[] {
      return fw.getAgent('scout')!.getContextManager().getAllMessages()
        .flatMap((m) => m.content)
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && b.text.startsWith('[routing]'))
        .map((b) => b.text);
    }

    return { published, context, channelless, busyElsewhere, routingNotices };
  }

  it('with activity in another channel, a turn no channel caused speaks in HOME, not the busy channel', async () => {
    const t = await setup(HOME);
    await t.busyElsewhere();
    await t.channelless('check-in');
    assert.deepEqual(t.published(), [HOME], 'published to the home channel only');
    assert.equal(t.context()?.defaultOutgoing?.channelId, HOME, 'the server is told its speech lands in HOME');
    assert.ok(t.routingNotices().some((n) => n.includes(HOME)), 'the routing notice names HOME');
    assert.ok(!t.routingNotices().some((n) => n.includes(BUSY)), 'and never the busy channel');
  });

  it('with no prior inbound message at all, such a turn still speaks in HOME', async () => {
    const t = await setup(HOME);
    await t.channelless('first words');
    assert.deepEqual(t.published(), [HOME]);
    assert.equal(t.context()?.defaultOutgoing?.channelId, HOME);
  });

  it('control: without homeChannel the same turn follows the busy channel', async () => {
    const t = await setup();
    await t.busyElsewhere();
    await t.channelless('check-in');
    assert.deepEqual(t.published(), [BUSY]);
    assert.equal(t.context()?.defaultOutgoing?.channelId, BUSY);
  });
});
