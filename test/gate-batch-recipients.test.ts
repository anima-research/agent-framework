import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateEventInfo, JudgeFn, JudgeRequest } from '../src/gate/types.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-batch-recipients');

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeGate(file: string, behavior: unknown, judge?: JudgeFn, now?: () => number) {
  const configPath = join(TMP_DIR, file);
  writeFileSync(configPath, JSON.stringify({ policies: [{ name: 'batch', match: { scope: ['clock:reminder'] }, behavior }] }));
  const lines: Array<{ text: string; audience?: readonly string[] }> = [];
  const wakes: string[] = [];
  const gate = new EventGate({
    configPath,
    emitTrace: () => {},
    addMessage: (_p, content, _m, _forAgent, _placement, audience) => {
      lines.push({ text: (content as Array<{ text: string }>)[0]!.text, ...(audience !== undefined ? { audience } : {}) });
      return '';
    },
    requestInference: (agentName) => wakes.push(agentName),
    getAgentNames: () => ['agent', 'other'],
    ...(judge ? { judge } : {}),
    ...(now ? { now } : {}),
  });
  return { gate, lines, wakes };
}

const reminder = (content: string, recipients?: string[]): GateEventInfo => ({
  content, eventType: 'clock:reminder', serverId: 'clock', channelId: '', ...(recipients ? { recipients } : {}),
});

function fire(gate: EventGate): void {
  const held = gate as unknown as { debounceTimers: Map<string, { timer?: ReturnType<typeof setTimeout> }>; fireDebounce(name: string): void };
  assert.equal(held.debounceTimers.size, 1, 'premise: the rule holds the batch');
  for (const [name, state] of held.debounceTimers) {
    if (state.timer) clearTimeout(state.timer);
    held.fireDebounce(name);
  }
}

