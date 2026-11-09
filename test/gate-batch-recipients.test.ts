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

/** A gate whose own recipients are `agent` and `other`, with one rule over reminders. */
function makeGate(file: string, behavior: unknown, judge?: JudgeFn) {
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
  });
  return { gate, lines, wakes };
}

const reminder = (content: string, recipients?: string[]): GateEventInfo => ({
  content, eventType: 'clock:reminder', serverId: 'clock', channelId: '', ...(recipients ? { recipients } : {}),
});

/** Fires the batch the rule holds. */
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

  it("asks the judge about the agents a batch wakes, shows it no event whose list of recipients is empty, and doesn't ask about a batch that wakes no one", async () => {
    const requests: JudgeRequest[] = [];
    const judge: JudgeFn = async (request) => {
      requests.push(request);
      return { reply: false, reason: 'not now' };
    };
    const { gate, wakes } = makeGate('judge.json', { judge: { debounceMs: 60_000 } }, judge);
    gate.evaluate(reminder('water the plants', ['other']));
    gate.evaluate(reminder('feed the cat', []));
    fire(gate);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.agentNames, ['other']);
    assert.deepEqual(requests[0]!.events.map((e) => e.content), ['water the plants']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.evaluate(reminder('dim the lamps', []));
    fire(gate);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, 1, 'no judge call for a batch that wakes no one');
    assert.deepEqual(wakes, []);
    gate.dispose();
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
