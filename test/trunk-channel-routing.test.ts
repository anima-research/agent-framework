/**
 * Item-3 redux: single-TRUNK output routing.
 *
 * These tests cover the FRAMEWORK-side plumbing that gives a trunk turn its
 * speech route (shelf-355; the route DECISION itself is unit-tested in
 * speech-routes.test.ts):
 *   - derivePushEventChannel() reconstructs the MCPL composite channel for a
 *     push event (Discord DMs arrive this way), preferring an explicit
 *     origin.mcplChannelId.
 *   - a channel-incoming turn, and a DM push-event turn, take their
 *     triggering conversation as the turn's route; a reaction is no candidate.
 *   - the route belongs to the current turn; a no-trigger turn takes only the
 *     fallback, the last delivered message's conversation, and none without
 *     one.
 *   - threads are routes only where the channel's connector posts into named
 *     threads (MCPL RFC-011 exact), and a channel that declares no publish
 *     target is no route at all.
 *
 * connectome-host runs every agent as a single trunk (it never sets
 * `conversations`), so no fork/home exists: the turn's triggering
 * conversation is what keeps a reply in the channel it is answering.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

/** A framework request that continues a turn, as the tests read it. */
interface ContinuationView {
  agentName: string; reason: string; source: string; timestamp: number;
  continuesTurn?: true;
  namesConversation?: true;
  routeCandidates?: Array<{ conversation: { channelId?: string }; addressed: boolean }>;
  fallbackPlace?: { conversation: { channelId?: string } };
  suppressProse?: boolean;
}

/** Reach the private per-turn speech routes + the pure channel-deriver. */
function internals(framework: AgentFramework) {
  return framework as unknown as {
    turnRoutes: Map<string, { route: { kind: string; channelId?: string; replyTo?: string; origin: string } | null; hold?: unknown }>;
    pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number; channelId?: string }>;
    derivePushEventChannel(
      origin: Record<string, unknown> | undefined,
    ): { channelId: string; label?: string } | undefined;
    channelRegistry: unknown;
    handleMcplPushEvent(event: unknown): void;
    continuationRequest(agentName: string, reason: string): ContinuationView;
    /** A continuation as its batch would start now: what the turn record gives it. */
    continuationFor(request: ContinuationView): ContinuationView;
    conversationAgentHomes: Map<string, string>;
  };
}

/**
 * A channel subsystem stand-in whose channels all declare `target` as their
 * MCPL RFC-011 publish target: a route is only ever a place the framework
 * can publish to exactly. Plain speech it is asked to publish is recorded.
 */
