/**
 * MCPL RFC-007 tool lifecycle — the emitter's pairing (started at dispatch →
 * exactly one terminal, to exactly the connection epochs the opening went
 * to, unless their grant no longer covers the call), host-unique call ids,
 * and the grant computation for the two toolLifecycle paths.
 *
 * Tests named "review #N" are regressions for the Greptile review of
 * agent-framework PR #199.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityGrant, computeGrant } from '../src/mcpl/capability-grant.js';
import {
  SCRIPT_PARENT_META_KEY,
  ToolLifecycleEmitter,
  openingFor,
  parseToolObserveParams,
  type ToolCallDescriptor,
  type ToolLifecycleConfig,
  type ToolLifecycleParams,
  type ToolObserveRule,
} from '../src/mcpl/tool-lifecycle.js';
import type { ToolClass } from '../src/mcpl/tool-classes.js';
import type { McplCapabilities } from '../src/mcpl/types.js';

const OBSERVE = 'toolLifecycle.observe';
const INPUTS = 'toolLifecycle.inputs';

function observer(id: string, paths: string[], filter: ToolObserveRule[] | null = null) {
  const sent: ToolLifecycleParams[] = [];
  return {
    id,
    grant: new CapabilityGrant(new Set(paths), []),
    toolObserveFilter: filter,
    transportEpoch: 0,
    sendToolLifecycle: (p: ToolLifecycleParams) => { sent.push(p); },
    sent,
  };
}

function rules(raw: unknown): ToolObserveRule[] | null {
  const parsed = parseToolObserveParams({ rules: raw });
  assert.ok(parsed.ok, `rules should parse: ${JSON.stringify(raw)}`);
  return parsed.rules;
}

const DEFAULT_INPUTS: ToolLifecycleConfig = { observe: {}, inputs: { classes: 'default' } };

function harness(opts: {
  observers: ReturnType<typeof observer>[];
  config?: Record<string, ToolLifecycleConfig>;
  classes?: Record<string, ToolClass[]>;
}) {
  let clock = 1000;
  const emitter = new ToolLifecycleEmitter({
    observers: () => opts.observers,
    configFor: (id) => opts.config?.[id],
    describe: (tool) => {
      const sep = tool.indexOf('--');
      const cls = opts.classes?.[tool] ?? ['shell'];
      return sep > 0
        ? { class: cls, serverId: tool.slice(0, sep), serverTool: tool.slice(sep + 2) }
        : { class: cls };
    },
  }, () => clock);
  return { emitter, tick: (ms: number) => { clock += ms; } };
}

/**
 * What the framework does at its dispatch point: register, run dispatch
 * (whose refusal sites may call refuse()), then open.
 */
function dispatch(
  emitter: ToolLifecycleEmitter,
  agent: string,
  inferenceId: string,
  call: { id: string; name: string; input: unknown },
  refusedByHost = false,
): void {
  emitter.register(agent, inferenceId, call);
  if (refusedByHost) emitter.refuse(agent, call.id);
  emitter.open(agent, call.id);
}

/** An Anthropic-shaped, provider-unique tool_use id. */
const TOOLU = (n: number) => `toolu_01${String(n).padStart(22, '0')}`;

