import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { fixture, eventually, REPLY_DEADLINE_MS, TS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import type { TuneOutParams } from '../src/mcpl/channel-registry.js';
import { SUB, internals, incoming, registerOpen, enter, stored, find, held, inWindow, textOf, type Fixture } from './helpers/admission.js';

type Coordinator = {
  cadenceTimers: Map<string, unknown>;
  expiryTimers: Map<string, unknown>;
  pendingWakes: Map<string, unknown>;
  divertedSinceInvocation: Map<string, number>;
  activeEpochIds(): string[];
  getAllExcept(): { params: { epochId: string } } | null;
  enterAllExcept(except: { serverId: string; channelId: string }, opts: Record<string, number>, source: string): { ok: boolean };
  scheduleWakeInvocation(serverId: string, channelId: string): void;
  runDeferredCancels(): void;
  deferredCancels: Map<string, unknown>;
  hooks: { getStoredMessages(): unknown[] };
  noteDisposition(key: string, text: string): void;
  getDispositionsInjection(): { content: Array<{ text: string }> } | null;
};
type Registry = {
  getDesiredState(serverId: string, channelId: string): string | undefined;
  getTuneOutState(serverId: string, channelId: string): { params: { epochId: string; startedAtSequence: number } } | null;
  channels: Map<string, { open: boolean }>;
  handleChannelToolCall(tool: string, input: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  enterTuneOut(serverId: string, channelId: string, params: TuneOutParams, source: string): void;
  recordTuneOutWake(serverId: string, channelId: string): unknown;
  readCoordinatorState(stateId: string): unknown;
  applyDesiredChannelState(serverId: string, channelId: string, options?: unknown): Promise<unknown>;
  channelLifecycleTails: Map<string, unknown>;
  labelHistory: Map<string, string>;
  setSubscriptionPolicy(serverId: string, policy: 'auto' | 'manual' | string[]): void;
  ensureInitialDesiredState(serverId: string, channel: unknown): boolean;
  ensureChannelRegistered(serverId: string, channelId: string, label?: string): void;
  branchMoved(): void;
  desiredStates: Map<string, { state: string; source: string }>;
  store: { getStateJson(id: string): unknown };
};
type Moves = {
  rollbackToMessage(agent: string, opts: { messageId: string }): Promise<{ sourceBranch: string; targetBranch: string }>;
  switchBranch(name: string): Promise<void>;
  suppressMessages(agent: string, opts: { messageIds: string[] }): Promise<unknown>;
};

const key = (channelId: string): string => JSON.stringify(['editor', channelId]);
const SCOPE = 'all-except';
const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const coordinatorOf = (f: Fixture): Coordinator => internals(f).tuneOutCoordinator as unknown as Coordinator;
const registryOf = (f: Fixture): Registry => internals(f).channelRegistry as unknown as Registry;
const moves = (f: Fixture): Moves => f.framework as unknown as Moves;
const write = (f: Fixture, t: string): string => String(f.framework.getAgent('agent')!.getContextManager().addMessage('user', [text(t)]));
const branchNow = (f: Fixture): string => f.framework.getStore().currentBranch().name;
const withSub = () => fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });

function appliedChannels(registry: Registry): string[] {
  const applied: string[] = [];
  const apply = registry.applyDesiredChannelState.bind(registry);
  registry.applyDesiredChannelState = (serverId, channelId, options) => { applied.push(channelId); return apply(serverId, channelId, options); };
  return applied;
}

