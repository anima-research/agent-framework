/**
 * Suppress rules (`suppress: { description, script? }`): how the gate reads them, which events
 * they take (suppressionFor), and that they never decide a wake.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate, findShadowedPolicies } from '../src/gate/event-gate.js';
import { firstCatchAll } from '../src/gate/rule-scope.js';
import type { GateConfig, GateEventInfo, GatePolicy } from '../src/gate/types.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-suppress');
const CONFIG_PATH = join(TMP_DIR, 'gate.json');

function makeGate(config: unknown, traces: Array<Record<string, unknown>> = []) {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, typeof config === 'string' ? config : JSON.stringify(config));
  return new EventGate({
    configPath: CONFIG_PATH,
    emitTrace: (t) => { traces.push(t as Record<string, unknown>); },
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
}

const ev = (tags: string[], over: Partial<GateEventInfo> = {}): GateEventInfo => ({
  content: 'the eye went off', eventType: 'mcpl:push-event', serverId: 'body', channelId: '', tags, ...over,
});

const S = { description: 'the body\'s noise' };
const HIDE_BODY: GatePolicy = { name: 'hide-body', match: { source: 'body' }, behavior: 'defer', suppress: S };

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
afterEach(() => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

describe('reading a suppress rule', () => {
  it('loads a suppress object with a description, behavior "defer" and a narrowing match as a suppress rule', () => {
    const gate = makeGate({ default: 'always', policies: [HIDE_BODY] });
    assert.deepEqual(gate.policyInForce('hide-body')?.suppress, S);
    assert.deepEqual(gate.getStatus().errors, []);
    const status = gate.getStatus().policies.find((p) => p.name === 'hide-body');
    assert.deepEqual(status?.suppress, S);
  });

  it('wake_add_rule\'s path (addPolicy) writes it as given, and refuses one without "defer", one that matches everything, or a suppress that isn\'t a described object', () => {
    const gate = makeGate({ default: 'always', policies: [] });
    gate.addPolicy({ ...HIDE_BODY });
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as GateConfig;
    assert.deepEqual(onDisk.policies[0], HIDE_BODY);

    assert.throws(() => gate.addPolicy({ name: 'x', match: { source: 'body' }, behavior: 'always', suppress: S }),
      /suppress is given, and a rule that suppresses needs "behavior": "defer" written out.*behavior "always"/);
    assert.throws(() => gate.addPolicy({ name: 'y', match: { source: 'body' }, suppress: S }),
      /needs "behavior": "defer" written out.*it has no behavior/);
    assert.throws(() => gate.addPolicy({ name: 'z', match: {}, behavior: 'defer', suppress: S }),
      /suppress is given, and the rule matches every event/);
    assert.throws(() => gate.addPolicy({ name: 'w', match: { scope: [] }, behavior: 'defer', suppress: S }),
      /the rule matches every event/, 'an empty scope narrows nothing');
    assert.throws(() => gate.addPolicy({ name: 'v', match: { source: 'body' }, behavior: 'defer', suppress: true }),
      /suppress is true, where an object such as \{"description": "the eye going on and off"\} is needed/);
    assert.throws(() => gate.addPolicy({ name: 'u', match: { source: 'body' }, behavior: 'defer', suppress: {} }),
      /suppress\.description is missing/);
    assert.throws(() => gate.addPolicy({ name: 't', match: { source: 'body' }, behavior: 'defer', suppress: { ...S, script: '(event, state) => {' } }),
      /suppress\.script doesn't parse/);
    assert.throws(() => gate.addPolicy({ name: 's', match: { source: 'body' }, behavior: 'defer', suppress: { ...S, script: 42 } }),
      /suppress\.script is 42, where the source of a function/);
    assert.throws(() => gate.addPolicy({ name: 'r', match: { source: 'body' }, behavior: 'defer', suppress: { ...S, scirpt: '() => true' } }),
      /suppress has "scirpt" \(did you mean "script"\?\)/, 'a slip of a field is refused, not read as hiding everything');
    assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['hide-body'], 'nothing refused was saved');
  });

  it('a gate.json rule with a problem in its suppress is read as a release without suppression reads it: not suppressing', () => {
    const gate = makeGate({ default: 'defer', policies: [
      { name: 'loud', match: { source: 'body' }, behavior: 'always', suppress: S },
      { name: 'all', match: {}, behavior: 'defer', suppress: S },
    ] });
    assert.equal(gate.policyInForce('loud')?.suppress, undefined);
    assert.equal(gate.policyInForce('all')?.suppress, undefined);
    assert.equal(gate.suppressionFor(ev(['chat:ambient'])), null);
    assert.equal(gate.evaluate(ev(['chat:ambient'])).trigger, true, '"loud" wakes, as its behavior says');
    assert.ok(gate.getStatus().errors.some((e) => /Rule "loud".*suppress is given/.test(e)), 'gate_status names the problem');
  });
});

describe('a suppress rule read past a problem in gate.json does not suppress', () => {
  for (const [what, rule] of [
    ['a misspelled script field', { name: 'r', match: { source: 'body' }, behavior: 'defer', suppress: { description: 'x', scirpt: '() => false' } }],
    ['an empty script', { name: 'r', match: { source: 'body' }, behavior: 'defer', suppress: { description: 'x', script: '' } }],
    ['a null script', { name: 'r', match: { source: 'body' }, behavior: 'defer', suppress: { description: 'x', script: null } }],
    ['a match read without a malformed part', { name: 'r', match: { source: 'body', tagsAny: 'chat:ambient' }, behavior: 'defer', suppress: { description: 'x' } }],
  ] as const) {
    it(`${what}: the rule defers instead, and gate_status says why`, () => {
      const gate = makeGate({ default: 'always', policies: [rule] });
      assert.equal(gate.policyInForce('r')?.suppress, undefined);
      assert.equal(gate.suppressionFor(ev(['chat:ambient'])), null);
      assert.ok(gate.getStatus().errors.some((e) => /Rule "r"/.test(e)), 'named in gate_status');
    });
  }
});

describe('suppressionFor', () => {
  it('names the suppress rule that takes the event, without a side effect', () => {
    const traces: Array<Record<string, unknown>> = [];
    const gate = makeGate({ default: 'always', policies: [HIDE_BODY] }, traces);
    traces.length = 0;
    assert.equal(gate.suppressionFor(ev(['chat:ambient'])), 'hide-body');
    assert.equal(gate.suppressionFor(ev(['chat:ambient'], { serverId: 'discord' })), null, 'another server\'s events aren\'t taken');
    assert.equal(gate.getStatus().policies[0].matchCount, 0, 'asking counts nothing');
    assert.deepEqual(traces, [], 'asking traces nothing');
  });

  it('never takes an addressed event or the heartbeat\'s: they go on to the rules after it', () => {
    const gate = makeGate({ default: 'defer', policies: [
      HIDE_BODY,
      { name: 'wake-addressed', match: { tagsAny: ['chat:addressed'] }, behavior: 'always' },
    ] });
    const mention = ev(['chat:mention', 'chat:addressed']);
    assert.equal(gate.suppressionFor(mention), null);
    const decision = gate.evaluate(mention);
    assert.equal(decision.policyName, 'wake-addressed', 'the suppress rule doesn\'t decide it');
    assert.equal(decision.trigger, true);
    assert.equal(gate.suppressionFor(ev([], { serverId: 'heartbeat' })), null);
    const hb = makeGate({ default: 'always', policies: [{ name: 'hide-hb', match: { source: 'heartbeat' }, behavior: 'defer', suppress: S }] });
    assert.equal(hb.suppressionFor(ev([], { serverId: 'heartbeat' })), null, 'the heartbeat is never suppressed');
    assert.equal(hb.evaluate(ev([], { serverId: 'heartbeat' })).trigger, true, 'and still wakes under the default');
  });

  it('reads rules first-match: an earlier rule that matches decides the event, unless it\'s a passthrough that wouldn\'t fire', () => {
    const gate = makeGate({ default: 'always', policies: [
      { name: 'eye-on', match: { source: 'body', filter: { type: 'text', pattern: 'eye went on' } }, behavior: 'always' },
      HIDE_BODY,
    ] });
    assert.equal(gate.suppressionFor(ev([], { content: 'the eye went on' })), null, 'the earlier rule takes it');
    assert.equal(gate.suppressionFor(ev([], { content: 'the eye went off' })), 'hide-body');

    const sampled = makeGate({ default: 'always', policies: [
      { name: 'sample', match: { source: 'body' }, behavior: { passive_sample: { every: 2 } }, passthrough: true },
      HIDE_BODY,
    ] });
    assert.equal(sampled.suppressionFor(ev([])), 'hide-body', 'a passthrough that wouldn\'t fire lets the event on');
    // The sampler's count isn't moved by suppressed events, so it stays one short of firing.
    assert.equal(sampled.suppressionFor(ev([])), 'hide-body');
  });

  it('evaluate and probe pass over a suppress rule for an event suppression was asked about, and defer by it otherwise', () => {
    const gate = makeGate({ default: 'always', policies: [HIDE_BODY] });
    const asked = ev(['chat:ambient'], { suppressionAsked: true });
    assert.equal(gate.evaluate(asked).policyName, null, 'the default decides, not the suppress rule');
    assert.equal(gate.probe(asked).policyName, null);
    // Where suppression wasn't asked (no view to hide the row from), the rule's behavior, defer, applies.
    const unasked = ev(['chat:ambient']);
    assert.deepEqual([gate.evaluate(unasked).policyName, gate.evaluate(unasked).trigger], ['hide-body', false]);
    assert.equal(gate.evaluate(ev(['chat:addressed'])).policyName, null, 'an addressed event is always let by');
  });

  it('a rule edited in gate.json is read again before the next decision', () => {
    const gate = makeGate({ default: 'always', policies: [HIDE_BODY] });
    assert.equal(gate.suppressionFor(ev([])), 'hide-body');
    gate.removePolicy('hide-body');
    assert.equal(gate.suppressionFor(ev([])), null);
  });
});

describe('suppression in what the gate reports', () => {
  it('noteSuppressed counts the event as the rule\'s match and traces it', () => {
    const traces: Array<Record<string, unknown>> = [];
    const gate = makeGate({ default: 'always', policies: [HIDE_BODY] }, traces);
    traces.length = 0;
    gate.noteSuppressed('hide-body', { eventType: 'mcpl:push-event', serverId: 'body', channelId: '' });
    const status = gate.getStatus().policies[0];
    assert.equal(status.matchCount, 1);
    assert.equal(typeof status.lastMatchTimestamp, 'number');
    assert.deepEqual(traces.map((t) => t.type), ['gate:suppressed']);
    assert.equal(traces[0].policyName, 'hide-body');
  });

  it('the probe table shows a suppressed probe as the rule\'s, not waking', () => {
    const gate = makeGate({ default: 'always', policies: [
      { name: 'hide-ambient', match: { source: 'discord', tagsAny: ['chat:ambient'] }, behavior: 'defer', suppress: S },
    ] });
    const rows = gate.probeTable();
    const ambient = rows.find((r) => r.probe === 'ambient (human)')!;
    assert.deepEqual([ambient.policy, ambient.behavior, ambient.wouldWake], ['hide-ambient', 'suppress', false]);
    const dm = rows.find((r) => r.probe === 'dm (open channel)')!;
    assert.equal(dm.wouldWake, true, 'a DM is addressed, so it isn\'t suppressed');
  });

  it('the rule-order notes and the catch-all check pass over a suppress rule', () => {
    const policies: GatePolicy[] = [
      { name: 'hide-ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer', suppress: S },
      { name: 'ambient-sample', match: { tagsAny: ['chat:ambient'] }, behavior: { passive_sample: { every: 5 } } },
      { name: 'quiet', match: { scope: ['mcpl:channel-incoming'] }, behavior: 'defer' },
    ];
    assert.deepEqual(findShadowedPolicies(policies).filter((w) => w.earlier === 'hide-ambient'), []);
    assert.equal(firstCatchAll([{ name: 'hide', match: { scope: ['mcpl:push-event'] }, behavior: 'defer', suppress: S }], { lettingBy: true }), null);
    assert.equal(firstCatchAll(policies, { lettingBy: true }), 'quiet');
  });
});

describe('suppress rules with a script of the agent\'s own (suppress.script)', () => {
  const clocked = (policies: GatePolicy[], timeoutMs?: number) => {
    let t = 1_000_000;
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ default: 'always', policies }));
    const gate = new EventGate({
      configPath: CONFIG_PATH, emitTrace: () => {}, addMessage: () => '', requestInference: () => {}, getAgentNames: () => ['agent'],
      // A generous timeout unless the test is about timeouts, so a loaded machine doesn't fail a script that answers.
      now: () => t, suppressScriptTimeoutMs: timeoutMs ?? 2_000,
    });
    gates.push(gate);
    return { gate, advance: (ms: number) => { t += ms; } };
  };
  const gates: EventGate[] = [];
  afterEach(() => { for (const gate of gates.splice(0)) gate.dispose(); });
  // The scenario from the design talk, written by the agent: one eye change shown in ten minutes, per event type.
  const ONE_IN_TEN = `(event, state) => {
    const last = state[event.eventType];
    if (last && event.at - last < 600000) return true;
    state[event.eventType] = event.at;
    return false;
  }`;
  const EYE: GatePolicy = { name: 'eye', match: { source: 'body' }, behavior: 'defer', suppress: { description: 'eye flaps', script: ONE_IN_TEN } };

  it('the script decides, with state it keeps between events', () => {
    const { gate, advance } = clocked([EYE]);
    assert.equal(gate.decideSuppression(ev([])), null, 'the first is shown');
    advance(1000);
    assert.equal(gate.decideSuppression(ev([])), 'eye');
    assert.equal(gate.decideSuppression(ev([], { eventType: 'mcpl:channel-incoming' })), null, 'another type, its own memory');
    advance(600_000);
    assert.equal(gate.decideSuppression(ev([])), null, 'ten minutes on, shown again');
    assert.deepEqual(gate.suppressScriptState('eye'), { 'mcpl:push-event': 1_601_000, 'mcpl:channel-incoming': 1_001_000 });
    const status = gate.getStatus().policies[0].suppress?.scriptStatus;
    assert.deepEqual([status?.loaded, status?.runs, status?.hidden, status?.errors], [true, 4, 1, 0]);
  });

  it('suppressionFor runs the script on a copy of its state, which it drops', () => {
    const { gate } = clocked([EYE]);
    assert.equal(gate.suppressionFor(ev([])), null);
    assert.equal(gate.suppressionFor(ev([])), null, 'asking twice changed nothing');
    gate.probeTable();
    assert.deepEqual(gate.suppressScriptState('eye'), {});
    assert.equal(gate.decideSuppression(ev([])), null, 'the first real arrival is still the one shown');
    assert.equal(gate.suppressionFor(ev([])), 'eye');
  });

  it('a script that throws, runs too long, or keeps an unkeepable state shows the event, and gate_status says so', () => {
    const throws = clocked([{ ...EYE, suppress: { description: 'x', script: '(event) => { throw new Error("boom"); }' } }]);
    assert.equal(throws.gate.decideSuppression(ev([])), null);
    assert.match(String(throws.gate.getStatus().policies[0].suppress?.scriptStatus?.lastError), /boom/);
    const loops = clocked([{ ...EYE, suppress: { description: 'x', script: '() => { for (;;) {} }' } }], 40);
    assert.equal(loops.gate.decideSuppression(ev([])), null);
    const status = loops.gate.getStatus().policies[0].suppress?.scriptStatus;
    assert.equal(status?.timeouts, 1);
    assert.equal(status?.loaded, true, 'loaded again on a fresh worker');
    const huge = clocked([{ ...EYE, suppress: { description: 'x', script: '(e, state) => { state.blob = "x".repeat(100000); return true; }' } }]);
    assert.equal(huge.gate.decideSuppression(ev([])), null);
    assert.match(String(huge.gate.getStatus().policies[0].suppress?.scriptStatus?.lastError), /over the 65,536 bytes/);
    assert.deepEqual(huge.gate.suppressScriptState('eye'), {}, 'the state stays as it was');
  });

  it('only true hides: a truthy answer of another kind shows the event', () => {
    const { gate } = clocked([{ ...EYE, suppress: { description: 'x', script: '() => "yes"' } }]);
    assert.equal(gate.decideSuppression(ev([])), null);
  });

  it('a looping script stops only itself: the next rule\'s script still runs, and after three timeouts in a row it is set aside', () => {
    const { gate } = clocked([
      { name: 'loops', match: { source: 'body' }, behavior: 'defer', suppress: { description: 'x', script: '() => { for (;;) {} }' } },
      { name: 'hides', match: { source: 'body' }, behavior: 'defer', suppress: { description: 'y', script: '() => true' } },
    ], 40);
    for (let i = 0; i < 3; i++) assert.equal(gate.decideSuppression(ev([])), 'hides', `event ${i + 1}: the next rule decides`);
    const [loops, hides] = gate.getStatus().policies.map((p) => p.suppress?.scriptStatus);
    assert.equal(loops?.timeouts, 3);
    assert.match(String(loops?.disabled), /3 times in a row, so it isn't run again until its rule changes/);
    assert.equal(hides?.loaded, true, 'loaded again on each fresh worker');
    const started = Date.now();
    assert.equal(gate.decideSuppression(ev([])), 'hides');
    assert.ok(Date.now() - started < 40, 'a script set aside costs no timeout');
  });

  it('the probe table lets a probe on past a script that says show, and gate_status reports a script before any event', () => {
    const { gate } = clocked([
      { name: 'quiet', match: { source: 'discord', tagsAny: ['chat:ambient'] }, behavior: 'defer', suppress: { description: 'x', script: '() => false' } },
      { name: 'ambient-wakes', match: { tagsAny: ['chat:ambient'] }, behavior: 'always' },
    ]);
    assert.equal(gate.getStatus().policies[0].suppress?.scriptStatus?.loaded, true);
    const ambient = gate.probeTable().find((r) => r.probe === 'ambient (human)')!;
    assert.deepEqual([ambient.policy, ambient.wouldWake], ['ambient-wakes', true]);
  });

  it('a script that is not a function is caught before it is saved, and shows events if it reaches gate.json', () => {
    const { gate } = clocked([{ ...EYE, suppress: { description: 'x', script: '42' } }]);
    assert.match(String(gate.checkSuppressScript('42')), /the script is number, not a function/);
    assert.equal(gate.checkSuppressScript('(event, state) => false'), null);
    assert.equal(gate.decideSuppression(ev([])), null);
    assert.match(String(gate.getStatus().policies[0].suppress?.scriptStatus?.lastError), /doesn't compile/);
  });

  it('a script that says show lets the event on to the rules after it', () => {
    const { gate } = clocked([
      { ...EYE, suppress: { description: 'only the off ones', script: '(event) => event.text.includes("off")' } },
      { name: 'all-body', match: { source: 'body' }, behavior: 'defer', suppress: { description: 'the rest of the body' } },
    ]);
    assert.equal(gate.decideSuppression(ev([], { content: 'eye off' })), 'eye');
    assert.equal(gate.decideSuppression(ev([], { content: 'eye on' })), 'all-body');
  });

  it('an addressed event is never shown to the script', () => {
    const { gate } = clocked([{ ...EYE, suppress: { description: 'x', script: '(e, state) => { state.seen = (state.seen ?? 0) + 1; return true; }' } }]);
    assert.equal(gate.decideSuppression(ev(['chat:addressed'])), null);
    assert.deepEqual(gate.suppressScriptState('eye'), {});
  });

  it('the state survives a restart, and starts afresh when the script changes or the rule is removed', async () => {
    const first = clocked([EYE]);
    first.gate.decideSuppression(ev([]));
    first.gate.dispose();
    const second = clocked([EYE]);
    assert.deepEqual(second.gate.suppressScriptState('eye'), { 'mcpl:push-event': 1_000_000 }, 'read back from suppress-state.json');
    assert.equal(second.gate.decideSuppression(ev([])), 'eye');
    second.gate.addPolicy({ ...EYE, suppress: { description: 'eye flaps', script: ONE_IN_TEN.replace('600000', '300000') } });
    assert.deepEqual(second.gate.suppressScriptState('eye'), {}, 'a changed script starts afresh');
    second.gate.decideSuppression(ev([]));
    second.gate.addPolicy({ ...EYE, suppress: { description: 'a new description', script: ONE_IN_TEN.replace('600000', '300000') } });
    assert.deepEqual(second.gate.suppressScriptState('eye'), { 'mcpl:push-event': 1_000_000 }, 'a new description keeps it');
    second.gate.removePolicy('eye');
    second.gate.addPolicy({ ...EYE, suppress: { description: 'eye flaps', script: ONE_IN_TEN.replace('600000', '300000') } });
    assert.deepEqual(second.gate.suppressScriptState('eye'), {}, 'a rule removed and added again starts afresh');
  });
});
