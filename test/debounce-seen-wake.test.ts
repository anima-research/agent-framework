import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent } from '@animalabs/membrane';
import type { EventGate } from '../src/gate/event-gate.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { incoming, registerOpen, MENTION } from './helpers/admission.js';
import { GateModule, waitCall, say } from './helpers/dendrite.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class ReminderModule extends GateModule {
  override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'clock:reminder') return {};
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: String((event as unknown as { content: string }).content) }] }],
      requestInference: true,
    };
  }
}

class EndingModule extends ReminderModule {
  ended = false;

  override getTools() {
    return [...super.getTools(), { name: 'end', description: 'End the turn', inputSchema: { type: 'object' as const, properties: {} } }];
  }

  override async handleToolCall(call: Parameters<ReminderModule['handleToolCall']>[0]) {
    if (call.name === 'end' || call.name.endsWith('--end')) {
      this.ended = true;
      return { success: true, data: { ended: true }, endTurn: true };
    }
    return super.handleToolCall(call);
  }
}

class FailingStream extends MockYieldingStream {
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of { [Symbol.asyncIterator]: () => super[Symbol.asyncIterator]() }) {
      if (event.type === 'complete') {
        yield { type: 'error', error: new Error('request failed before answering') } as StreamEvent;
      } else yield event;
    }
  }
}

class BeforeCompletionStream extends MockYieldingStream {
  beforeComplete?: () => Promise<void>;
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of { [Symbol.asyncIterator]: () => super[Symbol.asyncIterator]() }) {
      if (event.type === 'complete') await this.beforeComplete?.();
      yield event;
    }
  }
}

class HeldStream extends MockYieldingStream {
  entered = false;
  release: () => void = () => {};
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.entered = true;
    await new Promise<void>((resolve) => { this.release = resolve; });
    yield* { [Symbol.asyncIterator]: () => super[Symbol.asyncIterator]() };
  }
}

