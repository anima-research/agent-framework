/**
 * Speaking never opens a channel: an explicit send tool's successful call
 * posts (the server sends it) and leaves the channel's lifecycle as the agent
 * left it, with no "[channels] Now open" notice: a channel the agent closed
 * stays closed, a channel whose open failed isn't opened again, and a
 * tuned-out channel stays tuned out. The call still
 * records the channel as engaged this turn, by its descriptor id, for the
 * mid-turn re-pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const channelId = 'discord:g1:444555';
const origin = { kind: 'agent' as const, agentName: 'sol' };

/** A real ChannelRegistry with one registered channel, and a framework with
 *  just what dispatchMcplToolCall reads. */
async function harness() {
  // Every channels/open attempt, including one the server refuses.
  const opens: Array<{ channelId?: string }> = [];
  let refuseOpens = false;
  const server = {
    id: 'discord',
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    async sendToolsCall() {
      // discord-mcpl's send tools answer with the posted message and the raw channel id.
      return { content: [{ type: 'text', text: JSON.stringify({ messageId: 'm9', channelId: '444555' }) }] };
    },
    async sendChannelsOpen(params: { channelId?: string }) {
      opens.push(params);
      if (refuseOpens) throw new Error('open refused by server');
      return {};
    },
    async sendChannelsClose() {
      return {};
    },
  };
  const serverRegistry = {
    getServer: (id: string) => (id === 'discord' ? server : undefined),
  } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(serverRegistry, {} as FeatureSetManager, () => {}, () => {});
  await registry.handleChanged('discord', {
    added: [{ id: channelId, type: 'discord', label: '#upkeep', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '444555' } }],
  } as never);

  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerRegistry = serverRegistry;
  framework.mcplServerConfigs = new Map([['discord', { id: 'discord', toolPrefix: 'discord' }]]);
  framework.mcplToolFeatureSets = new Map();
  framework.checkpointManager = null;
  framework.channelRegistry = registry;
  framework.turnEngagedChannels = new Map();
  framework.emitTrace = () => {};
  const windowMessages: string[] = [];
  framework.addMessage = (_role: string, content: Array<{ text?: string }>) => {
    windowMessages.push(content.map((b) => b.text ?? '').join(''));
    return 'msg';
  };

  /** Dispatch reply_message by the raw id; resolve with its result and the
   *  turn's engaged channels as they stood when the result was queued (the
   *  mid-turn re-pin reads them when that event is processed). */
  async function reply(): Promise<{ success: boolean; engagedAtResult: string[] }> {
    const out = await new Promise<{ success: boolean; engagedAtResult: string[] }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the tool result')), 1000);
      framework.pushEvent = (event: { type: string; callId?: string; result: { success: boolean } }) => {
        if (event.type === 'tool-result' && event.callId === 'call-reply') {
          clearTimeout(timeout);
          resolve({
            success: event.result.success,
            engagedAtResult: [...(framework.turnEngagedChannels.get('sol') ?? [])],
          });
        }
      };
      framework.dispatchMcplToolCall(
        'sol',
        { id: 'call-reply', name: 'discord--reply_message', input: { channelId: '444555', messageId: 'm1', content: 'answering, without moving in' } },
        'discord',
        'discord',
      );
    });
    // Let anything the send started on its own settle before the caller looks.
    await new Promise((resolve) => setImmediate(resolve));
    return out;
  }

  return {
    registry, opens, windowMessages, reply,
    setRefuseOpens: (v: boolean) => { refuseOpens = v; },
  };
}

test('a reply_message into a channel the agent closed leaves it closed, and records the turn engagement', async () => {
  const { registry, opens, windowMessages, reply } = await harness();
  // The agent had the channel open, then closed it.
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const opensBefore = opens.length;

  const { success, engagedAtResult } = await reply();

  assert.equal(success, true);
  assert.equal(opens.length, opensBefore, 'the send sent no channels/open');
  assert.equal(registry.isChannelOpen(channelId), false, 'the channel stays closed');
  assert.equal(registry.getDesiredState('discord', channelId), 'closed', "the agent's close stands");
  assert.deepEqual(windowMessages, [], 'no notice says the channel opened');
  assert.deepEqual(engagedAtResult, [channelId],
    'recorded by the descriptor id the re-pin compares, before the tool result is queued');
});

test('a reply_message into a channel decided open whose open failed retries no open', async () => {
  const { registry, opens, windowMessages, reply, setRefuseOpens } = await harness();
  // The agent opened it, but the server refused: decided open, transport closed.
  setRefuseOpens(true);
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, false);
  assert.equal(registry.getDesiredState('discord', channelId), 'open');
  assert.equal(registry.isChannelOpen(channelId), false);
  const opensBefore = opens.length;

  const { success } = await reply();

  assert.equal(success, true);
  assert.equal(opens.length, opensBefore, 'the send attempts no channels/open');
  assert.equal(registry.isChannelOpen(channelId), false);
  assert.deepEqual(windowMessages, []);
});

test('a reply_message into a tuned-out channel leaves the tune-out in place', async () => {
  const { registry, opens, windowMessages, reply } = await harness();
  // Tuned out: the transport stays open, and the decision is the tune-out.
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  registry.enterTuneOut('discord', channelId, {
    epochId: 'e1', cadenceSeconds: 600, backlogCap: 50, maxWakes: 3, startedAtSequence: 0,
  }, 'agent-tool');
  const opensBefore = opens.length;

  const { success } = await reply();

  assert.equal(success, true);
  assert.equal(registry.getDesiredState('discord', channelId), 'tuned-out', 'the tune-out stands');
  assert.equal(opens.length, opensBefore, 'the send sent no channels/open');
  assert.deepEqual(windowMessages, [], 'no notice says the channel opened');
});
