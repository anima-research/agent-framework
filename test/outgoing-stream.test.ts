/**
 * The outgoing stream (MCPL Spec 14.3 `channels/outgoing/chunk` and
 * `complete`, mirrored as the `inference:published` traces) carries what
 * delivery published, sent once each publish succeeds. Text that
 * delivery withholds never reaches it: a round that a silencing tool,
 * `skip_reply` or a private `think` keeps back, text under a hybrid hold, a
 * bounce, or a round the stream never finished. Nor does a publish that
 * throws, that the server reports undelivered, or that it doesn't confirm.
 * A voice server speaks what it gets, and words already spoken can't be
 * taken back, so the stream can't run ahead of delivery.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStreamOptions } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type Module, type ModuleContext, type ToolCall, type ToolResult,
  type ProcessEvent, type ProcessState } from '../src/index.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { ChannelRegistry, destinationKey } from '../src/mcpl/channel-registry.js';
import { ALL_CAPABILITY_PATHS, CapabilityGrant } from '../src/mcpl/capability-grant.js';

const dirs: string[] = [];
const unscripted: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  assert.deepEqual(unscripted.splice(0), [], 'every stream the framework opened was one the test scripted');
});

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const call = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
/** A round that ends in tool calls. */
const round = (...blocks: ContentBlock[]) => createMockResponse(blocks, 'tool_use');
/** A round that ends the stream. */
const final = (...blocks: ContentBlock[]) => createMockResponse(blocks);

/** Each stream the framework opens takes the next list of responses. */
class ScriptMembrane {
  streams = 0;
  readonly requests: NormalizedRequest[] = [];
  /** Wraps a stream's events, by its 1-based number. */
  wrap?: (index: number, events: AsyncIterable<StreamEvent>) => AsyncIterable<StreamEvent>;
  constructor(readonly scripts: NormalizedResponse[][]) {}
  streamYielding(request: NormalizedRequest, _options: YieldingStreamOptions = {}) {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) {
      const last = request.messages.at(-1)?.content.map((b) => (b as { text?: string }).text ?? `[${b.type}]`).join(' ') ?? '';
      unscripted.push(`stream ${this.requests.length}, after: ${last.slice(0, 120)}`);
      throw new Error('unexpected extra inference');
    }
    const stream = new MockYieldingStream(script);
    const index = ++this.streams;
    const wrap = this.wrap;
    if (wrap) {
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<StreamEvent> })[Symbol.asyncIterator] =
        () => wrap(index, { [Symbol.asyncIterator]: iterate })[Symbol.asyncIterator]();
    }
    return stream;
  }
  asMembrane() { return this as unknown as Membrane; }
}

class ToolModule implements Module {
  readonly name = 'test';
  /** Runs inside a tool call, before its result: lets a test act mid-round. */
  during?: (call: ToolCall) => Promise<void>;
  async start(_ctx: ModuleContext) {}
  async stop() {}
  getTools() {
    return [
      { name: 'read', description: 'Read', inputSchema: { type: 'object' as const, properties: {} } },
      { name: 'send_message', description: 'Explicit send', inputSchema: { type: 'object' as const, properties: {} } },
    ];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    await this.during?.(call);
    return { success: true, data: `payload-${call.id}` };
  }
  /** Called with each external message's text as it is processed. */
  processed?: (content: string) => void;
  async onProcess(event: ProcessEvent, _state: ProcessState) {
    if (event.type === 'external-message') this.processed?.(String(event.content));
    return event.type === 'external-message'
      ? {
          addMessages: [{
            participant: 'user',
            content: [{ type: 'text' as const, text: String(event.content) }],
            ...((event as { metadata?: Record<string, unknown> }).metadata ? { metadata: (event as { metadata?: Record<string, unknown> }).metadata } : {}),
          }],
          requestInference: String(event.content) === 'go',
        }
      : {};
  }
}

type Logged =
  | { kind: 'chunk'; channelId: string; text: string; inferenceId: string; index: number }
  | { kind: 'publish'; channelId: string; text: string }
  | { kind: 'complete'; channelId: string; text: string; inferenceId: string }
  | { kind: 'mark'; channelId: string; text: string };

/**
 * The registry stub: #alpha, #cafe and @laria resolve, the turn's locus is
 * world:test, and every chunk, publish and complete lands in one ordered
 * log. A publish whose text is in `fails` fails.
 */
