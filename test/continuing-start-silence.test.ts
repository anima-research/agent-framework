import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { EventResponse, InferenceRequest, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import type { ModuleContextInjection } from '../src/types/module.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const ROOM = 'discord:g1:room';
const GENERAL = 'discord:g1:general';
const PROMISE = 'stays held until a new message reaches you or this turn ends';
const NEW_MESSAGE = 'thanks, is it the final version?';
const CHATTER = 'someone else talking in the room';
const FINAL = 'Done — I sent it to the room.';
const CHANGE = 'ZZCHANGE: a tool a host added';
const REPLY = "Yes, it's the final version.";
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input }) as ContentBlock;

class ErrorsAfter extends MockYieldingStream {
  reached = false;
  private release: () => void = () => {};
  private readonly released: Promise<void>;
  constructor(responses: NormalizedResponse[], private readonly depth: number, gated = false) {
    super(responses, true);
    this.released = gated ? new Promise((resolve) => { this.release = resolve; }) : Promise.resolve();
  }

  fail(): void {
    this.release();
  }

  override provideToolResults(results: unknown[], options?: Parameters<MockYieldingStream['provideToolResults']>[1]): void {
    super.provideToolResults(results, options);
    if (this.toolDepth !== this.depth) return;
    this.reached = true;
    const self = this as unknown as { events: StreamEvent[]; _done: boolean };
    self._done = false;
    void this.released.then(() => {
      self.events.push({ type: 'error', error: new Error('provider unavailable') } as unknown as StreamEvent);
      const wake = (this as unknown as { pendingResolve: (() => void) | null }).pendingResolve;
      if (wake) wake();
    });
  }
}

class ThrowsAfter extends MockYieldingStream {
  constructor(responses: NormalizedResponse[]) {
    super(responses, true);
  }

  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) yield next.value;
    throw new Error('provider unavailable');
  }
}

class XmlModeStream implements YieldingStream {
  constructor(private readonly inner: YieldingStream) {}
  provideToolResults(...args: Parameters<YieldingStream['provideToolResults']>): void {
    this.inner.provideToolResults(...args);
  }
  cancel(): void { this.inner.cancel(); }
  get isWaitingForTools(): boolean { return this.inner.isWaitingForTools; }
  get pendingToolCallIds(): string[] { return this.inner.pendingToolCallIds; }
  get toolDepth(): number { return this.inner.toolDepth; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of this.inner) {
      if (event.type !== 'tool-calls') {
        yield event;
        continue;
      }
      const context = { ...(event as unknown as { context: Record<string, unknown> }).context };
      delete context.roundContent;
      context.supportsInjectedMessages = false;
      yield { ...event, context } as unknown as StreamEvent;
    }
  }
}

class Gate implements Module {
  readonly name = 'gate';
  private opened: Promise<void> = Promise.resolve();
  private open: () => void = () => {};
  waiting = false;
  ctx?: ModuleContext;
  private readonly gathers = new Map<string, number>();
  onGather?: (agentName: string, n: number) => void;
  close(): void {
    this.opened = new Promise((resolve) => { this.open = resolve; });
  }
  release(): void {
    this.open();
  }
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
  async gatherContext(agentName: string): Promise<ModuleContextInjection[]> {
    const n = (this.gathers.get(agentName) ?? 0) + 1;
    this.gathers.set(agentName, n);
    this.onGather?.(agentName, n);
    return [];
  }
  async stop(): Promise<void> {
    this.open();
  }
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for the gate.', inputSchema: { type: 'object', properties: {} } }];
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.waiting = true;
    await this.opened;
    this.waiting = false;
    return { success: true, data: 'opened' };
  }
}

const SEND = createMockResponse([text('Posting it now.'), call('s1', 'discord--send_message', { channelId: ROOM, text: 'The report is up.' })], 'tool_use');
const HELD = createMockResponse([text('Sent it, all done.'), call('w1', 'gate--wait')], 'tool_use');
const overBudget = (): NormalizedResponse => {
  const response = createMockResponse([text('Sent it, all done.'), call('w1', 'gate--wait')], 'tool_use');
  (response as { usage: { inputTokens: number; outputTokens: number } }).usage = { inputTokens: 100, outputTokens: 5 };
  return response;
};
const final = () => new MockYieldingStream([createMockResponse([text(FINAL)])], true);
const reply = () => new MockYieldingStream([createMockResponse([text(REPLY)])], true);

