import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import { firstSentence } from '../src/mcpl/tool-signature.js';
import { MAX_TIMER_MS } from '../src/deadline-timer.js';
import type { GateConfig, GateEventInfo, JudgeFn, JudgeRequest, JudgeVerdict } from '../src/gate/types.js';
import type { ToolDefinition } from '../src/types/index.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-judge');

function writeConfig(name: string, config: unknown): string {
  const path = join(TMP_DIR, name);
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

let clockMocked = false;

function useRealClock(): void {
  mock.timers.reset();
  clockMocked = false;
}

const STEP_MS = 5;

async function advance(ms: number): Promise<void> {
  if (!clockMocked) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  for (let stepped = 0; stepped < ms; stepped += STEP_MS) {
    mock.timers.tick(Math.min(STEP_MS, ms - stepped));
    await settle();
  }
}

const refusalEnd = (gate: EventGate): number => (gate as unknown as { judgeRefusal: { until: number } }).judgeRefusal.until;

async function lastMillisecond(end: number, before: () => void): Promise<void> {
  await advance(end - Date.now() - 1);
  before();
  await advance(1);
}

function answersTaken(gate: EventGate): () => number {
  const internal = gate as unknown as { finishJudging: (...args: unknown[]) => void };
  const finish = internal.finishJudging.bind(gate);
  let taken = 0;
  internal.finishJudging = (...args: unknown[]) => {
    taken++;
    finish(...args);
  };
  return () => taken;
}

async function until(done: () => boolean, what: string, withinMs = 5_000): Promise<void> {
  const by = Date.now() + withinMs;
  await settle();
  while (!done()) {
    if (Date.now() >= by) assert.fail(`timed out waiting for ${what}`);
    await advance(STEP_MS);
  }
}

async function idle(framework: { runUntilIdle(): Promise<unknown> }, what = 'the framework to be idle'): Promise<void> {
  let settled = false;
  let failure: unknown;
  void framework.runUntilIdle().then(() => { settled = true; }, (err: unknown) => { failure = err; settled = true; });
  await until(() => settled, what, 60_000);
  if (failure !== undefined) throw failure;
}

/** A judge whose verdicts the test hands out, one per request, in order. */
function scriptedJudge() {
  const requests: JudgeRequest[] = [];
  const askedAt: number[] = [];
  const pending: Array<{ resolve: (v: JudgeVerdict) => void; reject: (e: unknown) => void }> = [];
  const fn: JudgeFn = (request) => {
    requests.push(request);
    askedAt.push(Date.now());
    return new Promise<JudgeVerdict>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return {
    fn,
    requests,
    askedAt,
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
    answerAt(index: number, verdict: JudgeVerdict) {
      const [next] = pending.splice(index, 1);
      assert.ok(next, `a judge request is waiting at ${index}`);
      next.resolve(verdict);
    },
    failAt(index: number, err: unknown) {
      const [next] = pending.splice(index, 1);
      assert.ok(next, `a judge request is waiting at ${index}`);
      next.reject(err);
    },
    waiting: () => pending.length,
  };
}

function makeGate(configPath: string, opts: {
  judge?: JudgeFn; judgeTimeoutMs?: number; judgeOnError?: 'wake' | 'skip'; now?: () => number; residents?: string[];
  isHeld?: (serverId: string | undefined, channelId: string | undefined) => boolean;
  onTrace?: (trace: { type: string; [k: string]: unknown }) => void;
  getAgentNames?: () => string[];
} = {}) {
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const messages: Array<{ participant: string; content: unknown; metadata?: unknown }> = [];
  const wakes: Array<{ agentName: string; reason: string }> = [];
  const gate: EventGate = new EventGate({
    configPath,
    emitTrace: (e) => {
      traces.push(e as { type: string });
      opts.onTrace?.(e as { type: string });
    },
    addMessage: (p, c, m) => { messages.push({ participant: p, content: c, metadata: m }); return ''; },
    requestInference: (a, r) => wakes.push({ agentName: a, reason: r }),
    getAgentNames: opts.getAgentNames ?? (() => ['agent']),
    ...(opts.judge ? { judge: opts.judge } : {}),
    ...(opts.judgeTimeoutMs !== undefined ? { judgeTimeoutMs: opts.judgeTimeoutMs } : {}),
    ...(opts.judgeOnError ? { judgeOnError: opts.judgeOnError } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.residents ? { changesJudgedContext: (name: string) => opts.residents!.includes(name) } : {}),
    ...(opts.isHeld ? { isHeld: opts.isHeld } : {}),
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

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  clockMocked = true;
});
afterEach(() => {
  useRealClock();
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
    await advance(160);
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
    await advance(10);
    await until(() => wakes.length === 1, 'the wake');
    assert.deepStrictEqual(wakes, [{ agentName: 'agent', reason: 'gate:debounce' }]);
    assert.strictEqual(messages.length, 1);
    const verdict = traces.find((t) => t.type === 'gate:judge-verdict');
    assert.ok(verdict);
    assert.strictEqual(verdict.verdict, 'reply');
    assert.strictEqual(verdict.woke, true);
    assert.strictEqual('reason' in verdict, false, "the judge's reason isn't traced");
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 1, wait: 0, error: 0, refused: 0 });
    assert.strictEqual(state.last!.reason, 'a direct question');
    assert.strictEqual(state.last!.inputTokens, 1234);
    gate.dispose();
  });

  it('a wait on an event outside MCPL writes nothing either, as defer doesn\'t', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages } = makeGate(writeConfig('wait-module-event.json', {
      policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { judge: { debounceMs: 30 } } }],
    }), { judge: judge.fn });
    gate.evaluate({ content: 'notes.md changed', eventType: 'workspace:modified', serverId: 'workspace', channelId: '' });
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.answer({ reply: false, reason: 'nothing to answer' });
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the verdict applied');
    await advance(50);
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(wakes.length, 0);
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
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: false, reason: 'banter between others' });
    await advance(10);
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the verdict');
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(messages.length, 0);
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 0, wait: 1, error: 0, refused: 0 });
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
      await advance(160);
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.fail(new Error('provider down'));
      await advance(10);
      await until(() => wakes.length === 1, 'the wake');
    } finally {
      console.error = original;
    }
    assert.strictEqual(wakes.length, 1);
    assert.ok(errors.some((e) => (e as unknown[]).map(String).join(' ').includes('provider down')), 'the failure is logged');
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
      await advance(160);
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.fail(new Error('provider down'));
      await advance(10);
      await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.error === 1, 'the failure counted');
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
      await until(() => wakes.length === 1, 'the timed-out judge to wake the agent');
    } finally {
      console.error = original;
    }
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    assert.strictEqual(wakes.length, 1);
    // A verdict after the timeout changes nothing.
    judge.answer({ reply: true, reason: 'late' });
    await advance(10);
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
      await advance(160);
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.answer({ reason: 'hm' } as unknown as JudgeVerdict);
      await advance(10);
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
    await advance(160);
    await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the batch held');
    assert.strictEqual(judge.requests.length, 0, 'not judged mid-turn');
    gate.onInferenceEnded('agent');
    await advance(10);
    await until(() => judge.requests.length === 1, 'the judge is asked after the turn');
    judge.answer({ reply: true, reason: 'ok' });
    await advance(10);
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
    const taken = answersTaken(gate);
    judge.answer({ reply: true, reason: 'late' });
    await until(() => taken() === 1, "the gate to take the stopped call's late answer");
    assert.strictEqual(wakes.length, 0, 'a stopped call wakes nothing');
    assert.strictEqual(judge.requests.length, 1, 'not judged again mid-turn');
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 0, error: 0, refused: 0 }, 'a stopped call is no verdict and no error');
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 2, 'the judge to be asked after the turn');
    judge.answer({ reply: false, reason: 'already answered' });
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the WAIT verdict counted');
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
    const internal = gate as unknown as { finishJudging(...args: unknown[]): void };
    const finish = internal.finishJudging.bind(gate);
    let finished = 0;
    internal.finishJudging = (...args: unknown[]) => {
      finished++;
      finish(...args);
    };
    judge.answer({ reply: false, reason: 'stale' });
    judge.answer({ reply: true, reason: 'still' });
    await until(() => finished === 2, 'both answers to be handled');
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(judge.requests.length, 2);
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 1, wait: 0, error: 0, refused: 0 }, "only the later call's REPLY counts");
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
    const taken = answersTaken(gate);
    judge.answer({ reply: true, reason: 'stopped, so ignored' });
    judge.answer({ reply: false, reason: 'helper answered' });
    await until(() => taken() === 2 && gate.getStatus().policies.some((p) => p.judgeState?.verdicts.wait === 1), 'the gate to take both answers, the second as its WAIT');
    assert.strictEqual(wakes.length, 0);
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 1, error: 0, refused: 0 });
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
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.reply === 1, 'the REPLY verdict counted');
    assert.strictEqual(judge.requests.length, 1, 'not judged again');
    assert.strictEqual(wakes.length, 0, 'the wake waits, as every batched wake does, while any turn runs');
    gate.onInferenceEnded('fork');
    gate.onInferenceEnded('subconscious');
    await advance(10);
    await until(() => wakes.length === 1, 'the wake');
    gate.dispose();
  });

  it('a quiesce stops the judge deciding now, and its batch is judged at resume', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('quiesce.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.setQuiesced(true);
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    const taken = answersTaken(gate);
    judge.answer({ reply: true, reason: 'late' });
    await until(() => taken() === 1, "the gate to take the stopped call's late answer");
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.heldCount, 1);
    gate.setQuiesced(false);
    await advance(10);
    await until(() => judge.requests.length === 2, 'the judge is asked at resume');
    judge.answer({ reply: true, reason: 'now' });
    await advance(10);
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
      await advance(160);
      await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 100, 'the batch held');
    } finally {
      console.error = original;
    }
    assert.strictEqual(gate.inferenceDiagnostics().droppedJudgeEvents, 50);
    gate.onInferenceEnded('agent');
    await advance(10);
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
      await advance(160);
      await until(() => judge.waiting() === 1, 'the judge is asked');
      assert.strictEqual(judge.requests[0]!.events.length, 100);
      for (let i = 0; i < 120; i++) gate.evaluate(chat(`b${i}`));
      await advance(160);
      await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the b batch to queue behind the call');
    } finally {
      console.error = original;
    }
    judge.answer({ reply: false, reason: 'not yet' });
    await advance(10);
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
        await advance(160);
        await until(() => judge.waiting() === 1, 'the judge is asked');
        judge.fail(new Error('400 model not found'));
        await advance(10);
        await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.error === i + 1, 'the failure counted');
      }
    } finally {
      console.error = original;
    }
    assert.ok(gate.getStatus().errors.some((e) => e.includes('failed its last 3 requests') && e.includes('400 model not found')));
    gate.evaluate(chat('ok'));
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: false, reason: 'fine' });
    await advance(10);
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the verdict');
    assert.ok(!gate.getStatus().errors.some((e) => e.includes('failed its last')));
    gate.dispose();
  });

  const refusal = (text: string, retryAfterMs?: number) =>
    Object.assign(new Error(text), { providerAdmission: 'deferred' as const, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  const judgeState = (gate: EventGate) => gate.getStatus().policies[0]!.judgeState!;
  const logDuring = async (step: () => Promise<void>): Promise<string[]> => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await step();
    } finally {
      console.error = original;
    }
    return logged;
  };

  it('a refused call is traced and counted as a refusal, apart from failures, with its hold and stated end', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, traces } = makeGate(writeConfig('refused.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, 'the judge call');
    const refusedAt = Date.now();
    const logged = await logDuring(async () => {
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => wakes.length === 1, 'the fail-open wake');
    });
    const seenAt = Date.now();
    assert.ok(logged.some((l) => l.includes('so its batch of 1 event goes to delivery without the judge')), JSON.stringify(logged));
    const state = judgeState(gate);
    assert.deepStrictEqual(state.verdicts, { reply: 0, wait: 0, error: 0, refused: 1 });
    assert.strictEqual(state.last?.verdict, 'refused');
    assert.match(state.last?.reason ?? '', /provider calls are held/);
    const verdict = traces.find((t) => t.type === 'gate:judge-verdict')!;
    assert.strictEqual(verdict.verdict, 'refused');
    assert.strictEqual(verdict.woke, true);
    assert.match(String(verdict.hold), /provider calls are held/);
    assert.ok(Number(verdict.until) >= refusedAt + 60_000 && Number(verdict.until) <= seenAt + 60_000, `the trace's stated end: ${String(verdict.until)}`);
    const errors = gate.getStatus().errors;
    assert.strictEqual(errors.some((e) => e.includes('reply judge has failed')), false, 'gate_status names no failing judge');
    assert.ok(errors.some((e) => e.startsWith("The reply judge's calls are refused until") && e.includes('provider calls are held')
      && e.includes("Until then, each judge rule's batch is delivered without being judged, unless a turn or the host's quiesce holds it until after then, or it waits behind a call of its rule that the judge answers WAIT once its calls are no longer refused, when it's judged.")), JSON.stringify(errors));
    gate.dispose();
  });

  it("under onError 'wake', while a refusal's stated wait lasts, a batch wakes the agent unjudged without asking, and so does one held for a turn when the turn ends", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('refused-wake.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => wakes.length === 1, 'the refused batch wakes the agent');
    gate.evaluate(chat('second'));
    await until(() => wakes.length === 2, 'the next batch wakes the agent unjudged');
    gate.onInferenceStarted('agent');
    gate.evaluate(chat('third'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held for the turn');
    gate.onInferenceEnded('agent');
    await until(() => wakes.length === 3, "the turn-held batch wakes the agent at the turn's end");
    assert.strictEqual(judge.requests.length, 1, 'the judge was asked only the first time');
    assert.deepStrictEqual(judgeState(gate).verdicts, { reply: 0, wait: 0, error: 0, refused: 1 });
    gate.dispose();
  });

  it("under onError 'wake', while a refusal's stated wait lasts, the wake list gives a judge rule's batch due before the wait ends as delivered without the judge, as certain, and one due after it as going to the judge", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-wake-listed.json', {
      policies: [
        { name: 'soon', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } },
        { name: 'later', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 120_000 } } },
      ],
    }), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).verdicts.refused === 1, 'the refusal recorded');
    gate.evaluate(chat('second'));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    const due = (name: string) => (gate as unknown as { debounceTimers: Map<string, { dueAt: number }> }).debounceTimers.get(name)!.dueAt;
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain, w.at]), [
      ['rule "soon"\'s batch of 1 event, delivered without the judge while its calls are refused', true, due('soon')],
      ['rule "later"\'s batch of 1 event goes to the judge', false, due('later')],
    ]);
    gate.dispose();
  });

  it("under onError 'wake', while a refusal's stated wait lasts, a batch due while another agent's turn runs is delivered without the judge once that turn ends, as its entry says", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('refused-wake-other-turn.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).verdicts.refused === 1 && wakes.length === 1, 'the refused batch delivered');
    gate.evaluate(chat('second'));
    gate.onInferenceStarted('other');
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain]), [
      ['rule "ambient"\'s batch of 1 event, delivered without the judge while its calls are refused, at its due time or, if a turn is still running then, once none is', true],
    ]);
    const due = (gate as unknown as { debounceTimers: Map<string, { dueAt: number }> }).debounceTimers.get('ambient')!.dueAt;
    await advance(due - Date.now() + 50);
    assert.strictEqual(wakes.length, 1, 'not delivered at its due time while the other turn runs');
    gate.onInferenceEnded('other');
    await until(() => wakes.length === 2, 'delivered once the turn ends');
    assert.strictEqual(judge.requests.length, 1, 'without the judge');
    gate.dispose();
  });

  for (const releasedAt of ['before', 'after'] as const) {
    it(`under onError 'wake', a batch due while the host is quiesced through a refusal's stated wait is listed with the quiesce, and is ${releasedAt === 'before' ? 'delivered without the judge at the release, which comes before the wait ends' : 'sent to the judge at the release, which comes after the wait ends'}`, async () => {
      const judge = scriptedJudge();
      const { gate, wakes } = makeGate(writeConfig(`refused-wake-quiesced-${releasedAt}.json`, JUDGED), { judge: judge.fn, residents: ['agent'] });
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      judge.fail(refusal("scout's provider calls are held", 5_000));
      await until(() => judgeState(gate).verdicts.refused === 1 && wakes.length === 1, 'the refused batch delivered');
      gate.evaluate(chat('second'));
      gate.setQuiesced(true);
      assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain]), [[
        'rule "ambient"\'s batch of 1 event, delivered without the judge while its calls are refused, at its due time or, if the host is still quiesced then, once it isn\'t, unless the host\'s quiesce holds it past the refusal\'s end, which sends it to the judge', false,
      ]]);
      const end = refusalEnd(gate);
      await advance(releasedAt === 'before' ? 1_000 : end - Date.now() + 1_000);
      await until(() => judgeState(gate).heldCount === 1, 'the batch held through the quiesce');
      assert.strictEqual(wakes.length, 1, 'premise: nothing delivered while quiesced');
      assert.strictEqual(Date.now() < end, releasedAt === 'before', 'premise: the release comes on the side of the refusal\'s end named');
      gate.setQuiesced(false);
      if (releasedAt === 'before') {
        await until(() => wakes.length === 2, 'delivered at the release');
        assert.strictEqual(judge.requests.length, 1, 'without the judge');
      } else {
        await until(() => judge.requests.length === 2, 'the judge asked at the release');
        assert.deepStrictEqual(judge.requests[1]!.events.map((e) => e.content), ['second']);
        assert.strictEqual(wakes.length, 1, 'not delivered unjudged');
      }
      gate.dispose();
    });
  }

  it("under onError 'wake', a batch delivered without the judge while its calls are refused, whose delivery throws, is logged as a judge rule's batch", async () => {
    const judge = scriptedJudge();
    let failing = false;
    const { gate } = makeGate(writeConfig('refused-wake-throws.json', JUDGED), {
      judge: judge.fn, residents: ['agent'],
      isHeld: () => {
        if (failing) throw new Error('zz isHeld failed');
        return false;
      },
    });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).verdicts.refused === 1, 'the refusal recorded');
    gate.evaluate(chat('second'));
    failing = true;
    const logged = await logDuring(async () => { await advance(200); });
    assert.ok(logged.some((l) => l.includes("[gate] a judge rule's batch of 1 event couldn't be delivered") && l.includes('zz isHeld failed')), JSON.stringify(logged));
    assert.strictEqual(judge.requests.length, 1, 'premise: delivered without the judge');
    gate.dispose();
  });

  it("under onError 'wake', while a refusal's stated wait lasts, the wake list counts only a batch's events whose channel isn't held now, and leaves out a batch with none", async () => {
    const judge = scriptedJudge();
    let tunedOut = false;
    const { gate } = makeGate(writeConfig('refused-wake-held.json', {
      policies: [
        { name: 'soon', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } },
        { name: 'quiet', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 100 } } },
      ],
    }), { judge: judge.fn, residents: ['agent'], isHeld: (serverId, channelId) => tunedOut && serverId === 'discord' && channelId === 'c-held' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).verdicts.refused === 1, 'the refusal recorded');
    gate.evaluate(chat('second'));
    gate.evaluate(chat('third', { channelId: 'c-held' }));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c-held' });
    tunedOut = true;
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain]), [
      ['rule "soon"\'s batch of 1 event, delivered without the judge while its calls are refused', true],
    ]);
    gate.dispose();
  });

  it("under onError 'skip', while a refusal's stated wait lasts, the wake list gives a judge rule's batch due before the wait ends as held for the judge until the end, and one due after it as going to the judge", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-skip-listed.json', {
      policies: [
        { name: 'soon', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } },
        { name: 'later', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 120_000 } } },
      ],
    }), { judge: judge.fn, judgeOnError: 'skip', residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).heldCount === 1, 'the refused batch held');
    gate.evaluate(chat('second'));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    const end = (gate as unknown as { judgeRefusal: { until: number } }).judgeRefusal.until;
    const later = (gate as unknown as { debounceTimers: Map<string, { dueAt: number }> }).debounceTimers.get('later')!.dueAt;
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain, w.at]), [
      ['rule "soon"\'s batch of 1 event, which joins its held batch when it fires, held for the judge while its calls are refused', false, end],
      ['rule "soon"\'s batch of 1 event, held for the judge while its calls are refused', false, end],
      ['rule "later"\'s batch of 1 event goes to the judge', false, later],
    ]);
    gate.dispose();
  });

  it("under onError 'wake', while a refusal's stated wait lasts and a turn runs, the wake list gives a batch due before the wait ends as one that may go to the judge, and a batch the turn holds as delivered without it only if the refusal still holds then", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-wake-turn-listed.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).verdicts.refused === 1, 'the refusal recorded');
    gate.evaluate(chat('second'));
    const listed = () => gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain]);
    assert.deepStrictEqual(listed(), [['rule "ambient"\'s batch of 1 event, delivered without the judge while its calls are refused', true]], 'premise: certain while no turn runs');
    gate.onInferenceStarted('agent');
    assert.deepStrictEqual(listed(), [[
      'rule "ambient"\'s batch of 1 event, delivered without the judge while its calls are refused, at its due time or, if a turn is still running then, once none is, unless a turn holds it past the refusal\'s end, which sends it to the judge', false,
    ]]);
    await until(() => judgeState(gate).heldCount === 1, 'the batch held for the turn');
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain, w.when]), [[
      'rule "ambient"\'s batch of 1 event, held for the judge, or delivered without it if its calls are still refused then', false, 'once no turn or quiesce holds it',
    ]]);
    gate.dispose();
  });

  it("under onError 'skip', while a refusal's stated wait lasts and a turn runs, the wake list says a batch is held past the wait's end while the turn holds it", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-skip-turn-listed.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).heldCount === 1, 'the refused batch held');
    gate.evaluate(chat('second'));
    const end = (gate as unknown as { judgeRefusal: { until: number } }).judgeRefusal.until;
    const held = 'held for the judge while its calls are refused';
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.what), [
      `rule "ambient"'s batch of 1 event, which joins its held batch when it fires, ${held}`,
      `rule "ambient"'s batch of 1 event, ${held}`,
    ], 'premise: no turn runs');
    gate.onInferenceStarted('agent');
    const past = " and, past the refusal's end, while a turn holds it";
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain, w.at]), [
      [`rule "ambient"'s batch of 1 event, which joins its held batch when it fires, ${held}${past}`, false, end],
      [`rule "ambient"'s batch of 1 event, ${held}${past}`, false, end],
    ]);
    gate.dispose();
  });

  const deciding = async (onError: 'wake' | 'skip', name: string, waitMs = 60_000, laterChannel = 'c2') => {
    const judge = scriptedJudge();
    const made = makeGate(writeConfig(`refused-deciding-${name}.json`, {
      policies: [
        { name: 'soon', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } },
        { name: 'deciding', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 100 } } },
      ],
    }), { judge: judge.fn, judgeOnError: onError, residents: ['agent'] });
    const { gate } = made;
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    await until(() => judge.waiting() === 1, "the deciding rule's call");
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 2, "the other rule's call");
    judge.failAt(1, refusal("scout's provider calls are held", waitMs));
    await until(() => judgeState(gate).verdicts.refused === 1, 'the refusal recorded');
    gate.evaluate({ content: 'again', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: laterChannel });
    const internal = gate as unknown as { debounceTimers: Map<string, { dueAt: number }>; judging: Map<string, { queued: unknown[] }>; judgeRefusal: { until: number } };
    const listed = gate.upcomingWakes(['agent']).find((w) => w.what.startsWith('rule "deciding"\'s batch'));
    const before = made.messages.length;
    const delivered = () => made.messages.length > before;
    const held = () => gate.getStatus().policies.find((p) => p.name === 'deciding')!.judgeState!.heldCount;
    const asked = () => judge.requests.map((r) => [r.policyName, r.events.map((e) => e.content)]);
    return { ...made, judge, internal, listed, due: internal.debounceTimers.get('deciding')!.dueAt, end: internal.judgeRefusal.until, delivered, held, asked };
  };
  const decidingWake = 'rule "deciding"\'s batch of 1 event, delivered without the judge while its calls are refused, at its due time or, if the judge is still deciding the rule\'s batch then, once it decides, unless the judge answers WAIT when its calls are no longer refused, which sends it to the judge';
  const decidingSkip = 'rule "deciding"\'s batch of 1 event, held for the judge while its calls are refused, unless the judge\'s REPLY to the rule\'s batch it is deciding delivers it first';

  it("under onError 'wake', a batch of a rule the judge is deciding, while another agent's turn runs, is listed as delivered once the judge decides and once no turn runs, since it needs both", async () => {
    const { gate } = await deciding('wake', 'wake-both');
    gate.onInferenceStarted('zz-other');
    const listed = gate.upcomingWakes(['agent']).find((w) => w.what.startsWith('rule "deciding"\'s batch'));
    assert.ok(listed?.what.includes("if the judge is still deciding the rule's batch then, once it decides and, if a turn is still running then, once none is"), listed?.what);
    gate.onInferenceEnded('zz-other');
    gate.dispose();
  });

  for (const order of ['fired first', 'decided first'] as const) {
    it(`under onError 'wake', while a refusal's stated wait lasts, a batch of a rule the judge is deciding is listed as one that may be delivered at its due time or once the judge decides, and is delivered so when the call is decided before that wait ends (${order})`, async () => {
      const { gate, judge, internal, listed, due, delivered } = await deciding('wake', `wake-${order.replace(' ', '-')}`);
      assert.deepStrictEqual([listed?.what, listed?.certain, listed?.at], [decidingWake, false, due]);
      if (order === 'fired first') {
        await until(() => (internal.judging.get('deciding')?.queued.length ?? 0) === 1, 'the batch waits behind the call');
        assert.ok(Date.now() >= due, 'premise: past its due time');
        assert.strictEqual(delivered(), false, 'not delivered at its due time while the judge decides');
        judge.answer({ reply: false, reason: 'nothing to answer' });
        await until(delivered, 'delivered once the judge decides');
      } else {
        judge.answer({ reply: false, reason: 'nothing to answer' });
        await until(() => !internal.judging.has('deciding'), 'the deciding call done');
        assert.strictEqual(delivered(), false, 'premise: not yet due');
        await until(delivered, 'delivered at its due time');
        assert.ok(Date.now() >= due);
      }
      assert.strictEqual(judge.requests.length, 2, 'without the judge');
      gate.dispose();
    });

    it(`under onError 'skip', while a refusal's stated wait lasts, a batch of a rule the judge is deciding is listed as held until the end unless a REPLY delivers it first, and a WAIT leaves it held (${order})`, async () => {
      const { gate, judge, internal, listed, end, delivered, held } = await deciding('skip', `skip-${order.replace(' ', '-')}`);
      assert.deepStrictEqual([listed?.what, listed?.certain, listed?.at], [decidingSkip, false, end]);
      if (order === 'fired first') await until(() => (internal.judging.get('deciding')?.queued.length ?? 0) === 1, 'the batch waits behind the call');
      assert.strictEqual(held(), 0, 'premise: nothing of the rule held yet');
      judge.answer({ reply: false, reason: 'nothing to answer' });
      await until(() => held() === 1, 'held for the judge');
      assert.strictEqual(delivered(), false);
      assert.strictEqual(judge.requests.length, 2);
      gate.dispose();
    });
  }

  it("under onError 'skip', while a refusal's stated wait lasts, a REPLY to a rule's batch the judge is deciding delivers a later batch of that rule with it", async () => {
    const { gate, judge, internal, delivered, held, messages } = await deciding('skip', 'skip-reply', 60_000, 'c3');
    await until(() => (internal.judging.get('deciding')?.queued.length ?? 0) === 1, 'the batch waits behind the call');
    judge.answer({ reply: true, reason: 'asked' });
    await until(delivered, 'delivered with the batch the REPLY wakes for');
    const text = (messages.at(-1)!.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /: 2 events matched\]/, "the call's batch and the one behind it");
    assert.match(text, /- 1 message in [^\n]*c2/, "the call's batch, from c2");
    assert.match(text, /- 1 message in [^\n]*c3/, 'the batch behind it, from c3');
    assert.strictEqual(held(), 0);
    gate.dispose();
  });

  it("under onError 'skip', while a refusal that stated no end holds a rule's batch, the wake list says the rule's next batch takes the held one in when it fires", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-no-end-joins.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    gate.evaluate(chat('second'));
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.what), [
      'rule "ambient"\'s batch of 1 event, which joins its held batch when it fires, goes to the judge',
      'rule "ambient"\'s batch of 1 event, held for the judge',
    ]);
    await until(() => judge.waiting() === 1, 'the next batch asked');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second'], 'premise: the ask takes the held batch in');
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  for (const onError of ['wake', 'skip'] as const) {
    it(`under onError '${onError}', a batch of a rule the judge is deciding goes to the judge when the call answers WAIT after the refusal's stated wait has ended`, async () => {
      const { gate, judge, internal, listed, due, end, delivered, held, asked } = await deciding(onError, `${onError}-outlasted`, 1_000);
      assert.deepStrictEqual([listed?.what, listed?.certain, listed?.at], onError === 'wake' ? [decidingWake, false, due] : [decidingSkip, false, end]);
      await until(() => (internal.judging.get('deciding')?.queued.length ?? 0) === 1, 'the batch waits behind the call');
      await advance(end - Date.now() + 20);
      assert.ok(Date.now() > end, "premise: the refusal's stated wait has ended");
      const before = onError === 'wake'
        ? [['deciding', ['hi']], ['soon', ['first']]]
        : [['deciding', ['hi']], ['soon', ['first']], ['soon', ['first']]];
      assert.deepStrictEqual(asked(), before, "premise: the calls asked before the WAIT, under \"skip\" with the other rule's held batch judged at the wait's end");
      assert.strictEqual(delivered(), false, 'premise: not delivered while the judge decides');
      judge.answer({ reply: false, reason: 'nothing to answer' });
      await until(() => judge.requests.length === before.length + 1, 'the batch asked about');
      assert.deepStrictEqual(asked(), [...before, ['deciding', ['again']]]);
      assert.strictEqual(delivered(), false, 'not delivered');
      assert.strictEqual(held(), 0, 'not held');
      gate.dispose();
    });
  }

  it("lists a judge rule's batch as debounced when no judge is wired, since it's delivered as a debounce's is", () => {
    const { gate } = makeGate(writeConfig('no-judge-listed.json', JUDGED), { residents: ['agent'] });
    gate.evaluate(chat('hello'));
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain]), [['rule "ambient"\'s debounced batch of 1 event', true]]);
    gate.dispose();
  });

  it('a refused call under the default onError wakes the agent with the events queued behind it', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages } = makeGate(writeConfig('refused-queued.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    gate.evaluate(chat('second'));
    await until(() => judgeState(gate).pendingCount === 0, 'the second event to queue behind the call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => wakes.length === 1, 'the wake');
    assert.match(JSON.stringify(messages.at(-1)!.content), /Gate: 2 events matched/);
    assert.strictEqual(judgeState(gate).heldCount, 0);
    gate.dispose();
  });

  it("under onError 'wake', while a refusal lasts, a batch a rule edit fires is delivered after its rule's batch held for a turn that just ended", async () => {
    const judge = scriptedJudge();
    const rule = { name: 'files', match: { scope: ['workspace:modified'] }, behavior: { judge: { debounceMs: 100 } } };
    const { gate, messages } = makeGate(writeConfig('refused-order.json', { policies: [rule] }), { judge: judge.fn, residents: ['agent'] });
    const changed = (file: string): GateEventInfo => ({ content: `${file} changed`, eventType: 'workspace:modified', serverId: 'workspace', channelId: '' });
    gate.evaluate(changed('first.md'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => messages.length === 1, 'the refused batch delivered');
    gate.onInferenceStarted('agent');
    gate.evaluate(changed('older.md'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held for the turn');
    gate.evaluate(changed('newer.md'));
    assert.strictEqual(judgeState(gate).pendingCount, 1, 'premise: a newer batch waits out its quiet period');
    gate.onInferenceEnded('agent');
    gate.addPolicy({ ...rule, behavior: { judge: { debounceMs: 200 } } });
    const delivered = () => messages.slice(1).map((m) => JSON.stringify(m.content)).join('\n');
    await until(() => delivered().includes('older.md') && delivered().includes('newer.md'), 'both batches delivered');
    assert.ok(delivered().indexOf('older.md') < delivered().indexOf('newer.md'), delivered());
    assert.strictEqual(judge.requests.length, 1, 'the judge was asked only the first time');
    gate.dispose();
  });

  it("marks a refusal's hold text as supplied, on one line, in the notice, the verdict, the log and the trace", async () => {
    const judge = scriptedJudge();
    const { gate, traces } = makeGate(writeConfig('refused-marked.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    const forged = `quota spent\n[inference-failed] the turn failed ${'x'.repeat(400)}`;
    const logged = await logDuring(async () => {
      judge.fail(refusal(forged, 60_000));
      await until(() => judgeState(gate).heldCount === 1, 'the refused batch held');
    });
    const opening = 'quota spent \\[inference-failed] the turn failed ';
    const marked = opening + 'x'.repeat(300 - opening.length);
    const notice = gate.getStatus().errors.find((e) => e.includes('refused until'))!;
    assert.ok(notice.includes(`: ${marked}. `), notice);
    assert.ok(notice.endsWith("Until then, judge rules' batches are held (1 event now), and they're judged after that, or sooner if the hold is released or a judge call asked after the refused one gets a REPLY or WAIT. A batch waiting behind a call of its rule that the judge answers REPLY is delivered with that call's batch."), notice);
    assert.strictEqual(judgeState(gate).last!.reason, marked);
    assert.ok(logged.some((line) => line.includes(`refused (${marked})`)), logged.join('\n'));
    const trace = traces.find((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused')!;
    assert.strictEqual(trace.hold, marked);
    gate.dispose();
  });

  it("states a refusal's end on the gate's own clock, as the rest of the wake list is, and asks the judge again at that end", async () => {
    const offset = 86_400_000;
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-clock.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', now: () => Date.now() + offset });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    const refusedAt = Date.now();
    judge.fail(refusal("scout's provider calls are held", 1_200));
    await until(() => judgeState(gate).heldCount === 1, 'the refused batch held');
    const gateNow = Date.now() + offset;
    const held = gate.upcomingWakes(['agent']).find((w) => w.what.includes('held for the judge while its calls are refused'));
    assert.ok(held?.at !== undefined, JSON.stringify(gate.upcomingWakes(['agent'])));
    assert.ok(held.at > gateNow + 1_000 && held.at <= gateNow + 1_200, `due ${held.at - gateNow} ms after the gate's now`);
    await lastMillisecond(refusalEnd(gate) - offset, () => assert.strictEqual(judge.requests.length, 1, 'not asked a millisecond before the stated wait ends'));
    await until(() => judge.waiting() === 1, "the held batch to be judged at the refusal's end");
    assert.ok(judge.askedAt[1]! - refusedAt >= 1_200, `asked again ${judge.askedAt[1]! - refusedAt} ms on, not before the stated wait ends`);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under onError 'skip', a refused call holds its batch, with the events queued behind it, and the judge decides it once the refusal's stated wait ends", async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages, traces } = makeGate(writeConfig('refused-skip.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    gate.evaluate(chat('second'));
    await until(() => judgeState(gate).pendingCount === 0, 'the second event to queue behind the call');
    const refusedAt = Date.now();
    judge.fail(refusal('claude-haiku-5-5 is held for scout', 1_200));
    await until(() => judgeState(gate).heldCount === 2, 'the batch and its queue to be held');
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(traces.filter((t) => t.type === 'gate:judge-verdict').at(-1)!.woke, false);
    assert.ok(gate.getStatus().errors.some((e) => e.includes('claude-haiku-5-5 is held for scout')
      && e.includes("judge rules' batches are held (2 events now), and they're judged after that, or sooner if the hold is released")), JSON.stringify(gate.getStatus().errors));
    await lastMillisecond(refusalEnd(gate), () => assert.strictEqual(judge.requests.length, 1, 'not asked a millisecond before the stated wait ends'));
    await until(() => judge.waiting() === 1, 'the held batch to be judged once the wait ends');
    assert.ok(judge.askedAt[1]! - refusedAt >= 1_200, `asked again ${judge.askedAt[1]! - refusedAt} ms on, not before the stated wait ends`);
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
    judge.answer({ reply: true, reason: 'a question' });
    await until(() => wakes.length === 1, 'the wake');
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('claude-haiku-5-5 is held for scout')), false, 'the refusal is over');
    assert.match(JSON.stringify(messages.at(-1)!.content), /Gate: 2 events matched/);
    assert.deepStrictEqual(judgeState(gate).verdicts, { reply: 1, wait: 0, error: 0, refused: 1 });
    gate.dispose();
  });

  it("under 'skip', a batch refused again when it's judged again is held again, to the new refusal's end", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('refused-again.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 1_000));
    await until(() => judge.waiting() === 1, "the batch judged again at the refusal's end", 4_000);
    const againAt = Date.now();
    judge.fail(refusal("scout's provider calls are held", 1_000));
    await until(() => judgeState(gate).verdicts.refused === 2, 'the second refusal recorded');
    await lastMillisecond(refusalEnd(gate), () => assert.strictEqual(judge.requests.length, 2, "not asked a millisecond before the second refusal's end"));
    await until(() => judge.waiting() === 1, "judged once the second refusal ends");
    assert.ok(judge.askedAt[2]! - againAt >= 1_000, `held to the second refusal's end (${judge.askedAt[2]! - againAt} ms)`);
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first']);
    judge.answer({ reply: false, reason: 'chatter' });
    await advance(20);
    assert.strictEqual(wakes.length, 0);
    assert.deepStrictEqual(judgeState(gate).verdicts, { reply: 0, wait: 1, error: 0, refused: 2 });
    gate.dispose();
  });

  it("under 'skip', a batch that arrives while a refusal's stated wait holds joins the held batch without asking the judge", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-joins.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    const refusedAt = Date.now();
    judge.fail(refusal("scout's provider calls are held", 1_500));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    gate.evaluate(chat('second'));
    await until(() => judgeState(gate).heldCount === 2, 'the new batch to join the held one');
    await lastMillisecond(refusalEnd(gate), () => assert.strictEqual(judge.requests.length, 1, 'not asked a millisecond before the wait ends'));
    await until(() => judge.waiting() === 1, 'both judged once the wait ends');
    assert.ok(judge.askedAt[1]! - refusedAt >= 1_500, `asked again ${judge.askedAt[1]! - refusedAt} ms after the refusal`);
    assert.strictEqual(judge.requests.length, 2, 'the judge was not asked between');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
    judge.answer({ reply: false, reason: 'chatter' });
    assert.strictEqual(judgeState(gate).verdicts.refused, 1);
    gate.dispose();
  });

  it("under 'skip', a refusal that states no end holds its batch, and one that fires during a turn, through the turn's end, until the framework says a hold ended", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-no-end.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    assert.ok(gate.getStatus().errors.some((e) => e.includes('stated no end')
      && e.includes("The refusal sets no time to ask again: judge rules' held batches (1 event now) are judged once a judge call made after this gets a REPLY or WAIT, or when the hold is released, as an operator's release of a provider wait or a surgery's end does. A new batch whose call fails is dropped without waking the agent, and so are the held events it took in.")), JSON.stringify(gate.getStatus().errors));
    gate.onInferenceStarted('agent');
    gate.evaluate(chat('during'));
    await until(() => judgeState(gate).heldCount === 2, 'the batch that fired during the turn held with it');
    gate.onInferenceEnded('agent');
    await advance(100);
    assert.strictEqual(judge.requests.length, 1, "a turn's end doesn't ask again");
    gate.providerCallsReleased();
    await until(() => judge.waiting() === 1, 'the held batch judged once a hold ends');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'during']);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("a batch whose send to the judge throws after it took in its rule's held batch is logged with every event it drops", async () => {
    const judge = scriptedJudge();
    let failing = 0;
    const { gate } = makeGate(writeConfig('held-unsent.json', JUDGED), {
      judge: judge.fn,
      judgeOnError: 'skip',
      getAgentNames: () => {
        if (failing > 0) { failing--; throw new Error('no agents yet'); }
        return ['agent'];
      },
    });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    failing = 1;
    const logged = await logDuring(async () => {
      gate.evaluate(chat('second'));
      await advance(150);
    });
    assert.ok(logged.includes('[gate] Rule "ambient": its pending batch of 2 events couldn\'t be sent to the judge (no agents yet), so the batch is dropped'), logged.join('\n'));
    assert.strictEqual(judgeState(gate).heldCount, 0);
    assert.strictEqual(judge.requests.length, 1, 'premise: no second call was asked');
    gate.dispose();
  });

  it("under 'skip', a batch asked while a refusal with no end holds its rule's batch takes the held events in, and a verdict on it ends the refusal", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-later-call.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    assert.ok(gate.getStatus().errors.some((e) => e.includes('stated no end')), 'gate_status names the refusal');
    gate.evaluate(chat('second'));
    await until(() => judge.waiting() === 1, "the later batch's call");
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
    assert.strictEqual(judgeState(gate).heldCount, 0);
    judge.answer({ reply: false, reason: 'chatter' });
    await until(() => judgeState(gate).verdicts.wait === 1, 'the verdict applied');
    await advance(50);
    assert.strictEqual(judge.requests.length, 2, 'nothing is left to ask');
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('refused')), false, JSON.stringify(gate.getStatus().errors));
    gate.dispose();
  });

  const TWO_RULES = {
    policies: [
      { name: 'first', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 30 } } },
      { name: 'second', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 30 } } },
    ],
  };
  const elsewhere = (content: string): GateEventInfo => ({ content, eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });

  it("under 'skip', a batch asked while a refusal with no end holds its rule's batch keeps the newest 100 events of the two", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-take-in-cap.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    await logDuring(async () => {
      for (let i = 0; i < 60; i++) gate.evaluate(chat(`old ${i}`));
      await until(() => judge.waiting() === 1, 'the first call');
      judge.fail(refusal('a live surgery for scout holds the store'));
      await until(() => judgeState(gate).heldCount === 60, 'the refused batch held');
      for (let i = 0; i < 60; i++) gate.evaluate(chat(`new ${i}`));
      await until(() => judge.waiting() === 1, "the later batch's call");
    });
    const asked = judge.requests.at(-1)!.events.map((e) => e.content);
    assert.deepStrictEqual(asked, [...Array.from({ length: 40 }, (_, i) => `old ${i + 20}`), ...Array.from({ length: 60 }, (_, i) => `new ${i}`)]);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("while a rule's batch is held for a refusal with no end, the judge asked about another rule's batch is told what the held one waits for", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-listed.json', TWO_RULES), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, "first's call");
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, "first's batch held");
    gate.evaluate(elsewhere('hi'));
    await until(() => judge.waiting() === 1, "second's call");
    assert.deepStrictEqual(judge.requests.at(-1)!.upcomingWakes, [{
      certain: false, when: 'once a later judge call gets a REPLY or WAIT, or the hold on its calls is released, and no turn or quiesce holds it', what: 'rule "first"\'s batch of 1 event, held for the judge',
    }]);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("a verdict on a call asked before a refusal leaves the refusal standing", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-older-call.json', {
      policies: [
        { name: 'first', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 30 } } },
        { name: 'second', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 30 } } },
      ],
    }), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, "first's call");
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    await until(() => judge.waiting() === 2, "second's call, asked after first's");
    judge.failAt(1, refusal("scout's provider calls are held", 60_000));
    await until(() => gate.getStatus().policies[1]!.judgeState!.heldCount === 1, "second's batch held");
    judge.answer({ reply: false, reason: 'chatter' });
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, "first's verdict applied");
    await advance(50);
    assert.strictEqual(judge.requests.length, 2, "first's verdict doesn't re-ask the held batch");
    assert.ok(gate.getStatus().errors.some((e) => e.includes("The reply judge's calls are refused until")), 'the refusal stands');
    gate.dispose();
  });

  it("a verdict on a call asked after the refused one, though sent before the refusal came back, ends the refusal", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-later-asked.json', {
      policies: [
        { name: 'first', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 30 } } },
        { name: 'second', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 30 } } },
      ],
    }), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, "first's call");
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    await until(() => judge.waiting() === 2, "second's call, asked after first's");
    judge.failAt(0, refusal("scout's provider calls are held", 60_000));
    await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, "first's batch held");
    judge.answer({ reply: false, reason: 'chatter' });
    await until(() => judge.waiting() === 1, "first's held batch judged once second's verdict ends the refusal");
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['hello']);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under 'skip', a later call that fails leaves a refusal with no end standing", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-later-fails.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    gate.evaluate(chat('second'));
    await until(() => judge.waiting() === 1, "the later batch's call");
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
    judge.fail(new Error('provider down'));
    await until(() => judgeState(gate).verdicts.error === 1, 'the failure recorded');
    assert.ok(gate.getStatus().errors.some((e) => e.includes('stated no end')), JSON.stringify(gate.getStatus().errors));
    gate.dispose();
  });

  it("a release a trace listener makes as it hears of a refusal releases the refused batch", async () => {
    const judge = scriptedJudge();
    let release: (() => void) | undefined;
    const { gate } = makeGate(writeConfig('refused-release-in-trace.json', JUDGED), {
      judge: judge.fn, judgeOnError: 'skip',
      onTrace: (t) => { if (t.type === 'gate:judge-verdict' && t.verdict === 'refused') release?.(); },
    });
    release = () => gate.providerCallsReleased();
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('claude-haiku-5-5 is held for scout until released'));
    await until(() => judge.waiting() === 1, 'the refused batch judged on the release its trace prompted');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first']);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("an older call's refusal reported after a newer call's leaves the newer refusal standing", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-older-late.json', TWO_RULES), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, "first's call");
    gate.evaluate(elsewhere('hi'));
    await until(() => judge.waiting() === 2, "second's call, asked after first's");
    judge.failAt(1, refusal("scout's provider calls are held", 60_000));
    await until(() => gate.getStatus().policies[1]!.judgeState!.heldCount === 1, "second's batch held");
    const logged = await logDuring(async () => {
      judge.failAt(0, refusal('claude-haiku-5-5 is held for scout', 1_000));
      await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, "first's batch held");
    });
    assert.ok(logged.some((l) => l.includes("is held while the judge's calls are refused")), JSON.stringify(logged));
    await advance(1_300);
    assert.strictEqual(judge.requests.length, 2, "not asked again at the older refusal's end");
    const errors = gate.getStatus().errors;
    assert.ok(errors.some((e) => e.includes("scout's provider calls are held")), JSON.stringify(errors));
    assert.strictEqual(errors.some((e) => e.includes('claude-haiku-5-5 is held for scout')), false, JSON.stringify(errors));
    gate.dispose();
  });

  it("a refusal reported after a later-asked call's verdict holds nothing: its batch is asked again at once", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-after-verdict.json', TWO_RULES), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, "first's call");
    gate.evaluate(elsewhere('hi'));
    await until(() => judge.waiting() === 2, "second's call, asked after first's");
    judge.answerAt(1, { reply: false, reason: 'chatter' });
    await until(() => gate.getStatus().policies[1]!.judgeState!.verdicts.wait === 1, "second's verdict applied");
    const logged = await logDuring(async () => {
      judge.failAt(0, refusal("scout's provider calls are held", 60_000));
      await until(() => judge.waiting() === 1, "first's batch asked again", 1_000);
    });
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['hello']);
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('refused')), false, JSON.stringify(gate.getStatus().errors));
    assert.ok(logged.some((l) => l.includes('goes back to the judge')), JSON.stringify(logged));
    assert.ok(!logged.some((l) => l.includes('is held')), JSON.stringify(logged));
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("a refusal reported after the framework said a hold ended holds nothing: its batch is asked again at once", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-after-release.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    gate.providerCallsReleased();
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judge.waiting() === 1, 'the batch asked again', 1_000);
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first']);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("a batch refused again after taking in its rule's held batch is held whole, with the events queued behind it, in order", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-order-held.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('a1'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'a1 held');
    gate.evaluate(chat('a2'));
    await until(() => judge.waiting() === 1, "a2's call, which a refusal with no end allows");
    gate.evaluate(chat('a3'));
    await until(() => judgeState(gate).pendingCount === 0 && judge.requests.length === 2, 'a3 to queue behind a2');
    await advance(80);
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 3, 'a1, a2 and a3 held');
    gate.providerCallsReleased();
    await until(() => judge.waiting() === 1, 'the held batch judged');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['a1', 'a2', 'a3']);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under 'skip', a turn that ends while a refusal with an end holds leaves the held batch held", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-turn.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    const refusedAt = Date.now();
    judge.fail(refusal("scout's provider calls are held", 1_200));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await lastMillisecond(refusalEnd(gate), () => assert.strictEqual(judge.requests.length, 1, 'not asked a millisecond before the stated wait ends'));
    await until(() => judge.waiting() === 1, "judged at the refusal's end");
    assert.ok(judge.askedAt[1]! - refusedAt >= 1_200, `the turn's end sent nothing to a judge still refused (asked ${judge.askedAt[1]! - refusedAt} ms on)`);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under 'skip', a refusal whose stated wait is no finite number of ms states no end", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-infinite.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('claude-haiku-5-5 is held for scout until released', Infinity));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    assert.ok(gate.getStatus().errors.some((e) => e.includes('stated no end')), JSON.stringify(gate.getStatus().errors));
    await advance(1_300);
    assert.strictEqual(judge.requests.length, 1, 'not asked again while the hold lasts');
    gate.providerCallsReleased();
    await until(() => judge.waiting() === 1, 'judged once the hold is released');
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it('refusals between failures neither count toward the failing streak nor reset it', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-streak.json', JUDGED), { judge: judge.fn });
    const steps: unknown[] = [new Error('provider down'), refusal('a live surgery for scout holds the store'), new Error('provider down'), new Error('provider down')];
    for (const [i, step] of steps.entries()) {
      gate.evaluate(chat(`hello ${i}`));
      await until(() => judge.waiting() === 1, `judge call ${i}`);
      judge.fail(step);
      await advance(20);
    }
    assert.ok(gate.getStatus().errors.some((e) => e.includes('reply judge has failed its last 3 requests, refusals aside (the newest: ')), JSON.stringify(gate.getStatus().errors));
    gate.dispose();
  });

  it('a failing streak with no refusal in it keeps the plain words, and one with a refusal after its failures says refusals aside', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-streak-end.json', JUDGED), { judge: judge.fn });
    const failing = () => gate.getStatus().errors.find((e) => e.includes('reply judge has failed its last'));
    const steps: unknown[] = [new Error('provider down'), new Error('provider down'), new Error('provider down'), refusal('a live surgery for scout holds the store')];
    for (const [i, step] of steps.entries()) {
      gate.evaluate(chat(`hello ${i}`));
      await until(() => judge.waiting() === 1, `judge call ${i}`);
      judge.fail(step);
      await advance(20);
      if (i === 2) assert.ok(failing()?.includes('failed its last 3 requests (the newest: '), String(failing()));
    }
    assert.ok(failing()?.includes('failed its last 3 requests, refusals aside (the newest: '), String(failing()));
    gate.dispose();
  });

  it('a refusal before a failing streak, or inside one a success has ended since, leaves the streak its plain words', async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-streak-outside.json', JUDGED), { judge: judge.fn });
    const failing = () => gate.getStatus().errors.find((e) => e.includes('reply judge has failed its last'));
    const fail = new Error('provider down');
    const steps: Array<unknown | JudgeVerdict> = [
      refusal('a live surgery for scout holds the store'), fail, fail, fail,
      fail, refusal('a live surgery for scout holds the store'), { reply: false, reason: 'chatter' }, fail, fail, fail,
    ];
    for (const [i, step] of steps.entries()) {
      gate.evaluate(chat(`hello ${i}`));
      await until(() => judge.waiting() === 1, `judge call ${i}`);
      if (step && typeof step === 'object' && 'reply' in step) judge.answer(step as JudgeVerdict);
      else judge.fail(step);
      await advance(20);
      if (i === 3) assert.ok(failing()?.includes('failed its last 3 requests (the newest: '), `a refusal before the streak: ${String(failing())}`);
      if (i === 5) assert.ok(failing()?.includes('failed its last 4 requests, refusals aside (the newest: '), `premise: a refusal inside it: ${String(failing())}`);
    }
    assert.ok(failing()?.includes('failed its last 3 requests (the newest: '), `a fresh streak after a success: ${String(failing())}`);
    gate.dispose();
  });

  it("under onError 'wake', a refusal that states no end says each batch is still asked about", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('refused-wake-no-end.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => wakes.length === 1, 'the refused batch wakes the agent');
    assert.ok(gate.getStatus().errors.some((e) => e.includes('stated no end')
      && e.includes("Each judge rule's batch is still asked about, and is delivered without being judged if the call is refused.")), JSON.stringify(gate.getStatus().errors));
    gate.evaluate(chat('second'));
    await until(() => judge.waiting() === 1, 'the next batch is asked');
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under 'skip', a stated wait longer than one timer can run holds the batch rather than ask again at once, and one past what a date can name states no end", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-long.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    const delays: number[] = [];
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      delays.push(ms ?? 0);
      return timeout(handler, ms, ...args);
    }) as typeof setTimeout;
    try {
      judge.fail(refusal("scout's provider calls are held", 3_000_000_000));
      await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    } finally {
      globalThis.setTimeout = timeout;
    }
    assert.ok(gate.getStatus().errors.some((e) => e.includes("The reply judge's calls are refused until")), JSON.stringify(gate.getStatus().errors));
    assert.ok(delays.length > 0 && delays.every((ms) => ms <= MAX_TIMER_MS), `no timer is set past what Node can hold: ${delays.join(', ')}`);
    await advance(1_200);
    assert.strictEqual(judge.requests.length, 1, 'not asked again');
    gate.providerCallsReleased();
    await until(() => judge.waiting() === 1, 'asked once the hold is released');
    judge.fail(refusal("scout's provider calls are held", 1e16));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held again');
    assert.ok(gate.getStatus().errors.some((e) => e.includes('stated no end')), JSON.stringify(gate.getStatus().errors));
    gate.dispose();
  });

  it("a batch whose send reads a host clock that throws leaves its rule's held batch held, so the log counts only the batch it drops", async () => {
    let throwing = false;
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-throwing-clock.json', JUDGED), {
      judge: judge.fn, judgeOnError: 'skip',
      now: () => {
        if (throwing) throw new Error('zz clock');
        return Date.now();
      },
    });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    const internal = gate as unknown as { judgeBatch(policyName: string, events: unknown[], judge: unknown): void };
    throwing = true;
    try {
      assert.throws(() => internal.judgeBatch('ambient', [], { debounceMs: 100, instructions: 'Wake me for questions.' }), /zz clock/, "premise: the send reads the host's clock");
    } finally {
      throwing = false;
    }
    assert.strictEqual(judgeState(gate).heldCount, 1, 'the held batch is still held');
    gate.dispose();
  });

  it("a batch held for a refusal is never judged once the gate is disposed", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-dispose.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 1_000));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    gate.dispose();
    await advance(1_300);
    assert.strictEqual(judge.requests.length, 1);
  });

  it('a null verdict from a custom judge decides by onError rather than dropping the batch', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('null.json', JUDGED), { judge: judge.fn });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await advance(160);
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.answer(null as unknown as JudgeVerdict);
      await advance(10);
      await until(() => wakes.length === 1, 'the wake');
    } finally {
      console.error = original;
    }
    assert.strictEqual(wakes.length, 1);
    gate.dispose();
  });

  it('a batch that fires while the judge decides waits for the verdict: delivered with it on reply', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages } = makeGate(writeConfig('queued-reply.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('one'));
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.evaluate(chat('two', { channelId: 'c2', metadata: { authorId: 'u1', channelName: 'beds' } }));
    await advance(160);
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the second batch to queue behind the call');
    assert.strictEqual(judge.requests.length, 1, 'one request at a time per rule');
    judge.answer({ reply: true, reason: 'ok' });
    await advance(10);
    await until(() => wakes.length === 1, 'the wake');
    assert.strictEqual(judge.requests.length, 1);
    assert.strictEqual(messages.length, 1);
    const delivered = JSON.stringify(messages[0]!.content);
    assert.match(delivered, /Gate: 2 events matched/, 'the queued batch is delivered with the judged one');
    assert.ok(delivered.includes('#garden (c1)') && delivered.includes('#beds (c2)'), `each of the two events is delivered, each in its own channel: ${delivered}`);
    gate.dispose();
  });

  it('...and judged afresh on wait', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('queued-wait.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('one'));
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.evaluate(chat('two'));
    await advance(160);
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the second batch to queue behind the call');
    judge.answer({ reply: false, reason: 'not yet' });
    await advance(10);
    await until(() => judge.requests.length === 2, 'the queued batch to be judged');
    assert.deepStrictEqual(judge.requests[1]!.events.map((e) => e.content), ['two']);
    judge.answer({ reply: true, reason: 'now' });
    await advance(10);
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
      await advance(30);
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
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.dispose();
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    const taken = answersTaken(gate);
    judge.answer({ reply: true, reason: 'late' });
    await until(() => taken() === 1, "the gate to take the stopped call's late answer");
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

  const waiting = (instructions: string) => ({
    policies: [{ name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 60_000, instructions } } }],
  });

  it("a batch whose rule's instructions are edited in gate.json while it waits is judged by the edited instructions", async () => {
    const judge = scriptedJudge();
    const path = writeConfig('changed-reload.json', waiting('Wake me for questions.'));
    const { gate } = makeGate(path, { judge: judge.fn });
    gate.evaluate(chat('lol'));
    assert.strictEqual(judge.requests.length, 0, 'the batch waits on its debounce');
    writeFileSync(path, JSON.stringify(waiting('Wake me for jokes.'), null, 2));
    (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
    gate.evaluate(chat('another'));
    await until(() => judge.requests.length === 1, 'the changed rule\'s pending batch to go to the judge');
    assert.strictEqual(judge.requests[0]!.instructions, 'Wake me for jokes.');
    assert.deepStrictEqual(judge.requests[0]!.events.map((e) => e.content), ['lol']);
    gate.dispose();
  });

  it("a reload whose first cleared batch can't be sent to the judge still sends the rest, and logs the one it drops", async () => {
    const judge = scriptedJudge();
    const both = (instructions: string) => ({
      policies: [
        { name: 'first', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 60_000, instructions } } },
        { name: 'second', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 60_000, instructions } } },
      ],
    });
    const path = writeConfig('reload-unsent.json', both('Wake me for questions.'));
    let failing = 0;
    const { gate } = makeGate(path, {
      judge: judge.fn,
      getAgentNames: () => {
        if (failing > 0) { failing--; throw new Error('no agents yet'); }
        return ['agent'];
      },
    });
    gate.evaluate(chat('lol'));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    assert.strictEqual(judge.requests.length, 0, 'premise: both batches wait on their debounce');
    writeFileSync(path, JSON.stringify(both('Wake me for jokes.'), null, 2));
    (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
    failing = 1;
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    } finally {
      console.error = original;
    }
    await until(() => judge.requests.length === 1, "the second rule's batch to go to the judge");
    assert.deepStrictEqual(judge.requests[0]!.events.map((e) => e.content), ['hi']);
    assert.strictEqual(judge.requests[0]!.instructions, 'Wake me for jokes.');
    assert.ok(logged.includes('[gate] Rule "first": its pending batch of 1 event couldn\'t be sent to the judge (no agents yet), so the batch is dropped'), logged.join('\n'));
    gate.dispose();
  });

  it("a batch whose rule's instructions are rewritten through addPolicy, which wake_add_rule calls, while it waits is judged by the new instructions", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('changed-write.json', waiting('Wake me for questions.')), { judge: judge.fn });
    gate.evaluate(chat('lol'));
    gate.addPolicy({ name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 60_000, instructions: 'Wake me for jokes.' } } });
    await until(() => judge.requests.length === 1, 'the changed rule\'s pending batch to go to the judge');
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
    assert.deepStrictEqual(gate.getStatus().policies.find((p) => p.name === 'ambient')!.judgeState!.verdicts, { reply: 0, wait: 0, error: 0, refused: 0 });
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
    const taken = answersTaken(gate);
    judge.answer({ reply: true, reason: 'stopped, so ignored' });
    judge.answer({ reply: false, reason: 'the turn answered it' });
    await until(() => taken() === 2 && gate.getStatus().policies.some((p) => p.judgeState?.verdicts.wait === 1), 'the gate to take both answers, the second as its WAIT');
    assert.strictEqual(wakes.length, 0);
    gate.dispose();
  });

  it('leaves a debounce rule, and a judge rule with no judge wired, to their quiet period, and the probe agrees', () => {
    const debounced = makeGate(writeConfig('addressed-debounce.json', {
      policies: [{ name: 'batched', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } }],
    }), { judge: scriptedJudge().fn });
    assert.strictEqual(debounced.gate.probe(addressed('agent?')).trigger, false);
    assert.strictEqual(debounced.gate.evaluate(addressed('agent?')).trigger, false);
    mock.timers.tick(99);
    assert.strictEqual(debounced.wakes.length, 0, 'not before its 100 ms quiet period');
    mock.timers.tick(1);
    assert.strictEqual(debounced.wakes.length, 1, 'at its quiet period');
    debounced.gate.dispose();
    const unwired = makeGate(writeConfig('addressed-unwired.json', JUDGED));
    assert.strictEqual(unwired.gate.probe(addressed('agent?')).trigger, false);
    assert.strictEqual(unwired.gate.evaluate(addressed('agent?')).trigger, false);
    mock.timers.tick(99);
    assert.strictEqual(unwired.wakes.length, 0, 'not before its 100 ms quiet period');
    mock.timers.tick(1);
    assert.strictEqual(unwired.wakes.length, 1, 'at its quiet period');
    unwired.gate.dispose();
  });
});

