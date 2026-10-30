import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';
// Note: the gate matches the event's *already-expanded* tag set. Implication
// expansion (expandTags) is the host's job and is tested in mcpl-core-ts.

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-tags');

function makeGate(config: GateConfig) {
  mkdirSync(TMP_DIR, { recursive: true });
  const configPath = join(TMP_DIR, 'gate.json');
  writeFileSync(configPath, JSON.stringify(config));
  return new EventGate({
    configPath,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
}

function ev(tags: string[], overrides?: Partial<GateEventInfo>): GateEventInfo {
  return { content: 'x', eventType: 'mcpl:push-event', serverId: 'portal', channelId: 'c1', tags, ...overrides };
}

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
afterEach(() => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

describe('EventGate tag matching', () => {
  it('tagsAny matches if any listed tag present', () => {
    const gate = makeGate({
      policies: [{ name: 'wake', match: { tagsAny: ['chat:mention', 'chat:dm'] }, behavior: 'always' }],
      default: 'skip',
    });
    assert.strictEqual(gate.evaluate(ev(['chat:mention'])).trigger, true);
    assert.strictEqual(gate.evaluate(ev(['chat:dm', 'chat:from-human'])).trigger, true);
    assert.strictEqual(gate.evaluate(ev(['chat:ambient'])).trigger, false);
    assert.strictEqual(gate.evaluate(ev([])).trigger, false);
  });

  it('tagsAll requires every listed tag', () => {
    const gate = makeGate({
      policies: [{ name: 'r', match: { tagsAll: ['chat:reaction', 'chat:to-self'] }, behavior: 'always' }],
      default: 'skip',
    });
    assert.strictEqual(gate.evaluate(ev(['chat:reaction', 'chat:to-self'])).trigger, true);
    assert.strictEqual(gate.evaluate(ev(['chat:reaction'])).trigger, false);
  });

  it('tagsNone excludes', () => {
    const gate = makeGate({
      policies: [{ name: 'amb', match: { tagsAll: ['chat:ambient'], tagsNone: ['chat:from-self'] }, behavior: 'always' }],
      default: 'skip',
    });
    assert.strictEqual(gate.evaluate(ev(['chat:ambient'])).trigger, true);
    assert.strictEqual(gate.evaluate(ev(['chat:ambient', 'chat:from-self'])).trigger, false);
  });

  it('glob patterns match a namespace', () => {
    const gate = makeGate({
      policies: [{ name: 'tg', match: { tagsAny: ['telegram:*'] }, behavior: 'always' }],
      default: 'skip',
    });
    assert.strictEqual(gate.evaluate(ev(['telegram:callback'])).trigger, true);
    assert.strictEqual(gate.evaluate(ev(['discord:slash'])).trigger, false);
  });

  it('first-match-wins: addressed before ambient-debounce', () => {
    const gate = makeGate({
      policies: [
        { name: 'addressed', match: { tagsAny: ['chat:addressed'] }, behavior: 'always' },
        { name: 'ambient', match: { tagsAny: ['chat:mention'] }, behavior: { debounce: 1000 } },
      ],
      default: 'skip',
    });
    // host pre-expands a mention event to include chat:addressed
    const d = gate.evaluate(ev(['chat:mention', 'chat:addressed']));
    assert.strictEqual(d.policyName, 'addressed');
    assert.strictEqual(d.trigger, true);
  });
});
