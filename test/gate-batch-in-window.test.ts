import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedRequest } from '@animalabs/membrane';
import type { EventResponse, ProcessEvent, ProcessState } from '../src/index.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { incoming, registerOpen, internals, textOf, MENTION, AMBIENT, type Stored } from './helpers/admission.js';
import { GateModule, say } from './helpers/dendrite.js';
import { MockYieldingStream } from './helpers/mock-membrane.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type GateInternals = {
  debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout>; events: unknown[] }>;
  fireDebounce(name: string): void;
};

const gateOf = (f: Fixture) => (f.framework as unknown as { eventGate: GateInternals }).eventGate;

async function batched(f: Fixture, count: number): Promise<void> {
  await f.framework.runUntilIdle();
  const pending = () => [...gateOf(f).debounceTimers.values()].reduce((n, state) => n + state.events.length, 0);
  await eventually(() => pending() === count, `${count} event(s) batched`);
}

function fire(f: Fixture): void {
  const gate = gateOf(f);
  for (const [name, state] of [...gate.debounceTimers]) {
    clearTimeout(state.timer);
    gate.fireDebounce(name);
  }
}

/** One answer per stream, each request kept under the agent it was for. */
function answerEachStream(f: Fixture): Map<string, NormalizedRequest[]> {
  const byAgent = new Map<string, NormalizedRequest[]>();
  (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: NormalizedRequest) => {
    f.membrane.calls.push(request);
    const who = request.assistantParticipant ?? '';
    byAgent.set(who, [...(byAgent.get(who) ?? []), request]);
    return new MockYieldingStream([say(`${who} answers`)]);
  };
  return byAgent;
}

/** The agents whose turns started, in order. */
function turnsStarted(f: Fixture): string[] {
  const turns: string[] = [];
  f.framework.onTrace((event) => {
    if (event.type === 'inference:started') turns.push(event.agentName);
  });
  return turns;
}

const requestText = (request: NormalizedRequest | undefined): string => JSON.stringify(request?.messages ?? null);
const rowsOf = (f: Fixture, agent: string): string[] =>
  (f.framework.getAgent(agent)!.getContextManager().getAllMessages() as unknown as Stored[]).map(textOf);
const resident = (name: string) => ({ name, model: 'test', systemPrompt: `You are ${name}.` });
const addressedOnly = { name: 'batch', match: { scope: ['mcpl:channel-incoming'], tagsAny: ['chat:addressed'] }, behavior: { debounce: 60_000 } };

class CustomModule extends GateModule {
  override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    const { type, content } = event as unknown as { type: string; content: string };
    if (type === 'clock:custom') return { requestInference: true };
    if (type === 'clock:reminder') {
      return { addMessages: [{ participant: 'user', content: [{ type: 'text', text: content }] }], requestInference: true };
    }
    return {};
  }
}

