import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-mutation');
const CONFIG_PATH = join(TMP_DIR, 'gate.json');

interface InferenceCall { agentName: string; reason: string; source: string }

function makeGate(config: GateConfig, onInference?: (c: InferenceCall) => void) {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config));
  return new EventGate({
    configPath: CONFIG_PATH,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: (agentName, reason, source) => onInference?.({ agentName, reason, source }),
    getAgentNames: () => ['agent'],
  });
}

function readConfig(): GateConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as GateConfig;
}

function ev(tags: string[], overrides?: Partial<GateEventInfo>): GateEventInfo {
  return { content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c1', tags, ...overrides };
}

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
afterEach(() => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

describe('EventGate.addPolicy / removePolicy (wake_add_rule / wake_remove_rule)', () => {
  it('adds a policy that takes effect immediately and is persisted to gate.json', () => {
    const gate = makeGate({ policies: [], default: 'defer' });
    // Before: an ambient event falls through to the "defer" default.
    assert.strictEqual(gate.evaluate(ev(['chat:ambient'])).trigger, false);

    gate.addPolicy({ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' });

    // Live effect without any reload.
    assert.strictEqual(gate.evaluate(ev(['chat:mention'])).trigger, true);
    // Persisted to disk in canonical shape.
    const onDisk = readConfig();
    assert.deepStrictEqual(onDisk.policies.map(p => p.name), ['mentions']);
    assert.strictEqual(onDisk.policies[0].behavior, 'always');
  });

  it('upserts (replaces in place) when a policy of the same name already exists', () => {
    const gate = makeGate({
      policies: [
        { name: 'a', match: { tagsAny: ['chat:dm'] }, behavior: 'always' },
        { name: 'busy', match: { channel: 'c1' }, behavior: 'always' },
        { name: 'b', match: { tagsAny: ['chat:mention'] }, behavior: 'always' },
      ],
      default: 'defer',
    });
    gate.addPolicy({ name: 'busy', match: { channel: 'c1' }, behavior: { debounce: 5000 } });

    const names = readConfig().policies.map(p => p.name);
    assert.deepStrictEqual(names, ['a', 'busy', 'b'], 'order preserved, no duplicate');
    const busy = readConfig().policies.find(p => p.name === 'busy')!;
    assert.deepStrictEqual(busy.behavior, { debounce: 5000 }, 'behavior replaced');
  });

  it('prepend places a wake rule ahead of a broad rule (first match wins)', () => {
    const gate = makeGate({
      policies: [{ name: 'firehose', match: { channel: 'c1' }, behavior: 'defer' }],
      default: 'defer',
    });
    // Without the wake rule, a mention in c1 is deferred by the broad rule.
    assert.strictEqual(gate.evaluate(ev(['chat:mention'])).trigger, false);

    gate.addPolicy(
      { name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' },
      { position: 'prepend' },
    );
    const decision = gate.evaluate(ev(['chat:mention']));
    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.policyName, 'mentions');
    assert.deepStrictEqual(readConfig().policies.map(p => p.name), ['mentions', 'firehose']);
  });

  it('rejects an invalid policy and writes nothing', () => {
    const gate = makeGate({ policies: [{ name: 'keep', match: {}, behavior: 'always' }], default: 'defer' });
    assert.throws(() => gate.addPolicy({ name: 'bad', behavior: { debounce: -5 } }), /debounce/);
    assert.throws(() => gate.addPolicy({ match: {}, behavior: 'always' }), /name/);
    // Original config untouched.
    assert.deepStrictEqual(readConfig().policies.map(p => p.name), ['keep']);
  });

  it('removePolicy removes and persists; returns false for an unknown name', () => {
    const gate = makeGate({
      policies: [
        { name: 'x', match: { tagsAny: ['chat:mention'] }, behavior: 'always' },
        { name: 'y', match: {}, behavior: 'defer' },
      ],
      default: 'defer',
    });
    assert.strictEqual(gate.removePolicy('x'), true);
    assert.strictEqual(gate.evaluate(ev(['chat:mention'])).trigger, false, 'rule no longer applies');
    assert.deepStrictEqual(readConfig().policies.map(p => p.name), ['y']);

    assert.strictEqual(gate.removePolicy('nope'), false);
    assert.deepStrictEqual(readConfig().policies.map(p => p.name), ['y'], 'unchanged on miss');
  });

  it('persisted config is valid and reloadable by a fresh gate', () => {
    const gate = makeGate({ policies: [], default: 'defer' });
    gate.addPolicy({ name: 'r', match: { source: 'discord', channel: 'c1', tagsAny: ['chat:ambient'] }, behavior: { debounce: 1000 } });

    const fresh = new EventGate({
      configPath: CONFIG_PATH,
      emitTrace: () => {},
      addMessage: () => '',
      requestInference: () => {},
      getAgentNames: () => ['agent'],
    });
    assert.deepStrictEqual(fresh.getStatus().policies.map(p => p.name), ['r']);
  });

  it('listPolicyNames reflects the freshest on-disk view', () => {
    const gate = makeGate({ policies: [{ name: 'a', match: {}, behavior: 'always' }], default: 'defer' });
    gate.addPolicy({ name: 'b', match: {}, behavior: 'defer' });
    assert.deepStrictEqual(gate.listPolicyNames(), ['a', 'b']);
  });
});

describe('Item 5 gate mechanism: every-message-debounced on chat:ambient', () => {
  it('debounces ambient messages in a channel and fires one batched wake after the window', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const inferences: InferenceCall[] = [];
    const gate = makeGate({ policies: [], default: 'defer' }, (c) => inferences.push(c));

    // The gate half of item 5's "debounced mode": a per-channel debounce policy
    // keyed on the ambient tag. (subscribe_channel + subscription-gc "off" are
    // the host-side other two thirds — see the B2 report.)
    gate.addPolicy({
      name: 'ambient-debounced:c1',
      match: { source: 'discord', channel: 'c1', tagsAny: ['chat:ambient'] },
      behavior: { debounce: 120 }, // just above MIN_DEBOUNCE_MS for a fast test
    });

    // A burst of ambient messages: each matches, none triggers immediately.
    for (let i = 0; i < 3; i++) {
      const d = gate.evaluate(ev(['chat:ambient'], { content: `msg ${i}` }));
      assert.strictEqual(d.trigger, false, 'ambient is batched, not an immediate wake');
      assert.strictEqual(d.policyName, 'ambient-debounced:c1');
    }
    // A mention in the same channel is NOT ambient → falls through to default (defer here).
    assert.strictEqual(gate.evaluate(ev(['chat:mention'])).trigger, false);

    assert.strictEqual(inferences.length, 0, 'no wake yet — window still open');
    t.mock.timers.tick(200);
    assert.strictEqual(inferences.length, 1, 'exactly one batched wake after the window settles');

    // Status shows the debounce policy with its match count.
    const status = gate.getStatus();
    const p = status.policies.find(s => s.name === 'ambient-debounced:c1')!;
    assert.strictEqual(p.matchCount, 3);
  });
});
