/**
 * Speaking never undoes the agent's own decision to keep a channel closed: an
 * explicit send tool's successful call posts (the server sends it), and opens
 * a closed channel, as channel_open does, unless the agent closed or declined
 * it itself or a module closed it, which stay closed, as a tuned-out channel
 * stays tuned out. A channel nobody decided about, one a machine closed, and
 * one decided open whose open failed are opened, as on main. The call records
 * the channel as engaged this turn, by its descriptor id, for the mid-turn
 * re-pin. Where the words land in a channel the agent closed or declined
 * itself, the send's answer, or the turn's delivery line for routed speech,
 * says the channel stays closed, what still reaches the agent from it, and
 * how to open it, until the agent turns that note off with agent_settings. A
 * code_execution script's send keeps the server's receipt, which the script
 * parses, and the agent is told by a notice in its window instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry, destinationKey } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const channelId = 'discord:g1:444555';
const origin = { kind: 'agent' as const, agentName: 'sol' };
/** A channel on a server, discord unless named. */
const ref = (id: string, serverId = 'discord') => ({ serverId, channelId: id });
/** A turn's routing as its `[delivered]` receipt reads it: plain speech
 *  delivered to these channels on discord, and nothing else. */
const receiptRouting = (...ids: string[]) => ({ deliveries: ids.map((id) => ref(id)), suppressed: 0, drafts: [], keptPrivate: 0 });
/** The agent the harness's framework knows, with what a send's dispatch reads of it. */
const agentStub = (more: Record<string, unknown> = {}) => ({
  canUseTool: () => true,
  getConsumedWatermark: () => null,
  notePublished: () => {},
  ...more,
});

/** The note a send's answer carries when it lands in #upkeep, which the agent closed. */
const UPKEEP_NOTE = `[closed channel] #upkeep (${channelId}) stays closed: you closed it, and your words there don't open it. ` +
  'Messages there that address you, such as an @-mention, still reach you. ' +
  `channel_open with channelId "${channelId}" and serverId "discord" opens it. ` +
  'To stop this note, set closed_channel_note to false with agent_settings.';

/** A real ChannelRegistry with one registered channel, and a framework with
 *  just what dispatchMcplToolCall reads. With sharedIdFirst, a second server,
 *  discord2, registers a channel with the same id first, so a lookup by bare
 *  id finds that one. */
