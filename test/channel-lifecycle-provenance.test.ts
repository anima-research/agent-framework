import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ChannelRegistry, desiredStateInLog } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

/**
 * Desired-state provenance: a server upgrading its descriptor to
 * initiallyOpen may lift a pure default ('default-closed' = nobody ever
 * decided), but must never override a real decision (agent-tool,
 * invitation-declined). Regression for the eidoverse-worlds case where a
 * resident's world channel stayed shadow-closed forever because the default
 * predated the server declaring its bootstrap preference.
 */

function makeRegistry(store?: JsStore) {
  const serverRegistry = {
    getServer: (_id: string) => ({ sendChannelsPublish: async () => ({ delivered: true }) }),
  } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    store ? { store } : undefined,
  );
  const r = registry as unknown as {
    ensureInitialDesiredState(serverId: string, ch: { id: string; type: string; label: string; direction: string; initiallyOpen?: boolean }): void;
    setDesiredState(serverId: string, channelId: string, desired: 'open' | 'closed', source: string): void;
    getDesiredState(serverId: string, channelId: string): 'open' | 'closed' | undefined;
  };
  return { registry, r };
}

const ch = (initiallyOpen?: boolean) => ({
  id: 'world:commons', type: 'world', label: 'eidoverse — commons', direction: 'bidirectional', initiallyOpen,
});

test('default-closed is lifted when the server later declares initiallyOpen', () => {
  const { r } = makeRegistry();
  // first registration: server said nothing → default-closed
  r.ensureInitialDesiredState('eidoverse', ch(undefined));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'closed');
  // server upgrades its descriptor: bootstrap preference lifts the pure default
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
});

test('an agent decision to close is never overridden by initiallyOpen', () => {
  const { r } = makeRegistry();
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
  // the agent deliberately closes their door
  r.setDesiredState('eidoverse', 'world:commons', 'closed', 'agent-tool');
  // server keeps declaring initiallyOpen — the decision sticks
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'closed');
});

test("desiredStateInLog reads a server's channel's last decision from a store's lifecycle log, by the rule a registry replayed from it reads", () => {
  const dir = mkdtempSync(join(tmpdir(), 'desired-state-in-log-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try {
    assert.equal(desiredStateInLog(store, 'a', 'c-1'), undefined, 'a store no registry has written to');
    const { registry, r } = makeRegistry(store);
    r.setDesiredState('a', 'c-1', 'open', 'opened-by-reply');
    r.setDesiredState('a', 'c-1', 'closed', 'agent-tool');
    r.setDesiredState('a', 'c-2', 'open', 'opened-by-reply');
    // One channel id on two servers, each with its own decision.
    r.setDesiredState('a', 'c-3', 'open', 'opened-by-reply');
    r.setDesiredState('b', 'c-3', 'closed', 'agent-tool');
    registry.enterTuneOut('a', 'c-9', { epochId: 'e-9', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
    // Records the rule doesn't read as a decision: another kind, a channel id
    // that isn't text, a tune-out with no params, a state no build writes.
    // A decision with no source is still a decision.
    for (const item of [
      { kind: 'channel-renamed', serverId: 'a', channelId: 'c-5', desired: 'open', source: 'agent-tool' },
      { kind: 'desired-state', serverId: 'a', channelId: 6, desired: 'open', source: 'agent-tool' },
      { kind: 'desired-state', serverId: 'a', channelId: 'c-7', desired: 'tuned-out', source: 'agent-tool' },
      { kind: 'desired-state', serverId: 'a', channelId: 'c-8', desired: 'maybe', source: 'agent-tool' },
      { kind: 'desired-state', serverId: 'a', channelId: 'c-10', desired: 'open' },
    ]) store.appendToStateJson('mcpl/channel-lifecycle', { ...item, timestamp: new Date().toISOString() } as never);
    assert.equal(desiredStateInLog(store, 'a', 'c-1'), 'closed', 'the last decision wins');
    assert.equal(desiredStateInLog(store, 'a', 'c-2'), 'open');
    assert.equal(desiredStateInLog(store, 'a', 'c-3'), 'open', "a's own decision");
    assert.equal(desiredStateInLog(store, 'b', 'c-3'), 'closed', "b's own decision");
    assert.equal(desiredStateInLog(store, 'b', 'c-2'), undefined, "another server's channel");
    assert.equal(desiredStateInLog(store, 'a', 'c-9'), 'tuned-out');
    for (const [server, id] of [['a', 'c-5'], ['a', '6'], ['a', 'c-7'], ['a', 'c-8']]) {
      assert.equal(desiredStateInLog(store, server!, id!), undefined, `${server}:${id} isn't a decision`);
    }
    assert.equal(desiredStateInLog(store, 'a', 'c-10'), 'open', 'a decision with no source');
    assert.equal(desiredStateInLog(store, 'a', 'c-4'), undefined, 'none on record');
    const replayed = makeRegistry(store).registry;
    for (const [server, id] of [['a', 'c-1'], ['a', 'c-2'], ['a', 'c-3'], ['b', 'c-3'], ['b', 'c-2'], ['a', 'c-9'],
      ['a', 'c-5'], ['a', '6'], ['a', 'c-7'], ['a', 'c-8'], ['a', 'c-10'], ['a', 'c-4']]) {
      assert.equal(replayed.getDesiredState(server!, id!), desiredStateInLog(store, server!, id!), `${server}:${id}`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
