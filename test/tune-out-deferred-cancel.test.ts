import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { SUB, internals, textOf, stored, has, find, registerOpen, enter, type Fixture, type Stored } from './helpers/admission.js';

type Answer = { success: boolean; data?: unknown; error?: string };
type Framework = {
  addMessage(p: string, c: unknown[], m: Record<string, unknown>): string;
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  executeToolCall(call: unknown): Promise<Answer>;
};

const waiting = (answer: Answer): { waiting?: unknown; note?: string; cancelled?: unknown } =>
  (answer.data ?? {}) as { waiting?: unknown; note?: string; cancelled?: unknown };

function saysWhatItWaitsFor(note: string): void {
  assert.match(note, /an operator's change to the store/, `names a surgery's hold: ${note}`);
  assert.match(note, /refuses writes until the host re-initializes it/, `names a refusing context: ${note}`);
  assert.doesNotMatch(note, /writes (are |kept |held )?(in memory|stored)/, `doesn't say it waits for writes: ${note}`);
  assert.match(note, /Cancelling again doesn't end the wait sooner, and how long it lasts isn't known here/, `says asking again won't end it: ${note}`);
  assert.doesNotMatch(note, /Nothing you can do/, `claims nothing of the host's other tools: ${note}`);
  assert.match(note, /If the host stops before then, the cancel is lost/, `says a stop loses it: ${note}`);
}

async function heldDuringSurgery() {
  const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
  await registerOpen(f, 'work', 'noisy');
  enter(f, 'noisy', { backlogCap: 10 });
  const registry = internals(f).channelRegistry;
  const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
  const framework = f.framework as unknown as Framework;
  framework.addMessage('antra', [{ type: 'text', text: 'held before the hold' }], {
    tuneOut: { epochId }, channelId: 'noisy', serverId: 'editor', author: { id: 'U1', name: 'antra' },
  });
  const release = framework.reserveStoreForSurgery('roll back', 'agent');
  return { f, registry, framework, release, coordinator: internals(f).tuneOutCoordinator! };
}

describe("a cancel that waits for the held writes says so to its caller", () => {
  it("the resident's tune_out cancel is answered as waiting, the tune-out stays in force, and it ends at the release", async () => {
    const { f, registry, release } = await heldDuringSurgery();
    try {
      const answer = await internals(f).handleTuneOutTool('agent', { channelId: 'noisy', mode: 'cancel' });
      assert.equal(answer.success, true, answer.error);
      assert.equal(waiting(answer).cancelled, undefined, `not answered as cancelled: ${JSON.stringify(answer.data)}`);
      assert.equal(waiting(answer).waiting, 'noisy', 'answered as waiting, naming the channel');
      assert.match(waiting(answer).note ?? '', /stays in force/, 'and saying the tune-out stays in force until then');
      saysWhatItWaitsFor(waiting(answer).note ?? '');
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the tune-out is still in force');
      release();
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'ended at the release');
      assert.match(textOf(find(f, '<tuned-out-backlog')), /held before the hold/, 'its backlog released');
    } finally { release(); await f.close(); }
  });

  it("the resident's cancel of the all-except hold is answered as waiting", async () => {
    const { f, coordinator, release } = await heldDuringSurgery();
    let again = (): void => {};
    try {
      release();
      assert.ok(coordinator.cancel('editor', 'noisy', 'agent-tool', 'test').ok, 'premise: the channel tune-out ended');
      const scope = coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool');
      assert.ok(scope.ok);
      again = (f.framework as unknown as Framework).reserveStoreForSurgery('roll back', 'agent');
      const answer = await internals(f).handleTuneOutTool('agent', { mode: 'cancel', scope: 'all-except' });
      assert.equal(answer.success, true, answer.error);
      assert.equal(waiting(answer).cancelled, undefined, `not answered as cancelled: ${JSON.stringify(answer.data)}`);
      assert.equal(waiting(answer).waiting, 'all-except');
      assert.match(waiting(answer).note ?? '', /stays in force/);
      saysWhatItWaitsFor(waiting(answer).note ?? '');
      assert.ok(coordinator.getAllExcept(), 'premise: the hold is still in force');
      again();
      assert.equal(coordinator.getAllExcept(), null, 'ended at the release');
    } finally { release(); again(); await f.close(); }
  });

  it("the subconscious's cancel_tuneout is answered as waiting, and its note goes out with the release", async () => {
    const { f, registry, coordinator, release } = await heldDuringSurgery();
    try {
      const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: 'Someone asked for you.' });
      assert.equal(answer.success, true, answer.error);
      assert.equal(waiting(answer).cancelled, undefined, `not answered as cancelled: ${JSON.stringify(answer.data)}`);
      assert.equal(waiting(answer).waiting, true);
      assert.match(waiting(answer).note ?? '', /stays in force/);
      saysWhatItWaitsFor(waiting(answer).note ?? '');
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the tune-out is still in force');
      release();
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'ended at the release');
      assert.ok(has(f, 'Someone asked for you.'), 'its note is delivered with the release');
    } finally { release(); await f.close(); }
  });

  it("a close of the excepted channel that can't be recorded doesn't say the focus ended when its release waits", async () => {
    const { f, coordinator, release } = await heldDuringSurgery();
    let again = (): void => {};
    try {
      release();
      assert.ok(coordinator.cancel('editor', 'noisy', 'agent-tool', 'test').ok, 'premise: the channel tune-out ended');
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool').ok);
      const registry = internals(f).channelRegistry as unknown as { setDesiredState(...args: unknown[]): void };
      const record = registry.setDesiredState.bind(registry);
      registry.setDesiredState = (...args: unknown[]) => {
        if (args[2] === 'closed') throw new Error('the log refused it');
        return record(...args);
      };
      again = (f.framework as unknown as Framework).reserveStoreForSurgery('roll back', 'agent');
      const result = await f.framework.executeToolCall({ id: 'c1', name: 'channel_close', input: { channelId: 'work' }, callerAgentName: 'agent' } as never);
      assert.equal(result.success, false);
      assert.ok(coordinator.getAllExcept(), 'premise: the hold is still in force');
      assert.doesNotMatch(result.error ?? '', /ended all the same|was delivered/, result.error);
      assert.match(result.error ?? '', /The close cancels the all-except hold that excepts it\. Not cancelled yet: /, result.error);
      saysWhatItWaitsFor(result.error ?? '');
      assert.doesNotMatch(result.error ?? '', /Nothing you can do/, result.error);
      again();
      assert.equal(coordinator.getAllExcept(), null, 'ended at the release');
    } finally { release(); again(); await f.close(); }
  });

  for (const already of [false, true]) it(`a close of the excepted channel${already ? ', closed already,' : ''} during a surgery's hold is answered ${already ? 'already closed' : 'closed'} and told the focus ends once the hold is over`, async () => {
    const { f, coordinator, release } = await heldDuringSurgery();
    let again = (): void => {};
    try {
      release();
      assert.ok(coordinator.cancel('editor', 'noisy', 'agent-tool', 'test').ok, 'premise: the channel tune-out ended');
      const close = (id: string): Promise<Answer> =>
        f.framework.executeToolCall({ id, name: 'channel_close', input: { channelId: 'work' }, callerAgentName: 'agent' } as never) as Promise<Answer>;
      if (already) {
        assert.ok((await close('c0')).success, 'premise: work closed before the hold');
        await eventually(() => internals(f).channelRegistry.getDesiredState('editor', 'work') === 'closed', 'work closed');
      }
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool').ok);
      again = (f.framework as unknown as Framework).reserveStoreForSurgery('roll back', 'agent');
      const result = await close('c1');
      assert.equal(result.success, true, result.error);
      const data = (result.data ?? {}) as { status?: string; note?: string };
      assert.equal(data.status, already ? 'already closed' : 'closed');
      assert.ok(coordinator.getAllExcept(), 'premise: the hold is still in force');
      assert.match(data.note ?? '', /^The close cancels the all-except hold that excepts it\. Not cancelled yet: /,
        `the answer says the hold's end waits, not only that the channel is closed: ${JSON.stringify(data)}`);
      saysWhatItWaitsFor(data.note ?? '');
      assert.doesNotMatch(data.note ?? '', /ended|was delivered/, data.note);
      again();
      assert.equal(coordinator.getAllExcept(), null, 'ended at the release');
    } finally { release(); again(); await f.close(); }
  });
});

