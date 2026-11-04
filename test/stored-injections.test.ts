/**
 * Context injections kept where they were placed (context-manager #155,
 * part 5; src/stored-injections.ts). At a start, an `afterUser` injection is
 * stored in the agent's window, appended as the message compile() would have
 * placed, so it stays where the agent saw it: one the agent's last request
 * held with the same content (or a newer copy a start whose compile threw
 * stored) isn't stored again, and a changed one is appended then. While the window is held (quiesced, or another reader of
 * the shared slot mid-turn), compile() places it instead. A module's
 * injection can opt out (placedEachCompile) and is placed as before; an MCPL
 * server's can't. A stored row is marked with its agent and namespace, and
 * every other agent's view leaves it out.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, WindowedPassthroughStrategy, type ContextInjection } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, type Agent, type Module, type ModuleContext, type ModuleContextInjection, type ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { HookOrchestrator } from '../src/mcpl/hook-orchestrator.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) await frameworks.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);

/** A module that turns an external message into a user message and asks for
 *  inference, and gathers one `afterUser` injection whose text the test sets. */
class Lessons implements Module {
  readonly name = 'lessons';
  lesson = 'LESSON one';
  optOut = false;
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext) { this.ctx = ctx; }
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  async onProcess(event: ProcessEvent) {
    return event.type === 'external-message'
      ? { addMessages: [{ participant: 'user', content: [text(String((event as { content?: unknown }).content))] }], requestInference: true }
      : {};
  }
  async gatherContext(): Promise<ModuleContextInjection[]> {
    return [{ namespace: 'lessons', position: 'afterUser', content: [text(this.lesson)], ...(this.optOut ? { placedEachCompile: true } : {}) }];
  }
}

type Internals = {
  storeInjections(agent: Agent, injections: ContextInjection[] | undefined): ContextInjection[] | undefined;
  planInjectionStores(agent: Agent, injections: ContextInjection[] | undefined): { rows: unknown[]; leftAt: number[] } | undefined;
  quiesced: boolean;
  activeTurnTokens: Map<string, unknown>;
  isNewestIn(agent: Agent, entry: { eventType: string; serverId?: string; channelId?: string; messageId?: string }): boolean;
  shedNewestTurn(agent: Agent): { removedIds: string[] } | null;
  isUnreadStoredMessage(agent: Agent, messageId: string): boolean;
  pendingRequests: Array<Record<string, unknown>>;
};
const internals = (f: AgentFramework) => f as unknown as Internals;

async function make(opts: { modules?: Module[]; agents?: string[]; subconscious?: boolean; dir?: string; strategy?: unknown; errorPolicy?: unknown } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'af-stored-injections-'));
  if (!opts.dir) dirs.push(dir);
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: (opts.agents ?? ['prime']).map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, ...(opts.strategy ? { strategy: opts.strategy as never } : {}) })),
    modules: opts.modules ?? [],
    syncIntervalMs: 0,
    ...(opts.subconscious ? { subconscious: { enabled: true, systemPrompt: 'notice' } } : {}),
    ...(opts.errorPolicy ? { errorPolicy: opts.errorPolicy as never } : {}),
  });
  frameworks.push(framework);
  await framework.start();
  return { framework, membrane };
}

const injection = (t = 'LESSON one', namespace = 'lessons'): ContextInjection =>
  ({ namespace, position: 'afterUser', content: [text(t)] });

/** A compile the agent sends, as a start's is: what it renders is what the
 *  next start's same-content skip reads (Agent.renderedInjection). */
const sent = (agent: Agent) => agent.buildActivationRequest([], undefined, undefined, [], {});

/** Record what a compile built to send held, as its provenance would give
 *  it: each stored row, rendered as its own message, with its body's state. */
function noteHeld(agent: Agent, held: Array<[{ id: string; sequence: number }, { complete: boolean; missing?: string[] }]>): void {
  (agent as unknown as { noteRenderedInjections(result: unknown): void }).noteRenderedInjections({
    messages: held.map(() => ({ participant: 'system_context:lessons', content: [] })),
    provenance: {
      messages: held.map(([row, body]) => ({ kind: 'raw', bodies: [{ messageId: row.id, sequence: row.sequence, ...body }] })),
      branch: agent.getContextManager().currentBranchRef(),
    },
  });
}

/** The text of a request message or stored row. */
const textOf = (m: { content: unknown }): string =>
  (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');

/** The rows of `agent`'s window that are stored injections. */
const storedInjections = (agent: Agent) => agent.getContextManager().getAllMessages()
  .filter((m) => (m.metadata as { contextInjection?: unknown } | undefined)?.contextInjection !== undefined);

/** A turn: push the message, answer it, and wait until the framework is idle. */
async function turn(x: { framework: AgentFramework; membrane: MockMembrane }, content: string): Promise<void> {
  x.membrane.pushResponse(createMockResponse([text(`reply to ${content}`)]));
  x.framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
}

for (const [shape, build] of [
  ['the window ending on a user message', (a: Agent) => {
    a.getContextManager().addMessage('user', [text('hello')]);
  }],
  ['the window ending on a round of tool results', (a: Agent) => {
    a.getContextManager().addMessage('user', [text('hello')]);
    a.getContextManager().addMessage('prime', [{ type: 'tool_use', id: 't1', name: 'look', input: {} } as ContentBlock]);
    a.getContextManager().addMessage('user', [{ type: 'tool_result', toolUseId: 't1', content: 'seen' } as unknown as ContentBlock]);
  }],
] as const) {
  test(`with ${shape}, a stored injection renders byte for byte as the one compile() placed`, async () => {
    const x = await make();
    const agent = x.framework.getAgent('prime')!;
    build(agent);
    const inj = injection();
    const placed = await agent.buildActivationRequest([], [inj], undefined, [], { dryRun: true });
    assert.equal(internals(x.framework).storeInjections(agent, [inj]), undefined, 'nothing is left for compile()');
    assert.equal(storedInjections(agent).length, 1, 'the premise: it was stored');
    const stored = await agent.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
    assert.deepEqual(stored.messages, placed.messages);
    assert.equal(stored.system, placed.system);
  });
}

test('an unchanged injection is stored once and stays where the agent saw it, so each request extends the last', async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons] });
  await turn(x, 'one');
  await turn(x, 'two');
  assert.equal(x.membrane.calls.length, 2);
  const [first, second] = x.membrane.calls.map((c) => c.messages);
  assert.deepEqual(second!.slice(0, first!.length), first, 'the second request begins with the first, the injection where it was');
  assert.deepEqual(second!.map(textOf), ['one', 'LESSON one', 'reply to one', 'two']);
  assert.equal(storedInjections(x.framework.getAgent('prime')!).length, 1);
});

test('a changed injection is stored after the turn\'s opening message, and the earlier copy stays where it was', async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons] });
  await turn(x, 'one');
  lessons.lesson = 'LESSON two';
  await turn(x, 'two');
  assert.deepEqual(x.membrane.calls[1]!.messages.map(textOf), ['one', 'LESSON one', 'reply to one', 'two', 'LESSON two']);
  const rows = storedInjections(x.framework.getAgent('prime')!);
  assert.deepEqual(rows.map(textOf), ['LESSON one', 'LESSON two']);
  assert.deepEqual(rows.map((r) => r.participant), ['system_context:lessons', 'system_context:lessons']);
  assert.deepEqual(rows.map((r) => {
    const { agent, namespace } = (r.metadata as { contextInjection: { agent: string; namespace: string } }).contextInjection;
    return { agent, namespace };
  }), [{ agent: 'prime', namespace: 'lessons' }, { agent: 'prime', namespace: 'lessons' }], 'each row is marked with its agent and namespace');
});

test("a module's injection that opts out is placed by compile() at each start, as before, and never stored", async () => {
  const lessons = new Lessons();
  lessons.optOut = true;
  const x = await make({ modules: [lessons] });
  await turn(x, 'one');
  await turn(x, 'two');
  assert.deepEqual(x.membrane.calls[0]!.messages.map(textOf), ['one', 'LESSON one']);
  assert.deepEqual(x.membrane.calls[1]!.messages.map(textOf), ['one', 'reply to one', 'two', 'LESSON one'], 'it moves to after the newest user message');
  assert.equal(storedInjections(x.framework.getAgent('prime')!).length, 0);
});

test("an MCPL server can't opt its injection out of being stored: its conversion builds four fields alone", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  agent.getContextManager().addMessage('prime', [text('reply')]);
  const server = {
    id: 'srv',
    grant: new CapabilityGrant(new Set(['contextHooks.beforeInference.inject.afterUser']), []),
    sendBeforeInference: async () => ({
      featureSet: 'doc',
      contextInjections: [{ namespace: 'notes', position: 'afterUser', content: [{ type: 'text', text: 'SERVER' }], placedEachCompile: true }],
    }),
  };
  (x.framework as unknown as { hookOrchestrator: HookOrchestrator }).hookOrchestrator =
    new HookOrchestrator({ getAllServers: () => [server] } as never, { validateInbound: () => {} } as never);
  const preview = await x.framework.previewActivation('prime', { injections: true });
  assert.deepEqual(preview.messages.map(textOf), ['hello', 'reply', 'SERVER', '[Continue]'], 'appended, as a start stores it, not placed before the reply');
});

