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
  const sent: string[] = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async (params: { history?: { beforeMessageId?: unknown } }) => { opens.push(params); sent.push('open'); return {}; },
    sendChannelsClose: async () => { sent.push('close'); return {}; },
    sendChannelsAcknowledge: async (params: { messageId?: unknown }) => { acks.push(params); sent.push('acknowledge'); return { acknowledged: true }; },
    sendChannelsPublish: async () => { sent.push('publish'); return { delivered: true, messageId: 'm1' }; },
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
  // Registering the channel sends what its desired state asks; only what a
  // call sends after this counts.
  sent.length = 0;
  return { registry, opens, acks, sent };
}

const call = (text: string): unknown => JSON.parse(text);

const invited = { serverId: 'discord', channelId: 'invited' };

for (const [kind, written, gave] of [['a number', ID, 'a number'], ['true', 'true', 'a boolean']] as const) {
  test(`channel_open refuses a beforeMessageId written as ${kind}, and nothing is opened or sent`, async () => {
    const { registry, opens } = await makeRegistry();
    const before = registry.getDesiredState('discord', 'invited');
    const res = await registry.handleChannelToolCall('channel_open', call(`{"channelId":"invited","backscroll":5,"beforeMessageId":${written}}`), origin);
    assert.equal(res.success, false);
    assert.equal((res as { isError?: unknown }).isError, true);
    assert.equal(String((res as { error?: unknown }).error).startsWith(`Nothing changed: channel_open's beforeMessageId must be a string, and this call gave ${gave}. Give it in quotes`), true, String((res as { error?: unknown }).error));
    assert.equal(opens.length, 0, 'no channels/open was sent');
    assert.equal(registry.getDesiredState('discord', 'invited'), before, 'no decision to open was recorded');
  });

  test(`channel_decline refuses a messageId written as ${kind}, and nothing is declined or acknowledged`, async () => {
    const { registry, acks } = await makeRegistry();
    const res = await registry.handleChannelToolCall('channel_decline', call(`{"channelId":"invited","messageId":${written},"acknowledge":"👀"}`), origin);
    assert.equal(res.success, false);
    assert.equal((res as { isError?: unknown }).isError, true);
    assert.equal(String((res as { error?: unknown }).error).startsWith(`Nothing changed: channel_decline's messageId must be a string, and this call gave ${gave}. Give it in quotes`), true, String((res as { error?: unknown }).error));
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

test("channel_publish's refusal of a channelId written as a number carries isError, and says why a number won't do", async () => {
  const { registry } = await makeRegistry();
  const res = await registry.handleChannelToolCall('channel_publish', call(`{"channelId":${ID},"content":"zz-number"}`), origin);
  assert.equal(res.success, false);
  assert.equal((res as { isError?: unknown }).isError, true);
  assert.equal(
    (res as { error?: unknown }).error,
    "Nothing changed: channel_publish's channelId must be a string, and this call gave a number. "
      + 'Give it in quotes: a number can lose its last digits as the call is read.',
  );
});

// Every parameter a channel tool's schema gives as a string, other than the
// three above, each with a call that's otherwise one the tool takes.
const STRING_PARAMETERS: Array<[tool: string, field: string, rest: Record<string, unknown>]> = [
  ['channel_open', 'channelId', { serverId: 'discord' }],
  ['channel_open', 'serverId', { channelId: 'invited' }],
  ['channel_decline', 'channelId', { serverId: 'discord', messageId: '1', acknowledge: '👀' }],
  ['channel_decline', 'serverId', { channelId: 'invited', messageId: '1', acknowledge: '👀' }],
  ['channel_decline', 'acknowledge', { channelId: 'invited', serverId: 'discord', messageId: '1' }],
  ['channel_close', 'channelId', { serverId: 'discord' }],
  ['channel_close', 'serverId', { channelId: 'invited' }],
  ['channel_publish', 'content', { channelId: 'invited' }],
  ['channel_publish', 'text', { channelId: 'invited' }],
  ['think', 'content', {}],
  ['journal', 'content', {}],
  ['skip_reply', 'reason', {}],
];
const NOT_STRINGS: Array<[written: string, gave: string]> = [
  [ID, 'a number'], ['0', 'a number'], ['true', 'a boolean'], ['false', 'a boolean'], ['{}', 'an object'], ['[]', 'an array'],
];

for (const [tool, field, rest] of STRING_PARAMETERS) {
  test(`${tool} refuses a ${field} that isn't a string, and changes and sends nothing`, async () => {
    for (const [written, gave] of NOT_STRINGS) {
      const { registry, sent } = await makeRegistry();
      const state = registry.getDesiredState('discord', 'invited');
      const closed = registry.closedByAgent(invited);
      const input = { ...rest, ...(call(`{"${field}":${written}}`) as object) };
      const res = await registry.handleChannelToolCall(tool, input, origin);
      const error = String((res as { error?: unknown }).error);
      assert.equal(res.success, false, `${field} ${written}: ${JSON.stringify(res)}`);
      assert.equal((res as { isError?: unknown }).isError, true, `${field} ${written}`);
      assert.equal(error.startsWith(`Nothing changed: ${tool}'s ${field} must be a string, and this call gave ${gave}. Give it in quotes`), true, error);
      assert.equal(error.includes('can lose its last digits'), gave === 'a number', `the digits clause only for a number: ${error}`);
      assert.deepEqual(sent, [], `${field} ${written}: nothing was sent`);
      assert.equal(registry.getDesiredState('discord', 'invited'), state, `${field} ${written}: the channel's desired state is as it was`);
      assert.equal(registry.closedByAgent(invited), closed, `${field} ${written}: no decision was recorded`);
    }
  });
}

test('a serverId given as null is read as none given, as before', async () => {
  const { registry, sent } = await makeRegistry();
  const res = await registry.handleChannelToolCall('channel_open', call('{"channelId":"invited","serverId":null}'), origin);
  assert.equal(res.success, true, JSON.stringify(res));
  assert.deepEqual(sent, ['open']);
});