class RateLimitedAtComplete extends MockYieldingStream {
  constructor(replies: ConstructorParameters<typeof MockYieldingStream>[0], private readonly error: Error) { super(replies, true); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of { [Symbol.asyncIterator]: () => super[Symbol.asyncIterator]() }) {
      if (event.type === 'complete') {
        yield { type: 'error', error: this.error } as StreamEvent;
        return;
      }
      yield event;
    }
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type GateState = Pick<EventGate, 'inferenceDiagnostics' | 'onInferenceStarted' | 'onInferenceEnded'> & { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout>; events: unknown[] }>; fireDebounce(name: string): void };
function gateOf(f: Fixture) {
  return (f.framework as unknown as { eventGate: GateState }).eventGate;
}
function fire(f: Fixture) {
  const gate = gateOf(f);
  assert.ok(gate.debounceTimers.size + gate.inferenceDiagnostics().bufferedEvents > 0, 'premise: a batch is pending or held');
  for (const [name, state] of gate.debounceTimers) {
    clearTimeout(state.timer);
    gate.fireDebounce(name);
  }
}
async function setup(debounce = 200, failing = false, beforeComplete?: (f: Fixture) => Promise<void>, agents?: unknown[], module: ReminderModule = new ReminderModule()) {
  const f = await fixture({ agents, framework: {
    modules: [module],
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    gate: { config: { policies: [{ name: 'batch', match: { scope: ['clock:reminder', 'mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce } }], default: 'always' } },
  } });
  const streams: MockYieldingStream[] = [];
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request);
    const replies = streams.length === 0 ? [waitCall('first'), say('answered')] : [say('fresh turn')];
    const stream = failing && streams.length === 0 ? new FailingStream(replies, true) : new BeforeCompletionStream(replies, true);
    if (stream instanceof BeforeCompletionStream && streams.length === 0 && beforeComplete) stream.beforeComplete = () => beforeComplete(f);
    streams.push(stream);
    return stream;
  };
  await registerOpen(f, 'work');
  const start = async (channelId = 'work') => {
    (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'test', source: 'editor', channelId, channelServerId: 'editor', timestamp: Date.now(),
    });
    const loop = f.framework.runUntilIdle();
    await eventually(() => module.entered.has('first'), 'turn reached tool');
    return { loop };
  };
  return { f, module, streams, start };
}
async function send(f: Fixture, lane: 'module' | 'channel' | 'push' | 'heartbeat' | 'reminder', body = 'new event', id = 'mid') {
  if (lane === 'heartbeat' || lane === 'reminder') {
    (f.framework as unknown as { deliverHeartbeat(wake: import('../src/heartbeat/heartbeat.js').HeartbeatWake): void }).deliverHeartbeat(
      lane === 'heartbeat'
        ? { kind: 'heartbeat', reason: 'schedule', silent: false, text: body, eventId: id }
        : { kind: 'reminder', reminderId: id, recurring: false, text: body, eventId: id });
  } else if (lane === 'module') {
    f.framework.pushEvent({ type: 'clock:reminder', source: 'clock', content: body } as unknown as ProcessEvent);
  } else if (lane === 'channel') {
    await incoming(f, 'work', id, body, MENTION);
  } else {
    await f.send('push/event', { featureSet: 'doc', eventId: id, timestamp: new Date().toISOString(), payload: { content: [{ type: 'text', text: body }] } });
  }
}
function deferred(f: Fixture, body: string) {
  return (f.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.some((m) => JSON.stringify(m).includes(body));
}
function heard(stream: MockYieldingStream) { return JSON.stringify(stream.receivedToolResultOptions); }
function recordWakes(f: Fixture): Array<{ agentName: string; lines?: number }> {
  const gate = gateOf(f) as unknown as { requestInferenceFn: (agentName: string, ...rest: unknown[]) => void };
  const wakes: Array<{ agentName: string; lines?: number }> = [];
  const original = gate.requestInferenceFn;
  gate.requestInferenceFn = (agentName, ...rest) => {
    const provenance = rest[2] as { lines?: unknown[] } | undefined;
    wakes.push({ agentName, ...(provenance?.lines ? { lines: provenance.lines.length } : {}) });
    original(agentName, ...rest);
  };
  return wakes;
}

describe('debounced writes already read and answered', () => {
  for (const lane of ['module', 'channel', 'push', 'heartbeat', 'reminder'] as const) {
    for (const held of [false, true]) {
      it(`${lane}: ${held ? 'a 200 ms batch held for inference' : 'a batch fired after the turn'} starts no second call`, async () => {
        const { f, module, streams, start } = await setup(held ? 200 : 60_000);
        const wakes = recordWakes(f);
        try {
          const { loop } = await start();
          await send(f, lane);
          await eventually(() => deferred(f, 'new event'), 'event deferred');
          if (held) await eventually(() => gateOf(f).inferenceDiagnostics().bufferedEvents === 1, 'batch held');
          module.release('first');
          await loop;
          if (!held) {
            assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 0, 'premise: nothing held for inference');
            fire(f);
          }
          await eventually(() => gateOf(f).debounceTimers.size === 0, 'debounce fired');
          assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
          await f.framework.runUntilIdle();
          assert.ok(heard(streams[0]!).includes('new event'), 'the tool boundary carried the event');
          if (lane === 'channel') assert.ok(f.published.some((p) => p.channelId === 'work'), 'the answer reached the channel');
          assert.equal(f.membrane.calls.length, 1, 'no redundant model call');
          assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 0, 'batch was checked, not left held');
          assert.ok(!f.context().includes('[Gate:'), 'no redundant gate line');
        } finally { await f.close(); }
      });
    }
  }

  it('a partial batch keeps the event arriving mid-turn after the request was built', async () => {
    const { f, module, streams, start } = await setup(60_000, false, async (f) => {
      await send(f, 'module', 'still unread', 'second');
      await eventually(() => deferred(f, 'still unread'), 'late event deferred after the boundary');
    });
    try {
      const { loop } = await start();
      await send(f, 'module', 'already answered');
      await eventually(() => deferred(f, 'already answered'), 'first event deferred');
      module.release('first');
      await loop;
      assert.ok(heard(streams[0]!).includes('already answered'));
      assert.ok(!heard(streams[0]!).includes('still unread'), 'late event was not in the request');
      assert.equal(gateOf(f).debounceTimers.get('batch')!.events.length, 2);
      fire(f);
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 2);
      const rows = f.framework.getAgent('agent')!.getContextManager().getAllMessages();
      const lines = rows.filter((r) => r.metadata?.source === 'gate:debounce');
      assert.equal(lines.length, 1);
      assert.ok(JSON.stringify(lines[0]).includes('still unread'));
      assert.ok(!JSON.stringify(lines[0]).includes('already answered'));
      assert.ok(JSON.stringify(lines[0]).includes('1 event matched'));
    } finally { await f.close(); }
  });

  it("one resident reading a shared write does not cancel another resident's wake", async () => {
    const { f, module, start } = await setup(60_000, false, undefined,
      ['agent', 'other'].map((name) => ({ name, model: 'test', systemPrompt: 'test' })));
    const turns: string[] = [];
    const off = f.framework.onTrace((event) => {
      if (event.type === 'inference:started') turns.push(event.agentName);
    });
    try {
      const { loop } = await start();
      await send(f, 'module');
      await eventually(() => deferred(f, 'new event'), 'event deferred');
      module.release('first');
      await loop;
      fire(f);
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['agent', 'other']);
      assert.equal(f.membrane.calls.length, 2);
    } finally { off(); await f.close(); }
  });

  it("a co-resident whose own turn answered the slot after the event still wakes for a batch written to the delivery agent's window", async () => {
    const { f, module } = await setup(60_000, false, undefined,
      ['agent', 'other'].map((name) => ({ name, model: 'test', systemPrompt: 'test' })));
    const turns: string[] = [];
    const off = f.framework.onTrace((event) => {
      if (event.type === 'inference:started') turns.push(event.agentName);
    });
    try {
      await send(f, 'module');
      await f.framework.runUntilIdle();
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'other', reason: 'test', source: 'editor', channelId: 'work', channelServerId: 'editor', timestamp: Date.now(),
      });
      const idle = f.framework.runUntilIdle();
      await eventually(() => module.entered.has('first'), "other's turn reached its tool");
      module.release('first');
      await idle;
      assert.deepEqual(turns, ['other'], "premise: other's turn read the slot after the event and was answered");
      fire(f);
      await f.framework.runUntilIdle();
      assert.deepEqual(turns.slice(1).sort(), ['agent', 'other'], "the event is the delivery agent's write, so other's answer doesn't take its wake");
    } finally { off(); await f.close(); }
  });

  it('unsatisfied residents retain stored content without re-presenting it in a shared summary', async () => {
    const { f, module, start } = await setup(60_000, false, undefined,
      ['agent', 'other', 'third'].map((name) => ({ name, model: 'test', systemPrompt: 'test' })));
    try {
      const { loop } = await start();
      await send(f, 'module');
      await eventually(() => deferred(f, 'new event'), 'event deferred');
      module.release('first');
      await loop;
      fire(f);
      const linesFor = (name: string) => f.framework.getAgent(name)!.getContextManager()
        .getAllMessages().filter((row) => row.metadata?.source === 'gate:debounce');
      const other = linesFor('other');
      const third = linesFor('third');
      assert.equal(other.length, 0, 'a shared summary must not re-present the event to its answered owner');
      assert.deepEqual(third, other);
      for (const name of ['other', 'third']) {
        assert.match(JSON.stringify(f.framework.getAgent(name)!.getContextManager().getAllMessages()), /new event/, 'original stored content is still in each resident window');
      }
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 3, 'both unsatisfied recipients wake');
      for (const request of f.membrane.calls.slice(1)) assert.match(JSON.stringify(request), /new event/, 'each request actually includes the original input');
      for (const name of ['agent', 'other', 'third']) assert.deepEqual(linesFor(name), [], `${name}'s window has no line for the event its delivery agent answered`);
    } finally { await f.close(); }
  });

  it('a batch that wakes three residents of one slot writes one line there', async () => {
    const { f, module } = await setup(60_000, false, undefined,
      ['agent', 'other', 'third'].map((name) => ({ name, model: 'test', systemPrompt: 'test' })));
    try {
      await send(f, 'module', 'first unread');
      await send(f, 'module', 'second unread', 'second');
      await f.framework.runUntilIdle();
      fire(f);
      const idle = f.framework.runUntilIdle();
      await eventually(() => module.entered.has('first'), 'the first turn reached its tool');
      module.release('first');
      await idle;
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 3, 'each resident wakes');
      const slot = f.framework.getAgent('other')!.getContextManager().getAllMessages().filter((row) => row.metadata?.source === 'gate:debounce');
      assert.equal(slot.length, 1, 'one line in the shared slot');
      assert.ok(JSON.stringify(slot[0]).includes('2 events matched'));
      assert.deepEqual(f.framework.getAgent('third')!.getContextManager().getAllMessages().filter((row) => row.metadata?.source === 'gate:debounce'), slot);
    } finally { await f.close(); }
  });


  it("a reader of the slot the batch didn't wake writes the batch's line at its own start, before the woken turn's", async () => {
    const f = await fixture({ framework: {
      modules: [new ReminderModule()],
      subconscious: { enabled: true, systemPrompt: 'notice' },
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      gate: { config: { policies: [{ name: 'batch', match: { scope: ['clock:reminder'] }, behavior: { debounce: 60_000 } }], default: 'always' } },
    } });
    const starts: string[] = [];
    f.framework.onTrace((event) => { if (event.type === 'inference:started') starts.push(event.agentName); });
    let held: HeldStream | undefined;
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
      f.membrane.calls.push(request);
      if (!held) return (held = new HeldStream([say('noted')], true));
      return new MockYieldingStream([say('fresh turn')], true);
    };
    try {
      await send(f, 'module', 'first unread');
      await send(f, 'module', 'second unread', 'second');
      await f.framework.runUntilIdle();
      fire(f);
      const internals = f.framework as unknown as { pendingRequests: Array<{ agentName: string }> };
      assert.deepEqual(internals.pendingRequests.map((r) => r.agentName), ['agent'], 'premise: the batch wakes the resident, not the subconscious');
      internals.pendingRequests.unshift({ agentName: 'Subconscious', reason: 'test', source: 'test', timestamp: Date.now() } as never);
      const idle = f.framework.runUntilIdle();
      await eventually(() => held?.entered === true, "the subconscious's turn is alive");
      await eventually(() => starts.length === 2, "the resident's woken turn starts while the subconscious's is alive");
      held!.release();
      await idle;
      assert.deepEqual(starts.slice(0, 2), ['Subconscious', 'agent']);
      for (const i of [0, 1]) assert.match(JSON.stringify(f.membrane.calls[i]), /2 events matched/, `request ${i} carries the batch's line`);
      const lines = f.framework.getAgent('agent')!.getContextManager().getAllMessages().filter((row) => row.metadata?.source === 'gate:debounce');
      assert.equal(lines.length, 1, 'one line in the slot');
    } finally { await f.close(); }
  });

  it("a batch with an event the host gave no write is written when it fires, naming every event, though the woken start finds the slot held", async () => {
    const module = new class extends ReminderModule {
      override async onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse> {
        if (event.type !== 'test:double') return super.onProcess(event, state);
        return {
          addMessages: ['double one', 'double two'].map((text) => ({ participant: 'user', content: [{ type: 'text' as const, text }] })),
          requestInference: true,
        };
      }
    }();
    const f = await fixture({ framework: {
      modules: [module],
      subconscious: { enabled: true, systemPrompt: 'notice' },
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      gate: { config: { policies: [{ name: 'batch', match: { scope: ['clock:reminder', 'test:double'] }, behavior: { debounce: 60_000 } }], default: 'always' } },
    } });
    const starts: string[] = [];
    f.framework.onTrace((event) => { if (event.type === 'inference:started') starts.push(event.agentName); });
    let held: HeldStream | undefined;
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
      f.membrane.calls.push(request);
      if (!held) return (held = new HeldStream([say('noted')], true));
      return new MockYieldingStream([say('fresh turn')], true);
    };
    const lines = () => f.framework.getAgent('agent')!.getContextManager().getAllMessages().filter((row) => row.metadata?.source === 'gate:debounce');
    try {
      await send(f, 'module', 'with a write');
      f.framework.pushEvent({ type: 'test:double', source: 'test', content: 'no write' } as unknown as ProcessEvent);
      await f.framework.runUntilIdle();
      fire(f);
      assert.equal(lines().length, 1, 'written when it fired');
      assert.match(JSON.stringify(lines()[0]!.content), /2 events matched/, 'naming every event');
      const internals = f.framework as unknown as { pendingRequests: Array<{ agentName: string }> };
      internals.pendingRequests.unshift({ agentName: 'Subconscious', reason: 'test', source: 'test', timestamp: Date.now() } as never);
      const idle = f.framework.runUntilIdle();
      await eventually(() => held?.entered === true, "the subconscious's turn is alive");
      await eventually(() => starts.length === 2, "the resident's woken turn starts while the subconscious's is alive");
      held!.release();
      await idle;
      assert.deepEqual(starts.slice(0, 2), ['Subconscious', 'agent']);
      assert.match(JSON.stringify(f.membrane.calls[1]), /2 events matched/, "the woken turn's request carries it");
      assert.equal(lines().length, 1, 'once');
    } finally { await f.close(); }
  });

  for (const held of ['a mention', 'a module event without a write', 'both'] as const) {
    it(`batches held for one turn are delivered apart by whether every event has a write: ${held}`, async () => {
      const module = new class extends ReminderModule {
        override async onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse> {
          if (event.type !== 'test:double') return super.onProcess(event, state);
          return {
            addMessages: ['double one', 'double two'].map((text) => ({ participant: 'user', content: [{ type: 'text' as const, text }] })),
            requestInference: true,
          };
        }
      }();
      const f = await fixture({ framework: {
        modules: [module],
        errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
        gate: { config: { policies: [
          { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 200 } },
          { name: 'double', match: { scope: ['test:double'] }, behavior: { debounce: 200 } },
        ], default: 'always' } },
      } });
      let calls = 0;
      (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
        f.membrane.calls.push(request);
        return new MockYieldingStream(calls++ === 0 ? [waitCall('first'), say('answered')] : [say('fresh turn')], true);
      };
      try {
        await registerOpen(f, 'work');
        (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
          agentName: 'agent', reason: 'test', source: 'editor', channelId: 'work', channelServerId: 'editor', timestamp: Date.now(),
        });
        const loop = f.framework.runUntilIdle();
        await eventually(() => module.entered.has('first'), 'turn reached tool');
        if (held !== 'a module event without a write') await send(f, 'channel');
        if (held !== 'a mention') f.framework.pushEvent({ type: 'test:double', source: 'test', content: 'no write' } as unknown as ProcessEvent);
        await eventually(() => gateOf(f).inferenceDiagnostics().bufferedEvents === (held === 'both' ? 2 : 1), 'the batches held for the turn');
        module.release('first');
        await loop;
        await f.framework.runUntilIdle();
        const lines = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
          .filter((row) => row.metadata?.source === 'gate:debounce').map((row) => JSON.stringify(row.content));
        assert.equal(f.membrane.calls.length, held === 'a mention' ? 1 : 2, 'a second turn only where the module event was held');
        assert.equal(f.published.filter((p) => p.channelId === 'work').length, 1, "only the first turn's answer reached the mention's channel");
        if (held === 'a mention') assert.deepEqual(lines, [], 'no line for the answered mention');
        else {
          assert.equal(lines.length, 1, 'one line, written when the batches were delivered');
          assert.match(lines[0]!, /1 event matched/);
          assert.doesNotMatch(lines[0]!, /in work/, 'naming the module event, not the answered mention');
        }
      } finally { await f.close(); }
    });
  }

  it('two batches owed to one start are written as one line, in the order they fired', async () => {
    const module = new class extends ReminderModule {
      override async onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse> {
        if (event.type !== 'test:second') return super.onProcess(event, state);
        return {
          addMessages: [{ participant: 'user', content: [{ type: 'text', text: String((event as unknown as { content: string }).content) }] }],
          requestInference: true,
        };
      }
    }();
    const f = await fixture({ framework: {
      modules: [module],
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      gate: { config: { policies: [
        { name: 'reminders', match: { scope: ['clock:reminder'] }, behavior: { debounce: 60_000 } },
        { name: 'seconds', match: { scope: ['test:second'] }, behavior: { debounce: 60_000 } },
      ], default: 'always' } },
    } });
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
      f.membrane.calls.push(request);
      return new MockYieldingStream([say('noted')], true);
    };
    try {
      f.framework.pushEvent({ type: 'clock:reminder', source: 'clock', content: 'fired second' } as unknown as ProcessEvent);
      f.framework.pushEvent({ type: 'test:second', source: 'test', content: 'fired first' } as unknown as ProcessEvent);
      await f.framework.runUntilIdle();
      const gate = gateOf(f);
      assert.equal(gate.debounceTimers.size, 2, 'premise: two batches pending');
      for (const rule of ['seconds', 'reminders']) {
        const name = [...gate.debounceTimers.keys()].find((key) => key.includes(rule))!;
        clearTimeout(gate.debounceTimers.get(name)!.timer);
        gate.fireDebounce(name);
      }
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 1, 'one start');
      const lines = f.framework.getAgent('agent')!.getContextManager().getAllMessages().filter((row) => row.metadata?.source === 'gate:debounce');
      assert.equal(lines.length, 1);
      assert.match(JSON.stringify(lines[0]!.content), /2 events matched\]\\n\\n- \[seconds\] \(test:second\): fired first\\n- \[reminders\] \(clock:reminder\): fired second/);
    } finally { await f.close(); }
  });

  it('an owed line whose event was answered before any start leaves the set unwritten at the next start', async () => {
    const { f, module, start } = await setup(200);
    const owed = () => (f.framework as unknown as { owedWakeLines: Set<unknown> }).owedWakeLines.size;
    try {
      const { loop } = await start();
      await send(f, 'module');
      await eventually(() => deferred(f, 'new event'), 'event deferred');
      await eventually(() => gateOf(f).inferenceDiagnostics().bufferedEvents === 1, 'batch held');
      module.release('first');
      await loop;
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 1, 'premise: the answered batch started no turn');
      assert.equal(owed(), 1, 'premise: no start has decided its line');
      (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now() });
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 2, 'premise: a later start');
      assert.equal(owed(), 0, 'that start found it answered');
      assert.ok(!f.context().includes('[Gate:'), 'and wrote no line');
    } finally { await f.close(); }
  });

  for (const kind of ['addressed', 'ambient', 'system'] as const) {
    it(`a channel event read without replying there ${kind === 'addressed' ? 'keeps its addressed wake' : kind === 'ambient' ? 'drops its ambient wake' : 'drops a chat:system notice\'s wake'}`, async () => {
      const { f, module, streams, start } = await setup(60_000);
      const wakes = recordWakes(f);
      try {
        await registerOpen(f, 'elsewhere');
        const { loop } = await start('elsewhere');
        await incoming(f, 'work', 'mid', 'new event', kind === 'ambient' ? ['chat:ambient'] : kind === 'system' ? ['chat:system'] : MENTION);
        await eventually(() => deferred(f, 'new event'), 'event deferred');
        module.release('first');
        await loop;
        assert.ok(heard(streams[0]!).includes('new event'), 'premise: the first turn read the event');
        assert.ok(!f.published.some((p) => p.channelId === 'work'), 'the first turn did not reply there');
        fire(f);
        assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
        await f.framework.runUntilIdle();
        assert.equal(f.membrane.calls.length, kind === 'addressed' ? 2 : 1);
      } finally { await f.close(); }
    });
  }

  it('a stored event read by a later turn also needs no debounced wake', async () => {
    const { f, module, start } = await setup(60_000);
    const wakes = recordWakes(f);
    try {
      await send(f, 'module');
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 0);
      const { loop } = await start();
      module.release('first');
      await loop;
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('new event'));
      fire(f);
      assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 1);
    } finally { await f.close(); }
  });

  it('an aggregate render-batch wake remains wakeable after another turn reads the render', async () => {
    const { f, module, start } = await setup(60_000);
    try {
      f.renderer(async () => ({ content: [{ type: 'text', text: 'rendered aggregate' }] }));
      await f.send('push/event', f.params('aggregate', 'fallback', { deferred: true }));
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 0);
      const { loop } = await start();
      module.release('first');
      await loop;
      assert.equal(f.renders.length, 1);
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('rendered aggregate'));
      fire(f);
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 2, 'aggregate reply requirements are not inferred from the latest event tags');
    } finally { await f.close(); }
  });

  for (const outcome of ['publishes', 'throws', 'refuses', 'stops', 'disposes'] as const) {
    it(`a final publication that ${outcome} ${outcome === 'publishes' ? 'drops the channel event\'s batched wake once it has published' : outcome === 'throws' || outcome === 'refuses' ? 'keeps the channel event\'s batched wake' : 'leaves no batch held'}`, async () => {
      const { f, module, start } = await setup(60_000);
      const wakes = recordWakes(f);
      const registry = (f.framework as unknown as {
        channelRegistry: { routeSpeech: (...args: unknown[]) => Promise<unknown> };
      }).channelRegistry;
      const original = registry.routeSpeech.bind(registry);
      let publishing = false;
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      registry.routeSpeech = async (...args) => {
        if (publishing) return original(...args);
        publishing = true;
        await wait;
        if (outcome === 'publishes') return original(...args);
        if (outcome === 'throws') throw new Error('publication failed');
        return null;
      };
      try {
        const { loop } = await start();
        await send(f, 'channel');
        await eventually(() => deferred(f, 'new event'), 'event deferred');
        fire(f);
        assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 1, 'premise: the batch fired during the turn is held for it');
        module.release('first');
        await eventually(() => publishing, 'final publication started');
        if (outcome === 'disposes') {
          (f.framework as unknown as { disposeConversationAgent(name: string): void }).disposeConversationAgent('agent');
          assert.equal(f.framework.getAgent('agent'), null);
        }
        const stopping = outcome === 'stops' ? f.framework.stop() : undefined;
        release();
        await loop;
        await stopping;
        if (outcome === 'publishes') {
          await f.framework.runUntilIdle();
          assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
          assert.ok(f.published.some((p) => p.channelId === 'work'), 'premise: the held publication reached the channel');
          assert.equal(f.membrane.calls.length, 1, 'judged after the publication, the wake is dropped');
        } else if (outcome === 'throws' || outcome === 'refuses') {
          await f.framework.runUntilIdle();
          assert.equal(f.membrane.calls.length, 2, 'failed publication leaves a chance to reply');
        }
        assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 0, 'no batch stays wedged');
      } finally { release(); await f.close(); }
    });
  }

  for (const proseRouting of ['locus', 'hybrid'] as const) {
    it(`${proseRouting}: a turn a tool ends is judged after its final publication, so its answered channel batch starts no second call`, async () => {
      const module = new EndingModule();
      const { f, start } = await setup(60_000, false, undefined, [{ name: 'agent', model: 'test', systemPrompt: 'test', proseRouting }], module);
      const wakes = recordWakes(f);
      const ending = createMockResponse([{ type: 'text', text: 'answered' }, { type: 'tool_use', id: 'call-end', name: 'test--end', input: {} }], 'tool_use');
      let calls = 0;
      (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
        f.membrane.calls.push(request);
        return new MockYieldingStream(calls++ === 0 ? [waitCall('first'), ending] : [say('fresh turn')], true);
      };
      const registry = (f.framework as unknown as {
        channelRegistry: { routeSpeech: (...args: unknown[]) => Promise<unknown> };
      }).channelRegistry;
      const original = registry.routeSpeech.bind(registry);
      let publishing = false;
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      registry.routeSpeech = async (...args) => {
        if (!publishing) {
          publishing = true;
          await wait;
        }
        return original(...args);
      };
      try {
        const { loop } = await start();
        await send(f, 'channel');
        await eventually(() => deferred(f, 'new event'), 'event deferred');
        fire(f);
        assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 1, 'premise: the batch fired during the turn is held for it');
        module.release('first');
        await eventually(() => module.ended && publishing, 'the tool ended the turn with its reply still publishing');
        release();
        await loop;
        await f.framework.runUntilIdle();
        assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
        assert.ok(f.published.some((p) => p.channelId === 'work'), 'premise: the held publication reached the channel');
        assert.equal(f.membrane.calls.length, 1, 'judged after the publication, the wake is dropped');
      } finally { release(); await f.close(); }
    });
  }

  it("an unread channel edit batched with the message it replaced and a later message: the turn's line counts the edit and the later message", async () => {
    const { f } = await setup(60_000);
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
      f.membrane.calls.push(request);
      return new MockYieldingStream([say('read it')], true);
    };
    try {
      await f.send('channels/incoming', { messages: [f.channel('c', 'original text', { initial: true }, 'work', 'edited')] });
      const edit = await f.send('channels/incoming', { messages: [f.channel('e', 'newest text', {}, 'work', 'edited')] });
      assert.equal(edit.result.results[0].coalesce.outcome, 'replaced', 'premise: the edit replaced the unread original');
      await f.send('channels/incoming', { messages: [f.channel('l', 'later text', { initial: true }, 'work', 'later')] });
      fire(f);
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 1, 'the unread edit and the later message keep the wake');
      assert.deepEqual(JSON.stringify(f.membrane.calls[0]).match(/\[Gate: \d+ events? matched\]/g), ['[Gate: 2 events matched]'],
        'one line, for the edit and the later message, not the removed original');
    } finally { await f.close(); }
  });

  it("a batched wake's turn that fails into a provider's stated wait after a tool round answered its event is retried, not dropped", async () => {
    const { f, module } = await setup(60_000);
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
      f.membrane.calls.push(request);
      if (f.membrane.calls.length === 1) {
        return new RateLimitedAtComplete([waitCall('first'), say('answered')], new MembraneError({
          type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 600_000,
          message: 'rate limit reached', rawError: { status: 429 }, rawRequest: request,
        }));
      }
      return new MockYieldingStream([say('retried')], true);
    };
    try {
      await send(f, 'module');
      await f.framework.runUntilIdle();
      fire(f);
      const queued = (f.framework as unknown as { pendingRequests: Array<{ readsWakeLines?: boolean; wakeLines?: unknown[] }> }).pendingRequests;
      assert.deepEqual(queued.map((r) => [r.readsWakeLines, r.wakeLines?.length]), [[true, 1]], "premise: the batch's wake, with its line");
      const line = queued[0]!.wakeLines![0];
      const idle = f.framework.runUntilIdle();
      await eventually(() => module.entered.has('first'), "the batch's turn reached its tool");
      module.release('first');
      await idle;
      const holds = (f.framework as unknown as { providerAccelerationCooldowns: Map<string, { heldRequests: Array<{ readsWakeLines?: boolean }> }> }).providerAccelerationCooldowns;
      assert.equal(holds.get('agent')?.heldRequests.length, 1, "premise: the provider's stated wait holds the turn's retry");
      const done = (f.framework as unknown as { wakeLineDone(agent: unknown, line: unknown): boolean }).wakeLineDone(f.framework.getAgent('agent'), line);
      assert.equal(done, true, "premise: the failed attempt's tool round answered the line's write");
      assert.ok(!holds.get('agent')!.heldRequests[0]!.readsWakeLines, 'the held retry no longer reads its lines, so the answer can\'t drop it');
      f.framework.releaseProviderWait('agent');
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 2, 'the retry ran');
    } finally { await f.close(); }
  });

  for (const outcome of ['aborted', 'failed'] as const) {
    it(`an ${outcome} turn keeps the held batch wake`, async () => {
      const { f, module, streams, start } = await setup(60_000, outcome === 'failed');
      try {
        const { loop } = await start();
        await send(f, 'module');
        await eventually(() => deferred(f, 'new event'), 'event deferred');
        fire(f);
        assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 1);
        if (outcome === 'aborted') assert.equal(f.framework.abortInference('agent', 'test abort'), true);
        module.release('first');
        await loop;
        await f.framework.runUntilIdle();
        assert.equal(heard(streams[0]!).includes('new event'), outcome === 'failed', 'only the failed request was handed the event');
        assert.equal(f.membrane.calls.length, 2, 'unanswered event still wakes');
        assert.ok(JSON.stringify(f.membrane.calls[1]).includes('new event'));
      } finally { await f.close(); }
    });
  }
});

