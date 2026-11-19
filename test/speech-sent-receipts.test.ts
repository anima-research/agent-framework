import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ProcessEvent, SpeechContext, SpeechRoutedContext, SpeechSent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { NOTICE_TAG } from '../src/notice-tags.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const SENT_TO = 'the console that sent this turn';
const HEDGE = 'This route delivered it nowhere; if another surface showed it (a reply thread, the console), that copy stands. It is saved in your archive.';
const UNDELIVERABLE = '[send-undeliverable]';

type Answer = 'sent' | 'per-text' | 'none' | { sentTo?: unknown };
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
  onSpeechRouted(agent: string, text: string, context: SpeechRoutedContext): unknown {
    this.asked.push({ agent, text, context });
    this.onAsked();
    const answer = this.answer;
    if (typeof answer === 'object') return answer;
    if (answer === 'per-text') return { sentTo: `${SENT_TO}, for ${text}` };
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

class HeldSecondThenRests extends HeldSecond {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    if (this.primary < 3) return super.streamYielding(request);
    this.calls.push(request);
    this.primary++;
    return new MockYieldingStream([createMockResponse([{ type: 'tool_use', id: `sr-${this.primary}`, name: 'skip_reply', input: {} } as ContentBlock], 'tool_use')]);
  }
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
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
  let gates: Array<() => void> = [];

  afterEach(async () => {
    for (const release of gates) release();
    gates = [];
    await framework?.stop();
    framework = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function gate(): [Promise<void>, () => void] {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    gates.push(release);
    return [released, release];
  }

  async function host(modules: Surface[], membrane: MockMembrane, agent: Record<string, unknown> = {}, channels = true, config: Record<string, unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), 'speech-routed-'));
    framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.', proseRouting: 'locus', ...agent }],
      modules: modules as unknown as Module[],
      ...config,
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
    const traces: Array<{ type: string }> = [];
    f.onTrace((event) => { traces.push(event as { type: string }); });
    await turn(f);
    assert.deepEqual(traces.filter((e) => e.type === 'mcpl:speech-route-failed'), [], 'a shown piece emits no route-failure trace');
    assert.deepEqual(askedTexts(surface), [{ text: 'Hi there.', final: true }]);
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · this turn's routing posted it to no channel`);
  });

  for (const [lock, what] of [
    ['#room', 'a locked turn with a lock'],
    ['drafts', 'a turn locked to drafts'],
    [undefined, 'a locked turn whose lock is unset'],
    ['#nowhere', "a locked turn whose lock doesn't resolve"],
  ] as const) {
    it(`${what} asks the modules where its speech went, and its receipt names what they said`, async () => {
      const surface = new Surface();
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
      const f = await host([surface], membrane, { proseRouting: 'locked', ...(lock ? { proseLock: lock } : {}) });
      const { server, published } = channelServer(true);
      const registry = internals(f).channelRegistry;
      registry.serverRegistry = { getServer: () => server };
      registry.ensureChannelRegistered('srv', 'room', 'room');
      await turn(f);
      assert.deepEqual(askedTexts(surface), [{ text: 'Hi there.', final: true }]);
      assert.ok(receipt(f)?.includes(`sent to ${SENT_TO}`), receipt(f));
      if (lock === '#room') {
        assert.deepEqual(published.map((p) => p.text), ['Hi there.'], 'premise: the speech went to the lock');
      } else {
        assert.deepEqual(published, [], 'premise: nothing posted');
        assert.match(receipt(f) ?? '', /held as draft d-/, 'its drafts note stands beside the place');
      }
    });
  }

  it("a reply no module named a place for is told it went nowhere, named by its words, and that another surface may have shown it", async () => {
    const surface = new Surface();
    surface.answer = 'none';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    const traces: Array<{ type: string }> = [];
    f.onTrace((event) => { traces.push(event as { type: string }); });
    await turn(f);
    assert.equal(surface.asked.length, 1, 'premise: it was asked');
    assert.equal(traces.filter((e) => e.type === 'mcpl:speech-route-failed').length, 1, 'an unshown piece emits its route-failure trace');
    assert.equal(notices(f).length, 1, notices(f).join('\n'));
    assert.ok(notices(f)[0]!.startsWith('[send-undeliverable] Your plain speech "Hi there." (9 chars) had no channel to go to'), notices(f)[0]);
    assert.ok(notices(f)[0]!.endsWith(HEDGE), notices(f)[0]);
  });

  it("a no-channel notice whose words its host didn't pass names the speech by its length alone", async () => {
    const f = await host([], new MockMembrane());
    const registry = internals(f).channelRegistry as unknown as { onRouteFailure(info: Record<string, unknown>): void };
    registry.onRouteFailure({ conversationId: 'resident', channelId: null, reason: 'no channel was chosen for it', textLen: 50, outcome: 'failed' });
    assert.equal(notices(f).length, 1, notices(f).join('\n'));
    assert.ok(notices(f)[0]!.startsWith('[send-undeliverable] Your plain speech (50 chars) had no channel to go to'), notices(f)[0]);
  });

  it("a no-channel notice for speech that's only whitespace names it by its length alone", async () => {
    const f = await host([], new MockMembrane());
    const registry = internals(f).channelRegistry as unknown as { onRouteFailure(info: Record<string, unknown>): void };
    registry.onRouteFailure({ conversationId: 'resident', channelId: null, reason: 'no channel was chosen for it', textLen: 3, text: '   ', outcome: 'failed' });
    assert.equal(notices(f).length, 1, notices(f).join('\n'));
    assert.ok(notices(f)[0]!.startsWith('[send-undeliverable] Your plain speech (3 chars) had no channel to go to'), notices(f)[0]);
  });

  it("the line for a reply a module showed names where, and never says 'no locus', which connectome-doctor reads as not delivered", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    const lines = errors.filter((e) => e.startsWith('[routeSpeech]'));
    assert.deepEqual(lines, ['[routeSpeech] resident: turn has no channel; 9 chars shown by "the\\u0020console\\u0020that\\u0020sent\\u0020this\\u0020turn", routing posted it to no channel']);
  });

  it("a piece held as a draft that a module showed is logged with its place as it's named, as a piece with no channel is", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane, { proseRouting: 'locked', proseLock: 'drafts' });
    await turn(f);
    assert.match(receipt(f) ?? '', /held as draft d-/, 'premise: the speech was held as a draft');
    const lines = errors.filter((e) => e.startsWith('[speechRouted]'));
    assert.deepEqual(lines, ['[speechRouted] resident: 9 chars shown by "the\\u0020console\\u0020that\\u0020sent\\u0020this\\u0020turn", held as a draft']);
  });

  it("a place a module names is logged as a field, its invisible characters escaped, and kept readable in the receipt", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.answer = { sentTo: 'the terminal\u202e(page)' };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    const lines = errors.filter((e) => e.startsWith('[routeSpeech]'));
    assert.deepEqual(lines, ['[routeSpeech] resident: turn has no channel; 9 chars shown by "the\\u0020terminal\\u202e(page)", routing posted it to no channel']);
    assert.equal(receipt(f), "[delivered] plain speech → sent to the terminal\u202e(page) · this turn's routing posted it to no channel");
  });

  it("the line for a reply no module showed still says 'no locus', as connectome-doctor reads it", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.answer = 'none';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    const lines = errors.filter((e) => e.startsWith('[routeSpeech]'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.equal(lines[0], '[routeSpeech] resident: turn has no locus (no home/trigger channel; nothing to deliver into) — speech NOT routed (9 chars stay in chronicle)');
  });

  it("a place a module names reaches the receipt as one line, a notice's opening in it marked as text", async () => {
    const surface = new Surface();
    surface.answer = { sentTo: 'the terminal\u0085[routing] says so' };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(receipt(f), "[delivered] plain speech → sent to the terminal \\[routing] says so · this turn's routing posted it to no channel");
  });

  it("an ephemeral run with no channel asks no module, since its plain speech is its caller's result: a module that says it showed the speech puts no receipt in it", async () => {
    const surface = new Surface();
    surface.answer = 'sent';
    const membrane = new MockMembrane();
    const f = await host([surface], membrane);
    const routed: string[] = [];
    const routing: Promise<unknown>[] = [];
    const receiptSteps: string[] = [];
    const internal = f as unknown as { appendProseDeliveryReceipt(agent: { name: string }, routing: unknown): void };
    const append = internal.appendProseDeliveryReceipt.bind(f);
    internal.appendProseDeliveryReceipt = (agent, turnRouting) => { append(agent, turnRouting); receiptSteps.push(agent.name); };
    const registry = (f as unknown as { channelRegistry: { routeSpeech(...args: unknown[]): unknown } }).channelRegistry;
    const routeSpeech = registry.routeSpeech.bind(registry);
    registry.routeSpeech = (...args: unknown[]) => { routed.push(String(args[0])); const outcome = routeSpeech(...args); routing.push(Promise.resolve(outcome)); return outcome; };
    const created = await f.createEphemeralAgent({ name: 'run-1', model: 'test-model', systemPrompt: 'Do the task.', proseRouting: 'locus' });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const run = f.runEphemeralToCompletion(created.agent, created.contextManager);
    f.start();
    const result = await run;
    assert.equal(result.speech, 'Done.');
    await until(() => routed.includes('run-1') || surface.asked.length > 0, "the run's speech reaching the registry, or a module being asked");
    assert.deepEqual(surface.asked, []);
    await Promise.allSettled(routing);
    await until(() => receiptSteps.includes('run-1'), "the run's turn-end receipt step");
    const runTexts = created.contextManager.getAllMessages().map((m) => textOf(m.content));
    assert.deepEqual(runTexts.filter((text) => text.startsWith('[delivered]')), []);
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
    const spoken: Array<number | undefined> = [];
    (surface as unknown as { onAgentSpeech(agent: string, content: unknown, context: SpeechContext): Promise<void> }).onAgentSpeech = async (_agent, _content, context) => {
      spoken.push(context.turnId);
    };
    surface.ctx!.registerSpeechHandler('*');
    await turn(f);
    assert.deepEqual(askedTexts(surface), [
      { text: 'Looking around.', final: false },
      { text: 'Nothing here.', final: true },
    ]);
    assert.deepEqual(surface.asked.map((a) => a.agent), ['resident', 'resident']);
    const turnIds = surface.asked.map((a) => a.context.turnId);
    assert.equal(typeof turnIds[0], 'number');
    assert.equal(turnIds[1], turnIds[0], "one turn's pieces name one turn");
    assert.ok(spoken.length > 0, 'premise: the speech handler was told the turn');
    assert.deepEqual([...new Set(spoken)], [turnIds[0]], "the turn onAgentSpeech's SpeechContext names");
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · this turn's routing posted it to no channel`);
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

  it("speech on both sides of a refused XML attempt after the turn's last call is the final reply, since the attempt traces no inference:tool_calls_yielded (a relay starts a new speech only there), where tool rounds aren't routed live", async () => {
    const surface = new Surface();
    const membrane = new AttemptBeforeReply(false);
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

  it("a turn's final speech is asked about after its inference:completed, and the agent's next turn starts, and compiles, only after its routing and receipt are done (a host that writes the reply at inference:completed keys its answer on this order)", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane);
    const order: string[] = [];
    let starts = 0;
    f.onTrace((event) => {
      if (event.type === 'inference:completed') order.push(`completed ${starts}`);
      if (event.type !== 'inference:started') return;
      starts += 1;
      order.push(`started ${starts} after ${texts(f).filter((t) => t.startsWith('[delivered]')).length} receipts`);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `Reply ${starts}.` }]));
    });
    surface.onAsked = () => { order.push(`asked ${surface.asked.at(-1)!.text}`); };
    const taken: string[] = [];
    const process = surface.onProcess.bind(surface);
    surface.onProcess = async (event) => {
      taken.push(String((event as { content?: unknown }).content));
      return process(event);
    };
    const [released, release] = gate();
    const { server, published } = channelServer(true);
    const publish = server.sendChannelsPublish;
    server.sendChannelsPublish = async (params) => {
      if (params.content?.[0]?.text === 'Reply 1.') await released;
      return publish(params);
    };
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    internals(f).pendingRequests.push({ agentName: 'resident', reason: 'channel-message', source: 'mcpl', timestamp: Date.now(), channelId: 'room', channelServerId: 'srv' });
    await f.start();
    await until(() => surface.asked.length === 1, "the first turn's ask");
    push(f, 'second');
    await until(() => taken.includes('second'), 'the second message to be taken in');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(published.length, 0, "premise: the first reply's post is still under way");
    release();
    await until(() => texts(f).filter((t) => t.startsWith('[delivered]')).length === 2, 'both receipts');
    assert.deepEqual(order, ['started 1 after 0 receipts', 'completed 1', 'asked Reply 1.', 'started 2 after 1 receipts', 'completed 2', 'asked Reply 2.']);
    assert.equal(published[0]?.text, 'Reply 1.');
    const second = (membrane.calls[1]?.messages ?? []) as Array<{ content: ContentBlock[] | string }>;
    const compiled = second.map((m) => (typeof m.content === 'string' ? m.content : textOf(m.content)));
    const receiptAt = compiled.findIndex((t) => t.startsWith('[delivered]'));
    assert.ok(receiptAt >= 0, compiled.join('\n'));
    assert.ok(receiptAt < compiled.indexOf('second'), compiled.join('\n'));
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
    assert.ok(failed[0]!.includes('Some plain speech of its rounds was handed on for delivery or shown as written'), failed[0]);
    assert.deepEqual(notices(f), []);
  });

  it("a heartbeat that fails after a round a module showed says that round's held speech was handed on", async () => {
    const surface = new Surface();
    const membrane = new FailsAfterFirstRound();
    membrane.pushResponse(lookRound('Looking around.'));
    const f = await host([surface], membrane);
    internals(f).pendingRequests.push({ agentName: 'resident', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now() });
    await f.runUntilIdle();
    assert.deepEqual(askedTexts(surface), [{ text: 'Looking around.', final: false }], 'premise: the held round was asked about');
    assert.deepEqual(openDrafts(f).map((d) => d.text), ['Looking around.'], 'premise: the round was held as a draft');
    const failed = texts(f).filter((t) => t.startsWith('[inference-failed]'));
    assert.equal(failed.length, 1, texts(f).join('\n'));
    assert.ok(failed[0]!.includes('Some plain speech of its rounds was handed on for delivery or shown as written'), failed[0]);
  });

  it("a receipt that can't be recorded is logged with its agent and the places it named", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    const manager = f.getAgent('resident')!.getContextManager();
    const add = manager.addMessage.bind(manager);
    manager.addMessage = ((...args: Parameters<typeof add>) => {
      if ((args[2] as { kind?: string } | undefined)?.kind === 'delivery-receipt') throw new Error('zz-store full');
      return add(...args);
    }) as typeof manager.addMessage;
    await turn(f);
    assert.equal(receipt(f), undefined, 'premise: no receipt was recorded');
    assert.ok(errors.includes('[delivered] resident: its receipt couldn\'t be recorded; it named "sent\\u0020to\\u0020the\\u0020console\\u0020that\\u0020sent\\u0020this\\u0020turn": Error: zz-store full'), errors.join('\n'));
  });

  it("a context-budget restart that takes a routing whose receipt was written names only its own speech's places in its receipt", async () => {
    const surface = new Surface();
    surface.answer = 'per-text';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO}, for Hi there. · this turn's routing posted it to no channel`, 'premise: the turn wrote its receipt');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Again.' }]));
    internals(f).pendingRequests.push({ agentName: 'resident', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
    await f.runUntilIdle();
    assert.deepEqual(askedTexts(surface).map((a) => a.text), ['Hi there.', 'Again.'], 'premise: the restart routed its speech');
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO}, for Again. · this turn's routing posted it to no channel`);
  });

  it("a turn that takes a module's wake beside a continuation names that wake's messages, not those the continuation carried", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both.' }]));
    const f = await host([surface], membrane);
    const pending = internals(f).pendingRequests;
    const t0 = Date.now();
    pending.push({ agentName: 'resident', reason: 'auto-continue', source: 'framework', timestamp: t0, openingMessages: ['m-carried'], autoContinueRun: { stop: 'end_turn' } });
    pending.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: t0 + 1, openingMessages: ['m-new'] });
    await f.runUntilIdle();
    assert.deepEqual(askedTexts(surface), [{ text: 'Both.', final: true }], 'premise: one turn took both');
    assert.deepEqual(surface.asked[0]!.context.openedBy?.messages, ['m-new']);
  });

  it("a piece with no channel whose agent a module replaces from inside its hook isn't routed for the replacement", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.answer = 'none';
    const f = await host([surface], new MockMembrane());
    const internal = f as unknown as {
      agents: Map<string, unknown>;
      channelRegistry: { routeSpeech(...args: unknown[]): unknown };
      routingOf(name: string): unknown;
      routeLocusSpeech(agent: unknown, round: unknown, text: string, locus: null): Promise<unknown>;
    };
    const original = internal.agents.get('resident');
    const routed: unknown[] = [];
    const route = internal.channelRegistry.routeSpeech.bind(internal.channelRegistry);
    internal.channelRegistry.routeSpeech = (...args: unknown[]) => { routed.push(args); return route(...args); };
    surface.onAsked = () => { internal.agents.set('resident', { name: 'resident' }); };
    try {
      assert.equal(await internal.routeLocusSpeech(original, { routing: internal.routingOf('resident') }, 'Said before the swap.', null), null);
      assert.equal(surface.asked.length, 1, 'premise: the module was asked');
      assert.deepEqual(routed, []);
      assert.ok(errors.includes(`[routeSpeech] resident: replaced while its modules were asked; ${'Said before the swap.'.length} chars not routed for the replacement`), errors.join('\n'));
    } finally {
      internal.agents.set('resident', original);
    }
  });

  for (const where of ['a channel', 'no channel'] as const) it(`a piece with ${where} that a replaced agent routes after another agent took its name asks no module and routes under that name`, async (t) => {
    const surface = new Surface();
    const f = await host([surface], new MockMembrane());
    const { server, published } = channelServer(true);
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    await f.start();
    const internal = f as unknown as {
      agents: Map<string, unknown>;
      routingOf(name: string): unknown;
      routeLocusSpeech(agent: unknown, round: unknown, text: string, locus: { serverId: string; channelId: string } | null): Promise<unknown>;
    };
    const routed: string[] = [];
    const routes = registry as unknown as { routeSpeech(name: string, text: string, ...rest: unknown[]): unknown };
    const routeSpeech = routes.routeSpeech.bind(routes);
    t.mock.method(routes, 'routeSpeech', (name: string, text: string, ...rest: unknown[]) => { routed.push(`${name}: ${text}`); return routeSpeech(name, text, ...rest); });
    const original = internal.agents.get('resident');
    const text = 'Said after the swap.';
    internal.agents.set('resident', { name: 'resident' });
    try {
      await internal.routeLocusSpeech(original, { routing: internal.routingOf('resident') }, text, where === 'a channel' ? { serverId: 'srv', channelId: 'room' } : null);
      assert.deepEqual(surface.asked, [], 'no module is asked about it');
      assert.deepEqual(routed, [`resident: ${text}`], 'it routes under the name');
      if (where === 'a channel') assert.deepEqual(published.map((p) => p.text), [text], "it's posted");
    } finally {
      internal.agents.set('resident', original);
    }
  });

  it("hybrid plain words of a heartbeat's turn with no locus that a replaced agent writes after another agent took its name are held as a draft, as before, and no module is asked about them", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    const f = await host([surface], new MockMembrane(), { proseRouting: 'hybrid' });
    await f.start();
    const internal = f as unknown as {
      agents: Map<string, unknown>;
      routingOf(name: string): { heartbeat?: true; drafts: Array<{ id: string }> };
      deliverHybridProse(agent: unknown, rawText: string, locus: null, allowLocus: boolean, round: unknown): Promise<void>;
    };
    const original = internal.agents.get('resident');
    const routing = internal.routingOf('resident');
    routing.heartbeat = true;
    internal.agents.set('resident', { name: 'resident' });
    try {
      await internal.deliverHybridProse(original, 'Kept for later.', null, true, { routing, notice: 'later' });
      assert.equal(routing.drafts.length, 1, `it's held as a draft: ${errors.join('\n')}`);
      assert.deepEqual(surface.asked, [], 'no module is asked about it');
    } finally {
      internal.agents.set('resident', original);
    }
  });

  it("a module whose onSpeechRouted can't be read isn't asked, and the others are", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    const broken = new Surface('broken');
    Object.defineProperty(broken, 'onSpeechRouted', { get() { throw new Error('broken accessor'); } });
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([broken, surface], membrane);
    await turn(f);
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · this turn's routing posted it to no channel`);
    assert.ok(errors.includes('Speech-routed module broken (agent resident) error reading its onSpeechRouted: Error: broken accessor'), errors.join('\n'));
  });

  it("a place's callback that throws is logged, and the ask still returns the place", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    const f = await host([surface], new MockMembrane());
    const registry = (f as unknown as { moduleRegistry: { askSpeechRouted(agent: string, text: string, context: SpeechRoutedContext, onPlace?: () => void): string[] } }).moduleRegistry;
    assert.deepEqual(registry.askSpeechRouted('resident', 'Hi.', { final: true }, () => { throw new Error('zz-callback broke'); }), [SENT_TO]);
    assert.ok(errors.includes("Speech-routed module console (agent resident) place's callback error: Error: zz-callback broke"), errors.join('\n'));
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

  it("a hybrid reply's >>> post whose outcome is unknown counts as a post tried, so the receipt doesn't say its routing posted it to no channel", async (t) => {
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
    assert.ok(!receipt(f)?.includes('posted it to no channel'), receipt(f));
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
      assert.deepEqual(askedTexts(surface), [{ text: 'Hi there.', final: true }], 'premise: the module was asked about the reply');
      assert.equal(notices(f).length, answer === 'sent' ? 0 : 1, notices(f).join('\n'));
      if (answer === 'sent') assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · this turn's routing posted it to no channel`);
    });
  }

  it("a hybrid tool round is asked about as it routes, and a private envelope never is", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('Looking around.'));
    membrane.pushResponse(afterLook('Looking around.', '>>>skip_reply kept to myself'));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    await turn(f);
    assert.ok(f.getAgent('resident')!.getContextManager().getAllMessages().some((m) => textOf(m.content).includes('>>>skip_reply kept to myself')), "premise: the final round's reply was taken in");
    assert.deepEqual(askedTexts(surface), [{ text: 'Looking around.', final: false }]);
    assert.ok(!surface.asked.some((a) => a.text.includes('kept to myself')), 'the private envelope is never asked about');
    assert.deepEqual(notices(f), []);
  });

  const keepWakeQuiet = (f: AgentFramework, membrane: MockMembrane, envelope: string) => {
    let starts = 0;
    f.onTrace((event) => {
      if (event.type === 'inference:started' && ++starts > 1) membrane.pushResponse(createMockResponse([{ type: 'text', text: envelope }]));
    });
  };

  const openDrafts = (f: AgentFramework) =>
    (f as unknown as { proseDrafts: { open(agent: string): Array<{ id: string; text: string; reason: string }> } }).proseDrafts.open('resident');

  it("a heartbeat's held prose asks the modules, stays a draft, and its receipt names what they said", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'A quiet thought.' }]));
    const f = await host([surface], membrane);
    internals(f).pendingRequests.push({ agentName: 'resident', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now() });
    await f.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'premise: the heartbeat took a turn');
    assert.deepEqual(askedTexts(surface), [{ text: 'A quiet thought.', final: true }]);
    assert.deepEqual(notices(f), []);
    assert.deepEqual(openDrafts(f).map((d) => d.text), ['A quiet thought.']);
    assert.ok(receipt(f)?.includes(`sent to ${SENT_TO}`), receipt(f));
    assert.match(receipt(f) ?? '', /held as draft d-/);
  });

  it('a locked turn whose lock moved while its words waited for its end asks about the speech it holds', async () => {
    const surface = new Surface();
    surface.answer = 'per-text';
    const membrane = new WithoutRoundContent();
    membrane.supportsInjectedMessages = false;
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Before the move.' },
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#ops' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Before the move.' },
      { type: 'text', text: 'After the move.' },
    ] as ContentBlock[]));
    const f = await host([surface], membrane, { proseRouting: 'locked', proseLock: '#room' });
    const { server, published } = channelServer(true);
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    registry.ensureChannelRegistered('srv', 'ops', 'ops');
    await turn(f);
    assert.deepEqual(published, [], 'premise: the move held the whole stream');
    const asked = surface.asked.map((a) => a.text).join(' ');
    assert.ok(asked.includes('Before the move.') && asked.includes('After the move.'), JSON.stringify(askedTexts(surface)));
    assert.deepEqual(askedTexts(surface).map((a) => a.final), [true], "the reply's held piece is asked about as final");
    for (const piece of surface.asked) {
      const place = `sent to ${SENT_TO}, for ${piece.text.replace(/\s+/g, ' ').trim()}`;
      assert.ok(receipt(f)?.includes(place), `${place} in ${receipt(f)}`);
    }
    assert.match(receipt(f) ?? '', /held as drafts? d-/);
  });

  it("a hybrid reply held after a refused target asks about the held speech, and not about the refused envelope", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(lookRound('>>>nowhere First.'));
    membrane.pushResponse(afterLook('>>>nowhere First.', 'Second.'));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    keepWakeQuiet(f, membrane, '>>>skip_reply');
    await turn(f);
    const drafts = openDrafts(f);
    assert.ok(drafts.some((d) => d.text === 'First.' && d.reason === 'bounced'), `premise: the refused envelope bounced: ${JSON.stringify(drafts)}`);
    assert.ok(drafts.some((d) => d.text === 'Second.' && d.reason === 'no-destination'), `premise: the reply was held: ${JSON.stringify(drafts)}`);
    assert.deepEqual(askedTexts(surface), [{ text: 'Second.', final: true }]);
    const turnReceipt = texts(f).find((x) => x.startsWith('[delivered]') && x.includes('held as draft'));
    assert.ok(turnReceipt?.includes(`sent to ${SENT_TO}`), turnReceipt);
  });

  it("speech a send in its round held, with a turn's channel, asks the modules about it", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    surface.answer = 'per-text';
    const membrane = new MockMembrane();
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
    const f = await host([surface], membrane);
    const published = await channelTurn(f, true);
    await f.runUntilIdle();
    assert.ok(!published.some((p) => p.text === 'Looking around.'), `premise: the send held the round's speech: ${JSON.stringify(published)}`);
    assert.ok(openDrafts(f).some((d) => d.text === 'Looking around.' && d.reason === 'explicit-send'), JSON.stringify(openDrafts(f)));
    assert.equal(askedTexts(surface).filter((a) => a.text === 'Looking around.' && a.final === false).length, 1, JSON.stringify(askedTexts(surface)));
    assert.ok(receipt(f)?.includes(`sent to ${SENT_TO}, for Looking around.`), receipt(f));
  });

  it("a hybrid round a send held asks about its plain envelope, and not about its >>> envelope", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new MockMembrane();
    const send = { type: 'tool_use', id: 'p1', name: 'channel_publish', input: { channelId: 'room', content: 'A note.' } } as ContentBlock;
    const said = 'And plain.\n>>>room More for the room.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: said }, send], 'tool_use'));
    membrane.pushResponse({
      ...createMockResponse([
        { type: 'text', text: said },
        send,
        { type: 'tool_result', toolUseId: 'p1', content: 'posted' },
        { type: 'text', text: 'Done.' },
      ] as ContentBlock[]),
      toolCalls: [],
      rawAssistantText: 'Done.',
    } as NormalizedResponse);
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    const published = await channelTurn(f, true);
    await f.runUntilIdle();
    const drafts = openDrafts(f);
    assert.ok(drafts.some((d) => d.text.includes('And plain.')) && drafts.some((d) => d.text.includes('More for the room.')),
      `premise: the send held both envelopes: ${JSON.stringify(drafts)} ${JSON.stringify(published)}`);
    assert.equal(askedTexts(surface).filter((a) => a.text.includes('And plain.') && a.final === false).length, 1, JSON.stringify(askedTexts(surface)));
    assert.ok(!surface.asked.some((a) => a.text.includes('More for the room.')), 'the >>> envelope is an explicit send');
  });

  for (const hybrid of [false, true]) {
    it(`where tool rounds aren't routed live, a send that held the turn's speech asks about a round's prose as a round's and only the reply as the final speech${hybrid ? ', under hybrid routing' : ''}`, async (t) => {
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
      const f = await host([surface], membrane, hybrid ? { proseRouting: 'hybrid' } : {});
      await channelTurn(f, true);
      await f.runUntilIdle();
      const held = openDrafts(f).map((d) => d.text);
      assert.ok(held.some((d) => d.includes('Looking around.')) && held.some((d) => d.includes('Nothing here.')), `premise: the send held both: ${JSON.stringify(held)}`);
      assert.deepEqual(askedTexts(surface), [
        { text: 'Looking around.', final: false },
        { text: 'Nothing here.', final: true },
      ]);
    });
  }

  it("explicit routing asks no module about speech it holds or bounces, since it writes no receipt", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new MockMembrane();
    const list = { type: 'tool_use', id: 'd1', name: 'drafts', input: { action: 'list' } } as ContentBlock;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Unrouted words.' }, list], 'tool_use'));
    membrane.pushResponse({
      ...createMockResponse([
        { type: 'text', text: 'Unrouted words.' },
        list,
        { type: 'tool_result', toolUseId: 'd1', content: 'no drafts' },
        { type: 'text', text: 'Bounced words.' },
      ] as ContentBlock[]),
      toolCalls: [],
      rawAssistantText: 'Bounced words.',
    } as NormalizedResponse);
    const f = await host([surface], membrane, { proseRouting: 'explicit' });
    keepWakeQuiet(f, membrane, '>>skip_reply');
    await turn(f);
    const drafts = openDrafts(f);
    assert.ok(drafts.some((d) => d.text === 'Unrouted words.' && d.reason === 'no-destination'), `premise: a drafts round held it: ${JSON.stringify(drafts)}`);
    assert.ok(drafts.some((d) => d.text === 'Bounced words.' && d.reason === 'bounced'), `premise: the reply bounced: ${JSON.stringify(drafts)}`);
    assert.deepEqual(surface.asked, []);
    assert.equal(receipt(f), undefined);
  });

  it("an envelope whose {{unsent}} names a draft still being sent holds its words without asking, as an explicit send", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>room {{unsent}} and more' }]));
    const f = await host([surface], membrane, { proseRouting: 'hybrid' });
    const { server } = channelServer(true);
    const registry = internals(f).channelRegistry;
    registry.serverRegistry = { getServer: () => server };
    registry.ensureChannelRegistered('srv', 'room', 'room');
    const i = f as unknown as {
      proseDrafts: { hold(agent: string, segments: Array<{ text: string }>, reason: string): { held: Array<{ id: string }> } };
      draftsInFlight: Set<string>;
    };
    const [bounced] = i.proseDrafts.hold('resident', [{ text: 'Earlier words.' }], 'bounced').held;
    i.draftsInFlight.add(`resident\u0000${bounced!.id}`);
    await turn(f);
    assert.ok(openDrafts(f).some((d) => d.text.includes('and more')), `premise: the envelope's words were held: ${JSON.stringify(openDrafts(f))}`);
    assert.deepEqual(surface.asked, []);
  });

  it("a module whose hook throws as it's called counts as having shown nothing, the line names it, and another module's place still counts", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    (surface as unknown as { onSpeechRouted(): never }).onSpeechRouted = () => { throw new Error('console broke'); };
    const other = new Surface('other');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface, other], membrane);
    await turn(f);
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · this turn's routing posted it to no channel`);
    assert.ok(errors.includes('Speech-routed module console (agent resident) error: Error: console broke'), errors.join('\n'));
  });

  it("a module whose answer throws when its place is read counts as having shown nothing, and another module's place still counts", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.answer = { get sentTo(): unknown { throw new Error('console broke'); } };
    const other = new Surface('other');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface, other], membrane);
    await turn(f);
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → sent to ${SENT_TO} · this turn's routing posted it to no channel`);
    assert.ok(errors.includes('Speech-routed module console (agent resident) error: Error: console broke'), errors.join('\n'));
  });

  it("modules are asked in module order: each place once, a blank answer names none, and a place reads as one line", async () => {
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
    assert.equal(receipt(f), `[delivered] plain speech → sent to the terminal that sent this turn · sent to a page ${'x'.repeat(300)} · this turn's routing posted it to no channel`);
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

  it("a receipt that can't be recorded is logged naming each channel by its id, however long the channel's label", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.answer = 'none';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi room.' }]));
    const f = await host([surface], membrane);
    const registry = internals(f).channelRegistry as unknown as { ensureChannelRegistered(serverId: string, channelId: string, label?: string): void; getDescriptor(channel: { serverId: string; channelId: string }): { label?: string } | undefined };
    registry.ensureChannelRegistered('srv', 'room', 'l'.repeat(300));
    await channelTurn(f, true);
    assert.equal(registry.getDescriptor({ serverId: 'srv', channelId: 'room' })?.label?.length, 300, "premise: the channel's label is longer than a log value");
    const cm = f.getAgent('resident')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    t.mock.method(cm, 'addMessage', (...args: Parameters<typeof cm.addMessage>) => {
      if ((args[2] as { kind?: string } | undefined)?.kind === 'delivery-receipt') throw new Error('zz-receipt refused');
      return add(...args);
    });
    await f.runUntilIdle();
    const line = errors.find((e) => e.startsWith("[delivered] resident: its receipt couldn't be recorded; it named "));
    assert.ok(line, `premise: the receipt couldn't be recorded: ${errors.join('\n')}`);
    assert.ok(line.split('; it named ')[1]!.includes('room'), line);
  });

  it("a turn with a channel posts there, and its receipt names the channel and where the module showed the reply", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi room.' }]));
    const f = await host([surface], membrane);
    const published = await channelTurn(f, true);
    await f.runUntilIdle();
    assert.deepEqual(published.map((p) => p.channelId), ['room']);
    assert.equal(surface.asked.length, 1, 'it was asked');
    assert.deepEqual(notices(f), []);
    assert.equal(receipt(f), `[delivered] plain speech → room · sent to ${SENT_TO}`);
  });

  it("a module whose hook returns a promise that rejects names no place, and its error is logged as a throw's is", async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const surface = new Surface();
    surface.onSpeechRouted = (agent, text, context) => {
      surface.asked.push({ agent, text, context });
      return Promise.reject(new Error('zz-rejected'));
    };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(surface.asked.length, 1, 'premise: it was asked');
    assert.equal(notices(f).length, 1, texts(f).join('\n'));
    assert.ok(errors.includes('Speech-routed module console (agent resident) error: Error: zz-rejected'), errors.join('\n'));
  });

  it("a module whose hook returns a promise names no place, and routing doesn't wait for it", async () => {
    const surface = new Surface();
    let settle: (answer: SpeechSent) => void = () => {};
    surface.onSpeechRouted = (agent, text, context) => {
      surface.asked.push({ agent, text, context });
      return new Promise<SpeechSent>((resolve) => { settle = resolve; });
    };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f);
    assert.equal(surface.asked.length, 1, 'premise: it was asked');
    assert.equal(notices(f).length, 1, texts(f).join('\n'));
    assert.equal(receipt(f), undefined);
    settle({ sentTo: SENT_TO });
  });

  it("a turn whose channel post has an unknown outcome names the place in its receipt without saying its routing posted it to no channel", async (t) => {
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
    const ask = surface.onSpeechRouted.bind(surface);
    surface.onSpeechRouted = (agent, text, context) => {
      ask(agent, text, context);
      return { sentTo: text === 'Looking around.' ? 'the round\'s place' : 'the reply\'s place' };
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

  it('a module is told which messages opened the turn, every one its waking answer added, and the opening request', async () => {
    const surface = new Surface();
    surface.messagesPerEvent = 2;
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    const before = Date.now();
    await turn(f, 'the opening message');
    const opened = surface.asked.at(-1)!.context.openedBy!;
    assert.equal(opened.reason, 'external-message');
    assert.equal(opened.source, 'console');
    assert.ok(opened.timestamp >= before && opened.timestamp <= Date.now(), String(opened.timestamp));
    assert.deepEqual(openingTexts(surface, surface.asked.at(-1)!), ['the opening message (1)', 'the opening message (2)']);
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
    surface.onSpeechRouted = (agent, text, context) => {
      ask(agent, text, context);
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
    assert.equal(surface.asked.filter((a) => a.text === 'Before the restart.').length, 1, 'the round routed before the restart is asked about once');
    const afterRestart = surface.asked.filter((a) => a.text === 'After the restart.' || a.text === 'Done.');
    assert.deepEqual(afterRestart.map((a) => a.context.final), [false, true]);
    for (const asked of afterRestart) {
      assert.equal(asked.context.openedBy?.reason, 'external-message');
      assert.equal(asked.context.openedBy?.source, 'console');
      assert.deepEqual(openingTexts(surface, asked), ['the opening message']);
    }
    assert.ok(receipt(f)?.includes('sent to the place before'), `the receipt keeps the place named before the restart: ${receipt(f)}`);
  });

  it("a start that takes a module's wake into a turn already under way names the turn's opening message too", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both.' }]));
    const f = await host([surface], membrane);
    const internal = f as unknown as {
      routingOf(name: string): { roundsRan?: true; openingMessages?: string[]; openedBy?: Record<string, unknown> };
      openLogical: Map<string, unknown>;
    };
    const t0 = Date.now();
    const routing = internal.routingOf('resident');
    routing.openedBy = { agentName: 'resident', reason: 'external-message', source: 'console', timestamp: t0 - 10, openingMessages: ['m-opener'] };
    routing.openingMessages = ['m-opener'];
    routing.roundsRan = true;
    internal.openLogical.set('resident', routing);
    const pending = internals(f).pendingRequests;
    pending.push({ agentName: 'resident', reason: 'tool_results_ready', source: 'framework', timestamp: t0 });
    pending.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: t0 + 1, openingMessages: ['m-joined'] });
    await f.runUntilIdle();
    assert.deepEqual(askedTexts(surface), [{ text: 'Both.', final: true }], 'premise: one start took both');
    assert.equal(surface.asked[0]!.context.openedBy?.reason, 'external-message', 'premise: the turn already under way opened it');
    assert.deepEqual([...(surface.asked[0]!.context.openedBy?.messages ?? [])].sort(), ['m-joined', 'm-opener']);
  });

  it("a start that takes a module's wake into a turn that began a round whose results it didn't flush names the turn's opening message too", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both.' }]));
    const f = await host([surface], membrane);
    const internal = f as unknown as {
      routingOf(name: string): { roundsRan?: true; unflushedRounds?: number; openingMessages?: string[]; openedBy?: Record<string, unknown> };
      openLogical: Map<string, unknown>;
    };
    const t0 = Date.now();
    const routing = internal.routingOf('resident');
    routing.openedBy = { agentName: 'resident', reason: 'external-message', source: 'console', timestamp: t0 - 10, openingMessages: ['m-opener'] };
    routing.openingMessages = ['m-opener'];
    routing.unflushedRounds = 1;
    assert.equal(routing.roundsRan, undefined, 'premise: no round of it was flushed');
    internal.openLogical.set('resident', routing);
    const pending = internals(f).pendingRequests;
    pending.push({ agentName: 'resident', reason: 'tool_results_ready', source: 'framework', timestamp: t0 });
    pending.push({ agentName: 'resident', reason: 'external-message', source: 'console', timestamp: t0 + 1, openingMessages: ['m-joined'] });
    await f.runUntilIdle();
    assert.deepEqual(askedTexts(surface), [{ text: 'Both.', final: true }], 'premise: one start took both');
    assert.deepEqual([...(surface.asked[0]!.context.openedBy?.messages ?? [])].sort(), ['m-joined', 'm-opener']);
  });

  it("a held autoContinue run's retry that takes a message's wake names that message, not the one that started the run", async (t) => {
    t.mock.method(console, 'error', () => {});
    const surface = new Surface();
    const membrane = new HeldSecondThenRests();
    const f = await host([surface], membrane, { autoContinue: true });
    push(f, 'the opening message');
    const i = internals(f);
    const deadline = Date.now() + 5_000;
    while (!i.providerAccelerationCooldowns.has('resident')) {
      assert.ok(Date.now() < deadline, `premise: the run's continuation is held (calls: ${membrane.primary})`);
      void f.runUntilIdle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const first = surface.asked.find((a) => a.text === 'Answer 1.');
    assert.ok(first, JSON.stringify(askedTexts(surface)));
    assert.deepEqual(openingTexts(surface, first!), ['the opening message'], 'premise: the opening message started the run');
    const held = () => (i.providerAccelerationCooldowns.get('resident')?.heldRequests ?? []) as unknown[];
    const before = held().length;
    push(f, 'the second message');
    while (held().length === before) {
      assert.ok(Date.now() < deadline + 5_000, `premise: the second message's wake is held (held: ${held().length})`);
      void f.runUntilIdle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    (f as unknown as { releaseProviderWait(agent: string): void }).releaseProviderWait('resident');
    await f.runUntilIdle();
    const retried = surface.asked.find((a) => a.text === 'Answer 3.');
    assert.ok(retried, `premise: the retry took the wake and spoke: ${JSON.stringify(askedTexts(surface))}`);
    assert.deepEqual(openingTexts(surface, retried!), ['the second message']);
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

  it("three pushes parked with one key for an agent their messages aren't written to, a plain one, a silent heartbeat's and another plain one, name both plain pushes' messages at resume, the first's carried on by the silent push the park kept between them", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane, {}, true, {
      agents: [
        { name: 'resident', model: 'test-model', systemPrompt: 'Resident.', proseRouting: 'locus' },
        { name: 'second', model: 'test-model', systemPrompt: 'Second.', proseRouting: 'locus' },
      ],
    });
    await f.quiesce({ reason: 'test window' });
    const t0 = Date.now();
    const pending = internals(f).pendingRequests;
    pending.push({ agentName: 'second', reason: 'mcpl:push-event', source: 'discord', timestamp: t0, addressed: false, openingMessages: ['m-first'] });
    pending.push({ agentName: 'second', reason: 'mcpl:push-event', source: 'discord', timestamp: t0 + 10, suppressProse: true, silentHeartbeat: { eventId: 'zz-tick', serverId: 'discord' } });
    pending.push({ agentName: 'second', reason: 'mcpl:push-event', source: 'discord', timestamp: t0 + 20, addressed: false, openingMessages: ['m-second'] });
    await (f as unknown as { processInferenceRequests(): Promise<void> }).processInferenceRequests();
    assert.equal(membrane.calls.length, 0, 'premise: parked while quiesced');
    assert.equal(internals(f).pendingRequests.length, 1, 'premise: coalesced into one');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi.' }]));
    await f.resume();
    await f.runUntilIdle();
    assert.deepEqual(surface.asked.filter((a) => a.agent === 'second').at(-1)?.context.openedBy?.messages, ['m-first', 'm-second']);
  });

  it("a provider hold that keeps a silent push carrying messages and folds an equal plain push into it keeps both pushes' messages", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const f = await host([surface], membrane);
    const now = Date.now();
    const timer = setTimeout(() => {}, 60_000);
    const cooldowns = internals(f).providerAccelerationCooldowns;
    try {
      cooldowns.set('resident', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'test hold', failures: 1 });
      const push = (message: string, silent: boolean) => ({
        agentName: 'resident', reason: 'mcpl:push-event', source: 'discord', timestamp: now, addressed: false,
        ...(silent ? { suppressProse: true, silentHeartbeat: { eventId: 'zz-tick', serverId: 'discord' } } : {}),
        openingMessages: [message],
      });
      internals(f).pendingRequests.push(push('m-first', true), push('m-second', false));
      await f.runUntilIdle();
      const held = cooldowns.get('resident')!.heldRequests as Array<{ openingMessages?: string[]; suppressProse?: unknown }>;
      assert.equal(held.length, 1, 'premise: the hold keeps one of the two equal pushes');
      assert.equal(held[0]!.suppressProse, true, 'premise: the hold keeps the silent push it held first');
      assert.deepEqual(held[0]!.openingMessages, ['m-first', 'm-second']);
    } finally {
      clearTimeout(timer);
    }
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

  it("a retry after a refused round's rewind names the messages of the turn it stands in for", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    const call = { type: 'tool_use', id: 'c1', name: 'console--look', input: {} } as ContentBlock;
    membrane.pushResponse(lookRound('Let me look.'));
    membrane.pushResponse({
      ...createMockResponse([{ type: 'text', text: 'Let me look.' }, call, { type: 'tool_result', toolUseId: 'c1', content: 'nothing here' }] as ContentBlock[], 'refusal'),
      toolCalls: [],
    } as NormalizedResponse);
    const f = await host([surface], membrane, { refusalHandling: { autoRewind: true, maxRewinds: 3 } });
    let starts = 0;
    f.onTrace((event) => {
      if (event.type === 'inference:started' && ++starts === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    });
    await turn(f, 'hello there');
    await f.runUntilIdle();
    const retried = surface.asked.find((a) => a.text === 'Hi there.');
    assert.ok(retried, JSON.stringify(askedTexts(surface)));
    assert.equal(retried!.context.openedBy?.reason, 'refusal-rewind-retry', 'premise: the retry opened a turn of its own');
    assert.deepEqual(openingTexts(surface, retried!), ['hello there']);
  });

  it("an operator's unstick names the messages of the turn it carries on", async () => {
    const surface = new Surface();
    const membrane = new MockMembrane();
    membrane.pushResponse({ ...createMockResponse([{ type: 'text', text: 'I would rather not.' }], 'refusal'), toolCalls: [] } as NormalizedResponse);
    const f = await host([surface], membrane);
    await turn(f, 'hello there');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Unstuck reply.' }]));
    const accepted = await (f as unknown as { handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean }> })
      .handleHostCommand('test-server', { command: 'unstick', agentName: 'resident' });
    assert.equal(accepted.ok, true, 'premise: the unstick was accepted');
    await f.runUntilIdle();
    const rerun = surface.asked.find((a) => a.text === 'Unstuck reply.');
    assert.ok(rerun, JSON.stringify(askedTexts(surface)));
    assert.equal(rerun!.context.openedBy?.reason, 'unstick', "premise: the unstick's run opened a turn of its own");
    assert.deepEqual(openingTexts(surface, rerun!), ['hello there']);
  });

  it("a rewind that sets aside a reply no channel took sets aside the notice that quotes it, so the retry is sent neither", async () => {
    const surface = new Surface();
    surface.answer = 'none';
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi there.' }]));
    const f = await host([surface], membrane);
    await turn(f, 'hello there');
    assert.ok(notices(f).some((n) => n.includes('Hi there.')), `premise: the notice quotes the reply: ${notices(f).join('\n')}`);
    membrane.pushResponse({ ...createMockResponse([{ type: 'text', text: 'I would rather not.' }], 'refusal'), toolCalls: [] } as NormalizedResponse);
    let starts = 0;
    f.onTrace((event) => {
      if (event.type === 'inference:started' && ++starts === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Unstuck reply.' }]));
    });
    const accepted = await (f as unknown as { handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean }> })
      .handleHostCommand('test-server', { command: 'unstick', agentName: 'resident' });
    assert.equal(accepted.ok, true, 'premise: the unstick was accepted');
    await f.runUntilIdle();
    assert.equal(starts, 2, 'premise: the unstick was refused once and retried');
    const sent = JSON.stringify(membrane.calls.at(-1)!.messages);
    assert.ok(sent.includes(`[${NOTICE_TAG.refusalRewind}]`), 'premise: the last request is the retry after the rewind');
    assert.doesNotMatch(sent, /Hi there/, "the retry carries neither the set-aside reply nor its notice's quote");
    assert.match(sent, /hello there/, 'what came before stays');
  });

  it("an inference failure's rewind queues its retry with the messages of the turn it stands in for", async () => {
    const surface = new Surface();
    const f = await host([surface], new MockMembrane());
    const agent = f.getAgent('resident')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'the newest exchange' }]);
    const i = f as unknown as {
      pendingRequests: Array<{ reason?: string; openingMessages?: string[] }>;
      routingOf(name: string): { openingMessages?: string[] };
      quarantinePoisonedHistory(agent: unknown, reason: string): void;
      presentAtEndOf(agent: unknown): void;
    };
    i.presentAtEndOf(agent);
    i.routingOf('resident').openingMessages = ['m-opening'];
    i.quarantinePoisonedHistory(agent, 'the provider refused the request');
    const woke = i.pendingRequests.filter((r) => r.reason === 'inference-failure-rewind-retry');
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
