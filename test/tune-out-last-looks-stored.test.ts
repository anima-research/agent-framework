/**
 * The subconscious's last looks are stored: a coordinator built over the same
 * store, or over the store reopened from disk, reads back the looks another
 * coordinator marked, for each epoch and each channel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

type Looks = Record<string, Record<string, number>>;
interface LookKeeping { markLook(epochId: string, serverId: string, channelId: string): void; lastLooks(): Looks | undefined }

function coordinatorOver(store: JsStore, sequence: () => number = () => 0): LookKeeping {
  const servers = { getServer: () => null } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(servers, {} as FeatureSetManager, () => {}, () => {}, { store });
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
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
  };
  return new TuneOutCoordinator(registry, {} as never, hooks as never) as unknown as LookKeeping;
}

test("the subconscious's last looks are read back from the store, by a coordinator over the same store and over the store reopened", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'last-looks-'));
  let reopened: JsStore | undefined;
  t.after(() => {
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'store');
  const store = JsStore.openOrCreate({ path });
  let sequence = 0;
  const first = coordinatorOver(store, () => sequence);
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

  assert.deepEqual(coordinatorOver(store).lastLooks(), marked, 'read back over the same store');
  store.sync();
  store.close();
  reopened = JsStore.openOrCreate({ path });
  assert.deepEqual(coordinatorOver(reopened).lastLooks(), marked, 'read back over the store reopened');
});
