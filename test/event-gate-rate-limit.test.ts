import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';

// ---------------------------------------------------------------------------
// Test scaffolding — fake-clock gate, deterministic across runs.
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-ratelimit');

function tmpPath(name: string): string {
  return join(TMP_DIR, name);
}

interface TraceEntry {
  type: string;
  [key: string]: unknown;
}

interface Harness {
  gate: EventGate;
  configPath: string;
  traces: TraceEntry[];
  advance(ms: number): void;
  setNow(ms: number): void;
}

function makeFakeClockGate(initialConfig: GateConfig, startTime = 1_000_000): Harness {
  let currentTime = startTime;
  mkdirSync(TMP_DIR, { recursive: true });
  const configPath = tmpPath(`gate-${Math.random().toString(36).slice(2)}.json`);
  const traces: TraceEntry[] = [];
  const gate = new EventGate({
    configPath,
    initialConfig,
    emitTrace: (e) => traces.push(e as TraceEntry),
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
    now: () => currentTime,
  });
  return {
    gate,
    configPath,
    traces,
    advance(ms) { currentTime += ms; },
    setNow(ms) { currentTime = ms; },
  };
}

/** Rewrite gate.json so the next evaluate() reloads it: the gate compares its text, whatever its mtime. */
async function rewriteConfig(h: Harness, next: GateConfig): Promise<void> {
  // Bypass the 1s reload-check throttle (existing test pattern).
  (h.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  writeFileSync(h.configPath, JSON.stringify(next, null, 2));
}

function event(overrides?: Partial<GateEventInfo>): GateEventInfo {
  return {
    content: 'test',
    eventType: 'mcpl:channel-incoming',
    serverId: 'telegram',
    channelId: 'telegram:default:supergroup:1',
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation: new behaviors', () => {
  // Validation errors during initialConfig seeding land in getStatus().errors
  // rather than throwing — this matches the existing pattern where a bad
  // gate.json edit doesn't crash the running gate, just reports the issue.
  it('leaves out a rate_limit with non-positive tokens, which wakes on nothing, and says so', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'p',
        match: {},
        behavior: { rate_limit: { tokens: 0, refillIntervalMs: 1000 } },
      }],
    });
    const errors = gate.getStatus().errors;
    assert.deepStrictEqual(gate.getStatus().policies, []);
    assert.ok(
      errors.some(e => /Rule "p" is left out: behavior\.rate_limit\.tokens is 0, where a positive number is needed\./.test(e)),
      `expected validation error, got: ${JSON.stringify(errors)}`,
    );
  });

  it('reads a rate_limit with a refillIntervalMs under 0 as tokens that never refill, as it ran, and one of 0 as tokens that refill at once, and says so', () => {
    for (const [refillIntervalMs, tokens, read, wakes] of [
      [-1, 2, "so its tokens never refill, and once they're spent it wakes the agent on nothing it matches.", [true, true, false, false, false]],
      // Earlier releases refilled a bucket with an interval of 0 once, and then never.
      // One token is spent at each event, so the probe meets a spent bucket.
      [0, 1, 'so its tokens refill at once, and it limits nothing it matches.', [true, true, true, true, true]],
    ] as const) {
      const h = makeFakeClockGate({
        default: 'skip',
        policies: [{
          name: 'p',
          match: {},
          behavior: { rate_limit: { tokens, refillIntervalMs } },
        }],
      });
      assert.deepStrictEqual(h.gate.getStatus().policies[0]!.behavior, { rate_limit: { tokens, refillIntervalMs } });
      assert.ok(
        h.gate.getStatus().errors.some(e => e.includes(
          `Rule "p": behavior.rate_limit.refillIntervalMs is ${refillIntervalMs}, where a positive number of milliseconds is needed, ${read}`,
        )),
        JSON.stringify(h.gate.getStatus().errors),
      );
      // However long it waits, and with no wait at all for 0. The probe, which
      // wake_add_rule's table reads, says the same at each step.
      const woke: boolean[] = [];
      const probed: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        probed.push(h.gate.probe(event()).trigger);
        woke.push(h.gate.evaluate(event()).trigger);
        if (refillIntervalMs < 0) h.advance(60_000);
      }
      assert.deepStrictEqual(woke, wakes, `refillIntervalMs ${refillIntervalMs}`);
      assert.deepStrictEqual(probed, woke, `refillIntervalMs ${refillIntervalMs}: the probe`);
    }
  });

  it('reads passive_sample with non-integer every as its next whole number, as it ran, and says so', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'p',
        match: {},
        behavior: { passive_sample: { every: 1.5 } as { every: number } },
      }],
    });
    assert.deepStrictEqual(gate.getStatus().policies[0]!.behavior, { passive_sample: { every: 2 } });
    assert.ok(
      gate.getStatus().errors.some(e => /passive_sample\.every is 1\.5, not a whole number, so it's read as 2\./.test(e)),
    );
  });

  it('accepts well-formed rate_limit and passive_sample without keyBy', () => {
    const { gate } = makeFakeClockGate({
      policies: [
        { name: 'rl', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 1000 } } },
      ],
      default: 'skip',
    });
    // With tokens=1, the first call passes, the second is denied.
    assert.strictEqual(gate.evaluate(event()).trigger, true);
    assert.strictEqual(gate.evaluate(event()).trigger, false);
  });
});

