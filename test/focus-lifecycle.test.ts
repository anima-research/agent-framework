/**
 * Focus epoch durability — the `focus` record in mcpl/channel-lifecycle,
 * replayed last-record-wins so a restart lands in the same epoch (same
 * stamps, same deadline) and a corrupt record reads as "not focused".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ChannelRegistry, type FocusParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

function makeRegistry(store?: JsStore) {
  const serverRegistry = { getServer: (_id: string) => null } as unknown as McplServerRegistry;
  return new ChannelRegistry(serverRegistry, {} as FeatureSetManager, () => {}, () => {}, store ? { store } : undefined);
}

const PARAMS: FocusParams = {
  epochId: 'epoch-1',
  serverId: 'discord',
  channelId: 'discord:g:work',
  startedAtMs: 1_000,
  startedAtSequence: 42,
  expiresAtMs: 2_000_000_000_000,
  backlogCap: 20,
};

test('set/get/end round-trip in the projection', () => {
  const registry = makeRegistry();
  assert.equal(registry.getFocus(), null);
  registry.setFocus(PARAMS, 'agent-tool');
  assert.deepEqual(registry.getFocus(), PARAMS);
  registry.setFocus(null, 'agent-tool');
  assert.equal(registry.getFocus(), null);
});

test('the epoch replays across restart, including re-target release points; end replays as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-lifecycle-'));
  try {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const first = makeRegistry(store);
    first.setFocus(PARAMS, 'agent-tool');
    const retargeted = { ...PARAMS, channelId: 'discord:g:chat', released: { 'discord:g:chat': 7 } };
    first.setFocus(retargeted, 'agent-tool');

    const second = makeRegistry(store);
    assert.deepEqual(second.getFocus(), retargeted);

    second.setFocus(null, 'duration');
    const third = makeRegistry(store);
    assert.equal(third.getFocus(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed focus record replays as not focused rather than failing boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-lifecycle-bad-'));
  try {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const first = makeRegistry(store);
    first.setFocus(PARAMS, 'agent-tool');
    store.appendToStateJson('mcpl/channel-lifecycle', {
      kind: 'focus', serverId: 'discord', timestamp: 'now', focus: { epochId: 'x' },
    });
    const second = makeRegistry(store);
    assert.equal(second.getFocus(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('focus records do not disturb per-channel desired state', () => {
  const registry = makeRegistry();
  registry.setFocus(PARAMS, 'agent-tool');
  assert.equal(registry.getDesiredState('discord', 'discord:g:work'), undefined);
});
