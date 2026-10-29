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
const PARAMS: TuneOutParams = { epochId: 'eA', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 0 };
const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);

interface Row { id: string; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }

const heldRow = (i: number, channelId = CHANNEL, epochId = 'eA'): Row => ({
  id: `h${i}`,
  participant: 'user',
  content: [text(`held ${i}`)],
  metadata: { author: { name: 'Bo' }, channelId, serverId: 'disc', tuneOut: { epochId } },
});

function registryOn(store: JsStore): ChannelRegistry {
  const servers = { getServer: (_id: string) => null } as unknown as McplServerRegistry;
  return new ChannelRegistry(servers, {} as FeatureSetManager, () => {}, () => {}, { store });
}

function windowWith(...held: number[]): Row[] {
  return held.map((i) => heldRow(i));
}

const dumpsIn = (window: Row[], channelId?: string): string[] =>
  window
    .filter((m) => m.metadata?.kind === 'tune-out-cancel' && (channelId === undefined || m.metadata.channelId === channelId))
    .map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''));

function timesShown(window: Row[], lines: string[]): Record<string, number> {
  const all = dumpsIn(window).join('\n');
  return Object.fromEntries(lines.map((line) => [line, all.split(`: ${line}\n`).length - 1]));
}

function coordinatorOn(
  registry: ChannelRegistry,
  window: Row[],
  opts: {
    failDump?: boolean;
    durable?: () => boolean;
    onDump?: (c: TuneOutCoordinator) => void;
    queued?: Array<Row & { writeId: string }>;
    reports?: string[];
    inferences?: string[];
    failWake?: boolean;
    anchors?: number[];
    traces?: string[];
  } = {},
) {
  let failDump = opts.failDump === true;
  let failWake = opts.failWake === true;
  let rows = 0;
  let coordinator!: TuneOutCoordinator;
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>) => {
      if (metadata?.kind === 'tune-out-cancel') {
        if (failDump) { failDump = false; throw new Error('the store refused the write'); }
        window.push({ id: `dump-${++rows}`, participant, content, metadata });
        opts.onDump?.(coordinator);
      } else if (metadata?.kind === 'tune-out-cancel-report') {
        opts.reports?.push(content.map((b) => (b as { text?: string }).text ?? '').join(''));
      }
    },
    commitDeliveries: () => opts.durable?.() ?? true,
    requestInference: (_agent: string, reason: string) => {
      if (failWake) { failWake = false; throw new Error('the wake request failed'); }
      opts.inferences?.push(reason);
    },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => window,
    getDeferredMessages: () => opts.queued ?? [],
    emitTrace: (e: { type: string }) => { opts.traces?.push(e.type); },
    currentSequence: () => 1,
    setSubconsciousAnchor: (sequence: number) => { opts.anchors?.push(sequence); },
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
  };
  coordinator = new TuneOutCoordinator(registry, {} as never, hooks as never);
  return coordinator;
}

function failingEnd(registry: ChannelRegistry, failures = 1): void {
  const end = registry.cancelTuneOut.bind(registry);
  let left = failures;
  registry.cancelTuneOut = (...args: Parameters<ChannelRegistry['cancelTuneOut']>) => {
    if (left > 0) { left--; throw new Error('the lifecycle write failed'); }
    return end(...args);
  };
}