describe('a later cancel of a tune-out whose cancel already waits', () => {
  it("gives the release its note when the waiting cancel has none, as an end time's cancel then the subconscious's", async () => {
    const { f, registry, coordinator, release } = await heldDuringSurgery();
    try {
      assert.deepEqual(coordinator.cancel('editor', 'noisy', 'duration', 'duration elapsed'), { ok: true, deferred: true });
      const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: 'Someone asked for you.' });
      assert.equal(answer.success, true, answer.error);
      assert.equal(waiting(answer).waiting, true);
      assert.match(waiting(answer).note ?? '', /Your note waits with the cancel and is delivered when the tune-out ends\./,
        `told what becomes of its note: ${waiting(answer).note}`);
      assert.match(waiting(answer).note ?? '', /The notice is kept in the store as well, unless the store refuses that too: if the host stops before the notice is written, the host writes it when it starts again/,
        `told that a loss notice that can't be written survives a stop (Ivy-3594, round 6): ${waiting(answer).note}`);
      assert.match(waiting(answer).note ?? '', /The waiting cancel isn't kept in the store: if the host stops before the tune-out ends, the cancel and your note are lost, and you are told so by such a notice, kept in the store for the host to write when it starts again, unless the store refuses that too\.$/,
        `and that a stop before the hold ends loses the cancel and the note, but not the notice of the note's loss (Ivy-3594, round 8): ${waiting(answer).note}`);
      assert.doesNotMatch(waiting(answer).note ?? '', /or the host stops/, `no longer says a stop ends the notice's retries: ${waiting(answer).note}`);
      release();
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'ended at the release');
      assert.ok(has(f, 'Someone asked for you.'), "the subconscious's note is delivered with the release");
    } finally { release(); await f.close(); }
  });

  it("tells a later caller whose note won't go out with it, when the waiting cancel carries a note of its own", async () => {
    const { f, registry, coordinator, release } = await heldDuringSurgery();
    try {
      const first = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: 'The first note.' });
      assert.equal(first.success, true, first.error);
      assert.match(waiting(first).note ?? '', /Your note waits with the cancel and is delivered when the tune-out ends\./,
        'the first caller is told its note waits with the cancel');
      const second = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: 'The second note.' });
      assert.equal(second.success, true, second.error);
      assert.equal(waiting(second).waiting, true);
      assert.match(waiting(second).note ?? '', /Your note isn't delivered/, `the second caller is told: ${waiting(second).note}`);
      assert.doesNotMatch(waiting(second).note ?? '', /Your note waits/, 'and not that it waits');
      release();
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'ended at the release');
      assert.ok(has(f, 'The first note.'), "the waiting cancel's note is delivered");
      assert.ok(!has(f, 'The second note.'), 'and the second, as its caller was told, is not');
    } finally { release(); await f.close(); }
  });

  it("tells a later caller of the all-except hold's cancel whose note won't go out with it, as a channel's", async () => {
    const { f, coordinator, release } = await heldDuringSurgery();
    let again = (): void => {};
    try {
      release();
      assert.ok(coordinator.cancel('editor', 'noisy', 'agent-tool', 'test').ok, 'premise: the channel tune-out ended');
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool').ok);
      again = (f.framework as unknown as Framework).reserveStoreForSurgery('roll back', 'agent');
      const first = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', scope: 'all-except', text: 'The first note.' });
      assert.equal(first.success, true, first.error);
      assert.equal(waiting(first).waiting, true);
      assert.match(waiting(first).note ?? '', /Your note waits with the cancel and is delivered when the all-except hold ends\./,
        'the first caller is told its note waits with the cancel');
      const second = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', scope: 'all-except', text: 'The second note.' });
      assert.equal(second.success, true, second.error);
      assert.equal(waiting(second).waiting, true);
      assert.match(waiting(second).note ?? '', /Your note isn't delivered/, `the second caller is told: ${waiting(second).note}`);
      assert.doesNotMatch(waiting(second).note ?? '', /Your note waits/, 'and not that it waits');
      again();
      assert.equal(coordinator.getAllExcept(), null, 'ended at the release');
      assert.ok(has(f, 'The first note.'), "the waiting cancel's note is delivered");
      assert.ok(!has(f, 'The second note.'), 'and the second, as its caller was told, is not');
    } finally { release(); again(); await f.close(); }
  });
});

