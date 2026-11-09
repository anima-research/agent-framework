import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import type { NormalizedRequest } from '@animalabs/membrane';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { GateModule, say, waitCall } from './helpers/dendrite.js';
import { MockYieldingStream } from './helpers/mock-membrane.js';
import type { GatePolicy } from '../src/gate/types.js';

type Asked = string[] | true;

/** Answers a `clock:reminder` with one message, with the reminder's metadata, or, for `held: 'beside'`,
 *  a held message beside a visible one, asking inference for the agents the reminder names. */
class ReminderModule extends GateModule {
  override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'clock:reminder') return {};
    const reminder = event as unknown as { content: string; agents: Asked; held?: boolean | 'beside'; metadata?: Record<string, unknown> };
    const message = (text: string, metadata: Record<string, unknown> | undefined) => ({
      participant: 'user', content: [{ type: 'text' as const, text }], ...(metadata ? { metadata } : {}),
    });
    const held = { tuneOut: { epochId: 'e1' } };
    return {
      addMessages: reminder.held === 'beside'
        ? [message('a note held back', held), message(reminder.content, undefined)]
        : [message(reminder.content, reminder.held === true ? held : reminder.metadata)],
      requestInference: reminder.agents,
    };
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const BATCH: GatePolicy[] = [{ name: 'batch', match: { scope: ['clock:reminder'] }, behavior: { debounce: 60_000 } }];

async function setup(agents: unknown[], policies: GatePolicy[] = BATCH, framework: Record<string, unknown> = {}) {
  const module = new ReminderModule();
  const f = await fixture({ agents, framework: { modules: [module], gate: { config: { policies, default: 'always' } }, ...framework } });
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

const remind = (f: Fixture, content: string, agents: Asked, held: boolean | 'beside' = false, metadata?: Record<string, unknown>) =>
  f.framework.pushEvent({ type: 'clock:reminder', source: 'clock', content, agents, held, ...(metadata ? { metadata } : {}) } as unknown as ProcessEvent);

type GateHandle = {
  debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout>; events: unknown[] }>;
  fireDebounce(name: string): void;
  evaluate(info: { content?: unknown }): unknown;
};
const gateOf = (f: Fixture) => (f.framework as unknown as { eventGate: GateHandle }).eventGate;

/** The content of each event the gate is asked about, from now on. */
function gateAsked(f: Fixture): string[] {
  const gate = gateOf(f);
  const evaluate = gate.evaluate.bind(gate);
  const asked: string[] = [];
  gate.evaluate = (info) => { asked.push(String(info.content)); return evaluate(info); };
  return asked;
}

