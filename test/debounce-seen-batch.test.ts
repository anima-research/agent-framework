import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventGate, type WritePlacement } from '../src/gate/event-gate.js';
import type { GateDecision, GateEventInfo } from '../src/gate/types.js';

type Check = (agent: string, after: WritePlacement) => boolean;
function harness(check?: Check, agents = ['one'], judge?: ConstructorParameters<typeof EventGate>[0]['judge']) {
  const dir = mkdtempSync(join(tmpdir(), 'debounce-read-'));
  const writes: Array<{ content: unknown; forAgent?: string }> = [];
  const wakes: Array<{ agent: string; provenance: unknown }> = [];
  const traces: Array<{ type: string; eventCount?: number }> = [];
  const opts = {
    configPath: join(dir, 'gate.json'),
    initialConfig: { policies: [...(judge ? [{ name: 'judged', match: { scope: ['judge:event'] }, behavior: { judge: { debounceMs: 60_000 } } }] : []), { name: 'batch', match: {}, behavior: { debounce: 60_000 } }], default: 'always' as const },
    emitTrace: (event: { type: string; eventCount?: number }) => { traces.push(event); },
    addMessage: (_p: string, content: unknown, _m?: unknown, forAgent?: string) => { writes.push({ content, forAgent }); },
    requestInference: (agent: string, _r: string, _s: string, provenance?: unknown) => { wakes.push({ agent, provenance }); },
    getAgentNames: () => agents,
    isWriteDone: check,
    judge,
  };
  const gate = new EventGate(opts);
  const state = gate as unknown as { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>; fireDebounce(name: string): void };
  const evaluate = gate.evaluate.bind(gate) as (info: GateEventInfo, after?: WritePlacement) => GateDecision;
  return {
    gate, wakes, writes, traces,
    channel: (content: string, after?: WritePlacement, tags = ['chat:addressed']) => evaluate({
      eventType: 'mcpl:channel-incoming', content, serverId: 'chat', channelId: 'room', tags,
    }, after),
    add: (content: string, after?: WritePlacement, channel?: string) => evaluate({
      eventType: 'clock:reminder', content, serverId: 'clock', channelId: channel ?? '',
      metadata: channel ? { authorId: content } : undefined,
    }, after),
    fire: () => { for (const [name, s] of state.debounceTimers) { clearTimeout(s.timer); state.fireDebounce(name); } },
    close: () => { gate.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('debounce delivery read checks', () => {
  it('checks each agent separately and derives each remainder and provenance separately', () => {
    const f = harness((agent, p) => p.agent === agent, ['one', 'two']);
    try {
      f.add('first', { agent: 'one', messageId: 'a' }, 'room-a');
      f.add('second', { agent: 'two', messageId: 'b' }, 'room-b');
      f.fire();
      assert.deepEqual(f.wakes.map((w) => [w.agent, (w.provenance as { channelId: string }).channelId]), [['one', 'room-b'], ['two', 'room-a']]);
      assert.equal(f.writes.length, 2);
      for (const w of f.writes) {
        const text = JSON.stringify(w.content);
        assert.ok(text.includes(w.forAgent === 'one' ? 'second' : 'first'));
        assert.ok(!text.includes(w.forAgent === 'one' ? 'first' : 'second'));
      }
    } finally { f.close(); }
  });

  it('does not wake a fully satisfied recipient while retaining the other recipient', () => {
    const f = harness((agent) => agent === 'one', ['one', 'two']);
    try {
      f.add('event', { agent: 'one', messageId: 'a' });
      f.fire();
      assert.deepEqual(f.wakes.map((w) => w.agent), ['two']);
    } finally { f.close(); }
  });

  it('rechecks only after inference ends, using the placement filled after admission', async () => {
    let answered = false;
    let checks = 0;
    const f = harness((_agent, p) => { checks++; return answered && p.messageId === 'stored'; });
    try {
      const placement: WritePlacement = {};
      f.gate.onInferenceStarted('one');
      f.add('event', placement);
      f.fire();
      assert.equal(checks, 0, 'buffering is not evidence of reading');
      placement.messageId = 'stored';
      answered = true;
      f.gate.onInferenceEnded('one');
      await tick();
      assert.equal(checks, 1);
      assert.deepEqual(f.wakes, []);
      assert.deepEqual(f.writes, []);
    } finally { f.close(); }
  });

  it('a final-publication fence leaves judge timing and inference status unchanged', async () => {
    let judged = 0;
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    const f = harness(() => true, ['one'], async () => { judged++; return { reply: true, reason: 'needed' }; });
    try {
      f.gate.onInferenceStarted('one');
      f.gate.evaluate({ eventType: 'judge:event', content: 'judge this', serverId: '', channelId: '' }, { agent: 'one', messageId: 'judged' });
      f.fire();
      assert.equal(judged, 0);
      f.gate.onInferenceEnded('one', publication);
      assert.deepEqual(f.gate.inferenceDiagnostics().inferring, []);
      await tick();
      await tick();
      assert.equal(judged, 1, 'the judge did not wait for publication');
      assert.equal(f.wakes.length, 1, 'nor did its verdict');
    } finally { release(); await tick(); f.close(); }
  });

  it('the cap evicts placements with their events and never resurrects them', async () => {
    const checked: string[] = [];
    const f = harness((_agent, p) => { checked.push(p.messageId!); return p.messageId !== '100'; });
    try {
      f.gate.onInferenceStarted('one');
      for (let i = 0; i <= 100; i++) f.add(`event-${i}`, { messageId: String(i) });
      f.fire();
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 100);
      assert.equal(f.gate.inferenceDiagnostics().droppedBufferedEvents, 1);
      f.gate.onInferenceEnded('one');
      await tick();
      assert.equal(checked.length, 100);
      assert.ok(!checked.includes('0'));
      assert.equal(f.wakes.length, 1);
      assert.equal(f.writes.length, 1);
      const text = JSON.stringify(f.writes[0]);
      assert.ok(text.includes('event-100'));
      assert.ok(!text.includes('event-99'));
      f.gate.onInferenceEnded('one');
      await tick();
      assert.equal(f.wakes.length, 1);
    } finally { f.close(); }
  });

  it('a check that throws keeps every event and logs the fault once per throttle window', () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args); };
    const f = harness(() => { throw new Error('store unavailable'); });
    try {
      f.add('first', { messageId: 'a' });
      f.add('second', { messageId: 'b' });
      f.fire();
      assert.equal(f.wakes.length, 1);
      assert.ok(JSON.stringify(f.writes).includes('first'));
      assert.ok(JSON.stringify(f.writes).includes('second'));
      assert.equal(errors.length, 1);
      assert.ok(JSON.stringify(errors).includes('store unavailable'));
    } finally { console.error = original; f.close(); }
  });

  it('a multi-recipient remainder writes one shared-slot line, not a duplicate per resident', () => {
    const f = harness((agent) => agent === 'one', ['one', 'two', 'three']);
    try {
      f.add('event', { agent: 'one', messageId: 'a' });
      f.fire();
      assert.deepEqual(f.wakes.map((w) => w.agent), ['two', 'three']);
      assert.equal(f.writes.length, 1, 'ordinary residents read the same message slot');
      assert.equal(f.writes[0].forAgent, 'two', 'write via an unsatisfied resident');
    } finally { f.close(); }
  });

  it('persistent check faults log again after the scheduler-style minute throttle', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const f = harness(() => { throw new Error('store unavailable'); });
    try {
      for (let i = 0; i < 2; i++) { f.add('event', {}); f.fire(); }
      assert.equal(errors.length, 1);
      t.mock.timers.tick(59_999);
      f.add('event', {}); f.fire();
      assert.equal(errors.length, 1);
      t.mock.timers.tick(1);
      f.add('event', {}); f.fire();
      assert.equal(errors.length, 2);
      assert.equal(f.wakes.length, 4);
    } finally { f.close(); }
  });

  it('reports only the delivered remainder in the unchanged debounce trace shape', () => {
    const f = harness((_agent, p) => p.messageId === 'seen');
    try {
      f.add('seen', { messageId: 'seen' }); f.fire();
      assert.equal(f.traces.filter((e) => e.type === 'gate:debounce-delivered').length, 0);
      f.add('seen', { messageId: 'seen' });
      f.add('unseen', { messageId: 'unseen' }); f.fire();
      assert.deepEqual(f.traces.filter((e) => e.type === 'gate:debounce-delivered').map((e) => e.eventCount), [1]);
    } finally { f.close(); }
  });

  it('without either optional hook the existing shared line and wakes are unchanged', () => {
    const absent = harness(undefined, ['one', 'two']);
    const noPlacement = harness(() => { throw new Error('must not check an unknown placement'); }, ['one', 'two']);
    try {
      absent.add('event', { messageId: 'a' });
      noPlacement.add('event');
      absent.fire();
      noPlacement.fire();
      assert.deepEqual(absent.writes, noPlacement.writes);
      assert.deepEqual(absent.wakes, noPlacement.wakes);
      assert.deepEqual(absent.writes, [{ content: [{ type: 'text', text: '[Gate: 1 event matched]\n\n- [batch] (clock:reminder): event' }], forAgent: undefined }]);
      assert.deepEqual(absent.wakes.map((w) => w.agent), ['one', 'two']);
    } finally { absent.close(); noPlacement.close(); }
  });
});


