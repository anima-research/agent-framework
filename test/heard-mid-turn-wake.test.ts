/**
 * A wake for a write the agent heard mid-turn (issue #264).
 *
 * A message that arrives while a turn is alive is deferred, and its wake
 * waits behind the busy agent. At the turn's next tool boundary the message
 * is stored and injected, so the live turn reads it (hear-while-acting). The
 * wake then starts no turn of its own once nothing is left for the agent to
 * do: a request that carried the write was answered and, for a wake that
 * carries a channel, unless its message's server marked it ambient, the agent
 * has since published into that channel having read it. Hearing a message
 * isn't answering it, so such a wake whose channel the agent hasn't spoken in
 * since reading still starts its turn.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { GateConfig } from '../src/gate/types.js';
import { destinationKey } from '../src/mcpl/channel-registry.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';

const ROOM = 'chat:room';
const GENERAL = 'chat:general';

type Internals = {
  deferredMessages: Array<{ id: string }>;
  pendingRequests: Array<Record<string, unknown>>;
  turnRouting: Map<string, unknown>;
  agents: Map<string, unknown>;
  eventGate: { armSelfWake(agentName: string, seconds: number, source?: string): unknown; clearSleep(): boolean } | null;
  dispatchSleepToolCall(agentName: string, call: ToolCall): void;
  scriptWake(agentName: string, scriptId: string, text: string, label: string): Promise<void>;
  bounceProse(agent: unknown, text: string, reason: string, candidates: undefined, prefix: '>>', round: unknown): void;
  readsWriteFor(placement: { agent?: string; deferredId?: string; messageId?: string } | undefined, agentName: string): { readsDeferredWrite?: string; readsStoredMessage?: string };
  dispatchChannelToolCall(agentName: string, call: ToolCall): void;
};
const internals = (f: AgentFramework) => f as unknown as Internals;

async function until(done: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  for (const end = Date.now() + timeoutMs; !done();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Each tool holds its round open while `during` writes something, until
 *  that write is deferred, its wake waiting behind the busy agent. `wait`
 *  then lets the turn go on; `stop` ends it at its boundary, with nothing
 *  more said. Events with text make module messages and ask for inference. */
class HoldModule implements Module {
  readonly name = 'hold';
  framework: AgentFramework | null = null;
  during: (() => unknown) | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      { name: 'wait', description: 'Wait for something', inputSchema: { type: 'object', properties: {} } },
      { name: 'stop', description: 'End the turn', inputSchema: { type: 'object', properties: {} } },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    if (during) {
      const fw = internals(this.framework!);
      const queued = fw.deferredMessages.length;
      await during();
      await until(() => fw.deferredMessages.length > queued, 'the mid-turn write to be deferred');
    }
    if (call.name.endsWith('stop')) return { success: true, data: { stopped: true }, endTurn: true };
    return { success: true, data: { ok: true } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message' && event.type !== 'api:message' && event.type !== 'clock:reminder') return {};
    const { content, metadata, echoMetadata, messageMetadata } = event as unknown as {
      content: string | string[]; metadata?: Record<string, unknown>; echoMetadata?: false; messageMetadata?: Record<string, unknown>;
    };
    const texts = Array.isArray(content) ? content : [content];
    const added = messageMetadata ?? (echoMetadata !== false ? metadata : undefined);
    return {
      addMessages: texts.map((text) => ({
        participant: 'Antra',
        content: [{ type: 'text', text }],
        ...(added ? { metadata: added } : {}),
      })),
      requestInference: true,
    };
  }
}

/** A channel registry whose plain speech always lands in `locus`, and whose
 *  channel_publish delivers, or is refused; `publishes` records each
 *  channel_publish it answers. `holdSpeech` can keep a post from landing
 *  until a promise settles, `speech: 'undelivered'` lands none, and
 *  `speechAttempts` records each that comes to land. */
