/**
 * af#105 — intuitive wake-gate composition.
 *
 * Covers the four pieces that grew out of the 2026-08-08 Mythos
 * stand-back-density incident (a prepended catch-all passive_sample silently
 * made the DM/mention wake rules unreachable for the whole incoming lane):
 *
 *   ① `passthrough` observer rules — non-firing counting behaviors fall
 *     through to later policies instead of consuming the event;
 *   ② shadow lint — provably-dead rules are reported at config time;
 *   ③ dry-run probes — side-effect-free "who would win" evaluation;
 *   ④ anchored positions — addPolicy({before}/{after}) placement.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate, findShadowedPolicies, formatShadowWarning } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo, GatePolicy } from '../src/gate/types.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-passthrough');

interface TraceEntry {
  type: string;
  [key: string]: unknown;
}

interface Harness {
  gate: EventGate;
  configPath: string;
  traces: TraceEntry[];
}

function makeGate(initialConfig: GateConfig): Harness {
  mkdirSync(TMP_DIR, { recursive: true });
  const configPath = join(TMP_DIR, `gate-${Math.random().toString(36).slice(2)}.json`);
  const traces: TraceEntry[] = [];
  const gate = new EventGate({
    configPath,
    initialConfig,
    emitTrace: (e) => traces.push(e as TraceEntry),
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
    now: () => 1_000_000,
  });
  return { gate, configPath, traces };
}

function event(overrides?: Partial<GateEventInfo>): GateEventInfo {
  return {
    content: 'test',
    eventType: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId: 'discord:dm:1',
    metadata: {},
    ...overrides,
  };
}

/** The Mythos incident's policy shapes, reusable across cases. */
const SAMPLER: GatePolicy = {
  name: 'stand-back-density',
  match: { scope: ['mcpl:channel-incoming'] },
  behavior: { passive_sample: { every: 3 } },
};
const DIRECT_ADDRESS: GatePolicy = {
  name: 'discord-direct-address',
  match: { scope: ['mcpl:push-event', 'mcpl:channel-incoming'], metadataTrue: ['isMention', 'isDM'] },
  behavior: 'always',
};
const AMBIENT: GatePolicy = {
  name: 'discord-ambient',
  match: { scope: ['mcpl:push-event', 'mcpl:channel-incoming'] },
  behavior: 'skip',
};

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ① passthrough
// ---------------------------------------------------------------------------

describe('passthrough observer rules', () => {
  it('non-firing passthrough sampler falls through to a later always rule (the incident, fixed)', () => {
    const { gate } = makeGate({
      policies: [
        { ...SAMPLER, passthrough: true },
        DIRECT_ADDRESS,
        AMBIENT,
      ],
      default: 'skip',
    });

    // A DM: with the consuming sampler this was swallowed 149/150 times.
    // With passthrough it must reach discord-direct-address every time the
    // sampler doesn't fire.
    const d1 = gate.evaluate(event({ metadata: { isDM: true } }));
    assert.strictEqual(d1.trigger, true);
    assert.strictEqual(d1.policyName, 'discord-direct-address');
    assert.deepStrictEqual(d1.observed, ['stand-back-density']);
  });

  it('passthrough sampler still fires every Nth match, and consumes on fire', () => {
    const { gate } = makeGate({
      policies: [{ ...SAMPLER, passthrough: true }, AMBIENT],
      default: 'skip',
    });

    // every:3 — two ambient events fall through to the ambient skip, the
    // third fires the sampler itself.
    const d1 = gate.evaluate(event());
    const d2 = gate.evaluate(event());
    const d3 = gate.evaluate(event());
    assert.strictEqual(d1.trigger, false);
    assert.strictEqual(d1.policyName, 'discord-ambient');
    assert.strictEqual(d2.policyName, 'discord-ambient');
    assert.strictEqual(d3.trigger, true);
    assert.strictEqual(d3.policyName, 'stand-back-density');
    assert.strictEqual(d3.observed, undefined);
  });

  it('counts every matching event even when a later rule wakes anyway', () => {
    const { gate } = makeGate({
      policies: [{ ...SAMPLER, passthrough: true }, DIRECT_ADDRESS, AMBIENT],
      default: 'skip',
    });

    // Two DMs (wake via direct-address, sampler counts both), then one
    // ambient event: sampler is at 2, the ambient event is its 3rd → fires.
    gate.evaluate(event({ metadata: { isDM: true } }));
    gate.evaluate(event({ metadata: { isDM: true } }));
    const d3 = gate.evaluate(event());
    assert.strictEqual(d3.trigger, true);
    assert.strictEqual(d3.policyName, 'stand-back-density');
  });

  it('falls through to the gate default when nothing later matches', () => {
    const { gate } = makeGate({
      policies: [{ ...SAMPLER, passthrough: true }],
      default: 'skip',
    });
    const d = gate.evaluate(event());
    assert.strictEqual(d.trigger, false);
    assert.strictEqual(d.policyName, null);
    assert.deepStrictEqual(d.observed, ['stand-back-density']);
    // The fall-to-default is counted in default decision stats.
    assert.strictEqual(gate.getStatus().defaultDecisions.skipped, 1);
  });

  it('rejects passthrough on non-counting behaviors', () => {
    for (const behavior of ['always', 'skip', { debounce: 1000 }] as const) {
      const { gate } = makeGate({
        policies: [{ name: 'p', match: {}, behavior, passthrough: true } as unknown as GatePolicy],
      });
      const errors = gate.getStatus().errors;
      assert.ok(
        errors.some((e) => /passthrough is only valid/.test(e)),
        `expected passthrough validation error for ${JSON.stringify(behavior)}, got: ${JSON.stringify(errors)}`,
      );
    }
  });

  it('accepts passthrough on rate_limit and falls through when the bucket is empty', () => {
    const { gate } = makeGate({
      policies: [
        {
          name: 'burst-governor',
          match: {},
          behavior: { rate_limit: { tokens: 1, refillIntervalMs: 60_000 } },
          passthrough: true,
        },
        { name: 'catch-all', match: {}, behavior: 'skip' },
      ],
      default: 'always',
    });
    const d1 = gate.evaluate(event());
    assert.strictEqual(d1.trigger, true); // token available → fires
    const d2 = gate.evaluate(event());
    assert.strictEqual(d2.trigger, false); // bucket empty → falls through
    assert.strictEqual(d2.policyName, 'catch-all');
    assert.deepStrictEqual(d2.observed, ['burst-governor']);
  });
});

