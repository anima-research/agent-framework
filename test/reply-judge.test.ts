import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MembraneError } from '@animalabs/membrane';
import type { Membrane, NormalizedMessage, NormalizedRequest } from '@animalabs/membrane';
import { ReplyJudge, cut, failedTurnLine, ifYouWait, judgeQuestion, parseVerdict, renderMessage } from '../src/gate/reply-judge.js';
import type { JudgeRequest } from '../src/gate/types.js';
import { oneLine } from '../src/supplied-text.js';

function msg(participant: string, text: string): NormalizedMessage {
  return { participant, content: [{ type: 'text', text }] };
}

/** A membrane that records each request and answers with `text`, reporting input tokens at `charsPerToken`. */
function fakeMembrane(text = 'REPLY: asked directly', charsPerToken = 4) {
  const requests: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      requests.push(request);
      const chars = (request.system?.length ?? 0)
        + request.messages.reduce((n, m) => n + m.content.reduce((k, b) => k + (b.type === 'text' ? b.text.length : 0), 0), 0);
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { inputTokens: Math.ceil(chars / charsPerToken), outputTokens: 12 },
        details: { usage: { inputTokens: Math.ceil(chars / charsPerToken), outputTokens: 12 }, model: { actual: 'claude-haiku-5-5' } },
      };
    },
  } as unknown as Membrane;
  return { membrane, requests };
}

function judgeRequest(overrides?: Partial<JudgeRequest>): JudgeRequest {
  return {
    policyName: 'ambient',
    instructions: 'Wake me for questions about the garden.',
    events: [{ eventType: 'mcpl:channel-incoming', channel: '#garden', authorId: 'u1', addressed: false, content: 'how are the tomatoes?', at: Date.now() - 5000 }],
    agentNames: ['Scout'],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function conversation(n: number, size = 400): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < n; i++) out.push(msg(i % 3 === 0 ? 'Scout' : `user${i % 5}`, `message ${i} ` + 'x'.repeat(size)));
  return out;
}

/** A provider that refuses, with `error` (a context-length error by default), the requests `refuses` picks by their 1-based number, or the first `refuses` of them. */
function refusingMembrane(refuses: number | ((n: number) => boolean), error?: Error) {
  const refused = typeof refuses === 'number' ? (n: number) => n <= refuses : refuses;
  const requests: NormalizedRequest[] = [];
  const size = (r: NormalizedRequest) => r.messages.reduce((n, m) => n + m.content.reduce((k, b) => k + (b.type === 'text' ? b.text.length : 0), 0), 0);
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      requests.push(request);
      if (refused(requests.length)) {
        throw error ?? new MembraneError({ type: 'context_length', retryable: false, message: 'prompt is too long: 1200000 tokens > 1000000 maximum', rawError: { status: 400 } });
      }
      return {
        content: [{ type: 'text', text: 'REPLY: asked directly' }],
        stopReason: 'end_turn',
        usage: { inputTokens: Math.ceil(size(request) / 3), outputTokens: 12 },
        details: { usage: { inputTokens: Math.ceil(size(request) / 3), outputTokens: 12 }, model: { actual: 'claude-haiku-5-5' } },
      };
    },
  } as unknown as Membrane;
  return { membrane, requests, size };
}