function registry(framework: AgentFramework, options: { streaming?: boolean; servers?: Record<string, string> } = {}) {
  const log: Logged[] = [];
  /** A publish whose text is held here doesn't return until the test lets it go. */
  const holds = new Map<string, Promise<void>>();
  /**
   * A publish of one of these texts fails: the server reports it undelivered
   * (`delivered: false`); its reply confirms nothing, so it may or may not
   * have been posted (`unknown`, as the real registry reads a reply that
   * leaves `delivered` out, an error answer or a timeout); or it throws.
   */
  const fails = new Map<string, 'undelivered' | 'unknown' | 'throw'>();
  /** A publish of one of these texts is answered with this message id, as a server that returns one. */
  const messageIds = new Map<string, string>();
  const known: Record<string, string> = { '#alpha': 'chan-alpha', '#cafe': 'chan-cafe', '@laria': 'discord:dm:99', '#b-room': 'b:room', '#room': 'room' };
  /** The server a channel belongs to: `options.servers` names some, and the stub's server has the rest. */
  const serverOf = (channelId: string) => options.servers?.[channelId] ?? 'stub';
  let stopped = false;
  /** One post, with the outcome the real registry's deliverSpeech gives it.
   *  The framework hands it the channel with its server. */
  const publish = async (body: string, to: { serverId?: string; channelId: string } | null) => {
    if (!to) return { status: 'failed' as const, reason: 'no channel', at: Date.now() };
    const channelId = to.channelId;
    log.push({ kind: 'publish', channelId, text: body });
    await holds.get(body);
    const failure = fails.get(body);
    if (failure === 'throw') throw new Error('synthetic publish failure');
    const destination = { serverId: serverOf(channelId), channelId };
    const messageId = messageIds.get(body);
    if (failure === 'unknown') {
      return { status: 'unknown' as const, destination, reason: 'the stub returned no delivery receipt (delivery uncertain)', at: Date.now() };
    }
    return failure === undefined
      ? { status: 'delivered' as const, destination, ...(messageId !== undefined ? { messageId } : {}), at: Date.now() }
      : { status: 'failed' as const, destination, reason: 'the stub reported delivered: false', at: Date.now() };
  };
  const target: Record<string, unknown> = {
    resolveLocus: () => ({ serverId: serverOf('world:test'), channelId: 'world:test' }),
    resolveProseTarget: (spec: string) => (known[spec] ? { serverId: serverOf(known[spec]), channelId: known[spec] } : { error: `no channel ${spec}` }),
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: serverOf(channelId), channelId } }),
    // Locus prose posts through routeSpeech, a named or sticky destination
    // through deliverSpeech, as with the real registry.
    deliverSpeech: async (_agent: string, body: string, to: { serverId?: string; channelId: string } | null) => publish(body, to),
    routeSpeech: async (_agent: string, body: string, to: { serverId?: string; channelId: string } | null) => {
      const outcome = await publish(body, to);
      return outcome.status === 'delivered'
        ? { delivered: true, serverId: outcome.destination.serverId, channelId: outcome.destination.channelId, ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}) }
        : null;
    },
    // Each delivery site hands its stream the destination its publish went
    // to, its channel's server; a stream message for any other is logged as
    // a mark, so a site that loses the server fails its test.
    sendOutgoingChunk: ({ serverId, channelId }: { serverId: string; channelId: string }, _agent: string, inferenceId: string, index: number, delta: string) => {
      if (stopped) return;
      if (serverId !== serverOf(channelId)) { log.push({ kind: 'mark', channelId, text: `chunk for server ${serverId}` }); return; }
      log.push({ kind: 'chunk', channelId, text: delta, inferenceId, index });
    },
    sendOutgoingComplete: ({ serverId, channelId }: { serverId: string; channelId: string }, _agent: string, inferenceId: string, body: string) => {
      if (stopped) return;
      if (serverId !== serverOf(channelId)) { log.push({ kind: 'mark', channelId, text: `complete for server ${serverId}` }); return; }
      log.push({ kind: 'complete', channelId, text: body, inferenceId });
    },
    // As the real registry's stopAll forgets its channels, a chunk or
    // complete sent after it finds no server and goes nowhere.
    stopAll: () => {
      stopped = true;
      log.push({ kind: 'mark', channelId: '', text: 'registry stopped' });
    },
    // skip_reply ends the turn, as the real registry's does; think is noted.
    handleChannelToolCall: async (name: string) => (name === 'skip_reply'
      ? { success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } }
      : { success: true, data: { noted: true } }),
    getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    getChannelTools: () => [],
    channelsNamed: (name: string) => [{ serverId: serverOf(name), channelId: name }],
    nameShown: (channel: { channelId: string }) => channel.channelId,
  };
  // A registry whose server doesn't take the stream sends no chunk or complete.
  if (options.streaming === false) {
    delete target.sendOutgoingChunk;
    delete target.sendOutgoingComplete;
  }
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(target, {
    get: (t, key: string) => (key in t ? t[key] : () => undefined),
  });
  return {
    log,
    holds,
    fails,
    messageIds,
    chunks: () => log.filter((e): e is Extract<Logged, { kind: 'chunk' }> => e.kind === 'chunk'),
    publishes: () => log.filter((e) => e.kind === 'publish').map((e) => ({ channelId: e.channelId, text: e.text })),
    completes: () => log.filter((e): e is Extract<Logged, { kind: 'complete' }> => e.kind === 'complete'),
  };
}

async function harness(
  scripts: NormalizedResponse[][],
  config: Partial<AgentConfig> = {},
  options: { streaming?: boolean; gate?: boolean; speech?: { locus: 'delivery' | 'latest-inbound' }; servers?: Record<string, string> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'af-outgoing-stream-')); dirs.push(dir);
  const membrane = new ScriptMembrane(scripts);
  const module = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', ...config }], modules: [module], syncIntervalMs: 0,
    // An EventGate gives the agent the sleep tool.
    ...(options.gate ? { gate: { configPath: join(dir, 'gate.json') } } : {}),
    // The re-pin is the legacy locus rule; a test about it opts in.
    ...(options.speech ? { speech: options.speech } : {}),
  });
  const stub = registry(framework, options);
  const traces: Array<{ type: string; channelId: string; text: string; inferenceId: string; index?: number; messageId?: string }> = [];
  framework.onTrace((event) => {
    if (event.type === 'inference:published' || event.type === 'inference:published_complete') {
      const { type, channelId, text: body, inferenceId } = event;
      traces.push({
        type, channelId, text: body, inferenceId,
        ...(event.type === 'inference:published' ? { index: event.index } : {}),
        // Kept whenever the key is there, so a trace that carries it as undefined shows.
        ...('messageId' in event ? { messageId: event.messageId } : {}),
      });
    }
  });
  /**
   * Once the agent's queued deliveries have run. A stream's `complete` is
   * chained on its deliveries in its teardown, ahead of this wait.
   */
  const settled = async () => {
    await (framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('assistant');
  };
  const run = async () => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    await framework.runUntilIdle();
    await settled();
  };
  return { framework, membrane, module, run, settled, traces, ...stub };
}

