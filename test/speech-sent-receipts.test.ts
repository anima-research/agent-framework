import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, SPEECH_RECEIPT_WAIT_MS } from '../src/index.js';
import type { Module, ModuleContext, ProcessEvent, SpeechRoutedContext, SpeechSent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const SENT_TO = 'the console that sent this turn';
const HEDGE = 'This route delivered it nowhere; if another surface showed it (a reply thread, the console), that copy stands. It is saved in your archive.';
const UNDELIVERABLE = '[send-undeliverable]';

type Answer = 'sent' | 'none' | 'throw' | 'hang' | 'late' | 'late-throw' | { sentTo?: unknown };
type Asked = { agent: string; text: string; context: SpeechRoutedContext };

class Surface {
  asked: Asked[] = [];
  answer: Answer = 'sent';
  messagesPerEvent = 1;
  onAsked: () => void = () => {};
  ctx: ModuleContext | null = null;
  constructor(readonly name = 'console') {}
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'look', description: 'Look around', inputSchema: { type: 'object', properties: {} } }];
  }
  toolCall: () => void = () => {};
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.toolCall();
    return { success: true, data: 'nothing here' };
  }
  async onProcess(event: ProcessEvent): Promise<{ addMessages?: unknown[]; requestInference?: boolean }> {
    if (event.type !== 'external-message' || (event as { source?: string }).source !== this.name) return {};
    const text = String((event as { content?: unknown }).content);
    const addMessages = Array.from({ length: this.messagesPerEvent }, (_, i) => ({
      participant: 'user',
      content: [{ type: 'text', text: this.messagesPerEvent === 1 ? text : `${text} (${i + 1})` }],
    }));
    return { addMessages, requestInference: true };
  }
  async onSpeechRouted(agent: string, text: string, context: SpeechRoutedContext): Promise<unknown> {
    this.asked.push({ agent, text, context });
    this.onAsked();
    const answer = this.answer;
    if (answer === 'throw') throw new Error(`${this.name} broke`);
    if (answer === 'hang') return new Promise(() => {});
    if (answer === 'late') return new Promise((resolve) => setTimeout(() => resolve({ sentTo: SENT_TO }), SPEECH_RECEIPT_WAIT_MS + 1_000));
    if (answer === 'late-throw') return new Promise((_, reject) => setTimeout(() => reject(new Error(`${this.name} broke late`)), SPEECH_RECEIPT_WAIT_MS + 1_000));
    if (typeof answer === 'object') return answer;
    return answer === 'sent' ? { sentTo: SENT_TO } : {};
  }
}

function channelServer(delivered: boolean | 'throws' = true) {
  const published: Array<{ channelId?: string; text?: string }> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (params: { channelId?: string; content?: Array<{ text?: string }> }) => {
      published.push({ channelId: params.channelId, text: params.content?.map((b) => b.text ?? '').join('') });
      if (delivered === 'throws') throw new Error('the connector lost the reply');
      return { delivered };
    },
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async () => ({}),
    sendChannelsAcknowledge: async () => ({ acknowledged: true }),
    sendChannelsOutgoingChunk: () => {},
    sendChannelsOutgoingComplete: () => {},
  };
  return { server, published };
}

class WithoutRoundContent extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    const inner = super.streamYielding(request);
    return new Proxy(inner, {
      get(target, prop) {
        if (prop !== Symbol.asyncIterator) {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async function* () {
          for await (const event of target) {
            if (event.type !== 'tool-calls') { yield event; continue; }
            const { roundContent: _roundContent, ...context } = (event as unknown as { context?: Record<string, unknown> }).context ?? {};
            yield { ...event, context } as unknown as StreamEvent;
          }
        };
      },
    });
  }
}

class AttemptBeforeReply extends MockMembrane {
  constructor(readonly live: boolean) {
    super();
  }

  override streamYielding(request: NormalizedRequest): YieldingStream {
    const inner = super.streamYielding(request);
    const live = this.live;
    return new Proxy(inner, {
      get(target, prop) {
        if (prop !== Symbol.asyncIterator) {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async function* () {
          for await (const event of target) {
            if (event.type === 'complete') {
              yield { type: 'tool-attempt', rawXml: '<function_calls><invoke name="nope"></invoke></function_calls>', notices: [], context: {} } as unknown as StreamEvent;
            }
            if (event.type === 'tool-calls' && !live) {
              const { roundContent: _roundContent, ...context } = (event as unknown as { context?: Record<string, unknown> }).context ?? {};
              yield { ...event, context } as unknown as StreamEvent;
              continue;
            }
            yield event;
          }
        };
      },
    });
  }
}

class FailsAfterFirstRound extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    const inner = super.streamYielding(request);
    let resultsGiven = false;
    let wake: (() => void) | undefined;
    return {
      provideToolResults: () => { resultsGiven = true; wake?.(); },
      cancel: () => { wake?.(); },
      get isWaitingForTools() { return !resultsGiven && inner.isWaitingForTools; },
      get pendingToolCallIds() { return resultsGiven ? [] : inner.pendingToolCallIds; },
      get toolDepth() { return inner.toolDepth; },
      get isCancelled() { return false; },
      async *[Symbol.asyncIterator]() {
        for await (const event of inner) {
          yield event;
          if (event.type !== 'tool-calls') continue;
          while (!resultsGiven) await new Promise<void>((resolve) => { wake = resolve; });
          yield { type: 'error', error: new MembraneError({ type: 'server', retryable: false, message: 'the provider failed', rawError: { status: 500 } }) } as unknown as StreamEvent;
          return;
        }
      },
    } as unknown as YieldingStream;
  }
}

