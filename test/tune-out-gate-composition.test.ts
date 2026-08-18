/**
 * The resident's wake gate composes into subconscious wakes (#77,
 * antra in #tuneout-talk): the subconscious is affected BY main's gate,
 * it does not replace it. An event the gate suppresses for the resident
 * diverts silently — stamped into the backlog, counted for cadence — but
 * wakes nobody and triggers no suppressed-mention reaction (main would
 * not have signaled either, and reacting would leak a standing mute to
 * its subject).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TuneOutCoordinator, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { ChannelRegistry, TuneOutParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

const PARAMS: TuneOutParams = {
  epochId: 'e1',
  cadenceSeconds: 3600,
  backlogCap: 10,
  maxWakes: 5,
  startedAtSequence: 1,
};

function harness(opts?: { privileged?: boolean }) {
  const wakes: string[] = [];
  const acks: string[] = [];
  const registry = {
    getTuneOutState: () => ({ params: PARAMS, wakeCount: 0 }),
    recordTuneOutWake: () => ({ params: PARAMS, wakeCount: 1 }),
    listChannelsRaw: () => [],
  } as unknown as ChannelRegistry;
  const servers = {
    getServer: () => ({
      // The ack path is grant-gated (CapabilityGrant.of reads conn.grant).
      grant: new CapabilityGrant(new Set(['channels.acknowledge']), []),
      sendChannelsAcknowledge: async (p: { messageId: string }) => {
        acks.push(p.messageId);
        return { acknowledged: true };
      },
    }),
  } as unknown as McplServerRegistry;
  const hooks = {
    addMessage: () => '',
    requestInference: () => {},
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [],
    currentSequence: () => 1,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => opts?.privileged ?? false,
    allowChannelSpeech: () => false,
    emitTrace: () => {},
  } as unknown as TuneOutFrameworkHooks;
  const coordinator = new TuneOutCoordinator(registry, servers, hooks);
  // Observe wake scheduling without waiting out the coalesce timer.
  (coordinator as unknown as { scheduleWakeInvocation: (s: string, c: string) => void })
    .scheduleWakeInvocation = (s: string, c: string) => { wakes.push(`${s}:${c}`); };
  return { coordinator, wakes, acks };
}

describe('duration expiry', () => {
  it('an expired deadline at resume cancels immediately via the standard flow', () => {
    const cancels: string[] = [];
    const registry = {
      listChannelsRaw: () => [{ serverId: 'disc', descriptor: { id: '#a' } }],
      getTuneOutState: () => ({
        params: { ...PARAMS, expiresAtMs: Date.now() - 5_000 },
        wakeCount: 0,
      }),
      cancelTuneOut: (_s: string, c: string) => {
        cancels.push(c);
        return { params: PARAMS, wakeCount: 0 };
      },
    } as unknown as ChannelRegistry;
    const hooks = {
      addMessage: () => '',
      requestInference: () => {},
      subconsciousName: () => 'Subconscious',
      primaryName: () => 'scout',
      getStoredMessages: () => [],
      currentSequence: () => 1,
      setSubconsciousAnchor: () => {},
      isForkBound: () => false,
      isPrivilegedAuthor: () => false,
      allowChannelSpeech: () => false,
      emitTrace: () => {},
    } as unknown as TuneOutFrameworkHooks;
    const coordinator = new TuneOutCoordinator(registry, {} as McplServerRegistry, hooks);
    coordinator.resumeActiveEpochs();
    assert.deepEqual(cancels, ['#a'], 'expired epoch cancelled at resume');
    coordinator.stop();
  });

  it('a live deadline arms a timer that cancels on schedule', async () => {
    const cancels: string[] = [];
    const registry = {
      listChannelsRaw: () => [],
      getTuneOutState: () => null,
      enterTuneOut: () => {},
      cancelTuneOut: (_s: string, c: string) => {
        cancels.push(c);
        return { params: PARAMS, wakeCount: 0 };
      },
    } as unknown as ChannelRegistry;
    const hooks = {
      addMessage: () => '',
      requestInference: () => {},
      subconsciousName: () => 'Subconscious',
      primaryName: () => 'scout',
      getStoredMessages: () => [],
      currentSequence: () => 1,
      setSubconsciousAnchor: () => {},
      isForkBound: () => false,
      isPrivilegedAuthor: () => false,
      allowChannelSpeech: () => false,
      emitTrace: () => {},
    } as unknown as TuneOutFrameworkHooks;
    const coordinator = new TuneOutCoordinator(registry, {} as McplServerRegistry, hooks);
    // armExpiry directly with a ~50ms deadline (enter() clamps duration to
    // >=60s, which a unit test should not wait out).
    (coordinator as unknown as {
      armExpiry: (s: string, c: string, p: TuneOutParams) => void;
    }).armExpiry('disc', '#a', { ...PARAMS, expiresAtMs: Date.now() + 50 });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(cancels, ['#a'], 'deadline fired the standard cancel');
    coordinator.stop();
  });

  it('enter() stamps expiresAtMs only when durationSeconds is given', () => {
    const entered: TuneOutParams[] = [];
    const registry = {
      listChannelsRaw: () => [],
      getTuneOutState: () => null,
      enterTuneOut: (_s: string, _c: string, p: TuneOutParams) => { entered.push(p); },
    } as unknown as ChannelRegistry;
    const hooks = {
      addMessage: () => '',
      requestInference: () => {},
      subconsciousName: () => 'Subconscious',
      primaryName: () => 'scout',
      getStoredMessages: () => [],
      currentSequence: () => 42,
      setSubconsciousAnchor: () => {},
      isForkBound: () => false,
      isPrivilegedAuthor: () => false,
      allowChannelSpeech: () => false,
      emitTrace: () => {},
    } as unknown as TuneOutFrameworkHooks;
    const coordinator = new TuneOutCoordinator(registry, {} as McplServerRegistry, hooks);
    coordinator.enter('disc', '#a', {}, 'agent-tool');
    assert.equal(entered[0].expiresAtMs, undefined, 'unset by default');
    coordinator.enter('disc', '#b', { durationSeconds: 3600 }, 'agent-tool');
    assert.ok(
      entered[1].expiresAtMs !== undefined && entered[1].expiresAtMs > Date.now() + 3_500_000,
      'deadline stamped from durationSeconds',
    );
    coordinator.stop();
  });
});

describe('dispositions injection', () => {
  function dispositionHarness() {
    const registry = {
      listChannelsRaw: () => [],
      getTuneOutState: () => null,
      readCoordinatorState: () => null,
      writeCoordinatorState: (_id: string, v: unknown) => { stateStore = v; },
    } as unknown as ChannelRegistry;
    let stateStore: unknown = null;
    const hooks = {
      addMessage: () => '',
      requestInference: () => {},
      subconsciousName: () => 'Subconscious',
      primaryName: () => 'scout',
      getStoredMessages: () => [],
      currentSequence: () => 1,
      setSubconsciousAnchor: () => {},
      isForkBound: () => false,
      isPrivilegedAuthor: () => false,
      allowChannelSpeech: () => false,
      emitTrace: () => {},
    } as unknown as TuneOutFrameworkHooks;
    return new TuneOutCoordinator(registry, {} as McplServerRegistry, hooks);
  }

  it('empty dispositions produce no injection', () => {
    const coordinator = dispositionHarness();
    assert.equal(coordinator.getDispositionsInjection(), null);
    coordinator.stop();
  });

  it('noted dispositions become a system-position injection; empty text deletes', () => {
    const coordinator = dispositionHarness();
    coordinator.noteDisposition('antra', 'pings always escalate');
    coordinator.noteDisposition('release-bot', 'ignore');
    const injection = coordinator.getDispositionsInjection();
    assert.equal(injection?.position, 'system');
    assert.equal(injection?.namespace, 'dispositions');
    assert.match(injection!.content[0].text, /antra: pings always escalate/);
    assert.match(injection!.content[0].text, /release-bot: ignore/);

    coordinator.noteDisposition('release-bot', '');
    const after = coordinator.getDispositionsInjection();
    assert.ok(!after!.content[0].text.includes('release-bot'), 'empty text deletes the key');
    coordinator.stop();
  });
});

describe('gate composition on subconscious wakes', () => {
  it('gate-passed addressed messages wake and get the reaction', () => {
    const { coordinator, wakes, acks } = harness();
    const divert = coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed'], 'U1', true);
    assert.equal(divert?.epochId, 'e1', 'still stamped');
    assert.equal(wakes.length, 1);
    assert.deepEqual(acks, ['m1']);
  });

  it('gate-suppressed addressed messages divert silently: stamp yes, wake no, reaction no', () => {
    const { coordinator, wakes, acks } = harness();
    const divert = coordinator.onIncoming('disc', '#a', 'm2', ['chat:addressed'], 'U1', false);
    assert.equal(divert?.epochId, 'e1', 'still stamped into the backlog');
    assert.equal(wakes.length, 0, 'no subconscious wake past the gate');
    assert.equal(acks.length, 0, 'no reaction — it would leak the mute');
  });

  it('gate-suppressed privileged authors do not wake either (gate is a true precondition)', () => {
    const { coordinator, wakes } = harness({ privileged: true });
    coordinator.onIncoming('disc', '#a', 'm3', ['chat:ambient'], 'U-priv', false);
    assert.equal(wakes.length, 0);
  });

  it('gate-passed privileged ambient authors wake without a reaction (nothing was suppressed toward them)', () => {
    const { coordinator, wakes, acks } = harness({ privileged: true });
    coordinator.onIncoming('disc', '#a', 'm4', ['chat:ambient'], 'U-priv', true);
    assert.equal(wakes.length, 1);
    assert.equal(acks.length, 0);
  });
});