// ---------------------------------------------------------------------------
// metadataTrue match
// ---------------------------------------------------------------------------

describe('match: metadataTrue', () => {
  it('matches when ANY listed metadata field is truthy', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'direct',
        match: { metadataTrue: ['isMention', 'isPrivate'] },
        behavior: 'always',
      }],
      default: 'skip',
    });

    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true } })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isPrivate: true } })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: false, isPrivate: false } })).trigger,
      false,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: {} })).trigger,
      false,
    );
  });

  it('treats empty arrays/strings/objects as falsy (not raw JS Boolean)', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'direct',
        match: { metadataTrue: ['mentionIds'] },
        behavior: 'always',
      }],
      default: 'skip',
    });

    // Empty array — would be truthy under raw Boolean(), but we want falsy.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { mentionIds: [] } })).trigger,
      false,
    );
    // Non-empty array — truthy.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { mentionIds: ['user-99'] } })).trigger,
      true,
    );
    // Empty string — falsy.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { mentionIds: '' } })).trigger,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// rate_limit
// ---------------------------------------------------------------------------

describe('rate_limit', () => {
  function rlConfig(): GateConfig {
    return {
      policies: [{
        name: 'rl',
        match: { metadataTrue: ['isMention'] },
        behavior: { rate_limit: { tokens: 12, refillIntervalMs: 1000, keyBy: 'senderId' } },
      }],
      default: 'skip',
    };
  }

  it('drains the bucket and denies the 13th invocation in a row', () => {
    const { gate } = makeFakeClockGate(rlConfig());
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(
        gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-1' } })).trigger,
        true,
        `invocation ${i + 1} should pass`,
      );
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-1' } })).trigger,
      false,
      '13th invocation must be denied',
    );
  });

  it('regenerates one token per refillIntervalMs', () => {
    const { gate, advance } = makeFakeClockGate(rlConfig());
    for (let i = 0; i < 12; i++) {
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } }));
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
    );
    advance(1000);
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      true,
      'one token should regenerate after refillIntervalMs',
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
      'no second token yet — should still be denied',
    );
  });

  it('caps refill at the configured tokens (no leaking)', () => {
    const { gate, advance } = makeFakeClockGate(rlConfig());
    // drain
    for (let i = 0; i < 12; i++) {
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } }));
    }
    advance(100_000); // way past full refill
    // Should now have full 12 tokens — not 100.
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(
        gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
        true,
        `post-refill invocation ${i + 1}`,
      );
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
      '13th post-refill invocation should be denied',
    );
  });

  it('keyBy partitions buckets — different users have independent quotas', () => {
    const { gate } = makeFakeClockGate(rlConfig());
    for (let i = 0; i < 12; i++) {
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-A' } }));
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-A' } })).trigger,
      false,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-B' } })).trigger,
      true,
      'user-B bucket must be independent',
    );
  });

  it('missing keyBy field falls back to a single shared bucket', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 2, refillIntervalMs: 1000, keyBy: 'senderId' } },
      }],
      default: 'skip',
    });
    // No senderId — these all share the single fallback bucket.
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
    assert.strictEqual(
      gate.evaluate(event({ metadata: {} })).trigger,
      false,
      'shared bucket should drain like any other',
    );
  });

  it('terminates with trigger:false on deny — does not fall through to default:always', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: { metadataTrue: ['isMention'] },
        behavior: { rate_limit: { tokens: 1, refillIntervalMs: 1000 } },
      }],
      default: 'always',
    });
    // First passes.
    assert.strictEqual(gate.evaluate(event({ metadata: { isMention: true } })).trigger, true);
    // Second is denied — must NOT fall through to default:always.
    const denied = gate.evaluate(event({ metadata: { isMention: true } }));
    assert.strictEqual(denied.trigger, false);
    assert.strictEqual(denied.policyName, 'rl');
  });
});

