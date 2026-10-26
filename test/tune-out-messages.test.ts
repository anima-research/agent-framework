/**
 * What the tune-out coordinator tells the agent, and the subconscious, when it
 * refuses: that nothing changed, why, and what to do instead. A channel that's
 * already tuned out gives its settings and how to change them, and is marked
 * for the dispatch, which tries a repeat's transport again; a cancel of one
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
    channelsNamed: (name: string) => tunedOut.filter((t) => t.channelId === name).map((t) => ({ serverId: 'disc', channelId: t.channelId })),
    sharedNameRefusalFor: () => undefined,
    // No call here is made inside a turn, so none has own channels.
    ownChannelFor: () => undefined,
    listChannelsRaw: () => tunedOut.map((t) => ({ serverId: 'disc', descriptor: { id: t.channelId } })),
    getTuneOutState: (_server: string, channelId: string) => {
      const found = tunedOut.find((t) => t.channelId === channelId);
      return found ? { params: { ...SETTINGS, expiresAtMs: found.expiresAtMs } } : null;
    },
    cancelTuneOut: () => null,
  };
  return new TuneOutCoordinator(registry as never, {} as never, hooks(opts) as never);
}

test('tune_out and cancel_tuneout say why nothing changed, and name the connected channels that are tuned out', async () => {
  assert.deepEqual(coordinator({ subconscious: false }).enter('disc', 'disc:guild:noisy', {}, 'agent-tool'), {
    ok: false,
    error: 'Nothing was tuned out: this host has no subconscious resident to watch a channel, so tune_out isn\'t '
      + 'available here, and calling it again won\'t change that. If you need channels diverted, ask whoever runs this host.',
  });
  assert.deepEqual(coordinator({ forkBound: true }).enter('disc', 'disc:guild:noisy', {}, 'agent-tool'), {
    ok: false,
    error: 'Nothing changed: a conversation is bound to "disc:guild:noisy", so its messages go to that conversation, '
      + 'and tune_out won\'t divert a channel while one is. Calling tune_out on it again won\'t change that until the '
      + 'conversation ends, which happens only once the channel has been quiet for a while. Tune out a different '
      + 'channel, or ask whoever runs this host if this one should be diverted.',
  });
  // An end carries milliseconds, as Date.now() plus whole seconds does, and is shown to the second.
  const expiring = coordinator({ tunedOut: [{ channelId: 'disc:guild:noisy', expiresAtMs: Date.UTC(2026, 9, 15, 6, 30, 0, 123) }] });
  assert.deepEqual(expiring.enter('disc', 'disc:guild:noisy', {}, 'agent-tool'), {
    ok: false,
    error: 'Nothing changed: "disc:guild:noisy" is already tuned out, with cadenceSeconds 300, backlogCap 50 and '
      + 'maxWakes 3, until 2026-10-15T06:30:00Z. To change those, cancel it first with tune_out mode "cancel", which '
      + 'delivers its backlog to you now, then call tune_out again with the new settings.',
    alreadyTunedOut: true,
  });

  const busy = coordinator({ tunedOut: [{ channelId: 'disc:guild:noisy' }, { channelId: 'disc:guild:busy' }] });
  const elsewhere = 'Nothing was cancelled: no connected channel "disc:guild:quiet" is tuned out. Connected channels tuned '
    + 'out now: "disc:guild:noisy", "disc:guild:busy". A tune-out also ends by itself when its duration runs out, or at '
    + 'the first wake past its wake budget, and its backlog goes to';
  assert.deepEqual(busy.cancel('disc', 'disc:guild:quiet', 'agent-tool', 'agent request'), { ok: false, error: `${elsewhere} you then.` });
  assert.deepEqual(await busy.handleSubconsciousTool('cancel_tuneout', { channelId: 'disc:guild:quiet' }), {
    success: false,
    error: `${elsewhere} the resident then.`,
    isError: true,
  });
});

test('a tune-out with no end, or one past what a date can hold, is described without one', () => {
  const settled = 'Nothing changed: "disc:guild:noisy" is already tuned out, with cadenceSeconds 300, backlogCap 50 and '
    + 'maxWakes 3. To change those, cancel it first with tune_out mode "cancel", which delivers its backlog to you now, then '
    + 'call tune_out again with the new settings.';
  for (const expiresAtMs of [undefined, 8.64e15 + 1]) {
    const busy = coordinator({ tunedOut: [{ channelId: 'disc:guild:noisy', ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) }] });
    assert.deepEqual(busy.enter('disc', 'disc:guild:noisy', {}, 'agent-tool'), { ok: false, error: settled, alreadyTunedOut: true }, String(expiresAtMs));
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
  assert.deepEqual(await overRegistry.handleSubconsciousTool('cancel_tuneout', { channelId: 'disc:guild:noisy' }), {
    success: false,
    error: 'Nothing was cancelled: no connected channel is tuned out now. A tune-out also ends by itself when its '
      + 'duration runs out, or at the first wake past its wake budget, and its backlog goes to the resident then.',
    isError: true,
  });
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
  assert.deepEqual(await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'general' }), {
    success: false,
    isError: true,
    error: 'Channel "general" is on more than one server ("a:general", "b:general"), so nothing ran. '
      + 'Call again with channelId set to one of them.',
  });
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
  assert.deepEqual(wakes.filter((w) => w.startsWith('Subconscious:')), [
    'Subconscious: tune-out cancelled: a:general', 'Subconscious: tune-out cadence: a:general',
  ]);
  // The subconscious's own words carry the channel's server, which the
  // framework reads on a conversational row (repinChannel).
  const note = added.find((m) => m.metadata?.kind === 'subconscious-note');
  assert.deepEqual([note?.metadata?.channelId, note?.metadata?.serverId], ['general', 'b']);
  await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'b:general', text: 'all quiet on b' });
  const which = await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'general', text: 'which general?' });
  assert.deepEqual([which.success, which.isError, which.error], [false, true,
    'Channel "general" is on more than one server ("a:general", "b:general"), so nothing was delivered. Call again with channelId set to one of them.']);
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
  const cancelled: string[] = [];
  const coordinator = new TuneOutCoordinator(registry, {} as never, hooks({}) as never);
  (coordinator as unknown as { cancel(s: string, c: string): { ok: boolean } }).cancel = (s: string, c: string) => { cancelled.push(`${s} ${c}`); return { ok: true }; };
  const own = [{ serverId: 'b', channelId: 'general' }];
  assert.deepEqual(await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'general' }, own), { success: true, data: { cancelled: true } });
  assert.deepEqual(cancelled, ['b general'], "the turn's own channel, not a shared-id refusal");
  await registry.handleChanged('b', { removed: ['general'] });
  const gone = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'general' }, own);
  assert.equal(gone.error, '"general" is this turn\'s channel on server "b", which no longer registers it, so nothing ran, '
    + 'and nothing can run on it until that server registers it again.');
  assert.deepEqual(cancelled, ['b general'], "a's tune-out is left as it was");
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
  assert.equal(gone.error, '"general" is this turn\'s channel on server "b", which no longer registers it, so nothing was posted, '
    + 'and nothing can be until that server registers it again.');
  assert.equal(posted.length, 1);
  // deliver_summary refuses it too, rather than leaving a row a re-pin would read as a's general.
  const undelivered = await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'general', text: 'still quiet' }, own);
  assert.deepEqual([undelivered.success, undelivered.isError], [false, true]);
  assert.equal(undelivered.error, '"general" is this turn\'s channel on server "b", which no longer registers it, so nothing was delivered, '
    + 'and nothing can be until that server registers it again.');
  assert.equal(added.length, 1);
  // Where the turn has channels with that id on two servers, it means neither, for both tools.
  await registry.handleRegister('b', { channels: [{ id: 'general', type: 'chat', label: '#general', direction: 'bidirectional' }] });
  const both = [{ serverId: 'a', channelId: 'general' }, { serverId: 'b', channelId: 'general' }];
  const unspoken = await coordinator.handleSubconsciousTool('speak_in_channel', { channelId: 'general', text: 'to whom?' }, both);
  assert.equal(unspoken.error, '"general" is the id of this turn\'s channels on more than one server ("a:general", "b:general"), '
    + 'so nothing was posted. Call again with channelId set to one of them.');
  const unsummed = await coordinator.handleSubconsciousTool('deliver_summary', { channelId: 'general', text: 'about whom?' }, both);
  assert.deepEqual([unsummed.success, unsummed.isError], [false, true]);
  assert.equal(unsummed.error, '"general" is the id of this turn\'s channels on more than one server ("a:general", "b:general"), '
    + 'so nothing was delivered. Call again with channelId set to one of them.');
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
