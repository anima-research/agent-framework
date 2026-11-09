import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import type { NormalizedRequest } from '@animalabs/membrane';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { GateModule, say, waitCall } from './helpers/dendrite.js';
import { MockYieldingStream } from './helpers/mock-membrane.js';
import type { GatePolicy } from '../src/gate/types.js';

type Asked = string[] | true;

/** Answers a `clock:reminder` with one message, asking inference for the agents the reminder names. */
class ReminderModule extends GateModule {
  override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'clock:reminder') return {};
    const reminder = event as unknown as { content: string; agents: Asked };
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: reminder.content }] }],
      requestInference: reminder.agents,
    };
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const BATCH: GatePolicy[] = [{ name: 'batch', match: { scope: ['clock:reminder'] }, behavior: { debounce: 60_000 } }];

async function setup(agents: unknown[], policies: GatePolicy[] = BATCH) {
  const module = new ReminderModule();
  const f = await fixture({ agents, framework: { modules: [module], gate: { config: { policies, default: 'always' } } } });
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request);
    const job = JSON.stringify(request.messages).includes('[WORKER-FRAMING]') && !module.entered.has('g-worker');
    return new MockYieldingStream(job ? [waitCall('g-worker'), say('worker done')] : [say('answered')], true);
  };
  const turns: string[] = [];
  const off = f.framework.onTrace((event) => {
    if (event.type === 'inference:started') turns.push(event.agentName);
  });
  return { f, module, turns, off };
}

const remind = (f: Fixture, content: string, agents: Asked) =>
  f.framework.pushEvent({ type: 'clock:reminder', source: 'clock', content, agents } as unknown as ProcessEvent);

const gateOf = (f: Fixture) =>
  (f.framework as unknown as { eventGate: { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout>; events: unknown[] }>; fireDebounce(name: string): void } }).eventGate;

/** Fires the batch the debounce rule holds. */
function fire(f: Fixture, events: number): void {
  const gate = gateOf(f);
  assert.equal(gate.debounceTimers.size, 1, 'premise: the debounce rule holds the reminders');
  for (const [name, state] of gate.debounceTimers) {
    assert.equal(state.events.length, events, 'premise: the batch holds every reminder');
    clearTimeout(state.timer);
    gate.fireDebounce(name);
  }
}

const rows = (f: Fixture, text: string) => f.framework.getAgent('agent')!.getContextManager().getAllMessages()
  .filter((m) => JSON.stringify(m.content).includes(text));
const audienceOf = (row: { metadata?: unknown }) => (row.metadata as { audience?: unknown } | undefined)?.audience;

/** A copy of `agent` on a slot of its own, blocked in a tool until `done`. */
async function isolatedJob(f: Fixture, module: ReminderModule) {
  f.framework.start();
  const worker = await f.framework.deriveAgent({
    name: 'worker-1', from: 'agent', mode: 'copy',
    framing: [{ participant: 'user', content: [{ type: 'text', text: '[WORKER-FRAMING] count them' }] }],
  });
  const run = f.framework.runEphemeralToCompletion(worker.agent, worker.contextManager);
  await eventually(() => module.entered.has('g-worker'), 'the worker blocks in its tool');
  return {
    async done() {
      module.release('g-worker');
      await run;
      await f.framework.runUntilIdle();
    },
  };
}

const resident = (name: string, extra: Record<string, unknown> = {}) => ({ name, model: 'test', systemPrompt: 'test', ...extra });

describe("a debounced module event wakes the agents its response asked inference for, and its line is theirs", () => {
  it('a message for one resident: the batch wakes that resident alone, and its line is stored for that resident alone', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')]);
    try {
      remind(f, 'water the plants', ['agent']);
      await f.framework.runUntilIdle();
      fire(f, 1);
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['agent']);
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('water the plants'), "the resident it's for is woken with it");
      const quoting = rows(f, 'water the plants');
      assert.ok(quoting.some((m) => JSON.stringify(m.content).includes('[Gate:')), 'premise: the batch wrote its line');
      assert.deepEqual(quoting.map(audienceOf), quoting.map(() => ['agent']));
    } finally { off(); await f.close(); }
  });

  it("a requested agent the event's source can't trigger isn't woken by the batch, as it isn't on the direct path", async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other', { triggerSources: ['editor'] })]);
    try {
      remind(f, 'water the plants', ['agent', 'other']);
      await f.framework.runUntilIdle();
      fire(f, 1);
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['agent']);
    } finally { off(); await f.close(); }
  });

  it('a request for an empty list of agents is shown to no one in its batch, beside one for a resident', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')]);
    try {
      remind(f, 'water the plants', []);
      remind(f, 'dim the lamps', ['agent']);
      await f.framework.runUntilIdle();
      fire(f, 2);
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['agent']);
      const lines = rows(f, '[Gate:');
      assert.equal(lines.length, 1);
      assert.ok(JSON.stringify(lines[0]!.content).includes('dim the lamps'));
      assert.ok(!JSON.stringify(lines[0]!.content).includes('water the plants'));
    } finally { off(); await f.close(); }
  });

  it("a request naming only an isolated job, which doesn't read the message's slot, is shown to no one in its batch, beside one for a resident", async () => {
    const { f, module, turns, off } = await setup([resident('agent'), resident('other')]);
    try {
      const job = await isolatedJob(f, module);
      remind(f, 'water the plants', ['worker-1']);
      remind(f, 'dim the lamps', ['agent']);
      await eventually(() => gateOf(f).debounceTimers.get('batch')?.events.length === 2, 'the debounce rule holds both reminders');
      fire(f, 2);
      await job.done();
      assert.deepEqual(turns, ['worker-1', 'agent']);
      const lines = rows(f, '[Gate:');
      assert.equal(lines.length, 1);
      assert.ok(JSON.stringify(lines[0]!.content).includes('dim the lamps'));
      assert.ok(!JSON.stringify(lines[0]!.content).includes('water the plants'));
    } finally {
      module.release('g-worker');
      off();
      await f.close();
    }
  });

  it('a request for every agent (true) is batched as before: the batch wakes every resident, and its line is stored as a write that names no agent', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')]);
    try {
      remind(f, 'water the plants', true);
      await f.framework.runUntilIdle();
      fire(f, 1);
      await f.framework.runUntilIdle();
      assert.deepEqual([...turns].sort(), ['agent', 'other']);
      const lines = rows(f, '[Gate:');
      assert.equal(lines.length, 1);
      assert.deepEqual(audienceOf(lines[0]!), ['agent', 'other']);
    } finally { off(); await f.close(); }
  });

  it('with no rule batching it, a request naming an isolated job asks inference for it, as before', async () => {
    const { f, module, off } = await setup([resident('agent'), resident('other')], []);
    try {
      const job = await isolatedJob(f, module);
      remind(f, 'water the plants', ['worker-1']);
      const pending = () => (f.framework as unknown as { pendingRequests: Array<{ agentName: string; reason: string }> }).pendingRequests;
      await eventually(() => pending().some((r) => r.agentName === 'worker-1' && r.reason === 'clock:reminder'), "the reminder's request for the job");
      assert.deepEqual(pending().filter((r) => r.reason === 'clock:reminder').map((r) => r.agentName), ['worker-1']);
      await job.done();
    } finally {
      module.release('g-worker');
      off();
      await f.close();
    }
  });
});
