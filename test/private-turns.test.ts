import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { NormalizedResponse, StreamEvent } from '@animalabs/membrane';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { fixture, eventually, crash } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { internals, textOf, stored, has, MENTION, AMBIENT, SUB, incoming, registerOpen, enter } from './helpers/admission.js';
import { bindAsConversationFork, GateModule, waitCall } from './helpers/dendrite.js';
import { SurfaceModule, ActModule, SpeechProbe, surfaceMessage, say, callTool, act } from './helpers/surface.js';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { ConversationContext, DiscordClientInterface } from '../src/modules/discord/types.js';

type F = Awaited<ReturnType<typeof fixture>>;
type Routing = { private?: true; locus?: { serverId: string; channelId: string }; pin?: unknown; drafts: unknown[] };
type Hidden = {
  turnRouting: Map<string, Routing>;
  openLogical: Map<string, Routing>;
  pendingRequests: unknown[];
  appendProseDeliveryReceipt(agent: unknown, routing: unknown): void;
};
const hidden = (f: F) => f.framework as unknown as Hidden;

const SECRET = 'for your eyes only: what is the door code?';
const sent = (f: F, text: string) => f.published.filter((p) => JSON.stringify(p).includes(text));
const storedText = (f: F, text: string) => stored(f).filter((m) => textOf(m).includes(text) || JSON.stringify(m.content).includes(text));
const wake = (f: F, request: Record<string, unknown> = {}) =>
  hidden(f).pendingRequests.push({ agentName: 'agent', reason: 'nudge', source: 'test', timestamp: Date.now(), ...request });

const queues = new WeakMap<object, NormalizedResponse[][]>();
function script(f: F, ...turns: NormalizedResponse[][]): void {
  const membrane = f.membrane;
  if (!queues.has(membrane)) {
    const original = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request, options) => {
      const reader = (request as { system?: string }).system?.includes(SUB.systemPrompt);
      for (const response of reader ? [say('zz-reader')] : queues.get(membrane)!.shift() ?? [say('zz-unscripted')]) membrane.pushResponse(response);
      return original(request, options);
    };
  }
  queues.set(membrane, turns.map((t) => [...t]));
}