async function harness(opts: { sharedIdFirst?: boolean } = {}) {
  // Every channels/open attempt, including one the server refuses.
  const opens: Array<{ channelId?: string }> = [];
  let refuseOpens = false;
  // While set, the send's result waits for it; reaching it resolves sendReached.
  let hold: Promise<void> | null = null;
  let reached!: () => void;
  let sendReached = new Promise<void>((resolve) => { reached = resolve; });
  // The raw channel id the send's answer names.
  let sentTo = '444555';
  // While set, the server refuses the send, as discord-mcpl does without Send Messages.
  let refuseSends = false;
  // While set, the server refuses channels/close.
  let refuseCloses = false;
  // While set, the send's answer is this content instead of discord-mcpl's receipt.
  let answer: unknown[] | null = null;
  const published: Array<{ channelId: string; text: string }> = [];
  const server = {
    id: 'discord',
    isConnected: true,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    async sendToolsList() {
      return { tools: ['send_message', 'reply_message', 'send_dm'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
    },
    async sendToolsCall() {
      reached();
      if (hold) await hold;
      if (refuseSends) {
        return { content: [{ type: 'text', text: `Missing Access in channel ${sentTo}` }], isError: true };
      }
      if (answer) return { content: answer };
      // discord-mcpl's send tools answer with the posted message and the raw channel id.
      return { content: [{ type: 'text', text: JSON.stringify({ messageId: 'm9', channelId: sentTo }) }] };
    },
    async sendChannelsOpen(params: { channelId?: string }) {
      opens.push(params);
      if (refuseOpens) throw new Error('open refused by server');
      return {};
    },
    async sendChannelsClose() {
      if (refuseCloses) throw new Error('close refused by server');
      return {};
    },
    // What routed speech, such as a sleep announcement, posts.
    async sendChannelsPublish(params: { channelId: string; content: Array<{ text: string }> }) {
      published.push({ channelId: params.channelId, text: params.content[0]!.text });
      return { delivered: true };
    },
  };
  const serverRegistry = {
    getServer: (id: string) => (id === 'discord' || id === 'discord2' ? server : undefined),
    getAllServers: () => [server],
  } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(serverRegistry, {} as FeatureSetManager, () => {}, () => {});
  if (opts.sharedIdFirst) {
    await registry.handleChanged('discord2', {
      added: [{ id: channelId, type: 'discord', label: '#elsewhere', direction: 'bidirectional',
        address: { guildId: 'g2', channelId: '444555' } }],
    } as never);
  }
  // Every open a send starts, which the send's answer doesn't wait for.
  const speechOpens: Promise<unknown>[] = [];
  const openIfClosedForSend = registry.openIfClosedForSend.bind(registry);
  registry.openIfClosedForSend = ((...args: Parameters<typeof openIfClosedForSend>) => {
    const opening = openIfClosedForSend(...args);
    speechOpens.push(opening);
    return opening;
  }) as typeof openIfClosedForSend;
  await registry.handleChanged('discord', {
    added: [{ id: channelId, type: 'discord', label: '#upkeep', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '444555' } }],
  } as never);

  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerRegistry = serverRegistry;
  framework.mcplServerConfigs = new Map([['discord', { id: 'discord', toolPrefix: 'discord' }]]);
  framework.mcplTools = [];
  framework.mcplToolFeatureSets = new Map();
  framework.checkpointManager = null;
  framework.channelRegistry = registry;
  // The sending turn's routing, whose engaged set a send tool made in that
  // turn (callerTurnId) records into.
  framework.turnRouting = new Map([['sol', { turnId: 't1', engaged: new Set<string>() }]]);
  framework.openLogical = new Map();
  framework.scriptCallStarts = new Map();
  framework.usedEphemeralAgentNames = new Set();
  framework.emitTrace = () => {};
  // The framework's state store, where agent_settings keeps closed_channel_note.
  let frameworkState: unknown = null;
  framework.store = {
    getStateJson: () => frameworkState,
    setStateJson: (_id: string, value: unknown) => { frameworkState = value; },
  };
  framework.agents = new Map([['sol', agentStub()]]);
  // Conversation agents by their home channel, and ephemeral runs by name;
  // sol is neither.
  // The Dendrite registry, where a conversation agent's home is kept; sol has none.
  framework.registry = { homes: new Map<string, { serverId: string; channelId: string }>(), homeChannel(name: string) { return this.homes.get(name); }, list: () => [] };
  framework.ephemeralRuns = new Map();
  const windowMessages: string[] = [];
  /** Whose window each of those was addressed to: addMessage's forAgent, or
   *  undefined for the primary agent's. */
  const windowFor: Array<string | undefined> = [];
  framework.addMessage = (_role: string, content: Array<{ text?: string }>, _metadata?: unknown, opts?: { forAgent?: string }) => {
    windowMessages.push(content.map((b) => b.text ?? '').join(''));
    windowFor.push(opts?.forAgent);
    return 'msg';
  };

  /** Dispatch a send tool by the raw id, made in the agent's turn; resolve
   *  with its result, and the turn's engaged channels once the open the send
   *  started has settled, and what follows it. A script's call (`script`) is
   *  one the framework is waiting on for a script. */
  async function reply(tool = 'reply_message', callId = 'call-reply', script = false): Promise<{ success: boolean; engaged: string[]; data: string; raw: unknown; error: string }> {
    if (script) framework.scriptToolWaiters = new Map([[callId, () => {}]]);
    const out = await new Promise<{ success: boolean; data: string; raw: unknown; error: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the tool result')), 1000);
      framework.pushEvent = (event: { type: string; callId?: string; result: { success: boolean; data?: unknown; error?: string } }) => {
        if (event.type === 'tool-result' && event.callId === callId) {
          clearTimeout(timeout);
          resolve({
            success: event.result.success,
            data: String(event.result.data ?? ''),
            raw: event.result.data,
            error: String(event.result.error ?? ''),
          });
        }
      };
      framework.dispatchMcplToolCall(
        'sol',
        { id: callId, name: `discord--${tool}`, callerTurnId: 't1',
          input: { channelId: sentTo, messageId: 'm1', content: 'answering, without moving in' } },
        'discord',
        'discord',
      );
    });
    // Let the open the send started on its own settle, and what follows it,
    // before the caller looks.
    await Promise.allSettled(speechOpens.splice(0));
    await new Promise((resolve) => setImmediate(resolve));
    framework.scriptToolWaiters = undefined;
    return { ...out, engaged: [...(framework.turnRouting.get('sol')?.engaged ?? [])] };
  }

  await framework.refreshMcplTools();
  return {
    registry, framework, opens, windowMessages, windowFor, reply, published,
    setRefuseOpens: (v: boolean) => { refuseOpens = v; },
    setHold: (p: Promise<void> | null) => {
      hold = p;
      sendReached = new Promise<void>((resolve) => { reached = resolve; });
    },
    sendReached: () => sendReached,
    setSentTo: (raw: string) => { sentTo = raw; },
    setRefuseSends: (v: boolean) => { refuseSends = v; },
    setRefuseCloses: (v: boolean) => { refuseCloses = v; },
    setAnswer: (content: unknown[] | null) => { answer = content; },
    setGrant: (grant: CapabilityGrant) => { server.grant = grant; },
    /** The server's connection, as a drop leaves it: not connected, the host
     *  reconnecting to it, its grant empty until its next exchange. */
    dropConnection: () => {
      Object.assign(server, { isConnected: false, willReconnect: true, grant: new CapabilityGrant(new Set(), []) });
    },
    state: () => frameworkState as { closedChannelNotes?: Record<string, boolean> } | null,
  };
}

test("a send into a channel the agent closed says so, what still reaches the agent, and how to open it, until they turn the note off", async () => {
  const { registry, framework, reply } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);

  const first = await reply();
  assert.equal(first.success, true);
  assert.ok(first.data.endsWith(`\n${UPKEEP_NOTE}`), first.data);
  assert.ok(first.data.startsWith('{"messageId":"m9"'), "the server's own answer comes first");
  // Every send tool, send_dm included: one rule for every way of speaking.
  assert.ok((await reply('send_dm')).data.endsWith(`\n${UPKEEP_NOTE}`), 'send_dm');

  // Turned off through agent_settings, for good: kept in the framework's state.
  const settings = framework.closedChannelNoteSettingsExtension();
  assert.deepEqual(settings.get('sol'), { closed_channel_note: true });
  assert.deepEqual(settings.update('sol', { closed_channel_note: false }), { closed_channel_note: false });
  assert.ok(!(await reply()).data.includes('[closed channel]'), 'no note once turned off');
  assert.throws(() => settings.update('sol', { closed_channel_note: 'off' }), /closed_channel_note must be true or false, not "off"/);

  // Reset brings the default back.
  assert.deepEqual(settings.reset('sol'), { closed_channel_note: true });
  assert.ok((await reply()).data.endsWith(UPKEEP_NOTE));
});