// ---------------------------------------------------------------------------
// passive_sample
// ---------------------------------------------------------------------------

describe('passive_sample', () => {
  it('fires every Nth match, then resets', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 3 } },
      }],
      default: 'skip',
    });
    assert.strictEqual(gate.evaluate(event()).trigger, false);
    assert.strictEqual(gate.evaluate(event()).trigger, false);
    assert.strictEqual(gate.evaluate(event()).trigger, true);  // 3rd → fires
    assert.strictEqual(gate.evaluate(event()).trigger, false); // counter reset
    assert.strictEqual(gate.evaluate(event()).trigger, false);
    assert.strictEqual(gate.evaluate(event()).trigger, true);  // 6th
  });

  it('keyBy partitions counters — busy channel does not affect quiet one', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 3, keyBy: 'channelId' } },
      }],
      default: 'skip',
    });
    // Two messages in A, then B's first: on one shared counter, B's would be
    // the third and fire; on B's own, it doesn't.
    for (let i = 0; i < 2; i++) {
      assert.strictEqual(
        gate.evaluate(event({ channelId: 'A', metadata: { channelId: 'A' } })).trigger,
        false,
      );
    }
    assert.strictEqual(
      gate.evaluate(event({ channelId: 'B', metadata: { channelId: 'B' } })).trigger,
      false,
      'B counts on its own',
    );
    // A's third fires on A's counter.
    assert.strictEqual(
      gate.evaluate(event({ channelId: 'A', metadata: { channelId: 'A' } })).trigger,
      true,
    );
  });

  it('terminates with trigger:false on non-firing counter — no fallthrough to default', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 100 } },
      }],
      default: 'always',
    });
    const decision = gate.evaluate(event());
    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.policyName, 'ps');
  });
});

// ---------------------------------------------------------------------------
// resets cross-policy
// ---------------------------------------------------------------------------

describe('resets', () => {
  it('firing a policy clears the rate_limit and passive_sample state of named targets', () => {
    const config: GateConfig = {
      policies: [
        {
          name: 'direct',
          match: { metadataTrue: ['isMention'] },
          behavior: { rate_limit: { tokens: 12, refillIntervalMs: 1000, keyBy: 'senderId' } },
          resets: ['passive'],
        },
        {
          name: 'passive',
          match: {},
          behavior: { passive_sample: { every: 5 } },
        },
      ],
      default: 'skip',
    };
    const { gate } = makeFakeClockGate(config);

    // 4 quiet messages — passive counter at 4
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    }
    // Direct invocation fires AND resets the passive counter.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      true,
    );
    // Now we need ANOTHER 5 quiet messages, not 1 more.
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    }
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
  });

  it('denied rate_limit does NOT trigger resets', () => {
    const config: GateConfig = {
      policies: [
        {
          name: 'direct',
          match: { metadataTrue: ['isMention'] },
          behavior: { rate_limit: { tokens: 1, refillIntervalMs: 10_000 } },
          resets: ['passive'],
        },
        {
          name: 'passive',
          match: {},
          behavior: { passive_sample: { every: 3 } },
        },
      ],
      default: 'skip',
    };
    const { gate } = makeFakeClockGate(config);

    // Burn the only token via direct invocation — fires, counter resets to 0
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      true,
    );
    // 2 quiet messages — counter at 2
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    // Denied direct invocation — must NOT reset counter
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
    );
    // Next quiet message should still fire (counter was preserved at 2 → reaches 3)
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
  });

  it('always-behavior with resets clears target state too', () => {
    const config: GateConfig = {
      policies: [
        {
          name: 'priority',
          match: { metadataTrue: ['urgent'] },
          behavior: 'always',
          resets: ['passive'],
        },
        {
          name: 'passive',
          match: {},
          behavior: { passive_sample: { every: 5 } },
        },
      ],
      default: 'skip',
    };
    const { gate } = makeFakeClockGate(config);
    // pile up the passive counter
    for (let i = 0; i < 4; i++) gate.evaluate(event({ metadata: {} }));
    // urgent fires, resets passive
    assert.strictEqual(gate.evaluate(event({ metadata: { urgent: true } })).trigger, true);
    // need full 5 quiet messages now
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    }
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
  });

  it('unknown reset target is silently ignored', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'p',
        match: {},
        behavior: 'always',
        resets: ['nonexistent', 'also-fake'],
      }],
      default: 'skip',
    });
    // Should not throw
    assert.strictEqual(gate.evaluate(event()).trigger, true);
  });
});

