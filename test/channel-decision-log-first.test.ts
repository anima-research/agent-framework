/**
 * A durable write that fails leaves memory as it was (the first part of
 * #417). Each writer of the channel registry's lifecycle and label logs
 * appends to the store before it changes memory. So an operation whose
 * append throws, as on a full disk, fails without its change, a retry
 * records it rather than taking a same-state return, and a registry rebuilt
 * from the store replays what memory held. A record that changes no memory,
 * a decline's of the invitation it declined, is written once the decline has
 * taken effect, so its failure goes to the operator's log instead. Before, memory changed first: a retried `channel_close`
 * reported success without recording anything, and after a restart the
 * old record came back, so subscription policy could lift a close the
 * agent had been told succeeded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry, type TuneOutParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const LIFECYCLE = 'mcpl/channel-lifecycle';
const LABELS = 'mcpl/channel-label-history';
const DISK_FULL = /ENOSPC: no space left on device/;

type Write = { id: string; item: unknown };

/**
 * The real store, made to throw on one chosen append as a full disk would.
 * It carries the calls the registry makes here.
 */
function failingStore(path: string) {
  const real = JsStore.openOrCreate({ path });
  let chosen: ((write: Write) => boolean) | undefined;
  let message = '';
  const throwIfChosen = (write: Write) => {
    if (chosen?.(write)) {
      chosen = undefined;
      throw new Error(message);
    }
  };
  const store = {
    registerState: (opts: Parameters<JsStore['registerState']>[0]) => real.registerState(opts),
    getStateJson: (id: string) => real.getStateJson(id),
    appendToStateJson: (id: string, item: unknown) => {
      throwIfChosen({ id, item });
      return real.appendToStateJson(id, item as never);
    },
  } as unknown as JsStore;
  return {
    store,
    failNext: (choose: (write: Write) => boolean, words = 'ENOSPC: no space left on device') => {
      chosen = choose;
      message = words;
    },
    close: () => real.close(),
  };
}

function withStore(
  name: string,
  body: (store: ReturnType<typeof failingStore>) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), `${name}-`));
    let opened: ReturnType<typeof failingStore> | undefined;
    try {
      opened = failingStore(join(dir, 'store'));
      await body(opened);
    } finally {
      // Closed before its directory goes, however the test ended.
      try {
        opened?.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

function makeRegistry(store: JsStore) {
  const openCalls: string[] = [];
  const closeCalls: string[] = [];
  const ackCalls: string[] = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async (params: { channelId: string }) => {
      openCalls.push(params.channelId);
      return {};
    },
    sendChannelsClose: async (params: { channelId: string }) => {
      closeCalls.push(params.channelId);
      return {};
    },
    sendChannelsAcknowledge: async (params: { messageId: string }) => {
      ackCalls.push(params.messageId);
      return { acknowledged: true, representation: 'not now' };
    },
    sendChannelsPublish: undefined as undefined | (() => Promise<unknown>),
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { store },
  );
  return { registry, openCalls, closeCalls, ackCalls, server };
}

/** The decision on record in memory, with its source. */
function decision(registry: ChannelRegistry, channelId: string) {
  const internals = registry as unknown as {
    desiredStates: Map<string, { state: string; source: string }>;
    lifecycleKey(serverId: string, channelId: string): string;
  };
  const record = internals.desiredStates.get(internals.lifecycleKey('discord', channelId));
  return record && { state: record.state, source: record.source };
}

const commons = { id: 'c1', type: 'discord', label: '#commons', direction: 'bidirectional' as const };
const ops = { id: 'c2', type: 'discord', label: '#ops', direction: 'bidirectional' as const };

const PARAMS: TuneOutParams = {
  epochId: 'epoch-1',
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
  startedAtSequence: 42,
};

const lifecycleWrite = ({ id }: Write) => id === LIFECYCLE;
const decisionWrite = ({ id, item }: Write) =>
  id === LIFECYCLE && (item as { kind?: string }).kind === 'desired-state';

test('a channel_close whose record fails to append answers that nothing changed and leaves the channel open; its retry records the close a restart replays', withStore('log-first-close', async ({ store, failNext }) => {
  const { registry, closeCalls } = makeRegistry(store);
  await registry.handleRegister('discord', { channels: [commons] });
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'c1' })).success, true);
  assert.deepEqual(decision(registry, 'c1'), { state: 'open', source: 'agent-tool' });
  const closesBefore = closeCalls.length;

  failNext(lifecycleWrite);
  const failed = await registry.handleChannelToolCall('channel_close', { channelId: 'c1' });
  assert.equal(failed.success, false);
  assert.equal(failed.isError, true);
  assert.match(failed.error ?? '', DISK_FULL);
  assert.match(failed.error ?? '', /^Nothing changed for channel "c1": this host couldn't record the decision: .*, so nothing was sent to the server\. Calling channel_close again tries again; if it fails the same way, ask whoever runs this host\.$/);
  assert.deepEqual(decision(registry, 'c1'), { state: 'open', source: 'agent-tool' });
  assert.equal(closeCalls.length, closesBefore, 'nothing went to the server');

  const retried = await registry.handleChannelToolCall('channel_close', { channelId: 'c1' });
  assert.deepEqual(retried.data, { channelId: 'c1', serverId: 'discord', status: 'closed' });
  assert.deepEqual(decision(registry, 'c1'), { state: 'closed', source: 'agent-tool' });

  const restarted = makeRegistry(store).registry;
  assert.deepEqual(decision(restarted, 'c1'), { state: 'closed', source: 'agent-tool' });
}));

