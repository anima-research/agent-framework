import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventGate, type WritePlacement } from '../src/gate/event-gate.js';

function fixture(options: {
  agents?: string[];
  shared?: string[];
  done?: (agent: string, placement: WritePlacement) => boolean;
  policies?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'debounce-recipients-'));
  const agents = options.agents ?? ['owner'];
  const writes: Array<{ content: unknown; forAgent?: string }> = [];
  const wakes: string[] = [];
  const traces: Array<{ type: string; policyName?: string; eventCount?: number }> = [];
  const opts = {
    configPath: join(dir, 'gate.json'),
    initialConfig: {
      policies: options.policies
        ? ['alpha', 'beta'].map((name) => ({ name, match: { scope: [`${name}:event`] }, behavior: { debounce: 60_000 } }))
        : [{ name: 'batch', match: {}, behavior: { debounce: 60_000 } }],
      default: 'always' as const,
    },
    emitTrace: (event: { type: string; policyName?: string; eventCount?: number }) => { traces.push(event); },
    addMessage: (_p: string, content: unknown, _m?: unknown, forAgent?: string) => { writes.push({ content, forAgent }); },
    requestInference: (name: string) => { wakes.push(name); },
    getAgentNames: () => agents,
    getSharedSlotReaders: options.shared === undefined ? undefined : () => options.shared!,
    isWriteDone: options.done ?? (() => false),
  };
  const gate = new EventGate(opts);
  const state = gate as unknown as { debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>; fireDebounce(name: string): void };
  const add = (content: string, after?: WritePlacement, eventType = 'clock:reminder') => gate.evaluate({
    eventType, content, serverId: 'chat', channelId: eventType === 'mcpl:channel-incoming' ? 'room' : '', tags: ['chat:addressed'],
  }, after);
  return {
    gate, agents, writes, wakes, traces, add,
    channel: (after: WritePlacement = { agent: 'owner', messageId: 'event' }) => add('event', after, 'mcpl:channel-incoming'),
    fire: () => { for (const [name, pending] of state.debounceTimers) { clearTimeout(pending.timer); (gate as unknown as { fireDebounce(name: string): void }).fireDebounce(name); } },
    delivered: () => traces.filter((event) => event.type === 'gate:debounce-delivered'),
    close: () => { gate.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('debounce recipient stores and delivery occurrences', () => {
  it('writes only the common unseen remainder into the shared slot', () => {
    const f = fixture({ agents: ['left', 'right'], shared: ['left', 'right'], done: (agent, p) => agent === p.agent });
    try {
      f.add('answered by left', { agent: 'left', messageId: 'left' });
      f.add('answered by right', { agent: 'right', messageId: 'right' });
      f.add('common unseen');
      f.fire();
      assert.deepEqual(f.wakes, ['left', 'right']);
      assert.equal(f.writes.length, 1);
      assert.match(JSON.stringify(f.writes), /common unseen/);
      assert.doesNotMatch(JSON.stringify(f.writes), /answered by/);
      assert.deepEqual(f.delivered().map((event) => event.eventCount), [3]);
    } finally { f.close(); }
  });

  it('writes a partial group once per store, even when its first recipient is a fork', () => {
    const f = fixture({ agents: ['satisfied-fork', 'fork', 'resident'], shared: ['resident'], done: (agent) => agent === 'satisfied-fork' });
    try {
      f.add('still needed', { agent: 'satisfied-fork', messageId: 'event' }); f.fire();
      assert.deepEqual(f.wakes.sort(), ['fork', 'resident']);
      assert.deepEqual(f.writes.map((w) => w.forAgent).sort(), ['fork', 'resident']);
      for (const write of f.writes) assert.match(JSON.stringify(write.content), /still needed/);
    } finally { f.close(); }
  });

  it('without the optional shared-slot hook, legacy divergent-line placement is unchanged', () => {
    const f = fixture({ agents: ['left', 'right'], done: (agent, p) => agent === p.agent });
    try {
      f.add('left content', { agent: 'left', messageId: 'left' });
      f.add('right content', { agent: 'right', messageId: 'right' }); f.fire();
      assert.deepEqual(f.wakes, ['left', 'right']);
      assert.deepEqual(f.writes.map((w) => w.forAgent), ['left', 'right']);
      assert.match(JSON.stringify(f.writes[0]), /right content/);
      assert.doesNotMatch(JSON.stringify(f.writes[0]), /left content/);
      assert.match(JSON.stringify(f.writes[1]), /left content/);
      assert.doesNotMatch(JSON.stringify(f.writes[1]), /right content/);
    } finally { f.close(); }
  });

  it('does not fence a placement another recipient owns', async () => {
    const publication = deferred();
    const f = fixture({ agents: ['owner', 'other'], shared: ['owner', 'other'] });
    try {
      f.gate.onInferenceEnded('other', publication.promise);
      f.channel(); f.fire();
      assert.deepEqual(f.wakes, ['owner', 'other']);
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 0);
      publication.resolve(); await tick(); await tick();
      assert.equal(f.wakes.length, 2);
    } finally { publication.resolve(); f.close(); }
  });

  it('counts an event once across immediate delivery and its owner fence release', async () => {
    const publication = deferred();
    const f = fixture({ agents: ['owner', 'other'], shared: ['owner', 'other'] });
    try {
      f.gate.onInferenceEnded('owner', publication.promise);
      f.channel(); f.fire();
      assert.deepEqual(f.wakes, ['other']);
      assert.equal(f.writes.length, 1, 'the immediate recipient gets the common unseen summary');
      assert.deepEqual(f.delivered().map((e) => e.eventCount), [1]);
      publication.resolve(); await tick(); await tick();
      assert.deepEqual(f.wakes, ['other', 'owner']);
      assert.equal(f.writes.length, 1);
      assert.deepEqual(f.delivered().map((e) => e.eventCount), [1]);
    } finally { publication.resolve(); f.close(); }
  });

  it('two open recipient fences cannot write two shared lines for one event', async () => {
    const first = deferred(), second = deferred();
    const f = fixture({ agents: ['owner', 'other'], shared: ['owner', 'other'] });
    try {
      f.gate.onInferenceEnded('owner', first.promise);
      f.gate.onInferenceEnded('other', second.promise);
      f.channel(); f.fire();
      assert.deepEqual(f.wakes, ['other'], 'only the placement owner can benefit from the fence');
      first.resolve(); await tick(); await tick();
      second.resolve(); await tick(); await tick();
      assert.deepEqual(f.wakes, ['other', 'owner']);
      assert.equal(f.writes.length, 1);
      assert.deepEqual(f.delivered().map((e) => e.eventCount), [1]);
    } finally { first.resolve(); second.resolve(); f.close(); }
  });

  it('drops a released recipient that is no longer in the live gate audience', async () => {
    const publication = deferred();
    const f = fixture({ shared: ['owner'] });
    try {
      f.gate.onInferenceEnded('owner', publication.promise);
      f.channel(); f.fire();
      f.agents.splice(0);
      publication.resolve(); await tick(); await tick();
      assert.deepEqual(f.wakes, []);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.delivered(), []);
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 0);
    } finally { publication.resolve(); f.close(); }
  });

  it('a merged inference flush traces newly delivered events once per policy', async () => {
    const f = fixture({ policies: true });
    try {
      f.gate.onInferenceStarted('owner');
      f.add('a', undefined, 'alpha:event'); f.add('b', undefined, 'beta:event'); f.add('c', undefined, 'alpha:event'); f.fire();
      assert.deepEqual(f.delivered(), []);
      f.gate.onInferenceEnded('owner'); await tick();
      assert.equal(f.writes.length, 1);
      assert.deepEqual(f.delivered().map((e) => [e.policyName, e.eventCount]), [['alpha', 2], ['beta', 1]]);
    } finally { f.close(); }
  });
});