describe('a batched wake writes no gate line when it is delivered for events already in the window', () => {
  it("two messages in two residents' windows: each resident's first request holds both, and no gate line", async () => {
    const f = await fixture({
      agents: [resident('scout'), resident('mira')],
      framework: { gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false } },
    });
    try {
      const requests = answerEachStream(f);
      await registerOpen(f, 'work');
      await incoming(f, 'work', 'm1', 'first message', MENTION);
      await incoming(f, 'work', 'm2', 'second message', MENTION);
      await batched(f, 2);
      fire(f);
      await f.framework.runUntilIdle();
      for (const name of ['scout', 'mira']) {
        const first = requests.get(name)?.[0];
        assert.ok(first, `premise: the batch woke ${name}`);
        assert.ok(requestText(first).includes('first message') && requestText(first).includes('second message'),
          `premise: ${name}'s first request holds both messages`);
        assert.ok(!requestText(first).includes('[Gate:'), `${name}'s first request holds no gate line`);
      }
    } finally { await f.close(); }
  });

  it('one message with another stored after it before the batch fires: the first request holds both, and a line naming the first', async () => {
    const f = await fixture({
      agents: [resident('scout')],
      framework: { gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false } },
    });
    try {
      const requests = answerEachStream(f);
      await registerOpen(f, 'work');
      await incoming(f, 'work', 'm1', 'the question', MENTION);
      await batched(f, 1);
      await incoming(f, 'work', 'm2', 'chatter after it', AMBIENT);
      await f.framework.runUntilIdle();
      assert.ok(rowsOf(f, 'scout').some((t) => t.includes('chatter after it')), 'premise: the later message stored');
      fire(f);
      await f.framework.runUntilIdle();
      const first = requests.get('scout')?.[0];
      assert.ok(first, 'premise: the batch woke scout');
      assert.ok(requestText(first).includes('the question') && requestText(first).includes('chatter after it'),
        'premise: the first request holds both messages');
      const texts = (first!.messages as Array<{ content: Array<{ type: string; text?: string }> }>)
        .map((m) => m.content.map((c) => c.text ?? '').join(''));
      const lines = texts.filter((t) => t.startsWith('[Gate:'));
      assert.equal(lines.length, 1, 'one line, at the start: something follows the batch\'s message');
      assert.match(lines[0]!, /^\[Gate: 1 event matched\]\n\n- 1 message in work \(oldest ~\d+s ago\) — already shown above at arrival; this is a batched wake, not new content$/);
      assert.ok(texts.indexOf(lines[0]!) > texts.findIndex((t) => t.includes('chatter after it')), 'after the later message');
    } finally { await f.close(); }
  });

  it('a reminder whose module stored its text: the first request holds the text once, and no gate line', async () => {
    const f = await fixture({
      agents: [resident('scout')],
      framework: {
        modules: [new CustomModule()],
        gate: { config: { policies: [{ name: 'batch', match: { scope: ['clock:reminder'] }, behavior: { debounce: 60_000 } }], default: 'skip' }, onboarding: false },
      },
    });
    try {
      const requests = answerEachStream(f);
      f.framework.pushEvent({ type: 'clock:reminder', source: 'clock', content: 'water the plants' } as unknown as ProcessEvent);
      await batched(f, 1);
      assert.ok(rowsOf(f, 'scout').some((t) => t.includes('water the plants')), 'premise: the reminder stored');
      fire(f);
      await f.framework.runUntilIdle();
      const first = requests.get('scout')?.[0];
      assert.ok(first, 'premise: the batch woke scout');
      assert.equal(requestText(first).split('water the plants').length - 1, 1, 'the reminder text appears once');
      assert.ok(!requestText(first).includes('[Gate:'), 'the first request holds no gate line');
    } finally { await f.close(); }
  });

  it('a batch of messages and an event with no message of its own: the line counts and quotes that event alone', async () => {
    const f = await fixture({
      agents: [resident('scout')],
      framework: {
        modules: [new CustomModule()],
        gate: { config: { policies: [{ name: 'batch', match: { scope: ['clock:custom', 'mcpl:channel-incoming'] }, behavior: { debounce: 60_000 } }], default: 'skip' }, onboarding: false },
      },
    });
    try {
      const requests = answerEachStream(f);
      await registerOpen(f, 'work');
      await incoming(f, 'work', 'm1', 'first message', MENTION);
      await incoming(f, 'work', 'm2', 'second message', MENTION);
      f.framework.pushEvent({ type: 'clock:custom', source: 'clock', content: 'the custom event' } as unknown as ProcessEvent);
      await batched(f, 3);
      fire(f);
      await f.framework.runUntilIdle();
      const lines = rowsOf(f, 'scout').filter((t) => t.includes('[Gate:'));
      assert.equal(lines.length, 1, 'one gate line');
      assert.match(lines[0]!, /^\[Gate: 1 event matched\]\n\n- \[batch\] \(clock:custom\): the custom event$/);
      assert.ok(requestText(requests.get('scout')?.[0]).includes('the custom event'), 'the first request holds the line');
    } finally { await f.close(); }
  });

  it("the router: the trunk and an unrelated fork, woken for another fork's message, get no line and no quoted text", async () => {
    const f = await fixture({
      agents: [resident('trunk')],
      framework: {
        conversations: { templateAgent: 'trunk' },
        gate: { config: { policies: [addressedOnly], default: 'skip' }, onboarding: false },
      },
    });
    try {
      answerEachStream(f);
      const turns = turnsStarted(f);
      await f.send('channels/register', {
        channels: ['alpha', 'beta'].map((id) => ({ id, type: 'discord', label: id, initiallyOpen: true, metadata: { is_im: true } })),
      });
      await eventually(() => ['alpha', 'beta'].every((id) => internals(f).channelRegistry.getDesiredState('editor', id) === 'open'), 'channels open');
      await incoming(f, 'alpha', 'a1', 'words for alpha', MENTION);
      await incoming(f, 'beta', 'b1', 'words for beta', MENTION);
      const alpha = forkAgentName('conversation', 'editor', 'alpha', 1);
      const beta = forkAgentName('conversation', 'editor', 'beta', 1);
      await batched(f, 2);
      assert.ok(f.framework.getAgent(alpha) && f.framework.getAgent(beta), 'premise: a fork for each channel');
      assert.ok(rowsOf(f, alpha).some((t) => t.includes('words for alpha')), "premise: alpha's fork holds its message");
      assert.ok(rowsOf(f, beta).some((t) => t.includes('words for beta')), "premise: beta's fork holds its message");
      fire(f);
      await f.framework.runUntilIdle();
      for (const name of ['trunk', alpha, beta]) assert.ok(turns.includes(name), `premise: the batch woke ${name}`);
      for (const name of ['trunk', alpha, beta]) {
        assert.deepEqual(rowsOf(f, name).filter((t) => t.includes('[Gate:')), [], `${name} holds no gate line`);
      }
      assert.ok(!rowsOf(f, 'trunk').some((t) => t.includes('words for alpha') || t.includes('words for beta')), 'the trunk holds neither message');
      assert.ok(!rowsOf(f, alpha).some((t) => t.includes('words for beta')), "alpha's fork holds nothing of beta's message");
      assert.ok(!rowsOf(f, beta).some((t) => t.includes('words for alpha')), "beta's fork holds nothing of alpha's message");
    } finally { await f.close(); }
  });
});