// ---------------------------------------------------------------------------
// status reporting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hot reload: changed-behavior state invalidation
// ---------------------------------------------------------------------------

describe('hot reload — changed behavior clears stale state', () => {
  it('rate_limit tokens lowered: bucket cleared, fresh quota at the new limit', async () => {
    const h = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 12, refillIntervalMs: 10_000 } },
      }],
      default: 'skip',
    });
    // Drain the old 12-token bucket
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(h.gate.evaluate(event()).trigger, true);
    }
    assert.strictEqual(h.gate.evaluate(event()).trigger, false);

    // Reload with tokens=3
    await rewriteConfig(h, {
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 3, refillIntervalMs: 10_000 } },
      }],
      default: 'skip',
    });

    // Next evaluate triggers reload + fresh bucket at the new limit.
    assert.strictEqual(h.gate.evaluate(event()).trigger, true);
    assert.strictEqual(h.gate.evaluate(event()).trigger, true);
    assert.strictEqual(h.gate.evaluate(event()).trigger, true);
    assert.strictEqual(
      h.gate.evaluate(event()).trigger,
      false,
      '4th post-reload invocation must hit the new limit (tokens=3), not the old 12',
    );
  });

  it('rate_limit refillIntervalMs changed: bucket cleared (state stale otherwise)', async () => {
    const h = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 5, refillIntervalMs: 100_000 } },
      }],
      default: 'skip',
    });
    // Drain
    for (let i = 0; i < 5; i++) h.gate.evaluate(event());
    assert.strictEqual(h.gate.evaluate(event()).trigger, false);

    await rewriteConfig(h, {
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 5, refillIntervalMs: 1000 } },
      }],
      default: 'skip',
    });

    // Bucket was cleared; new 5 tokens available immediately.
    assert.strictEqual(h.gate.evaluate(event()).trigger, true);
  });

  it('rate_limit keyBy changed: old keyed buckets do NOT carry over', async () => {
    const h = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 1, refillIntervalMs: 100_000, keyBy: 'userId' } },
      }],
      default: 'skip',
    });
    // Burn the only token under user K. (keyBy channelId would key by the
    // channel the gate routes the event to, not the field's value.)
    h.gate.evaluate(event({ metadata: { userId: 'K', senderId: 'x' } }));
    assert.strictEqual(
      h.gate.evaluate(event({ metadata: { userId: 'K', senderId: 'x' } })).trigger,
      false,
    );

    // Reload — same tokens/refill, but keyBy switched to senderId.
    await rewriteConfig(h, {
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 1, refillIntervalMs: 100_000, keyBy: 'senderId' } },
      }],
      default: 'skip',
    });

    // Sender K under the new scheme must get a fresh bucket: the old
    // user-K bucket, under the same key, is gone, and doesn't bleed into
    // the new partition.
    assert.strictEqual(
      h.gate.evaluate(event({ metadata: { userId: 'other', senderId: 'K' } })).trigger,
      true,
    );
  });

  it('passive_sample every lowered: counter cleared, does NOT fire stale', async () => {
    const h = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 10 } },
      }],
      default: 'skip',
    });
    // Pile up the counter to 7
    for (let i = 0; i < 7; i++) h.gate.evaluate(event());

    // Reload to every=3. Without the fix, counter at 7+1=8 ≥ 3 → fires
    // immediately on the very next event. The fix should clear it to 0,
    // so we need 3 more events before it fires.
    await rewriteConfig(h, {
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 3 } },
      }],
      default: 'skip',
    });

    assert.strictEqual(h.gate.evaluate(event()).trigger, false, '1st post-reload');
    assert.strictEqual(h.gate.evaluate(event()).trigger, false, '2nd post-reload');
    assert.strictEqual(h.gate.evaluate(event()).trigger, true, '3rd post-reload fires');
  });

  it('passive_sample keyBy changed: per-key counters cleared', async () => {
    const h = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 3, keyBy: 'userId' } },
      }],
      default: 'skip',
    });
    // Two messages from user K — counter at 2.
    for (let i = 0; i < 2; i++) {
      h.gate.evaluate(event({ metadata: { userId: 'K' } }));
    }

    await rewriteConfig(h, {
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 3, keyBy: 'senderId' } },
      }],
      default: 'skip',
    });

    // First post-reload event under sender K, the old counter's key: a fresh
    // counter (1, not 3), so it doesn't fire.
    assert.strictEqual(
      h.gate.evaluate(event({ metadata: { senderId: 'K' } })).trigger,
      false,
    );
  });

  it('unchanged behavior on reload: state preserved', async () => {
    const config: GateConfig = {
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 3, refillIntervalMs: 100_000 } },
      }],
      default: 'skip',
    };
    const h = makeFakeClockGate(config);
    // Drain to 0
    for (let i = 0; i < 3; i++) h.gate.evaluate(event());
    assert.strictEqual(h.gate.evaluate(event()).trigger, false);

    // Reload with identical behavior (e.g., a stylistic edit elsewhere
    // in the same file). State must NOT be cleared.
    await rewriteConfig(h, config);

    assert.strictEqual(
      h.gate.evaluate(event()).trigger,
      false,
      'unchanged-behavior reload must not regrant tokens',
    );
  });

  it('trace event lists policies whose state was cleared', async () => {
    const h = makeFakeClockGate({
      policies: [
        { name: 'a', match: {}, behavior: { rate_limit: { tokens: 5, refillIntervalMs: 1000 } } },
        { name: 'b', match: {}, behavior: { passive_sample: { every: 5 } } },
      ],
      default: 'skip',
    });

    // change one behavior, leave the other alone
    await rewriteConfig(h, {
      policies: [
        { name: 'a', match: {}, behavior: { rate_limit: { tokens: 2, refillIntervalMs: 1000 } } },
        { name: 'b', match: {}, behavior: { passive_sample: { every: 5 } } },
      ],
      default: 'skip',
    });
    h.gate.evaluate(event()); // triggers reload

    const reload = h.traces.find(t => t.type === 'gate:config-reloaded');
    assert.ok(reload, 'should have emitted a reload trace');
    assert.deepStrictEqual(reload.stateClearedPolicies, ['a']);
    assert.deepEqual((reload.removedPolicies as unknown[] | undefined) ?? [], [], 'no policy was removed');
  });

  it('trace event lists removed policies separately from state-cleared ones', async () => {
    const h = makeFakeClockGate({
      policies: [
        { name: 'kept', match: {}, behavior: { rate_limit: { tokens: 5, refillIntervalMs: 1000 } } },
        { name: 'gone', match: {}, behavior: { passive_sample: { every: 5 } } },
      ],
      default: 'skip',
    });

    await rewriteConfig(h, {
      policies: [
        // change kept's behavior so it's also state-cleared
        { name: 'kept', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 1000 } } },
      ],
      default: 'skip',
    });
    h.gate.evaluate(event());

    const reload = h.traces.find(t => t.type === 'gate:config-reloaded');
    assert.ok(reload);
    assert.deepStrictEqual(reload.removedPolicies, ['gone']);
    assert.deepStrictEqual(reload.stateClearedPolicies, ['kept']);
  });
});