test("a note that can't be worked out leaves the delivered words as they were, and the operator's log says why", async () => {
  const { registry, framework, reply } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const answer = JSON.stringify({ messageId: 'm9', channelId: '444555' });
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[closed-channel-note]')) logged.push(line);
  };
  try {
    // The setting can't be read, as after the store has closed.
    const store = framework.store;
    framework.store = { getStateJson: () => { throw new Error('store closed'); } };
    let sent = await reply();
    assert.equal(sent.success, true, 'the send was delivered, and says so');
    assert.equal(sent.data, answer);
    assert.deepEqual(logged.splice(0), ['[closed-channel-note] for sol failed: store closed']);
    framework.store = store;

    // The registry can't say who closed the channel, and then a lookup
    // throws something that isn't an Error at all.
    const closedByAgent = registry.closedByAgent;
    registry.closedByAgent = () => { throw new Error('lookup failed'); };
    sent = await reply();
    assert.equal(sent.success, true);
    assert.equal(sent.data, answer);
    assert.deepEqual(logged.splice(0), ['[closed-channel-note] for sol failed: lookup failed']);
    registry.closedByAgent = () => { throw undefined; };
    sent = await reply();
    assert.equal(sent.success, true);
    assert.equal(sent.data, answer);
    assert.deepEqual(logged.splice(0), ['[closed-channel-note] for sol failed: undefined']);
    registry.closedByAgent = closedByAgent;

    // The channel the send went to can't be looked up.
    const resolveSendTarget = registry.resolveSendTarget;
    registry.resolveSendTarget = () => { throw new Error('target lookup failed'); };
    sent = await reply();
    assert.equal(sent.success, true);
    assert.equal(sent.data, answer);
    assert.deepEqual(logged.splice(0), ['[closed-channel-note] for sol failed: target lookup failed']);
    registry.resolveSendTarget = resolveSendTarget;

    // Routed speech's delivery line stands without the note.
    const lines: string[] = [];
    const agent = {
      name: 'sol',
      proseRouting: 'locus',
      getContextManager: () => ({
        addMessage: (_role: string, content: Array<{ text: string }>) => { lines.push(content[0]!.text); return 'm'; },
      }),
    };
    framework.store = { getStateJson: () => { throw new Error('store closed'); } };
    framework.appendProseDeliveryReceipt(agent, receiptRouting(channelId));
    assert.deepEqual(lines, [`[delivered] plain speech → #upkeep (${channelId})`]);
    assert.deepEqual(logged.splice(0), ['[closed-channel-note] for sol failed: store closed']);
  } finally {
    console.error = consoleError;
  }
});

test("on a server whose grant lacks channels.lifecycle, the note doesn't offer channel_open, which can't open anything there", async () => {
  const { registry, reply, setGrant } = await harness();
  setGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle')), []));
  // The close is the agent's decision on record, though the server can't be told.
  await registry.handleChannelToolCall('channel_close', { channelId }, origin);
  assert.equal(registry.closedByAgent(ref(channelId)), 'closed');
  const { success, data } = await reply();
  assert.equal(success, true);
  assert.ok(data.endsWith(`\n[closed channel] #upkeep (${channelId}) stays closed: you closed it, and your words there don't open it. ` +
    'Messages there that address you, such as an @-mention, still reach you. ' +
    'To stop this note, set closed_channel_note to false with agent_settings.'), data);
});

test("the note offers only what its reader can use: channel_open and agent_settings where its allowedTools hold them, and what still reaches it where those messages land in its window", async () => {
  const { registry, framework, reply } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const head = `[closed channel] #upkeep (${channelId}) stays closed: you closed it, and your words there don't open it.`;
  const reach = ' Messages there that address you, such as an @-mention, still reach you.';
  const open = ` channel_open with channelId "${channelId}" and serverId "discord" opens it.`;
  const off = ' To stop this note, set closed_channel_note to false with agent_settings.';
  const noteOf = async () => {
    const { success, data } = await reply();
    assert.equal(success, true);
    return data.slice(data.indexOf('[closed channel]'));
  };
  assert.equal(await noteOf(), head + reach + open + off);
  // An agent whose allowedTools leave a tool out isn't offered it.
  framework.agents.set('sol', agentStub({ canUseTool: (tool: string) => tool !== 'channel_open' }));
  assert.equal(await noteOf(), head + reach + off);
  framework.agents.set('sol', agentStub({ canUseTool: (tool: string) => tool !== 'agent_settings' }));
  assert.equal(await noteOf(), head + reach + open);
  // An agent whose window isn't where those messages land, as an ephemeral
  // run's is its own, isn't told they reach it: here the delivery agent is
  // another, and sol doesn't read the residents' shared slot.
  framework.agents = new Map([['primary', agentStub()], ['sol', agentStub()]]);
  framework.sharedSlotAgents = new Set();
  assert.equal(await noteOf(), head + open + off);
});

test("a note written while its server reconnects still offers channel_open, which opens the channel once the server is back", async () => {
  const { registry, framework, dropConnection } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  // The turn's speech went out before the drop; its delivery line is written after it.
  dropConnection();
  assert.equal(registry.directsLifecycle('discord'), false, 'the grant is empty until the next exchange');
  const lines: string[] = [];
  const agent = {
    name: 'sol',
    proseRouting: 'locus',
    getContextManager: () => ({
      addMessage: (_role: string, content: Array<{ text: string }>) => { lines.push(content[0]!.text); return 'm'; },
    }),
  };
  framework.appendProseDeliveryReceipt(agent, receiptRouting(channelId));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(` channel_open with channelId "${channelId}" and serverId "discord" opens it.`), lines[0]);
});

