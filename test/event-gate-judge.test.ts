import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo, JudgeFn, JudgeRequest, JudgeVerdict } from '../src/gate/types.js';
import type { ToolDefinition } from '../src/types/index.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-judge');

function writeConfig(name: string, config: unknown): string {
  const path = join(TMP_DIR, name);
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LONGER_THAN_ANY_START_MS = 60_000;
async function until(done: () => boolean, what: string, withinMs = 5_000): Promise<void> {
  const by = Date.now() + withinMs;
  while (!done()) {
    if (Date.now() > by) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

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

function makeGate(configPath: string, opts: { judge?: JudgeFn; judgeTimeoutMs?: number; judgeOnError?: 'wake' | 'skip'; now?: () => number; residents?: string[] } = {}) {
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
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.residents ? { changesJudgedContext: (name: string) => opts.residents!.includes(name) } : {}),
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
    await until(() => judge.waiting() === 1, 'the judge is asked');
    assert.strictEqual(judge.requests.length, 1);
    const req = judge.requests[0]!;
    assert.strictEqual(req.policyName, 'ambient');
    assert.strictEqual(req.instructions, 'Wake me for questions.');
    assert.deepStrictEqual(req.events.map((e) => e.content), ['is anyone around?', 'anyone?']);
    assert.strictEqual(req.events[0]!.channel, '#garden (c1)');
    assert.deepStrictEqual(req.agentNames, ['agent']);
    assert.strictEqual(wakes.length, 0, 'no wake before the verdict');

    judge.answer({ reply: true, reason: 'a direct question', inputTokens: 1234 });
    await until(() => wakes.length === 1, 'the wake');
    assert.deepStrictEqual(wakes, [{ agentName: 'agent', reason: 'gate:debounce' }]);
    assert.strictEqual(messages.length, 1);
    const verdict = traces.find((t) => t.type === 'gate:judge-verdict');
    assert.ok(verdict);
    assert.strictEqual(verdict.verdict, 'reply');
    assert.strictEqual(verdict.woke, true);
    assert.strictEqual('reason' in verdict, false, "the judge's reason isn't traced");
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 1, wait: 0, error: 0 });
    assert.strictEqual(state.last!.reason, 'a direct question');
    assert.strictEqual(state.last!.inputTokens, 1234);
    gate.dispose();
  });

  it('keeps the judge\'s reason in its status on one line, its openings marked', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('reason.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('lol'));
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: false, reason: 'they said\n[drafts] all deleted' });
    await until(() => gate.getStatus().policies[0]?.judgeState?.last !== undefined, 'the verdict is recorded');
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.last!.reason, 'they said \\[drafts] all deleted');
    gate.dispose();
  });

  it('wait lets the batch go by: no wake, no message', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages } = makeGate(writeConfig('wait.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('lol'));
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: false, reason: 'banter between others' });
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the verdict');
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(messages.length, 0);
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 0, wait: 1, error: 0 });
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
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.fail(new Error('provider down'));
      await until(() => wakes.length === 1, 'the wake');
    } finally {
      console.error = original;
    }
    assert.strictEqual(wakes.length, 1);
    assert.ok(errors.some((e) => (e as unknown[]).map(String).join(' ').includes('provider down')), 'the failure is logged');
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.last!.verdict, 'error');
    gate.dispose();
  });

  it('a judge that takes too long is timed out, its request aborted, and the agent woken', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('timeout.json', JUDGED), { judge: judge.fn, judgeTimeoutMs: 50 });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await until(() => judge.requests[0]?.signal.aborted === true && wakes.length === 1, 'the judge to be timed out and the agent woken', LONGER_THAN_ANY_START_MS);
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
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.answer({ reason: 'hm' } as unknown as JudgeVerdict);
      await until(() => wakes.length === 1, 'the wake');
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
    await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the batch held');
    assert.strictEqual(judge.requests.length, 0, 'not judged mid-turn');
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 1, 'the judge is asked after the turn');
    judge.answer({ reply: true, reason: 'ok' });
    await until(() => wakes.length === 1, 'the wake');
    gate.dispose();
  });

  it("a resident's turn that starts while the judge decides stops it, and its batch is judged once after the turn", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('midturn.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('hello'));
    await until(() => judge.requests.length === 1, 'the judge to be asked');
    gate.onInferenceStarted('agent');
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0, 'a stopped call wakes nothing');
    assert.strictEqual(judge.requests.length, 1, 'not judged again mid-turn');
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 0, error: 0 }, 'a stopped call is no verdict and no error');
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 2, 'the judge to be asked after the turn');
    judge.answer({ reply: false, reason: 'already answered' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(judge.requests.length, 2, 'one call after the turn');
    gate.dispose();
  });

  it('...and a verdict reached after a turn that started and ended while the judge read is that later call\'s alone', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('between.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('hello'));
    await until(() => judge.requests.length === 1, 'the judge to be asked');
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 2, 'the judge to be asked after the turn');
    judge.answer({ reply: false, reason: 'stale' });
    judge.answer({ reply: true, reason: 'still' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(judge.requests.length, 2);
    gate.dispose();
  });

  it("a co-resident's turn stops the judge too, since the residents share the context it reads", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('coresident.json', JUDGED), { judge: judge.fn, residents: ['agent', 'helper'] });
    gate.evaluate(chat('hello'));
    await until(() => judge.requests.length === 1, 'the judge to be asked');
    gate.onInferenceStarted('helper');
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    gate.onInferenceEnded('helper');
    await until(() => judge.requests.length === 2, 'the judge to be asked after the turn');
    judge.answer({ reply: true, reason: 'stopped, so ignored' });
    judge.answer({ reply: false, reason: 'helper answered' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 1, error: 0 });
    gate.dispose();
  });

  it("a resident's turn resumed while the judge decides stops it too", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('resumed.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('hello'));
    await until(() => judge.requests.length === 1, 'the judge to be asked');
    gate.onInferenceResumed('agent');
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 2, 'the judge to be asked after the turn');
    gate.dispose();
  });

  it("a stopped call's batch keeps the events queued behind it, and they're judged together after the turn", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('stop-queued.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.requests.length === 1, 'the judge to be asked');
    gate.evaluate(chat('second'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the second batch to queue behind the first');
    assert.strictEqual(judge.requests.length, 1, 'premise: the second batch waits behind the first');
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 2, 'the judge to be asked after the turn');
    assert.deepStrictEqual(judge.requests[1]!.events.map((e) => e.content), ['first', 'second']);
    gate.dispose();
  });

  it("a fork's or the subconscious's turn neither holds a judge rule's batch nor stops the judge", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('fork-turn.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.onInferenceStarted('fork');
    gate.evaluate(chat('hello'));
    await until(() => judge.requests.length === 1, "the judge to be asked while the fork's turn runs");
    gate.onInferenceStarted('subconscious');
    assert.strictEqual(judge.requests[0]!.signal.aborted, false);
    judge.answer({ reply: true, reason: 'asked' });
    await sleep(10);
    assert.strictEqual(judge.requests.length, 1, 'not judged again');
    assert.strictEqual(wakes.length, 0, 'the wake waits, as every batched wake does, while any turn runs');
    gate.onInferenceEnded('fork');
    gate.onInferenceEnded('subconscious');
    await until(() => wakes.length === 1, 'the wake');
    gate.dispose();
  });

  it('a quiesce stops the judge deciding now, and its batch is judged at resume', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('quiesce.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.setQuiesced(true);
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.heldCount, 1);
    gate.setQuiesced(false);
    await until(() => judge.requests.length === 2, 'the judge is asked at resume');
    judge.answer({ reply: true, reason: 'now' });
    await until(() => wakes.length === 1, 'the wake');
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
      await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 100, 'the batch held');
    } finally {
      console.error = original;
    }
    assert.strictEqual(gate.inferenceDiagnostics().droppedJudgeEvents, 50);
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 1, 'the judge is asked after the turn');
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
      await until(() => judge.waiting() === 1, 'the judge is asked');
      assert.strictEqual(judge.requests[0]!.events.length, 100);
      for (let i = 0; i < 120; i++) gate.evaluate(chat(`b${i}`));
      await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the b batch to queue behind the call');
    } finally {
      console.error = original;
    }
    judge.answer({ reply: false, reason: 'not yet' });
    await until(() => judge.requests.length === 2, 'the queued batch to be judged');
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
        await until(() => judge.waiting() === 1, 'the judge is asked');
        judge.fail(new Error('400 model not found'));
        await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.error === i + 1, 'the failure counted');
      }
    } finally {
      console.error = original;
    }
    assert.ok(gate.getStatus().errors.some((e) => e.includes('failed its last 3 requests') && e.includes('400 model not found')));
    gate.evaluate(chat('ok'));
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: false, reason: 'fine' });
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the verdict');
    assert.ok(!gate.getStatus().errors.some((e) => e.includes('failed its last')));
    gate.dispose();
  });

  it('a judge that made no call, refused under a hold, decides by onError and counts no failure', async () => {
    const refusal = Object.assign(new Error("scout's provider calls are held"), { providerAdmission: 'deferred' as const });
    const { gate, wakes, traces } = makeGate(writeConfig('refused.json', JUDGED), { judge: async () => { throw refusal; } });
    for (let i = 0; i < 3; i++) {
      gate.evaluate(chat(`hello ${i}`));
      await until(() => wakes.length === i + 1, 'the fail-open wake');
    }
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 0, error: 0 });
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('reply judge has failed')), false, 'gate_status names no failing judge');
    assert.strictEqual(traces.some((t) => t.type === 'gate:judge-verdict'), false);
    gate.dispose();
  });

  it('a refused call under the default onError wakes the agent with the events queued behind it', async () => {
    const refusal = Object.assign(new Error("scout's provider calls are held"), { providerAdmission: 'deferred' as const });
    const judge = scriptedJudge();
    const { gate, wakes, messages } = makeGate(writeConfig('refused-queued.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    gate.evaluate(chat('second'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the second event to queue behind the call');
    judge.fail(refusal);
    await until(() => wakes.length === 1, 'the wake');
    assert.match(JSON.stringify(messages.at(-1)!.content), /Gate: 2 events matched/);
    gate.dispose();
  });

  it("under onError 'skip', a refused call wakes nothing, the events queued behind it are judged next, and the rule's history stays as it was", async () => {
    const refusal = Object.assign(new Error("scout's provider calls are held"), { providerAdmission: 'deferred' as const });
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('refused-skip.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the first judge call');
    judge.fail(new Error('provider down'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.error === 1, 'the failure to be counted');
    gate.evaluate(chat('second'));
    await until(() => judge.waiting() === 1, 'the second judge call');
    gate.evaluate(chat('third'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the third event to queue behind the call');
    judge.fail(refusal);
    await until(() => judge.waiting() === 1, 'the queued event to be judged');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['third']);
    assert.strictEqual(wakes.length, 0);
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 0, wait: 0, error: 1 });
    assert.strictEqual(state.last?.reason, 'provider down');
    judge.answer({ reply: false, reason: 'nothing for the agent' });
    gate.dispose();
  });

  it('a null verdict from a custom judge decides by onError rather than dropping the batch', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('null.json', JUDGED), { judge: judge.fn });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.answer(null as unknown as JudgeVerdict);
      await until(() => wakes.length === 1, 'the wake');
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
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.evaluate(chat('two'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the second batch to queue behind the call');
    assert.strictEqual(judge.requests.length, 1, 'one request at a time per rule');
    judge.answer({ reply: true, reason: 'ok' });
    await until(() => wakes.length === 1, 'the wake');
    assert.strictEqual(judge.requests.length, 1);
    gate.dispose();
  });

  it('...and judged afresh on wait', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('queued-wait.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('one'));
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.evaluate(chat('two'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the second batch to queue behind the call');
    judge.answer({ reply: false, reason: 'not yet' });
    await until(() => judge.requests.length === 2, 'the queued batch to be judged');
    assert.deepStrictEqual(judge.requests[1]!.events.map((e) => e.content), ['two']);
    judge.answer({ reply: true, reason: 'now' });
    await until(() => wakes.length === 1, 'the wake');
    gate.dispose();
  });

  it('maxWaitMs judges a batch that keeps getting pushed back, counted on the gate\'s clock from its first event', async () => {
    let clock = 1_000_000;
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('maxwait.json', {
      policies: [{ name: 'busy', match: {}, behavior: { judge: { debounceMs: 60_000, maxWaitMs: 180_000 } } }],
    }), { judge: judge.fn, now: () => clock });
    for (let i = 0; i < 3; i++) {
      gate.evaluate(chat(`m${i}`));
      clock += 60_000;
      await sleep(30);
    }
    assert.strictEqual(judge.requests.length, 0, 'not judged before the cap');
    gate.evaluate(chat('m3'));
    await until(() => judge.requests.length === 1, 'the judge to be asked at the cap, before the quiet period');
    assert.strictEqual(judge.requests[0]!.events.length, 4);
    gate.dispose();
  });

  it('dispose aborts a judge deciding now, and its verdict delivers nothing', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('dispose.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.dispose();
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
  });
});