function stubChannelRegistry(
  framework: AgentFramework,
  locus: string,
  opts: {
    publish?: 'delivered' | 'refused';
    publishes?: Array<[string, 'delivered' | 'refused']>;
    holdSpeech?: (text: string) => Promise<void> | undefined;
    speech?: 'delivered' | 'undelivered' | 'reported-undelivered';
    speechAttempts?: string[];
  } = {},
) {
  const posted: Array<[string, string]> = [];
  // Channels are the chat server's, named as the registry names them.
  const channelIdOf = (c: { channelId: string } | string | null | undefined) => (typeof c === 'string' ? c : c?.channelId);
  const explicit: Record<string, unknown> = {
    resolveLocus: () => ({ serverId: 'chat', channelId: locus }),
    routeSpeech: async (_agent: string, text: string, target?: { serverId: string; channelId: string } | null) => {
      await opts.holdSpeech?.(text);
      opts.speechAttempts?.push(text);
      const channelId = channelIdOf(target);
      if (!channelId) return null;
      // An undelivered post as the registry returns one (null), and in the
      // other shape its type allows for one.
      if (opts.speech === 'undelivered') return null;
      if (opts.speech === 'reported-undelivered') return { delivered: false, serverId: 'chat', channelId };
      posted.push([text, channelId]);
      return { delivered: true, serverId: 'chat', channelId };
    },
    handleChannelToolCall: async (
      name: string,
      input: { channelId: string; content: string },
      _origin: unknown,
      seen?: { outcome?: unknown },
    ) => {
      if (name !== 'channel_publish') return { success: false, error: `${name} isn't stubbed`, isError: true };
      const destination = { serverId: 'chat', channelId: input.channelId };
      opts.publishes?.push([input.channelId, opts.publish ?? 'delivered']);
      if (opts.publish === 'refused') {
        if (seen) seen.outcome = { status: 'failed', destination, reason: 'refused', at: Date.now() };
        return { success: false, error: 'refused', isError: true };
      }
      posted.push([input.content, input.channelId]);
      if (seen) seen.outcome = { status: 'delivered', destination, at: Date.now() };
      return { success: true, data: {} };
    },
    // Hybrid prose: `>>>#room` names room, and a post to it lands.
    resolveProseTarget: (target: string) => ({ serverId: 'chat', channelId: target === '#room' ? ROOM : GENERAL }),
    deliverSpeech: async (_agent: string, body: string, channel: { channelId: string } | string) => {
      const channelId = channelIdOf(channel)!;
      posted.push([body, channelId]);
      return { status: 'delivered', destination: { serverId: 'chat', channelId }, at: Date.now() };
    },
    channelsNamed: (name: string) => [{ serverId: 'chat', channelId: name }],
    nameShown: (channel: { channelId: string }) => channel.channelId,
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return posted;
}

/** Each turn its own responses, its rounds on membrane's native path, which
 *  carries injected messages into the next round. Returns the turns' streams. */
function scheduleTurns(membrane: MockMembrane, turns: NormalizedResponse[][]): MockYieldingStream[] {
  const streams: MockYieldingStream[] = [];
  (membrane as unknown as { streamYielding: (req: NormalizedRequest) => MockYieldingStream }).streamYielding = (req) => {
    membrane.calls.push(req);
    const stream = new MockYieldingStream(turns[streams.length] ?? [createMockResponse([text('fallback')])], true);
    streams.push(stream);
    membrane.lastStream = stream;
    return stream;
  };
  return streams;
}

/** What a turn heard at its tool boundaries. */
const heardIn = (stream: MockYieldingStream | undefined) => JSON.stringify(stream?.receivedToolResultOptions ?? []);

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const call = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const go = () => ({ type: 'external-message', source: 'test', content: 'go' }) as unknown as ProcessEvent;
const channelMessage = (channelId: string, messageId: string, body: string, addressed = true) => ({
  type: 'mcpl:channel-incoming',
  serverId: 'chat',
  channelId,
  messageId,
  author: { id: 'u-1', name: 'someone' },
  content: [text(body)],
  timestamp: new Date().toISOString(),
  tags: addressed ? ['chat:mention', 'chat:addressed'] : ['chat:ambient'],
  triggerInference: true,
}) as unknown as ProcessEvent;

/** A stream whose two tool rounds come without verbatim round content, so
 *  the framework routes the turn's prose at its end (the fallback path),
 *  though it declares that it carries injected messages; then it completes
 *  with `final`. */
class RoundsWithoutContent implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  injected: unknown[] = [];
  private resume: (() => void) | null = null;
  private resumed = false;
  constructor(private final: NormalizedResponse) {}
  provideToolResults(_results: unknown[], options?: { injectedMessages?: unknown[] }): void {
    this.injected.push(...(options?.injectedMessages ?? []));
    this.isWaitingForTools = false;
    this.resumed = true;
    this.resume?.();
  }
  cancel(): void {
    this.resumed = true;
    this.resume?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (const id of ['c1', 'c2']) {
      this.isWaitingForTools = true;
      this.pendingToolCallIds = [id];
      this.resumed = false;
      yield {
        type: 'tool-calls',
        calls: [{ id, name: 'hold--wait', input: {} }],
        context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', supportsInjectedMessages: true },
      } as StreamEvent;
      if (!this.resumed) await new Promise<void>((resolve) => { this.resume = resolve; });
    }
    yield { type: 'complete', response: this.final } as StreamEvent;
  }
}

/** One tool round, on membrane's native path; then the request that carries
 *  the round's results, and what its boundary injected, fails, and the
 *  stream ends with an error. */
class RoundThenFails implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  injected: unknown[] = [];
  private resume: (() => void) | null = null;
  private resumed = false;
  provideToolResults(_results: unknown[], options?: { injectedMessages?: unknown[] }): void {
    this.injected.push(...(options?.injectedMessages ?? []));
    this.isWaitingForTools = false;
    this.resumed = true;
    this.resume?.();
  }
  cancel(): void {
    this.resumed = true;
    this.resume?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const wait = { type: 'tool_use' as const, id: 'c1', name: 'hold--wait', input: {} };
    this.isWaitingForTools = true;
    this.pendingToolCallIds = [wait.id];
    yield {
      type: 'tool-calls',
      calls: [{ id: wait.id, name: wait.name, input: {} }],
      context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: [wait], supportsInjectedMessages: true },
    } as StreamEvent;
    if (!this.resumed) await new Promise<void>((resolve) => { this.resume = resolve; });
    yield { type: 'error', error: new Error('the provider is down') } as StreamEvent;
  }
}

/** A script's call through the bridge, answered: its result reaches the
 *  bridge as an event, so the framework is run until the answer comes. A
 *  call that rejects throws its own error. */