// ---------------------------------------------------------------------------
// ② shadow lint
// ---------------------------------------------------------------------------

describe('shadow lint', () => {
  it('flags the incident shape: prepended scope catch-all shadows direct-address for the overlapped scope', () => {
    const warnings = findShadowedPolicies([SAMPLER, DIRECT_ADDRESS, AMBIENT]);
    const hit = warnings.find((w) => w.later === 'discord-direct-address');
    assert.ok(hit, `expected direct-address shadow warning, got ${JSON.stringify(warnings)}`);
    assert.strictEqual(hit.earlier, 'stand-back-density');
    assert.deepStrictEqual(hit.eventTypes, ['mcpl:channel-incoming']);
    assert.match(formatShadowWarning(hit), /unreachable for mcpl:channel-incoming/);
  });

  it('a passthrough observer shadows nothing', () => {
    const warnings = findShadowedPolicies([
      { ...SAMPLER, passthrough: true },
      DIRECT_ADDRESS,
      AMBIENT,
    ]);
    assert.ok(!warnings.some((w) => w.earlier === 'stand-back-density'));
  });

  it('does not flag rules the earlier one cannot fully cover', () => {
    // direct-address has a metadataTrue discriminator ambient lacks: events
    // with no truthy flags slip past it, so ambient stays reachable.
    const warnings = findShadowedPolicies([DIRECT_ADDRESS, AMBIENT]);
    assert.deepStrictEqual(warnings, []);
  });

  it('subset metadataTrue IS flagged (earlier OR-list covers later)', () => {
    const warnings = findShadowedPolicies([
      { name: 'broad', match: { metadataTrue: ['isMention', 'isDM'] }, behavior: 'skip' },
      { name: 'narrow', match: { metadataTrue: ['isDM'] }, behavior: 'always' },
    ]);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].later, 'narrow');
    assert.strictEqual(warnings[0].eventTypes, 'all');
  });

  it('surfaces via gate:shadow-warnings trace and getStatus on mutation', () => {
    const { gate, traces } = makeGate({ policies: [DIRECT_ADDRESS, AMBIENT], default: 'skip' });
    assert.deepStrictEqual(gate.getStatus().shadowWarnings, []);
    gate.addPolicy(SAMPLER, { position: 'prepend' });
    const status = gate.getStatus();
    assert.ok(
      status.shadowWarnings.some((w) => /discord-direct-address/.test(w)),
      `expected shadow warning in status, got ${JSON.stringify(status.shadowWarnings)}`,
    );
    assert.ok(traces.some((t) => t.type === 'gate:shadow-warnings'));
  });
});