describe("a cancel while the primary's or the subconscious's context manager refuses its work", () => {
  for (const whose of ['primary', 'subconscious'] as const) it(`waits while the ${whose}'s refuses, the tune-out in force, though nothing is kept for its recovery yet, and runs once a switch re-initializes it`, async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const registry = internals(f).channelRegistry;
      const coordinator = internals(f).tuneOutCoordinator!;
      const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      (f.framework as unknown as Framework).addMessage('antra', [{ type: 'text', text: 'held before the failure' }], {
        tuneOut: { epochId }, channelId: 'noisy', serverId: 'editor', author: { id: 'U1', name: 'antra' },
      });
      const names = f.framework as unknown as { primaryAgentName: string; subconsciousAgentName: string | null };
      const refusing = whose === 'primary' ? names.primaryAgentName : names.subconsciousAgentName;
      assert.ok(refusing, `premise: the fixture has a ${whose}`);
      const strategy = f.framework.getAgent(refusing)!.getContextManager().getStrategy() as unknown as {
        initialize?: (...args: unknown[]) => Promise<void>;
      };
      const initialize = strategy.initialize?.bind(strategy);
      let failNext = true;
      strategy.initialize = async (...args: unknown[]) => {
        if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
        await initialize?.(...args);
      };
      const branch = f.framework.getStore().currentBranch().name;
      await f.framework.switchBranch(branch);
      assert.equal(failNext, false, `premise: the ${whose}'s re-initialization failed`);
      const kept = (f.framework as unknown as { heldForRecovery: Map<string, unknown[]> }).heldForRecovery;
      assert.equal(kept.get(refusing)?.length ?? 0, 0, 'premise: nothing is kept for its recovery yet');

      assert.deepEqual(coordinator.cancel('editor', 'noisy', 'duration', 'duration elapsed'), { ok: true, deferred: true },
        'the cancel waits');
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'the tune-out stays in force');
      assert.equal(kept.get(refusing)?.length ?? 0, 0, 'and no release is kept in memory behind an end on disk');

      await f.framework.switchBranch(branch);
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'it ends once a switch re-initializes the manager');
      assert.equal(stored(f).filter((m) => textOf(m).includes('<tuned-out-backlog')).length, 1, 'its release stored once');
      assert.match(textOf(find(f, '<tuned-out-backlog')), /held before the failure/);
    } finally { await f.close(); }
  });

  it("waits too when a rollback of the primary fails and so does its restore, which leaves the primary's manager refusing", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const registry = internals(f).channelRegistry;
      const coordinator = internals(f).tuneOutCoordinator!;
      const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      const framework = f.framework as unknown as Framework & {
        rollbackToMessage(agent: string, opts: { messageId: string }): Promise<unknown>;
        heldForRecovery: Map<string, unknown[]>;
      };
      const target = framework.addMessage('antra', [{ type: 'text', text: 'held before the rollback' }], {
        tuneOut: { epochId }, channelId: 'noisy', serverId: 'editor', author: { id: 'U1', name: 'antra' },
      });
      framework.addMessage('antra', [{ type: 'text', text: 'after the rollback point' }], {
        channelId: 'work', serverId: 'editor', author: { id: 'U1', name: 'antra' },
      });
      const strategy = f.framework.getAgent('agent')!.getContextManager().getStrategy() as unknown as {
        initialize?: (...args: unknown[]) => Promise<void>;
      };
      const initialize = strategy.initialize?.bind(strategy);
      let failures = 2;
      strategy.initialize = async (...args: unknown[]) => {
        if (failures > 0) { failures--; throw new Error('injected initialization failure'); }
        await initialize?.(...args);
      };
      const source = f.framework.getStore().currentBranch().name;
      await assert.rejects(framework.rollbackToMessage('agent', { messageId: target }), /RESTORE TO/,
        'premise: the rollback fails, and so does its restore');
      assert.equal(failures, 0, "premise: both initializations failed, the rollback's and the restore's");
      assert.equal(framework.heldForRecovery.get('agent')?.length ?? 0, 0, 'premise: nothing is kept for its recovery yet');

      assert.deepEqual(coordinator.cancel('editor', 'noisy', 'duration', 'duration elapsed'), { ok: true, deferred: true },
        'the cancel waits');
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'the tune-out stays in force');
      assert.equal(framework.heldForRecovery.get('agent')?.length ?? 0, 0, 'and no release is kept in memory behind an end on disk');

      await f.framework.switchBranch(source);
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'it ends once a switch re-initializes the manager');
      assert.equal(stored(f).filter((m) => textOf(m).includes('<tuned-out-backlog')).length, 1, 'its release stored once');
    } finally { await f.close(); }
  });
});

