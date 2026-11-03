import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry, destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelContext } from '../src/mcpl/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { GateModule } from './helpers/dendrite.js';
import {
  SUB, internals, registerOpen, channellessTurnLocus, enter, incoming, settle, blockInTool, textOf, type Stored,
} from './helpers/admission.js';
import type { FrameworkConfig } from '../src/types/framework.js';

const OPS = 'discord:g1:ops';
const BUSY = 'discord:g1:busy';
const TRIGGER = 'discord:g1:trigger';
const FORK_HOME = 'discord:g1:fork-home';
const ref = (channelId: string): ChannelRef => ({ serverId: 'discord', channelId });

function makeRegistry(opts: {
  unpromptedChannel?: string;
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
  for (const id of [OPS, BUSY, TRIGGER, FORK_HOME]) {
    raw.channels.set(destinationKey(ref(id)), { serverId: 'discord', descriptor: { id, type: 'discord', label: id }, open: true });
  }
  // The global most-recent-inbound locus: some unrelated channel was busy.
  raw.defaultPublishChannel = ref(BUSY);
  return registry;
}

describe('unpromptedChannel: speech locus for no-trigger turns', () => {
  it('a no-trigger turn resolves to the configured unprompted channel, not the last-active one', () => {
    const registry = makeRegistry({ unpromptedChannel: OPS, activeChannelResolver: () => undefined });
    assert.deepEqual(registry.resolveLocus('agent'), ref(OPS));
  });

  it('without unpromptedChannel the global most-recent-inbound fallback is unchanged', () => {
    const registry = makeRegistry({ activeChannelResolver: () => undefined });
    assert.deepEqual(registry.resolveLocus('agent'), ref(BUSY));
  });

  it('a triggering channel still wins over the unprompted channel', () => {
    const registry = makeRegistry({ unpromptedChannel: OPS, activeChannelResolver: () => ref(TRIGGER) });
    assert.deepEqual(registry.resolveLocus('agent'), ref(TRIGGER));
  });

  it("a conversation fork's home still wins over everything", () => {
    const registry = makeRegistry({
      unpromptedChannel: OPS,
      homeChannelResolver: () => ref(FORK_HOME),
      activeChannelResolver: () => ref(TRIGGER),
    });
    assert.deepEqual(registry.resolveLocus('agent'), ref(FORK_HOME));
  });
});

describe('unpromptedChannel: a no-trigger turn is told, and published to, the unprompted channel', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
  let tempDir: string;
  let statusPath: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unprompted-channel-delivery-'));
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
   * A trunk agent on a real MCPL server with OPS and BUSY registered and
   * open. Channel messages are stored without waking it, and the previous
   * locus rule (latest inbound) is the fallback, so activity in BUSY is what
   * a turn with no channel of its own would otherwise follow.
   */
  async function setup(
    unpromptedChannel?: string,
    opts: { speech?: 'delivery' | 'latest-inbound'; proseRouting?: 'locus' | 'explicit' } = {},
  ) {
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'scout', model: 'test-model', systemPrompt: 'You are scout.',
        ...(opts.proseRouting ? { proseRouting: opts.proseRouting } : {}),
      }],
      modules: [],
      speech: { locus: opts.speech ?? 'latest-inbound' },
      gate: { config: { policies: [], default: 'skip' } },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: {
          STATUS_PATH: statusPath, COMMAND_PATH: commandPath,
          CHANNELS: JSON.stringify([{ id: OPS, label: '#ops' }, { id: BUSY, label: '#busy' }]),
        },
      }],
      ...(unpromptedChannel ? { unpromptedChannel } : {}),
    });
    await framework.start();
    const fw = framework;
    const internals = fw as unknown as {
      channelRegistry: ChannelRegistry;
      pendingRequests: Array<Record<string, unknown>>;
    };
    await until(() => internals.channelRegistry.listChannelsRaw().length >= 2, 'registration');
    const registry = internals.channelRegistry;

    const context = (): ChannelContext | undefined => registry.buildChannelContext('scout', 'discord');

    const published = (): string[] => jsonLines<{ event: string; channelId?: string }>(statusPath)
      .filter((e) => e.event === 'publish').map((e) => e.channelId!);

    async function wake(request: Record<string, unknown>, responses: Array<ReturnType<typeof createMockResponse>>) {
      for (const r of responses) membrane.pushResponse(r);
      const before = membrane.calls.length;
      internals.pendingRequests.push({ agentName: 'scout', timestamp: Date.now(), ...request });
      await until(() => membrane.calls.length > before, 'turn start');
      await fw.runUntilIdle();
    }

    /** Run one turn that no channel message caused, which says `text`. */
    async function channelless(text: string) {
      await wake({ reason: 'test', source: 'framework' }, [createMockResponse([{ type: 'text', text }])]);
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

    return { framework: fw, published, context, wake, channelless, busyElsewhere, routingNotices };
  }

  const publishCall = (content: string) => createMockResponse(
    [{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content } } as never],
    'tool_use',
  );
  const done = () => createMockResponse([]);

  describe('which turns take it', () => {
    it('a self-scheduled wake speaks in the unprompted channel, under the default speech.locus too', async () => {
      const t = await setup(OPS, { speech: 'delivery' });
      await t.wake({ reason: 'self-scheduled wake (skip_reply, 60s)', source: 'self-wake' }, [createMockResponse([{ type: 'text', text: 'back' }])]);
      assert.deepEqual(t.published(), [OPS]);
    });

    it('channel_publish naming no channel goes there too, in explicit prose routing, and servers are told the same channel', async () => {
      const t = await setup(OPS, { speech: 'delivery', proseRouting: 'explicit' });
      await t.wake({ reason: 'test', source: 'framework' }, [publishCall('a note'), done()]);
      assert.deepEqual(t.published(), [OPS]);
      assert.equal(t.context()?.defaultOutgoing?.channelId, OPS);
    });

    it("a heartbeat's turn doesn't take it: its plain speech is held as a draft", async () => {
      const t = await setup(OPS, { speech: 'delivery' });
      await t.wake({ reason: 'heartbeat', source: 'heartbeat' }, [createMockResponse([{ type: 'text', text: 'still here' }])]);
      assert.deepEqual(t.published(), []);
      assert.ok(t.routingNotices().some((n) => n.includes('came from your heartbeat')), JSON.stringify(t.routingNotices()));
    });

    it("a silent heartbeat tick doesn't take it: its channel_publish naming no channel posts nothing", async () => {
      const t = await setup(OPS, { speech: 'delivery' });
      await t.wake({ reason: 'heartbeat', source: 'heartbeat', suppressProse: true }, [publishCall('a note'), done()]);
      assert.deepEqual(t.published(), []);
    });

    it("an ephemeral run doesn't take it: its prose is its caller's result", async () => {
      const t = await setup(OPS, { speech: 'delivery' });
      const created = await t.framework.createEphemeralAgent({ name: 'sub', model: 'test-model', systemPrompt: 'Do the task.', proseRouting: 'locus' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Find it and report back.' }]);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the result' }]));
      const run = t.framework.runEphemeralToCompletion(created.agent, created.contextManager);
      await t.framework.runUntilIdle();
      await run;
      await t.framework.runUntilIdle();
      assert.deepEqual(t.published(), []);
    });
  });

  describe('its value', () => {
    for (const [value, kind] of [['', 'a blank string'], ['   ', 'a blank string'], [42, 'a number']] as const) {
      it(`create() refuses ${JSON.stringify(value)}, naming the setting and the value's kind`, async () => {
        await assert.rejects(
          AgentFramework.create({
            storePath: join(tempDir, 'refused.chronicle'),
            membrane: membrane.asMembrane(),
            agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
            modules: [],
            unpromptedChannel: value as never,
          }),
          new RegExp(`^Error: unpromptedChannel must name a channel, such as "discord:<guildId>:<channelId>", not ${kind}$`),
        );
      });
    }

    it('one that names no registered channel: such a turn takes what it would without it, and the host logs that once', async () => {
      const logged: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        const t = await setup('discord:g1:nowhere', { speech: 'delivery' });
        await t.channelless('first');
        await t.channelless('second');
        assert.deepEqual(t.published(), []);
        assert.ok(!t.routingNotices().some((n) => n.includes('nowhere')), JSON.stringify(t.routingNotices()));
        assert.deepEqual(logged.filter((l) => l.includes('unpromptedChannel')), [
          '[routing] unpromptedChannel discord:g1:nowhere names no registered channel, so a turn no channel message prompted '
            + 'takes the fallback it takes without the setting until the setting names one. Logged once.',
        ]);
      } finally {
        console.error = error;
      }
    });
  });

  it('with activity in another channel, a turn no channel caused speaks in the unprompted channel, not the busy channel', async () => {
    const t = await setup(OPS);
    await t.busyElsewhere();
    await t.channelless('check-in');
    assert.deepEqual(t.published(), [OPS], 'published to the unprompted channel only');
    assert.equal(t.context()?.defaultOutgoing?.channelId, OPS, 'the server is told its speech lands there');
    assert.ok(t.routingNotices().some((n) => n.includes(OPS)), 'the routing notice names it');
    assert.ok(!t.routingNotices().some((n) => n.includes(BUSY)), 'and never the busy channel');
  });

  it('with no prior inbound message at all, such a turn still speaks in the unprompted channel', async () => {
    const t = await setup(OPS);
    await t.channelless('first words');
    assert.deepEqual(t.published(), [OPS]);
    assert.equal(t.context()?.defaultOutgoing?.channelId, OPS);
  });

  it('control: without unpromptedChannel the same turn follows the busy channel', async () => {
    const t = await setup();
    await t.busyElsewhere();
    await t.channelless('check-in');
    assert.deepEqual(t.published(), [BUSY]);
    assert.equal(t.context()?.defaultOutgoing?.channelId, BUSY);
  });
});

