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
  const opts = {
    configPath: join(dir, 'gate.json'),
    initialConfig: { policies: [...(judge ? [{ name: 'judged', match: { scope: ['judge:event'] }, behavior: { judge: { debounceMs: 60_000 } } }] : []), { name: 'batch', match: {}, behavior: { debounce: 60_000 } }], default: 'always' as const },
    emitTrace: () => {},
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
    gate, wakes, writes,
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
      f.gate.evaluate({ eventType: 'judge:event', content: 'judge this', serverId: '', channelId: '' });
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

  it('a check that throws keeps every event and logs the fault once', () => {
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
