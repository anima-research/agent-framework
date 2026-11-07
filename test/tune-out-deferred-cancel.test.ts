import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually, crash } from './helpers/coalescing-fixture.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { AgentFramework } from '../src/framework.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { SUB, internals, textOf, stored, has, find, registerOpen, enter, type Fixture, type Stored } from './helpers/admission.js';
import { WriteOutcomeUnknownError } from '../src/context-manager-errors.js';
import { ShutdownTimeoutError } from '../src/shutdown.js';

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
  assert.match(note, /Cancelling again doesn't end the wait sooner while that lasts, and how long it lasts isn't known here/, `says asking again won't end it: ${note}`);
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
      assert.match(waiting(answer).note ?? '', /The waiting cancel isn't kept in the store: if the host stops before the tune-out ends, the cancel is lost, and your note with it unless it was delivered already; you are told of a lost note by such a notice, kept in the store for the host to write when it starts again; if the store refuses that too, or the host crashes, you are told when it starts again that any cancel of the tune-out then waiting was lost, with any note left with it that had not been delivered\.$/,
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
  let commits = 0;
  fw.commitDeliveries = () => { commits++; return false; };
  release();
  fw.commitDeliveries = commit;
  assert.ok(commits > 0, "premise: the waiting cancel ran at the release, and its release's durability check was asked (review 2, #106)");
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
      assert.deepEqual(window.filter((t) => t.includes('without recording')), [],
        "the specific notice only: the stop's stamp covers the hold, so no notice of an unrecorded stop is written (Ivy-3594, round 8)");
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

// ---------------------------------------------------------------------------
// AF #844 review, round 8 (Ivy-3594, the stop stamp): a stop records which
// holds it left on record with their waiting cancels accounted for. A boot
// that finds a hold the stamp doesn't cover (a crash, or a stop whose
// writes the store refused) tells the persistent subconscious that any
// cancel of it then waiting was lost, with any note left with it.
// ---------------------------------------------------------------------------

const unrecorded = (epochId: string): string => `[Tune-out: the host stopped without recording the state of the tune-out of noisy `
  + `(epoch ${epochId}). If you asked for a cancel of it before the stop, it had not run when the host stopped: it was lost, and `
  + 'any note you left with it. That tune-out is still in force.]';
// The first release, its sync refused, was the subconscious's own cancel's (Weft, finding 4).
const ranWithNote = (epochId: string): string => `[Tune-out: the host stopped without recording the state of the tune-out of noisy `
  + `(epoch ${epochId}). Your cancel of it ran: its release reached agent, with the note you left with it. Its end was `
  + 'not recorded, so that tune-out is still in force.]';
const ranUnasked = (epochId: string): string => `[Tune-out: the host stopped without recording the state of the tune-out of noisy `
  + `(epoch ${epochId}). Your cancel of it ran: its release reached agent. Its end was not recorded, so that tune-out is still in force.]`;

/** The process dies: nothing the stop would write to the coordinator's state reaches the store. */
async function crashLosingStopWrites(f: Fixture): Promise<void> {
  const states = (f.framework as unknown as Restartable).channelRegistry;
  const write = states.writeCoordinatorState.bind(states);
  states.writeCoordinatorState = (id, value) => { if (!id.startsWith('tune-out/')) write(id, value); };
  await crash(f);
}

/** The registry refuses to record a hold's end once, as a process that dies just before recording it would leave it. */
function endNotRecorded(f: Fixture): void {
  const registry = internals(f).channelRegistry as unknown as { cancelTuneOut(...args: unknown[]): unknown };
  registry.cancelTuneOut = () => { throw new Error('the process died before the end was recorded (test)'); };
}

/** A plain hold on noisy, with a primer row in the subconscious's context to show it survives the restart. */
async function heldWithPrimer() {
  const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
  await registerOpen(f, 'work', 'noisy');
  enter(f, 'noisy', { backlogCap: 10 });
  const fw = f.framework as unknown as Restartable;
  const sub = fw.subconsciousAgentName!;
  assert.ok(sub, 'premise: a persistent subconscious');
  fw.addMessage('user', [{ type: 'text', text: 'primer 7a2d: the subconscious read this before the stop' }], { system: true }, { forAgent: sub });
  return { f, sub, epochId: internals(f).channelRegistry.getTuneOutState('editor', 'noisy')!.params.epochId };
}

describe("a hold on record that the last stop didn't stamp (AF #844 review, round 8)", () => {
  it("a waiting note whose release and a later cancel both fail on a store write, at a stop whose record and stamp the store refuses, is told after the restart as a cancel the stop didn't record, with a turn to read it (Ivy-3594)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, fw, sub, epochId, release } = await noteWaitingAfterFailedRelease();
    try {
      const add = fw.addMessage.bind(fw);
      fw.addMessage = (participant, content, metadata, opts) => {
        if (metadata?.kind === 'subconscious-note' || metadata?.kind === 'tune-out-cancel') throw new Error('EACCES: the store refused the write (test)');
        return add(participant, content, metadata, opts);
      };
      assert.throws(() => internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), /EACCES/,
        'premise: another cancel fails too, on its write');
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold stays in force');
      const states = fw.channelRegistry;
      states.writeCoordinatorState = (id) => { throw new Error(`EACCES: the store refused ${id} (test)`); };
      await f.framework.stop();
      const lines = errors.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes('stopping:'));
      assert.ok(lines.some((l) => l.includes('could not be stamped')), `the stop says it could not stamp: ${lines.join('\n')}`);
      await f.create();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'the hold is resumed');
      const window = presentedTo(f, sub);
      assert.ok(window.some((t) => t.includes('primer 7a2d')), 'premise: the subconscious kept its context across the restart');
      assert.deepEqual(window.filter((t) => t.includes('without recording')), [ranUnasked(epochId)],
        "the subconscious's presented context has the reasoned row: the first release, its sync refused, is stored (Weft, finding 2)");
      assert.ok(internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason === 'tune-out stop not recorded: noisy'),
        'and a turn to read it is queued');
      assert.deepEqual(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), { ok: true },
        'a later note-free cancel ends the hold');
      assert.deepEqual(presentedTo(f, sub).filter((t) => t.includes('without recording')), [ranUnasked(epochId)], 'the row stays, once');
      assert.ok(!has(f, 'Someone asked for you.'), 'premise: the note was never delivered');
    } finally {
      errors.mock.restore();
      release();
      await f.close();
    }
  });

  it("a clean stop and start with a hold on record and no cancel waiting tell the subconscious nothing: the stamp covers the hold", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId } = await heldWithPrimer();
    try {
      await f.framework.stop();
      await f.create();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold is resumed');
      const window = presentedTo(f, sub);
      assert.ok(window.some((t) => t.includes('primer 7a2d')), 'premise: the subconscious kept its context across the restart');
      assert.deepEqual(window.filter((t) => t.includes('without recording') || t.includes('was not delivered')), [], 'no loss row');
      assert.ok(!internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason.startsWith('tune-out stop not recorded')), 'and no turn for one');
      const stamp = (f.framework as unknown as Restartable).channelRegistry.readCoordinatorState('tune-out/agent/stop-stamp') as { v: number; epochs: string[]; runStartedAt?: unknown };
      assert.deepEqual([stamp.v, stamp.epochs, typeof stamp.runStartedAt], [1, [], 'number'],
        "the boot writes the stamp again covering no hold, with its run's start, so it covers no later stop");
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  it("a crash (no stop's writes reach the store) with a hold on record: the next start tells the subconscious that a cancel it asked for then, if any, was lost, with a turn to read it", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId } = await heldWithPrimer();
    try {
      await crashLosingStopWrites(f);
      await f.create();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold is resumed');
      const window = presentedTo(f, sub);
      assert.ok(window.some((t) => t.includes('primer 7a2d')), 'premise: the subconscious kept its context across the restart');
      assert.deepEqual(window.filter((t) => t.includes('without recording')), [unrecorded(epochId)], 'the row');
      assert.ok(internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason === 'tune-out stop not recorded: noisy'),
        'and a turn to read it');
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });
});

