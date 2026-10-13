/**
 * Speaking never opens a channel: an explicit send tool's successful call
 * into a channel the agent closed posts there (the server sends it) and
 * leaves the channel's lifecycle as the agent left it, with no "[channels]
 * Now open" notice. The call still records the channel as engaged this turn,
 * by its descriptor id, for the mid-turn re-pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

test('a reply_message into a channel the agent closed leaves it closed, and records the turn engagement', async () => {
  const opens: Array<{ channelId?: string }> = [];
  const server = {
    id: 'discord',
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    async sendToolsCall() {
      // discord-mcpl's send tools answer with the posted message and the raw channel id.
      return { content: [{ type: 'text', text: JSON.stringify({ messageId: 'm9', channelId: '444555' }) }] };
    },
    async sendChannelsOpen(params: { channelId?: string }) {
      opens.push(params);
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

  const channelId = 'discord:g1:444555';
  await registry.handleChanged('discord', {
    added: [{ id: channelId, type: 'discord', label: '#upkeep', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '444555' } }],
  } as never);
  // The agent had the channel open, then closed it.
  const origin = { kind: 'agent' as const, agentName: 'sol' };
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const opensBefore = opens.length;

  // A framework with just what dispatchMcplToolCall reads.
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

  const result = await new Promise<{ success: boolean }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for the tool result')), 1000);
    framework.pushEvent = (event: { type: string; callId?: string; result: { success: boolean } }) => {
      if (event.type === 'tool-result' && event.callId === 'call-reply') {
        clearTimeout(timeout);
        resolve(event.result);
      }
    };
    framework.dispatchMcplToolCall(
      'sol',
      { id: 'call-reply', name: 'discord--reply_message', input: { channelId: '444555', messageId: 'm1', content: 'answering, without moving in' } },
      'discord',
      'discord',
    );
  });
  // Let anything the send started on its own settle before looking.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.success, true);
  assert.equal(opens.length, opensBefore, 'the send sent no channels/open');
  assert.equal(registry.isChannelOpen(channelId), false, 'the channel stays closed');
  assert.equal(registry.getDesiredState('discord', channelId), 'closed', "the agent's close stands");
  assert.deepEqual(windowMessages, [], 'no notice says the channel opened');
  assert.deepEqual([...(framework.turnEngagedChannels.get('sol') ?? [])], [channelId],
    'the raw id resolves to the descriptor id the re-pin compares');
});
