/**
 * AF #844 bot review, round 8: the tune-out coordinator and its
 * subconscious-window anchor.
 *
 * 65: a cancel deferred while writes were held in memory, whose run at the
 *     release throws, stays waiting with its note and is tried again (at
 *     the next release, or by one retry timer), never dropped.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

interface Added { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string }
const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

/** One tune-out (eA on disc:guild:a), with the framework's writesHeld and commitDeliveries hooks driven by the test. */
function deferredSetup() {
  const state = { held: true, durable: false, inForce: true };
  const added: Added[] = [];
  const params = { epochId: 'eA', cadenceSeconds: 300, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 };
  const registry = {
    getTuneOutState: (_s: string, channelId: string) => (state.inForce && channelId === 'disc:guild:a' ? { params, wakeCount: 0 } : null),
    readCoordinatorState: () => null,
    nameShown: (channel: { channelId: string }) => channel.channelId,
    quotedShown: (channel: { channelId: string }) => JSON.stringify(channel.channelId),
    cancelTuneOut: () => { if (!state.inForce) return null; state.inForce = false; return { params, wakeCount: 0 }; },
    listChannelsRaw: () => [],
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      added.push({ participant, content, metadata, forAgent });
    },
    requestInference: () => {},
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [{ participant: 'user', content: [text('A1')], metadata: { author: { name: 'Ann' }, tuneOut: { epochId: 'eA' } } }],
    getSurgeryHeldMessages: () => [],
    unseenBySubconscious: () => 0,
    emitTrace: () => {},
    writesHeld: () => state.held,
    commitDeliveries: () => state.durable,
  };
  const coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  const notes = () => added.filter((m) => m.metadata?.kind === 'subconscious-note').map((m) => textOf(m.content));
  return { coordinator, state, added, notes };
}

test('65: a deferred cancel whose release is not made durable at the release stays waiting with its note, and runs at the next release', () => {
  const { coordinator, state, notes } = deferredSetup();
  const errors = mock.method(console, 'error', () => {});
  try {
    assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.'), { ok: true, deferred: true });
    state.held = false;
    coordinator.runDeferredCancels();
    assert.ok(state.inForce, 'the release could not be made durable: the tune-out stays in force');
    assert.deepEqual(notes(), [], 'and its note is not delivered yet');
    assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes('stays waiting')), 'the failure is logged as waiting on');
    state.durable = true;
    coordinator.runDeferredCancels();
    assert.ok(!state.inForce, 'the next release ends it');
    assert.deepEqual(notes(), ['Someone asked for you.'], 'with the note asked for during the hold');
    coordinator.runDeferredCancels();
    assert.deepEqual(notes(), ['Someone asked for you.'], 'once');
  } finally {
    errors.mock.restore();
    coordinator.stop();
  }
});

test('65: with no later release, one retry timer runs the waiting cancel again; stop clears it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  try {
    const { coordinator, state, notes } = deferredSetup();
    coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Look here.');
    state.held = false;
    coordinator.runDeferredCancels();
    assert.ok(state.inForce);
    mock.timers.tick(60_000);
    assert.ok(state.inForce, 'still not durable at the retry: it waits on');
    state.durable = true;
    mock.timers.tick(60_000);
    assert.ok(!state.inForce, 'the retry armed again ends it');
    assert.deepEqual(notes(), ['Look here.']);

    // stop() clears an armed retry: the tune-out stays in force on disk.
    const second = deferredSetup();
    second.coordinator.cancel('disc', 'disc:guild:a', 'duration', 'duration elapsed');
    second.state.held = false;
    second.coordinator.runDeferredCancels();
    second.coordinator.stop();
    second.state.durable = true;
    mock.timers.tick(120_000);
    assert.ok(second.state.inForce, 'no cancel runs after stop');
  } finally {
    errors.mock.restore();
    mock.timers.reset();
  }
});

test('65: a deferred cancel whose hold ended meanwhile ends nothing and is not tried again', () => {
  const { coordinator, state, added } = deferredSetup();
  try {
    coordinator.cancel('disc', 'disc:guild:a', 'duration', 'duration elapsed');
    state.inForce = false; // ended otherwise during the hold
    state.held = false;
    coordinator.runDeferredCancels();
    state.inForce = true;
    state.durable = true;
    coordinator.runDeferredCancels();
    assert.ok(state.inForce, 'the cancel that found no tune-out is not kept');
    assert.equal(added.length, 0);
  } finally {
    coordinator.stop();
  }
});
