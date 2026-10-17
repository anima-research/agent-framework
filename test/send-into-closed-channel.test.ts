/**
 * Speaking never undoes the agent's own decision to keep a channel closed: an
 * explicit send tool's successful call posts (the server sends it), and opens
 * a closed channel, as channel_open does, only where nobody decided to keep it
 * closed. A channel the agent closed or declined stays closed, a channel whose
 * open failed isn't opened again, and a tuned-out channel stays tuned out.
 * The call records the channel as engaged this turn, by its descriptor id,
 * for the mid-turn re-pin. Where the words land in a channel the agent closed
 * or declined itself, the send's answer, or the turn's delivery line for
 * routed speech, says the channel stays closed, what still reaches the agent
 * from it, and how to open it, until the agent turns that note off with
 * agent_settings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const channelId = 'discord:g1:444555';
const origin = { kind: 'agent' as const, agentName: 'sol' };

/** The note a send's answer carries when it lands in #upkeep, which the agent closed. */
const UPKEEP_NOTE = `[closed channel] #upkeep (${channelId}) stays closed: you closed it, and your words there don't open it. ` +
  'Messages there that address you, such as an @-mention, still reach you; ' +
  `channel_open with channelId "${channelId}" and serverId "discord" opens it. ` +
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
  // While set, the server refuses the send, as discord-mcpl does without Send Messages.
  let refuseSends = false;
  const published: Array<{ channelId: string; text: string }> = [];
  const server = {
    id: 'discord',
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    async sendToolsCall() {
      if (hold) await hold;
      if (refuseSends) {
        return { content: [{ type: 'text', text: `Missing Access in channel ${sentTo}` }], isError: true };
      }
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
    // What routed speech, such as a sleep announcement, posts.
    async sendChannelsPublish(params: { channelId: string; content: Array<{ text: string }> }) {
      published.push({ channelId: params.channelId, text: params.content[0]!.text });
      return { delivered: true };
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
  // Conversation agents by their home channel; sol isn't one.
  framework.conversationAgentHomes = new Map();
  const windowMessages: string[] = [];
  framework.addMessage = (_role: string, content: Array<{ text?: string }>) => {
    windowMessages.push(content.map((b) => b.text ?? '').join(''));
    return 'msg';
  };

  /** Dispatch reply_message by the raw id; resolve with its result and the
   *  turn's engaged channels as they stood when the result was queued (the
   *  mid-turn re-pin reads them when that event is processed). */
  async function reply(tool = 'reply_message'): Promise<{ success: boolean; engagedAtResult: string[]; data: string; error: string }> {
    const out = await new Promise<{ success: boolean; engagedAtResult: string[]; data: string; error: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the tool result')), 1000);
      framework.pushEvent = (event: { type: string; callId?: string; result: { success: boolean; data?: unknown; error?: string } }) => {
        if (event.type === 'tool-result' && event.callId === 'call-reply') {
          clearTimeout(timeout);
          resolve({
            success: event.result.success,
            engagedAtResult: [...(framework.turnRouting.get('sol')?.engaged ?? [])],
            data: String(event.result.data ?? ''),
            error: String(event.result.error ?? ''),
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
    registry, framework, opens, windowMessages, reply, published,
    setRefuseOpens: (v: boolean) => { refuseOpens = v; },
    setHold: (p: Promise<void> | null) => { hold = p; },
    setSentTo: (raw: string) => { sentTo = raw; },
    setRefuseSends: (v: boolean) => { refuseSends = v; },
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
    framework.appendProseDeliveryReceipt(agent, { deliveries: [channelId], suppressed: 0 });
    assert.deepEqual(lines, [`[delivered] plain speech → #upkeep (${channelId})`]);
    assert.deepEqual(logged.splice(0), ['[closed-channel-note] for sol failed: store closed']);
  } finally {
    console.error = consoleError;
  }
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

test('a send into an open channel, or by send_dm, carries no closed-channel note', async () => {
  {
    const { registry, reply } = await harness();
    assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
    assert.ok(!(await reply()).data.includes('[closed channel]'), 'open');
  }
  {
    // send_dm sends to a DM by what the tool is, so its answer carries no
    // note even into #upkeep, which the agent closed.
    const { registry, reply } = await harness();
    assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
    assert.ok(!(await reply('send_dm')).data.includes('[closed channel]'), 'send_dm');
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
    const { success, data, engagedAtResult } = await reply();
    assert.equal(success, true);
    assert.ok(!data.includes('[closed channel]'), `${id}: no note where the send opens the channel`);
    assert.equal(engagedAtResult.at(-1), id, 'recorded as engaged');
    assert.equal(registry.isChannelOpen(id), true, `${id} opened`);
    assert.equal(registry.getDesiredState('discord', id), 'open');
    assert.equal(windowMessages.at(-1),
      `[channels] Now open: ${label} (${id}) — your own message into the closed channel engaged it. ` +
      'Ongoing traffic from this channel will reach you. If you don\'t want it, use channel_close: a channel you close ' +
      'stays closed until you open it with channel_open, and neither speaking there nor policy reopens it.');
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
    framework.appendProseDeliveryReceipt(agent, { deliveries, suppressed: 0 });
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

test('a reply_message still in flight when the agent closes its channel leaves it closed', async () => {
  const { registry, opens, reply, setHold } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId }, origin)).success, true);
  let release!: () => void;
  setHold(new Promise<void>((resolve) => { release = resolve; }));
  const replying = reply();
  // The same round closes the channel while the reply is in flight.
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  release();
  const opensBefore = opens.length;
  const { success, data } = await replying;
  assert.equal(success, true);
  assert.equal(registry.isChannelOpen(channelId), false, 'the close, made while the reply was in flight, stands');
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
    assert.match(property.description, /a channel you closed or declined/);
    assert.equal(settings(framework, { action: 'get' }).data?.closed_channel_note, true, 'on by default');

    // Another framework-owned setting, kept in the same state.
    assert.equal(settings(framework, { action: 'update', tool_result_guard: true }).data?.tool_result_guard, true);
    const off = settings(framework, { action: 'update', closed_channel_note: false });
    assert.equal(off.data?.closed_channel_note, false);
    assert.equal(off.data?.tool_result_guard, true, "turning the note off leaves the other setting's value");
    assert.match(String(settings(framework, { action: 'update', closed_channel_note: 'no' }).error), /closed_channel_note must be a boolean/);

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

test("a sleep announced into a channel the agent closed says only what addresses it reaches it; anywhere else it opens as speech does", async () => {
  const { registry, framework, published, opens } = await harness();
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g1:777888', type: 'discord', label: '#lobby', direction: 'bidirectional',
      address: { guildId: 'g1', channelId: '777888' } }],
  } as never);
  framework.eventGate = { setSleep: (seconds: number) => ({ until: Date.parse('2026-10-16T04:00:00Z') + seconds * 1000 }) };
  framework.activeTurnTriggers = new Map();
  framework.timeZone = 'UTC';
  const routing = framework.turnRouting.get('sol');
  // Where each announcement was routed, and its post, which the sleep doesn't wait for.
  const routedTo: Array<string | null> = [];
  const posts: Promise<unknown>[] = [];
  const route = registry.routeSpeech.bind(registry);
  registry.routeSpeech = ((...args: Parameters<typeof route>) => {
    routedTo.push(args[2] as string | null);
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
      framework.dispatchSleepToolCall('sol', { id: 'call-sleep', name: 'sleep', input });
    });
    await Promise.allSettled(posts.splice(0));
    return result;
  };
  const quiet = "💤 Going quiet for 10m. I'll still see messages, but won't respond until I wake.";
  const addressed = "💤 Going quiet for 10m. I'll still see messages addressed to me, but won't respond until I wake.";

  // The turn's locus is #upkeep, which the agent closed.
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  routing.locus = channelId;
  let slept = await sleep({ seconds: 600 });
  assert.equal(slept.success, true);
  assert.equal(slept.endTurn, true);
  assert.equal(slept.data.closedChannelNote, undefined, 'the sleep result carries no note');
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
  assert.equal(registry.isChannelOpen(channelId), false, 'it stays closed');

  // The agent's own words are posted as they are.
  slept = await sleep({ seconds: 600, message: 'back soon' });
  assert.deepEqual(published.splice(0), [{ channelId, text: 'back soon' }]);

  // With the note turned off, the announcement still says what reaches the agent.
  framework.closedChannelNoteSettingsExtension().update('sol', { closed_channel_note: false });
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
  framework.closedChannelNoteSettingsExtension().reset('sol');

  // When who closed the channel can't be read, the words are ones true either way.
  const closedByAgent = registry.closedByAgent.bind(registry);
  registry.closedByAgent = () => { throw new Error('the registry is unreadable'); };
  slept = await sleep({ seconds: 600 });
  registry.closedByAgent = closedByAgent;
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);

  // A conversation agent's announcement reads the same: the words follow the channel.
  framework.conversationAgentHomes.set('sol', channelId);
  slept = await sleep({ seconds: 600 });
  framework.conversationAgentHomes.delete('sol');
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);

  // Hybrid routing announces to the locus as locus mode does.
  framework.agents.set('sol', { proseRouting: 'hybrid' });
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
  framework.agents.set('sol', {});

  // A closed channel nobody decided about: the announcement opens it, as speech does, so all of it reaches the agent.
  routing.locus = 'discord:g1:777888';
  const opensBefore = opens.length;
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId: 'discord:g1:777888', text: quiet }]);
  assert.deepEqual(opens.slice(opensBefore).map((o) => o.channelId), ['discord:g1:777888']);
  assert.equal(registry.isChannelOpen('discord:g1:777888'), true);
  // And an open one.
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId: 'discord:g1:777888', text: quiet }]);
  routedTo.splice(0);

  // A locus the registry doesn't know: the post fails, as before.
  routing.locus = 'discord:g1:999999';
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(routedTo.splice(0), ['discord:g1:999999']);
  assert.deepEqual(published.splice(0), [], 'nothing reached a channel');
  // No locus at all: routed as before, with nothing to post to.
  routing.locus = null;
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(routedTo.splice(0), [null]);
  assert.deepEqual(published.splice(0), []);
  routing.locus = channelId;

  // Prose routing off, a silent turn, or no announcement: nothing is routed.
  framework.agents.set('sol', { proseRouting: 'disabled' });
  slept = await sleep({ seconds: 600 });
  framework.agents.set('sol', {});
  framework.activeTurnTriggers.set('sol', { suppressProse: true });
  slept = await sleep({ seconds: 600 });
  framework.activeTurnTriggers.delete('sol');
  slept = await sleep({ seconds: 600, announce: false });
  assert.deepEqual(routedTo.splice(0), [], 'nothing was routed');

  // Explicit mode announces only to the turn's target: none, or an empty one, routes nothing.
  framework.agents.set('sol', { proseRouting: 'explicit' });
  slept = await sleep({ seconds: 600 });
  routing.pin = '';
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(routedTo.splice(0), [], 'nothing was routed');
  assert.deepEqual(published, [], 'nothing was posted');
  routing.pin = channelId;
  slept = await sleep({ seconds: 600 });
  assert.deepEqual(published.splice(0), [{ channelId, text: addressed }]);
});

test('a conversation agent gets no note on its send: channel_open is refused to it', async () => {
  const { registry, framework, reply, windowMessages } = await harness();
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, origin)).success, true);
  framework.conversationAgentHomes.set('sol', channelId);
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