test('a channel_open whose decision fails to append answers the failure and opens nothing; its retry records the open a restart replays', withStore('log-first-open', async ({ store, failNext }) => {
  const { registry, openCalls } = makeRegistry(store);
  await registry.handleRegister('discord', { channels: [commons] });
  const before = decision(registry, 'c1');
  assert.equal(before?.state, 'closed');
  const opensBefore = openCalls.length;

  failNext(decisionWrite);
  const failed = await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });
  assert.equal(failed.success, false);
  assert.match(failed.error ?? '', DISK_FULL);
  // A decision never recorded isn't read as one a later decision overtook.
  assert.match(failed.error ?? '', /^Nothing changed for channel "c1": this host couldn't record the decision: .*, so nothing was sent to the server\. Calling channel_open again tries again; if it fails the same way, ask whoever runs this host\.$/);
  assert.deepEqual(decision(registry, 'c1'), before);
  assert.equal(openCalls.length, opensBefore, 'nothing went to the server');

  const retried = await registry.handleChannelToolCall('channel_open', { channelId: 'c1' });
  assert.equal(retried.success, true);
  assert.equal(openCalls.length, opensBefore + 1);
  const restarted = makeRegistry(store).registry;
  assert.deepEqual(decision(restarted, 'c1'), { state: 'open', source: 'agent-tool' });
}));