type Verdict = { reply: boolean; reason: string };
type Asked = { resolve: (verdict: Verdict) => void; reject: (err: unknown) => void };
async function judged(wired: boolean, opts: { tool?: boolean } = {}) {
  const module = new ReminderModule();
  const f = await fixture({ framework: {
    modules: [module],
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    gate: {
      config: { policies: [{ name: 'batch', match: { scope: ['clock:reminder', 'mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 60_000 } } }], default: 'always' },
      judge: wired ? {} : { enabled: false },
    },
  } });
  const asked: Asked[] = [];
  if (wired) (gateOf(f) as unknown as { judgeFn: unknown }).judgeFn = () => new Promise<Verdict>((resolve, reject) => asked.push({ resolve, reject }));
  const streams: MockYieldingStream[] = [];
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request);
    const stream = new MockYieldingStream(opts.tool && streams.length === 0 ? [waitCall('first'), say('answered')] : [say('answered')], true);
    streams.push(stream);
    return stream;
  };
  await registerOpen(f, 'work');
  const verdicts: string[] = [];
  f.framework.onTrace((event) => {
    if (event.type === 'gate:judge-verdict') verdicts.push((event as unknown as { verdict: string }).verdict);
  });
  const wake = () => {
    (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'test', source: 'editor', channelId: 'work', channelServerId: 'editor', timestamp: Date.now(),
    });
    return f.framework.runUntilIdle();
  };
  const answeredMidTurn = async () => {
    const loop = wake();
    await eventually(() => module.entered.has('first'), 'turn reached tool');
    await send(f, 'module');
    await eventually(() => deferred(f, 'new event'), 'event deferred');
    module.release('first');
    await loop;
    assert.ok(heard(streams[0]!).includes('new event'), 'premise: the tool boundary carried the event');
  };
  const arrivesIdle = async () => {
    await send(f, 'module');
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, 0, 'premise: the judge rule held the event back');
    assert.equal(gateOf(f).debounceTimers.get('batch')?.events.length, 1, 'premise: its batch is pending');
  };
  const reply = () => {
    const next = asked.shift();
    assert.ok(next, 'a judge request is waiting');
    next.resolve({ reply: true, reason: 'test' });
  };
  return { f, module, asked, verdicts, wake, answeredMidTurn, arrivesIdle, reply };
}

describe('judge rules and the answered-batch drop', () => {
  it('with no judge wired, a judge rule\'s batch the agent answered starts no turn, as a debounce of its quiet period', async () => {
    const { f, answeredMidTurn } = await judged(false, { tool: true });
    const wakes = recordWakes(f);
    try {
      await answeredMidTurn();
      fire(f);
      assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 1, 'no redundant model call');
      assert.ok(!f.context().includes('[Gate:'), 'no gate line for the answered event');
    } finally { await f.close(); }
  });

  for (const [how, error, traced] of [
    ['fails', new Error('judge down'), ['error']],
    ['makes no call, its admission refused', Object.assign(new Error('admission deferred'), { providerAdmission: 'deferred' }), []],
  ] as const) {
    it(`a judge that ${how}, with onError "wake", delivers a batch the agent answered as a debounce: no turn`, async () => {
      const { f, asked, verdicts, answeredMidTurn } = await judged(true, { tool: true });
      const wakes = recordWakes(f);
      try {
        await answeredMidTurn();
        fire(f);
        await eventually(() => asked.length === 1, 'the judge is asked');
        asked.shift()!.reject(error);
        await eventually(() => (gateOf(f) as unknown as { judging: Map<string, unknown> }).judging.size === 0, "the judge's outcome is settled");
        assert.deepEqual(verdicts, traced);
        assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
        await f.framework.runUntilIdle();
        assert.equal(f.membrane.calls.length, 1, 'no redundant model call');
      } finally { await f.close(); }
    });
  }

  it("a reply given while the turn's answer awaits publication keeps its wake: the judge had the answer in view", async () => {
    const { f, module, asked, verdicts, wake, reply } = await judged(true, { tool: true });
    const registry = (f.framework as unknown as {
      channelRegistry: { routeSpeech: (...args: unknown[]) => Promise<unknown> };
    }).channelRegistry;
    const original = registry.routeSpeech.bind(registry);
    let publishing = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    registry.routeSpeech = async (...args) => {
      if (!publishing) {
        publishing = true;
        await held;
      }
      return original(...args);
    };
    try {
      const loop = wake();
      await eventually(() => module.entered.has('first'), 'turn reached tool');
      await send(f, 'channel');
      await eventually(() => deferred(f, 'new event'), 'event deferred');
      fire(f);
      assert.equal(asked.length, 0, 'premise: the judge waits for the turn');
      module.release('first');
      await eventually(() => publishing && asked.length === 1, "the judge is asked while the turn's answer awaits publication");
      reply();
      await eventually(() => verdicts.length === 1, 'the verdict');
      release();
      await loop;
      await f.framework.runUntilIdle();
      assert.ok(f.published.some((p) => p.channelId === 'work'), 'premise: the answer reached the channel');
      assert.equal(f.membrane.calls.length, 2, "the judge's reply stands");
    } finally { release(); await f.close(); }
  });

  it('a reply given with the answer already made keeps its wake: the turn starts', async () => {
    const { f, asked, verdicts, answeredMidTurn, reply } = await judged(true, { tool: true });
    try {
      await answeredMidTurn();
      fire(f);
      await eventually(() => asked.length === 1, 'the judge is asked');
      reply();
      await eventually(() => verdicts.length === 1, 'the verdict');
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 2, "the judge's reply stands");
    } finally { await f.close(); }
  });

  it('a reply given while a turn\'s start awaits its assembly is dropped once that turn answers the batch', async () => {
    const { f, asked, verdicts, arrivesIdle, reply } = await judged(true);
    const wakes = recordWakes(f);
    try {
      await arrivesIdle();
      fire(f);
      await eventually(() => asked.length === 1, 'the judge is asked');
      let release!: (value: unknown) => void;
      let rendering = false;
      f.renderer(() => { rendering = true; return new Promise((resolve) => { release = resolve; }); });
      await f.send('push/event', f.params('1', 'doc_edit', { deferred: true }));
      const run = f.framework.runUntilIdle();
      await eventually(() => rendering, "the turn's start awaits the render");
      assert.deepEqual(f.framework.getHostModeStatus().activeTurnAgents, ['agent'], 'premise: the scheduler holds the agent');
      assert.deepEqual(gateOf(f).inferenceDiagnostics().inferring, [], 'premise: the gate has not been told of the turn');
      reply();
      await eventually(() => verdicts.length === 1, 'the verdict');
      release({ content: [{ type: 'text', text: 'rendered' }] });
      await run;
      await f.framework.runUntilIdle();
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('new event'), 'premise: the turn read the event');
      assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
      assert.equal(f.membrane.calls.length, 1, "the reply's wake starts no second turn");
    } finally { await f.close(); }
  });

  it('a reply given while a wake is parked behind an auxiliary call is dropped once the parked turn answers the batch', async () => {
    const { f, asked, verdicts, arrivesIdle, reply, wake } = await judged(true);
    const wakes = recordWakes(f);
    try {
      await arrivesIdle();
      fire(f);
      await eventually(() => asked.length === 1, 'the judge is asked');
      let releaseAux!: () => void;
      const internal = f.framework as unknown as { withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T> };
      const auxiliary = internal.withAuxiliaryAdmission('agent', () => new Promise<void>((resolve) => { releaseAux = resolve; }));
      const run = wake();
      await eventually(() => f.framework.getHostModeStatus().parkedAdmissions === 1, 'the wake parks behind the auxiliary call');
      assert.equal(f.membrane.calls.length, 0, 'premise: parked, not started');
      reply();
      await eventually(() => verdicts.length === 1, 'the verdict');
      releaseAux();
      await auxiliary;
      await run;
      await eventually(() => f.membrane.calls.length >= 1, 'the parked turn runs');
      await f.framework.runUntilIdle();
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('new event'), 'premise: the turn read the event');
      assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
      assert.equal(f.membrane.calls.length, 1, "the reply's wake starts no second turn");
    } finally { await f.close(); }
  });

  it('a reply held behind another agent\'s turn is dropped once the judged agent answers the batch meanwhile', async () => {
    const { f, asked, verdicts, arrivesIdle, reply, wake } = await judged(true);
    const wakes = recordWakes(f);
    try {
      await arrivesIdle();
      fire(f);
      await eventually(() => asked.length === 1, 'the judge is asked');
      gateOf(f).onInferenceStarted('reader');
      reply();
      await eventually(() => verdicts.length === 1, 'the verdict');
      assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 1, "premise: the reply's batch waits for the other turn");
      await wake();
      assert.equal(f.membrane.calls.length, 1, "premise: the judged agent's own turn ran");
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('new event'), 'premise: that turn read the event');
      gateOf(f).onInferenceEnded('reader');
      await eventually(() => gateOf(f).inferenceDiagnostics().bufferedEvents === 0, 'the batch is delivered');
      await f.framework.runUntilIdle();
      assert.deepEqual(wakes, [{ agentName: 'agent', lines: 1 }], 'the batch requested its wake, handing on its line');
      assert.equal(f.membrane.calls.length, 1, "the reply's wake starts no second turn");
    } finally { await f.close(); }
  });
});

