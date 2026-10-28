/**
 * The all-except scope (issue #232 §3.2; focus folded into tune-out): hold
 * every channel except one, for a bounded time. A resident-level policy
 * epoch, decided by the same admission stage as a per-channel tune-out.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import type { ContentBlock } from '@animalabs/membrane';
import { createMockResponse, HeldStream } from './helpers/mock-membrane.js';
import {
  SUB, internals, textOf, stored, held, has, find, MENTION,
  incoming, dm, registerOpen, enter, settle, channellessTurnLocus,
} from './helpers/admission.js';

const epochOf = (m: { metadata?: Record<string, unknown> }): string | undefined =>
  (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId;

function enterAllExcept(f: Parameters<typeof internals>[0], except: string, opts: Record<string, number> = {}) {
  const r = internals(f).tuneOutCoordinator!.enterAllExcept(
    { serverId: 'editor', channelId: except }, { durationSeconds: 120, backlogCap: 10, ...opts }, 'agent-tool',
  );
  assert.ok(r.ok, `all-except: ${(r as { error?: string }).error ?? ''}`);
  return (r as { params: { epochId: string } }).params;
}

describe('tune-out, all-except scope', () => {
  it('holds every channel but the excepted one — including DMs and channels registered later', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      const scope = enterAllExcept(f, 'work');

      await incoming(f, 'noisy', 'n1', 'noise one');
      await settle(f);
      assert.equal(epochOf(find(f, 'noise one')), scope.epochId, 'held under the scope\'s epoch');

      await dm(f, 'dm-1', 'a dm while focused');
      await settle(f);
      assert.equal(epochOf(find(f, 'a dm while focused')), scope.epochId, 'a DM is held too (resident-level, not per channel)');

      await registerOpen(f, 'late');
      await incoming(f, 'late', 'l1', 'registered after entry');
      await settle(f);
      assert.equal(epochOf(find(f, 'registered after entry')), scope.epochId, 'a channel registered after entry is held');

      await incoming(f, 'work', 'w1', 'the excepted channel', MENTION);
      await f.turn();
      assert.ok(!held(find(f, 'the excepted channel')), 'the excepted channel is delivered');
      assert.ok(f.membrane.calls.length >= 1, 'and wakes');

      const epochs = f.framework.listPolicyEpochs();
      const listed = epochs.find((e) => e.id === scope.epochId);
      assert.ok(listed, 'the scope is a policy epoch');
      assert.equal(listed!.kind, 'tune-out', 'of the tune-out kind');
      assert.deepEqual(listed!.scope, { kind: 'all-except', except: { serverId: 'editor', channelId: 'work' } });
      assert.equal(typeof listed!.expiresAtMs, 'number', 'bounded');
    } finally { await f.close(); }
  });

  it('while active, a turn with no delivery of its own speaks into the excepted channel; after cancel it has no locus', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      assert.equal(await channellessTurnLocus(f), null, 'default rule: no locus without a delivery');
      enterAllExcept(f, 'work');
      assert.equal(await channellessTurnLocus(f), 'work', 'the focus destination');
      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      f.alwaysRespond(); // the release wakes the resident and the reader
      await f.framework.runUntilIdle();
      assert.equal(await channellessTurnLocus(f), null, 'gone with the scope');
    } finally { await f.close(); }
  });

  it('focus entered during a turn with no channel of its own gives that turn the excepted channel: its plain speech lands there', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      f.membrane.responses.length = 0; // the fixture pre-scripts an `ok`
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'fx', name: 'focus', input: { channelId: 'work', durationSeconds: 120 } },
      ] as ContentBlock[], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-here for a while' }] as ContentBlock[]));
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'agent', reason: 'heartbeat', source: 'test', timestamp: Date.now(),
      });
      await f.framework.runUntilIdle();
      await eventually(() => f.published.some((p) => JSON.stringify(p).includes('zz-here for a while')), 'the speech went out');
      assert.equal(f.published.find((p) => JSON.stringify(p).includes('zz-here for a while'))!.channelId, 'work');
    } finally { await f.close(); }
  });

  it("a turn woken in one channel that focuses on another is told its speech stays where the turn began, and it does", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      f.membrane.responses.length = 0; // the fixture pre-scripts an `ok`
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'fx', name: 'focus', input: { channelId: 'noisy', durationSeconds: 120 } },
      ] as ContentBlock[], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-still in work' }] as ContentBlock[]));
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => f.published.some((p) => JSON.stringify(p).includes('zz-still in work')), 'the speech went out');
      assert.equal(f.published.find((p) => JSON.stringify(p).includes('zz-still in work'))!.channelId, 'work');
      const told = stored(f).some((m) => JSON.stringify(m.content).includes("This turn's plain speech still lands in work"));
      assert.ok(told, "the focus result says this turn's speech stays in work");
    } finally { await f.close(); }
  });

  it("a focus whose call no open turn made, as a script's left from an earlier turn, leaves the open turn's speech where it was", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      f.membrane.responses.length = 0;
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-mine alone' }] as ContentBlock[]));
      const m = f.membrane as unknown as { responses: unknown[]; responseIndex: number; calls: unknown[]; lastStream: unknown };
      let outside: Promise<{ success: boolean; error?: string }> | undefined;
      // While the turn is open, a call naming the agent that carries no turn.
      f.membrane.streamYielding = ((request: unknown) => {
        m.calls.push(request);
        const remaining = m.responses.slice(m.responseIndex);
        m.responseIndex = m.responses.length;
        outside ??= f.framework.executeToolCall({ id: 'fz', name: 'focus', input: { channelId: 'work', durationSeconds: 120 }, callerAgentName: 'agent' } as never) as never;
        const stream = new HeldStream(outside.then(() => undefined), remaining as never);
        m.lastStream = stream;
        return stream;
      }) as never;
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'agent', reason: 'heartbeat', source: 'test', timestamp: Date.now(),
      });
      await f.framework.runUntilIdle();
      assert.ok(outside, 'premise: the call was made while the turn was open');
      const entered = await outside;
      assert.ok(entered.success, entered.error);
      assert.ok(internals(f).tuneOutCoordinator!.getAllExcept(), 'premise: the focus holds');
      await eventually(() => stored(f).some((x) => textOf(x).includes('zz-mine alone')), 'the turn spoke');
      const routing = (f.framework as unknown as { routingOf(agentName: string): { locus?: { channelId: string } | null } }).routingOf('agent');
      assert.equal(routing.locus ?? null, null, "the open turn's locus didn't move");
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!f.published.some((p) => JSON.stringify(p).includes('zz-mine alone')), 'its speech went to no channel');
    } finally { await f.close(); }
  });

  it("a turn that has no channel by design publishes nowhere when channel_publish names none, though a focus holds, as its plain speech goes nowhere", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enterAllExcept(f, 'work');
      (f.framework as unknown as { routingOf(agentName: string): { noChannel?: true } }).routingOf('agent').noChannel = true;
      const result = await f.framework.executeToolCall({ id: 'p1', name: 'channel_publish', input: { content: 'zz-nowhere' }, callerAgentName: 'agent' } as never);
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /name the channel with channelId\. This turn has no channel of its own/);
      assert.ok(!f.published.some((p) => JSON.stringify(p).includes('zz-nowhere')), 'nothing was posted');
    } finally { await f.close(); }
  });

  it("under the legacy latest-inbound rule too, a heartbeat turn's channel_publish naming no channel is refused, as its plain speech has no channel", async () => {
    const f = await fixture({ framework: { subconscious: SUB, speech: { locus: 'latest-inbound' } } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work');
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.turn();
      assert.equal((internals(f).channelRegistry.getDefaultPublishChannel() as unknown as { channelId: string } | null)?.channelId, 'work', 'premise: work is the latest inbound channel');
      f.membrane.responses.length = 0;
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'pb', name: 'channel_publish', input: { content: 'zz-beat' } },
      ] as ContentBlock[], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'beat done' }] as ContentBlock[]));
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'agent', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(),
      });
      await f.framework.runUntilIdle();
      await eventually(() => stored(f).some((m) => JSON.stringify(m.content).includes('This turn has no channel of its own')) || f.published.some((p) => JSON.stringify(p).includes('zz-beat')), 'the publish was answered');
      assert.ok(!f.published.some((p) => JSON.stringify(p).includes('zz-beat')), 'nothing was posted');
    } finally { await f.close(); }
  });

  it('check reports held counts per channel and peeks one channel without releasing', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy', 'other');
      const scope = enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n1', 'noise one');
      await incoming(f, 'noisy', 'n2', 'noise two');
      await incoming(f, 'other', 'o1', 'elsewhere');
      await settle(f);
      const report = internals(f).tuneOutCoordinator!.check({ peek: { serverId: 'editor', channelId: 'noisy' }, peekLimit: 1 });
      assert.ok(report.allExcept, 'the scope is reported');
      assert.equal(report.allExcept!.epochId, scope.epochId);
      assert.deepEqual(report.allExcept!.held, { noisy: 2, other: 1 });
      assert.deepEqual(report.peek, ['antra: noise two'], 'peek shows the newest held line, capped');
      const viaTool = await internals(f).handleTuneOutTool('agent', { mode: 'check', peek: 'noisy', peekLimit: '1' });
      assert.deepEqual((viaTool.data as { peek?: string[] }).peek, ['antra: noise two'], "the tool reads peekLimit's numeric string as its number");
      const refused = await internals(f).handleTuneOutTool('agent', { mode: 'check', peek: 'noisy', peekLimit: 'many' });
      assert.equal(refused.success, false);
      assert.match(refused.error ?? '', /peekLimit must be a finite number of lines, and it was the string "many"/);
      assert.ok(internals(f).tuneOutCoordinator!.getAllExcept(), 'still active');
      assert.equal(stored(f).filter(held).length, 3, 'nothing released');
      assert.ok(!has(f, '<tuned-out-backlog'), 'no release notice');
    } finally { await f.close(); }
  });

  it('cancel releases per held channel with a per-channel cap; the originals stay excluded', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy', 'other');
      enterAllExcept(f, 'work', { backlogCap: 1 });
      await incoming(f, 'noisy', 'n1', 'noise one');
      await incoming(f, 'noisy', 'n2', 'noise two');
      await incoming(f, 'other', 'o1', 'elsewhere');
      await settle(f);
      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      f.alwaysRespond(); // the release wakes the resident and the reader
      const release = textOf(find(f, 'all channels except'));
      assert.match(release, /\[Tune-out: all channels except work released — test/);
      assert.match(release, /<tuned-out-backlog channel="noisy" messages=2 truncated=1/);
      assert.match(release, /antra: noise two/);
      assert.ok(!/antra: noise one/.test(release), 'per-channel cap applied');
      assert.match(release, /<tuned-out-backlog channel="other" messages=1/);
      assert.match(release, /antra: elsewhere/);
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, 'scope ended');
      const compiled = await f.framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(!compiled.messages.some((m) => textOf(m as never).includes('noise one') && !textOf(m as never).includes('<tuned-out-backlog')), 'originals stay view-excluded');
      await incoming(f, 'noisy', 'n3', 'after release', MENTION);
      await f.turn();
      assert.ok(!held(find(f, 'after release')), 'traffic is delivered again');
    } finally { await f.close(); }
  });

  it('precedence: a per-channel epoch keeps its own hold; the excepted channel cannot be tuned out', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      const perChannel = internals(f).channelRegistry.getTuneOutState('editor', 'noisy')!.params.epochId;
      const scope = enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n1', 'noise under both');
      await settle(f);
      assert.equal(epochOf(find(f, 'noise under both')), perChannel, 'the per-channel epoch wins');
      assert.notEqual(perChannel, scope.epochId);

      const refused = internals(f).tuneOutCoordinator!.enter('editor', 'work', { cadenceSeconds: 3600 }, 'agent-tool');
      assert.equal(refused.ok, false);
      assert.match((refused as { error: string }).error, /excepted/);

      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      const again = internals(f).tuneOutCoordinator!.enterAllExcept({ serverId: 'editor', channelId: 'noisy' }, { durationSeconds: 120 }, 'agent-tool');
      assert.equal(again.ok, false, 'a tuned-out channel cannot be the exception');
      assert.match((again as { error: string }).error, /tuned out/);
    } finally { await f.close(); }
  });

  it("the subconscious's cancel_tuneout naming the scope ends the scope, though channelId names a channel tuned out on its own", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      enterAllExcept(f, 'work');
      const coordinator = internals(f).tuneOutCoordinator!;
      f.alwaysRespond(); // the scope's release wakes the resident and the reader
      const cancelled = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', scope: 'all-except' });
      assert.ok(cancelled.success, cancelled.error);
      assert.equal(coordinator.getAllExcept(), null, 'the scope named outright ended');
      assert.ok(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), "the channel's own tune-out stays");

      // With no scope to end, naming it ends nothing, rather than the channel the call names.
      const noScope = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', scope: 'all-except' });
      assert.equal(noScope.success, false, 'there was no scope to end');
      assert.match(noScope.error ?? '', /no all-except hold/);
      assert.ok(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), "the channel's own tune-out still stays");
      await f.framework.runUntilIdle();
    } finally { await f.close(); }
  });

  it("the subconscious's cancel_tuneout naming the scope \"channel\" ends only a channel's own tune-out, never the all-except hold", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy', 'other');
      enter(f, 'noisy');
      enterAllExcept(f, 'work');
      const coordinator = internals(f).tuneOutCoordinator!;
      const heldByScope = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'other', scope: 'channel' });
      assert.equal(heldByScope.success, false, 'a channel only the scope holds has no tune-out of its own to end');
      assert.match(heldByScope.error ?? '', /isn't tuned out on its own/);
      assert.notEqual(coordinator.getAllExcept(), null, 'the scope still holds');

      f.alwaysRespond(); // the channel's release wakes the resident and the reader
      const own = await coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', scope: 'channel' });
      assert.ok(own.success, own.error);
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), null, "the channel's own tune-out ended");
      assert.notEqual(coordinator.getAllExcept(), null, 'and the scope still holds');
      await f.framework.runUntilIdle();
    } finally { await f.close(); }
  });

  it('the duration is mandatory, and a second scope is refused', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work');
      const noDuration = internals(f).tuneOutCoordinator!.enterAllExcept({ serverId: 'editor', channelId: 'work' }, {} as never, 'agent-tool');
      assert.equal(noDuration.ok, false);
      assert.match((noDuration as { error: string }).error, /durationSeconds/);
      enterAllExcept(f, 'work');
      const second = internals(f).tuneOutCoordinator!.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool');
      assert.equal(second.ok, false);
      assert.match((second as { error: string }).error, /already/);
    } finally { await f.close(); }
  });

  it("the tool reads a numeric string as its number and refuses a value that gives none, naming it, as the coordinator does", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      const i = internals(f);
      const soon = await i.handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except', durationSeconds: 'soon' });
      assert.equal(soon.success, false);
      assert.match(soon.error ?? '', /durationSeconds must be a finite number of seconds, and it was the string "soon"/);
      assert.equal(i.tuneOutCoordinator!.getAllExcept(), null, 'nothing changed');
      const entered = await i.handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except', durationSeconds: '120', backlogCap: '7' });
      assert.ok(entered.success, entered.error);
      assert.equal(i.tuneOutCoordinator!.getAllExcept()!.params.backlogCap, 7);
    } finally { await f.close(); }
  });

  it('the tool: scope all-except, check, cancel — and `focus` as the alias', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      const i = internals(f);
      const noDuration = await i.handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except' });
      assert.equal(noDuration.success, false);
      assert.match(noDuration.error ?? '', /durationSeconds/);
      const entered = await i.handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except', durationSeconds: 120 });
      assert.ok(entered.success, entered.error);
      assert.equal((entered.data as { except?: string }).except, 'work');
      await incoming(f, 'noisy', 'n1', 'noise');
      await settle(f);
      const check = await i.handleTuneOutTool('agent', { mode: 'check', peek: 'noisy' });
      assert.ok(check.success, check.error);
      assert.deepEqual((check.data as { allExcept: { held: Record<string, number> } }).allExcept.held, { noisy: 1 });
      assert.deepEqual((check.data as { peek: string[] }).peek, ['antra: noise']);
      const cancelled = await i.handleTuneOutTool('agent', { mode: 'cancel', scope: 'all-except' });
      assert.ok(cancelled.success, cancelled.error);
      assert.equal(i.tuneOutCoordinator!.getAllExcept(), null);

      const focus = await (f.framework as unknown as { handleFocusTool(agent: string, input: Record<string, unknown>): { success: boolean; error?: string; data?: unknown } })
        .handleFocusTool('agent', { channelId: 'work', durationSeconds: 120 });
      assert.ok(focus.success, focus.error);
      assert.equal(i.tuneOutCoordinator!.getAllExcept()!.params.except.channelId, 'work');
      assert.ok(f.framework.getAllTools().some((t) => t.name === 'focus'), 'focus is offered as the alias');
    } finally { await f.close(); }
  });

  it('closing the excepted channel ends the scope', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n1', 'held');
      await settle(f);
      const result = await f.framework.executeToolCall({ id: 'c1', name: 'channel_close', input: { channelId: 'work' }, callerAgentName: 'agent' } as never);
      assert.ok(result.success, result.error);
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, 'nothing left to speak into: the scope ended');
      assert.match(textOf(find(f, 'all channels except')), /antra: held/);
    } finally { await f.close(); }
  });

  it("a close of the excepted channel that can't be recorded still says the focus ended, since it did", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enterAllExcept(f, 'work');
      const registry = internals(f).channelRegistry as unknown as { setDesiredState(...args: unknown[]): void };
      const record = registry.setDesiredState.bind(registry);
      registry.setDesiredState = (...args: unknown[]) => {
        if (args[2] === 'closed') throw new Error('the log refused it');
        return record(...args);
      };
      const result = await f.framework.executeToolCall({ id: 'c1', name: 'channel_close', input: { channelId: 'work' }, callerAgentName: 'agent' } as never);
      assert.equal(result.success, false);
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, 'the scope ended');
      assert.match(result.error ?? '', /The focus on it ended all the same/);
    } finally { await f.close(); }
  });

  it('closing the excepted channel ends the scope when the channel was closed already', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      const close = (id: string) => f.framework.executeToolCall({ id, name: 'channel_close', input: { channelId: 'work' }, callerAgentName: 'agent' } as never);
      assert.ok((await close('c0')).success);
      await eventually(() => internals(f).channelRegistry.getDesiredState('editor', 'work') === 'closed', 'work closed');
      enterAllExcept(f, 'work');
      const result = await close('c1');
      assert.ok(result.success, result.error);
      assert.equal((result.data as { status?: string }).status, 'already closed');
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, 'the scope ended');
    } finally { await f.close(); }
  });

  it("where another server shares a channel's id, check/peek and focus take the names the other modes take, and the subconscious's cancel_tuneout naming the scope ends it though channelId names that shared id", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      const map = (internals(f).channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
      for (const id of ['work', 'noisy']) {
        map.set(JSON.stringify(['other', id]), { serverId: 'other', descriptor: { id, type: 'discord', label: id }, open: true });
      }
      const tool = internals(f) as unknown as {
        handleTuneOutTool(agent: string, input: Record<string, unknown>, own?: Array<{ serverId: string; channelId: string }>): Promise<{ success: boolean; error?: string; data?: unknown }>;
        handleFocusTool(agent: string, input: Record<string, unknown>, own?: Array<{ serverId: string; channelId: string }>): Promise<{ success: boolean; error?: string; data?: unknown }>;
      };
      // Inside a turn whose channel is editor's 'work', the bare id means that channel.
      const focused = await tool.handleFocusTool('agent', { channelId: 'work', durationSeconds: 120 }, [{ serverId: 'editor', channelId: 'work' }]);
      assert.ok(focused.success, focused.error);
      assert.deepEqual(internals(f).tuneOutCoordinator!.getAllExcept()!.params.except, { serverId: 'editor', channelId: 'work' });
      await incoming(f, 'noisy', 'n1', 'noise');
      await settle(f);
      const shared = await tool.handleTuneOutTool('agent', { mode: 'check', peek: 'noisy' });
      assert.equal(shared.success, false, 'a peek at a name two servers share is refused, as every mode refuses it');
      assert.match(shared.error ?? '', /editor:noisy/);
      const qualified = await tool.handleTuneOutTool('agent', { mode: 'check', peek: 'editor:noisy' });
      assert.ok(qualified.success, qualified.error);
      assert.deepEqual((qualified.data as { peek: string[] }).peek, ['antra: noise'], 'the qualified name peeks that server\'s channel');
      const other = await tool.handleTuneOutTool('agent', { mode: 'check', peek: 'other:noisy' });
      assert.deepEqual((other.data as { peek: string[] }).peek, [], "and the other server's channel holds nothing");
      const withServer = await tool.handleTuneOutTool('agent', { mode: 'check', peek: 'noisy', serverId: 'editor' });
      assert.deepEqual((withServer.data as { peek: string[] }).peek, ['antra: noise'], 'the shared id with a serverId peeks that server\'s channel');
      const inTurn = await tool.handleTuneOutTool('agent', { mode: 'check', peek: 'noisy' }, [{ serverId: 'editor', channelId: 'noisy' }]);
      assert.deepEqual((inTurn.data as { peek: string[] }).peek, ['antra: noise'], "inside a turn whose channel it is, the shared id peeks the turn's channel");

      const cancelled = await internals(f).tuneOutCoordinator!.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', scope: 'all-except' });
      assert.ok(cancelled.success, cancelled.error);
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, 'the scope named outright ended the hold');

      // Nor does a turn's own channel its server no longer registers, which picks no channel either.
      const again = await tool.handleFocusTool('agent', { channelId: 'editor:work', durationSeconds: 120 });
      assert.ok(again.success, again.error);
      const gone = { serverId: 'other', channelId: 'gone' };
      const withoutScope = await internals(f).tuneOutCoordinator!.handleSubconsciousTool('cancel_tuneout', { channelId: 'gone' }, [gone]);
      assert.equal(withoutScope.success, false, "without the scope, the turn's channel that's gone is refused");
      assert.match(withoutScope.error ?? '', /until that server registers it again/, "with the refusal for the turn's channel, not the one for a channel that isn't tuned out");
      assert.notEqual(internals(f).tuneOutCoordinator!.getAllExcept(), null);
      const withScope = await internals(f).tuneOutCoordinator!.handleSubconsciousTool('cancel_tuneout', { channelId: 'gone', scope: 'all-except' }, [gone]);
      assert.ok(withScope.success, withScope.error);
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, "naming the scope ends the hold, though the turn's channel it names is gone");
    } finally { await f.close(); }
  });

  it('check/peek shows only what the active epoch holds, never a released one', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'old held one');
      await incoming(f, 'noisy', 'n2', 'old held two');
      await settle(f);
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      f.alwaysRespond();
      await f.framework.runUntilIdle();
      enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n3', 'new held');
      await f.framework.runUntilIdle();
      const report = internals(f).tuneOutCoordinator!.check({ peek: { serverId: 'editor', channelId: 'noisy' } });
      assert.deepEqual(report.allExcept!.held, { noisy: 1 });
      assert.deepEqual(report.peek, ['antra: new held'], 'released traffic is not shown as held (first live run, finding B)');
      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      await f.framework.runUntilIdle();
      assert.deepEqual(internals(f).tuneOutCoordinator!.check({ peek: { serverId: 'editor', channelId: 'noisy' } }).peek, [], 'nothing active: nothing to peek');
    } finally { await f.close(); }
  });

  it('the room hears the door shut: entry and release are announced in the excepted channel; `tuneOut.announce: false` keeps quiet', async () => {
    const until = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(cond(), what);
    };
    const textOfPublish = (p: Record<string, unknown>) =>
      ((p.content as Array<{ type: string; text?: string }>) ?? []).map((b) => b.text ?? '').join('');
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    const traces: string[] = [];
    f.framework.onTrace((t) => { traces.push(t.type); });
    try {
      await registerOpen(f, 'work', 'noisy');
      const entered = await internals(f).handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except', durationSeconds: 120 });
      assert.ok(entered.success, entered.error);
      assert.equal((entered.data as { announcedIn?: string | null }).announcedIn, 'work', 'the tool result names where the entry was announced');
      await until(() => f.published.length >= 1, 'the entry is announced');
      assert.equal(f.published[0].channelId, 'work');
      assert.match(textOfPublish(f.published[0]), /^\[Focus: agent is here for 2 min, until \d\d:\d\d UTC; other channels are held meanwhile\.\]$/);
      await incoming(f, 'noisy', 'n1', 'held');
      await settle(f);
      assert.equal(f.published.length, 1, 'a held channel hears nothing');

      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      f.alwaysRespond();
      await until(() => f.published.length >= 2, 'the release is announced');
      assert.equal(f.published[1].channelId, 'work');
      assert.match(textOfPublish(f.published[1]), /^\[Focus: agent released — test\.\]$/);
      await until(() => traces.filter((t) => t === 'tune-out:announced').length >= 2, 'both announcements traced');
    } finally { await f.close(); }

    // Where another server registers the excepted channel's id, the entry is
    // still announced in the excepted channel, on its own server, and the
    // answer names the channel as the agent can name it back.
    const shared = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(shared, 'work', 'noisy');
      (internals(shared).channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set(
        JSON.stringify(['other', 'work']), { serverId: 'other', descriptor: { id: 'work', type: 'discord', label: 'work' }, open: true });
      const entered = await internals(shared).handleTuneOutTool('agent', { channelId: 'editor:work', scope: 'all-except', durationSeconds: 120 });
      assert.ok(entered.success, entered.error);
      assert.equal((entered.data as { except?: string }).except, 'editor:work');
      assert.equal((entered.data as { announcedIn?: string | null }).announcedIn, 'editor:work');
      await until(() => shared.published.length >= 1, 'the entry is announced, though another server shares the id');
      // `published` holds what the fixture's one connection, 'editor', is
      // sent: 'other' has no connection, so nothing sent there is recorded.
      assert.equal(shared.published[0].channelId, 'work');
    } finally { await shared.close(); }

    const quiet = await fixture({ framework: { subconscious: SUB, tuneOut: { announce: false } } as Partial<FrameworkConfig> });
    try {
      await registerOpen(quiet, 'work', 'noisy');
      const entered = await internals(quiet).handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except', durationSeconds: 120 });
      assert.ok(entered.success, entered.error);
      assert.equal((entered.data as { announcedIn?: string | null }).announcedIn, null);
      await incoming(quiet, 'noisy', 'n1', 'held');
      await settle(quiet);
      assert.ok(internals(quiet).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      quiet.alwaysRespond();
      await quiet.framework.runUntilIdle();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(quiet.published.length, 0, 'announce: false — nothing is posted');
    } finally { await quiet.close(); }
  });
});