describe('reply judge: a request refused as too long', () => {
  const judgeOver = (membrane: Membrane, messages = 60, maxInputTokens = 4_000) => new ReplyJudge({
    membraneFor: () => membrane, chooseAgent: (n) => n[0],
    preview: async () => ({ messages: conversation(messages), config: { model: 'x', maxTokens: 1 } }),
    options: { maxInputTokens },
  });
  const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = original;
    }
  };

  it('is asked once more, smaller', async () => {
    const { membrane, requests, size } = refusingMembrane(1);
    const judge = judgeOver(membrane);
    const before = judge.estimateRatio();
    const verdict = await quietly(() => judge.judge(judgeRequest()));
    assert.strictEqual(verdict.reply, true);
    assert.strictEqual(requests.length, 2);
    assert.ok(size(requests[1]!) < size(requests[0]!), `${size(requests[1]!)} < ${size(requests[0]!)}`);
    assert.strictEqual(before, 3, 'premise: the starting ratio');
  });

  it('refused again, fails as any failed call does, after two requests', async () => {
    const { membrane, requests } = refusingMembrane(2);
    await quietly(() => assert.rejects(judgeOver(membrane).judge(judgeRequest()), /prompt is too long/));
    assert.strictEqual(requests.length, 2);
  });

  it('is asked smaller though the window from the last request still fits, by starting a fresh window', async () => {
    // The first batch is answered, and its window holds the whole conversation; the second is refused.
    const { membrane, requests, size } = refusingMembrane((n) => n === 2);
    const judge = judgeOver(membrane, 50, 20_000);
    await quietly(() => judge.judge(judgeRequest()));
    await quietly(() => judge.judge(judgeRequest()));
    assert.strictEqual(requests.length, 3);
    assert.strictEqual(size(requests[1]!), size(requests[0]!), 'premise: the refused request is the answered one again');
    assert.ok(size(requests[2]!) < size(requests[1]!), `${size(requests[2]!)} < ${size(requests[1]!)}`);
  });

  it('keeps the lower ratio for later batches, down to one character a token, where a refusal is no longer asked again', async () => {
    const { membrane, requests } = refusingMembrane(() => true);
    const judge = judgeOver(membrane);
    const asked: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = requests.length;
      await quietly(() => assert.rejects(judge.judge(judgeRequest()), /prompt is too long/));
      asked.push(requests.length - before);
    }
    assert.deepStrictEqual(asked, [2, 2, 1]);
    assert.strictEqual(judge.estimateRatio(), 1);
  });

  it('halves the ratio once for two requests built at it and refused together', async () => {
    const { membrane } = refusingMembrane(() => true);
    const judge = judgeOver(membrane);
    await quietly(() => Promise.allSettled([judge.judge(judgeRequest()), judge.judge(judgeRequest())]));
    assert.strictEqual(judge.estimateRatio(), 1.5);
  });

  it("isn't asked again for any other failure", async () => {
    const { membrane, requests } = refusingMembrane(1, new MembraneError({ type: 'server', retryable: true, message: 'upstream 500', rawError: { status: 500 } }));
    await assert.rejects(judgeOver(membrane).judge(judgeRequest()), /upstream 500/);
    assert.strictEqual(requests.length, 1);
  });
});

describe('reply judge: verdicts', () => {
  it('parses REPLY and WAIT lines, with or without markdown', () => {
    assert.deepStrictEqual(parseVerdict('REPLY: they asked'), { reply: true, reason: 'they asked' });
    assert.deepStrictEqual(parseVerdict('**WAIT** — banter'), { reply: false, reason: 'banter' });
    assert.deepStrictEqual(parseVerdict('**REPLY:** a question'), { reply: true, reason: 'a question' });
    assert.strictEqual(parseVerdict('I think the agent should respond.'), undefined);
    // Its reasoning's words aren't the verdict: the last line in the asked-for form is.
    assert.deepStrictEqual(parseVerdict('Reply would only add noise.\nWAIT: banter'), { reply: false, reason: 'banter' });
    assert.deepStrictEqual(parseVerdict('Wait, they did ask something.\nREPLY: asked directly'), { reply: true, reason: 'asked directly' });
    assert.deepStrictEqual(parseVerdict('WAIT: first thought\nREPLY: on reflection, asked'), { reply: true, reason: 'on reflection, asked' });
    assert.strictEqual(parseVerdict('wait: lower case'), undefined);
    assert.strictEqual(parseVerdict('REPLY without a separator'), undefined);
  });

  it('returns the model, tokens and reason', async () => {
    const { membrane } = fakeMembrane('WAIT: others are talking');
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0], preview: async () => ({ system: 'You are Scout.', messages: conversation(5), config: { model: 'x', maxTokens: 1 } }),
    });
    const verdict = await judge.judge(judgeRequest());
    assert.strictEqual(verdict.reply, false);
    assert.strictEqual(verdict.reason, 'others are talking');
    assert.strictEqual(verdict.model, 'claude-haiku-5-5');
    assert.ok((verdict.inputTokens ?? 0) > 0);
  });

  it('throws when the answer holds no verdict, so the gate decides by onError', async () => {
    const { membrane } = fakeMembrane('Sure! Here is a reply to the tomatoes question.');
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0], preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
    });
    await assert.rejects(judge.judge(judgeRequest()), /no verdict/);
  });
});

