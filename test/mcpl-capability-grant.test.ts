/**
 * Capability grant core (SPEC §5.4, §5.1, §6.4, §13.4).
 *
 * The load-bearing cases mirror the 2026-08-02 differ adjudications: the
 * one-segment wildcard (TS had shipped the suffix reading), bare-parent-
 * grants-nothing, and the recursive advertisement walk that the old
 * `=== true` checks silently missed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  advertisedPaths,
  capabilityPatternMatches,
  computeGrant,
  ALL_CAPABILITY_PATHS,
  isKnownCapabilityPath,
  CapabilityGrant,
} from '../src/mcpl/capability-grant.js';
import type { McplCapabilities } from '../src/mcpl/types.js';

const caps = (o: Record<string, unknown>): McplCapabilities =>
  ({ version: '0.5', ...o }) as unknown as McplCapabilities;

// ── §6.2 vocabulary ─────────────────────────────────────────────────────────

test('vocabulary is exactly the 17 §6.2 paths', () => {
  assert.deepEqual([...ALL_CAPABILITY_PATHS].sort(), [
    'channels.acknowledge',
    'channels.incoming',
    'channels.lifecycle',
    'channels.publish',
    'channels.register',
    'channels.streaming',
    'channels.typing',
    'contextHooks.beforeInference.inject.afterUser',
    'contextHooks.beforeInference.inject.beforeUser',
    'contextHooks.beforeInference.inject.system',
    'contextHooks.beforeInference.observe',
    'inferenceLifecycle',
    'inferenceRequest',
    'inferenceRequest.streaming',
    'modelInfo',
    'pushEvents',
    'tools',
  ]);
  assert.equal(isKnownCapabilityPath('channels'), false); // namespace, not a path
  assert.equal(isKnownCapabilityPath('contextHooks.beforeInference'), false);
});

// ── §5.1 advertisement walk ─────────────────────────────────────────────────

test('boolean true expands to every leaf beneath (channels: true → 7 leaves)', () => {
  const a = advertisedPaths(caps({ channels: true }));
  assert.equal(a.size, 7);
  assert.ok(a.has('channels.streaming'));
});

test('recursive object shape advertises exactly its leaves', () => {
  const a = advertisedPaths(caps({
    contextHooks: { beforeInference: { observe: true, inject: { beforeUser: true } } },
  }));
  assert.deepEqual([...a].sort(), [
    'contextHooks.beforeInference.inject.beforeUser',
    'contextHooks.beforeInference.observe',
  ]);
});

test('beforeInference: true is shorthand for observe plus all three inject leaves', () => {
  const a = advertisedPaths(caps({ contextHooks: { beforeInference: true } }));
  assert.equal(a.size, 4);
});

test('false, absent, and unknown names advertise nothing', () => {
  assert.equal(advertisedPaths(caps({ channels: false })).size, 0);
  assert.equal(advertisedPaths(caps({})).size, 0);
  assert.equal(advertisedPaths(caps({ madeUp: true, channels: { alsoMadeUp: true } })).size, 0);
  assert.equal(advertisedPaths(null).size, 0);
});

test('inferenceRequest is self-grantable: object form advertises its own path', () => {
  const a = advertisedPaths(caps({ inferenceRequest: { streaming: true } }));
  assert.deepEqual([...a].sort(), ['inferenceRequest', 'inferenceRequest.streaming']);
});

// ── §5.4 matching: one segment, equal counts ────────────────────────────────

test('* matches exactly one segment; segment counts must agree', () => {
  assert.ok(capabilityPatternMatches('channels.*', 'channels.publish'));
  assert.ok(!capabilityPatternMatches('channels.*', 'channels'));
  // The adjudicated divergence: a trailing * is NOT a subtree match.
  assert.ok(!capabilityPatternMatches('contextHooks.*', 'contextHooks.beforeInference.observe'));
  assert.ok(!capabilityPatternMatches('contextHooks.*', 'contextHooks.beforeInference.inject.system'));
  assert.ok(!capabilityPatternMatches('*', 'channels.publish'));
  assert.ok(capabilityPatternMatches('*', 'pushEvents'));
  assert.ok(capabilityPatternMatches('contextHooks.beforeInference.inject.*', 'contextHooks.beforeInference.inject.afterUser'));
});

test('bare parent grants nothing beneath it', () => {
  const grant = new CapabilityGrant(new Set(['channels']), []);
  assert.ok(!grant.has('channels.publish'));
  assert.ok(grant.has('channels')); // the path itself, which no method requires
});

// ── grant computation ───────────────────────────────────────────────────────

test('empty grant denies everything; absence is denial', () => {
  const g = CapabilityGrant.empty();
  assert.ok(g.isEmpty());
  for (const p of ALL_CAPABILITY_PATHS) assert.ok(!g.has(p));
});

test('§13.4: inject.system is denied by default and re-grantable only explicitly', () => {
  const advertised = caps({ contextHooks: { beforeInference: true } });
  const denied = computeGrant(advertised, {});
  assert.ok(!denied.has('contextHooks.beforeInference.inject.system'));
  assert.ok(denied.has('contextHooks.beforeInference.inject.beforeUser'));
  assert.deepEqual(denied.deniedPaths, ['contextHooks.beforeInference.inject.system']);

  const granted = computeGrant(advertised, {
    enabledCapabilities: ['contextHooks.beforeInference.inject.system'],
  });
  assert.ok(granted.has('contextHooks.beforeInference.inject.system'));
  assert.deepEqual(granted.deniedPaths, []);
});

test('grant is advertisement-bounded: nothing un-advertised is granted', () => {
  const g = computeGrant(caps({ pushEvents: true }), {
    enabledCapabilities: ['channels.*', 'tools'],
  });
  assert.ok(g.has('pushEvents'));
  assert.ok(!g.has('tools'));
  assert.ok(!g.has('channels.publish'));
});