test('a unit a throwing write left part-stored is stored whole at the next start, so none of it is lost', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  const unit = (): ContextInjection[] => [injection('PART A'), injection('PART B')];
  const original = cm.addMessage.bind(cm);
  let writes = 0;
  const consoleError = console.error;
  console.error = () => {};
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => {
      if (++writes === 2) throw new Error('refused before landing');
      return original(...args);
    };
    const first = unit();
    assert.deepEqual(internals(x.framework).storeInjections(agent, first), [first[1]], 'its rest is placed this time');
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    console.error = consoleError;
  }
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, unit()), undefined, 'the next start stores it whole');
  assert.deepEqual(storedInjections(agent).map(textOf), ['PART A', 'PART A', 'PART B']);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, unit()), undefined);
  assert.equal(storedInjections(agent).length, 3, 'and once whole, it is skipped');
});

test('system and beforeUser injections are left to compile(), as before', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const others: ContextInjection[] = [
    { namespace: 's', position: 'system', content: [text('SYS')] },
    { namespace: 'b', position: 'beforeUser', content: [text('BEFORE')] },
  ];
  assert.deepEqual(internals(x.framework).storeInjections(agent, others), others);
  assert.equal(storedInjections(agent).length, 0);
});

test('a wake with nothing new keeps [Continue] last, after a changed injection stored after the latest reply; an unchanged one leaves the request as before', async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons] });
  await turn(x, 'one');
  // Signed, as a binding model's reply is: a later request renders a reply's
  // [Continue] before its first row it can recognise (silent-heartbeat.ts).
  const timer = (answer: string) => {
    x.membrane.pushResponse(createMockResponse([
      { type: 'thinking', thinking: `reasoning for ${answer}`, signature: `sig-${answer}` } as ContentBlock, text(answer)]));
    internals(x.framework).pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'framework', timestamp: Date.now() });
    return x.framework.runUntilIdle();
  };
  await timer('woke');
  assert.deepEqual(x.membrane.calls[1]!.messages.map(textOf), ['one', 'LESSON one', 'reply to one', '[Continue]'], 'unchanged, nothing is stored and nothing moves');
  lessons.lesson = 'LESSON two';
  await timer('woke again');
  const changed = x.membrane.calls[2]!.messages;
  assert.deepEqual(changed.map(textOf), ['one', 'LESSON one', 'reply to one', '[Continue]', 'woke', 'LESSON two', '[Continue]'],
    'the injection after the latest reply, and the cue after it, last');
  assert.equal(changed.at(-2)!.participant, 'system_context:lessons');
  await turn(x, 'two');
  assert.deepEqual(x.membrane.calls[3]!.messages.slice(0, changed.length), changed, 'and the next request begins with it: the cue stays where the reply saw it');
});

test("a speaker merely named like an injection's participant is an arrival: the request ends on it, with no [Continue]", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  agent.getContextManager().addMessage('prime', [text('reply')]);
  agent.getContextManager().addMessage('system_context:visitor', [text('VISITOR')]);
  const request = await agent.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
  assert.deepEqual(request.messages.map(textOf), ['hello', 'reply', 'VISITOR']);
});

test("another agent's stored injection stays out of a second resident's view and the subconscious's", async () => {
  const x = await make({ agents: ['prime', 'helper'], subconscious: true });
  const prime = x.framework.getAgent('prime')!;
  prime.getContextManager().addMessage('user', [text('hello')]);
  const inj = injection('PRIME-ONLY');
  internals(x.framework).storeInjections(prime, [inj]);
  const compiled = async (name: string) =>
    (await x.framework.getAgent(name)!.getContextManager().compile(undefined, undefined, { dryRun: true })).messages.map(textOf);
  assert.ok((await compiled('prime')).includes('PRIME-ONLY'), 'the premise: its own view has it');
  assert.ok((await compiled('helper')).includes('hello'), "the premise: the helper reads the residents' slot");
  assert.ok(!(await compiled('helper')).includes('PRIME-ONLY'), "the helper's doesn't");
  assert.ok((await compiled('Subconscious')).includes('hello'), "the premise: the subconscious reads the residents' slot");
  assert.ok(!(await compiled('Subconscious')).includes('PRIME-ONLY'), "the subconscious's doesn't");
  const helperInj = injection('HELPER-ONLY');
  internals(x.framework).storeInjections(x.framework.getAgent('helper')!, [helperInj]);
  assert.equal(storedInjections(prime).filter((m) => textOf(m) === 'PRIME-ONLY').length, 1);
  assert.ok(!(await compiled('prime')).includes('HELPER-ONLY'), "and each resident's skip and view are its own");
  assert.ok((await compiled('helper')).includes('HELPER-ONLY'));
});

test('the same content from two residents is stored for each: the skip is keyed by agent', async () => {
  const x = await make({ agents: ['prime', 'helper'] });
  const prime = x.framework.getAgent('prime')!;
  const helper = x.framework.getAgent('helper')!;
  prime.getContextManager().addMessage('user', [text('hello')]);
  const a = injection('SAME');
  internals(x.framework).storeInjections(prime, [a]);
  await sent(prime);
  assert.equal(internals(x.framework).storeInjections(prime, [injection('SAME')]), undefined);
  assert.equal(prime.getContextManager().getAllMessages().filter((m) => textOf(m) === 'SAME').length, 1, "the premise: prime's own skip holds");
  const b = injection('SAME');
  assert.equal(internals(x.framework).storeInjections(helper, [b]), undefined);
  assert.equal(prime.getContextManager().getAllMessages().filter((m) => textOf(m) === 'SAME').length, 2, 'one row for each, in the one slot');
});

test('a preview shows what a start would store where it would put it, and stores nothing', async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons] });
  await turn(x, 'one');
  lessons.lesson = 'LESSON two';
  const agent = x.framework.getAgent('prime')!;
  const before = agent.getContextManager().getMessageCount();
  const preview = await x.framework.previewActivation('prime', { injections: true });
  assert.equal(agent.getContextManager().getMessageCount(), before, 'nothing stored');
  assert.deepEqual(preview.messages.map(textOf), ['one', 'LESSON one', 'reply to one', 'LESSON two', '[Continue]'], 'the changed injection appended, as a start stores it, and the cue after it');
  x.membrane.pushResponse(createMockResponse([text('woke')]));
  internals(x.framework).pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'framework', timestamp: Date.now() });
  await x.framework.runUntilIdle();
  assert.deepEqual(x.membrane.calls[1]!.messages, preview.messages, 'the start that follows sends what the preview showed');
});

test("while the host is quiesced, nothing is stored: compile() places a changed one as before, and one in view isn't placed again", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const shown = injection('SHOWN');
  internals(x.framework).storeInjections(agent, [shown]);
  await sent(agent);
  internals(x.framework).quiesced = true;
  const changed = injection('CHANGED', 'other');
  try {
    assert.deepEqual(internals(x.framework).storeInjections(agent, [injection('SHOWN'), changed]), [changed], 'the one in view is neither stored nor placed');
  } finally {
    internals(x.framework).quiesced = false;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['SHOWN']);
  internals(x.framework).quiesced = true;
  const a = injection('A', 'a');
  const optedOut = { ...injection('B', 'b'), placedEachCompile: true } as ContextInjection;
  const c = injection('C', 'c');
  try {
    assert.deepEqual(internals(x.framework).storeInjections(agent, [a, optedOut, c]), [a, optedOut, c], "compile() places them in the order gathered, an opted-out one's place kept");
  } finally {
    internals(x.framework).quiesced = false;
  }
});

test("while another reader of the shared slot has a turn alive, nothing is stored there: compile() places it, as for a clock row", async () => {
  const x = await make({ agents: ['prime', 'helper'] });
  const prime = x.framework.getAgent('prime')!;
  prime.getContextManager().addMessage('user', [text('hello')]);
  const inj = injection();
  internals(x.framework).activeTurnTokens.set('helper', Symbol('turn'));
  try {
    assert.deepEqual(internals(x.framework).storeInjections(prime, [inj]), [inj]);
  } finally {
    internals(x.framework).activeTurnTokens.delete('helper');
  }
  assert.equal(storedInjections(prime).length, 0);
  assert.equal(internals(x.framework).storeInjections(prime, [inj]), undefined, 'once the slot is free, it is stored');
  assert.equal(storedInjections(prime).length, 1);
});

test("a module reads a stored injection's row, with its mark, among the window's messages", async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons] });
  await turn(x, 'one');
  const rows = lessons.ctx!.queryMessages({}).messages
    .filter((m) => (m.metadata as { contextInjection?: { agent?: string } } | undefined)?.contextInjection?.agent === 'prime');
  assert.deepEqual(rows.map(textOf), ['LESSON one']);
});

test("a namespace that isn't a string is read as its text, as compile() names the participant, and the skip still finds it", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const numbered = (): ContextInjection => ({ namespace: 5 as unknown as string, position: 'afterUser', content: [text('FIVE')] });
  const first = numbered();
  internals(x.framework).storeInjections(agent, [first]);
  await sent(agent);
  const again = numbered();
  assert.equal(internals(x.framework).storeInjections(agent, [again]), undefined, 'the second is skipped, not placed');
  const rows = storedInjections(agent);
  assert.deepEqual(rows.map((r) => r.participant), ['system_context:5'], 'stored once, named as compile() names it');
  assert.equal((rows[0]!.metadata as { contextInjection: { namespace: unknown } }).contextInjection.namespace, '5');
});