/** Fires the batch the debounce rule holds. */
function fire(f: Fixture): void {
  const gate = gateOf(f);
  assert.equal(gate.debounceTimers.size, 1, 'premise: the debounce rule holds a batch');
  for (const [name, state] of gate.debounceTimers) {
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
      fire(f);
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
      fire(f);
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['agent']);
    } finally { off(); await f.close(); }
  });

  it('a request for an empty list of agents is shown to no one in its batch, beside one for a resident', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')]);
    const asked = gateAsked(f);
    try {
      remind(f, 'water the plants', []);
      remind(f, 'dim the lamps', ['agent']);
      await f.framework.runUntilIdle();
      assert.deepEqual(asked, ['water the plants', 'dim the lamps'], 'premise: the gate is asked about both');
      fire(f);
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
    const asked = gateAsked(f);
    try {
      const job = await isolatedJob(f, module);
      remind(f, 'water the plants', ['worker-1']);
      remind(f, 'dim the lamps', ['agent']);
      await eventually(() => asked.length === 2, 'the gate is asked about both reminders');
      assert.deepEqual(asked, ['water the plants', 'dim the lamps']);
      fire(f);
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

  it('a request whose message is held from the residents is shown to no one in its batch, beside one for a resident', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')]);
    const asked = gateAsked(f);
    try {
      remind(f, 'water the plants', ['agent'], true);
      remind(f, 'dim the lamps', ['agent']);
      await f.framework.runUntilIdle();
      assert.deepEqual(asked, ['water the plants', 'dim the lamps'], 'premise: the gate is asked about both');
      fire(f);
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['agent']);
      const lines = rows(f, '[Gate:');
      assert.equal(lines.length, 1);
      assert.ok(JSON.stringify(lines[0]!.content).includes('dim the lamps'));
      assert.ok(!JSON.stringify(lines[0]!.content).includes('water the plants'));
    } finally { off(); await f.close(); }
  });

  it('with no rule batching it, a request whose message is held from the residents wakes no one either', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')], []);
    const added: string[] = [];
    const offAdded = f.framework.onTrace((event) => {
      if (event.type === 'message:added') added.push(event.source);
    });
    try {
      remind(f, 'water the plants', ['agent'], true);
      await f.framework.runUntilIdle();
      assert.deepEqual(added, ['clock:reminder'], 'premise: the held message is stored');
      assert.deepEqual(turns, []);
    } finally { offAdded(); off(); await f.close(); }
  });

  it('a request whose response stores a held message beside one the resident sees wakes it, as before', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')], []);
    try {
      remind(f, 'water the plants', ['agent'], 'beside');
      await f.framework.runUntilIdle();
      assert.deepEqual(turns, ['agent']);
      const request = JSON.stringify(f.membrane.calls[0]);
      assert.ok(request.includes('water the plants'), 'its request carries the message it sees');
      assert.ok(!request.includes('a note held back'), 'and not the held one');
      assert.equal(rows(f, 'a note held back').length, 1, 'premise: the held message is stored');
    } finally { off(); await f.close(); }
  });

  it('a held message wakes the subconscious it names, whose view keeps held traffic, and not the resident, batched or not', async () => {
    for (const policies of [[], BATCH]) {
      const { f, turns, off } = await setup([resident('agent'), resident('other')], policies, { subconscious: { enabled: true, systemPrompt: 'You notice.' } });
      try {
        remind(f, 'water the plants', ['agent', 'Subconscious'], true);
        await f.framework.runUntilIdle();
        if (policies.length > 0) {
          fire(f);
          await f.framework.runUntilIdle();
        }
        const how = policies.length > 0 ? 'batched' : 'no rule';
        assert.deepEqual([...new Set(turns)], ['Subconscious'], `${how}: only the subconscious wakes`);
        const call = f.membrane.calls.find((c) => JSON.stringify(c).includes('You notice.'));
        assert.ok(call && JSON.stringify(call).includes('water the plants'), `${how}: the subconscious is woken with the held message in view`);
        const lines = rows(f, '[Gate:');
        assert.deepEqual(lines.map(audienceOf), policies.length > 0 ? [['Subconscious']] : [], 'a line, if any, is stored for the subconscious alone');
      } finally { off(); await f.close(); }
    }
  });

  it("a response's message that carries a copied suppression record wakes the resident it names, since it's stored without it", async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')], []);
    try {
      remind(f, 'water the plants', ['agent'], false, { suppressed: { rule: 'quiet', eventType: 'clock:reminder' } });
      await f.framework.runUntilIdle();
      const stored = rows(f, 'water the plants');
      assert.equal(stored.length, 1, 'premise: the message is stored');
      assert.equal((stored[0]!.metadata as { suppressed?: unknown } | undefined)?.suppressed, undefined, 'premise: without the record');
      assert.deepEqual(turns, ['agent']);
    } finally { off(); await f.close(); }
  });

  it("a response storing only another agent's stored context injection doesn't wake the resident it names, batched or not", async () => {
    for (const policies of [[], BATCH]) {
      const { f, turns, off } = await setup([resident('agent'), resident('other')], policies);
      const asked = gateAsked(f);
      try {
        remind(f, 'water the plants', ['agent'], false, { contextInjection: { agent: 'other', namespace: 'agents/other', contentHash: 'h1', part: 0, parts: 1 } });
        await f.framework.runUntilIdle();
        const how = policies.length > 0 ? 'batched' : 'no rule';
        assert.equal(rows(f, 'water the plants').length, 1, `${how}: premise: the message is stored`);
        assert.deepEqual(asked, ['water the plants'], `${how}: premise: the gate is asked about it`);
        if (policies.length > 0) assert.equal(gateOf(f).debounceTimers.size, 0, 'batched: it joins no batch');
        assert.deepEqual(turns, [], `${how}: no one wakes`);
      } finally { off(); await f.close(); }
    }
  });

  it('a request for every agent (true) is batched as before: the batch wakes every resident, and its line is stored as a write that names no agent', async () => {
    const { f, turns, off } = await setup([resident('agent'), resident('other')]);
    try {
      remind(f, 'water the plants', true);
      await f.framework.runUntilIdle();
      fire(f);
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
