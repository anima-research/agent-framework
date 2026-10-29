import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { SUB, internals, textOf, stored, has, find, registerOpen, enter } from './helpers/admission.js';

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
  assert.match(note, /Nothing you can do ends the wait sooner, cancelling again included/, `says it isn't the caller's to end: ${note}`);
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
      assert.match(result.error ?? '', /The focus on it ends once an operator's change to the store is over, or a context that refuses writes is re-initialized by the host/, result.error);
      assert.match(result.error ?? '', /Nothing you can do ends it sooner/, result.error);
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
      assert.doesNotMatch(waiting(answer).note ?? '', /note/, `nothing said of its note: ${waiting(answer).note}`);
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
      assert.doesNotMatch(waiting(first).note ?? '', /note/, 'the first caller is told nothing of a note');
      const second = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', text: 'The second note.' });
      assert.equal(second.success, true, second.error);
      assert.equal(waiting(second).waiting, true);
      assert.match(waiting(second).note ?? '', /Your note isn't delivered/, `the second caller is told: ${waiting(second).note}`);
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
      assert.doesNotMatch(waiting(first).note ?? '', /note/, 'the first caller is told nothing of a note');
      const second = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', scope: 'all-except', text: 'The second note.' });
      assert.equal(second.success, true, second.error);
      assert.equal(waiting(second).waiting, true);
      assert.match(waiting(second).note ?? '', /Your note isn't delivered/, `the second caller is told: ${waiting(second).note}`);
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