test('a write that throws before its row lands leaves the injection to compile(); one that throws after it lands keeps the row', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  const original = cm.addMessage.bind(cm);
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = () => { throw new Error('refused before landing'); };
    const refused = injection('REFUSED');
    assert.deepEqual(internals(x.framework).storeInjections(agent, [refused]), [refused], 'placed by compile() instead');
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => { original(...args); throw new Error('thrown after landing'); };
    const landed = injection('LANDED');
    assert.equal(internals(x.framework).storeInjections(agent, [landed]), undefined, 'the row that landed stands, so it is not placed again');
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    console.error = consoleError;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['LANDED']);
  assert.equal(errors.filter((e) => e.startsWith('[injection] prime: ')).length, 2, 'each is logged');
});

test("where a write throws and the read-back fails, a row whose write returned counts as stored, and the rest is placed, logged as unknown", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  const original = cm.addMessage.bind(cm);
  const originalWindow = cm.getMessageWindow.bind(cm);
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let writes = 0;
  const unit = [injection('FIRST'), injection('SECOND')];
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => {
      const id = original(...args);
      if (++writes === 2) throw new Error('thrown after landing');
      return id;
    };
    (cm as unknown as { getMessageWindow: unknown }).getMessageWindow = () => { throw new Error('unreadable'); };
    assert.deepEqual(internals(x.framework).storeInjections(agent, unit), [unit[1]], 'the one whose write threw is placed, though it landed');
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    (cm as unknown as { getMessageWindow: unknown }).getMessageWindow = originalWindow;
    console.error = consoleError;
  }
  assert.ok(errors.some((e) => e.includes('1 of 2 injection row(s) stored (whether the one that threw landed is unknown)')), errors.join('\n'));
});

test('an injection with a lone surrogate in its text and namespace is stored well formed, as compile() would have placed it, and skipped next time', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const lone = (): ContextInjection => ({ namespace: 'ns\ud83d', position: 'afterUser', content: [text('cut \ud83d here')] });
  const placed = await agent.buildActivationRequest([], [lone()], undefined, [], { dryRun: true });
  const first = lone();
  internals(x.framework).storeInjections(agent, [first]);
  await sent(agent);
  const again = lone();
  assert.equal(internals(x.framework).storeInjections(agent, [again]), undefined, 'skipped the second time');
  const rows = storedInjections(agent);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.participant, 'system_context:ns\ufffd');
  assert.equal(textOf(rows[0]!), 'cut \ufffd here');
  assert.equal((rows[0]!.metadata as { contextInjection: { namespace: string } }).contextInjection.namespace, 'ns\ufffd', "the mark's namespace is the participant's");
  const stored = await agent.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
  assert.deepEqual(stored.messages, placed.messages);
});

test("storedInjectionMarkOf reads a row's whole mark, and nothing from a row with none or a partial one", async () => {
  const { storedInjectionMarkOf } = await import('../src/index.js');
  const mark = { agent: 'prime', namespace: 'lessons', contentHash: 'h', part: 1, parts: 2 };
  assert.deepEqual(storedInjectionMarkOf({ contextInjection: mark }), mark);
  assert.deepEqual(storedInjectionMarkOf({ contextInjection: { ...mark, extra: 1 } }), mark, 'its five fields');
  for (const metadata of [undefined, {}, { contextInjection: null }, { contextInjection: 'prime' },
    { contextInjection: { namespace: 'lessons' } }, { contextInjection: { agent: 'prime', namespace: 'lessons', contentHash: 'h' } },
    { contextInjection: { ...mark, agent: 5 } }, { contextInjection: { ...mark, namespace: 5 } }, { contextInjection: { ...mark, contentHash: null } },
    { contextInjection: { ...mark, part: 2 } }, { contextInjection: { ...mark, part: -1 } },
    { contextInjection: { ...mark, part: 0.5 } }, { contextInjection: { ...mark, parts: '2' } }]) {
    assert.equal(storedInjectionMarkOf(metadata), undefined, JSON.stringify(metadata));
  }
});

test('a gather that interleaves sources is stored in the order gathered, as compile() would have placed it, and each source is skipped or stored as a unit', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const gathered = (b = 'B') => [injection('A', 'x'), injection(b, 'y'), injection('C', 'x')];
  const placed = await agent.buildActivationRequest([], gathered(), undefined, [], { dryRun: true });
  assert.equal(internals(x.framework).storeInjections(agent, gathered()), undefined);
  const stored = await agent.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
  assert.deepEqual(stored.messages, placed.messages, 'byte for byte, in the gathered order');
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'B', 'C']);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, gathered()), undefined);
  assert.equal(storedInjections(agent).length, 3, 'unchanged, both sources are skipped');
  await sent(agent);
  internals(x.framework).storeInjections(agent, gathered('B2'));
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'B', 'C', 'B2'], 'only the source that changed is stored again');
});

test('a gather mixing positions stores its afterUser injections and leaves the rest to compile(), in the order given', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const sys: ContextInjection = { namespace: 's', position: 'system', content: [text('SYS')] };
  const before: ContextInjection = { namespace: 'b', position: 'beforeUser', content: [text('BEFORE')] };
  const mixed = [sys, injection('AFTER-1', 'a'), before, injection('AFTER-2', 'c')];
  assert.deepEqual(internals(x.framework).storeInjections(agent, mixed), [sys, before]);
  assert.deepEqual(storedInjections(agent).map(textOf), ['AFTER-1', 'AFTER-2']);
});

test('content that changes back is stored again: the skip compares with the newest copy in view, not any older one', async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons] });
  lessons.lesson = 'A';
  await turn(x, 'one');
  lessons.lesson = 'B';
  await turn(x, 'two');
  lessons.lesson = 'A';
  await turn(x, 'three');
  assert.deepEqual(storedInjections(x.framework.getAgent('prime')!).map(textOf), ['A', 'B', 'A']);
  assert.deepEqual(x.membrane.calls[2]!.messages.map(textOf), ['one', 'A', 'reply to one', 'two', 'B', 'reply to two', 'three', 'A']);
});

test('a copy the last request didn\'t hold whole, as after a fold or a scroll-out, is stored again; one it held, however shaped, is skipped', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  internals(x.framework).storeInjections(agent, [injection()]);
  const [row] = storedInjections(agent);
  // What the last sent compile held, as its provenance gives it.
  const held = (bodies: Array<{ messageId: string; sequence: number; complete: boolean }>) =>
    (agent as unknown as { noteRenderedInjections(result: unknown): void }).noteRenderedInjections({
      messages: bodies.length ? [{ participant: 'system_context:lessons', content: [] }] : [],
      provenance: { messages: bodies.length ? [{ kind: 'raw', bodies }] : [], branch: cm.currentBranchRef() },
    });
  held([{ messageId: row!.id, sequence: row!.sequence, complete: true }]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 1, 'held whole: skipped');
  held([{ messageId: row!.id, sequence: row!.sequence, complete: false, missing: ['shards'] } as never]);
  internals(x.framework).storeInjections(agent, [injection()]);
  assert.equal(storedInjections(agent).length, 2, 'held without all its shards: stored again');
  const [, again] = storedInjections(agent);
  held([{ messageId: again!.id, sequence: again!.sequence, complete: false, missing: ['content'] } as never]);
  internals(x.framework).storeInjections(agent, [injection()]);
  assert.equal(storedInjections(agent).length, 2, 'held but shaped by the strategy (cut, an image stripped): skipped');
  held([]);
  internals(x.framework).storeInjections(agent, [injection()]);
  assert.equal(storedInjections(agent).length, 3, 'not held at all: stored again');
});

test('after a restart, and on another branch, an unchanged injection is stored once more, then skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-stored-injections-')); dirs.push(dir);
  const lessons = new Lessons();
  const first = await make({ modules: [lessons], dir });
  await turn(first, 'one');
  await first.framework.stop();
  frameworks.splice(frameworks.indexOf(first.framework), 1);
  const second = await make({ modules: [new Lessons()], dir });
  await turn(second, 'two');
  const agent = second.framework.getAgent('prime')!;
  assert.equal(storedInjections(agent).length, 2, 'a new process has no record of what was held, so it stores once more');
  await turn(second, 'three');
  assert.equal(storedInjections(agent).length, 2, 'then skips');
  await agent.getContextManager().fork('elsewhere');
  await turn(second, 'four');
  assert.equal(storedInjections(agent).length, 3, 'on a new branch, once more');
  await turn(second, 'five');
  assert.equal(storedInjections(agent).length, 3, 'then skips there too');
});

test("an MCPL server's injection gathered at a turn's start is stored there, after the module's", async () => {
  const x = await make({ modules: [new Lessons()] });
  (x.framework as unknown as { hookOrchestrator: unknown }).hookOrchestrator = {
    beforeInference: async () => [{ namespace: 'notes', position: 'afterUser', content: [text('SERVER')] }],
    emitLifecycle() {},
  };
  await turn(x, 'one');
  assert.deepEqual(x.membrane.calls[0]!.messages.map(textOf), ['one', 'LESSON one', 'SERVER']);
  assert.deepEqual(storedInjections(x.framework.getAgent('prime')!).map(textOf), ['LESSON one', 'SERVER']);
});