test('a delivered round streams its text once its publish succeeds, and the published traces mirror the stream', async () => {
  const h = await harness([[round(text('first'), call('one', 'test--read')), final(text('second'))]]);
  try {
    await h.run();
    const [id] = new Set(h.chunks().map((c) => c.inferenceId));
    assert.deepEqual(h.log, [
      { kind: 'publish', channelId: 'world:test', text: 'first' },
      { kind: 'chunk', channelId: 'world:test', text: 'first', inferenceId: id, index: 0 },
      { kind: 'publish', channelId: 'world:test', text: 'second' },
      { kind: 'chunk', channelId: 'world:test', text: '\n\nsecond', inferenceId: id, index: 1 },
      { kind: 'complete', channelId: 'world:test', text: 'first\n\nsecond', inferenceId: id },
    ], 'each publish is streamed once it succeeds, and a later one to the same channel opens with a paragraph break');
    assert.deepEqual(h.traces, [
      { type: 'inference:published', channelId: 'world:test', text: 'first', inferenceId: id, index: 0 },
      { type: 'inference:published', channelId: 'world:test', text: '\n\nsecond', inferenceId: id, index: 1 },
      { type: 'inference:published_complete', channelId: 'world:test', text: 'first\n\nsecond', inferenceId: id },
    ]);
  } finally { await h.framework.stop(); }
});

for (const mode of ['locus', 'hybrid', 'explicit'] as const) {
  const aside = mode === 'explicit' ? '>>#alpha an aside I decided against' : 'an aside I decided against';

  test(`${mode}: a round that calls skip_reply streams nothing`, async () => {
    const h = await harness([[round(text(aside), call('skip', 'skip_reply'))]], { proseRouting: mode });
    try {
      await h.run();
      assert.equal(h.membrane.streams, 1, "the turn's inference ran");
      assert.deepEqual(h.publishes(), [], 'delivery keeps the round');
      assert.deepEqual(h.log, [], 'and the stream gets none of it');
      assert.deepEqual(h.traces, []);
    } finally { await h.framework.stop(); }
  });

  test(`${mode}: a round beside a private think streams nothing, and the next round streams as it is published`, async () => {
    const answer = mode === 'explicit' ? '>>#alpha the answer' : 'the answer';
    const h = await harness([[round(text(aside), call('plan', 'think', { content: 'planning' })), final(text(answer))]],
      { proseRouting: mode, sameRoundThinkTextPolicy: 'private' });
    try {
      await h.run();
      const where = mode === 'explicit' ? 'chan-alpha' : 'world:test';
      assert.deepEqual(h.publishes(), [{ channelId: where, text: 'the answer' }]);
      assert.deepEqual(h.chunks().map((c) => ({ channelId: c.channelId, text: c.text })), [{ channelId: where, text: 'the answer' }]);
    } finally { await h.framework.stop(); }
  });
}

for (const mode of ['locus', 'hybrid'] as const) {
  test(`${mode}: a round with a send streams nothing, and neither does the turn's later prose`, async () => {
    const h = await harness([[round(text('sending it directly'), call('send', 'test--send_message')), final(text('and done'))]],
      { proseRouting: mode });
    try {
      await h.run();
      assert.equal(h.membrane.streams, 1, "the turn's inference ran");
      assert.deepEqual(h.publishes(), [], 'the send silences the turn from its round on');
      assert.deepEqual(h.log, [], 'and the stream carries none of it');
    } finally { await h.framework.stop(); }
  });
}

test('explicit: a round starts where the sticky destination is, and its >> lines move it, as delivery does', async () => {
  const h = await harness([[round(text('>>#alpha first'), call('one', 'test--read')), final(text('middle\n>>#cafe later'))]],
    { proseRouting: 'explicit' });
  try {
    await h.run();
    assert.deepEqual(h.publishes(), [
      { channelId: 'chan-alpha', text: 'first' },
      { channelId: 'chan-alpha', text: 'middle' },
      { channelId: 'chan-cafe', text: 'later' },
    ]);
    assert.deepEqual(h.chunks().map((c) => ({ channelId: c.channelId, text: c.text })), [
      { channelId: 'chan-alpha', text: 'first' },
      { channelId: 'chan-alpha', text: '\n\nmiddle' },
      { channelId: 'chan-cafe', text: 'later' },
    ]);
    assert.deepEqual(h.completes().map((c) => ({ channelId: c.channelId, text: c.text })), [
      { channelId: 'chan-alpha', text: 'first\n\nmiddle' },
      { channelId: 'chan-cafe', text: 'later' },
    ]);
  } finally { await h.framework.stop(); }
});

test("explicit: two destinations whose ids join to the same string are two destinations to the stream, each streamed and completed with its own words", async () => {
  // Server a's channel `b:room` and server a:b's channel `room` would both be
  // `a:b:room` joined with a colon.
  const h = await harness([[round(text('>>#b-room first'), call('one', 'test--read')), final(text('>>#room second'))]],
    { proseRouting: 'explicit' }, { servers: { 'b:room': 'a', room: 'a:b' } });
  try {
    await h.run();
    assert.deepEqual(h.publishes(), [{ channelId: 'b:room', text: 'first' }, { channelId: 'room', text: 'second' }]);
    assert.deepEqual(h.log.filter((e) => e.kind !== 'publish').map((e) => [e.kind, e.channelId, e.text]), [
      ['chunk', 'b:room', 'first'],
      ['chunk', 'room', 'second'],
      ['complete', 'b:room', 'first'],
      ['complete', 'room', 'second'],
    ], "each destination's chunk carries no paragraph break, and its complete only its own words");
  } finally { await h.framework.stop(); }
});