test("a send's note goes after the server's own answer, whatever its shape: one more block after an image's, or the note alone where the answer has no words", async () => {
  const { registry, reply, setAnswer } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  setAnswer([{ type: 'text', text: 'posted' }, { type: 'image', data: png, mimeType: 'image/png' }]);
  const withImage = await reply();
  assert.equal(withImage.success, true);
  assert.deepEqual(withImage.raw, [
    { type: 'text', text: 'posted' },
    { type: 'image', data: png, mimeType: 'image/png' },
    { type: 'text', text: UPKEEP_NOTE },
  ]);
  setAnswer([]);
  const empty = await reply();
  assert.equal(empty.success, true);
  assert.equal(empty.raw, UPKEEP_NOTE);
});

test("a closed-channel invitation in a tuned-out channel doesn't offer the decline as a way to reply without opening it, since channel_decline refuses a tuned-out channel", async () => {
  const { registry, framework } = await harness();
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:777888', type: 'discord', label: '#lobby', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '777888' } }],
  } as never);
  const invite = (id: string, label: string): string => framework.buildClosedChannelInvitation({
    serverId: 'discord', channelId: id, channelLabel: label, messageId: 'm7', authorName: 'Ann', tags: ['chat:addressed'],
  })?.block.text ?? '';
  // Tuned out while its transport is closed, as while tune_out's open is out, or after it failed.
  registry.enterTuneOut('discord', channelId, {
    epochId: 'e1', cadenceSeconds: 600, backlogCap: 50, maxWakes: 3, startedAtSequence: 0,
  }, 'agent-tool');
  assert.equal(registry.isChannelOpen(ref(channelId)), false);
  const tunedOut = invite(channelId, '#upkeep');
  assert.ok(tunedOut.includes("1. Reply — your plain speech lands where the latest word on where it lands says: a [routing] notice, "
    + "or channel_open's result. If that is #upkeep (discord:g1:444555), write your reply with no prefix; it will be delivered there. "
    + 'If that is another channel, or you see none, to reply here, check whether discord exposes a send tool that can address it.\n'), tunedOut);
  assert.doesNotMatch(tunedOut, /open it \(option 2\)/);
  assert.doesNotMatch(tunedOut, /decline it first/);
  assert.equal((await registry.handleChannelToolCall('channel_decline', { channelId, messageId: 'm7' }, origin)).success, false,
    'channel_decline refuses it');
  // A closed channel nobody decided about is offered the decline.
  assert.match(invite('discord:g1:777888', '#lobby'),
    /which opens the channel\. To reply without opening it, decline it first \(option 3\): a channel you've declined stays closed when you speak there\. If that is another channel, or you see none/);
});

test("a channel the agent closed whose server refused the close is still open, so a send there carries no note", async () => {
  const { registry, opens, reply, setRefuseCloses } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  setRefuseCloses(true);
  const closed = await registry.handleChannelToolCall('channel_close', { channelId }, origin);
  assert.equal(closed.success, false);
  // The record says the agent closed it; its traffic still flows.
  assert.equal(registry.closedByAgent(ref(channelId)), 'closed');
  assert.equal(registry.isChannelOpen(ref(channelId)), true);
  const opensBefore = opens.length;

  const { success, data } = await reply();
  assert.equal(success, true);
  assert.ok(!data.includes('[closed channel]'), data);
  assert.equal(opens.length, opensBefore, 'an open channel is opened by nothing');
});

test('a send the server refuses carries no closed-channel note', async () => {
  const { registry, reply, setRefuseSends } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  setRefuseSends(true);
  const refused = await reply();
  assert.equal(refused.success, false);
  assert.equal(refused.error, 'Missing Access in channel 444555', "the server's refusal, and nothing about the channel");
});

test('a send the server refuses into a closed channel nobody decided about opens nothing and says nothing about it', async () => {
  const { registry, opens, windowMessages, reply, setRefuseSends } = await harness();
  assert.equal(registry.speechOpens(ref(channelId)), true, 'a reply that went through would open it');
  const before = registry.getDesiredState('discord', channelId);
  setRefuseSends(true);
  const opensBefore = opens.length;
  const refused = await reply();
  assert.equal(refused.success, false);
  assert.equal(refused.error, 'Missing Access in channel 444555');
  assert.equal(opens.length, opensBefore, 'nothing was posted, so nothing opens');
  assert.equal(registry.isChannelOpen(ref(channelId)), false);
  assert.equal(registry.getDesiredState('discord', channelId), before, 'and no intent to open is recorded');
  assert.equal(registry.speechOpens(ref(channelId)), true, 'a later reply would still open it');
  assert.deepEqual(windowMessages, [], 'no notice either');
});

test("a send's note reads the channel on the server the words went to, not one on another server with the same id", async () => {
  const { registry, reply } = await harness({ sharedIdFirst: true });
  // discord2's channel with this id is open.
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId, serverId: 'discord2' }, origin)).success, true);
  assert.equal(registry.isChannelOpen(ref(channelId, 'discord2')), true);
  // On discord, where the reply goes, the agent closed it.
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId, serverId: 'discord' }, origin)).success, true);
  assert.equal(registry.isChannelOpen(ref(channelId)), false);
  const { success, data } = await reply();
  assert.equal(success, true);
  // Two servers register the id, so the agent is shown its server-qualified name.
  assert.ok(data.endsWith(UPKEEP_NOTE.replace(`(${channelId})`, `(discord:${channelId})`)), data);
});

test('a send into an open channel, or into a channel a module closed, carries no closed-channel note', async () => {
  {
    const { registry, reply } = await harness();
    assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
    assert.ok(!(await reply()).data.includes('[closed channel]'), 'open');
  }
  {
    // A module closed it, as connectome-host's mentions mode does through ctx.callTool:
    // the send leaves it closed, and the module's own tool is the way back.
    const { registry, opens, reply } = await harness();
    assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, { kind: 'module' })).success, true);
    const opensBefore = opens.length;
    const { success, data } = await reply();
    assert.equal(success, true);
    assert.ok(!data.includes('[closed channel]'), 'a module\'s close');
    assert.equal(opens.length, opensBefore, 'the send opened nothing');
    assert.equal(registry.isChannelOpen(ref(channelId)), false);
  }
});

