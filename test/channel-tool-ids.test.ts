import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const ID = '1437820485836259419';
const origin = { kind: 'agent' as const, agentName: 'sol' };

async function makeRegistry() {
  const opens: Array<{ history?: { beforeMessageId?: unknown } }> = [];
  const acks: Array<{ messageId?: unknown }> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async (params: { history?: { beforeMessageId?: unknown } }) => { opens.push(params); return {}; },
    sendChannelsClose: async () => ({}),
    sendChannelsAcknowledge: async (params: { messageId?: unknown }) => { acks.push(params); return { acknowledged: true }; },
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { onRouteFailure: () => {} },
  );
  await registry.handleChanged('discord', {
    added: [
      { id: 'invited', type: 'discord', label: '#invited', direction: 'bidirectional' },
    ],
  } as never);
  return { registry, opens, acks };
}

const call = (text: string): unknown => JSON.parse(text);

const invited = { serverId: 'discord', channelId: 'invited' };

for (const [kind, written] of [['a number', ID], ['true', 'true']] as const) {
  test(`channel_open refuses a beforeMessageId written as ${kind}, and nothing is opened or sent`, async () => {
    const { registry, opens } = await makeRegistry();
    const before = registry.getDesiredState('discord', 'invited');
    const res = await registry.handleChannelToolCall('channel_open', call(`{"channelId":"invited","backscroll":5,"beforeMessageId":${written}}`), origin);
    assert.equal(res.success, false);
    assert.equal((res as { isError?: unknown }).isError, true);
    assert.match(String((res as { error?: unknown }).error), /^Nothing changed: channel_open's beforeMessageId must be a string\. Give it in quotes, as the invitation notice does/);
    assert.equal(opens.length, 0, 'no channels/open was sent');
    assert.equal(registry.getDesiredState('discord', 'invited'), before, 'no decision to open was recorded');
  });

  test(`channel_decline refuses a messageId written as ${kind}, and nothing is declined or acknowledged`, async () => {
    const { registry, acks } = await makeRegistry();
    const res = await registry.handleChannelToolCall('channel_decline', call(`{"channelId":"invited","messageId":${written},"acknowledge":"👀"}`), origin);
    assert.equal(res.success, false);
    assert.equal((res as { isError?: unknown }).isError, true);
    assert.match(String((res as { error?: unknown }).error), /^Nothing changed: channel_decline's messageId must be a string\. Give it in quotes, as the invitation notice does/);
    assert.equal(acks.length, 0, 'no channels/acknowledge was sent');
    assert.equal(registry.closedByAgent(invited), undefined, 'no decline was recorded');
  });
}

test('channel_open and channel_decline pass a string id to the server as it was written', async () => {
  const opened = await makeRegistry();
  const open = await opened.registry.handleChannelToolCall('channel_open', call(`{"channelId":"invited","backscroll":5,"beforeMessageId":"${ID}"}`), origin);
  assert.equal(open.success, true);
  assert.equal(opened.opens.at(-1)?.history?.beforeMessageId, ID);
  assert.equal(opened.registry.getDesiredState('discord', 'invited'), 'open');
  const declined = await makeRegistry();
  const decline = await declined.registry.handleChannelToolCall('channel_decline', call(`{"channelId":"invited","messageId":"${ID}","acknowledge":"👀"}`), origin);
  assert.equal(decline.success, true);
  assert.equal(declined.acks.at(-1)?.messageId, ID);
  assert.equal(declined.registry.closedByAgent(invited), 'declined');
});

test('channel_open takes a null beforeMessageId as no anchor, as before', async () => {
  const { registry, opens } = await makeRegistry();
  const res = await registry.handleChannelToolCall('channel_open', call(`{"channelId":"invited","backscroll":5,"beforeMessageId":null}`), origin);
  assert.equal(res.success, true);
  assert.equal(opens.length, 1);
  const history = opens[0]?.history;
  assert.ok(history, 'the backscroll asked for history');
  assert.equal('beforeMessageId' in history, false, 'no anchor was sent');
});
