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