test('a send into a closed channel nobody decided about opens it, as channel_open does, and says so', async () => {
  const { registry, opens, windowMessages, reply, setSentTo } = await harness();
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:dm:777', type: 'discord', label: 'Tess', direction: 'bidirectional',
      address: { channelId: '777' }, metadata: { channelType: 'dm' } }],
  } as never);
  // #upkeep, and a DM that woke the agent: both registered closed, by default.
  for (const [raw, id, label] of [['444555', channelId, '#upkeep'], ['777', 'discord:dm:777', 'Tess']] as const) {
    setSentTo(raw);
    const { success, data, engaged } = await reply();
    assert.equal(success, true);
    assert.ok(!data.includes('[closed channel]'), `${id}: no note where the send opens the channel`);
    assert.equal(engaged.at(-1), destinationKey(ref(id)), 'recorded as engaged');
    assert.equal(registry.isChannelOpen(ref(id)), true, `${id} opened`);
    assert.equal(registry.getDesiredState('discord', id), 'open');
    assert.equal(windowMessages.at(-1),
      `[channels] Now open: ${label} (${id}): your own message into the closed channel opened it. ` +
      'What an open channel brings you is up to its server: some send every message in it, and others only ' +
      "what addresses you unless you're subscribed to it; their own tools can change that. " +
      'If you don\'t want it, use channel_close: a channel you close stays closed until you open it with channel_open, ' +
      "and neither speaking there, the subscription policy nor its server's own default opens it again.");
  }
  assert.deepEqual(opens.map((o) => o.channelId), [channelId, 'discord:dm:777']);
});

test("routed speech into a channel the agent closed says so in the turn's delivery line", async () => {
  const { registry, framework } = await harness();
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:777888', type: 'discord', label: '#lobby', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '777888' } }],
  } as never);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const lines: string[] = [];
  const agent = {
    name: 'sol',
    proseRouting: 'auto',
    getContextManager: () => ({
      addMessage: (_role: string, content: Array<{ text: string }>) => { lines.push(content[0]!.text); return 'm'; },
    }),
  };
  const receipt = (...deliveries: string[]) => {
    framework.appendProseDeliveryReceipt(agent, receiptRouting(...deliveries));
    return lines.pop();
  };
  // The same words as a send's note, without its tag.
  const note = UPKEEP_NOTE.slice('[closed channel] '.length);
  assert.equal(receipt(channelId), `[delivered] plain speech → #upkeep (${channelId}) · ${note}`);
  // Two channels the agent closed in one turn: a note for each, and how to stop them once.
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:555666', type: 'discord', label: '#standup', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '555666' } }],
  } as never);
  assert.equal((await registry.handleChannelToolCall(
    'channel_decline', { channelId: 'discord:g1:555666', messageId: 'm1' }, origin)).success, true);
  const stop = 'To stop this note, set closed_channel_note to false with agent_settings.';
  const upkeepNote = note.slice(0, -(stop.length + 1));
  const standupNote = upkeepNote.replaceAll('#upkeep', '#standup').replaceAll(channelId, 'discord:g1:555666')
    .replace('you closed it', 'you declined it');
  assert.equal(receipt(channelId, 'discord:g1:555666'),
    `[delivered] plain speech → #upkeep (${channelId}) · #standup (discord:g1:555666) · ${upkeepNote} ${standupNote} ${stop}`);
  // A closed channel nobody decided about says nothing more: speech opens it.
  assert.equal(receipt('discord:g1:777888'), '[delivered] plain speech → #lobby (discord:g1:777888)');
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

  const { success, engaged } = await reply();

  assert.equal(success, true);
  assert.equal(opens.length, opensBefore, 'the send sent no channels/open');
  assert.equal(registry.isChannelOpen(ref(channelId)), false, 'the channel stays closed');
  assert.equal(registry.getDesiredState('discord', channelId), 'closed', "the agent's close stands");
  assert.deepEqual(windowMessages, [], 'no notice says the channel opened');
  assert.deepEqual(engaged, [destinationKey(ref(channelId))], 'recorded as engaged this turn, though it stays closed');
});

test('a reply_message into a channel decided open whose open failed opens it again, as on main, and the decision stands', async () => {
  const { registry, opens, windowMessages, reply, setRefuseOpens } = await harness();
  // The agent opened it, but the server refused: decided open, transport closed.
  setRefuseOpens(true);
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, false);
  assert.equal(registry.getDesiredState('discord', channelId), 'open');
  assert.equal(registry.isChannelOpen(ref(channelId)), false);
  setRefuseOpens(false);
  const opensBefore = opens.length;

  const { success, data } = await reply();

  assert.equal(success, true);
  assert.ok(!data.includes('[closed channel]'), 'no note: the agent decided this channel open');
  assert.equal(opens.length, opensBefore + 1, 'the send opened it again');
  assert.equal(registry.isChannelOpen(ref(channelId)), true);
  assert.equal(registry.getDesiredState('discord', channelId), 'open');
  assert.deepEqual(windowMessages, [], 'reconfirming a channel already decided open changes no decision, so no notice');
});