test('explicit: a {{unsent}} resend streams the retained text it publishes', async () => {
  const original = 'the reply I meant for laria';
  // The unprefixed reply bounces and wakes a second turn, which resends it.
  const h = await harness([[final(text(original))], [final(text('>>@laria {{unsent}}'))]], { proseRouting: 'explicit' });
  try {
    await h.run();
    assert.deepEqual(h.publishes(), [{ channelId: 'discord:dm:99', text: original }]);
    assert.deepEqual(h.chunks().map((c) => ({ channelId: c.channelId, text: c.text })), [{ channelId: 'discord:dm:99', text: original }],
      'the stream carries the substituted text, not the token');
  } finally { await h.framework.stop(); }
});

test('hybrid: a publish that fails streams nothing, and the {{unsent}} resend of its retained text streams once', async () => {
  const reply = 'the reply I meant for alpha';
  // The >>> post fails, so delivery retains its text and wakes a second turn, which resends it.
  const h = await harness([[final(text(`>>>#alpha ${reply}`))], [final(text('>>>#alpha {{unsent}}'))]], { proseRouting: 'hybrid' });
  h.fails.set(reply, 'undelivered');
  // The failure applies to the first post alone, so the resend succeeds.
  const failureOf = h.fails.get.bind(h.fails);
  h.fails.get = (body: string) => { const failure = failureOf(body); h.fails.delete(body); return failure; };
  try {
    await h.run();
    assert.deepEqual(h.publishes(), [{ channelId: 'chan-alpha', text: reply }, { channelId: 'chan-alpha', text: reply }],
      'the post failed, and the resend posted the retained text');
    assert.deepEqual(h.chunks().map((c) => ({ channelId: c.channelId, text: c.text })), [{ channelId: 'chan-alpha', text: reply }],
      'only the resend streams, once, so a voice server speaks the reply once');
  } finally { await h.framework.stop(); }
});

/** Two streams of one turn: the first round crosses the stream budget, so the turn restarts. */
function budgetRestart(first: string, continued: string) {
  const overBudget = round(text(first), call('one', 'test--read'));
  overBudget.usage = { inputTokens: 100, outputTokens: 5 };
  return [[overBudget], [final(text(continued))]];
}

test("hybrid: a resumed stream's first round stays held under the hold an earlier stream left", async () => {
  const h = await harness(budgetRestart('>>>skip_reply an aside', 'carrying on'), { proseRouting: 'hybrid', maxStreamTokens: 20 });
  try {
    await h.run();
    assert.equal(h.membrane.streams, 2, 'the turn restarted for its budget');
    assert.deepEqual(h.publishes(), [], 'delivery keeps the hold across the restart');
    assert.deepEqual(h.log, [], 'and the resumed stream sends nothing to the locus');
  } finally { await h.framework.stop(); }
});

test("hybrid: a resumed stream's first round streams to the pin an earlier stream left, and each stream completes", async () => {
  const h = await harness(budgetRestart('>>>#alpha first', 'carrying on'), { proseRouting: 'hybrid', maxStreamTokens: 20 });
  try {
    await h.run();
    assert.equal(h.membrane.streams, 2, 'the turn restarted for its budget');
    assert.deepEqual(h.publishes(), [
      { channelId: 'chan-alpha', text: 'first' },
      { channelId: 'chan-alpha', text: 'carrying on' },
    ]);
    const chunks = h.chunks();
    assert.deepEqual(chunks.map((c) => ({ channelId: c.channelId, text: c.text })), [
      { channelId: 'chan-alpha', text: 'first' },
      { channelId: 'chan-alpha', text: 'carrying on' },
    ], 'the resumed stream follows the pin, not the locus');
    assert.notEqual(chunks[0]!.inferenceId, chunks[1]!.inferenceId, 'each stream has its own id');
    assert.deepEqual(h.completes().map((c) => ({ text: c.text, inferenceId: c.inferenceId })), [
      { text: 'first', inferenceId: chunks[0]!.inferenceId },
      { text: 'carrying on', inferenceId: chunks[1]!.inferenceId },
    ], 'the stream that handed its turn to the restart completes too');
  } finally { await h.framework.stop(); }
});

test('a stream that fails partway streams none of its unfinished round, and its retry streams what it delivers', async () => {
  const h = await harness([[round(text('first'), call('one', 'test--read')), final(text('half a thought'))], [final(text('carrying on'))]]);
  // The first stream errors where its last round would complete.
  h.membrane.wrap = (index, events) => ({
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        if (index === 1 && event.type === 'complete') {
          yield { type: 'error', error: new Error('synthetic transient stream error') } as StreamEvent;
          return;
        }
        yield event;
      }
    },
  });
  try {
    await h.run();
    assert.equal(h.membrane.streams, 2, 'the error was retried');
    assert.deepEqual(h.publishes().map((p) => p.text), ['first', 'carrying on']);
    assert.equal(h.chunks().some((c) => c.text.includes('half a thought')), false, 'the unfinished round never streams');
    assert.deepEqual(h.completes().map((c) => c.text), ['first', 'carrying on'], 'each stream completes with what it delivered');
  } finally { await h.framework.stop(); }
});

