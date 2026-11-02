/**
 * What the tune-out coordinator tells the agent, and the subconscious, when it
 * refuses: that nothing changed, why, and what to do instead. A channel that's
 * already tuned out gives its settings and how to change them; a cancel of one
 * that isn't names the connected ones that are, and the backlog's reader as
 * its caller knows the resident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

const SETTINGS = { epochId: 'e1', cadenceSeconds: 300, backlogCap: 50, maxWakes: 3, startedAtSequence: 0 };

/** The hooks the refusals read: a subconscious unless it's left out, a fork binding, and channel speech off. */
function hooks(opts: { subconscious?: boolean; forkBound?: boolean }) {
  return {
    subconsciousName: () => (opts.subconscious === false ? undefined : 'Subconscious'),
    primaryName: () => 'scout',
    isForkBound: () => opts.forkBound ?? false,
    allowChannelSpeech: () => false,
  };
}

/** A coordinator over registered tuned-out channels, or none, for the refusals that need no live channel. */
function coordinator(opts: { tunedOut?: Array<{ channelId: string; expiresAtMs?: number }>; subconscious?: boolean; forkBound?: boolean }) {
  const tunedOut = opts.tunedOut ?? [];
  const registry = {
    // Each channel's id is unique here, so it's shown by its id, and names
    // the one channel with it.
    nameShown: (channel: { channelId: string }) => channel.channelId,
    quotedShown: (channel: { channelId: string }) => JSON.stringify(channel.channelId),
    channelsNamed: (name: string) => tunedOut.filter((t) => t.channelId === name).map((t) => ({ serverId: 'disc', channelId: t.channelId })),
    sharedNameRefusalFor: () => undefined,
    // No call here is made inside a turn, so none has own channels.
    ownChannelFor: () => undefined,
    listChannelsRaw: () => tunedOut.map((t) => ({ serverId: 'disc', descriptor: { id: t.channelId } })),
    getTuneOutState: (_server: string, channelId: string) => {
      const found = tunedOut.find((t) => t.channelId === channelId);
      return found ? { params: { ...SETTINGS, expiresAtMs: found.expiresAtMs } } : null;
    },
    readCoordinatorState: () => null,
    cancelTuneOut: () => null,
  };
  return new TuneOutCoordinator(registry as never, {} as never, hooks(opts) as never);
}

function refusalOf(result: { ok: boolean; error?: string }): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.error ?? '';
}

function assertSettingsAndChange(error: string): void {
  assert.match(error, /cadenceSeconds 300, backlogCap 50 and maxWakes 3/);
  assert.match(error, /cancel it first with tune_out mode "cancel"/);
  assert.match(error, /then call tune_out again with the new settings/);
}

function assertEndsByItself(error: string, reader: string): void {
  assert.match(error, /ends by itself when its duration runs out, or at the first wake past its wake budget/);
  assert.ok(error.endsWith(`its backlog goes to ${reader} then.`), error);
}

function assertBothNamed(error: string, notDone: string): void {
  assert.match(error, /"general"/);
  assert.match(error, /\("a:general", "b:general"\)/);
  assert.ok(error.includes(notDone), error);
  assert.match(error, /Call again with channelId set to one of them/);
}