describe('ToolLifecycleEmitter', () => {
  test('started at dispatch, completed on result — isError from the result, never its content', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter, tick } = harness({ observers: [o] });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(1), name: 'prov--run', input: { cmd: 'make' } });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started']);
    tick(40);
    emitter.onResult('scout', TOOLU(1), { success: true, isError: true, data: 'SECRET-OUTPUT' } as never);
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'completed']);
    assert.equal(o.sent[1].isError, true);
    assert.equal(o.sent[1].durationMs, 40);
    assert.equal(o.sent[0].toolCallId, o.sent[1].toolCallId);
    assert.ok(!JSON.stringify(o.sent).includes('SECRET-OUTPUT'), 'vector 26: no outcome leakage');
    for (const p of o.sent) {
      for (const k of ['result', 'output', 'content']) assert.equal(k in p, false, `vector 27: no ${k}`);
    }
    assert.equal(emitter.openCount, 0);
  });

  test('review #6 — an error RESULT is completed+isError; only a marked dispatch failure is failed', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(2), name: 'utils', input: {} });
    emitter.onResult('scout', TOOLU(2), { success: false, isError: true });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(3), name: 'prov--run', input: {} });
    emitter.markDispatchFailure('scout', TOOLU(3));
    emitter.onResult('scout', TOOLU(3), { success: false, isError: true });
    const terminals = o.sent.filter((p) => p.phase !== 'started');
    assert.deepEqual(terminals.map((p) => `${p.tool}:${p.phase}:${p.isError}`), [
      'utils:completed:true',
      'prov--run:failed:undefined',
    ]);
  });

  test('review #4 — a call the host refuses before executing (provider gone, policy) produces no events', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {}, input: true }]));
    const { emitter } = harness({ observers: [o], config: { obs: DEFAULT_INPUTS } });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(4), name: 'gone--click', input: { x: 1 } }, true);
    emitter.onResult('scout', TOOLU(4), { success: false, isError: true });
    assert.equal(o.sent.length, 0);
    assert.equal(emitter.openCount, 0);
  });

  test('re-review #1 — a host-tool refusal (conversation-bound channel guard) produces no events', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o], classes: { channel_open: ['comms'] } });
    dispatch(emitter, 'fork-1', 'inf_1', { id: TOOLU(40), name: 'channel_open', input: { channelId: 'x' } }, true);
    emitter.onResult('fork-1', TOOLU(40), { success: false, isError: true });
    assert.equal(o.sent.length, 0, 'never reported as started or completed');
    // refuse() after the opening went out changes nothing: refusal is only
    // meaningful before execution, and the call is then paired normally.
    dispatch(emitter, 'scout', 'inf_2', { id: TOOLU(41), name: 'prov--a', input: {} });
    emitter.refuse('scout', TOOLU(41));
    emitter.onResult('scout', TOOLU(41), { success: true });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'completed']);
  });

  test('review #2 — two agents with the same short call id never cross', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    dispatch(emitter, 'alice', 'inf_a', { id: 'call_0', name: 'prov--a', input: {} });
    dispatch(emitter, 'bob', 'inf_b', { id: 'call_0', name: 'prov--b', input: {} });
    emitter.markDispatchFailure('bob', 'call_0');
    emitter.onResult('bob', 'call_0', { success: false, isError: true });
    emitter.onResult('alice', 'call_0', { success: true });
    const byTool = (tool: string) => o.sent.filter((p) => p.tool === tool).map((p) => p.phase);
    assert.deepEqual(byTool('prov--a'), ['started', 'completed']);
    assert.deepEqual(byTool('prov--b'), ['started', 'failed']);
    const ids = new Set(o.sent.filter((p) => p.phase === 'started').map((p) => p.toolCallId));
    assert.equal(ids.size, 2, 'distinct host ids for the two call_0s');
  });

  test('review #5 — a stream end aborts only its own inference ids, never a successor\'s calls', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    dispatch(emitter, 'scout', 'inf_old', { id: TOOLU(5), name: 'prov--a', input: {} });
    dispatch(emitter, 'scout', 'inf_new', { id: TOOLU(6), name: 'prov--b', input: {} });
    dispatch(emitter, 'other', 'inf_x', { id: TOOLU(7), name: 'prov--c', input: {} });
    emitter.abortOpen('scout', ['inf_old']);
    assert.deepEqual(o.sent.filter((p) => p.phase === 'aborted').map((p) => p.tool), ['prov--a']);
    emitter.onResult('scout', TOOLU(6), { success: true });
    assert.deepEqual(o.sent.filter((p) => p.tool === 'prov--b').map((p) => p.phase), ['started', 'completed']);
    emitter.onResult('scout', TOOLU(5), { success: true });
    assert.equal(o.sent.filter((p) => p.tool === 'prov--a').length, 2, 'no second terminal after abort');
    assert.equal(emitter.openCount, 1, "the other agent's call stays open");
  });

  test('re-review #2 — durationMs counts from before dispatch, so synchronous work inside dispatch is included', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter, tick } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: TOOLU(42), name: 'sleep', input: {} });
    tick(25); // a synchronous tool doing its work inside dispatch
    emitter.open('scout', TOOLU(42));
    tick(5); // the queued result waiting to be processed
    emitter.onResult('scout', TOOLU(42), { success: true });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'completed']);
    assert.equal(o.sent[1].durationMs, 30);
  });

  test('parallel calls pair by toolCallId', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(8), name: 'prov--a', input: {} });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(9), name: 'prov--b', input: {} });
    emitter.onResult('scout', TOOLU(9), { success: true });
    emitter.onResult('scout', TOOLU(8), { success: true });
    assert.deepEqual(o.sent.map((p) => `${p.toolCallId}:${p.phase}`), [
      `${TOOLU(8)}:started`, `${TOOLU(9)}:started`, `${TOOLU(9)}:completed`, `${TOOLU(8)}:completed`,
    ]);
  });

  test('observe revoked mid-call → no terminal; inputs revoked mid-call → terminal still sent (§4.5)', () => {
    const a = observer('a', [OBSERVE]);
    const b = observer('b', [OBSERVE, INPUTS]);
    const { emitter } = harness({ observers: [a, b] });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(10), name: 'prov--a', input: {} });
    a.grant = a.grant.without(OBSERVE);
    b.grant = b.grant.without(INPUTS);
    emitter.onResult('scout', TOOLU(10), { success: true });
    assert.deepEqual(a.sent.map((p) => p.phase), ['started']);
    assert.deepEqual(b.sent.map((p) => p.phase), ['started', 'completed']);
  });

  test('review #7 — a reconnected observer never gets a terminal for an opening its old transport saw', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(11), name: 'prov--a', input: {} });
    o.transportEpoch++; // reconnect; grant re-established
    emitter.onResult('scout', TOOLU(11), { success: true });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started']);
  });

  test('a filter change mid-call does not suppress the terminal (§6.5)', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(12), name: 'prov--a', input: {} });
    o.toolObserveFilter = [];
    emitter.onResult('scout', TOOLU(12), { success: true });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'completed']);
  });

  test('terminals go only where the opening went', () => {
    const early = observer('early', [OBSERVE]);
    const late = observer('late', []);
    const { emitter } = harness({ observers: [early, late] });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(13), name: 'prov--a', input: {} });
    late.grant = new CapabilityGrant(new Set([OBSERVE]), []);
    emitter.onResult('scout', TOOLU(13), { success: true });
    assert.deepEqual(early.sent.map((p) => p.phase), ['started', 'completed']);
    assert.equal(late.sent.length, 0, 'granted mid-call: no terminal without an opening');
  });

  test('review #9 — ids: provider-unique toolu ids kept; everything else and any repeat minted (§3)', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    const run = (id: string) => {
      dispatch(emitter, 'scout', 'inf', { id, name: 'prov--a', input: {} });
      emitter.onResult('scout', id, { success: true });
    };
    run('call_0');
    run('call_0');
    run(TOOLU(14));
    run(TOOLU(14));
    run('call_abcdefghijklmnopqrstuvwxyz0123'); // long, but not a provider-guaranteed format
    const opened = o.sent.filter((p) => p.phase === 'started').map((p) => p.toolCallId);
    assert.equal(new Set(opened).size, 5, `ids must be unique: ${opened.join(', ')}`);
    assert.ok(opened[0].startsWith('call_0~'));
    assert.equal(opened[2], TOOLU(14), 'a provider-unique id is used as is');
    assert.notEqual(opened[3], TOOLU(14), 'its repeat is minted over');
    assert.ok(opened[4].startsWith('call_abcdefghijklmnopqrstuvwxyz0123~'), 'unknown formats are minted');
  });

  test('inert while nothing observes: register tracks nothing', () => {
    const o = observer('obs', []);
    const { emitter } = harness({ observers: [o] });
    dispatch(emitter, 'scout', 'inf', { id: TOOLU(15), name: 'prov--a', input: {} });
    assert.equal(emitter.openCount, 0);
  });

  test('the filter and the grant compose end to end', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([
      { match: { serverTool: 'click' }, input: ['x', 'y'] },
      { match: { class: 'comms' }, report: false },
      { match: {} },
    ]));
    const { emitter } = harness({
      observers: [o],
      config: { obs: DEFAULT_INPUTS },
      classes: { 'computer--click': ['computer'], 'chat--send': ['comms'], 'blender--execute': [] },
    });
    const go = (id: string, name: string, input: unknown) => {
      dispatch(emitter, 'scout', 'inf', { id, name, input });
      emitter.onResult('scout', id, { success: true });
    };
    go(TOOLU(20), 'computer--click', { x: 1, y: 2, button: 'left' });
    go(TOOLU(21), 'chat--send', { text: 'private words' });
    go(TOOLU(22), 'blender--execute', { code: 'import bpy' });
    const started = o.sent.filter((p) => p.phase === 'started');
    assert.deepEqual(started.map((p) => p.tool), ['computer--click', 'blender--execute']);
    assert.deepEqual(started[0].input, { x: 1, y: 2 });
    assert.equal(started[1].input, undefined);
    assert.ok(!JSON.stringify(o.sent).includes('private words'));
    assert.ok(!JSON.stringify(o.sent).includes('import bpy'));
  });
});

