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
    assert.strictEqual('reason' in verdict, false, "the judge's reason isn't traced");
    const state = gate.getStatus().policies[0]!.judgeState!;
    assert.deepStrictEqual(state.verdicts, { reply: 1, wait: 0, error: 0 });
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

  it("a resident's turn that starts while the judge decides stops it, and its batch is judged once after the turn", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('midturn.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.evaluate(chat('hello'));
    await sleep(160);
    assert.strictEqual(judge.requests.length, 1, 'premise: the judge is deciding');
    gate.onInferenceStarted('agent');
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0, 'a stopped call wakes nothing');
    assert.strictEqual(judge.requests.length, 1, 'not judged again mid-turn');
    assert.deepStrictEqual(gate.getStatus().policies[0]!.judgeState!.verdicts, { reply: 0, wait: 0, error: 0 }, 'a stopped call is no verdict and no error');
    gate.onInferenceEnded('agent');
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2, 'judged once the turn ended');
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
    await sleep(160);
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2);
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
    await sleep(160);
    gate.onInferenceStarted('helper');
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    gate.onInferenceEnded('helper');
    await sleep(10);
    assert.strictEqual(judge.requests.length, 2, 'judged once the turn ended');
    judge.answer({ reply: false, reason: 'helper answered' });
    await sleep(10);
    assert.strictEqual(wakes.length, 0);
    gate.dispose();
  });

  it("a fork's or the subconscious's turn neither holds a judge rule's batch nor stops the judge", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('fork-turn.json', JUDGED), { judge: judge.fn, residents: ['agent'] });
    gate.onInferenceStarted('fork');
    gate.evaluate(chat('hello'));
    await sleep(160);
    assert.strictEqual(judge.requests.length, 1, "judged while the other agent's turn runs");
    gate.onInferenceStarted('subconscious');
    assert.strictEqual(judge.requests[0]!.signal.aborted, false);
    judge.answer({ reply: true, reason: 'asked' });
    await sleep(10);
    assert.strictEqual(judge.requests.length, 1, 'not judged again');
    gate.onInferenceEnded('fork');
    gate.onInferenceEnded('subconscious');
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

  it('maxWaitMs judges a batch that keeps getting pushed back, counted on the gate\'s clock from its first event', async () => {
    let clock = 1_000_000;
    const judge = scriptedJudge();
    const { gate } = makeGate(writeConfig('maxwait.json', {
      policies: [{ name: 'busy', match: {}, behavior: { judge: { debounceMs: 150, maxWaitMs: 250 } } }],
    }), { judge: judge.fn, now: () => clock });
    // Steady chatter, 60 ms apart on the gate's clock, never 150 ms of quiet:
    // the sixth event, 300 ms after the first, is past the 250 ms cap.
    for (let i = 0; i < 6; i++) {
      gate.evaluate(chat(`m${i}`));
      clock += 60;
    }
    await sleep(20);
    assert.strictEqual(judge.requests.length, 1);
    assert.strictEqual(judge.requests[0]!.events.length, 6);
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

describe('judge rules: a message addressed to the agent', () => {
  it('a batch holding one wakes the agent without asking the judge', async () => {
    const judge = scriptedJudge();
    const { gate, wakes, messages } = makeGate(writeConfig('addressed.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('nice weather'));
    gate.evaluate(chat('agent, are you there?', { tags: ['chat:addressed'] }));
    await sleep(160);
    assert.strictEqual(judge.requests.length, 0);
    assert.deepStrictEqual(wakes, [{ agentName: 'agent', reason: 'gate:debounce' }]);
    assert.strictEqual(messages.length, 1);
    gate.dispose();
  });

  it("one that fires while the judge decides the rule's earlier batch wakes the agent now, and that verdict wakes nothing more", async () => {
    const judge = scriptedJudge();
    const { gate, wakes } = makeGate(writeConfig('addressed-deciding.json', JUDGED), { judge: judge.fn });
    gate.evaluate(chat('lol'));
    await sleep(160);
    assert.strictEqual(judge.waiting(), 1, 'premise: the judge is deciding the first batch');
    gate.evaluate(chat('agent?', { tags: ['chat:addressed'] }));
    await sleep(160);
    assert.deepStrictEqual(wakes, [{ agentName: 'agent', reason: 'gate:debounce' }]);
    assert.strictEqual(judge.requests[0]!.signal.aborted, true);
    judge.answer({ reply: true, reason: 'late' });
    await sleep(10);
    assert.strictEqual(wakes.length, 1);
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
  const toolNamed = (name: string) => {
    const tools = membrane.calls.at(-1)!.tools ?? [];
    return tools.find((tool) => tool.name === name)!;
  };
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
    assert.match(toolNamed('wake_remove_rule').description, /A judge rule's batch.*is still judged, by the rule as it was, and wakes you only on reply/);
  });

  it('a host that sets no GateOptions.judge wires no judge: the tool offers none, and a judge it is given is not read', async (t) => {
    const { readFileSync } = await import('node:fs');
    const { framework, configPath, call, wakeAddRule, toolNamed } = await judgeFramework(t);
    const given = await call({ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, judge: { debounceMs: 20000 } });
    assert.strictEqual(given.isError, true);
    assert.match(given.content, /specify exactly one behavior/);
    assert.doesNotMatch(given.content, /`judge`/);
    assert.match(given.content, /"judge"/, 'the refusal names the parameter it does not read');
    assert.strictEqual((JSON.parse(readFileSync(configPath, 'utf-8')) as GateConfig).policies.some((p) => p.name === 'ambient'), false);
    assert.strictEqual(JSON.stringify(wakeAddRule()).includes('judge'), false, 'nothing in the tool names the judge');
    assert.strictEqual(JSON.stringify(toolNamed('wake_remove_rule')).includes('judge'), false, 'nor in wake_remove_rule');
    const gate = (framework as unknown as { eventGate: { judgeFn?: unknown } }).eventGate;
    assert.strictEqual(gate.judgeFn, undefined);
  });

  it("the agent's turn doesn't wait for a judge call in flight", async (t) => {
    const { createMockResponse } = await import('./helpers/mock-membrane.js');
    const { framework, membrane } = await judgeFramework(t, {});
    const complete = membrane.complete.bind(membrane);
    const hanging = new AbortController();
    (membrane as unknown as { complete: (r: { assistantParticipant?: string }, o?: { signal?: AbortSignal }) => Promise<unknown> }).complete =
      (request, options) => (request.assistantParticipant === 'reply-judge'
        ? new Promise((_, reject) => {
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
    await sleep(20);
    const before = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'here' }]));
    assert.strictEqual(framework.nudgeAgent('scout').ok, true);
    await Promise.race([framework.runUntilIdle(), sleep(3000)]);
    assert.ok(membrane.calls.length > before, 'the turn sent its request while the judge call was still out');
    hanging.abort();
    await asked;
  });

  it("the residents' turns change what the judge reads, and the subconscious's don't", async (t) => {
    const { framework } = await judgeFramework(t, {}, { subconscious: { enabled: true, systemPrompt: 'You watch.' } });
    const gate = (framework as unknown as { eventGate: { changesJudgedContextFn: (name: string) => boolean } }).eventGate;
    assert.ok(framework.getAgent('Subconscious'), 'premise: a subconscious runs');
    assert.strictEqual(gate.changesJudgedContextFn('scout'), true);
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

  it('enabled: false leaves the judge unwired, and judge rules run as debounces', async (t) => {
    const { membrane, eventGate } = await frameworkWith(t, { config: JUDGED, judge: { enabled: false } });
    assert.ok(eventGate.getStatus().errors.some((e) => e.includes('wires no reply judge')));
    assert.strictEqual(membrane.calls.length, 0);
  });
});
