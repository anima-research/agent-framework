import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo, JudgeFn, JudgeRequest, JudgeVerdict } from '../src/gate/types.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-judge');

function writeConfig(name: string, config: unknown): string {
  const path = join(TMP_DIR, name);
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A judge whose verdicts the test hands out, one per request, in order. */
function scriptedJudge() {
  const requests: JudgeRequest[] = [];
  const pending: Array<{ resolve: (v: JudgeVerdict) => void; reject: (e: unknown) => void }> = [];
  const fn: JudgeFn = (request) => {
    requests.push(request);
    return new Promise<JudgeVerdict>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return {
    fn,
    requests,
    answer(verdict: JudgeVerdict) {
      const next = pending.shift();
      assert.ok(next, 'a judge request is waiting');
      next.resolve(verdict);
    },
    fail(err: unknown) {
      const next = pending.shift();
      assert.ok(next, 'a judge request is waiting');
      next.reject(err);
    },
    waiting: () => pending.length,
  };
}

function makeGate(configPath: string, opts: { judge?: JudgeFn; judgeTimeoutMs?: number; judgeOnError?: 'wake' | 'skip' } = {}) {
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const messages: Array<{ participant: string; content: unknown; metadata?: unknown }> = [];
  const wakes: Array<{ agentName: string; reason: string }> = [];
  const gate = new EventGate({
    configPath,
    emitTrace: (e) => traces.push(e as { type: string }),
    addMessage: (p, c, m) => { messages.push({ participant: p, content: c, metadata: m }); return ''; },
    requestInference: (a, r) => wakes.push({ agentName: a, reason: r }),
    getAgentNames: () => ['agent'],
    ...(opts.judge ? { judge: opts.judge } : {}),
    ...(opts.judgeTimeoutMs !== undefined ? { judgeTimeoutMs: opts.judgeTimeoutMs } : {}),
    ...(opts.judgeOnError ? { judgeOnError: opts.judgeOnError } : {}),
  });
  return { gate, traces, messages, wakes };
}

function chat(content: string, overrides?: Partial<GateEventInfo>): GateEventInfo {
  return {
    content,
    eventType: 'mcpl:push-event',
    serverId: 'discord',
    channelId: 'c1',
    metadata: { authorId: 'u1', channelName: 'garden' },
    ...overrides,
  };
}

const JUDGED: GateConfig = {
  policies: [
    { name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100, instructions: 'Wake me for questions.' } } },
  ],
};

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('judge rules: reading', () => {
  it('loads a judge rule as written', () => {
    const { gate } = makeGate(writeConfig('read.json', {
      policies: [{ name: 'j', match: {}, behavior: { judge: { debounceMs: 20000, maxWaitMs: 120000, instructions: 'hi' } } }],
    }));
    const status = gate.getStatus();
    assert.deepStrictEqual(status.policies[0]!.behavior, { judge: { debounceMs: 20000, maxWaitMs: 120000, instructions: 'hi' } });
    assert.deepStrictEqual(status.errors.filter((e) => !e.includes('wires no reply judge')), []);
    gate.dispose();
  });

  it('reads a quiet period out of range at its bound, and a maxWait under it at the quiet period', () => {
    const { gate } = makeGate(writeConfig('bounds.json', {
      policies: [{ name: 'j', match: {}, behavior: { judge: { debounceMs: 10, maxWaitMs: 5 } } }],
    }));
    assert.deepStrictEqual(gate.getStatus().policies[0]!.behavior, { judge: { debounceMs: 100, maxWaitMs: 100 } });
    gate.dispose();
  });

  it('refuses a judge with no quiet period, instructions that are not text, or instructions too long', () => {
    for (const judge of [{}, { debounceMs: 1000, instructions: 5 }, { debounceMs: 1000, instructions: 'x'.repeat(4001) }]) {
      const { gate } = makeGate(writeConfig('bad.json', { policies: [{ name: 'j', match: {}, behavior: { judge } }] }));
      assert.strictEqual(gate.getStatus().policies.length, 0, JSON.stringify(judge));
      gate.dispose();
    }
  });

  it('refuses passthrough on a judge rule', () => {
    const { gate } = makeGate(writeConfig('pass.json', {
      policies: [{ name: 'j', match: {}, behavior: { judge: { debounceMs: 1000 } }, passthrough: true }],
    }));
    assert.ok(gate.getStatus().errors.some((e) => e.includes('passthrough')));
    gate.dispose();
  });

  it('a judge rule matches and holds the event back like a debounce', () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('decision.json', JUDGED), { judge: judge.fn });
    const d = gate.evaluate(chat('hello'));
    assert.strictEqual(d.trigger, false);
    assert.strictEqual(d.policyName, 'ambient');
    gate.dispose();
  });
});