describe('reply judge: the document', () => {
  it('renders participants, tool calls and results, and leaves thinking out', () => {
    const text = renderMessage({
      participant: 'Scout',
      content: [
        { type: 'thinking', thinking: 'private', signature: 's' },
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'tomato blight' } },
      ],
    } as unknown as NormalizedMessage);
    assert.ok(text.startsWith('[Scout] let me look'));
    assert.ok(text.includes('[calls search] {"q":"tomato blight"}'));
    assert.ok(!text.includes('private'));
    assert.strictEqual(cut('abc', 10), 'abc');
    assert.ok(cut('a'.repeat(1000), 100).includes('characters cut'));
  });

  it('sends the agent the model, low effort, its instructions, the batch, and keeps the newest messages', async () => {
    const { membrane, requests } = fakeMembrane();
    const messages = conversation(30);
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0], preview: async () => ({ system: 'You are Scout.', messages, config: { model: 'x', maxTokens: 1 } }),
    });
    await judge.judge(judgeRequest());
    const req = requests[0]!;
    assert.strictEqual(req.config.model, 'claude-haiku-5-5');
    assert.deepStrictEqual(req.providerParams, { output_config: { effort: 'low' } });
    assert.ok(req.system!.includes('reply judge for an AI agent named Scout'));
    const all = req.messages.map((m) => (m.content[0] as { text: string }).text).join('\n');
    assert.ok(all.includes('message 29 '), 'the newest message is shown');
    assert.ok(all.includes('You are Scout.'), "the agent's system prompt is shown");
    const last = (req.messages.at(-1)!.content[0] as { text: string }).text;
    assert.ok(last.includes('how are the tomatoes?'));
    assert.ok(last.includes('Wake me for questions about the garden.'));
  });

  it('stays under its input budget for a context many times larger', async () => {
    const { membrane, requests } = fakeMembrane('REPLY: ok', 3);
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      options: { maxInputTokens: 20_000 },
      chooseAgent: (n) => n[0],
      preview: async () => ({ system: 'S'.repeat(50_000), messages: conversation(2_000, 600), config: { model: 'x', maxTokens: 1 } }),
    });
    const verdict = await judge.judge(judgeRequest());
    assert.ok(verdict.inputTokens! <= 20_000, String(verdict.inputTokens));
    const all = requests[0]!.messages.map((m) => (m.content[0] as { text: string }).text).join('\n');
    assert.ok(all.includes('message 1999 '));
    assert.ok(!all.includes('message 0 '));
    assert.ok(all.includes('earlier messages not shown'));
  });

  it('learns a denser tokenizer and keeps under budget after it', async () => {
    // 2 characters a token, well under the initial guess of 3.
    const { membrane } = fakeMembrane('REPLY: ok', 2);
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      options: { maxInputTokens: 20_000 },
      chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2_000, 600), config: { model: 'x', maxTokens: 1 } }),
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let last;
    try {
      await judge.judge(judgeRequest());
      last = await judge.judge(judgeRequest());
    } finally {
      console.error = original;
    }
    assert.ok(judge.estimateRatio() < 2.3, String(judge.estimateRatio()));
    assert.ok(last!.inputTokens! <= 20_000, String(last!.inputTokens));
  });

  it('after a request over budget, takes the measured ratio at once, with a margin', async () => {
    // A full anchored window at the initial 3 characters a token, measured at 1.5: over budget once.
    let tokensPerChar = 1 / 3;
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        const chars = (request.system?.length ?? 0)
          + request.messages.reduce((n, m) => n + m.content.reduce((k, b) => k + (b.type === 'text' ? b.text.length : 0), 0), 0);
        const inputTokens = Math.ceil(chars * tokensPerChar);
        return { content: [{ type: 'text', text: 'WAIT: x' }], stopReason: 'end_turn', usage: { inputTokens, outputTokens: 1 }, details: { usage: { inputTokens, outputTokens: 1 }, model: {} } };
      },
    } as unknown as Membrane;
    let messages = conversation(100, 300);
    const judge = new ReplyJudge({
      membraneFor: () => membrane, options: { maxInputTokens: 20_000 }, chooseAgent: (n) => n[0],
      preview: async () => ({ messages, config: { model: 'x', maxTokens: 1 } }),
    });
    await judge.judge(judgeRequest());
    // The conversation grows to fill the anchored window; then the tokenizer turns out twice as dense.
    messages = [...messages, ...conversation(60, 300)];
    tokensPerChar = 1 / 1.5;
    const original = console.error;
    console.error = () => {};
    let over;
    try {
      over = await judge.judge(judgeRequest());
    } finally {
      console.error = original;
    }
    assert.ok(over!.inputTokens! > 20_000, `the test's setup overruns once (${over!.inputTokens})`);
    assert.ok(judge.estimateRatio() <= 1.5 * 0.9 + 1e-9, String(judge.estimateRatio()));
    const after = await judge.judge(judgeRequest());
    assert.ok(after.inputTokens! <= 20_000, String(after.inputTokens));
  });

  it('keeps its earlier chunks byte-identical as the conversation grows, with a cache breakpoint after the last full one', async () => {
    const { membrane, requests } = fakeMembrane('REPLY: ok', 4);
    let messages = conversation(400, 300);
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      options: { maxInputTokens: 60_000 },
      chooseAgent: (n) => n[0],
      preview: async () => ({ system: 'You are Scout.', messages, config: { model: 'x', maxTokens: 1 } }),
    });
    await judge.judge(judgeRequest());
    messages = [...messages, ...conversation(3, 300).map((m, i) => msg(m.participant, `fresh ${i}`))];
    await judge.judge(judgeRequest());
    const [a, b] = requests;
    const breakA = a!.messages.findIndex((m) => m.cacheBreakpoint);
    const breakB = b!.messages.findIndex((m) => m.cacheBreakpoint);
    assert.ok(breakA >= 0 && breakB >= breakA, `${breakA} ${breakB}`);
    for (let i = 0; i <= breakA; i++) {
      assert.deepStrictEqual(b!.messages[i], a!.messages[i], `chunk ${i} is unchanged`);
    }
    assert.strictEqual(a!.messages.filter((m) => m.cacheBreakpoint).length, 1);
  });

  it('calls the agent\'s membrane with the native formatter, and names no message the assistant', async () => {
    const options: unknown[] = [];
    const requests: NormalizedRequest[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest, opts: unknown) => {
        requests.push(request);
        options.push(opts);
        return { content: [{ type: 'text', text: 'WAIT: x' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 }, details: { usage: { inputTokens: 10, outputTokens: 1 }, model: {} } };
      },
    } as unknown as Membrane;
    const asked: string[] = [];
    const judge = new ReplyJudge({
      membraneFor: (agent) => { asked.push(agent); return membrane; },
      chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
    });
    await judge.judge(judgeRequest());
    assert.deepStrictEqual(asked, ['Scout']);
    const { NativeFormatter } = await import('@animalabs/membrane');
    assert.ok((options[0] as { formatter?: unknown }).formatter instanceof NativeFormatter);
    assert.ok((options[0] as { signal?: unknown }).signal instanceof AbortSignal);
    assert.strictEqual(requests[0]!.assistantParticipant, 'reply-judge');
    assert.ok(requests[0]!.messages.every((m) => m.participant === 'user'));
  });

  it('lists a long batch newest first within its share, counting the rest', async () => {
    const { membrane, requests } = fakeMembrane();
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      options: { maxInputTokens: 10_000 },
      chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
    });
    const events = Array.from({ length: 2_000 }, (_, i) => ({
      eventType: 'mcpl:channel-incoming', addressed: false, content: `event ${i} ` + 'y'.repeat(200), at: Date.now(),
    }));
    const verdict = await judge.judge(judgeRequest({ events }));
    const last = (requests[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.ok(last.includes('event 1999 '));
    assert.ok(!last.includes('event 0 '));
    assert.match(last, /\(\d+ earlier events in this batch not listed\)/);
    assert.ok(verdict.inputTokens! <= 10_000, String(verdict.inputTokens));
  });

  it('stops before calling the model when the gate gave up during the preview', async () => {
    const { membrane, requests } = fakeMembrane();
    const abort = new AbortController();
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      chooseAgent: (n) => n[0],
      preview: async () => { abort.abort(); return { messages: conversation(2), config: { model: 'x', maxTokens: 1 } }; },
    });
    await assert.rejects(judge.judge(judgeRequest({ signal: abort.signal })), /stopped/);
    assert.strictEqual(requests.length, 0);
  });

  it('reads a budget under the minimum at the minimum, saying so, rather than at the default', async () => {
    const { membrane } = fakeMembrane('WAIT: x', 3);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    let verdict;
    try {
      const judge = new ReplyJudge({
        membraneFor: () => membrane, options: { maxInputTokens: 3_000 }, chooseAgent: (n) => n[0],
        preview: async () => ({ messages: conversation(2_000, 600), config: { model: 'x', maxTokens: 1 } }),
      });
      verdict = await judge.judge(judgeRequest());
    } finally {
      console.error = original;
    }
    assert.ok(errors.some((e) => e.includes('maxInputTokens is 3000, under the 4000 minimum')));
    assert.ok(verdict!.inputTokens! <= 4_000, String(verdict!.inputTokens));
  });

  it('tells the judge what wakes the agent if it waits, soonest first, the framework\'s beside the gate\'s', async () => {
    const { membrane, requests } = fakeMembrane();
    const now = Date.now();
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
      upcomingWakes: () => [{ at: now + 3 * 3600_000 + 40 * 60_000, certain: true, what: 'a turn held by a provider cooldown, when it ends' }],
    });
    await judge.judge(judgeRequest({
      upcomingWakes: [
        { at: now + 12 * 60_000, certain: true, what: 'its own skip_reply timer' },
        { at: now + 45_000, certain: false, what: 'rule "x"\'s batch of 2 events goes to the judge' },
      ],
    }));
    const last = (requests[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.ok(last.includes([
      '<if_you_wait>',
      'If you answer WAIT and nothing new arrives, Scout is next woken by:',
      '- in 45 s, maybe: rule "x"\'s batch of 2 events goes to the judge',
      '- in 12 min: its own skip_reply timer',
      '- in 3 h 40 min: a turn held by a provider cooldown, when it ends',
      '</if_you_wait>',
    ].join('\n')), last);
    assert.ok(requests[0]!.system!.includes('what will wake the agent anyway'));
  });

  it('says when nothing the host knows of is scheduled, and a provider that throws counts as knowing none', async () => {
    assert.match(ifYouWait([], 'Scout', Date.now()), /Nothing the host knows of is scheduled to wake Scout: if you answer WAIT, it isn't woken until a new event arrives/);
    assert.match(ifYouWait([{ certain: true, what: 'a wake already queued (x)' }], 'Scout', Date.now()), /- as soon as it is free: a wake already queued \(x\)/);
    const { membrane, requests } = fakeMembrane();
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
      upcomingWakes: () => { throw new Error('boom'); },
    });
    await judge.judge(judgeRequest());
    assert.match((requests[0]!.messages.at(-1)!.content[0] as { text: string }).text, /Nothing the host knows of is scheduled/);
  });

  it("says first that the agent's last turn failed, and that nothing runs it again, when nothing will", async () => {
    const { membrane, requests } = fakeMembrane();
    const now = Date.now();
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
      failedLastTurn: () => ({ at: now - 125_000, again: { kind: 'none' } }),
    });
    await judge.judge(judgeRequest());
    const last = (requests[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.ok(last.includes([
      '<if_you_wait>',
      "Scout's last turn, 2m ago, failed and may not have answered all of what woke it. Nothing runs it again: if you answer WAIT, what woke it stays unanswered until something wakes Scout.",
      'Nothing the host knows of is scheduled to wake Scout:',
    ].join('\n')), last);
  });

  it("says a wake of the agent's is queued, or held until its hold ends or an operator releases it, when one is", () => {
    const now = 1_000_000;
    const opening = "Scout's last turn, 30s ago, failed and may not have answered all of what woke it.";
    assert.strictEqual(failedTurnLine({ at: now - 30_000, again: { kind: 'queued' } }, 'Scout', now),
      `${opening} A wake for Scout is already queued.`);
    assert.strictEqual(failedTurnLine({ at: now - 30_000, again: { kind: 'held', until: now + 180_000 } }, 'Scout', now),
      `${opening} A wake for Scout is held, due to be let go in 3 min.`);
    assert.strictEqual(failedTurnLine({ at: now - 30_000, again: { kind: 'held' } }, 'Scout', now),
      `${opening} A wake for Scout is held, and is let go when the hold on it is released.`);
  });

  it("shows a wake due at no nameable time by its words, quoted, after every wake with a time", () => {
    const now = 1_000_000;
    const text = ifYouWait([
      { when: 'when the hold <on it> is released', certain: true, what: 'a wake held by a provider hold' },
      { at: now + 60_000, certain: true, what: 'its own skip_reply timer' },
    ], 'Scout', now);
    assert.ok(text.includes('- in 60 s: its own skip_reply timer\n- when the hold &lt;on it&gt; is released: a wake held by a provider hold'), text);
  });

  it("says how many past the eighth wake are only maybe, when some are and some aren't", () => {
    const now = 1_000_000;
    const wakes = Array.from({ length: 11 }, (_, i) => ({ at: now + 1_000 + i, certain: i !== 9, what: `wake ${i}` }));
    assert.ok(ifYouWait(wakes, 'Scout', now).includes('- and 3 more, 1 of them only maybe'));
  });

  it("shows each upcoming wake's words on one line, escaped, and says how many past the eighth are only maybe", () => {
    const now = 1_000_000;
    const wakes = [
      { at: now + 1_000, certain: true, what: 'a wake already queued (nudge from Ann <mod>\n[x])' },
      ...Array.from({ length: 9 }, (_, i) => ({ at: now + 2_000 + i, certain: i < 7, what: `wake ${i}` })),
    ];
    const text = ifYouWait(wakes, 'Scout', now);
    assert.ok(text.includes('- in 1 s: a wake already queued (nudge from Ann &lt;mod&gt; &#91;x&#93;)'), text);
    assert.ok(text.includes('- and 2 more, each only maybe'), text);
  });

  it('shows no failed-turn line when the last turn completed, and a provider that throws counts as none', async () => {
    assert.ok(!ifYouWait([], 'Scout', Date.now()).includes('last turn'));
    const { membrane, requests } = fakeMembrane();
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
      failedLastTurn: () => { throw new Error('boom'); },
    });
    await judge.judge(judgeRequest());
    assert.ok(!(requests[0]!.messages.at(-1)!.content[0] as { text: string }).text.includes('last turn'));
  });

  it("shows a message's text over several lines indented under its name, with markup characters escaped", () => {
    const text = renderMessage(msg('Ann', 'the beds need:\r\n- compost\n- <b>water</b> & mulch'));
    assert.strictEqual(text, '[Ann] the beds need:\n  - compost\n  - &lt;b&gt;water&lt;/b&gt; &amp; mulch');
    assert.strictEqual(renderMessage(msg('Ann [mod]\nB', 'hi')), '[Ann &#91;mod&#93; B] hi');
  });

  it("escapes markup characters in a participant's name, an event's channel and its author", () => {
    assert.strictEqual(renderMessage(msg('Ann <mod> & co', 'hi')), '[Ann &lt;mod&gt; &amp; co] hi');
    const question = judgeQuestion({
      events: [{ eventType: 'mcpl:channel-incoming', channel: '#r&d <beds> [b]', authorId: 'u<1>\n[x]', addressed: false, content: 'hi', at: 1_000_000 }],
    }, 'Scout', 1_000_000);
    assert.ok(question.includes('- 0s ago in #r&amp;d &lt;beds&gt; &#91;b&#93; from u&lt;1&gt; &#91;x&#93;: hi'), question);
  });

  it('keeps a value to one line whatever form its line breaks take', () => {
    assert.strictEqual(oneLine('a\r\nb\rc\nd\u000be\u000cf\u0085g\u2028h\u2029i\n\n\nj'), 'a b c d e f g h i j');
  });

  it("shows an event's text over several lines indented inside its item, and its channel and author on one line", () => {
    const question = judgeQuestion({
      events: [{ eventType: 'mcpl:channel-incoming', channel: '#garden\nbeds', authorId: 'u1', addressed: false, content: 'the beds need:\n- compost\n- a < b', at: 1_000_000 }],
    }, 'Scout', 1_000_000);
    assert.ok(question.includes('<new_events count="1">\n- 0s ago in #garden beds from u1: the beds need:\n  - compost\n  - a &lt; b\n</new_events>'), question);
  });

  it('reads the primary agent its chooser names', async () => {
    const { membrane } = fakeMembrane();
    const asked: string[] = [];
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      chooseAgent: (n) => n.find((a) => a === 'Scout'),
      preview: async (agent) => { asked.push(agent); return { messages: conversation(2), config: { model: 'x', maxTokens: 1 } }; },
    });
    await judge.judge(judgeRequest({ agentNames: ['fork-1', 'Scout'] }));
    assert.deepStrictEqual(asked, ['Scout']);
  });
});
