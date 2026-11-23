import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Membrane, NormalizedMessage, NormalizedRequest } from '@animalabs/membrane';
import { JudgeFailure, ReplyJudge, cut, ifYouWait, parseVerdict, renderMessage } from '../src/gate/reply-judge.js';
import type { JudgeRequest } from '../src/gate/types.js';

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

  it("names an answer with no verdict in the framework's words, keeping its stop and text apart for the log", async () => {
    const { membrane } = fakeMembrane('zz-judge-words-7f3a I would rather not say.');
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0], preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
    });
    const failure = await judge.judge(judgeRequest()).then(() => assert.fail('the judge should fail'), (e: unknown) => e);
    assert.ok(failure instanceof JudgeFailure, String(failure));
    assert.equal(failure.message, "the judge's answer held no verdict");
    assert.equal(failure.detail, 'stop: end_turn, text: "zz-judge-words-7f3a I would rather not say."');
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
    // Below the measured 1.5 characters a token, so with a margin.
    assert.ok(judge.estimateRatio() < 1.5, String(judge.estimateRatio()));
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

  it("opens what waiting leaves with the agent's failed last turn, and a provider that throws counts as none", async () => {
    const { membrane, requests } = fakeMembrane();
    const now = Date.now();
    const preview = async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } });
    await new ReplyJudge({ membraneFor: () => membrane, chooseAgent: (n) => n[0], preview, failedLastTurn: () => ({ at: now - 125_000 }) })
      .judge(judgeRequest());
    const told = (requests[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.ok(told.includes("<if_you_wait>\nScout's last turn, 2m ago, failed and may not have answered all of what woke it.\nNothing the host knows of is scheduled"), told);
    await new ReplyJudge({ membraneFor: () => membrane, chooseAgent: (n) => n[0], preview, failedLastTurn: () => { throw new Error('boom'); } })
      .judge(judgeRequest());
    assert.doesNotMatch((requests[1]!.messages.at(-1)!.content[0] as { text: string }).text, /last turn/);
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

describe('reply judge: surrogate pairs', () => {
  const FLOWER = '\u{1F33C}';
  const NOTE = / \[…(\d+) characters cut…\] /;

  function parts(result: string): { head: string; count: number; tail: string } {
    const m = NOTE.exec(result);
    assert.ok(m, `a cut note in ${JSON.stringify(result.slice(0, 60))}`);
    return { head: result.slice(0, m.index), count: Number(m[1]), tail: result.slice(m.index + m[0].length) };
  }

  function requestTexts(request: NormalizedRequest): string[] {
    const texts: string[] = typeof request.system === 'string' ? [request.system] : [];
    for (const m of request.messages) for (const b of m.content) if (b.type === 'text') texts.push(b.text);
    return texts;
  }

  async function bothAlignments(context: (pad: string) => { system?: string; messages: NormalizedMessage[] }): Promise<NormalizedRequest[]> {
    const { membrane, requests } = fakeMembrane();
    for (const pad of ['', 'a']) {
      const judge = new ReplyJudge({
        membraneFor: () => membrane, chooseAgent: (n) => n[0],
        preview: async () => ({ ...context(pad), config: { model: 'x', maxTokens: 1 } }),
      });
      await judge.judge(judgeRequest());
    }
    return requests;
  }

  function assertEmojiWhole(requests: NormalizedRequest[]): void {
    assert.strictEqual(requests.length, 2);
    for (const request of requests) {
      for (const text of requestTexts(request)) {
        assert.ok(text.isWellFormed(), `well formed: ${JSON.stringify(text.slice(0, 40))}`);
        assert.ok(!text.includes('\uFFFD'), `no emoji replaced: ${JSON.stringify(text.slice(0, 40))}`);
      }
      const all = requestTexts(request).join('\n');
      assert.match(all, NOTE, 'the cut text reaches the request');
      assert.ok(all.includes(FLOWER), 'its emoji reach the request');
    }
  }

  it('ends the head before a pair that its cut point falls inside', () => {
    const keep = Math.floor((600 - 40) / 2);
    const text = 'x'.repeat(keep - 1) + FLOWER + 'y'.repeat(500);
    const result = cut(text, 600);
    assert.ok(result.isWellFormed());
    const { head, count, tail } = parts(result);
    assert.strictEqual(head, 'x'.repeat(keep - 1));
    assert.strictEqual(count, text.length - head.length - tail.length);
  });

  it('starts the tail after a pair that its cut point falls inside', () => {
    const keep = Math.floor((600 - 40) / 2);
    const text = 'x'.repeat(500) + FLOWER + 'y'.repeat(keep - 1);
    const result = cut(text, 600);
    assert.ok(result.isWellFormed());
    const { head, count, tail } = parts(result);
    assert.strictEqual(tail, 'y'.repeat(keep - 1));
    assert.strictEqual(count, text.length - head.length - tail.length);
  });

  it('keeps a text of emoji alone well formed, within its limit, with the cut counted', () => {
    for (const text of [FLOWER.repeat(400), 'a' + FLOWER.repeat(400)]) {
      const result = cut(text, 600);
      assert.ok(result.isWellFormed(), `well formed from ${text.length} units`);
      assert.ok(result.length <= 600, String(result.length));
      const { head, count, tail } = parts(result);
      assert.strictEqual(count, text.length - head.length - tail.length);
    }
  });

  it('cuts a text with no surrogate at a cut point as before, to the character, emoji elsewhere included', () => {
    const keep = Math.floor((600 - 40) / 2);
    const letters = Array.from({ length: 700 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const emoji = FLOWER + 'x'.repeat(300) + FLOWER.repeat(50) + 'y'.repeat(300) + FLOWER;
    for (const text of [letters, emoji]) {
      assert.strictEqual(cut(text, 600), `${text.slice(0, keep)} […${text.length - 2 * keep} characters cut…] ${text.slice(-keep)}`);
    }
  });

  it('sends a long text block with emoji at its cut points, each emoji whole', async () => {
    assertEmojiWhole(await bothAlignments((pad) => ({ messages: [msg('user1', pad + FLOWER.repeat(3_100))] })));
  });

  it("sends a long tool call's input with emoji at its cut points, each emoji whole", async () => {
    assertEmojiWhole(await bothAlignments((pad) => ({
      messages: [{ participant: 'Scout', content: [{ type: 'tool_use', id: 't1', name: 'weather', input: { q: pad + FLOWER.repeat(400) } }] }],
    })));
  });

  it('sends a long tool result with emoji at its cut points, each emoji whole', async () => {
    assertEmojiWhole(await bothAlignments((pad) => ({
      messages: [{ participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', toolName: 'weather', content: pad + FLOWER.repeat(400), isError: false }] }],
    })));
  });

  it('sends a long message of several blocks with emoji at its cut points, each emoji whole', async () => {
    const block = (pad: string) => ({ type: 'text' as const, text: pad + FLOWER.repeat(2_500) });
    assertEmojiWhole(await bothAlignments((pad) => ({ messages: [{ participant: 'user1', content: [block(pad), block(pad), block(pad)] }] })));
  });

  it("sends a long system prompt of the agent's with emoji at its cut points, each emoji whole", async () => {
    assertEmojiWhole(await bothAlignments((pad) => ({ system: pad + FLOWER.repeat(15_000), messages: conversation(2) })));
  });

  it('sends U+FFFD for a lone half that no cut made, wherever the request carries it', async () => {
    const { membrane, requests } = fakeMembrane();
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0],
      preview: async () => ({
        system: 'You are a \uDF3C scout.',
        messages: [msg('user1', 'an early \uDF3C flower'), ...conversation(60), msg('user1', 'a broken \uD83C flower')],
        config: { model: 'x', maxTokens: 1 },
      }),
    });
    await judge.judge(judgeRequest({ agentNames: ['Sc\uD83Cout'], instructions: 'wake me for \uDF3C only' }));
    const request = requests[0]!;
    assert.ok(requestTexts(request).every((t) => t.isWellFormed()));
    const text = (m: NormalizedMessage | undefined): string => (m?.content[0] as { text: string } | undefined)?.text ?? '';
    assert.ok(typeof request.system === 'string' && request.system.includes('Sc\uFFFDout'), "the judge's own system prompt");
    assert.ok(text(request.messages.find((m) => m.cacheBreakpoint)).includes('an early \uFFFD flower'), 'a closed chunk');
    assert.ok(text(request.messages.at(-3)).includes('a broken \uFFFD flower'), 'the open chunk');
    assert.ok(text(request.messages.at(-2)).includes('You are a \uFFFD scout.'), "the agent's system prompt");
    assert.ok(text(request.messages.at(-1)).includes('wake me for \uFFFD only'), "the rule's instructions");
  });

  it('sends a whole emoji that no cut reaches as itself', async () => {
    const { membrane, requests } = fakeMembrane();
    const judge = new ReplyJudge({
      membraneFor: () => membrane, chooseAgent: (n) => n[0],
      preview: async () => ({ system: `You are Scout ${FLOWER}.`, messages: [msg('user1', `the tomatoes ${FLOWER} are ripe`)], config: { model: 'x', maxTokens: 1 } }),
    });
    await judge.judge(judgeRequest());
    const all = requestTexts(requests[0]!).join('\n');
    assert.ok(all.includes(`the tomatoes ${FLOWER} are ripe`));
    assert.ok(all.includes(`You are Scout ${FLOWER}.`));
    assert.ok(!all.includes('\uFFFD'));
  });
});