describe('judge rules: verdicts', () => {
  it('reply wakes the agent with the batch, and the judge is shown the batch and the instructions', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages, traces } = makeGate(writeConfig('reply.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('is anyone around?'));
    gate.evaluate(chat('anyone?'));
    await sleep(160);
    assert.strictEqual(judge.requests.length, 1);
    const req = judge.requests[0]!;
    assert.strictEqual(req.policyName, 'ambient');
    assert.strictEqual(req.instructions, 'Wake me for questions.');
    assert.deepStrictEqual(req.events.map((e) => e.content), ['is anyone around?', 'anyone?']);
    assert.strictEqual(req.events[0]!.channel, '#garden (c1)');
    assert.deepStrictEqual(req.agentNames, ['agent']);
    assert.strictEqual(wakes.length, 0, 'no wake before the verdict');

    judge.answer({ reply: true, reason: 'a direct question', inputTokens: 1234 });
    await sleep(10);
    assert.deepStrictEqual(wakes, [{ agentName: 'agent', reason: 'gate:debounce' }]);
    assert.strictEqual(messages.length, 1);
    const verdict = traces.find((t) => t.type === 'gate:judge-verdict');
    assert.ok(verdict);
    assert.strictEqual(verdict.verdict, 'reply');
    assert.strictEqual(verdict.woke, true);
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 1, wait: 0, error: 0, rejudged: 0 });
    assert.strictEqual(state.last!.reason, 'a direct question');
    assert.strictEqual(state.last!.inputTokens, 1234);
    gate.dispose();
  });

  it('wait lets the batch go by: no wake, no message', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages } = makeGate(writeConfig('wait.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('lol'));
    await sleep(160);
    judge.answer({ reply: false, reason: 'banter between others' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(messages.length, 0);
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 0, wait: 1, error: 0, rejudged: 0 });
    assert.strictEqual(state.last!.verdict, 'wait');
    gate.dispose();
  });

  it('a failed judge wakes the agent by default (fail open)', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('fail.json', JUDGED), { judge: judge.fn });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      gate.evaluate(chat('hello'));
      await sleep(160);
      judge.fail(new Error('provider down'));
      await sleep(10);
    } finally {
      console.error = original;
    }
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(errors.length, 1, 'the failure is logged');
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.last!.verdict, 'error');
    gate.dispose();
  });

  it('a failed judge under onError "skip" does not wake', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('fail-skip.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await sleep(160);
      judge.fail(new Error('provider down'));
      await sleep(10);
    } finally {
      console.error = original;
    }
    assert.strictEqual(wakes.length, 0);
    gate.dispose();
  });

  it('a judge that takes too long is timed out, its request aborted, and the agent woken', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('timeout.json', JUDGED), { judge: judge.fn, judgeTimeoutMs: 50 });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await sleep(200);
    } finally {
      console.error = original;
    }
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    assert.strictEqual(wakes.length, 1);
    // A verdict after the timeout changes nothing.
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('a judge whose answer has no boolean verdict counts as a failure', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('nonsense.json', JUDGED), { judge: judge.fn });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await sleep(160);
      judge.answer({ reason: 'hm' } as unknown as JudgeVerdict);
      await sleep(10);
    } finally {
      console.error = original;
    }
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts.error, 1);
    gate.dispose();
  });
});