describe('unpromptedChannel and the tune-out holds', () => {
  const withUnprompted = () => fixture({ framework: { subconscious: SUB, unpromptedChannel: 'ops' } as Partial<FrameworkConfig> });

  it("what servers are told follows the same order: an explicit-mode turn's channel context names the excepted channel while the hold is open", async () => {
    const f = await fixture({
      framework: { subconscious: SUB, unpromptedChannel: 'ops' } as Partial<FrameworkConfig>,
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', proseRouting: 'explicit' }],
    });
    f.membrane.responses.length = 0;
    (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
    const told = async (): Promise<string | undefined> => {
      f.membrane.pushResponse(createMockResponse([]));
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now(),
      });
      await f.framework.runUntilIdle();
      const registry = internals(f).channelRegistry as unknown as {
        buildChannelContext(agentName: string, serverId: string): { defaultOutgoing?: { channelId: string } } | undefined;
      };
      return registry.buildChannelContext('agent', 'editor')?.defaultOutgoing?.channelId;
    };
    try {
      await registerOpen(f, 'work', 'noisy', 'ops');
      assert.equal(await told(), 'ops', 'no hold: the unprompted channel');
      assert.ok(internals(f).tuneOutCoordinator!.enterAllExcept(
        { serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool',
      ).ok);
      assert.equal(await told(), 'work', 'the hold: the channel the agent kept');
    } finally { await f.close(); }
  });

  it("an all-except hold's channel outranks it: a turn no channel prompted speaks in the excepted channel while the hold is open, and in the unprompted channel before and after", async () => {
    const f = await withUnprompted();
    try {
      await registerOpen(f, 'work', 'noisy', 'ops');
      assert.equal(await channellessTurnLocus(f), 'ops', 'no hold: the unprompted channel');
      const entered = internals(f).tuneOutCoordinator!.enterAllExcept(
        { serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool',
      );
      assert.ok(entered.ok);
      assert.equal(await channellessTurnLocus(f), 'work', 'the hold: the channel the agent kept');
      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      f.alwaysRespond();
      await f.framework.runUntilIdle();
      assert.equal(await channellessTurnLocus(f), 'ops', 'the hold ended: the unprompted channel again');
    } finally { await f.close(); }
  });

  const releaseLoci = async (f: Awaited<ReturnType<typeof withUnprompted>>, cancel: () => void): Promise<Array<string | null>> => {
    const loci: Array<string | null> = [];
    const off = f.framework.onTrace((t) => {
      if (t.type === 'inference:started' && (t as { agentName: string }).agentName === 'agent') {
        loci.push((t as { channelId?: string }).channelId ?? null);
      }
    });
    try {
      cancel();
      f.alwaysRespond();
      await f.framework.runUntilIdle();
    } finally { off(); }
    return loci;
  };

  it("an all-except hold's release turn answers held channel messages, so it takes main's fallback, not the unprompted channel", async () => {
    const f = await withUnprompted();
    try {
      await registerOpen(f, 'work', 'noisy', 'ops');
      assert.ok(internals(f).tuneOutCoordinator!.enterAllExcept(
        { serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool',
      ).ok);
      await incoming(f, 'noisy', 'n1', 'noise one');
      await settle(f);
      const loci = await releaseLoci(f, () => assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok));
      assert.ok(loci.length >= 1, 'the release woke the resident');
      assert.deepEqual(loci, loci.map(() => null), JSON.stringify(loci));
    } finally { await f.close(); }
  });

  it("a channel's tune-out release turn: the same", async () => {
    const f = await withUnprompted();
    try {
      await registerOpen(f, 'work', 'noisy', 'ops');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'n1', 'noise one');
      await settle(f);
      const loci = await releaseLoci(f, () => assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok));
      assert.ok(loci.length >= 1, 'the release woke the resident');
      assert.deepEqual(loci, loci.map(() => null), JSON.stringify(loci));
    } finally { await f.close(); }
  });

  it('a release restored at boot owes the resident a wake marked as a channel message\'s', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    let saved: string;
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'held before the crash');
      await eventually(() => internals(f).deferredMessages.some((m) => textOf(m as Stored).includes('held before the crash')), 'held message deferred');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      saved = readFileSync(join(f.dir, 'store', 'recovery', 'deferred-writes.json'), 'utf8');
      f.alwaysRespond();
      gate.release('g1');
      await loop;
    } finally { await f.close(); }

    const dir = mkdtempSync(join(tmpdir(), 'unprompted-reboot-'));
    const deferredWritesPath = join(dir, 'deferred-writes.json');
    writeFileSync(deferredWritesPath, saved!);
    const g = await fixture({ framework: { subconscious: SUB, deferredWritesPath } as Partial<FrameworkConfig>, dir });
    try {
      const pending = (g.framework as unknown as { pendingRequests: Array<{ agentName: string; reason: string; channelBorne?: true }> }).pendingRequests;
      const release = pending.find((r) => r.agentName === 'agent' && /tune-out released/.test(r.reason));
      assert.ok(release, 'the restored release owes the resident its wake');
      assert.equal(release.channelBorne, true);
    } finally { await g.close(); }
  });
});