function declaringRegistry(target: 'exact' | 'root' | undefined) {
  const published: Array<{ text: string; to: unknown }> = [];
  const registry = new Proxy({
    publishTarget: () => target,
    // Every channel it is asked about is one registration.
    resolveDestination: (c: { serverId?: string; channelId: string }) =>
      ({ destination: { serverId: c.serverId ?? 'discord', channelId: c.channelId } }),
    resolveLocus: () => null,
    routeSpeech: async (_a: string, text: string, to: unknown) => {
      published.push({ text, to });
      // As the real registry reports a delivery: where it went, its thread included.
      const dest = (to ?? {}) as { serverId?: string; channelId?: string; threadId?: string | null };
      return { delivered: true, serverId: dest.serverId ?? 'x', channelId: dest.channelId ?? 'x', ...(dest.threadId ? { threadId: dest.threadId } : {}) };
    },
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
  return { registry, published };
}

function channelIncoming(channelId: string, text: string): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'antra' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent;
}

/** A Discord DM as discord-mcpl forwards it: a push/event whose origin carries
 *  the raw channel (guildId null) — no channels/incoming, no open channel. */
function dmPushEvent(rawChannelId: string, text: string): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'discord',
    featureSet: 'discord.messaging',
    eventId: `discord_msg_${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord',
      channelId: rawChannelId,
      guildId: null,
      channelName: undefined,
      isDM: true,
    },
    timestamp: new Date().toISOString(),
    inferenceId: `inf-${Math.random().toString(36).slice(2)}`,
    triggerInference: true,
  } as unknown as ProcessEvent;
}

describe('Trunk channel routing (item-3 redux)', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trunk-routing-test-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework() {
    // NO `conversations` — this is connectome-host's single-trunk mode.
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
  }

  it('derivePushEventChannel prefers an explicit origin.mcplChannelId', async () => {
    const framework = await makeFramework();
    const got = internals(framework).derivePushEventChannel({
      source: 'discord',
      mcplChannelId: 'discord:dm:999',
      channelName: 'DM with Antra',
      channelId: '999',
    });
    assert.deepEqual(got, { channelId: 'discord:dm:999', label: 'DM with Antra' });
    await framework.stop();
  });

  it('derivePushEventChannel reconstructs a Discord DM composite (guildId null -> dm)', async () => {
    const framework = await makeFramework();
    const got = internals(framework).derivePushEventChannel({
      source: 'discord',
      channelId: '42',
      guildId: null,
      isDM: true,
    });
    assert.deepEqual(got, { channelId: 'discord:dm:42' });
    await framework.stop();
  });

  it('derivePushEventChannel reconstructs a non-open guild channel composite', async () => {
    const framework = await makeFramework();
    const got = internals(framework).derivePushEventChannel({
      source: 'discord',
      channelId: 'C7',
      guildId: 'G1',
    });
    assert.deepEqual(got, { channelId: 'discord:G1:C7' });
    await framework.stop();
  });

  it('derivePushEventChannel returns undefined for a channel-less push (heartbeat)', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    assert.equal(i.derivePushEventChannel(undefined), undefined);
    assert.equal(i.derivePushEventChannel({ source: 'heartbeat', kind: 'tick' }), undefined);
    await framework.stop();
  });

  it('adds an actionable invitation when addressed in a closed channel', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ capabilities: { history: { maxMessages: 80 } } }),
      stopAll: () => {},
    };

    i.handleMcplPushEvent({
      type: 'mcpl:push-event',
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: 'discord_msg_m1',
      content: [{ type: 'text', text: 'Antra: can you look at this?' }],
      origin: {
        source: 'discord',
        messageId: 'm1',
        mcplChannelId: 'discord:G1:C7',
        channelName: 'portables',
      },
      tags: ['chat:mention', 'chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: 'i1',
      triggerInference: false,
    });

    const messages = framework.getAgent('scout')!.getContextManager().queryMessages({}).messages;
    const text = messages.at(-1)?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? '';
    assert.match(text, /Channel invitation/);
    assert.match(text, /channel_open/);
    // 2026-07-21 rewrite: names resolved, numbered options, backscroll hint
    // phrased as "a number up to N", explicit permission to do nothing.
    assert.match(text, /#portables/);
    assert.match(text, /backscroll \(a number up to 80\)/);
    assert.match(text, /channel_decline/);
    assert.match(text, /optionally set acknowledge/);
    assert.match(text, /Doing nothing is also fine\./);
    // 2026-08-05 accuracy pass: the delivery model must be stated correctly —
    // direct addresses still arrive; un-@'d follow-ups to a reply do not.
    assert.match(text, /address you directly/);
    assert.match(text, /follow-ups to your reply will NOT reach you/);
    // No surface-tracked tally on this event → no missed-count sentence.
    assert.doesNotMatch(text, /passed there without you/);
    await framework.stop();
  });

  it('surfaces the missed-ambient tally in the closed-channel invitation', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ capabilities: { history: { maxMessages: 80 } } }),
      stopAll: () => {},
    };

    i.handleMcplPushEvent({
      type: 'mcpl:push-event',
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: 'discord_msg_m2',
      content: [{ type: 'text', text: 'Antra: still there?' }],
      origin: {
        source: 'discord',
        messageId: 'm2',
        mcplChannelId: 'discord:G1:C7',
        channelName: 'portables',
        // discord-mcpl attaches the missed-ambient tally for closed, tracked
        // channels so the agent sees the cost of staying out at decision time.
        missedMessages: 3,
        missedCharacters: 2729,
      },
      tags: ['chat:mention', 'chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: 'i2',
      triggerInference: false,
    });

    const messages = framework.getAgent('scout')!.getContextManager().queryMessages({}).messages;
    const text = messages.at(-1)?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? '';
    assert.match(text, /Channel invitation/);
    assert.match(text, /While closed, 3 messages \(~2729 chars\) have passed there without you\./);
    await framework.stop();
  });

  it('the invitation\'s reply prefix is a single resolvable token, not a label with spaces', async () => {
    // Live bug (2026-10-02): a first DM arrived on a closed channel labelled "DM: _reim0n"; the
    // invitation said to prefix ">>#DM: _reim0n", which parses as target "#DM:" + body "_reim0n …":
    // the reply bounced, and the retained text later went out with a stray "_reim0n" line.
    const textOf = (framework: Awaited<ReturnType<typeof makeFramework>>) =>
      framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? '';
    const dmEvent = (id: string) => ({
      type: 'mcpl:push-event' as const,
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: `discord_msg_${id}`,
      content: [{ type: 'text' as const, text: '_reim0n: hey, I have THE gossip' }],
      origin: { source: 'discord', messageId: id, mcplChannelId: 'discord:dm:1555', channelName: 'DM: _reim0n' },
      tags: ['chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: `i-${id}`,
      triggerInference: false,
    });

    // The registry knows the channel: its round-trip target is used.
    const framework = await makeFramework();
    const i = internals(framework);
    const asked: string[] = [];
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ label: 'DM: _reim0n', capabilities: { history: { maxMessages: 80 } } }),
      proseTargetFor: (id: string, serverId?: string) => { asked.push(`${serverId}/${id}`); return '@_reim0n'; },
      stopAll: () => {},
    };
    i.handleMcplPushEvent(dmEvent('m3'));
    const text = textOf(framework);
    assert.deepEqual(asked, ['discord/discord:dm:1555'], 'asked for this channel on the server it came from');
    assert.match(text, /prefixed with ">>@_reim0n"/);
    assert.doesNotMatch(text, />>#DM:/);
    assert.match(text, /#DM: _reim0n/, 'the readable label still names the place');
    await framework.stop();

    // The registry finds no safe token (shared id, whitespace): no prefix is offered at all.
    const fw2 = await makeFramework();
    const i2 = internals(fw2);
    i2.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ label: 'DM: _reim0n', capabilities: { history: { maxMessages: 80 } } }),
      proseTargetFor: () => undefined,
      stopAll: () => {},
    };
    i2.handleMcplPushEvent(dmEvent('m4'));
    const t2 = textOf(fw2);
    assert.doesNotMatch(t2, /prefixed with ">>/);
    assert.match(t2, /Reply without joining isn't available here/);
    assert.match(t2, /channel_open with channelId "discord:dm:1555"/, 'joining stays available');
    await fw2.stop();

    // A registry stand-in without proseTargetFor: a whitespace-free guess, never the spaced label.
    const fw3 = await makeFramework();
    const i3 = internals(fw3);
    i3.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getChannelLabel: () => undefined,
      getDescriptor: () => undefined,
      stopAll: () => {},
    };
    i3.handleMcplPushEvent(dmEvent('m5'));
    assert.match(textOf(fw3), /prefixed with ">>discord:dm:1555"/);
    await fw3.stop();
  });

  it('a channel-incoming trunk turn takes its triggering conversation as its speech route', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the date is ...' }]));
    const framework = await makeFramework();
    internals(framework).channelRegistry = declaringRegistry('root').registry;

    const event = channelIncoming('discord:guild:chanA', 'A: sleep && date');
    framework.pushEvent(event);
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1, 'the trunk should have run one turn');
    const route = internals(framework).turnRoutes.get('scout')?.route;
    assert.equal(route?.channelId, 'discord:guild:chanA', 'the turn must be routed to the channel that triggered it');
    assert.equal(route?.replyTo, (event as unknown as { messageId: string }).messageId, 'its message is the reply edge');
    assert.equal(route?.origin, 'trigger');
    await framework.stop();
  });

  it('a DM push-event turn takes the reconstructed DM channel as its route (item-3 redux DM sub-case)', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi in the DM' }]));
    const framework = await makeFramework();
    internals(framework).channelRegistry = declaringRegistry('root').registry;

    framework.pushEvent(dmPushEvent('42', 'hey scout, ping'));
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1, 'the trunk should wake for the DM');
    assert.equal(
      internals(framework).turnRoutes.get('scout')?.route?.channelId,
      'discord:dm:42',
      'the DM reply must route to the DM channel',
    );
    await framework.stop();
  });

  it('the route belongs to the CURRENT turn, never a stale one', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    i.channelRegistry = declaringRegistry('root').registry;

    // (Push the response right before each turn: MockMembrane's stream
    // consumes ALL queued responses at once.)
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ans A' }]));
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanA');

    // A DM turn decides its own route — never inherits the previous turn's.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ans DM' }]));
    framework.pushEvent(dmPushEvent('42', 'now in a DM'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'both turns should have run');
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'discord:dm:42', 'the CURRENT turn’s channel, not chanA');
    await framework.stop();
  });

  it('a reaction that wakes a turn answers nothing: no route candidate', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noticed' }]));
    const framework = await makeFramework();
    framework.pushEvent({
      ...(channelIncoming('discord:guild:chanA', '👍') as unknown as Record<string, unknown>),
      tags: ['chat:reaction', 'chat:addressed'],
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true });
    await framework.stop();
  });

  it('a thread is a route where its channel posts into named threads (MCPL RFC-011 exact)', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the topic' }]));
    const framework = await makeFramework();
    const { registry, published } = declaringRegistry('exact');
    internals(framework).channelRegistry = registry;
    framework.pushEvent({
      ...(channelIncoming('zulip:stream:7', 'on topic') as unknown as Record<string, unknown>),
      serverId: 'zulip',
      threadId: 'topic-a',
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const turn = internals(framework).turnRoutes.get('scout') as { route: { channelId?: string; threadId?: string } | null };
    assert.equal(turn.route?.channelId, 'zulip:stream:7');
    assert.equal(turn.route?.threadId, 'topic-a');
    assert.deepEqual(published, [{ text: 'answering the topic', to: { serverId: 'zulip', channelId: 'zulip:stream:7', threadId: 'topic-a' } }],
      'into the thread, never the channel root');
    await framework.stop();
  });

  it('a thread placement is not streamed; a root publication streams after it is confirmed, at the root (RFC-011 §6)', async () => {
    const framework = await makeFramework();
    const { registry, published } = declaringRegistry('exact');
    const streamed: Array<{ kind: string; serverId: string; channelId: string; text: string; published: number }> = [];
    Object.assign(registry as Record<string, unknown>, {
      sendOutgoingChunk: (d: { serverId: string; channelId: string }, _a: string, _i: string, _n: number, delta: string) =>
        streamed.push({ kind: 'chunk', serverId: d.serverId, channelId: d.channelId, text: delta, published: published.length }),
      sendOutgoingComplete: (d: { serverId: string; channelId: string }, _a: string, _i: string, text: string) =>
        streamed.push({ kind: 'complete', serverId: d.serverId, channelId: d.channelId, text, published: published.length }),
    });
    internals(framework).channelRegistry = registry;

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'into the thread' }]));
    framework.pushEvent({
      ...(channelIncoming('zulip:stream:7', 'on topic') as unknown as Record<string, unknown>),
      serverId: 'zulip',
      threadId: 'topic-a',
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(streamed.length, 0, 'one channel stream could carry thread speech and root envelopes alike: none at all');
    assert.equal(published.length, 1, 'the speech itself was still published, into the thread');

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'at the root' }]));
    framework.pushEvent({ ...(channelIncoming('zulip:stream:7', 'at root') as unknown as Record<string, unknown>), serverId: 'zulip' } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.deepEqual(streamed, [
      { kind: 'chunk', serverId: 'zulip', channelId: 'zulip:stream:7', text: 'at the root', published: 2 },
      { kind: 'complete', serverId: 'zulip', channelId: 'zulip:stream:7', text: 'at the root', published: 2 },
    ], 'after its confirmed publish, on the server it resolved to');
    await framework.stop();
  });

  it('a thread on a channel that declares no threads wakes the turn but plain speech is held, never sent to the root', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the topic' }]));
    const framework = await makeFramework();
    const { registry, published } = declaringRegistry('root');
    internals(framework).channelRegistry = registry;
    framework.pushEvent({
      ...(channelIncoming('zulip:stream:7', 'on topic') as unknown as Record<string, unknown>),
      serverId: 'zulip',
      threadId: 'topic-a',
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const turn = internals(framework).turnRoutes.get('scout') as { route: unknown; unroutable?: { reason: string } };
    assert.equal(turn.route, null);
    assert.equal(turn.unroutable?.reason, 'thread');
    const texts = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    assert.ok(texts.some((t) => t.startsWith('[routing] Your plain speech can\'t go to the conversation in front of you') &&
      /is a thread, but its connector declares the channel has no threads/.test(t)));
    const drafts = (framework as unknown as { proseDrafts: { open(a: string): Array<{ text: string; reason: string; note?: string }> } })
      .proseDrafts.open('scout');
    assert.deepEqual(drafts.map((d) => [d.text, d.reason]), [['answering the topic', 'no-destination']]);
    assert.match(drafts[0]!.note ?? '', /is a thread, but its connector declares the channel has no threads/);
    assert.deepEqual(published, [], 'nothing went to the channel root');
    await framework.stop();
  });

  it('a channel whose connector declares no publish target is no route: speech is held, nothing published', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello there' }]));
    const framework = await makeFramework();
    const { registry, published } = declaringRegistry(undefined);
    internals(framework).channelRegistry = registry;
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    const turn = internals(framework).turnRoutes.get('scout') as { route: unknown; unroutable?: { reason: string } };
    assert.equal(turn.route, null);
    assert.equal(turn.unroutable?.reason, 'untargetable');
    const texts = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    const notice = texts.find((t) => t.startsWith('[routing]'));
    assert.match(notice ?? '', /its connector doesn't declare where a post lands \(MCPL RFC-011\)/);
    assert.match(notice ?? '', /publication from here is unavailable until it does/);
    assert.doesNotMatch(notice ?? '', /consult/, 'no connector tools are claimed when the connector lists none');
    assert.deepEqual(published, []);
    await framework.stop();
  });

  it('a no-trigger (heartbeat) turn never carries a stale route over: with no delivered message it has none', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    const framework = await makeFramework();
    const i = internals(framework);

    // A stale route left by a prior turn must not carry over: a turn with no
    // route candidates (a heartbeat/timer) takes only the fallback, the last
    // delivered message's conversation, and with none delivered it has no
    // destination, so its plain speech is held as a draft.
    i.turnRoutes.set('scout', { route: { kind: 'channel', channelId: 'discord:guild:stale', origin: 'trigger' } });
    const scout = framework.getAgent('scout')!;
    await (framework as unknown as {
      startAgentStream(agent: unknown, trigger?: unknown): Promise<void>;
    }).startAgentStream(scout, {
      agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now(),
    });
    await framework.runUntilIdle();

    assert.deepEqual(i.turnRoutes.get('scout'), { route: null }, 'a no-trigger turn has no route');
    await framework.stop();
  });

  /** A registry stand-in whose last delivered message is `last`. */
  function withLastInbound(target: 'exact' | 'root' | undefined, last: { serverId: string; channelId: string; threadId?: string }) {
    const declaring = declaringRegistry(target);
    (declaring.registry as Record<string, unknown>).getLastInbound = () => ({ ...last });
    return declaring;
  }

  async function heartbeat(framework: AgentFramework): Promise<void> {
    const scout = framework.getAgent('scout')!;
    await (framework as unknown as {
      startAgentStream(agent: unknown, trigger?: unknown): Promise<void>;
    }).startAgentStream(scout, { agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now() });
    await framework.runUntilIdle();
  }

  it('a no-trigger (heartbeat) turn takes the fallback, the last delivered message\'s conversation, and speaks there with its thread', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('exact', {
      serverId: 'slack', channelId: 'slack:C1', threadId: '1700.01',
    });
    internals(framework).channelRegistry = registry;
    await heartbeat(framework);
    const turn = internals(framework).turnRoutes.get('scout') as { route: Record<string, unknown> | null };
    assert.deepEqual(turn.route, {
      kind: 'channel', serverId: 'slack', channelId: 'slack:C1', threadId: '1700.01', origin: 'fallback',
    });
    // It answers no message, so the beforeInference context names where the
    // speech lands and no `incoming` (MCPL's triggering message).
    const view = (framework as unknown as { speechRouteView(a: string): Record<string, unknown> }).speechRouteView('scout');
    assert.deepEqual(view, { kind: 'channel', serverId: 'slack', channelId: 'slack:C1', threadId: '1700.01' });
    assert.equal(published.length, 1);
    assert.equal(published[0]!.text, 'tick');
    assert.deepEqual(
      { ...(published[0]!.to as Record<string, unknown>) },
      { serverId: 'slack', channelId: 'slack:C1', threadId: '1700.01' },
      'published into the conversation the last message came from, its thread named',
    );
    const texts = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    assert.ok(texts.some((t) => t.startsWith('[routing] Nothing in this wake named a conversation, so your plain speech lands where the last message came in')),
      'the resident is told why its speech goes there');
    await framework.stop();
  });

  it('a wake that names a conversation never takes the fallback: a reaction, or a channel another agent\'s fork owns', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noticed' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    // A reaction names its channel but answers nothing: no route, as before
    // the fallback, rather than the last delivered message's channel.
    framework.pushEvent({
      ...(channelIncoming('discord:guild:chanA', '👍') as unknown as Record<string, unknown>),
      tags: ['chat:reaction', 'chat:addressed'],
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true }, 'a reaction-woken turn takes no fallback');

    // A message in a channel another agent's fork owns: the trunk takes no
    // candidate there, and no fallback either.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'not mine' }]));
    (framework as unknown as { conversationAgentHomes: Map<string, string> }).conversationAgentHomes
      .set('fork-1', 'discord:guild:forked');
    framework.pushEvent(channelIncoming('discord:guild:forked', 'hello fork'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true }, 'a fork-filtered wake takes no fallback');

    // A pushed reaction in a DM names that DM: no fallback either.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'saw it' }]));
    framework.pushEvent({
      ...(dmPushEvent('42', '👍') as unknown as Record<string, unknown>),
      tags: ['chat:reaction'],
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 3);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true }, 'a pushed reaction takes no fallback');

    // A push that names only its author names a conversation too.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'who was that' }]));
    framework.pushEvent({
      type: 'mcpl:push-event', serverId: 'discord', featureSet: 'discord.messaging',
      eventId: `e-${Math.random().toString(36).slice(2)}`, content: [{ type: 'text', text: 'hm' }],
      origin: { source: 'discord', authorId: 'U9' }, timestamp: new Date().toISOString(),
      inferenceId: `inf-${Math.random().toString(36).slice(2)}`, triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 4);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true }, 'an author-only push takes no fallback');

    // So does one that names only a thread.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'in that thread' }]));
    framework.pushEvent({
      type: 'mcpl:push-event', serverId: 'discord', featureSet: 'discord.messaging',
      eventId: `e-${Math.random().toString(36).slice(2)}`, content: [{ type: 'text', text: 'hm' }],
      origin: { source: 'discord', threadId: 'T-9' }, timestamp: new Date().toISOString(),
      inferenceId: `inf-${Math.random().toString(36).slice(2)}`, triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 5);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true }, 'a thread-only push takes no fallback');
    assert.deepEqual(published, [], 'nothing went to the last delivered message\'s channel');
    await framework.stop();
  });

  it('a console message requesting inference without adding a message still answers on the console, never the fallback', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'on the console' }]));
    // A module that requests inference for console input without adding it
    // as a message (the input reaches context some other way).
    const nudger = {
      name: 'nudger',
      async start() {},
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false, error: 'none', isError: true }; },
      async onProcess(event: ProcessEvent) {
        return event.type === 'external-message' ? { requestInference: true } : {};
      },
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'nudge.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [nudger as never],
    });
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:last' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'status?', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1);
    const turn = internals(framework).turnRoutes.get('scout') as { route: { kind: string; surface?: string } | null };
    assert.equal(turn.route?.kind, 'surface', 'the console is the route');
    assert.equal(turn.route?.surface, 'tui');
    assert.deepEqual(published, [], 'nothing was published to the last channel');
    await framework.stop();
  });

  it('a refusal\'s rewind retry names the refused turn\'s conversation, so it speaks there, never where the last message came in', async () => {
    // One response per stream: the refused turn, then its retry.
    const streams = [createMockResponse([], 'refusal'), createMockResponse([{ type: 'text', text: 'after the rewind' }])];
    (membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
      membrane.calls.push(request as never);
      return new MockYieldingStream(streams.splice(0, 1));
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'rewind.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', refusalHandling: { autoRewind: true } }],
      modules: [],
    });
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'the refused turn, then its retry');
    assert.equal(internals(framework).turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanA');
    assert.deepEqual(published.map((p) => [(p.to as { channelId: string }).channelId, p.text]),
      [['discord:guild:chanA', 'after the rewind']]);
    await framework.stop();
  });

  it('a continuation names its turn\'s conversation in any batch: it keeps it beside a heartbeat in either order and beside an ambient arrival, and holds beside an addressed one', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first answer' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    const i = internals(framework);
    // What a continuation carries is read when its batch starts.
    assert.equal(i.continuationRequest('scout', 'refusal-rewind-retry').routeCandidates, undefined);
    const chanA = i.continuationFor(i.continuationRequest('scout', 'refusal-rewind-retry'));
    assert.equal(chanA.namesConversation, true);
    assert.deepEqual(chanA.routeCandidates?.map((c) => [c.conversation.channelId, c.addressed]), [['discord:guild:chanA', true]]);
    const heartbeatRequest = () => ({ agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now() });
    const arrivalFromB = (addressed: boolean) => ({
      agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), namesConversation: true,
      routeCandidates: [{ conversation: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:chanB' }, addressed, at: Date.now() }],
    }) as never;
    const batches: Array<[string, () => unknown[]]> = [
      ['first', () => [i.continuationRequest('scout', 'inference-failure-rewind-retry'), heartbeatRequest()]],
      ['behind a heartbeat', () => [heartbeatRequest(), i.continuationRequest('scout', 'prose-bounce')]],
      ['beside an ambient arrival', () => [arrivalFromB(false), i.continuationRequest('scout', 'unstick')]],
    ];
    for (const [label, batch] of batches) {
      const calls = membrane.calls.length;
      membrane.pushResponse(createMockResponse([{ type: 'text', text: label }]));
      i.pendingRequests.push(...(batch() as never[]));
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, calls + 1, `${label}: one turn`);
      assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanA', `${label}: it keeps chanA`);
    }
    assert.deepEqual(published.map((p) => (p.to as { channelId: string }).channelId),
      ['discord:guild:chanA', 'discord:guild:chanA', 'discord:guild:chanA', 'discord:guild:chanA']);
    // An addressed arrival from chanB competes with it: the turn is held.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'which one' }]));
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'), arrivalFromB(true));
    await framework.runUntilIdle();
    const held = i.turnRoutes.get('scout') as { route: null; hold?: { conversations: Array<{ channelId: string }> } };
    assert.equal(held.route, null);
    assert.deepEqual(held.hold?.conversations.map((c) => c.channelId).sort(), ['discord:guild:chanA', 'discord:guild:chanB']);
    assert.equal(published.length, 4, 'nothing published from the held turn');
    // Its continuation names both, and is held again.
    const both = i.continuationFor(i.continuationRequest('scout', 'prose-bounce'));
    assert.deepEqual(both.routeCandidates?.map((c) => c.conversation.channelId).sort(), ['discord:guild:chanA', 'discord:guild:chanB']);
    await framework.stop();
  });

  it('the fork rule judges a continuation when its turn starts: a claim made after it was queued keeps it out, one given up lets it in', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first answer' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    const i = internals(framework);
    const chanARoute = i.turnRoutes.get('scout')!;
    // Queued while chanA is free; a fork claims it before the turn starts.
    const queued = i.continuationRequest('scout', 'refusal-rewind-retry');
    const asQueued = i.continuationFor(queued);
    assert.equal(asQueued.namesConversation, true);
    assert.deepEqual(asQueued.routeCandidates?.map((c) => [c.conversation.channelId, c.addressed]), [['discord:guild:chanA', true]]);
    i.pendingRequests.push(queued);
    i.conversationAgentHomes.set('fork-1', 'discord:guild:chanA');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'not into the fork' }]));
    await framework.runUntilIdle();
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null, named: true }, 'no route into the fork, and no fallback');
    assert.equal(published.length, 1, 'only the first answer was published');
    // Queued while the fork owns chanA; the fork gives it up before the turn starts.
    i.turnRoutes.set('scout', chanARoute);
    const released = i.continuationRequest('scout', 'unstick');
    assert.deepEqual(i.continuationFor(released).routeCandidates?.map((c) => c.conversation.channelId), ['discord:guild:chanA'], 'named whoever owns it');
    i.pendingRequests.push(released);
    i.conversationAgentHomes.delete('fork-1');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back in chanA' }]));
    await framework.runUntilIdle();
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanA');
    assert.deepEqual(published.map((p) => (p.to as { channelId: string }).channelId), ['discord:guild:chanA', 'discord:guild:chanA']);
    // An unroutable candidate in a fork's channel never routes, but it would
    // compete: the rule keeps it from holding another agent's turn.
    i.conversationAgentHomes.set('fork-1', 'discord:guild:chanA');
    const now = Date.now();
    i.pendingRequests.push({
      agentName: 'scout', reason: 'mcpl:push-event', source: 'discord', timestamp: now, namesConversation: true,
      routeCandidates: [
        { conversation: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:chanA' }, addressed: true, at: now, unroutable: true },
        { conversation: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:chanB' }, addressed: true, at: now - 1 },
      ],
    } as never);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'to chanB' }]));
    await framework.runUntilIdle();
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanB', "the fork's channel holds nothing");
    await framework.stop();
  });

  it("a continuation of a turn whose words had no place gets none, never the fallback, when the turn's wake named a conversation", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noticed' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    // A reaction names its channel but answers nothing: the turn has no place.
    framework.pushEvent({
      ...(channelIncoming('discord:guild:chanA', '👍') as unknown as Record<string, unknown>),
      tags: ['chat:reaction', 'chat:addressed'],
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null, named: true });
    const placeless = i.continuationRequest('scout', 'refusal-rewind-retry');
    assert.equal(i.continuationFor(placeless).namesConversation, true);
    assert.equal(i.continuationFor(placeless).routeCandidates, undefined);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'still nowhere' }]));
    i.pendingRequests.push(placeless);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2);
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null, named: true });
    assert.deepEqual(published, [], 'nothing went where the last message came in');
    // No record at all (no locus-mode turn yet): the wake names nothing, and
    // takes the fallback like any such wake.
    i.turnRoutes.delete('scout');
    const fresh = i.continuationRequest('scout', 'unstick');
    assert.equal(i.continuationFor(fresh).namesConversation, undefined);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'where the last message came in' }]));
    i.pendingRequests.push(fresh);
    await framework.runUntilIdle();
    const fallback = i.turnRoutes.get('scout')?.route;
    assert.deepEqual([fallback?.channelId, fallback?.origin], ['discord:guild:elsewhere', 'fallback']);
    await framework.stop();
  });

  it("a fallback turn's continuation keeps that turn's place as its fallback when the last message came in elsewhere since, and yields to an addressed arrival", async () => {
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    await heartbeat(framework);
    assert.equal(i.turnRoutes.get('scout')?.route?.origin, 'fallback');
    const continued = i.continuationRequest('scout', 'refusal-rewind-retry');
    const view = i.continuationFor(continued);
    assert.equal(view.namesConversation, undefined);
    assert.equal(view.routeCandidates, undefined);
    assert.equal(view.fallbackPlace?.conversation.channelId, 'discord:guild:elsewhere');
    // A message comes in on another channel before the continuation starts:
    // the rest of the reply still goes where its first part went.
    (registry as Record<string, unknown>).getLastInbound = () => ({ serverId: 'discord', channelId: 'discord:guild:moved' });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick again' }]));
    i.pendingRequests.push(continued);
    await framework.runUntilIdle();
    assert.deepEqual([i.turnRoutes.get('scout')?.route?.channelId, i.turnRoutes.get('scout')?.route?.origin],
      ['discord:guild:elsewhere', 'fallback']);
    // Beside an addressed arrival from chanB, the arrival takes the turn: the
    // fallback's place was never a conversation in front of the resident.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'to chanB' }]));
    i.pendingRequests.push(i.continuationRequest('scout', 'unstick'), {
      agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), namesConversation: true,
      routeCandidates: [{ conversation: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:chanB' }, addressed: true, at: Date.now() }],
    } as never);
    await framework.runUntilIdle();
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanB');
    assert.deepEqual(published.map((p) => (p.to as { channelId: string }).channelId),
      ['discord:guild:elsewhere', 'discord:guild:elsewhere', 'discord:guild:chanB']);
    await framework.stop();
  });

  it("a fallback turn's kept place that the fork rule refuses when its continuation starts gives no place, then or after, even with the last message come in elsewhere", async () => {
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    await heartbeat(framework);
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'discord:guild:elsewhere');
    // A fork claims the kept place, and a message comes in on another channel.
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'));
    i.conversationAgentHomes.set('fork-1', 'discord:guild:elsewhere');
    (registry as Record<string, unknown>).getLastInbound = () => ({ serverId: 'discord', channelId: 'discord:guild:moved' });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'not into the fork' }]));
    await framework.runUntilIdle();
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null, named: true }, "no route into the fork's channel, and none elsewhere");
    // The next continuation of the same reply has no place either.
    const before = i.turnRoutes.get('scout');
    i.pendingRequests.push(i.continuationRequest('scout', 'inference-failure-rewind-retry'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'still not moved' }]));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 3, 'the second continuation ran');
    assert.notEqual(i.turnRoutes.get('scout'), before, 'and wrote its own record');
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null, named: true });
    assert.deepEqual(published.map((p) => (p.to as { channelId: string }).channelId), ['discord:guild:elsewhere'], 'only the tick was published');
    i.conversationAgentHomes.delete('fork-1');
    await framework.stop();
  });

  it("a fallback turn's kept place whose channel no longer declares a publish target gives its continuation no place", async () => {
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    await heartbeat(framework);
    // The kept place's channel stops declaring; the last inbound moves to one that does.
    (registry as Record<string, unknown>).publishTarget = (c: { channelId?: string }) => (c.channelId === 'discord:guild:elsewhere' ? undefined : 'root');
    (registry as Record<string, unknown>).getLastInbound = () => ({ serverId: 'discord', channelId: 'discord:guild:moved' });
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'nowhere now' }]));
    await framework.runUntilIdle();
    assert.equal(i.turnRoutes.get('scout')?.route, null);
    assert.deepEqual(published.map((p) => (p.to as { channelId: string }).channelId), ['discord:guild:elsewhere'], 'only the tick was published');
    await framework.stop();
  });

  it("a no-name turn that found no fallback place gives a continuation that names none, so it takes the fallback once there is one", async () => {
    const framework = await makeFramework();
    const { registry, published } = declaringRegistry('root');
    (registry as Record<string, unknown>).getLastInbound = () => null;
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'nowhere to go' }]));
    await heartbeat(framework);
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null }, 'no place, and its wake named none');
    const continued = i.continuationRequest('scout', 'inference-failure-rewind-retry');
    assert.equal(i.continuationFor(continued).namesConversation, undefined);
    // A message comes in; the continuation's turn takes it as its fallback.
    (registry as Record<string, unknown>).getLastInbound = () => ({ serverId: 'discord', channelId: 'discord:guild:first' });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'now somewhere' }]));
    i.pendingRequests.push(continued);
    await framework.runUntilIdle();
    assert.deepEqual([i.turnRoutes.get('scout')?.route?.channelId, i.turnRoutes.get('scout')?.route?.origin],
      ['discord:guild:first', 'fallback']);
    assert.deepEqual(published.map((p) => [(p.to as { channelId: string }).channelId, p.text]),
      [['discord:guild:first', 'now somewhere']]);
    await framework.stop();
  });

  it("a silent tick's rewind retry is a silent tick too: no place for its words, and the tick's own prompt", async () => {
    const streams = [createMockResponse([], 'refusal'), createMockResponse([{ type: 'text', text: 'thinking privately' }])];
    (membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
      membrane.calls.push(request as never);
      return new MockYieldingStream(streams.splice(0, 1));
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'silent.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', refusalHandling: { autoRewind: true } }],
      modules: [],
    });
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent({
      type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId: 'hb-1', content: [],
      timestamp: new Date().toISOString(), origin: { source: 'heartbeat', reason: 'schedule', silent: true },
      inferenceId: 'inf-hb-1', triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'the refused tick, then its retry');
    assert.ok(JSON.stringify(membrane.calls[1]).includes('[silent heartbeat]'), "the retry carries the tick's prompt");
    const retryRows = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .filter((m) => JSON.stringify(m.content).includes('thinking privately'));
    assert.equal(retryRows.length > 0 && retryRows.every((m) => (m.metadata as { silentHeartbeat?: { eventId?: string } } | undefined)?.silentHeartbeat?.eventId === 'hb-1'), true,
      "the retry's rows carry the tick's stamp");
    // The retry's own turn was a silent tick: its record keeps the tick.
    const record = internals(framework).turnRoutes.get('scout') as { route: unknown; silent?: { silentHeartbeat?: { eventId?: string } } };
    assert.equal(record.route, null);
    assert.equal(record.silent?.silentHeartbeat?.eventId, 'hb-1', 'the retry was a silent tick');
    assert.deepEqual(published, [], 'nothing was published');
    await framework.stop();
  });

  it("an unstick names the conversation its agent's last turn answered", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first answer' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    const host = framework as unknown as { handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'unstuck' }]));
    const result = await host.handleHostCommand('discord', { command: 'unstick', agentName: 'scout' });
    assert.equal(result.ok, true, result.error);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2);
    assert.equal(internals(framework).turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanA');
    assert.deepEqual(published.map((p) => [(p.to as { channelId: string }).channelId, p.text]),
      [['discord:guild:chanA', 'first answer'], ['discord:guild:chanA', 'unstuck']]);
    await framework.stop();
  });

  it("a silent tick whose start fails at the failure threshold: its rewind retry is a silent tick too, with nothing left to resend", async () => {
    // The retry is queued from startAgentStream's terminal branch, after the
    // tick's trigger is torn down: its silence comes from the turn record.
    const streams = [createMockResponse([{ type: 'text', text: 'thinking privately' }])];
    (membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
      membrane.calls.push(request as never);
      return new MockYieldingStream(streams.splice(0, 1));
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'silent-start.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const scout = framework.getAgent('scout')!;
    const cm = scout.getContextManager();
    cm.addMessage('user', [{ type: 'text', text: 'An earlier question' }]);
    cm.addMessage('scout', [{ type: 'text', text: 'An earlier answer' }]);
    // One failure short of the threshold, so this start's failure rewinds.
    (framework as unknown as { consecutiveInferenceFailures: Map<string, number> }).consecutiveInferenceFailures.set('scout', 2);
    const { MembraneError } = await import('@animalabs/membrane');
    const compile = cm.compile.bind(cm);
    let failNext = true;
    (cm as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile = async (...args: unknown[]) => {
      if (failNext) {
        failNext = false;
        throw new MembraneError({ type: 'invalid_request', message: 'compile 400', retryable: false, httpStatus: 400 } as never);
      }
      return (compile as (...a: unknown[]) => Promise<unknown>)(...args);
    };
    framework.pushEvent({
      type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId: 'hb-2', content: [],
      timestamp: new Date().toISOString(), origin: { source: 'heartbeat', reason: 'schedule', silent: true },
      inferenceId: 'inf-hb-2', triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'the failed start reached no model; its retry did');
    assert.ok(JSON.stringify(membrane.calls[0]).includes('[silent heartbeat]'), "the retry carries the tick's prompt");
    const retryRows = cm.getAllMessages().filter((m) => JSON.stringify(m.content).includes('thinking privately'));
    assert.equal(retryRows.length > 0 && retryRows.every((m) => (m.metadata as { silentHeartbeat?: { eventId?: string } } | undefined)?.silentHeartbeat?.eventId === 'hb-2'), true,
      "the retry's rows carry the tick's stamp");
    const drafts = (framework as unknown as { proseDrafts: { open(agent: string): unknown[] } }).proseDrafts.open('scout');
    assert.deepEqual(drafts, [], 'its words stayed private: no draft to resend');
    const record = internals(framework).turnRoutes.get('scout') as { silent?: { silentHeartbeat?: { eventId?: string } } };
    assert.equal(record.silent?.silentHeartbeat?.eventId, 'hb-2', 'the retry was a silent tick');
    assert.deepEqual(published, [], 'nothing was published');
    await framework.stop();
  });

  it('an unstick is refused while a turn is alive, even when the agent reads idle', async () => {
    const framework = await makeFramework();
    const fw = framework as unknown as {
      activeTurnTokens: Map<string, number>;
      handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
    };
    assert.equal(framework.getAgent('scout')!.state.status, 'idle');
    fw.activeTurnTokens.set('scout', 99);
    const refused = await fw.handleHostCommand('discord', { command: 'unstick', agentName: 'scout' });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /while a turn is in progress/);
    assert.equal(internals(framework).pendingRequests.some((r) => r.reason === 'unstick'), false, 'no unstick queued');
    fw.activeTurnTokens.delete('scout');
    await framework.stop();
  });

  it("a continuation of a turn whose channel had no server resolves it again when it starts, and takes the route with its server", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'held' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    let registered = false;
    (registry as Record<string, unknown>).getChannelServerId = (id: string) => (registered && id === 'discord:guild:late' ? 'discord' : undefined);
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    const fw = framework as unknown as { candidateForChannel(channelId: string, addressed: boolean, at: number): unknown };
    const now = Date.now();
    i.pendingRequests.push({
      agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: now, namesConversation: true,
      routeCandidates: [fw.candidateForChannel('discord:guild:late', true, now)],
    } as never);
    await framework.runUntilIdle();
    const unresolved = i.turnRoutes.get('scout') as { route: unknown; unroutable?: { reason: string } };
    assert.equal(unresolved.route, null);
    assert.equal(unresolved.unroutable?.reason, 'unresolved');
    // The server registers; the turn's retry takes the channel, with its server.
    registered = true;
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'there now' }]));
    await framework.runUntilIdle();
    const route = i.turnRoutes.get('scout')?.route as { channelId?: string; serverId?: string } | null;
    assert.deepEqual([route?.serverId, route?.channelId], ['discord', 'discord:guild:late']);
    assert.deepEqual(published.map((p) => [(p.to as { serverId?: string }).serverId, (p.to as { channelId: string }).channelId, p.text]),
      [['discord', 'discord:guild:late', 'there now']]);
    await framework.stop();
  });

  it("the inference policy sees a continuation already filled from its turn's record", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first answer' }]));
    const framework = await makeFramework();
    const { registry } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    const policy = (framework as unknown as { inferencePolicy: { shouldInfer(agentName: string, requests: unknown[], state: unknown): boolean } }).inferencePolicy;
    const seen: Array<{ reason: string; namesConversation?: true; routeCandidates?: Array<{ conversation: { channelId?: string } }> }> = [];
    const shouldInfer = policy.shouldInfer.bind(policy);
    policy.shouldInfer = (agentName, requests, state) => {
      seen.push(...(requests as typeof seen));
      return shouldInfer(agentName, requests, state);
    };
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'second answer' }]));
    await framework.runUntilIdle();
    const retry = seen.find((r) => r.reason === 'refusal-rewind-retry');
    assert.deepEqual([retry?.namesConversation, retry?.routeCandidates?.map((c) => c.conversation.channelId)],
      [true, ['discord:guild:chanA']]);
    await framework.stop();
  });

  it("a continuation's conversation counts as older than a message batched with it, so that message gives the reply edge", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first answer' }]));
    const framework = await makeFramework();
    const { registry } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    const first = i.turnRoutes.get('scout')?.route?.replyTo;
    assert.ok(first);
    // A newer message in chanA is queued first; the turn's retry is queued after it.
    const arrival = {
      agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), namesConversation: true,
      routeCandidates: [{ conversation: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:chanA' }, addressed: true, at: Date.now(), messageId: 'm-newer' }],
    };
    i.pendingRequests.push(arrival as never, i.continuationRequest('scout', 'refusal-rewind-retry'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'second answer' }]));
    await framework.runUntilIdle();
    assert.deepEqual([i.turnRoutes.get('scout')?.route?.channelId, i.turnRoutes.get('scout')?.route?.replyTo], ['discord:guild:chanA', 'm-newer']);
    await framework.stop();
  });

  it("a silent tick's record survives a restart or a guard retry, and a restart batched with an ordinary wake runs ordinary, routed by that wake", async () => {
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    const scout = framework.getAgent('scout')!;
    const start = (trigger: Record<string, unknown>) => (framework as unknown as {
      startAgentStream(agent: unknown, trigger?: unknown, attempt?: number): Promise<void>;
    }).startAgentStream(scout, { agentName: 'scout', source: 'framework', timestamp: Date.now(), ...trigger });
    const silentHeartbeat = { eventId: 'hb-9', origin: { source: 'heartbeat', silent: true } };
    // A silent tick whose wake named a conversation.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'private' }]));
    await start({ reason: 'heartbeat', suppressProse: true, namesConversation: true, silentHeartbeat });
    await framework.runUntilIdle();
    const record = i.turnRoutes.get('scout') as { route: unknown; named?: true; silent?: { silentHeartbeat?: { eventId?: string } } };
    assert.deepEqual([record.route, record.named, record.silent?.silentHeartbeat?.eventId], [null, true, 'hb-9']);
    // Its restart and its guard retry, each alone: silent, and the record is kept whole.
    for (const reason of ['context_budget_restart', 'tool_result_guard_retry']) {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'still private' }]));
      await start({ reason, suppressProse: true, silentHeartbeat });
      await framework.runUntilIdle();
      assert.equal(i.turnRoutes.get('scout'), record, `the ${reason} kept the record`);
    }
    // A restart that shares its batch with an ordinary wake runs ordinary.
    // The tick had no route to keep, so the wake's conversation decides it.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ordinary now' }]));
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(), suppressProse: true, silentHeartbeat } as never,
      {
        agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), namesConversation: true,
        routeCandidates: [{ conversation: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:asked' }, addressed: true, at: Date.now(), messageId: 'm-asked' }],
      } as never,
    );
    await framework.runUntilIdle();
    const ordinary = i.turnRoutes.get('scout') as { route: { channelId?: string; replyTo?: string } | null; named?: true; silent?: unknown };
    assert.deepEqual([ordinary.route?.channelId, ordinary.route?.replyTo, ordinary.named, ordinary.silent],
      ['discord:guild:asked', 'm-asked', true, undefined]);
    assert.deepEqual(published.map((p) => [(p.to as { channelId: string }).channelId, p.text]), [['discord:guild:asked', 'ordinary now']]);
    await framework.stop();
  });

  it("an unstick and a bounce's resend after a silent tick are ordinary turns; the tick's own retry stays silent", async () => {
    const framework = await makeFramework();
    const { registry } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    const silentTick = (eventId: string) => framework.pushEvent({
      type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId, content: [],
      timestamp: new Date().toISOString(), origin: { source: 'heartbeat', reason: 'schedule', silent: true },
      inferenceId: `inf-${eventId}`, triggerInference: true,
    } as unknown as ProcessEvent);
    const silent = () => (i.turnRoutes.get('scout') as { silent?: unknown } | undefined)?.silent !== undefined;
    const lastCallSilent = () => JSON.stringify(membrane.calls.at(-1)).includes('[silent heartbeat]');
    // The tick's own retry is a silent tick.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    silentTick('hb-a');
    await framework.runUntilIdle();
    assert.equal(silent(), true);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'retry' }]));
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'));
    await framework.runUntilIdle();
    assert.equal(lastCallSilent(), true, 'the retry carries the tick\'s prompt');
    assert.equal(silent(), true);
    // An operator's unstick after it is an ordinary turn.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'unstuck' }]));
    const host = framework as unknown as { handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> };
    const result = await host.handleHostCommand('discord', { command: 'unstick', agentName: 'scout' });
    assert.equal(result.ok, true, result.error);
    await framework.runUntilIdle();
    assert.equal(lastCallSilent(), false, 'no tick prompt');
    assert.equal(silent(), false, 'an ordinary record');
    // So is a bounce's resend after another silent tick.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick 2' }]));
    silentTick('hb-b');
    await framework.runUntilIdle();
    assert.equal(silent(), true);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'resending' }]));
    (framework as unknown as { bounceProse(agent: unknown, text: string, reason: string): void })
      .bounceProse(framework.getAgent('scout'), 'lost words', 'a late bounce');
    await framework.runUntilIdle();
    assert.equal(lastCallSilent(), false, 'no tick prompt');
    assert.equal(silent(), false, 'an ordinary record');
    await framework.stop();
  });

  it("a gate's unroutable candidate that names its server stays unroutable when its turn starts, and in its continuations", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'held' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    // Every id has a sole registrant and declares a target here, so a raw id
    // checked again would look routable.
    (registry as Record<string, unknown>).getChannelServerId = () => 'discord';
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    const now = Date.now();
    // As the gate passes an event whose registered channel the host couldn't
    // resolve: the raw author id, its server named, unroutable.
    i.pendingRequests.push({
      agentName: 'scout', reason: 'gate', source: 'gate', timestamp: now, namesConversation: true,
      routeCandidates: [{ conversation: { kind: 'channel', serverId: 'discord', channelId: 'user:U5' }, addressed: true, at: now, unroutable: true }],
    } as never);
    await framework.runUntilIdle();
    const turn = i.turnRoutes.get('scout') as { route: unknown; unroutable?: { reason: string } };
    assert.equal(turn.route, null);
    assert.equal(turn.unroutable?.reason, 'unresolved');
    // Its retry names the same conversation, still marked: no route.
    const first = i.turnRoutes.get('scout');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'still held' }]));
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'the retry ran');
    const retried = i.turnRoutes.get('scout') as { route: unknown; unroutable?: { reason: string; neverRoutes?: true } };
    assert.notEqual(retried, first, 'and wrote its own record');
    assert.deepEqual([retried.route, retried.unroutable?.reason, retried.unroutable?.neverRoutes], [null, 'unresolved', true]);
    assert.deepEqual(published, [], 'nothing went to the raw id');
    await framework.stop();
  });

  it("a hold's conversation from an unroutable candidate stays marked in its continuation, even when it is the one left", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'held between them' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    (registry as Record<string, unknown>).getChannelServerId = () => 'discord';
    internals(framework).channelRegistry = registry;
    const i = internals(framework);
    const now = Date.now();
    i.pendingRequests.push({
      agentName: 'scout', reason: 'gate', source: 'gate', timestamp: now, namesConversation: true,
      routeCandidates: [
        { conversation: { kind: 'channel', serverId: 'discord', channelId: 'user:U5' }, addressed: true, at: now, unroutable: true },
        { conversation: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:chanB' }, addressed: true, at: now - 1 },
      ],
    } as never);
    await framework.runUntilIdle();
    assert.equal((i.turnRoutes.get('scout') as { hold?: unknown }).hold !== undefined, true, 'held');
    // A fork claims chanB, so the raw id is the only conversation left.
    i.conversationAgentHomes.set('fork-1', 'discord:guild:chanB');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'not to the raw id' }]));
    i.pendingRequests.push(i.continuationRequest('scout', 'refusal-rewind-retry'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'the retry ran');
    const retried = i.turnRoutes.get('scout') as { route: unknown; hold?: unknown; unroutable?: { reason: string; neverRoutes?: true } };
    assert.deepEqual([retried.route, retried.hold, retried.unroutable?.reason, retried.unroutable?.neverRoutes], [null, undefined, 'unresolved', true]);
    assert.deepEqual(published, [], 'nothing went to the raw id');
    i.conversationAgentHomes.delete('fork-1');
    await framework.stop();
  });

  it("a wake's conversation whose server registered while it waited is routable when its turn starts", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'there now' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    let registered = false;
    (registry as Record<string, unknown>).getChannelServerId = (id: string) => (registered && id === 'discord:guild:late' ? 'discord' : undefined);
    internals(framework).channelRegistry = registry;
    const fw = framework as unknown as {
      candidateForChannel(channelId: string, addressed: boolean, at: number): { unroutable?: true };
    };
    // Queued while no server held the channel: unroutable then.
    const now = Date.now();
    const candidate = fw.candidateForChannel('discord:guild:late', true, now);
    assert.equal(candidate.unroutable, true);
    internals(framework).pendingRequests.push({
      agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: now, namesConversation: true,
      routeCandidates: [candidate],
    } as never);
    // The server registers before the turn starts.
    registered = true;
    await framework.runUntilIdle();
    assert.equal(internals(framework).turnRoutes.get('scout')?.route?.channelId, 'discord:guild:late');
    assert.deepEqual(published.map((p) => [(p.to as { channelId: string; serverId?: string }).serverId, (p.to as { channelId: string }).channelId]),
      [['discord', 'discord:guild:late']]);
    await framework.stop();
  });

  it("a bounce during a turn queues its wake at once, and the wake names where that turn's words went by its end", async () => {
    // Turn 1 answers chanA; mid-turn, a tool bounces words and moves the
    // route to chanB, as a channel_open would. Turn 2 is the bounce's wake:
    // queued at once, it starts only after turn 1 has ended, and reads the
    // record then. A bounce that lands while a successor turn is alive (the
    // previous turn's speech failing late) waits for that turn the same way.
    const mover = {
      name: 'mover',
      framework: undefined as AgentFramework | undefined,
      queuedMidTurn: undefined as boolean | undefined,
      async start() {},
      async stop() {},
      getTools: () => [{ name: 'move', description: 'Move along', inputSchema: { type: 'object', properties: {} } }],
      async handleToolCall() {
        const fw = this.framework as unknown as {
          bounceProse(agent: unknown, text: string, reason: string): void;
          turnRoutes: Map<string, unknown>;
          pendingRequests: Array<{ reason: string }>;
        };
        fw.bounceProse(this.framework!.getAgent('scout'), 'lost words', 'a test bounce');
        this.queuedMidTurn = fw.pendingRequests.some((r) => r.reason === 'prose-bounce');
        fw.turnRoutes.set('scout', { route: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:chanB', origin: 'open' } });
        return { success: true, data: { ok: true } };
      },
      async onProcess() { return {}; },
    };
    const streams = [
      [createMockResponse([{ type: 'tool_use', id: 't1', name: 'mover--move', input: {} }], 'tool_use'), createMockResponse([{ type: 'text', text: 'moved' }])],
      [createMockResponse([{ type: 'text', text: 'resending' }])],
    ];
    (membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
      membrane.calls.push(request as never);
      return new MockYieldingStream(streams.shift() ?? []);
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'bounce.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [mover as never],
    });
    mover.framework = framework;
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    assert.equal(mover.queuedMidTurn, true, 'the wake is queued at once');
    assert.equal(membrane.calls.length, 2, 'the turn, then the bounce\'s wake');
    assert.equal(internals(framework).turnRoutes.get('scout')?.route?.channelId, 'discord:guild:chanB');
    assert.deepEqual(published.map((p) => [(p.to as { channelId: string }).channelId, p.text]),
      [['discord:guild:chanB', 'moved'], ['discord:guild:chanB', 'resending']]);
    await framework.stop();
  });

  it("a bounce outside a turn queues its wake at once, which names the conversation the turn answered", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:elsewhere' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1);
    // The turn is over; its words fail to land (a delivery after it).
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'resending' }]));
    (framework as unknown as { bounceProse(agent: unknown, text: string, reason: string): void })
      .bounceProse(framework.getAgent('scout'), 'lost words', 'a test bounce');
    assert.ok(internals(framework).pendingRequests.some((r) => r.reason === 'prose-bounce'), 'queued at once');
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, "the bounce's wake");
    assert.deepEqual(published.map((p) => [(p.to as { channelId: string }).channelId, p.text]),
      [['discord:guild:chanA', 'answered'], ['discord:guild:chanA', 'resending']]);
    await framework.stop();
  });

  it('an ephemeral subagent never takes the fallback, and several requests batched into one turn name a conversation if any does', async () => {
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:last' });
    internals(framework).channelRegistry = registry;
    // A real ephemeral subagent: its prose is its caller's.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'diver notes' }]));
    const diver = await framework.createEphemeralAgent({ name: 'diver', model: 'test-model', systemPrompt: 'Dive.', allowedTools: 'all' });
    diver.contextManager.addMessage('user', [{ type: 'text', text: 'Look around.' }]);
    const run = framework.runEphemeralToCompletion(diver.agent, diver.contextManager);
    await framework.runUntilIdle();
    assert.equal((await run).speech, 'diver notes');
    assert.deepEqual(internals(framework).turnRoutes.get('diver'), { route: null }, 'no fallback for an ephemeral');

    // A heartbeat batched with a wake that names a conversation (as a
    // reaction's does) is one turn that names one: no fallback.
    const calls = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'batched' }]));
    internals(framework).pendingRequests.push(
      { agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now() },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), namesConversation: true } as never,
    );
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, calls + 1, 'the batch ran, as one turn');
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true }, 'the batch named a conversation');
    assert.deepEqual(published, []);
    await framework.stop();
  });

  it('a tune-out wake about a channel names it, so the primary\'s turn after a cancel takes no fallback', async () => {
    const framework = await makeFramework();
    // The coordinator's requestInference hook (tune-out/coordinator.ts).
    const wake = (framework as unknown as {
      queueTuneOutWake(agent: string, reason: string, source: string, channelId?: string): void;
    }).queueTuneOutWake.bind(framework);
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:last' });
    internals(framework).channelRegistry = registry;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back from the noisy channel' }]));
    wake('scout', 'tune-out cancelled (done)', 'tune-out', 'discord:guild:noisy');
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true }, 'it names the noisy channel: no fallback');
    assert.deepEqual(published, []);
    // A wake through the same hook that names no channel takes the fallback.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    wake('scout', 'a wake about nothing', 'tune-out');
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2);
    assert.equal(internals(framework).turnRoutes.get('scout')?.route?.channelId, 'discord:guild:last');
    await framework.stop();
  });

  it('a module event that names a channel, a thread or an author in its metadata never takes the fallback', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about that channel' }]));
    const relay = {
      name: 'relay',
      async start() {},
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false, error: 'none', isError: true }; },
      async onProcess(event: ProcessEvent) {
        return event.type === 'relay:note' ? { requestInference: true } : {};
      },
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'relay.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [relay as never],
    });
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:last' });
    internals(framework).channelRegistry = registry;
    framework.pushEvent({ type: 'relay:note', source: 'relay', metadata: { channelId: 'discord:guild:other' } } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null, named: true });
    // A thread alone, or an author alone, names a conversation too; a note
    // naming none takes the fallback.
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ threadId: 'T-1' }, null],
      [{ authorId: 'U-5' }, null],
      [{}, 'discord:guild:last'],
    ];
    for (const [metadata, expected] of cases) {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `about ${JSON.stringify(metadata)}` }]));
      framework.pushEvent({ type: 'relay:note', source: 'relay', metadata } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      assert.equal(internals(framework).turnRoutes.get('scout')?.route?.channelId ?? null, expected, JSON.stringify(metadata));
    }
    assert.equal(membrane.calls.length, 4);
    assert.deepEqual(published.map((p) => (p.to as { channelId: string }).channelId), ['discord:guild:last'],
      'only the note naming nothing spoke, where the last message came in');
    await framework.stop();
  });

  it('a threadless root-channel fallback speaks at its root when no fork owns it', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    const framework = await makeFramework();
    const { registry, published } = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:general' });
    internals(framework).channelRegistry = registry;
    await heartbeat(framework);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), {
      route: { kind: 'channel', serverId: 'discord', channelId: 'discord:guild:general', origin: 'fallback' },
    });
    assert.equal(published.length, 1);
    assert.equal((published[0]!.to as { channelId: string }).channelId, 'discord:guild:general');
    await framework.stop();
  });

  it('the fallback never goes into a channel a conversation fork owns, nor into one that declares no publish target', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    const framework = await makeFramework();
    const owned = withLastInbound('root', { serverId: 'discord', channelId: 'discord:guild:forked' });
    internals(framework).channelRegistry = owned.registry;
    (framework as unknown as { conversationAgentHomes: Map<string, string> }).conversationAgentHomes
      .set('fork-1', 'discord:guild:forked');
    await heartbeat(framework);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null }, 'a fork\'s channel is the fork\'s');
    assert.deepEqual(owned.published, []);
    (framework as unknown as { conversationAgentHomes: Map<string, string> }).conversationAgentHomes.delete('fork-1');

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tock' }]));
    const undeclared = withLastInbound(undefined, { serverId: 'discord', channelId: 'discord:guild:plain' });
    internals(framework).channelRegistry = undeclared.registry;
    await heartbeat(framework);
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null },
      'an undeclared channel is no fallback: no route, not an unroutable conversation in front of the resident');
    assert.deepEqual(undeclared.published, []);
    await framework.stop();
  });
});