describe('judge rules: timing', () => {
  it('a batch that fires during a turn is held, then judged once the turn ends', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('held.json', JUDGED), { judge: judge.fn });
    gate.onInferenceStarted('agent');
    gate.evaluate(chat('hello'));
    await sleep(160);
    assert.strictEqual(judge.requests.length, 0, 'not judged mid-turn');
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.heldCount, 1);
    gate.onInferenceEnded('agent');
    await sleep(10);
    assert.strictEqual(judge.requests.length, 1);
    judge.answer({ reply: true, reason: 'ok' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('a reply reached while a turn ran is judged again after it, against the context it left, and traced as not waking', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, traces } = makeGate(writeConfig('midturn.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await sleep(160);
    gate.onInferenceStarted('agent');
    judge.answer({ reply: true, reason: 'ok' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(judge.requests.length, 1, 'not judged again mid-turn');
    const first = traces.find((t) => t.type === 'gate:judge-verdict')!;
    assert.strictEqual(first.woke, false);
    assert.strictEqual(first.rejudged, true);
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 1, wait: 0, error: 0, rejudged: 1 });
    gate.onInferenceEnded('agent');
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2, 'judged again once the turn ended');
    // The turn answered it: this time the judge lets it go.
    judge.answer({ reply: false, reason: 'already answered' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    gate.dispose();
  });

  it('a batch is judged again only once: the re-judgment\'s reply wakes the agent though another turn overlapped it', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('once.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await sleep(160);
    gate.onInferenceStarted('agent');
    judge.answer({ reply: true, reason: 'ok' });
    await sleep(10);
    gate.onInferenceEnded('agent');
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2);
    // Another turn overlaps the re-judgment.
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    judge.answer({ reply: true, reason: 'still' });
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2, 'no third request');
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it("another agent's turn (one the batch doesn't wake) doesn't send a reply back to the judge", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('other.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await sleep(160);
    gate.onInferenceStarted('Subconscious');
    gate.onInferenceEnded('Subconscious');
    judge.answer({ reply: true, reason: 'ok' });
    await sleep(10);
    assert.strictEqual(judge.requests.length, 1);
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('...as is one reached after a turn that started and ended while the judge read', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('between.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await sleep(160);
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    judge.answer({ reply: true, reason: 'ok' });
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2);
    judge.answer({ reply: true, reason: 'still' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('a quiesce stops the judge deciding now, and its batch is judged at resume', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('quiesce.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await sleep(160);
    gate.setQuiesced(true);
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.heldCount, 1);
    gate.setQuiesced(false);
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2);
    judge.answer({ reply: true, reason: 'now' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('caps what a rule holds for the judge, dropping the oldest', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('cap.json', {
      policies: [{ name: 'busy', match: {}, behavior: { judge: { debounceMs: 100 } } }],
    }), { judge: judge.fn });
    const original = console.error;
    console.error = () => {};
    try {
      gate.onInferenceStarted('agent');
      for (let i = 0; i < 150; i++) gate.evaluate(chat(`m${i}`));
      await sleep(160);
    } finally {
      console.error = original;
    }
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.heldCount, 100);
    assert.strictEqual(gate.inferenceDiagnostics().droppedJudgeEvents, 50);
    gate.onInferenceEnded('agent');
    await sleep(10);
    assert.strictEqual(judge.requests[0]!.events[0]!.content, 'm50');
    gate.dispose();
  });

  it('while the judge decides a full batch, events that fire meanwhile keep their newest', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('cap-queued.json', {
      policies: [{ name: 'busy', match: {}, behavior: { judge: { debounceMs: 100 } } }],
    }), { judge: judge.fn });
    const original = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < 100; i++) gate.evaluate(chat(`a${i}`));
      await sleep(160);
      assert.strictEqual(judge.requests[0]!.events.length, 100);
      for (let i = 0; i < 120; i++) gate.evaluate(chat(`b${i}`));
      await sleep(160);
    } finally {
      console.error = original;
    }
    judge.answer({ reply: false, reason: 'not yet' });
    await sleep(10);
    const next = judge.requests[1]!.events.map((e) => e.content);
    assert.strictEqual(next.length, 100);
    assert.strictEqual(next[0], 'b20');
    assert.strictEqual(next.at(-1), 'b119', 'the newest is kept');
    gate.dispose();
  });

  it('gate_status names a judge that keeps failing', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('streak.json', JUDGED), { judge: judge.fn });
    const original = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < 3; i++) {
        gate.evaluate(chat(`m${i}`));
        await sleep(160);
        judge.fail(new Error('400 model not found'));
        await sleep(10);
      }
    } finally {
      console.error = original;
    }
    assert.ok(gate.getStatus().errors.some((e) => e.includes('failed its last 3 requests') && e.includes('400 model not found')));
    gate.evaluate(chat('ok'));
    await sleep(160);
    judge.answer({ reply: false, reason: 'fine' });
    await sleep(10);
    assert.ok(!gate.getStatus().errors.some((e) => e.includes('failed its last')));
    gate.dispose();
  });

  it('a null verdict from a custom judge decides by onError rather than dropping the batch', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('null.json', JUDGED), { judge: judge.fn });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await sleep(160);
      judge.answer(null as unknown as JudgeVerdict);
      await sleep(10);
    } finally {
      console.error = original;
    }
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('a batch that fires while the judge decides waits for the verdict: delivered with it on reply', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('queued-reply.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('one'));
    await sleep(160);
    gate.evaluate(chat('two'));
    await sleep(160);
    assert.strictEqual(judge.requests.length, 1, 'one request at a time per rule');
    judge.answer({ reply: true, reason: 'ok' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(judge.requests.length, 1);
    gate.dispose();
  });

  it('...and judged afresh on wait', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('queued-wait.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('one'));
    await sleep(160);
    gate.evaluate(chat('two'));
    await sleep(160);
    judge.answer({ reply: false, reason: 'not yet' });
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2);
    assert.deepStrictEqual(judge.requests[1]!.events.map((e) => e.content), ['two']);
    judge.answer({ reply: true, reason: 'now' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('maxWaitMs judges a batch that keeps getting pushed back', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('maxwait.json', {
      policies: [{ name: 'busy', match: {}, behavior: { judge: { debounceMs: 150, maxWaitMs: 250 } } }],
    }), { judge: judge.fn });
    for (let i = 0; i < 8; i++) {
      gate.evaluate(chat(`m${i}`));
      await sleep(60);
    }
    // 8 × 60 ms of steady chatter, never 150 ms of quiet: judged by maxWait.
    assert.ok(judge.requests.length >= 1);
    assert.ok(judge.requests[0]!.events.length >= 3 && judge.requests[0]!.events.length <= 6, String(judge.requests[0]!.events.length));
    gate.dispose();
  });

  it('dispose aborts a judge deciding now, and its verdict delivers nothing', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('dispose.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await sleep(160);
    gate.dispose();
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
  });
});

describe('judge rules: what waiting leaves the agent with', () => {
  it("tells the judge the gate's own timers: a self-wake, a sleep's end, other rules' batches, not the rule it judges", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming.json', {
      policies: [
        { name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } },
        { name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } },
        { name: 'other-room', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 120000 } } },
      ],
    }), { judge: judge.fn });
    const t0 = Date.now();
    gate.armSelfWake('agent', 600);
    gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    gate.evaluate(chat('hello'));
    await sleep(160);
    const wakes = judge.requests[0]!.upcomingWakes!;
    assert.deepStrictEqual(wakes.map((w) => [w.what, w.certain]), [
      ['rule "files"\'s debounced batch of 1 event', true],
      ['rule "other-room"\'s batch of 1 event goes to the judge', false],
      ['its own skip_reply timer', true],
    ]);
    const selfWake = wakes.find((w) => w.what.includes('skip_reply'))!;
    assert.ok(Math.abs(selfWake.at! - (t0 + 600_000)) < 2_000, String(selfWake.at! - t0));
    assert.ok(!wakes.some((w) => w.what.includes('"ambient"')), "the rule being judged isn't listed");
    gate.dispose();
  });

  it("lists a sleep's end, and nothing once a self-wake has been cancelled by a turn", () => {
    const { gate } = makeGate(writeConfig('upcoming-sleep.json', JUDGED));
    gate.armSelfWake('agent', 60);
    gate.onInferenceStarted('agent'); // a turn cancels a pending self-wake
    gate.onInferenceEnded('agent');
    assert.deepStrictEqual(gate.upcomingWakes(['agent']), []);
    gate.setSleep(300, undefined, 'agent');
    const [wake] = gate.upcomingWakes(['agent']);
    assert.strictEqual(wake!.what, 'the end of its sleep');
    gate.dispose();
  });
});