describe('judge rules: what waiting leaves the agent with', () => {
  it("tells the judge the gate's own timers: a self-wake, other rules' batches, not the batch it judges", async () => {
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
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    const wakes = judge.requests[0]!.upcomingWakes!;
    assert.deepStrictEqual(wakes.map((w) => [w.what, w.certain]), [
      ['rule "files"\'s debounced batch of 1 event', true],
      ['rule "other-room"\'s batch of 1 event goes to the judge', false],
      ['its own skip_reply timer', true],
    ]);
    const selfWake = wakes.find((w) => w.what.includes('skip_reply'))!;
    assert.strictEqual(selfWake.at, t0 + 600_000);
    assert.ok(!wakes.some((w) => w.what.includes('"ambient"')), "the batch being judged isn't listed");
    gate.dispose();
  });

  it("tells the judge another judge rule's batch the judge is deciding, with what queued behind it", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming-deciding.json', {
      policies: [
        { name: 'first', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 50 } } },
        { name: 'second', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 400 } } },
      ],
    }), { judge: judge.fn });
    gate.evaluate(chat('hello'));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    await until(() => judge.requests.length === 1, "first's batch to go to the judge");
    assert.deepStrictEqual(judge.requests[0]!.upcomingWakes!.map((w) => [w.what, w.certain]), [
      ['rule "second"\'s batch of 1 event goes to the judge', false],
    ]);
    gate.evaluate(chat('and again'));
    await until(() => judge.requests.length === 2, "second's batch to go to the judge while first's is decided");
    assert.deepStrictEqual(judge.requests[1]!.upcomingWakes!.map((w) => [w.when, w.what, w.certain]), [
      ['once the judge decides it', 'rule "first"\'s batch of 1 event, with 1 event queued behind it, which the judge is deciding', false],
    ]);
    judge.answer({ reply: false, reason: 'chatter' });
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("tells the judge the events buffered behind a turn that doesn't change the context it reads, and upcomingWakes leaves out a given rule's", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming-buffered.json', {
      policies: [
        { name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 30 } },
        { name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 150 } } },
      ],
    }), { judge: judge.fn, residents: ['agent'] });
    gate.onInferenceStarted('fork');
    gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    gate.evaluate(chat('hello'));
    await until(() => judge.requests.length === 1, 'the judge rule\'s batch to go to the judge during the fork\'s turn');
    assert.strictEqual(gate.inferenceDiagnostics().bufferedEvents, 1, 'premise: the debounced batch is buffered behind the fork\'s turn');
    assert.deepStrictEqual(judge.requests[0]!.upcomingWakes!.map((w) => [w.when, w.what, w.certain]), [
      ["once no turn runs and the host isn't quiesced", '1 event buffered for delivery', true],
    ]);
    assert.deepStrictEqual(gate.upcomingWakes(['agent'], 'ambient').map((w) => w.what), ['1 event buffered for delivery']);
    assert.deepStrictEqual(gate.upcomingWakes(['agent'], 'files').map((w) => w.what), ['rule "ambient"\'s batch of 1 event, which the judge is deciding'], "rule files' buffered events are left out with it");
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("tells the judge each batch still held when the held batches are judged in turn", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming-held.json', {
      policies: [
        { name: 'first', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 30 } } },
        { name: 'second', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 30 } } },
      ],
    }), { judge: judge.fn, residents: ['agent'] });
    gate.onInferenceStarted('agent');
    gate.evaluate(chat('hello'));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    await until(() => gate.getStatus().policies.every((p) => p.judgeState!.heldCount === 1), 'both batches held for the turn');
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 2, 'both held batches to go to the judge');
    assert.deepStrictEqual(judge.requests[0]!.upcomingWakes!.map((w) => [w.what, w.certain]), [
      ['rule "second"\'s batch of 1 event, held for the judge', false],
    ]);
    assert.deepStrictEqual(judge.requests[1]!.upcomingWakes!.map((w) => [w.when, w.what, w.certain]), [
      ['once the judge decides it', 'rule "first"\'s batch of 1 event, which the judge is deciding', false],
    ]);
    judge.answer({ reply: false, reason: 'chatter' });
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("upcomingWakes, given a rule's name, leaves out that rule's batches, whether collected, decided or held", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming-except.json', {
      policies: [
        { name: 'first', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 50 } } },
        { name: 'second', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 120000 } } },
      ],
    }), { judge: judge.fn, residents: ['agent'] });
    const listed = (exceptPolicy?: string) => gate.upcomingWakes(['agent'], exceptPolicy).map((w) => w.what);
    gate.evaluate(chat('hello'));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    await until(() => judge.requests.length === 1, "first's batch to go to the judge");
    assert.deepStrictEqual(listed('first'), ['rule "second"\'s batch of 1 event goes to the judge']);
    assert.deepStrictEqual(listed('second'), ['rule "first"\'s batch of 1 event, which the judge is deciding']);
    gate.onInferenceStarted('agent');
    assert.deepStrictEqual(gate.upcomingWakes(['agent'], 'second'), [{ certain: false, when: 'once no turn or quiesce holds it', what: 'rule "first"\'s batch of 1 event, held for the judge' }]);
    assert.deepStrictEqual(listed('first'), ['rule "second"\'s batch of 1 event goes to the judge']);
    assert.deepStrictEqual(listed(), ['rule "second"\'s batch of 1 event goes to the judge', 'rule "first"\'s batch of 1 event, held for the judge'],
      'the wake with a time first, and the one due when no turn holds it last');
    gate.dispose();
  });

  it("lists events buffered while the host is quiesced, as certain, due once no turn runs and the host isn't quiesced", async () => {
    const { gate } = makeGate(writeConfig('upcoming-quiesced.json', {
      policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 30 } }],
    }));
    gate.setQuiesced(true);
    gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    await until(() => gate.inferenceDiagnostics().bufferedEvents === 1, 'the fired batch buffered while the host is quiesced');
    assert.deepStrictEqual(gate.upcomingWakes(['agent']), [{ certain: true, when: "once no turn runs and the host isn't quiesced", what: '1 event buffered for delivery' }]);
    gate.dispose();
  });

  it('leaves out of the buffered count an event whose channel is held now', async () => {
    let tunedOut = false;
    const { gate } = makeGate(writeConfig('upcoming-buffered-held.json', {
      policies: [{ name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 30 } }],
    }), { isHeld: (serverId, channelId) => tunedOut && serverId === 'discord' && channelId === 'c-held' });
    gate.setQuiesced(true);
    gate.evaluate({ content: 'hello', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c-held' });
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c-open' });
    await until(() => gate.inferenceDiagnostics().bufferedEvents === 2, 'both events buffered while the host is quiesced');
    assert.strictEqual(gate.upcomingWakes(['agent'])[0]?.what, '2 events buffered for delivery', 'premise: both are listed before the tune-out');
    tunedOut = true;
    assert.deepStrictEqual(gate.upcomingWakes(['agent']), [{ certain: true, when: "once no turn runs and the host isn't quiesced", what: '1 event buffered for delivery' }]);
    gate.dispose();
  });

  it("tells the judge its own rule's events buffered behind a turn, as certain", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming-own-buffered.json', {
      policies: [{ name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 50 } } }],
    }), { judge: judge.fn, residents: ['agent'] });
    gate.onInferenceStarted('fork');
    gate.evaluate(chat('hello'));
    await until(() => judge.requests.length === 1, "the batch's call during the fork's turn");
    judge.answer({ reply: true, reason: 'addressed' });
    await until(() => gate.inferenceDiagnostics().bufferedEvents === 1, "the replied batch buffered behind the fork's turn");
    gate.evaluate(chat('again'));
    await until(() => judge.requests.length === 2, 'the next batch asked');
    assert.deepStrictEqual(judge.requests[1]!.upcomingWakes!.map((w) => [w.when, w.what, w.certain]), [
      ["once no turn runs and the host isn't quiesced", '1 event buffered for delivery', true],
    ]);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("tells the judge its own rule's next batch, collecting while a held one is asked", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming-own-next.json', {
      policies: [{ name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } }],
    }), { judge: judge.fn, residents: ['agent'] });
    gate.onInferenceStarted('agent');
    gate.evaluate(chat('first'));
    await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the first batch held for the turn');
    gate.evaluate(chat('second'));
    gate.onInferenceEnded('agent');
    await until(() => judge.requests.length === 1, 'the held batch asked once the turn ends');
    assert.deepStrictEqual(judge.requests[0]!.events.map((e) => e.content), ['first']);
    assert.deepStrictEqual(judge.requests[0]!.upcomingWakes!.map((w) => [w.what, w.certain]), [
      ['rule "ambient"\'s batch of 1 event goes to the judge', false],
    ]);
    assert.deepStrictEqual(gate.upcomingWakes(['agent'], 'ambient'), []);
    judge.answer({ reply: false, reason: 'chatter' });
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
    await advance(160);
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
    useRealClock();
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (input: Record<string, unknown>) => {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'add', name: 'wake_add_rule', input }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    assert.strictEqual(framework.nudgeAgent('scout').ok, true);
    await idle(framework);
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
    const removal = toolNamed('wake_remove_rule').description;
    assert.match(firstSentence(removal), /a judge rule's pending batches still go where the rule as it was sends them\.$/,
      "the first sentence, all the settings toolset shows of it, says what becomes of a removed rule's pending batches");
    assert.match(removal, /A judge rule's batch is pending while it waits out its quiet period, is held or is being judged\./);
  });

  it("tells an agent with the judge that a wait adds nothing to its context, and what was stored as it arrived stays stored for when it's next woken", async (t) => {
    const { wakeAddRule } = await judgeFramework(t, {});
    const judge = (wakeAddRule().inputSchema.properties as Record<string, { description: string }>).judge!;
    assert.ok(judge.description.includes('When it says wait, you aren\'t woken, and as for "defer", nothing more is added to your context: what was stored as it arrived stays stored for when you\'re next woken.'), judge.description);
    assert.ok(!judge.description.includes('stay in your context'), judge.description);
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
    await idle(framework);
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
    await idle(framework);
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
    await advance(20);
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
      useRealClock();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const eventGate = (framework as unknown as { eventGate: EventGate }).eventGate;
    return { framework, membrane, eventGate };
  }

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
    await idle(framework);
    assert.ok(membrane.calls.length >= 2, 'the reply woke the agent for a turn');
  });

  it("under onError 'skip', a batch whose judge call a provider wait on the judge's model refused is held, and judged once an operator releases the wait", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { onError: 'skip' } });
    const internal = framework as unknown as { recordProviderWait(agentName: string, model: string, error: Error): unknown };
    const wait = new MembraneError({ type: 'rate_limit', retryable: true, retryAfterMs: 600_000, message: 'slow down', rawError: { status: 429 } });
    assert.ok(internal.recordProviderWait('scout', 'claude-haiku-5-5', wait), "premise: the judge's model waits");
    const original = console.error;
    console.error = () => {};
    try {
      eventGate.evaluate(chat('is scout around?'));
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the refused batch to be held');
      assert.strictEqual(membrane.calls.length, 0, 'no judge call was made');
      assert.strictEqual(eventGate.getStatus().policies[0]!.judgeState!.verdicts.refused, 1);
      assert.ok(eventGate.getStatus().errors.some((e) => e.includes('refused until')), 'gate_status names the refusal and its end');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'REPLY: asked directly' }]));
      membrane.pushResponse(createMockResponse([]));
      framework.releaseProviderWait('scout', 'claude-haiku-5-5');
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.reply === 1, 'the held batch judged once the wait is released');
      assert.strictEqual(membrane.calls[0]!.assistantParticipant, 'reply-judge');
      const shown = membrane.calls[0]!.messages.map((m) => (m.content[0] as { text: string }).text).join('\n');
      assert.ok(shown.includes('is scout around?'));
      await idle(framework);
      assert.ok(membrane.calls.length >= 2, 'the reply woke the agent for a turn');
    } finally {
      console.error = original;
    }
  });

  it("under onError 'skip', a batch refused under the host's hold on the agent's calls is held while the hold lasts, and judged once it ends", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane, createMockResponse } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-hold-'));
    const membrane = new MockMembrane();
    let consulted = 0;
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      modules: [],
      gate: { configPath: join(dir, 'gate.json'), config: JUDGED, judge: { onError: 'skip' } },
      providerHold: () => (consulted++ === 0 ? { holdMs: 3_000, reason: 'quota spent' } : undefined),
    });
    t.after(async () => {
      useRealClock();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const eventGate = (framework as unknown as { eventGate: EventGate }).eventGate;
    const internal = framework as unknown as { holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown, auxiliary?: boolean): boolean };
    let calledAt: number | undefined;
    const complete = membrane.complete.bind(membrane);
    membrane.complete = async (request) => { calledAt ??= Date.now(); return complete(request); };
    const original = console.error;
    console.error = () => {};
    try {
      const quota = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, message: 'quota', rawError: { status: 429 } });
      assert.strictEqual(internal.holdProviderAcceleration(framework.getAgent('scout'), quota, undefined, true), true, 'premise: the agent is held');
      const heldAt = Date.now();
      eventGate.evaluate(chat('lol'));
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the refused batch to be held');
      assert.ok(eventGate.getStatus().errors.some((e) => e.includes('refused until') && e.includes('quota spent')), JSON.stringify(eventGate.getStatus().errors));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      await lastMillisecond(refusalEnd(eventGate), () => {
        assert.strictEqual(eventGate.getStatus().policies[0]!.judgeState!.verdicts.refused, 1, 'not asked again a millisecond before the hold ends');
        assert.strictEqual(eventGate.getStatus().policies[0]!.judgeState!.heldCount, 1, 'still held, not taken into a judge call, a millisecond before the hold ends');
        assert.strictEqual(calledAt, undefined);
      });
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the batch judged once the hold ends');
      assert.ok(calledAt !== undefined && calledAt - heldAt >= 3_000, `the judge's call was made ${calledAt === undefined ? 'never' : `${calledAt - heldAt} ms after the hold began`}`);
      assert.deepStrictEqual(membrane.calls.map((c) => c.assistantParticipant), ['reply-judge']);
      assert.deepStrictEqual(eventGate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 1, error: 0, refused: 1 });
      assert.strictEqual(eventGate.getStatus().errors.some((e) => e.includes('refused until')), false, 'the refusal is over');
    } finally {
      console.error = original;
    }
  });

  async function heldFramework(t: { after: (fn: () => Promise<void> | void) => void }, holds: number[]) {
    const { MembraneError } = await import('@animalabs/membrane');
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-held-'));
    const membrane = new MockMembrane();
    let consulted = 0;
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      modules: [],
      gate: { configPath: join(dir, 'gate.json'), config: JUDGED, judge: { onError: 'skip' } },
      providerHold: () => {
        const holdMs = holds[consulted++];
        return holdMs === undefined ? undefined : { holdMs, reason: 'quota spent' };
      },
    });
    const original = console.error;
    console.error = () => {};
    t.after(async () => {
      console.error = original;
      useRealClock();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const eventGate = (framework as unknown as { eventGate: EventGate }).eventGate;
    const internal = framework as unknown as {
      holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown, auxiliary?: boolean): boolean;
      providerAccelerationCooldowns: Map<string, { until: number }>;
      providerWaits: { set(agent: string, model: string, retryAfterMs: unknown, reason: string): unknown };
      pendingRequests: Array<Record<string, unknown>>;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    let calledAt: number | undefined;
    const complete = membrane.complete.bind(membrane);
    membrane.complete = async (request) => { calledAt ??= Date.now(); return complete(request); };
    const hold = () => internal.holdProviderAcceleration(framework.getAgent('scout'), new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429, message: 'quota', rawError: { status: 429 },
    }), undefined, true);
    const judgeState = () => eventGate.getStatus().policies[0]!.judgeState!;
    return { framework, membrane, eventGate, internal, hold, judgeState, calledAt: () => calledAt, consulted: () => consulted };
  }

  it("under onError 'skip', a call refused by a hold past its end, before the hold's timer has let it go, waits for that release, and is judged then", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { membrane, eventGate, internal, hold, judgeState, calledAt } = await heldFramework(t, [3_000]);
    assert.strictEqual(hold(), true, 'premise: the agent is held');
    const heldAt = Date.now();
    internal.providerAccelerationCooldowns.get('scout')!.until = heldAt;
    eventGate.evaluate(chat('lol'));
    await until(() => judgeState().heldCount === 1, 'the refused batch to be held');
    assert.ok(eventGate.getStatus().errors.some((e) => e.includes('no time left') && e.includes('quota spent')
      && e.includes("The refusal sets no time to ask again: judge rules' held batches (1 event now) are judged once a judge call made after this gets a REPLY or WAIT, or when the hold on the agent's calls ends.")), JSON.stringify(eventGate.getStatus().errors));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
    await lastMillisecond(heldAt + 3_000, () => {
      assert.strictEqual(judgeState().verdicts.refused, 1, "not asked again before the hold's timer lets it go");
      assert.strictEqual(judgeState().heldCount, 1, "still held, not taken into a judge call, before the hold's timer lets it go");
      assert.strictEqual(calledAt(), undefined, "not called a millisecond before the hold's timer lets it go");
    });
    await until(() => judgeState().verdicts.wait === 1, "the batch judged once the hold's timer lets it go");
    assert.ok(calledAt() !== undefined && calledAt()! - heldAt >= 3_000, `the judge's call was made ${calledAt() === undefined ? 'never' : `${calledAt()! - heldAt} ms after the hold began`}`);
    assert.deepStrictEqual(judgeState().verdicts, { reply: 0, wait: 1, error: 0, refused: 1 });
  });

  it("under onError 'skip', a batch refused under a hold its host extends at its end is held to the new end, and judged once the hold lets go", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { membrane, eventGate, hold, judgeState, calledAt, consulted } = await heldFramework(t, [3_000, 2_000]);
    assert.strictEqual(hold(), true, 'premise: the agent is held');
    const heldAt = Date.now();
    eventGate.evaluate(chat('lol'));
    await until(() => judgeState().heldCount === 1, 'the refused batch to be held');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
    await lastMillisecond(heldAt + 5_000, () => {
      assert.strictEqual(judgeState().verdicts.wait, 0, 'not judged a millisecond before the extended hold lets go');
      assert.strictEqual(judgeState().heldCount, 1, 'still held, not taken into a judge call, a millisecond before the extended hold lets go');
      assert.strictEqual(calledAt(), undefined);
    });
    await until(() => judgeState().verdicts.wait === 1, 'the batch judged once the extended hold lets go');
    assert.strictEqual(consulted(), 3, 'premise: the host extended the hold once, then let it go');
    assert.ok(calledAt()! - heldAt >= 5_000, `the judge's call was made ${calledAt()! - heldAt} ms after the hold began`);
    assert.deepStrictEqual(judgeState().verdicts, { reply: 0, wait: 1, error: 0, refused: 2 });
  });

  it("lists a wake a hold keeps as due at the end of a provider wait on the agent's model that outlasts the hold, since the wake waits that out once the hold lets it go", async (t) => {
    const { internal, hold } = await heldFramework(t, [3_000]);
    assert.strictEqual(hold(), true, 'premise: the agent is held');
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a queued test wake', source: 'test', timestamp: Date.now() });
    const [held] = internal.upcomingWakesFor('scout');
    assert.ok(held?.at !== undefined && held.at - Date.now() <= 3_000, `premise: held to the hold's end: ${JSON.stringify(held)}`);
    internal.providerWaits.set('scout', 'test-model', 60_000, 'slow down');
    const [outlasted] = internal.upcomingWakesFor('scout');
    assert.ok(outlasted?.at !== undefined && outlasted.at - Date.now() > 50_000, `held to the wait's end: ${JSON.stringify(outlasted)}`);
    internal.providerWaits.set('scout', 'test-model', Number.POSITIVE_INFINITY, 'until released');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout'), [{ when: 'when the hold on it is released', certain: true, what: 'a wake held by a provider hold' }]);
  });

  it("under onError 'skip', a batch refused under a surgery's hold on the store is judged once the surgery lets the store go", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { onError: 'skip' } });
    const internal = framework as unknown as { reserveStoreForSurgery(verb: string, agentName: string): () => void };
    const original = console.error;
    console.error = () => {};
    try {
      const release = internal.reserveStoreForSurgery('undo', 'scout');
      eventGate.evaluate(chat('is scout around?'));
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the refused batch to be held');
      assert.strictEqual(membrane.calls.length, 0, 'no judge call was made');
      assert.ok(eventGate.getStatus().errors.some((e) => e.includes('stated no end')), JSON.stringify(eventGate.getStatus().errors));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      release();
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the held batch judged once the surgery ends');
      assert.deepStrictEqual(membrane.calls.map((c) => c.assistantParticipant), ['reply-judge']);
    } finally {
      console.error = original;
    }
  });

  it("tells the judge the agent's last turn failed, and whether a wake for it is on its way, alike in that line and the wake list, as the framework's state has it", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane, createMockResponse } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    class FailingTurns extends MockMembrane {
      failTurns = true;
      override streamYielding(request: import('@animalabs/membrane').NormalizedRequest): import('@animalabs/membrane').YieldingStream {
        if (!this.failTurns) return super.streamYielding(request);
        this.calls.push(request);
        const error = new MembraneError({ type: 'server', retryable: true, httpStatus: 500, message: 'Internal server error', rawError: { status: 500 } });
        return {
          isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
          provideToolResults() { throw new Error('not waiting'); },
          cancel() {},
          async *[Symbol.asyncIterator]() { yield { type: 'error', error }; },
        } as unknown as import('@animalabs/membrane').YieldingStream;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-failed-'));
    const membrane = new FailingTurns();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      modules: [],
      gate: { configPath: join(dir, 'gate.json'), config: JUDGED },
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false as const }) },
      exhaustedTurnRearmMs: false,
    });
    t.after(async () => {
      useRealClock();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const eventGate = (framework as unknown as { eventGate: EventGate }).eventGate;
    const internal = framework as unknown as {
      consecutiveInferenceFailures: Map<string, number>;
      pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
      parkedContinuations: Set<unknown>;
      recordProviderWait(agentName: string, model: string, error: Error): unknown;
      holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown): boolean;
      wakesOnTheirWay(agentName: string): unknown;
    };
    const read = internal.wakesOnTheirWay.bind(framework);
    let readings = 0;
    internal.wakesOnTheirWay = (agentName: string) => {
      readings++;
      return read(agentName);
    };
    const judged = (n: number) => until(() => membrane.calls.filter((c) => c.assistantParticipant === 'reply-judge').length === n, `judge call ${n}`);
    const question = () => {
      const asked = membrane.calls.filter((c) => c.assistantParticipant === 'reply-judge').at(-1)!;
      return (asked.messages.at(-1)!.content[0] as { text: string }).text;
    };
    const opening = /scout's last turn, \d+s ago, failed and may not have answered all of what woke it\./;
    const original = console.error;
    console.error = () => {};
    try {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'REPLY: asked to check something' }]));
      eventGate.evaluate(chat('@scout can you check X?'));
      await judged(1);
      await until(() => internal.pendingRequests.length > 0, 'the wake');
      await idle(framework);
      assert.strictEqual(internal.consecutiveInferenceFailures.get('scout'), 1, 'premise: the turn failed with its retries spent');
      assert.strictEqual(internal.pendingRequests.length, 0, 'premise: nothing re-arms it');

      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      readings = 0;
      eventGate.evaluate(chat('lol'));
      await judged(2);
      assert.strictEqual(readings, 1, 'the wake list and the failed-turn line come from one reading');
      assert.match(question(), opening);
      assert.ok(question().includes('Nothing runs it again: if you answer WAIT, whatever of it is unanswered stays so until something wakes scout.'), question());

      const later = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 180_000, message: 'slow down', rawError: { status: 429 } });
      assert.strictEqual(internal.holdProviderAcceleration(framework.getAgent('scout'), later), true, 'premise: scout is held, with no turn held');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('anyone?'));
      await judged(3);
      assert.ok(question().includes('A wake for scout is held, due to be let go in 3 min.'), question());
      assert.ok(question().includes(': a wake held by a provider hold, when it ends'), question());
      const failures = internal.consecutiveInferenceFailures.get('scout') ?? 0;
      framework.releaseProviderWait('scout', 'test-model');
      await idle(framework);
      assert.ok((internal.consecutiveInferenceFailures.get('scout') ?? 0) > failures, 'the release queued a retry, which ran and failed');
      assert.strictEqual(internal.pendingRequests.length, 0, 'premise: nothing re-arms it');

      internal.pendingRequests.push({ agentName: 'scout', reason: 'a queued wake', source: 'framework', timestamp: Date.now() });
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('and?'));
      await judged(4);
      assert.ok(question().includes('A wake for scout is already queued.'), question());
      assert.ok(question().includes(': a wake already queued (a queued wake)'), question());

      const request = internal.pendingRequests.shift()!;
      internal.parkedContinuations.add(request);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('so?'));
      await judged(5);
      assert.ok(question().includes('A wake for scout is already queued.'), question());
      assert.ok(question().includes(': a wake already queued (a queued wake)'), question());
      internal.parkedContinuations.delete(request);
      internal.pendingRequests.push(request);

      const wait = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 180_000, message: 'slow down', rawError: { status: 429 } });
      internal.recordProviderWait('scout', 'test-model', wait);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('hmm'));
      await judged(6);
      assert.ok(question().includes('A wake for scout is held, due to be let go in 3 min.'), question());
      assert.ok(question().includes(': a wake held by a provider hold, when it ends'), question());
      assert.ok(!question().includes('already queued'), question());

      assert.strictEqual(internal.holdProviderAcceleration(framework.getAgent('scout'), wait, internal.pendingRequests.shift()), true, 'premise: the turn is held');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('hm'));
      await judged(7);
      assert.ok(question().includes('A wake for scout is held, due to be let go in 3 min.'), question());
      assert.ok(question().includes(': a wake held by a provider hold, when it ends'), question());

      membrane.failTurns = false;
      framework.releaseProviderWait('scout', 'test-model');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Checked: X is fine.' }]));
      await idle(framework);
      assert.strictEqual(internal.consecutiveInferenceFailures.get('scout') ?? 0, 0, 'premise: a turn completed');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('thanks'));
      await judged(8);
      assert.doesNotMatch(question(), /last turn/);
    } finally {
      console.error = original;
    }
  });

  it("tells the judge of a failed last turn only while no turn has started since, by the order of starts and failures, not the clock: a turn that failed in the millisecond it started is named, and a later turn started in the millisecond of a failure, then stopped, ends the line", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane, MockYieldingStream, createMockResponse } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    class StoppableStream extends MockYieldingStream {
      private stop!: () => void;
      private readonly stopped = new Promise<void>((resolve) => { this.stop = resolve; });
      override cancel(): void { this.stop(); }
      override async *[Symbol.asyncIterator](): AsyncGenerator<import('@animalabs/membrane').StreamEvent> {
        await this.stopped;
        yield { type: 'aborted', reason: 'user' } as import('@animalabs/membrane').StreamEvent;
      }
    }
    class Turns extends MockMembrane {
      mode: 'fail' | 'hang' = 'fail';
      hung = 0;
      override streamYielding(request: import('@animalabs/membrane').NormalizedRequest): import('@animalabs/membrane').YieldingStream {
        this.calls.push(request);
        if (this.mode === 'hang') {
          this.hung++;
          return new StoppableStream([]);
        }
        const error = new MembraneError({ type: 'server', retryable: true, httpStatus: 500, message: 'Internal server error', rawError: { status: 500 } });
        return {
          isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
          provideToolResults() { throw new Error('not waiting'); },
          cancel() {},
          async *[Symbol.asyncIterator]() { yield { type: 'error', error }; },
        } as unknown as import('@animalabs/membrane').YieldingStream;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-stopped-'));
    const membrane = new Turns();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      modules: [],
      gate: { configPath: join(dir, 'gate.json'), config: JUDGED },
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false as const }) },
      exhaustedTurnRearmMs: false,
    });
    t.after(async () => {
      useRealClock();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const eventGate = (framework as unknown as { eventGate: EventGate }).eventGate;
    const internal = framework as unknown as {
      consecutiveInferenceFailures: Map<string, number>;
      pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
      lastInferenceAt: Map<string, { startedAt?: number; failedAt?: number }>;
    };
    const judged = (n: number) => until(() => membrane.calls.filter((c) => c.assistantParticipant === 'reply-judge').length === n, `judge call ${n}`);
    const question = () => {
      const asked = membrane.calls.filter((c) => c.assistantParticipant === 'reply-judge').at(-1)!;
      return (asked.messages.at(-1)!.content[0] as { text: string }).text;
    };
    const stillUntil = async (done: () => boolean, what: string): Promise<void> => {
      for (let turns = 0; !done(); turns++) {
        if (turns === 10_000) assert.fail(`${what} didn't happen`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const run = () => {
      const state = { ended: false, failure: undefined as unknown };
      void framework.runUntilIdle().then(() => { state.ended = true; }, (err: unknown) => { state.failure = err; state.ended = true; });
      return state;
    };
    const ended = async (state: { ended: boolean; failure: unknown }, what: string): Promise<void> => {
      await until(() => state.ended, what, 60_000);
      if (state.failure !== undefined) throw state.failure;
    };
    const wake = (reason: string) => internal.pendingRequests.push({ agentName: 'scout', reason, source: 'framework', timestamp: Date.now() });
    const failures = () => internal.consecutiveInferenceFailures.get('scout') ?? 0;
    const sameMillisecond = () => internal.lastInferenceAt.get('scout')?.startedAt === internal.lastInferenceAt.get('scout')?.failedAt;
    const original = console.error;
    console.error = () => {};
    try {
      wake('a first wake');
      const first = run();
      await stillUntil(() => failures() === 1, 'the first turn to fail');
      assert.ok(sameMillisecond(), 'premise: the turn started and failed in one millisecond');
      await ended(first, 'the failed turn to end');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('lol'));
      await judged(1);
      assert.match(question(), /scout's last turn, \d+s ago, failed/);

      wake('a second wake');
      await idle(framework);
      assert.strictEqual(failures(), 2, 'premise: the second turn failed');
      const failedAt = internal.lastInferenceAt.get('scout')!.failedAt!;
      membrane.mode = 'hang';
      wake('a third wake');
      mock.timers.setTime(failedAt);
      const third = run();
      await stillUntil(() => membrane.hung === 1, 'the third turn to start its stream');
      assert.ok(sameMillisecond(), 'premise: the next turn started in the millisecond the last one failed');
      assert.strictEqual(framework.abortInference('scout'), true, 'premise: the turn is stopped');
      await ended(third, 'the stopped turn to end');
      assert.strictEqual(failures(), 2, 'premise: no turn has completed since the failure');

      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('ok'));
      await judged(2);
      assert.doesNotMatch(question(), /last turn/);
    } finally {
      console.error = original;
    }
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

  it("an operator's release of a provider wait releases batches held for a refusal, even when it finds no wait recorded", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { onError: 'skip' } });
    const internal = framework as unknown as { surgeryHold: { verb: string; agentName: string } | null };
    const original = console.error;
    console.error = () => {};
    try {
      internal.surgeryHold = { verb: 'undo', agentName: 'scout' };
      eventGate.evaluate(chat('is scout around?'));
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the refused batch to be held');
      internal.surgeryHold = null;
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      assert.deepStrictEqual(framework.releaseProviderWait('scout'), [], 'premise: no wait was recorded');
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the held batch judged on the release');
    } finally {
      console.error = original;
    }
  });

  it("lists a turn a provider wait holds, at the wait's end as it stands, though extended, or held until released, saying so", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      recordProviderWait(agentName: string, model: string, error: Error): unknown;
      holdForProviderWait(agent: unknown, wait: unknown, requests: unknown[]): boolean;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
      providerAccelerationCooldowns: Map<string, { until: number }>;
      providerWaits: { set(agent: string, model: string, retryAfterMs: unknown, reason: string): unknown };
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
    assert.strictEqual(held?.what, 'a wake held by a provider hold, when it ends');
    assert.ok(Number.isFinite(held!.at));
    assert.strictEqual((internal.getAgent('scout') as { model: string }).model, 'test-model', "premise: the wait is on the agent's model");
    internal.providerWaits.set('scout', 'test-model', 3_600_000, 'slower still');
    const [extended] = internal.upcomingWakesFor('scout');
    assert.ok(extended!.at! - Date.now() > 3_000_000, `held until the extended wait's end, not the hold's first: ${extended!.at! - Date.now()} ms on`);
    holdFor(Number.POSITIVE_INFINITY);
    assert.strictEqual(internal.providerAccelerationCooldowns.get('scout')!.until, Number.POSITIVE_INFINITY, 'premise: now held until released');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout'), [{ when: 'when the hold on it is released', certain: true, what: 'a wake held by a provider hold' }]);
  });

  it('lists no wake for a provider hold whose held wakes were all withdrawn, since its end starts no turn', async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      recordProviderWait(agentName: string, model: string, error: Error): unknown;
      holdForProviderWait(agent: unknown, wait: unknown, requests: unknown[]): boolean;
      cancelCoalescedWakes(subject: string): void;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
      providerAccelerationCooldowns: Map<string, { heldRequests: unknown[]; emptiedBy?: string }>;
      getAgent(name: string): unknown;
    };
    const wait = internal.recordProviderWait('scout', 'test-model', new MembraneError({
      type: 'rate_limit', retryable: true, retryAfterMs: 60_000, message: 'slow down', rawError: { status: 429 },
    }));
    assert.ok(internal.holdForProviderWait(internal.getAgent('scout'), wait,
      [{ agentName: 'scout', reason: 'held', source: 'test', timestamp: Date.now(), coalescingSubject: 'subject-a' }]));
    assert.strictEqual(internal.upcomingWakesFor('scout')[0]?.what, 'a wake held by a provider hold, when it ends', 'premise: the held wake is listed');
    internal.cancelCoalescedWakes('subject-a');
    const hold = internal.providerAccelerationCooldowns.get('scout');
    assert.deepStrictEqual([hold?.heldRequests.length, hold?.emptiedBy], [0, 'withdrawal'], 'premise: the hold stays, emptied by the withdrawal');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout'), []);
  });

  it('lists a wake queued behind a hold that holds nothing yet as held until the hold ends, since a scheduler pass holds it there', async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework } = await judgeFramework(t, {}, { providerHold: () => ({ holdMs: 60_000, reason: 'weekly quota spent' }) });
    const internal = framework as unknown as {
      withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>, model?: string): Promise<T>;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      providerAccelerationCooldowns: Map<string, { heldRequests: unknown[]; auxiliaryOrigin?: boolean }>;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    await assert.rejects(internal.withAuxiliaryAdmission('scout', async () => {
      throw new MembraneError({ type: 'rate_limit', retryable: true, message: 'quota spent', rawError: { status: 429 } });
    }), /quota spent/);
    const hold = internal.providerAccelerationCooldowns.get('scout');
    assert.deepStrictEqual([hold?.auxiliaryOrigin, hold?.heldRequests.length], [true, 0], 'premise: the auxiliary call armed a hold that holds nothing');
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a later wake', source: 'test', timestamp: Date.now() });
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake held by a provider hold, when it ends']);
    await internal.processInferenceRequests();
    assert.strictEqual(internal.providerAccelerationCooldowns.get('scout')?.heldRequests.length, 1, 'premise: a scheduler pass holds the wake until the hold ends');
  });

  it("doesn't list as held a wake a hold keeps whose message the agent has already read and answered, which the hold's release drops with no turn", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework } = await judgeFramework(t, {}, { providerHold: () => ({ holdMs: 60_000, reason: 'weekly quota spent' }) });
    const internal = framework as unknown as {
      withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>, model?: string): Promise<T>;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      providerAccelerationCooldowns: Map<string, { heldRequests: unknown[]; auxiliaryOrigin?: boolean }>;
      storedMessageDone(agent: unknown, messageId: string, to: unknown): boolean;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    await assert.rejects(internal.withAuxiliaryAdmission('scout', async () => {
      throw new MembraneError({ type: 'rate_limit', retryable: true, message: 'quota spent', rawError: { status: 429 } });
    }), /quota spent/);
    internal.storedMessageDone = () => false;
    internal.pendingRequests.push({ agentName: 'scout', reason: 'zz an answered wake', source: 'test', timestamp: Date.now(), readsStoredMessage: 'zz-message' });
    await internal.processInferenceRequests();
    const hold = internal.providerAccelerationCooldowns.get('scout');
    assert.deepStrictEqual([hold?.auxiliaryOrigin, hold?.heldRequests.length], [true, 1], 'premise: an auxiliary call\'s hold keeps the wake');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake held by a provider hold, when it ends'], 'premise: while its message is unanswered, the held wake is listed');
    internal.storedMessageDone = (_agent, messageId) => messageId === 'zz-message';
    assert.deepStrictEqual(internal.upcomingWakesFor('scout'), []);
  });

  it("lists a wake queued after the agent's model changed as queued, though a wait holds its old model, since the scheduler lets that turn go", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      agents: Map<string, { model: string }>;
      pendingRequests: Array<Record<string, unknown>>;
      providerAccelerationCooldowns: Map<string, { waitModel?: string }>;
      holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown): boolean;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    const wait = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 3_600_000, message: 'slow down', rawError: { status: 429 } });
    assert.strictEqual(internal.holdProviderAcceleration(framework.getAgent('scout'), wait), true, 'premise: scout is held');
    const original = internal.agents.get('scout')!;
    assert.strictEqual(internal.providerAccelerationCooldowns.get('scout')?.waitModel, original.model, "premise: the hold is the wait on scout's model");
    internal.agents.set('scout', Object.assign(Object.create(Object.getPrototypeOf(original)) as { model: string }, original, { model: 'zz-other-model' }));
    try {
      internal.pendingRequests.push({ agentName: 'scout', reason: 'a wake after the change', source: 'test', timestamp: Date.now() });
      assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake already queued (a wake after the change)']);
    } finally {
      internal.agents.set('scout', original);
    }
  });

  it('lists a start that waits behind an auxiliary call, with nothing else queued, as a wake on its way', async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>, model?: string): Promise<T>;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      providerGates: Map<string, { primaryDepth: number; auxiliaryInFlight: number }>;
      activeTurnTokens: Map<string, unknown>;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    let finish!: () => void;
    const auxiliary = internal.withAuxiliaryAdmission('scout', () => new Promise<void>((resolve) => { finish = resolve; }));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a test wake', source: 'test', timestamp: Date.now() });
    await internal.processInferenceRequests();
    const gate = internal.providerGates.get('scout')!;
    assert.deepStrictEqual(
      [gate.auxiliaryInFlight, gate.primaryDepth, internal.pendingRequests.length, internal.activeTurnTokens.has('scout')],
      [1, 1, 0, false],
      'premise: the start waits behind the auxiliary call, with nothing queued and no turn running');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake already queued (a start waiting for an auxiliary call to finish)']);
    finish();
    await auxiliary;
  });

  async function parkedBehindAuxiliary(t: Parameters<typeof frameworkWith>[0], request: Record<string, unknown> = {}) {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>, model?: string): Promise<T>;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      providerGates: Map<string, { primaryDepth: number; auxiliaryInFlight: number }>;
      activeTurnTokens: Map<string, unknown>;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    let finish!: () => void;
    const auxiliary = internal.withAuxiliaryAdmission('scout', () => new Promise<void>((resolve) => { finish = resolve; }));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a test wake', source: 'test', timestamp: Date.now(), ...request });
    await internal.processInferenceRequests();
    const gate = internal.providerGates.get('scout')!;
    assert.deepStrictEqual([gate.auxiliaryInFlight, gate.primaryDepth, internal.pendingRequests.length], [1, 1, 0], 'premise: the start waits behind the auxiliary call');
    return { internal, done: async () => { finish(); await auxiliary; } };
  }

  it("lists a start that waits behind an auxiliary call while a puppeted tool holds the agent's turn token", async (t) => {
    const { internal, done } = await parkedBehindAuxiliary(t);
    internal.activeTurnTokens.set('scout', Symbol('a puppeted tool'));
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake already queued (a start waiting for an auxiliary call to finish)']);
    internal.activeTurnTokens.delete('scout');
    await done();
  });

  it('counts a start that waits behind an auxiliary call beside a wake queued meanwhile', async (t) => {
    const { internal, done } = await parkedBehindAuxiliary(t);
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a later wake', source: 'test', timestamp: Date.now() });
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['2 wakes already queued (a later wake)']);
    internal.pendingRequests.length = 0;
    await done();
  });

  it('lists a start parked behind an auxiliary call only while its name still binds the agent that parked it', async (t) => {
    const { internal, done } = await parkedBehindAuxiliary(t);
    const agents = (internal as unknown as { agents: Map<string, object> }).agents;
    const parked = agents.get('scout')!;
    agents.set('scout', { ...parked });
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), [], 'an agent bound to the name since');
    agents.set('scout', parked);
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake already queued (a start waiting for an auxiliary call to finish)']);
    await done();
  });

  it('lists a start parked behind an auxiliary call whose only causes are deferred batches as a maybe, since it starts no turn if they give it nothing to read', async (t) => {
    const { internal, done } = await parkedBehindAuxiliary(t, { coalescingBatch: true, coalescingSubject: 'zz-batch' });
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => [w.certain, w.what]), [
      [false, 'a start waiting for an auxiliary call to finish, which starts no turn if its deferred pushes give it nothing to read'],
    ]);
    await done();
  });

  it('lists a start that waits for its deferred pushes to be assembled as a wake on its way', async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      pushCoalescer: unknown;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      assembling: Set<string>;
      activeTurnTokens: Map<string, unknown>;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    let assembled!: () => void;
    const assembly = new Promise<undefined>((resolve) => { assembled = () => resolve(undefined); });
    internal.pushCoalescer = { pendingBatches: () => 1, assemble: () => assembly, isRendering: () => false, identity: () => undefined, suspend: () => {} };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a test wake', source: 'test', timestamp: Date.now() });
    const pass = internal.processInferenceRequests();
    await until(() => internal.assembling.has('scout'), 'the start to wait on its assembly');
    assert.deepStrictEqual([internal.pendingRequests.length, internal.activeTurnTokens.has('scout')], [0, true], 'premise: nothing queued, the turn token taken');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake already queued (a start assembling its deferred pushes)']);
    assembled();
    await pass;
    await until(() => !internal.assembling.has('scout'), 'the assembly to end');
  });

  it('lists a start assembling its deferred pushes, when they are its only causes, as a maybe, since it starts no turn if they give it nothing to read', async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      pushCoalescer: unknown;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      assembling: Set<string>;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    let assembled!: () => void;
    const assembly = new Promise<undefined>((resolve) => { assembled = () => resolve(undefined); });
    internal.pushCoalescer = { pendingBatches: () => 1, assemble: () => assembly, isRendering: () => false, identity: () => undefined, suspend: () => {} };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a deferred batch', source: 'test', timestamp: Date.now(), coalescingBatch: true, coalescingSubject: 'zz-batch' });
    const pass = internal.processInferenceRequests();
    await until(() => internal.assembling.has('scout'), 'the start to wait on its assembly');
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => [w.certain, w.what]), [
      [false, 'a start assembling its deferred pushes, which starts no turn if they give it nothing to read'],
    ]);
    assembled();
    await pass;
    await until(() => !internal.assembling.has('scout'), 'the assembly to end');
  });

  it('a start whose name binds another agent by the time it throws before its stream marks no failed last turn for that agent', async (t) => {
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      pushCoalescer: unknown;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      assembling: Set<string>;
      agents: Map<string, object>;
      failedLastTurnFor(agentName: string): unknown;
      recordTurnCheckpoint(agentName: string): void;
    };
    let assembled!: () => void;
    const assembly = new Promise<undefined>((resolve) => { assembled = () => resolve(undefined); });
    internal.pushCoalescer = { pendingBatches: () => 1, assemble: () => assembly, isRendering: () => false, identity: () => undefined, suspend: () => {} };
    const record = internal.recordTurnCheckpoint.bind(framework);
    internal.recordTurnCheckpoint = () => {
      internal.recordTurnCheckpoint = record;
      throw new Error('zz checkpoint refused');
    };
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a test wake', source: 'test', timestamp: Date.now() });
    const pass = internal.processInferenceRequests();
    await until(() => internal.assembling.has('scout'), 'the start to wait on its assembly');
    const original = internal.agents.get('scout')!;
    internal.agents.set('scout', { ...original });
    const errors = console.error;
    console.error = () => {};
    try {
      assembled();
      await assert.rejects(pass, /zz checkpoint refused/, "premise: the start's own throw reaches its pass");
      await until(() => !internal.assembling.has('scout'), 'the assembly to end');
      assert.strictEqual(internal.recordTurnCheckpoint, record, 'premise: the checkpoint threw');
      assert.strictEqual(internal.failedLastTurnFor('scout'), undefined);
    } finally {
      console.error = errors;
      internal.agents.set('scout', original);
    }
  });

  it('a silent start that throws before its stream marks no failed last turn, since it settles none', async (t) => {
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      failedLastTurnFor(agentName: string): unknown;
      recordTurnCheckpoint(agentName: string): void;
    };
    const record = internal.recordTurnCheckpoint.bind(framework);
    internal.recordTurnCheckpoint = () => {
      internal.recordTurnCheckpoint = record;
      throw new Error('zz checkpoint refused');
    };
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a silent test wake', source: 'test', timestamp: Date.now(), suppressProse: true });
    const errors = console.error;
    console.error = () => {};
    try {
      await assert.rejects(internal.processInferenceRequests(), /zz checkpoint refused/, "premise: the start's own throw reaches its pass");
    } finally {
      console.error = errors;
    }
    assert.strictEqual(internal.recordTurnCheckpoint, record, 'premise: the checkpoint threw');
    assert.strictEqual(internal.failedLastTurnFor('scout'), undefined);
  });

  it("a start that resumes after its assembly leaves the failed-turn mark of the agent its name binds by then", async (t) => {
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      pushCoalescer: unknown;
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      assembling: Set<string>;
      agents: Map<string, object>;
      lastStartFailed: WeakMap<object, number>;
      failedLastTurnFor(agentName: string): unknown;
    };
    let assembled!: () => void;
    const assembly = new Promise<undefined>((resolve) => { assembled = () => resolve(undefined); });
    internal.pushCoalescer = { pendingBatches: () => 1, assemble: () => assembly, isRendering: () => false, identity: () => undefined, suspend: () => {} };
    internal.pendingRequests.push({ agentName: 'scout', reason: 'a test wake', source: 'test', timestamp: Date.now() });
    const pass = internal.processInferenceRequests();
    await until(() => internal.assembling.has('scout'), 'the start to wait on its assembly');
    const original = internal.agents.get('scout')!;
    const replacement = Object.assign(Object.create(Object.getPrototypeOf(original)), original) as object;
    internal.agents.set('scout', replacement);
    internal.lastStartFailed.set(replacement, Date.now());
    const errors = console.error;
    console.error = () => {};
    try {
      assert.notStrictEqual(internal.failedLastTurnFor('scout'), undefined, "premise: the agent the name binds now has a failed last turn");
      assembled();
      await pass;
      await until(() => !internal.assembling.has('scout'), 'the assembly to end');
      assert.notStrictEqual(internal.failedLastTurnFor('scout'), undefined);
    } finally {
      console.error = errors;
      internal.agents.set('scout', original);
    }
  });

  it("doesn't list a queued wake whose message the agent has already read and answered, which the scheduler drops with no turn", async (t) => {
    const { framework } = await frameworkWith(t, { config: JUDGED, judge: {} });
    const internal = framework as unknown as {
      pendingRequests: Array<Record<string, unknown>>;
      storedMessageDone(agent: unknown, messageId: string, to: unknown): boolean;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    internal.pendingRequests.push({ agentName: 'scout', reason: 'zz an answered wake', source: 'test', timestamp: Date.now(), readsStoredMessage: 'zz-message' });
    internal.storedMessageDone = () => false;
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake already queued (zz an answered wake)'], 'premise: while its message is unanswered, the wake is listed');
    internal.storedMessageDone = (_agent, messageId) => messageId === 'zz-message';
    assert.deepStrictEqual(internal.upcomingWakesFor('scout'), []);
  });

  it("lists another agent's wake that a scheduler pass holds while it awaits an earlier agent's start", async (t) => {
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane, createMockResponse } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-pass-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let aideGathering = false;
    const slowGather = {
      name: 'slow-gather',
      async start() {},
      async stop() {},
      getTools: () => [],
      async onProcess() { return {}; },
      async handleToolCall() { return { success: true }; },
      async gatherContext(agentName: string) {
        if (agentName === 'aide') { aideGathering = true; await released; }
        return [];
      },
    };
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'aide', model: 'test-model', systemPrompt: 'You are aide.', proseRouting: 'disabled' },
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' },
      ],
      modules: [slowGather as never],
      gate: { configPath: join(dir, 'gate.json'), config: JUDGED, judge: {} },
    });
    t.after(async () => {
      release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const internal = framework as unknown as {
      pendingRequests: Array<Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
      passRequests: Set<Map<string, unknown[]>>;
      upcomingWakesFor(agentName: string): Array<{ at?: number; when?: string; certain: boolean; what: string }>;
    };
    internal.pendingRequests.push(
      { agentName: 'aide', reason: 'aide wake', source: 'test', timestamp: Date.now() },
      { agentName: 'scout', reason: 'scout wake', source: 'test', timestamp: Date.now() },
    );
    const pass = internal.processInferenceRequests();
    await until(() => aideGathering, "aide's start to wait on its module's context");
    assert.ok([...internal.passRequests].some((m) => m.has('scout')), "premise: the pass still holds scout's wake while it awaits aide's start");
    assert.deepStrictEqual(internal.upcomingWakesFor('scout').map((w) => w.what), ['a wake already queued (scout wake)']);
    release();
    await pass;
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
    useRealClock();
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
      useRealClock();
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
    await idle(framework);
    assert.strictEqual(membrane.calls.length, 1, 'one turn');
    assert.strictEqual((framework as unknown as { providerAccelerationCooldowns: Map<string, unknown> }).providerAccelerationCooldowns.size, 0, 'the stopped call arms no hold');
  });
});