function withStore(run: (store: JsStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-cancel-order-'));
  try {
    run(JsStore.openOrCreate({ path: join(dir, 'store') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HELD = ['held 1', 'held 2', 'held 3'];
const once = (lines: string[]) => Object.fromEntries(lines.map((line) => [line, 1]));

test('a cancel whose dump fails leaves the tune-out on record, and after a restart its cancel delivers the held messages', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const first = registryOn(store);
    first.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    const before = coordinatorOn(first, window, { failDump: true });
    assert.throws(() => before.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the store refused the write/);
    before.stop();
    assert.deepEqual(dumpsIn(window), []);

    const second = registryOn(store);
    assert.equal(second.getTuneOutState('disc', CHANNEL)?.params.epochId, 'eA', 'the tune-out is still on record');
    const after = coordinatorOn(second, window);
    assert.deepEqual(after.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    after.stop();
    assert.deepEqual(timesShown(window, HELD), once(HELD));
    assert.equal(second.getTuneOutState('disc', CHANNEL), null);
  });
});

test('a cancel retried after its dump was written and its end record failed shows each held message once, and ends the tune-out', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    failingEnd(registry);
    const coordinator = coordinatorOn(registry, window);
    assert.throws(() => coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the lifecycle write failed/);
    assert.equal(dumpsIn(window).length, 1, 'the dump was written before the end record failed');
    assert.equal(registry.getTuneOutState('disc', CHANNEL)?.params.epochId, 'eA', 'the tune-out is still in force');
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.equal(dumpsIn(window).length, 1, 'the retry writes no second dump');
    assert.deepEqual(timesShown(window, HELD), once(HELD));
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
  });
});

test('a message held after a dump whose end record failed reaches the resident once, and every message the first dump showed is shown once', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    failingEnd(registry);
    const coordinator = coordinatorOn(registry, window);
    assert.throws(() => coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the lifecycle write failed/);
    assert.equal(dumpsIn(window).length, 1, 'the dump was written before the end record failed');
    window.push(heldRow(4));
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.deepEqual(timesShown(window, [...HELD, 'held 4']), once([...HELD, 'held 4']));
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
  });
});

test('after a restart between a written dump and its failed end record, the next cancel shows nothing a second time', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const first = registryOn(store);
    first.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    failingEnd(first);
    const before = coordinatorOn(first, window);
    assert.throws(() => before.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the lifecycle write failed/);
    assert.equal(dumpsIn(window).length, 1, 'the dump was written before the end record failed');
    before.stop();

    const second = registryOn(store);
    assert.equal(second.getTuneOutState('disc', CHANNEL)?.params.epochId, 'eA', 'the tune-out is still on record');
    const after = coordinatorOn(second, window);
    assert.deepEqual(after.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    after.stop();
    assert.equal(dumpsIn(window).length, 1, 'the cancel after the restart writes no second dump');
    assert.deepEqual(timesShown(window, HELD), once(HELD));
    assert.equal(second.getTuneOutState('disc', CHANNEL), null);
  });
});

test('a rollback that takes away a written dump before the tune-out ends leaves its messages to the next cancel', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    failingEnd(registry);
    const coordinator = coordinatorOn(registry, window);
    assert.throws(() => coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the lifecycle write failed/);
    assert.equal(dumpsIn(window).length, 1, 'the dump was written before the end record failed');
    window.splice(0, window.length, ...window.filter((m) => m.metadata?.kind !== 'tune-out-cancel'));
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.deepEqual(timesShown(window, HELD), once(HELD));
  });
});

test('a cancel whose dump could not be made durable leaves the tune-out in force, and its retry ends it showing each message once', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    let durable = false;
    const coordinator = coordinatorOn(registry, window, { durable: () => durable });
    assert.throws(() => coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), /could not be made durable/);
    assert.equal(registry.getTuneOutState('disc', CHANNEL)?.params.epochId, 'eA', 'the tune-out is still in force');
    durable = true;
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.deepEqual(timesShown(window, HELD), once(HELD));
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
  });
});

test('a cancel of the same channel made while its dump is being written is refused, and the dump is written once', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    const nested: Array<{ ok: boolean; error?: string }> = [];
    let reentered = false;
    const coordinator = coordinatorOn(registry, window, {
      onDump: (c) => {
        if (reentered) return;
        reentered = true;
        nested.push(c.cancel('disc', CHANNEL, 'agent-tool', 'nested'));
      },
    });
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.equal(nested.length, 1);
    assert.equal(nested[0]!.ok, false);
    assert.match(nested[0]!.error ?? '', /already in progress/);
    assert.deepEqual(timesShown(window, HELD), once(HELD));
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
  });
});

test('a cancel retried in the same process after its dump failed shows each held message once, and ends the tune-out', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    const coordinator = coordinatorOn(registry, window, { failDump: true });
    assert.throws(() => coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the store refused the write/);
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.deepEqual(timesShown(window, HELD), once(HELD));
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
  });
});