// ── Calls made by a code_execution script (issue #235 F4) ───────────────────

describe('ToolLifecycleEmitter: script-inner calls', () => {
  /**
   * What the framework does: the code_execution call is dispatched like any
   * model call, and while it is (between register and open) it reads the
   * origin its script's calls inherit.
   */
  function runScript(emitter: ToolLifecycleEmitter, agent: string, inferenceId: string, id: string) {
    emitter.register(agent, inferenceId, { id, name: 'code_execution', input: { code: '...' } });
    const origin = emitter.scriptOrigin(agent, id);
    emitter.open(agent, id);
    return origin;
  }
  function scriptCall(
    emitter: ToolLifecycleEmitter,
    agent: string,
    origin: ReturnType<ToolLifecycleEmitter['scriptOrigin']>,
    call: { id: string; name: string; input: unknown },
    refusedByHost = false,
  ): void {
    emitter.registerScriptCall(agent, origin!, call);
    if (refusedByHost) emitter.refuse(agent, call.id);
    emitter.open(agent, call.id);
  }

  test('reported under the inner tool, the parent inference, and the parent call in _meta', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter, tick } = harness({ observers: [o], classes: { code_execution: ['shell'], 'chat--send': ['comms'] } });
    const origin = runScript(emitter, 'scout', 'inf_1', TOOLU(50));
    assert.deepEqual(origin, { inferenceId: 'inf_1', parentToolCallId: TOOLU(50) });
    scriptCall(emitter, 'scout', origin, { id: 'pytc-1', name: 'chat--send', input: { text: 'hi' } });
    tick(120);
    emitter.onResult('scout', 'pytc-1', { success: true });
    emitter.onResult('scout', TOOLU(50), { success: true });

    const inner = o.sent.filter((p) => p.tool === 'chat--send');
    assert.deepEqual(inner.map((p) => p.phase), ['started', 'completed']);
    for (const p of inner) {
      assert.deepEqual(p.class, ['comms']);
      assert.equal(p.serverTool, 'send');
      assert.equal(p.inferenceId, 'inf_1');
      assert.deepEqual(p._meta, { [SCRIPT_PARENT_META_KEY]: TOOLU(50) });
    }
    assert.equal(inner[0].toolCallId, inner[1].toolCallId);
    assert.notEqual(inner[0].toolCallId, TOOLU(50));
    assert.equal(inner[1].durationMs, 120);
    // The model's own call carries no attribution.
    for (const p of o.sent.filter((p) => p.tool === 'code_execution')) assert.equal('_meta' in p, false);
  });

  test("the inner tool's own class decides filters and the inputs class exclusion", () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: { class: 'comms' }, input: true }]));
    const { emitter } = harness({
      observers: [o],
      config: { obs: { observe: {}, inputs: { tools: ['*'] } } },
      classes: { code_execution: ['shell'], 'chat--send': ['comms'], 'computer--click': ['computer'] },
    });
    const origin = runScript(emitter, 'scout', 'inf_1', TOOLU(51));
    scriptCall(emitter, 'scout', origin, { id: 'pytc-2', name: 'computer--click', input: { x: 1 } });
    scriptCall(emitter, 'scout', origin, { id: 'pytc-3', name: 'chat--send', input: { text: 'private words' } });
    emitter.onResult('scout', 'pytc-2', { success: true });
    emitter.onResult('scout', 'pytc-3', { success: true });
    assert.deepEqual(o.sent.map((p) => `${p.tool}:${p.phase}`), ['chat--send:started', 'chat--send:completed']);
    assert.equal(o.sent[0].inputWithheld, true, 'comms never carries arguments, from a script either');
    assert.ok(!JSON.stringify(o.sent).includes('private words'));
  });

  test('an error result is completed+isError; a refusal produces nothing; a lost result is failed', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    const origin = runScript(emitter, 'scout', 'inf_1', TOOLU(52));
    scriptCall(emitter, 'scout', origin, { id: 'pytc-4', name: 'prov--run', input: {} });
    emitter.onResult('scout', 'pytc-4', { success: false, isError: true });
    scriptCall(emitter, 'scout', origin, { id: 'pytc-5', name: 'gone--run', input: {} }, true);
    emitter.onResult('scout', 'pytc-5', { success: false, isError: true });
    scriptCall(emitter, 'scout', origin, { id: 'pytc-6', name: 'prov--hang', input: {} });
    emitter.markDispatchFailure('scout', 'pytc-6'); // the host gave up waiting
    emitter.onResult('scout', 'pytc-6', undefined);
    const inner = o.sent.filter((p) => p.tool !== 'code_execution');
    assert.deepEqual(inner.map((p) => `${p.tool}:${p.phase}:${p.isError}`), [
      'prov--run:started:undefined', 'prov--run:completed:true',
      'prov--hang:started:undefined', 'prov--hang:failed:undefined',
    ]);
  });

  test("a stream's end does not abort a script's calls: an orphaned call ends with its own result", () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    const origin = runScript(emitter, 'scout', 'inf_1', TOOLU(53));
    scriptCall(emitter, 'scout', origin, { id: 'pytc-7', name: 'prov--slow', input: {} });
    dispatch(emitter, 'scout', 'inf_1', { id: TOOLU(54), name: 'prov--model', input: {} });
    emitter.abortOpen('scout', ['inf_1']); // turn over; the script and the code_execution call are gone
    emitter.onResult('scout', 'pytc-7', { success: true });
    const phases = (tool: string) => o.sent.filter((p) => p.tool === tool).map((p) => p.phase);
    assert.deepEqual(phases('code_execution'), ['started', 'aborted']);
    assert.deepEqual(phases('prov--model'), ['started', 'aborted'], 'model calls are aborted as before');
    assert.deepEqual(phases('prov--slow'), ['started', 'completed']);
    assert.equal(emitter.openCount, 0);
  });

  test('a parent nothing observed: its inner calls keep its inference, without a parent id', () => {
    const o = observer('obs', []);
    const { emitter } = harness({ observers: [o] });
    const origin = runScript(emitter, 'scout', 'inf_9', TOOLU(55));
    assert.deepEqual(origin, { inferenceId: 'inf_9' });
    o.grant = new CapabilityGrant(new Set([OBSERVE]), []); // granted while the script runs
    scriptCall(emitter, 'scout', origin, { id: 'pytc-8', name: 'prov--a', input: {} });
    emitter.onResult('scout', 'pytc-8', { success: true });
    assert.deepEqual(o.sent.map((p) => `${p.tool}:${p.phase}:${p.inferenceId}`), [
      'prov--a:started:inf_9', 'prov--a:completed:inf_9',
    ]);
    assert.equal('_meta' in o.sent[0], false);
    assert.equal(emitter.scriptOrigin('scout', 'not-dispatching'), undefined, 'only the call being dispatched');
  });
});