test('locus: after a mid-turn addressed re-pin, the next round streams to the new locus, where it is published', async () => {
  const h = await harness([[round(text('station four, proceeding'), call('one', 'test--read')), final(text('answering you'))]], {}, { speech: { locus: 'latest-inbound' } });
  // While the tool runs, someone addresses the agent from a DM. The tool
  // returns once the message has been processed, so the round's boundary
  // weighs it.
  h.module.during = async () => {
    const seen = new Promise<void>((resolve) => {
      h.module.processed = (content) => { if (content === 'quick question over here?') resolve(); };
    });
    h.framework.pushEvent({
      type: 'external-message', source: 'test', content: 'quick question over here?',
      metadata: { channelId: 'discord:dm:antra', tags: ['chat:addressed'] },
    } as unknown as ProcessEvent);
    await seen;
  };
  try {
    await h.run();
    assert.deepEqual(h.publishes(), [
      { channelId: 'world:test', text: 'station four, proceeding' },
      { channelId: 'discord:dm:antra', text: 'answering you' },
    ]);
    assert.deepEqual(h.chunks().map((c) => ({ channelId: c.channelId, text: c.text })), [
      { channelId: 'world:test', text: 'station four, proceeding' },
      { channelId: 'discord:dm:antra', text: 'answering you' },
    ], 'the stream follows the re-pin');
  } finally { await h.framework.stop(); }
});

test("explicit: a stream's complete waits for the deliveries it queued, so no chunk follows it", async () => {
  // skip_reply ends the turn while round one's post is still out: explicit
  // mode doesn't hold the turn for its queued deliveries.
  const h = await harness([[round(text('>>#alpha first'), call('one', 'test--read')), round(text('an aside'), call('skip', 'skip_reply'))]],
    { proseRouting: 'explicit' });
  let release!: () => void;
  h.holds.set('first', new Promise<void>((resolve) => { release = resolve; }));
  try {
    h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    // The turn has ended and its stream torn down, with 'first' still out.
    await h.framework.runUntilIdle();
    h.log.push({ kind: 'mark', channelId: '', text: 'post released' });
    release();
    await h.settled();
    assert.deepEqual(h.log.map((e) => `${e.kind}:${e.text}`), [
      'publish:first',
      'mark:post released',
      'chunk:first',
      'complete:first',
    ], 'the chunk follows the post once it succeeds, the complete follows the chunk, and the private round streams nothing');
  } finally {
    release();
    await h.framework.stop();
  }
});

/** How a test title says a publish failed. */
const failedHow = (failure: 'undelivered' | 'unknown' | 'throw'): string =>
  failure === 'throw' ? 'throws' : failure === 'unknown' ? "the server doesn't confirm" : 'the server reports undelivered';

for (const failure of ['undelivered', 'unknown', 'throw'] as const) {
  test(`a publish that ${failedHow(failure)} never streams, and the stream goes on with what is`, async () => {
    const h = await harness([[round(text('lost'), call('one', 'test--read')), final(text('kept'))]]);
    h.fails.set('lost', failure);
    try {
      await h.run();
      assert.deepEqual(h.publishes().map((p) => p.text), ['lost', 'kept'], 'both publishes were tried');
      assert.deepEqual(h.chunks().map((c) => c.text), ['kept'], 'only the one that succeeded streams');
      assert.deepEqual(h.completes().map((c) => c.text), ['kept'], 'and the complete carries only it');
      assert.equal(h.traces.some((t) => t.text.includes('lost')), false, 'nor do the published traces');
    } finally { await h.framework.stop(); }
  });
}

test('a stream stopped mid-turn still completes what it published', async () => {
  const h = await harness([[round(text('first'), call('one', 'test--read')), final(text('never written'))]]);
  // The tool doesn't return until the test is done with it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let published!: () => void;
  const firstOut = new Promise<void>((resolve) => { published = resolve; });
  h.module.during = async () => { await held; };
  const unlog = h.framework.onTrace((event) => { if (event.type === 'inference:published') published(); });
  try {
    h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    void h.framework.runUntilIdle().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([firstOut, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the first round never streamed')), 10000);
    })]).finally(() => clearTimeout(timer));
    await h.framework.stop();
    await h.settled();
    assert.deepEqual(h.completes().map((c) => ({ channelId: c.channelId, text: c.text })), [{ channelId: 'world:test', text: 'first' }],
      'the stopped stream ends its utterance with what it carried');
  } finally {
    unlog?.();
    release();
    await h.framework.stop();
  }
});