test('a send into a tuned-out channel leaves the tune-out in place, and its answer says so', async () => {
  const { registry, framework, opens, windowMessages, reply } = await harness();
  // Tuned out: the transport stays open, and the decision is the tune-out.
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  registry.enterTuneOut('discord', channelId, {
    epochId: 'e1', cadenceSeconds: 600, backlogCap: 50, maxWakes: 3, startedAtSequence: 0,
  }, 'agent-tool');
  const opensBefore = opens.length;
  const tunedOutNote = `[tuned out] #upkeep (${channelId}) stays tuned out: your words there don't end the tune-out, ` +
    'so its traffic still goes to your subconscious until the tune-out ends. ' +
    `Call tune_out with channelId "${channelId}" and mode "cancel" for it to resume normal attention; cancelling ` +
    'delivers the diverted backlog. To stop this note, set closed_channel_note to false with agent_settings.';

  for (const tool of ['reply_message', 'send_dm']) {
    const { success, data } = await reply(tool);
    assert.equal(success, true);
    assert.ok(data.endsWith(`\n${tunedOutNote}`), `${tool}: ${data}`);
  }
  assert.equal(registry.getDesiredState('discord', channelId), 'tuned-out', 'the tune-out stands');
  assert.equal(opens.length, opensBefore, 'the send sent no channels/open');
  assert.deepEqual(windowMessages, [], 'no notice says the channel opened');

  // The setting turns it off too.
  framework.closedChannelNoteSettingsExtension().update('sol', { closed_channel_note: false });
  assert.ok(!(await reply()).data.includes('[tuned out]'));
  framework.closedChannelNoteSettingsExtension().reset('sol');
  // An agent whose allowedTools leave tune_out out isn't told how to call it.
  framework.agents.set('sol', agentStub({ canUseTool: (tool: string) => tool !== 'tune_out' }));
  assert.ok((await reply()).data.endsWith('until the tune-out ends. To stop this note, set closed_channel_note to false with agent_settings.'));
  framework.agents.set('sol', agentStub());
  // A conversation agent gets none.
  framework.registry.homes.set('sol', { serverId: 'discord', channelId });
  assert.ok(!(await reply()).data.includes('[tuned out]'));
});

test("a tuned-out channel whose id another server's channel shares is named for tune_out by its server-qualified name, which picks it alone", async () => {
  const { registry, reply } = await harness({ sharedIdFirst: true });
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId, serverId: 'discord' }, origin)).success, true);
  registry.enterTuneOut('discord', channelId, {
    epochId: 'e1', cadenceSeconds: 600, backlogCap: 50, maxWakes: 3, startedAtSequence: 0,
  }, 'agent-tool');
  const { success, data } = await reply();
  assert.equal(success, true);
  assert.ok(data.includes(`Call tune_out with channelId "discord:${channelId}" and mode "cancel"`), data);
});

test("a code_execution script's send into a channel the agent closed or tuned out keeps the server's receipt, and the agent is told in its window", async () => {
  const { registry, framework, windowMessages, windowFor, reply } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const receipt = { messageId: 'm9', channelId: '444555' };

  // A script parses the receipt, so it's the server's own, as before.
  const scripted = await reply('reply_message', 'pytc-1', true);
  assert.equal(scripted.success, true);
  assert.deepEqual(JSON.parse(scripted.data), receipt);
  const closedBody = UPKEEP_NOTE.slice('[closed channel] '.length);
  assert.deepEqual(windowMessages, [`[closed channel] Your script's reply_message: ${closedBody}`]);
  assert.deepEqual(windowFor, ['sol'], "it's addressed to the agent whose script sent, not to the primary's window by default");
  // The model's own send keeps the note in its answer, and adds nothing to the window.
  assert.ok((await reply()).data.endsWith(`\n${UPKEEP_NOTE}`));
  assert.equal(windowMessages.length, 1);

  // A tune-out's line goes the same way.
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  registry.enterTuneOut('discord', channelId, {
    epochId: 'e1', cadenceSeconds: 600, backlogCap: 50, maxWakes: 3, startedAtSequence: 0,
  }, 'agent-tool');
  windowMessages.length = 0;
  windowFor.length = 0;
  assert.deepEqual(JSON.parse((await reply('send_dm', 'pytc-2', true)).data), receipt);
  assert.equal(windowMessages.length, 1);
  assert.deepEqual(windowFor, ['sol']);
  assert.ok(windowMessages[0]!.startsWith(`[tuned out] Your script's send_dm: #upkeep (${channelId}) stays tuned out: `), windowMessages[0]);
  assert.ok(windowMessages[0]!.endsWith('To stop this note, set closed_channel_note to false with agent_settings.'));

  // A window that can't take the notice leaves the receipt as it was, and the operator's log says why.
  const addMessage = framework.addMessage;
  framework.addMessage = () => { throw new Error('window unavailable'); };
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[closed-channel-note]')) logged.push(line);
  };
  try {
    const sent = await reply('send_dm', 'pytc-3', true);
    assert.equal(sent.success, true);
    assert.deepEqual(JSON.parse(sent.data), receipt);
    assert.deepEqual(logged, ["[closed-channel-note] for sol's script failed: window unavailable"]);
  } finally {
    console.error = consoleError;
    framework.addMessage = addMessage;
  }

  // The setting turns the notice off too.
  framework.closedChannelNoteSettingsExtension().update('sol', { closed_channel_note: false });
  windowMessages.length = 0;
  assert.deepEqual(JSON.parse((await reply('reply_message', 'pytc-4', true)).data), receipt);
  assert.deepEqual(windowMessages, []);
});

test('a reply_message still in flight when the agent closes its channel leaves it closed', async () => {
  const { registry, opens, reply, setHold, sendReached } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  let release!: () => void;
  setHold(new Promise<void>((resolve) => { release = resolve; }));
  const opensBefore = opens.length;
  const replying = reply();
  // The reply is at the server, waiting for its answer, when the same round
  // closes the channel.
  await sendReached();
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  release();
  const { success, data } = await replying;
  assert.equal(success, true);
  assert.equal(registry.isChannelOpen(ref(channelId)), false, 'the close, made while the reply was in flight, stands');
  assert.equal(opens.length, opensBefore, 'the send opened nothing');
  assert.ok(data.endsWith(UPKEEP_NOTE), 'and its answer says the channel stays closed');
});

