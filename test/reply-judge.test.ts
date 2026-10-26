import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Membrane, NormalizedMessage, NormalizedRequest } from '@animalabs/membrane';
import { ReplyJudge, cut, ifYouWait, judgeQuestion, parseVerdict, renderMessage } from '../src/gate/reply-judge.js';
import type { JudgeEventSummary } from '../src/index.js';
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

describe('reply judge: the question', () => {
  it("says no event is a mention, a reply or a DM to the agent when none is, and doesn't when one is", () => {
    const line = 'None of these events is a mention, a reply or a DM to Scout: those wake it without asking you. A message can still ask it something by name.';
    assert.ok(judgeQuestion(judgeRequest(), 'Scout', Date.now()).includes(line));
    const mention: JudgeEventSummary = { eventType: 'mcpl:channel-incoming', addressed: true, content: 'Scout?', at: Date.now() };
    const addressed = judgeRequest({ events: [mention] });
    assert.strictEqual(judgeQuestion(addressed, 'Scout', Date.now()).includes('None of these events'), false);
    const mixed = judgeRequest({ events: [...judgeRequest().events, mention] });
    assert.strictEqual(judgeQuestion(mixed, 'Scout', Date.now()).includes('None of these events'), false);
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

  it("reads the newest of a context many times larger, with the agent's system prompt abridged, in a few thousand tokens", async () => {
    const { membrane, requests } = fakeMembrane('REPLY: ok', 3);
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      chooseAgent: (n) => n[0],
      preview: async () => ({ system: 'S'.repeat(50_000), messages: conversation(2_000, 600), config: { model: 'x', maxTokens: 1 } }),
    });
    await judge.judge(judgeRequest());
    const texts = requests[0]!.messages.map((m) => (m.content[0] as { text: string }).text);
    const all = texts.join('\n');
    assert.ok(all.includes('message 1999 '));
    assert.ok(!all.includes('message 0 '));
    assert.ok(all.includes('earlier messages not shown'));
    assert.ok(all.includes("Scout's system prompt (abridged)"));
    const chars = requests[0]!.system!.length + texts.reduce((n, text) => n + text.length, 0);
    assert.ok(chars < 25_000, String(chars));
    const [document, about] = texts;
    assert.ok(document!.startsWith("# Scout's context") && about!.startsWith("## Scout's system prompt"), 'the conversation, then the system prompt');
    const shown = [...document!.matchAll(/message (\d+) /g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(shown, Array.from({ length: shown.length }, (_, i) => 2_000 - shown.length + i), 'the newest messages, oldest first, none skipped');
    assert.strictEqual(requests[0]!.promptCaching, false);
  });

  it('shows the newest message even when it alone is over the size, cut to the longest a message renders', async () => {
    const { membrane, requests } = fakeMembrane('REPLY: ok', 3);
    const newest: NormalizedMessage = { participant: 'user1', content: [
      { type: 'text', text: 'message 2 ' + 'x'.repeat(5_000) }, { type: 'text', text: 'y'.repeat(5_000) },
      { type: 'text', text: 'z'.repeat(5_000) + ' end of the newest' },
    ] };
    const messages = [...conversation(2), newest];
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      chooseAgent: (n) => n[0],
      preview: async () => ({ messages, config: { model: 'x', maxTokens: 1 } }),
    });
    await judge.judge(judgeRequest());
    const document = (requests[0]!.messages[0]!.content[0] as { text: string }).text;
    assert.ok(document.includes('message 2 ') && document.includes(' end of the newest'), 'the newest message, its head and its tail');
    assert.ok(document.length > 6_700, String(document.length));
    assert.ok(document.length < 12_200, String(document.length));
    assert.ok(document.includes('characters cut'), 'cut to the longest a message renders');
    assert.ok(!document.includes('message 1 '));
  });

  it("counts a request's usage as the agent's even when its answer holds no verdict", async () => {
    const { membrane } = fakeMembrane('I am not sure.');
    const recorded: string[] = [];
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
      recordUsage: (agentName) => { recorded.push(agentName); },
    });
    await assert.rejects(judge.judge(judgeRequest()), /no verdict/);
    assert.deepStrictEqual(recorded, ['Scout']);
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

  it('lists the newest of a long batch within its share, oldest of them first, counting the rest', async () => {
    const { membrane, requests } = fakeMembrane();
    const judge = new ReplyJudge({
      membraneFor: () => membrane,
      chooseAgent: (n) => n[0],
      preview: async () => ({ messages: conversation(2), config: { model: 'x', maxTokens: 1 } }),
    });
    const events = Array.from({ length: 2_000 }, (_, i) => ({
      eventType: 'mcpl:channel-incoming', addressed: false, content: `event ${i} ` + 'y'.repeat(200), at: Date.now(),
    }));
    await judge.judge(judgeRequest({ events }));
    const last = (requests[0]!.messages.at(-1)!.content[0] as { text: string }).text;
    assert.ok(last.includes('event 1999 '));
    assert.ok(!last.includes('event 0 '));
    assert.match(last, /\(\d+ earlier events in this batch not listed\)/);
    const listed = last.split('\n').filter((line) => / event \d+ /.test(line));
    const shown = listed.map((line) => Number(/ event (\d+) /.exec(line)![1]));
    assert.deepStrictEqual(shown, Array.from({ length: shown.length }, (_, i) => 2_000 - shown.length + i), 'the newest, oldest of them first');
    const used = listed.reduce((n, line) => n + line.length + 1, 0);
    assert.ok(used - 1 <= 2_160 && used > 2_160 - 260, String(used));
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