test('a channel_decline whose decision fails to append answers that nothing changed and acknowledges nothing; its retry records the decline a restart replays', withStore('log-first-decline', async ({ store, failNext }) => {
  // A channel first seen in a push has no decision yet, so the decline's
  // decision is a change of state and has a record to append.
  const { registry, ackCalls } = makeRegistry(store);
  registry.ensureChannelRegistered('discord', 'c7', '#lobby');
  assert.equal(registry.getDesiredState('discord', 'c7'), undefined);
  const decline = { channelId: 'c7', messageId: 'm1', acknowledge: 'not now' };

  failNext(decisionWrite);
  const failed = await registry.handleChannelToolCall('channel_decline', decline);
  assert.equal(failed.success, false);
  assert.equal(failed.isError, true);
  assert.match(failed.error ?? '', DISK_FULL);
  assert.match(failed.error ?? '', /^Nothing changed for channel "c7": this host couldn't record the decision: .*, so no acknowledgment was posted and nothing was sent to the server\. Calling channel_decline again tries again; if it fails the same way, ask whoever runs this host\.$/);
  assert.equal(registry.getDesiredState('discord', 'c7'), undefined);
  assert.equal(ackCalls.length, 0, 'nothing went to the server');

  const retried = await registry.handleChannelToolCall('channel_decline', decline);
  assert.equal((retried.data as { status?: string }).status, 'remained closed');
  assert.deepEqual(ackCalls, ['m1']);
  const restarted = makeRegistry(store).registry;
  assert.deepEqual(decision(restarted, 'c7'), { state: 'closed', source: 'invitation-declined' });
}));

test('speech whose open fails to append its decision says nothing changed, and what helps', withStore('log-first-speech', async ({ store, failNext }) => {
  const { registry, openCalls, server } = makeRegistry(store);
  server.sendChannelsPublish = async () => ({ delivered: true });
  registry.ensureChannelRegistered('discord', 'c1', '#commons');
  // A store's words that end in a period lose it where the reason composes
  // them.
  failNext(decisionWrite, 'The disk is full.');
  const outcome = await registry.deliverSpeech('agent', 'hello', { serverId: 'discord', channelId: 'c1' });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, "opening the channel for these words didn't complete: this host couldn't record the decision: " +
    'The disk is full, so try again; if it fails the same way, ask whoever runs this host');
  assert.equal(registry.getDesiredState('discord', 'c1'), undefined);
  assert.deepEqual(openCalls, [], 'nothing went to the server');
}));

test('a channel_decline whose declined invitation fails to append still declines, and tells the operator', withStore('log-first-declined-record', async ({ store, failNext }) => {
  // The record of the invitation declined is an audit record, written once
  // the decline has taken effect: the decision, the acknowledgment and the
  // close.
  const { registry, ackCalls } = makeRegistry(store);
  registry.ensureChannelRegistered('discord', 'c7', '#lobby');
  failNext(({ id, item }) => id === LIFECYCLE && (item as { kind?: string }).kind === 'invitation-declined');
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  let declined;
  try {
    declined = await registry.handleChannelToolCall('channel_decline', { channelId: 'c7', messageId: 'm1', acknowledge: 'not now' });
  } finally {
    console.error = original;
  }
  assert.equal(declined.success, true);
  assert.equal((declined.data as { status?: string }).status, 'remained closed');
  assert.deepEqual(ackCalls, ['m1'], 'the acknowledgment went out once');
  assert.deepEqual(decision(registry, 'c7'), { state: 'closed', source: 'invitation-declined' });
  assert.ok(lines.some((line) => line.startsWith('[channel-decline]') && DISK_FULL.test(line)), lines.join('\n'));
}));

test('a tune-out whose record fails to append fails and leaves the channel undecided; its retry is what a restart replays', withStore('log-first-tune-out', ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  failNext(lifecycleWrite);
  assert.throws(() => registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool'), DISK_FULL);
  assert.equal(registry.getDesiredState('discord', 'c1'), undefined);
  assert.equal(registry.getTuneOutState('discord', 'c1'), null);

  registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool');
  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.getTuneOutState('discord', 'c1'), { params: PARAMS, wakeCount: 0 });
}));

test('a tune-out wake whose record fails to append fails uncounted; its retry counts once, as a restart replays', withStore('log-first-wake', ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool');

  failNext(lifecycleWrite);
  assert.throws(() => registry.recordTuneOutWake('discord', 'c1'), DISK_FULL);
  assert.deepEqual(registry.getTuneOutState('discord', 'c1'), { params: PARAMS, wakeCount: 0 });

  assert.deepEqual(registry.recordTuneOutWake('discord', 'c1'), { params: PARAMS, wakeCount: 1 });
  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.getTuneOutState('discord', 'c1'), { params: PARAMS, wakeCount: 1 });
}));