test("closed_channel_note is an agent_settings key, kept in the framework's state beside the others across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-closed-channel-note-'));
  const config = () => ({
    storePath: join(dir, 'store'),
    membrane: {} as never,
    agents: [{ name: 'sol', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  /** One agent_settings call, as the agent makes it, and its result. */
  const settings = (fw: AgentFramework, input: Record<string, unknown>) => {
    const internals = fw as unknown as {
      pushEvent(event: unknown): void;
      dispatchAgentSettingsToolCall(agentName: string, call: unknown): void;
    };
    const pushEvent = internals.pushEvent;
    let result: { success: boolean; data?: Record<string, unknown>; error?: string } | undefined;
    internals.pushEvent = (event: { type: string; result: typeof result }) => { if (event.type === 'tool-result') result = event.result; };
    try {
      internals.dispatchAgentSettingsToolCall('sol', { id: 'call-settings', name: 'agent_settings', input });
    } finally {
      internals.pushEvent = pushEvent;
    }
    assert.ok(result, 'agent_settings answered');
    return result;
  };
  let framework = await AgentFramework.create(config());
  try {
    const tool = framework.getAllTools().find((t) => t.name === 'agent_settings')!;
    const property = (tool.inputSchema.properties as Record<string, { type: string; description: string }>).closed_channel_note;
    assert.equal(property.type, 'boolean');
    assert.match(property.description, /a channel you closed or declined, or a send tool's words to one you tuned out/);
    assert.equal(settings(framework, { action: 'get' }).data?.closed_channel_note, true, 'on by default');

    // Another framework-owned setting, kept in the same state.
    assert.equal(settings(framework, { action: 'update', tool_result_guard: true }).data?.tool_result_guard, true);
    const off = settings(framework, { action: 'update', closed_channel_note: false });
    assert.equal(off.data?.closed_channel_note, false);
    assert.equal(off.data?.tool_result_guard, true, "turning the note off leaves the other setting's value");
    assert.match(String(settings(framework, { action: 'update', closed_channel_note: 'no' }).error), /closed_channel_note must be true or false, not "no"/);

    await framework.stop();
    framework = await AgentFramework.create(config());
    const after = settings(framework, { action: 'get' });
    assert.equal(after.data?.closed_channel_note, false, 'still off after a restart');
    assert.equal(after.data?.tool_result_guard, true, 'and the other setting with it');

    const reset = settings(framework, { action: 'reset', settings: ['closed_channel_note'] });
    assert.equal(reset.data?.closed_channel_note, true);
    assert.equal(reset.data?.tool_result_guard, true, 'a reset of the note resets nothing else');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sleep announced into a channel the agent or a module closed says the agent will still see messages addressed to it; elsewhere the post opens the channel as speech does, and says it will still see messages", async () => {
  const { registry, framework, published, opens, setRefuseCloses, setGrant } = await harness();
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:777888', type: 'discord', label: '#lobby', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '777888' } }],
  } as never);
  framework.eventGate = { setSleep: (seconds: number) => ({ until: Date.parse('2026-10-16T04:00:00Z') + seconds * 1000 }) };
  framework.activeTurnTriggers = new Map();
  framework.timeZone = 'UTC';
  const routing = framework.turnRouting.get('sol');
  // Where each announcement was routed, and its post, which the sleep doesn't wait for.
  const routedTo: Array<{ serverId: string; channelId: string } | null> = [];
  const posts: Promise<unknown>[] = [];
  const route = registry.routeSpeech.bind(registry);
  registry.routeSpeech = ((...args: Parameters<typeof route>) => {
    routedTo.push(args[2] as { serverId: string; channelId: string } | null);
    const post = route(...args);
    posts.push(post);
    return post;
  }) as typeof route;
  /** One sleep call, as the agent makes it; its result once the post it started has run. */
  const sleep = async (input: Record<string, unknown>) => {
    const result = await new Promise<{ success: boolean; data: Record<string, unknown>; endTurn?: boolean }>((resolve) => {
      framework.pushEvent = (event: { type: string; callId?: string; result: never }) => {
        if (event.type === 'tool-result' && event.callId === 'call-sleep') resolve(event.result);
      };
      framework.dispatchSleepToolCall('sol', { id: 'call-sleep', name: 'sleep', callerTurnId: 't1', input });
    });
    await Promise.allSettled(posts.splice(0));
    return result;
  };
  const quiet = "💤 Going quiet for 10m. I'll still see messages, but won't respond until I wake.";
  const addressed = "💤 Going quiet for 10m. I'll still see messages addressed to me, but won't respond until I wake.";

  // The turn's locus is #upkeep, which the agent closed.
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  routing.locus = ref(channelId);
  let slept = await sleep({ seconds: 600 });
  assert.equal(slept.success, true);
  assert.equal(slept.endTurn, true);
  assert.deepEqual(Object.keys(slept.data).sort(), ['sleepingFor', 'timeZone', 'until', 'untilLocal'], 'the sleep result carries no note');
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
  assert.equal(registry.isChannelOpen(ref(channelId)), false, 'it stays closed');

  // The agent's own words are posted as they are.
  slept = await sleep({ seconds: 600, message: 'back soon' });
  assert.deepEqual(published.splice(0), [{ channelId, text: 'back soon' }]);

  // With the note turned off, the announcement still says what reaches the agent.
  framework.closedChannelNoteSettingsExtension().update('sol', { closed_channel_note: false });
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
  framework.closedChannelNoteSettingsExtension().reset('sol');

  // When who closed the channel can't be read, the words are ones true either way.
  const speechLeavesClosed = registry.speechLeavesClosed.bind(registry);
  registry.speechLeavesClosed = () => { throw new Error('the registry is unreadable'); };
  slept = await sleep({ seconds: 600 });
  registry.speechLeavesClosed = speechLeavesClosed;
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);

  // A channel a module closed stays closed too, as connectome-host's mentions mode keeps it.
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:121212', type: 'discord', label: '#mentions-only', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '121212' } }],
  } as never);
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'discord:g1:121212' }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'discord:g1:121212' }, { kind: 'module' })).success, true);
  routing.locus = ref('discord:g1:121212');
  const opensBeforeModule = opens.length;
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId: 'discord:g1:121212', text: addressed }]);
  assert.equal(opens.length, opensBeforeModule, 'the post opened nothing');
  assert.equal(registry.isChannelOpen(ref('discord:g1:121212')), false);

  // A channel the agent closed whose server refused the close is still open, so all of it still reaches the agent.
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:343434', type: 'discord', label: '#refused', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '343434' } }],
  } as never);
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'discord:g1:343434' }, origin)).success, true);
  setRefuseCloses(true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'discord:g1:343434' }, origin)).success, false);
  setRefuseCloses(false);
  assert.equal(registry.closedByAgent(ref('discord:g1:343434')), 'closed', 'the close is on record');
  assert.equal(registry.isChannelOpen(ref('discord:g1:343434')), true, 'and the channel is still open');
  routing.locus = ref('discord:g1:343434');
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId: 'discord:g1:343434', text: quiet }]);
  routing.locus = ref(channelId);

  // A conversation agent announces nothing: its sleep is refused before the
  // announcement (dispatchSleepToolCall; event-gate-sleep.test.ts).

  // Hybrid routing announces to the locus as locus mode does.
  framework.agents.set('sol', agentStub({ proseRouting: 'hybrid' }));
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
  framework.agents.set('sol', agentStub());

  // A closed channel nobody decided about: the announcement opens it, as speech does, so all of it reaches the agent.
  routing.locus = ref('discord:g1:777888');
  const opensBefore = opens.length;
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId: 'discord:g1:777888', text: quiet }]);
  assert.deepEqual(opens.slice(opensBefore).map((o) => o.channelId), ['discord:g1:777888']);
  assert.equal(registry.isChannelOpen(ref('discord:g1:777888')), true);
  // And an open one.
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId: 'discord:g1:777888', text: quiet }]);
  routedTo.splice(0);

  // A locus the registry doesn't know: the post fails, as before.
  routing.locus = ref('discord:g1:999999');
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(routedTo.splice(0), [ref('discord:g1:999999')]);
  assert.deepEqual(published.splice(0), [], 'nothing reached a channel');
  // No locus at all: routed as before, with nothing to post to.
  routing.locus = null;
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(routedTo.splice(0), [null]);
  assert.deepEqual(published.splice(0), []);
  routing.locus = ref(channelId);

  // Prose routing off, a silent turn, or no announcement: nothing is routed.
  framework.agents.set('sol', agentStub({ proseRouting: 'disabled' }));
  slept = await sleep({ seconds: 600 });
  framework.agents.set('sol', agentStub());
  framework.activeTurnTriggers.set('sol', { suppressProse: true });
  slept = await sleep({ seconds: 600 });
  framework.activeTurnTriggers.delete('sol');
  slept = await sleep({ seconds: 600, announce: false });
  assert.deepEqual(routedTo.splice(0), [], 'nothing was routed');

  // Explicit mode announces only to the turn's target: none routes nothing.
  framework.agents.set('sol', agentStub({ proseRouting: 'explicit' }));
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(routedTo.splice(0), [], 'nothing was routed');
  assert.deepEqual(published, [], 'nothing was posted');
  routing.pin = ref(channelId);
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
  routing.pin = undefined;
  framework.agents.set('sol', agentStub());

  // On a server that's up without channels.lifecycle, speech opens nothing,
  // so a closed channel there stays closed, and the words say what reaches
  // the agent from a closed channel.
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:565656', type: 'discord', label: '#ungranted', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '565656' } }],
  } as never);
  setGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle')), []));
  routing.locus = ref('discord:g1:565656');
  const opensBeforeUngranted = opens.length;
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId: 'discord:g1:565656', text: addressed }]);
  assert.equal(opens.length, opensBeforeUngranted, 'the post opened nothing');
});