// A stop() that finds a publish still out ends the stream before its teardown
// closes the connections the publish waits on, whatever becomes of the
// publish then: the close rejects it, or it succeeds too late to stream.
for (const late of ['rejects', 'succeeds'] as const) {
  test(`a stop() with a publish still out completes what the stream sent before teardown, and a publish that ${late === 'rejects' ? 'teardown rejects' : 'succeeds after teardown'} never streams`, async () => {
    const h = await harness([[
      round(text('first'), call('one', 'test--read')),
      round(text('second'), call('two', 'test--read')),
      final(text('never written')),
    ]]);
    // 'second' is still out when stop() begins; teardown settles it, as
    // closing an MCPL connection settles a request it still holds.
    let settleSecond!: () => void;
    const secondHeld = new Promise<void>((resolve, reject) => {
      settleSecond = () => (late === 'rejects' ? reject(new Error('connection closed')) : resolve());
    });
    secondHeld.catch(() => {});
    h.holds.set('second', secondHeld);
    // The second round's tool doesn't return until the test is done with it.
    let releaseTwo!: () => void;
    const twoHeld = new Promise<void>((resolve) => { releaseTwo = resolve; });
    h.module.during = async (c) => { if (c.id === 'two') await twoHeld; };
    h.module.stop = async () => {
      h.log.push({ kind: 'mark', channelId: '', text: 'teardown' });
      settleSecond();
    };
    try {
      h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      void h.framework.runUntilIdle().catch(() => {});
      for (const end = Date.now() + 10000; !h.log.some((e) => e.kind === 'publish' && e.text === 'second');) {
        assert.ok(Date.now() < end, 'the second publish went out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await h.framework.stop();
      await h.settled();
      assert.deepEqual(h.log.filter((e) => e.kind !== 'publish').map((e) => `${e.kind}:${e.text}`),
        ['chunk:first', 'complete:first', 'mark:registry stopped', 'mark:teardown'],
        'the stream completes before the registry forgets its channels and the teardown, with what it sent, and nothing streams after its complete');
      assert.deepEqual(h.traces.map((t) => `${t.type}:${t.text}`), ['inference:published:first', 'inference:published_complete:first'],
        'and the published traces say the same');
    } finally {
      releaseTwo();
      await h.framework.stop();
    }
  });
}

test('a stop() completes a stream the framework no longer tracks, as a disposed ephemeral\'s, before the registry forgets its channels', async () => {
  const h = await harness([[round(text('first'), call('one', 'test--read')), final(text('second'))]]);
  // The turn's last publish is still out when stop() begins; teardown rejects
  // it, as closing an MCPL connection rejects a request it still holds.
  let rejectSecond!: () => void;
  const secondHeld = new Promise<void>((_, reject) => { rejectSecond = () => reject(new Error('connection closed')); });
  secondHeld.catch(() => {});
  h.holds.set('second', secondHeld);
  h.module.stop = async () => {
    h.log.push({ kind: 'mark', channelId: '', text: 'teardown' });
    rejectSecond();
  };
  try {
    h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    void h.framework.runUntilIdle().catch(() => {});
    for (const end = Date.now() + 10000; !h.log.some((e) => e.kind === 'publish' && e.text === 'second');) {
      assert.ok(Date.now() < end, 'the last publish went out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The stream, still awaiting that publish, is no longer tracked, as when
    // an idle ephemeral is disposed, so stop() doesn't wait for it.
    (h.framework as unknown as { activeStreams: Map<string, unknown> }).activeStreams.delete('assistant');
    await h.framework.stop();
    await h.settled();
    assert.deepEqual(h.log.filter((e) => e.kind !== 'publish').map((e) => `${e.kind}:${e.text}`),
      ['chunk:first', 'complete:first', 'mark:registry stopped', 'mark:teardown'],
      'the stream completes with what it sent before the registry forgets its channels, and nothing streams after');
  } finally {
    await h.framework.stop();
  }
});

test("with the real channel registry, a stop() with a publish still out sends the stream's complete to the server before the registry forgets its channels", async () => {
  // The stop tests above use the harness's stub registry. Here the publishes,
  // the chunks, the complete and stopAll go through a real ChannelRegistry
  // and a server it owns, so the registry's own teardown keeps the order honest.
  const dir = mkdtempSync(join(tmpdir(), 'af-outgoing-real-')); dirs.push(dir);
  const membrane = new ScriptMembrane([[
    round(text('first'), call('one', 'test--read')),
    round(text('second'), call('two', 'test--read')),
    final(text('never written')),
  ]]);
  const module = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system' }], modules: [module], syncIntervalMs: 0,
  });
  // What reaches the server, with the registry's stopAll and the teardown marked.
  const wire: string[] = [];
  // 'second' is still out when stop() begins; teardown rejects it, as closing
  // an MCPL connection rejects a request it still holds.
  let rejectSecond!: () => void;
  const secondHeld = new Promise<void>((_, reject) => { rejectSecond = () => reject(new Error('connection closed')); });
  secondHeld.catch(() => {});
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (params: { content: Array<{ text: string }> }) => {
      const body = params.content[0]!.text;
      wire.push(`publish:${body}`);
      if (body === 'second') await secondHeld;
      return { delivered: true };
    },
    sendChannelsOutgoingChunk: (params: { delta: string }) => { wire.push(`chunk:${params.delta}`); },
    sendChannelsOutgoingComplete: (params: { content: Array<{ text: string }> }) => { wire.push(`complete:${params.content[0]!.text}`); },
    sendChannelsTyping: () => {},
  };
  const registry = new ChannelRegistry({ getServer: () => server } as never, {} as never, () => {}, () => {}, {});
  (registry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 'srv', channelId: 'world:test' }),
    { serverId: 'srv', descriptor: { id: 'world:test', type: 'srv', label: 'world:test' }, open: true });
  const stopAll = registry.stopAll.bind(registry);
  (registry as unknown as { stopAll: () => void }).stopAll = () => { wire.push('registry stopped'); stopAll(); };
  // The turn's locus and channel tools, as the harness gives them.
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, key: string) => {
      if (key === 'resolveLocus') return () => ({ serverId: 'srv', channelId: 'world:test' });
      if (key === 'handleChannelToolCall') return async () => ({ success: true, data: {} });
      if (key === 'getChannelTools') return () => [];
      const value = (target as unknown as Record<string, unknown>)[key];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  // The second round's tool doesn't return until the test is done with it.
  let releaseTwo!: () => void;
  const twoHeld = new Promise<void>((resolve) => { releaseTwo = resolve; });
  module.during = async (c) => { if (c.id === 'two') await twoHeld; };
  module.stop = async () => { wire.push('teardown'); rejectSecond(); };
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    void framework.runUntilIdle().catch(() => {});
    for (const end = Date.now() + 10000; !wire.includes('publish:second');) {
      assert.ok(Date.now() < end, 'the second publish went out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await framework.stop();
    await (framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('assistant');
    assert.deepEqual(wire, ['publish:first', 'chunk:first', 'publish:second', 'complete:first', 'registry stopped', 'teardown'],
      "the server gets the stream's complete before the registry forgets its channels, and nothing streams after it");
  } finally {
    releaseTwo();
    await framework.stop();
  }
});

/**
 * A turn whose channel registry is real, with the channels given open in
 * their servers, the locus `room`. What each server is sent lands in `wire`
 * as `<server> <kind>:<text>`, and the stream's `inference:published*`
 * traces in `traces`, each with its destination's server and channel.
 * `during` runs inside the turn's tool call `one`, with the registry, to
 * change the channels mid-turn.
 */
async function realRegistryTurn(
  script: NormalizedResponse[],
  channels: Array<[serverId: string, channelId: string]>,
  during: (registry: ChannelRegistry, open: (serverId: string, channelId: string) => void) => Promise<void>,
  /** Runs inside each publish, after the registry has sent it and before the server answers. */
  onPublish?: (text: string, registry: ChannelRegistry, open: (serverId: string, channelId: string) => void) => Promise<void>,
): Promise<{ wire: string[]; traces: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'af-outgoing-real-')); dirs.push(dir);
  const membrane = new ScriptMembrane([script]);
  const module = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system' }], modules: [module], syncIntervalMs: 0,
  });
  const wire: string[] = [];
  const traces: string[] = [];
  framework.onTrace((event) => {
    const e = event as { type: string; serverId?: string; channelId?: string; text?: string };
    if (e.type === 'inference:published' || e.type === 'inference:published_complete') traces.push(`${e.type} ${JSON.stringify([e.serverId, e.channelId])} ${e.text}`);
  });
  const server = (name: string) => ({
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (params: { content: Array<{ text: string }> }) => {
      wire.push(`${name} publish:${params.content[0]!.text}`);
      await onPublish?.(params.content[0]!.text, registry, open);
      return { delivered: true };
    },
    sendChannelsOutgoingChunk: (params: { delta: string }) => { wire.push(`${name} chunk:${params.delta}`); },
    sendChannelsOutgoingComplete: (params: { content: Array<{ text: string }> }) => { wire.push(`${name} complete:${params.content[0]!.text}`); },
    sendChannelsTyping: () => {},
  });
  // Each server the registry asks for is connected, the one a channel moves to included.
  const servers = new Map<string, ReturnType<typeof server>>();
  const getServer = (id: string) => servers.get(id) ?? servers.set(id, server(id)).get(id)!;
  const registry = new ChannelRegistry({ getServer } as never, {} as never, () => {}, () => {}, {});
  const open = (serverId: string, channelId: string) => {
    (registry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId, channelId }),
      { serverId, descriptor: { id: channelId, type: 'chat', label: channelId }, open: true });
  };
  for (const [serverId, channelId] of channels) open(serverId, channelId);
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, key: string) => {
      // The turn's locus is the first channel, on its server.
      if (key === 'resolveLocus') return () => ({ serverId: channels[0]![0], channelId: channels[0]![1] });
      if (key === 'handleChannelToolCall') return async () => ({ success: true, data: {} });
      if (key === 'getChannelTools') return () => [];
      const value = (target as unknown as Record<string, unknown>)[key];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  module.during = async (c) => { if (c.id === 'one') await during(registry, open); };
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    await framework.runUntilIdle();
    await (framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('assistant');
  } finally {
    await framework.stop();
  }
  return { wire, traces };
}