test('a preview leaves out an injection in view, places one that opts out, and while quiesced places a changed one rather than appending it', async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons] });
  await turn(x, 'one');
  const preview = async () => (await x.framework.previewActivation('prime', { injections: true })).messages.map(textOf);
  assert.deepEqual(await preview(), ['one', 'LESSON one', 'reply to one', '[Continue]'], 'unchanged: nothing appended or placed');
  lessons.lesson = 'LESSON two';
  internals(x.framework).quiesced = true;
  try {
    assert.deepEqual(await preview(), ['one', 'LESSON two', 'LESSON one', 'reply to one', '[Continue]'], 'quiesced: compile() places it');
  } finally {
    internals(x.framework).quiesced = false;
  }
  lessons.optOut = true;
  assert.deepEqual(await preview(), ['one', 'LESSON two', 'LESSON one', 'reply to one', '[Continue]'], 'opted out: compile() places it');
  assert.equal(storedInjections(x.framework.getAgent('prime')!).length, 1, 'and no preview stored anything');
});

test('the subconscious keeps its own stored injection in view', async () => {
  const x = await make({ subconscious: true });
  const sub = x.framework.getAgent('Subconscious')!;
  sub.getContextManager().addMessage('user', [text('notice this')]);
  internals(x.framework).storeInjections(sub, [injection('SUB-ONLY')]);
  const compiled = await sub.getContextManager().compile(undefined, undefined, { dryRun: true });
  assert.ok(compiled.messages.map(textOf).includes('SUB-ONLY'));
});

test("an agent's stored injection is unread while that agent hasn't read it, whatever a resident whose view leaves it out has read", async () => {
  const x = await make({ agents: ['prime', 'helper'] });
  const helper = x.framework.getAgent('helper')!;
  internals(x.framework).storeInjections(helper, [injection('HELPER-ONLY')]);
  const row = helper.getContextManager().getAllMessages().find((m) => textOf(m) === 'HELPER-ONLY')!;
  assert.ok(row, 'the premise: it was stored');
  x.framework.getAgent('prime')!.markContextConsumed();
  assert.equal(internals(x.framework).isUnreadStoredMessage(helper, row.id), true);
  helper.markContextConsumed();
  assert.equal(internals(x.framework).isUnreadStoredMessage(helper, row.id), false);
});

test("a row a tune-out holds from the residents is unread while the subconscious hasn't read it, whatever a resident has read", async () => {
  const x = await make({ subconscious: true });
  const prime = x.framework.getAgent('prime')!;
  const id = prime.getContextManager().addMessage('Antra', [text('DIVERTED')], { tuneOut: { epochId: 'e1' } } as never);
  prime.markContextConsumed();
  assert.equal(internals(x.framework).isUnreadStoredMessage(prime, id), true);
  x.framework.getAgent('Subconscious')!.markContextConsumed();
  assert.equal(internals(x.framework).isUnreadStoredMessage(prime, id), false);
});

test("a row whose mark isn't whole is no stored injection: every view keeps it", async () => {
  const x = await make({ agents: ['prime', 'helper'] });
  const prime = x.framework.getAgent('prime')!;
  prime.getContextManager().addMessage('user', [text('hello')]);
  prime.getContextManager().addMessage('system_context:lessons', [text('PARTIAL')], { contextInjection: { agent: 'prime', namespace: 'lessons' } } as never);
  const compiled = await x.framework.getAgent('helper')!.getContextManager().compile(undefined, undefined, { dryRun: true });
  assert.ok(compiled.messages.map(textOf).includes('PARTIAL'));
});

test('a channel message followed only by a stored injection is still the newest entry, so its wake needs no line of its own', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hi there')], { serverId: 'srv', channelId: 'c1', messageId: 'm1' } as never);
  const entry = { eventType: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'c1', messageId: 'm1' };
  internals(x.framework).storeInjections(agent, [injection('A', 'x'), injection('B', 'y')]);
  assert.equal(internals(x.framework).isNewestIn(agent, entry), true);
  cm.addMessage('user', [text('later')]);
  assert.equal(internals(x.framework).isNewestIn(agent, entry), false, 'the premise: an ordinary row after it makes it not the newest');
});

test("a refusal's rewind sheds the newest exchange, not a stored injection after it", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  cm.addMessage('prime', [text('poisoned reply')]);
  internals(x.framework).storeInjections(agent, [injection()]);
  internals(x.framework).shedNewestTurn(agent);
  assert.ok(!cm.getAllMessages().some((m) => textOf(m) === 'poisoned reply'), 'the reply is shed');
  assert.deepEqual(storedInjections(agent).map(textOf), ['LESSON one'], 'the injection stays');
});

test('a preview puts a stand-in where the start would store it: before what compile() places at the end of a window with no user message', async () => {
  const before: ContextInjection = { namespace: 'b', position: 'beforeUser', content: [text('BEFORE')] };
  const optedOut = { ...injection('PLACED', 'p'), placedEachCompile: true } as ContextInjection;
  const gathers: Module = {
    name: 'gathers', async start() {}, async stop() {}, getTools: () => [],
    async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; },
    async onProcess() { return {}; },
    async gatherContext() { return [before, injection('STORED'), optedOut]; },
  };
  const x = await make({ modules: [gathers] });
  x.framework.getAgent('prime')!.getContextManager().addMessage('prime', [text('a reply, with no user message before it')]);
  const preview = await x.framework.previewActivation('prime', { injections: true });
  x.membrane.pushResponse(createMockResponse([text('woke')]));
  internals(x.framework).pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'framework', timestamp: Date.now() });
  await x.framework.runUntilIdle();
  const start = x.membrane.calls[0]!.messages;
  assert.deepEqual(start.map(textOf), ['a reply, with no user message before it', 'STORED', 'BEFORE', 'PLACED'], 'the premise: the start renders the stored row before what compile() places, which ends the request, as on main');
  assert.deepEqual(preview.messages, start);
});

test('in a window with no user message, a stored injection after the agent\'s reply is followed by [Continue]; a placed one ends the request, as on main', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('prime', [text('a reply, with no user message before it')]);
  const placed = await agent.buildActivationRequest([], [injection('LESSON')], undefined, [], { dryRun: true });
  assert.deepEqual(placed.messages.map(textOf), ['a reply, with no user message before it', 'LESSON'], 'placed, it ends the request, as on main');
  internals(x.framework).storeInjections(agent, [injection('LESSON')]);
  const stored = await agent.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
  assert.deepEqual(stored.messages.map(textOf), ['a reply, with no user message before it', 'LESSON', '[Continue]']);
});

test('an injection over the strategy\'s per-message cap is stored once: the cut copy counts as held, since a new one would be cut the same', async () => {
  const long = 'LESSON ' + 'word '.repeat(400);
  for (const [cap, why] of [[50, 'over the cap'], [100_000, 'under it']] as const) {
    const lessons = new Lessons();
    lessons.lesson = long;
    const x = await make({ modules: [lessons], strategy: new WindowedPassthroughStrategy({ maxMessageTokens: cap }) });
    for (const t of ['one', 'two', 'three']) await turn(x, t);
    assert.equal(storedInjections(x.framework.getAgent('prime')!).length, 1, why);
    const last = x.membrane.calls.at(-1)!.messages;
    assert.equal(last.filter((m) => m.participant === 'system_context:lessons').length, 1, `${why}: one copy in the request`);
    if (cap === 50) assert.ok(!textOf(last.find((m) => m.participant === 'system_context:lessons')!).includes(long), 'the premise: the cap cut it');
  }
});

test("a dry compile leaves the record alone: a preview on another branch doesn't make the next start store again", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  internals(x.framework).storeInjections(agent, [injection()]);
  await sent(agent);
  const home = cm.currentBranch().name;
  await cm.fork('elsewhere');
  await agent.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
  await cm.switchBranch(home);
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 1, 'back on its branch, the sent record still holds it');
});

test("a row that landed though its write threw is traced as added, as one whose write returned is", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  const traced: Array<{ messageId?: unknown; source?: unknown }> = [];
  x.framework.onTrace((e) => { if ((e as { type: string }).type === 'message:added') traced.push(e as never); });
  const original = cm.addMessage.bind(cm);
  const consoleError = console.error;
  console.error = () => {};
  let writes = 0;
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => {
      const id = original(...args);
      if (++writes === 2) throw new Error('thrown after landing');
      return id;
    };
    internals(x.framework).storeInjections(agent, [injection('FIRST', 'a'), injection('SECOND', 'b')]);
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    console.error = consoleError;
  }
  const rows = storedInjections(agent);
  assert.deepEqual(rows.map(textOf), ['FIRST', 'SECOND']);
  assert.deepEqual(traced.filter((e) => String(e.source).startsWith('context-injection')).map((e) => [e.messageId, e.source]),
    [[rows[0]!.id, 'context-injection:a'], [rows[1]!.id, 'context-injection:b']], 'each once, naming its namespace');
});

test("a newest copy missing shards isn't held: the same content is stored again", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  internals(x.framework).storeInjections(agent, [injection('OLD')]);
  await sent(agent);
  internals(x.framework).storeInjections(agent, [injection('NEW')]);
  const [old, newer] = storedInjections(agent);
  (agent as unknown as { noteRenderedInjections(result: unknown): void }).noteRenderedInjections({
    messages: [{ participant: 'system_context:lessons', content: [] }, { participant: 'system_context:lessons', content: [] }],
    provenance: {
      messages: [
        { kind: 'raw', bodies: [{ messageId: old!.id, sequence: old!.sequence, complete: true }] },
        { kind: 'raw', bodies: [{ messageId: newer!.id, sequence: newer!.sequence, complete: false, missing: ['shards'] }] },
      ],
      branch: cm.currentBranchRef(),
    },
  });
  assert.equal(internals(x.framework).storeInjections(agent, [injection('NEW')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['OLD', 'NEW', 'NEW'], 'NEW, missing shards, is not held, so it is stored again');
});

test("content changed back to an older copy's is stored again: the newest content in view decides", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  internals(x.framework).storeInjections(agent, [injection('OLD')]);
  await sent(agent);
  internals(x.framework).storeInjections(agent, [injection('NEW')]);
  const [old, newer] = storedInjections(agent);
  noteHeld(agent, [[old!, { complete: true }], [newer!, { complete: false, missing: ['shards'] }]]);
  internals(x.framework).storeInjections(agent, [injection('OLD')]);
  assert.deepEqual(storedInjections(agent).map(textOf), ['OLD', 'NEW', 'OLD'], "the newest in view is NEW, cut short, so OLD isn't what the agent last saw");
});