interface Harness {
  incoming(messageId: string, body: string, mode?: 'addressed' | 'ambient'): void;
  until(cond: () => boolean, what: string): Promise<void>;
  queued(body: string): boolean;
  stored(body: string): boolean;
  wake(request: Omit<InferenceRequest, 'agentName'>): void;
  endTurn(): Promise<void>;
  storeFor(agentName: string, body: string): ReturnType<ModuleContext['addMessage']>;
  /** Store a system change, as a host may, without metadata. */
  storeChange(): void;
  remove(id: ReturnType<ModuleContext['addMessage']>): void;
}

interface Turn {
  publishes: Array<[string | undefined, string | undefined]>;
  drafts: Array<[string, string]>;
  requests: NormalizedRequest[];
  holds: number;
}

async function turn(options: {
  proseRouting: 'locus' | 'hybrid';
  stream: (n: number) => YieldingStream;
  maxStreamTokens?: number;
  hold?: { error: string; during?: (h: Harness) => Promise<void> };
  gateWakesOnMentions?: boolean;
  messageWhileGated?: boolean;
  whileGated?: (h: Harness) => Promise<void>;
  residents?: boolean;
  gather?: (h: Harness, agentName: string, n: number) => void;
  beforeEnd?: (h: Harness) => Promise<void>;
  toolDeclarations?: 'entries';
}): Promise<Turn> {
  const dir = mkdtempSync(join(tmpdir(), 'af-continuing-start-'));
  const commandPath = join(dir, 'commands.jsonl');
  const statusPath = join(dir, 'status.jsonl');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  let streams = 0;
  membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    if (JSON.stringify(request).includes('You are other.')) {
      return new MockYieldingStream([createMockResponse([call('k-other', 'skip_reply', { reason: 'not mine' })], 'tool_use')], true);
    }
    membrane.calls.push(request);
    streams += 1;
    return options.stream(streams);
  };
  const gate = new Gate();
  if (options.messageWhileGated || options.whileGated) gate.close();
  let holds = 0;
  const hold = options.hold;
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: options.proseRouting,
      ...(options.maxStreamTokens !== undefined ? { maxStreamTokens: options.maxStreamTokens } : {}),
      ...(options.toolDeclarations ? { toolDeclarations: options.toolDeclarations } : {}),
    }, ...(options.residents ? [{ name: 'other', model: 'test-model', systemPrompt: 'You are other.' }] : [])],
    mcplServers: [{
      id: 'discord', command: process.execPath, args: [join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs')],
      env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath, SEND_TOOL: '1' }, toolPrefix: 'discord',
    }],
    errorPolicy: { maxRetries: 2, onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 2 ? { retry: true, delayMs: 0 } : { retry: false }) },
    ...(hold ? { providerHold: (error: Error) => (error.message === hold.error && holds === 0 && ++holds === 1 ? { holdMs: 60_000, reason: 'test hold' } : undefined) } : {}),
    ...(options.gateWakesOnMentions
      ? { gate: { config: { policies: [{ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }], default: 'skip' } } }
      : {}),
    modules: [gate],
  } as Parameters<typeof AgentFramework.create>[0]);
  const internals = framework as unknown as {
    channelRegistry: { listChannelsRaw(): unknown[] };
    activeTurnTokens: Map<string, unknown>;
    deferredMessages: unknown[];
    pendingRequests: InferenceRequest[];
    providerAccelerationCooldowns: Map<string, { until: number }>;
    openLogical: Map<string, unknown>;
    releaseProviderAccelerationCooldown(agentName: string): void;
    proseDrafts: { open(agent: string): Array<{ text: string; reason: string }> };
  };
  const until = async (cond: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const lines = () => existsSync(statusPath)
    ? readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; channelId?: string; text?: string })
    : [];
  const h: Harness = {
    incoming: (messageId, body, mode = 'addressed') =>
      appendFileSync(commandPath, JSON.stringify({ op: 'incoming', channelId: ROOM, messageId, mode, text: body }) + '\n'),
    until,
    queued: (body) => JSON.stringify(internals.deferredMessages).includes(body),
    stored: (body) => JSON.stringify(framework.getAgent('scout')!.getContextManager().getAllMessages()).includes(body),
    wake: (request) => internals.pendingRequests.push({ agentName: 'scout', ...request } as InferenceRequest),
    endTurn: async () => { internals.openLogical.delete('scout'); },
    storeFor: (agentName, body) => {
      assert.ok(!internals.activeTurnTokens.has(agentName), `${agentName} has no turn alive, so the write is stored`);
      return gate.ctx!.addMessage('user', [text(body)], undefined, { forAgent: agentName });
    },
    remove: (id) => gate.ctx!.removeMessage(id),
    storeChange: () => {
      gate.ctx!.addMessage('Host', [{ type: 'system_change', defineTools: [{ name: 'zz_tool', description: CHANGE, inputSchema: { type: 'object', properties: {} } }] } as unknown as ContentBlock]);
    },
  };
  if (options.gather) gate.onGather = (agentName, n) => options.gather!(h, agentName, n);
  try {
    await framework.start();
    await until(() => internals.channelRegistry.listChannelsRaw().length >= 2, 'the channels');
    h.incoming('in-1', 'please post the report');
    if (options.messageWhileGated) {
      await until(() => gate.waiting, 'the gated tool');
      h.incoming('in-2', NEW_MESSAGE);
      await until(() => h.queued(NEW_MESSAGE), 'the message to queue');
      gate.release();
    }
    if (options.whileGated) {
      await until(() => gate.waiting && !internals.activeTurnTokens.has('other'), 'the gated tool');
      await options.whileGated(h);
      gate.release();
    }
    if (options.beforeEnd) await options.beforeEnd(h);
    if (hold) {
      await until(() => internals.providerAccelerationCooldowns.has('scout'), 'the provider hold');
      if (hold.during) await hold.during(h);
      internals.providerAccelerationCooldowns.get('scout')!.until = Date.now();
      internals.releaseProviderAccelerationCooldown('scout');
    }
    await until(() => streams >= 2 && !internals.activeTurnTokens.has('scout') && internals.pendingRequests.length === 0
      && !internals.providerAccelerationCooldowns.has('scout'), 'the turn to end');
    await framework.runUntilIdle();
    return {
      publishes: lines().filter((l) => l.event === 'publish').map((l) => [l.channelId, l.text]),
      drafts: internals.proseDrafts.open('scout').map((d) => [d.text, d.reason]),
      requests: membrane.calls,
      holds,
    };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const carriesPromise = (request: NormalizedRequest | undefined) => JSON.stringify(request ?? null).includes(PROMISE);
const read = (request: NormalizedRequest | undefined, body: string) => JSON.stringify(request ?? null).includes(body);
const heldAsSend = (run: Turn, line: string) => run.drafts.some(([t, reason]) => t === line && reason === 'explicit-send');
const answered = (run: Turn) => {
  assert.deepEqual(run.publishes, [[ROOM, REPLY]]);
  assert.ok(!run.drafts.some(([t]) => t === REPLY), 'the reply was not held');
};

describe('a start that continues the turn keeps a hold an explicit send set, until a new message reaches the agent', () => {
  for (const proseRouting of ['locus', 'hybrid'] as const) {
    it(`${proseRouting}: errorPolicy's retry after the stream fails keeps the line it writes held`, async () => {
      const run = await turn({ proseRouting, stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : final()) });
      assert.ok(carriesPromise(run.requests[1]), 'the retry read the notice that promised the hold');
      assert.deepEqual(run.publishes, []);
      assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
    });

    it(`${proseRouting}: a retry whose own start fails passes the hold to the retry after it`, async () => {
      const run = await turn({
        proseRouting,
        stream: (n) => {
          if (n === 1) return new ErrorsAfter([SEND, HELD], 2);
          if (n === 2) throw new Error('connection refused');
          return final();
        },
      });
      assert.equal(run.requests.length, 3);
      assert.deepEqual(run.publishes, []);
      assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
    });

    it(`${proseRouting}: the retry a provider hold keeps for the turn keeps the line it writes held`, async () => {
      const run = await turn({ proseRouting, hold: { error: 'provider unavailable' }, stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : final()) });
      assert.equal(run.holds, 1, 'the failure was held');
      assert.ok(carriesPromise(run.requests[1]));
      assert.deepEqual(run.publishes, []);
      assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
    });

    it(`${proseRouting}: a context-budget restart keeps the line its stream writes held`, async () => {
      const run = await turn({
        proseRouting, maxStreamTokens: 20,
        stream: (n) => (n === 1 ? new MockYieldingStream([SEND, overBudget(), createMockResponse([text(FINAL)])], true) : final()),
      });
      assert.equal(run.requests.length, 2, 'the stream restarted');
      assert.deepEqual(run.publishes, []);
      assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
    });

    it(`${proseRouting}: the provider hold's retry that reads a message sent during the hold answers it in the room`, async () => {
      const run = await turn({
        proseRouting, hold: { error: 'provider unavailable', during: async (h) => {
          h.incoming('in-2', NEW_MESSAGE);
          await h.until(() => h.stored(NEW_MESSAGE) || h.queued(NEW_MESSAGE), 'the message');
        } },
        stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : reply()),
      });
      assert.ok(read(run.requests[1], NEW_MESSAGE), 'the retry read the new message');
      answered(run);
      assert.equal(run.requests.length, 2, 'no later turn answered it');
    });

    it(`${proseRouting}: errorPolicy's retry after a boundary that took in a message answers it in the room`, async () => {
      const run = await turn({ proseRouting, messageWhileGated: true, stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : reply()) });
      assert.ok(read(run.requests[1], NEW_MESSAGE), 'the retry read the new message');
      answered(run);
      assert.equal(run.requests.length, 2, 'no later turn answered it');
    });

    it(`${proseRouting}: a context-budget restart at a boundary that took in a message answers it in the room`, async () => {
      const run = await turn({
        proseRouting, maxStreamTokens: 20, messageWhileGated: true,
        stream: (n) => (n === 1 ? new MockYieldingStream([SEND, overBudget(), createMockResponse([text(FINAL)])], true) : reply()),
      });
      assert.ok(read(run.requests[1], NEW_MESSAGE), 'the restart read the new message');
      answered(run);
      assert.equal(run.requests.length, 2, 'no later turn answered it');
    });
  }

  it('the retry a provider hold keeps after the stream throws keeps the line it writes held', async () => {
    const run = await turn({ proseRouting: 'locus', hold: { error: 'provider unavailable' }, stream: (n) => (n === 1 ? new ThrowsAfter([SEND, HELD]) : final()) });
    assert.equal(run.holds, 1, 'the throw was held');
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it("the retry a provider hold keeps after a retry's start fails keeps the line it writes held", async () => {
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'connection refused' },
      stream: (n) => {
        if (n === 1) return new ErrorsAfter([SEND, HELD], 2);
        if (n === 2) throw new Error('connection refused');
        return final();
      },
    });
    assert.equal(run.holds, 1, 'the failed start was held');
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it("a retry after a send to another channel speaks in the turn's own", async () => {
    const elsewhere = createMockResponse([text('Posting it there.'), call('s1', 'discord--send_message', { channelId: GENERAL, text: 'The report is up.' })], 'tool_use');
    const run = await turn({ proseRouting: 'locus', stream: (n) => (n === 1 ? new ErrorsAfter([elsewhere, HELD], 2) : final()) });
    assert.deepEqual(run.publishes, [[ROOM, 'Posting it there.'], [ROOM, 'Sent it, all done.'], [ROOM, FINAL]]);
  });

  it("a refused skip_reply's round with no send before it leaves nothing held: the budget restart after it speaks", async () => {
    const refused = createMockResponse([text('A note to myself.'), call('k1', 'skip_reply', { reason: 'continue later', wake_in_seconds: 60 })], 'tool_use');
    (refused as { usage: { inputTokens: number; outputTokens: number } }).usage = { inputTokens: 100, outputTokens: 5 };
    const run = await turn({
      proseRouting: 'locus', maxStreamTokens: 20,
      stream: (n) => (n === 1 ? new MockYieldingStream([refused, createMockResponse([text(FINAL)])], true) : final()),
    });
    assert.equal(run.requests.length, 2, 'the stream restarted');
    assert.deepEqual(run.publishes, [[ROOM, FINAL]]);
  });

  it("a refused skip_reply's round stays its own: the retry after it holds its line where the send posted", async () => {
    const refused = createMockResponse([text('A note to myself.'), call('k1', 'skip_reply', { reason: 'continue later', wake_in_seconds: 60 })], 'tool_use');
    const run = await turn({ proseRouting: 'locus', stream: (n) => (n === 1 ? new ErrorsAfter([SEND, refused], 2) : final()) });
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it('a silent heartbeat merged into the held retry leaves the line held', async () => {
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'provider unavailable', during: async (h) => {
        h.wake({ reason: 'mcpl:push-event', source: 'mcpl:heartbeat', timestamp: Date.now(), silentHeartbeat: { eventId: 'tick-1', serverId: 'heartbeat' } });
      } },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : final()),
    });
    assert.equal(run.requests.length, 2, 'the heartbeat started no turn of its own');
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it('overheard chatter stored during the hold, with no wake, clears the hold for the retry that reads it', async () => {
    const run = await turn({
      proseRouting: 'locus', gateWakesOnMentions: true, hold: { error: 'provider unavailable', during: async (h) => {
        h.incoming('in-2', CHATTER, 'ambient');
        await h.until(() => h.stored(CHATTER) || h.queued(CHATTER), 'the chatter');
      } },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : reply()),
    });
    assert.ok(read(run.requests[1], CHATTER), 'the retry read the chatter');
    answered(run);
  });

  it('a system change a host stores during the hold leaves the line held, since nothing was said to the agent', async () => {
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'provider unavailable', during: async (h) => {
        h.storeChange();
        await h.until(() => h.stored(CHANGE), 'the change');
      } },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : final()),
    });
    assert.equal(run.requests.length, 2, 'the change started no turn of its own');
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it("under 'entries', a system change handed to the round after a send leaves the retry's line held, since nothing was said to the agent", async () => {
    const run = await turn({
      proseRouting: 'locus', toolDeclarations: 'entries',
      whileGated: async (h) => {
        h.storeChange();
        await h.until(() => h.queued(CHANGE), 'the change to wait for the boundary');
      },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : final()),
    });
    assert.ok(read(run.requests[1], CHANGE), 'the retry carried the change');
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it("chatter queued while the failed stream's last request ran clears the hold for the held retry that reads it", async () => {
    let failing: ErrorsAfter | undefined;
    const run = await turn({
      proseRouting: 'locus', gateWakesOnMentions: true, hold: { error: 'provider unavailable' },
      stream: (n) => {
        if (n !== 1) return reply();
        failing = new ErrorsAfter([SEND, HELD], 2, true);
        return failing;
      },
      beforeEnd: async (h) => {
        await h.until(() => failing?.reached === true, 'the last request');
        h.incoming('in-2', CHATTER, 'ambient');
        await h.until(() => h.queued(CHATTER), 'the chatter to queue');
        failing!.fail();
      },
    });
    assert.ok(read(run.requests[1], CHATTER), 'the held retry read the chatter');
    answered(run);
  });

  it("XML tool mode: errorPolicy's retry keeps the turn's sends, which hold its line at the turn's end", async () => {
    // XML mode routes a tool turn's prose once, at its end, from the whole
    // completion (which repeats the turn's blocks with no calls of its own).
    const retryTurn = () => new MockYieldingStream([
      createMockResponse([text(FINAL), call('l2', 'channel_list')], 'tool_use'),
      { ...createMockResponse([text(FINAL), call('l2', 'channel_list')]), toolCalls: [] },
    ], true);
    const run = await turn({ proseRouting: 'locus', stream: (n) => new XmlModeStream(n === 1 ? new ErrorsAfter([SEND, HELD], 2) : retryTurn()) });
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it("a message another resident's window gets while the failed stream runs clears the hold for the retry that reads it", async () => {
    const run = await turn({
      proseRouting: 'locus', residents: true, whileGated: async (h) => { h.storeFor('other', CHATTER); },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : reply()),
    });
    assert.ok(read(run.requests[1], CHATTER), 'the retry read the message');
    answered(run);
  });

  it("a message stored while the retry gathers its context clears the hold for the compile that reads it", async () => {
    const run = await turn({
      proseRouting: 'locus', residents: true,
      gather: (h, agentName, n) => { if (agentName === 'scout' && n === 2) h.storeFor('other', CHATTER); },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : reply()),
    });
    assert.ok(read(run.requests[1], CHATTER), 'the retry read the message');
    answered(run);
  });

  it('a held retry that answers a new message and sends again keeps that send\'s hold through its own retry', async () => {
    const ack = createMockResponse([text('Got it.'), call('w0', 'gate--wait')], 'tool_use');
    const resend = createMockResponse([text('Answering.'), call('s2', 'discord--send_message', { channelId: ROOM, text: 'Yes, final.' })], 'tool_use');
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'provider unavailable', during: async (h) => {
        h.incoming('in-2', NEW_MESSAGE);
        await h.until(() => h.stored(NEW_MESSAGE) || h.queued(NEW_MESSAGE), 'the message');
      } },
      stream: (n) => {
        if (n === 1) return new ErrorsAfter([SEND, HELD], 2);
        if (n === 2) return new ErrorsAfter([ack, resend, HELD], 3);
        return final();
      },
    });
    assert.equal(run.requests.length, 3);
    assert.ok(read(run.requests[1], NEW_MESSAGE), 'the held retry read the new message');
    assert.ok(run.publishes.some(([channel, t]) => channel === ROOM && t === 'Got it.'), 'the new message ended the first hold');
    assert.ok(!run.publishes.some(([, t]) => t === FINAL), JSON.stringify(run.publishes));
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it('a message removed unread before the held retry starts leaves the line held', async () => {
    const run = await turn({
      proseRouting: 'locus', residents: true, hold: { error: 'provider unavailable', during: async (h) => {
        h.remove(h.storeFor('other', CHATTER));
      } },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : final()),
    });
    assert.ok(!read(run.requests[1], CHATTER), 'the message was gone before the retry');
    assert.deepEqual(run.publishes, []);
    assert.ok(heldAsSend(run, FINAL), JSON.stringify(run.drafts));
  });

  it("XML tool mode: a held retry that reads a new message answers it in the room", async () => {
    const replyTurn = () => new MockYieldingStream([
      createMockResponse([text(REPLY), call('l2', 'channel_list')], 'tool_use'),
      { ...createMockResponse([text(REPLY), call('l2', 'channel_list')]), toolCalls: [] },
    ], true);
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'provider unavailable', during: async (h) => {
        h.incoming('in-2', NEW_MESSAGE);
        await h.until(() => h.stored(NEW_MESSAGE) || h.queued(NEW_MESSAGE), 'the message');
      } },
      stream: (n) => new XmlModeStream(n === 1 ? new ErrorsAfter([SEND, HELD], 2) : replyTurn()),
    });
    assert.ok(read(run.requests[1], NEW_MESSAGE), 'the held retry read the new message');
    assert.ok(run.publishes.some(([channel, t]) => channel === ROOM && t === REPLY), JSON.stringify(run.publishes));
    assert.ok(!run.drafts.some(([t]) => t === REPLY), JSON.stringify(run.drafts));
  });

  it('a held retry that starts a new logical turn takes no hold into it', async () => {
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'provider unavailable', during: async (h) => h.endTurn() },
      stream: (n) => (n === 1 ? new ErrorsAfter([SEND, HELD], 2) : final()),
    });
    assert.deepEqual(run.publishes, [[ROOM, FINAL]]);
  });

  it('a held retry that opened a new turn and whose start then fails passes no hold to the retry after it', async () => {
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'provider unavailable', during: async (h) => h.endTurn() },
      stream: (n) => {
        if (n === 1) return new ErrorsAfter([SEND, HELD], 2);
        if (n === 2) throw new Error('connection refused');
        return final();
      },
    });
    assert.equal(run.requests.length, 3);
    assert.deepEqual(run.publishes, [[ROOM, FINAL]]);
  });

  it("a held retry that read a new message and whose start then fails passes no hold to the retry after it", async () => {
    const run = await turn({
      proseRouting: 'locus', hold: { error: 'provider unavailable', during: async (h) => {
        h.incoming('in-2', NEW_MESSAGE);
        await h.until(() => h.stored(NEW_MESSAGE) || h.queued(NEW_MESSAGE), 'the message');
      } },
      stream: (n) => {
        if (n === 1) return new ErrorsAfter([SEND, HELD], 2);
        if (n === 2) throw new Error('connection refused');
        return reply();
      },
    });
    assert.equal(run.requests.length, 3);
    assert.ok(read(run.requests[1], NEW_MESSAGE), 'the held retry read the new message');
    answered(run);
  });
});