// ── Grant computation and config robustness ─────────────────────────────────

describe('toolLifecycle grant', () => {
  const caps = (o: Record<string, unknown>): McplCapabilities => ({ version: '0.5', ...o }) as unknown as McplCapabilities;
  const quiet = <T>(fn: () => T): T => {
    const orig = console.error;
    console.error = () => {};
    try { return fn(); } finally { console.error = orig; }
  };
  const anyCall: ToolCallDescriptor = {
    toolCallId: TOOLU(30), inferenceId: 'inf', conversationId: 'scout', tool: 'prov--a',
    class: ['shell'], serverId: 'prov', serverTool: 'a', input: {},
  };

  test('vector 49 — advertised but not granted by default', () => {
    const g = quiet(() => computeGrant(caps({ toolLifecycle: true }), {}));
    assert.equal(g.has(OBSERVE), false);
    assert.equal(g.has(INPUTS), false);
    assert.ok(g.deniedPaths.includes(OBSERVE) && g.deniedPaths.includes(INPUTS));
  });

  test('vector 50 — a policy object is the explicit grant of the path it states', () => {
    const g1 = quiet(() => computeGrant(caps({ toolLifecycle: true }), { toolLifecycle: { observe: {} } }));
    assert.equal(g1.has(OBSERVE), true);
    assert.equal(g1.has(INPUTS), false);
    const g2 = quiet(() => computeGrant(caps({ toolLifecycle: true }), { toolLifecycle: { observe: {}, inputs: { classes: 'default' } } }));
    assert.equal(g2.has(INPUTS), true);
  });

  test('review #1 — `observe: false` (or null, or a string) grants nothing', () => {
    for (const value of [false, null, 'yes', 0]) {
      const g = quiet(() => computeGrant(caps({ toolLifecycle: true }), { toolLifecycle: { observe: value } } as never));
      assert.equal(g.has(OBSERVE), false, JSON.stringify(value));
    }
  });

  test('review #1 — a non-object narrowing under an explicit grant admits nothing', () => {
    const o = observer('obs', [OBSERVE]);
    for (const observe of [false, null, 'x', { tools: 'prov--*' }, { conversations: 7 }, { classes: 'shell' }]) {
      assert.equal(openingFor(o, { observe } as never, anyCall, 'started'), null, JSON.stringify(observe));
    }
    assert.ok(openingFor(o, { observe: { tools: ['prov--*'] } }, anyCall, 'started'));
    assert.ok(openingFor(o, undefined, anyCall, 'started'), 'absent narrowing = the grant is enough');
  });

  test('enabledCapabilities grants explicitly too; never beyond the advertisement', () => {
    const g = quiet(() => computeGrant(caps({ toolLifecycle: { observe: true } }), { enabledCapabilities: ['toolLifecycle.*'] }));
    assert.equal(g.has(OBSERVE), true);
    assert.equal(g.has(INPUTS), false, 'inputs was not advertised');
  });

  test('review #8 — an unknown params member is rejected, not read as "no rules"', () => {
    const r = parseToolObserveParams({ ruless: [{ match: {} }] });
    assert.equal(r.ok, false);
    assert.equal(parseToolObserveParams({ rules: [], _meta: { trace: 'x' } }).ok, true, "MCP's _meta is allowed");
  });
});