test("an injection that would leave nothing in a request isn't stored: compile() places it and the sanitizer drops it, so [Continue] stays last", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  agent.getContextManager().addMessage('prime', [text('reply')]);
  const blank: ContextInjection = { namespace: 'lessons', position: 'afterUser', content: [text('  \n ')] };
  const none: ContextInjection = { namespace: 'other', position: 'afterUser', content: [] };
  assert.deepEqual(internals(x.framework).storeInjections(agent, [blank, none]), [blank, none]);
  assert.equal(storedInjections(agent).length, 0);
  const request = await agent.buildActivationRequest([], [blank, none], undefined, [], { dryRun: true });
  assert.deepEqual(request.messages.map(textOf), ['hello', 'reply', '[Continue]']);
});

test('a source that gives the same object twice has both stored as parts of one unit, which is then skipped', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const twice = injection('TWICE');
  assert.equal(internals(x.framework).storeInjections(agent, [twice, twice]), undefined);
  const rows = storedInjections(agent);
  assert.deepEqual(rows.map((r) => (r.metadata as { contextInjection: { part: number; parts: number } }).contextInjection), [
    { agent: 'prime', namespace: 'lessons', contentHash: (rows[0]!.metadata as { contextInjection: { contentHash: string } }).contextInjection.contentHash, part: 0, parts: 2 },
    { agent: 'prime', namespace: 'lessons', contentHash: (rows[0]!.metadata as { contextInjection: { contentHash: string } }).contextInjection.contentHash, part: 1, parts: 2 },
  ]);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [twice, twice]), undefined);
  assert.equal(storedInjections(agent).length, 2, 'held whole, skipped');
});

test("a stored row is marked as the framework's own: system, and kind 'context-injection'", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  internals(x.framework).storeInjections(agent, [injection()]);
  const [row] = storedInjections(agent);
  assert.equal((row!.metadata as { system?: unknown }).system, true);
  assert.equal((row!.metadata as { kind?: unknown }).kind, 'context-injection');
});

test("while another reader of the shared slot has a turn alive, a preview places a changed injection, as the start would", async () => {
  const lessons = new Lessons();
  const x = await make({ modules: [lessons], agents: ['prime', 'helper'] });
  // The window a turn would leave, written directly: with two residents, a
  // turn would ask both to answer.
  const prime = x.framework.getAgent('prime')!;
  prime.getContextManager().addMessage('user', [text('one')]);
  internals(x.framework).storeInjections(prime, [injection('LESSON one')]);
  prime.getContextManager().addMessage('prime', [text('reply to one')]);
  await sent(prime);
  lessons.lesson = 'LESSON two';
  internals(x.framework).activeTurnTokens.set('helper', Symbol('turn'));
  try {
    const preview = (await x.framework.previewActivation('prime', { injections: true })).messages.map(textOf);
    assert.deepEqual(preview, ['one', 'LESSON two', 'LESSON one', 'reply to one', '[Continue]']);
  } finally {
    internals(x.framework).activeTurnTokens.delete('helper');
  }
});

test("a channel message followed by another resident's stored injection is still the newest entry", async () => {
  const x = await make({ agents: ['prime', 'helper'] });
  const prime = x.framework.getAgent('prime')!;
  prime.getContextManager().addMessage('user', [text('hi there')], { serverId: 'srv', channelId: 'c1', messageId: 'm1' } as never);
  internals(x.framework).storeInjections(x.framework.getAgent('helper')!, [injection('HELPER')]);
  assert.equal(internals(x.framework).isNewestIn(prime, { eventType: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'c1', messageId: 'm1' }), true);
});

test('where another resident spoke last, a stored injection after that message ends the request, with no [Continue]', async () => {
  const x = await make({ agents: ['prime', 'helper'] });
  const prime = x.framework.getAgent('prime')!;
  prime.getContextManager().addMessage('user', [text('hello')]);
  prime.getContextManager().addMessage('helper', [text("helper's answer")]);
  internals(x.framework).storeInjections(prime, [injection('LESSON')]);
  const request = await prime.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
  assert.deepEqual(request.messages.map(textOf), ['hello', "helper's answer", 'LESSON']);
});

test('copies of one content pool the parts they hold, whatever other content sits between them; copies that each miss a part pool nothing more', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const unit = () => [injection('H1'), injection('H1b')];
  internals(x.framework).storeInjections(agent, unit());
  await sent(agent);
  internals(x.framework).storeInjections(agent, [injection('H2')]);
  await sent(agent);
  internals(x.framework).storeInjections(agent, unit());
  const rows = storedInjections(agent);
  assert.deepEqual(rows.map(textOf), ['H1', 'H1b', 'H2', 'H1', 'H1b']);
  // The first copy holds part 0, the second part 1, with H2 between them.
  noteHeld(agent, [[rows[0]!, { complete: true }], [rows[1]!, { complete: false, missing: ['shards'] }], [rows[2]!, { complete: true }],
    [rows[3]!, { complete: false, missing: ['shards'] }], [rows[4]!, { complete: true }]]);
  assert.equal(internals(x.framework).storeInjections(agent, unit()), undefined);
  assert.equal(storedInjections(agent).length, 5, 'pooled across H2, H1 is held whole: skipped');
  // Neither copy holds part 1.
  noteHeld(agent, [[rows[0]!, { complete: true }], [rows[1]!, { complete: false, missing: ['shards'] }],
    [rows[3]!, { complete: true }], [rows[4]!, { complete: false, missing: ['shards'] }]]);
  internals(x.framework).storeInjections(agent, unit());
  assert.equal(storedInjections(agent).length, 7, 'no copy holds part 1: stored again');
});

test('a gather of a stored injection and a blank one in a window ending on the reply keeps [Continue] last: the blank one is placed and sanitized away', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('prime', [text('a reply, with no user message before it')]);
  const blank: ContextInjection = { namespace: 'blank', position: 'afterUser', content: [text('   ')] };
  const left = internals(x.framework).storeInjections(agent, [injection('REAL'), blank]);
  assert.deepEqual(left, [blank], 'the blank one is left to compile()');
  const request = await agent.buildActivationRequest([], left, undefined, [], { dryRun: true });
  assert.deepEqual(request.messages.map(textOf), ['a reply, with no user message before it', 'REAL', '[Continue]']);
});

test("an injection of non-text blocks alone is stored; a text block whose text isn't a string counts as blank", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  const image: ContextInjection = { namespace: 'pictures', position: 'afterUser',
    content: [{ type: 'image', source: { type: 'base64', data: 'R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', mediaType: 'image/gif' } } as ContentBlock] };
  const odd: ContextInjection = { namespace: 'odd', position: 'afterUser', content: [{ type: 'text', text: 5 } as unknown as ContentBlock] };
  assert.deepEqual(internals(x.framework).storeInjections(agent, [image, odd]), [odd]);
  assert.deepEqual(storedInjections(agent).map((r) => r.participant), ['system_context:pictures']);
});

test('a source giving the same object twice, whose second write throws before landing, has that occurrence alone placed', async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  const twice = injection('TWICE');
  const original = cm.addMessage.bind(cm);
  const consoleError = console.error;
  console.error = () => {};
  let writes = 0;
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => {
      if (++writes === 2) throw new Error('refused before landing');
      return original(...args);
    };
    const left = internals(x.framework).storeInjections(agent, [twice, twice]);
    assert.equal(left?.length, 1, 'one occurrence is placed, not both and not neither');
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    console.error = consoleError;
  }
  assert.equal(storedInjections(agent).length, 1);
});

test("a start doesn't fail when the store can't read a row: the record and the trailing count pass it over, and say so; a start's reads by id don't grow with the ordinary rows before the stored ones", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  cm.addMessage('prime', [text('reply')]);
  internals(x.framework).storeInjections(agent, [injection()]);
  const getMessage = cm.getMessage.bind(cm);
  const errors: string[] = [];
  const read: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    cm.getMessage = (id) => { read.push(id); throw new Error('store unavailable'); };
    const request = await sent(agent);
    assert.deepEqual(request.messages.map(textOf), ['hello', 'reply', 'LESSON one'], 'built, the unreadable row counted as no stored one');
  } finally {
    cm.getMessage = getMessage;
    console.error = consoleError;
  }
  assert.ok(read.length > 0, 'the premise: it read the stored row');
  // The record passed the unreadable row over, so the next start stores it again.
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 2, 'not taken for held');
  // Readable, a start's reads by id are the same with four times the ordinary rows before the stored one.
  const readsAt = async (pairs: number): Promise<number> => {
    const y = await make();
    const other = y.framework.getAgent('prime')!;
    const window = other.getContextManager();
    for (let i = 0; i < pairs; i++) {
      window.addMessage('user', [text(`hello ${i}`)]);
      window.addMessage('prime', [text(`reply ${i}`)]);
    }
    internals(y.framework).storeInjections(other, [injection()]);
    const get = window.getMessage.bind(window);
    let reads = 0;
    window.getMessage = (id) => { reads++; return get(id); };
    try {
      await sent(other);
    } finally {
      window.getMessage = get;
    }
    return reads;
  };
  const few = await readsAt(4);
  assert.ok(few > 0, 'the premise: a start reads the stored row');
  assert.equal(await readsAt(16), few);
  assert.ok(errors.some((e) => e.startsWith('[injection] prime: could not read stored row')), errors.join('\n'));
});

