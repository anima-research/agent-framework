import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import type { NormalizedRequest } from '@animalabs/membrane';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { GateModule, say, waitCall } from './helpers/dendrite.js';
import { MockYieldingStream } from './helpers/mock-membrane.js';

/** Answers a `clock:reminder` with one message, asking inference for the agents it names. */
class TargetedReminderModule extends GateModule {
  constructor(readonly agents: string[]) {
    super();
  }

  override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'clock:reminder') return {};
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: String((event as unknown as { content: string }).content) }] }],
      requestInference: this.agents,
    };
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(module: TargetedReminderModule, agents: unknown[]) {
  const f = await fixture({ agents, framework: {
    modules: [module],
    gate: { config: { policies: [{ name: 'batch', match: { scope: ['clock:reminder'] }, behavior: { debounce: 60_000 } }], default: 'always' } },
  } });
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request);
    return new MockYieldingStream([say('answered')], true);
  };
  const turns: string[] = [];
  const off = f.framework.onTrace((event) => {
    if (event.type === 'inference:started') turns.push(event.agentName);
  });
  return { f, turns, off };
}

const remind = (f: Fixture, text: string) =>
  f.framework.pushEvent({ type: 'clock:reminder', source: 'clock', content: text } as unknown as ProcessEvent);
const gateOf = (f: Fixture) =>
  (f.framework as unknown as { eventGate: { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>; fireDebounce(name: string): void } }).eventGate;

/** Fires the batch the debounce rule holds. */
function fire(f: Fixture): void {
  const gate = gateOf(f);
  assert.equal(gate.debounceTimers.size, 1, 'premise: the debounce rule holds the reminder');
  for (const [name, state] of gate.debounceTimers) {
    clearTimeout(state.timer);
    gate.fireDebounce(name);
  }
}

/** The reminder arrives, its batch is held by the debounce rule, and the batch fires. */
async function remindAndFire(f: Fixture, text: string): Promise<void> {
  remind(f, text);
  await f.framework.runUntilIdle();
  fire(f);
  await f.framework.runUntilIdle();
}

const resident = (name: string, extra: Record<string, unknown> = {}) => ({ name, model: 'test', systemPrompt: 'test', ...extra });

describe("a debounced module event wakes the agents its response asked inference for, and its line is theirs", () => {
  it('a message for one resident: the batch wakes that resident alone, and its line is stored for that resident alone', async () => {
    const { f, turns, off } = await setup(new TargetedReminderModule(['agent']), [resident('agent'), resident('other')]);
    try {
      await remindAndFire(f, 'water the plants');
      assert.deepEqual(turns, ['agent']);
      assert.ok(JSON.stringify(f.membrane.calls[0]).includes('water the plants'), "the resident it's for is woken with it");
      const rows = f.framework.getAgent('other')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('water the plants'));
      assert.ok(rows.some((m) => JSON.stringify(m.content).includes('[Gate:')), 'premise: the batch wrote its line');
      assert.deepEqual(rows.map((m) => (m.metadata as { audience?: unknown } | undefined)?.audience), rows.map(() => ['agent']));
    } finally { off(); await f.close(); }
  });

  it("a requested agent the event's source can't trigger isn't woken by the batch, as it isn't on the direct path", async () => {
    const { f, turns, off } = await setup(new TargetedReminderModule(['agent', 'other']),
      [resident('agent'), resident('other', { triggerSources: ['editor'] })]);
    try {
      await remindAndFire(f, 'water the plants');
      assert.deepEqual(turns, ['agent']);
    } finally { off(); await f.close(); }
  });

  it('a request naming no agents (an empty list) wakes no one in a batch, as it wakes no one on the direct path', async () => {
    const { f, turns, off } = await setup(new TargetedReminderModule([]), [resident('agent'), resident('other')]);
    try {
      await remindAndFire(f, 'water the plants');
      assert.deepEqual(turns, []);
      const lines = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('[Gate:'));
      assert.deepEqual(lines, [], 'no line is stored for the residents');
    } finally { off(); await f.close(); }
  });

  it("a request naming only an isolated job, which doesn't read the message's slot: the batch wakes no one and writes no line", async () => {
    const module = new TargetedReminderModule(['worker-1']);
    const { f, turns, off } = await setup(module, [resident('agent')]);
    // An isolated job: a copy of the resident on a slot of its own, blocked in a tool while the reminder lands.
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
      f.membrane.calls.push(request);
      const first = JSON.stringify(request.messages).includes('[WORKER-FRAMING]') && !module.entered.has('g-worker');
      return new MockYieldingStream(first ? [waitCall('g-worker'), say('worker done')] : [say('answered')], true);
    };
    f.framework.start();
    const worker = await f.framework.deriveAgent({
      name: 'worker-1', from: 'agent', mode: 'copy',
      framing: [{ participant: 'user', content: [{ type: 'text', text: '[WORKER-FRAMING] count them' }] }],
    });
    const run = f.framework.runEphemeralToCompletion(worker.agent, worker.contextManager);
    try {
      await eventually(() => module.entered.has('g-worker'), 'the worker blocks in its tool');
      remind(f, 'water the plants');
      await eventually(() => gateOf(f).debounceTimers.size === 1, 'the debounce rule holds the reminder');
      fire(f);
      module.release('g-worker');
      await run;
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['worker-1'], "the worker's own turn, and no wake from the batch");
      const lines = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('[Gate:'));
      assert.deepEqual(lines, [], 'no line is stored for the residents');
    } finally {
      module.release('g-worker');
      off();
      await f.close();
    }
  });
});
