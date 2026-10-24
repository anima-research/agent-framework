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
import type {
  ProcessEvent,
  Module,
  ModuleContext,
  ToolDefinition,
  ToolCall,
  ToolResult,
  EventResponse,
} from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';

/** A channel on the fixture's discord server. */
const discord = (channelId: string) => ({ serverId: 'discord', channelId });

/** Reach the private per-turn routing state (its triggering channel) + the pure channel-deriver. */
function internals(framework: AgentFramework) {
  return framework as unknown as {
    turnRouting: Map<string, { triggerChannel?: { serverId: string; channelId: string }; locus?: { serverId: string; channelId: string }; nonChannelOrigin?: boolean }>;
    pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number; channelId?: string }>;
    derivePushEventChannel(
      origin: Record<string, unknown> | undefined,
    ): { channelId: string; label?: string } | undefined;
    channelRegistry: unknown;
    handleMcplPushEvent(event: unknown): void;
  };
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
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ capabilities: { history: { maxMessages: 80 } } }),
      inboundOnlyServer: () => undefined,
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
    // #406: what else reaches the agent is each server's delivery (slack-mcpl
    // keeps its own subscription), so the invitation says only what holds on
    // every server.
    assert.match(
      text,
      /a channel you haven't opened\. Messages there that address you, such as an @-mention, reach you whether or not you open it\./,
    );
    // Here nobody decided to keep the channel closed, so a reply opens it, as
    // speech does, and the invitation says so, with how to reply without
    // opening it.
    assert.match(text, /\n1\. Reply — write your reply this turn prefixed with ">>#portables"; it will be delivered there, which opens the channel\. To reply without opening it, decline it first \(option 3\): a channel you've declined stays closed when you speak there\.\n/);
    assert.match(text, /2\. Open the channel — call channel_open/);
    assert.doesNotMatch(text, /invisible to you|follow-ups to your reply|without joining/);
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
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ capabilities: { history: { maxMessages: 80 } } }),
      inboundOnlyServer: () => undefined,
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
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ label: 'DM: _reim0n', capabilities: { history: { maxMessages: 80 } } }),
      proseTargetFor: (c: { serverId: string; channelId: string }) => { asked.push(`${c.serverId}/${c.channelId}`); return '@_reim0n'; },
      inboundOnlyServer: () => undefined,
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
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ label: 'DM: _reim0n', capabilities: { history: { maxMessages: 80 } } }),
      proseTargetFor: () => undefined,
      inboundOnlyServer: () => undefined,
      stopAll: () => {},
    };
    i2.handleMcplPushEvent(dmEvent('m4'));
    const t2 = textOf(fw2);
    assert.doesNotMatch(t2, /prefixed with ">>/);
    assert.match(t2, /\n1\. Reply — no single-word target reaches this channel unambiguously/);
    assert.match(t2, /check whether discord exposes a send tool that can address it\. Replying there opens the channel\. To reply without opening it, decline it first \(option 3\): a channel you've declined stays closed when you speak there\.\n/,
      'the hint promises no tool, and says what replying does');
    assert.match(t2, /channel_open with channelId "discord:dm:1555"/, 'opening stays available');
    await fw2.stop();

    // A registry stand-in without proseTargetFor: a whitespace-free guess, never the spaced label.
    const fw3 = await makeFramework();
    const i3 = internals(fw3);
    i3.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getChannelLabel: () => undefined,
      getDescriptor: () => undefined,
      inboundOnlyServer: () => undefined,
      stopAll: () => {},
    };
    i3.handleMcplPushEvent(dmEvent('m5'));
    assert.match(textOf(fw3), /prefixed with ">>discord:dm:1555"/);
    await fw3.stop();
  });

  it('in a channel the agent closed or declined itself, the invitation says a reply leaves it closed', async () => {
    const textOf = (framework: Awaited<ReturnType<typeof makeFramework>>) =>
      framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? '';
    const mention = (id: string) => ({
      type: 'mcpl:push-event' as const,
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: `discord_msg_${id}`,
      content: [{ type: 'text' as const, text: 'Antra: can you look at this?' }],
      origin: { source: 'discord', messageId: id, mcplChannelId: 'discord:G1:C7', channelName: 'portables' },
      tags: ['chat:mention', 'chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: `i-${id}`,
      triggerInference: false,
    });
    for (const target of ['#portables', undefined]) {
      const framework = await makeFramework();
      const asked: string[] = [];
      internals(framework).channelRegistry = {
        ensureChannelRegistered: () => {},
        isChannelOpen: () => false,
        // A reply leaves this channel closed: the agent closed or declined it.
        speechOpens: (c: { serverId: string; channelId: string }) => { asked.push(`${c.serverId}/${c.channelId}`); return false; },
        getDesiredState: () => 'closed',
        getChannelLabel: () => undefined,
        getDescriptor: () => ({ capabilities: { history: { maxMessages: 80 } } }),
        proseTargetFor: () => target,
        inboundOnlyServer: () => undefined,
        stopAll: () => {},
      };
      internals(framework).handleMcplPushEvent(mention(`m-${target ?? 'none'}`));
      const text = textOf(framework);
      assert.deepEqual(asked, ['discord/discord:G1:C7'], 'asked about this channel on the server it came from');
      // What else reaches the agent from a channel left closed is its server's
      // to say (#406), so the line says only that the channel stays closed.
      assert.match(text, target
        ? /\n1\. Reply — write your reply this turn prefixed with ">>#portables"; it will be delivered there, and the channel stays closed\.\n/
        : /\n1\. Reply — no single-word target reaches this channel unambiguously, so a ">>" prefix can't name it; check whether discord exposes a send tool that can address it\. Replying there leaves the channel closed\.\n/);
      assert.doesNotMatch(text, /opens the channel|decline it first|follow-ups to your reply/);
      await framework.stop();
    }
  });

  it('a direct message carries no invitation: all of a DM reaches the agent, open or closed', async () => {
    // A DM registers closed, and stays closed until the agent answers it, or for good once the
    // agent closes it. An invitation on its messages would repeat a block whose premise is false
    // there: there is no other traffic to miss, and nothing to join.
    const framework = await makeFramework();
    const i = internals(framework);
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getChannelLabel: () => undefined,
      getDescriptor: () => ({ label: 'DM: _reim0n', capabilities: { history: { maxMessages: 80 } } }),
      proseTargetFor: () => '@_reim0n',
      inboundOnlyServer: () => undefined,
      stopAll: () => {},
    };
    i.handleMcplPushEvent({
      type: 'mcpl:push-event',
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: 'discord_msg_m6',
      content: [{ type: 'text', text: '_reim0n: you there?' }],
      origin: { source: 'discord', messageId: 'm6', mcplChannelId: 'discord:dm:1555', isDM: true, authorName: '_reim0n' },
      // As discord-mcpl tags a DM, after the host's core-tag closure.
      tags: ['chat:dm', 'chat:addressed', 'chat:private'],
      timestamp: new Date().toISOString(),
      inferenceId: 'i6',
      triggerInference: false,
    });
    const text = framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? '';
    assert.match(text, /you there\?/);
    assert.doesNotMatch(text, /Channel invitation/);
    await framework.stop();
  });

  it('the invitation offers no reply into a channel its server declared inbound-only, and says why', async () => {
    // pocket-body's live transcript: another agent speaking in the room arrives
    // on it addressed, and the host publishes nothing into it, so a ">>" reply would
    // only be refused.
    const framework = await makeFramework();
    const i = internals(framework);
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getDescriptor: () => ({ label: 'Body · ears', direction: 'inbound' }),
      getChannelLabel: () => 'Body · ears',
      proseTargetFor: () => '#ears',
      inboundOnlyServer: (channel: { channelId: string }) => (channel.channelId === 'body:ears' ? 'pocket-body' : undefined),
      stopAll: () => {},
    };
    i.handleMcplPushEvent({
      type: 'mcpl:push-event',
      serverId: 'pocket-body',
      featureSet: 'body',
      eventId: 'ears_1',
      content: [{ type: 'text', text: 'Fable: Linn, can you hear me?' }],
      origin: { source: 'pocket-body', messageId: 'e1', mcplChannelId: 'body:ears', channelName: 'Body · ears' },
      tags: ['chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: 'i-e1',
      triggerInference: false,
    });

    const text = framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? '';
    assert.match(text, /Channel invitation/);
    assert.match(
      text,
      /1\. Replying there isn't available: pocket-body declared this channel inbound-only, so nothing you write is posted into it\. To speak there, use pocket-body's own tools\./,
    );
    assert.doesNotMatch(text, /prefixed with ">>/);
    assert.match(text, /channel_open with channelId "body:ears"/, 'opening it, to hear the room, stays available');
    await framework.stop();
  });

  it('the invitation adds a # only where the channel\'s name lacks one, and names an unlabelled channel by its id', async () => {
    // #406's run: slack-mcpl registers "#general (acme)" and its push carries no
    // channelName, so the invitation named the place "##general (acme)".
    const framework = await makeFramework();
    const i = internals(framework);
    const labels: Record<string, string> = {
      'slack:C1': '#general (acme)',
      'slack:C2': '#random',
      // A lazily registered channel carries its id as its label.
      'slack:C3': 'slack:C3',
    };
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      speechOpens: () => true,
      getDesiredState: () => undefined,
      getDescriptor: (c: { channelId: string }) => ({ label: labels[c.channelId] }),
      getChannelLabel: (_serverId: string, id: string) => labels[id],
      inboundOnlyServer: () => undefined,
      stopAll: () => {},
    };
    const textOf = () =>
      framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? '';
    const mention = (channel: string, id: string) => ({
      type: 'mcpl:push-event' as const,
      serverId: 'slack',
      featureSet: 'slack.messaging',
      eventId: `slack_msg_${channel}_${id}`,
      content: [{ type: 'text' as const, text: 'U2: @UBOT can you look at this?' }],
      origin: { source: 'slack', messageId: id, channelId: channel, mcplChannelId: `slack:${channel}`, authorName: 'U2' },
      tags: ['chat:mention', 'chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: `i-${id}`,
      triggerInference: false,
    });

    i.handleMcplPushEvent(mention('C1', '101.1'));
    const t1 = textOf();
    assert.match(t1, /addressed you in #general \(acme\) —/);
    assert.doesNotMatch(t1, /##/);
    assert.match(t1, /prefixed with ">>slack:C1"/, 'a spaced label is never the guess');

    i.handleMcplPushEvent(mention('C2', '102.1'));
    const t2 = textOf();
    assert.match(t2, /addressed you in #random —/);
    assert.match(t2, /prefixed with ">>#random"/, 'the guess strips the label\'s own # before adding one');
    assert.doesNotMatch(t2, /##/);

    // A label that is only the id names nothing, as at the other places that name a channel.
    i.handleMcplPushEvent(mention('C3', '103.1'));
    const t3 = textOf();
    assert.match(t3, /addressed you in "slack:C3" —/);
    assert.match(t3, /prefixed with ">>slack:C3"/);
    assert.doesNotMatch(t3, /#slack:C3/);
    await framework.stop();
  });

  it('channel_open and channel_close leave what a channel delivers to its server', () => {
    // #406: slack-mcpl keeps its own subscription, so opening a Slack
    // conversation needn't bring its other messages, and closing it needn't stop them.
    const registry = new ChannelRegistry({} as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {});
    const description = (name: string) => registry.getChannelTools().find((t) => t.name === name)?.description ?? '';
    assert.match(description('channel_open'), /What an open channel delivers to you depends on its MCPL server\./);
    assert.doesNotMatch(description('channel_open'), /start receiving|ongoing traffic|subscribe/);
    assert.match(
      description('channel_close'),
      /Messages that address you still reach you; what else stops reaching you depends on its server\./,
    );
    assert.doesNotMatch(description('channel_close'), /stop receiving/);
  });

  it('the "Now open" notice leaves what an open channel delivers to its server', async () => {
    // #406's run: after the policy's "Ongoing traffic from this channel will reach you",
    // an unsubscribed Slack conversation's next ordinary message never arrived.
    const framework = await makeFramework();
    const notice = internals(framework) as unknown as {
      recordChannelAutoOpenNotice(
        agentName: string | undefined,
        serverId: string,
        channels: Array<{ channelId: string; label?: string }>,
        cause: 'subscription-policy' | 'opened-by-delivery' | 'opened-by-reply',
      ): void;
    };
    const lastText = () =>
      framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? '';

    // Each form an agent can read: a delivery or a send opens one channel, and
    // only the subscription policy opens several at once.
    notice.recordChannelAutoOpenNotice('scout', 'slack', [{ channelId: 'slack:C1', label: '#general (acme)' }], 'opened-by-delivery');
    const one = lastText();
    assert.match(
      one,
      /Now open: #general \(acme\) \(slack:C1\): your own message into the closed channel opened it\. What an open channel brings you is up to its server: some send every message in it, and others only what addresses you unless you're subscribed to it; their own tools can change that\. If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again\./,
    );
    assert.doesNotMatch(one, /will reach you/);

    notice.recordChannelAutoOpenNotice('scout', 'slack', [{ channelId: 'slack:C1' }, { channelId: 'slack:C2' }], 'subscription-policy');
    const two = lastText();
    assert.match(
      two,
      /Selected for opening by subscription policy: slack:C1, slack:C2\. The host opens them, and if one doesn't open, tries again when its server next registers it; channel_list shows whether each is open yet\. What an open channel brings you is up to its server: some send every message in it, and others only what addresses you unless you're subscribed to it; their own tools can change that\. If you don't want one of them, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again\./,
    );
    assert.doesNotMatch(two, /will reach you/);
    await framework.stop();
  });

  it('a channel-incoming trunk turn records its triggering channel', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the date is ...' }]));
    const framework = await makeFramework();

    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: sleep && date'));
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1, 'the trunk should have run one turn');
    assert.deepEqual(
      internals(framework).turnRouting.get('scout')?.triggerChannel,
      discord('discord:guild:chanA'),
      'the turn must be routed to the channel that triggered it, on its server',
    );
    await framework.stop();
  });

  it('a DM push-event turn records the reconstructed DM channel (item-3 redux DM sub-case)', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi in the DM' }]));
    const framework = await makeFramework();

    framework.pushEvent(dmPushEvent('42', 'hey scout, ping'));
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1, 'the trunk should wake for the DM');
    assert.deepEqual(
      internals(framework).turnRouting.get('scout')?.triggerChannel,
      discord('discord:dm:42'),
      'the DM reply must route to the DM channel, not the global locus',
    );
    await framework.stop();
  });

  it('the triggering channel tracks the CURRENT turn, never a stale one', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    // A channel-A turn sets the active channel... (push the response right before
    // each turn: MockMembrane's stream consumes ALL queued responses at once.)
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ans A' }]));
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    assert.deepEqual(i.turnRouting.get('scout')?.triggerChannel, discord('discord:guild:chanA'));

    // ...then a DM turn OVERWRITES it — the next turn's reply must never inherit
    // the previous turn's channel (the concurrency hazard this fix removes).
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ans DM' }]));
    framework.pushEvent(dmPushEvent('42', 'now in a DM'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'both turns should have run');
    assert.deepEqual(
      i.turnRouting.get('scout')?.triggerChannel,
      discord('discord:dm:42'),
      'the routing state must reflect the CURRENT turn’s channel, not chanA',
    );
    await framework.stop();
  });

  it("the channel registry resolves and reports the current turn's trigger channel, then its locus", async () => {
    const framework = await makeFramework();
    const i = framework as unknown as {
      initializeMcpl(servers: unknown[]): Promise<void>;
      channelRegistry: {
        resolveLocus(agentName: string): { serverId: string; channelId: string } | null;
        buildChannelContext(agentName: string | undefined, serverId: string): { defaultOutgoing?: { channelId: string } } | undefined;
      };
      turnRouting: Map<string, { triggerChannel?: { serverId: string; channelId: string }; locus?: { serverId: string; channelId: string } }>;
    };
    // The real registry, with no servers: its resolver reads the framework's turn state.
    await i.initializeMcpl([]);
    i.turnRouting.set('scout', { triggerChannel: discord('discord:guild:chanA') });
    assert.deepEqual(i.channelRegistry.resolveLocus('scout'), discord('discord:guild:chanA'),
      'the locus a turn freezes comes from its trigger channel');
    assert.equal(i.channelRegistry.buildChannelContext('scout', 'discord')?.defaultOutgoing?.channelId, 'discord:guild:chanA',
      'and its server is told the same channel');
    // A re-pin moved the turn's locus: a later start of the turn tells the
    // agent where its speech now lands.
    i.turnRouting.set('scout', { triggerChannel: discord('discord:guild:chanA'), locus: discord('discord:dm:42') });
    assert.equal(i.channelRegistry.buildChannelContext('scout', 'discord')?.defaultOutgoing?.channelId, 'discord:dm:42');
    await framework.stop();
  });

  it("the compile a capacity hold defers a turn to keeps the turn's trigger channel", async () => {
    // The first stream ends with an organization acceleration 429, which
    // holds the turn; a message from another channel arrives during the hold.
    membrane.pushResponse(createMockResponse([] as never[]));
    const framework = await makeFramework();
    const makeStream = membrane.streamYielding.bind(membrane);
    let streams = 0;
    membrane.streamYielding = (request, options) => {
      const stream = makeStream(request, options);
      const n = ++streams;
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && n === 1) {
            yield {
              type: 'error' as const,
              error: new MembraneError({
                type: 'rate_limit', retryable: true, httpStatus: 429,
                message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
                rawError: { status: 429 }, rawRequest: request,
              }),
            };
            return;
          }
          yield event;
        }
      };
      return stream;
    };
    const held = framework as unknown as {
      providerAccelerationCooldowns: Map<string, { until: number; heldRequests: Array<{ channelId?: string }> }>;
      releaseProviderAccelerationCooldown(agentName: string): void;
    };
    const triggerAtStart: Array<string | undefined> = [];
    framework.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      triggerAtStart.push(internals(framework).turnRouting.get('scout')?.triggerChannel?.channelId);
      if (triggerAtStart.length === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }]));
    });

    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: what time is it'));
    await framework.runUntilIdle();
    assert.ok(held.providerAccelerationCooldowns.has('scout'), 'the turn is held');
    framework.pushEvent(channelIncoming('discord:guild:chanB', 'B: unrelated chatter'));
    await framework.runUntilIdle();
    const hold = held.providerAccelerationCooldowns.get('scout')!;
    assert.ok(hold.heldRequests.some((r) => r.channelId === 'discord:guild:chanB'), "chanB's wake waits in the hold with the turn's");
    // What the hold's timer does when it fires, at the hold's deadline.
    hold.until = Date.now();
    held.releaseProviderAccelerationCooldown('scout');
    await framework.runUntilIdle();

    assert.deepEqual(triggerAtStart, ['discord:guild:chanA', 'discord:guild:chanA'],
      "the deferred compile's batch names chanB, and the turn keeps chanA");
    await framework.stop();
  });

  it('startAgentStream clears the triggering channel for a no-channel (heartbeat) turn', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    const framework = await makeFramework();
    const i = internals(framework);

    // Simulate a stale channel left by a prior turn, then run a heartbeat/timer
    // turn (an InferenceRequest with no channelId). startAgentStream must clear
    // the entry up front so routeSpeech falls back to the global locus rather
    // than replaying the stale channel.
    i.turnRouting.set('scout', { triggerChannel: discord('discord:guild:stale') });
    const scout = framework.getAgent('scout')!;
    await (framework as unknown as {
      startAgentStream(agent: unknown, trigger?: unknown): Promise<void>;
    }).startAgentStream(scout, {
      agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now(),
    });
    await framework.runUntilIdle();

    assert.equal(
      i.turnRouting.get('scout')?.triggerChannel,
      undefined,
      'a no-trigger turn must clear any stale triggering channel',
    );
    await framework.stop();
  });
  it('a WebUI turn after Discord traffic freezes null and keeps prose private', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'private WebUI reply' }]));
    const framework = await makeFramework();
    const i = internals(framework) as ReturnType<typeof internals> & {
      turnRouting: Map<string, { locus?: string; nonChannelOrigin: boolean }>;
      channelRegistry: Record<string, unknown>;
    };
    let resolveCalls = 0;
    let routeCalls = 0;
    i.channelRegistry = new Proxy({
      resolveLocus: () => { resolveCalls++; return 'discord:guild:last-room'; },
      routeSpeech: async () => { routeCalls++; return null; },
      getDescriptor: () => undefined,
      sendOutgoingChunk: () => {}, sendOutgoingComplete: () => {}, sendOutgoingLifecycle: () => {},
      startTyping: () => {}, stopTyping: () => {}, stopAll: () => {}, getChannelTools: () => [],
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined }) as never;
    const scout = framework.getAgent('scout')!;
    await (framework as unknown as { startAgentStream(agent: unknown, trigger?: unknown): Promise<void> })
      .startAgentStream(scout, { agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: Date.now(), nonChannelOrigin: true });
    await framework.runUntilIdle();
    assert.equal(resolveCalls, 0);
    assert.equal(routeCalls, 0);
    assert.equal(i.turnRouting.get('scout')?.locus, undefined);
    assert.equal(i.turnRouting.get('scout')?.nonChannelOrigin, true);
    const texts = scout.getContextManager().getAllMessages().flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text);
    assert.ok(texts.some((t) => t.includes('[delivered] plain speech → no channel') && t.includes('kept private')));
    await framework.stop();
  });

  it('a WebUI turn overrides even a resident home channel', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'private resident reply' }]));
    const framework = await makeFramework();
    const i = internals(framework) as ReturnType<typeof internals> & {
      turnRouting: Map<string, { locus?: string; nonChannelOrigin: boolean }>;
      channelRegistry: Record<string, unknown>;
    };
    let resolveCalls = 0;
    i.channelRegistry = new Proxy({ resolveLocus: () => { resolveCalls++; return 'discord:guild:resident-home'; }, routeSpeech: async () => null, getDescriptor: () => undefined, startTyping: () => {}, stopTyping: () => {}, stopAll: () => {}, getChannelTools: () => [] }, { get: (t,p:string) => p in t ? t[p as keyof typeof t] : () => undefined }) as never;
    const scout = framework.getAgent('scout')!;
    await (framework as unknown as { startAgentStream(agent: unknown, trigger?: unknown): Promise<void> }).startAgentStream(scout, { agentName:'scout', reason:'external-message', source:'tui', timestamp:Date.now(), nonChannelOrigin:true });
    await framework.runUntilIdle();
    assert.equal(resolveCalls, 0);
    assert.equal(i.turnRouting.get('scout')?.nonChannelOrigin, true, 'control: the private turn ran');
    assert.equal(i.turnRouting.get('scout')?.locus, undefined);
    const texts = scout.getContextManager().getAllMessages().flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text);
    assert.ok(texts.some((t) => t.includes('[delivered] plain speech → no channel') && t.includes('kept private')), 'and reached its speech, kept private');
    await framework.stop();
  });

  it('a channel-triggered turn still freezes its channel', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'channel reply' }]));
    const framework = await makeFramework();
    const i = internals(framework) as ReturnType<typeof internals> & { turnRouting: Map<string,{locus?:string}>; channelRegistry: Record<string,unknown> };
    i.channelRegistry = new Proxy({ resolveLocus: () => 'discord:guild:chanA', routeSpeech: async () => null, getDescriptor: () => undefined, startTyping: () => {}, stopTyping: () => {}, stopAll: () => {}, getChannelTools: () => [] }, { get:(t,p:string)=>p in t?t[p as keyof typeof t]:()=>undefined }) as never;
    const scout=framework.getAgent('scout')!;
    await (framework as unknown as {startAgentStream(a:unknown,t?:unknown):Promise<void>}).startAgentStream(scout,{agentName:'scout',reason:'mcpl:channel-incoming',source:'discord',timestamp:Date.now(),channelId:'discord:guild:chanA'});
    await framework.runUntilIdle();
    assert.equal(i.turnRouting.get('scout')?.locus,'discord:guild:chanA');
    await framework.stop();
  });

  it('a heartbeat turn still uses the global fallback', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'heartbeat reply' }]));
    const framework=await makeFramework();
    const i=internals(framework) as ReturnType<typeof internals> & {turnRouting:Map<string,{locus?:string}>;channelRegistry:Record<string,unknown>};
    i.channelRegistry=new Proxy({resolveLocus:()=> 'discord:guild:last-room',routeSpeech:async()=>null,getDescriptor:()=>undefined,startTyping:()=>{},stopTyping:()=>{},stopAll:()=>{},getChannelTools:()=>[]},{get:(t,p:string)=>p in t?t[p as keyof typeof t]:()=>undefined}) as never;
    const scout=framework.getAgent('scout')!;
    await (framework as unknown as {startAgentStream(a:unknown,t?:unknown):Promise<void>}).startAgentStream(scout,{agentName:'scout',reason:'heartbeat',source:'timer',timestamp:Date.now()});
    await framework.runUntilIdle();
    assert.equal(i.turnRouting.get('scout')?.locus,'discord:guild:last-room');
    await framework.stop();
  });
});