test('a conversation agent gets no note on its send: channel_open is refused to it', async () => {
  const { registry, framework, reply, windowMessages } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  framework.registry.homes.set('sol', { serverId: 'discord', channelId });
  const { success, data } = await reply();
  assert.equal(success, true);
  assert.ok(!data.includes('[closed channel]'), data);
  assert.deepEqual(windowMessages.filter((m) => m.startsWith('[closed channel]')), []);
});

test("channel_publish never opened a channel, so its answer carries no note", async () => {
  const { registry, framework, published, windowMessages } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  const result = await new Promise<{ success: boolean; data?: unknown }>((resolve) => {
    framework.pushEvent = (event: { type: string; callId?: string; result: { success: boolean; data?: unknown } }) => {
      if (event.type === 'tool-result' && event.callId === 'call-publish') resolve(event.result);
    };
    framework.dispatchChannelToolCall('sol', { id: 'call-publish', name: 'channel_publish', input: { channelId, content: 'a word to #upkeep' } });
  });
  assert.equal(result.success, true);
  assert.deepEqual(published, [{ channelId, text: 'a word to #upkeep' }]);
  assert.ok(!JSON.stringify(result.data ?? '').includes('[closed channel]'));
  assert.deepEqual(windowMessages.filter((m) => m.startsWith('[closed channel]')), []);
});