class HeldSecond extends MockMembrane {
  primary = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.primary++;
    if (this.primary === 2) {
      const error = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 60_000, message: 'rate limit reached', rawError: { status: 429 }, rawRequest: request });
      return { isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false, provideToolResults() { throw new Error('not waiting'); }, cancel() {}, async *[Symbol.asyncIterator]() { yield { type: 'error', error } as StreamEvent; } } as unknown as YieldingStream;
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `Answer ${this.primary}.` }])]);
  }
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function tickUntil(t: { mock: { timers: { tick(ms: number): void } } }, settled: () => boolean): Promise<void> {
  return (async () => {
    const deadline = Date.now() + 30_000;
    while (!settled()) {
      assert.ok(Date.now() < deadline, 'the run settles under the mocked clock');
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1_000);
    }
  })();
}

const textOf = (blocks: ContentBlock[]): string => blocks.map((b) => (b as { text?: string }).text ?? '').join('');
const lookRound = (said: string, id = 'c1'): NormalizedResponse => createMockResponse([
  { type: 'text', text: said },
  { type: 'tool_use', id, name: 'console--look', input: {} },
] as ContentBlock[], 'tool_use');
const afterLook = (said: string, trailing: string, id = 'c1'): NormalizedResponse => ({
  ...createMockResponse([
    { type: 'text', text: said },
    { type: 'tool_use', id, name: 'console--look', input: {} },
    { type: 'tool_result', toolUseId: id, content: 'nothing here' },
    { type: 'text', text: trailing },
  ] as ContentBlock[]),
  toolCalls: [],
  rawAssistantText: trailing,
} as NormalizedResponse);