test("the direct API's inference records what its compile held, so the next start skips what it showed", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  internals(x.framework).storeInjections(agent, [injection()]);
  x.membrane.pushResponse(createMockResponse([text('direct reply')]));
  assert.equal(agent.renderedInjection('lessons'), undefined, 'the premise: no compile has recorded yet');
  await agent.runInferenceWithInjections([], undefined);
  assert.equal(x.membrane.calls.length, 1, 'the premise: the direct API sent a request');
  assert.equal(agent.renderedInjection('lessons')?.whole, true, 'its own record says the direct request held it');
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 1, 'held by the direct request: skipped');
});

test('a preview with a stand-in and a placed blank injection keeps [Continue] last, as the start does', async () => {
  const blank: ContextInjection = { namespace: 'blank', position: 'afterUser', content: [text('   ')] };
  const gathers: Module = {
    name: 'gathers', async start() {}, async stop() {}, getTools: () => [],
    async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; },
    async onProcess() { return {}; },
    async gatherContext() { return [injection('REAL'), blank]; },
  };
  const x = await make({ modules: [gathers] });
  x.framework.getAgent('prime')!.getContextManager().addMessage('prime', [text('a reply, with no user message before it')]);
  const preview = await x.framework.previewActivation('prime', { injections: true });
  assert.deepEqual(preview.messages.map(textOf), ['a reply, with no user message before it', 'REAL', '[Continue]']);
  x.membrane.pushResponse(createMockResponse([text('woke')]));
  internals(x.framework).pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'framework', timestamp: Date.now() });
  await x.framework.runUntilIdle();
  assert.deepEqual(x.membrane.calls[0]!.messages, preview.messages, 'the start sends what the preview showed');
});

test("in a held window with no user message, a changed injection compile() places ends the request with no [Continue], as on main", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('prime', [text('a reply, with no user message before it')]);
  internals(x.framework).quiesced = true;
  try {
    const left = internals(x.framework).storeInjections(agent, [injection('CHANGED')]);
    assert.equal(storedInjections(agent).length, 0, 'the premise: held, it is placed, not stored');
    const request = await agent.buildActivationRequest([], left, undefined, [], { dryRun: true });
    assert.deepEqual(request.messages.map(textOf), ['a reply, with no user message before it', 'CHANGED']);
  } finally {
    internals(x.framework).quiesced = false;
  }
});

test("a start whose compile throws, retried by the error policy, stores a changed injection once: the failed attempt's copy hasn't been in a request yet", async () => {
  const lessons = new Lessons();
  lessons.lesson = 'FIRST';
  const x = await make({
    modules: [lessons],
    errorPolicy: { maxRetries: 3, onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
  });
  const agent = x.framework.getAgent('prime')!;
  await turn(x, 'hello');
  assert.deepEqual(storedInjections(agent).map(textOf), ['FIRST'], 'the premise: stored and sent');
  lessons.lesson = 'SECOND';
  const cm = agent.getContextManager();
  const compile = cm.compile.bind(cm);
  let failures = 2;
  cm.compile = (async (...args: Parameters<typeof compile>) => {
    if (failures-- > 0) throw new Error('the compile failed');
    return compile(...args);
  }) as typeof cm.compile;
  await turn(x, 'again');
  assert.equal(failures, -1, 'the premise: two attempts failed and the third compiled');
  assert.deepEqual(storedInjections(agent).map(textOf), ['FIRST', 'SECOND'], 'one copy of the changed content');
  const request = x.membrane.calls.at(-1)!.messages.map(textOf);
  assert.ok(request.includes('SECOND'), 'and the retry that compiled carried it');
});

test("with no request sent since it started, a start's retry still finds the copy its failed attempt stored", async () => {
  const lessons = new Lessons();
  const x = await make({
    modules: [lessons],
    errorPolicy: { maxRetries: 2, onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 2 ? { retry: true, delayMs: 0 } : { retry: false }) },
  });
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  const compile = cm.compile.bind(cm);
  let failures = 1;
  cm.compile = (async (...args: Parameters<typeof compile>) => {
    if (failures-- > 0) throw new Error('the compile failed');
    return compile(...args);
  }) as typeof cm.compile;
  await turn(x, 'hello');
  assert.equal(failures, -1, 'the premise: the first attempt failed');
  assert.deepEqual(storedInjections(agent).map(textOf), ['LESSON one']);
});

/** The framework's module registry, whose gather the tests below call. */
const registryOf = (x: { framework: AgentFramework }) =>
  (x.framework as unknown as { moduleRegistry: { gatherContext(agent: string): Promise<ModuleContextInjection[]> } }).moduleRegistry;

/** A module that gathers one `afterUser` injection under `namespace` after
 *  `delayMs`, as a slower source finishes later. */
class Timed implements Module {
  readonly name: string;
  delayMs = 0;
  contextTimeoutMs?: number;
  /** Where it notes its name when its gather finishes, if given. */
  finished?: string[];
  /** What it waits for before it finishes, in place of its delay, if given. */
  waitFor?: () => Promise<unknown>;
  private readonly onFinish = new Set<() => void>();
  /** Resolves when its next gather finishes. */
  whenFinished(): Promise<void> { return new Promise((resolve) => this.onFinish.add(resolve)); }
  constructor(name: string, private readonly says: string, private readonly namespace = 'shared') { this.name = name; }
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  async onProcess() { return {}; }
  async gatherContext(): Promise<ModuleContextInjection[]> {
    await (this.waitFor ? this.waitFor() : new Promise((resolve) => setTimeout(resolve, this.delayMs)));
    this.finished?.push(this.name);
    for (const resolve of this.onFinish) resolve();
    this.onFinish.clear();
    return [{ namespace: this.namespace, position: 'afterUser', content: [text(this.says)] }];
  }
}

test("injections come in the modules' registration order, whatever order they finish in, so an unchanged unit isn't stored again when the order they finish in changes", async () => {
  const first = new Timed('first-source', 'FROM FIRST');
  const second = new Timed('second-source', 'FROM SECOND');
  const lessons = new Lessons();
  const finished: string[] = [];
  first.finished = finished;
  second.finished = finished;
  const x = await make({ modules: [lessons, first, second] });
  const agent = x.framework.getAgent('prime')!;
  first.waitFor = () => second.whenFinished();
  await turn(x, 'hello');
  assert.deepEqual(finished, ['second-source', 'first-source'], 'the premise: the first finished last');
  const shared = () => storedInjections(agent).map(textOf).filter((t) => t.startsWith('FROM'));
  assert.deepEqual(shared(), ['FROM FIRST', 'FROM SECOND'], 'registration order, though the first finished last');
  first.waitFor = undefined;
  second.waitFor = () => first.whenFinished();
  finished.length = 0;
  await turn(x, 'again');
  assert.deepEqual(finished, ['first-source', 'second-source'], 'the premise: now the second finished last');
  assert.deepEqual(shared(), ['FROM FIRST', 'FROM SECOND'], 'the same unit, not stored again');
});

test("a module that answers after its timeout, while another module is still gathering, adds nothing to what is gathered", async () => {
  const finished: string[] = [];
  const late = new Timed('late-source', 'TOO LATE', 'late');
  late.delayMs = 200;
  late.contextTimeoutMs = 10;
  late.finished = finished;
  const slow = new Timed('slow-source', 'IN TIME', 'slow');
  slow.waitFor = () => late.whenFinished();
  slow.finished = finished;
  slow.contextTimeoutMs = 5_000;
  const x = await make({ modules: [late, slow] });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let gathered: ModuleContextInjection[];
  try {
    gathered = await registryOf(x).gatherContext('prime');
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((e) => e.includes('late-source') && e.includes('timed out')), errors.join('\n'));
  assert.deepEqual(finished, ['late-source', 'slow-source'], 'the premise: the late module answered while the slow one was still gathering');
  assert.deepEqual(gathered.map((i) => i.namespace), ['slow'], 'the late answer added nothing');
});