describe("the framework's answer to the gate's isAnswered", () => {
  type Row = { id: string; sequence: number; metadata?: { deferredWriteId?: string } };
  type AgentView = {
    getContextManager(): { getAllMessages(): Row[]; currentBranch(): { name: string } };
    answeredWatermark: { branch: string; sequence: number } | null;
  };
  type Ctx = {
    after: Record<string, string>; agent: AgentView; row: Row;
    internal: { deferredMessages: unknown[]; unackedDeferredWrites: unknown[]; landedCopiesById: () => unknown };
  };
  const write = (id: string) => ({ id, seq: 1, participant: 'editor', content: [{ type: 'text', text: id }], heldAt: Date.now() });
  const unreadable = (c: Ctx) => { c.agent.getContextManager = () => { throw new Error('store unreadable'); }; };
  const rows: Array<[string, boolean, (c: Ctx) => Record<string, string>]> = [
    ['a write that a request the agent answered carried: answered', true, (c) => c.after],
    ['the same write asked for as a stored message: answered', true, (c) => ({ agent: 'agent', messageId: c.row.id })],
    ['a stored message no longer in the store: answered', true, () => ({ agent: 'agent', messageId: 'no-such-row' })],
    ["a write above the answered watermark on the agent's branch: not answered", false, (c) => {
      c.agent.answeredWatermark = { branch: c.agent.getContextManager().currentBranch().name, sequence: c.row.sequence - 1 };
      return c.after;
    }],
    ['a write still queued for the agent: not answered', false, (c) => {
      c.internal.deferredMessages.push(write('queued-1'));
      return { agent: 'agent', deferredId: 'queued-1' };
    }],
    ['with no answered watermark yet: not answered', false, (c) => { c.agent.answeredWatermark = null; return c.after; }],
    ['with the watermark on another branch: in doubt, so answered', true, (c) => {
      c.agent.answeredWatermark = { branch: 'elsewhere', sequence: c.row.sequence };
      return c.after;
    }],
    ['a write drained but not yet stored: in doubt, so answered', true, (c) => {
      c.internal.unackedDeferredWrites.push(write('drained-1'));
      return { agent: 'agent', deferredId: 'drained-1' };
    }],
    ['a store that throws reading the write: in doubt, so answered', true, (c) => { unreadable(c); return c.after; }],
    ['a store that throws reading a stored message: in doubt, so answered', true, (c) => {
      const messageId = c.row.id;
      unreadable(c);
      return { agent: 'agent', messageId };
    }],
    ['a write whose agent is gone: in doubt, so answered', true, (c) => ({ ...c.after, agent: 'gone' })],
    ['a write placement that names no message: in doubt, so answered', true, () => ({ agent: 'agent' })],
    ['a queued write whose landing the store can\'t settle: in doubt, so answered', true, (c) => {
      c.internal.deferredMessages.push({ ...write('unsettled-1'), landing: 'unknown' });
      c.internal.landedCopiesById = () => undefined;
      return { agent: 'agent', deferredId: 'unsettled-1' };
    }],
  ];
  for (const [what, answered, ask] of rows) {
    it(what, async () => {
      const { f, answeredMidTurn } = await judged(true, { tool: true });
      const agent = f.framework.getAgent('agent') as unknown as AgentView;
      const getContextManager = agent.getContextManager;
      try {
        await answeredMidTurn();
        const after = (gateOf(f).debounceTimers.get('batch')!.events[0] as { after: Record<string, string> }).after;
        const row = agent.getContextManager().getAllMessages().find((m) => m.metadata?.deferredWriteId === after.deferredId);
        assert.ok(row && after.agent === 'agent', "premise: the event was written to the agent's queue and has landed");
        const internal = f.framework as unknown as Ctx['internal'];
        const isAnswered = (gateOf(f) as unknown as { isAnsweredFn: (after: Record<string, string>) => boolean }).isAnsweredFn;
        assert.equal(isAnswered(ask({ after, agent, row, internal })), answered);
      } finally {
        agent.getContextManager = getContextManager;
        await f.close();
      }
    });
  }
});