describe('debounce final-publication fences', () => {
  it('retains more than the inference cap without evicting any unseen event', async () => {
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    const checked: string[] = [];
    const f = harness((_agent, p) => { checked.push(p.messageId!); return false; });
    try {
      f.gate.onInferenceEnded('one', publication);
      for (let i = 0; i < 125; i++) {
        f.channel(`event-${i}`, { messageId: String(i) }); f.fire();
      }
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 125);
      assert.equal(f.gate.inferenceDiagnostics().droppedBufferedEvents, 0);
      assert.equal(f.wakes.length, 0);
      assert.equal(f.traces.filter((e) => e.type === 'gate:debounce-delivered').length, 0);
      release(); await tick(); await tick();
      assert.deepEqual(checked, Array.from({ length: 125 }, (_, i) => String(i)));
      assert.equal(f.wakes.length, 1);
      assert.ok(JSON.stringify(f.writes).includes('125 events matched'));
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 0);
      assert.deepEqual(f.traces.filter((e) => e.type === 'gate:debounce-delivered').map((e) => e.eventCount), [125]);
    } finally { release(); await tick(); f.close(); }
  });

  it("one agent's slow publication does not hold another recipient of the same batch", async () => {
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    const f = harness(() => false, ['one', 'two']);
    try {
      f.gate.onInferenceEnded('one', publication);
      f.channel('event', { messageId: 'a' }); f.fire();
      assert.deepEqual(f.wakes.map((w) => w.agent), ['two']);
      assert.equal(f.writes[0].forAgent, 'two');
      release(); await tick(); await tick();
      assert.deepEqual(f.wakes.map((w) => w.agent), ['two', 'one']);
      assert.equal(f.writes[1].forAgent, 'one');
    } finally { release(); await tick(); f.close(); }
  });

  it('only placement-backed reply-requiring events wait on a publication fence', async () => {
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    const checked: string[] = [];
    const f = harness((_agent, p) => { checked.push(p.messageId!); return false; });
    try {
      f.gate.onInferenceEnded('one', publication);
      f.add('module', { messageId: 'module' });
      f.channel('ambient', { messageId: 'ambient' }, ['chat:ambient']);
      f.channel('system', { messageId: 'system' }, ['chat:system']);
      f.channel('no placement');
      f.channel('addressed', { messageId: 'addressed' });
      f.fire();
      assert.deepEqual(checked, ['module', 'ambient', 'system']);
      assert.equal(f.wakes.length, 1);
      assert.ok(JSON.stringify(f.writes).includes('4 events matched'));
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 1);
      release(); await tick(); await tick();
      assert.deepEqual(checked, ['module', 'ambient', 'system', 'addressed']);
      assert.equal(f.wakes.length, 2);
    } finally { release(); await tick(); f.close(); }
  });

  it('a stuck fence releases wakeable events after 65 seconds and logs once', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    let checks = 0;
    const f = harness(() => { checks++; return true; });
    try {
      f.gate.onInferenceEnded('one', publication);
      f.channel('event', { messageId: 'a' }); f.fire();
      t.mock.timers.tick(64_999); await tick();
      assert.equal(f.wakes.length, 0);
      t.mock.timers.tick(1); await tick(); await tick();
      assert.equal(f.wakes.length, 1, 'timeout keeps the wake even if the read check would drop it');
      assert.equal(checks, 0);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0][0]), /Final-publication fence.*65000 ms.*wakeable/);
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 0);
      release(); await tick();
      t.mock.timers.tick(65_000); await tick();
      assert.equal(errors.length, 1);
      assert.equal(f.wakes.length, 1, 'late settlement cannot deliver twice');
    } finally { release(); f.close(); }
  });

  it('overlapping fences cannot extend an earlier batch deadline', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const f = harness(() => false);
    try {
      f.gate.onInferenceEnded('one', new Promise<void>(() => {}));
      f.channel('first', { messageId: 'first' }); f.fire();
      t.mock.timers.tick(30_000);
      f.gate.onInferenceEnded('one', new Promise<void>(() => {}));
      t.mock.timers.tick(35_000); await tick(); await tick();
      assert.equal(f.wakes.length, 1);
      f.channel('second', { messageId: 'second' }); f.fire();
      assert.equal(f.wakes.length, 1);
      t.mock.timers.tick(30_000); await tick(); await tick();
      assert.equal(f.wakes.length, 2);
      assert.equal(errors.length, 2);
    } finally { f.close(); }
  });

  it('released holds remain uncapped while a new turn or quiesce prevents delivery', async () => {
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    let checks = 0;
    const f = harness(() => { checks++; return false; });
    try {
      f.gate.onInferenceEnded('one', publication);
      for (let i = 0; i < 125; i++) f.channel(`event-${i}`, { messageId: String(i) });
      f.fire();
      f.gate.onInferenceStarted('one');
      f.gate.setQuiesced(true);
      release(); await tick(); await tick();
      assert.equal(f.wakes.length, 0);
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 125);
      f.gate.onInferenceEnded('one'); await tick();
      assert.equal(f.wakes.length, 0);
      f.gate.setQuiesced(false); await tick(); await tick();
      assert.equal(checks, 125);
      assert.equal(f.gate.inferenceDiagnostics().droppedBufferedEvents, 0);
      assert.equal(f.wakes.length, 1);
    } finally { release(); await tick(); f.close(); }
  });

  it('disposal clears fence timers and prevents later delivery', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    const f = harness(() => false);
    try {
      f.gate.onInferenceEnded('one', publication);
      f.channel('event', {}); f.fire();
      f.gate.dispose();
      t.mock.timers.tick(65_000); await tick();
      release(); await tick();
      assert.deepEqual(f.wakes, []);
      assert.deepEqual(errors, []);
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 0);
    } finally { f.close(); }
  });
});