async function make(opts: {
  mode?: 'locus' | 'hybrid' | 'locked' | 'explicit';
  lock?: string;
  rule?: 'delivery' | 'latest-inbound';
  wakes?: boolean | string[];
  agent?: Record<string, unknown>;
  modules?: unknown[];
  framework?: Record<string, unknown>;
  fixture?: Record<string, unknown>;
} = {}) {
  const probe = new ActModule();
  const f = await fixture({
    ...opts.fixture,
    framework: {
      modules: [new SurfaceModule(opts.wakes ?? true), probe, ...(opts.modules ?? [])],
      ...(opts.rule ? { speech: { locus: opts.rule } } : {}),
      ...opts.framework,
    } as Partial<FrameworkConfig>,
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', proseRouting: opts.mode ?? 'locus', ...(opts.lock ? { proseLock: opts.lock } : {}), ...opts.agent }],
  });
  await registerOpen(f, 'work', 'noisy');
  f.membrane.responses.length = 0; // the fixture pre-scripts an `ok`
  (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
  return { f, probe };
}

async function sentinel(f: F, text = 'zz-sentinel'): Promise<void> {
  await eventually(() => sent(f, text).length > 0, 'a later room turn spoke, after anything earlier was sent');
}

describe('private turns: when a turn is private (part 1)', () => {
  it('an undo of a private turn leaves its message unanswered, so the next turn is private too', async () => {
    const { f } = await make({ mode: 'locked', lock: 'work' });
    try {
      script(f, [say('zz-first answer')], [say('zz-after the undo')], [say('zz-sentinel')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-first answer'), 'premise: the private turn answered');
      const undone = f.framework.undoLastTurn('agent');
      assert.ok((undone.window?.retracted ?? 0) > 0, `premise: the undo took the answer out of the window: ${JSON.stringify(undone)}`);
      wake(f);
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-after the undo'), "premise: the nudge's turn spoke");
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-after the undo'), [], 'the turn after the undo spoke in no channel');
      assert.deepEqual(sent(f, 'zz-first answer'), [], 'nor did the private turn');
    } finally { await f.close(); }
  });

  it('after a redo gives the answer back, a room message makes the next turn public', async () => {
    const { f } = await make({ mode: 'locked', lock: 'work' });
    try {
      script(f, [say('zz-first answer')], [say('zz-sentinel')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      f.framework.undoLastTurn('agent');
      const redone = f.framework.redo('agent');
      assert.ok((redone.window?.represented ?? 0) > 0, `premise: the redo put the answer back: ${JSON.stringify(redone)}`);
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-first answer'), [], 'the private answer stayed private');
    } finally { await f.close(); }
  });

  it('a crash while a private turn waits on its tool call leaves the message unanswered, so the turn after the restart is private', async () => {
    const gate = new GateModule();
    const { f } = await make({ mode: 'locked', lock: 'work', modules: [gate] });
    try {
      script(f, [waitCall('g1'), say('zz-never')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      const loop = f.framework.runUntilIdle().catch(() => {});
      await eventually(() => gate.entered.has('g1'), 'the private turn is in its tool call');
      await crash(f);
      void loop;
      await f.create();
      await registerOpen(f, 'work');
      f.membrane.responses.length = 0;
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      script(f, [say('zz-after the restart')], [say('zz-sentinel')]);
      wake(f);
      await f.framework.runUntilIdle();
      await eventually(() => has(f, 'zz-after the restart'), "premise: the turn after the restart spoke");
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-after the restart'), [], 'the turn after the restart spoke in no channel');
    } finally { await f.close(); }
  });

  it("a conversation's closure prompt, written after an operator's message was answered, isn't a channel's message, so the next turn is private", async () => {
    const { f } = await make({ rule: 'latest-inbound' });
    try {
      script(f, [say('zz-room')], [say('zz-private answer')], [say('zz-after the prompt')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-room').length > 0, 'premise: the room turn spoke in its channel');
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-private answer'), 'premise: the private turn answered');
      const agent = f.framework.getAgent('agent')!;
      agent.getContextManager().addMessage('user', [{ type: 'text', text: 'zz-closing: wrap up' }], { channelId: 'work', conversationClosure: true } as never);
      (f.framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(agent);
      assert.ok(agent.getContextManager().getPresentedMessages().some((m) => JSON.stringify(m.content).includes('zz-closing')), "premise: the prompt is in the agent's window");
      wake(f);
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-after the prompt'), "premise: the nudge's turn spoke");
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-after the prompt'), [], 'the turn after the prompt spoke in no channel');
    } finally { await f.close(); }
  });

  it("a provider hold keeps a private turn's wake beside an unmarked wake equal to it in every other field, in either order", async () => {
    const { f } = await make({ wakes: false });
    try {
      const fw = f.framework as unknown as { holdRequest(held: Array<Record<string, unknown>>, request: Record<string, unknown>): void };
      const at = Date.now();
      const unmarked = { agentName: 'agent', reason: 'nudge', source: 'framework', timestamp: at };
      const marked = { ...unmarked, privateCaller: true };
      for (const order of [[unmarked, marked], [marked, unmarked]]) {
        const held: Array<Record<string, unknown>> = [];
        for (const request of order) fw.holdRequest(held, { ...request });
        assert.equal(held.filter((r) => r.privateCaller === true).length, 1, `the private turn's wake is kept: ${JSON.stringify(held)}`);
      }
      const held: Array<Record<string, unknown>> = [];
      fw.holdRequest(held, { ...unmarked });
      fw.holdRequest(held, { ...unmarked });
      assert.equal(held.length, 1, 'premise: two equal unmarked wakes are kept once');
    } finally { await f.close(); }
  });

  it("a private message's wake merged with a room's gives one turn, and it's private", async () => {
    const { f } = await make({ rule: 'delivery', wakes: false });
    try {
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      (f.framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(f.framework.getAgent('agent'));
      script(f, [say('zz-merged answer')]);
      const calls = f.membrane.calls.length;
      const starts: Array<{ channelId?: string; addressed?: boolean }> = [];
      const fw = f.framework as unknown as { startAgentStream(agent: unknown, request: { channelId?: string; addressed?: boolean }): Promise<unknown> };
      const startAgentStream = fw.startAgentStream.bind(fw);
      fw.startAgentStream = (agent, request) => {
        starts.push(request);
        return startAgentStream(agent, request);
      };
      wake(f, { reason: 'external-message', source: 'tui' });
      wake(f, { reason: 'mcpl:channel-incoming', source: 'editor', channelId: 'work', channelServerId: 'editor', addressed: true });
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length - calls, 1, 'premise: one turn read both');
      assert.equal(starts.length, 1, 'premise: one start');
      assert.ok(starts[0]!.channelId === 'work' && starts[0]!.addressed === true, `premise: the start carried the room's wake: ${JSON.stringify(starts[0])}`);
      assert.ok(has(f, 'zz-merged answer'), 'premise: it spoke');
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-merged answer'), [], 'the merged turn spoke in no channel');
    } finally { await f.close(); }
  });

  it('a room turn after an answered private exchange routes as before', async () => {
    const { f } = await make({ rule: 'delivery' });
    try {
      script(f, [say('zz-private answer')], [say('zz-room answer')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-room answer').length > 0, 'the room turn spoke in work');
      assert.deepEqual(sent(f, 'zz-private answer'), [], 'the private answer stayed private');
    } finally { await f.close(); }
  });

  it("an operator's message that no round of the agent's answered stays unanswered past a delivery receipt", async () => {
    const { f } = await make({ mode: 'locked', lock: 'work', wakes: false });
    try {
      script(f, [say('zz-room answer')], [say('zz-sentinel')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      (f.framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(f.framework.getAgent('agent'));
      const agent = f.framework.getAgent('agent');
      hidden(f).appendProseDeliveryReceipt(agent, {
        deliveries: [{ serverId: 'editor', channelId: 'work' }], suppressed: 0, drafts: [], keptPrivate: 0,
      });
      assert.ok(storedText(f, '[delivered]').length > 0, 'premise: a receipt row follows the operator\'s message');
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-room answer'), 'premise: the room turn spoke');
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-room answer'), [], "the receipt isn't an answer, so the room turn was private");
    } finally { await f.close(); }
  });

  it("a silent tick's round that ends in text doesn't answer an operator's message, so the room turn after it is private", async () => {
    const { f } = await make({ rule: 'delivery', wakes: false });
    try {
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      script(f, [say('zz-tick thought')], [say('zz-room answer')], [say('zz-sentinel')]);
      wake(f, { reason: 'heartbeat', source: 'heartbeat', suppressProse: true, silentHeartbeat: { eventId: 'hb-1', serverId: 'heartbeat' } });
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-tick thought'), "premise: the silent tick's round ended in text");
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-room answer'), 'premise: the room turn spoke');
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-room answer'), [], "the tick's text isn't an answer, so the room turn was private");
    } finally { await f.close(); }
  });

  it("a locked agent's silent tick that reads an operator's message gives channel_publish no default", async () => {
    const { f } = await make({ mode: 'locked', lock: 'work', wakes: false });
    try {
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      script(f, [callTool('p1', 'channel_publish', { content: 'zz-tick post' }), say('')]);
      wake(f, { reason: 'heartbeat', source: 'heartbeat', suppressProse: true, silentHeartbeat: { eventId: 'hb-1', serverId: 'heartbeat' } });
      await f.framework.runUntilIdle();
      const refusal = storedText(f, 'This turn has no channel of its own');
      assert.ok(refusal.length > 0, `channel_publish naming no channel was refused: ${stored(f).slice(-3).map((m) => JSON.stringify(m.content)).join('\n')}`);
      assert.deepEqual(sent(f, 'zz-tick post'), [], 'and posted nowhere');
    } finally { await f.close(); }
  });
});

describe('private turns: the flip, and what it clears (parts 2, 3 and 9)', () => {
  it('a surface row heard at a tool boundary makes a room turn private for the rest of it, and the turn is told', async () => {
    const { f, probe } = await make({ rule: 'delivery' });
    try {
      probe.acts.push(async () => {
        await eventually(() => sent(f, 'zz-before the message').length > 0, 'premise: the room turn spoke in work before the message');
        f.framework.pushEvent(surfaceMessage(SECRET));
      });
      script(f, [act('a1', 'zz-before the message'), say('zz-after the message')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-before the message').length > 0, 'premise: the room turn spoke in work before the message');
      assert.ok(has(f, 'zz-after the message'), 'premise: the turn spoke after it');
      const notice = storedText(f, 'so your plain speech goes to no channel for the rest of this turn');
      assert.equal(notice.length, 1, `the flip writes one notice: ${stored(f).map((m) => textOf(m)).filter((t) => t.includes('[routing]')).join('\n')}`);
      assert.ok(textOf(notice[0]!).includes('for the rest of this turn; reaching a channel takes an explicit send.'), textOf(notice[0]!));
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-after the message'), [], 'what the turn said after the message went to no channel');
    } finally { await f.close(); }
  });

  it("a surface row presented at the start a provider hold keeps for a room turn makes it private, and the turn is told", async () => {
    let holds = 0;
    const { f } = await make({ rule: 'delivery', wakes: false, framework: {
      providerHold: (error: Error) => (error.message === 'provider unavailable' && holds++ === 0 ? { holdMs: 60_000, reason: 'test hold' } : undefined),
    } });
    const cooldowns = (f.framework as unknown as { providerAccelerationCooldowns: Map<string, { until: number }> }).providerAccelerationCooldowns;
    try {
      script(f, [say('zz-continued')]);
      const scripted = f.membrane.streamYielding.bind(f.membrane);
      let failed = false;
      const retried: string[] = [];
      f.membrane.streamYielding = (request, options) => {
        if (failed) {
          retried.push(JSON.stringify(request));
          return scripted(request, options);
        }
        failed = true;
        return new (class extends MockYieldingStream {
          override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> { throw new Error('provider unavailable'); }
        })([], true);
      };
      const live: unknown[] = [];
      const off = f.framework.onTrace((t) => { if (t.type === 'inference:started') live.push(hidden(f).turnRouting.get('agent')); });
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(cooldowns.has('agent'), 'premise: the room turn failed into a provider hold');
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.equal(storedText(f, SECRET).length, 1, 'premise: the message is stored during the hold');
      cooldowns.get('agent')!.until = Date.now();
      (f.framework as unknown as { releaseProviderAccelerationCooldown(agent: string): void }).releaseProviderAccelerationCooldown('agent');
      await f.framework.runUntilIdle();
      off();
      assert.equal(live.length, 2, 'premise: the room turn and its retry each started a stream');
      assert.equal(live[1], live[0], 'premise: the retry continued the room turn');
      assert.ok(has(f, 'zz-continued'), 'premise: the retry spoke');
      assert.equal(storedText(f, 'so your plain speech goes to no channel for the rest of this turn').length, 1, 'the flip writes its notice');
      assert.ok(retried[0]?.includes('so your plain speech goes to no channel for the rest of this turn'), "the retry's request holds the notice");
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-continued'), [], 'what the continued turn said went to no channel');
    } finally { await f.close(); }
  });

  it("on a host whose window for the agent couldn't be written down, an operator's message the provider hold's retry compiles makes the room turn private", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-legacy-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    store.registerState({ id: 'agents/agent/window', strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
    store.appendToStateJson('agents/agent/window', { v: 99 });
    store.close();
    let holds = 0;
    const { f } = await make({ rule: 'delivery', wakes: false, fixture: { dir }, framework: {
      providerHold: (error: Error) => (error.message === 'provider unavailable' && holds++ === 0 ? { holdMs: 60_000, reason: 'test hold' } : undefined),
    } });
    const cooldowns = (f.framework as unknown as { providerAccelerationCooldowns: Map<string, { until: number }> }).providerAccelerationCooldowns;
    try {
      assert.equal(f.framework.getAgent('agent')!.getContextManager().windowMode(), 'legacy', "premise: the agent's window is the record");
      script(f, [say('zz-continued')]);
      const scripted = f.membrane.streamYielding.bind(f.membrane);
      let failed = false;
      const retried: string[] = [];
      f.membrane.streamYielding = (request, options) => {
        if (failed) {
          retried.push(JSON.stringify(request));
          return scripted(request, options);
        }
        failed = true;
        return new (class extends MockYieldingStream {
          override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> { throw new Error('provider unavailable'); }
        })([], true);
      };
      const live: unknown[] = [];
      const off = f.framework.onTrace((t) => { if (t.type === 'inference:started') live.push(hidden(f).turnRouting.get('agent')); });
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(cooldowns.has('agent'), 'premise: the room turn failed into a provider hold');
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.equal(storedText(f, SECRET).length, 1, 'premise: the message is stored during the hold');
      cooldowns.get('agent')!.until = Date.now();
      (f.framework as unknown as { releaseProviderAccelerationCooldown(agent: string): void }).releaseProviderAccelerationCooldown('agent');
      await f.framework.runUntilIdle();
      off();
      assert.equal(live.length, 2, 'premise: the room turn and its retry each started a stream');
      assert.equal(live[1], live[0], 'premise: the retry continued the room turn');
      assert.ok(has(f, 'zz-continued'), 'premise: the retry spoke');
      assert.equal(storedText(f, 'so your plain speech goes to no channel for the rest of this turn').length, 1, 'the flip writes its notice');
      assert.ok(retried[0]?.includes('so your plain speech goes to no channel for the rest of this turn'), "the retry's request holds the notice");
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-continued'), [], 'what the continued turn said went to no channel');
    } finally { await f.close(); }
  });

  it("on a host whose window for the agent couldn't be written down, an operator's message its budget restart compiles makes the room turn private", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-legacy-restart-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    store.registerState({ id: 'agents/agent/window', strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
    store.appendToStateJson('agents/agent/window', { v: 99 });
    store.close();
    const { f, probe } = await make({ rule: 'delivery', wakes: false, fixture: { dir }, agent: { maxStreamTokens: 20 } });
    try {
      assert.equal(f.framework.getAgent('agent')!.getContextManager().windowMode(), 'legacy', "premise: the agent's window is the record");
      probe.acts.push(() => f.framework.pushEvent(surfaceMessage(SECRET)));
      const overBudget = act('a1');
      (overBudget as { usage: { inputTokens: number; outputTokens: number } }).usage = { inputTokens: 100, outputTokens: 5 };
      script(f, [overBudget, say('zz-never')], [say('zz-restarted')]);
      const reasons: string[] = [];
      const live: unknown[] = [];
      const off = f.framework.onTrace((t) => { if (t.type === 'inference:started') live.push(hidden(f).turnRouting.get('agent')); });
      const scripted = f.membrane.streamYielding.bind(f.membrane);
      f.membrane.streamYielding = (request, options) => {
        reasons.push(JSON.stringify(request).includes(SECRET) ? 'holds the message' : 'without it');
        return scripted(request, options);
      };
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      off();
      assert.equal(live.length, 2, `premise: the room turn and its budget restart each started a stream: ${reasons.join(', ')}`);
      assert.equal(live[1], live[0], 'premise: the restart continued the room turn');
      assert.deepEqual(reasons, ['without it', 'holds the message'], "premise: the restart's compile held the operator's message");
      assert.ok(has(f, 'zz-restarted'), 'premise: the restart spoke');
      assert.equal(storedText(f, 'so your plain speech goes to no channel for the rest of this turn').length, 1, 'the flip writes its notice');
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-restarted'), [], 'what the restarted turn said went to no channel');
    } finally { await f.close(); }
  });

  it("on a host whose window for the agent couldn't be written down, an operator's message stored while a module's context hook waits at the error policy's retry makes the room turn private", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-legacy-hook-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    store.registerState({ id: 'agents/agent/window', strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
    store.appendToStateJson('agents/agent/window', { v: 99 });
    store.close();
    let gathered = 0;
    let atRetry: (() => Promise<void>) | undefined;
    const hook = {
      name: 'hook',
      async start() {},
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false, error: 'no tools' }; },
      async onProcess() { return {}; },
      async gatherContext(agentName: string) {
        if (agentName === 'agent' && ++gathered === 2) await atRetry?.();
        return [];
      },
    };
    const { f } = await make({ rule: 'delivery', wakes: false, fixture: { dir }, modules: [hook], framework: {
      errorPolicy: { maxRetries: 1, onInferenceError: (_error: Error, _agent: string, attempt: number) => (attempt < 1 ? { retry: true, delayMs: 10 } : { retry: false }) },
    } });
    try {
      assert.equal(f.framework.getAgent('agent')!.getContextManager().windowMode(), 'legacy', "premise: the agent's window is the record");
      atRetry = async () => {
        await (f.framework as unknown as { handleProcessEvent(event: unknown): Promise<void> }).handleProcessEvent(surfaceMessage(SECRET));
        assert.equal(storedText(f, SECRET).length, 1, "premise: the message is stored while the retry's hook waits");
      };
      script(f, [say('zz-retried')]);
      const scripted = f.membrane.streamYielding.bind(f.membrane);
      let failed = false;
      const requests: string[] = [];
      f.membrane.streamYielding = (request, options) => {
        requests.push(JSON.stringify(request));
        if (failed) return scripted(request, options);
        failed = true;
        return new (class extends MockYieldingStream {
          override provideToolResults(results: unknown[], options?: Parameters<MockYieldingStream['provideToolResults']>[1]): void {
            super.provideToolResults(results, options);
            const self = this as unknown as { events: StreamEvent[]; _done: boolean; pendingResolve: (() => void) | null };
            self._done = false;
            self.events.push({ type: 'error', error: new Error('the provider failed') } as unknown as StreamEvent);
            self.pendingResolve?.();
          }
        })([act('a1')], true);
      };
      const live: unknown[] = [];
      const off = f.framework.onTrace((t) => { if (t.type === 'inference:started') live.push(hidden(f).turnRouting.get('agent')); });
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => has(f, 'zz-retried'), 'premise: the retry spoke');
      await f.framework.runUntilIdle();
      off();
      assert.equal(live.length, 2, 'premise: the room turn and its retry each started a stream');
      assert.equal(live[1], live[0], 'premise: the retry continued the room turn');
      assert.ok(!requests[0]?.includes(SECRET) && requests[1]?.includes(SECRET), "premise: only the retry's compile held the operator's message");
      assert.equal(storedText(f, 'so your plain speech goes to no channel for the rest of this turn').length, 1, 'the flip writes its notice');
      assert.ok(requests[1]?.includes('so your plain speech goes to no channel for the rest of this turn'), "the retry's request holds the notice");
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-retried'), [], 'what the retried turn said went to no channel');
    } finally { await f.close(); }
  });

  it("a hybrid `>>>` destination set before a flip takes none of the turn's later words", async () => {
    const { f, probe } = await make({ mode: 'hybrid', rule: 'delivery' });
    let pinnedBefore = false;
    try {
      probe.acts.push(async () => {
        await eventually(() => sent(f, 'zz-pinned').length > 0, 'premise: the pinned words went out before the message');
        pinnedBefore = hidden(f).turnRouting.get('agent')?.pin !== undefined;
        f.framework.pushEvent(surfaceMessage(SECRET));
      });
      script(f, [act('a1', '>>>#noisy zz-pinned'), say('zz-after the message')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-pinned').length > 0, 'premise: the pinned words went out');
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.ok(pinnedBefore, 'premise: the `>>>` set the pin before the flip');
      assert.ok(has(f, 'zz-after the message'), 'premise: the turn spoke after the flip');
      assert.deepEqual(sent(f, 'zz-after the message'), [], "the pin didn't take the words after the flip");
    } finally { await f.close(); }
  });

  it('after a flip the turn shows typing in no channel, and its traces name none', async () => {
    const { f, probe } = await make({ rule: 'delivery' });
    try {
      let flipped = false;
      const typing: Array<{ op: 'start' | 'stop'; channel: string; flipped: boolean }> = [];
      const registry = internals(f).channelRegistry as unknown as Record<'startTyping' | 'stopTyping', (channel: unknown, metadata?: unknown) => void>;
      for (const op of ['start', 'stop'] as const) {
        const key = `${op}Typing` as const;
        const original = registry[key].bind(registry);
        registry[key] = (channel, metadata) => {
          typing.push({ op, channel: channel === undefined ? '(every)' : typeof channel === 'string' ? channel : (channel as { channelId: string }).channelId, flipped });
          original(channel, metadata);
        };
      }
      const traced: Array<{ channelId?: string; flipped: boolean }> = [];
      const off = f.framework.onTrace((t) => {
        if (t.type === 'inference:tokens' || t.type === 'inference:content_block') traced.push({ channelId: (t as { channelId?: string }).channelId, flipped });
      });
      probe.acts.push(() => { flipped = true; f.framework.pushEvent(surfaceMessage(SECRET)); });
      script(f, [act('a1', 'zz-before the message'), say('zz-after the message')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      off();
      assert.ok(traced.some((t) => !t.flipped && t.channelId === 'work'), `control: before the flip, traces name work: ${JSON.stringify(traced)}`);
      assert.ok(traced.some((t) => t.flipped), `premise: the turn traced after the flip: ${JSON.stringify(traced)}`);
      assert.deepEqual(traced.filter((t) => t.flipped && t.channelId !== undefined), [], 'no trace after the flip names a channel');
      assert.ok(typing.some((t) => !t.flipped && t.op === 'start' && t.channel === 'work'), `control: typing showed in work: ${JSON.stringify(typing)}`);
      assert.deepEqual(typing.filter((t) => t.flipped && t.op === 'start'), [], 'no typing starts after the flip');
      assert.ok(typing.some((t) => t.flipped && t.op === 'stop' && t.channel === 'work'), `the flip stopped typing in work: ${JSON.stringify(typing)}`);
    } finally { await f.close(); }
  });

  it("a stored tools notice makes no turn private at its open, and one heard at a boundary flips none", async () => {
    const { f, probe } = await make({ mode: 'locked', lock: 'work', wakes: false });
    try {
      f.framework.pushEvent(surfaceMessage('New tools available: probe--act', 'mcpl:editor'));
      await f.framework.runUntilIdle();
      (f.framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(f.framework.getAgent('agent'));
      assert.ok(stored(f).some((m) => textOf(m).includes('New tools available') && (m.metadata as { inboundSource?: { kind?: string } } | undefined)?.inboundSource?.kind === 'surface'),
        'premise: the notice is stored as a surface row');
      script(f, [say('zz-after the notice')]);
      wake(f);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-after the notice').length > 0, 'a nudge after the notice spoke at the lock');
      probe.acts.push(() => f.framework.pushEvent(surfaceMessage('New tools available: probe--act2', 'mcpl:editor')));
      script(f, [act('a1'), say('zz-after the boundary notice')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-after the boundary notice').length > 0, 'a notice heard at a boundary flipped nothing');
    } finally { await f.close(); }
  });
});

describe('private turns: readers, writers and speech (parts 4, 5 and 6)', () => {
  it("a private turn's channel_publish naming no channel is refused, and one naming a channel posts", async () => {
    const { f } = await make({ rule: 'latest-inbound' });
    try {
      script(f, [say('zz-room answer')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-room answer').length > 0, 'premise: the latest inbound names work');
      script(f, [
        callTool('p1', 'channel_publish', { content: 'zz-no channel named' }),
        callTool('p2', 'channel_publish', { channelId: 'work', content: 'zz-named' }),
        say('zz-done'),
      ]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-named').length > 0, 'the send naming work posted');
      assert.ok(storedText(f, 'This turn has no channel of its own').length > 0, 'the send naming none was refused, saying why');
      assert.deepEqual(sent(f, 'zz-no channel named'), [], 'and posted nowhere');
    } finally { await f.close(); }
  });

  it("channel_publish naming no channel is refused after a flip, and after the private turn enters a focus", async () => {
    const { f, probe } = await make({ rule: 'delivery', framework: { subconscious: SUB } });
    try {
      probe.acts.push(() => f.framework.pushEvent(surfaceMessage(SECRET)));
      script(f, [
        act('a1'),
        callTool('p1', 'channel_publish', { content: 'zz-after the flip' }),
        callTool('fx-enter', 'focus', { channelId: 'work', durationSeconds: 120 }),
        callTool('p2', 'channel_publish', { content: 'zz-after the focus' }),
        say('zz-done'),
      ]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-done'), 'premise: the turn ran to its end');
      assert.ok(internals(f).tuneOutCoordinator!.getAllExcept(), 'premise: the focus holds');
      assert.equal(storedText(f, 'This turn has no channel of its own').length, 2, 'both sends naming no channel were refused, saying why');
      assert.deepEqual(sent(f, 'zz-after the flip'), [], 'the send after the flip posted nowhere');
      assert.deepEqual(sent(f, 'zz-after the focus'), [], 'nor did the send after the focus');
    } finally { await f.close(); }
  });

  it("a speech handler is told a private turn's speech is private, and a room turn's isn't", async () => {
    const speaker = new SpeechProbe();
    const { f } = await make({ rule: 'delivery', modules: [speaker] });
    try {
      script(f, [say('zz-private answer')], [say('zz-room answer')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      const mine = speaker.heard.find((h) => h.text.includes('zz-private answer'));
      const room = speaker.heard.find((h) => h.text.includes('zz-room answer'));
      assert.ok(mine && room, `premise: the handler heard both turns: ${JSON.stringify(speaker.heard)}`);
      assert.equal(mine.private, true, "the private turn's speech is marked private");
      assert.equal(room.private, undefined, "the room turn's speech isn't");
    } finally { await f.close(); }
  });

  it("the built-in Discord module posts none of a private turn's speech, and edits in none of its thoughts", async () => {
    let n = 0;
    const posted: string[] = [];
    const edits: string[] = [];
    const client = {
      sendMessage: async (_channelId: string, content: string) => { posted.push(content); return { messageId: `M${++n}` }; },
      sendDM: async (_userId: string, content: string) => { posted.push(content); return { messageId: `D${++n}` }; },
      fetchMessage: async () => '',
      editMessage: async (_channelId: string, messageId: string, content: string) => { edits.push(`${messageId}: ${content}`); },
    } as unknown as DiscordClientInterface;
    const module = new DiscordModule(client, { token: 'test-token' });
    (module as unknown as { replyContexts: Map<string, ConversationContext> }).replyContexts.set('default', { channelId: 'c1', userId: 'u1' } as ConversationContext);
    const trigger = { reason: 'test', source: 'test', timestamp: 0 };
    assert.equal((await module.handleToolCall({ id: 'call-send' as never, name: 'send', input: { channelId: 'c1', content: 'an earlier send' }, callerAgentName: 'A', callerTurnId: 1 })).success, true);
    await module.onAgentSpeech('A', [{ type: 'text', text: 'zz-private words' }], { turnComplete: true, trigger, thoughts: [{ type: 'text', text: 'zz-private why' }], turnId: 1, private: true });
    assert.deepEqual(posted, ['an earlier send'], 'nothing more was posted');
    assert.deepEqual(edits, [], 'no thoughts were edited in');
    await module.onAgentSpeech('A', [{ type: 'text', text: 'zz-room words' }], { turnComplete: true, trigger, turnId: 2 });
    assert.ok(posted.includes('zz-room words'), `control: a public turn's speech posts: ${JSON.stringify(posted)}`);
  });

  it("on a host whose channels come from a module, once the operator's message is answered the module's channel message gets a public turn", async () => {
    const speaker = new SpeechProbe();
    const { f } = await make({ rule: 'delivery', modules: [speaker] });
    try {
      script(f, [say('zz-private answer')], [say('zz-module room answer')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      f.framework.pushEvent({ type: 'room:message', content: 'agent, from the module room' } as never);
      await f.framework.runUntilIdle();
      const mine = speaker.heard.find((h) => h.text.includes('zz-private answer'));
      const room = speaker.heard.find((h) => h.text.includes('zz-module room answer'));
      assert.ok(mine && room, `premise: the handler heard both turns: ${JSON.stringify(speaker.heard)}`);
      assert.equal(mine.private, true, "premise: the operator's turn was private");
      assert.equal(room.private, undefined, "the module channel's turn is public");
    } finally { await f.close(); }
  });

  for (const tag of ['chat:reaction', 'chat:edited', 'chat:deleted']) {
    it(`a channel item tagged ${tag} after an answered operator's message isn't a newer channel message, so the next turn stays private`, async () => {
      const { f } = await make({ mode: 'locked', lock: 'work' });
      try {
        script(f, [say('zz-private answer')], [say('zz-after the marker')], [say('zz-sentinel')]);
        f.framework.pushEvent(surfaceMessage(SECRET));
        await f.framework.runUntilIdle();
        assert.ok(has(f, 'zz-private answer'), 'premise: the private turn answered');
        await incoming(f, 'work', 'm1', 'zz-marker', [tag]);
        await f.framework.runUntilIdle();
        assert.equal(storedText(f, 'zz-marker').length, 1, `premise: the ${tag} item is in the window`);
        if (!has(f, 'zz-after the marker')) {
          wake(f);
          await f.framework.runUntilIdle();
        }
        assert.ok(has(f, 'zz-after the marker'), 'premise: a turn spoke after the marker');
        await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
        await f.framework.runUntilIdle();
        await sentinel(f);
        assert.deepEqual(sent(f, 'zz-after the marker'), [], 'the turn after the marker spoke in no channel');
      } finally { await f.close(); }
    });
  }

  it("a module's row that names a channel but is tagged as a reaction isn't a message from it, so the next turn stays private", async () => {
    const speaker = new SpeechProbe();
    const { f } = await make({ rule: 'delivery', modules: [speaker] });
    try {
      script(f, [say('zz-private answer')], [say('zz-after the reaction')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      f.framework.pushEvent({ type: 'reaction:message', content: 'zz-thumbs up' } as never);
      await f.framework.runUntilIdle();
      const mine = speaker.heard.find((h) => h.text.includes('zz-private answer'));
      const after = speaker.heard.find((h) => h.text.includes('zz-after the reaction'));
      assert.ok(mine && after, `premise: the handler heard both turns: ${JSON.stringify(speaker.heard)}`);
      assert.equal(mine.private, true, "premise: the operator's turn was private");
      assert.equal(after.private, true, "the reaction didn't make the next turn public");
    } finally { await f.close(); }
  });

  it("a row that names a channel but isn't a message from it, such as a subconscious's note at a channel cancel, leaves the next turn private", async () => {
    const speaker = new SpeechProbe();
    const { f } = await make({ rule: 'delivery', modules: [speaker] });
    try {
      script(f, [say('zz-private answer')], [say('zz-after the note')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      f.framework.pushEvent({ type: 'note:message', content: 'a note about room-1' } as never);
      await f.framework.runUntilIdle();
      const mine = speaker.heard.find((h) => h.text.includes('zz-private answer'));
      const after = speaker.heard.find((h) => h.text.includes('zz-after the note'));
      assert.ok(mine && after, `premise: the handler heard both turns: ${JSON.stringify(speaker.heard)}`);
      assert.equal(mine.private, true, "premise: the operator's turn was private");
      assert.equal(after.private, true, "the note didn't make the next turn public");
    } finally { await f.close(); }
  });

  it("a push event whose origin names a channel the framework can't resolve isn't a channel's message, so after an answered operator's message the next turn stays private", async () => {
    const speaker = new SpeechProbe();
    const { f } = await make({ rule: 'delivery', modules: [speaker] });
    try {
      script(f, [say('zz-private answer')], [say('zz-after the push')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      await f.send('push/event', {
        featureSet: 'doc', eventId: 'e1', timestamp: '2026-09-30T00:00:00Z',
        payload: { content: [{ type: 'text', text: 'agent, a word in private' }] },
        origin: { source: 'slack', channelId: 'C123', authorId: 'U1', authorName: 'antra', messageId: 'e1' },
        tags: ['chat:dm', 'chat:addressed', 'chat:from-human'],
      });
      await f.framework.runUntilIdle();
      const row = stored(f).find((m) => textOf(m).includes('a word in private'));
      const metadata = row?.metadata as { channelId?: unknown; inboundSource?: { kind?: string } } | undefined;
      assert.ok(metadata?.channelId && metadata.inboundSource?.kind !== 'channel', `premise: the push's row names a channel and its source isn't one: ${JSON.stringify(metadata)}`);
      const mine = speaker.heard.find((h) => h.text.includes('zz-private answer'));
      const after = speaker.heard.find((h) => h.text.includes('zz-after the push'));
      assert.ok(mine && after, `premise: the handler heard both turns: ${JSON.stringify(speaker.heard)}`);
      assert.equal(mine.private, true, "premise: the operator's turn was private");
      assert.equal(after.private, true, "the push didn't make the next turn public");
    } finally { await f.close(); }
  });

  it("a sleep in a private locus-mode turn posts no announcement and writes no failure marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-sleep-'));
    const { f } = await make({ rule: 'delivery', fixture: { dir }, framework: { gate: { config: { policies: [], default: 'always' }, configPath: join(dir, 'gate.json') } } });
    try {
      script(f, [callTool('s1', 'sleep', { seconds: 60 })]);
      const before = f.published.length;
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(stored(f).some((m) => JSON.stringify(m.content).includes('sleepingFor')), 'premise: the sleep ran');
      assert.deepEqual(storedText(f, '[send-undeliverable]').map((m) => textOf(m)), [], 'no failure marker');
      assert.deepEqual(f.published.slice(before), [], 'nothing was posted');
    } finally {
      (f.framework as unknown as { eventGate: { clearSleep(): boolean } }).eventGate.clearSleep();
      await f.close();
    }
  });

  it("explicit: a sleep in a private turn posts no announcement, though the turn's own `>>` posted its words", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-sleep-explicit-'));
    const { f, probe } = await make({ mode: 'explicit', rule: 'delivery', fixture: { dir }, framework: { gate: { config: { policies: [], default: 'always' }, configPath: join(dir, 'gate.json') } } });
    try {
      probe.acts.push(() => eventually(() => sent(f, 'zz-said').length > 0, "premise: the envelope's words went out before the sleep"));
      script(f, [act('a1', '>>#work zz-said'), callTool('s1', 'sleep', { seconds: 60 })]);
      const before = f.published.length;
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(stored(f).some((m) => JSON.stringify(m.content).includes('sleepingFor')), 'premise: the sleep ran');
      assert.deepEqual(f.published.slice(before).filter((p) => !JSON.stringify(p).includes('zz-said')), [], 'nothing but the envelope was posted');
    } finally {
      (f.framework as unknown as { eventGate: { clearSleep(): boolean } }).eventGate.clearSleep();
      await f.close();
    }
  });

  for (const [mode, prefix] of [['hybrid', '>>>'], ['explicit', '>>']] as const) {
    it(`${mode}: a \`${prefix}\` destination queued before a flip, and delivered after it, isn't kept for the turn's later words`, async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const { f, probe } = await make({ mode, rule: 'delivery', fixture: { holdPublish: (p: Record<string, unknown>) => (JSON.stringify(p).includes('zz-slow') ? held : undefined) } });
      try {
        probe.acts.push(() => f.framework.pushEvent(surfaceMessage(SECRET)));
        probe.acts.push(async () => {
          release();
          await eventually(() => sent(f, 'zz-queued').length > 0, 'premise: the queued envelope went out after the flip');
        });
        script(f, [act('a1', `${prefix}#noisy zz-slow\n${prefix}#work zz-queued`), act('a2'), say('zz-after the flip')]);
        await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
        await f.framework.runUntilIdle();
        assert.equal(storedText(f, 'so your plain speech goes to no channel for the rest of this turn').length, 1, 'premise: the turn flipped');
        script(f, [say(`${prefix}#work zz-sentinel`)]);
        await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
        await f.framework.runUntilIdle();
        await sentinel(f);
        assert.ok(has(f, 'zz-after the flip'), 'premise: the turn spoke after the flip');
        assert.deepEqual(sent(f, 'zz-after the flip'), [], "the queued envelope's destination took none of the words after the flip");
      } finally { await f.close(); }
    });
  }

  it("hybrid: a `>>>` destination a send in its round reached, routed after a flip, isn't kept for the turn's later words", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { f, probe } = await make({ mode: 'hybrid', rule: 'delivery', fixture: { holdPublish: (p: Record<string, unknown>) => (JSON.stringify(p).includes('zz-slow') ? held : undefined) } });
    const drafted = () => JSON.stringify(hidden(f).turnRouting.get('agent')?.drafts ?? []).includes('zz-queued');
    try {
      probe.acts.push(() => f.framework.pushEvent(surfaceMessage(SECRET)));
      probe.acts.push(async () => {
        release();
        await eventually(drafted, "premise: the round's words for the send's channel were held after the flip");
      });
      script(f, [createMockResponse([
        { type: 'text', text: '>>>#noisy zz-slow\n>>>#work zz-queued' },
        { type: 'tool_use', id: 'a1', name: 'probe--act', input: {} },
        { type: 'tool_use', id: 'p1', name: 'channel_publish', input: { channelId: 'work', content: 'zz-sent' } },
      ] as never, 'tool_use'), act('a2'), say('zz-after the flip')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(sent(f, 'zz-sent').length > 0, "premise: the round's send reached work");
      assert.equal(storedText(f, 'so your plain speech goes to no channel for the rest of this turn').length, 1, 'premise: the turn flipped');
      script(f, [say('>>>#work zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.ok(has(f, 'zz-after the flip'), 'premise: the turn spoke after the flip');
      assert.deepEqual(sent(f, 'zz-after the flip'), [], "the send's channel took none of the words after the flip");
    } finally { await f.close(); }
  });

  for (const [mode, prefix] of [['hybrid', '>>>'], ['explicit', '>>']] as const) {
    it(`${mode}: in a private turn, a \`${prefix}\` envelope posts its own words, and the turn's later unprefixed words go to no channel`, async () => {
      const { f } = await make({ mode, rule: 'delivery' });
      try {
        script(f, [act('a1', `${prefix}#work zz-named`), say('zz-unprefixed after')]);
        f.framework.pushEvent(surfaceMessage(SECRET));
        await f.framework.runUntilIdle();
        await eventually(() => sent(f, 'zz-named').length > 0, "the envelope's own words went to work");
        script(f, [say(`${prefix}#work zz-sentinel`)]);
        await incoming(f, 'work', 'w1', 'agent, one more', MENTION);
        await f.framework.runUntilIdle();
        await sentinel(f);
        assert.ok(has(f, 'zz-unprefixed after'), 'premise: the turn wrote unprefixed words after the envelope');
        assert.deepEqual(sent(f, 'zz-unprefixed after'), [], 'the later unprefixed words went to no channel');
      } finally { await f.close(); }
    });
  }

  it("explicit: a private turn's ` !` continuation that comes while a later room turn is provider-held doesn't join that turn's retry, and runs as its own private turn", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holds = 0;
    const speaker = new SpeechProbe();
    const dir = mkdtempSync(join(tmpdir(), 'private-late-continuation-'));
    const { f } = await make({
      mode: 'explicit', rule: 'delivery', modules: [speaker],
      fixture: { dir, holdPublish: (p: Record<string, unknown>) => (JSON.stringify(p).includes('zz-slow') ? held : undefined) },
      framework: {
        gate: { config: { policies: [], default: 'always' }, configPath: join(dir, 'gate.json') },
        providerHold: (error: Error) => (error.message === 'provider unavailable' && holds++ === 0 ? { holdMs: 60_000, reason: 'test hold' } : undefined),
      },
    });
    const cooldowns = (f.framework as unknown as { providerAccelerationCooldowns: Map<string, { until: number; heldRequests: Array<{ privateCaller?: true }> }> }).providerAccelerationCooldowns;
    const gate = (f.framework as unknown as { eventGate: { clearSleep(): boolean } }).eventGate;
    try {
      script(f, [say('>>#noisy zz-first answer')], [callTool('s1', 'sleep', { seconds: 60 }, '>>#noisy ! zz-slow')], [say('>>#work zz-retry')], [say('>>#noisy zz-continuation')]);
      const scripted = f.membrane.streamYielding.bind(f.membrane);
      let streams = 0;
      f.membrane.streamYielding = (request, options) => {
        streams += 1;
        if (streams !== 3) return scripted(request, options);
        return new (class extends MockYieldingStream {
          override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> { throw new Error('provider unavailable'); }
        })([], true);
      };
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(sent(f, 'zz-first answer').length > 0, "premise: a private turn answered the operator's message");
      wake(f);
      let settled = false;
      void f.framework.runUntilIdle().then(() => { settled = true; });
      await eventually(() => f.published.some((p) => JSON.stringify(p).includes('zz-slow')), "premise: the nudge's private turn has its delivery on its way");
      await eventually(() => settled, 'premise: the private turn ended on its sleep with its delivery still on its way');
      gate.clearSleep();
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(cooldowns.has('agent'), 'premise: the room turn failed into a provider hold');
      release();
      const waiting = () => [...hidden(f).pendingRequests, ...(cooldowns.get('agent')?.heldRequests ?? [])] as Array<{ privateCaller?: true }>;
      await eventually(() => waiting().some((r) => r.privateCaller), "premise: the continuation the nudge's turn asked for came while the room turn was held, marked as a private turn's");
      cooldowns.get('agent')!.until = Date.now();
      (f.framework as unknown as { releaseProviderAccelerationCooldown(agent: string): void }).releaseProviderAccelerationCooldown('agent');
      await f.framework.runUntilIdle();
      const retry = speaker.heard.find((h) => h.text.includes('zz-retry'));
      assert.ok(retry, `premise: the room turn's retry spoke: ${JSON.stringify(speaker.heard)}`);
      assert.equal(retry.private, undefined, 'premise: the room turn stayed public');
      const continuation = speaker.heard.find((h) => h.text.includes('zz-continuation'));
      assert.ok(continuation, `the continuation ran as a turn of its own: ${JSON.stringify(speaker.heard)}`);
      assert.equal(continuation.private, true, 'and that turn was private');
    } finally {
      release();
      gate.clearSleep();
      await f.close();
    }
  });

  it("explicit: a private turn's late ` !` continuation, parked in a quiesce beside a public turn's own, keeps its mark, and the turn at the lift is private", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const speaker = new SpeechProbe();
    const dir = mkdtempSync(join(tmpdir(), 'private-quiesce-park-'));
    const { f, probe } = await make({
      mode: 'explicit', rule: 'delivery', modules: [speaker],
      fixture: { dir, holdPublish: (p: Record<string, unknown>) => (JSON.stringify(p).includes('zz-slow') ? held : undefined) },
      framework: { gate: { config: { policies: [], default: 'always' }, configPath: join(dir, 'gate.json') } },
    });
    const gate = (f.framework as unknown as { eventGate: { clearSleep(): boolean } }).eventGate;
    const marked = (reason: string) => hidden(f).pendingRequests.filter((r) => {
      const request = r as { reason?: string; privateCaller?: true };
      return request.reason === reason && request.privateCaller === true;
    });
    let quiesced: Promise<unknown> | undefined;
    try {
      script(f,
        [say('>>#noisy zz-first answer')],
        [callTool('s1', 'sleep', { seconds: 60 }, '>>#noisy ! zz-slow')],
        [act('a1', '>>#work zz-room'), say('>>#work ! zz-room again')],
        [say('>>#work zz-after the lift')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(sent(f, 'zz-first answer').length > 0, "premise: a private turn answered the operator's message");
      wake(f);
      let settled = false;
      void f.framework.runUntilIdle().then(() => { settled = true; });
      await eventually(() => f.published.some((p) => JSON.stringify(p).includes('zz-slow')), "premise: the nudge's private turn has its delivery on its way");
      await eventually(() => settled, 'premise: the private turn ended on its sleep with its delivery still on its way');
      gate.clearSleep();
      probe.acts.push(async () => {
        quiesced = f.framework.quiesce({ reason: 'test' });
        release();
        await eventually(() => marked('prose-continuation').length > 0, "premise: the private turn's continuation came, marked, during the quiesce");
        hidden(f).pendingRequests.push(
          { agentName: 'agent', reason: 'prose-bounce', source: 'framework', timestamp: Date.now(), privateCaller: true },
          { agentName: 'agent', reason: 'prose-bounce', source: 'framework', timestamp: Date.now() + 1 },
        );
      });
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await quiesced;
      assert.ok(sent(f, 'zz-room again').length > 0, "premise: the room turn ended with its own ` !`");
      await (f.framework as unknown as { processInferenceRequests(): Promise<void> }).processInferenceRequests();
      assert.equal(hidden(f).pendingRequests.filter((r) => (r as { reason?: string }).reason === 'prose-continuation').length, 2,
        "the room turn's continuation and the private turn's were parked apart");
      assert.equal(marked('prose-continuation').length, 1, "the private turn's continuation kept its mark in the park");
      assert.equal(marked('prose-bounce').length, 1, "and so did a private turn's bounce wake");
      await f.framework.resume();
      await f.framework.runUntilIdle();
      const after = speaker.heard.find((h) => h.text.includes('zz-after the lift'));
      assert.ok(after, `premise: a turn ran at the lift: ${JSON.stringify(speaker.heard)}`);
      assert.equal(after.private, true, 'the turn at the lift was private');
    } finally {
      release();
      gate.clearSleep();
      await f.close();
    }
  });

  it("a private turn's context-budget restart queues its continuation with the turn's privacy", async () => {
    const { f } = await make({ agent: { maxTokens: 4_000, physicalWindowTokens: 200_000 } });
    const restarts: Array<{ privateCaller?: true }> = [];
    const off = f.framework.onTrace((t) => {
      if (t.type !== 'inference:stream_restarted') return;
      restarts.push(...(hidden(f).pendingRequests as Array<{ reason?: string; privateCaller?: true }>).filter((r) => r.reason === 'context_budget_restart'));
    });
    try {
      script(f, [say('zz-first answer')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-first answer'), "premise: a private turn answered the operator's message");
      await incoming(f, 'work', 'w1', 'zz-chatter', AMBIENT);
      await f.framework.runUntilIdle();
      const near = act('a1');
      (near as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
      script(f, [near], [say('zz-after the restart')]);
      wake(f, { reason: 'prose-continuation', source: 'framework', privateCaller: true });
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-after the restart'), 'premise: the turn went on after its restart');
      assert.equal(restarts.length, 1, 'premise: the private turn restarted for its budget');
      assert.equal(restarts[0]!.privateCaller, true, "the restart's continuation carries the turn's privacy");
    } finally { off(); await f.close(); }
  });

  it("a private turn's refusal rewind re-runs it as a private turn", async () => {
    const speaker = new SpeechProbe();
    const { f } = await make({ modules: [speaker], agent: { refusalHandling: { autoRewind: true, maxRewinds: 3 } } });
    try {
      script(f, [say('zz-first answer')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-first answer'), "premise: a private turn answered the operator's message");
      await incoming(f, 'work', 'w1', 'zz-chatter one', AMBIENT);
      await incoming(f, 'work', 'w2', 'zz-chatter two', AMBIENT);
      await f.framework.runUntilIdle();
      script(f, [createMockResponse([], 'refusal')], [say('zz-after the rewind')]);
      wake(f, { reason: 'prose-continuation', source: 'framework', privateCaller: true });
      await f.framework.runUntilIdle();
      const after = speaker.heard.find((h) => h.text.includes('zz-after the rewind'));
      assert.ok(after, `premise: the rewind's retry ran: ${JSON.stringify(speaker.heard)}`);
      assert.ok(has(f, 'zz-chatter one'), "premise: a room message newer than the operator's is still in the window");
      assert.equal(after.private, true, "the rewind's retry was private");
    } finally { await f.close(); }
  });

  it("a room turn that turned private at a tool boundary is re-run by its refusal rewind as a private turn, once the shed has taken the operator's message out of its window", async () => {
    const speaker = new SpeechProbe();
    const { f, probe } = await make({ rule: 'delivery', modules: [speaker], agent: { refusalHandling: { autoRewind: true, maxRewinds: 3 } } });
    try {
      probe.acts.push(async () => { f.framework.pushEvent(surfaceMessage(SECRET)); });
      script(f, [act('a1', 'zz-before the message'), createMockResponse([], 'refusal')], [say('zz-after the rewind')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(storedText(f, 'so your plain speech goes to no channel for the rest of this turn').length > 0, 'premise: the room turn turned private');
      const presented = (f.framework.getAgent('agent')!.getContextManager() as unknown as { getPresentedMessages(): Array<{ content: unknown }> }).getPresentedMessages();
      assert.ok(!presented.some((m) => JSON.stringify(m.content).includes(SECRET)), "premise: the shed took the operator's message out of the agent's window");
      const after = speaker.heard.find((h) => h.text.includes('zz-after the rewind'));
      assert.ok(after, `premise: the rewind's retry ran: ${JSON.stringify(speaker.heard)}`);
      assert.equal(after.private, true, "the rewind's retry was private");
    } finally { await f.close(); }
  });

  it("a private turn's own tool_results_ready, batched with another wake while the turn is open, starts with the batch", async () => {
    const { f } = await make();
    try {
      script(f, [say('zz-batch')]);
      const routing = (f.framework as unknown as { routingOf(name: string): Routing }).routingOf('agent');
      routing.private = true;
      hidden(f).openLogical.set('agent', routing);
      hidden(f).pendingRequests.push(
        { agentName: 'agent', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now(), privateCaller: true },
        { agentName: 'agent', reason: 'nudge', source: 'test', timestamp: Date.now() + 1 },
      );
      await (f.framework as unknown as { processInferenceRequests(): Promise<void> }).processInferenceRequests();
      assert.deepEqual((hidden(f).pendingRequests as Array<{ reason?: string }>).filter((r) => r.reason === 'tool_results_ready'), [],
        "the turn's own continuation wasn't sent back to the queue");
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-batch'), 'premise: the batch ran');
    } finally { await f.close(); }
  });

  it("channel_open in a private turn moves nothing, and its result says the turn's speech goes to no channel", async () => {
    const { f } = await make({ rule: 'delivery' });
    try {
      script(f, [callTool('o1', 'channel_open', { channelId: 'noisy' }), say('zz-after the open')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      const results = stored(f).map((m) => JSON.stringify(m.content));
      assert.ok(results.some((t) => t.includes('This turn has no channel, so its plain speech goes to none')), `the open's result: ${results.slice(-3).join('\n')}`);
      assert.ok(!results.some((t) => t.includes('now lands in this channel')), "it doesn't say this turn's speech lands there");
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.ok(has(f, 'zz-after the open'), 'premise: the turn spoke after the open');
      assert.deepEqual(sent(f, 'zz-after the open'), [], 'the turn spoke in no channel');
    } finally { await f.close(); }
  });

  it("prose_locus in a locked agent's private turn moves the lock for later turns only, and says so", async () => {
    const { f } = await make({ mode: 'locked', lock: 'work' });
    try {
      script(f, [callTool('l0', 'prose_locus', {}), callTool('l1', 'prose_locus', { to: '#noisy' }), say('zz-after the move')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      const results = stored(f).map((m) => JSON.stringify(m.content));
      assert.ok(results.some((t) => t.includes('Your plain speech goes to no channel on this turn')), `the read says this turn's speech goes nowhere: ${results.slice(-5).join('\n')}`);
      assert.ok(results.some((t) => t.includes('from your next turn') && t.includes('This turn has no channel, so its plain speech goes to none')),
        `the move says where later turns speak, and that this one speaks nowhere: ${results.slice(-5).join('\n')}`);
      assert.ok(!results.some((t) => t.includes("on this turn's later rounds")), "it doesn't say this turn's later rounds move");
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.ok(JSON.stringify(sent(f, 'zz-sentinel')).includes('noisy'), `the next public turn speaks at the new lock: ${JSON.stringify(sent(f, 'zz-sentinel'))}`);
      assert.ok(has(f, 'zz-after the move'), 'premise: the turn spoke after the move');
      assert.deepEqual(sent(f, 'zz-after the move'), [], 'the private turn spoke in no channel');
    } finally { await f.close(); }
  });

  it("under 'latest-inbound', an addressed message heard in a private turn moves nothing and writes no notice saying so", async () => {
    const { f, probe } = await make({ rule: 'latest-inbound' });
    try {
      script(f, [say('zz-room answer')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-room answer').length > 0, 'premise: the latest inbound names work');
      probe.acts.push(() => incoming(f, 'noisy', 'n1', 'agent, over here', MENTION));
      script(f, [act('a1'), say('zz-after the arrival')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'agent, over here'), 'premise: the addressed message arrived');
      assert.deepEqual(storedText(f, 'The conversation moved to'), [], 'no re-pin notice');
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.ok(has(f, 'zz-after the arrival'), 'premise: the turn spoke after the arrival');
      assert.deepEqual(sent(f, 'zz-after the arrival'), [], 'the turn spoke in no channel');
    } finally { await f.close(); }
  });

  it("a locked agent's private turn told of a message addressed from elsewhere is told its speech has no channel", async () => {
    const { f, probe } = await make({ mode: 'locked', lock: 'work' });
    try {
      probe.acts.push(() => incoming(f, 'noisy', 'n1', 'agent, over here', MENTION));
      script(f, [act('a1'), say('zz-after the arrival')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      const notices = storedText(f, 'addressed you from');
      assert.equal(notices.length, 1, `premise: one notice of the addressed message: ${stored(f).map((m) => textOf(m)).filter((t) => t.includes('[routing]')).join('\n')}`);
      assert.ok(textOf(notices[0]!).includes('Your plain speech stays in your archive (no channel) this turn'), textOf(notices[0]!));
    } finally { await f.close(); }
  });

  it("a private turn's reply writes no failure marker, and a locked one keeps no draft", async () => {
    for (const mode of ['locus', 'locked', 'hybrid'] as const) {
      const { f } = await make({ mode, rule: 'delivery' });
      try {
        script(f, [say('zz-private answer')]);
        f.framework.pushEvent(surfaceMessage(SECRET));
        await f.framework.runUntilIdle();
        assert.ok(has(f, 'zz-private answer'), `${mode}: premise: the private turn answered`);
        assert.deepEqual(storedText(f, '[send-undeliverable]').map((m) => textOf(m)), [], `${mode}: no failure marker`);
        assert.deepEqual(hidden(f).turnRouting.get('agent')!.drafts, [], `${mode}: no draft kept`);
        assert.deepEqual(storedText(f, 'draft').map((m) => textOf(m)).filter((t) => t.includes('[delivered]')), [], `${mode}: no receipt names a draft`);
      } finally { await f.close(); }
    }
  });

  it('in explicit mode, a turn private from its open shows typing in no channel, though its wake names one', async () => {
    const { f } = await make({ mode: 'explicit', wakes: false });
    try {
      const typing: string[] = [];
      const registry = internals(f).channelRegistry as unknown as { startTyping: (channel: unknown, metadata?: unknown) => void };
      const startTyping = registry.startTyping.bind(registry);
      registry.startTyping = (channel, metadata) => {
        typing.push(typeof channel === 'string' ? channel : (channel as { channelId: string }).channelId);
        startTyping(channel, metadata);
      };
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      (f.framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(f.framework.getAgent('agent'));
      script(f, [say('zz-private answer')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'zz-private answer'), 'premise: the turn ran');
      assert.deepEqual([...typing], [], 'no typing while the operator was unanswered');
      script(f, [say('>>#work zz-room answer')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(typing.includes('work'), `control: a public turn woken from work shows typing there: ${JSON.stringify(typing)}`);
    } finally { await f.close(); }
  });
});

describe("private turns: the wakes a private turn causes (part 7)", () => {
  it('an auto-continue after a room message was heard in a private turn is private', async () => {
    const { f, probe } = await make({ mode: 'locked', lock: 'work', agent: { autoContinue: { maxConsecutive: 1 } } });
    try {
      probe.acts.push(() => incoming(f, 'work', 'w1', 'chatter in the room', AMBIENT));
      script(f, [act('a1'), say('zz-private answer')], [say('zz-continued')]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      await eventually(() => has(f, 'zz-continued'), 'premise: the turn was continued');
      assert.ok(has(f, 'chatter in the room'), 'premise: the room message was heard');
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-continued'), [], 'the continuation spoke in no channel');
      assert.deepEqual(sent(f, 'zz-private answer'), [], 'nor did the private turn');
      const row = stored(f).find((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'auto-continue');
      assert.match(textOf(row!), /plain words you write without it and with no destination go to no channel this turn/,
        "the continuation's row says where its plain speech goes");
    } finally { await f.close(); }
  });

  it("a private turn's bounce wake, batched behind a room mention's earlier wake, opens a private turn", async () => {
    const { f, probe } = await make({ mode: 'explicit' });
    try {
      let turn = 0;
      const typing: Array<{ turn: number; channel: string }> = [];
      const registry = internals(f).channelRegistry as unknown as { startTyping: (channel: unknown, metadata?: unknown) => void };
      const startTyping = registry.startTyping.bind(registry);
      registry.startTyping = (channel, metadata) => {
        typing.push({ turn, channel: typeof channel === 'string' ? channel : (channel as { channelId: string }).channelId });
        startTyping(channel, metadata);
      };
      let batch: Array<{ channelId?: string; privateCaller?: true }> = [];
      const off = f.framework.onTrace((t) => {
        if (t.type !== 'inference:started') return;
        turn += 1;
        if (turn !== 2) return;
        const trigger = (f.framework as unknown as { activeTurnTriggers: Map<string, object> }).activeTurnTriggers.get('agent');
        const key = trigger && Object.getOwnPropertySymbols(trigger).find((k) => k.description === 'merged-batch');
        batch = key ? (trigger as Record<symbol, typeof batch>)[key] ?? [] : [];
      });
      probe.acts.push(() => incoming(f, 'work', 'w1', 'agent, are you there?', MENTION));
      script(f, [act('a1'), say('zz-unprefixed')], [callTool('s1', 'skip_reply', { reason: 'done' })]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      off();
      assert.ok(storedText(f, 'zz-unprefixed').length > 0 && stored(f).some((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce'), 'premise: the private turn\'s text bounced');
      assert.equal(turn, 2, 'premise: the bounce and the room mention took one turn');
      assert.ok(batch.some((r) => r.privateCaller) && batch.some((r) => !r.privateCaller && String(r.channelId ?? '').endsWith('work')),
        `premise: the second turn merged the bounce's wake with the room mention's: ${JSON.stringify(batch)}`);
      assert.ok(!has(f, 'zz-unscripted'), 'premise: no third turn ran');
      assert.deepEqual(typing.filter((t) => t.turn === 2), [], `the merged turn showed typing in no channel: ${JSON.stringify(typing)}`);
    } finally { await f.close(); }
  });
});