test("with the real channel registry, a stream ends in a channel its server declared inbound-only mid-turn: the complete carries what it streamed there", async () => {
  const { wire } = await realRegistryTurn(
    [round(text('first'), call('one', 'test--read')), final(text('second'))],
    [['body', 'room']],
    async (registry) => {
      await registry.handleChanged('body', { updated: [{ id: 'room', type: 'chat', label: 'room', direction: 'inbound' }] } as never);
    },
  );
  assert.deepEqual(wire, ['body publish:first', 'body chunk:first', 'body complete:first'],
    'the later text is refused there, and the stream it took ends there');
});

test("with the real channel registry, a channel id that passes from one server to another mid-turn: the turn's words stay with its own server's channel, and the other server is sent nothing", async () => {
  // The turn's locus is a's room, with its server. b's room is another
  // channel with the same id, so the turn's later words aren't sent there:
  // they're refused, as a's room is no longer registered.
  const { wire, traces } = await realRegistryTurn(
    [round(text('first'), call('one', 'test--read')), final(text('second'))],
    [['a', 'room']],
    async (registry, open) => {
      await registry.handleChanged('a', { removed: ['room'] } as never);
      open('b', 'room');
    },
  );
  assert.deepEqual(wire, ['a publish:first', 'a chunk:first'],
    'b is sent nothing, and a, which no longer registers the channel, gets no complete');
  assert.deepEqual(traces, [
    'inference:published ["a","room"] first',
    'inference:published_complete ["a","room"] first',
  ], 'in-process consumers get the destination by its server');
});

test("with the real channel registry, a chunk follows its publish's destination: a channel that moves to another server as the publish is answered streams none of it there", async () => {
  // a removes `room` and b registers one while a's answer to the publish is
  // on its way: the chunk is a's, which no longer registers the channel, so
  // it goes nowhere, and never to b, whose channel got no publish.
  const { wire, traces } = await realRegistryTurn(
    [final(text('first'))],
    [['a', 'room']],
    async () => {},
    async (_text, registry, open) => {
      await registry.handleChanged('a', { removed: ['room'] } as never);
      open('b', 'room');
    },
  );
  assert.deepEqual(wire, ['a publish:first']);
  assert.deepEqual(traces, [
    'inference:published ["a","room"] first',
    'inference:published_complete ["a","room"] first',
  ], "the traces follow the publish's destination whatever the registry sends");
});