function assertWithdrawn(error: string, notDone: string): void {
  assert.match(error, /^"general" is this turn's channel on server "b", which no longer registers it/);
  assert.ok(error.includes(notDone), error);
  assert.match(error, /until that server registers it again\.$/);
}

test('tune_out and cancel_tuneout say why nothing changed, and name the connected channels that are tuned out', async () => {
  // No reader, and no hold without one: tune_out says so, with no word of a
  // subconscious.
  const unavailable = refusalOf(coordinator({ subconscious: false }).enter('disc', 'disc:guild:noisy', {}, 'agent-tool'));
  assert.equal(unavailable, "Nothing was tuned out: no reader is configured here to read a held channel, and this host "
    + "doesn't hold one without a reader, so tune_out isn't available here, and calling it again won't change that. If "
    + 'you need channels diverted, ask whoever runs this host.');
  // And a deliver_summary with no reader to deliver it from says that.
  assert.deepEqual(await coordinator({ subconscious: false }).handleSubconsciousTool('deliver_summary', { text: 'All quiet.', channelId: 'disc:guild:noisy' }),
    { success: false, error: 'Nothing was delivered: no reader is configured here.', isError: true });
  const bound = refusalOf(coordinator({ forkBound: true }).enter('disc', 'disc:guild:noisy', {}, 'agent-tool'));
  assert.match(bound, /^Nothing changed: a conversation is bound to "disc:guild:noisy"/);
  assert.match(bound, /tune_out won't divert a channel while one is/);
  assert.match(bound, /again won't change that until the conversation ends/);
  assert.match(bound, /Tune out a different channel/);
  const expiring = coordinator({ tunedOut: [{ channelId: 'disc:guild:noisy', expiresAtMs: Date.UTC(2026, 9, 15, 6, 30, 0, 123) }] });
  const already = refusalOf(expiring.enter('disc', 'disc:guild:noisy', {}, 'agent-tool'));
  assert.match(already, /^Nothing changed: "disc:guild:noisy" is already tuned out/);
  assertSettingsAndChange(already);
  assert.match(already, /until 2026-10-15T06:30:00/);

  const busy = coordinator({ tunedOut: [{ channelId: 'disc:guild:noisy' }, { channelId: 'disc:guild:busy' }] });
  const toResident = refusalOf(busy.cancel('disc', 'disc:guild:quiet', 'agent-tool', 'agent request'));
  const toSubconscious = await busy.handleSubconsciousTool('cancel_tuneout', { channelId: 'disc:guild:quiet' });
  assert.deepEqual([toSubconscious.success, toSubconscious.isError], [false, true]);
  for (const [error, reader] of [[toResident, 'you'], [toSubconscious.error ?? '', 'the resident']] as const) {
    assert.match(error, /^Nothing was cancelled: /);
    assert.match(error, /"disc:guild:noisy", "disc:guild:busy"/, 'the connected channels that are tuned out');
    assertEndsByItself(error, reader);
  }
});

test('a tune-out with no end, or one past what a date can hold, is described without one', () => {
  for (const expiresAtMs of [undefined, 8.64e15 + 1]) {
    const busy = coordinator({ tunedOut: [{ channelId: 'disc:guild:noisy', ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) }] });
    const settled = refusalOf(busy.enter('disc', 'disc:guild:noisy', {}, 'agent-tool'));
    assert.match(settled, /^Nothing changed: "disc:guild:noisy" is already tuned out/, String(expiresAtMs));
    assertSettingsAndChange(settled);
    assert.doesNotMatch(settled, /\buntil\b/, String(expiresAtMs));
  }
});

test("a cancel_tuneout of a channel whose server was removed claims nothing about that channel's tune-out", async () => {
  // Removing a server drops its channels and keeps their tune-outs, so the lookup can't find this one.
  const registry = new ChannelRegistry({ getServer: () => null } as never, {} as never, () => {}, () => {});
  await registry.handleRegister('disc', {
    channels: [{ id: 'disc:guild:noisy', type: 'discord', label: '#noisy', direction: 'bidirectional' }],
  });
  registry.enterTuneOut('disc', 'disc:guild:noisy', SETTINGS, 'agent-tool');
  registry.removeServer('disc');
  assert.ok(registry.getTuneOutState('disc', 'disc:guild:noisy'), 'the tune-out outlives its server');
  const overRegistry = new TuneOutCoordinator(registry, {} as never, hooks({}) as never);
  const refused = await overRegistry.handleSubconsciousTool('cancel_tuneout', { channelId: 'disc:guild:noisy' });
  assert.deepEqual([refused.success, refused.isError], [false, true]);
  const error = refused.error ?? '';
  assert.match(error, /^Nothing was cancelled: no connected channel is tuned out now\./);
  assert.doesNotMatch(error, /"/, 'it names no channel');
  assertEndsByItself(error, 'the resident');
});

test("two servers' tune-outs of one channel id are named apart, and cancel_tuneout takes the qualified name", async () => {
  // A channel id is unique only within one server's connection, so `a` and `b` can each register `general`.
  const registry = new ChannelRegistry({ getServer: () => null } as never, {} as never, () => {}, () => {});
  for (const serverId of ['a', 'b']) {
    await registry.handleRegister(serverId, {
      channels: [{ id: 'general', type: 'chat', label: '#general', direction: 'bidirectional' }],
    });
    registry.enterTuneOut(serverId, 'general', SETTINGS, 'agent-tool');
  }
  const added: Array<{ text: string; metadata?: Record<string, unknown> }> = [];
  const wakes: string[] = [];
  const coordinator = new TuneOutCoordinator(registry, {} as never, {
    ...hooks({}),
    addMessage: (_participant: string, content: Array<{ type: string; text?: string }>, metadata?: Record<string, unknown>) => {
      added.push({ text: content.map((c) => c.text ?? '').join(''), metadata });
    },
    requestInference: (agentName: string, reason: string) => { wakes.push(`${agentName}: ${reason}`); },
    primaryName: () => 'scout',
    getStoredMessages: () => [],
    emitTrace: () => {},
  } as never);
  const already = coordinator.enter('b', 'general', {}, 'agent-tool');
  assert.ok(!already.ok && already.error.startsWith('Nothing changed: "b:general" is already tuned out'), JSON.stringify(already));
  // The registry's rule: a name both servers' channels answer to is refused.
  const shared = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'general' });
  assert.deepEqual([shared.success, shared.isError], [false, true]);
  assertBothNamed(shared.error ?? '', 'nothing ran');
  assert.deepEqual(await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'b:general', text: 'quiet now' }),
    { success: true, data: { cancelled: true } });
  assert.ok(!registry.getTuneOutState('b', 'general'), "b's tune-out ended");
  assert.ok(registry.getTuneOutState('a', 'general'), "a's goes on");
  // What the resident and the subconscious are told names b's channel apart.
  const cancelNotice = added.find((m) => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(cancelNotice?.text.includes('[Tune-out: b:general cancelled'), JSON.stringify(added));
  assert.ok(!added.some((m) => /Tune-out: general\b/.test(m.text)), 'no notice names the bare shared id');
  // The resident's cancel of a's, and a cadence turn on it, wake the
  // subconscious with reasons that name a's channel apart.
  wakes.length = 0;
  assert.deepEqual(coordinator.cancel('a', 'general', 'agent-tool', 'agent request'), { ok: true });
  (coordinator as unknown as { invokeSubconscious(s: string, c: string, t: 'cadence', n: number): void })
    .invokeSubconscious('a', 'general', 'cadence', 2);
  const subconsciousWakes = wakes.filter((w) => w.startsWith('Subconscious:'));
  assert.equal(subconsciousWakes.length, 2, JSON.stringify(wakes));
  for (const reason of subconsciousWakes) assert.match(reason, /\ba:general$/);
  // The subconscious's own words carry the channel's server, which the
  // framework reads on a conversational row (repinChannel).
  const note = added.find((m) => m.metadata?.kind === 'subconscious-note');
  assert.deepEqual([note?.metadata?.channelId, note?.metadata?.serverId], ['general', 'b']);
  await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'b:general', text: 'all quiet on b' });
  const which = await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'general', text: 'which general?' });
  assert.deepEqual([which.success, which.isError], [false, true]);
  assertBothNamed(which.error ?? '', 'nothing was delivered');
  await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'nowhere', text: 'about a channel nobody registers' });
  const summaries = added.filter((m) => m.metadata?.kind === 'subconscious-summary').map((m) => [m.metadata?.channelId, m.metadata?.serverId]);
  assert.deepEqual(summaries, [['general', 'b'], ['nowhere', undefined]],
    'a shared name is refused with its channels, and a name no channel answers to is kept as given, with no server');
});