async function bridgeAnswer<T>(framework: AgentFramework, pending: Promise<T>): Promise<T> {
  let settled: { value: T } | { error: unknown } | undefined;
  pending.then((value) => { settled = { value }; }, (error: unknown) => { settled = { error }; });
  for (const end = Date.now() + 10_000; settled === undefined;) {
    if (Date.now() > end) throw new Error("the bridge's call got no answer within 10 s");
    await framework.runUntilIdle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if ('error' in settled) throw settled.error;
  return settled.value;
}

/** A turn that waits on a tool while something arrives, then goes on. */
const heardThen = (...next: NormalizedResponse[]) => [
  createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'),
  ...next,
];
const stopping = () => createMockResponse([call('c9', 'hold--stop')], 'tool_use');

describe('a wake for a write heard mid-turn', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: HoldModule;
  // The scheduler's drop of a marked wake, as it logs it: a turn that didn't
  // start because its wake was dropped, not because none was queued.
  let drops: string[];
  const consoleError = console.error;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'heard-wake-'));
    membrane = new MockMembrane();
    module = new HoldModule();
    drops = [];
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[wake] assistant: dropped')) drops.push(line);
      else consoleError(...args);
    };
  });

  afterEach(() => {
    console.error = consoleError;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const droppedOne = () => assert.ok(drops.length === 1 && drops[0]!.includes('dropped 1 wake(s)'), `its marked wake was dropped: ${JSON.stringify(drops)}`);

  async function createFramework(opts: { gate?: GateConfig; proseRouting?: 'hybrid' | 'explicit'; noRetries?: boolean } = {}): Promise<AgentFramework> {
    const { gate, proseRouting, noRetries } = opts;
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', ...(proseRouting ? { proseRouting } : {}) }],
      modules: [module],
      ...(gate ? { gate: { config: gate } } : {}),
      ...(noRetries ? { errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } } : {}),
    });
    module.framework = framework;
    return framework;
  }

  // -------------------------------------------------------------------------
  // A wake that carries a channel

  // Its answer can be the turn's last words, a later round's words while
  // the turn goes on, or, in hybrid mode, either one addressed with `>>>`.
  const answers: Array<[string, 'hybrid' | undefined, string, NormalizedResponse[]]> = [
    ['in its final reply (#264)', undefined, 'heard you', [createMockResponse([text('heard you')])]],
    ["in a later round's words", undefined, 'on it', [createMockResponse([text('on it'), call('c2', 'hold--wait')], 'tool_use'), stopping()]],
    ['in a final reply addressed there', 'hybrid', 'heard you', [createMockResponse([text('>>>#room heard you')])]],
    ["in a later round's words addressed there", 'hybrid', 'on it', [createMockResponse([text('>>>#room on it'), call('c2', 'hold--wait')], 'tool_use'), stopping()]],
  ];
  for (const [how, proseRouting, answer, rest] of answers) {
    it(`a channel message the turn heard and then answered in its channel, ${how}, starts no turn of its own`, async () => {
      const streams = scheduleTurns(membrane, [heardThen(...rest)]);
      const framework = await createFramework({ proseRouting });
      // Hybrid's unaddressed words go to general, so only the address answers.
      const posted = stubChannelRegistry(framework, proseRouting ? GENERAL : ROOM);
      module.during = () => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this'));

      framework.pushEvent(go());
      await framework.runUntilIdle();

      assert.ok(heardIn(streams[0]).includes('also this'), 'the turn heard the message at its tool boundary');
      assert.ok(posted.some(([t, channelId]) => t === answer && channelId === ROOM), `answered in room: ${JSON.stringify(posted)}`);
      assert.equal(membrane.calls.length, 1, 'its wake started no turn: the agent answered it in its channel');
      droppedOne();
      assert.equal(internals(framework).pendingRequests.length, 0);
      await framework.stop();
    });
  }

  // A turn with no tool round reads everything it will before it speaks, so
  // its words answer what its request held.
  for (const [proseRouting, reply] of [[undefined, 'hello'], ['hybrid', '>>>#room hello']] as const) {
    it(`a text-only reply${proseRouting ? ' addressed with >>>' : ''} is noted as a publish into its channel, made having read its request`, async () => {
      scheduleTurns(membrane, [[createMockResponse([text(reply)])]]);
      const framework = await createFramework({ proseRouting });
      const posted = stubChannelRegistry(framework, proseRouting ? GENERAL : ROOM);

      framework.pushEvent(go());
      await framework.runUntilIdle();

      assert.deepEqual(posted, [['hello', ROOM]]);
      const agent = framework.getAgent('assistant') as unknown as {
        getConsumedWatermark(): { branch: string; sequence: number };
        publishedAfterReading(channelId: string, branch: string, sequence: number): boolean;
      };
      const read = agent.getConsumedWatermark();
      const room = destinationKey({ serverId: 'chat', channelId: ROOM });
      assert.equal(agent.publishedAfterReading(room, read.branch, read.sequence), true, 'noted with what its request read');
      assert.equal(agent.publishedAfterReading(room, read.branch, read.sequence + 1), false, 'and nothing stored after');
      await framework.stop();
    });
  }

  it('a channel message the turn heard, when the turn spoke only elsewhere after, keeps its wake', async () => {
    const streams = scheduleTurns(membrane, [
      heardThen(createMockResponse([text('done over here')])),
      [createMockResponse([text('now, about room')])],
    ]);
    const framework = await createFramework();
    const posted = stubChannelRegistry(framework, GENERAL);
    // Neither tag: an addressed message would re-pin the turn to room, and
    // one its server marked ambient asks no answer there.
    module.during = () => framework.pushEvent({ ...channelMessage(ROOM, 'm-mid', 'a word in room'), tags: undefined } as unknown as ProcessEvent);

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(heardIn(streams[0]).includes('a word in room'), 'the turn heard the message at its tool boundary');
    assert.equal(membrane.calls.length, 2, 'its wake started the turn: the agent never spoke in room after hearing it');
    assert.deepEqual(drops, []);
    assert.deepEqual(posted.slice(0, 2), [['checking', GENERAL], ['done over here', GENERAL]]);
    await framework.stop();
  });

  // A send tool whose channel the framework records answers there too: its
  // note goes under the channel its open resolves, the key the wake holds.
  it("a channel message the turn heard and then answered with a server's send_message in its channel starts no turn of its own", async () => {
    const streams = scheduleTurns(membrane, [heardThen(
      createMockResponse([call('s2', 'chat--send_message', { channelId: ROOM, text: 'heard you' })], 'tool_use'),
      stopping(),
    )]);
    const framework = await createFramework();
    stubChannelRegistry(framework, GENERAL);
    const fw = framework as unknown as {
      channelRegistry: Record<string, unknown>;
      mcplServerRegistry: unknown;
      mcplServerConfigs: Map<string, unknown>;
      mcplPrefixMap: Map<string, string>;
      mcplToolFeatureSets: Map<string, unknown>;
    };
    const sent: unknown[] = [];
    fw.mcplServerRegistry = {
      getServer: (id: string) => id === 'chat' ? {
        id: 'chat',
        sendToolsCall: async (...args: unknown[]) => { sent.push(args); return { content: [{ type: 'text', text: 'sent' }] }; },
      } : null,
      getAllServers: () => [],
      closeAll: async () => {},
    };
    fw.mcplServerConfigs = new Map([['chat', { id: 'chat', toolPrefix: 'chat' }]]);
    fw.mcplPrefixMap = new Map([['chat', 'chat']]);
    fw.mcplToolFeatureSets = new Map();
    const registry = new Proxy(fw.channelRegistry, {
      get: (target, prop: string) => prop === 'openIfClosedForSend'
        ? async () => ({ status: 'already-open', channelId: ROOM })
        : prop === 'directsLifecycle' ? () => true
        : (target as Record<string, unknown>)[prop],
    });
    fw.channelRegistry = registry;
    module.during = () => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this'));

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(heardIn(streams[0]).includes('also this'), 'the turn heard the message at its tool boundary');
    assert.equal(sent.length, 1, 'the server got the send');
    assert.equal(membrane.calls.length, 1, 'its wake started no turn: the agent answered it in its channel');
    droppedOne();
    await framework.stop();
  });

  // In explicit mode the answer is addressed with `>>`. The turn's first
  // round says nothing, since explicit mode holds unaddressed words.
  it('a channel message the turn heard and then answered in its channel, in a final reply addressed there with >>, starts no turn of its own', async () => {
    const streams = scheduleTurns(membrane, [[
      createMockResponse([call('c1', 'hold--wait')], 'tool_use'),
      createMockResponse([text('>>#room heard you')]),
    ]]);
    const framework = await createFramework({ proseRouting: 'explicit' });
    const posted = stubChannelRegistry(framework, GENERAL);
    module.during = () => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this'));

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(heardIn(streams[0]).includes('also this'), 'the turn heard the message at its tool boundary');
    assert.ok(posted.some(([t, channelId]) => t === 'heard you' && channelId === ROOM), `answered in room: ${JSON.stringify(posted)}`);
    assert.equal(membrane.calls.length, 1, 'its wake started no turn: the agent answered it in its channel');
    droppedOne();
    await framework.stop();
  });

  // An ambient message asked nothing of the agent: once a request that
  // carried it is answered, reading it was all its wake was for.
  it('an ambient channel message the turn heard starts no turn of its own, though the turn spoke only elsewhere after', async () => {
    const streams = scheduleTurns(membrane, [
      heardThen(createMockResponse([text('done over here')])),
      [createMockResponse([text('now, about room')])],
    ]);
    const framework = await createFramework();
    const posted = stubChannelRegistry(framework, GENERAL);
    module.during = () => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'a word in room', false));

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(heardIn(streams[0]).includes('a word in room'), 'the turn heard the message at its tool boundary');
    assert.ok(!posted.some(([, channelId]) => channelId === ROOM), `nothing was said in room: ${JSON.stringify(posted)}`);
    assert.equal(membrane.calls.length, 1, 'its wake started no turn');
    droppedOne();
    await framework.stop();
  });

  // A push can carry a channel (its origin's mcplChannelId), and its wake is
  // judged by the same key a publish there records.
  // An addressed push re-pins the turn to its channel, so the case that
  // speaks only elsewhere is one with neither tag.
  const channelPush = (tag: 'chat:addressed' | 'chat:ambient' | undefined) => ({
    type: 'mcpl:push-event', serverId: 'chat', featureSet: 'notify', eventId: 'e-room',
    content: [text('a push in room')], triggerInference: true,
    origin: { mcplChannelId: ROOM, channelName: 'room' }, ...(tag ? { tags: [tag] } : {}),
  }) as unknown as ProcessEvent;
  for (const [what, tag, locus, kept] of [
    ['an addressed push with a channel, heard and then answered in its channel, starts no turn of its own', 'chat:addressed', ROOM, false],
    ['a push with a channel and neither tag, heard and not answered in its channel, keeps its wake', undefined, GENERAL, true],
    ['an ambient push with a channel, heard and not answered in its channel, starts no turn of its own', 'chat:ambient', GENERAL, false],
  ] as const) {
    it(what, async () => {
      const streams = scheduleTurns(membrane, [heardThen(createMockResponse([text('noted')])), [createMockResponse([text('again')])]]);
      const framework = await createFramework();
      const posted = stubChannelRegistry(framework, locus);
      module.during = () => framework.pushEvent(channelPush(tag));

      framework.pushEvent(go());
      await framework.runUntilIdle();

      assert.ok(heardIn(streams[0]).includes('a push in room'), 'the turn heard the push at its tool boundary');
      assert.ok(posted.some(([t, channelId]) => t === 'noted' && channelId === locus), `the reply went to ${locus}: ${JSON.stringify(posted)}`);
      if (kept) {
        assert.equal(membrane.calls.length, 2, 'its wake started the turn');
        assert.deepEqual(drops, []);
      } else {
        assert.equal(membrane.calls.length, 1, 'its wake started no turn');
        droppedOne();
      }
      await framework.stop();
    });
  }

  it('a channel message heard after the turn spoke in its channel keeps its wake when nothing is said there after, however late the earlier words land', async () => {
    const streams = scheduleTurns(membrane, [heardThen(stopping()), [createMockResponse([text('answering room')])]]);
    const framework = await createFramework();
    // The round's words post only once the boundary has marked the message
    // read: they were written before it, so they don't answer it.
    let markRead!: () => void;
    const read = new Promise<void>((resolve) => { markRead = resolve; });
    framework.onTrace((event) => {
      if (event.type === 'inference:stream_resumed' && (event as { injectedMessages?: number }).injectedMessages) markRead();
    });
    const posted = stubChannelRegistry(framework, ROOM, { holdSpeech: (t) => (t === 'checking' ? read : undefined) });
    module.during = () => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this'));

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(heardIn(streams[0]).includes('also this'), 'the turn heard the message at its tool boundary');
    assert.deepEqual(posted[0], ['checking', ROOM], "the earlier round's words posted to room");
    assert.equal(membrane.calls.length, 2, 'its wake started the turn: nothing said in room after hearing it');
    assert.deepEqual(drops, []);
    await framework.stop();
  });

  for (const publish of ['delivered', 'refused'] as const) {
    it(`a channel_publish into the message's channel after hearing it ${publish === 'delivered' ? 'answers it' : "doesn't answer it when refused"}`, async () => {
      const streams = scheduleTurns(membrane, [
        heardThen(
          createMockResponse([call('p1', 'channel_publish', { channelId: ROOM, content: 'noted, thanks' })], 'tool_use'),
          stopping(),
        ),
        [createMockResponse([text('answering room')])],
      ]);
      const framework = await createFramework();
      const publishes: Array<[string, 'delivered' | 'refused']> = [];
      stubChannelRegistry(framework, GENERAL, { publish, publishes });
      module.during = () => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this'));

      framework.pushEvent(go());
      await framework.runUntilIdle();

      assert.ok(heardIn(streams[0]).includes('also this'), 'the turn heard the message at its tool boundary');
      assert.deepEqual(publishes, [[ROOM, publish]], `the publish into room was ${publish}`);
      assert.equal(membrane.calls.length, publish === 'delivered' ? 1 : 2,
        publish === 'delivered' ? 'its wake started no turn' : 'its wake started the turn');
      if (publish === 'delivered') droppedOne();
      else assert.deepEqual(drops, []);
      await framework.stop();
    });
  }

  it('a channel message the turn heard, then a sleep announced in its channel, starts no turn of its own', async () => {
    const streams = scheduleTurns(membrane, [
      heardThen(createMockResponse([call('s1', 'sleep', { seconds: 60 })], 'tool_use')),
      [createMockResponse([text('awake again')])],
    ]);
    const framework = await createFramework({ gate: { policies: [], default: 'always' } });
    const posted = stubChannelRegistry(framework, ROOM);
    module.during = () => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this'));

    framework.pushEvent(go());
    await framework.runUntilIdle();
    internals(framework).eventGate!.clearSleep();

    assert.ok(heardIn(streams[0]).includes('also this'), 'the turn heard the message at its tool boundary');
    assert.ok(posted.some(([t, channelId]) => t.startsWith('💤 Going quiet') && channelId === ROOM), `the sleep was announced in room: ${JSON.stringify(posted)}`);
    assert.equal(membrane.calls.length, 1, 'its wake started no turn: the agent spoke in room after hearing it');
    droppedOne();
    await framework.stop();
  });

  // The announcement goes to the turn's locus, or in explicit mode to its
  // pin, and is noted once it's delivered, with what the agent had read at
  // the call, however late it lands. One made outside the turn isn't
  // announced at all (callingTurnOf).
  const roomRef = { serverId: 'chat', channelId: ROOM };
  for (const [where, proseRouting, routing, turnId, speech, noted] of [
    ['in the locus', undefined, { locus: roomRef }, 1, 'delivered', true],
    ['at an explicit pin', 'explicit', { pin: roomRef }, 1, 'delivered', true],
    ['in the locus but not delivered', undefined, { locus: roomRef }, 1, 'undelivered', false],
    ['in the locus, reported not delivered', undefined, { locus: roomRef }, 1, 'reported-undelivered', false],
  ] as const) {
    it(`a sleep announced ${where} is ${noted ? 'noted as a publish there once it lands, with what the agent had read at the call' : 'not noted as a publish'}`, async () => {
      const framework = await createFramework({ gate: { policies: [], default: 'always' }, proseRouting });
      let land!: () => void;
      const landed = new Promise<void>((resolve) => { land = resolve; });
      const attempts: string[] = [];
      const posted = stubChannelRegistry(framework, ROOM, { holdSpeech: () => landed, speech, speechAttempts: attempts });
      const fw = internals(framework);
      fw.turnRouting.set('assistant', { turnId: 1, wasIn: [], engaged: new Set(), ...routing });
      const agent = framework.getAgent('assistant') as unknown as {
        getConsumedWatermark(): { branch: string; sequence: number };
        markContextConsumed(): void;
        getContextManager(): { addMessage(participant: string, content: unknown[]): unknown };
        publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
      };
      agent.getContextManager().addMessage('Antra', [text('earlier words')]);
      agent.markContextConsumed();
      const atCall = agent.getConsumedWatermark();

      fw.dispatchSleepToolCall('assistant', { id: 's1', name: 'sleep', input: { seconds: 60 }, ...(turnId ? { callerTurnId: turnId } : {}) });
      const room = destinationKey({ serverId: 'chat', channelId: ROOM });
      assert.equal(agent.publishedAfterReading(room, atCall.branch, atCall.sequence), false, 'nothing is noted before it lands');
      // The agent reads more before the announcement lands.
      agent.getContextManager().addMessage('Antra', [text('later words')]);
      agent.markContextConsumed();
      const later = agent.getConsumedWatermark();
      assert.ok(later.sequence > atCall.sequence, 'the agent read more');
      land();
      await until(() => attempts.length > 0, 'the announcement to come to land');
      fw.eventGate!.clearSleep();

      assert.deepEqual(posted.map(([, channelId]) => channelId), speech === 'delivered' ? [ROOM] : []);
      assert.equal(agent.publishedAfterReading(room, atCall.branch, atCall.sequence), noted);
      assert.equal(agent.publishedAfterReading(room, later.branch, later.sequence), false, 'and not with what it read after the call');
      await framework.stop();
    });
  }

  it("a write marks the wake of the agent it went to with the id it was deferred or stored under, and another agent's wake stays plain", async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    assert.deepEqual(fw.readsWriteFor({ agent: 'assistant', deferredId: 'd-1' }, 'assistant'), { readsDeferredWrite: 'd-1' });
    assert.deepEqual(fw.readsWriteFor({ agent: 'assistant', deferredId: 'd-1' }, 'helper'), {}, "another agent's wake stays plain");
    assert.deepEqual(fw.readsWriteFor({ agent: 'assistant', messageId: 'm-1' }, 'assistant'), { readsStoredMessage: 'm-1' },
      'a wake can wait while a request reads a stored write, as behind a held continuation');
    assert.deepEqual(fw.readsWriteFor({ agent: 'assistant', messageId: 'm-1' }, 'helper'), {}, "another agent's wake stays plain");
    await framework.stop();
  });

  // -------------------------------------------------------------------------
  // A wake without a channel: read is done

  const unchanneled: Array<[string, (framework: AgentFramework) => unknown, string]> = [
    ['a push with no channel', (framework) => framework.pushEvent({
      type: 'mcpl:push-event', serverId: 'chat', featureSet: 'notify', eventId: 'e-1',
      content: [text('the build finished')], triggerInference: true,
    } as unknown as ProcessEvent), 'the build finished'],
    ["a module's one message", (framework) => framework.pushEvent({
      type: 'clock:reminder', source: 'clock', content: 'the kettle is on',
    } as unknown as ProcessEvent), 'the kettle is on'],
    ["a background script's wake", (framework) => internals(framework).scriptWake(
      'assistant', 'script-1', '[background-script script-1] finished: 42', 'wake',
    ), 'finished: 42'],
  ];
  for (const [what, write] of unchanneled) {
    it(`${what}, heard at the boundary, starts no turn of its own`, async () => {
      const streams = scheduleTurns(membrane, [heardThen(createMockResponse([text('all done')])), [createMockResponse([text('again')])]]);
      const framework = await createFramework();
      stubChannelRegistry(framework, ROOM);
      module.during = () => write(framework);

      framework.pushEvent(go());
      await framework.runUntilIdle();

      assert.ok(streams[0]!.receivedToolResultOptions.some((o) => (o?.injectedMessages?.length ?? 0) > 0),
        'the turn heard it at its tool boundary');
      assert.equal(membrane.calls.length, 1, 'its wake started no turn');
      droppedOne();
      await framework.stop();
    });
  }

  const storedAsItArrives: Array<[string, string, (framework: AgentFramework) => unknown]> = [
    ...unchanneled.map(([what, write, shown]): [string, string, (framework: AgentFramework) => unknown] => [what, shown, write]),
    ['a channel message', 'also this', (framework) => framework.pushEvent(channelMessage(ROOM, 'm-1', 'also this'))],
    ["the gate's self-wake notice", '[self-wake] your test timer', (framework) => internals(framework).eventGate!.armSelfWake('assistant', 1, 'test')],
  ];
  for (const [what, shown, write] of storedAsItArrives) {
    it(`${what}, stored while the agent has no turn, gives its wake the stored row's id`, async () => {
      const framework = await createFramework(what.includes('self-wake') ? { gate: { policies: [], default: 'always' } } : {});
      stubChannelRegistry(framework, ROOM);
      const triggers: Array<Record<string, unknown>> = [];
      (framework as unknown as { startAgentStream: (agent: unknown, trigger: unknown) => Promise<unknown> }).startAgentStream =
        async (_agent, trigger) => { triggers.push(trigger as Record<string, unknown>); return undefined; };
      write(framework);
      for (const end = Date.now() + 5000; triggers.length === 0 && Date.now() < end;) {
        await framework.runUntilIdle();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const row = framework.getAgent('assistant')!.getContextManager().getAllMessages()
        .find((m) => JSON.stringify(m.content).includes(shown));
      assert.ok(row, `${what} was stored`);
      assert.deepEqual(triggers.map((r) => r.readsStoredMessage), [row.id], "its wake's turn would start for the row it names");
      await framework.stop();
    });
  }

  // A refusal is the provider's answer to the request that carried the
  // write: a turn after it would compile the same context. A channel's wake
  // still waits for the agent to speak there.
  for (const [what, write, kept] of [
    ['a push with no channel', unchanneled[0]![1], false],
    ['a channel message', (framework: AgentFramework) => framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this')), true],
  ] as const) {
    it(`${what}, heard at the boundary of a request that ends in a refusal, ${kept ? 'keeps its wake' : 'starts no turn of its own'}`, async () => {
      const streams = scheduleTurns(membrane, [heardThen(createMockResponse([], 'refusal')), [createMockResponse([text('again')])]]);
      const framework = await createFramework();
      stubChannelRegistry(framework, ROOM);
      module.during = () => write(framework);

      framework.pushEvent(go());
      await framework.runUntilIdle();

      assert.ok(streams[0]!.receivedToolResultOptions.some((o) => (o?.injectedMessages?.length ?? 0) > 0),
        'the turn heard it at its tool boundary');
      assert.equal(membrane.calls.length, kept ? 2 : 1, kept ? 'its wake started the turn' : 'its wake started no turn');
      if (kept) assert.deepEqual(drops, []); else droppedOne();
      await framework.stop();
    });
  }

  it("the gate's self-wake notice, heard at the boundary, starts no turn of its own", async () => {
    const streams = scheduleTurns(membrane, [heardThen(createMockResponse([text('all done')])), [createMockResponse([text('again')])]]);
    const framework = await createFramework({ gate: { policies: [], default: 'always' } });
    stubChannelRegistry(framework, ROOM);
    module.during = () => internals(framework).eventGate!.armSelfWake('assistant', 1, 'test');

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(heardIn(streams[0]).includes('[self-wake] your test timer'), 'the turn heard the notice at its tool boundary');
    assert.equal(membrane.calls.length, 1, 'its wake started no turn');
    droppedOne();
    await framework.stop();
  });

  // deferred-wake-integrity's invariant 3, for a marked wake: an endTurn
  // boundary stores what it drained without injecting it, so nothing read it.
  it('a write stored at an endTurn boundary keeps its wake, which starts the turn that reads it', async () => {
    const streams = scheduleTurns(membrane, [[stopping()], [createMockResponse([text('reading it now')])]]);
    const framework = await createFramework();
    stubChannelRegistry(framework, ROOM);
    module.during = () => framework.pushEvent({ type: 'clock:reminder', source: 'clock', content: 'the kettle is on' } as unknown as ProcessEvent);

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.equal(heardIn(streams[0]).includes('the kettle is on'), false, 'the endTurn boundary injected nothing');
    assert.equal(membrane.calls.length, 2, 'its wake started the turn');
    assert.deepEqual(drops, []);
    assert.ok(JSON.stringify(membrane.calls[1]).includes('the kettle is on'));
    await framework.stop();
  });

  // On the fallback path (rounds without verbatim content), the prose routed
  // at the turn's end is the whole turn's, words written before a boundary
  // included, so it answers only what the turn's first request had read,
  // though a later round's request read the message.
  it('on the fallback path, a channel message heard at a boundary keeps its wake though the turn spoke in its channel at its end', async () => {
    const stream = new RoundsWithoutContent(createMockResponse([text('heard you')]));
    (membrane as unknown as { streamYielding: (req: NormalizedRequest) => YieldingStream }).streamYielding = (req) => {
      membrane.calls.push(req);
      // The kept wake's turn says nothing, so the only publish noted is the
      // first turn's.
      return membrane.calls.length === 1 ? stream : new MockYieldingStream([createMockResponse([])], true);
    };
    const framework = await createFramework();
    const posted = stubChannelRegistry(framework, ROOM);
    const agent = framework.getAgent('assistant') as unknown as {
      getConsumedWatermark(): { branch: string; sequence: number };
      publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
    };
    let firstRead!: { branch: string; sequence: number };
    module.during = () => {
      // During the first round's tool call: what the first request had read.
      firstRead = agent.getConsumedWatermark();
      return framework.pushEvent(channelMessage(ROOM, 'm-mid', 'also this'));
    };

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(JSON.stringify(stream.injected).includes('also this'), 'the boundary handed the stream the message');
    assert.ok(posted.some(([t, channelId]) => t === 'heard you' && channelId === ROOM), `the turn spoke in room at its end: ${JSON.stringify(posted)}`);
    assert.equal(agent.publishedAfterReading(destinationKey({ serverId: 'chat', channelId: ROOM }), firstRead.branch, firstRead.sequence), true,
      "the end's prose is noted as a publish made having read what the first request had");
    assert.equal(membrane.calls.length, 2, 'its wake started the turn');
    assert.deepEqual(drops, []);
    await framework.stop();
  });

  it('a write heard at a boundary keeps its wake when the request that carried it fails', async () => {
    const failing = new RoundThenFails();
    (membrane as unknown as { streamYielding: (req: NormalizedRequest) => YieldingStream }).streamYielding = (req) => {
      membrane.calls.push(req);
      return membrane.calls.length === 1 ? failing : new MockYieldingStream([createMockResponse([text('reading it now')])], true);
    };
    const framework = await createFramework({ noRetries: true });
    stubChannelRegistry(framework, ROOM);
    module.during = () => framework.pushEvent({ type: 'clock:reminder', source: 'clock', content: 'the kettle is on' } as unknown as ProcessEvent);

    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(JSON.stringify(failing.injected).includes('the kettle is on'), 'the boundary handed the stream the write');
    assert.equal(membrane.calls.length, 2, 'its wake started the turn: no answered request carried it');
    assert.deepEqual(drops, []);
    assert.ok(JSON.stringify(membrane.calls[1]).includes('the kettle is on'));
    await framework.stop();
  });

  it("a channel_publish made in no turn, as a background script's is, isn't noted as a publish", async () => {
    const framework = await createFramework();
    const publishes: Array<[string, 'delivered' | 'refused']> = [];
    stubChannelRegistry(framework, ROOM, { publishes });
    const fw = internals(framework);
    const results: string[] = [];
    const push = framework.pushEvent.bind(framework);
    (framework as unknown as { pushEvent: (event: { type: string; callId?: string }) => void }).pushEvent = (event) => {
      if (event.type === 'tool-result' && event.callId) results.push(event.callId);
      push(event as never);
    };
    const agent = framework.getAgent('assistant') as unknown as {
      getConsumedWatermark(): { branch: string; sequence: number };
      publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
    };
    const room = destinationKey({ serverId: 'chat', channelId: ROOM });
    const branch = agent.getConsumedWatermark().branch;

    // The agent is in a turn, which the script's call isn't made in.
    fw.turnRouting.set('assistant', { turnId: 1, wasIn: [], engaged: new Set() });
    fw.dispatchChannelToolCall('assistant', { id: 'from-script', name: 'channel_publish', input: { channelId: ROOM, content: 'a script posts' } });
    await until(() => results.includes('from-script'), 'the script\'s publish to finish');
    assert.deepEqual(publishes, [[ROOM, 'delivered']], "the premise: the script's publish was delivered");
    assert.equal(agent.publishedAfterReading(room, branch, 0), false, "a background script's publish isn't noted");

    fw.dispatchChannelToolCall('assistant', { id: 'from-turn', name: 'channel_publish', input: { channelId: ROOM, content: 'the agent posts' }, callerTurnId: 1 });
    await until(() => results.includes('from-turn'), "the turn's publish to finish");
    assert.equal(agent.publishedAfterReading(room, branch, 0), true, "a turn's publish is noted");
    await framework.stop();
  });

  // A script's call carries the turn watching it, which a later round's wait
  // shares with the round that started it. Its words were written as its run
  // call started it, so a publish it makes is credited with what the agent
  // had read then, not with what it has read since.
  it("a script's channel_publish is credited with what the agent had read when its run call started the script", async () => {
    const framework = await createFramework();
    const publishes: Array<[string, 'delivered' | 'refused']> = [];
    stubChannelRegistry(framework, ROOM, { publishes });
    const fw = internals(framework) as unknown as {
      turnRouting: Map<string, unknown>;
      scriptToolCall(agent: string, tool: string, argsJson: string, context: Record<string, unknown>): Promise<{ ok: boolean; json: string; held?: true }>;
    };
    const agent = framework.getAgent('assistant') as unknown as {
      getConsumedWatermark(): { branch: string; sequence: number };
      publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
    };
    const room = destinationKey({ serverId: 'chat', channelId: ROOM });
    const now = agent.getConsumedWatermark();
    const atStart = { branch: now.branch, sequence: now.sequence - 1 };
    fw.turnRouting.set('assistant', { turnId: 1, wasIn: [], engaged: new Set() });

    const answer = fw.scriptToolCall('assistant', 'channel_publish', JSON.stringify({ channelId: ROOM, content: 'a script posts' }),
      { watch: { turnId: 1, endTurn: false }, startTurnId: 1, startReadThrough: atStart });
    const answered = await bridgeAnswer(framework, answer);

    assert.equal(answered.held, undefined, `the call got its result: ${answered.json}`);
    assert.equal(JSON.parse(answered.json).isError, false, `the call succeeded: ${answered.json}`);
    assert.deepEqual(publishes, [[ROOM, 'delivered']], "the premise: the script's publish was delivered");
    assert.equal(agent.publishedAfterReading(room, atStart.branch, atStart.sequence), true, 'credited with what the agent had read when the script started');
    assert.equal(agent.publishedAfterReading(room, now.branch, now.sequence), false, 'not with what it has read since');
    await framework.stop();
  });

  it("a script's sleep announcement is credited with what the agent had read when its run call started the script", async () => {
    const framework = await createFramework({ gate: { policies: [], default: 'always' } });
    const attempts: string[] = [];
    stubChannelRegistry(framework, ROOM, { speechAttempts: attempts });
    const fw = internals(framework) as unknown as {
      turnRouting: Map<string, unknown>;
      eventGate: { clearSleep(): void };
      scriptToolCall(agent: string, tool: string, argsJson: string, context: Record<string, unknown>): Promise<{ ok: boolean; json: string; held?: true }>;
    };
    const agent = framework.getAgent('assistant') as unknown as {
      getConsumedWatermark(): { branch: string; sequence: number };
      publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
    };
    const room = destinationKey({ serverId: 'chat', channelId: ROOM });
    const now = agent.getConsumedWatermark();
    const atStart = { branch: now.branch, sequence: now.sequence - 1 };
    fw.turnRouting.set('assistant', { turnId: 1, wasIn: [], engaged: new Set(), locus: { serverId: 'chat', channelId: ROOM } });

    const answer = fw.scriptToolCall('assistant', 'sleep', JSON.stringify({ seconds: 60 }),
      { watch: { turnId: 1, endTurn: false }, startTurnId: 1, startReadThrough: atStart });
    const answered = await bridgeAnswer(framework, answer);
    await until(() => agent.publishedAfterReading(room, atStart.branch, atStart.sequence), 'the announcement to be noted');
    fw.eventGate.clearSleep();

    assert.equal(answered.held, undefined, `the call got its result: ${answered.json}`);
    assert.equal(JSON.parse(answered.json).isError, false, `the call succeeded: ${answered.json}`);
    assert.equal(attempts.length, 1, 'the sleep was announced');
    assert.equal(agent.publishedAfterReading(room, now.branch, now.sequence), false, 'not with what it has read since');
    await framework.stop();
  });

  it("a script's send is credited with what the agent had read when its run call started the script", async () => {
    const framework = await createFramework();
    stubChannelRegistry(framework, ROOM);
    const fw = framework as unknown as {
      channelRegistry: Record<string, unknown>;
      mcplServerRegistry: unknown;
      mcplServerConfigs: Map<string, unknown>;
      mcplPrefixMap: Map<string, string>;
      mcplToolFeatureSets: Map<string, unknown>;
      turnRouting: Map<string, unknown>;
      scriptToolCall(agent: string, tool: string, argsJson: string, context: Record<string, unknown>): Promise<{ ok: boolean; json: string; held?: true }>;
    };
    fw.mcplServerRegistry = {
      getServer: (id: string) => id === 'chat' ? { id: 'chat', sendToolsCall: async () => ({ content: [{ type: 'text', text: 'sent' }] }) } : null,
      getAllServers: () => [],
      closeAll: async () => {},
    };
    fw.mcplServerConfigs = new Map([['chat', { id: 'chat', toolPrefix: 'chat' }]]);
    fw.mcplPrefixMap = new Map([['chat', 'chat']]);
    fw.mcplToolFeatureSets = new Map();
    fw.channelRegistry = new Proxy(fw.channelRegistry, {
      get: (target, prop: string) => prop === 'openIfClosedForSend'
        ? async () => ({ status: 'already-open', channelId: ROOM })
        : prop === 'directsLifecycle' ? () => true
        : (target as Record<string, unknown>)[prop],
    });
    const agent = framework.getAgent('assistant') as unknown as {
      getConsumedWatermark(): { branch: string; sequence: number };
      publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
    };
    const room = destinationKey({ serverId: 'chat', channelId: ROOM });
    const now = agent.getConsumedWatermark();
    const atStart = { branch: now.branch, sequence: now.sequence - 1 };
    fw.turnRouting.set('assistant', { turnId: 1, wasIn: [], engaged: new Set() });

    const answer = fw.scriptToolCall('assistant', 'chat--send_message', JSON.stringify({ channelId: ROOM, text: 'a script sends' }),
      { watch: { turnId: 1, endTurn: false }, startTurnId: 1, startReadThrough: atStart });
    const answered = await bridgeAnswer(framework, answer);
    await until(() => agent.publishedAfterReading(room, atStart.branch, atStart.sequence), 'the send to be noted');

    assert.equal(answered.held, undefined, `the call got its result: ${answered.json}`);
    assert.equal(JSON.parse(answered.json).isError, false, `the call succeeded: ${answered.json}`);
    assert.equal(agent.publishedAfterReading(room, now.branch, now.sequence), false, 'not with what it has read since');
    await framework.stop();
  });

  const event = (e: Record<string, unknown>) => (framework: AgentFramework) => framework.pushEvent(e as unknown as ProcessEvent);
  const kept: Array<[string, (framework: AgentFramework) => unknown]> = [
    ['console input, which nothing records an answer to', event({ type: 'external-message', source: 'console', content: 'are you there?' })],
    ['API input, which nothing records an answer to', event({ type: 'api:message', source: 'api', content: 'are you there?' })],
    ['a module event with several messages', event({ type: 'clock:reminder', source: 'clock', content: ['one', 'two'] })],
    ["a module's message that names its channel, though its event doesn't, which the module answers through its own speech", event({ type: 'clock:reminder', source: 'chat', content: 'a word in room', messageMetadata: { channelId: ROOM } })],
    ["an external message whose event names its channel, though the module's message doesn't", event({ type: 'external-message', source: 'chat', content: 'a word in room', metadata: { channelId: ROOM }, echoMetadata: false })],
    // Its answer is a resend of the held draft, which hearing it doesn't show.
    ['a prose bounce notice', (framework) => {
      const fw = internals(framework);
      fw.bounceProse(fw.agents.get('assistant'), 'hello there', 'no channel named #nowhere', undefined, '>>',
        { routing: fw.turnRouting.get('assistant'), notice: 'now' });
    }],
  ];
  for (const [what, write] of kept) {
    it(`${what}: heard at the boundary, its wake still starts the turn`, async () => {
      const streams = scheduleTurns(membrane, [heardThen(createMockResponse([text('all done')])), [createMockResponse([text('again')])]]);
      const framework = await createFramework();
      stubChannelRegistry(framework, ROOM);
      module.during = () => write(framework);

      framework.pushEvent(go());
      await framework.runUntilIdle();

      assert.ok(streams[0]!.receivedToolResultOptions.some((o) => (o?.injectedMessages?.length ?? 0) > 0),
        'the turn heard it at its tool boundary');
      assert.equal(membrane.calls.length, 2, 'its wake started the turn');
      assert.deepEqual(drops, []);
      await framework.stop();
    });
  }
});