describe('queued debounce delivery safety', () => {
  for (const interruption of ['turn', 'quiesce', 'dispose'] as const) {
    it(`a fence delivery microtask rechecks ${interruption}`, async () => {
      const publication = deferred();
      const f = fixture();
      try {
        f.gate.onInferenceEnded('owner', publication.promise);
        f.channel(); f.fire();
        publication.resolve();
        // The promise callback queues delivery behind this continuation.
        await Promise.resolve();
        if (interruption === 'turn') f.gate.onInferenceStarted('owner');
        else if (interruption === 'quiesce') f.gate.setQuiesced(true);
        else f.gate.dispose();
        await tick();
        assert.deepEqual(f.wakes, []);
        assert.deepEqual(f.writes, []);
        assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, interruption === 'dispose' ? 0 : 1);
        if (interruption === 'turn') f.gate.onInferenceEnded('owner');
        else if (interruption === 'quiesce') f.gate.setQuiesced(false);
        await tick(); await tick();
        assert.equal(f.wakes.length, interruption === 'dispose' ? 0 : 1);
      } finally { publication.resolve(); f.close(); }
    });

    it(`an inference-buffer microtask rechecks ${interruption}`, async () => {
      const f = fixture();
      try {
        f.gate.onInferenceStarted('owner'); f.add('unseen'); f.fire();
        f.gate.onInferenceEnded('owner');
        if (interruption === 'turn') f.gate.onInferenceStarted('owner');
        else if (interruption === 'quiesce') f.gate.setQuiesced(true);
        else f.gate.dispose();
        await tick();
        assert.deepEqual(f.wakes, []);
        assert.deepEqual(f.writes, []);
        if (interruption === 'turn') f.gate.onInferenceEnded('owner');
        else if (interruption === 'quiesce') f.gate.setQuiesced(false);
        await tick();
        assert.equal(f.wakes.length, interruption === 'dispose' ? 0 : 1);
      } finally { f.close(); }
    });
  }

  it('re-holding a queued inference batch preserves oldest-first cap eviction', async (t) => {
    t.mock.method(console, 'error', () => {});
    const checked: string[] = [];
    const f = fixture({ done: (_name, after) => { checked.push(after.messageId!); return false; } });
    try {
      f.gate.onInferenceStarted('owner');
      for (let i = 0; i < 100; i++) f.add(String(i), { messageId: String(i) });
      f.fire(); f.gate.onInferenceEnded('owner'); f.gate.onInferenceStarted('owner');
      for (let i = 100; i < 105; i++) f.add(String(i), { messageId: String(i) });
      f.fire(); await tick();
      assert.deepEqual(f.wakes, []);
      assert.equal(f.gate.inferenceDiagnostics().bufferedEvents, 100);
      assert.equal(f.gate.inferenceDiagnostics().droppedBufferedEvents, 5);
      f.gate.onInferenceEnded('owner'); await tick();
      assert.deepEqual(checked, Array.from({ length: 100 }, (_, i) => String(i + 5)));
    } finally { f.close(); }
  });

  it('disposal cancels the outstanding publication watchdog timer', (t) => {
    const cleared: unknown[] = [];
    const clear = globalThis.clearTimeout;
    t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => { cleared.push(timer); clear(timer); });
    const f = fixture();
    try {
      f.gate.onInferenceEnded('owner', new Promise<void>(() => {}));
      const fences = (f.gate as unknown as { publicationFences: Map<string, Set<{ timer: unknown }>> }).publicationFences;
      const timer = [...fences.get('owner')!][0].timer;
      f.gate.dispose();
      assert.ok(cleared.includes(timer));
    } finally { f.close(); }
  });

  it('an event arriving with two open fences uses the older deadline', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    t.mock.method(console, 'error', () => {});
    const f = fixture();
    try {
      f.gate.onInferenceEnded('owner', new Promise<void>(() => {}));
      t.mock.timers.tick(30_000);
      f.gate.onInferenceEnded('owner', new Promise<void>(() => {}));
      f.channel(); f.fire();
      t.mock.timers.tick(35_000); await tick();
      assert.equal(f.wakes.length, 1);
    } finally { f.close(); }
  });

  it('late settlement during a turn cannot undo timeout wakeability', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    t.mock.method(console, 'error', () => {});
    const publication = deferred();
    const f = fixture({ done: () => true });
    try {
      f.gate.onInferenceEnded('owner', publication.promise); f.channel(); f.fire();
      f.gate.onInferenceStarted('owner');
      t.mock.timers.tick(65_000); await tick();
      publication.resolve(); await tick();
      f.gate.onInferenceEnded('owner'); await tick(); await tick();
      assert.equal(f.wakes.length, 1);
    } finally { publication.resolve(); f.close(); }
  });
});
