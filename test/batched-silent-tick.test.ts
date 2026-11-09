import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import type { NormalizedRequest } from '@animalabs/membrane';
import { conversationForkSpec } from '../src/dendrite/index.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { incoming, registerOpen, MENTION } from './helpers/admission.js';
import { GateModule, waitCall, say } from './helpers/dendrite.js';
import { MockYieldingStream } from './helpers/mock-membrane.js';
import { SILENT_HEARTBEAT_SEPARATOR } from '../src/silent-heartbeat.js';

class M extends GateModule {
  override async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Pending = { agentName: string; source?: string; suppressProse?: boolean; silentHeartbeat?: { eventId: string; serverId: string }; wakeLines?: unknown[] };
type Internals = {
  eventGate: { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>; fireDebounce(name: string): void };
  pendingRequests: Pending[];
  deliverHeartbeat(wake: unknown): void;
  registry: { register(spec: ReturnType<typeof conversationForkSpec>): unknown; end(name: string, reason: 'stopped'): unknown };
  agents: Map<string, unknown>;
};
const internals = (f: Fixture) => f.framework as unknown as Internals;
const tick = (f: Fixture) => internals(f).deliverHeartbeat({ kind: 'heartbeat', reason: 'schedule', silent: true, text: 'tick prompt', eventId: 'tick' });
const reminder = (f: Fixture) => internals(f).deliverHeartbeat({ kind: 'reminder', reminderId: 'r1', recurring: false, text: 'water the plants', eventId: 'rem' });
const separator = SILENT_HEARTBEAT_SEPARATOR.slice(0, 40);

/** A framework whose gate batches channel messages and pushes, the heartbeat's included, for a minute. */
async function batching() {
  const module = new M();
  const f = await fixture({ framework: {
    modules: [module],
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    gate: { config: { policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 60_000 } }], default: 'always' } },
  } });
  await registerOpen(f, 'work');
  return { f, module };
}

/** Fire every pending batch now, as its timer would. */
function fire(f: Fixture): void {
  const gate = internals(f).eventGate;
  assert.ok(gate.debounceTimers.size > 0, 'premise: a batch is pending');
  for (const [name, state] of gate.debounceTimers) {
    clearTimeout(state.timer);
    gate.fireDebounce(name);
  }
}

/**
 * A first turn waits at a tool while the tick, and whatever `alongside`
 * sends, arrive and are batched; the batch fires once that turn has ended.
 * The request of the turn the batch wakes, and what was routed as speech.
 */
async function batchedTurn(alongside: (f: Fixture) => Promise<void> | void) {
  const { f, module } = await batching();
  let n = 0;
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request);
    return new MockYieldingStream(n++ === 0 ? [waitCall('first'), say('answered')] : [say('fresh turn')], true);
  };
  const routed: string[] = [];
  const off = f.framework.onTrace((e) => { if (/^mcpl:speech-route/.test(e.type)) routed.push(e.type); });
  try {
    internals(f).pendingRequests.push({
      agentName: 'agent', reason: 'test', source: 'editor', channelId: 'work', channelServerId: 'editor', timestamp: Date.now(),
    } as Pending);
    const loop = f.framework.runUntilIdle();
    await eventually(() => module.entered.has('first'), 'turn reached tool');
    tick(f);
    await alongside(f);
    module.release('first');
    await loop;
    routed.length = 0;
    fire(f);
    const woken = internals(f).pendingRequests.map((r) => ({ ...r }));
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, 2, 'premise: the batch wakes one turn');
    return { woken, request: JSON.stringify(f.membrane.calls[1]), routed: [...routed] };
  } finally { off(); await f.close(); }
}

describe('a silent tick batched by a gate rule', () => {
  it('alone, wakes as the tick: prose suppressed, its separator sent, and no [Gate:] line naming a message it never stored', async () => {
    const { woken, request, routed } = await batchedTurn(() => {});
    assert.deepEqual(woken.map((r) => [r.agentName, r.suppressProse, r.silentHeartbeat]),
      [['agent', true, { eventId: 'tick', serverId: 'heartbeat' }]]);
    assert.ok(request.includes(separator), 'the tick separator is in the request');
    assert.ok(!request.includes('[Gate: '), 'no [Gate:] line');
    assert.deepEqual(routed, [], 'its prose is not routed as speech');
  });

  it('with a channel message, wakes an ordinary turn whose [Gate:] line counts the message alone', async () => {
    const { woken, request, routed } = await batchedTurn((f) => incoming(f, 'work', 'm1', 'hello there', MENTION));
    assert.ok(woken.every((r) => r.suppressProse !== true && r.silentHeartbeat === undefined), 'an ordinary wake');
    assert.ok(!request.includes(separator), 'no tick separator');
    assert.ok(!request.includes('(unknown channel)'), 'the tick is not counted as a message');
    assert.ok(!request.includes('[Gate: 2 events matched]'));
    assert.deepEqual(routed, ['mcpl:speech-routed'], 'its reply goes to the channel');
  });

  it('with a heartbeat reminder, wakes an ordinary turn whose [Gate:] line counts the reminder alone', async () => {
    const { woken, request } = await batchedTurn((f) => reminder(f));
    assert.ok(woken.every((r) => r.suppressProse !== true && r.silentHeartbeat === undefined), 'an ordinary wake');
    assert.ok(!request.includes(separator), 'no tick separator');
    assert.ok(request.includes('[Gate: 1 event matched]'), 'one event, the reminder');
    assert.ok(!request.includes('2 messages in'), 'the tick is not counted with the reminder');
  });

  it("is the heartbeat's own: a server's push whose origin says silent, batched alone, keeps its line and wakes an ordinary turn", async () => {
    const { f } = await batching();
    try {
      await f.send('push/event', {
        featureSet: 'doc', eventId: 'p1', timestamp: new Date().toISOString(),
        origin: { silent: true }, payload: { content: [{ type: 'text', text: 'a document changed' }] },
      });
      await f.framework.runUntilIdle();
      fire(f);
      const woken = internals(f).pendingRequests;
      assert.ok(woken.length > 0, 'premise: the batch wakes the agent');
      assert.ok(woken.every((r) => r.suppressProse !== true && r.silentHeartbeat === undefined), 'an ordinary wake');
      assert.ok(woken.some((r) => (r.wakeLines?.length ?? 0) > 0) || f.context().includes('[Gate: 1 event matched]'),
        'its [Gate:] line, written now or handed to the wake');
    } finally {
      internals(f).pendingRequests.splice(0);
      await f.close();
    }
  });

  it('wakes the agents the heartbeat wakes, not a conversation fork the gate also wakes', async () => {
    const { f } = await batching();
    const fw = internals(f);
    fw.registry.register(conversationForkSpec('agent-conv-1', { template: 'agent', homeChannel: { serverId: 'editor', channelId: 'work' }, idleTtlMs: 60_000 }));
    fw.agents.set('agent-conv-1', fw.agents.get('agent'));
    try {
      tick(f);
      assert.equal(fw.pendingRequests.length, 0, 'premise: the rule batches the tick');
      fire(f);
      assert.deepEqual(fw.pendingRequests.map((r) => [r.agentName, r.suppressProse]), [['agent', true]]);
    } finally {
      fw.pendingRequests.splice(0);
      fw.registry.end('agent-conv-1', 'stopped');
      fw.agents.delete('agent-conv-1');
      await f.close();
    }
  });
});
