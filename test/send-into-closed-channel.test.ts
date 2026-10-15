/**
 * Speaking never opens a channel: an explicit send tool's successful call
 * posts (the server sends it) and leaves the channel's lifecycle as the agent
 * left it, with no "[channels] Now open" notice: a channel the agent closed
 * stays closed, a channel whose open failed isn't opened again, and a
 * tuned-out channel stays tuned out. The call still
 * records the channel as engaged this turn, by its descriptor id, for the
 * mid-turn re-pin. Where the words land in a closed channel that isn't a DM,
 * the send's answer, or the turn's delivery line for routed speech, says the
 * channel stays closed, what still reaches the agent from it, and how to open
 * it, until the agent turns that note off with agent_settings.
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

/** The note a send's answer carries when it lands in the closed #upkeep. */
const UPKEEP_NOTE = `[closed channel] #upkeep (${channelId}) stays closed: speaking into a closed channel doesn't open it. ` +
  'Messages there that address you, such as an @-mention, still reach you; to hear the rest of its traffic, ' +
  `call channel_open with channelId "${channelId}" and serverId "discord". ` +
  'To stop this note, set closed_channel_note to false with agent_settings.';

/** A real ChannelRegistry with one registered channel, and a framework with
 *  just what dispatchMcplToolCall reads. */
async function harness() {
  // Every channels/open attempt, including one the server refuses.
  const opens: Array<{ channelId?: string }> = [];
  let refuseOpens = false;
  // While set, the send's result waits for it.
  let hold: Promise<void> | null = null;
  // The raw channel id the send's answer names.
  let sentTo = '444555';
  const server = {
    id: 'discord',
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    async sendToolsCall() {
      if (hold) await hold;
      // discord-mcpl's send tools answer with the posted message and the raw channel id.
      return { content: [{ type: 'text', text: JSON.stringify({ messageId: 'm9', channelId: sentTo }) }] };
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
  // The sending turn's routing, whose engaged set a send tool records into.
  framework.turnRouting = new Map([['sol', { engaged: new Set<string>() }]]);
  framework.emitTrace = () => {};
  // The framework's state store, where agent_settings keeps closed_channel_note.
  let frameworkState: unknown = null;
  framework.store = {
    getStateJson: () => frameworkState,
    setStateJson: (_id: string, value: unknown) => { frameworkState = value; },
  };
  framework.agents = new Map([['sol', {}]]);
  // Channels seen delivering a chat:dm message (a class field the constructor sets).
  framework.directMessageChannels = new Set<string>();
  const windowMessages: string[] = [];
  framework.addMessage = (_role: string, content: Array<{ text?: string }>) => {
    windowMessages.push(content.map((b) => b.text ?? '').join(''));
    return 'msg';
  };

  /** Dispatch reply_message by the raw id; resolve with its result and the
   *  turn's engaged channels as they stood when the result was queued (the
   *  mid-turn re-pin reads them when that event is processed). */
  async function reply(tool = 'reply_message'): Promise<{ success: boolean; engagedAtResult: string[]; data: string }> {
    const out = await new Promise<{ success: boolean; engagedAtResult: string[]; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the tool result')), 1000);
      framework.pushEvent = (event: { type: string; callId?: string; result: { success: boolean; data?: unknown } }) => {
        if (event.type === 'tool-result' && event.callId === 'call-reply') {
          clearTimeout(timeout);
          resolve({
            success: event.result.success,
            engagedAtResult: [...(framework.turnRouting.get('sol')?.engaged ?? [])],
            data: String(event.result.data ?? ''),
          });
        }
      };
      framework.dispatchMcplToolCall(
        'sol',
        { id: 'call-reply', name: `discord--${tool}`, input: { channelId: sentTo, messageId: 'm1', content: 'answering, without moving in' } },
        'discord',
        'discord',
      );
    });
    // Let anything the send started on its own settle before the caller looks.
    await new Promise((resolve) => setImmediate(resolve));
    return out;
  }

  return {
    registry, framework, opens, windowMessages, reply,
    setRefuseOpens: (v: boolean) => { refuseOpens = v; },
    setHold: (p: Promise<void> | null) => { hold = p; },
    setSentTo: (raw: string) => { sentTo = raw; },
    state: () => frameworkState as { closedChannelNotes?: Record<string, boolean> } | null,
  };
}

test("a send that stays in a closed channel says so, what still reaches the agent, and how to open it, until they turn the note off", async () => {
  const { registry, framework, reply, state } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);

  const first = await reply();
  assert.equal(first.success, true);
  assert.ok(first.data.endsWith(`\n${UPKEEP_NOTE}`), first.data);
  assert.ok(first.data.startsWith('{"messageId":"m9"'), "the server's own answer comes first");

  // Turned off through agent_settings, for good: kept in the framework's state.
  const settings = framework.closedChannelNoteSettingsExtension();
  assert.deepEqual(settings.get('sol'), { closed_channel_note: true });
  assert.deepEqual(settings.update('sol', { closed_channel_note: false }), { closed_channel_note: false });
  assert.deepEqual(state()?.closedChannelNotes, { sol: false });
  assert.ok(!(await reply()).data.includes('[closed channel]'), 'no note once turned off');
  assert.throws(() => settings.update('sol', { closed_channel_note: 'off' }), /closed_channel_note must be a boolean/);

  // Reset brings the default back.
  assert.deepEqual(settings.reset('sol'), { closed_channel_note: true });
  assert.ok((await reply()).data.endsWith(UPKEEP_NOTE));
});