describe('a batch shows each event to the agents it is for', () => {
  it("a named recipient that isn't one of the gate's own, such as a subconscious, is shown its own events alone", () => {
    const { gate, lines, wakes } = makeGate('mixed.json', { debounce: 60_000 });
    gate.evaluate(reminder('water the plants'));
    gate.evaluate(reminder('check the mood', ['sub']));
    fire(gate);
    assert.deepEqual([...wakes].sort(), ['agent', 'other', 'sub']);
    const forSub = lines.filter((l) => l.audience?.includes('sub'));
    assert.equal(forSub.length, 1);
    assert.ok(forSub[0]!.text.includes('check the mood'));
    assert.ok(!forSub[0]!.text.includes('water the plants'), "the untargeted event is the gate's recipients'");
    const forResidents = lines.filter((l) => l.audience?.includes('agent'));
    assert.deepEqual(forResidents.map((l) => l.audience), [['agent', 'other']]);
    assert.ok(forResidents[0]!.text.includes('water the plants'));
    assert.ok(!forResidents[0]!.text.includes('check the mood'));
    gate.dispose();
  });

  it('an event whose list of recipients is empty leaves a batch of untargeted events as it is without it', () => {
    const { gate, lines, wakes } = makeGate('empty.json', { debounce: 60_000 });
    gate.evaluate(reminder('water the plants'));
    gate.evaluate(reminder('dim the lamps', []));
    fire(gate);
    assert.deepEqual(wakes, ['agent', 'other']);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.audience, undefined, "stored as an untargeted batch's line is, a write that names no agent");
    assert.ok(lines[0]!.text.includes('water the plants'));
    assert.ok(!lines[0]!.text.includes('dim the lamps'));
    gate.dispose();
  });

  it("judges a batch as a whole, for the gate's recipients, and never with an event whose list of recipients is empty", async () => {
    const requests: JudgeRequest[] = [];
    let answered!: () => void;
    const verdict = new Promise<void>((resolve) => { answered = resolve; });
    const judge: JudgeFn = async (request) => {
      requests.push(request);
      answered();
      return { reply: false, reason: 'not now' };
    };
    const { gate, wakes } = makeGate('judge.json', { judge: { debounceMs: 60_000 } }, judge);
    gate.evaluate(reminder('water the plants', ['other']));
    gate.evaluate(reminder('feed the cat', []));
    fire(gate);
    await verdict;
    const judging = gate as unknown as { judging: Map<string, unknown> };
    for (let i = 0; i < 20 && judging.judging.size > 0; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(judging.judging.size, 0, 'premise: the verdict is applied');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.agentNames, ['agent', 'other']);
    assert.deepEqual(requests[0]!.events.map((e) => e.content), ['water the plants']);
    assert.deepEqual(wakes, [], 'a WAIT wakes no one');
    gate.dispose();
  });

  it('names on each upcoming wake the agents it would wake, of those asked about', () => {
    const { gate } = makeGate('wakes.json', { debounce: 60_000 });
    gate.evaluate(reminder('water the plants', ['other']));
    gate.armSelfWake('other', 120);
    gate.setSleep(300, undefined, 'other');
    const wakes = gate.upcomingWakes(['agent', 'other']);
    assert.deepEqual(wakes.map((w) => w.kind), ['debounce', 'self-wake', 'sleep-end'], 'premise: the three kinds of source');
    assert.deepEqual(wakes.map((w) => (w as { agents?: unknown }).agents), [['other'], ['other'], ['other']]);
    assert.deepEqual(gate.upcomingWakes(['agent']), [], "none is agent's");
    gate.clearSleep();
    gate.evaluate(reminder('dim the lamps'));
    gate.setSleep(300);
    const shared = gate.upcomingWakes(['agent', 'other']).filter((w) => w.kind !== 'self-wake');
    assert.deepEqual(shared.map((w) => [w.kind, (w as { agents?: unknown }).agents]), [['debounce', ['agent', 'other']], ['sleep-end', ['agent', 'other']]],
      'an untargeted event and a sleep that names no agent are for every agent asked about');
    gate.dispose();
  });

  it('an event whose list of recipients is empty joins no batch and is let through: alone it holds none, and beside one it neither joins nor restarts its quiet period', () => {
    let clock = 1_000_000;
    const { gate, lines, wakes } = makeGate('none.json', { debounce: 60_000 }, undefined, () => clock);
    const held = gate as unknown as { debounceTimers: Map<string, { events: unknown[]; dueAt: number }> };
    assert.equal(gate.evaluate(reminder('dim the lamps', [])).trigger, true, 'let through, so whom it wakes is the caller\'s');
    assert.equal(held.debounceTimers.size, 0, 'alone, it holds no batch');
    gate.evaluate(reminder('water the plants', ['agent']));
    const due = held.debounceTimers.get('batch')!.dueAt;
    clock += 30_000;
    assert.equal(gate.evaluate(reminder('feed the cat', [])).trigger, true);
    assert.equal(held.debounceTimers.get('batch')!.events.length, 1, "it doesn't join the batch");
    assert.equal(held.debounceTimers.get('batch')!.dueAt, due, "it doesn't restart the batch's quiet period");
    fire(gate);
    assert.deepEqual(wakes, ['agent']);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.text.includes('feed the cat'));
    gate.dispose();
  });

  it('a probe and evaluate agree on an event whose list of recipients is empty, under a debounce rule and a judge rule', () => {
    const judge: JudgeFn = async () => ({ reply: false, reason: 'not now' });
    for (const [file, behavior] of [['probe-debounce.json', { debounce: 60_000 }], ['probe-judge.json', { judge: { debounceMs: 60_000 } }]] as const) {
      const { gate } = makeGate(file, behavior, judge);
      assert.equal(gate.probe(reminder('dim the lamps', [])).trigger, true, `${file}: the probe lets it through`);
      assert.equal(gate.evaluate(reminder('dim the lamps', [])).trigger, true, `${file}: evaluate lets it through`);
      assert.equal(gate.probe(reminder('water the plants', ['agent'])).trigger, false, `${file}: a probe of a named event still batches`);
      gate.dispose();
    }
  });

  it('counts a pending batch among the wakes due only for the agents it would wake', () => {
    const kinds = (gate: EventGate, name: string) => gate.upcomingWakes([name]).map((w) => w.kind);
    const forAgent = makeGate('upcoming-agent.json', { debounce: 60_000 });
    forAgent.gate.evaluate(reminder('water the plants', ['agent']));
    assert.deepEqual(kinds(forAgent.gate, 'agent'), ['debounce']);
    assert.deepEqual(kinds(forAgent.gate, 'other'), []);
    forAgent.gate.dispose();
    const forSub = makeGate('upcoming-sub.json', { debounce: 60_000 });
    forSub.gate.evaluate(reminder('check the mood', ['sub']));
    assert.deepEqual(kinds(forSub.gate, 'sub'), ['debounce']);
    assert.deepEqual(kinds(forSub.gate, 'agent'), []);
    forSub.gate.dispose();
    const forNoOne = makeGate('upcoming-none.json', { debounce: 60_000 });
    forNoOne.gate.evaluate(reminder('dim the lamps', []));
    assert.deepEqual(kinds(forNoOne.gate, 'agent'), []);
    forNoOne.gate.dispose();
  });
});