test('a message queued at a dump whose end record failed, which lands before the retry, is not dumped again', () => {
  withStore((store) => {
    const window = windowWith(1, 2);
    const queued: Array<Row & { writeId: string }> = [{ ...heldRow(3), id: 'q', writeId: 'w3' }];
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, PARAMS, 'agent-tool');
    failingEnd(registry);
    const coordinator = coordinatorOn(registry, window, { queued });
    assert.throws(() => coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the lifecycle write failed/);
    assert.equal(dumpsIn(window).length, 1, 'the dump was written before the end record failed');
    const landed = queued.shift()!;
    window.push({ id: 'h3-stored', participant: landed.participant, content: landed.content, metadata: { ...landed.metadata, deferredWriteId: landed.writeId } });
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.equal(dumpsIn(window).length, 1, 'the retry writes no second dump');
    assert.deepEqual(timesShown(window, ['held 1', 'held 2', 'held 3']), once(['held 1', 'held 2', 'held 3']));
  });
});

test("the subconscious's report after a retry says what each dump left out, counting a dump stored in shards once", () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const reports: string[] = [];
    const registry = registryOn(store);
    registry.enterTuneOut('disc', CHANNEL, { ...PARAMS, backlogCap: 2 }, 'agent-tool');
    failingEnd(registry);
    const coordinator = coordinatorOn(registry, window, { reports });
    assert.throws(() => coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), /the lifecycle write failed/);
    const dump = window.find((m) => m.metadata?.kind === 'tune-out-cancel')!;
    window.push({ ...dump, id: 'dump-1-shard-2' });
    window.push(heldRow(4), heldRow(5), heldRow(6));
    assert.deepEqual(coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test'), { ok: true });
    coordinator.stop();
    assert.equal(reports.length, 1, reports.join('\n'));
    const second = dumpsIn(window).at(-1)!;
    assert.ok(['held 1', 'held 2', 'held 3'].every((line) => !second.includes(line)), `the second dump leaves out what the first covered, its cap's cut included: ${second}`);
    assert.match(reports[0]!, /Of the 2 dumps' diverted messages, 1 of 3 in dump 1 and 1 of 3 in dump 2, the oldest of each, weren't delivered raw to the resident\./);
  });
});

test('a start whose expired tune-out cannot be made durable still starts and arms the others, and its retry delivers once durability returns', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  withStore((store) => {
    const other = 'disc:guild:b';
    const window = [heldRow(1), heldRow(2), { ...heldRow(7, other, 'eB'), id: 'b7' }];
    const first = registryOn(store);
    first.enterTuneOut('disc', CHANNEL, { ...PARAMS, cadenceSeconds: 30, expiresAtMs: 1_000_000 - 1 }, 'agent-tool');
    first.enterTuneOut('disc', other, { ...PARAMS, epochId: 'eB', expiresAtMs: 1_000_000 + 120_000 }, 'agent-tool');
    const registry = registryOn(store);
    registry.listChannelsRaw = (() => [CHANNEL, other].map((id) => ({ serverId: 'disc', descriptor: { id } }))) as never;
    let durable = false;
    const inferences: string[] = [];
    const coordinator = coordinatorOn(registry, window, { durable: () => durable, inferences });
    t.mock.method(console, 'error', () => {});
    assert.doesNotThrow(() => coordinator.resumeActiveEpochs());
    assert.equal(registry.getTuneOutState('disc', CHANNEL)?.params.epochId, 'eA', 'the expired tune-out stays in force');
    t.mock.timers.tick(30_000);
    assert.ok(inferences.some((r) => r.startsWith('tune-out cadence')), `its cadence look comes before the retry: ${inferences.join('; ')}`);
    durable = true;
    t.mock.timers.tick(30_000);
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null, 'its retry ended it');
    assert.equal(dumpsIn(window, CHANNEL).filter((d) => d.includes('held 1')).length, 1);
    assert.deepEqual(timesShown(window, ['held 1', 'held 2']), once(['held 1', 'held 2']));
    t.mock.timers.tick(60_000);
    assert.equal(registry.getTuneOutState('disc', other), null, 'the other tune-out ended at its own end time');
    assert.equal(dumpsIn(window, other).length, 1);
    coordinator.stop();
  });
});

