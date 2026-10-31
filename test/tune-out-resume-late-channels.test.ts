/**
 * A tune-out on record whose channel isn't registered at the start, as a
 * channel its MCPL server registers only later (discord-mcpl registers from
 * a task that waits on the policy exchange or a grace timer), is resumed at
 * the start as any other is: one past its end time is cancelled there, its
 * backlog stored and its end recorded; one whose end time is still ahead
 * has its end timer armed; and the subconscious keeps its window's start
 * and its last look for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import { ChannelRegistry, type TuneOutParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

const CHANNEL = 'disc:guild:a';
const NOW = Date.UTC(2026, 9, 29);
const PARAMS: TuneOutParams = { epochId: 'eA', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 7 };
const HELD = ['held 1', 'held 2', 'held 3'];

interface Row { id: string; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }

const window3 = (): Row[] => [1, 2, 3].map((i) => ({
  id: `h${i}`,
  participant: 'user',
  content: [{ type: 'text', text: `held ${i}` } as ContentBlock],
  metadata: { author: { name: 'Bo' }, channelId: CHANNEL, serverId: 'disc', tuneOut: { epochId: 'eA' } },
}));

function registryOn(store: JsStore): ChannelRegistry {
  const servers = { getServer: (_id: string) => null } as unknown as McplServerRegistry;
  return new ChannelRegistry(servers, {} as FeatureSetManager, () => {}, () => {}, { store });
}

function coordinatorOn(registry: ChannelRegistry, window: Row[], anchors: number[] = []): TuneOutCoordinator {
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>) => {
      if (metadata?.kind === 'tune-out-cancel') window.push({ id: `dump-${window.length}`, participant, content, metadata });
    },
    commitDeliveries: () => true,
    requestInference: () => {},
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => window,
    getDeferredMessages: () => [],
    emitTrace: () => {},
    currentSequence: () => 9,
    setSubconsciousAnchor: (sequence: number) => { anchors.push(sequence); },
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
  };
  return new TuneOutCoordinator(registry, {} as never, hooks as never);
}

/** How many times each held line shows in the window's dumps. */
function timesShown(window: Row[]): Record<string, number> {
  const all = window
    .filter((m) => m.metadata?.kind === 'tune-out-cancel')
    .map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''))
    .join('\n');
  return Object.fromEntries(HELD.map((line) => [line, all.split(`: ${line}\n`).length - 1]));
}

const once = Object.fromEntries(HELD.map((line) => [line, 1]));

async function withStore(run: (store: JsStore) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-resume-late-'));
  try {
    await run(JsStore.openOrCreate({ path: join(dir, 'store') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a tune-out whose channel isn't registered at the start and whose end time passed while the process was down is cancelled at the start", async () => {
  await withStore((store) => {
    const window = window3();
    registryOn(store).enterTuneOut('disc', CHANNEL, { ...PARAMS, expiresAtMs: Date.now() - 1 }, 'agent-tool');
    const registry = registryOn(store);
    assert.deepEqual(registry.listChannelsRaw(), [], 'no channel is registered yet');
    const coordinator = coordinatorOn(registry, window);
    coordinator.resumeActiveEpochs();
    coordinator.stop();
    assert.deepEqual(timesShown(window), once, 'its backlog is stored');
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
    assert.equal(registryOn(store).getTuneOutState('disc', CHANNEL), null, 'its end is on record');
  });
});

test("a tune-out whose channel isn't registered at the start has its end timer armed there, and ends at its end time after the channel registers", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  await withStore(async (store) => {
    const window = window3();
    registryOn(store).enterTuneOut('disc', CHANNEL, { ...PARAMS, expiresAtMs: NOW + 120_000 }, 'agent-tool');
    const registry = registryOn(store);
    const coordinator = coordinatorOn(registry, window);
    t.after(() => coordinator.stop());
    coordinator.resumeActiveEpochs();
    await registry.handleRegister('disc', {
      channels: [{ id: CHANNEL, type: 'discord', label: '#a', direction: 'bidirectional' }],
    });
    t.mock.timers.tick(119_999);
    assert.equal(registry.getTuneOutState('disc', CHANNEL)?.params.epochId, 'eA', 'in force until its end time');
    t.mock.timers.tick(1);
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null, 'ended at its end time');
    assert.deepEqual(timesShown(window), once, 'its backlog is stored');
  });
});

test("the subconscious keeps its window's start and its last look for a tune-out whose channel isn't registered, at the start and at a later hold", async () => {
  await withStore((store) => {
    registryOn(store).enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    const registry = registryOn(store);
    // The looks are kept in memory: the store refuses their keys, which hold
    // a NUL between server and channel.
    const looks = { eA: { [`disc\0${CHANNEL}`]: 8 } };
    const state = new Map<string, unknown>([['tune-out/scout/last-looks', looks]]);
    registry.readCoordinatorState = (id: string) => state.get(id) ?? null;
    registry.writeCoordinatorState = (id: string, value: unknown) => { state.set(id, value); };
    const anchors: number[] = [];
    const coordinator = coordinatorOn(registry, window3(), anchors);
    coordinator.resumeActiveEpochs();
    assert.deepEqual(anchors, [PARAMS.startedAtSequence], "the subconscious's window starts at the tune-out's start");
    assert.deepEqual(registry.readCoordinatorState('tune-out/scout/last-looks'), looks, 'its last look is kept');
    assert.equal(coordinator.enter('disc', 'disc:guild:b', {}, 'agent-tool').ok, true);
    assert.equal(coordinator.enterAllExcept({ serverId: 'disc', channelId: 'disc:guild:work' }, { durationSeconds: 120 }, 'agent-tool').ok, true);
    coordinator.stop();
    assert.deepEqual(anchors, Array(3).fill(PARAMS.startedAtSequence), "a later tune-out or all-except hold doesn't move the window's start past it");
  });
});
