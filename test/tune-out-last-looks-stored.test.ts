/**
 * The subconscious's last looks are stored: a coordinator built over the same
 * store, or over the store reopened from disk, reads back the looks another
 * coordinator marked, for each epoch and each channel, and a start keeps the
 * looks of every tune-out on record, whether its channel is registered yet or
 * not. Ending the all-except hold leaves a channel's own tune-out the wake and
 * the count kept under that channel's key.
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
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

type Looks = Record<string, Record<string, number>>;
interface Inner {
  markLook(epochId: string, serverId: string, channelId: string): void;
  lastLooks(): Looks | undefined;
  key(serverId: string, channelId: string): string;
  pendingWakes: Map<string, unknown>;
  divertedSinceInvocation: Map<string, number>;
}

const CHANNEL = 'disc:guild:a';

function registryOn(store: JsStore): ChannelRegistry {
  const servers = { getServer: () => null } as unknown as McplServerRegistry;
  return new ChannelRegistry(servers, {} as FeatureSetManager, () => {}, () => {}, { store });
}

function coordinatorOn(registry: ChannelRegistry, sequence: () => number = () => 0, privileged = false): TuneOutCoordinator {
  const hooks = {
    addMessage: () => {},
    commitDeliveries: () => true,
    requestInference: () => {},
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [],
    getDeferredMessages: () => [],
    emitTrace: () => {},
    currentSequence: sequence,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => privileged,
    allowChannelSpeech: () => false,
  };
  return new TuneOutCoordinator(registry, { getServer: () => undefined } as never, hooks as never);
}

const inner = (coordinator: TuneOutCoordinator) => coordinator as unknown as Inner;

test("the subconscious's last looks are read back from the store, by a coordinator over the same store and over the store reopened", () => {
  const dir = mkdtempSync(join(tmpdir(), 'last-looks-'));
  const path = join(dir, 'store');
  const store = JsStore.openOrCreate({ path });
  let closed = false;
  let reopened: JsStore | undefined;
  try {
    let sequence = 0;
    const first = inner(coordinatorOn(registryOn(store), () => sequence));
    sequence = 8;
    first.markLook('e-channel', 'disc', 'disc:guild:a');
    sequence = 9;
    first.markLook('e-channel-b', 'disc', 'disc:guild:b');
    sequence = 11;
    first.markLook('e-all-except', 'disc', 'disc:guild:c');
    first.markLook('e-all-except', 'other', 'disc:guild:c');
    const marked = first.lastLooks();
    assert.equal(Object.keys(marked ?? {}).length, 3, 'three epochs marked');
    assert.equal(Object.keys(marked?.['e-all-except'] ?? {}).length, 2, 'the same channel id on two servers is two looks');

    assert.deepEqual(inner(coordinatorOn(registryOn(store))).lastLooks(), marked, 'read back over the same store');
    store.sync();
    store.close();
    closed = true;
    reopened = JsStore.openOrCreate({ path });
    assert.deepEqual(inner(coordinatorOn(registryOn(reopened))).lastLooks(), marked, 'read back over the store reopened');
  } finally {
    if (!closed) store.close();
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const order of ['before', 'after'] as const) {
  test(`a start over the reopened store keeps the last looks of a tune-out on record and of the all-except hold, its channel registering ${order} the start's resume`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'last-looks-start-'));
    const path = join(dir, 'store');
    const store = JsStore.openOrCreate({ path });
    let closed = false;
    let reopened: JsStore | undefined;
    try {
      const params: TuneOutParams = { epochId: 'eA', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 7 };
      const registry = registryOn(store);
      registry.enterTuneOut('disc', CHANNEL, params, 'agent-tool');
      let sequence = 8;
      const first = coordinatorOn(registry, () => sequence);
      assert.equal(first.enterAllExcept({ serverId: 'disc', channelId: 'disc:guild:work' }, { durationSeconds: 120 }, 'agent-tool').ok, true);
      const hold = first.getAllExcept()?.params.epochId;
      assert.ok(hold);
      inner(first).markLook('eA', 'disc', CHANNEL);
      sequence = 9;
      inner(first).markLook(hold, 'disc', 'disc:guild:b');
      const marked = inner(first).lastLooks();
      assert.equal(Object.keys(marked ?? {}).length, 2, 'the tune-out and the hold each marked');
      first.stop();
      store.sync();
      store.close();
      closed = true;

      reopened = JsStore.openOrCreate({ path });
      const again = registryOn(reopened);
      const register = () => again.handleRegister('disc', {
        channels: [{ id: CHANNEL, type: 'discord', label: '#a', direction: 'bidirectional' }],
      });
      const second = coordinatorOn(again);
      if (order === 'before') await register();
      second.resumeActiveEpochs();
      if (order === 'after') await register();
      second.stop();
      assert.deepEqual(inner(second).lastLooks(), marked);
    } finally {
      if (!closed) store.close();
      reopened?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a start whose read of the holds on record throws keeps every last look and says so; one whose read answers prunes the looks of an epoch no longer on record", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'last-looks-unread-'));
  const path = join(dir, 'store');
  const store = JsStore.openOrCreate({ path });
  let closed = false;
  let reopened: JsStore | undefined;
  try {
    const params: TuneOutParams = { epochId: 'eA', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 7 };
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, params, 'agent-tool');
    let sequence = 8;
    const first = coordinatorOn(registry, () => sequence);
    inner(first).markLook('eA', 'disc', CHANNEL);
    sequence = 9;
    inner(first).markLook('eGone', 'disc', 'disc:guild:b');
    const marked = inner(first).lastLooks();
    assert.deepEqual(Object.keys(marked ?? {}).sort(), ['eA', 'eGone'], 'a look of the hold on record, and one of an epoch no longer on it');
    first.stop();
    store.sync();
    store.close();
    closed = true;

    reopened = JsStore.openOrCreate({ path });
    const again = registryOn(reopened);
    const read = again.tuneOutsOnRecord.bind(again);
    let failing = true;
    again.tuneOutsOnRecord = () => {
      if (failing) throw new Error('the store could not read the holds (test)');
      return read();
    };
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const second = coordinatorOn(again);
    second.resumeActiveEpochs();
    failing = false;
    second.stop();
    assert.deepEqual(inner(second).lastLooks(), marked, 'no look pruned on a read that threw');
    assert.ok(errors.some((e) => e.includes("the subconscious's last looks are all kept")), 'the start says it kept them');

    const third = coordinatorOn(again);
    third.resumeActiveEpochs();
    third.stop();
    assert.deepEqual(Object.keys(inner(third).lastLooks() ?? {}), ['eA'], 'with the read answering, the start prunes the epoch no longer on record');
  } finally {
    if (!closed) store.close();
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ending the all-except hold leaves a channel's own tune-out its pending wake and its tally", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'last-looks-hold-end-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try {
    const coordinator = coordinatorOn(registryOn(store), () => 0, true);
    assert.equal(coordinator.enterAllExcept({ serverId: 'disc', channelId: 'disc:guild:work' }, { durationSeconds: 120 }, 'agent-tool').ok, true);
    assert.equal(coordinator.enter('disc', CHANNEL, {}, 'agent-tool').ok, true);
    coordinator.recordHeld('disc', CHANNEL, 'm1', undefined, 'author');
    const key = inner(coordinator).key('disc', CHANNEL);
    const own = () => ({ wake: inner(coordinator).pendingWakes.has(key), tally: inner(coordinator).divertedSinceInvocation.get(key) });
    assert.deepEqual(own(), { wake: true, tally: 1 }, 'a held message from a privileged author wakes the reader, and is counted');
    assert.equal(coordinator.cancelAllExcept('agent-tool', 'the hold ends').ok, true);
    assert.deepEqual(own(), { wake: true, tally: 1 });
    coordinator.stop();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