// ---------------------------------------------------------------------------
// status reporting
// ---------------------------------------------------------------------------

describe('gate:status with new behaviors', () => {
  it('exposes rate-limit bucketCount + deniedCount', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 1, refillIntervalMs: 10_000, keyBy: 'k' } },
      }],
      default: 'skip',
    });
    gate.evaluate(event({ metadata: { k: 'a' } })); // creates bucket A, consumes
    gate.evaluate(event({ metadata: { k: 'b' } })); // creates bucket B, consumes
    gate.evaluate(event({ metadata: { k: 'a' } })); // denied
    const status = gate.getStatus();
    const policy = status.policies.find(p => p.name === 'rl');
    assert.ok(policy);
    assert.strictEqual(policy.rateLimitState?.bucketCount, 2);
    assert.strictEqual(policy.rateLimitState?.deniedCount, 1);
  });

  it('exposes passive-sample counterCount + fireCount', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 2, keyBy: 'k' } },
      }],
      default: 'skip',
    });
    gate.evaluate(event({ metadata: { k: 'A' } })); // count 1
    gate.evaluate(event({ metadata: { k: 'A' } })); // fires; reset to 0
    gate.evaluate(event({ metadata: { k: 'B' } })); // count 1 in B
    const status = gate.getStatus();
    const policy = status.policies.find(p => p.name === 'ps');
    assert.ok(policy);
    // 2 keys touched (A and B), 1 fire so far
    assert.strictEqual(policy.passiveSampleState?.counterCount, 2);
    assert.strictEqual(policy.passiveSampleState?.fireCount, 1);
  });
});