test("a note that can't be worked out leaves the send's answer as the server gave it", async () => {
  const { registry, framework, reply } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  // The setting can't be read, as after the store has closed.
  framework.store = { getStateJson: () => { throw new Error('store closed'); } };
  const { success, data } = await reply();
  assert.equal(success, true, 'the send was delivered, and says so');
  assert.equal(data, JSON.stringify({ messageId: 'm9', channelId: '444555' }));
});

test('a send into an open channel, or into a DM by any sign of one, carries no closed-channel note', async () => {
  {
    const { registry, reply } = await harness();
    assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
    assert.ok(!(await reply()).data.includes('[closed channel]'), 'open');
  }
  {
    // send_dm sends to a DM, whatever the registry knows of it.
    const { reply } = await harness();
    assert.ok(!(await reply('send_dm')).data.includes('[closed channel]'), 'send_dm');
  }
  {
    // A channel that delivered a message tagged chat:dm.
    const { framework, reply } = await harness();
    framework.noteDirectMessageTags(channelId, ['chat:addressed', 'chat:dm']);
    assert.ok(!(await reply()).data.includes('[closed channel]'), 'chat:dm seen');
  }
  {
    // One the registry knows as a DM by its metadata.
    const { registry, reply, setSentTo } = await harness();
    await registry.handleChanged('discord', {
      added: [{ id: 'discord:dm:777', type: 'discord', label: 'Tess', direction: 'bidirectional',
        address: { channelId: '777' }, metadata: { channelType: 'dm' } }],
    } as never);
    setSentTo('777');
    const { data, engagedAtResult } = await reply();
    assert.deepEqual(engagedAtResult, ['discord:dm:777']);
    assert.ok(!data.includes('[closed channel]'), 'registry DM');
  }
});

test("routed speech that stays in a closed channel says so in the turn's delivery line", async () => {
  const { registry, framework } = await harness();
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:dm:777', type: 'discord', label: 'Tess', direction: 'bidirectional',
      address: { channelId: '777' }, metadata: { channelType: 'dm' } }],
  } as never);
  const lines: string[] = [];
  const agent = {
    name: 'sol',
    proseRouting: 'auto',
    getContextManager: () => ({
      addMessage: (_role: string, content: Array<{ text: string }>) => { lines.push(content[0]!.text); return 'm'; },
    }),
  };
  const receipt = (...deliveries: string[]) => {
    framework.appendProseDeliveryReceipt(agent, { deliveries, suppressed: 0 });
    return lines.pop();
  };
  // The same words as a send's note, without its tag.
  const note = UPKEEP_NOTE.slice('[closed channel] '.length);
  assert.equal(receipt(channelId), `[delivered] plain speech → #upkeep (${channelId}) · ${note}`);
  // A DM says nothing more.
  assert.equal(receipt('discord:dm:777'), '[delivered] plain speech → #Tess (discord:dm:777)');
  // Nor does an open channel, or any channel once the agent has turned the note off.
  framework.closedChannelNoteSettingsExtension().update('sol', { closed_channel_note: false });
  assert.equal(receipt(channelId), `[delivered] plain speech → #upkeep (${channelId})`);
  framework.closedChannelNoteSettingsExtension().reset('sol');
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal(receipt(channelId), `[delivered] plain speech → #upkeep (${channelId})`);
});

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

  // The send marked the channel answered: when the push lane reports its
  // next message, a turn with no trigger speaks there.
  assert.equal(registry.getDefaultPublishChannel(), null);
  registry.notePushDelivered('discord', channelId, 'm2', undefined, ['chat:mention']);
  assert.equal(registry.getDefaultPublishChannel(), channelId, 'the send answered the channel');
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

test('a reply_message still in flight when the agent closes its channel marks nothing', async () => {
  const { registry, reply, setHold } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  let release!: () => void;
  setHold(new Promise<void>((resolve) => { release = resolve; }));
  const replying = reply();
  // The same round closes the channel while the reply is in flight.
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  release();
  const { success } = await replying;
  assert.equal(success, true);
  assert.equal(registry.isChannelOpen(channelId), false, 'the channel stays closed');
  registry.notePushDelivered('discord', channelId, 'm2', undefined, ['chat:mention']);
  assert.equal(registry.getDefaultPublishChannel(), null, 'the close, made while the reply was in flight, stands');
});