describe('judge rules without a judge', () => {
  it('wake as a debounce of the same quiet period, and gate_status says so', async () => {
    const { gate, wakes } = makeGate(writeConfig('unwired.json', JUDGED));
    assert.ok(gate.getStatus().errors.some((e) => e.includes('wires no reply judge')));
    gate.evaluate(chat('hello'));
    await sleep(160);
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });
});

describe('wake_add_rule with judge', () => {
  it('saves a judge rule with the agent\'s instructions, and refuses one whose instructions sit outside judge', async (t) => {
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane, createMockResponse } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-'));
    const configPath = join(dir, 'gate.json');
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      modules: [],
      gate: { configPath, config: { default: 'defer', policies: [{ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }] } },
    });
    t.after(async () => {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const call = async (input: Record<string, unknown>) => {
      membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'add', name: 'wake_add_rule', input }], 'tool_use'));
      membrane.pushResponse(createMockResponse([]));
      assert.strictEqual(framework.nudgeAgent('scout').ok, true);
      await framework.runUntilIdle();
      const [round] = membrane.lastStream!.receivedToolResults as Array<Array<{ content: string; isError: boolean }>>;
      return round![0]!;
    };

    const saved = await call({
      name: 'ambient',
      match: { tagsAny: ['chat:ambient'] },
      judge: { debounceMs: 20000, maxWaitMs: 120000, instructions: 'Wake me for questions.' },
    });
    assert.strictEqual(saved.isError, false, saved.content);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8')) as GateConfig;
    assert.deepStrictEqual(onDisk.policies.find((p) => p.name === 'ambient')!.behavior,
      { judge: { debounceMs: 20000, maxWaitMs: 120000, instructions: 'Wake me for questions.' } });

    const misplaced = await call({ name: 'loose', debounceMs: 20000, instructions: 'Wake me for questions.' });
    assert.strictEqual(misplaced.isError, true);
    assert.match(misplaced.content, /"instructions", a field of "judge"/);
  });
});