describe("what a boot after an unrecorded stop can tell of a waiting note (AF #844 review, round 8, Andrew-3578)", () => {
  it("a waiting note written to the resident before another cancel's release, whose end the crash left unrecorded, is told as delivered, not lost", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId, release } = await noteWaitingAfterFailedRelease();
    try {
      endNotRecorded(f);
      assert.throws(() => internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), /before the end was recorded/,
        "premise: the resident's cancel wrote the note and its release, and synced them, but its end was not recorded");
      assert.ok(has(f, 'Someone asked for you.'), 'premise: the note is in the residents\' store');
      await crashLosingStopWrites(f);
      await f.create();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold is resumed');
      const window = presentedTo(f, sub);
      assert.deepEqual(window.filter((t) => t.includes('without recording')), [ranWithNote(epochId)],
        'the row says the cancel ran and the note was delivered, its release being stored too (Weft, finding 2)');
      assert.ok(!window.some((t) => t.includes('it was lost')), 'and not that it was lost');
      assert.ok(internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason === 'tune-out stop not recorded: noisy'), 'with a turn to read it');
    } finally {
      errors.mock.restore();
      release();
      await f.close();
    }
  });

  it("a waiting note whose loss another cancel's release told, that release's end left unrecorded by a crash, gets no row of its own: the release told it", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, fw, sub, epochId, release } = await noteWaitingAfterFailedRelease();
    try {
      const add = fw.addMessage.bind(fw);
      fw.addMessage = (participant, content, metadata, opts) => {
        if (metadata?.kind === 'subconscious-note') throw new Error('the store refused the note (test)');
        return add(participant, content, metadata, opts);
      };
      endNotRecorded(f);
      assert.throws(() => internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), /before the end was recorded/);
      await crashLosingStopWrites(f);
      await f.create();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold is resumed');
      const window = presentedTo(f, sub);
      assert.deepEqual(window.filter((t) => t.includes('This cancel ended that tune-out while that one waited')).length, 1,
        'premise: the release that tells the loss is in the subconscious\'s window');
      assert.deepEqual(window.filter((t) => t.includes('without recording')), [], 'and no row of an unrecorded stop is added');
      assert.ok(!internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason.startsWith('tune-out stop not recorded')));
    } finally {
      errors.mock.restore();
      release();
      await f.close();
    }
  });
});

describe("a release that tells a waiting note's loss leaves the subconscious a turn that outlives a stop (AF #844 review, round 8, Ivy-3594)", () => {
  for (const answered of [false, true]) it(answered
    ? "control: a turn of the subconscious's after the release, before the stop, leaves no turn asked for again at the start"
    : "the loss-carrying release stored and synced, an orderly stop, and a start on the same store: the subconscious has a turn asked for to read it", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, fw, sub, release } = await noteWaitingAfterFailedRelease();
    try {
      const add = fw.addMessage.bind(fw);
      let refuse = true;
      fw.addMessage = (participant, content, metadata, opts) => {
        if (refuse && metadata?.kind === 'subconscious-note') throw new Error('EACCES: the store refused the note (test)');
        return add(participant, content, metadata, opts);
      };
      assert.deepEqual(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), { ok: true },
        "the resident's cancel ends the hold, its release telling the note's loss");
      refuse = false;
      assert.ok(presentedTo(f, sub).some((t) => t.includes('This cancel ended that tune-out while that one waited')),
        "premise: shown to the subconscious at rest before the stop, its turn asked for in memory only");
      // Its turn, read: a row of its own after the release in its window.
      if (answered) fw.addMessage(sub, [{ type: 'text', text: 'Noted: my note was lost.' }], {}, { forAgent: sub });
      await f.framework.stop();
      await f.create();
      const window = presentedTo(f, sub);
      assert.equal(window.filter((t) => t.includes('This cancel ended that tune-out while that one waited')).length, 1,
        "premise: the subconscious's presented context holds the release with the loss");
      assert.equal(internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason === 'tune-out note not delivered: noisy'), !answered,
        `${answered ? 'no turn is asked again' : 'a turn is asked for the subconscious to read it'}: ${JSON.stringify(internals(f).pendingRequests)}`);
    } finally {
      errors.mock.restore();
      release();
      await f.close();
    }
  });
});

