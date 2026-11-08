import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedResponse, StreamEvent } from '@animalabs/membrane';
import { MockYieldingStream } from './helpers/mock-membrane.js';
import { fixture, eventually, crash } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { internals, textOf, stored, has, MENTION, AMBIENT, SUB, incoming, registerOpen, enter } from './helpers/admission.js';
import { bindAsConversationFork, GateModule, waitCall } from './helpers/dendrite.js';
import { SurfaceModule, ActModule, surfaceMessage, say, callTool, act } from './helpers/surface.js';

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
} = {}) {
  const probe = new ActModule();
  const f = await fixture({
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

  it("a private message's wake merged with a room's gives one turn, and it's private", async () => {
    const { f } = await make({ rule: 'delivery', wakes: false });
    try {
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      (f.framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(f.framework.getAgent('agent'));
      script(f, [say('zz-merged answer')]);
      const calls = f.membrane.calls.length;
      wake(f, { reason: 'external-message', source: 'tui' });
      wake(f, { reason: 'mcpl:channel-incoming', source: 'editor', channelId: 'work', channelServerId: 'editor', addressed: true });
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length - calls, 1, 'premise: one turn read both');
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
      probe.acts.push(() => f.framework.pushEvent(surfaceMessage(SECRET)));
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
      f.membrane.streamYielding = (request, options) => {
        if (failed) return scripted(request, options);
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
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
      assert.deepEqual(sent(f, 'zz-continued'), [], 'what the continued turn said went to no channel');
    } finally { await f.close(); }
  });

  it("a hybrid `>>>` destination set before a flip takes none of the turn's later words", async () => {
    const { f, probe } = await make({ mode: 'hybrid', rule: 'delivery' });
    try {
      probe.acts.push(() => f.framework.pushEvent(surfaceMessage(SECRET)));
      script(f, [act('a1', '>>>#noisy zz-pinned'), say('zz-after the message')]);
      await incoming(f, 'work', 'w1', 'agent, hello', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => sent(f, 'zz-pinned').length > 0, 'premise: the pinned words went out');
      script(f, [say('zz-sentinel')]);
      await incoming(f, 'work', 'w2', 'agent, one more', MENTION);
      await f.framework.runUntilIdle();
      await sentinel(f);
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
      const off = f.framework.onTrace((t) => { if (t.type === 'inference:started') turn += 1; });
      probe.acts.push(() => incoming(f, 'work', 'w1', 'agent, are you there?', MENTION));
      script(f, [act('a1'), say('zz-unprefixed')], [callTool('s1', 'skip_reply', { reason: 'done' })]);
      f.framework.pushEvent(surfaceMessage(SECRET));
      await f.framework.runUntilIdle();
      off();
      assert.ok(storedText(f, 'zz-unprefixed').length > 0 && stored(f).some((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce'), 'premise: the private turn\'s text bounced');
      assert.equal(turn, 2, 'premise: the bounce and the room mention took one turn');
      assert.ok(!has(f, 'zz-unscripted'), 'premise: no third turn ran');
      assert.deepEqual(typing.filter((t) => t.turn === 2), [], `the merged turn showed typing in no channel: ${JSON.stringify(typing)}`);
    } finally { await f.close(); }
  });
});
