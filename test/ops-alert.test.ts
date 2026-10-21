import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

/**
 * opsAlert() is the single escalation path for "a human should hear about
 * this": failures.log record + ops:alert trace + cooldown-throttled Discord
 * webhook. It and noteRefusal() are private and the full framework is heavy
 * to construct, so — like inference-failure-observability.test.ts — we
 * exercise them on a prototype instance with just the touched fields stubbed.
 */
function makeHarness() {
  const fw = Object.create(AgentFramework.prototype) as any;
  fw.opsAlertLastSent = new Map<string, number>();
  fw.opsAlertCooldownMs = 15 * 60_000;
  fw.refusalStats = new Map();
  fw.refusalStreak = new Map();
  fw.consecutiveInferenceFailures = new Map<string, number>();
  fw.inferenceFailureEscalationThreshold = 3;
  fw.exhaustionRewinds = new Map<string, number>();
  fw.lastInferenceAt = new Map<string, object>();
  fw.pendingRequests = [];
  fw.activeStreams = new Map();   // healthSnapshot reads its keys
  fw.agents = new Map([['cairn', {
    state: { status: 'idle' },
    getContextManager: () => ({ addMessage: () => {} }),
  }]]);

  // Capture instead of touching the filesystem — logFailure's file mechanics
  // are trivial and shared with the legacy exhaustion path.
  const logged: Array<Record<string, unknown>> = [];
  fw.logFailure = (r: Record<string, unknown>) => logged.push(r);

  // Capture traces.
  const traces: any[] = [];
  fw.traceListeners = [];
  fw.onTrace((e: any) => traces.push(e));

  // Capture webhook posts.
  const posts: Array<{ url: string; body: any }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: any, init?: any) => {
    posts.push({ url: String(url), body: JSON.parse(init?.body ?? 'null') });
    return Promise.resolve(new Response('ok'));
  }) as typeof fetch;

  // Silence + capture stderr.
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };

  const restore = () => {
    globalThis.fetch = origFetch;
    console.error = origErr;
    delete process.env.CONNECTOME_OPS_WEBHOOK;
  };
  return { fw, logged, traces, posts, errs, restore };
}

test('opsAlert: one webhook post per (agent,kind) per cooldown; trace + log always', () => {
  const { fw, logged, traces, posts, restore } = makeHarness();
  process.env.CONNECTOME_OPS_WEBHOOK = 'https://discord.example/hook';
  try {
    fw.opsAlert('hard-down', 'cairn', 'reason A');
    fw.opsAlert('hard-down', 'cairn', 'reason B');          // same key → suppressed
    assert.equal(posts.length, 1, 'second post within cooldown is suppressed');
    assert.match(posts[0].body.content, /\*\*cairn\*\* hard-down: reason A/);

    fw.opsAlert('refusal', 'cairn', 'different kind');       // different key → posts
    assert.equal(posts.length, 2);
    fw.opsAlert('hard-down', 'lena', 'different agent');     // different key → posts
    assert.equal(posts.length, 3);

    // Cooldown expiry re-arms the key.
    fw.opsAlertLastSent.set('cairn:hard-down', Date.now() - 16 * 60_000);
    fw.opsAlert('hard-down', 'cairn', 'reason C');
    assert.equal(posts.length, 4, 'posts again after the cooldown window');

    // The durable + wire records are NOT throttled: every call logs + traces
    // (5 calls — including the webhook-suppressed one).
    assert.equal(traces.filter(t => t.type === 'ops:alert').length, 5);
    assert.equal(logged.length, 5, 'failures.log record on every call (no skipLog)');
    assert.equal(logged[0].kind, 'hard-down');
  } finally { restore(); }
});

test('opsAlert: no webhook env → no fetch, still logs and traces', () => {
  const { fw, logged, traces, posts, restore } = makeHarness();
  try {
    fw.opsAlert('mcpl-down', 'discord', 'unreachable');
    assert.equal(posts.length, 0);
    assert.equal(logged.length, 1);
    assert.equal(traces.filter(t => t.type === 'ops:alert').length, 1);
  } finally { restore(); }
});

test('hard-down routes through opsAlert: one post at threshold, retries suppressed', () => {
  const { fw, posts, restore } = makeHarness();
  process.env.CONNECTOME_OPS_WEBHOOK = 'https://discord.example/hook';
  try {
    for (let i = 0; i < 5; i++) fw.noteInferenceExhausted('cairn', 'boom');
    assert.equal(posts.length, 1, 'streaks 3,4,5 within cooldown → exactly one post');
    assert.match(posts[0].body.content, /hard-down: 3 consecutive inference failures/);
  } finally { restore(); }
});

test('noteRefusal: stats + streak + per-refusal log; alert only from streak 2', () => {
  const { fw, logged, posts, restore } = makeHarness();
  process.env.CONNECTOME_OPS_WEBHOOK = 'https://discord.example/hook';
  try {
    const s1 = fw.noteRefusal('cairn', 'cyber', { input: 200_000, output: 12 });
    assert.equal(s1, 1);
    assert.equal(posts.length, 0, 'a single refusal does not page anyone');
    const s2 = fw.noteRefusal('cairn', 'bio');
    assert.equal(s2, 2);
    assert.equal(posts.length, 1, 'second consecutive refusal alerts');
    assert.match(posts[0].body.content, /refusal streak 2, category=bio/);

    // Every refusal gets a durable record (kind, category, streak, tokens).
    assert.equal(logged.length, 2);
    assert.equal(logged[0].kind, 'refusal');
    assert.equal(logged[0].category, 'cyber');
    assert.equal(logged[0].streak, 1);
    assert.deepEqual(logged[0].tokens, { input: 200_000, output: 12 });
    assert.equal(logged[1].streak, 2);

    // Stats accumulate per category and are exposed via healthSnapshot.
    const snap = fw.healthSnapshot();
    const cairn = snap.agents.find((a: any) => a.name === 'cairn');
    assert.equal(cairn.refusalStats.total, 2);
    assert.deepEqual(cairn.refusalStats.byCategory, { cyber: 1, bio: 1 });
    assert.equal(cairn.refusalStats.lastCategory, 'bio');

    // Agents that never refused expose null (mixed-fleet compat: consumers
    // treat missing/null as "n/a").
    fw.agents.set('lena', { state: { status: 'idle' } });
    const lena = fw.healthSnapshot().agents.find((a: any) => a.name === 'lena');
    assert.equal(lena.refusalStats, null);
  } finally { restore(); }
});

test('refusal streak resets independently of stats (driver clears it on any clean turn)', () => {
  const { fw, posts, restore } = makeHarness();
  process.env.CONNECTOME_OPS_WEBHOOK = 'https://discord.example/hook';
  try {
    fw.noteRefusal('cairn', 'cyber');
    // The stream driver's non-refusal branch does exactly this:
    fw.refusalStreak.delete('cairn');
    fw.noteRefusal('cairn', 'cyber');
    assert.equal(posts.length, 0, 'streak restarted at 1 — no alert');
    assert.equal(fw.refusalStats.get('cairn').total, 2, 'lifetime stats keep counting');
  } finally { restore(); }
});
