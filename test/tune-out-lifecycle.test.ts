/**
 * Tune-out desired state (issue #77) — durable lifecycle semantics.
 *
 * The third DesiredChannelState. A tuned-out channel stays transport-open
 * (traffic keeps arriving for the subconscious); main's wake/visibility
 * divert happens downstream. Params and wake counts live in the
 * mcpl/channel-lifecycle append-log, replayed last-record-wins, so
 * max-wakes cannot reset on restart and time travel carries the epoch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ChannelRegistry, type TuneOutParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

function makeRegistry(store?: JsStore) {
  const serverRegistry = {
    getServer: (_id: string) => null,
  } as unknown as McplServerRegistry;
  return new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    store ? { store } : undefined,
  );
}

const PARAMS: TuneOutParams = {
  epochId: 'epoch-1',
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
  startedAtSequence: 42,
};

test('enter/query/cancel round-trip in the projection', () => {
  const registry = makeRegistry();
  registry.enterTuneOut('discord', '#dev', PARAMS, 'agent-tool');

  assert.equal(registry.getDesiredState('discord', '#dev'), 'tuned-out');
  const state = registry.getTuneOutState('discord', '#dev');
  assert.deepEqual(state, { params: PARAMS, wakeCount: 0 });

  const ended = registry.cancelTuneOut('discord', '#dev', 'open', 'agent-tool');
  assert.deepEqual(ended, { params: PARAMS, wakeCount: 0 });
  assert.equal(registry.getDesiredState('discord', '#dev'), 'open');
  assert.equal(registry.getTuneOutState('discord', '#dev'), null);
  // Cancelling twice is a null no-op.
  assert.equal(registry.cancelTuneOut('discord', '#dev', 'open', 'agent-tool'), null);
});

test('wake counts are durable across restart; epoch and params replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-lifecycle-'));
  try {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const first = makeRegistry(store);
    first.enterTuneOut('discord', '#dev', PARAMS, 'agent-tool');
    assert.deepEqual(first.recordTuneOutWake('discord', '#dev'), {
      params: PARAMS,
      wakeCount: 1,
    });
    assert.deepEqual(first.recordTuneOutWake('discord', '#dev'), {
      params: PARAMS,
      wakeCount: 2,
    });

    // Fresh registry over the same store: full state from replay alone.
    const second = makeRegistry(store);
    assert.equal(second.getDesiredState('discord', '#dev'), 'tuned-out');
    assert.deepEqual(second.getTuneOutState('discord', '#dev'), {
      params: PARAMS,
      wakeCount: 2,
    });

    // A wake recorded after restart continues the durable count.
    assert.equal(second.recordTuneOutWake('discord', '#dev')?.wakeCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale epoch\'s wake records do not leak into a new epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-epoch-'));
  try {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const registry = makeRegistry(store);
    registry.enterTuneOut('discord', '#dev', PARAMS, 'agent-tool');
    registry.recordTuneOutWake('discord', '#dev');
    registry.recordTuneOutWake('discord', '#dev');
    // Re-enter under a new epoch (fresh params) without cancelling first.
    registry.enterTuneOut(
      'discord',
      '#dev',
      { ...PARAMS, epochId: 'epoch-2', maxWakes: 3 },
      'agent-tool',
    );
    assert.equal(registry.getTuneOutState('discord', '#dev')?.wakeCount, 0);

    // Replay agrees: old epoch's wake records are attributed to epoch-1
    // and skipped once epoch-2's desired-state record supersedes it.
    const replayed = makeRegistry(store);
    assert.deepEqual(replayed.getTuneOutState('discord', '#dev'), {
      params: { ...PARAMS, epochId: 'epoch-2', maxWakes: 3 },
      wakeCount: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordTuneOutWake on a non-tuned-out channel is a null no-op', () => {
  const registry = makeRegistry();
  assert.equal(registry.recordTuneOutWake('discord', '#dev'), null);
  assert.equal(registry.getTuneOutState('discord', '#dev'), null);
});

test('malformed tuned-out records (no params) are dropped at replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-malformed-'));
  try {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    // Seed the log the way an old/foreign writer might: a tuned-out
    // desired-state with no params object.
    const first = makeRegistry(store);
    void first; // registers the state slot
    store.appendToStateJson('mcpl/channel-lifecycle', {
      kind: 'desired-state',
      serverId: 'discord',
      channelId: '#dev',
      desired: 'tuned-out',
      timestamp: new Date().toISOString(),
    });
    const replayed = makeRegistry(store);
    assert.equal(replayed.getDesiredState('discord', '#dev'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