test("a module whose gatherContext throws, answers with something that isn't an array, or holds an entry that can't be read, is skipped, and the others' injections are kept", async () => {
  const one = { namespace: 'object', position: 'afterUser', content: [text('NOT AN ARRAY')] };
  const answers: Array<[string, () => unknown]> = [
    ['throws-source', () => { throw new Error('thrown before any promise'); }],
    ['rejects-source', async () => { throw new Error('rejected'); }],
    ['sync-undefined-source', () => undefined],
    ['undefined-source', async () => undefined],
    ['null-source', async () => null],
    ['object-source', async () => one],
    ['string-source', async () => 'oops'],
    ['set-source', async () => new Set([one])],
    ['null-entry-source', async () => [one, null]],
    ['string-entry-source', async () => [one, 'x']],
    ['contentless-system-source', async () => [one, { namespace: 'sys', position: 'system' }]],
    ['null-block-system-source', async () => [one, { namespace: 'sys', position: 'system', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, null] }]],
    // A hole, which `every` and `some` pass over, and a spread reads as undefined.
    ['hole-block-system-source', async () => {
      const content: unknown[] = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }];
      content.length = 3;
      content[2] = text('after the hole');
      return [one, { namespace: 'sys', position: 'system', content }];
    }],
    ['hole-entry-source', async () => { const answer: unknown[] = [one]; answer.length = 2; return answer; }],
  ];
  const modules: Module[] = answers.map(([name, gather]) => ({
    name, async start() {}, async stop() {}, getTools: () => [],
    async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; },
    async onProcess() { return {}; },
    gatherContext: gather as Module['gatherContext'],
  }));
  const x = await make({ modules: [...modules, new Timed('kept-source', 'KEPT', 'kept')] });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let gathered: ModuleContextInjection[];
  try {
    gathered = await registryOf(x).gatherContext('prime');
  } finally {
    console.error = original;
  }
  assert.deepEqual(gathered.map((i) => i.namespace), ['kept']);
  for (const [name] of answers) assert.ok(errors.some((e) => e.includes(name)), `${name} is logged: ${errors.join('\n')}`);
  assert.ok(errors.some((e) => e.includes('hole-entry-source') && e.includes('not an array of objects')), 'a hole in the answer is refused by the check, not by a later read');
});

test("a window that can't be read when a start sets its point is stored into, with nothing recorded to skip it, and the start goes on", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  await sent(agent);
  const cm = agent.getContextManager();
  const getMessageWindow = cm.getMessageWindow.bind(cm);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  cm.getMessageWindow = (() => { throw new Error('unreadable'); }) as typeof cm.getMessageWindow;
  try {
    assert.equal(internals(x.framework).storeInjections(agent, [injection('CHANGED')]), undefined, 'stored, not placed');
  } finally {
    cm.getMessageWindow = getMessageWindow;
    console.error = original;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['CHANGED']);
  assert.ok(errors.some((e) => e.includes('could not read its window for copies stored since its last request')), errors.join('\n'));
});

test("a window that can't be read leaves the last request's record to decide: the same content it held whole isn't stored again", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('HELD')]), undefined);
  await sent(agent);
  const getMessageWindow = cm.getMessageWindow.bind(cm);
  const original = console.error;
  console.error = () => {};
  cm.getMessageWindow = (() => { throw new Error('unreadable'); }) as typeof cm.getMessageWindow;
  try {
    assert.equal(internals(x.framework).storeInjections(agent, [injection('HELD')]), undefined);
  } finally {
    cm.getMessageWindow = getMessageWindow;
    console.error = original;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['HELD'], 'the record says it was held whole');
});

test("a read that fails partway leaves the newest copy it found to decide", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('A')]), undefined);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('C')]), undefined);
  for (let i = 0; i < 100; i++) cm.addMessage('user', [text(`row ${i}`)]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('D')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'C', 'D'], 'the premise: C and D stored, neither sent, 100 rows apart');
  const getMessageWindow = cm.getMessageWindow.bind(cm);
  let reads = 0;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  cm.getMessageWindow = ((...args: Parameters<typeof getMessageWindow>) => {
    if (++reads === 2) throw new Error('unreadable');
    return getMessageWindow(...args);
  }) as typeof cm.getMessageWindow;
  try {
    assert.equal(internals(x.framework).storeInjections(agent, [injection('A')]), undefined);
  } finally {
    cm.getMessageWindow = getMessageWindow;
    console.error = original;
  }
  assert.equal(reads, 2, 'the premise: the first read of 64 rows held D, and the second failed');
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'C', 'D', 'A'], "D, not the record's A, is newest, so A is stored again");
  assert.ok(errors.some((e) => e.includes('the rows it read decide')), errors.join('\n'));
});

test("content that changed back while a start's compile failed is stored again: the copy that failed is newer than what the last request held", async () => {
  const lessons = new Lessons();
  lessons.lesson = 'FIRST';
  const x = await make({ modules: [lessons], errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } });
  const agent = x.framework.getAgent('prime')!;
  await turn(x, 'hello');
  lessons.lesson = 'SECOND';
  const cm = agent.getContextManager();
  const compile = cm.compile.bind(cm);
  let failures = 1;
  cm.compile = (async (...args: Parameters<typeof compile>) => {
    if (failures-- > 0) throw new Error('the compile failed');
    return compile(...args);
  }) as typeof cm.compile;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    internals(x.framework).pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'framework', timestamp: Date.now() });
    await x.framework.runUntilIdle();
  } finally {
    console.error = original;
  }
  assert.equal(failures, 0, 'the premise: that start failed, with no retry');
  assert.deepEqual(storedInjections(agent).map(textOf), ['FIRST', 'SECOND'], 'the premise: its copy is stored');
  lessons.lesson = 'FIRST';
  await turn(x, 'again');
  assert.deepEqual(storedInjections(agent).map(textOf), ['FIRST', 'SECOND', 'FIRST'], 'the content the agent has now is newest');
  const request = x.membrane.calls.at(-1)!.messages.map(textOf);
  assert.ok(request.lastIndexOf('FIRST') > request.lastIndexOf('SECOND'), request.join(' | '));
});

test("a restart between a start whose compile threw and the next sent compile stores the source's content once more, newest, as after any restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-stored-injections-')); dirs.push(dir);
  const lessons = new Lessons();
  lessons.lesson = 'FIRST';
  const first = await make({ modules: [lessons], dir, errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } });
  await turn(first, 'one');
  lessons.lesson = 'SECOND';
  const cm = first.framework.getAgent('prime')!.getContextManager();
  cm.compile = (async () => { throw new Error('the compile failed'); }) as typeof cm.compile;
  const original = console.error;
  console.error = () => {};
  try {
    internals(first.framework).pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'framework', timestamp: Date.now() });
    await first.framework.runUntilIdle();
  } finally {
    console.error = original;
  }
  assert.deepEqual(storedInjections(first.framework.getAgent('prime')!).map(textOf), ['FIRST', 'SECOND'], 'the premise: the failed start stored its copy');
  await first.framework.stop();
  frameworks.splice(frameworks.indexOf(first.framework), 1);
  const back = new Lessons();
  back.lesson = 'FIRST';
  const second = await make({ modules: [back], dir });
  await turn(second, 'two');
  const agent = second.framework.getAgent('prime')!;
  assert.deepEqual(storedInjections(agent).map(textOf), ['FIRST', 'SECOND', 'FIRST'], 'stored once more after the restart');
  const request = second.membrane.calls.at(-1)!.messages.map(textOf);
  assert.ok(request.lastIndexOf('FIRST') > request.lastIndexOf('SECOND'), request.join(' | '));
});

test("a retry stores again a unit whose failed attempt stored only some of its parts", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  await sent(agent);
  const unit = (): ContextInjection[] => [injection('PART A'), injection('PART B')];
  const original = cm.addMessage.bind(cm);
  let writes = 0;
  const consoleError = console.error;
  console.error = () => {};
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => {
      if (++writes === 2) throw new Error('refused before landing');
      return original(...args);
    };
    internals(x.framework).storeInjections(agent, unit());
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    console.error = consoleError;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['PART A'], 'the premise: the attempt stored one part, and no compile followed');
  assert.equal(internals(x.framework).storeInjections(agent, unit()), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['PART A', 'PART A', 'PART B'], 'stored whole');
});

test("a failed attempt's copy decides only for its own namespace and its own agent", async () => {
  const x = await make({ agents: ['prime', 'other'] });
  const prime = x.framework.getAgent('prime')!;
  const other = x.framework.getAgent('other')!;
  prime.getContextManager().addMessage('user', [text('hello')]);
  await sent(prime);
  await sent(other);
  const both = () => [injection('X', 'lessons'), injection('Y', 'notes')];
  assert.equal(internals(x.framework).storeInjections(prime, both()), undefined);
  assert.equal(internals(x.framework).storeInjections(other, [injection('Z', 'lessons')]), undefined);
  assert.deepEqual(storedInjections(prime).map(textOf), ['X', 'Y', 'Z'], "the premise: stored in the residents' one slot, with no compile after");
  assert.equal(internals(x.framework).storeInjections(prime, both()), undefined);
  assert.deepEqual(storedInjections(prime).map(textOf), ['X', 'Y', 'Z'], "prime's retry finds its own copies, past the other namespace's and the other resident's newer ones");
});

test("a failed attempt's copy doesn't decide on another branch: the store there is one more row, as any branch change is", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 1, 'the premise: stored, with no compile after');
  await agent.getContextManager().fork('elsewhere');
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 2, 'once more on the new branch');
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 2, "then its retry finds that branch's copy");
});

test("a failed attempt's copy is found however many rows came after it", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  for (let i = 0; i < 150; i++) cm.addMessage('user', [text(`row ${i}`)]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 1, 'found 150 rows back, past two reads of 64');
});

test("rows from before the last sent request don't count as unsent: a copy that request didn't hold whole is stored again, though another namespace's plan set the point first", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('X')]), undefined);
  const [row] = storedInjections(agent);
  noteHeld(agent, [[{ id: row!.id, sequence: row!.sequence }, { complete: false, missing: ['shards'] }]]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('Y', 'notes'), injection('X')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['X', 'Y', 'X'], 'the copy the request held in part is stored again');
});