// ---------------------------------------------------------------------------
// ③ dry-run probes
// ---------------------------------------------------------------------------

describe('dry-run probes', () => {
  it('probe reports the winner without advancing counters', () => {
    const { gate } = makeGate({ policies: [SAMPLER, DIRECT_ADDRESS], default: 'skip' });

    // Probe the same DM three times — a MUTATING evaluate would fire the
    // every:3 sampler on the third call; probes must not.
    for (let i = 0; i < 3; i++) {
      const p = gate.probe(event({ metadata: { isDM: true } }));
      assert.strictEqual(p.policyName, 'stand-back-density');
      assert.strictEqual(p.trigger, false);
    }
    // Real evaluation still starts from a cold counter.
    const d = gate.evaluate(event({ metadata: { isDM: true } }));
    assert.strictEqual(d.trigger, false);
  });

  it('probe honors passthrough fall-through', () => {
    const { gate } = makeGate({
      policies: [{ ...SAMPLER, passthrough: true }, DIRECT_ADDRESS],
      default: 'skip',
    });
    const p = gate.probe(event({ metadata: { isDM: true } }));
    assert.strictEqual(p.policyName, 'discord-direct-address');
    assert.strictEqual(p.trigger, true);
  });

  it('probeTable makes the incident visible as a changed dm row', () => {
    const { gate } = makeGate({ policies: [DIRECT_ADDRESS, AMBIENT], default: 'skip' });
    const before = gate.probeTable();
    const dmBefore = before.find((r) => r.probe === 'dm (open channel)');
    assert.ok(dmBefore);
    assert.strictEqual(dmBefore.policy, 'discord-direct-address');
    assert.strictEqual(dmBefore.wouldWake, true);

    gate.addPolicy(SAMPLER, { position: 'prepend' });
    const after = gate.probeTable();
    const dmAfter = after.find((r) => r.probe === 'dm (open channel)');
    assert.ok(dmAfter);
    assert.strictEqual(dmAfter.policy, 'stand-back-density');
    assert.strictEqual(dmAfter.wouldWake, false);
    // The closed-channel (push/event) dm row is untouched — exactly the
    // asymmetry that made the incident look intermittent.
    const dmPush = after.find((r) => r.probe === 'dm (closed channel)');
    assert.ok(dmPush);
    assert.strictEqual(dmPush.policy, 'discord-direct-address');
    assert.strictEqual(dmPush.wouldWake, true);
  });
});

// ---------------------------------------------------------------------------
// ④ anchored positions
// ---------------------------------------------------------------------------

describe('anchored positions', () => {
  it('inserts before/after a named anchor', () => {
    const { gate } = makeGate({ policies: [DIRECT_ADDRESS, AMBIENT], default: 'skip' });
    gate.addPolicy(SAMPLER, { position: { before: 'discord-ambient' } });
    assert.deepStrictEqual(gate.listPolicyNames(), [
      'discord-direct-address', 'stand-back-density', 'discord-ambient',
    ]);
    gate.addPolicy(
      { name: 'after-anchor', match: {}, behavior: 'skip' },
      { position: { after: 'discord-direct-address' } },
    );
    assert.deepStrictEqual(gate.listPolicyNames(), [
      'discord-direct-address', 'after-anchor', 'stand-back-density', 'discord-ambient',
    ]);
  });

  it('throws on a missing anchor, naming the available rules', () => {
    const { gate } = makeGate({ policies: [AMBIENT], default: 'skip' });
    assert.throws(
      () => gate.addPolicy(SAMPLER, { position: { before: 'no-such-rule' } }),
      /no policy named "no-such-rule".*discord-ambient/s,
    );
  });

  it('replacement without a position stays in place; with a position it moves', () => {
    const { gate } = makeGate({
      policies: [SAMPLER, DIRECT_ADDRESS, AMBIENT],
      default: 'skip',
    });
    // In-place update keeps the (bad) prepended slot.
    gate.addPolicy({ ...SAMPLER, behavior: { passive_sample: { every: 5 } } });
    assert.deepStrictEqual(gate.listPolicyNames(), [
      'stand-back-density', 'discord-direct-address', 'discord-ambient',
    ]);
    // Re-issuing WITH an anchor is the repair path for the incident.
    gate.addPolicy(SAMPLER, { position: { before: 'discord-ambient' } });
    assert.deepStrictEqual(gate.listPolicyNames(), [
      'discord-direct-address', 'stand-back-density', 'discord-ambient',
    ]);
  });
});
