/**
 * Explicit prose routing (docs/explicit-prose-routing.md).
 *
 * The model names every destination in-band (`>>` prefixes); unprefixed prose
 * is NEVER delivered — it bounces to a clipboard for a prefixed resend. The
 * laria regression (2026-07-24): a DM reply generated while the host-inferred
 * locus pointed at a guild channel was misdelivered there. In explicit mode
 * that class is structurally impossible: the worst case is a bounce.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  InferenceRequest,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { ProseStreamRouter } from '../src/mcpl/prose-stream-router.js';
import type { ContentBlock } from '@animalabs/membrane';

class ToolboxModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  calls: ToolCall[] = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'move',
      description: 'Move the robot',
      inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    }, {
      name: 'say',
      description: 'Publish speech into the world',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { ok: true, published: call.name.endsWith('--say') } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const text = String((event as { content?: unknown }).content);
      return {
        addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }],
        requestInference: text === 'go',
      };
    }
    return {};
  }
}

/** Registry stub: two known channels (#alpha guild, laria's DM) + capture. */
function stubRegistry(framework: AgentFramework, plan: Array<'delivered' | 'false' | 'throw'> = []) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const known: Record<string, { channelId: string; label: string }> = {
    '#alpha': { channelId: 'chan-alpha', label: '#alpha' },
    '#cafe': { channelId: 'discord:g:cafe', label: '#cafe' },
    'world:commons': { channelId: 'world:commons', label: 'world:commons' },
    'alpha': { channelId: 'chan-alpha', label: '#alpha' },
    'chan-alpha': { channelId: 'chan-alpha', label: '#alpha' },
    '@laria': { channelId: 'discord:dm:99', label: 'DM: laria' },
    'discord:dm:99': { channelId: 'discord:dm:99', label: 'DM: laria' },
  };
  const explicit: Record<string, unknown> = {
    resolveProseTarget: (spec: string) =>
      known[spec] ?? { error: `no channel matches "${spec}"` },
    routeSpeech: async (_agent: string, text: string, locus?: string | null) => {
      routed.push({ text, locus: locus ?? null });
      const behavior = plan.shift() ?? 'delivered';
      if (behavior === 'throw') throw new Error('synthetic publication failure');
      return { delivered: behavior === 'delivered', channelId: locus ?? '' };
    },
    resolveLocus: () => 'world:commons',
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

describe('explicit prose routing', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: ToolboxModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'epr-test-'));
    membrane = new MockMembrane();
    module = new ToolboxModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(mode: 'explicit' | 'hybrid' | 'disabled' = 'explicit'): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'assistant',
        model: 'test-model',
        systemPrompt: 'You are a test agent.',
        proseRouting: mode,
      }],
      modules: [module],
    });
    module.framework = framework;
    return framework;
  }

  function trigger(framework: AgentFramework): void {
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: {},
    } as unknown as ProcessEvent);
  }

  /** Feed a response for the Nth turn (1-based) the moment it starts —
   *  MockMembrane hands ALL remaining responses to the first stream, so
   *  later turns must receive theirs at inference:started time. */
  function feedTurn(framework: AgentFramework, turn: number, blocks: ContentBlock[], stop?: string): void {
    let count = 0;
    const off = framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      count++;
      if (count === turn) {
        membrane.pushResponse(createMockResponse(blocks, stop as never));
        off();
      }
    });
  }

  it('unprefixed prose NEVER delivers — bounces to clipboard, then a prefixed {{unsent}} resend delivers verbatim (laria regression)', async () => {
    const original = 'laria.\n\nYes, I remember. Two words through the keyhole.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: original }] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    const bounceNotices: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-bounce') bounceNotices.push(1);
    });

    // Turn 2 = the bounce-wake: model resends with a destination.
    feedTurn(framework, 2, [{ type: 'text', text: '>>@laria {{unsent}}' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(bounceNotices.length, 1, 'exactly one bounce notice');
    assert.equal(routed.length, 1, 'only the prefixed resend delivered');
    assert.equal(routed[0]!.locus, 'discord:dm:99', 'delivered to the DM the model named');
    assert.equal(routed[0]!.text, original, 'clipboard substitution is verbatim');

    await framework.stop();
  });

  it('resolves label prefixes and applies the sticky turn target to later unprefixed segments', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first segment' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'second segment, no prefix' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'first segment', locus: 'chan-alpha' },
      { text: 'second segment, no prefix', locus: 'chan-alpha' },
    ], 'prefix stripped on wire; sticky target carries the second segment');

    await framework.stop();
  });

  it('>>skip_reply keeps the text in context — nothing delivered, no bounce', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>skip_reply\nWorking through the plan here.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    const bounceNotices: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-bounce') bounceNotices.push(1);
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(routed.length, 0, 'skip_reply text is never delivered');
    assert.equal(bounceNotices.length, 0, 'skip_reply text never bounces');

    await framework.stop();
  });

  /** The registry stub answers skip_reply as the real registry does: the turn ends, and nothing is sent. */
  function answerSkipReply(framework: AgentFramework): { calls: number } {
    const answered = { calls: 0 };
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.handleChannelToolCall = async (name: string) => {
      if (name === 'skip_reply') answered.calls++;
      return { success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } };
    };
    return answered;
  }

  /** What the registry stub's streaming surface receives (MCPL Spec 14.3 chunk and complete). */
  function captureStream(framework: AgentFramework) {
    const chunks: Array<{ channelId: string; delta: string }> = [];
    const completes: Array<{ channelId: string; text: string }> = [];
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.sendOutgoingChunk = (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      chunks.push({ channelId, delta });
    };
    registry.sendOutgoingComplete = (channelId: string, _agent: string, _id: string, text: string) => {
      completes.push({ channelId, text });
    };
    return { chunks, completes };
  }

  /** The texts of the agent's context, and the bounce notices among them. */
  function context(framework: AgentFramework): { texts: string[]; bounces: number } {
    const messages = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{
      content: Array<{ type: string; text?: string }>;
      metadata?: { kind?: string };
    }>;
    return {
      texts: messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')),
      bounces: messages.filter((m) => m.metadata?.kind === 'prose-bounce').length,
    };
  }

  const clipboardOf = (framework: AgentFramework): string | undefined =>
    (framework as unknown as { proseClipboards: Map<string, string> }).proseClipboards.get('assistant');

  it('a round that calls skip_reply keeps its unprefixed prose private: nothing delivered, bounced, retained or woken for', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Weighing whether this needs an answer from me.' },
      { type: 'tool_use', id: 'sr1', name: 'skip_reply', input: { reason: 'nothing to add' } },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    // Were the text bounced, its wake would start a second turn: give that
    // turn a response, so the test fails on its count instead of hanging.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);

    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.equal(routed.length, 0, 'nothing is delivered');
    const seen = context(framework);
    assert.equal(seen.bounces, 0, 'no bounce notice reaches the context');
    assert.ok(seen.texts.some((t) => t.includes('Weighing whether this needs an answer')), 'the text stays in the context');
    assert.equal(clipboardOf(framework), undefined, 'nothing is retained for {{unsent}}');
    assert.equal(turns, 1, 'no bounce wake starts another turn');

    await framework.stop();
  });

  it('a round that calls skip_reply keeps its unprefixed prose from a sticky destination', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first, deliberately' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Second thoughts I keep to myself.' },
      { type: 'tool_use', id: 'sr2', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.deepEqual(routed, [{ text: 'first, deliberately', locus: 'chan-alpha' }],
      'only the earlier, deliberately addressed segment goes out');
    assert.ok(context(framework).texts.some((t) => t.includes('Second thoughts I keep to myself.')), 'the text stays in the context');

    await framework.stop();
  });

  it('a round that calls skip_reply sends nothing, a prefixed segment included, and asks for no continuation', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha ! addressed, then thought better of' },
      { type: 'tool_use', id: 'sr3', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    // A continuation would start a second turn: give it a response, so the
    // test fails on its count instead of hanging.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.equal(routed.length, 0, 'skip_reply ends the turn without sending anything');
    assert.equal(context(framework).bounces, 0);
    assert.equal(turns, 1, "the round's ' !' starts no continuation after skip_reply ended the turn");

    await framework.stop();
  });


  type RoutingState = {
    pin?: string; destination: string | null; hybridHold: boolean;
    logical: { continuation: boolean; deliveries: string[]; suppressed: number };
  };

  async function within<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), ms);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  function nextTrace(framework: AgentFramework, type: string) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const off = framework.onTrace((event) => {
      if (event.type === type && (event as { agentName?: string }).agentName === 'assistant') {
        off();
        resolve();
      }
    });
    return { promise, dispose: off };
  }

  async function withQueuedTurns(
    mode: 'explicit' | 'hybrid',
    lateText: string,
    nextResponses: ReturnType<typeof createMockResponse>[],
    inspect: (fixture: {
      framework: AgentFramework; routed: Array<{ text: string; locus: string | null }>;
      earlier: RoutingState; next: RoutingState; turns: () => number;
      release: () => void; drain: () => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    const arrows = mode === 'explicit' ? '>>' : '>>>';
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: arrows + '#alpha first' },
      { type: 'tool_use', id: 'q1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: lateText },
      { type: 'tool_use', id: 'q2', name: 'robot--move', input: { dir: 'south' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'q3', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework(mode);
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    const route = registry.routeSpeech as (agent: string, text: string, locus?: string | null) => Promise<unknown>;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    registry.routeSpeech = async (agent: string, text: string, locus?: string | null) => {
      const outcome = await route(agent, text, locus);
      if (text.trim() === 'first') await held;
      return outcome;
    };
    let turns = 0;
    framework.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      turns++;
      if (turns === 2) for (const response of nextResponses) membrane.pushResponse(response);
      // Serve a bounce wake or an unexpected continuation without hanging.
      if (turns === 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: arrows + 'skip_reply' }]));
    });
    const internals = framework as unknown as {
      turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
      processInferenceRequests(): Promise<void>;
    };
    const processRequests = internals.processInferenceRequests.bind(framework);
    let nextWakeQueued = false;
    let resolveBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { resolveBlocked = resolve; });
    internals.processInferenceRequests = async () => {
      await processRequests();
      if (nextWakeQueued && turns === 1 && internals.pendingRequests.some((r) => r.agentName === 'assistant')) {
        resolveBlocked();
      }
    };
    const ended = nextTrace(framework, 'inference:turn_ended');
    let completed: ReturnType<typeof nextTrace> | undefined;
    let started: ReturnType<typeof nextTrace> | undefined;
    let stopped = false;
    let driving: Promise<void> | undefined;
    const drain = async () => {
      stopped = true;
      if (driving) await within(driving, 'the queued turns to drain', 10000);
    };
    try {
      trigger(framework);
      driving = (async () => {
        while (!stopped) {
          await framework.runUntilIdle();
          if (!stopped) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })();
      void driving.catch(() => {});
      await within(ended.promise, 'the first turn to end');
      assert.equal(skip.calls, 1, 'skip_reply ended the first turn');
      const earlier = internals.turnRouting.get('assistant')!;
      completed = nextTrace(framework, 'inference:completed');
      started = nextTrace(framework, 'inference:started');
      nextWakeQueued = true;
      trigger(framework);
      if (mode === 'hybrid') {
        const disposition = await within(Promise.race([
          blocked.then(() => 'blocked'), started.promise.then(() => 'started'),
        ]), 'the next wake to reach scheduling');
        assert.equal(disposition, 'blocked', 'hybrid retains the earlier turn token until its receipt tail drains');
        assert.equal(internals.turnRouting.get('assistant'), earlier, 'the earlier turn still owns routing');
        assert.deepEqual(routed.map((r) => r.text.trim()), ['first']);
        release();
        await within(completed.promise, 'the next inference after release');
        assert.equal(turns, 2, 'hybrid starts the next turn after the earlier teardown');
      } else {
        await within(completed.promise, 'the next inference to complete');
        assert.equal(turns, 2, 'explicit starts the next turn without waiting');
        assert.deepEqual(routed.map((r) => r.text.trim()), ['first'],
          "only the first post has entered routing while its confirmation is held");
      }
      await inspect({ framework, routed, earlier, next: internals.turnRouting.get('assistant')!,
        turns: () => turns, release, drain });
    } finally {
      ended.dispose();
      completed?.dispose();
      started?.dispose();
      internals.processInferenceRequests = processRequests;
      release();
      try { await drain(); } finally { await framework.stop(); }
    }
  }


  async function withHeldHybridCallback(
    lateText: string | null,
    inspect: (fixture: {
      framework: AgentFramework; routed: Array<{ text: string; locus: string | null }>;
      gateway: {
        deliverHybridProse(agent: unknown, text: string, locus: string, allowLocus: boolean, routing: RoutingState): Promise<void>;
        appendProseDeliveryReceipt(agent: unknown, routing: RoutingState): void;
      };
      earlier: RoutingState; next: RoutingState; agent: unknown;
      pending: Promise<void>; release: () => void;
    }) => Promise<void>,
  ): Promise<void> {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      turnRouting: Map<string, RoutingState>;
      deliverHybridProse(agent: unknown, text: string, locus: string, allowLocus: boolean, routing: RoutingState): Promise<void>;
      appendProseDeliveryReceipt(agent: unknown, routing: RoutingState): void;
    };
    const agent = framework.getAgent('assistant')!;
    const earlier: RoutingState = { destination: null, hybridHold: false, logical: { continuation: false, deliveries: [], suppressed: 0 } };
    const next: RoutingState = { ...earlier, logical: { continuation: false, deliveries: [], suppressed: 0 } };
    gateway.turnRouting.set('assistant', earlier);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    const route = registry.routeSpeech as (agent: string, text: string, locus?: string | null) => Promise<unknown>;
    let release!: () => void;
    let resolveEntered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    registry.routeSpeech = async (name: string, text: string, locus?: string | null) => {
      const outcome = await route(name, text, locus);
      resolveEntered();
      await held;
      return outcome;
    };
    const first = gateway.deliverHybridProse(agent, '>>>#alpha first', 'world:commons', true, earlier);
    const pending = lateText === null ? first
      : first.then(() => gateway.deliverHybridProse(agent, lateText, 'world:commons', true, earlier));
    void pending.catch(() => {});
    try {
      await within(entered, 'the earlier callback to enter routing');
      // Exercise callback ownership directly. Normal hybrid scheduling keeps
      // its turn token until the receipt tail drains, so fresh turns serialize.
      gateway.turnRouting.set('assistant', next);
      await inspect({ framework, routed, gateway, earlier, next, agent, pending, release });
    } finally {
      release();
      try { await within(pending, 'the held callback to drain'); } finally { await framework.stop(); }
    }
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    const title = mode === 'explicit'
      ? "explicit: prose a turn leaves queued follows that turn's destination, and the next turn's posts wait behind it"
      : "hybrid: the next turn waits for the ended turn's receipt tail, and posts keep their destinations and order";
    it(title, async () => {
      const arrows = mode === 'explicit' ? '>>' : '>>>';
      await withQueuedTurns(mode, 'and then this', [
        createMockResponse([{ type: 'text', text: arrows + '#cafe next' }]),
      ], async ({ framework, routed, release, drain }) => {
        release();
        await drain();
        assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), [
          { text: 'first', locus: 'chan-alpha' },
          { text: 'and then this', locus: 'chan-alpha' },
          { text: 'next', locus: 'discord:g:cafe' },
        ], "each post follows its own turn's destination, in delivery order");
        assert.equal(context(framework).bounces, 0, 'nothing bounces into the next turn');
      });
    });
  }

  it("a queued round's late continuation starts once its tool-ended turn's deliveries have run", async () => {
    await withQueuedTurns('explicit', '>>#alpha ! late', [
      createMockResponse([{ type: 'text', text: '>>#cafe next' }]),
    ], async ({ earlier, next, turns, release, drain }) => {
      assert.equal(earlier.logical.continuation, false, 'the continuation has not run before release');
      release();
      for (const end = Date.now() + 5000; turns() < 3 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await drain();
      assert.equal(turns(), 3, 'the continuation starts its own turn, once');
      assert.equal(earlier.logical.continuation, false, "the earlier turn's request was taken from its own object");
      assert.equal(next.logical.continuation, false, 'the next turn never receives that continuation');
    });
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
    it(`${mode}: a ' !' an earlier round asked for starts its continuation when skip_reply ends the turn`, async () => {
      const arrows = mode === 'explicit' ? '>>' : '>>>';
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: arrows + '#alpha ! keep going' },
        { type: 'tool_use', id: 'k1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'k2', name: 'skip_reply', input: {} },
      ] as ContentBlock[], 'tool_use'));

      const framework = await createFramework(mode);
      const routed = stubRegistry(framework);
      const skip = answerSkipReply(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: arrows + 'skip_reply' }] as ContentBlock[]);
      const reasons: string[] = [];
      const internals = framework as unknown as { pendingRequests: InferenceRequest[]; processInferenceRequests(): Promise<void> };
      const process = internals.processInferenceRequests.bind(framework);
      internals.processInferenceRequests = async () => {
        for (const request of internals.pendingRequests) reasons.push(request.reason);
        await process();
      };

      trigger(framework);
      await framework.runUntilIdle();
      for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        await framework.runUntilIdle();
      }

      assert.equal(skip.calls, 1, 'skip_reply ended the first turn');
      assert.deepEqual(routed.map((r) => r.text.trim()), ['keep going']);
      assert.ok(reasons.includes('prose-continuation'), 'the continuation was requested');
      assert.equal(turns, 2, 'and it started one more turn');

      await framework.stop();
    });
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    it(`${mode}: a tool-ended turn's ' !' queued behind a held post starts its continuation once that post settles`, async () => {
      const arrows = mode === 'explicit' ? '>>' : '>>>';
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: `${arrows}#alpha first\n${arrows}#alpha ! second` },
        { type: 'tool_use', id: 'w1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'w2', name: 'skip_reply', input: {} },
      ] as ContentBlock[], 'tool_use'));
      const framework = await createFramework(mode);
      const routed = stubRegistry(framework);
      answerSkipReply(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: arrows + 'skip_reply' }] as ContentBlock[]);
      const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
      const route = registry.routeSpeech as (agent: string, text: string, locus?: string | null) => Promise<unknown>;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      registry.routeSpeech = async (agent: string, text: string, locus?: string | null) => {
        const outcome = await route(agent, text, locus);
        if (text.trim() === 'first') { entered(); await held; }
        return outcome;
      };
      const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
      const ended = nextTrace(framework, 'inference:turn_ended');
      trigger(framework);
      const running = framework.runUntilIdle();
      try {
        await within(reached, "the first envelope's post to start");
        await within(ended.promise, 'skip_reply to end the turn');
        assert.equal(turns, 1);
        assert.ok(!internals.pendingRequests.some((r) => r.reason === 'prose-continuation'),
          "no continuation while the ' !' envelope waits behind the held post");
        release();
        await within(running, 'the turn to settle');
        for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          await framework.runUntilIdle();
        }
        assert.deepEqual(routed.map((r) => r.text.trim()), ['first', 'second']);
        assert.equal(turns, 2, 'the continuation starts once the queued envelope has run');
      } finally {
        ended.dispose();
        release();
        await framework.stop();
      }
    });
  }

  for (const when of ['already set', 'set late'] as const) {
    it(`hybrid: a ' !' an earlier stream asked for (${when}) still starts its continuation after a re-inference on unstreamed tool results`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }] as ContentBlock[]));
      const framework = await createFramework('hybrid');
      const routed = stubRegistry(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply' }] as ContentBlock[]);
      const internals = framework as unknown as {
        turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
        proseSpeechChains: Map<string, Promise<void>>;
        openLogical: Map<string, RoutingState['logical']>;
      };
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      try {
        // The turn's earlier stream asked for a continuation, or will once
        // its queued delivery runs; the turn goes on in a re-inference, which
        // starts a new stream with a fresh routing state while the earlier
        // stream's logical turn is still open.
        const earlier: RoutingState = { destination: null, hybridHold: false, logical: { continuation: when === 'already set', deliveries: [], suppressed: 0 } };
        internals.turnRouting.set('assistant', earlier);
        internals.openLogical.set('assistant', earlier.logical);
        if (when === 'set late') {
          internals.proseSpeechChains.set('assistant', held.then(() => { earlier.logical.continuation = true; }));
        }
        internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);
        const running = framework.runUntilIdle();
        if (when === 'set late') {
          for (const end = Date.now() + 5000; turns < 1 && Date.now() < end;) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
          assert.equal(turns, 1, 'the re-inference has started');
          assert.equal(earlier.logical.continuation, false, 'the earlier delivery has not run as the re-inference starts');
          release();
        }
        await within(running, 'the re-inference to settle');
        for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          await framework.runUntilIdle();
        }
        assert.deepEqual(routed.map((r) => r.text.trim()), ['carrying on']);
        assert.equal(turns, 2, 'the re-inference completes, then the continuation it carried starts');
        assert.equal(earlier.logical.continuation, false, "the check took the earlier stream's flag");
      } finally {
        release();
        await framework.stop();
      }
    });
  }

  it("hybrid: a re-inference on unstreamed tool results receipts the earlier stream's late delivery with its own", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });
    const internals = framework as unknown as {
      turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
      proseSpeechChains: Map<string, Promise<void>>;
      openLogical: Map<string, RoutingState['logical']>;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      // The earlier stream left its tool results pending, its logical turn
      // still open; its delivery lands only after the re-inference has
      // begun, into the logical turn the two share.
      const earlier: RoutingState = { destination: null, hybridHold: false, logical: { continuation: false, deliveries: [], suppressed: 0 } };
      internals.turnRouting.set('assistant', earlier);
      internals.openLogical.set('assistant', earlier.logical);
      internals.proseSpeechChains.set('assistant', held.then(() => { earlier.logical.deliveries.push('chan-alpha'); }));
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);
      const running = framework.runUntilIdle();
      for (const end = Date.now() + 5000; turns < 1 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(turns, 1, 'the re-inference has started');
      assert.deepEqual(earlier.logical.deliveries, [], 'the earlier delivery has not landed yet');
      release();
      await within(running, 'the re-inference to settle');
      assert.deepEqual(routed.map((r) => r.text.trim()), ['carrying on']);
      const receipt = context(framework).texts.filter((t) => t.startsWith('[delivered]'));
      assert.equal(receipt.length, 1, `one receipt for the logical turn: ${receipt.join(' | ')}`);
      assert.match(receipt[0]!, /chan-alpha/, "it reports the earlier stream's late delivery");
      assert.match(receipt[0]!, /world:commons/, "and the re-inference's own");
    } finally {
      release();
      await framework.stop();
    }
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
  const p = mode === 'explicit' ? '>>' : '>>>';
  it(`${mode}: an error retry keeps a ' !' whose envelope is delivered after the retry starts`, async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: `${p}#alpha first\n${p}#alpha ! second` },
      { type: 'tool_use', id: 'retry-held', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const framework = await createFramework(mode);
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      proseSpeechChains: Map<string, Promise<void>>;
      channelRegistry: { routeSpeech: (...args: unknown[]) => Promise<unknown> };
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const route = internals.channelRegistry.routeSpeech;
    internals.channelRegistry.routeSpeech = async (...args: unknown[]) => {
      const result = await route(...args);
      if (String(args[1]).trim() === 'first') { reached(); await held; }
      return result;
    };
    let firstChain: Promise<void> | undefined;
    let restarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => { restarted = resolve; });
    let starts = 0;
    framework.onTrace((event) => {
      if (event.type === 'inference:failed') firstChain = internals.proseSpeechChains.get('assistant');
      if (event.type === 'inference:started') {
        starts++;
        if (starts === 2) {
          membrane.pushResponse(createMockResponse([{ type: 'text', text: `${p}skip_reply retry done` }]));
          restarted();
        }
        if (starts === 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: `${p}skip_reply continuation done` }]));
      }
    });
    // The first stream ends in a retryable error instead of completing; the
    // retry's own end waits for the first stream's queued deliveries, so the
    // held ' !' envelope runs after the retry has started.
    const makeStream = membrane.streamYielding.bind(membrane);
    let streams = 0;
    membrane.streamYielding = (request, options) => {
      const stream = makeStream(request, options);
      const index = ++streams;
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && index === 1) {
            yield { type: 'error' as const, error: new Error('synthetic transient stream error') };
            return;
          }
          if (event.type === 'complete' && index === 2) {
            assert.ok(firstChain, 'the first stream queued a delivery chain');
            await firstChain;
          }
          yield event;
        }
      };
      return stream;
    };
    let running: Promise<void> | undefined;
    try {
      trigger(framework);
      running = framework.runUntilIdle();
      void running.catch(() => {});
      await within(entered, 'the held first post');
      await within(retryStarted, 'the error retry to start', 10000);
      assert.equal(starts, 2);
      release();
      await within(running, 'the retry and continuation to finish', 10000);
      assert.deepEqual(routed.map((r) => r.text.trim()), ['first', 'second']);
      assert.equal(membrane.calls.length, 3, "the late ' !' survives the error retry and starts a continuation");
    } finally {
      release();
      if (running) await running;
      await framework.stop();
    }
  });
  }

  it("the non-streaming fallback leaves the scheduling turn's logical turn open for the re-inference", async () => {
    // Adapted from a reviewer's producer test: the agent's direct inference
    // API leaves tools pending with no yielding stream, and the tool result
    // goes through the framework's real event handling.
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    const agent = framework.getAgent('assistant')!;
    const internals = framework as unknown as {
      routingOf(name: string): RoutingState;
      openLogical: Map<string, unknown>;
      pendingRequests: InferenceRequest[];
      handleProcessEvent(event: ProcessEvent): Promise<void>;
    };
    const origin = internals.routingOf('assistant').logical;
    origin.continuation = true;
    origin.deliveries.push('chan-alpha');
    // The turn that ran the tools is open, as its fresh start left it.
    internals.openLogical.set('assistant', origin);
    const response = createMockResponse([
      { type: 'tool_use', id: 'unstreamed-one', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use');
    (membrane as unknown as { stream: () => Promise<typeof response> }).stream = async () => response;
    try {
      agent.getContextManager().addMessage('user', [{ type: 'text', text: 'Take the direct inference path.' }]);
      await agent.runInference(framework.getAllTools());
      assert.equal(agent.state.status, 'waiting_for_tools');
      assert.equal((agent.state as { stream?: unknown }).stream, undefined, 'the direct API has no yielding stream');
      agent.addAssistantResponse(response.content);
      await internals.handleProcessEvent({
        type: 'tool-result', source: 'robot', moduleName: 'robot', agentName: 'assistant', callId: 'unstreamed-one',
        result: { success: true, data: { ok: true } },
      } as ProcessEvent);
      assert.ok(internals.pendingRequests.some((r) => r.reason === 'tool_results_ready'), 'the fallback scheduled the re-inference');
      assert.equal(internals.openLogical.get('assistant'), origin, 'without settling the turn it continues');
    } finally {
      await framework.stop();
    }
  });

  it("a settle closes the open logical turn only when it is the settling stream's own, and stop() clears open turns", async () => {
    const framework = await createFramework('hybrid');
    const internals = framework as unknown as {
      openLogical: Map<string, RoutingState['logical']>;
      settleAgent(name: string, outcome: { stopReason: 'completed'; speech: string }, closes: RoutingState['logical'] | undefined): void;
    };
    const open: RoutingState['logical'] = { continuation: true, deliveries: [], suppressed: 0 };
    const stale: RoutingState['logical'] = { continuation: false, deliveries: [], suppressed: 0 };
    internals.openLogical.set('assistant', open);
    // A settle from a stream a newer one replaced passes its own logical
    // turn, or none; neither closes the open one.
    internals.settleAgent('assistant', { stopReason: 'completed', speech: '' }, stale);
    internals.settleAgent('assistant', { stopReason: 'completed', speech: '' }, undefined);
    assert.equal(internals.openLogical.get('assistant'), open, "a stale settle leaves the newer turn open");
    internals.settleAgent('assistant', { stopReason: 'completed', speech: '' }, open);
    assert.equal(internals.openLogical.has('assistant'), false, "the turn's own settle closes it");
    internals.openLogical.set('assistant', open);
    await framework.stop();
    assert.equal(internals.openLogical.size, 0, 'stop() clears every open logical turn');
  });

  it('a silent start leaves an open logical turn to the next start that routes prose', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'quiet' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });
    const internals = framework as unknown as {
      turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
      openLogical: Map<string, RoutingState['logical']>;
    };
    try {
      const open: RoutingState['logical'] = { continuation: true, deliveries: [], suppressed: 0 };
      internals.openLogical.set('assistant', open);
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'heartbeat', source: 'framework', timestamp: Date.now(), suppressProse: true } as InferenceRequest);
      // Bounded: a silent start that took the open turn's ' !' would start a
      // continuation with no response queued, and this would wait for good.
      await within(framework.runUntilIdle(), 'the silent turn to settle', 3000);
      assert.equal(turns, 1);
      assert.notEqual(internals.turnRouting.get('assistant')?.logical, open, 'the silent start kept a logical turn of its own');
      assert.equal(internals.openLogical.get('assistant'), open, 'and neither took nor closed the open one');
      assert.equal(open.continuation, true, "the open turn's ' !' is untouched");
      // The next start that routes prose continues it, and its ' !' runs.
      // (feedTurn counts starts from here: the prose turn is 1, the
      // continuation 2.)
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>skip_reply' }] as ContentBlock[]));
      feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      for (const end = Date.now() + 5000; turns < 3 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        await framework.runUntilIdle();
      }
      assert.equal(turns, 3, "the next prose turn continued the open turn and took its ' !'");
    } finally {
      await framework.stop();
    }
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
    it(`${mode}: the wake that consumes unstreamed tool results continues the turn that scheduled them`, async () => {
      const p = mode === 'explicit' ? '>>' : '>>>';
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `${p}skip_reply carrying on` }] as ContentBlock[]));
      const framework = await createFramework(mode);
      stubRegistry(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: `${p}skip_reply` }] as ContentBlock[]);
      const internals = framework as unknown as {
        turnRouting: Map<string, RoutingState>;
        openLogical: Map<string, RoutingState['logical']>;
      };
      try {
        // The scheduling turn asked for a continuation and left its tool
        // results pending; the scheduler then starts the agent with another
        // wake, which consumes them.
        const scheduling: RoutingState = { destination: null, hybridHold: false, logical: { continuation: true, deliveries: [], suppressed: 0 } };
        internals.openLogical.set('assistant', scheduling.logical);
        internals.turnRouting.set('assistant', { destination: null, hybridHold: false, logical: { continuation: false, deliveries: [], suppressed: 0 } });
        trigger(framework);
        await framework.runUntilIdle();
        for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          await framework.runUntilIdle();
        }
        assert.equal(turns, 2, "the consuming turn took the scheduling turn's ' !'");
        assert.equal(scheduling.logical.continuation, false);
        assert.equal(internals.openLogical.has('assistant'), false, 'and the turns it ran have settled');
      } finally {
        await framework.stop();
      }
    });
  }

  for (const boundary of ['stop', 'dispose'] as const) {
    it(`a tool-ended explicit turn's late ' !' takes no new turn after ${boundary === 'stop' ? 'stop()' : 'its agent is disposed'}`, async () => {
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: '>>#alpha ! first' },
        { type: 'tool_use', id: 'p1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'p2', name: 'skip_reply', input: {} },
      ] as ContentBlock[], 'tool_use'));
      const framework = await createFramework();
      stubRegistry(framework);
      answerSkipReply(framework);
      const internals = framework as unknown as {
        channelRegistry: { routeSpeech: (...args: unknown[]) => Promise<unknown> };
        proseSpeechChains: Map<string, Promise<void>>;
        turnRouting: Map<string, RoutingState>;
        pendingRequests: InferenceRequest[];
        disposeConversationAgent(name: string): void;
      };
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      internals.channelRegistry.routeSpeech = async () => {
        entered();
        await held;
        return { delivered: true, channelId: 'chan-alpha' };
      };
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the tool-ended turn to settle');
        await within(reached, 'the queued delivery to reach routing');
        const chain = internals.proseSpeechChains.get('assistant')!;
        const routing = internals.turnRouting.get('assistant')!;
        assert.equal(routing.logical.continuation, true, "the held delivery's ' !' is on its turn's object");
        assert.equal(internals.pendingRequests.length, 0);
        if (boundary === 'stop') await framework.stop();
        else internals.disposeConversationAgent('assistant');
        release();
        await within(chain, 'the queued delivery');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(internals.pendingRequests.filter((r) => r.reason === 'prose-continuation').length, 0,
          'the late check adds no request');
        assert.equal(routing.logical.continuation, false, 'it took the flag and dropped it');
      } finally {
        release();
        await framework.stop();
      }
    });
  }

  it("hybrid: a held callback's late malformed envelope holds only its supplied turn", async () => {
    await withHeldHybridCallback('>>>', async ({ earlier, next, routed, gateway, agent, pending, release }) => {
      assert.equal(earlier.hybridHold, false, 'the malformed envelope has not run before release');
      release();
      await within(pending, 'the late malformed envelope');
      assert.equal(earlier.hybridHold, true, 'the late hold belongs to the supplied earlier turn');
      assert.equal(next.hybridHold, false, 'the newer object stays unheld');
      await gateway.deliverHybridProse(agent, 'next', 'world:commons', true, next);
      assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), [
        { text: 'first', locus: 'chan-alpha' },
        { text: 'next', locus: 'world:commons' },
      ], 'the newer callback still publishes to its own locus');
    });
  });

  it("hybrid callbacks and receipts keep each turn's counts while a post is held", async () => {
    await withHeldHybridCallback(null, async ({ framework, earlier, next, gateway, agent, pending, release }) => {
      await gateway.deliverHybridProse(agent, 'quiet without a destination', 'world:commons', false, next);
      release();
      await within(pending, 'the earlier delivery confirmation');
      gateway.appendProseDeliveryReceipt(agent, earlier);
      gateway.appendProseDeliveryReceipt(agent, next);
      const receipts = context(framework).texts.filter((text) => text.startsWith('[delivered]'));
      assert.equal(receipts.length, 2, 'each supplied turn gets its own receipt');
      const delivered = receipts.find((text) => text.includes('chan-alpha'));
      const suppressed = receipts.find((text) => text.includes('suppressed'));
      assert.ok(delivered, "the earlier turn's delivery is acknowledged");
      assert.doesNotMatch(delivered, /suppressed/, "the earlier receipt excludes the newer suppression");
      assert.ok(suppressed, "the newer turn's suppression is acknowledged");
      assert.match(suppressed, /1 plain-speech segment.*suppressed/);
      assert.doesNotMatch(suppressed, /chan-alpha/, "the newer receipt excludes the earlier delivery");
    });
  });

  it("a private round's ' !' leaves no continuation request behind", async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      deliverProse(agent: unknown, text: string, round?: { keepPrivate?: boolean }): Promise<void>;
      turnRouting: Map<string, { logical: { continuation: boolean } }>;
    };
    const agent = framework.getAgent('assistant')!;

    // When skip_reply ends an explicit turn, the speech chain isn't awaited,
    // so the round's delivery can run once the next turn has begun.
    await internals.deliverProse(agent, '>>#alpha ! kept private', { keepPrivate: true });
    assert.equal(routed.length, 0, 'nothing is delivered');
    assert.equal(internals.turnRouting.get('assistant')?.logical.continuation ?? false, false, 'and no continuation is asked for');

    // The same envelope outside a private round asks for one.
    await internals.deliverProse(agent, '>>#alpha ! sent');
    assert.equal(routed.length, 1);
    assert.equal(internals.turnRouting.get('assistant')?.logical.continuation, true);

    await framework.stop();
  });

  it('a skip_reply round that sets the retained text aside with >>skip_reply {{unsent}} clears it', async () => {
    // Turn 1 bounces its text, which retains it and wakes turn 2.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'An answer with nowhere to go.' }] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    feedTurn(framework, 2, [
      { type: 'text', text: '>>skip_reply {{unsent}}' },
      { type: 'tool_use', id: 'sr4', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use');

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the bounce wake ran the skip_reply round');
    assert.equal(routed.length, 0);
    assert.equal(clipboardOf(framework), undefined, 'the retained text is set aside, as >>skip_reply {{unsent}} says');

    await framework.stop();
  });

  it('explicit mode streams nothing before a destination: unprefixed text never reaches the trigger channel', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Unprefixed musing.\n>>#alpha streamed after the prefix' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubRegistry(framework);
    const stream = captureStream(framework);
    // The unprefixed line bounces, and its wake starts a second turn.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);

    // A turn the trigger channel woke: chan-alpha is where its typing shows.
    const internals = framework as unknown as {
      pendingRequests: InferenceRequest[];
      processInferenceRequests(): Promise<void>;
    };
    internals.pendingRequests.push({
      agentName: 'assistant', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(),
      channelId: 'chan-alpha', addressed: true,
    });
    await internals.processInferenceRequests();
    await framework.runUntilIdle();

    const streamed = stream.chunks.map((c) => c.delta).join('');
    assert.ok(streamed.includes('streamed after the prefix'), 'prefixed text streams to its destination');
    assert.equal(streamed.includes('Unprefixed musing.'), false, 'unprefixed text is never streamed');
    assert.equal(stream.completes.some((c) => c.text.includes('Unprefixed musing.')), false,
      'nor finalized by the stream complete');

    await framework.stop();
  });

  it('the stream reads leading whitespace and a token\'s end as delivery does', async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as { deliverProse(agent: unknown, text: string): Promise<void> };
    const agent = framework.getAgent('assistant')!;
    const cases = ['  >>#alpha hello', '\u00a0>>#alpha hello', '\u2003>>#alpha hello', '\r>>#alpha hello', '\t>>#alpha\r\nhello'];
    try {
      for (const text of cases) {
        routed.length = 0;
        await gateway.deliverProse(agent, text);
        const router = new ProseStreamRouter({
          mode: 'explicit', initialTarget: null, resolve: (spec) => (spec === '#alpha' ? 'chan-alpha' : null),
        });
        const streamed = [...router.feed(text), ...router.finish()];
        assert.deepEqual(routed.map((r) => r.locus), ['chan-alpha'], `delivery sends ${JSON.stringify(text)} to #alpha`);
        assert.ok(streamed.length > 0 && streamed.every((d) => d.channelId === 'chan-alpha'),
          `the stream sends ${JSON.stringify(text)} there too`);
      }
    } finally {
      await framework.stop();
    }
  });

  it("a round's destination, decided at its boundary, is the sticky destination its delivery leaves", async () => {
    const framework = await createFramework();
    stubRegistry(framework);
    const internals = framework as unknown as {
      deliverProse(agent: unknown, text: string): Promise<void>;
      admitProse(text: string): unknown[];
      roundDestination(current: string | null, envelopes: unknown[]): string | null;
      turnRouting: Map<string, RoutingState>;
    };
    const agent = framework.getAgent('assistant')!;
    const rounds: string[][] = [
      ['>>#alpha first\n>>#alpha'],
      ['  >>#alpha indented'],
      ['>>#nowhere bounced'],
      ['>>skip_reply kept\nand unprefixed'],
      ['unprefixed', '>>#alpha second segment'],
    ];
    try {
      for (const segments of rounds) {
        for (const start of [null, 'chan-alpha']) {
          internals.turnRouting.set('assistant', { pin: start ?? undefined, destination: null, hybridHold: false,
            logical: { continuation: false, deliveries: [], suppressed: 0 } });
          for (const segment of segments) await internals.deliverProse(agent, segment);
          const admitted = segments.flatMap((segment) => internals.admitProse(segment));
          assert.equal(internals.roundDestination(start, admitted), internals.turnRouting.get('assistant')?.pin ?? null,
            `${JSON.stringify(segments)} from ${start}`);
        }
      }
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a `>>>` envelope with no target streams nothing, as delivery bounces it', async () => {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      deliverHybridProse(agent: unknown, text: string, locus: string, allowLocus: boolean, routing: RoutingState): Promise<void>;
      turnRouting: Map<string, RoutingState>;
    };
    const agent = framework.getAgent('assistant')!;
    // The registry's resolver trims its argument, as the router's must here.
    const resolve = (spec: string) => (spec.trim() === '#alpha' ? 'chan-alpha' : null);
    const cases = ['>>>\r\nsecret', '>>>\nsecret', '>>>\u00a0#alpha secret', '>>> \u00a0#alpha secret'];
    try {
      for (const text of cases) {
        routed.length = 0;
        const queued: RoutingState = { destination: null, hybridHold: false,
          logical: { continuation: false, deliveries: [], suppressed: 0 } };
        const live: RoutingState = { ...queued, logical: { continuation: false, deliveries: [], suppressed: 0 } };
        gateway.turnRouting.set('assistant', live);
        await gateway.deliverHybridProse(agent, text, 'chan-locus', true, queued);
        assert.equal(queued.hybridHold, true, 'the supplied turn receives the hold');
        assert.equal(live.hybridHold, false, 'the live turn stays unheld');
        const router = new ProseStreamRouter({ mode: 'hybrid', initialTarget: 'chan-locus', resolve });
        const streamed = [...router.feed(text), ...router.finish()];
        assert.equal(routed.length, 0, `delivery bounces ${JSON.stringify(text)}`);
        assert.deepEqual(streamed, [], `and the stream sends none of ${JSON.stringify(text)}`);
      }
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a segment that is only `>>>`, or `>>>` and a gap, holds back the next segment, as delivery does', async () => {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      deliverHybridProse(agent: unknown, text: string, locus: string, allowLocus: boolean, routing: RoutingState): Promise<void>;
      turnRouting: Map<string, RoutingState>;
    };
    const agent = framework.getAgent('assistant')!;
    const resolve = (spec: string) => (spec.trim() === '#alpha' ? 'chan-alpha' : null);
    try {
      for (const prefix of ['>>>', '>>> ', '>>>\t']) {
        routed.length = 0;
        const queued: RoutingState = { destination: null, hybridHold: false,
          logical: { continuation: false, deliveries: [], suppressed: 0 } };
        const live: RoutingState = { ...queued, logical: { continuation: false, deliveries: [], suppressed: 0 } };
        gateway.turnRouting.set('assistant', live);
        await gateway.deliverHybridProse(agent, '>>>#alpha first', 'chan-locus', true, queued);
        await gateway.deliverHybridProse(agent, prefix, 'chan-locus', true, queued);
        await gateway.deliverHybridProse(agent, 'secret', 'chan-locus', true, queued);
        assert.deepEqual(queued.logical.deliveries, ['chan-alpha'], 'the supplied turn records its delivery');
        assert.equal(queued.logical.suppressed, 1, 'the supplied turn records its suppression');
        assert.deepEqual(live.logical.deliveries, [], 'the live turn receives no delivery');
        assert.equal(live.logical.suppressed, 0, 'the live turn receives no suppression');
        const router = new ProseStreamRouter({ mode: 'hybrid', initialTarget: 'chan-locus', resolve });
        const streamed = [
          ...router.feed('>>>#alpha first'), ...router.endSegment(),
          ...router.feed(prefix), ...router.endSegment(),
          ...router.feed('secret'), ...router.finish(),
        ];
        assert.deepEqual(routed.map((r) => r.text), ['first'], `delivery sends only first, after ${JSON.stringify(prefix)}`);
        assert.equal(streamed.filter((d) => d.delta.includes('secret')).length, 0,
          `and the stream holds secret back after ${JSON.stringify(prefix)}`);
      }
    } finally {
      await framework.stop();
    }
  });

  it('admission turns a resolver that throws into an envelope that bounces', async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      channelRegistry: { resolveProseTarget: (spec: string) => unknown };
      admitProse(text: string): Array<{ text: string; resolved?: { channelId?: string; error?: string } }>;
      deliverAdmittedProse(agent: unknown, envelopes: unknown[], round: { routing: RoutingState }): Promise<void>;
      routingOf(name: string): RoutingState;
    };
    const resolve = internals.channelRegistry.resolveProseTarget.bind(internals.channelRegistry);
    internals.channelRegistry.resolveProseTarget = (spec: string) => {
      if (spec === '#boom') throw new Error('directory unavailable');
      return resolve(spec);
    };
    try {
      const admitted = internals.admitProse('>>#boom one\n>>#alpha two');
      assert.match(admitted[0]!.resolved?.error ?? '', /directory unavailable/);
      await internals.deliverAdmittedProse(framework.getAgent('assistant')!, admitted, { routing: internals.routingOf('assistant') });
      assert.deepEqual(routed.map((r) => r.text), ['two'], 'the other envelope still goes out');
    } finally {
      await framework.stop();
    }
  });

  it("' !' continuation starts another turn immediately after prose ends the current one", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha ! step one done, continuing' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    feedTurn(framework, 2, [{ type: 'text', text: '>>#alpha step two done' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 2, 'a second inference ran without any external event');
    assert.deepEqual(routed.map((r) => r.text), ['step one done, continuing', 'step two done']);
    assert.deepEqual(routed.map((r) => r.locus), ['chan-alpha', 'chan-alpha']);

    await framework.stop();
  });

  it('appends the mode primer exactly once across turns', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha hello' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubRegistry(framework);

    const primers: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-routing-primer') primers.push(1);
    });

    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(primers.length, 1, 'primer on first explicit turn');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha again' },
    ] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(primers.length, 1, 'no re-priming on later turns');

    await framework.stop();
  });

  it('prose_help tool returns the routing reference on demand', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'prose_help', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha got it' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    const stream = membrane.lastStream!;
    assert.equal(stream.receivedToolResults.length, 1);
    const result = JSON.stringify(stream.receivedToolResults[0]);
    assert.ok(result.includes('destination'), 'help text served as tool result');
    assert.deepEqual(routed, [{ text: 'got it', locus: 'chan-alpha' }]);

    await framework.stop();
  });

  it('multi-envelope prose: each >> line routes independently (Tilde scenario)', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha part one for the channel\n>>@laria part two, just for you\nwith a second line\n>> quoted arrow stays in body' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'part one for the channel', locus: 'chan-alpha' },
      { text: 'part two, just for you\nwith a second line\n>> quoted arrow stays in body', locus: 'discord:dm:99' },
    ], 'two envelopes, two destinations; quoted arrow not split');

    await framework.stop();
  });


  it('hybrid preserves authored >>> envelope, publishes only body cross-surface, and records canonical receipt', async () => {
    const authored = '>>>#cafe\nA message meant for the café.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: authored }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'A message meant for the café.', locus: 'discord:g:cafe' }]);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored), 'source/author view retains exact envelope');
    assert.ok(texts.includes('[delivered] plain speech → discord:g:cafe'), 'canonical destination receipt enters context');
    await framework.stop();
  });

  it('hybrid leaves unprefixed prose on the frozen locus', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Ordinary field speech.' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'Ordinary field speech.', locus: 'world:commons' }]);
    await framework.stop();
  });

  it('hybrid accepts permissive whitespace but missing targets bounce and publish nowhere', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '  >>>   #missing\nDo not guess.' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply {{unsent}}' }] as ContentBlock[]);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, []);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.some(t => t.includes('[prose-routing]') && t.includes('not delivered') && t.includes('>>>#channel {{unsent}}')));
    await framework.stop();
  });


  it('hybrid keeps an explicit target sticky across tool-round segments in the same turn', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#cafe first segment' },
      { type: 'tool_use', id: 'hc1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'second segment, no repeated envelope' },
    ] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [
      { text: 'first segment', locus: 'discord:g:cafe' },
      { text: 'second segment, no repeated envelope', locus: 'discord:g:cafe' },
    ]);
    await framework.stop();
  });


  it('hybrid target-only envelope establishes the sticky destination for the next tool-round segment', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#cafe' },
      { type: 'tool_use', id: 'hc2', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'body follows' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'body follows', locus: 'discord:g:cafe' }]);
    await framework.stop();
  });


  it('hybrid >>>skip_reply clears a sticky target until a fresh valid envelope', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#cafe first' }, { type: 'tool_use', id: 'sk1', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>skip_reply hidden' }, { type: 'tool_use', id: 'sk2', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'plain text must remain suppressed' }, { type: 'tool_use', id: 'sk3', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>world:commons recovered' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'first', locus: 'discord:g:cafe' }, { text: 'recovered', locus: 'world:commons' }]);
    await framework.stop();
  });

  for (const failure of ['false', 'throw'] as const) {
    it(`hybrid ${failure} delivery clears sticky authority, suppresses later prose, and a fresh target resumes`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#cafe first' }, { type: 'tool_use', id: 'fl1', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#alpha fails' }, { type: 'tool_use', id: 'fl2', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'plain text must remain suppressed' }, { type: 'tool_use', id: 'fl3', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>world:commons recovered' }] as ContentBlock[]));
      const framework = await createFramework('hybrid');
      const routed = stubRegistry(framework, ['delivered', failure, 'delivered']);
      feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply {{unsent}}' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      assert.equal(routed.some(r => r.text.includes('plain text must remain suppressed')), false);
      assert.deepEqual(routed.filter(r => r.text !== 'fails'), [{ text: 'first', locus: 'discord:g:cafe' }, { text: 'recovered', locus: 'world:commons' }]);
      const cm = framework.getAgent('assistant')!.getContextManager();
      const texts = cm.getAllMessages().flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
      assert.ok(texts.some(t => t.includes('[prose-routing]') && t.includes('>>>#channel {{unsent}}')));
      await framework.stop();
    });
  }


  it('hybrid same-round successful say tool outranks a contradictory prose envelope', async () => {
    const authored = '>>>#cafe wrong-locus duplicate';
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: authored },
      { type: 'tool_use', id: 'say1', name: 'robot--say', input: { text: 'Hello Sill in the world' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tool completed' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(module.calls.filter(c => c.name === 'say' || c.name.endsWith('--say')).length, 1);
    assert.deepEqual(routed, []);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored));
    assert.ok(texts.some(t => t.startsWith('[delivered] nothing') && t.includes('suppressed')));
    await framework.stop();
  });


  it('disabled mode suppresses text-only prose without a bounce, primer, or channel delivery', async () => {
    const authored = 'Internal continuity summary that must never publish.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: authored }] as ContentBlock[]));
    const framework = await createFramework('disabled');
    const routed = stubRegistry(framework);
    const sources: string[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source) sources.push(ev.source);
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'disabled prose never reaches a channel');
    assert.equal(sources.includes('prose-bounce'), false, 'disabled prose does not bounce');
    assert.equal(sources.includes('prose-routing-primer'), false, 'disabled mode injects no model-visible primer');
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored), 'authored prose remains in Chronicle');
    assert.ok(texts.some(t => t.includes('[delivered] nothing') && t.includes('proseRouting=disabled')),
      'private suppression receipt explains the unsent prose');

    await framework.stop();
  });

  it('disabled mode ignores destination prefixes but explicit publish tools still execute', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha this prefix must not bypass disabled mode' },
      { type: 'tool_use', id: 'd1', name: 'robot--say', input: { text: 'published explicitly' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'trailing prose must also remain private' },
    ] as ContentBlock[]));
    const framework = await createFramework('disabled');
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'neither prefixed nor trailing prose routed');
    assert.equal(module.calls.length, 1, 'explicit tool call executed');
    assert.equal(module.calls[0]!.name, 'say');
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.some(t => t.includes('[delivered] nothing') && t.includes('2 plain-speech segment(s) suppressed')),
      'one receipt accounts for mid-turn and trailing prose');

    await framework.stop();
  });

});