test("cancel_tuneout inside the subconscious's turn reads the id of the turn's own channel as that channel, and refuses it once its server withdrew it", async () => {
  const registry = new ChannelRegistry({ getServer: () => null } as never, {} as never, () => {}, () => {});
  for (const serverId of ['a', 'b']) {
    await registry.handleRegister(serverId, {
      channels: [{ id: 'general', type: 'chat', label: '#general', direction: 'bidirectional' }],
    });
  }
  registry.enterTuneOut('a', 'general', SETTINGS, 'agent-tool');
  registry.enterTuneOut('b', 'general', SETTINGS, 'agent-tool');
  const coordinator = new TuneOutCoordinator(registry, {} as never, {
    ...hooks({}),
    addMessage: () => {},
    requestInference: () => {},
    getStoredMessages: () => [],
    emitTrace: () => {},
  } as never);
  const own = [{ serverId: 'b', channelId: 'general' }];
  assert.deepEqual(await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'general' }, own), { success: true, data: { cancelled: true } });
  assert.ok(!registry.getTuneOutState('b', 'general'), "the turn's own channel's tune-out ended, not a shared-id refusal");
  assert.ok(registry.getTuneOutState('a', 'general'), "a's goes on");
  await registry.handleChanged('b', { removed: ['general'] });
  const gone = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'general' }, own);
  assert.deepEqual([gone.success, gone.isError], [false, true]);
  assertWithdrawn(gone.error ?? '', 'nothing ran');
  assert.ok(registry.getTuneOutState('a', 'general'), "a's tune-out is left as it was");
});

