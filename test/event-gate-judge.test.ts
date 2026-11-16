import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import * as gateModule from '../src/gate/event-gate.js';
import { EventGate, type WakeWrite, type WritePlacement } from '../src/gate/event-gate.js';
import { JudgeFailure } from '../src/gate/reply-judge.js';
import { firstSentence } from '../src/mcpl/tool-signature.js';
import { MAX_TIMER_MS } from '../src/deadline-timer.js';

/** The gate's internal mark of the rows a batched wake's line can name, read
 *  loosely so this file still runs, red, against a gate without it. */
const BATCH_LINE_ROWS: symbol = (gateModule as unknown as { BATCH_LINE_ROWS?: symbol }).BATCH_LINE_ROWS ?? Symbol('no line rows');
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

const refusalEnd = (gate: EventGate, rule = 'ambient'): number => (gate as unknown as { judgeHeld: Map<string, { refusal: { until: number } }> }).judgeHeld.get(rule)!.refusal.until;

async function lastMillisecond(end: number, before: () => void): Promise<void> {
  assert.ok(end - Date.now() >= 1, `premise: ${end - Date.now()} ms left before the end, at least 1`);
  await advance(end - Date.now() - 1);
  before();
  await advance(1);
}

async function byThisMillisecond(done: () => boolean, what: string): Promise<void> {
  const by = performance.now() + 5_000;
  while (!done() && performance.now() < by) {
    mock.timers.tick(0);
    await settle();
  }
  assert.ok(done(), `${what}, without the clock moving on`);
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

const LONGER_THAN_ANY_START_MS = 60_000;
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

/** A judge whose verdicts the test hands out, one per request. */
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
  isAnswered?: (after: WritePlacement) => boolean;
} = {}) {
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const messages: Array<{ participant: string; content: unknown; metadata?: unknown }> = [];
  const wakes: Array<{ agentName: string; reason: string; writes?: WakeWrite[]; lineRows?: unknown }> = [];
  const gate: EventGate = new EventGate({
    configPath,
    emitTrace: (e) => {
      traces.push(e as { type: string });
      opts.onTrace?.(e as { type: string });
    },
    addMessage: (p, c, m) => { messages.push({ participant: p, content: c, metadata: m }); return ''; },
    requestInference: (a, r, _s, p) => wakes.push({ agentName: a, reason: r, ...(p?.writes ? { writes: p.writes } : {}), ...(p && BATCH_LINE_ROWS in p ? { lineRows: (p as Record<symbol, unknown>)[BATCH_LINE_ROWS] } : {}) }),
    getAgentNames: () => ['agent'],
    ...(opts.judge ? { judge: opts.judge } : {}),
    ...(opts.judgeTimeoutMs !== undefined ? { judgeTimeoutMs: opts.judgeTimeoutMs } : {}),
    ...(opts.judgeOnError ? { judgeOnError: opts.judgeOnError } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.residents ? { changesJudgedContext: (name: string) => opts.residents!.includes(name) } : {}),
    ...(opts.isHeld ? { isHeld: opts.isHeld } : {}),
    ...(opts.isAnswered ? { isAnswered: opts.isAnswered } : {}),
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
  for (const answeredRows of [[], ['row-1']] as const) {
    it(`a reply with ${answeredRows.length ? 'an event the host says is already answered keeps the wake: it carries no writes' : 'no event the host says is answered carries each event\'s write to the wake'}, and no line either way`, async () => {
      const judge = scriptedJudge();
      const answered = new Set<string>(answeredRows);
      const { gate, wakes, messages } = makeGate(writeConfig(`reply-split-${answeredRows.length}.json`, JUDGED), {
        judge: judge.fn, isAnswered: (after) => answered.has(after.messageId!),
      });
      gate.evaluate(chat('already answered'), { agent: 'agent', messageId: 'row-1' });
      gate.evaluate(chat('still open'), { agent: 'agent', messageId: 'row-2' });
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.answer({ reply: true, reason: 'a direct question', inputTokens: 1 });
      await until(() => wakes.length === 1, 'the wake');
      assert.strictEqual(messages.length, 0, 'messages stored at arrival get no line');
      if (answeredRows.length === 0) {
        assert.deepStrictEqual(wakes[0]!.writes?.map((w) => w.after), [{ agent: 'agent', messageId: 'row-1' }, { agent: 'agent', messageId: 'row-2' }]);
      } else {
        assert.strictEqual(wakes[0]!.writes, undefined, 'the wake has nothing to drop it by');
      }
      gate.dispose();
    });
  }

  it("a reply with an event the host says is already answered: the wake carries no writes, but its line rows still name both events' rows", async () => {
    const judge = scriptedJudge();
    const answered = new Set<string>(['row-1']);
    const { gate, wakes } = makeGate(writeConfig('reply-line-rows.json', JUDGED), {
      judge: judge.fn, isAnswered: (after) => answered.has(after.messageId!),
    });
    gate.evaluate(chat('already answered'), { agent: 'agent', messageId: 'row-1' });
    gate.evaluate(chat('still open'), { agent: 'agent', messageId: 'row-2' });
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: true, reason: 'a direct question', inputTokens: 1 });
    await until(() => wakes.length === 1, 'the wake');
    assert.strictEqual(wakes[0]!.writes, undefined, 'premise: the answered event keeps the wake');
    assert.deepStrictEqual(wakes[0]!.lineRows, [{ agent: 'agent', messageId: 'row-1' }, { agent: 'agent', messageId: 'row-2' }]);
    gate.dispose();
  });

  it("a reply to a batch with nothing in the window to name: its wake still carries line rows, none, so a merge with another batch's wake keeps that batch's line", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('reply-no-line-rows.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('a push with no stored message of its own'));
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: true, reason: 'worth a look', inputTokens: 1 });
    await until(() => wakes.length === 1, 'the wake');
    assert.deepStrictEqual(wakes[0]!.lineRows, []);
    gate.dispose();
  });

  it('a reply asks isAnswered only about events with a stored write, never an unfilled placement', async () => {
    const judge = scriptedJudge();
    const asked: WritePlacement[] = [];
    const { gate, wakes } = makeGate(writeConfig('reply-asked-writes.json', JUDGED), {
      judge: judge.fn, isAnswered: (after) => { asked.push(after); return false; },
    });
    gate.evaluate(chat('never placed'), { agent: '' });
    gate.evaluate(chat('placed'), { agent: 'agent', messageId: 'row-2' });
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: true, reason: 'a direct question', inputTokens: 1 });
    await until(() => wakes.length === 1, 'the wake');
    assert.deepStrictEqual(asked, [{ agent: 'agent', messageId: 'row-2' }]);
    gate.dispose();
  });

  it('a reply asks isAnswered when the judge answers: an event answered while the judge read keeps the wake', async () => {
    const judge = scriptedJudge();
    const answered = new Set<string>();
    const { gate, wakes } = makeGate(writeConfig('reply-asked-late.json', JUDGED), {
      judge: judge.fn, isAnswered: (after) => answered.has(after.messageId!),
    });
    gate.evaluate(chat('answered while the judge read'), { agent: 'agent', messageId: 'row-1' });
    gate.evaluate(chat('still open'), { agent: 'agent', messageId: 'row-2' });
    await until(() => judge.waiting() === 1, 'the judge is asked');
    answered.add('row-1');
    judge.answer({ reply: true, reason: 'a direct question', inputTokens: 1 });
    await until(() => wakes.length === 1, 'the wake');
    assert.strictEqual(wakes[0]!.writes, undefined, 'the answered event keeps the wake, so it carries no writes');
    gate.dispose();
  });

  for (const [doubt, isAnswered] of [
    ['no isAnswered', undefined],
    ['an isAnswered that throws', () => { throw new Error('no'); }],
    ['an isAnswered that answers neither true nor false', (() => undefined) as unknown as () => boolean],
    ['an isAnswered that says answered', () => true],
  ] as const) {
    it(`with ${doubt}, a reply's events count as answered when it was given: the wake carries no writes`, async () => {
      const judge = scriptedJudge();
      const { gate, wakes } = makeGate(writeConfig('reply-written.json', JUDGED), {
        judge: judge.fn, ...(isAnswered ? { isAnswered } : {}),
      });
      gate.evaluate(chat('is anyone around?'), { agent: 'agent', messageId: 'row-1' });
      await until(() => judge.waiting() === 1, 'the judge is asked');
      judge.answer({ reply: true, reason: 'a direct question', inputTokens: 1 });
      await until(() => wakes.length === 1, 'the wake');
      assert.strictEqual(wakes[0]!.writes, undefined);
      gate.dispose();
    });
  }

  for (const how of ['no judge wired', 'a judge that fails, onError "wake"'] as const) {
    it(`with ${how}, a judge rule's batch carries its events' writes to the wake, and the channel a reply is owed in, as a debounce's does`, async () => {
      const judge = scriptedJudge();
      const { gate, wakes, messages } = makeGate(writeConfig('no-verdict.json', {
        policies: [{ name: 'addressed', match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: 100 } } }],
      }), {
        ...(how === 'no judge wired' ? {} : { judge: judge.fn }), isAnswered: () => true,
      });
      gate.evaluate(chat('is anyone around?', { eventType: 'mcpl:channel-incoming', tags: ['chat:addressed'] }), { agent: 'agent', messageId: 'row-1' });
      if (how !== 'no judge wired') {
        await until(() => judge.waiting() === 1, 'the judge is asked');
        judge.fail(new Error('judge down'));
      }
      await until(() => wakes.length === 1, 'the wake');
      assert.strictEqual(messages.length, 0);
      assert.deepStrictEqual(wakes[0]!.writes?.map(({ after, replyTo }) => ({ after, replyTo })),
        [{ after: { agent: 'agent', messageId: 'row-1' }, replyTo: { serverId: 'discord', channelId: 'c1' } }]);
      gate.dispose();
    });
  }

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
    assert.deepStrictEqual(wakes, [{ agentName: 'agent', reason: 'gate:debounce', lineRows: [] }], 'a batch wake, whose line has nothing to name');
    assert.strictEqual(messages.length, 0, 'events stored at arrival get no line');
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

  it("a refused call's log line names the events queued behind the call, which go with its batch, and the oldest events the cap dropped as it held them", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('cap-refused.json', {
      policies: [{ name: 'busy', match: {}, behavior: { judge: { debounceMs: 100 } } }],
    }), { judge: judge.fn, judgeOnError: 'skip' });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      for (let i = 0; i < 100; i++) gate.evaluate(chat(`a${i}`));
      await until(() => judge.waiting() === 1, 'the judge is asked');
      for (let i = 0; i < 100; i++) gate.evaluate(chat(`b${i}`));
      await advance(160);
      await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the b batch to queue behind the call');
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await settle();
    } finally {
      console.error = original;
    }
    const line = logged.find((l) => l.includes("the reply judge's call was refused"));
    assert.ok(line?.includes("its batch of 100 events, with 100 more queued behind the call, is held while the judge's calls are refused, the rule's oldest 100 events dropped at the cap"), JSON.stringify(logged));
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.heldCount, 100, 'premise: the cap kept 100');
    gate.dispose();
    const small = scriptedJudge();
    const { gate: one } = makeGate(writeConfig('refused-call-queued.json', JUDGED), { judge: small.fn, judgeOnError: 'skip' });
    one.evaluate(chat('first'));
    await until(() => small.waiting() === 1, 'the judge call');
    one.evaluate(chat('second'));
    await advance(160);
    const internal = one as unknown as { judging: Map<string, { queued: unknown[] }> };
    assert.strictEqual(internal.judging.get('ambient')?.queued.length, 1, 'premise: the second batch waits behind the call');
    const errors = await logDuring(async () => {
      small.fail(refusal("scout's provider calls are held", 60_000));
      await settle();
    });
    assert.deepStrictEqual(errors.filter((l) => l.includes('[gate] Rule')), [
      `[gate] Rule "ambient": the reply judge's call was refused (scout's provider calls are held), so its batch of 1 event, with 1 more queued behind the call, is held while the judge's calls are refused (judge onError "skip")`,
    ]);
    assert.strictEqual(judgeState(one).heldCount, 2, 'the queued batch goes with its batch');
    one.dispose();
  });

  // About twice the most a spread can pass as call arguments on Node 24.22.2
  // (between 124,887 and 125,498 elements).
  const PAST_A_SPREAD = 250_000;
  for (const route of ['held while a turn runs', 'queued while the judge decides'] as const) {
    it(`a quiet period's batch longer than a spread can pass, ${route}, keeps its newest`, async () => {
      const judge = scriptedJudge();
      const { gate } = makeGate(writeConfig(`spread-${route.split(' ')[0]}.json`, {
        policies: [{ name: 'busy', match: {}, behavior: { judge: { debounceMs: 100 } } }],
      }), { judge: judge.fn, judgeTimeoutMs: 600_000 });
      const original = console.error;
      console.error = () => {};
      try {
        const state = () => gate.getStatus().policies[0]!.judgeState!;
        if (route === 'held while a turn runs') gate.onInferenceStarted('agent');
        gate.evaluate(chat('first'));
        if (route === 'queued while the judge decides') await until(() => judge.requests.length === 1, 'the judge to decide the first batch');
        else await until(() => state().heldCount === 1, 'the first batch to be held');
        for (let i = 0; i < PAST_A_SPREAD; i++) gate.evaluate(chat(`b${i}`));
        await until(() => state().pendingCount === 0, 'the flood to end its quiet period');
        if (route === 'queued while the judge decides') assert.ok(state().judging && judge.requests.length === 1, 'premise: the flood waits for the judge');
        else assert.strictEqual(state().heldCount, 100, 'premise: the flood is held with the first batch');
      } finally {
        console.error = original;
      }
      if (route === 'held while a turn runs') gate.onInferenceEnded('agent');
      else judge.answer({ reply: false, reason: 'not yet' });
      await until(() => judge.requests.length === (route === 'held while a turn runs' ? 1 : 2), 'the newest events to be judged');
      assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content),
        Array.from({ length: 100 }, (_, i) => `b${PAST_A_SPREAD - 100 + i}`));
      gate.dispose();
    });
  }

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
    assert.ok(gate.getStatus().errors.some((e) => e.includes('failed its last 3 requests (the newest: the call failed)')), JSON.stringify(gate.getStatus().errors));
    assert.ok(!gate.getStatus().errors.some((e) => e.includes('400 model not found')), "gate_status doesn't quote an error the framework didn't write");
    gate.evaluate(chat('ok'));
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    judge.answer({ reply: false, reason: 'fine' });
    await advance(10);
    await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the verdict');
    assert.ok(!gate.getStatus().errors.some((e) => e.includes('failed its last')));
    gate.dispose();
  });

  it("a judge that fails on a provider's error shows the framework's words in gate_status, and stderr keeps the provider's", async () => {
    const SENTINEL = 'zz-provider-words-7f3a';
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('provider-words.json', JUDGED), { judge: judge.fn });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      for (let i = 0; i < 3; i++) {
        gate.evaluate(chat(`m${i}`));
        await until(() => judge.waiting() === 1, 'the judge is asked');
        judge.fail(new MembraneError({ type: 'server', retryable: true, httpStatus: 529, message: `Overloaded: ${SENTINEL}`, rawError: undefined }));
        await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.error === i + 1, 'the failure counted');
      }
    } finally {
      console.error = original;
    }
    const status = gate.getStatus();
    assert.strictEqual(status.policies[0]!.judgeState!.last!.reason, 'the model call failed (server, HTTP 529)');
    assert.ok(status.errors.some((e) => e.includes('failed its last 3 requests (the newest: the model call failed (server, HTTP 529))')), JSON.stringify(status.errors));
    assert.ok(!JSON.stringify(status).includes(SENTINEL), JSON.stringify(status));
    assert.ok(logged.some((line) => line.includes(SENTINEL)), "stderr keeps the provider's words");
    gate.dispose();
  });

  it("a judge the gate times out shows the gate's own words in gate_status", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('timeout-words.json', JUDGED), { judge: judge.fn, judgeTimeoutMs: 50 });
    const original = console.error;
    console.error = () => {};
    try {
      gate.evaluate(chat('hello'));
      await until(() => wakes.length === 1, 'the judge to be timed out and the agent woken', LONGER_THAN_ANY_START_MS);
    } finally {
      console.error = original;
    }
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.last!.reason, 'the judge took more than 50 ms');
    gate.dispose();
  });

  it("a judge whose answer held no verdict is shown in the framework's words, and stderr keeps what the answer said", async () => {
    const SENTINEL = 'zz-judge-words-7f3a';
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('no-verdict-words.json', JUDGED), { judge: judge.fn });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      for (let i = 0; i < 3; i++) {
        gate.evaluate(chat(`m${i}`));
        await until(() => judge.waiting() === 1, 'the judge is asked');
        judge.fail(new JudgeFailure("the judge's answer held no verdict", `stop: refusal, text: "${SENTINEL}"`));
        await until(() => gate.getStatus().policies[0]!.judgeState!.verdicts.error === i + 1, 'the failure counted');
      }
    } finally {
      console.error = original;
    }
    const status = gate.getStatus();
    assert.strictEqual(status.policies[0]!.judgeState!.last!.reason, "the judge's answer held no verdict");
    assert.ok(status.errors.some((e) => e.includes("(the newest: the judge's answer held no verdict)")), JSON.stringify(status.errors));
    assert.ok(!JSON.stringify(status).includes(SENTINEL) && !JSON.stringify(status).includes('refusal'), JSON.stringify(status));
    assert.ok(logged.some((line) => line.includes(SENTINEL)), 'stderr keeps what the answer said');
    gate.dispose();
  });

  it("a judge that rejects as soon as it's stopped still shows the gate's timeout, in gate_status and on stderr", async () => {
    let asked = 0;
    let stopped = 0;
    const fn: JudgeFn = (request) => new Promise<JudgeVerdict>((_, reject) => {
      asked++;
      request.signal.addEventListener('abort', () => { stopped++; reject(new DOMException('This operation was aborted', 'AbortError')); });
    });
    const { gate, wakes } = makeGate(writeConfig('abort-aware-timeout.json', JUDGED), { judge: fn, judgeTimeoutMs: 50 });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      gate.evaluate(chat('hello'));
      await until(() => wakes.length === 1, 'the judge to be timed out and the agent woken', LONGER_THAN_ANY_START_MS);
    } finally {
      console.error = original;
    }
    assert.strictEqual(gate.getStatus().policies[0]!.judgeState!.last!.reason, 'the judge took more than 50 ms');
    assert.ok(logged.some((line) => line.includes('the reply judge failed (the judge took more than 50 ms)')), JSON.stringify(logged));
    assert.deepEqual({ asked, stopped }, { asked: 1, stopped: 1 }, 'the judge was asked once, and the gate stopped it');
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

  it("a refused call is traced and counted as a refusal, apart from failures, with its hold and stated end, and under onError 'wake', where nothing is held, gate_status names no refusal", async () => {
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
    assert.strictEqual(state.last?.reason, 'the framework refused to send the call', "gate_status gives the framework's words");
    const verdict = traces.find((t) => t.type === 'gate:judge-verdict')!;
    assert.strictEqual(verdict.verdict, 'refused');
    assert.strictEqual(verdict.woke, true);
    assert.match(String(verdict.hold), /provider calls are held/);
    assert.ok(Number(verdict.until) >= refusedAt + 60_000 && Number(verdict.until) <= seenAt + 60_000, `the trace's stated end: ${String(verdict.until)}`);
    const errors = gate.getStatus().errors;
    assert.strictEqual(errors.some((e) => e.includes('reply judge has failed')), false, 'gate_status names no failing judge');
    assert.strictEqual(errors.some((e) => e.includes('refused')), false, JSON.stringify(errors));
    gate.dispose();
  });

  it("under onError 'wake', each batch is asked about though an earlier call was refused, and each refused batch, one held for a turn among them, wakes the agent and is logged and traced", async () => {
    const judge = scriptedJudge();
    const { gate, wakes, traces } = makeGate(writeConfig('refused-wake.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    const logged = await logDuring(async () => {
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => wakes.length === 1, 'the refused batch wakes the agent');
      gate.evaluate(chat('second'));
      await until(() => judge.waiting() === 1, "the next batch asked about within the refusal's stated wait");
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => wakes.length === 2, 'the next refused batch wakes the agent');
      gate.onInferenceStarted('agent');
      gate.evaluate(chat('third'));
      await until(() => judgeState(gate).heldCount === 1, 'the batch held for the turn');
      gate.onInferenceEnded('agent');
      await until(() => judge.waiting() === 1, "the turn-held batch asked about at the turn's end");
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => wakes.length === 3, 'the turn-held refused batch wakes the agent');
    });
    assert.deepStrictEqual(judge.requests.map((r) => r.events.map((e) => e.content)), [['first'], ['second'], ['third']]);
    assert.strictEqual(judgeState(gate).verdicts.refused, 3);
    assert.strictEqual(judgeState(gate).heldCount, 0, 'nothing held for a refusal');
    assert.strictEqual(logged.filter((l) => l.includes("the reply judge's call was refused")).length, 3, JSON.stringify(logged));
    assert.strictEqual(traces.filter((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused').length, 3);
    gate.dispose();
  });


  it("under onError 'wake', a refused call's batch whose delivery throws is logged by its rule's name", async () => {
    const judge = scriptedJudge();
    let failing = false;
    const { gate } = makeGate(writeConfig('refused-wake-throws.json', JUDGED), {
      judge: judge.fn, residents: ['agent'],
      isHeld: () => {
        if (failing) throw new Error('zz isHeld failed\n[gate] a forged line');
        return false;
      },
    });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    failing = true;
    const logged = await logDuring(async () => {
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => judgeState(gate).verdicts.refused === 1, 'the refusal recorded');
    });
    const line = logged.find((l) => l.includes("[gate] Rule \"ambient\": its pending batch of 1 event couldn't be delivered"));
    assert.ok(line, JSON.stringify(logged));
    assert.ok(line.includes('zz isHeld failed\\n'), JSON.stringify(line));
    assert.ok(!line.includes('\n'), 'the error text is quoted, so it starts no line of its own');
    gate.dispose();
  });

  it("under 'skip', a REPLY, a WAIT or a failure on another rule's batch, asked before or after the refused call, leaves the refused batch held to its stated end", async () => {
    for (const refusedAsked of ['first', 'second'] as const) {
      for (const outcome of ['reply', 'wait', 'failure'] as const) {
        const label = `the refused call asked ${refusedAsked}, the other answered by ${outcome}`;
        const judge = scriptedJudge();
        const { gate } = makeGate(writeConfig(`refused-other-${refusedAsked}-${outcome}.json`, TWO_RULES), { judge: judge.fn, judgeOnError: 'skip' });
        const held = () => gate.getStatus().policies[0]!.judgeState!.heldCount;
        const decided = () => {
          const v = gate.getStatus().policies[1]!.judgeState!.verdicts;
          return v.reply + v.wait + v.error;
        };
        await logDuring(async () => {
          gate.evaluate(refusedAsked === 'first' ? chat('hello') : elsewhere('hi'));
          await until(() => judge.waiting() === 1, `${label}: the first call`);
          gate.evaluate(refusedAsked === 'first' ? elsewhere('hi') : chat('hello'));
          await until(() => judge.waiting() === 2, `${label}: the second call`);
          judge.failAt(refusedAsked === 'first' ? 0 : 1, refusal("scout's provider calls are held", 1_000));
          await until(() => held() === 1, `${label}: the refused batch held`);
          if (outcome === 'failure') judge.fail(new Error('provider down'));
          else judge.answer({ reply: outcome === 'reply', reason: 'decided' });
          await until(() => decided() === 1, `${label}: the other call decided`);
          await advance(50);
        });
        assert.strictEqual(judge.requests.length, 2, `${label}: the held batch isn't asked again`);
        assert.strictEqual(held(), 1, `${label}: still held`);
        assert.ok(gate.getStatus().errors.some((e) => e.startsWith(`Rule "first"'s reply judge call was refused`)), `${label}: ${JSON.stringify(gate.getStatus().errors)}`);
        await until(() => judge.waiting() === 1, `${label}: asked again at the refusal's stated end`);
        assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['hello'], label);
        judge.answer({ reply: false, reason: 'chatter' });
        gate.dispose();
      }
    }
  });


  const refusedOnce = async (onError: 'wake' | 'skip', file: string, opts: { config?: GateConfig; waitMs?: number | null; isHeld?: (serverId: string | undefined, channelId: string | undefined) => boolean } = {}) => {
    const judge = scriptedJudge();
    const made = makeGate(writeConfig(file, opts.config ?? JUDGED), { judge: judge.fn, judgeOnError: onError, residents: ['agent'], ...(opts.isHeld ? { isHeld: opts.isHeld } : {}) });
    made.gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(opts.waitMs === null ? refusal('a live surgery for scout holds the store') : refusal("scout's provider calls are held", opts.waitMs ?? 60_000));
    await until(() => judgeState(made.gate).verdicts.refused === 1, 'the refusal recorded');
    return { ...made, judge };
  };
  const twoRules = (later: { name: string; debounceMs: number }): GateConfig => ({
    policies: [
      { name: 'soon', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 100 } } },
      { name: later.name, match: { scope: ['mcpl:channel-incoming'] }, behavior: { judge: { debounceMs: later.debounceMs } } },
    ],
  });
  const dueOf = (gate: EventGate, name: string) => (gate as unknown as { debounceTimers: Map<string, { dueAt: number }> }).debounceTimers.get(name)!.dueAt;
  const listed = (gate: EventGate) => gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain, w.at]);

  it("under onError 'wake', after a refused call the wake list gives each judge rule's collecting batch as going to the judge at its due time, a maybe", async () => {
    const { gate } = await refusedOnce('wake', 'refused-wake-listed.json', { config: twoRules({ name: 'later', debounceMs: 120_000 }) });
    gate.evaluate(chat('second'));
    gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
    assert.deepStrictEqual(listed(gate), [
      ['rule "soon"\'s batch of 1 event goes to the judge', false, dueOf(gate, 'soon')],
      ['rule "later"\'s batch of 1 event goes to the judge', false, dueOf(gate, 'later')],
    ]);
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.kind), ['judge-batch', 'judge-batch']);
    gate.dispose();
  });

  it("under onError 'skip', the wake list gives a batch held for a refusal at the refusal's stated end, and past it while a turn holds it, and each judge rule's collecting batch as going to the judge, joining its rule's held batch", async () => {
    {
      const { gate } = await refusedOnce('skip', 'refused-skip-listed.json', { config: twoRules({ name: 'later', debounceMs: 120_000 }) });
      gate.evaluate(chat('second'));
      gate.evaluate({ content: 'hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c2' });
      const end = refusalEnd(gate, 'soon');
      assert.deepStrictEqual(listed(gate), [
        ['rule "soon"\'s batch of 1 event, which joins its held batch when it fires, goes to the judge', false, dueOf(gate, 'soon')],
        ['rule "soon"\'s batch of 1 event, held for the judge while its calls are refused', false, end],
        ['rule "later"\'s batch of 1 event goes to the judge', false, dueOf(gate, 'later')],
      ]);
      gate.dispose();
    }
    {
      const { gate } = await refusedOnce('skip', 'refused-skip-turn-listed.json');
      gate.evaluate(chat('second'));
      const end = refusalEnd(gate);
      const due = dueOf(gate, 'ambient');
      const joins = 'rule "ambient"\'s batch of 1 event, which joins its held batch when it fires, goes to the judge';
      const held = 'rule "ambient"\'s batch of 1 event, held for the judge while its calls are refused';
      assert.deepStrictEqual(listed(gate), [[joins, false, due], [held, false, end]], 'premise: no turn runs');
      assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.kind), ['judge-batch', 'judge-batch']);
      gate.onInferenceStarted('agent');
      assert.deepStrictEqual(listed(gate), [
        [joins, false, due],
        [`${held} and, past the refusal's end, while a turn holds it`, false, end],
      ]);
      gate.dispose();
    }
    {
      const { gate, judge } = await refusedOnce('skip', 'refused-no-end-joins.json', { waitMs: null });
      gate.evaluate(chat('second'));
      assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.what), [
        'rule "ambient"\'s batch of 1 event, which joins its held batch when it fires, goes to the judge',
        'rule "ambient"\'s batch of 1 event, held for the judge',
      ]);
      await until(() => judge.waiting() === 1, 'the next batch asked');
      assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second'], 'premise: the ask takes the held batch in');
      judge.answer({ reply: false, reason: 'chatter' });
      gate.dispose();
    }
  });



  it("lists a judge rule's batch as debounced when no judge is wired, since it's delivered as a debounce's is", () => {
    const { gate } = makeGate(writeConfig('no-judge-listed.json', JUDGED), { residents: ['agent'] });
    gate.evaluate(chat('hello'));
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain]), [['rule "ambient"\'s debounced batch of 1 event', true]]);
    gate.dispose();
  });

  it('a refused call under the default onError wakes the agent with the events queued behind it', async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('refused-queued.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('first'), { agent: 'agent', messageId: 'row-1' });
    await until(() => judge.waiting() === 1, 'the judge call');
    gate.evaluate(chat('second'), { agent: 'agent', messageId: 'row-2' });
    await until(() => judgeState(gate).pendingCount === 0, 'the second event to queue behind the call');
    judge.fail(refusal("scout's provider calls are held", 60_000));
    await until(() => wakes.length === 1, 'the wake');
    assert.deepStrictEqual(wakes[0]!.writes?.map((w) => w.after.messageId), ['row-1', 'row-2'], 'the wake is for both events');
    assert.strictEqual(judgeState(gate).heldCount, 0);
    gate.dispose();
  });


  it("marks a refusal's hold text as supplied, on one line, in the log and the trace, and gate_status gives none of it", async () => {
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
    const notice = gate.getStatus().errors.find((e) => e.startsWith('Rule "ambient"\'s reply judge call was refused'))!;
    assert.ok(notice.startsWith('Rule "ambient"\'s reply judge call was refused until '), notice);
    assert.ok(notice.endsWith(': 1 event held for the judge.'), notice);
    assert.strictEqual(judgeState(gate).last!.reason, 'the framework refused to send the call');
    assert.ok(!JSON.stringify(gate.getStatus()).includes('quota spent'), "gate_status gives none of the hold's words");
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
    assert.strictEqual(judge.waiting(), 1, "the held batch judged at the refusal's end");
    assert.ok(judge.askedAt[1]! - refusedAt >= 1_200, `asked again ${judge.askedAt[1]! - refusedAt} ms on, not before the stated wait ends`);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under onError 'skip', a refused call holds its batch, with the events queued behind it, and the judge decides it once the refusal's stated wait ends", async () => {
    const judge = scriptedJudge();
    const { gate, wakes, traces } = makeGate(writeConfig('refused-skip.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', isAnswered: () => false });
    gate.evaluate(chat('first'), { agent: 'agent', messageId: 'row-1' });
    await until(() => judge.waiting() === 1, 'the judge call');
    gate.evaluate(chat('second'), { agent: 'agent', messageId: 'row-2' });
    await until(() => judgeState(gate).pendingCount === 0, 'the second event to queue behind the call');
    const refusedAt = Date.now();
    judge.fail(refusal('claude-haiku-5-5 is held for scout', 1_200));
    await until(() => judgeState(gate).heldCount === 2, 'the batch and its queue to be held');
    assert.strictEqual(wakes.length, 0);
    assert.strictEqual(traces.filter((t) => t.type === 'gate:judge-verdict').at(-1)!.woke, false);
    assert.ok(gate.getStatus().errors.some((e) => e.startsWith('Rule "ambient"\'s reply judge call was refused until ') && e.endsWith(': 2 events held for the judge.')), JSON.stringify(gate.getStatus().errors));
    await lastMillisecond(refusalEnd(gate), () => assert.strictEqual(judge.requests.length, 1, 'not asked a millisecond before the stated wait ends'));
    assert.strictEqual(judge.waiting(), 1, 'the held batch judged as the wait ends');
    assert.ok(judge.askedAt[1]! - refusedAt >= 1_200, `asked again ${judge.askedAt[1]! - refusedAt} ms on, not before the stated wait ends`);
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
    judge.answer({ reply: true, reason: 'a question' });
    await until(() => wakes.length === 1, 'the wake');
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('claude-haiku-5-5 is held for scout')), false, 'the refusal is over');
    assert.deepStrictEqual(wakes[0]!.writes?.map((w) => w.after.messageId), ['row-1', 'row-2'], 'the wake is for both events');
    assert.deepStrictEqual(judgeState(gate).verdicts, { reply: 1, wait: 0, error: 0, refused: 1 });
    gate.dispose();
  });

  it("under 'skip', a batch refused again when it's judged again is held again, to the new refusal's end, and its second refusal is counted but neither logged nor traced", async () => {
    const judge = scriptedJudge();
    const { gate, wakes, traces } = makeGate(writeConfig('refused-again.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    let againAt = 0;
    const logged = await logDuring(async () => {
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      judge.fail(refusal("scout's provider calls are held", 1_000));
      await until(() => judge.waiting() === 1, "the batch judged again at the refusal's end", 4_000);
      againAt = Date.now();
      judge.fail(refusal("scout's provider calls are held", 1_000));
      await until(() => judgeState(gate).verdicts.refused === 2, 'the second refusal recorded');
    });
    assert.strictEqual(logged.filter((l) => l.includes("the reply judge's call was refused")).length, 1, JSON.stringify(logged));
    assert.strictEqual(traces.filter((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused').length, 1);
    await lastMillisecond(refusalEnd(gate), () => assert.strictEqual(judge.requests.length, 2, "not asked a millisecond before the second refusal's end"));
    assert.strictEqual(judge.waiting(), 1, 'judged as the second refusal ends');
    assert.ok(judge.askedAt[2]! - againAt >= 1_000, `held to the second refusal's end (${judge.askedAt[2]! - againAt} ms)`);
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first']);
    judge.answer({ reply: false, reason: 'chatter' });
    await advance(20);
    assert.strictEqual(wakes.length, 0);
    assert.deepStrictEqual(judgeState(gate).verdicts, { reply: 0, wait: 1, error: 0, refused: 2 });
    gate.dispose();
  });

  it("under 'skip', a batch its rule fires while its batch is held for a refusal's stated wait takes the held batch in and is asked; refused again, the whole is held to the new refusal's end, and that refusal is counted but neither logged nor traced", async () => {
    const judge = scriptedJudge();
    const { gate, traces } = makeGate(writeConfig('refused-joins.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    let againAt = 0;
    const logged = await logDuring(async () => {
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => judgeState(gate).heldCount === 1, 'the batch held');
      gate.evaluate(chat('second'));
      await until(() => judge.waiting() === 1, 'the new batch asked, with the held one');
      assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
      assert.strictEqual(judgeState(gate).heldCount, 0, 'the held batch taken into the call');
      againAt = Date.now();
      judge.fail(refusal("scout's provider calls are held", 1_000));
      await until(() => judgeState(gate).heldCount === 2, 'the whole held again');
    });
    await lastMillisecond(refusalEnd(gate), () => assert.strictEqual(judge.requests.length, 2, "not asked a millisecond before the new refusal's end"));
    assert.strictEqual(judge.waiting(), 1, "the whole asked at the new refusal's end");
    assert.ok(judge.askedAt[2]! - againAt >= 1_000, `asked again ${judge.askedAt[2]! - againAt} ms after the second refusal`);
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
    assert.strictEqual(judgeState(gate).verdicts.refused, 2);
    assert.strictEqual(logged.filter((l) => l.includes("the reply judge's call was refused")).length, 1, JSON.stringify(logged));
    assert.strictEqual(traces.filter((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused').length, 1);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under 'skip', a held batch's first refusal after a turn stops a call that took it in is logged and traced, as its first refusal was", async () => {
    const judge = scriptedJudge();
    const { gate, traces } = makeGate(writeConfig('refused-stopped.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', residents: ['agent'] });
    const logged = await logDuring(async () => {
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      judge.fail(refusal('a live surgery for scout holds the store'));
      await until(() => judgeState(gate).heldCount === 1, 'the batch held');
      gate.evaluate(chat('second'));
      await until(() => judge.waiting() === 1, 'the next batch asked, with the held one');
      gate.onInferenceStarted('agent');
      await until(() => judgeState(gate).heldCount === 2, 'the call stopped by the turn, its batch held');
      gate.onInferenceEnded('agent');
      await until(() => judge.requests.length === 3, "asked again at the turn's end");
      assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
      judge.failAt(1, refusal('a live surgery for scout holds the store'));
      await until(() => judgeState(gate).verdicts.refused === 2, 'the refusal after the stop recorded');
    });
    assert.strictEqual(logged.filter((l) => l.includes("the reply judge's call was refused")).length, 2, JSON.stringify(logged));
    assert.strictEqual(traces.filter((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused').length, 2);
    gate.dispose();
  });

  it("under 'skip', a held batch's first refusal after a release is logged and traced with its own hold, and gate_status names the batch it holds", async () => {
    const judge = scriptedJudge();
    const { gate, traces } = makeGate(writeConfig('refused-after-release-logged.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    const logged = await logDuring(async () => {
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => judgeState(gate).heldCount === 1, 'the batch held');
      gate.judgeRefusalsMayHaveLifted();
      await until(() => judge.waiting() === 1, 'asked again at the release');
      judge.fail(refusal('a live surgery for scout holds the store'));
      await until(() => judgeState(gate).verdicts.refused === 2, 'the refusal after the release recorded');
    });
    const lines = logged.filter((l) => l.includes("the reply judge's call was refused"));
    assert.strictEqual(lines.length, 2, JSON.stringify(logged));
    assert.ok(lines[1]!.includes('(a live surgery for scout holds the store)'), lines[1]);
    assert.deepStrictEqual(traces.filter((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused').map((t) => t.hold), ["scout's provider calls are held", 'a live surgery for scout holds the store']);
    assert.ok(gate.getStatus().errors.includes('Rule "ambient"\'s reply judge call was refused: 1 event held for the judge.'), JSON.stringify(gate.getStatus().errors));
    gate.dispose();
  });

  it("under 'skip', a held batch's first refusal after a release that comes while a call that took it in is out is logged and traced with its own hold", async () => {
    const judge = scriptedJudge();
    const { gate, traces } = makeGate(writeConfig('refused-release-in-flight.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    const logged = await logDuring(async () => {
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      judge.fail(refusal('a live surgery for scout holds the store'));
      await until(() => judgeState(gate).heldCount === 1, 'the batch held');
      gate.evaluate(chat('second'));
      await until(() => judge.waiting() === 1, 'the next batch asked, with the held one');
      assert.strictEqual(judgeState(gate).heldCount, 0, 'premise: the held batch is in the call');
      gate.judgeRefusalsMayHaveLifted();
      judge.fail(refusal("scout's provider calls are held", 60_000));
      await until(() => judgeState(gate).verdicts.refused === 2, 'the refusal after the release recorded');
    });
    const lines = logged.filter((l) => l.includes("the reply judge's call was refused"));
    assert.strictEqual(lines.length, 2, JSON.stringify(logged));
    assert.ok(lines[1]!.includes("(scout's provider calls are held)"), lines[1]);
    assert.deepStrictEqual(traces.filter((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused').map((t) => t.hold), ['a live surgery for scout holds the store', "scout's provider calls are held"]);
    gate.dispose();
  });

  it("under 'skip', a refusal that states no end holds its batch through turns' ends until the framework says a hold ended, but a batch its rule fires during a turn takes it in and is asked as the turn ends", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-no-end.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip', residents: ['agent'] });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    assert.ok(gate.getStatus().errors.includes('Rule "ambient"\'s reply judge call was refused: 1 event held for the judge.'), JSON.stringify(gate.getStatus().errors));
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await advance(100);
    assert.strictEqual(judge.requests.length, 1, "a turn's end with nothing new from the rule doesn't ask again");
    gate.onInferenceStarted('agent');
    gate.evaluate(chat('during'));
    await until(() => judgeState(gate).heldCount === 2, 'the batch that fired during the turn held with it');
    assert.strictEqual(judge.requests.length, 1, 'nothing is asked while the turn runs');
    gate.onInferenceEnded('agent');
    await until(() => judge.waiting() === 1, "the whole asked as the turn ends, since its rule fired");
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'during']);
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).verdicts.refused === 2 && judgeState(gate).heldCount === 2, 'refused again, held again');
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await advance(100);
    assert.strictEqual(judge.requests.length, 2, "again a turn's end with nothing new doesn't ask");
    gate.judgeRefusalsMayHaveLifted();
    await until(() => judge.waiting() === 1, 'the held batch judged once a hold ends');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'during']);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under 'skip', a refusal a call reports after the framework said a hold ended, while the call was out, doesn't hold its batch: it's asked again, and refused again it's counted, not logged or traced again", async () => {
    const judge = scriptedJudge();
    const { gate, traces } = makeGate(writeConfig('refused-after-release-in-flight.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    const logged = await logDuring(async () => {
      gate.evaluate(chat('first'));
      await until(() => judge.waiting() === 1, 'the judge call');
      gate.judgeRefusalsMayHaveLifted();
      judge.fail(refusal('a live surgery for scout holds the store'));
      await until(() => judge.waiting() === 1 && judge.requests.length === 2, 'asked again, since a hold ended while the call was out');
      judge.fail(refusal('a live surgery for scout holds the store'));
      await until(() => judgeState(gate).verdicts.refused === 2 && judgeState(gate).heldCount === 1, 'refused again, and held');
    });
    assert.deepStrictEqual(judge.requests[1]!.events.map((e) => e.content), ['first']);
    assert.strictEqual(logged.filter((l) => l.includes("the reply judge's call was refused")).length, 1, JSON.stringify(logged));
    assert.strictEqual(traces.filter((t) => t.type === 'gate:judge-verdict' && t.verdict === 'refused').length, 1);
    gate.judgeRefusalsMayHaveLifted();
    await until(() => judge.waiting() === 1, 'asked at the release');
    judge.answer({ reply: false, reason: 'chatter' });
    await until(() => judgeState(gate).verdicts.wait === 1, 'the verdict applied');
    assert.strictEqual(judgeState(gate).heldCount, 0);
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('refused')), false, JSON.stringify(gate.getStatus().errors));
    gate.dispose();
  });

  it("under 'skip', a batch asked while a refusal with no end holds its rule's batch takes the held events in, and a verdict on it leaves nothing held", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-later-call.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    assert.ok(gate.getStatus().errors.some((e) => e.startsWith('Rule "ambient"\'s reply judge call was refused')), 'gate_status names the refusal');
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
      certain: false, kind: 'judge-batch', when: "with its rule's next batch, or once the hold on its calls is released, and no turn or quiesce holds it", what: 'rule "first"\'s batch of 1 event, held for the judge',
    }]);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });



  it("under 'skip', a batch that took in its rule's batch held for a refusal with no end, and whose call then fails, is dropped with the held events, logged as dropped, and nothing is left held", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-later-fails.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('a live surgery for scout holds the store'));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    gate.evaluate(chat('second'));
    await until(() => judge.waiting() === 1, "the later batch's call");
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first', 'second']);
    const logged = await logDuring(async () => {
      judge.fail(new Error('provider down'));
      await until(() => judgeState(gate).verdicts.error === 1, 'the failure recorded');
    });
    assert.ok(logged.some((line) => line.includes('so its batch of 2 events is dropped without waking the agent (judge onError "skip")')), logged.join('\n'));
    assert.strictEqual(judgeState(gate).heldCount, 0);
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('refused')), false, JSON.stringify(gate.getStatus().errors));
    gate.dispose();
  });

  it("a release a trace listener makes as it hears of a refusal releases the refused batch", async () => {
    const judge = scriptedJudge();
    let release: (() => void) | undefined;
    const { gate } = makeGate(writeConfig('refused-release-in-trace.json', JUDGED), {
      judge: judge.fn, judgeOnError: 'skip',
      onTrace: (t) => { if (t.type === 'gate:judge-verdict' && t.verdict === 'refused') release?.(); },
    });
    release = () => gate.judgeRefusalsMayHaveLifted();
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal('claude-haiku-5-5 is held for scout until released'));
    await until(() => judge.waiting() === 1, 'the refused batch judged on the release its trace prompted');
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['first']);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("gate_status names each rule's batch held for a refusal, in rule order, and each goes back to the judge at its own refusal's stated end", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-two-rules.json', TWO_RULES), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('hello'));
    await until(() => judge.waiting() === 1, "first's call");
    gate.evaluate(elsewhere('hi'));
    await until(() => judge.waiting() === 2, "second's call, asked after first's");
    await logDuring(async () => {
      judge.failAt(1, refusal("scout's provider calls are held", 60_000));
      await until(() => gate.getStatus().policies[1]!.judgeState!.heldCount === 1, "second's batch held");
      judge.failAt(0, refusal('claude-haiku-5-5 is held for scout', 1_000));
      await until(() => gate.getStatus().policies[0]!.judgeState!.heldCount === 1, "first's batch held, after second's");
    });
    const iso = (rule: string) => new Date(refusalEnd(gate, rule)).toISOString();
    assert.ok(gate.getStatus().errors.includes(
      `Rule "first"'s reply judge call was refused until ${iso('first')}: 1 event held for the judge.`
      + ` Rule "second"'s reply judge call was refused until ${iso('second')}: 1 event held for the judge.`,
    ), JSON.stringify(gate.getStatus().errors));
    await until(() => judge.waiting() === 1, "first's batch asked again at its own refusal's end");
    assert.deepStrictEqual(judge.requests.at(-1)!.events.map((e) => e.content), ['hello']);
    assert.strictEqual(gate.getStatus().policies[1]!.judgeState!.heldCount, 1, "second's batch still held to its own end");
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
    gate.judgeRefusalsMayHaveLifted();
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
    assert.strictEqual(judge.waiting(), 1, "judged at the refusal's end");
    assert.ok(judge.askedAt[1]! - refusedAt >= 1_200, `the turn's end sent nothing to a judge still refused (asked ${judge.askedAt[1]! - refusedAt} ms on)`);
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("under 'skip', a batch held for a refusal whose stated wait ends while the host is quiesced goes back to the judge once the quiesce clears", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('refused-quiesced.json', JUDGED), { judge: judge.fn, judgeOnError: 'skip' });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    judge.fail(refusal("scout's provider calls are held", 1_200));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held');
    gate.setQuiesced(true);
    await advance(refusalEnd(gate) - Date.now() + 100);
    assert.strictEqual(judge.requests.length, 1, 'not asked while the host is quiesced, though the stated wait has ended');
    assert.strictEqual(judgeState(gate).heldCount, 1, 'still held');
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('refused')), false, "past the refusal's end, gate_status names it no longer");
    gate.setQuiesced(false);
    await until(() => judge.waiting() === 1, 'judged once the quiesce clears');
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
    assert.ok(gate.getStatus().errors.includes('Rule "ambient"\'s reply judge call was refused: 1 event held for the judge.'), JSON.stringify(gate.getStatus().errors));
    await advance(1_300);
    assert.strictEqual(judge.requests.length, 1, 'not asked again while the hold lasts');
    gate.judgeRefusalsMayHaveLifted();
    await until(() => judge.waiting() === 1, 'judged once the hold is released');
    judge.answer({ reply: false, reason: 'chatter' });
    gate.dispose();
  });

  it("a refusal is counted apart from the failing streak: between or after its failures it neither counts toward the streak nor resets it, and a success does", async () => {
    const fail = new Error('provider down');
    const refused = () => refusal('a live surgery for scout holds the store');
    const plain = (n: number) => `failed its last ${n} requests (the newest: `;
    const cases: Array<[string, Array<unknown | JudgeVerdict>, Record<number, string>]> = [
      ['between', [fail, refused(), fail, fail], { 3: plain(3) }],
      ['after', [fail, fail, fail, refused()], { 2: plain(3), 3: plain(3) }],
      ['outside', [refused(), fail, fail, fail, fail, refused(), { reply: false, reason: 'chatter' }, fail, fail, fail], { 3: plain(3), 5: plain(4), 9: plain(3) }],
    ];
    for (const [name, steps, said] of cases) {
      const judge = scriptedJudge();
      const { gate } = makeGate(writeConfig(`refused-streak-${name}.json`, JUDGED), { judge: judge.fn });
      const failing = () => gate.getStatus().errors.find((e) => e.includes('reply judge has failed its last'));
      for (const [i, step] of steps.entries()) {
        gate.evaluate(chat(`hello ${i}`));
        await until(() => judge.waiting() === 1, `${name}: judge call ${i}`);
        if (step && typeof step === 'object' && 'reply' in step) judge.answer(step as JudgeVerdict);
        else judge.fail(step);
        await advance(20);
        if (said[i] !== undefined) assert.ok(failing()?.includes(said[i]!), `${name}, after step ${i}: ${String(failing())}`);
      }
      if (name === 'between') assert.deepStrictEqual([judgeState(gate).verdicts.error, judgeState(gate).verdicts.refused], [3, 1], 'the refusal is counted, and the errors before it stay counted');
      gate.dispose();
    }
  });

  it("under onError 'wake', a refusal that states no end leaves gate_status naming none, its rule's last verdict shows it, and the next batch is asked about", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('refused-wake-no-end.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('first'));
    await until(() => judge.waiting() === 1, 'the judge call');
    await logDuring(async () => {
      judge.fail(refusal('a live surgery for scout holds the store'));
      await until(() => wakes.length === 1, 'the refused batch wakes the agent');
    });
    assert.strictEqual(gate.getStatus().errors.some((e) => e.includes('refused')), false, JSON.stringify(gate.getStatus().errors));
    assert.deepStrictEqual([judgeState(gate).last?.verdict, judgeState(gate).last?.reason], ['refused', 'the framework refused to send the call']);
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
      assert.ok(gate.getStatus().errors.some((e) => e.startsWith('Rule "ambient"\'s reply judge call was refused until ')), JSON.stringify(gate.getStatus().errors));
      assert.ok(delays.length > 0 && delays.every((ms) => ms <= MAX_TIMER_MS), `no timer is set past what Node can hold: ${delays.join(', ')}`);
      const armed = delays.length;
      mock.timers.tick(MAX_TIMER_MS);
      await settle();
      assert.strictEqual(judge.requests.length, 1, "not asked again when the first timer fires");
      assert.deepStrictEqual(delays.slice(armed), [3_000_000_000 - MAX_TIMER_MS], 'a timer is armed for exactly the rest of the wait');
      mock.timers.tick(3_000_000_000 - MAX_TIMER_MS - 1);
      await settle();
      assert.strictEqual(judge.requests.length, 1, 'not asked a millisecond before the wait ends');
      mock.timers.tick(1);
      await settle();
      assert.strictEqual(judge.waiting(), 1, 'asked once the stated wait ends');
    } finally {
      globalThis.setTimeout = timeout;
    }
    judge.fail(refusal("scout's provider calls are held", 1e16));
    await until(() => judgeState(gate).heldCount === 1, 'the batch held again');
    assert.ok(gate.getStatus().errors.includes("Rule \"ambient\"'s reply judge call was refused: 1 event held for the judge."), JSON.stringify(gate.getStatus().errors));
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
    const { gate, wakes } = makeGate(writeConfig('queued-reply.json', JUDGED), { judge: judge.fn, isAnswered: () => false });
    gate.evaluate(chat('one'), { agent: 'agent', messageId: 'row-1' });
    await advance(160);
    await until(() => judge.waiting() === 1, 'the judge is asked');
    gate.evaluate(chat('two', { channelId: 'c2', metadata: { authorId: 'u1', channelName: 'beds' } }), { agent: 'agent', messageId: 'row-2' });
    await advance(160);
    await until(() => gate.getStatus().policies[0]!.judgeState!.pendingCount === 0, 'the second batch to queue behind the call');
    assert.strictEqual(judge.requests.length, 1, 'one request at a time per rule');
    judge.answer({ reply: true, reason: 'ok' });
    await advance(10);
    await until(() => wakes.length === 1, 'the wake');
    assert.strictEqual(judge.requests.length, 1);
    assert.deepStrictEqual(wakes[0]!.writes?.map((w) => w.after.messageId), ['row-1', 'row-2'], 'the queued batch is delivered with the judged one');
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
    assert.deepStrictEqual(wakes.map((w) => [w.what, w.certain, w.kind]), [
      ['rule "files"\'s debounced batch of 1 event', true, 'debounce'],
      ['rule "other-room"\'s batch of 1 event goes to the judge', false, 'judge-batch'],
      ['its own skip_reply timer', true, 'self-wake'],
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
      ['once the judge decides it', 'rule "first"\'s batch of 1 event, which the judge is deciding, with 1 event queued behind it, sent to the judge unless the call wakes the agent', false],
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
    assert.deepStrictEqual(gate.upcomingWakes(['agent'], 'second'), [{ certain: false, kind: 'judge-batch', when: 'once no turn or quiesce holds it', what: 'rule "first"\'s batch of 1 event, held for the judge' }]);
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
    assert.deepStrictEqual(gate.upcomingWakes(['agent']), [{ certain: true, kind: 'debounce', when: "once no turn runs and the host isn't quiesced", what: '1 event buffered for delivery' }]);
    gate.dispose();
  });

  for (const [what, writes, certain] of [
    ['each written to the agent only may wake it, since an answered wake starts no turn', [{ agent: 'agent', messageId: 'row-1' }, { agent: 'agent', messageId: 'row-2' }], false],
    ['with an event given no write, they wake it: the framework has no write to drop the wake by', [{ agent: 'agent', messageId: 'row-1' }, undefined], true],
  ] as const) {
    it(`lists events buffered while the host is quiesced as a debounced batch's: ${what}`, async () => {
      const { gate } = makeGate(writeConfig('upcoming-quiesced-written.json', {
        policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 30 } }],
      }));
      gate.setQuiesced(true);
      writes.forEach((after: WritePlacement | undefined, i) => {
        gate.evaluate({ content: `notes-${i}.md`, eventType: 'workspace:modified', serverId: '', channelId: '' }, after);
      });
      await until(() => gate.inferenceDiagnostics().bufferedEvents === 2, 'the fired batch buffered while the host is quiesced');
      assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => [w.what, w.certain]), [['2 events buffered for delivery', certain]]);
      gate.dispose();
    });
  }

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
    assert.deepStrictEqual(gate.upcomingWakes(['agent']), [{ certain: true, kind: 'debounce', when: "once no turn runs and the host isn't quiesced", what: '1 event buffered for delivery' }]);
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

  const toAgent = { agent: 'agent', messageId: 'row-1' };
  for (const [what, writes, woken, certain] of [
    ['its one event written to the agent it wakes only may wake it, since an answered batch starts no turn', [toAgent], ['agent'], false],
    ['each of its events written to the agent it wakes only may wake it', [toAgent, { agent: 'agent', messageId: 'row-2' }], ['agent'], false],
    ['with an event given no write, it wakes the agent: the framework has no write to drop the wake by', [toAgent, undefined], ['agent'], true],
    ["with an event written to another agent's window, it wakes the agent", [{ agent: 'other', messageId: 'row-1' }], ['agent'], true],
    ['with a write that names no agent, it wakes the agent', [{ messageId: 'row-1' }], ['agent'], true],
    ["it wakes a co-resident, whom the delivery agent's answer doesn't take it from", [toAgent], ['agent', 'other'], true],
  ] as const) {
    it(`tells the judge of a pending debounced batch: ${what}`, () => {
      const { gate } = makeGate(writeConfig('upcoming-written.json', {
        policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } }],
      }));
      writes.forEach((after: WritePlacement | undefined, i) => {
        gate.evaluate({ content: `notes-${i}.md`, eventType: 'workspace:modified', serverId: '', channelId: '' }, after);
      });
      const n = writes.length;
      assert.deepStrictEqual(gate.upcomingWakes([...woken]).map((w) => [w.what, w.certain]),
        [[`rule "files"'s debounced batch of ${n} ${n === 1 ? 'event' : 'events'}`, certain]]);
      gate.dispose();
    });
  }

  it("tells the judge of a pending debounced batch split by recipient: each agent's wake is told by the events delivery gives it", () => {
    const { gate } = makeGate(writeConfig('upcoming-split.json', {
      policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } }],
    }));
    gate.evaluate({ content: 'a.md', eventType: 'workspace:modified', serverId: '', channelId: '', recipients: ['agent'] }, { agent: 'agent', messageId: 'row-1' });
    gate.evaluate({ content: 'b.md', eventType: 'workspace:modified', serverId: '', channelId: '', recipients: ['other'] }, { agent: 'other', messageId: 'row-2' });
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.certain), [false], "the agent's wake has its own event's write alone");
    assert.deepStrictEqual(gate.upcomingWakes(['agent', 'other']).map((w) => w.certain), [false], "and so has the other's");
    gate.dispose();
  });

  it("tells the judge of a pending debounced batch split by recipient: an agent given none of its events doesn't make the wake certain", () => {
    const { gate } = makeGate(writeConfig('upcoming-split-none.json', {
      policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } }],
    }));
    gate.evaluate({ content: 'a.md', eventType: 'workspace:modified', serverId: '', channelId: '', recipients: ['agent'] }, { agent: 'agent', messageId: 'row-1' });
    assert.deepStrictEqual(gate.upcomingWakes(['agent', 'other']).map((w) => w.certain), [false], "the other agent is given no event, so delivery doesn't wake it");
    gate.dispose();
  });

  it("tells the judge of a pending debounced batch split by recipient: one agent's event with no write wakes that agent", () => {
    const { gate } = makeGate(writeConfig('upcoming-split-unwritten.json', {
      policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } }],
    }));
    gate.evaluate({ content: 'a.md', eventType: 'workspace:modified', serverId: '', channelId: '', recipients: ['agent'] }, { agent: 'agent', messageId: 'row-1' });
    gate.evaluate({ content: 'b.md', eventType: 'workspace:modified', serverId: '', channelId: '', recipients: ['other'] });
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.certain), [false]);
    assert.deepStrictEqual(gate.upcomingWakes(['agent', 'other']).map((w) => w.certain), [true]);
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

  it("gives an agent the gate doesn't wake its own self-wake and targeted sleep, not a batch or an untargeted sleep", () => {
    const { gate } = makeGate(writeConfig('upcoming-roles.json', {
      policies: [{ name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } }],
    }));
    gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    gate.setSleep(300);
    const kinds = (name: string) => gate.upcomingWakes([name]).map((w) => w.kind).sort();
    assert.deepStrictEqual(kinds('agent'), ['debounce', 'sleep-end']);
    assert.deepStrictEqual(kinds('a-worker'), []);
    gate.armSelfWake('a-worker', 60);
    gate.clearSleep();
    gate.setSleep(300, undefined, 'a-worker');
    assert.deepStrictEqual(kinds('a-worker'), ['self-wake', 'sleep-end']);
    gate.dispose();
  });

  it("gives an agent the gate doesn't wake no batch held for the judge, buffered, or being decided", async () => {
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('upcoming-roles-judged.json', {
      policies: [
        ...JUDGED.policies,
        { name: 'files', match: { scope: ['workspace:modified'] }, behavior: { debounce: 100 } },
      ],
    }), { judge: judge.fn });
    const listed = (name: string) => gate.upcomingWakes([name]).map((w) => [w.kind, w.when]);
    gate.setQuiesced(true);
    gate.evaluate(chat('hello'));
    gate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    await advance(160);
    assert.deepStrictEqual(listed('agent'), [
      ['judge-batch', 'once no turn or quiesce holds it'],
      ['debounce', "once no turn runs and the host isn't quiesced"],
    ], 'premise: the quiesce holds one batch for the judge and buffers the other');
    assert.deepStrictEqual(listed('a-worker'), []);
    gate.setQuiesced(false);
    await settle();
    assert.strictEqual(judge.requests.length, 1, 'premise: the held batch went to the judge');
    assert.deepStrictEqual(listed('agent'), [['judge-batch', 'once the judge decides it']]);
    assert.deepStrictEqual(listed('a-worker'), []);
    judge.answer({ reply: false, reason: 'nothing to answer' });
    await settle();
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
  async function frameworkWith(t: { after: (fn: () => Promise<void> | void) => void }, gate: Record<string, unknown>, names: string[] = ['scout']) {
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane } = await import('./helpers/mock-membrane.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gate-judge-wiring-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: names.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, proseRouting: 'disabled' as const })),
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

  it("under onError 'skip', a batch whose judge call a provider wait on the judge's model refused, before reading the agent's context, is held, and judged once an operator releases the wait", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { onError: 'skip' } });
    const internal = framework as unknown as { recordProviderWait(agentName: string, model: string, error: Error): unknown };
    const wait = new MembraneError({ type: 'rate_limit', retryable: true, retryAfterMs: 600_000, message: 'slow down', rawError: { status: 429 } });
    assert.ok(internal.recordProviderWait('scout', 'claude-haiku-5-5', wait), "premise: the judge's model waits");
    const reader = framework as unknown as { previewActivation: (agentName: string) => Promise<unknown> };
    const preview = reader.previewActivation.bind(framework);
    let previews = 0;
    reader.previewActivation = (agentName) => { previews++; return preview(agentName); };
    const original = console.error;
    console.error = () => {};
    try {
      eventGate.evaluate(chat('is scout around?'));
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the refused batch to be held');
      assert.strictEqual(membrane.calls.length, 0, 'no judge call was made');
      assert.strictEqual(previews, 0, "a call the framework would refuse reads none of the agent's context");
      assert.strictEqual(eventGate.getStatus().policies[0]!.judgeState!.verdicts.refused, 1);
      assert.ok(eventGate.getStatus().errors.some((e) => e.startsWith('Rule "ambient"\'s reply judge call was refused until ')), 'gate_status names the refusal and its end');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'REPLY: asked directly' }]));
      membrane.pushResponse(createMockResponse([]));
      framework.releaseProviderWait('scout', 'claude-haiku-5-5');
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.reply === 1, 'the held batch judged once the wait is released');
      assert.strictEqual(previews, 1, 'the admitted call reads the context');
      assert.strictEqual(membrane.calls[0]!.assistantParticipant, 'reply-judge');
      const shown = membrane.calls[0]!.messages.map((m) => (m.content[0] as { text: string }).text).join('\n');
      assert.ok(shown.includes('is scout around?'));
      await idle(framework);
      assert.ok(membrane.calls.length >= 2, 'the reply woke the agent for a turn');
    } finally {
      console.error = original;
    }
  });

  it("under onError 'skip', a judge call admitted before the agent's context is read, whose model a provider wait holds by the time it's sent, is refused by the call's own admission, and its batch held", async (t) => {
    const { MembraneError } = await import('@animalabs/membrane');
    const { framework, membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { onError: 'skip' } });
    const internal = framework as unknown as {
      recordProviderWait(agentName: string, model: string, error: Error): unknown;
      previewActivation: (agentName: string) => Promise<unknown>;
    };
    const preview = internal.previewActivation.bind(framework);
    let previews = 0;
    internal.previewActivation = (agentName) => {
      previews++;
      internal.recordProviderWait('scout', 'claude-haiku-5-5', new MembraneError({ type: 'rate_limit', retryable: true, retryAfterMs: 600_000, message: 'slow down', rawError: { status: 429 } }));
      return preview(agentName);
    };
    const original = console.error;
    console.error = () => {};
    try {
      eventGate.evaluate(chat('is scout around?'));
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.heldCount === 1, 'the batch refused at its call to be held');
      assert.strictEqual(previews, 1, 'premise: the call was admitted before the context was read');
      assert.strictEqual(membrane.calls.length, 0, 'no request reached the provider');
      assert.deepStrictEqual(eventGate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 0, error: 0, refused: 1 });
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
      assert.ok(eventGate.getStatus().errors.some((e) => e.startsWith('Rule "ambient"\'s reply judge call was refused until ')) && !JSON.stringify(eventGate.getStatus()).includes('quota spent'), JSON.stringify(eventGate.getStatus().errors));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      await lastMillisecond(refusalEnd(eventGate), () => {
        assert.strictEqual(eventGate.getStatus().policies[0]!.judgeState!.verdicts.refused, 1, 'not asked again a millisecond before the hold ends');
        assert.strictEqual(eventGate.getStatus().policies[0]!.judgeState!.heldCount, 1, 'still held, not taken into a judge call, a millisecond before the hold ends');
        assert.strictEqual(calledAt, undefined);
      });
      await byThisMillisecond(() => calledAt !== undefined, "the judge called at the hold's end");
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the batch judged once the hold ends');
      assert.ok(calledAt !== undefined && calledAt - heldAt >= 3_000, `the judge's call was made ${calledAt === undefined ? 'never' : `${calledAt - heldAt} ms after the hold began`}`);
      assert.deepStrictEqual(membrane.calls.map((c) => c.assistantParticipant), ['reply-judge']);
      assert.deepStrictEqual(eventGate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 1, error: 0, refused: 1 });
      assert.strictEqual(eventGate.getStatus().errors.some((e) => e.includes('reply judge call was refused')), false, 'the refusal is over');
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
    assert.ok(eventGate.getStatus().errors.includes("Rule \"ambient\"'s reply judge call was refused: 1 event held for the judge."), JSON.stringify(eventGate.getStatus().errors));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
    await lastMillisecond(heldAt + 3_000, () => {
      assert.strictEqual(judgeState().verdicts.refused, 1, "not asked again before the hold's timer lets it go");
      assert.strictEqual(judgeState().heldCount, 1, "still held, not taken into a judge call, before the hold's timer lets it go");
      assert.strictEqual(calledAt(), undefined, "not called a millisecond before the hold's timer lets it go");
    });
    await byThisMillisecond(() => calledAt() !== undefined, "the judge called as the hold's timer lets it go");
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
    await byThisMillisecond(() => calledAt() !== undefined, 'the judge called as the extended hold lets go');
    await until(() => judgeState().verdicts.wait === 1, 'the batch judged once the extended hold lets go');
    assert.strictEqual(consulted(), 3, 'premise: the host extended the hold once, then let it go');
    assert.ok(calledAt()! - heldAt >= 5_000, `the judge's call was made ${calledAt()! - heldAt} ms after the hold began`);
    assert.deepStrictEqual(judgeState().verdicts, { reply: 0, wait: 1, error: 0, refused: 2 });
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
      assert.ok(eventGate.getStatus().errors.includes('Rule "ambient"\'s reply judge call was refused: 1 event held for the judge.'), JSON.stringify(eventGate.getStatus().errors));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      release();
      await until(() => eventGate.getStatus().policies[0]!.judgeState!.verdicts.wait === 1, 'the held batch judged once the surgery ends');
      assert.deepStrictEqual(membrane.calls.map((c) => c.assistantParticipant), ['reply-judge']);
    } finally {
      console.error = original;
    }
  });

  it("tells the judge the agent's last turn failed, and what runs it again as the wake list has it: nothing, a queued wake or a held turn", async (t) => {
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
      holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown): boolean;
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
      eventGate.evaluate(chat('lol'));
      await judged(2);
      assert.match(question(), opening);
      assert.ok(question().includes('Nothing runs it again: if you answer WAIT, whatever of it is unanswered stays so until something wakes scout.'), question());

      internal.pendingRequests.push({ agentName: 'scout', reason: 'a queued wake', source: 'framework', timestamp: Date.now() });
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('and?'));
      await judged(3);
      assert.ok(question().includes('A wake for scout is already queued.'), question());
      assert.ok(question().includes(': a wake already queued (a queued wake)'), question());

      const wait = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 180_000, message: 'slow down', rawError: { status: 429 } });
      assert.strictEqual(internal.holdProviderAcceleration(framework.getAgent('scout'), wait, internal.pendingRequests.shift()), true, 'premise: the turn is held');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('hm'));
      await judged(4);
      assert.ok(question().includes('A wake for scout is held, due to be let go in 3 min.'), question());
      assert.ok(question().includes(': a turn held by a provider cooldown, when it ends'), question());
      assert.ok(!question().includes('already queued'), question());

      membrane.failTurns = false;
      framework.releaseProviderWait('scout', 'test-model');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Checked: X is fine.' }]));
      await idle(framework);
      assert.strictEqual(internal.consecutiveInferenceFailures.get('scout') ?? 0, 0, 'premise: a turn completed');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'WAIT: chatter' }]));
      eventGate.evaluate(chat('thanks'));
      await judged(5);
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
    const stillUntil = async (done: () => boolean, what: string, withinMs = 5_000): Promise<void> => {
      const by = performance.now() + withinMs;
      while (!done()) {
        if (performance.now() >= by) assert.fail(`${what} didn't happen`);
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

  it("an agent's end tells the gate its rules' held batches may go back to the judge, which may now ask about another agent, whether or not the agent was held", async (t) => {
    const { framework, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { onError: 'skip' } }, ['scout', 'aide']);
    let released = 0;
    const release = eventGate.judgeRefusalsMayHaveLifted.bind(eventGate);
    eventGate.judgeRefusalsMayHaveLifted = () => { released++; release(); };
    framework.stopAgent('aide');
    assert.strictEqual(released, 1);
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
