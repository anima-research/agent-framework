/**
 * Item-3 redux: single-TRUNK output routing.
 *
 * These tests cover the FRAMEWORK-side plumbing that feeds the ChannelRegistry's
 * `activeChannelResolver` (the routing DECISION itself is covered in
 * channel-registry-routing.test.ts):
 *   - derivePushEventChannel() reconstructs the MCPL composite channel for a
 *     push event (Discord DMs arrive this way), preferring an explicit
 *     origin.mcplChannelId.
 *   - a channel-incoming turn records its triggering channel per-agent.
 *   - a DM push-event turn records the reconstructed DM channel per-agent.
 *   - a batched wake picks the MOST-RECENT triggering channel.
 *
 * connectome-host runs every agent as a single trunk (it never sets
 * `conversations`), so no fork/home exists — the active triggering channel is
 * the only thing that keeps a reply in the channel it is answering.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

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
    resolveLocus: () => null,
    routeSpeech: async (_a: string, text: string, to: unknown) => {
      published.push({ text, to });
      return { delivered: true, channelId: 'x' };
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
    assert.deepEqual(internals(framework).turnRoutes.get('scout'), { route: null });
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

  it('a thread route is not streamed; a root route streams with threadId null (RFC-011 §6)', async () => {
    const framework = await makeFramework();
    const { registry, published } = declaringRegistry('exact');
    const streamed: Array<{ kind: string; channelId: string; threadId: unknown }> = [];
    Object.assign(registry as Record<string, unknown>, {
      sendOutgoingChunk: (channelId: string, _a: string, _i: string, _n: number, _d: string, threadId: unknown) =>
        streamed.push({ kind: 'chunk', channelId, threadId }),
      sendOutgoingComplete: (channelId: string, _a: string, _i: string, _t: string, threadId: unknown) =>
        streamed.push({ kind: 'complete', channelId, threadId }),
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
    assert.ok(streamed.some((e) => e.kind === 'chunk'), 'the root route streams');
    assert.ok(streamed.every((e) => e.channelId === 'zulip:stream:7' && e.threadId === null), JSON.stringify(streamed));
    assert.equal(streamed.filter((e) => e.kind === 'complete').length, 1);
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

  it('a no-trigger (heartbeat) turn has no speech route, whatever the previous turn had', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    const framework = await makeFramework();
    const i = internals(framework);

    // A stale route left by a prior turn must not carry over: a turn with no
    // route candidates (a heartbeat/timer) has no destination, so its plain
    // speech is held as a draft rather than sent anywhere.
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
});