describe('plain speech a module says it showed', () => {
  let dir: string | undefined;
  let framework: AgentFramework | undefined;

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function host(modules: Surface[], membrane: MockMembrane, agent: Record<string, unknown> = {}, channels = true) {
    dir = mkdtempSync(join(tmpdir(), 'speech-routed-'));
    framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.', proseRouting: 'locus', ...agent }],
      modules: modules as unknown as Module[],
    });
    if (channels) await (framework as unknown as { initializeMcpl(servers: []): Promise<void> }).initializeMcpl([]);
    return framework;
  }

  const texts = (f: AgentFramework): string[] => f.getAgent('resident')!.getContextManager().getAllMessages().map((m) => textOf(m.content));
  const notices = (f: AgentFramework): string[] => texts(f).filter((t) => t.includes(UNDELIVERABLE));
  const receipt = (f: AgentFramework): string | undefined => texts(f).filter((t) => t.startsWith('[delivered]')).at(-1);
  const push = (f: AgentFramework, text: string, source = 'console') => {
    f.pushEvent({ type: 'external-message', source, content: text, metadata: {} } as unknown as ProcessEvent);
  };
  const turn = async (f: AgentFramework, text = 'hello') => {
    push(f, text);
    await f.runUntilIdle();
  };
  const internals = (f: AgentFramework) => f as unknown as {
    pendingRequests: Array<Record<string, unknown>>;
    channelRegistry: { ensureChannelRegistered(serverId: string, channelId: string, label?: string): void; serverRegistry: unknown };
    providerAccelerationCooldowns: Map<string, Record<string, unknown>>;
    lastAnnouncedLocus: Map<string, unknown>;
    routingOf(agentName: string): unknown;
    addressedElsewhereNotice(agent: unknown, routing: unknown, channel: { serverId: string; channelId: string }, who: string): unknown;
  };
  const askedTexts = (s: Surface) => s.asked.map((a) => ({ text: a.text, final: a.context.final }));
  const openingTexts = (s: Surface, asked: Asked): string[] => (asked.context.openedBy?.messages ?? [])
    .map((id) => { const row = s.ctx!.getMessage(id); return row ? textOf(row.content) : `(no message ${id})`; });

  it("a turn with no channel whose reply the surface showed isn't told it went nowhere, and its receipt says where", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.deepEqual(askedTexts(surface), [{ text: 'Hi there.', final: true }]);
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · no channel posted it`);
  });

  it("a reply no module named a place for is told it went nowhere, named by its words, and that another surface may have shown it", async () => {
    const surface = new Surface();
    surface.answer = 'none';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(surface.asked.length, 1, 'premise: it was asked');
    assert.equal(notices(f).length, 1, notices(f).join('\n'));
    assert.ok(notices(f)[0]!.startsWith('[send-undeliverable] Your plain speech "Hi there." (9 chars) had no channel to go to'), notices(f)[0]);
    assert.ok(notices(f)[0]!.endsWith(HEDGE), notices(f)[0]);
  });

  it("a reply on a host where no module has the hook is told it went nowhere, and that another surface may have shown it", async () => {
    const surface = new Surface();
    (surface as { onSpeechRouted?: unknown }).onSpeechRouted = undefined;
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(notices(f).length, 1, notices(f).join('\n'));
    assert.ok(notices(f)[0]!.startsWith('[send-undeliverable] Your plain speech "Hi there." (9 chars) had no channel to go to'), notices(f)[0]);
    assert.ok(notices(f)[0]!.endsWith(HEDGE), notices(f)[0]);
  });

  const word = 'x'.repeat(38);
  for (const [what, text, named] of [
    ['quotes a quote so it can\'t end the excerpt', 'She said "yes".', '"She said \\"yes\\"." (15 chars)'],
    ['cuts a long piece at a word and marks the cut', 'This reply runs on well past the forty characters a notice quotes of it.', '"This reply runs on well past the forty…" (72 chars)'],
    ['names a piece that opens with an unclosed bracket by its words', '[delivered to nobody in particular as far as I can tell] then more', '"\\u005bdelivered to nobody in particular as…" (66 chars)'],
    ['keeps a word that ends exactly at the cut', `a ${word} and more words after it.`, `"a ${word}…" (65 chars)`],
    ['cuts inside a first word longer than the excerpt', `${'y'.repeat(50)} and more.`, `"${'y'.repeat(40)}…" (60 chars)`],
  ] as const) {
    it(`the notice's excerpt ${what}`, async () => {
      const surface = new Surface();
      surface.answer = 'none';
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text }]));
      const f = await host([surface], membrane);
      await turn(f);
      assert.ok(notices(f)[0]?.startsWith(`[send-undeliverable] Your plain speech ${named} had no channel to go to`), notices(f)[0]);
    });
  }

  const cantTell: SpeechSent = {};
  for (const [form, answer] of [['a blank place', { sentTo: '   ' }], ['no place at all', cantTell]] as const) {
    it(`a module whose answer has ${form} names no place, so the turn is still told its speech had no channel`, async () => {
      const surface = new Surface();
      surface.answer = answer;
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
      const f = await host([surface], membrane);
      await turn(f);
      assert.equal(surface.asked.length, 1, 'premise: it was asked');
      assert.equal(notices(f).length, 1, notices(f).join('\n'));
      assert.ok(notices(f)[0]!.endsWith(HEDGE), notices(f)[0]);
    });
  }

  it("a tool turn asks about each round's prose as it routes and the trailing reply as the final speech, each with its own text", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', 'Nothing here.'));
    const f = await host([surface], membrane);
    await turn(f);
    assert.deepEqual(askedTexts(surface), [
      { text: 'Looking around.', final: false },
      { text: 'Nothing here.', final: true },
    ]);
    assert.deepEqual(surface.asked.map((a) => a.agent), ['resident', 'resident']);
    const turnIds = surface.asked.map((a) => a.context.turnId);
    assert.equal(typeof turnIds[0], 'number');
    assert.equal(turnIds[1], turnIds[0], "one turn's pieces name one turn");
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · no channel posted it`);
  });

  it("where tool rounds aren't routed live, a round's prose routed at the turn's end is asked about as a round's, and only the reply as the final speech", async () => {
    const surface = new Surface();
    const membrane = new WithoutRoundContent();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', 'Nothing here.'));
    const f = await host([surface], membrane);
    await turn(f);
    assert.deepEqual(askedTexts(surface), [
      { text: 'Looking around.', final: false },
      { text: 'Nothing here.', final: true },
    ]);
  });

  it("where tool rounds aren't routed live, speech before a call the output limit cut off unrun is the final reply, since that call was never yielded", async () => {
    const surface = new Surface();
    const membrane = new WithoutRoundContent();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse({
      ...createMockResponse([
        { type: 'text', text: 'Looking around.' },
        { type: 'tool_use', id: 'c1', name: 'console--look', input: {} },
        { type: 'tool_result', toolUseId: 'c1', content: 'nothing here' },
        { type: 'text', text: 'Trying again.' },
        { type: 'tool_use', id: 'c2', name: 'console--look', input: {} },
      ] as ContentBlock[], 'max_tokens'),
      toolCalls: [],
    } as NormalizedResponse);
    const f = await host([surface], membrane);
    let yielded = 0;
    f.onTrace((event) => { if (event.type === 'inference:tool_calls_yielded') yielded += 1; });
    await turn(f);
    assert.equal(yielded, 1, "premise: only the first look's call was yielded");
    assert.deepEqual(askedTexts(surface), [
      { text: 'Looking around.', final: false },
      { text: 'Trying again.', final: true },
    ]);
  });

  it("where tool rounds aren't routed live, a refused round cut off at the output limit leaves the earlier round's prose a round's", async () => {
    const surface = new Surface();
    const membrane = new WithoutRoundContent();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse({
      ...createMockResponse([
        { type: 'text', text: 'Looking around.' },
        { type: 'tool_use', id: 'c1', name: 'console--look', input: {} },
        { type: 'tool_result', toolUseId: 'c1', content: 'nothing here' },
        { type: 'text', text: 'Never mind.' },
        { type: 'tool_use', id: 'c2', name: 'skip_reply', input: {} },
      ] as ContentBlock[], 'max_tokens'),
      toolCalls: [],
    } as NormalizedResponse);
    const f = await host([surface], membrane);
    await turn(f);
    assert.deepEqual(askedTexts(surface), [{ text: 'Looking around.', final: false }]);
  });

  it("a hybrid turn whose tool rounds aren't routed live asks about a round's prose as a round's and the reply as the final speech", async () => {
    const surface = new Surface();
    const membrane = new WithoutRoundContent();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', 'Nothing here.'));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    await turn(f);
    assert.deepEqual(askedTexts(surface), [
      { text: 'Looking around.', final: false },
      { text: 'Nothing here.', final: true },
    ]);
  });

  it("so does one whose send silenced its speech only where the send posted", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new WithoutRoundContent();
    const send = { type: 'tool_use', id: 'p1', name: 'channel_publish', input: { channelId: 'room', content: 'A note.' } } as ContentBlock;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Looking around.' }, send], 'tool_use'));
    membrane.pushResponse({
      ...createMockResponse([
        { type: 'text', text: 'Looking around.' },
        send,
        { type: 'tool_result', toolUseId: 'p1', content: 'posted' },
        { type: 'text', text: 'Nothing here.' },
      ] as ContentBlock[]),
      toolCalls: [],
      rawAssistantText: 'Nothing here.',
    } as NormalizedResponse);
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    const { server, published } = channelServer(true);
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    await turn(f);
    assert.deepEqual(published.map((p) => p.text), ['A note.'], 'premise: the send posted, and the speech did not');
    assert.deepEqual(askedTexts(surface), [
      { text: 'Looking around.', final: false },
      { text: 'Nothing here.', final: true },
    ]);
  });

  for (const live of [true, false]) {
    it(`speech on both sides of a refused XML attempt after the turn's last call is the final reply, since the attempt traces no inference:tool_calls_yielded (a relay starts a new speech only there)${live ? '' : ", where tool rounds aren't routed live"}`, async () => {
      const surface = new Surface();
      const membrane = new AttemptBeforeReply(live);
      membrane.pushResponse(lookRound('Looking around.'));
      membrane.pushResponse({
        ...createMockResponse([
          { type: 'text', text: 'Looking around.' },
          { type: 'tool_use', id: 'c1', name: 'console--look', input: {} },
          { type: 'tool_result', toolUseId: 'c1', content: 'nothing here' },
          { type: 'text', text: 'Trying.' },
          { type: 'tool_attempt', rawXml: '<function_calls><invoke name="nope"></invoke></function_calls>' },
          { type: 'tool_notice', notices: [] },
          { type: 'text', text: 'Nothing here.' },
        ] as unknown as ContentBlock[]),
        toolCalls: [],
        rawAssistantText: 'Trying.\nNothing here.',
      } as NormalizedResponse);
      const f = await host([surface], membrane);
      let yielded = 0;
      f.onTrace((event) => { if (event.type === 'inference:tool_calls_yielded') yielded += 1; });
      await turn(f);
      assert.equal(yielded, 1, "only the look's call is traced");
      assert.deepEqual(askedTexts(surface), [
        { text: 'Looking around.', final: false },
        { text: 'Trying.', final: true },
        { text: 'Nothing here.', final: true },
      ]);
    });
  }

  it("an agent's next turn starts, and compiles, only after its previous turn's routing and receipt are done (the host's speech record and the receipt's never-mid-stream rely on it)", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane);
    const order: string[] = [];
    let starts = 0;
    f.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      starts += 1;
      order.push(`started ${starts} after ${texts(f).filter((t) => t.startsWith('[delivered]')).length} receipts`);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `Reply ${starts}.` }]));
    });
    const taken: string[] = [];
    const process = surface.onProcess.bind(surface);
    surface.onProcess = async (event) => {
      taken.push(String((event as { content?: unknown }).content));
      return process(event);
    };
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const ask = surface.onSpeechRouted.bind(surface);
    surface.onSpeechRouted = async (agent, text, context) => {
      const answer = ask(agent, text, context);
      if (text === 'Reply 1.') {
        await released;
        order.push('answered 1');
      }
      return answer;
    };
    await f.start();
    push(f, 'first');
    await until(() => surface.asked.length === 1, "the first turn's ask");
    push(f, 'second');
    await until(() => taken.includes('second'), 'the second message to be taken in');
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await until(() => texts(f).filter((t) => t.startsWith('[delivered]')).length === 2, 'both receipts');
    assert.deepEqual(order, ['started 1 after 0 receipts', 'answered 1', 'started 2 after 1 receipts']);
    assert.deepEqual(surface.asked.map((a) => a.text), ['Reply 1.', 'Reply 2.']);
    const second = (membrane.calls[1]?.messages ?? []) as Array<{ content: ContentBlock[] | string }>;
    const compiled = second.map((m) => (typeof m.content === 'string' ? m.content : textOf(m.content)));
    const receiptAt = compiled.findIndex((t) => t.startsWith('[delivered]'));
    assert.ok(receiptAt >= 0, compiled.join('\n'));
    assert.ok(receiptAt < compiled.indexOf('second'), compiled.join('\n'));
  });

  it("a turn ended by skip_reply waits for an answer still due and names its place beside the channel", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'sr', name: 'skip_reply', input: { reason: 'done' } } as ContentBlock], 'tool_use'));
    const f = await host([surface], membrane);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const ask = surface.onSpeechRouted.bind(surface);
    surface.onSpeechRouted = async (agent, text, context) => {
      void ask(agent, text, context);
      await released;
      return { sentTo: SENT_TO };
    };
    let ended = false;
    f.onTrace((event) => { if (event.type === 'inference:turn_ended') ended = true; });
    const published = await channelTurn(f, true);
    const run = f.runUntilIdle();
    await until(() => ended, 'the turn to end');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receipt(f), undefined, 'no receipt while the answer is due');
    release();
    await run;
    assert.deepEqual(published.map((p) => p.text), ['Looking around.']);
    assert.deepEqual(askedTexts(surface), [{ text: 'Looking around.', final: false }]);
    assert.equal(receipt(f), `[delivered] plain speech → room · sent to ${SENT_TO}`);
  });

  it("a turn that fails after a round a module showed says that round's speech was handed on", async () => {
    const surface = new Surface();
    const membrane = new FailsAfterFirstRound();
    membrane.pushResponse(lookRound('Looking around.'));
    const f = await host([surface], membrane);
    await turn(f);
    assert.deepEqual(askedTexts(surface), [{ text: 'Looking around.', final: false }], 'premise: the round was asked about');
    const failed = texts(f).filter((t) => t.startsWith('[inference-failed]'));
    assert.equal(failed.length, 1, texts(f).join('\n'));
    assert.ok(failed[0]!.includes('Plain speech its rounds routed live was handed on for delivery as written'), failed[0]);
    assert.deepEqual(notices(f), []);
  });

  it("a ' !' continuation names the messages of the turn that asked for it", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    let starts = 0;
    f.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      starts += 1;
      if (starts <= 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: starts === 1 ? '>>>skip_reply !\nThinking it over.' : 'Here it is.' }]));
    });
    await turn(f, 'the question');
    await f.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'premise: the continuation took a turn');
    const reply = surface.asked.find((a) => a.text === 'Here it is.');
    assert.ok(reply, JSON.stringify(askedTexts(surface)));
    assert.deepEqual(openingTexts(surface, reply), ['the question']);
  });

  it('an explicit >>> send is never asked about', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>room Hello room.' }]));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    const { server, published } = channelServer(true);
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    await turn(f);
    assert.deepEqual(published.map((p) => p.text), ['Hello room.'], 'premise: the send posted');
    assert.deepEqual(surface.asked, []);
  });

  it("a hybrid reply's >>> post whose outcome is unknown counts as a post tried, so the receipt doesn't say no channel posted it", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.\n>>>room Hello room.' }]));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    const { server, published } = channelServer('throws');
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    await turn(f);
    assert.deepEqual(published.map((p) => p.text), ['Hello room.'], 'premise: the post was tried');
    assert.deepEqual(surface.asked.map((a) => a.text), ['Hi there.'], 'premise: the plain piece was asked about');
    assert.ok(receipt(f)?.includes(`sent to ${SENT_TO}`), receipt(f));
    assert.ok(!receipt(f)?.includes('no channel posted it'), receipt(f));
  });

  it("a hybrid reply's >>> post that follows a piece with no channel waits for that piece's answer, then posts", async () => {
    const surface = new Surface();
    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const ask = surface.onSpeechRouted.bind(surface);
    surface.onSpeechRouted = async (agent, text, context) => {
      const answer = ask(agent, text, context);
      await released;
      order.push(`answered ${text}`);
      return answer;
    };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.\n>>>room Hello room.' }]));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    const { server, published } = channelServer(true);
    const publish = server.sendChannelsPublish;
    server.sendChannelsPublish = async (params) => {
      order.push(`posted ${params.content?.map((b) => b.text ?? '').join('')}`);
      return publish(params);
    };
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    await f.start();
    push(f, 'hello');
    await until(() => surface.asked.length === 1, "the plain piece's ask");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(published, [], 'no post while the earlier piece is unanswered');
    release();
    await until(() => published.length === 1, 'the post');
    assert.deepEqual(order, ['answered Hi there.', 'posted Hello room.']);
  });

  it('a host with no channel registry asks no module and writes no notice or receipt', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane, {}, false);
    await turn(f);
    assert.equal(membrane.calls.length, 1, 'premise: the turn ran');
    assert.deepEqual(surface.asked, []);
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), undefined);
  });

  it("a module removed while it's being asked names nothing", async () => {
    const surface = new Surface();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const ask = surface.onSpeechRouted.bind(surface);
    surface.onSpeechRouted = async (agent, text, context) => {
      void ask(agent, text, context);
      await released;
      return { sentTo: SENT_TO };
    };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    surface.onAsked = () => { void f.removeModule('console').then(release); };
    await turn(f);
    assert.equal(surface.asked.length, 1, 'premise: it was asked');
    assert.equal(notices(f).length, 1);
    assert.ok(notices(f)[0]!.includes('if another surface showed it'), 'a module removed while asked may have shown it');
    assert.equal(receipt(f), undefined);
  });

  it("a round no module says it showed keeps its notice when the trailing reply's place clears its own", async () => {
    const surface = new Surface();
    let asks = 0;
    surface.onAsked = () => { surface.answer = ++asks === 1 ? 'none' : 'sent'; };
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', 'Nothing here.'));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(notices(f).length, 1, notices(f).join('\n'));
    assert.match(notices(f)[0]!, /\(15 chars\)/, "the round's notice, not the reply's");
  });

  for (const answer of ['sent', 'none'] as const) {
    it(`a hybrid resident's plain reply ${answer === 'sent' ? 'the surface showed gets no notice, and the receipt says where' : 'no module showed gets the notice'}`, async () => {
      const surface = new Surface();
      surface.answer = answer;
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
      const f = await host([surface], membrane, { proseRouting: 'hybrid' });
      await turn(f);
      assert.equal(notices(f).length, answer === 'sent' ? 0 : 1, notices(f).join('\n'));
      if (answer === 'sent') assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · no channel posted it`);
    });
  }

  it("a hybrid tool round is asked about as it routes, and a private envelope never is", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', '>>>skip_reply kept to myself'));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    await turn(f);
    assert.deepEqual(askedTexts(surface), [{ text: 'Looking around.', final: false }]);
    assert.ok(!surface.asked.some((a) => a.text.includes('kept to myself')), 'the private envelope is never asked about');
    assert.deepEqual(notices(f), []);
  });

  it("a heartbeat's held prose is never asked about and stays a draft", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'A quiet thought.' }]));
    const f = await host([surface], membrane);
    internals(f).pendingRequests.push({ agentName: 'resident', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now() });
    await f.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'premise: the heartbeat took a turn');
    assert.deepEqual(surface.asked, []);
    assert.deepEqual(notices(f), []);
    const drafts = (f as unknown as { proseDrafts: { open(agent: string): Array<{ text: string }> } }).proseDrafts.open('resident');
    assert.deepEqual(drafts.map((d) => d.text), ['A quiet thought.']);
  });

  it('a module that throws counts as having shown nothing, and the line names it', async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.answer = 'throw';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(notices(f).length, 1);
    assert.ok(notices(f)[0]!.includes('if another surface showed it'), 'a module that failed may have shown it');
    assert.ok(errors.some((e) => e.startsWith('Speech-routed module console error:') && e.includes('console broke')), errors.join('\n'));
  });

  it("modules that haven't answered are waited for together until the bound and no longer, and count as having shown nothing", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.answer = 'hang';
    const other = new Surface('other');
    other.answer = 'hang';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface, other], membrane);
    surface.onAsked = () => { t.mock.timers.enable({ apis: ['setTimeout'] }); };
    push(f, 'hello');
    let settled = false;
    const run = f.runUntilIdle().finally(() => { settled = true; });
    try {
      await until(() => surface.asked.length > 0, 'the ask');
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(SPEECH_RECEIPT_WAIT_MS - 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(notices(f), [], 'still waiting just before the bound');
      assert.ok(!errors.some((e) => e.includes("hadn't answered")), 'and not given up');
      t.mock.timers.tick(1);
      for (const name of ['console', 'other']) {
        assert.ok(errors.includes(`Speech-routed module ${name} hadn't answered within 5 s: counted as having sent nothing`), errors.join('\n'));
      }
      await tickUntil(t, () => settled);
    } finally {
      t.mock.timers.reset();
    }
    await run;
    assert.equal(SPEECH_RECEIPT_WAIT_MS, 5_000);
    assert.equal(notices(f).length, 1);
    assert.ok(notices(f)[0]!.includes('if another surface showed it'), "modules that hadn't answered may have shown it");
  });

  for (const late of ['late', 'late-throw'] as const) {
    it(`a module that ${late === 'late' ? 'answers' : 'fails'} after the bound gets a line naming it`, async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const surface = new Surface();
      surface.answer = late;
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
      const f = await host([surface], membrane);
      surface.onAsked = () => { t.mock.timers.enable({ apis: ['setTimeout'] }); };
      push(f, 'hello');
      let settled = false;
      const run = f.runUntilIdle().finally(() => { settled = true; });
      try {
        await until(() => surface.asked.length > 0, 'the ask');
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(SPEECH_RECEIPT_WAIT_MS + 1_000);
        await tickUntil(t, () => settled);
      } finally {
        t.mock.timers.reset();
      }
      await run;
      assert.equal(notices(f).length, 1, 'the late answer counts for nothing');
      assert.equal(receipt(f), undefined, 'and no receipt names its place');
      const line = late === 'late'
        ? 'Speech-routed module console answered after the 5 s wait: its answer counts for nothing'
        : 'Speech-routed module console error after the wait:';
      assert.ok(errors.some((e) => e.startsWith(line)), errors.join('\n'));
    });
  }

  it("modules are asked together: each place once, in module order, a blank answer names none, and a place reads as one line, cut when long", async () => {
    const first = new Surface('first');
    const second = new Surface('second');
    const third = new Surface('third');
    const fourth = new Surface('fourth');
    first.answer = { sentTo: '  the   terminal\nthat sent this turn ' };
    second.answer = { sentTo: 'the terminal that sent this turn' };
    third.answer = { sentTo: '   ' };
    fourth.answer = { sentTo: `a page ${'x'.repeat(300)}` };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([first, second, third, fourth], membrane);
    push(f, 'hello', 'first');
    await f.runUntilIdle();
    const long = `a page ${'x'.repeat(300)}`.slice(0, 200);
    assert.equal(receipt(f), `[delivered] plain speech → sent to the terminal that sent this turn · sent to ${long}… · no channel posted it`);
    assert.deepEqual(notices(f), []);
  });

  async function channelTurn(f: AgentFramework, delivered: boolean | 'throws') {
    const { server, published } = channelServer(delivered);
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    internals(f).pendingRequests.push({ agentName: 'resident', reason: 'channel-message', source: 'mcpl', timestamp: Date.now(), channelId: 'room', channelServerId: 'srv' });
    return published;
  }

  it("a turn with a channel posts there without waiting for a module, and its receipt names the channel and where the module showed the reply", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi room.' }]));
    const f = await host([surface], membrane);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const asked = surface.onSpeechRouted.bind(surface);
    const published = await channelTurn(f, true);
    surface.onSpeechRouted = async (agent, text, context) => {
      void asked(agent, text, context);
      await released;
      return { sentTo: SENT_TO };
    };
    let settled = false;
    const run = f.runUntilIdle().finally(() => { settled = true; });
    try {
      await until(() => published.length > 0 || settled, 'the post', 4_000);
      assert.equal(receipt(f), undefined, 'no receipt while the answer is due');
    } finally {
      release();
    }
    await run;
    assert.deepEqual(published.map((p) => p.channelId), ['room']);
    assert.ok(!errors.some((e) => e.includes("hadn't answered")), errors.join('\n'));
    assert.equal(surface.asked.length, 1, 'it was asked');
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → room · sent to ${SENT_TO}`);
  });

  it("a turn whose channel post has an unknown outcome names the place in its receipt without saying no channel posted it", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi room.' }]));
    const f = await host([surface], membrane);
    const published = await channelTurn(f, 'throws');
    await f.runUntilIdle();
    assert.equal(published.length, 1, 'premise: the post was tried');
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO}`);
  });

  it("a tool turn with a channel names, in its receipt and in routing order, where a module showed its rounds and its reply", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', 'Nothing here.'));
    const f = await host([surface], membrane);
    let releaseRound!: () => void;
    const roundReleased = new Promise<void>((resolve) => { releaseRound = resolve; });
    const ask = surface.onSpeechRouted.bind(surface);
    surface.onSpeechRouted = async (agent, text, context) => {
      void ask(agent, text, context);
      if (text === 'Looking around.') {
        await roundReleased;
        return { sentTo: 'the round\'s place' };
      }
      releaseRound();
      return { sentTo: 'the reply\'s place' };
    };
    const published = await channelTurn(f, true);
    await f.runUntilIdle();
    assert.deepEqual(published.map((p) => p.text), ['Looking around.', 'Nothing here.']);
    assert.deepEqual(askedTexts(surface), [
      { text: 'Looking around.', final: false },
      { text: 'Nothing here.', final: true },
    ]);
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), "[delivered] plain speech → room · sent to the round's place · sent to the reply's place");
  });

  it("a turn whose channel post fails keeps the channel's notice, and its receipt names where a module showed the reply", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi room.' }]));
    const f = await host([surface], membrane);
    await channelTurn(f, false);
    await f.runUntilIdle();
    const failed = texts(f).filter((t) => t.startsWith('[discord-send-failed]'));
    assert.equal(failed.length, 1, texts(f).join('\n'));
    assert.match(failed[0]!, /could not be delivered to/);
    assert.deepEqual(notices(f), []);
    assert.match(receipt(f) ?? '(no receipt)', new RegExp(`sent to ${SENT_TO}`));
  });

  it('the turn-start notice for a turn with no channel says no channel posts its speech, in its own words', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    internals(f).lastAnnouncedLocus.set('resident', { serverId: 'srv', channelId: 'room' });
    await turn(f);
    assert.deepEqual(texts(f).filter((t) => t.startsWith('[routing]')), [
      '[routing] Your plain speech currently has no channel, so no channel posts it. Use an explicit send tool to reach a channel.',
    ]);
  });

  it('the addressed-elsewhere notice on a turn with no channel says its speech has no channel', async () => {
    const membrane = new MockMembrane();
    const f = await host([new Surface()], membrane);
    const i = internals(f);
    i.addressedElsewhereNotice(f.getAgent('resident'), i.routingOf('resident'), { serverId: 'srv', channelId: 'dm:antra' }, 'antra');
    const told = texts(f).filter((t) => t.includes('addressed you from'));
    assert.equal(told.length, 1, told.join('\n'));
    assert.match(told[0]!, /Your plain speech has no channel this turn; reaching them takes an explicit send\.$/);
    assert.ok(!told[0]!.includes('archive'));
  });

  it('a module is told which messages opened the turn, and the opening request', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    const before = Date.now();
    await turn(f, 'the opening message');
    const opened = surface.asked.at(-1)!.context.openedBy!;
    assert.equal(opened.reason, 'external-message');
    assert.equal(opened.source, 'console');
    assert.ok(opened.timestamp >= before && opened.timestamp <= Date.now(), String(opened.timestamp));
    assert.deepEqual(openingTexts(surface, surface.asked.at(-1)!), ['the opening message']);
  });

  it('a waking answer that adds two messages names both', async () => {
    const surface = new Surface();
    surface.messagesPerEvent = 2;
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f, 'twice');
    assert.deepEqual(openingTexts(surface, surface.asked.at(-1)!), ['twice (1)', 'twice (2)']);
  });

  it('a turn several wakes were batched into names every one of their messages', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', 'Seen it.'));
    const f = await host([surface], membrane);
    let starts = 0;
    f.onTrace((event) => {
      if (event.type === 'inference:started' && ++starts === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both read.' }]));
    });
    surface.toolCall = () => { push(f, 'first message'); push(f, 'second message'); };
    await turn(f, 'the opening message');
    await f.runUntilIdle();
    assert.equal(starts, 2, 'one turn after the first took both');
    assert.deepEqual(openingTexts(surface, surface.asked.at(-1)!), ['first message', 'second message']);
  });

  it('a budget restart still names the messages and the request that opened the turn, on its rounds and its final speech', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const overBudget = lookRound('Before the restart.');
    overBudget.usage = { inputTokens: 100, outputTokens: 5 };
    membrane.pushResponse(overBudget);
    const f = await host([surface], membrane, { maxStreamTokens: 20 });
    const ask = surface.onSpeechRouted.bind(surface);
    surface.onSpeechRouted = async (agent, text, context) => {
      await ask(agent, text, context);
      return text === 'Before the restart.' ? { sentTo: 'the place before' } : undefined;
    };
    f.onTrace((event) => {
      if (event.type === 'inference:stream_restarted') {
        membrane.pushResponse(lookRound('After the restart.', 'c2'));
        membrane.pushResponse(afterLook('After the restart.', 'Done.', 'c2'));
      }
    });
    await turn(f, 'the opening message');
    assert.ok(membrane.calls.length >= 2, 'the turn restarted for its budget');
    const afterRestart = surface.asked.filter((a) => a.text === 'After the restart.' || a.text === 'Done.');
    assert.deepEqual(afterRestart.map((a) => a.context.final), [false, true]);
    for (const asked of afterRestart) {
      assert.equal(asked.context.openedBy?.reason, 'external-message');
      assert.equal(asked.context.openedBy?.source, 'console');
      assert.deepEqual(openingTexts(surface, asked), ['the opening message']);
    }
    assert.ok(receipt(f)?.includes('sent to the place before'), `the receipt keeps the place named before the restart: ${receipt(f)}`);
  });

  it("a held turn's retry that a wake is merged into names that wake's messages too", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new HeldSecond();
    const f = await host([surface], membrane);
    push(f, 'first');
    await f.runUntilIdle();
    push(f, 'second');
    const i = internals(f);
    const deadline = Date.now() + 5_000;
    while (!i.providerAccelerationCooldowns.has('resident')) {
      assert.ok(Date.now() < deadline, `premise: the second turn is held (calls: ${membrane.primary})`);
      void f.runUntilIdle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    i.pendingRequests.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: Date.now(), openingMessages: ['m-merged'] });
    (f as unknown as { releaseProviderWait(agent: string): void }).releaseProviderWait('resident');
    await f.runUntilIdle();
    assert.equal(membrane.primary, 3, 'premise: one retry, which took the wake');
    const last = surface.asked.at(-1)!;
    assert.deepEqual(openingTexts(surface, last).slice(0, 1), ['second']);
    assert.ok(last.context.openedBy?.messages.includes('m-merged'), JSON.stringify(last.context.openedBy));
  });

  it('a console message read in a running turn still wakes a turn of its own', async () => {
    const surface = new Surface();
    surface.answer = 'none';
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', 'Seen it.'));
    const f = await host([surface], membrane);
    let starts = 0;
    f.onTrace((event) => {
      if (event.type === 'inference:started' && ++starts === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Again.' }]));
    });
    surface.toolCall = () => { push(f, 'arrived mid-turn'); };
    await turn(f, 'the opening message');
    await f.runUntilIdle();
    assert.equal(starts, 2, 'the mid-turn message woke a turn after the first, as surface input always has');
  });

  it('two wakes coalesced while the host is quiesced name both their messages at resume', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane);
    await f.quiesce({ reason: 'test window' });
    const t0 = Date.now();
    const pending = internals(f).pendingRequests;
    pending.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: t0, openingMessages: ['m-first'] });
    pending.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: t0 + 10, openingMessages: ['m-second'] });
    await (f as unknown as { processInferenceRequests(): Promise<void> }).processInferenceRequests();
    assert.equal(membrane.calls.length, 0, 'premise: parked while quiesced');
    assert.equal(internals(f).pendingRequests.length, 1, 'premise: coalesced into one');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi both.' }]));
    await f.resume();
    await f.runUntilIdle();
    assert.deepEqual([...(surface.asked.at(-1)?.context.openedBy?.messages ?? [])].sort(), ['m-first', 'm-second']);
  });

  it('two equal wakes a provider hold keeps as one name both their messages at its release', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane);
    const now = Date.now();
    const timer = setTimeout(() => {}, 60_000);
    const cooldowns = internals(f).providerAccelerationCooldowns;
    cooldowns.set('resident', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'test hold', failures: 1 });
    const pending = internals(f).pendingRequests;
    pending.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: now, openingMessages: ['m-first'] });
    pending.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: now, openingMessages: ['m-second'] });
    await f.runUntilIdle();
    const held = cooldowns.get('resident')!.heldRequests as Array<{ openingMessages?: string[] }>;
    assert.equal(held.length, 1, 'premise: the hold keeps one');
    clearTimeout(timer);
    cooldowns.get('resident')!.until = Date.now();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    (f as unknown as { releaseProviderAccelerationCooldown(agent: string): void }).releaseProviderAccelerationCooldown('resident');
    await f.runUntilIdle();
    assert.equal(surface.asked.length, 1, 'premise: the released turn ran');
    assert.deepEqual(surface.asked[0]!.context.openedBy?.messages, ['m-first', 'm-second']);
  });

  it("a bounce's wake carries the messages that started the turn", async () => {
    const surface = new Surface();
    const f = await host([surface], new MockMembrane());
    const agent = f.getAgent('resident')!;
    const i = f as unknown as {
      pendingRequests: Array<{ reason?: string; openingMessages?: string[] }>;
      routingOf(name: string): { openingMessages?: string[] };
      bounceProse(agent: unknown, text: string, reason: string, candidates: undefined, prefix: '>>', round: { routing: unknown; notice: 'later' }): void;
    };
    const routing = i.routingOf('resident');
    routing.openingMessages = ['m-opening'];
    i.bounceProse(agent, 'Unrouted prose', 'no destination', undefined, '>>', { routing, notice: 'later' });
    const woke = i.pendingRequests.filter((r) => r.reason === 'prose-bounce');
    assert.deepEqual(woke.map((r) => r.openingMessages), [['m-opening']]);
  });

  it('a run autoContinue carries on names the messages that started it', async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane, { autoContinue: true });
    let starts = 0;
    f.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      starts += 1;
      membrane.pushResponse(starts === 1
        ? createMockResponse([{ type: 'text', text: 'First thought.' }])
        : starts === 2
          ? createMockResponse([{ type: 'text', text: 'Second thought.' }])
          : createMockResponse([{ type: 'tool_use', id: 'sr', name: 'skip_reply', input: {} } as ContentBlock], 'tool_use'));
    });
    await turn(f, 'the opening message');
    await f.runUntilIdle();
    const second = surface.asked.find((a) => a.text === 'Second thought.');
    assert.ok(second, JSON.stringify(askedTexts(surface)));
    assert.deepEqual(openingTexts(surface, second!), ['the opening message']);
  });
});
