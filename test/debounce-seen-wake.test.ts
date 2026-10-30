/** Debounce keeps only wakes whose writes still need an answered request (#814). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import type { NormalizedRequest, StreamEvent } from '@animalabs/membrane';
import type { EventGate } from '../src/gate/event-gate.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { incoming, registerOpen, MENTION } from './helpers/admission.js';
import { GateModule, waitCall, say } from './helpers/dendrite.js';
import { MockYieldingStream } from './helpers/mock-membrane.js';

class ReminderModule extends GateModule {
  override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'clock:reminder') return {};
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: String((event as unknown as { content: string }).content) }] }],
      requestInference: true,
    };
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
type GateState = Pick<EventGate, 'inferenceDiagnostics'> & { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout>; events: unknown[] }>; fireDebounce(name: string): void };
// Access the timer only to fire the long-delay cases deterministically. The
// reproduction below uses the actual 200 ms timer, including its held path.
function gateOf(f: Fixture) {
  return (f.framework as unknown as { eventGate: GateState }).eventGate;
}
function fire(f: Fixture) {
  const gate = gateOf(f);
  for (const [name, state] of gate.debounceTimers) {
    clearTimeout(state.timer);
    gate.fireDebounce(name);
  }
}
async function setup(debounce = 200, failing = false, beforeComplete?: (f: Fixture) => Promise<void>, agents?: unknown[]) {
  const module = new ReminderModule();
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
async function send(f: Fixture, lane: 'module' | 'channel' | 'push', body = 'new event', id = 'mid') {
  if (lane === 'module') {
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

describe('debounced writes already read and answered', () => {
  for (const lane of ['module', 'channel', 'push'] as const) {
    for (const held of [false, true]) {
      it(`${lane}: a 200 ms batch ${held ? 'held for inference' : 'firing after the turn'} starts no second call`, async () => {
        const { f, module, streams, start } = await setup();
        try {
          const { loop } = await start();
          await send(f, lane);
          await eventually(() => deferred(f, 'new event'), 'event deferred');
          if (held) await eventually(() => gateOf(f).inferenceDiagnostics().bufferedEvents === 1, 'batch held');
          module.release('first');
          await loop;
          await eventually(() => gateOf(f).debounceTimers.size === 0, 'debounce fired');
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

  it('two unsatisfied residents share one remainder line in their real message slot', async () => {
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
      assert.equal(other.length, 1);
      assert.deepEqual(third, other, 'one stored line is visible to both residents; two writes would duplicate it');
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 3, 'both unsatisfied recipients wake');
    } finally { await f.close(); }
  });

  for (const ambient of [false, true]) {
    it(`a channel event read without replying there ${ambient ? 'drops its ambient wake' : 'keeps its addressed wake'}`, async () => {
      const { f, module, start } = await setup(60_000);
      try {
        await registerOpen(f, 'elsewhere');
        const { loop } = await start('elsewhere');
        await incoming(f, 'work', 'mid', 'new event', ambient ? ['chat:ambient'] : MENTION);
        await eventually(() => deferred(f, 'new event'), 'event deferred');
        module.release('first');
        await loop;
        assert.ok(!f.published.some((p) => p.channelId === 'work'), 'the first turn did not reply there');
        fire(f);
        await f.framework.runUntilIdle();
        assert.equal(f.membrane.calls.length, ambient ? 1 : 2);
      } finally { await f.close(); }
    });
  }

  it('a stored event read by a later turn also needs no debounced wake', async () => {
    const { f, module, start } = await setup(60_000);
    try {
      await send(f, 'module');
      await f.framework.runUntilIdle();
      assert.equal(f.membrane.calls.length, 0);
      const { loop } = await start();
      module.release('first');
      await loop;
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('new event'));
      fire(f);
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

  for (const outcome of ['throws', 'refuses', 'stops', 'disposes'] as const) {
    it(`a final publication that ${outcome} releases its held debounce`, async () => {
      const { f, module, start } = await setup(60_000);
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
        if (outcome === 'throws') throw new Error('publication failed');
        return null; // a refusal (including a connection closed during stop)
      };
      try {
        const { loop } = await start();
        await send(f, 'channel');
        await eventually(() => deferred(f, 'new event'), 'event deferred');
        fire(f);
        module.release('first');
        await eventually(() => publishing, 'final publication started');
        assert.deepEqual(gateOf(f).inferenceDiagnostics().inferring, [], 'status ends at its original boundary');
        assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 1, 'channel wake waits for the receipt');
        if (outcome === 'disposes') {
          (f.framework as unknown as { disposeConversationAgent(name: string): void }).disposeConversationAgent('agent');
          assert.equal(f.framework.getAgent('agent'), null);
        }
        const stopping = outcome === 'stops' ? f.framework.stop() : undefined;
        release();
        await loop;
        await stopping;
        if (outcome !== 'stops' && outcome !== 'disposes') {
          await f.framework.runUntilIdle();
          assert.equal(f.membrane.calls.length, 2, 'failed publication leaves a chance to reply');
        }
        assert.equal(gateOf(f).inferenceDiagnostics().bufferedEvents, 0, 'no batch stays wedged');
      } finally { release(); await f.close(); }
    });
  }

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