describe('judge rules changed or removed while a batch waits', () => {
  it("a batch held for a resident's turn is judged by the rule's instructions as they are when the turn ends", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('changed-held.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.onInferenceStarted('agent');
    gate.evaluate(chat('lol'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the batch to be held for the turn');
    gate.addPolicy({ name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100, instructions: 'Wake me for jokes.' } } });
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 1, 'the judge to be asked after the turn');
    assert.strictEqual(judge.requests[0]!.instructions, 'Wake me for jokes.');
    gate.dispose();
  });

  it('a rule removed while its judge call is out: the late verdict still decides its batch, and leaves no record for a rule of the same name', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('removed-inflight.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, 'the judge to be asked');
    assert.strictEqual(gate.removePolicy('ambient'), true);
    judge.answer({ reply: true, reason: 'asked' });
    await until(() => wakes.length === 1, 'the wake');
    gate.addPolicy({ name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } });
    assert.deepStrictEqual(gate.getStatus().policies.find((p) => p.name === 'ambient')!.judgeState!.verdicts, { reply: 0, wait: 0, error: 0 });
    gate.dispose();
  });
});

describe('judge rules: mentions and rule order', () => {
  const addressed = (content: string) => chat(content, { tags: ['chat:addressed'] });

  it('a mention the judge rule matches goes to the judge with its batch, marked as addressing the agent', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('addressed.json', JUDGED), { judge: judge.fn });
    assert.strictEqual(gate.probe(addressed('agent?')).trigger, false, 'the probe says it batches');
    assert.strictEqual(gate.evaluate(addressed('agent, are you there?')).trigger, false);
    await until(() => judge.requests.length === 1, 'the batch to go to the judge');
    assert.deepStrictEqual(judge.requests[0]!.events.map((e) => [e.content, e.addressed]), [['agent, are you there?', true]]);
    gate.dispose();
  });

  it("a mention rule ahead of the judge rule wakes the agent without the judge; its turn stops the judge deciding the earlier batch, which is judged after the turn", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('addressed-ahead.json', {
      policies: [
        { name: 'mentions', match: { tagsAny: ['chat:addressed'] }, behavior: 'always' },
        ...JUDGED.policies,
      ],
    }), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('lol'));
    await until(() => judge.waiting() === 1, 'the judge to decide the first batch');
    const decision = gate.evaluate(addressed('agent?'));
    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.policyName, 'mentions');
    assert.strictEqual(gate.getStatus().policies[1]!.judgeState!.pendingCount, 0, 'the mention joins no batch');
    gate.onInferenceStarted('agent');
    assert.strictEqual(judge.requests[0]!.signal.aborted, true, "the mention's turn stops the judge");
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 2, 'the batch to be judged after the turn');
    assert.deepStrictEqual(judge.requests[1]!.events.map((e) => e.content), ['lol']);
    judge.answer({ reply: true, reason: 'stopped, so ignored' });
    judge.answer({ reply: false, reason: 'the turn answered it' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    gate.dispose();
  });

  it('leaves a debounce rule, and a judge rule with no judge wired, to their quiet period, and the probe agrees', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const debounced = makeGate(writeConfig('addressed-debounce.json', {
      policies: [{ name: 'batched', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } }],
    }), { judge: scriptedJudge().fn });
    assert.strictEqual(debounced.gate.probe(addressed('agent?')).trigger, false);
    assert.strictEqual(debounced.gate.evaluate(addressed('agent?')).trigger, false);
    t.mock.timers.tick(99);
    assert.strictEqual(debounced.wakes.length, 0, 'not before its 100 ms quiet period');
    t.mock.timers.tick(1);
    assert.strictEqual(debounced.wakes.length, 1, 'at its quiet period');
    debounced.gate.dispose();
    const unwired = makeGate(writeConfig('addressed-unwired.json', JUDGED));
    assert.strictEqual(unwired.gate.probe(addressed('agent?')).trigger, false);
    assert.strictEqual(unwired.gate.evaluate(addressed('agent?')).trigger, false);
    t.mock.timers.tick(99);
    assert.strictEqual(unwired.wakes.length, 0, 'not before its 100 ms quiet period');
    t.mock.timers.tick(1);
    assert.strictEqual(unwired.wakes.length, 1, 'at its quiet period');
    unwired.gate.dispose();
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
    await until(() => judge.waiting() === 1, 'the judge is asked');
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

  it("counts a batch's due time on the gate's clock", () => {
    let clock = 1_000_000;
    const { gate } = makeGate(writeConfig('upcoming-clock.json', {
      policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } }],
    }), { now: () => clock });
    gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    clock += 1_000;
    gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.at), [1_001_000 + 60_000]);
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
    await until(() => wakes.length === 1, 'the wake');
    gate.dispose();
  });
});

