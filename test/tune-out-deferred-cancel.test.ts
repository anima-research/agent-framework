import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { SUB, internals, textOf, has, find, registerOpen, enter } from './helpers/admission.js';

type Answer = { success: boolean; data?: unknown; error?: string };
type Framework = {
  addMessage(p: string, c: unknown[], m: Record<string, unknown>): string;
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  executeToolCall(call: unknown): Promise<Answer>;
};

const waiting = (answer: Answer): { waiting?: unknown; note?: string; cancelled?: unknown } =>
  (answer.data ?? {}) as { waiting?: unknown; note?: string; cancelled?: unknown };

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
      assert.match(result.error ?? '', /The focus on it ends once/, result.error);
      again();
      assert.equal(coordinator.getAllExcept(), null, 'ended at the release');
    } finally { release(); again(); await f.close(); }
  });
});
