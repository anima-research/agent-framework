import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { ErrorPolicy, EventResponse, Module, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);

class Surface implements Module {
  readonly name = 'surface';
  constructor(private readonly order: string[]) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> { this.order.push('modules stopped'); }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'user', content: [text(String(event.content))] }], requestInference: true };
  }
}

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const PROVIDER_WORDS = 'zz-provider-words-91c4';
const failure = (type: string, httpStatus?: number) => () => new MembraneError({
  type, retryable: true, message: `${PROVIDER_WORDS}: overloaded_error`, rawError: undefined,
  ...(httpStatus !== undefined ? { httpStatus } : {}),
} as never);

const noRetries: ErrorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false }) };

const within = <T>(work: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${what}: not settled within 5 s`)), 5000); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

const until = async (done: () => boolean, what: string): Promise<void> => {
  for (const start = Date.now(); !done(); await new Promise((r) => setTimeout(r, 10))) {
    if (Date.now() - start > 5000) throw new Error(`${what}: not within 5 s`);
  }
};

class LineTransport extends McplTransport {
  readonly kind = 'stdio' as const;
  constructor(private readonly onLine: (line: string) => void) { super(); }
  writeLine(line: string): void { this.onLine(line); }
  async close(): Promise<void> {}
}

type Step = NormalizedResponse[] | (() => Error);
type Answer = Record<string, unknown>;

async function unstickRig(script: Step[], agents: string[] = ['scout']) {
  const dir = mkdtempSync(join(tmpdir(), 'unstick-outcome-'));
  const membrane = new MockMembrane();
  const order: string[] = [];
  const requests: NormalizedRequest[] = [];
  const streamYielding = membrane.streamYielding.bind(membrane);
  let replies = 0;
  membrane.streamYielding = (request, options) => {
    requests.push(structuredClone(request));
    const step = script.shift() ?? [];
    if (typeof step === 'function') return new ErrorStream(step());
    for (const response of step.length > 0 ? step : [createMockResponse([text(`reply ${++replies}`)])]) membrane.pushResponse(response);
    return streamYielding(request, options) as MockYieldingStream;
  };
  const framework: AgentFramework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: agents.map((name) => ({ name, model: 'test-model', systemPrompt: name })),
    modules: [new Surface(order)], errorPolicy: noRetries, exhaustedTurnRearmMs: false,
  } as never);
  const posted: string[] = [];
  (framework as unknown as { postToChannel: (s: string, c: string, content: string) => Promise<void> })
    .postToChannel = async (_serverId, _channelId, content) => { posted.push(content); };
  const host = (params: Record<string, unknown>) => (framework as unknown as {
    handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Answer>;
  }).handleHostCommand('zz-srv', params);
  const drive = async (until: number) => {
    for (let i = 0; i < 200 && requests.length < until; i++) { await framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 10)); }
    await framework.runUntilIdle();
  };
  const say = async (content: string, until: number) => {
    framework.pushEvent({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true } as never);
    await drive(until);
  };
  const answers = new Map<number, Answer>();
  const transport = new LineTransport((line) => {
    const message = JSON.parse(line) as { id?: unknown; result?: Answer; error?: Answer };
    if (typeof message.id !== 'number') return;
    answers.set(message.id, message.result ?? message.error ?? {});
    order.push(`answered ${message.id}`);
  });
  const connection = new (McplServerConnection as unknown as new (id: string, config: null, transport: McplTransport) => McplServerConnection)('zz-srv', null, transport);
  connection.allowHostCommands = true;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  (framework as unknown as { wireMcplEvents(c: unknown, config: { id: string }): void }).wireMcplEvents(connection, { id: 'zz-srv' });
  connection.ready();
  const send = (id: number, params: Record<string, unknown>) =>
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id, method: 'host/command', params }));
  const texts = (request: NormalizedRequest) => request.messages.map((m) => JSON.stringify(m.content));
  const storedContent = (name = 'scout') => framework.getAgent(name)!.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
  const live = (name = 'scout') => (framework as unknown as { forcedRewind: Map<string, unknown> }).forcedRewind.has(name);
  const waiting = (name = 'scout') => (framework as unknown as { unstickWaiters: Map<string, Set<unknown>> }).unstickWaiters.get(name)?.size ?? 0;
  const ask = (agentName = 'scout') => within(host({ command: 'unstick-outcome', agentName }), `unstick-outcome for ${agentName}`);
  let stopped = false;
  return {
    framework, requests, posted, order, answers, host, ask, drive, say, send, texts, storedContent, live, waiting,
    stop: async () => { stopped = true; await framework.stop(); },
    close: async () => { if (!stopped) await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const CATEGORY = 'zz-category-7f3a';
const refusedAs = (category: string) => ({
  ...createMockResponse([], 'refusal'),
  raw: { request: {}, response: { stop_details: { category, explanation: `${PROVIDER_WORDS} explanation` } } },
}) as unknown as NormalizedResponse;
const tick = () => new Promise((r) => setTimeout(r, 50));

test("the unstick acknowledgement says the host answers for its outcome, and names the agent it took", async () => {
  const rig = await unstickRig([]);
  try {
    await rig.say('first question', 1);
    const ack = await rig.host({ command: 'unstick', channelId: 'zz-chan' });
    assert.deepEqual(ack, { ok: true, started: true, cap: 3, outcome: true, agentName: 'scout' }, 'no agentName was sent, so the first agent was taken, and named');
  } finally { await rig.close(); }
});

test("after a give-up at a refusal, a waiting unstick-outcome answers gave-up with the category, the report holds none, and nothing an agent reads holds it", async () => {
  const rig = await unstickRig([[], [refusedAs(CATEGORY)], [refusedAs(CATEGORY)], [refusedAs(CATEGORY)]]);
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    await rig.host({ command: 'unstick', agentName: 'scout', maxRewinds: 1, channelId: 'zz-chan' });
    const waiting = rig.host({ command: 'unstick-outcome', agentName: 'scout' });
    await rig.drive(4);
    const expected = { ok: true, outcome: 'gave-up', rewinds: 1, cause: { kind: 'refusal', category: CATEGORY } };
    assert.deepEqual(await within(waiting, 'the waiting request'), expected);
    assert.equal(rig.live(), false, 'the session ended');
    assert.equal(rig.posted.length, 1, 'the report was posted once');
    assert.ok(rig.posted[0]!.startsWith("⚠️ Couldn't unstick **scout**"), rig.posted[0]);
    assert.ok(!rig.posted[0]!.includes(CATEGORY), 'the public report holds no category');
    assert.ok(!JSON.stringify(await waiting).includes(PROVIDER_WORDS), "the answer holds nothing of the provider's explanation");
    assert.deepEqual(await rig.ask(), expected, 'a request after the end gets the same answer');
    await rig.say('a new question', 5);
    assert.equal(rig.requests.length, 5, 'the premise: the next turn ran');
    assert.ok(!rig.texts(rig.requests[4]!).some((t) => t.includes(CATEGORY)), 'the next request holds no category');
    assert.ok(!rig.storedContent().some((t) => t.includes(CATEGORY)), "no stored row's content holds it");
  } finally { await rig.close(); }
});

test("an unstick-outcome that arrives after a session cleared is answered at once, as cleared, with no cause", async () => {
  const rig = await unstickRig([[], [refusedAs(CATEGORY)], [refusedAs(CATEGORY)]]);
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    await rig.host({ command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    await rig.drive(4);
    assert.equal(rig.live(), false, 'the premise: the retry completed and the session ended');
    assert.ok(rig.posted[0]?.startsWith('🔧 Unstuck **scout**'), rig.posted.join('\n'));
    assert.deepEqual(await rig.ask(), { ok: true, outcome: 'cleared', rewinds: 1 });
  } finally { await rig.close(); }
});

const failed = (rewinds: number) => ({ ok: true, outcome: 'turn-failed', rewinds, cause: { kind: 'failure', type: 'server', status: 529 } });
const cleared = (rewinds: number) => ({ ok: true, outcome: 'cleared', rewinds });

test("a turn that runs out of retries inside a session answers a waiting request turn-failed with its type, its status and the turns set aside, ends nothing and posts nothing; the next request waits for the session's end", async () => {
  const rig = await unstickRig([[], [refusedAs(CATEGORY)], [refusedAs(CATEGORY)], failure('server', 529)]);
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    await rig.host({ command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    const waiting = rig.host({ command: 'unstick-outcome', agentName: 'scout' });
    await rig.drive(4);
    assert.deepEqual(await within(waiting, 'the waiting request'), failed(1), 'the session set one turn aside before the turn failed');
    assert.ok(!JSON.stringify(await waiting).includes(PROVIDER_WORDS), "the answer holds nothing of the provider's message");
    assert.equal(rig.live(), true, 'the session is still live');
    assert.equal(rig.posted.length, 0, 'nothing is posted in the channel');
    let again: Answer | undefined;
    void rig.host({ command: 'unstick-outcome', agentName: 'scout' }).then((answer) => { again = answer; });
    await tick();
    assert.equal(rig.waiting(), 1, 'the premise: the request has entered its wait');
    assert.equal(again, undefined, 'a request that asks again waits, rather than getting the same turn-failed twice');
    await rig.say('another question', 5);
    assert.equal(rig.live(), false, 'the premise: a turn that completes ends the session');
    assert.ok(rig.posted[0]?.startsWith('🔧 Unstuck **scout**'), rig.posted.join('\n'));
    await until(() => again !== undefined, 'the request that asked again');
    assert.deepEqual(again, cleared(1), "the session's end answers it");
    for (const n of [1, 2]) {
      assert.deepEqual(await rig.ask(), cleared(1), `the end is kept: request ${n} after it`);
    }
  } finally { await rig.close(); }
});

test('a turn-failed that comes before any request is kept, the first request takes it, and the next waits for the next answer', async () => {
  const rig = await unstickRig([[], failure('server', 529)]);
  try {
    await rig.say('first question', 1);
    await rig.host({ command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    await rig.drive(2);
    assert.equal(rig.live(), true, 'the premise: the turn failed and the session lives on');
    assert.deepEqual(await rig.ask(), failed(0), 'the first request takes it at once');
    let next: Answer | undefined;
    void rig.host({ command: 'unstick-outcome', agentName: 'scout' }).then((answer) => { next = answer; });
    await tick();
    assert.equal(rig.waiting(), 1, 'the premise: the request has entered its wait');
    assert.equal(next, undefined, 'the second request waits');
    await rig.say('another question', 3);
    await until(() => next !== undefined, 'the second request');
    assert.deepEqual(next, cleared(0), "and gets the session's end");
  } finally { await rig.close(); }
});

test("a failed turn's type safety goes to the person, and no request the agent sends holds it", async () => {
  const rig = await unstickRig([[], failure('safety')]);
  try {
    await rig.say('first question', 1);
    await rig.host({ command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    const waiting = rig.host({ command: 'unstick-outcome', agentName: 'scout' });
    await rig.drive(2);
    assert.deepEqual(await within(waiting, 'the waiting request'), { ok: true, outcome: 'turn-failed', rewinds: 0, cause: { kind: 'failure', type: 'safety' } });
    await rig.say('another question', 3);
    assert.equal(rig.requests.length, 3, 'the premise: the next turn ran');
    assert.ok(!rig.texts(rig.requests[2]!).some((t) => /safety/i.test(t)), 'the next request holds no type safety');
  } finally { await rig.close(); }
});

test("an agent that ends while a request waits answers agent-ended, and so does a request after its end", async () => {
  const rig = await unstickRig([], ['scout', 'aide']);
  try {
    await rig.framework.quiesce({ reason: 'zz: park the unstick' });
    const ack = await rig.host({ command: 'unstick', agentName: 'aide', channelId: 'zz-chan' });
    assert.equal(ack.quiesced, true, 'the premise: the unstick is parked, so its session is live and runs nothing');
    const waiting = rig.host({ command: 'unstick-outcome', agentName: 'aide' });
    rig.framework.stopAgent('aide');
    const ended = { ok: true, outcome: 'agent-ended', rewinds: 0 };
    assert.deepEqual(await within(waiting, 'the waiting request'), ended);
    assert.deepEqual(await rig.ask('aide'), ended);
  } finally { await rig.close(); }
});

test("while an unstick-outcome waits, a nudge and an undo from the same server are answered, and a stop answers it host-stopped without waiting for it", async () => {
  const rig = await unstickRig([]);
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    await rig.framework.quiesce({ reason: 'zz: park the unstick' });
    rig.send(1, { command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    await until(() => rig.answers.has(1), 'the unstick acknowledgement');
    assert.equal(rig.answers.get(1)?.quiesced, true, 'the premise: the unstick is parked, so its session is live and runs nothing');
    rig.send(2, { command: 'unstick-outcome', agentName: 'scout' });
    rig.send(3, { command: 'nudge', agentName: 'scout' });
    rig.send(4, { command: 'undo', agentName: 'scout', turns: 1 });
    await until(() => rig.answers.has(3) && rig.answers.has(4), 'the nudge and the undo, sent after it on the same connection');
    assert.equal(rig.waiting(), 1, 'the premise: the unstick-outcome has entered its wait');
    assert.equal(rig.answers.has(2), false, 'the unstick-outcome still waits');
    await within(rig.stop(), 'the stop');
    assert.deepEqual(rig.answers.get(2), { ok: true, outcome: 'host-stopped', rewinds: 0 });
    assert.ok(rig.order.indexOf('answered 2') < rig.order.indexOf('modules stopped'), rig.order.join(', '));
  } finally { await rig.close(); }
});

test("a new unstick drops the agent's last answer, so its request waits for the new session", async () => {
  const rig = await unstickRig([[], [refusedAs(CATEGORY)], [refusedAs(CATEGORY)]]);
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    await rig.host({ command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    await rig.drive(4);
    assert.equal((await rig.ask()).outcome, 'cleared', 'the premise: an answer is kept');
    await rig.framework.quiesce({ reason: 'zz: park the unstick' });
    rig.send(1, { command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    await until(() => rig.answers.has(1), 'the unstick acknowledgement');
    rig.send(2, { command: 'unstick-outcome', agentName: 'scout' });
    await tick();
    assert.equal(rig.waiting(), 1, 'the premise: the request has entered its wait');
    assert.equal(rig.answers.has(2), false, "the new session's request waits, rather than getting the last session's answer");
    await within(rig.stop(), 'the stop');
    assert.deepEqual(rig.answers.get(2), { ok: true, outcome: 'host-stopped', rewinds: 0 });
  } finally { await rig.close(); }
});

test("a new unstick answers the requests that still wait ok false, before its session starts, so the new session's failed turn is kept for its own first request", async () => {
  const rig = await unstickRig([[], failure('server', 529), failure('server', 529)]);
  try {
    await rig.say('first question', 1);
    await rig.host({ command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    await rig.drive(2);
    assert.deepEqual(await rig.ask(), failed(0), "the premise: the first session's turn failed, and the session lives on");
    rig.send(1, { command: 'unstick-outcome', agentName: 'scout' });
    await tick();
    assert.equal(rig.waiting(), 1, 'the premise: a request waits, as one its surface gave up on still does');
    rig.send(2, { command: 'unstick', agentName: 'scout', channelId: 'zz-chan' });
    await until(() => rig.answers.has(1) && rig.answers.has(2), 'the waiting request and the new acknowledgement');
    assert.deepEqual(rig.answers.get(1),
      { ok: false, error: 'unstick-outcome: a new /unstick of scout replaced the one this request waited on' },
      "the waiting request is answered ok false, and not with the new session's answer");
    assert.equal(rig.waiting(), 0, 'no request from the session it replaced still waits');
    await rig.drive(3);
    assert.deepEqual(await rig.ask(), failed(0), "the new session's failed turn is kept for its first request");
  } finally { await rig.close(); }
});

test("an unstick-outcome with no session and no answer, or with no agentName, answers ok false", async () => {
  const rig = await unstickRig([]);
  try {
    assert.deepEqual(await rig.ask(),
      { ok: false, error: 'unstick-outcome: scout has no /unstick to answer for' });
    assert.deepEqual(await rig.host({ command: 'unstick-outcome' }),
      { ok: false, error: 'unstick-outcome: agentName must name the agent, as the unstick acknowledgement does' });
  } finally { await rig.close(); }
});