// ---------------------------------------------------------------------------
// AF #844 review, round 8 (Ivy-3594, findings 2 and 3): what becomes of a
// note that waits with an accepted cancel, as the surviving subconscious
// sees it after a stop and a start on the same store.
// ---------------------------------------------------------------------------

type Restartable = Omit<Framework, 'addMessage'> & {
  subconsciousAgentName: string | null;
  commitDeliveries(): boolean;
  addMessage(participant: string, content: unknown[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
  channelRegistry: { readCoordinatorState(id: string): unknown; writeCoordinatorState(id: string, value: unknown): void };
};

const presentedTo = (f: Fixture, agent: string): string[] =>
  (f.framework.getAgent(agent)!.getContextManager().getPresentedMessages() as unknown as Stored[]).map(textOf);

const LOSS_RECORD = 'tune-out/agent/loss-notices';

/**
 * The subconscious's cancel_tuneout with a note, accepted as waiting during
 * a surgery's hold, whose first run at the release fails its durability
 * check: the tune-out stays in force, the cancel and its note waiting. A
 * primer row in the subconscious's context shows that context survives the
 * restart.
 */
async function noteWaitingAfterFailedRelease() {
  const { f, registry, release, coordinator } = await heldDuringSurgery();
  const fw = f.framework as unknown as Restartable;
  const sub = fw.subconsciousAgentName!;
  assert.ok(sub, 'premise: a persistent subconscious');
  const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
  fw.addMessage('user', [{ type: 'text', text: 'primer 7a2d: the subconscious read this before the stop' }], { system: true }, { forAgent: sub });
  const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: 'Someone asked for you.' }, [], sub);
  assert.equal(answer.success, true, answer.error);
  assert.equal(waiting(answer).waiting, true, 'premise: accepted as waiting');
  const commit = fw.commitDeliveries.bind(fw);
  fw.commitDeliveries = () => false;
  release();
  fw.commitDeliveries = commit;
  assert.equal(registry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the first release failed its durability check, the tune-out stays in force');
  assert.ok(!has(f, 'Someone asked for you.'), 'premise: the note is not delivered');
  return { f, fw, sub, epochId, coordinator, release };
}

describe("a note waiting with an accepted cancel, after the host stops (AF #844 review, round 8)", () => {
  it("a stop before the hold ends tells the persistent subconscious after the restart that its note was lost, and why, with a turn to read it; the hold is still in force (Ivy-3594, finding 2)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId, release } = await noteWaitingAfterFailedRelease();
    try {
      await f.framework.stop();
      const lines = errors.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes('stopping:'));
      assert.ok(lines.some((l) => l.includes(`the note ${sub} left with it is not delivered`)), `the stop says the note is lost: ${lines.join('\n')}`);
      assert.ok(lines.some((l) => l.includes(sub) && l.includes('kept in the store for the next boot')), `and that its notice is kept in the store: ${lines.join('\n')}`);
      await f.create();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId,
        'the hold is still in force after the restart: the cancel is not run again');
      const window = presentedTo(f, sub);
      assert.ok(window.some((t) => t.includes('primer 7a2d')), 'premise: the subconscious kept its context across the restart');
      assert.deepEqual(window.filter((t) => t.includes('was not delivered')), [
        '[Tune-out: the note you left with your cancel of noisy was not delivered to agent. The host stopped while your '
        + 'cancel waited, so your cancel was lost, and the note with it. That tune-out is still in force.]',
      ], "the next boot writes the loss into the subconscious's window, with the reason");
      assert.ok(internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason === 'tune-out note not delivered: noisy'),
        'and asks for a turn to read it');
      const record = (f.framework as unknown as Restartable).channelRegistry.readCoordinatorState(LOSS_RECORD) as { pendingLossNotices: unknown[] };
      assert.deepEqual(record.pendingLossNotices, [], 'and the record no longer holds it');
      assert.deepEqual(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), { ok: true },
        'control: a later cancel ends the hold');
      assert.ok(!has(f, 'Someone asked for you.'), 'and the lost note is not delivered then either');
    } finally {
      errors.mock.restore();
      release();
      await f.close();
    }
  });

  it("a note that can't be delivered when another cancel ends its hold is told in that cancel's release, which the subconscious still has after a restart though the store refused the notice and the loss record through the stop (Ivy-3594, finding 3)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, fw, sub, release } = await noteWaitingAfterFailedRelease();
    try {
      const add = fw.addMessage.bind(fw);
      fw.addMessage = (participant, content, metadata, opts) => {
        if (metadata?.kind === 'subconscious-note') throw new Error('the store refused the note (test)');
        if (metadata?.kind === 'tune-out-note-undelivered') throw new Error('the store refused the notice (test)');
        return add(participant, content, metadata, opts);
      };
      const states = fw.channelRegistry;
      const write = states.writeCoordinatorState.bind(states);
      states.writeCoordinatorState = (id, value) => {
        if (id === LOSS_RECORD) throw new Error('the store refused the record (test)');
        write(id, value);
      };
      assert.deepEqual(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), { ok: true },
        "the resident's cancel ends the hold");
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), null);
      await f.framework.stop();
      await f.create();
      const told = '[Tune-out: noisy cancelled — agent request, 0 wakes]\n\nThe note Subconscious left with an earlier cancel '
        + 'of noisy was not delivered to agent. This cancel ended that tune-out while that one waited, and delivering the '
        + 'note then failed: the store refused the note (test).';
      const window = presentedTo(f, sub);
      assert.ok(window.some((t) => t.includes('primer 7a2d')), 'premise: the subconscious kept its context across the restart');
      assert.deepEqual(window.filter((t) => t.includes('was not delivered')), [told],
        "the subconscious has the loss, with the reason, in the release that ended the hold");
      assert.ok(presentedTo(f, 'agent').includes(told), 'and so does the resident');
      assert.ok(!has(f, 'Someone asked for you.'), 'premise: the note was not delivered');
    } finally {
      errors.mock.restore();
      release();
      await f.close();
    }
  });
});