test("speak_in_channel and deliver_summary inside the subconscious's turn read the id of the turn's own channel as that channel", async () => {
  const registry = new ChannelRegistry({ getServer: () => null } as never, {} as never, () => {}, () => {});
  for (const serverId of ['a', 'b']) {
    await registry.handleRegister(serverId, {
      channels: [{ id: 'general', type: 'chat', label: '#general', direction: 'bidirectional' }],
    });
  }
  const posted: unknown[] = [];
  (registry as unknown as { publishForAgent(channel: unknown): Promise<unknown> }).publishForAgent = async (channel: unknown) => {
    posted.push(channel);
    return { success: true };
  };
  const added: Array<Record<string, unknown> | undefined> = [];
  const coordinator = new TuneOutCoordinator(registry, {} as never, {
    ...hooks({}),
    allowChannelSpeech: () => true,
    addMessage: (_participant: string, _content: unknown, metadata?: Record<string, unknown>) => { added.push(metadata); },
  } as never);
  const own = [{ serverId: 'b', channelId: 'general' }];
  await coordinator.handleSubconsciousTool('speak_in_channel', { channelId: 'general', text: 'hello' }, own);
  assert.deepEqual(posted, [{ serverId: 'b', channelId: 'general' }], "the turn's own channel, by its ref");
  await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'general', text: 'all quiet' }, own);
  assert.deepEqual(added.map((m) => [m?.channelId, m?.serverId]), [['general', 'b']]);
  // Once b withdraws it, speech there is refused, and a's general isn't taken for it.
  await registry.handleChanged('b', { removed: ['general'] });
  const gone = await coordinator.handleSubconsciousTool('speak_in_channel', { channelId: 'general', text: 'hello again' }, own);
  assertWithdrawn(gone.error ?? '', 'nothing was posted');
  assert.equal(posted.length, 1);
  // deliver_summary refuses it too, rather than leaving a row a re-pin would read as a's general.
  const undelivered = await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'general', text: 'still quiet' }, own);
  assert.deepEqual([undelivered.success, undelivered.isError], [false, true]);
  assertWithdrawn(undelivered.error ?? '', 'nothing was delivered');
  assert.equal(added.length, 1);
  // Where the turn has channels with that id on two servers, it means neither, for both tools.
  await registry.handleRegister('b', { channels: [{ id: 'general', type: 'chat', label: '#general', direction: 'bidirectional' }] });
  const both = [{ serverId: 'a', channelId: 'general' }, { serverId: 'b', channelId: 'general' }];
  const unspoken = await coordinator.handleSubconsciousTool('speak_in_channel', { channelId: 'general', text: 'to whom?' }, both);
  assertBothNamed(unspoken.error ?? '', 'nothing was posted');
  const unsummed = await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'general', text: 'about whom?' }, both);
  assert.deepEqual([unsummed.success, unsummed.isError], [false, true]);
  assertBothNamed(unsummed.error ?? '', 'nothing was delivered');
  assert.equal(posted.length, 1);
  assert.equal(added.length, 1);
});

test("cancel_tuneout refuses a name two registered channels answer to even where only one of them is tuned out", async () => {
  const registry = new ChannelRegistry({ getServer: () => null } as never, {} as never, () => {}, () => {});
  for (const serverId of ['a', 'b']) {
    await registry.handleRegister(serverId, {
      channels: [{ id: 'general', type: 'chat', label: '#general', direction: 'bidirectional' }],
    });
  }
  registry.enterTuneOut('b', 'general', SETTINGS, 'agent-tool');
  const coordinator = new TuneOutCoordinator(registry, {} as never, hooks({}) as never);
  const refused = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'general' });
  assert.match(refused.error ?? '', /^Channel "general" is on more than one server \("a:general", "b:general"\)/);
  assert.ok(registry.getTuneOutState('b', 'general'), "b's tune-out goes on");
});

test("speak_in_channel's refusal names the setting in the host's log, not to the subconscious", async (t) => {
  const busy = coordinator({ tunedOut: [{ channelId: 'disc:guild:noisy' }] });
  const warned = t.mock.method(console, 'warn', () => {});
  const refused = await busy.handleSubconsciousTool('speak_in_channel', { channelId: 'disc:guild:noisy', text: 'hello' });
  assert.equal(refused.isError, true);
  assert.deepEqual(
    warned.mock.calls.map((c) => c.arguments[0]),
    ['[tune-out] speak_in_channel refused: FrameworkConfig.subconscious.allowChannelSpeech is off'],
  );
});