test("the newest of several failed attempts' contents decides, and only its own parts are pooled", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  await sent(agent);
  const unit = (t: string): ContextInjection[] => [injection(`${t}1`), injection(`${t}2`)];
  assert.equal(internals(x.framework).storeInjections(agent, unit('B')), undefined);
  const original = cm.addMessage.bind(cm);
  let writes = 0;
  const consoleError = console.error;
  console.error = () => {};
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => {
      if (++writes === 2) throw new Error('refused before landing');
      return original(...args);
    };
    internals(x.framework).storeInjections(agent, unit('C'));
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    console.error = consoleError;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['B1', 'B2', 'C1'], "the premise: B whole, then C's first part alone");
  assert.equal(internals(x.framework).storeInjections(agent, unit('C')), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['B1', 'B2', 'C1', 'C1', 'C2'], "C is stored whole: B's parts don't make it whole");
  assert.equal(internals(x.framework).storeInjections(agent, unit('B')), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['B1', 'B2', 'C1', 'C1', 'C2', 'B1', 'B2'], 'the newest unsent content is C, so B is stored again');
});

test("a start or preview on another branch doesn't move this branch's point past a copy no request has had", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('A')]), undefined);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('B')]), undefined);
  const home = cm.currentBranch().name;
  await cm.fork('elsewhere');
  internals(x.framework).planInjectionStores(agent, [injection('C')]);
  await cm.switchBranch(home);
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'B'], 'the premise: back home, B stored and never sent');
  assert.equal(internals(x.framework).storeInjections(agent, [injection('A')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'B', 'A'], "the source's A is newest again");
});

test("a start that stored a whole unit of several parts and recorded no compile, as when its compile throws, has it found whole by the next plan", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  await sent(agent);
  const unit = (): ContextInjection[] => [injection('PART A'), injection('PART B')];
  assert.equal(internals(x.framework).storeInjections(agent, unit()), undefined);
  assert.equal(internals(x.framework).storeInjections(agent, unit()), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['PART A', 'PART B'], 'found whole, not stored again');
});

test("a sent compile on another branch leaves this branch's point, so its unsent copy still counts on return", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('A')]), undefined);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('B')]), undefined);
  const home = cm.currentBranch().name;
  await cm.fork('elsewhere');
  await sent(agent);
  await cm.switchBranch(home);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('B')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'B'], "home's unsent B still counts: not stored again");
});

test("a sent compile unsets the point of the branch it read, not the one current when it's recorded", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  await sent(agent);
  const homeRef = cm.currentBranchRef();
  assert.equal(internals(x.framework).storeInjections(agent, [injection('B')]), undefined);
  await cm.fork('elsewhere');
  assert.equal(internals(x.framework).storeInjections(agent, [injection('C')]), undefined);
  (agent as unknown as { noteRenderedInjections(result: unknown): void }).noteRenderedInjections({
    messages: [], provenance: { messages: [], branch: homeRef },
  });
  assert.equal(internals(x.framework).storeInjections(agent, [injection('C')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['B', 'C'], "this branch's unsent C still counts");
  await cm.switchBranch(homeRef.name);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('B')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['B', 'B'], "and home's point went, so its B counts as sent, and with nothing recorded as held, B is stored once more");
});

test("an answer the module changes after giving it, while another module is still gathering, is gathered as it was given", async () => {
  const given: ModuleContextInjection[] = [{ namespace: 'given', position: 'afterUser', content: [text('AS GIVEN')] }];
  let pushed!: () => void;
  const changed = new Promise<void>((resolve) => { pushed = resolve; });
  const changes: Module = {
    name: 'changes-source', async start() {}, async stop() {}, getTools: () => [],
    async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; },
    async onProcess() { return {}; },
    async gatherContext() {
      setTimeout(() => { given.push({ namespace: 'added', position: 'afterUser', content: [text('ADDED LATER')] }); pushed(); }, 10);
      return given;
    },
  };
  const slow = new Timed('slow-source', 'SLOW', 'slow');
  slow.waitFor = () => changed;
  const x = await make({ modules: [changes, slow] });
  const gathered = await registryOf(x).gatherContext('prime');
  assert.equal(given.length, 2, 'the premise: the module changed its answer before the gather returned');
  assert.deepEqual(gathered.map((i) => i.namespace), ['given', 'slow']);
});

test("each module's budget starts once its call returns, after its own synchronous work and earlier modules'", async () => {
  const busy: Module = {
    name: 'busy-source', async start() {}, async stop() {}, getTools: () => [],
    async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; },
    async onProcess() { return {}; },
    contextTimeoutMs: 200,
    gatherContext() {
      const until = Date.now() + 400;
      while (Date.now() < until) { /* synchronous work */ }
      return new Promise((resolve) => setTimeout(() => resolve([{ namespace: 'busy', position: 'afterUser', content: [text('BUSY')] } as ModuleContextInjection]), 1));
    },
  };
  const quick = new Timed('quick-source', 'QUICK', 'quick');
  quick.delayMs = 1;
  quick.contextTimeoutMs = 200;
  const x = await make({ modules: [busy, quick] });
  const gathered = await registryOf(x).gatherContext('prime');
  assert.deepEqual(gathered.map((i) => i.namespace), ['busy', 'quick'], "the busy module's 400 ms spent neither its own 200 ms nor the quick one's");
});

test("a sharded copy a failed start stored is found whole by the next plan", async () => {
  const x = await make({ strategy: new AutobiographicalStrategy({ adaptiveResolution: true, targetChunkTokens: 50 }) });
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  await sent(agent);
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  assert.equal(internals(x.framework).storeInjections(agent, [injection(long)]), undefined);
  const rows = agent.getContextManager().getAllMessages().filter((m) => (m.metadata as { contextInjection?: unknown } | undefined)?.contextInjection !== undefined);
  assert.ok(rows.length > 1, `the premise: stored as ${rows.length} shards`);
  assert.equal(internals(x.framework).storeInjections(agent, [injection(long)]), undefined);
  assert.equal(storedInjections(agent).length, rows.length, 'found whole, not stored again');
});

test("in a window with no rows, a failed start's copy is found by the next plan", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  assert.equal(agent.getContextManager().getMessageCount(), 0, 'the premise: an empty window');
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(internals(x.framework).storeInjections(agent, [injection()]), undefined);
  assert.equal(storedInjections(agent).length, 1, 'found, not stored again');
});

test("a read that fails before it finds any copy leaves the last request's record to decide", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('HELD', 'notes')]), undefined);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('X')]), undefined);
  const getMessageWindow = cm.getMessageWindow.bind(cm);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  cm.getMessageWindow = (() => { throw new Error('unreadable'); }) as typeof cm.getMessageWindow;
  try {
    assert.equal(internals(x.framework).storeInjections(agent, [injection('HELD', 'notes')]), undefined);
  } finally {
    cm.getMessageWindow = getMessageWindow;
    console.error = original;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['HELD', 'X'], 'the record says HELD was held whole');
  assert.ok(errors.some((e) => e.includes("that request's record decides")), errors.join('\n'));
});

test("a module skipped between two that finish out of order leaves the others in registration order", async () => {
  const first = new Timed('first-source', 'FIRST', 'first');
  const last = new Timed('last-source', 'LAST', 'last');
  first.waitFor = () => last.whenFinished();
  const skipped: Module = {
    name: 'skipped-source', async start() {}, async stop() {}, getTools: () => [],
    async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; },
    async onProcess() { return {}; },
    async gatherContext() { throw new Error('rejected'); },
  };
  const x = await make({ modules: [first, skipped, last] });
  const original = console.error;
  console.error = () => {};
  let gathered: ModuleContextInjection[];
  try {
    gathered = await registryOf(x).gatherContext('prime');
  } finally {
    console.error = original;
  }
  assert.deepEqual(gathered.map((i) => i.namespace), ['first', 'last']);
});

test("a unit whose later part alone changes is stored again whole", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  agent.getContextManager().addMessage('user', [text('hello')]);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('A'), injection('C')]), undefined);
  await sent(agent);
  assert.equal(internals(x.framework).storeInjections(agent, [injection('A'), injection('C')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'C'], 'the premise: the same unit is skipped');
  assert.equal(internals(x.framework).storeInjections(agent, [injection('A'), injection('C2')]), undefined);
  assert.deepEqual(storedInjections(agent).map(textOf), ['A', 'C', 'A', 'C2'], 'its first part unchanged, the unit is stored whole');
});

test("a write that throws in the middle of a gather leaves the rest unwritten, returned for compile() in the order gathered", async () => {
  const x = await make();
  const agent = x.framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  cm.addMessage('user', [text('hello')]);
  const opted: ModuleContextInjection = { namespace: 'opted', position: 'afterUser', content: [text('OPTED')], placedEachCompile: true };
  const gathered: ContextInjection[] = [injection('A', 'a'), injection('B', 'b'), opted, injection('C', 'c')];
  const original = cm.addMessage.bind(cm);
  let writes = 0;
  const consoleError = console.error;
  console.error = () => {};
  let left: ContextInjection[] | undefined;
  try {
    (cm as unknown as { addMessage: unknown }).addMessage = (...args: Parameters<typeof original>) => {
      if (++writes === 2) throw new Error('refused before landing');
      return original(...args);
    };
    left = internals(x.framework).storeInjections(agent, gathered);
  } finally {
    (cm as unknown as { addMessage: unknown }).addMessage = original;
    console.error = consoleError;
  }
  assert.deepEqual(storedInjections(agent).map(textOf), ['A']);
  assert.deepEqual(left?.map((i) => textOf(i)), ['B', 'OPTED', 'C'], 'the rest, in the order gathered');
});