async function judgeFramework(t: { after: (fn: () => Promise<void>) => void }, judge?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { AgentFramework } = await import('../src/index.js');
  const { MockMembrane, createMockResponse } = await import('./helpers/mock-membrane.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'gate-judge-'));
  const configPath = join(dir, 'gate.json');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    modules: [],
    gate: {
      configPath,
      config: { default: 'defer', policies: [{ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }] },
      ...(judge ? { judge } : {}),
    },
    ...extra,
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
  // The definition the agent reads: wake rules are in the host's built-in
  // toolset, out of the request's tool list, so it's read as that toolset
  // lists it for this agent (its own presentation applied).
  const host = (framework as unknown as { hostPresentation: { builtinTools(agent: string): ToolDefinition[] } }).hostPresentation;
  const toolNamed = (name: string) => host.builtinTools('scout').find((tool) => tool.name === name)!;
  const wakeAddRule = () => toolNamed('wake_add_rule');
  return { framework, membrane, configPath, call, wakeAddRule, toolNamed };
}

describe('wake_add_rule with judge', () => {
  it('saves a judge rule with the agent\'s instructions, and refuses one whose instructions sit outside judge', async (t) => {
    const { readFileSync } = await import('node:fs');
    const { configPath, call, wakeAddRule, toolNamed } = await judgeFramework(t, {});

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

    const tool = wakeAddRule();
    assert.ok((tool.inputSchema.properties as Record<string, unknown>).judge, 'the tool takes judge');
    const examples = [...tool.description.matchAll(/`(\{ name: "[^`]+\})`/g)]
      .map((m) => new Function(`return (${m[1]});`)() as Record<string, unknown>);
    const example = examples.find((e) => e.name === 'ambient-judged')!;
    const shown = await call(example);
    assert.strictEqual(shown.isError, false, shown.content);
    assert.strictEqual(JSON.parse(shown.content).ignoredFields, undefined, 'every field the example gives is read');
    assert.match(toolNamed('wake_remove_rule').description, /A judge rule's batch.*still goes to the judge, by the rule as it was\./);
  });

  it("refuses a judge out of range in the agent's own terms: judge, not gate.json's behavior.judge", async (t) => {
    const { call } = await judgeFramework(t, {});
    const early = await call({ name: 'quick', judge: { debounceMs: 50 } });
    assert.strictEqual(early.isError, true);
    assert.match(early.content, /^Rule "quick" wasn't saved: judge\.debounceMs is 50 ms, under the 100 ms minimum/);
    assert.doesNotMatch(early.content, /behavior\.judge/);
  });

  it('a host that sets no GateOptions.judge has the judge wired, its defaults in force', async (t) => {
    const { framework } = await judgeFramework(t);
    const wakeAddRule = framework.getAllTools().find((tool) => tool.name === 'wake_add_rule')!;
    assert.ok(JSON.stringify(wakeAddRule).includes('"judge"'), 'the tool offers judge');
    const gate = (framework as unknown as { eventGate: { judgeFn?: unknown } }).eventGate;
    assert.strictEqual(typeof gate.judgeFn, 'function');
  });

  it('a host that turns the judge off (enabled: false) wires none: the tool offers none, and a judge it is given is not read', async (t) => {
    const { readFileSync } = await import('node:fs');
    const { framework, configPath, call, wakeAddRule, toolNamed } = await judgeFramework(t, { enabled: false });
    const given = await call({ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, judge: { debounceMs: 20000 } });
    assert.strictEqual(given.isError, true);
    assert.match(given.content, /got no behavior, so nothing was saved/);
    assert.doesNotMatch(given.content, /`judge`/);
    assert.match(given.content, /"judge"/, 'the refusal names the parameter it does not read');
    assert.strictEqual((JSON.parse(readFileSync(configPath, 'utf-8')) as GateConfig).policies.some((p) => p.name === 'ambient'), false);
    assert.strictEqual(JSON.stringify(wakeAddRule()).includes('judge'), false, 'nothing in the tool names the judge');
    assert.strictEqual(JSON.stringify(toolNamed('wake_remove_rule')).includes('judge'), false, 'nor in wake_remove_rule');
    const both = await call({ name: 'loud', match: { tagsAny: ['chat:ambient'] }, behavior: 'always', judge: { debounceMs: 20000 } });
    assert.strictEqual(both.isError, false, both.content);
    assert.strictEqual((JSON.parse(readFileSync(configPath, 'utf-8')) as GateConfig).policies.find((p) => p.name === 'loud')!.behavior, 'always');
    assert.ok(JSON.stringify(JSON.parse(both.content).ignoredFields).includes('judge'), both.content);
    const gate = (framework as unknown as { eventGate: { judgeFn?: unknown } }).eventGate;
    assert.strictEqual(gate.judgeFn, undefined);
  });

  it("the agent's turn doesn't wait for a judge call in flight", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane } = await judgeFramework(t, {});
    const complete = membrane.complete.bind(membrane);
    const hanging = new AbortController();
    let judging = false;
    (membrane as unknown as { complete: (r: { assistantParticipant?: string }, o?: { signal?: AbortSignal }) => Promise<unknown> }).complete =
      (request, options) => (request.assistantParticipant === 'reply-judge'
        ? new Promise((_, reject) => {
          judging = true;
          const stop = () => reject(new Error('aborted'));
          options?.signal?.addEventListener('abort', stop);
          hanging.signal.addEventListener('abort', stop);
        })
        : complete(request as never));
    t.after(() => hanging.abort());
    const judge = (framework as unknown as { eventGate: { judgeFn: JudgeFn } }).eventGate.judgeFn;
    const asked = judge({
      policyName: 'ambient',
      events: [{ eventType: 'mcpl:push-event', addressed: false, content: 'lol', at: Date.now() }],
      agentNames: ['scout'],
      signal: new AbortController().signal,
    }).catch(() => undefined);
    await until(() => judging, "the judge's call to be out");
    const before = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'here' }]));
    assert.strictEqual(framework.nudgeAgent('scout').ok, true);
    await Promise.race([framework.runUntilIdle(), sleep(3000)]);
    assert.ok(membrane.calls.length > before, 'the turn sent its request while the judge call was still out');
    hanging.abort();
    await asked;
  });

  it("the residents' turns change what the judge reads, and the subconscious's don't", async (t) => {
    const { framework } = await judgeFramework(t, {}, {
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' },
        { name: 'helper', model: 'test-model', systemPrompt: 'You are helper.', proseRouting: 'disabled' },
      ],
      subconscious: { enabled: true, systemPrompt: 'You watch.' },
    });
    const gate = (framework as unknown as { eventGate: { changesJudgedContextFn: (name: string) => boolean } }).eventGate;
    assert.ok(framework.getAgent('Subconscious') && framework.getAgent('helper'), 'premise: a co-resident and a subconscious run');
    assert.strictEqual(gate.changesJudgedContextFn('scout'), true);
    assert.strictEqual(gate.changesJudgedContextFn('helper'), true);
    assert.strictEqual(gate.changesJudgedContextFn('Subconscious'), false);
  });

  it("a judge request's usage counts as the judged agent's", async (t) => {
    const { framework, membrane } = await judgeFramework(t, {});
    membrane.pushResponse({
      content: [{ type: 'text', text: 'WAIT: banter between others' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 300, outputTokens: 9 },
      details: { usage: { inputTokens: 300, outputTokens: 9, cacheReadTokens: 2000, cacheCreationTokens: 100 }, model: { actual: 'claude-haiku-5-5' } },
    } as never);
    const before = framework.getSessionUsage().byAgent.find((a) => a.agentName === 'scout');
    const judge = (framework as unknown as { eventGate: { judgeFn: JudgeFn } }).eventGate.judgeFn;
    const verdict = await judge({
      policyName: 'ambient',
      events: [{ eventType: 'mcpl:push-event', addressed: false, content: 'lol', at: Date.now() }],
      agentNames: ['scout'],
      signal: new AbortController().signal,
    });
    assert.strictEqual(verdict.reply, false, 'premise: the judge answered');
    const after = framework.getSessionUsage().byAgent.find((a) => a.agentName === 'scout');
    assert.ok(after, "the agent's usage has a tally");
    assert.strictEqual(after.inferenceCount - (before?.inferenceCount ?? 0), 1);
    assert.strictEqual(after.usage.inputTokens - (before?.usage.inputTokens ?? 0), 300);
    assert.strictEqual(after.usage.cacheReadTokens - (before?.usage.cacheReadTokens ?? 0), 2000);
    assert.strictEqual(after.usage.outputTokens - (before?.usage.outputTokens ?? 0), 9);
  });

  it("a judge call that fails records its model's wait and holds nothing else: the agent's turn still goes out, and the next judge call is refused", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework, membrane } = await judgeFramework(t, {}, { providerHold: () => ({ holdMs: 60_000, reason: 'weekly quota spent' }) });
    let judgeCalls = 0;
    const complete = membrane.complete.bind(membrane);
    (membrane as unknown as { complete: (r: { assistantParticipant?: string }) => Promise<unknown> }).complete = async (request) => {
      if (request.assistantParticipant !== 'reply-judge') return complete(request as never);
      judgeCalls++;
      throw new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 60_000, message: "This request would exceed your account's rate limit.", rawError: { status: 429 } });
    };
    const internal = framework as unknown as {
      eventGate: { judgeFn: JudgeFn };
      providerAccelerationCooldowns: Map<string, unknown>;
      providerWaits?: { active(agentName: string, model: string): unknown };
    };
    const request = () => internal.eventGate.judgeFn({
      policyName: 'ambient',
      events: [{ eventType: 'mcpl:push-event', addressed: false, content: 'lol', at: Date.now() }],
      agentNames: ['scout'],
      signal: new AbortController().signal,
    });
    await assert.rejects(request(), /rate limit/);
    assert.strictEqual(internal.providerAccelerationCooldowns.size, 0, 'no hold on the agent, though the host would grant one');
    assert.ok(internal.providerWaits!.active('scout', 'claude-haiku-5-5'), "the judge's model waits");
    assert.ok(!internal.providerWaits!.active('scout', 'test-model'), "the agent's own model doesn't");
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const streams = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'here' }]));
    assert.strictEqual(framework.nudgeAgent('scout').ok, true);
    await Promise.race([framework.runUntilIdle(), sleep(3_000)]);
    assert.ok(membrane.calls.length > streams, "the agent's turn sent its request");
    const refused = await request().then(() => undefined, (err: unknown) => err);
    assert.strictEqual((refused as { providerAdmission?: unknown } | undefined)?.providerAdmission, 'deferred');
    assert.strictEqual(judgeCalls, 1, 'the second judge call is refused without being made');
  });

  it('a judge call the gate stops is no provider failure: it arms no hold', async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework, membrane } = await judgeFramework(t, {}, { providerHold: () => ({ holdMs: 60_000, reason: 'weekly quota spent' }) });
    let inFlight = false;
    (membrane as unknown as { complete: (r: unknown, o?: { signal?: AbortSignal }) => Promise<unknown> }).complete = (_request, options) =>
      new Promise((_, reject) => {
        inFlight = true;
        options?.signal?.addEventListener('abort', () =>
          reject(new MembraneError({ type: 'abort', retryable: false, message: 'Request was aborted', rawError: undefined })));
      });
    const internal = framework as unknown as { eventGate: { judgeFn: JudgeFn }; providerAccelerationCooldowns: Map<string, unknown> };
    const stop = new AbortController();
    const asked = internal.eventGate.judgeFn({
      policyName: 'ambient',
      events: [{ eventType: 'mcpl:push-event', addressed: false, content: 'lol', at: Date.now() }],
      agentNames: ['scout'],
      signal: stop.signal,
    });
    await until(() => inFlight, "the judge's call to be out");
    stop.abort();
    await assert.rejects(asked, /aborted/);
    assert.strictEqual(internal.providerAccelerationCooldowns.size, 0);
  });

  it("a judge call withdrawn under a surgery's hold is marked as made without a call, which the gate counts as no failure", async (t) => {
    const { framework, membrane } = await judgeFramework(t, {});
    let calls = 0;
    (membrane as unknown as { complete: () => Promise<unknown> }).complete = async () => { calls++; throw new Error('no call expected'); };
    const internal = framework as unknown as { eventGate: { judgeFn: JudgeFn }; surgeryHold: { verb: string; agentName: string } | null };
    internal.surgeryHold = { verb: 'undo', agentName: 'scout' };
    const refused = await internal.eventGate.judgeFn({
      policyName: 'ambient',
      events: [{ eventType: 'mcpl:push-event', addressed: false, content: 'lol', at: Date.now() }],
      agentNames: ['scout'],
      signal: new AbortController().signal,
    }).then(() => undefined, (err: unknown) => err);
    internal.surgeryHold = null;
    assert.match(String((refused as Error)?.message), /withdrawn/);
    assert.strictEqual((refused as { providerAdmission?: unknown }).providerAdmission, 'deferred');
    assert.strictEqual(calls, 0);
  });

  it("a judge call on a model the provider holds is refused without being made, and the agent's own model isn't held", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework, membrane } = await judgeFramework(t, {});
    let calls = 0;
    (membrane as unknown as { complete: () => Promise<unknown> }).complete = async () => { calls++; throw new Error('no call expected'); };
    const internal = framework as unknown as {
      eventGate: { judgeFn: JudgeFn };
      recordProviderWait(agentName: string, model: string, error: Error): unknown;
      providerWaits?: { active(agentName: string, model: string): unknown };
    };
    const wait = new MembraneError({ type: 'rate_limit', retryable: true, retryAfterMs: 60_000, message: 'slow down', rawError: { status: 429 } });
    assert.ok(internal.recordProviderWait('scout', 'claude-haiku-5-5', wait), "premise: the judge's model waits");
    const refused = await internal.eventGate.judgeFn({
      policyName: 'ambient',
      events: [{ eventType: 'mcpl:push-event', addressed: false, content: 'lol', at: Date.now() }],
      agentNames: ['scout'],
      signal: new AbortController().signal,
    }).then(() => undefined, (err: unknown) => err);
    assert.strictEqual((refused as { providerAdmission?: unknown } | undefined)?.providerAdmission, 'deferred');
    assert.strictEqual(calls, 0);
    assert.ok(!internal.providerWaits!.active('scout', 'test-model'), "the agent's own model isn't held");
  });

  it('under a hold on the whole agent, the judge makes no call, and records nothing', async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework, membrane } = await judgeFramework(t, {}, { providerHold: () => ({ holdMs: 60_000, reason: 'weekly quota spent' }) });
    let calls = 0;
    (membrane as unknown as { complete: () => Promise<unknown> }).complete = async () => { calls++; throw new Error('no call expected'); };
    const internal = framework as unknown as {
      eventGate: { judgeFn: JudgeFn };
      holdProviderAcceleration(agent: unknown, error: Error): boolean;
      providerAccelerationCooldowns: Map<string, { reason: string; failures: number }>;
    };
    const quota = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, message: 'quota', rawError: { status: 429 } });
    assert.strictEqual(internal.holdProviderAcceleration(framework.getAgent('scout'), quota), true, 'premise: the agent is held');
    const failures = internal.providerAccelerationCooldowns.get('scout')!.failures;
    await assert.rejects(internal.eventGate.judgeFn({
      policyName: 'ambient',
      events: [{ eventType: 'mcpl:push-event', addressed: false, content: 'lol', at: Date.now() }],
      agentNames: ['scout'],
      signal: new AbortController().signal,
    }), /held \(weekly quota spent\), so the reply judge makes none/);
    assert.strictEqual(calls, 0);
    assert.strictEqual(internal.providerAccelerationCooldowns.get('scout')!.failures, failures, 'the refusal counts no failure');
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
    const { membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: {} });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: it wakes itself soon' }]));
    eventGate.armSelfWake('scout', 600);
    eventGate.evaluate(chat('anyone?'));
    await until(() => membrane.calls.length >= 1, 'the judge called the membrane');
    const question = (membrane.calls[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.match(question, /<if_you_wait>\nIf you answer WAIT and nothing new arrives, scout is next woken by:\n- in 10 min: its own skip_reply timer\n<\/if_you_wait>/);
  });

  it("tells the judge the framework's own upcoming wakes, such as one already queued", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: {} });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: a wake is already queued' }]));
    (framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests.push({ agentName: 'scout', reason: 'a queued test wake' });
    eventGate.evaluate(chat('anyone?'));
    await until(() => membrane.calls.length >= 1, 'the judge called the membrane');
    const question = (membrane.calls[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.match(question, /scout is next woken by:\n- [^\n]*: a wake already queued \(a queued test wake\)\n/);
  });

  it("lists a turn a provider wait holds only when the wait has an end", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      recordProviderWait(agentName: string, model: string, error: Error): unknown;
      holdForProviderWait(agent: unknown, wait: unknown, requests: unknown[]): boolean;
      upcomingWakesFor(agentName: string): Array<{ at?: number; what: string }>;
      providerAccelerationCooldowns: Map<string, { until: number }>;
      getAgent(name: string): unknown;
    };
    const holdFor = (retryAfterMs: number) => {
      const wait = internal.recordProviderWait('scout', 'test-model', new MembraneError({
        type: 'rate_limit', retryable: true, retryAfterMs, message: 'slow down', rawError: { status: 429 },
      }));
      assert.ok(internal.holdForProviderWait(internal.getAgent('scout'), wait, [{ agentName: 'scout', reason: 'held', source: 'test', timestamp: Date.now() }]));
    };
    holdFor(60_000);
    const [held] = internal.upcomingWakesFor('scout');
    assert.ok(held?.what.includes('a turn held by a provider cooldown'), held?.what);
    assert.ok(Number.isFinite(held!.at));
    holdFor(Number.POSITIVE_INFINITY);
    assert.strictEqual(internal.providerAccelerationCooldowns.get('scout')!.until, Number.POSITIVE_INFINITY, 'premise: now held until released');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout'), []);
  });

  it('enabled: false leaves the judge unwired, and judge rules run as debounces', async (t) => {
    const { membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { enabled: false } });
    assert.ok(eventGate.getStatus().errors.some((e) => e.includes('wires no reply judge')));
    assert.strictEqual(membrane.calls.length, 0);
  });

  it('a judge option of null wires the judge, as leaving it out does', async (t) => {
    const { eventGate } = await frameworkWith(t, { config: JUDGED, judge: null });
    assert.ok(!eventGate.getStatus().errors.some((e) => e.includes('wires no reply judge')));
  });
});

describe('a mention rule ahead of a judge rule, end to end over an MCPL server', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
  const GENERAL = 'discord:g1:general';

  it("wakes the agent without the judge once its message is stored; its turn stops the judge deciding the judge rule's earlier batch, which is judged after the turn, and one turn runs", async (t) => {
    const { mkdtempSync, appendFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { AgentFramework } = await import('../src/index.js');
    const { MembraneError } = await import('@animalabs/membrane');
    const { MockMembrane, createMockResponse } = await import('./helpers/mock-membrane.js');
    const dir = mkdtempSync(join(tmpdir(), 'judge-mention-'));
    const commandPath = join(dir, 'commands.txt');
    writeFileSync(commandPath, '');
    const membrane = new MockMembrane();
    const judgeSignals: Array<AbortSignal | undefined> = [];
    (membrane as unknown as { complete: (r: unknown, o?: { signal?: AbortSignal }) => Promise<unknown> }).complete = (_request, options) => {
      judgeSignals.push(options?.signal);
      if (judgeSignals.length > 1) {
        return Promise.resolve({
          content: [{ type: 'text', text: 'WAIT: the turn answered it' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
          details: { usage: { inputTokens: 10, outputTokens: 5 }, model: { actual: 'claude-haiku-5-5' } },
        });
      }
      return new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new MembraneError({ type: 'abort', retryable: false, message: 'Request was aborted', rawError: undefined })));
      });
    };
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      gate: {
        configPath: join(dir, 'gate.json'),
        config: {
          default: 'skip',
          policies: [
            // Rules are read in order: the mention rule, ahead, wakes without the judge.
            { name: 'mentions', match: { tagsAny: ['chat:addressed'] }, behavior: 'always' },
            { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 100 } } },
          ],
        },
        judge: {},
      },
      mcplServers: [{
        id: 'discord', command: process.execPath, args: [FIXTURE],
        env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    t.after(async () => {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await until(() => registry.listChannelsRaw().length >= 2, 'channel registration', 15_000);

    appendFileSync(commandPath, `incoming ${GENERAL} m-1 ambient just chatting\n`);
    await until(() => judgeSignals.length === 1, "the judge to decide the ambient message's batch", 15_000);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'here' }]));
    appendFileSync(commandPath, `incoming ${GENERAL} m-2 addressed @scout are you around?\n`);
    await until(() => membrane.calls.length >= 1, 'the woken turn', 15_000);
    assert.ok(JSON.stringify(membrane.calls[0]!.messages).includes('are you around?'), 'the turn compiled with the mention in its context');
    assert.strictEqual(judgeSignals[0]!.aborted, true, "the turn stops the judge deciding the earlier batch");
    const gate = (framework as unknown as { eventGate: { getStatus(): { policies: Array<{ judgeState?: { verdicts: { wait: number } } }> } } }).eventGate;
    await until(() => gate.getStatus().policies[1]!.judgeState!.verdicts.wait === 1, 'the batch to be judged after the turn', 15_000);
    assert.strictEqual(judgeSignals.length, 2);
    await framework.runUntilIdle();
    assert.strictEqual(membrane.calls.length, 1, 'one turn');
    assert.strictEqual((framework as unknown as { providerAccelerationCooldowns: Map<string, unknown> }).providerAccelerationCooldowns.size, 0, 'the stopped call arms no hold');
  });
});