describe('the framework wires the reply judge', () => {
  async function frameworkWith(t: { after: (fn: () => Promise<void> | void) => void }, gate: Record<string, unknown>) {
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-wiring-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      modules: [],
      gate: { configPath: join(dir, 'gate.json'), ...gate },
    });
    t.after(async () => {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const eventGate = (framework as unknown as { eventGate: EventGate }).eventGate;
    return { framework, membrane, eventGate };
  }

  const until = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 200 && !check(); i++) await sleep(20);
    assert.ok(check(), label);
  };

  it("asks the host's membrane, on the judge's model, about the primary's context, and wakes it on reply", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane, eventGate } = await frameworkWith(t, {
      config: JUDGED,
      judge: { timeoutMs: 4321, onError: 'skip' },
    });
    // The host's options reach the gate.
    const internals = eventGate as unknown as { judgeTimeoutMs: number; judgeOnError: string };
    assert.strictEqual(internals.judgeTimeoutMs, 4321);
    assert.strictEqual(internals.judgeOnError, 'skip');

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'REPLY: asked directly' }]));
    membrane.pushResponse(createMockResponse([]));
    eventGate.evaluate(chat('is scout around?'));
    await until(() => membrane.calls.length >= 1, 'the judge called the membrane');
    const asked = membrane.calls[0]!;
    assert.strictEqual(asked.config.model, 'claude-haiku-5-5');
    assert.strictEqual(asked.assistantParticipant, 'reply-judge');
    assert.ok(asked.system!.includes('reply judge for an AI agent named scout'));
    const shown = asked.messages.map((m) => (m.content[0] as { text: string }).text).join('\n');
    assert.ok(shown.includes('You are scout.'), "the primary's previewed request is the document");
    assert.ok(shown.includes('is scout around?'));
    await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.reply === 1, 'the verdict was recorded');
    await framework.runUntilIdle();
    assert.ok(membrane.calls.length >= 2, 'the reply woke the agent for a turn');
  });

  it("tells the judge the agent's pending skip_reply timer", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { membrane, eventGate } = await frameworkWith(t, { config: JUDGED });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: it wakes itself soon' }]));
    eventGate.armSelfWake('scout', 600);
    eventGate.evaluate(chat('anyone?'));
    await until(() => membrane.calls.length >= 1, 'the judge called the membrane');
    const question = (membrane.calls[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.match(question, /<if_you_wait>\nIf you answer WAIT and nothing new arrives, scout is next woken by:\n- in 10 min: its own skip_reply timer\n<\/if_you_wait>/);
  });

  it('enabled: false leaves the judge unwired, and judge rules run as debounces', async (t) => {
    const { membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { enabled: false } });
    assert.ok(eventGate.getStatus().errors.some((e) => e.includes('wires no reply judge')));
    assert.strictEqual(membrane.calls.length, 0);
  });
});