async function settlesSoon<T>(move: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([move, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} waited`)), REPLY_DEADLINE_MS); })]);
  } finally { clearTimeout(timer); }
}

type Lane = 'channels/incoming' | 'push/event';

function send(f: Fixture, lane: Lane, channelId: string, t: string): Promise<unknown> {
  return lane === 'channels/incoming'
    ? incoming(f, channelId, `m-${channelId}-during`, t)
    : f.send('push/event', {
      featureSet: 'doc', eventId: `p-${channelId}-during`, timestamp: TS, payload: { content: [text(t)] },
      origin: { mcplChannelId: channelId, messageId: `m-${channelId}-during`, authorId: 'U1', authorName: 'ann' }, tags: ['chat:mention'],
    });
}

async function arriveDuringMove<T>(f: Fixture, channelId: string, t: string, move: () => Promise<T>, onKept?: () => void, lane: Lane = 'channels/incoming'): Promise<{ moved: T; keptMark: string | undefined }> {
  const fw = f.framework as unknown as {
    followBranchMove(...a: unknown[]): Promise<unknown>;
    processNextEvent(): Promise<void>;
    surgeryHeldWrites: Array<{ content: ContentBlock[]; metadata?: { tuneOut?: { epochId?: string } } }>;
  };
  const keptOf = () => fw.surgeryHeldWrites.find((w) => w.content.some((b) => (b as { text?: string }).text?.includes(t)));
  const follow = fw.followBranchMove.bind(fw);
  let sent: Promise<unknown> | undefined;
  let keptMark: string | undefined;
  fw.followBranchMove = async (...a: unknown[]) => {
    f.alwaysRespond();
    sent = send(f, lane, channelId, t);
    const deadline = Date.now() + REPLY_DEADLINE_MS;
    while (keptOf() === undefined) {
      const left = deadline - Date.now();
      assert.ok(left > 0, 'premise: kept in memory as it arrived during the move');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([fw.processNextEvent(), new Promise<void>((resolve) => { timer = setTimeout(resolve, left); })]);
      } finally { clearTimeout(timer); }
    }
    keptMark = keptOf()!.metadata?.tuneOut?.epochId;
    onKept?.();
    return follow(...a);
  };
  try {
    const moved = await move();
    await sent;
    await f.framework.runUntilIdle();
    return { moved, keptMark };
  } finally { fw.followBranchMove = follow; }
}

async function arrive(f: Fixture, channelId: string, messageId: string, t: string): Promise<void> {
  f.alwaysRespond();
  await incoming(f, channelId, messageId, t);
  await f.framework.runUntilIdle();
}

describe('a branch move takes the channels and holds of the branch moved to', () => {
  it("rolling back to before a tune-out ends it at once: the channel is decided open, no hold is active, its timers stop, and its next message reaches the resident's window unheld", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the tune-out');
      enter(f, 'noisy', { durationSeconds: 3600 });
      await arrive(f, 'noisy', 'n0', 'held before the rollback');
      write(f, 'after the tune-out');
      const coordinator = coordinatorOf(f);
      assert.ok(coordinator.cadenceTimers.has(key('noisy')) && coordinator.expiryTimers.has(key('noisy')), 'premise: the hold has its timers');
      assert.ok((coordinator.divertedSinceInvocation.get(key('noisy')) ?? 0) > 0, 'premise: a held message counted');
      const registry = registryOf(f);
      await eventually(() => registry.channelLifecycleTails.size === 0, 'premise: no lifecycle work queued');
      const applied = appliedChannels(registry);

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(registry.getDesiredState('editor', 'noisy'), 'open');
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null);
      assert.deepEqual(coordinator.activeEpochIds(), []);
      assert.ok(!coordinator.cadenceTimers.has(key('noisy')) && !coordinator.expiryTimers.has(key('noisy')), "the hold's timers stopped");
      assert.equal(coordinator.divertedSinceInvocation.has(key('noisy')), false, "nothing is counted for the reader of a channel held nowhere");
      assert.deepEqual(applied, [], 'a channel decided open whose transport was open for the hold asks the server nothing');
      await arrive(f, 'noisy', 'n1', 'after the rollback');
      assert.equal(held(find(f, 'after the rollback')), false, 'stored unheld');
      f.present();
      assert.ok(inWindow(f, 'after the rollback'), "in the resident's window");
    } finally { await f.close(); }
  });

  it('switching back to the branch that holds the tune-out holds it again: the same epoch, its next message held, and its timers armed', async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the tune-out');
      enter(f, 'noisy', { durationSeconds: 3600 });
      const registry = registryOf(f);
      const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      write(f, 'after the tune-out');
      const { sourceBranch } = await moves(f).rollbackToMessage('agent', { messageId: before });
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'premise: the rollback ended it');
      assert.ok(!coordinatorOf(f).cadenceTimers.has(key('noisy')), 'premise: and stopped its timers');

      await moves(f).switchBranch(sourceBranch);

      assert.equal(registry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId);
      assert.deepEqual(coordinatorOf(f).activeEpochIds(), [epochId]);
      const coordinator = coordinatorOf(f);
      assert.ok(coordinator.cadenceTimers.has(key('noisy')) && coordinator.expiryTimers.has(key('noisy')), "the hold's timers are armed again");
      await arrive(f, 'noisy', 'n2', 'back on the source');
      const row = find(f, 'back on the source');
      assert.equal((row.metadata as { tuneOut?: { epochId?: string } }).tuneOut?.epochId, epochId, 'held under its epoch');
    } finally { await f.close(); }
  });

  it('the all-except hold leaves with a rollback to before it, its timers with it, and comes back with a switch to its branch', async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the hold');
      const coordinator = coordinatorOf(f);
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 3600 }, 'agent-tool').ok);
      const epochId = coordinator.getAllExcept()!.params.epochId;
      write(f, 'during the hold');
      assert.ok(coordinator.cadenceTimers.has(SCOPE) && coordinator.expiryTimers.has(SCOPE), 'premise: the hold has its timers');

      const { sourceBranch } = await moves(f).rollbackToMessage('agent', { messageId: before });
      assert.equal(coordinator.getAllExcept(), null);
      assert.ok(!coordinator.cadenceTimers.has(SCOPE) && !coordinator.expiryTimers.has(SCOPE), "the hold's timers stopped");

      await moves(f).switchBranch(sourceBranch);
      assert.equal(coordinator.getAllExcept()?.params.epochId, epochId);
      assert.ok(coordinator.cadenceTimers.has(SCOPE) && coordinator.expiryTimers.has(SCOPE), "the hold's timers are armed again");
    } finally { await f.close(); }
  });

  it("a hold whose end time passed while the store was on another branch ends at the switch back, its release stored once the switch releases the writes, with no start's notices", async () => {
    const f = await withSub();
    const errors: string[] = [];
    const error = mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the tune-out');
      enter(f, 'noisy', { durationSeconds: 60 });
      await arrive(f, 'noisy', 'n1', 'held on the source');
      const { sourceBranch } = await moves(f).rollbackToMessage('agent', { messageId: before });
      const coordinator = coordinatorOf(f);
      let waited = false;
      const run = coordinator.runDeferredCancels.bind(coordinator);
      coordinator.runDeferredCancels = () => {
        if (coordinator.deferredCancels.has(key('noisy')) && registryOf(f).getTuneOutState('editor', 'noisy')) waited = true;
        run();
      };
      mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
      try {
        await moves(f).switchBranch(sourceBranch);
      } finally { mock.timers.reset(); }

      assert.ok(waited, 'its cancel waited, the hold in force, for the writes the switch held');
      assert.equal(registryOf(f).getTuneOutState('editor', 'noisy'), null, 'its end time ended it');
      assert.equal(stored(f).filter((m) => textOf(m).includes('<tuned-out-backlog')).length, 1, 'its release stored once');
      assert.equal(stored(f).filter((m) => m.metadata?.kind === 'tune-out-end-unrecorded').length, 0, "no start's notice");
      assert.ok(!errors.some((e) => e.includes('while the process was down')), "nothing says the process was down");
    } finally { error.mock.restore(); await f.close(); }
  });

  it("control: a switch to the branch the store is on keeps a channel's hold and its timers as they are", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { durationSeconds: 3600 });
      const coordinator = coordinatorOf(f);
      const cadence = coordinator.cadenceTimers.get(key('noisy'));
      const expiry = coordinator.expiryTimers.get(key('noisy'));
      assert.ok(cadence && expiry, 'premise: the hold has its timers');
      const epochId = registryOf(f).getTuneOutState('editor', 'noisy')!.params.epochId;

      await moves(f).switchBranch(branchNow(f));

      assert.equal(registryOf(f).getTuneOutState('editor', 'noisy')?.params.epochId, epochId);
      assert.equal(coordinator.cadenceTimers.get(key('noisy')), cadence);
      assert.equal(coordinator.expiryTimers.get(key('noisy')), expiry);
    } finally { await f.close(); }
  });

  it("control: a switch to the branch the store is on keeps the all-except hold and its timers as they are", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const coordinator = coordinatorOf(f);
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 3600 }, 'agent-tool').ok);
      const epochId = coordinator.getAllExcept()!.params.epochId;
      const cadence = coordinator.cadenceTimers.get(SCOPE);
      const expiry = coordinator.expiryTimers.get(SCOPE);
      assert.ok(cadence && expiry, 'premise: the hold has its timers');

      await moves(f).switchBranch(branchNow(f));

      assert.equal(coordinator.getAllExcept()?.params.epochId, epochId);
      assert.equal(coordinator.cadenceTimers.get(SCOPE), cadence);
      assert.equal(coordinator.expiryTimers.get(SCOPE), expiry);
    } finally { await f.close(); }
  });

  it("a hold that both branches hold under one epoch, its wake budget spent on the branch moved to, ends at the switch though the move kept its timers", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { maxWakes: 1 });
      const registry = registryOf(f);
      const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      const forkPoint = write(f, 'after the tune-out');
      f.present();
      registry.recordTuneOutWake('editor', 'noisy');
      registry.recordTuneOutWake('editor', 'noisy');
      write(f, 'after the wakes');
      const { sourceBranch } = await moves(f).rollbackToMessage('agent', { messageId: forkPoint });
      const coordinator = coordinatorOf(f);
      assert.equal(registry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the branch moved to holds the same epoch');
      assert.ok(coordinator.cadenceTimers.has(key('noisy')), 'premise: its timers kept');

      await moves(f).switchBranch(sourceBranch);

      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'past its budget there, it ended');
    } finally { await f.close(); }
  });

  it("an all-except record that can't be read on the branch moved to is told, and the move goes on", async () => {
    const f = await withSub();
    const error = mock.method(console, 'error', () => {});
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before');
      write(f, 'cut by the rollback');
      const registry = registryOf(f);
      const read = registry.readCoordinatorState.bind(registry);
      registry.readCoordinatorState = (id: string) => {
        if (id.endsWith('/all-except')) throw new Error('injected read failure');
        return read(id);
      };
      try {
        await moves(f).rollbackToMessage('agent', { messageId: before });
      } finally { registry.readCoordinatorState = read; }

      const said = error.mock.calls.map((c) => String(c.arguments[0]));
      assert.ok(said.some((s) => s.includes('the tune-outs of the branch moved to could not be read')), 'told');
      assert.ok(!said.some((s) => s.includes('following a branch move failed')), 'and the move went on past it');
    } finally { error.mock.restore(); await f.close(); }
  });

  it("a channel decided closed on the branch moved to is closed at the server, and one decided open there is opened, without the move waiting for either", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the close');
      const registry = registryOf(f);
      assert.ok((await registry.handleChannelToolCall('channel_close', { channelId: 'noisy' })).success, 'premise: closed on the source');
      await eventually(() => registry.channels.get(key('noisy'))?.open === false, 'premise: closed at the server');
      write(f, 'after the close');

      f.holdReplies('channels/open');
      const sent = f.requests.length;
      const { sourceBranch } = await settlesSoon(moves(f).rollbackToMessage('agent', { messageId: before }), 'the rollback');
      assert.equal(registry.getDesiredState('editor', 'noisy'), 'open', 'decided open on the branch moved to');
      await eventually(() => f.requests.slice(sent).includes('channels/open'), 'the server is asked to open it');
      assert.equal(registry.channels.get(key('noisy'))?.open, false, 'its answer not in yet');
      f.releaseReplies();
      await eventually(() => registry.channels.get(key('noisy'))?.open === true, 'opened at the server');

      const requests = f.requests.length;
      f.holdReplies('channels/close');
      await settlesSoon(moves(f).switchBranch(sourceBranch), 'the switch');
      assert.equal(registry.getDesiredState('editor', 'noisy'), 'closed', 'decided closed on the branch moved back to');
      await eventually(() => f.requests.slice(requests).includes('channels/close'), 'the server is asked to close it');
      f.releaseReplies();
      await eventually(() => registry.channels.get(key('noisy'))?.open === false, 'closed at the server');
    } finally { await f.close(); }
  });

  it("a channel the agent opened after the branch point gets, on a rollback past it, the decision its registration made, and is closed at the server", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work');
      const before = write(f, 'before the channel came');
      await f.register('late');
      const registry = registryOf(f);
      await eventually(() => registry.getDesiredState('editor', 'late') === 'closed', 'premise: registered closed by default');
      assert.ok((await registry.handleChannelToolCall('channel_open', { channelId: 'late' })).success, 'premise: the agent opened it');
      await eventually(() => registry.channels.get(key('late'))?.open === true, 'premise: open at the server');
      write(f, 'after the channel came');

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(registry.getDesiredState('editor', 'late'), 'closed', "its registration's decision");
      assert.equal(registry.labelHistory.get('late'), 'late', "its registration's label sighting");
      await eventually(() => registry.channels.get(key('late'))?.open === false, 'closed at the server');
    } finally { await f.close(); }
  });

  it("a channel whose open a move sent is closed after that open fails, where the next move decides it closed", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the close');
      f.present();
      const registry = registryOf(f);
      assert.ok((await registry.handleChannelToolCall('channel_close', { channelId: 'noisy' })).success, 'premise: closed on the source');
      await eventually(() => registry.channels.get(key('noisy'))?.open === false, 'premise: closed at the server');
      write(f, 'after the close');
      f.holdReplies('channels/open');
      const sent = f.requests.length;
      const { sourceBranch } = await moves(f).rollbackToMessage('agent', { messageId: before });
      await eventually(() => f.requests.slice(sent).includes('channels/open'), "premise: the rollback's open is out");

      await moves(f).switchBranch(sourceBranch);
      assert.equal(registry.getDesiredState('editor', 'noisy'), 'closed', 'premise: decided closed on the branch moved back to');
      const requests = f.requests.length;
      f.releaseReplies({ fail: true });

      await eventually(() => f.requests.slice(requests).includes('channels/close'), 'the server is asked to close it after the failed open');
    } finally { await f.close(); }
  });

  it("a failure to decide one channel at the move leaves the others to be brought to the branch's decision, and isn't told as a failed read", async () => {
    const f = await withSub();
    const error = mock.method(console, 'error', () => {});
    try {
      await registerOpen(f, 'work');
      const before = write(f, 'before the channels came');
      f.present();
      await f.register('first');
      await f.register('second');
      const registry = registryOf(f);
      for (const id of ['first', 'second']) {
        assert.ok((await registry.handleChannelToolCall('channel_open', { channelId: id })).success, `premise: the agent opened ${id}`);
        await eventually(() => registry.channels.get(key(id))?.open === true, `premise: ${id} open at the server`);
      }
      write(f, 'after the channels came');
      const ensure = registry.ensureInitialDesiredState.bind(registry);
      registry.ensureInitialDesiredState = (serverId: string, channel: unknown) => {
        if ((channel as { id: string }).id === 'first') throw new Error('injected write failure');
        return ensure(serverId, channel);
      };
      try {
        await moves(f).rollbackToMessage('agent', { messageId: before });
      } finally { registry.ensureInitialDesiredState = ensure; }

      assert.equal(registry.getDesiredState('editor', 'second'), 'closed', "the other channel has its registration's decision");
      await eventually(() => registry.channels.get(key('second'))?.open === false, 'and is closed at the server');
      assert.ok(!error.mock.calls.some((c) => String(c.arguments[0]).includes('could not be read')), 'no read failure is told');
    } finally { error.mock.restore(); await f.close(); }
  });

  it("a rollback to before a server's first registration migrates its legacy policy there, as that registration did", async () => {
    const f = await withSub();
    try {
      const before = write(f, 'before any channel');
      f.present();
      await registerOpen(f, 'work');
      const registry = registryOf(f);
      assert.equal(registry.desiredStates.get('editor\u0000work')?.source, 'legacy-recipe-migration', 'premise: decided by the migration');
      write(f, 'after the registration');

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(registry.desiredStates.get('editor\u0000work')?.source, 'legacy-recipe-migration');
    } finally { await f.close(); }
  });

  it("a channel closed by default on the branch moved to is opened there where the subscription policy now wants it, as a registration would", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work');
      await f.register('late');
      const registry = registryOf(f);
      await eventually(() => registry.getDesiredState('editor', 'late') === 'closed', 'premise: closed by default');
      const before = write(f, 'after the channel came');
      f.present();
      registry.setSubscriptionPolicy('editor', 'auto');
      write(f, 'after the policy changed');

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(registry.getDesiredState('editor', 'late'), 'open');
      await eventually(() => registry.channels.get(key('late'))?.open === true, 'opened at the server');
    } finally { await f.close(); }
  });

  it("a channel known only from a push gets its label at a move and nothing else: no decision, and nothing asked of the server", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work');
      const before = write(f, 'before the push');
      f.present();
      const registry = registryOf(f);
      registry.setSubscriptionPolicy('editor', 'auto');
      registry.ensureChannelRegistered('editor', 'dm-1', 'Dee');
      assert.equal(registry.getDesiredState('editor', 'dm-1'), undefined, 'premise: a push decides nothing');
      write(f, 'after the push');
      await eventually(() => registry.channelLifecycleTails.size === 0, 'premise: no lifecycle work queued');
      const applied = appliedChannels(registry);

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(registry.labelHistory.get('dm-1'), 'Dee', 'its label sighting');
      assert.equal(registry.getDesiredState('editor', 'dm-1'), undefined);
      assert.deepEqual(applied, []);
    } finally { await f.close(); }
  });

  for (const lane of ['channels/incoming', 'push/event'] as const) {
    it(`a message (${lane}) held under the branch left's tune-out as it arrived while the move was under way reaches the resident on a branch that doesn't hold it`, async () => {
      const f = await withSub();
      try {
        await registerOpen(f, 'work', 'noisy');
        const before = write(f, 'before the tune-out');
        f.present();
        enter(f, 'noisy');
        const epochId = registryOf(f).getTuneOutState('editor', 'noisy')!.params.epochId;
        write(f, 'after the tune-out');
        const { keptMark } = await arriveDuringMove(f, 'noisy', 'arrived during the move', () => moves(f).rollbackToMessage('agent', { messageId: before }), undefined, lane);
        assert.equal(keptMark, epochId, "premise: held under the branch left's tune-out as it arrived");

        assert.equal(held(find(f, 'arrived during the move')), false, 'stored unheld');
        f.present();
        assert.ok(inWindow(f, 'arrived during the move'), "in the resident's window");
      } finally { await f.close(); }
    });
  }

  it("under an all-except hold that both branches hold, a channel's own hold that the branch moved to doesn't hold leaves no count for the scope's cadence to read while the agents follow", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const coordinator = coordinatorOf(f);
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 3600 }, 'agent-tool').ok, 'premise: the scope');
      const before = write(f, 'before the channel hold');
      f.present();
      enter(f, 'noisy');
      await arrive(f, 'noisy', 'n1', 'held under the channel hold');
      assert.ok((coordinator.divertedSinceInvocation.get(key('noisy')) ?? 0) > 0, 'premise: counted under its own hold');
      write(f, 'after the channel hold');
      const fw = f.framework as unknown as { reinitializeManagers(...a: unknown[]): Promise<unknown> };
      const reinit = fw.reinitializeManagers.bind(fw);
      let between: number | undefined | null = null;
      fw.reinitializeManagers = (...a: unknown[]) => { between = coordinator.divertedSinceInvocation.get(key('noisy')); return reinit(...a); };
      try {
        await moves(f).rollbackToMessage('agent', { messageId: before });
      } finally { fw.reinitializeManagers = reinit; }

      assert.ok(coordinator.getAllExcept() !== null, 'premise: the scope holds there too');
      assert.equal(between, undefined, 'no count for noisy between the phases');
    } finally { await f.close(); }
  });

  it("a message held during the move under the branch left's tune-out is held under the tune-out that holds its channel on the branch moved to", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      const registry = registryOf(f);
      enter(f, 'noisy');
      const first = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      const point = write(f, 'the point to roll back to');
      f.present();
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok, 'premise: the first tune-out ends');
      enter(f, 'noisy');
      const second = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      assert.notEqual(second, first, 'premise: a second tune-out');
      write(f, 'after the second tune-out');
      const { keptMark } = await arriveDuringMove(f, 'noisy', 'arrived during the move', () => moves(f).rollbackToMessage('agent', { messageId: point }));
      assert.equal(keptMark, second, 'premise: held under the second tune-out as it arrived');

      assert.equal(registry.getTuneOutState('editor', 'noisy')?.params.epochId, first, 'premise: the branch moved to holds the first');
      const row = find(f, 'arrived during the move');
      assert.equal((row.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId, first);
      f.present();
      assert.ok(!inWindow(f, 'arrived during the move'), "not in the resident's window");
    } finally { await f.close(); }
  });

  it("the subconscious's standing notes are those of the branch moved to", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work');
      const before = write(f, 'before the note');
      f.present();
      const coordinator = coordinatorOf(f);
      coordinator.noteDisposition('mood', 'a note on the branch left');
      write(f, 'after the note');
      assert.ok(coordinator.getDispositionsInjection()?.content[0].text.includes('a note on the branch left'), 'premise: the note stands there');

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(coordinator.getDispositionsInjection(), null);
    } finally { await f.close(); }
  });

  it("control: a suppression keeps the timers and the pending wake of a hold that its fork still holds", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      write(f, 'a message that stays');
      const unrelated = write(f, 'an unrelated message');
      const coordinator = coordinatorOf(f);
      coordinator.scheduleWakeInvocation('editor', 'noisy');
      const cadence = coordinator.cadenceTimers.get(key('noisy'));
      const wake = coordinator.pendingWakes.get(key('noisy'));
      assert.ok(cadence && wake, 'premise: a cadence and a pending wake');

      await moves(f).suppressMessages('agent', { messageIds: [unrelated] });

      assert.equal(coordinator.cadenceTimers.get(key('noisy')), cadence);
      assert.equal(coordinator.pendingWakes.get(key('noisy')), wake);
    } finally { await f.close(); }
  });

  for (const log of ['mcpl/channel-lifecycle', 'mcpl/channel-label-history']) {
    it(`a channel log that can't be read at the move (${log}) leaves the channels and their holds as they were and says so, and the move goes on`, async () => {
      const f = await withSub();
      const error = mock.method(console, 'error', () => {});
      try {
        await registerOpen(f, 'work', 'noisy');
        const before = write(f, 'before the tune-out');
        enter(f, 'noisy');
        write(f, 'cut by the rollback');
        const registry = registryOf(f);
        const coordinator = coordinatorOf(f);
        const cadence = coordinator.cadenceTimers.get(key('noisy'));
        const read = registry.store.getStateJson.bind(registry.store);
        registry.store.getStateJson = (id: string) => {
          if (id === log) throw new Error('injected read failure');
          return read(id);
        };
        try {
          await moves(f).rollbackToMessage('agent', { messageId: before });
        } finally { registry.store.getStateJson = read; }

        assert.ok(!stored(f).some((m) => textOf(m).includes('cut by the rollback')), "the agent's context followed the move");
        const said = error.mock.calls.map((c) => String(c.arguments[0]));
        assert.ok(said.some((s) => s.includes('the channel decisions of the branch moved to could not be read')), 'the read failure is told');
        assert.ok(!said.some((s) => s.includes('following a branch move failed')), 'and the move went on past it');
        assert.equal(registry.getDesiredState('editor', 'noisy'), 'tuned-out', 'the channels kept what they had');
        assert.equal(coordinator.cadenceTimers.get(key('noisy')), cadence, 'and so did the hold');
      } finally { error.mock.restore(); await f.close(); }
    });
  }

  it("an all-except record the move can't follow, its channel log unreadable, keeps the hold and its timers as they were", async () => {
    const f = await withSub();
    const error = mock.method(console, 'error', () => {});
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the hold');
      const coordinator = coordinatorOf(f);
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 3600 }, 'agent-tool').ok);
      const epochId = coordinator.getAllExcept()!.params.epochId;
      const cadence = coordinator.cadenceTimers.get(SCOPE);
      write(f, 'during the hold');
      const registry = registryOf(f);
      const read = registry.store.getStateJson.bind(registry.store);
      registry.store.getStateJson = (id: string) => {
        if (id === 'mcpl/channel-lifecycle') throw new Error('injected read failure');
        return read(id);
      };
      try {
        await moves(f).rollbackToMessage('agent', { messageId: before });
      } finally { registry.store.getStateJson = read; }

      assert.equal(coordinator.getAllExcept()?.params.epochId, epochId, 'the hold stays');
      assert.equal(coordinator.cadenceTimers.get(SCOPE), cadence, 'and so does its timer');
    } finally { error.mock.restore(); await f.close(); }
  });

  it("after a move whose channel logs couldn't be read, a switch to the branch the store is on reads them, and the channels and holds follow", async () => {
    const f = await withSub();
    const error = mock.method(console, 'error', () => {});
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the tune-out');
      enter(f, 'noisy');
      write(f, 'cut by the rollback');
      const registry = registryOf(f);
      const coordinator = coordinatorOf(f);
      const read = registry.store.getStateJson.bind(registry.store);
      registry.store.getStateJson = (id: string) => {
        if (id === 'mcpl/channel-lifecycle') throw new Error('injected read failure');
        return read(id);
      };
      try {
        await moves(f).rollbackToMessage('agent', { messageId: before });
      } finally { registry.store.getStateJson = read; }
      assert.equal(registry.getDesiredState('editor', 'noisy'), 'tuned-out', 'premise: the channels kept what they had');
      const left = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      const anchor = (internals(f) as unknown as { subconsciousAnchor: { pending: Array<{ start: { sequence: number; epochIds: string[] } }> } }).subconsciousAnchor;
      const start = { sequence: registry.getTuneOutState('editor', 'noisy')!.params.startedAtSequence, epochIds: [left] };
      anchor.pending.push({ start, inForce: [start] } as (typeof anchor.pending)[number]);

      await moves(f).switchBranch(branchNow(f));

      assert.equal(registry.getDesiredState('editor', 'noisy'), 'open', "the branch's own decision");
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'no hold there');
      assert.equal(coordinator.cadenceTimers.has(key('noisy')), false, "the branch left's hold stops");
      assert.ok(!anchor.pending.some((p) => p.start.epochIds.includes(left)), "and so does a window start that waited to be fixed for it");

      const reads: string[] = [];
      registry.store.getStateJson = (id: string) => { reads.push(id); return read(id); };
      try {
        await moves(f).switchBranch(branchNow(f));
      } finally { registry.store.getStateJson = read; }
      assert.ok(!reads.includes('mcpl/channel-lifecycle'), 'once read, a later switch to the same branch reads the channel logs no more');
    } finally { error.mock.restore(); await f.close(); }
  });

  it("a move that ends after the host's stop began arms no timer for the holds of the branch moved to", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      const point = write(f, 'after the tune-out');
      write(f, 'cut by the rollback');
      const coordinator = coordinatorOf(f) as Coordinator & { stopTimers(): void };
      assert.ok(coordinator.cadenceTimers.has(key('noisy')), 'premise: the hold has its cadence');
      const fw = f.framework as unknown as { reinitializeManagers(...a: unknown[]): Promise<unknown> };
      const reinit = fw.reinitializeManagers.bind(fw);
      let stopped = false;
      fw.reinitializeManagers = (...a: unknown[]) => { coordinator.stopTimers(); stopped = true; return reinit(...a); };
      try {
        await moves(f).rollbackToMessage('agent', { messageId: point });
      } finally { fw.reinitializeManagers = reinit; }

      assert.ok(stopped, "premise: the stop began while the move waited for the agents' contexts");
      assert.ok(registryOf(f).getTuneOutState('editor', 'noisy') !== null, 'premise: the branch moved to holds it');
      assert.deepEqual([coordinator.cadenceTimers.size, coordinator.expiryTimers.size, coordinator.pendingWakes.size], [0, 0, 0]);
    } finally { await f.close(); }
  });

  it("an all-except record that can't be read as the move gives each held message the mark of the branch moved to is told, with what that leaves", async () => {
    const f = await withSub();
    const error = mock.method(console, 'error', () => {});
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the tune-out');
      enter(f, 'noisy');
      write(f, 'after the tune-out');
      const coordinator = coordinatorOf(f);
      const scope = coordinator.getAllExcept.bind(coordinator);
      try {
        await arriveDuringMove(f, 'noisy', 'arrived during the move', () => moves(f).rollbackToMessage('agent', { messageId: before }), () => {
          coordinator.getAllExcept = () => { throw new Error('injected read failure'); };
        });
      } finally { coordinator.getAllExcept = scope; }

      const said = error.mock.calls.map((c) => String(c.arguments[0]));
      assert.ok(said.some((s) => s.includes('1 message held as it arrived keeps')), 'told');
    } finally { error.mock.restore(); await f.close(); }
  });

  it("an all-except record that the held messages' re-marking can't use is told, and the agents still follow the move", async () => {
    const f = await withSub();
    const error = mock.method(console, 'error', () => {});
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the tune-out');
      enter(f, 'noisy');
      write(f, 'after the tune-out');
      const coordinator = coordinatorOf(f);
      const scope = coordinator.getAllExcept.bind(coordinator);
      try {
        await arriveDuringMove(f, 'noisy', 'arrived during the move', () => moves(f).rollbackToMessage('agent', { messageId: before }), () => {
          coordinator.getAllExcept = () => ({ params: { epochId: 'e-malformed' } });
        });
      } finally { coordinator.getAllExcept = scope; }

      const said = error.mock.calls.map((c) => String(c.arguments[0]));
      assert.ok(said.some((s) => s.includes('1 message held as it arrived keeps')), 'told');
      assert.ok(!said.some((s) => s.includes('following a branch move failed')), 'and the move went on past it');
    } finally { error.mock.restore(); await f.close(); }
  });

  it("a channel a server registered with a descriptor that says lazyRegistered gets, on a rollback past its registration, the decision its registration made", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work');
      const before = write(f, 'before the channel came');
      await f.send('channels/register', { channels: [{ id: 'late', type: 'discord', label: 'late', metadata: { channelType: 'guild_text', lazyRegistered: true } }] });
      const registry = registryOf(f);
      await eventually(() => registry.getDesiredState('editor', 'late') === 'closed', 'premise: registered closed by default');
      assert.ok((await registry.handleChannelToolCall('channel_open', { channelId: 'late' })).success, 'premise: the agent opened it');
      write(f, 'after the channel came');

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(registry.getDesiredState('editor', 'late'), 'closed', "its registration's decision");
    } finally { await f.close(); }
  });

  it("a server whose legacy policy's migration fails on the branch moved to gets no decision for its channels there, as a registration whose migration fails gets none", async () => {
    const f = await withSub();
    const error = mock.method(console, 'error', () => {});
    try {
      const before = write(f, 'before the server registered');
      await f.register('work');
      const registry = registryOf(f) as Registry & { setDesiredState(serverId: string, channelId: string, desired: string, source: string): void };
      await eventually(() => registry.getDesiredState('editor', 'work') === 'closed', 'premise: decided at its registration');
      write(f, 'after the server registered');
      const set = registry.setDesiredState.bind(registry);
      registry.setDesiredState = (serverId: string, channelId: string, desired: string, source: string) => {
        if (source === 'legacy-recipe-migration') throw new Error('injected write failure');
        return set(serverId, channelId, desired, source);
      };
      try {
        await moves(f).rollbackToMessage('agent', { messageId: before });
      } finally { registry.setDesiredState = set; }

      assert.ok(error.mock.calls.some((c) => String(c.arguments[0]).includes("legacy recipe policy couldn't be migrated")), 'premise: the migration failed');
      assert.equal(registry.getDesiredState('editor', 'work'), undefined);
    } finally { error.mock.restore(); await f.close(); }
  });

  it("a channel the subscription policy opened after the branch point is open on a rollback past it, and the agent is told, as at its registration", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work');
      const registry = registryOf(f);
      registry.setSubscriptionPolicy('editor', 'auto');
      const before = write(f, 'before the channel came');
      f.present();
      await f.register('late');
      await eventually(() => registry.getDesiredState('editor', 'late') === 'open', 'premise: opened by the policy');
      const told = () => stored(f).filter((m) => m.metadata?.kind === 'channel-notice' && textOf(m).includes('late')).length;
      await eventually(() => told() === 1, 'premise: the agent was told at its registration');
      write(f, 'after the channel came');

      await moves(f).rollbackToMessage('agent', { messageId: before });

      assert.equal(registry.getDesiredState('editor', 'late'), 'open', 'opened by the policy there too');
      await eventually(() => told() === 1, 'told on the branch moved to');
    } finally { await f.close(); }
  });

  it('a host with no reader releases a hold that the branch moved to holds, once the move releases the writes', async () => {
    const f = await fixture();
    const error = mock.method(console, 'error', () => {});
    try {
      await registerOpen(f, 'work', 'noisy');
      const before = write(f, 'before the hold');
      const registry = registryOf(f);
      assert.equal(internals(f).tuneOutCoordinator ?? null, null, 'premise: no reader, so no coordinator');
      registry.enterTuneOut('editor', 'noisy', {
        epochId: 'e-recorded', cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5, startedAtSequence: 0,
      }, 'agent-tool');
      write(f, 'after the hold');
      const { sourceBranch } = await moves(f).rollbackToMessage('agent', { messageId: before });
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'the branch moved to holds nothing');
      const waits = () => error.mock.calls.filter((c) => String(c.arguments[0]).includes('the tune-outs on record are released once the store takes writes again')).length;
      assert.equal(waits(), 0, 'premise: no release waited yet');

      await moves(f).switchBranch(sourceBranch);

      assert.equal(waits(), 1, "the switch found the branch's hold, and its release waited for the writes the switch held");
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'released at the move, as at a start');
      assert.equal(registry.getDesiredState('editor', 'noisy'), 'open');
    } finally { error.mock.restore(); await f.close(); }
  });

  it("control: a move to a branch that holds nothing reads no stored messages to count what a reader hasn't seen", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work');
      const before = write(f, 'before');
      write(f, 'after');
      const coordinator = coordinatorOf(f);
      let reads = 0;
      const get = coordinator.hooks.getStoredMessages;
      coordinator.hooks.getStoredMessages = () => { reads++; return get(); };
      await moves(f).rollbackToMessage('agent', { messageId: before });
      assert.equal(reads, 0);
    } finally { await f.close(); }
  });

  it("the count of what a held channel's reader hasn't looked at is that of the held rows of the branch moved to, through a suppression's fork and a rollback", async () => {
    const f = await withSub();
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      const coordinator = coordinatorOf(f);
      await arrive(f, 'noisy', 'h1', 'held one');
      const forkPoint = write(f, 'the fork point');
      f.present();
      await arrive(f, 'noisy', 'h2', 'held two');
      const counted = coordinator.divertedSinceInvocation.get(key('noisy'));
      assert.ok(counted !== undefined && counted >= 2, `premise: two held, counted ${counted}`);
      const unrelated = write(f, 'an unrelated message');
      write(f, 'a message after it');

      await moves(f).suppressMessages('agent', { messageIds: [unrelated] });
      assert.equal(coordinator.divertedSinceInvocation.get(key('noisy')), counted, 'the same rows through the fork');

      await moves(f).rollbackToMessage('agent', { messageId: forkPoint });
      const heldThere = stored(f).filter(held).length;
      assert.equal(heldThere, 1, 'premise: the branch moved to holds one held row');
      assert.equal(coordinator.divertedSinceInvocation.get(key('noisy')), heldThere, "made again from the branch's held rows");
    } finally { await f.close(); }
  });
});
