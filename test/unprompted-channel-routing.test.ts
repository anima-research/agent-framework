import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import { ChannelRegistry, destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelContext } from '../src/mcpl/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';
import { fixture } from './helpers/coalescing-fixture.js';
import { GateModule } from './helpers/dendrite.js';
import { SUB, internals, registerOpen, enter, incoming, settle, textOf, find } from './helpers/admission.js';
import type { FrameworkConfig } from '../src/types/framework.js';

const OPS = 'discord:g1:ops';
const BUSY = 'discord:g1:busy';
const FEED = 'discord:g1:feed';
const TRIGGER = 'discord:g1:trigger';
const FORK_HOME = 'discord:g1:fork-home';
const ref = (channelId: string): ChannelRef => ({ serverId: 'discord', channelId });
const line = (value: string, why: string): string =>
  `[routing] unpromptedChannel ${value} ${why}, so a turn the agent's own timer starts `
  + 'takes the fallback it takes without the setting until the setting names a channel it can speak in. Not logged again until a turn has used it.';

async function logged(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = error;
  }
  return lines.filter((l) => l.includes('unpromptedChannel'));
}

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
  raw.defaultPublishChannel = ref(BUSY);
  return registry;
}

describe('unpromptedChannel in the registry', () => {
  it('a turn with no channel of its own resolves to the configured channel, not the last-active one', () => {
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

  it('a name two servers register leaves the turn on the fallback, and is logged once', async () => {
    const registry = makeRegistry({ unpromptedChannel: OPS, activeChannelResolver: () => undefined });
    const raw = registry as unknown as { channels: Map<string, unknown> };
    raw.channels.set(destinationKey({ serverId: 'slack', channelId: OPS }), { serverId: 'slack', descriptor: { id: OPS, type: 'slack', label: OPS }, open: true });
    const lines = await logged(() => {
      assert.deepEqual(registry.resolveLocus('agent'), ref(BUSY));
      assert.deepEqual(registry.resolveLocus('agent'), ref(BUSY));
    });
    assert.deepEqual(lines, [line(OPS, 'names 2 registered channels (name one with its server, as "serverId:channelId")')]);
  });

  it('a channel lost after it worked is logged again', async () => {
    const registry = makeRegistry({ unpromptedChannel: OPS, activeChannelResolver: () => undefined });
    const raw = registry as unknown as { channels: Map<string, unknown> };
    const key = destinationKey(ref(OPS));
    const entry = raw.channels.get(key);
    const lines = await logged(() => {
      raw.channels.delete(key);
      assert.deepEqual(registry.resolveLocus('agent'), ref(BUSY));
      assert.deepEqual(registry.resolveLocus('agent'), ref(BUSY));
      raw.channels.set(key, entry);
      assert.deepEqual(registry.resolveLocus('agent'), ref(OPS));
      raw.channels.delete(key);
      assert.deepEqual(registry.resolveLocus('agent'), ref(BUSY));
    });
    assert.deepEqual(lines, [line(OPS, 'names no registered channel'), line(OPS, 'names no registered channel')]);
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

describe("channel_publish's description", () => {
  const MAIN = "Publish a message to a channel. If channelId is omitted, publishes where your plain speech goes this turn: your conversation's channel if you are bound to one; otherwise the channel of the message that woke this turn, or one you opened during it; otherwise, while a focus holds, the channel it keeps. Where none of those names a channel, nothing is posted, unless this host is set to use the channel of the latest incoming message instead. A turn with no channel of its own, such as a heartbeat's, has no default, so it names one. A subagent has no default, so it must name a channel.";
  const publishTool = (options: Record<string, unknown>) => new ChannelRegistry(
    { getServer: () => undefined } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    options,
  ).getChannelTools().find((tool) => tool.name === 'channel_publish')!;

  it('without unpromptedChannel it is the definition agents read before it, with an event gate or without', () => {
    assert.equal(publishTool({ eventGatePresent: true }).description, MAIN);
    assert.equal(publishTool({}).description, MAIN);
  });

  it('with unpromptedChannel but no event gate, where no turn can take it, it is the same', () => {
    assert.equal(publishTool({ unpromptedChannel: OPS }).description, MAIN);
  });

  it('with unpromptedChannel and an event gate, it adds a default for a timer\'s turn, the channel this host names for it, and says a heartbeat\'s turn has no channel by design; the rest of the tool is unchanged', () => {
    const tool = publishTool({ unpromptedChannel: OPS, eventGatePresent: true });
    assert.equal(tool.description, "Publish a message to a channel. If channelId is omitted, publishes where your plain speech goes this turn: your conversation's channel if you are bound to one; otherwise the channel of the message that woke this turn, or one you opened during it; otherwise, while a focus holds, the channel it keeps; otherwise, on a turn your own skip_reply wake or the end of your sleep started (or a turn continuing one, when your plain speech isn't routed), the channel this host names for such turns. Where none of those names a channel, nothing is posted, unless this host is set to use the channel of the latest incoming message instead. A turn with no channel by design, such as a heartbeat's, has no default, so it names one. A subagent has no default, so it must name a channel.");
    assert.deepEqual({ ...tool, description: MAIN }, publishTool({ eventGatePresent: true }));
  });
});

class InputModule extends GateModule {
  override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    const e = event as unknown as { type: string; content?: string };
    if (e.type === 'external-message') {
      return { addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(e.content) }] }], requestInference: true };
    }
    if (e.type === 'test:chat') {
      return {
        addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(e.content) }], metadata: { serverId: 'discord', channelId: BUSY } as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

describe('unpromptedChannel on a real MCPL server', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
  let tempDir: string;
  let statusPath: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework | undefined;
  let turns: Array<Array<ReturnType<typeof createMockResponse>>> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unprompted-channel-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.jsonl');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    turns = [];
    const streamYielding = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request, options) => {
      for (const response of turns.shift() ?? []) membrane.pushResponse(response);
      return streamYielding(request, options);
    };
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

  async function setup(
    unpromptedChannel?: string,
    opts: { speech?: 'delivery' | 'latest-inbound'; proseRouting?: 'locus' | 'explicit' | 'locked'; proseLock?: string; autoContinue?: true } = {},
  ) {
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'scout', model: 'test-model', systemPrompt: 'You are scout.',
        ...(opts.proseRouting ? { proseRouting: opts.proseRouting } : {}),
        ...(opts.proseLock ? { proseLock: opts.proseLock } : {}),
        ...(opts.autoContinue ? { autoContinue: { maxConsecutive: 1 } } : {}),
      }],
      modules: [new InputModule()],
      speech: { locus: opts.speech ?? 'delivery' },
      gate: { config: { policies: [{ name: 'module-input', match: { scope: ['external-message', 'test:chat'] }, behavior: 'always' }], default: 'skip' } },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: {
          STATUS_PATH: statusPath, COMMAND_PATH: commandPath,
          CHANNELS: JSON.stringify([
            { id: OPS, label: '#ops' }, { id: BUSY, label: '#busy' }, { id: FEED, label: '#feed', direction: 'inbound' },
          ]),
        },
      }],
      ...(unpromptedChannel ? { unpromptedChannel } : {}),
    });
    await framework.start();
    const fw = framework;
    const internal = fw as unknown as {
      channelRegistry: ChannelRegistry;
      pendingRequests: Array<Record<string, unknown>>;
      proseSpeechChains: Map<string, Promise<void>>;
      eventGate: {
        setSleep(seconds: number, note?: string, agentName?: string): unknown;
        requestInferenceFn(agentName: string, reason: string, source: string, provenance?: Record<string, unknown>): void;
      };
    };
    await until(() => internal.channelRegistry.listChannelsRaw().length >= 3, 'registration');

    const toldNow = (): string | undefined => internal.channelRegistry.buildChannelContext('scout', 'discord')?.defaultOutgoing?.channelId;
    const toldInTurns: Array<string | undefined> = [];
    const held: string[] = [];
    fw.onTrace((e) => {
      if (e.type === 'inference:started' && (e as { agentName: string }).agentName === 'scout') toldInTurns.push(toldNow());
      if (e.type === 'prose:drafts-held') held.push((e as { reason: string }).reason);
    });
    const toolResults = (): Array<{ isError?: boolean }> =>
      (membrane.lastStream as unknown as { receivedToolResults: Array<Array<{ isError?: boolean }>> }).receivedToolResults.flat();
    const published = (): string[] => jsonLines<{ event: string; channelId?: string }>(statusPath)
      .filter((e) => e.event === 'publish').map((e) => e.channelId!);
    const texts = (): string[] => fw.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    const routingNotices = (): string[] => texts().filter((t) => t.startsWith('[routing]'));

    async function settled(): Promise<void> {
      for (;;) {
        await fw.runUntilIdle();
        const chain = internal.proseSpeechChains.get('scout');
        await chain;
        await fw.runUntilIdle();
        if (internal.proseSpeechChains.get('scout') === chain) return;
      }
    }
    type Responses = Array<ReturnType<typeof createMockResponse>>;
    async function started(responses: Responses, begin: () => void, later: Responses[] = []): Promise<number> {
      turns = [responses, ...later];
      const before = membrane.calls.length;
      begin();
      await until(() => membrane.calls.length >= before + 1 + later.length, 'the turns start');
      await settled();
      return before;
    }
    const skipReplyWake = (responses: Responses) => started(
      [createMockResponse([{ type: 'tool_use', id: 'sr', name: 'skip_reply', input: { wake_in_seconds: 1 } } as never], 'tool_use')],
      () => fw.pushEvent({ type: 'external-message', source: 'tui', content: 'come back in a second' } as unknown as ProcessEvent),
      [responses],
    );
    const sleepEnd = (responses: Responses, later: Responses[] = []) =>
      started(responses, () => internal.eventGate.setSleep(0.05, undefined, 'scout'), later);
    const wake = (request: Record<string, unknown>, responses: Array<ReturnType<typeof createMockResponse>>) =>
      started(responses, () => internal.pendingRequests.push({ agentName: 'scout', timestamp: Date.now(), ...request }));
    const gateWakes = (calls: Array<[string, string, Record<string, unknown>?]>, responses: Array<ReturnType<typeof createMockResponse>>) =>
      started(responses, () => { for (const [reason, source, provenance] of calls) internal.eventGate.requestInferenceFn('scout', reason, source, provenance); });
    const moduleEvent = (event: Record<string, unknown>, responses: Array<ReturnType<typeof createMockResponse>>) =>
      started(responses, () => fw.pushEvent(event as unknown as ProcessEvent));

    async function busyElsewhere() {
      appendFileSync(commandPath, JSON.stringify({ op: 'incoming', channelId: BUSY, messageId: 'busy-1', mode: 'ambient', text: 'busy chatter' }) + '\n');
      await until(() => texts().some((t) => t.includes('busy chatter')), 'the busy channel message delivered');
    }

    return {
      framework: fw, published, toldNow, toldInTurns, held, toolResults, texts, routingNotices,
      skipReplyWake, sleepEnd, wake, gateWakes, moduleEvent, busyElsewhere,
    };
  }

  const say = (text: string) => createMockResponse([{ type: 'text', text }]);
  const publishCall = (content: string) => createMockResponse(
    [{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content } } as never],
    'tool_use',
  );
  const done = () => createMockResponse([]);

  describe('the turns that take it: the agent\'s own timers', () => {
    it('a skip_reply wake speaks in the unprompted channel, under the default speech.locus too', async () => {
      const t = await setup(OPS);
      await t.skipReplyWake([say('back')]);
      assert.deepEqual(t.published(), [OPS]);
      assert.ok(t.routingNotices().some((n) => n.includes(OPS)), JSON.stringify(t.routingNotices()));
    });

    it("a sleep's end: the same", async () => {
      const t = await setup(OPS);
      await t.sleepEnd([say('awake')]);
      assert.deepEqual(t.published(), [OPS]);
    });

    it('with activity in another channel, under latest-inbound, it speaks in the unprompted channel, not the busy one', async () => {
      const t = await setup(OPS, { speech: 'latest-inbound' });
      await t.busyElsewhere();
      await t.skipReplyWake([say('check-in')]);
      assert.deepEqual(t.published(), [OPS]);
      assert.equal(t.toldInTurns.at(-1), OPS, 'the server is told its speech lands there');
      assert.ok(t.routingNotices().at(-1)?.includes(OPS), JSON.stringify(t.routingNotices()));
    });

    it('control: without unpromptedChannel the same turn follows the busy channel', async () => {
      const t = await setup(undefined, { speech: 'latest-inbound' });
      await t.busyElsewhere();
      await t.skipReplyWake([say('check-in')]);
      assert.deepEqual(t.published(), [BUSY]);
      assert.equal(t.toldInTurns.at(-1), BUSY);
    });

    it('channel_publish naming no channel goes there too, in explicit prose routing; servers are told the same channel in the turn, and not once it has ended', async () => {
      const t = await setup(OPS, { proseRouting: 'explicit' });
      await t.skipReplyWake([publishCall('a note'), done()]);
      assert.deepEqual(t.published(), [OPS]);
      assert.equal(t.toldInTurns.at(-1), OPS);
      assert.equal(t.toldNow(), undefined);
    });

    it("in explicit prose routing, autoContinue's next turn after a timer's turn keeps its default", async () => {
      const t = await setup(OPS, { proseRouting: 'explicit', autoContinue: true });
      await t.sleepEnd([done()], [[publishCall('still on it'), done()]]);
      assert.deepEqual(t.published(), [OPS]);
    });

    it("in explicit prose routing, a ' !' continuation of a timer's turn keeps its default", async () => {
      const t = await setup(OPS, { proseRouting: 'explicit' });
      await t.sleepEnd([say(`>>${BUSY} ! one more thing`)], [[publishCall('the thing'), done()]]);
      assert.deepEqual(t.published(), [BUSY, OPS]);
    });

    it("in explicit prose routing, the wake a timer's turn's bounced reply asks for keeps its default", async () => {
      const t = await setup(OPS, { proseRouting: 'explicit' });
      await t.sleepEnd([say('no target')], [[publishCall('resent'), done()]]);
      assert.deepEqual(t.published(), [OPS]);
    });

    it("a quiesce parks a timer's wake apart from another wake with the same reason, so neither absorbs the other", async () => {
      const t = await setup(OPS);
      const internals = t.framework as unknown as {
        pendingRequests: Array<{ agentName: string; source: string }>;
        processInferenceRequests(): Promise<void>;
        quiesced: boolean;
        eventGate: { requestInferenceFn(agentName: string, reason: string, source: string): void };
      };
      internals.quiesced = true;
      try {
        internals.eventGate.requestInferenceFn('scout', 'woken', 'self-wake');
        internals.eventGate.requestInferenceFn('scout', 'woken', 'gate');
        await internals.processInferenceRequests();
        assert.deepEqual(internals.pendingRequests.filter((r) => r.agentName === 'scout').map((r) => r.source).sort(), ['gate', 'self-wake']);
      } finally {
        internals.quiesced = false;
        internals.pendingRequests.length = 0;
      }
    });
  });

  describe("the turns that don't: they keep what they do without it", () => {
    it("a locked agent's: its timer's turn speaks at its lock, and servers are told the lock", async () => {
      const t = await setup(OPS, { proseRouting: 'locked', proseLock: BUSY });
      await t.skipReplyWake([say('back')]);
      assert.deepEqual(t.published(), [BUSY]);
      assert.equal(t.toldInTurns.at(-1), BUSY);
    });

    it("a locked agent's pointed at drafts: its timer's turn holds its speech, and servers are told no default", async () => {
      const t = await setup(OPS, { proseRouting: 'locked', proseLock: 'drafts' });
      await t.skipReplyWake([say('back')]);
      assert.deepEqual(t.published(), []);
      assert.equal(t.toldInTurns.at(-1), undefined);
      assert.ok(t.held.length > 0, 'its speech was held as drafts');
    });

    it("a start merged from a timer's wake and an ambient batch's", async () => {
      const t = await setup(OPS);
      const before = await t.gateWakes([
        ['self-scheduled wake (skip_reply, 1s)', 'self-wake'],
        ['gate:debounce', 'gate', { counterparty: 'discord:user:U-other', at: Date.now() }],
      ], [say('joining in')]);
      assert.equal(membrane.calls.length - before, 1, 'premise: both wakes made one start');
      assert.deepEqual(t.published(), []);
      assert.ok(t.texts().includes('joining in'), 'the turn spoke');
    });

    it('a person typing at a console or TUI (a module\'s external-message)', async () => {
      const t = await setup(OPS);
      await t.moduleEvent({ type: 'external-message', source: 'tui', content: 'are you there?' }, [say('my answer')]);
      assert.deepEqual(t.published(), []);
      assert.ok(t.texts().includes('my answer'), 'the turn spoke');
    });

    it("a module's message that names a channel", async () => {
      const t = await setup(OPS);
      await t.moduleEvent({ type: 'test:chat', source: 'mod', content: 'are you there?', metadata: { channelId: BUSY } }, [say('my answer')]);
      assert.deepEqual(t.published(), []);
      assert.ok(t.texts().includes('my answer'), 'the turn spoke');
    });

    for (const [what, request] of [
      ["another agent's mail", { reason: 'agent-message:peer', source: 'dendrite' }],
      ['a retry after a refused turn is rewound', { reason: 'refusal-rewind-retry', source: 'framework' }],
    ] as const) {
      it(`${what}: under latest-inbound, it follows the busy channel`, async () => {
        const t = await setup(OPS, { speech: 'latest-inbound' });
        await t.busyElsewhere();
        await t.wake(request, [say('my answer')]);
        assert.deepEqual(t.published(), [BUSY]);
      });
    }

    it("a heartbeat's turn: its plain speech is held as a draft", async () => {
      const t = await setup(OPS);
      await t.wake({ reason: 'heartbeat', source: 'heartbeat' }, [say('still here')]);
      assert.deepEqual(t.published(), []);
      assert.deepEqual(t.held, ['no-destination']);
    });

    it("a silent heartbeat tick: its channel_publish naming no channel posts nothing", async () => {
      const t = await setup(OPS);
      await t.wake({ reason: 'heartbeat', source: 'heartbeat', suppressProse: true }, [publishCall('a note'), done()]);
      assert.deepEqual(t.published(), []);
      assert.equal(t.toolResults().length, 1);
      assert.match(JSON.stringify(t.toolResults()[0]), /Nothing was posted: channel_publish needs a `channelId`, and there's no channel to default to yet\./);
    });

    it("an ephemeral run: its prose is its caller's result", async () => {
      const t = await setup(OPS);
      const created = await t.framework.createEphemeralAgent({ name: 'sub', model: 'test-model', systemPrompt: 'Do the task.', proseRouting: 'locus' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Find it and report back.' }]);
      membrane.pushResponse(say('the result'));
      const run = t.framework.runEphemeralToCompletion(created.agent, created.contextManager);
      await t.framework.runUntilIdle();
      const result = await run;
      await t.framework.runUntilIdle();
      assert.equal(result.speech.trim(), 'the result');
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

    it('create() reads null as not set', async () => {
      framework = await AgentFramework.create({
        storePath: join(tempDir, 'null.chronicle'),
        membrane: membrane.asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
        modules: [],
        unpromptedChannel: null as never,
      });
    });

    for (const [what, value, why] of [
      ['names no registered channel', 'discord:g1:nowhere', 'names no registered channel'],
      ['names a channel its server declared inbound-only', FEED, 'names a channel its server declared inbound-only'],
    ] as const) {
      it(`one that ${what}: a timer's turn takes what it would without it, and the host logs that once`, async () => {
        const lines = await logged(async () => {
          const t = await setup(value, { speech: 'latest-inbound' });
          await t.busyElsewhere();
          await t.skipReplyWake([say('first')]);
          await t.sleepEnd([say('second')]);
          assert.deepEqual(t.published(), [BUSY, BUSY]);
        });
        assert.deepEqual(lines, [line(value, why)]);
      });
    }
  });
});

describe('unpromptedChannel and the tune-out holds', () => {
  const withUnprompted = (agents?: unknown[]) => fixture({
    framework: { subconscious: SUB, unpromptedChannel: 'ops', gate: { config: { policies: [], default: 'skip' } } } as Partial<FrameworkConfig>,
    ...(agents ? { agents } : {}),
  });
  type Fixture = Awaited<ReturnType<typeof withUnprompted>>;
  type Seen = { locus: string | null; told: string | undefined };

  async function sleepEnd(f: Fixture): Promise<Seen> {
    const internal = f.framework as unknown as {
      eventGate: { requestInferenceFn(agentName: string, reason: string, source: string): void };
      channelRegistry: { buildChannelContext(agentName: string, serverId: string): { defaultOutgoing?: { channelId: string } } | undefined };
    };
    let seen: Seen | undefined;
    const off = f.framework.onTrace((t) => {
      if (t.type === 'inference:started' && (t as { agentName: string }).agentName === 'agent') {
        seen = {
          locus: (t as { channelId?: string }).channelId ?? null,
          told: internal.channelRegistry.buildChannelContext('agent', 'editor')?.defaultOutgoing?.channelId,
        };
      }
    });
    try {
      internal.eventGate.requestInferenceFn('agent', 'sleep ended', 'sleep');
      const deadline = Date.now() + 15_000;
      while (seen === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await f.framework.runUntilIdle();
    } finally { off(); }
    assert.ok(seen, "the sleep's end started a turn");
    return seen;
  }

  const enterAllExcept = (f: Fixture, except: string) => assert.ok(internals(f).tuneOutCoordinator!.enterAllExcept(
    { serverId: 'editor', channelId: except }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool',
  ).ok);

  it("an all-except hold's channel outranks it: a timer's turn speaks in the excepted channel while the hold is open, and in the unprompted channel before and after", async () => {
    const f = await withUnprompted();
    try {
      f.alwaysRespond();
      await registerOpen(f, 'work', 'noisy', 'ops');
      assert.equal((await sleepEnd(f)).locus, 'ops', 'no hold: the unprompted channel');
      enterAllExcept(f, 'work');
      assert.equal((await sleepEnd(f)).locus, 'work', 'the hold: the channel the agent kept');
      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      await f.framework.runUntilIdle();
      assert.equal((await sleepEnd(f)).locus, 'ops', 'the hold ended: the unprompted channel again');
    } finally { await f.close(); }
  });

  it("what servers are told follows the same order: an explicit-mode timer turn's channel context names the excepted channel while the hold is open", async () => {
    const f = await withUnprompted([{ name: 'agent', model: 'test', systemPrompt: 'test', proseRouting: 'explicit' }]);
    f.membrane.responses.length = 0;
    (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
    const told = async (): Promise<string | undefined> => {
      f.membrane.pushResponse(createMockResponse([]));
      return (await sleepEnd(f)).told;
    };
    try {
      await registerOpen(f, 'work', 'noisy', 'ops');
      assert.equal(await told(), 'ops', 'no hold: the unprompted channel');
      enterAllExcept(f, 'work');
      assert.equal(await told(), 'work', 'the hold: the channel the agent kept');
    } finally { await f.close(); }
  });

  const releaseLoci = async (f: Fixture, cancel: () => void): Promise<Array<string | null>> => {
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

  it("an all-except hold's release turn answers the held messages, so it takes main's fallback, not the unprompted channel", async () => {
    const f = await withUnprompted();
    try {
      await registerOpen(f, 'work', 'noisy', 'ops');
      enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n1', 'noise one');
      await settle(f);
      const loci = await releaseLoci(f, () => assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok));
      assert.match(textOf(find(f, '<tuned-out-backlog')), /noise one/, 'the release carried the held message');
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
      assert.match(textOf(find(f, '<tuned-out-backlog')), /noise one/, 'the release carried the held message');
      assert.ok(loci.length >= 1, 'the release woke the resident');
      assert.deepEqual(loci, loci.map(() => null), JSON.stringify(loci));
    } finally { await f.close(); }
  });
});