describe("what the judge is told of the framework's queued wakes", () => {
  type Internal = {
    pendingRequests: Array<Record<string, unknown>>;
    upcomingWakesFor(name: string): Array<{ certain: boolean; what: string }>;
  };
  const line = (after?: Record<string, string>) => ({ policyNames: ['batch'], at: 0, ...(after ? { after } : {}) });
  const told = (internal: Internal, queued: Array<Record<string, unknown>>) => {
    internal.pendingRequests.length = 0;
    for (const reads of queued) internal.pendingRequests.push({ agentName: 'agent', reason: 'gate:debounce', source: 'gate', timestamp: Date.now(), ...reads });
    const certain = internal.upcomingWakesFor('agent').map((w) => w.certain);
    internal.pendingRequests.length = 0;
    return certain;
  };

  it('a queued wake the scheduler could drop once the agent has answered it is a maybe', async () => {
    const { f } = await judged(true);
    try {
      const internal = f.framework as unknown as Internal;
      for (const reads of [
        { readsWakeLines: true, wakeLines: [line({ agent: 'agent', messageId: 'row-1' })] },
        { readsWakeLines: true, wakeLines: [line({ agent: 'agent', messageId: 'row-1' }), line({ agent: 'agent', deferredId: 'deferred-1' })] },
        { readsStoredMessage: 'row-1' },
        { readsDeferredWrite: 'deferred-1' },
      ]) assert.deepEqual(told(internal, [reads]), [false], JSON.stringify(reads));
    } finally { await f.close(); }
  });

  it('a queued wake the scheduler can never drop is certain', async () => {
    const { f } = await judged(true);
    try {
      const internal = f.framework as unknown as Internal;
      const maybe = { readsStoredMessage: 'row-1' };
      for (const queued of [
        [{ readsWakeLines: true, wakeLines: [] }],
        [{ readsWakeLines: true, wakeLines: [line({ agent: 'agent', messageId: 'row-1' }), line()] }],
        [{ readsWakeLines: true, wakeLines: [line({ agent: 'other', messageId: 'row-1' })] }],
        [{}],
        [maybe, {}],
      ]) assert.deepEqual(told(internal, queued), [true], JSON.stringify(queued));
    } finally { await f.close(); }
  });

  it('a turn a provider cooldown holds is a maybe when the scheduler could drop each held request, and certain otherwise', async () => {
    const { f } = await judged(true);
    try {
      const internal = f.framework as unknown as Internal & {
        recordProviderWait(agentName: string, model: string, error: Error): unknown;
        holdForProviderWait(agent: unknown, wait: unknown, requests: unknown[]): boolean;
        providerAccelerationCooldowns: Map<string, { heldRequests: unknown[] }>;
        getAgent(name: string): unknown;
      };
      const wait = internal.recordProviderWait('agent', 'test-model', new MembraneError({
        type: 'rate_limit', retryable: true, retryAfterMs: 60_000, message: 'slow down', rawError: { status: 429 },
      }));
      const droppable = { agentName: 'agent', reason: 'gate:debounce', source: 'gate', timestamp: Date.now(), readsWakeLines: true, wakeLines: [line({ agent: 'agent', messageId: 'row-1' })] };
      assert.ok(internal.holdForProviderWait(internal.getAgent('agent'), wait, [droppable]), 'premise: the cooldown holds the wake');
      const cooldownTold = () => internal.upcomingWakesFor('agent').filter((w) => w.what.includes('provider cooldown')).map((w) => w.certain);
      assert.deepEqual(cooldownTold(), [false], 'a held wake the scheduler could drop on release');
      internal.providerAccelerationCooldowns.get('agent')!.heldRequests.push({ agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now() });
      assert.deepEqual(cooldownTold(), [true], 'beside a held request it can never drop');
    } finally { await f.close(); }
  });
});