describe("a boot after an unrecorded stop names the cancel the subconscious asked for (AF #844 review, round 8, Vincent-3603)", () => {
  /** The coordinator answers as if writes were held (a context manager refusing its work, say): its cancels wait, while the subconscious's own rows store. */
  function holdCoordinatorWrites(f: Fixture): void {
    (internals(f).tuneOutCoordinator as unknown as { hooks: { writesHeld?: () => boolean } }).hooks.writesHeld = () => true;
  }
  const NOTE = 'Antra asked for you in #noisy.\nShe needs the build log.';

  it("a cancel_tuneout with a note the subconscious called in a turn of its own, answered as waiting, then a crash: the next start's row names the cancel and quotes the note", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId } = await heldWithPrimer();
    try {
      holdCoordinatorWrites(f);
      const membrane = f.membrane as unknown as { responses: unknown[]; responseIndex: number; pushResponse(r: unknown): void };
      membrane.responses.length = 0; // the fixture pre-scripts an `ok`
      membrane.responseIndex = 0;
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'sub-cancel', name: 'cancel_tuneout', input: { channelId: 'noisy', text: NOTE } },
      ] as never, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Waiting for the cancel.' }] as never));
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: sub, reason: 'test', source: 'test', timestamp: Date.now() });
      void f.framework.runUntilIdle();
      const result = (): string | undefined => {
        for (const m of f.framework.getAgent(sub)!.getContextManager().getPresentedMessages() as unknown as Array<{ content: Array<{ type: string; toolUseId?: string; content?: unknown }> }>) {
          for (const b of m.content) if (b.type === 'tool_result' && b.toolUseId === 'sub-cancel') return String(b.content);
        }
        return undefined;
      };
      await eventually(() => result() !== undefined, "the subconscious's cancel_tuneout and its result are stored");
      assert.match(result()!, /"waiting":true/, 'premise: answered as waiting');
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold stays in force');
      await crashLosingStopWrites(f);
      await f.create();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold is resumed');
      const window = presentedTo(f, sub);
      assert.ok(window.some((t) => t.includes('primer 7a2d')), 'premise: the subconscious kept its context across the restart');
      assert.deepEqual(window.filter((t) => t.includes('without recording')), [
        `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${epochId}). The cancel of it you `
        + 'asked for with your note "Antra asked for you in #noisy." had not run when the host stopped: it was lost, and the note you '
        + 'left with it. That tune-out is still in force.]',
      ], 'the row names the cancel it asked for and quotes its note');
      assert.ok(internals(f).pendingRequests.some((r) => r.agentName === sub && r.reason === 'tune-out stop not recorded: noisy'), 'with a turn to read it');
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  it("the cancel the subconscious asked for ran, its release stored, and its end's record failed, then a crash: the row says it ran, its note with it, which goes out before the end (Weft, finding 2; review 2 #25)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId } = await heldWithPrimer();
    try {
      holdCoordinatorWrites(f);
      const membrane = f.membrane as unknown as { responses: unknown[]; responseIndex: number; pushResponse(r: unknown): void };
      membrane.responses.length = 0;
      membrane.responseIndex = 0;
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'sub-cancel', name: 'cancel_tuneout', input: { channelId: 'noisy', text: NOTE } },
      ] as never, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Waiting for the cancel.' }] as never));
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: sub, reason: 'test', source: 'test', timestamp: Date.now() });
      void f.framework.runUntilIdle();
      await eventually(() => (f.framework.getAgent(sub)!.getContextManager().getPresentedMessages() as unknown as Array<{ content: Array<{ type: string; toolUseId?: string }> }>)
        .some((m) => m.content.some((b) => b.type === 'tool_result' && b.toolUseId === 'sub-cancel')), "the subconscious's cancel_tuneout and its result are stored");
      // The writes resume: its run stores its release, and the end can't be recorded.
      (internals(f).tuneOutCoordinator as unknown as { hooks: { writesHeld?: () => boolean } }).hooks.writesHeld = () => false;
      endNotRecorded(f);
      internals(f).tuneOutCoordinator!.runDeferredCancels();
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold stays in force');
      assert.ok(stored(f).some((m) => (m.metadata as { kind?: unknown; epochId?: unknown } | undefined)?.kind === 'tune-out-cancel'
        && (m.metadata as { epochId?: unknown }).epochId === epochId), 'premise: its release is stored');
      await crashLosingStopWrites(f);
      await f.create();
      assert.deepEqual(presentedTo(f, sub).filter((t) => t.includes('without recording')), [
        `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${epochId}). The cancel of it you `
        + 'asked for ran: its release reached agent, with the note you left with it. Its end '
        + 'was not recorded, so that tune-out is still in force.]',
      ]);
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  it("three crashes with nothing asked tell the hold once, and leave one turn asked for (Weft, finding 5)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub } = await heldWithPrimer();
    try {
      for (let crashes = 0; crashes < 3; crashes++) {
        await crashLosingStopWrites(f);
        await f.create();
      }
      assert.equal(presentedTo(f, sub).filter((t) => t.includes('without recording')).length, 1, 'one row');
      assert.deepEqual(internals(f).pendingRequests.filter((r) => r.agentName === sub && r.reason.startsWith('tune-out')).map((r) => r.reason),
        ['tune-out stop not recorded: noisy'], 'one turn');
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  it("a subconscious whose window isn't presented is told a hold once across three crashes, as one whose window is (Weft, c55239d5, finding 6)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const proto = AgentFramework.prototype as unknown as { presents(agent: unknown): boolean };
    const presents = proto.presents;
    for (const presented of [true, false]) {
      // Forced from the first create, so every boot reads it so.
      if (!presented) proto.presents = function (this: unknown, agent: unknown) { return (agent as { name?: string } | undefined)?.name === 'Subconscious' ? false : presents.call(this, agent); };
      const { f, sub } = await heldWithPrimer();
      try {
        for (let crashes = 0; crashes < 3; crashes++) {
          await crashLosingStopWrites(f);
          await f.create();
        }
        const rows = (f.framework.getAgent(sub)!.getContextManager().getAllMessages() as unknown as Stored[]).map(textOf);
        assert.equal(rows.filter((t) => t.includes('without recording')).length, 1, `${presented ? 'presented' : 'not presented'}: one row`);
      } finally {
        proto.presents = presents;
        await f.close();
      }
    }
    errors.mock.restore();
  });

  it("the framework queues one tune-out turn per agent and reason (Weft, c55239d5, pin)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub } = await heldWithPrimer();
    try {
      const hooks = (internals(f).tuneOutCoordinator as unknown as { hooks: { requestInference(a: string, r: string, s: string): void } }).hooks;
      hooks.requestInference(sub, 'tune-out stop not recorded: noisy', 'tune-out');
      hooks.requestInference(sub, 'tune-out stop not recorded: noisy', 'tune-out');
      hooks.requestInference(sub, 'tune-out note not delivered: noisy', 'tune-out');
      assert.deepEqual(internals(f).pendingRequests.filter((r) => r.agentName === sub).map((r) => r.reason),
        ['tune-out stop not recorded: noisy', 'tune-out note not delivered: noisy']);
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  for (const guarded of [true, false]) it(guarded
    ? "with the tool-result guard on, a crash before the guard settles leaves a placeholder for the result: the boot reads the original from the guard's audit and names the cancel"
    : "control, the guard off: the same turn and crash name the cancel from the result row", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId } = await heldWithPrimer();
    try {
      const guard = (f.framework.getAgent(sub) as unknown as { toolResultGuard: { setOverride(v: boolean): void; settle?: unknown } }).toolResultGuard;
      guard.setOverride(guarded);
      // The process dies before the guard settles the batch: its placeholder stays the result row.
      (guard as unknown as { settle: () => void }).settle = () => {};
      holdCoordinatorWrites(f);
      const membrane = f.membrane as unknown as { responses: unknown[]; responseIndex: number; pushResponse(r: unknown): void };
      membrane.responses.length = 0;
      membrane.responseIndex = 0;
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'sub-cancel', name: 'cancel_tuneout', input: { channelId: 'noisy', text: NOTE } },
      ] as never, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Waiting for the cancel.' }] as never));
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: sub, reason: 'test', source: 'test', timestamp: Date.now() });
      void f.framework.runUntilIdle();
      const result = (): string | undefined => {
        for (const m of f.framework.getAgent(sub)!.getContextManager().getAllMessages() as unknown as Array<{ content: Array<{ type: string; toolUseId?: string; content?: unknown }> }>) {
          for (const b of m.content) if (b.type === 'tool_result' && b.toolUseId === 'sub-cancel') return String(b.content);
        }
        return undefined;
      };
      await eventually(() => result() !== undefined, "the subconscious's cancel_tuneout's result row is stored");
      if (guarded) assert.match(result()!, /withheld by the guard/, 'premise: the result row is the guard\'s placeholder');
      else assert.match(result()!, /"waiting":true/, 'premise: the result row is the answer');
      await crashLosingStopWrites(f);
      await f.create();
      assert.deepEqual(presentedTo(f, sub).filter((t) => t.includes('without recording')), [
        `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${epochId}). The cancel of it you `
        + 'asked for with your note "Antra asked for you in #noisy." had not run when the host stopped: it was lost, and the note you '
        + 'left with it. That tune-out is still in force.]',
      ]);
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  it("the guard's archived results are the subconscious's alone: another agent's staged record for the same tool use id is not read (Weft, 0401939e, pin)", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub } = await heldWithPrimer();
    try {
      type Appending = { append(record: Record<string, unknown>): void };
      const guardOf = (name: string) => (f.framework.getAgent(name) as unknown as { toolResultGuard: Appending }).toolResultGuard;
      const staged = (toolUseId: string, answer: unknown) => ({ type: 'staged', batchId: `b-${toolUseId}`, content: [{ type: 'tool_result', toolUseId, content: JSON.stringify(answer) }] });
      guardOf(sub).append(staged('x', { waiting: true, serverId: 'editor' }));
      guardOf('agent').append(staged('x', { cancelled: true }));
      guardOf('agent').append(staged('y', { waiting: true }));
      const read = (f.framework as unknown as { subconsciousGuardedResults(): Map<string, unknown> }).subconsciousGuardedResults();
      assert.deepEqual([...read.entries()], [['x', JSON.stringify({ waiting: true, serverId: 'editor' })]]);
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  // AF #844 bot review 2, finding 90.
  it("a staged audit record whose blob is missing, unreadable or isn't JSON is logged, naming the agent and the blob, and read as absent", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub } = await heldWithPrimer();
    try {
      type Appending = { append(record: Record<string, unknown>): void };
      const guard = (f.framework.getAgent(sub) as unknown as { toolResultGuard: Appending }).toolResultGuard;
      const garbled = f.framework.getStore().storeBlob(Buffer.from('not json {'), 'application/json');
      const gone = '0'.repeat(64);
      guard.append({ type: 'staged', batchId: 'b-gone', content: { blobId: gone } });
      guard.append({ type: 'staged', batchId: 'b-bad-id', content: { blobId: 'not-a-hash' } });
      guard.append({ type: 'staged', batchId: 'b-garbled', content: { blobId: garbled } });
      errors.mock.resetCalls();
      const read = (f.framework as unknown as { subconsciousGuardedResults(): Map<string, unknown> }).subconsciousGuardedResults();
      assert.deepEqual([...read.entries()], [], 'neither is read');
      const lines = errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
      for (const blob of [gone, 'not-a-hash', garbled]) {
        assert.ok(lines.some((l) => l.includes(sub) && l.includes(blob)), `logged, naming ${blob}: ${lines.join('\n')}`);
      }
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  it("control: the same cancel through executeToolCall, which stores no turn's rows, then a crash: the row stays conditional", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, sub, epochId } = await heldWithPrimer();
    try {
      holdCoordinatorWrites(f);
      const answer = await f.framework.executeToolCall({ id: 'c1', name: 'cancel_tuneout', input: { channelId: 'noisy', text: NOTE }, callerAgentName: sub } as never) as { success: boolean; data?: { waiting?: unknown } };
      assert.equal(answer.data?.waiting, true, `premise: answered as waiting: ${JSON.stringify(answer)}`);
      await crashLosingStopWrites(f);
      await f.create();
      assert.deepEqual(presentedTo(f, sub).filter((t) => t.includes('without recording')), [unrecorded(epochId)],
        'with no call of its own in its window, the row is the conditional one');
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (nissa's house's fault arm): a queued cancel's own run writes its
// note while writes are held again, so the note is kept in memory, and
// storing it at their release fails. The waiting answer promised the reader
// that it is told if the note can't be delivered, and why: the operator's
// `message:lost` and `store-held-lost` aren't that. The note isn't written
// again.
// ---------------------------------------------------------------------------

const HELD_NOTE = 'Antra asked for you in #noisy (held note 5c1e).';

type Held = Restartable & {
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  surgeryHeldWrites: Array<{ metadata?: Record<string, unknown> }>;
};

/**
 * The subconscious's cancel_tuneout with a note, accepted as waiting during
 * a surgery's hold. At the release its run stores its release and makes it
 * durable, and a second hold begins then (an operator's next change), so
 * the note it writes next is kept in memory, the tune-out still in force.
 * `fault`: storing that note at the second hold's release throws, a plain
 * error (`lost`) or one that can't tell what of it landed (`unknown`).
 */
async function noteKeptByItsOwnRun(fault?: 'lost' | 'unknown') {
  const { f, registry, release, coordinator } = await heldDuringSurgery();
  const fw = f.framework as unknown as Held;
  const sub = fw.subconsciousAgentName!;
  assert.ok(sub, 'premise: a persistent subconscious');
  const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
  fw.addMessage('user', [{ type: 'text', text: 'primer 7a2d: the subconscious read this before the hold' }], { system: true }, { forAgent: sub });
  const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: HELD_NOTE }, [], sub);
  assert.equal(answer.success, true, answer.error);
  assert.equal(waiting(answer).waiting, true, 'premise: accepted as waiting');
  assert.match(waiting(answer).note ?? '', /If it can't be delivered then, you are told so in your context, and why/,
    'premise: the waiting answer promises the reader is told of a loss');
  // Every write of the note the coordinator makes; the release's replay of a kept one isn't another.
  let noteWrites = 0;
  const add = fw.addMessage.bind(fw);
  fw.addMessage = (participant, content, metadata, opts) => {
    if (metadata?.kind === 'subconscious-note' && !(opts as { replayed?: boolean } | undefined)?.replayed) noteWrites++;
    return add(participant, content, metadata, opts);
  };
  const commit = fw.commitDeliveries.bind(fw);
  let again: (() => void) | undefined;
  fw.commitDeliveries = () => {
    const durable = commit();
    if (durable && !again && has(f, '<tuned-out-backlog')) again = fw.reserveStoreForSurgery('roll back', 'agent');
    return durable;
  };
  release();
  fw.commitDeliveries = commit;
  assert.ok(again, 'premise: a second hold began once the release was durable');
  assert.equal(fw.surgeryHeldWrites.filter((w) => w.metadata?.kind === 'subconscious-note').length, 1, 'premise: the note is kept in memory');
  assert.equal(registry.getTuneOutState('editor', 'noisy')?.params.epochId, epochId, 'premise: the hold stays in force while the note is kept');
  assert.equal(noteWrites, 1, 'premise: the note was written once');
  // Storing the note at the second hold's release throws.
  let attempts = 0;
  if (fault) {
    const manager = f.framework.getAgent('agent')!.getContextManager() as unknown as { addMessage(...args: unknown[]): string };
    const store = manager.addMessage;
    manager.addMessage = (...args: unknown[]) => {
      const [participant, , metadata] = args as [string, unknown, Record<string, unknown> | undefined];
      if (participant === sub && metadata?.kind === 'subconscious-note') {
        attempts++;
        throw fault === 'unknown'
          ? new WriteOutcomeUnknownError({ landed: [], unknown: [], unnamed: 1 }, new Error('the store read failed (test)'))
          : new Error('EIO: the store refused the held note (test)');
      }
      return store.apply(manager, args);
    };
  }
  const traces: Array<{ type: string; source?: string; kind?: string; mayBeStored?: boolean }> = [];
  const off = f.framework.onTrace((t) => { traces.push(t as never); });
  return {
    f, fw, sub, epochId, registry, traces, off,
    noteWrites: () => noteWrites, attempts: () => attempts,
    release: () => { release(); again!(); },
  };
}

/** The text blocks of the subconscious's next model request: a turn of its, with every call answered. */
async function subconsciousRequest(f: Fixture, sub: string): Promise<string[]> {
  const before = f.membrane.calls.length;
  f.alwaysRespond();
  if (!internals(f).pendingRequests.some((r) => r.agentName === sub)) {
    internals(f).pendingRequests.push({ agentName: sub, reason: 'test: a turn of the subconscious' } as never);
  }
  await f.framework.runUntilIdle();
  const request = f.membrane.calls.slice(before).find((r) => r.assistantParticipant === sub);
  assert.ok(request, "premise: the subconscious's turn made a model request");
  return (request.messages as unknown as Array<{ content: Array<{ type: string; text?: string }> }>)
    .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
}

const lostHeldNote = '[Tune-out: the note you left with your cancel of noisy was not delivered to agent. Your cancel ended '
  + 'that tune-out when it ran, and delivering the note then failed: EIO: the store refused the held note (test).]';

describe("a note kept in memory by its cancel's own run, whose store fails when the writes are stored (AF #844, nissa's house's fault arm)", () => {
  it("is told lost to the subconscious, with the reason, in its next request, and the hold ends; the note is written once, and the operator still hears of the lost write", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun('lost');
    try {
      h.release();
      assert.equal(h.registry.getTuneOutState('editor', 'noisy'), null, 'the hold ends once the writes are stored');
      assert.equal(h.attempts(), 1, 'storing the kept note was tried once');
      assert.equal(h.noteWrites(), 1, 'and the note is not written again');
      assert.ok(!has(h.f, HELD_NOTE), 'premise: the note did not land');
      assert.equal(h.traces.filter((t) => t.type === 'message:lost' && t.source === 'surgery-release').length, 1,
        'the framework still traces the lost write');
      assert.equal(h.traces.filter((t) => t.type === 'ops:alert' && t.kind === 'store-held-lost').length, 1,
        'and alerts the operator');
      assert.deepEqual(presentedTo(h.f, h.sub).filter((t) => t.includes('not delivered') || t.includes('may be lost')), [lostHeldNote],
        "the subconscious is told the note was lost, and why, once");
      assert.ok(internals(h.f).pendingRequests.some((r) => r.agentName === h.sub && r.reason === 'tune-out note not delivered: noisy'),
        'with a turn to read it');
      const request = await subconsciousRequest(h.f, h.sub);
      assert.ok(request.some((t) => t.includes(lostHeldNote)), `its next request carries the notice: ${JSON.stringify(request)}`);
    } finally {
      h.off();
      errors.mock.restore();
      h.release();
      await h.f.close();
    }
  });

  it("whose store can't tell whether it landed is told as a note that may be lost, with the reason", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun('unknown');
    try {
      h.release();
      assert.equal(h.registry.getTuneOutState('editor', 'noisy'), null, 'the hold ends once the writes are stored');
      assert.equal(h.attempts(), 1, 'storing the kept note was tried once');
      assert.equal(h.noteWrites(), 1, 'and the note is not written again');
      assert.equal(h.traces.filter((t) => t.type === 'message:lost' && t.mayBeStored === true).length, 1,
        'the framework traces the write as one that may be stored');
      const told = presentedTo(h.f, h.sub).filter((t) => t.includes('not delivered') || t.includes('may be lost'));
      assert.equal(told.length, 1, `told once: ${JSON.stringify(told)}`);
      assert.match(told[0]!, /^\[Tune-out: the note you left with your cancel of noisy may be lost\. Your cancel ended that tune-out when it ran, and whether the note was delivered to agent isn't known here, as what the store holds of it can't be read here: addMessage failed, and the manager can't tell whether the store holds a row of the append that threw: the store read failed \(test\)\.\]$/,
        'as one that may be lost, saying why it is not known');
      assert.doesNotMatch(told[0]!, /was not delivered/, 'never as one known lost');
      const request = await subconsciousRequest(h.f, h.sub);
      assert.ok(request.some((t) => t === told[0]), `its next request carries the notice: ${JSON.stringify(request)}`);
    } finally {
      h.off();
      errors.mock.restore();
      h.release();
      await h.f.close();
    }
  });

  for (const told of [true, false]) it(told
    ? "a stop and a start after the loss is told tell it no second time"
    : "a stop before its run tells the loss (its end not recorded at the release) tells it once, as the stop's loss, and the start writes that once", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun('lost');
    try {
      if (!told) endNotRecorded(h.f);
      h.release();
      assert.equal(h.registry.getTuneOutState('editor', 'noisy')?.params.epochId ?? null, told ? null : h.epochId,
        told ? 'premise: the hold ended, and the loss was told' : "premise: the cancel's run couldn't record the end, so it waits on");
      await h.f.framework.stop();
      await h.f.create();
      const notices = presentedTo(h.f, h.sub).filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
      assert.deepEqual(notices, [told ? lostHeldNote
        : '[Tune-out: the note you left with your cancel of noisy was not delivered to agent. The host stopped while your '
          + 'cancel waited, so your cancel was lost, and the note with it. That tune-out is still in force.]'],
      'the subconscious is told of the note once');
      assert.ok(!has(h.f, HELD_NOTE), 'and the note is not written after the restart');
    } finally {
      h.off();
      errors.mock.restore();
      h.release();
      await h.f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (nissa's house, the follow-up): the same kept note, stored when
// the writes are stored. The cancel can still wait after that: its run
// can't record the end, or writes are held again before it runs. A stop
// then must not tell the reader its note was lost: the resident has it.
// ---------------------------------------------------------------------------

describe("a note kept in memory by its cancel's own run and stored when the writes are stored (AF #844, nissa's house)", () => {
  for (const waits of ['its run can\'t record the end', 'writes are held again before it runs', 'a crash, its run unable to record the end'] as const) it(`counts as delivered: its cancel still waiting (${waits}), ${waits.startsWith('a crash') ? 'the next start reads the note as delivered' : 'a stop tells the subconscious no note lost, and the next start tells nothing of the hold'}`, async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun();
    try {
      if (waits === 'writes are held again before it runs') {
        // Writes are held again as soon as the kept note is stored, so the
        // release's run of the deferred cancels finds them held.
        const hooks = (internals(h.f).tuneOutCoordinator as unknown as { hooks: { writesHeld?: () => boolean } }).hooks;
        const off = h.f.framework.onTrace((t) => {
          if (t.type === 'message:added' && (t as { source?: string }).source === 'surgery-release' && has(h.f, HELD_NOTE)) hooks.writesHeld = () => true;
        });
        h.release();
        off();
      } else {
        endNotRecorded(h.f);
        h.release();
      }
      assert.equal(stored(h.f).filter((m) => textOf(m) === HELD_NOTE).length, 1, 'premise: the kept note was stored at the release, once');
      assert.equal(h.registry.getTuneOutState('editor', 'noisy')?.params.epochId, h.epochId, 'premise: the cancel still waits, the hold in force');
      if (waits.startsWith('a crash')) await crashLosingStopWrites(h.f);
      else await h.f.framework.stop();
      const lines = errors.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes('stopping:'));
      assert.ok(!lines.some((l) => l.includes('is not delivered')), `the stop says no note is lost: ${lines.join('\n')}`);
      await h.f.create();
      assert.equal(internals(h.f).channelRegistry.getTuneOutState('editor', 'noisy')?.params.epochId, h.epochId, 'the hold is still in force after the restart');
      const told = presentedTo(h.f, h.sub).filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
      assert.deepEqual(told, waits.startsWith('a crash') ? [ranWithNote(h.epochId)] : [],
        waits.startsWith('a crash')
          ? "the next start reads that run's rows: its cancel ran, with the note delivered"
          : 'the subconscious is told nothing: the note was delivered, and the stop accounted for the hold');
      const record = (h.f.framework as unknown as Restartable).channelRegistry.readCoordinatorState(LOSS_RECORD) as { pendingLossNotices?: unknown[] } | null;
      assert.deepEqual(record?.pendingLossNotices ?? [], [], 'no loss is kept in the store');
      assert.equal(stored(h.f).filter((m) => textOf(m) === HELD_NOTE).length, 1, 'the resident has the note once');
    } finally {
      h.off();
      errors.mock.restore();
      h.release();
      await h.f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (nissa's house, the third finding): the kept note's store throws
// a WriteOutcomeUnknownError at the release, and its cancel still waits
// (its run can't record the end). An orderly stop and a start in the same
// process: the subconscious is told the note may be lost, never that it
// was not delivered.
// ---------------------------------------------------------------------------

describe("a kept note whose store couldn't tell whether it landed, its cancel still waiting at an orderly stop (AF #844, nissa's house)", () => {
  it("is told after the start as a note that may be lost, with the reason, never as one that was not delivered", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun('unknown');
    try {
      endNotRecorded(h.f);
      h.release();
      assert.equal(h.attempts(), 1, 'premise: storing the kept note was tried once, and threw');
      assert.equal(h.traces.filter((t) => t.type === 'message:lost' && t.mayBeStored === true).length, 1, 'premise: as a write that may be stored');
      assert.equal(h.registry.getTuneOutState('editor', 'noisy')?.params.epochId, h.epochId, "premise: the cancel's run couldn't record the end, so it waits on");
      assert.deepEqual(presentedTo(h.f, h.sub).filter((t) => t.includes('not delivered') || t.includes('may be lost')), [], 'premise: nothing is told before the stop');
      await h.f.framework.stop();
      await h.f.create();
      const told = presentedTo(h.f, h.sub).filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
      assert.deepEqual(told, [
        '[Tune-out: the note you left with your cancel of noisy may be lost. The host stopped while your cancel waited, so your cancel was lost. '
        + "Whether the note was delivered to agent isn't known here, as what the store holds of it can't be read here: addMessage failed, and the "
        + "manager can't tell whether the store holds a row of the append that threw: the store read failed (test). That tune-out is still in force.]",
      ], 'the subconscious is told once that the note may be lost, and why it is not known');
      assert.ok(!told.some((t) => t.includes('was not delivered')), 'never as a note known lost');
      assert.ok(internals(h.f).pendingRequests.some((r) => r.agentName === h.sub && r.reason === 'tune-out note not delivered: noisy'), 'with a turn to read it');
    } finally {
      h.off();
      errors.mock.restore();
      h.release();
      await h.f.close();
    }
  });
});

// AF #844 bot review 5, #31: the same kept note, the host stopped by a
// listener of that write's `message:lost`, which the framework traces
// before it tells the coordinator (heldWriteLost). The stop proper runs only
// after the stop's wait (hold 2's order), so the coordinator has heard of
// the lost write by then.
describe("a kept note whose store couldn't tell whether it landed, the host stopped from a listener of that loss (AF #844 review 5, #31)", () => {
  it('is told after the start as a note that may be lost, never as one that was not delivered', async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun('unknown');
    let stopping: Promise<void> | undefined;
    try {
      endNotRecorded(h.f);
      const off = h.f.framework.onTrace((t) => {
        if (t.type === 'message:lost' && !stopping) stopping = h.f.framework.stop();
      });
      h.release();
      off();
      assert.ok(stopping, 'premise: a listener of the lost write stopped the host');
      await stopping;
      assert.equal(h.attempts(), 1, 'premise: storing the kept note was tried once, and threw');
      await h.f.create();
      const told = presentedTo(h.f, h.sub).filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
      assert.equal(told.length, 1, `told once: ${JSON.stringify(told)}`);
      assert.match(told[0]!, /^\[Tune-out: the note you left with your cancel of noisy may be lost\./, 'as a note that may be lost');
      assert.doesNotMatch(told[0]!, /was not delivered/, 'never as one known lost');
    } finally {
      h.off();
      errors.mock.restore();
      h.release();
      await h.f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (Weft's hold 2, her q4-stop-held probe): the waiting note is
// written into a second hold (B), and the host stops during B. stop()
// waits for the operator's operation, and B releases then, storing the
// note. The subconscious must not be told the note was lost.
// ---------------------------------------------------------------------------

type Probe = Restartable & {
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  surgeryHeldWrites: Array<{ metadata?: Record<string, unknown> }>;
};

/**
 * Weft's probe: a hold (A) during which the subconscious's cancel_tuneout
 * with a note waits. `stop-held`: A releases, the cancel's run stores its
 * release, and a second hold (B, a switch of every agent) begins at its
 * commit, so the note is kept in memory by B. `stop-nohold`: A is still
 * held. Either way the host stops then, the stop waits for the operator's
 * operation, and that hold releases during the wait; then a start on the
 * same store.
 */
async function weftHoldTwo(mode: 'stop-held' | 'stop-nohold') {
  const { f, registry, release: releaseA, coordinator } = await heldDuringSurgery();
  const fw = f.framework as unknown as Probe;
  const sub = fw.subconsciousAgentName!;
  const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
  const note = `NOTE-q4-${mode}`;
  fw.addMessage('user', [{ type: 'text', text: 'primer' }], { system: true }, { forAgent: sub });
  const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: note }, [], sub);
  assert.equal(waiting(answer).waiting, true, 'premise: the cancel waits');
  let releaseB: (() => void) | undefined;
  if (mode === 'stop-held') {
    const commit = fw.commitDeliveries.bind(fw);
    fw.commitDeliveries = () => {
      const durable = commit();
      const hasRelease = stored(f).some((m) => m.metadata?.kind === 'tune-out-cancel' && m.metadata.epochId === epochId);
      if (!releaseB && hasRelease) releaseB = fw.reserveStoreForSurgery('switch branch', 'every agent');
      return durable;
    };
    releaseA();
    fw.commitDeliveries = commit;
    assert.ok(releaseB, 'premise: hold B began at the release commit');
    assert.equal(fw.surgeryHeldWrites.filter((w) => w.metadata?.kind === 'subconscious-note').length, 1, 'premise: B keeps the note in memory');
  }
  assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the hold is in force at the stop');
  const stopping = f.framework.stop();
  const raced = await Promise.race([stopping.then(() => 'stopped'), new Promise((r) => setTimeout(() => r('still stopping'), 300))]);
  assert.equal(raced, 'still stopping', "premise: the stop waits for the operator's operation");
  if (releaseB) releaseB(); else releaseA();
  await stopping;
  await f.create();
  const noteRows = stored(f).filter((m) => m.metadata?.kind === 'subconscious-note' && textOf(m) === note).length;
  const told = presentedTo(f, sub).filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
  const lossTurns = internals(f).pendingRequests.filter((r) => r.agentName === sub && r.reason.startsWith('tune-out note not delivered'));
  return { f, sub, note, noteRows, told, lossTurns, inForce: !!internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), releaseA, releaseB };
}

describe("a stop while an operator's change keeps the waiting note in memory (AF #844, Weft's hold 2)", () => {
  it("the stop's wait lets the change release and store the note: after the start the resident has it, and the subconscious is told no loss and asked no turn for one", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await weftHoldTwo('stop-held');
    try {
      assert.equal(h.noteRows, 1, "the note is in the resident's store once");
      assert.deepEqual(h.told, [], 'the subconscious is told no loss');
      assert.deepEqual(h.lossTurns, [], 'and asked no turn to read one');
      assert.equal(h.inForce, false, "the waiting cancel ran once the change released, before the stop finished: the hold ended");
    } finally {
      errors.mock.restore();
      h.releaseA();
      h.releaseB?.();
      await h.f.close();
    }
  });

  it("with the cancel still waiting for the first change, which the stop's wait lets release, the cancel runs then: the note is stored once, the hold ends, and nothing is told", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await weftHoldTwo('stop-nohold');
    try {
      assert.equal(h.noteRows, 1, "the note is in the resident's store once");
      assert.deepEqual(h.told, [], 'nothing is told: the cancel ran, with its note');
      assert.deepEqual(h.lossTurns, [], 'and no turn is asked for a loss');
      assert.equal(h.inForce, false, 'the hold ended');
    } finally {
      errors.mock.restore();
      h.releaseA();
      await h.f.close();
    }
  });
});

// Weft's word on 341f99f0 (the item not run): with the stop's new order a
// waiting cancel can complete inside the stop's wait, after the queue has
// closed. The release (stored then, or before the stop with the hold
// ending only then) is presented to the resident at rest, so the boot's
// wake for rows its window is still owed doesn't count it, and the wake the
// cancel asked for went with the stop.
describe("the resident's wake for a release that a cancel completed inside the stop's wait (Weft's not-run on 341f99f0)", () => {
  for (const mode of ['stop-held', 'stop-nohold'] as const) it(`${mode}: the next start asks the resident's turn once, as it would for a release whose wake a stop lost before it was run`, async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await weftHoldTwo(mode);
    try {
      assert.equal(h.inForce, false, 'premise: the cancel ran inside the stop, and the hold ended');
      const release = stored(h.f).filter((m) => m.metadata?.kind === 'tune-out-cancel');
      assert.equal(release.length, 1, 'premise: one release row');
      const resident = h.f.framework.getAgent('agent')!.getContextManager();
      const releaseId = (release[0] as unknown as { id: string }).id;
      assert.ok(resident.getPresentedMessages().some((m) => m.id === releaseId), "premise: the release is in the resident's window, not owed");
      const wakes = (internals(h.f).pendingRequests as Array<{ agentName: string; reason: string; source?: string }>)
        .filter((r) => r.agentName === 'agent' && r.source === 'tune-out');
      assert.deepEqual(wakes.map((r) => r.reason), ['tune-out released (restored)'], "the resident's turn is asked for, once");
    } finally {
      errors.mock.restore();
      h.releaseA();
      h.releaseB?.();
      await h.f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (Weft, Q5, her notice-dup probe): a loss notice whose own write
// begins a hold is kept in memory; the hold's release stores it, and the
// notice, still kept, was written again: the subconscious had it twice,
// under one lossNoticeId.
// ---------------------------------------------------------------------------

describe("a loss notice whose own write begins a hold (AF #844, Weft's notice-dup)", () => {
  for (const dup of [true, false]) it(dup
    ? "is written once: the hold's release stores the kept write, and the notice isn't written again"
    : 'control: a notice whose write begins no hold is written once', async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, release: releaseA, coordinator } = await heldDuringSurgery();
    const fw = f.framework as unknown as Probe;
    const sub = fw.subconsciousAgentName!;
    let releaseB: (() => void) | undefined;
    try {
      const note = 'NOTE-q5';
      const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: note }, [], sub);
      assert.equal(waiting(answer).waiting, true, 'premise: the cancel waits');
      const manager = f.framework.getAgent('agent')!.getContextManager() as unknown as { addMessage(...args: unknown[]): string };
      const store = manager.addMessage;
      manager.addMessage = (...args: unknown[]) => {
        const [participant, , metadata] = args as [string, unknown, Record<string, unknown> | undefined];
        if (participant === sub && metadata?.kind === 'subconscious-note') throw new Error('EIO: note refused (probe)');
        return store.apply(manager, args);
      };
      if (dup) {
        const add = fw.addMessage.bind(fw);
        fw.addMessage = (participant, content, metadata, opts) => {
          if (metadata?.kind === 'tune-out-note-undelivered' && !releaseB) releaseB = fw.reserveStoreForSurgery('switch branch', 'every agent');
          return add(participant, content, metadata, opts);
        };
      }
      releaseA();
      const notices = () => (f.framework.getAgent(sub)!.getContextManager().getAllMessages() as unknown as Stored[])
        .filter((m) => m.metadata?.kind === 'tune-out-note-undelivered');
      if (dup) {
        assert.ok(releaseB, 'premise: the notice began hold B as it was written');
        assert.equal(notices().length, 0, 'premise: the notice is kept in memory by B');
        releaseB!();
      }
      internals(f).tuneOutCoordinator!.runDeferredCancels();
      const ids = notices().map((m) => m.metadata?.lossNoticeId);
      assert.equal(ids.length, 1, `the subconscious has the notice once: ${JSON.stringify(ids)}`);
      assert.match(textOf(notices()[0]!), /was not delivered to agent\. Your cancel ended that tune-out when it ran, and delivering the note then failed: EIO: note refused \(probe\)\.\]$/);
    } finally {
      errors.mock.restore();
      releaseA();
      releaseB?.();
      await f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (Weft): the subconscious's cancel joins a waiting cancel (an end
// time's) after that one's first attempt wrote its release and failed, so
// no release names the subconscious. The run then delivers its note and
// can't record the end, and the host crashes. The boot read that release
// as another's: "a cancel of it that wasn't yours (duration elapsed) ran".
// ---------------------------------------------------------------------------

describe("a cancel the subconscious joined after the waiting one's release was written (AF #844, Weft)", () => {
  it("is told after a crash as its own cancel that ran, with the cancel it joined and the note it left", async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, registry, release: releaseA, coordinator } = await heldDuringSurgery();
    const fw = f.framework as unknown as Probe;
    const sub = fw.subconsciousAgentName!;
    const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
    let releaseB: (() => void) | undefined;
    try {
      fw.addMessage('user', [{ type: 'text', text: 'primer 7a2d' }], { system: true }, { forAgent: sub });
      assert.deepEqual(coordinator.cancel('editor', 'noisy', 'duration', 'duration elapsed'), { ok: true, deferred: true }, 'premise: the end time\'s cancel waits');
      // Its first attempt at the release writes its release, which isn't made durable: it waits on.
      const commit = fw.commitDeliveries.bind(fw);
      fw.commitDeliveries = () => false;
      releaseA();
      fw.commitDeliveries = commit;
      assert.equal(stored(f).filter((m) => m.metadata?.kind === 'tune-out-cancel' && m.metadata.epochId === epochId).length, 1, 'premise: its release is written');
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the hold is in force');
      // Writes are held again, and the subconscious's cancel, with a note, joins the one waiting.
      releaseB = fw.reserveStoreForSurgery('roll back', 'agent');
      const answer = await f.framework.executeToolCall({ id: 'c1', name: 'cancel_tuneout', input: { channelId: 'noisy', text: 'Joined note 9b1.' }, callerAgentName: sub } as never) as { data?: { waiting?: unknown } };
      assert.equal(answer.data?.waiting, true, `premise: answered as waiting: ${JSON.stringify(answer)}`);
      // The run delivers the note and can't record the end; the host crashes.
      endNotRecorded(f);
      releaseB();
      assert.ok(has(f, 'Joined note 9b1.'), 'premise: the note was delivered');
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the end was not recorded');
      await crashLosingStopWrites(f);
      await f.create();
      assert.deepEqual(presentedTo(f, sub).filter((t) => t.includes('without recording')), [
        `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${epochId}). Your cancel of it ran `
        + '(with the cancel for duration elapsed): its release reached agent, with the note you left with it. Its end was not recorded, '
        + 'so that tune-out is still in force.]',
      ], 'the row says the cancel that ran was its own, joined to the end time\'s');
    } finally {
      errors.mock.restore();
      releaseA();
      releaseB?.();
      await f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (Weft's hold-2 siblings, her p2 and p3 probes). p2: a hold begins
// at a write of the waiting cancel's run, its note or its release, either
// before the write lands (the write is kept in memory) or just after it
// returns (the write is stored, and only then are writes held); then the
// host stops, and the stop's wait lets the hold release. p3: the release
// that tells the queued note's loss is the one kept. With no stop (the
// controls) nothing false is told; with one, nothing false may be either.
// ---------------------------------------------------------------------------

const P2_NOTE = 'Antra asked for you in #noisy (note 9b3f).';

async function weftP2(kind: 'note' | 'release', when: 'kept' | 'after', stop: boolean) {
  const { f, registry, release, coordinator } = await heldDuringSurgery();
  const fw = f.framework as unknown as Probe;
  const sub = fw.subconsciousAgentName!;
  const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
  const wantKind = kind === 'note' ? 'subconscious-note' : 'tune-out-cancel';
  fw.addMessage('user', [{ type: 'text', text: 'primer 7a2d' }], { system: true }, { forAgent: sub });
  const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: P2_NOTE }, [], sub);
  assert.equal(waiting(answer).waiting, true, 'premise: the cancel waits');
  const add = fw.addMessage.bind(fw);
  let again: (() => void) | undefined;
  let returned: string | undefined;
  fw.addMessage = (participant, content, metadata, opts) => {
    if (!again && metadata?.kind === wantKind && !(opts as { replayed?: boolean } | undefined)?.replayed) {
      if (when === 'kept') {
        again = fw.reserveStoreForSurgery('roll back', 'agent');
        return (returned = add(participant, content, metadata, opts));
      }
      returned = add(participant, content, metadata, opts);
      again = fw.reserveStoreForSurgery('roll back', 'agent');
      return returned;
    }
    return add(participant, content, metadata, opts);
  };
  release();
  fw.addMessage = add;
  assert.ok(again, `premise: a second hold began at the ${wantKind} write`);
  assert.equal(returned === '', when === 'kept', `premise: the write ${when === 'kept' ? 'was kept in memory' : 'was stored'}`);
  assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the hold is in force');
  const rowsOf = () => stored(f).filter((m) => m.metadata?.kind === wantKind && m.metadata.epochId === epochId).length;
  if (stop) {
    const stopping = f.framework.stop();
    again!();
    await stopping;
    await f.create();
  } else {
    again!();
  }
  const told = presentedTo(f, sub).filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
  const notes = stored(f).filter((m) => textOf(m) === P2_NOTE).length;
  return { f, told, notes, rows: rowsOf(), inForce: !!internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), release, again };
}

describe("a hold begun at a write of the waiting cancel's run, then a stop (AF #844, Weft's p2)", () => {
  for (const kind of ['note', 'release'] as const) for (const when of ['kept', 'after'] as const) for (const stop of [true, false]) {
    it(`${stop ? '' : 'control (no stop): '}a hold begun ${when === 'kept' ? 'as' : 'just after'} the ${kind} is written${when === 'kept' ? ', keeping it in memory' : ', which lands'}${stop ? ', then a stop whose wait lets it release' : ', then released'}: the note is stored once, the hold ends, and nothing is told`, async () => {
      const errors = mock.method(console, 'error', () => {});
      const h = await weftP2(kind, when, stop);
      try {
        assert.equal(h.notes, 1, "the note is in the resident's store once");
        assert.equal(h.rows, 1, `one ${kind} row of the hold`);
        assert.deepEqual(h.told, [], 'the subconscious is told nothing');
        assert.equal(h.inForce, false, 'the hold ended');
      } finally {
        errors.mock.restore();
        h.release();
        h.again?.();
        await h.f.close();
      }
    });
  }
});

describe("a release that tells a queued note's loss, kept in memory, then a stop (AF #844, Weft's p3)", () => {
  for (const stop of [true, false]) it(stop
    ? "the stop's wait lets it release: the subconscious holds that release once, no stop notice beside it, and the hold has ended"
    : 'control (no stop): the release stored at the hold\'s release tells the loss once, and the hold ends', async () => {
    const errors = mock.method(console, 'error', () => {});
    const { f, registry, release, coordinator } = await heldDuringSurgery();
    const fw = f.framework as unknown as Probe;
    const sub = fw.subconsciousAgentName!;
    const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
    let again: (() => void) | undefined;
    try {
      fw.addMessage('user', [{ type: 'text', text: 'primer 7a2d' }], { system: true }, { forAgent: sub });
      const answer = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: 'Antra asked for you in #noisy (note 4d1c).' }, [], sub);
      assert.equal(waiting(answer).waiting, true, 'premise: the cancel waits');
      // Its first run at the release can't make the release durable: it waits on.
      const commit = fw.commitDeliveries.bind(fw);
      let failOnce = true;
      fw.commitDeliveries = () => { if (failOnce) { failOnce = false; return false; } return commit(); };
      release();
      fw.commitDeliveries = commit;
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the hold is in force, the cancel waiting');
      // The note's store refuses it, and a hold begins as the release telling the loss is written.
      const manager = f.framework.getAgent('agent')!.getContextManager() as unknown as { addMessage(...args: unknown[]): string };
      const store = manager.addMessage;
      manager.addMessage = (...args: unknown[]) => {
        if ((args[2] as Record<string, unknown> | undefined)?.kind === 'subconscious-note') throw new Error('EIO: the store refused the note (probe)');
        return store.apply(manager, args);
      };
      const add = fw.addMessage.bind(fw);
      fw.addMessage = (participant, content, metadata, opts) => {
        if (!again && metadata?.kind === 'tune-out-cancel' && metadata.lostNote === true && !(opts as { replayed?: boolean } | undefined)?.replayed) {
          again = fw.reserveStoreForSurgery('roll back', 'agent');
        }
        return add(participant, content, metadata, opts);
      };
      const ending = coordinator.cancel('editor', 'noisy', 'agent-tool', 'agent request');
      fw.addMessage = add;
      manager.addMessage = store;
      assert.deepEqual(ending, { ok: true, deferred: true }, "premise: the resident's cancel waits, its release kept in memory");
      assert.ok(again, 'premise: a hold began at the release telling the loss');
      if (stop) {
        const stopping = f.framework.stop();
        again!();
        await stopping;
        await f.create();
      } else {
        again!();
      }
      const s2 = (f.framework as unknown as Probe).subconsciousAgentName!;
      const told = presentedTo(f, s2).filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
      assert.equal(told.length, 1, `the subconscious is told once: ${JSON.stringify(told)}`);
      assert.match(told[0]!, /^\[Tune-out: noisy cancelled — agent request, 0 wakes\]\n\nThe note Subconscious left with an earlier cancel of noisy was not delivered to agent\. This cancel ended that tune-out while that one waited, and delivering the note then failed: EIO: the store refused the note \(probe\)\.$/,
        'by the release that ended the hold');
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), null, 'and the hold has ended, as that release says');
    } finally {
      errors.mock.restore();
      release();
      again?.();
      await f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844, the stop's budget: written by nissa's house (Paloma-2644 wrote and
// ran it, Crispin-2406 ran it at 52364a32; comment of 2026-11-07T00:23Z on
// #844), added unchanged. A stop() whose wait for the operator's operations
// runs out while a hold still keeps the waiting note in memory; the hold
// then releases in the same process and stores the note.
// ---------------------------------------------------------------------------

/** What else a stop called now could await before the operator's operations: streams, the event loop, a maintenance pass. */
function stopAwaits(f: Fixture): string {
  const fw = f.framework as unknown as { activeStreams: Map<string, unknown>; loopPromise: unknown; maintenanceRunning(): boolean };
  return `at the stop call: activeStreams.size ${fw.activeStreams.size}, loopPromise ${fw.loopPromise ? 'set' : 'null'}, maintenanceRunning ${fw.maintenanceRunning()}`;
}

describe("a stop whose wait for the kept hold runs out, the hold released after it (AF #844, the stop's budget)", () => {
  it("budget run out, then the hold released: the subconscious isn't told the note was not delivered, nor owed a turn for that, where the resident has it", async (t) => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun();
    try {
      const kept = () => h.fw.surgeryHeldWrites.filter((w) => w.metadata?.kind === 'subconscious-note').length;
      t.diagnostic(stopAwaits(h.f));
      let firstError: unknown;
      const first = await h.f.framework.stop(2000).then(() => 'resolved', (error: unknown) => {
        firstError = error;
        return `rejected: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      });
      // The rejection is the operator wait's timeout itself, or an aggregate of the stop's errors; either way, only that timeout.
      const stopErrors = firstError instanceof ShutdownTimeoutError ? [firstError]
        : firstError instanceof AggregateError ? [...firstError.errors] : [firstError];
      t.diagnostic(`the first stop, a 2 s budget: ${first}; its errors: ${JSON.stringify(stopErrors.map((e) => e instanceof ShutdownTimeoutError
        ? { timeout: e.pending } : e instanceof Error ? `${e.name}: ${e.message}` : String(e)))}`);
      assert.match(first, /^rejected: /, 'premise: the first stop failed');
      assert.ok(stopErrors.length === 1 && stopErrors[0] instanceof ShutdownTimeoutError && stopErrors[0].pending.includes('surgery:roll back'),
        "premise: its one error is the operator wait's timeout, the second hold (surgery:roll back) still pending");
      assert.equal(kept(), 1, 'premise: the note still kept in memory by the hold when it failed');
      let released = 'released';
      try { h.release(); } catch (error) { released = `the release threw: ${error instanceof Error ? error.message : String(error)}`; }
      t.diagnostic(`the hold: ${released}; kept in memory after: ${kept()}`);
      const second = await h.f.framework.stop().then(() => 'resolved', (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`);
      t.diagnostic(`the second stop: ${second}`);
      await h.f.create();
      const residentRows = stored(h.f).filter((m) => textOf(m).includes(HELD_NOTE)).length;
      const notices = presentedTo(h.f, h.sub).filter((text) => text.includes('not delivered') || text.includes('may be lost') || text.includes('without recording'));
      const turns = internals(h.f).pendingRequests.filter((r) => r.agentName === h.sub).map((r) => r.reason);
      t.diagnostic(`the note's rows in the resident's record: ${residentRows}`);
      for (const notice of notices) t.diagnostic(notice);
      t.diagnostic(`the subconscious's pending turns: ${JSON.stringify(turns)}`);
      assert.ok(!(residentRows > 0 && notices.some((notice) => notice.includes('was not delivered'))),
        "where the resident has the note, the subconscious isn't told it was not delivered");
      assert.ok(!(residentRows > 0 && turns.some((reason) => reason.startsWith('tune-out note not delivered'))),
        'nor owed a turn to read that');
    } finally {
      h.off();
      errors.mock.restore();
      h.release();
      await h.f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844, the stop's budget, the one case the house left open: a host
// that passes its own store handle to a new create() in the same process
// while the old instance's hold still keeps the note. The new boot can read
// the record before the release stores the note; "may be lost" is the only
// true word there. Once the release stores it, a start after says it went.
// ---------------------------------------------------------------------------

describe("a stop whose wait for the kept hold runs out, and a start on the same store handle before the hold releases (AF #844, the stop's budget)", () => {
  it("the start tells the subconscious that the note may be lost, never that it was not delivered; after the release, the note is stored once", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun();
    const handle = h.f.framework.getStore();
    let next: AgentFramework | undefined;
    try {
      const first = await h.f.framework.stop(500).then(() => 'resolved', (error: unknown) => error);
      assert.ok(first instanceof ShutdownTimeoutError && first.pending.includes('surgery:roll back'), `premise: the stop's wait ran out: ${String(first)}`);
      assert.equal(h.fw.surgeryHeldWrites.filter((w) => w.metadata?.kind === 'subconscious-note').length, 1, 'premise: the note is still kept in memory');
      assert.equal(stored(h.f).filter((m) => textOf(m) === HELD_NOTE).length, 0, 'premise: the store holds no note yet');
      // A new instance on the same handle, as a host that passes its own store does.
      next = await AgentFramework.create({
        store: handle, membrane: h.f.membrane.asMembrane(),
        agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [], subconscious: SUB,
        mcplServers: [{ id: 'editor', url: `ws://127.0.0.1:${h.f.port}`, enabledFeatureSets: ['doc'] }],
      } as unknown as FrameworkConfig);
      const sub = (next as unknown as { subconsciousAgentName: string }).subconsciousAgentName;
      const told = (next.getAgent(sub)!.getContextManager().getPresentedMessages() as unknown as Stored[]).map(textOf)
        .filter((t) => t.includes('not delivered') || t.includes('may be lost') || t.includes('without recording'));
      assert.equal(told.length, 1, `told once: ${JSON.stringify(told)}`);
      assert.match(told[0]!, /Your cancel of it ran: its release reached agent\. Its end was not recorded, so that tune-out is still in force\. The note you left with your cancel of it was kept in memory when the host stopped, to be stored when an operator's change to the store ended, and the store didn't hold it when this was written: it may be lost\.\]$/,
        'that the note may be lost, and why that is all that is known');
      assert.doesNotMatch(told[0]!, /was not delivered|did not/, 'never that it was not delivered');
      const turns = (next as unknown as { pendingRequests: Array<{ agentName: string; reason: string }> }).pendingRequests
        .filter((r) => r.agentName === sub).map((r) => r.reason);
      assert.ok(!turns.some((reason) => reason.startsWith('tune-out note not delivered')), `no turn for a loss: ${JSON.stringify(turns)}`);
      // The old instance's hold releases now, and stores the note on the same handle.
      h.release();
      assert.equal((next.getAgent('agent')!.getContextManager().getAllMessages() as unknown as Stored[]).filter((m) => textOf(m) === HELD_NOTE).length, 1,
        'the note is stored once by the release');
    } finally {
      errors.mock.restore();
      h.release();
      await next?.stop().catch(() => {});
      h.off();
      await h.f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AF #844 (Oscar, nissa's house, at 412877b3): a cancel's release reaches
// the resident, but its end isn't recorded, so the tune-out stays in force.
// After the next start the resident had "[Tune-out: noisy cancelled — …]"
// and nothing after it saying the tune-out still stands. Two doors: (a) a
// budgeted stop whose wait ran out, the hold released after it; (b) a throw
// between the release and the end, as a store fault would give. The boot
// tells the resident once, in the pass that tells the subconscious.
// ---------------------------------------------------------------------------

const STILL_IN_FORCE = /^\[Tune-out: noisy is still tuned out\. Its release above reached you, but its end wasn't recorded before the host stopped, so the tune-out is still in force: what arrives there is held, and comes with its next release\. It ends when it is cancelled \(tune_out mode "cancel"\), or by itself at the first wake past its wake budget \(maxWakes 5\)\.\]$/;

/** The resident's window after the start: the release's first line and every row after it that says the tune-out still stands. */
function residentAfterStart(f: Fixture): { releases: number; stillInForce: string[]; releaseFirst: boolean } {
  const window = presentedTo(f, 'agent');
  const at = window.findIndex((t) => t.startsWith('[Tune-out: noisy cancelled'));
  const still = window.filter((t) => STILL_IN_FORCE.test(t));
  return {
    releases: window.filter((t) => t.startsWith('[Tune-out: noisy cancelled')).length,
    stillInForce: still,
    releaseFirst: at >= 0 && still.length > 0 && window.indexOf(still[0]!) > at,
  };
}

/** What a check and a second enter say of noisy now, once its server registers it again after the start: held count, and the refusal. */
async function whatTheChannelSays(f: Fixture): Promise<{ held: number | undefined; refusal: string }> {
  await f.send('channels/register', {
    channels: ['work', 'noisy'].map((id) => ({ id, type: 'discord', label: id, initiallyOpen: true, metadata: { channelType: 'guild_text' } })),
  });
  await eventually(() => internals(f).tuneOutCoordinator!.check().channels.some((c) => c.channelId === 'noisy'), 'noisy listed by a check');
  const held = internals(f).tuneOutCoordinator!.check().channels.find((c) => c.channelId === 'noisy')?.held;
  const answer = await internals(f).handleTuneOutTool('agent', { channelId: 'noisy' });
  return { held, refusal: answer.success ? `(entered: ${JSON.stringify(answer.data)})` : answer.error ?? '' };
}

describe("a release that reached the resident, its end not recorded (AF #844, Oscar)", () => {
  it("(a) a budgeted stop whose wait ran out, the hold released after it: after the start the resident is told, once, after the release, that the tune-out is still in force; a check and a second enter agree", async () => {
    const errors = mock.method(console, 'error', () => {});
    const h = await noteKeptByItsOwnRun();
    try {
      const first = await h.f.framework.stop(500).then(() => 'resolved', (error: unknown) => error);
      assert.ok(first instanceof ShutdownTimeoutError, `premise: the stop's wait ran out: ${String(first)}`);
      h.release();
      await h.f.framework.stop();
      await h.f.create();
      assert.ok(internals(h.f).channelRegistry.getTuneOutState('editor', 'noisy'), 'premise: the tune-out is still in force');
      const seen = residentAfterStart(h.f);
      assert.equal(seen.releases, 1, "premise: the release is in the resident's window");
      assert.equal(seen.stillInForce.length, 1, `the resident is told once that it still stands: ${JSON.stringify(presentedTo(h.f, 'agent'))}`);
      assert.ok(seen.releaseFirst, 'after the release');
      const request = await subconsciousRequest(h.f, 'agent');
      assert.ok(request.some((t) => STILL_IN_FORCE.test(t)), "the resident's first request carries it");
      const says = await whatTheChannelSays(h.f);
      assert.equal(says.held, 0, 'a check counts nothing held: what was held went with the release');
      assert.match(says.refusal, /is already tuned out/, 'a second enter is refused as one already tuned out');
      await h.f.framework.stop();
      await h.f.create();
      assert.equal(residentAfterStart(h.f).stillInForce.length, 1, 'a later start tells it no second time');
    } finally {
      errors.mock.restore();
      h.release();
      h.off();
      await h.f.close();
    }
  });

  it("(b) a throw between the release and the end, then a stop and a start: the resident is told, once, after the release, that the tune-out is still in force; a check and a second enter agree", async () => {
    const errors = mock.method(console, 'error', () => {});
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const registry = internals(f).channelRegistry;
      const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      (f.framework as unknown as Framework).addMessage('antra', [{ type: 'text', text: 'held 1f2e' }], {
        tuneOut: { epochId }, channelId: 'noisy', serverId: 'editor', author: { id: 'U1', name: 'antra' },
      });
      endNotRecorded(f);
      assert.throws(() => internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), /before the end was recorded/,
        'premise: the cancel stored its release and threw at its end');
      assert.match(textOf(find(f, '<tuned-out-backlog')), /held 1f2e/, 'premise: the release, with the held message, is stored');
      assert.ok(registry.getTuneOutState('editor', 'noisy'), 'premise: the tune-out is still in force');
      await f.framework.stop();
      await f.create();
      assert.ok(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), 'premise: still in force after the start');
      const seen = residentAfterStart(f);
      assert.equal(seen.releases, 1, "premise: the release is in the resident's window");
      assert.equal(seen.stillInForce.length, 1, `the resident is told once that it still stands: ${JSON.stringify(presentedTo(f, 'agent'))}`);
      assert.ok(seen.releaseFirst, 'after the release');
      const request = await subconsciousRequest(f, 'agent');
      assert.ok(request.some((t) => STILL_IN_FORCE.test(t)), "the resident's first request carries it");
      const says = await whatTheChannelSays(f);
      assert.equal(says.held, 0, 'a check counts nothing held: what was held went with the release');
      assert.match(says.refusal, /is already tuned out/, 'a second enter is refused as one already tuned out');
      await f.framework.stop();
      await f.create();
      assert.equal(residentAfterStart(f).stillInForce.length, 1, 'a later start tells it no second time');
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });

  it('control: a cancel that recorded its end tells the resident nothing of the kind after a start', async () => {
    const errors = mock.method(console, 'error', () => {});
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      assert.deepEqual(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'agent request'), { ok: true }, 'premise: the cancel ended it');
      await f.framework.stop();
      await f.create();
      assert.deepEqual(residentAfterStart(f).stillInForce, [], 'nothing says it still stands');
    } finally {
      errors.mock.restore();
      await f.close();
    }
  });
});