test('a tune-out cancel whose record fails to append fails and leaves the tune-out in place; its retry ends it, as a restart replays', withStore('log-first-cancel', ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool');

  failNext(lifecycleWrite);
  assert.throws(() => registry.cancelTuneOut('discord', 'c1', 'open', 'agent-tool'), DISK_FULL);
  assert.equal(registry.getDesiredState('discord', 'c1'), 'tuned-out');

  assert.deepEqual(registry.cancelTuneOut('discord', 'c1', 'open', 'agent-tool'), { params: PARAMS, wakeCount: 0 });
  const restarted = makeRegistry(store).registry;
  assert.equal(restarted.getDesiredState('discord', 'c1'), 'open');
  assert.equal(restarted.getTuneOutState('discord', 'c1'), null);
}));

test('a recipe migration whose record fails to append runs again at the next registration, so after a restart a new channel is one nobody decided about', withStore('log-first-migration', async ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  registry.setSubscriptionPolicy('discord', ['c1']);
  failNext(({ id, item }) => id === LIFECYCLE && (item as { kind?: string }).kind === 'legacy-policy-migrated');
  await assert.rejects(registry.handleRegister('discord', { channels: [commons] }), DISK_FULL);
  await registry.handleRegister('discord', { channels: [commons] });
  assert.deepEqual(decision(registry, 'c1'), { state: 'open', source: 'legacy-recipe-migration' });

  // The recipe's allow-list doesn't name c2. Migrated again, it would
  // record c2 closed as the recipe's decision, which policy never lifts.
  const restarted = makeRegistry(store).registry;
  restarted.setSubscriptionPolicy('discord', ['c1']);
  await restarted.handleRegister('discord', { channels: [commons, ops] });
  assert.deepEqual(decision(restarted, 'c2'), { state: 'closed', source: 'default-closed' });
}));

test('a label sighting whose record fails to append is recorded at the next sighting, so a restart still finds the channel by its label', withStore('log-first-label', async ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  failNext(({ id }) => id === LABELS);
  await assert.rejects(registry.handleRegister('discord', { channels: [commons] }), DISK_FULL);
  await registry.handleRegister('discord', { channels: [commons] });

  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.resolveProseTargetDurable('#commons'), { channelId: 'c1', label: '#commons' });
}));

test('a label first seen in a push, whose sighting fails to append, is recorded by the next push, so a restart still finds the channel by its label', withStore('log-first-push-label', ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  // A bare lazy registration, then a push that reveals its label.
  registry.ensureChannelRegistered('discord', 'c9');
  failNext(({ id }) => id === LABELS);
  assert.throws(() => registry.ensureChannelRegistered('discord', 'c9', '#commons'), DISK_FULL);
  assert.ok('error' in registry.resolveProseTarget('#commons'), 'the live descriptor keeps its placeholder');
  registry.ensureChannelRegistered('discord', 'c9', '#commons');

  // A channel whose first push carries its label.
  failNext(({ id }) => id === LABELS);
  assert.throws(() => registry.ensureChannelRegistered('discord', 'c8', '#ops'), DISK_FULL);
  assert.ok('error' in registry.resolveProseTarget('c8'), 'nothing is registered');
  registry.ensureChannelRegistered('discord', 'c8', '#ops');

  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.resolveProseTargetDurable('#commons'), { channelId: 'c9', label: '#commons' });
  assert.deepEqual(restarted.resolveProseTargetDurable('#ops'), { channelId: 'c8', label: '#ops' });
}));

test('a DM recipient whose sighting fails to append is recorded at the next sighting, so a restart still finds the DM by its mention', withStore('log-first-dm', async ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  const dm = (metadata: Record<string, unknown>) =>
    ({ id: 'discord:dm:antra', type: 'discord', label: 'DM: antra', direction: 'bidirectional' as const, metadata });
  await registry.handleRegister('discord', { channels: [dm({ channelType: 'dm' })] });

  // The same label, now with the recipient's id.
  failNext(({ id }) => id === LABELS);
  await assert.rejects(registry.handleRegister('discord', { channels: [dm({ channelType: 'dm', recipientId: '123456789' })] }), DISK_FULL);
  await registry.handleRegister('discord', { channels: [dm({ channelType: 'dm', recipientId: '123456789' })] });

  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.resolveProseTargetDurable('<@123456789>'), { channelId: 'discord:dm:antra', label: 'DM: antra' });
}));