test('disabled: nothing streams, from a mid-turn round, trailing text or a text-only turn', async () => {
  for (const [script, branches] of [
    [[round(text('mid-turn'), call('one', 'test--read')), final(text('trailing'))], ['mid-turn prose', 'tool-call trailing prose']],
    [[final(text('text only'))], ['text-only prose']],
  ] as const) {
    const h = await harness([[...script]], { proseRouting: 'disabled' });
    const called: string[] = [];
    h.module.during = async (call) => { called.push(call.name); };
    // Each branch the turn reaches says it routed nothing; the test checks it reached them.
    const logged: string[] = [];
    const error = console.error;
    try {
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try { await h.run(); } finally { console.error = error; }
      for (const branch of branches) {
        assert.ok(logged.includes(`[routing] assistant: ${branch} NOT routed (proseRouting=disabled)`), `the ${branch} branch ran`);
      }
      assert.deepEqual(called, script.length > 1 ? ['read'] : [], "the tool round's call was made");
      assert.deepEqual(h.log, [], 'nothing is published, streamed or completed');
      assert.deepEqual(h.traces, [], 'and no published trace is emitted');
    } finally { await h.framework.stop(); }
  }
});

test("the sleep tool's announcement publishes through routeSpeech, as prose does, but isn't part of the stream", async () => {
  const h = await harness([[round(text('going quiet now'), call('s1', 'sleep', { seconds: 600 }))]], {}, { gate: true });
  try {
    await h.run();
    assert.ok(h.publishes().some((p) => p.channelId === 'world:test' && p.text.startsWith('\u{1F4A4}')), 'the sleep tool announced at the locus');
    assert.deepEqual(h.chunks().map((c) => c.text), ['going quiet now'], "the round's prose streams, and the announcement doesn't");
  } finally {
    // EventGate.dispose leaves a pending sleep's timer running, which would
    // keep this file alive for the whole sleep, so the test ends the sleep.
    (h.framework as unknown as { eventGate: { clearSleep(): boolean } }).eventGate.clearSleep();
    await h.framework.stop();
  }
});

test("the published traces are emitted when the channel's server takes no stream", async () => {
  const h = await harness([[round(text('first'), call('one', 'test--read')), final(text('second'))]], {}, { streaming: false });
  try {
    await h.run();
    assert.deepEqual(h.traces.map((t) => `${t.type}:${t.text}`), [
      'inference:published:first',
      'inference:published:\n\nsecond',
      'inference:published_complete:first\n\nsecond',
    ], 'in-process consumers still hear what was published');
  } finally { await h.framework.stop(); }
});

// A publish that fails streams nothing, on every delivery path.
const failedPublishCases: Array<{ name: string; mode: 'locus' | 'hybrid' | 'explicit'; script: () => NormalizedResponse[]; lost: string; kept?: string; bounces?: true }> = [
  { name: 'locus text-only', mode: 'locus', script: () => [final(text('lost'))], lost: 'lost' },
  { name: 'locus trailing', mode: 'locus', script: () => [round(text('kept'), call('one', 'test--read')), final(text('lost'))], lost: 'lost', kept: 'kept' },
  { name: 'hybrid unprefixed', mode: 'hybrid', script: () => [round(text('lost'), call('one', 'test--read')), final(text('kept'))], lost: 'lost', kept: 'kept' },
  { name: 'hybrid >>> target', mode: 'hybrid', script: () => [final(text('>>>#alpha lost'))], lost: 'lost', bounces: true },
  { name: 'explicit mid-turn', mode: 'explicit', script: () => [round(text('>>#alpha lost'), call('one', 'test--read')), final(text('>>#cafe kept'))], lost: 'lost', kept: 'kept', bounces: true },
  { name: 'explicit text-only', mode: 'explicit', script: () => [final(text('>>#alpha lost'))], lost: 'lost', bounces: true },
];
// The id a server returns for a publish rides on that publish's trace, on every delivery path.
for (const c of failedPublishCases) {
  test(`${c.name}: each published trace carries the message id its server returned for that publish`, async () => {
    const h = await harness([c.script()], { proseRouting: c.mode });
    const ids = new Map<string, string>([[c.lost, 'msg-1'], ...(c.kept ? [[c.kept, 'msg-2'] as [string, string]] : [])]);
    for (const [body, id] of ids) h.messageIds.set(body, id);
    try {
      await h.run();
      const published = h.traces.filter((t) => t.type === 'inference:published');
      const bodyOf = (t: { text: string }) => t.text.replace(/^\n\n/, '');
      assert.deepEqual(published.map(bodyOf).sort(), [...ids.keys()].sort(), 'each publish streamed once');
      for (const t of published) assert.equal(t.messageId, ids.get(bodyOf(t)), `"${bodyOf(t)}" carries its own publish's id`);
    } finally { await h.framework.stop(); }
  });
}

for (const c of failedPublishCases) {
  for (const failure of ['undelivered', 'unknown', 'throw'] as const) {
    const wakes = failure === 'undelivered' && c.bounces === true;
    test(`${c.name}: a publish that ${failedHow(failure)} streams nothing${wakes ? ', and its bounce wakes the agent with the notice' : ''}`, async () => {
      const h = await harness(wakes ? [c.script(), [final()]] : [c.script()], { proseRouting: c.mode });
      h.fails.set(c.lost, failure);
      try {
        await h.run();
        if (wakes) {
          const woken = h.membrane.requests[1]?.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '') ?? [];
          assert.ok(woken.some((t) => t.includes('was not delivered') && t.includes('held as draft')), "the wake's request carries the bounce notice");
        }
        assert.ok(h.publishes().some((p) => p.text === c.lost), 'the publish was tried');
        assert.equal(h.chunks().some((ch) => ch.text.includes(c.lost)), false, 'no chunk carries it');
        assert.equal(h.completes().some((co) => co.text.includes(c.lost)), false, 'nor does a complete');
        assert.equal(h.traces.some((t) => t.text.includes(c.lost)), false, 'nor a published trace');
        if (c.kept) {
          assert.deepEqual(h.chunks().map((ch) => ch.text), [c.kept], 'the publish beside it that succeeds still streams');
        }
      } finally { await h.framework.stop(); }
    });
  }
}