// ---------------------------------------------------------------------------
// Residents read one message slot
// ---------------------------------------------------------------------------
// Every ordinary resident reads the same message slot, and a tool boundary
// weighs only the messages drained for its own agent. So each resident's open
// turn weighs what lands in the slot by its own rule (an addressed message,
// or a follow-up in a channel the turn engaged), whichever agent it was
// stored for: by addMessage, by a boundary's drain, or by a start's own flush.

/** A channel message as a channel server forwards it, waking only `target`. */
function residentIncoming(channelId: string, text: string, target: string, addressed: boolean): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'antra' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: addressed ? { mentioned: true } : {},
    tags: addressed ? ['chat:addressed'] : ['chat:ambient', 'chat:from-human'],
    triggerInference: true,
    targetAgents: [target],
  } as unknown as ProcessEvent;
}

/** A module whose `pause` tool runs `during` before it returns, and whose
 *  context gathering runs `startHook` once, in the named agent's next start. */
class PauseModule implements Module {
  readonly name = 'pause';
  during: (() => Promise<void>) | null = null;
  startHook: { agent: string; run: () => void } | null = null;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async gatherContext(agentName: string): Promise<ContextInjection[]> {
    const hook = this.startHook;
    if (hook?.agent === agentName) {
      this.startHook = null;
      hook.run();
    }
    return [];
  }
  getTools(): ToolDefinition[] {
    return [{ name: 'pause', description: 'Pause briefly', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    if (during) await during();
    return { success: true, data: { ok: true } };
  }
  async onProcess(): Promise<EventResponse> {
    return {};
  }
}

describe('Residents read one message slot', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let pause: PauseModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resident-slot-test-'));
    membrane = new MockMembrane();
    pause = new PauseModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  type Internals = {
    addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
    turnRouting: Map<string, { triggerChannel?: { serverId: string; channelId: string }; locus?: { serverId: string; channelId: string }; nonChannelOrigin?: boolean }>;
    activeTurnTokens: Map<string, number>;
    deferredMessages: unknown[];
    channelRegistry: unknown;
    providerAccelerationCooldowns: Map<string, { until: number }>;
    releaseProviderAccelerationCooldown(agentName: string): void;
  };

  /** Two residents, scout the primary and shade. A registry stand-in
   *  resolves a fresh locus to the turn's trigger channel and records where
   *  each agent's speech is routed. `held`'s first stream ends with an
   *  organization acceleration 429, which holds its turn for a later
   *  compile. `first` is that stream's rounds, and `responses[n]` feeds the
   *  nth start (1-based) as it begins. */
  async function residents(
    held: 'scout' | 'shade',
    responses: Record<number, ContentBlock[][]>,
    first: ContentBlock[][] = [[]],
  ) {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'shade', model: 'test-model', systemPrompt: 'You are shade.' },
      ],
      modules: [pause],
    });
    const i = framework as unknown as Internals;
    const routed: Array<{ agent: string; text: string; locus: string | null }> = [];
    const registry: Record<string, unknown> = {
      resolveLocus: (name: string) => i.turnRouting.get(name)?.triggerChannel ?? discord('chan-default'),
      routeSpeech: async (agent: string, text: string, locus?: { serverId: string; channelId: string } | null) => {
        routed.push({ agent, text, locus: locus?.channelId ?? null });
        return locus ? { delivered: true, serverId: locus.serverId, channelId: locus.channelId } : null;
      },
      getDefaultPublishChannel: () => null,
      isChannelOpen: () => true,
      getDescriptor: () => undefined,
      getChannelTools: () => [],
    };
    i.channelRegistry = new Proxy(registry, {
      get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
    });

    first.forEach((blocks, n) => membrane.pushResponse(createMockResponse(blocks, n < first.length - 1 ? 'tool_use' : undefined)));
    const makeStream = membrane.streamYielding.bind(membrane);
    const firstStreamOf = new Set<string>();
    membrane.streamYielding = (request, options) => {
      const stream = makeStream(request, options);
      const system = JSON.stringify((request as { system?: unknown }).system ?? '');
      const agent = system.includes('You are shade.') ? 'shade' : 'scout';
      const first = !firstStreamOf.has(agent);
      firstStreamOf.add(agent);
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && first && agent === held) {
            yield {
              type: 'error' as const,
              error: new MembraneError({
                type: 'rate_limit', retryable: true, httpStatus: 429,
                message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
                rawError: { status: 429 }, rawRequest: request,
              }),
            };
            return;
          }
          yield event;
        }
      };
      return stream;
    };
    let starts = 0;
    framework.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      const feed = responses[++starts];
      feed?.forEach((blocks, n) => membrane.pushResponse(createMockResponse(blocks, n < feed.length - 1 ? 'tool_use' : undefined)));
    });

    /** Bring `name`'s hold to its deadline and release it, as its timer does then. */
    const release = async (name: string): Promise<void> => {
      const hold = i.providerAccelerationCooldowns.get(name);
      assert.ok(hold, `${name}'s turn is held`);
      hold.until = Date.now();
      i.releaseProviderAccelerationCooldown(name);
      await framework.runUntilIdle();
    };
    return { framework, i, routed, release };
  }

  const hereIAm = [[{ type: 'text', text: 'Here I am.' }] as ContentBlock[]];

  // Each row is also what main does, by re-resolving the held turn's locus
  // from its batch's addressed wake.
  for (const [held, role] of [['scout', 'the primary'], ['shade', 'a second resident']] as const) {
    it(`${role}, held by a capacity hold, moves its locus to an addressed message from another channel`, async () => {
      const { framework, i, routed, release } = await residents(held, { 2: hereIAm });
      framework.pushEvent(residentIncoming('discord:guild:chanA', `${held}, take a look`, held, false));
      await framework.runUntilIdle();
      assert.ok(i.providerAccelerationCooldowns.has(held), 'the turn is held');
      framework.pushEvent(residentIncoming('discord:dm:antra', `${held}, over here please`, held, true));
      await framework.runUntilIdle();
      await release(held);

      assert.deepEqual(routed, [{ agent: held, text: 'Here I am.', locus: 'discord:dm:antra' }]);
      await framework.stop();
    });
  }

  it('a second resident, held by a capacity hold, keeps its locus for ambient traffic in another channel', async () => {
    const { framework, routed, release } = await residents('shade', { 2: hereIAm });
    framework.pushEvent(residentIncoming('discord:guild:chanA', 'shade, take a look', 'shade', false));
    await framework.runUntilIdle();
    framework.pushEvent(residentIncoming('discord:guild:lounge', 'unrelated chatter', 'shade', false));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent('shade')!.getContextManager().getAllMessages()
      .some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'unrelated chatter')),
    'shade reads the ambient message in the slot');
    await release('shade');

    assert.deepEqual(routed, [{ agent: 'shade', text: 'Here I am.', locus: 'discord:guild:chanA' }]);
    await framework.stop();
  });

  it("a second resident's turn weighs a message stored while it runs, at the turn's next start", async () => {
    const { framework, i, routed, release } = await residents('shade', { 2: hereIAm });
    // While shade's start gathers its context, its turn is alive and no tool
    // cycle is open, so an addressed message for the idle primary is stored
    // at once. Shade's start has weighed its arrivals by then, and no
    // boundary of shade's turn weighs it.
    pause.startHook = {
      agent: 'shade',
      run: () => {
        i.addMessage('Antra', [{ type: 'text', text: 'shade, over here please' }],
          { channelId: 'discord:dm:antra', serverId: 'discord', tags: ['chat:addressed'] });
      },
    };
    framework.pushEvent(residentIncoming('discord:guild:chanA', 'shade, take a look', 'shade', false));
    await framework.runUntilIdle();
    assert.equal(pause.startHook, null, "shade's start stored the message");
    await release('shade');

    assert.deepEqual(routed, [{ agent: 'shade', text: 'Here I am.', locus: 'discord:dm:antra' }]);
    await framework.stop();
  });

  it("a second resident's held turn weighs a message the primary's own start stores", async () => {
    const { framework, i, routed, release } = await residents('shade', {
      2: [[{ type: 'text', text: 'scout here' }] as ContentBlock[]],
      3: hereIAm,
    });
    framework.pushEvent(residentIncoming('discord:guild:chanA', 'shade, take a look', 'shade', false));
    await framework.runUntilIdle();
    // While scout's turn is alive, a message for the primary waits in its
    // queue, and scout's next start stores it.
    i.activeTurnTokens.set('scout', 999);
    framework.pushEvent(residentIncoming('discord:dm:antra', 'shade, over here please', 'shade', true));
    await framework.runUntilIdle();
    assert.equal(i.deferredMessages.length, 1, 'the message waits for scout');
    i.activeTurnTokens.delete('scout');
    framework.pushEvent(residentIncoming('discord:guild:chanC', 'scout, a word', 'scout', false));
    await framework.runUntilIdle();
    assert.equal(i.deferredMessages.length, 0, "scout's start stored it");
    await release('shade');

    assert.deepEqual(routed.filter((r) => r.agent === 'shade'),
      [{ agent: 'shade', text: 'Here I am.', locus: 'discord:dm:antra' }]);
    await framework.stop();
  });

  it("a boundary that re-pins supersedes an arrival from another resident's store", async () => {
    const { framework, i, routed, release } = await residents('scout', { 2: hereIAm }, [
      [{ type: 'tool_use', id: 'p1', name: 'pause--pause', input: {} }] as ContentBlock[],
      [] as ContentBlock[],
    ]);
    // While scout's tool runs, a message for shade is stored at once, an
    // arrival for scout's turn. Then one for scout waits in its queue, and
    // scout's boundary stores it after, re-pinning the turn there.
    pause.during = async () => {
      i.addMessage('Antra', [{ type: 'text', text: 'shade, a word' }],
        { channelId: 'discord:dm:xenia', serverId: 'discord', tags: ['chat:addressed'] }, { forAgent: 'shade' });
      i.addMessage('Antra', [{ type: 'text', text: 'scout, over here please' }],
        { channelId: 'discord:dm:antra', serverId: 'discord', tags: ['chat:addressed'] });
    };
    framework.pushEvent(residentIncoming('discord:guild:chanA', 'scout, take a look', 'scout', false));
    await framework.runUntilIdle();
    assert.equal(pause.during, null, "scout's tool ran");
    await release('scout');

    assert.deepEqual(routed, [{ agent: 'scout', text: 'Here I am.', locus: 'discord:dm:antra' }],
      "the boundary's re-pin stands at the turn's next start");
    await framework.stop();
  });

  it("a second resident's held turn weighs a message the primary's tool boundary drains", async () => {
    const { framework, i, routed, release } = await residents('shade', {
      2: [
        [{ type: 'tool_use', id: 'p1', name: 'pause--pause', input: {} }] as ContentBlock[],
        [{ type: 'text', text: 'scout done' }] as ContentBlock[],
      ],
      3: hereIAm,
    });
    framework.pushEvent(residentIncoming('discord:guild:chanA', 'shade, take a look', 'shade', false));
    await framework.runUntilIdle();
    // The message comes while scout's tool runs, so it waits in scout's queue
    // until scout's boundary stores it.
    let queued = -1;
    pause.during = async () => {
      i.addMessage('Antra', [{ type: 'text', text: 'shade, over here please' }],
        { channelId: 'discord:dm:antra', serverId: 'discord', tags: ['chat:addressed'] });
      queued = i.deferredMessages.length;
    };
    framework.pushEvent(residentIncoming('discord:guild:chanC', 'scout, a word', 'scout', false));
    await framework.runUntilIdle();
    assert.equal(queued, 1, "the message waited in scout's queue while its tool ran");
    assert.equal(i.deferredMessages.length, 0, "scout's boundary stored it");
    await release('shade');

    assert.deepEqual(routed.filter((r) => r.agent === 'shade'),
      [{ agent: 'shade', text: 'Here I am.', locus: 'discord:dm:antra' }]);
    await framework.stop();
  });
});