test('a tune-out already past its wake budget at the start is cancelled there', () => {
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const first = registryOn(store);
    first.enterTuneOut('disc', CHANNEL, { ...PARAMS, maxWakes: 1 }, 'agent-tool');
    first.recordTuneOutWake('disc', CHANNEL);
    first.recordTuneOutWake('disc', CHANNEL);
    const registry = registryOn(store);
    registry.listChannelsRaw = (() => [{ serverId: 'disc', descriptor: { id: CHANNEL } }]) as never;
    const coordinator = coordinatorOn(registry, window);
    coordinator.resumeActiveEpochs();
    coordinator.stop();
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
    assert.deepEqual(timesShown(window, HELD), once(HELD));
  });
});

test('a start whose expired tune-out ends but then fails a step after the end goes on, and treats it as ended', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const first = registryOn(store);
    first.enterTuneOut('disc', CHANNEL, { ...PARAMS, expiresAtMs: 1_000_000 - 1 }, 'agent-tool');
    const registry = registryOn(store);
    registry.listChannelsRaw = (() => [{ serverId: 'disc', descriptor: { id: CHANNEL } }]) as never;
    let ends = 0;
    const end = registry.cancelTuneOut.bind(registry);
    registry.cancelTuneOut = (...args: Parameters<ChannelRegistry['cancelTuneOut']>) => { ends++; return end(...args); };
    const anchors: number[] = [];
    const coordinator = coordinatorOn(registry, window, { failWake: true, anchors });
    const errors = t.mock.method(console, 'error', () => {});
    assert.doesNotThrow(() => coordinator.resumeActiveEpochs());
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null, 'its end was recorded');
    assert.deepEqual(anchors, [], 'no tune-out in force anchors the subconscious');
    const said = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    assert.ok(!/stays tuned out/.test(said), said);
    t.mock.timers.tick(10 * 60_000);
    coordinator.stop();
    assert.equal(ends, 1, 'nothing tries to end it again');
    assert.equal(dumpsIn(window).length, 1);
  });
});

test('a tune-out past its wake budget whose cancel fails at the start says so as the start, stays in force, and its retry ends it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const first = registryOn(store);
    first.enterTuneOut('disc', CHANNEL, { ...PARAMS, maxWakes: 1 }, 'agent-tool');
    first.recordTuneOutWake('disc', CHANNEL);
    first.recordTuneOutWake('disc', CHANNEL);
    const registry = registryOn(store);
    registry.listChannelsRaw = (() => [{ serverId: 'disc', descriptor: { id: CHANNEL } }]) as never;
    let durable = false;
    const traces: string[] = [];
    const coordinator = coordinatorOn(registry, window, { durable: () => durable, traces });
    const errors = t.mock.method(console, 'error', () => {});
    assert.doesNotThrow(() => coordinator.resumeActiveEpochs());
    assert.equal(registry.getTuneOutState('disc', CHANNEL)?.params.epochId, 'eA', 'it stays in force');
    assert.ok(!traces.includes('tune-out:timer-failed'), 'no timer fired, so none is reported as failing');
    const said = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    assert.match(said, /past its wake budget at start/);
    durable = true;
    t.mock.timers.tick(60_000);
    coordinator.stop();
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null, 'its retry ended it');
    assert.deepEqual(timesShown(window, HELD), once(HELD));
  });
});

test('a tune-out past its wake budget whose cancel ends it at the start and then fails a later step is reported as ended', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  withStore((store) => {
    const window = windowWith(1, 2, 3);
    const first = registryOn(store);
    first.enterTuneOut('disc', CHANNEL, { ...PARAMS, maxWakes: 1 }, 'agent-tool');
    first.recordTuneOutWake('disc', CHANNEL);
    first.recordTuneOutWake('disc', CHANNEL);
    const registry = registryOn(store);
    registry.listChannelsRaw = (() => [{ serverId: 'disc', descriptor: { id: CHANNEL } }]) as never;
    const coordinator = coordinatorOn(registry, window, { failWake: true });
    const errors = t.mock.method(console, 'error', () => {});
    assert.doesNotThrow(() => coordinator.resumeActiveEpochs());
    assert.equal(registry.getTuneOutState('disc', CHANNEL), null, 'its end was recorded');
    const said = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    assert.match(said, /past its wake budget at start and its cancel ended it/);
    assert.ok(!/stays tuned out/.test(said), said);
    t.mock.timers.tick(10 * 60_000);
    coordinator.stop();
    assert.equal(dumpsIn(window).length, 1);
  });
});
