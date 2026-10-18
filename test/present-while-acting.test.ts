/**
 * "Present while acting": the two halves that keep an agent conversationally
 * alive during a long tool-using turn.
 *
 * SPEAK-while-acting — each round's prose is routed to the locus LIVE when
 * the round yields its tool calls. Explicit-send suppression lasts until new
 * external input begins another conversational round; the 'complete' case
 * routes only trailing prose.
 * Previously all segments were batched to the end of the turn.
 *
 * HEAR-while-acting — messages arriving mid-turn (deferred by addMessage
 * while tool_use blocks are pending) are flushed to the context window at
 * the tool-result boundary AND injected into the live stream via
 * provideToolResults(results, { injectedMessages }) (membrane ≥0.5.72), so
 * the next round of the SAME turn sees them instead of the agent staying
 * deaf until the turn ends.
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
import type { ContextInjection } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { MembraneError } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

// ---------------------------------------------------------------------------
// Test module: tools that optionally emit a mid-turn external message
// ---------------------------------------------------------------------------

class RobotModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  /** When set, the next `move` call pushes this text as an external message
   *  BEFORE returning its result (simulating a chat reply arriving while the
   *  tool executes). */
  interjection: string | null = null;
  /** Optional routing locus attached to the interjected message. */
  interjectionChannelId: string | null = null;
  /** Full metadata override for the interjected message (wins over
   *  interjectionChannelId when set) — e.g. reaction tags. */
  interjectionMetadata: Record<string, unknown> | null = null;
  /** Delay tool completion so live routing deterministically precedes it. */
  toolDelayMs = 0;
  /** Run once, during the next turn start's context gathering (the turn is
   *  alive and its stream doesn't exist yet). */
  startHook: (() => Promise<void>) | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  async gatherContext(): Promise<ContextInjection[]> {
    const hook = this.startHook;
    this.startHook = null;
    if (hook) await hook();
    return [];
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'move',
        description: 'Move the robot',
        inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
      },
      {
        name: 'send_message',
        description: 'Explicitly send a message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      // World-surface publication verbs (Eidoverse). Bare names matter: the
      // framework strips the `robot--` prefix before consulting its sets.
      {
        name: 'say',
        description: 'Say something aloud in the world',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      {
        name: 'whisper',
        description: 'Whisper to someone in the world',
        inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (this.toolDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.toolDelayMs));
    }
    if (this.interjection) {
      const text = this.interjection;
      this.interjection = null;
      this.framework!.pushEvent({
        type: 'external-message',
        source: 'test',
        content: text,
        metadata: this.interjectionMetadata
          ?? (this.interjectionChannelId
            ? { channelId: this.interjectionChannelId }
            : {}),
      } as unknown as ProcessEvent);
      // Give the run loop a beat to process the queued message while this
      // tool round is still pending (pendingAssistantBlocks non-empty), so
      // it lands in deferredMessages before the tool-result event.
      await new Promise((r) => setTimeout(r, 30));
    }
    return { success: true, data: { ok: true, tool: call.name } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const text = String((event as { content?: unknown }).content);
      const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
      return {
        addMessages: [
          {
            participant: 'Antra',
            content: [{ type: 'text', text }],
            ...(metadata ? { metadata } : {}),
          },
        ],
        // Only the initial 'go' starts a turn. Mid-turn interjections must
        // NOT request inference — we're testing mid-turn delivery, not wakes.
        requestInference: text === 'go',
      };
    }
    return {};
  }
}

/** Minimal ChannelRegistry stub covering everything driveStream touches. */
function stubChannelRegistry(framework: AgentFramework) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  let locusCalls = 0;
  const explicit: Record<string, unknown> = {
    resolveLocus: () => {
      locusCalls++;
      return `chan-live-${locusCalls}`;
    },
    routeSpeech: async (_agent: string, text: string, locus?: string | null) => {
      routed.push({ text, locus: locus ?? null });
      // Mirror the real registry's outcome shape (delivery receipts read it).
      return locus ? { delivered: true, channelId: locus } : null;
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  };
  // Everything else driveStream/stop touches (startTyping, stopTyping,
  // stopAll, ensureChannelRegistered, ...) becomes a no-op via Proxy so the
  // stub doesn't chase the real registry's surface.
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

// ---------------------------------------------------------------------------

describe('present while acting', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: RobotModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pwa-test-'));
    membrane = new MockMembrane();
    module = new RobotModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(agentOptions: { maxStreamTokens?: number } = {}): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.', ...agentOptions },
      ],
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

  // -------------------------------------------------------------------------
  // Speak-while-acting
  // -------------------------------------------------------------------------

  it('routes each round\'s prose live and only trailing prose at complete', async () => {
    // Round 1: narration + move; Round 2: more narration + move; final: postscript
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Heading to the door now!' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Door reached, opening it.' },
      { type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'east' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Arrived.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;

    // Track live ordering: when the first segment routes, no tool results
    // may have been provided yet (i.e. delivery happened DURING the round).
    const resultsAtRouteTime: number[] = [];
    const registry = (framework as unknown as {
      channelRegistry: { routeSpeech: (a: string, t: string, l?: string | null) => Promise<void> };
    }).channelRegistry;
    const origRoute = registry.routeSpeech;
    registry.routeSpeech = async (a, t, l) => {
      resultsAtRouteTime.push(membrane.lastStream!.receivedToolResults.length);
      return origRoute(a, t, l);
    };

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(
      routed.map((r) => r.text),
      ['Heading to the door now!', 'Door reached, opening it.', 'Arrived.'],
      'all three segments delivered, in order',
    );
    // Live: segment N routed before round N's tool results were provided
    assert.equal(resultsAtRouteTime[0], 0, 'round-1 prose routed before round-1 results');
    assert.equal(resultsAtRouteTime[1], 1, 'round-2 prose routed before round-2 results');
    // Locus resolved ONCE and pinned for the whole turn (incl. trailing prose)
    assert.deepEqual(
      routed.map((r) => r.locus),
      ['chan-live-1', 'chan-live-1', 'chan-live-1'],
      'one locus resolution, pinned across the turn',
    );

    await framework.stop();
  });

  it('sticky silencing: a silencing round suppresses its own and all later prose', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'sending it directly' },
      { type: 'tool_use', id: 'c1', name: 'robot--send_message', input: { text: 'hi' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Narrating round two.' },
      { type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'up' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(
      routed.map((r) => r.text),
      [],
      'explicit send in round 1 silences the turn from that round onward',
    );

    await framework.stop();
  });

  it('sticky silencing is forward-only: earlier rounds\' prose still routes', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Round one narration.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'up' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'private planning' },
      { type: 'tool_use', id: 'c2', name: 'robot--send_message', input: { text: 'hi' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'trailing postscript' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(
      routed.map((r) => r.text),
      ['Round one narration.'],
      'round-1 prose delivered live; round-2 (silencing) and trailing suppressed',
    );

    await framework.stop();
  });

  it('new injected channel input resets send suppression but the turn locus stays frozen', async () => {
    // While handling one channel, the agent explicitly sends that response; a
    // message from another channel arrives during the send, and the terminal
    // prose answers the new message. The suppression is cleared (the prose IS
    // delivered) — but it lands in the TURN's frozen locus, not the injected
    // message's channel: ambient input must never capture the agent's voice
    // mid-turn (2026-07-21 Cairn lounge misroute). A cross-channel reply
    // needs an explicit send.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--send_message', input: { text: 'reply to room4' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Yes, I want to try the VR space.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.interjection = 'Want to try a VR space?';
    module.interjectionChannelId = 'discord:guild:fable';

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Yes, I want to try the VR space.', locus: 'chan-live-1' },
    ]);

    await framework.stop();
  });

  it('an ADDRESSED mid-turn injection re-pins the locus for subsequent prose', async () => {
    // 2026-07-31 Mythos misroutes (n=6): someone explicitly addresses the
    // agent from another channel mid-turn (mention / reply / DM); the
    // agent's trailing prose answers THEM but the frozen pin delivered it
    // to the stale locus (the hospital scene into antra's DM, and its
    // mirror). Addressed conversational injections — the chat:addressed
    // signal turn-START batching already prefers — now move the pin, with a
    // one-line [routing] notice riding the same injection batch so window
    // and wire agree. Ambient injections still cannot (previous test).
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Station four, proceeding.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Answering the person who addressed me.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'hey, quick question over here?';
    module.interjectionMetadata = { channelId: 'discord:dm:antra', tags: ['chat:addressed'] };

    const notices: string[] = [];
    framework.onTrace((event) => {
      const e = event as { type: string; source?: string };
      if (e.type === 'message:added' && e.source === 'routing-notice') notices.push(e.source!);
    });

    trigger(framework);
    await framework.runUntilIdle();

    // Round-1 prose predates the injection and belongs to the old pin;
    // trailing prose follows the addressed speaker.
    assert.deepEqual(routed, [
      { text: 'Station four, proceeding.', locus: 'chan-live-1' },
      { text: 'Answering the person who addressed me.', locus: 'discord:dm:antra' },
    ]);
    // Boot-baseline announcement + the mid-turn re-pin notice.
    assert.equal(notices.length, 2, 'the re-pin produced exactly one routing notice');
    // The notice rode the injection batch to the live stream (window == wire).
    const injectedBatches = membrane.lastStream!.receivedToolResultOptions
      .map((o) => o?.injectedMessages ?? []);
    const wired = injectedBatches.flat().map((m) => JSON.stringify(m.content));
    assert.ok(
      wired.some((s) => s.includes('quick question')),
      'the addressed message itself was injected',
    );
    assert.ok(
      wired.some((s) => s.includes('[routing] The conversation moved to discord:dm:antra')),
      'the re-pin notice was injected alongside it',
    );

    await framework.stop();
  });

  it('a follow-up in a channel the agent explicitly engaged this turn re-pins', async () => {
    // 2026-07-31 n=7 (q's #portables reply): the agent explicitly sent into
    // a channel this turn; someone replies there WITHOUT a mention (ambient
    // by tag, addressed by context). The engaged-channel leg moves the pin;
    // trailing prose answering them follows.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Good plan on both counts.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'I need to swap out this eye screen';
    module.interjectionMetadata = {
      channelId: 'discord:guild:portables',
      tags: ['chat:ambient', 'chat:from-human'],
    };
    // Simulate an explicit send into #portables earlier in THIS turn (the
    // production record happens on the MCPL send path; the harness module's
    // tools are not MCPL, so seed the turn's engaged set mid-turn — after
    // the turn opens, before the injection boundary).
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      (framework as unknown as {
        turnRouting: Map<string, { engaged: Set<string> }>;
      }).turnRouting.get('assistant')!.engaged.add('discord:guild:portables');
      return origHandle(call);
    };

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Good plan on both counts.', locus: 'discord:guild:portables' },
    ], 'trailing prose followed the human reply into the engaged channel');

    await framework.stop();
  });

  it('an agent-resident follow-up in an engaged channel re-pins too (no author-kind filter)', async () => {
    // Fleet participants include agent-residents — "bot" by Discord flag,
    // full conversational participants in fact. Their in-flow replies in a
    // channel the agent just engaged move the pin exactly like anyone
    // else's (antra, 2026-07-31: the author-kind distinction is fragile and
    // wrong for this fleet).
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Continuing with the colleague.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = '*from the table* one receipt for the case, since I have a dated instance';
    module.interjectionMetadata = {
      channelId: 'discord:guild:hospital',
      tags: ['chat:ambient', 'chat:from-bot'],
    };
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      (framework as unknown as {
        turnRouting: Map<string, { engaged: Set<string> }>;
      }).turnRouting.get('assistant')!.engaged.add('discord:guild:hospital');
      return origHandle(call);
    };

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Continuing with the colleague.', locus: 'discord:guild:hospital' },
    ], 'the agent-resident follow-up moved the pin like any participant');

    await framework.stop();
  });

  it('ambient chatter in a channel the agent did NOT engage still cannot move the pin', async () => {
    // The Cairn-protection boundary, restated for the engaged-channel era:
    // no mention, no engagement this turn → the pin holds.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Continuing my report.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'unrelated lounge chatter';
    module.interjectionMetadata = {
      channelId: 'discord:guild:lounge',
      tags: ['chat:ambient', 'chat:from-human'],
    };

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Continuing my report.', locus: 'chan-live-1' },
    ], 'un-engaged ambient left the pin alone');

    await framework.stop();
  });

  it('an addressed injection from the CURRENT locus does not chatter a notice', async () => {
    // Same-channel addressed input is the ordinary case (the person the
    // agent is already talking to sends another message mid-turn): the pin
    // is already right, so no re-pin and — critically for KV — no notice.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Continuing right here.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'and one more thing';
    module.interjectionMetadata = { channelId: 'chan-live-1', tags: ['chat:addressed'] };

    const notices: string[] = [];
    framework.onTrace((event) => {
      const e = event as { type: string; source?: string };
      if (e.type === 'message:added' && e.source === 'routing-notice') notices.push(e.source!);
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Continuing right here.', locus: 'chan-live-1' }]);
    assert.equal(notices.length, 1, 'only the boot-baseline announcement — no re-pin chatter');

    await framework.stop();
  });

  // -------------------------------------------------------------------------
  // Every later start of the turn keeps its locus
  // -------------------------------------------------------------------------
  // A framework retry, the compile a capacity hold defers a turn to, the
  // re-inference on unstreamed tool results and a budget restart all keep
  // the turn's locus, re-pins included. A message that no tool boundary
  // weighed, because none of the turn's streams was running or its boundary
  // couldn't re-pin, still moves it at the turn's next start, by the mid-turn
  // rule: a conversational message that addressed the agent, or that follows
  // up in a channel the turn sent into.

  /** Make each stream in `indices` (1-based) end with `error` instead of completing. */
  function failStream(indices: number | number[], error: (request: NormalizedRequest) => Error): void {
    const failing = new Set(Array.isArray(indices) ? indices : [indices]);
    const makeStream = membrane.streamYielding.bind(membrane);
    let streams = 0;
    membrane.streamYielding = (request, options) => {
      const stream = makeStream(request, options);
      const n = ++streams;
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && failing.has(n)) {
            yield { type: 'error' as const, error: error(request) };
            return;
          }
          yield event;
        }
      };
      return stream;
    };
  }

  /** Feed a response to the Nth turn start (1-based) the moment it begins. */
  function feedStart(framework: AgentFramework, start: number, ...responses: ContentBlock[][]): void {
    let starts = 0;
    framework.onTrace((event) => {
      if (event.type !== 'inference:started' || ++starts !== start) return;
      responses.forEach((blocks, i) => membrane.pushResponse(createMockResponse(
        blocks, i < responses.length - 1 ? 'tool_use' : undefined,
      )));
    });
  }

  /** An organization acceleration 429, which holds the turn for a later compile. */
  const accelerationLimit = (request: NormalizedRequest): MembraneError => new MembraneError({
    type: 'rate_limit', retryable: true, httpStatus: 429,
    message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
    rawError: { status: 429 }, rawRequest: request,
  });

  type Held = {
    providerAccelerationCooldowns: Map<string, { until: number }>;
    releaseProviderAccelerationCooldown(agentName: string): void;
  };

  /** Bring the agent's capacity hold to its deadline and release it, as its
   *  timer does then, and run the deferred compile. */
  async function release(framework: AgentFramework): Promise<void> {
    const internals = framework as unknown as Held;
    const hold = internals.providerAccelerationCooldowns.get('assistant');
    assert.ok(hold, 'the turn is held');
    hold.until = Date.now();
    internals.releaseProviderAccelerationCooldown('assistant');
    await framework.runUntilIdle();
  }

  /** A message someone sends, stored as the test module stores it. */
  async function say(framework: AgentFramework, text: string, metadata: Record<string, unknown>): Promise<void> {
    framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata } as unknown as ProcessEvent);
    await framework.runUntilIdle();
  }

  /** Remove a stored message, as the retraction of an unread coalesced message does (removePlacement). */
  function withdraw(framework: AgentFramework, text: string): void {
    const cm = framework.getAgent('assistant')!.getContextManager();
    const message = cm.getAllMessages().find((m) =>
      m.content.some((b) => b.type === 'text' && (b as { text: string }).text === text));
    assert.ok(message, `"${text}" is stored`);
    cm.removeMessage(message.id);
  }

  const addressed = (channelId: string) => ({ channelId, tags: ['chat:addressed'] });
  const ambient = (channelId: string) => ({ channelId, tags: ['chat:ambient', 'chat:from-human'] });

  /** The `[routing] The conversation moved to …` notices, by channel. */
  const movedTo = (framework: AgentFramework): string[] =>
    framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'routing-notice')
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text))
      .map((text) => /^\[routing\] The conversation moved to (\S+) /.exec(text)?.[1])
      .filter((channel): channel is string => channel !== undefined);

  it("a framework retry keeps the turn's locus, a mid-turn re-pin included", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'quick question for you';
    module.interjectionMetadata = addressed('discord:dm:antra');
    failStream(1, () => new Error('synthetic transient stream error'));
    feedStart(framework, 2, [{ type: 'text', text: 'Answering after the retry.' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 2, 'the error was retried');
    assert.deepEqual(routed, [
      { text: 'Answering after the retry.', locus: 'discord:dm:antra' },
    ], 'the retry speaks where the re-pin moved the turn, not at a re-resolved locus');

    await framework.stop();
  });

  for (const [label, metadata, expected] of [
    ['an addressed message from another channel moves the locus there, with the notice',
      addressed('discord:dm:antra'), 'discord:dm:antra'],
    ['ambient traffic in another channel leaves the locus where it was',
      ambient('discord:guild:lounge'), 'chan-live-1'],
    // Tune-out stamps a message it diverts, and a resident's compiled view
    // leaves it out, so the agent never sees it.
    ['an addressed message that tune-out diverts leaves the locus where it was',
      { ...addressed('discord:dm:antra'), tuneOut: { epochId: 'epoch-1' } }, 'chan-live-1'],
    ['an addressed system marker from another channel leaves the locus where it was',
      { ...addressed('discord:dm:antra'), system: true }, 'chan-live-1'],
  ] as const) {
    it(`during a capacity hold, ${label}`, async () => {
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([] as ContentBlock[]));

      const framework = await createFramework();
      const routed = stubChannelRegistry(framework);
      module.toolDelayMs = 25;
      failStream(1, accelerationLimit);
      feedStart(framework, 2, [{ type: 'text', text: 'Here is the rest.' }] as ContentBlock[]);

      trigger(framework);
      await framework.runUntilIdle();
      // No turn is alive during the hold, so the message is stored at once.
      await say(framework, 'a message during the hold', metadata);
      assert.equal(membrane.calls.length, 1, 'the turn is still held');
      await release(framework);

      assert.equal(membrane.calls.length, 2, 'one deferred compile');
      assert.deepEqual(routed, [
        { text: 'On it.', locus: 'chan-live-1' },
        { text: 'Here is the rest.', locus: expected },
      ]);
      assert.deepEqual(movedTo(framework), expected === 'chan-live-1' ? [] : [expected],
        'a re-pin tells the agent, and nothing else does');

      await framework.stop();
    });
  }

  for (const [label, messages, expected] of [
    ['an addressed message withdrawn before the deferred compile moves nothing',
      [['soon withdrawn', 'discord:dm:antra', true]], 'chan-live-1'],
    ['the newest addressed message that remains moves the locus, when a newer one is withdrawn',
      [['still there', 'discord:dm:antra', false], ['soon withdrawn', 'discord:dm:q', true]], 'discord:dm:antra'],
  ] as const) {
    it(`during a capacity hold, ${label}`, async () => {
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([] as ContentBlock[]));

      const framework = await createFramework();
      const routed = stubChannelRegistry(framework);
      module.toolDelayMs = 25;
      failStream(1, accelerationLimit);
      feedStart(framework, 2, [{ type: 'text', text: 'Here is the rest.' }] as ContentBlock[]);

      trigger(framework);
      await framework.runUntilIdle();
      for (const [text, channelId] of messages) await say(framework, text, addressed(channelId));
      // Each withdrawn message leaves the agent's store before the turn's
      // next start, so the agent never sees it there.
      for (const [text, , withdrawn] of messages) if (withdrawn) withdraw(framework, text);
      await release(framework);

      assert.equal(membrane.calls.length, 2, 'one deferred compile');
      assert.deepEqual(routed, [
        { text: 'On it.', locus: 'chan-live-1' },
        { text: 'Here is the rest.', locus: expected },
      ]);
      assert.deepEqual(movedTo(framework), expected === 'chan-live-1' ? [] : [expected],
        'a re-pin tells the agent, and nothing else does');

      await framework.stop();
    });
  }

  it("during a capacity hold, a store that can't be read at the deferred compile fails the start rather than drop the arrival", async () => {
    // Adapted from a reviewer's probe: a read that fails says nothing about
    // whether the message is there, so it can't count as a withdrawal.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    failStream(1, accelerationLimit);
    // Were the failed read taken as a withdrawal, the compile would run and
    // answer here, at the turn's old channel.
    feedStart(framework, 2, [{ type: 'text', text: 'Here is the rest.' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();
    await say(framework, 'a question for you', addressed('discord:dm:antra'));
    const cm = framework.getAgent('assistant')!.getContextManager();
    const arrival = cm.getAllMessages().find((m) =>
      m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'a question for you'))!;
    const getMessage = cm.getMessage.bind(cm);
    cm.getMessage = (id) => {
      if (id === arrival.id) throw new Error('store unavailable');
      return getMessage(id);
    };
    try {
      await assert.rejects(release(framework), /store unavailable/);
    } finally {
      cm.getMessage = getMessage;
    }

    assert.equal(membrane.calls.length, 1, 'the deferred compile never ran');
    assert.deepEqual(routed, [{ text: 'On it.', locus: 'chan-live-1' }], 'and the turn spoke nowhere else');
    assert.deepEqual(movedTo(framework), [], 'nor told the agent of a move');

    await framework.stop();
  });

  it("a message a tool boundary already weighed doesn't take the locus back at a later start", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'east' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    const internals = framework as unknown as {
      pendingRequests: InferenceRequest[];
      turnRouting: Map<string, { engaged: Set<string> }>;
    };
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      if (call.id === 'c1') {
        // Someone addresses the agent from a DM: the first boundary re-pins
        // there. The message's wake waits behind the turn, as a real one
        // would, and is released with the hold.
        module.interjection = 'quick question for you';
        module.interjectionMetadata = addressed('discord:dm:antra');
        internals.pendingRequests.push({
          agentName: 'assistant', reason: 'channel-message', source: 'test', timestamp: Date.now(),
          channelId: 'discord:dm:antra', addressed: true,
        } as InferenceRequest);
      } else {
        // The turn sent into #portables, and a follow-up there re-pins the
        // second boundary (seeded: this module's tools aren't MCPL sends).
        internals.turnRouting.get('assistant')!.engaged.add('discord:guild:portables');
        module.interjection = 'replying on portables';
        module.interjectionMetadata = ambient('discord:guild:portables');
      }
      return origHandle(call);
    };
    failStream(1, accelerationLimit);
    feedStart(framework, 2, [{ type: 'text', text: 'Back now.' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();
    await release(framework);

    assert.equal(membrane.calls.length, 2, 'one deferred compile');
    assert.deepEqual(routed, [
      { text: 'Back now.', locus: 'discord:guild:portables' },
    ], "the DM, weighed at the first boundary, doesn't move the locus back from #portables");
    assert.deepEqual(movedTo(framework), ['discord:dm:antra', 'discord:guild:portables']);

    await framework.stop();
  });

  it("an arrival a start has used doesn't move the locus again after a later re-pin", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      if (call.id === 'c2') {
        // In the second stream, someone else addresses the agent: its boundary re-pins.
        module.interjection = 'over here now';
        module.interjectionMetadata = addressed('discord:dm:q');
      }
      return origHandle(call);
    };
    failStream([1, 2], accelerationLimit);
    feedStart(framework, 2,
      [{ type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'east' } }] as ContentBlock[],
      [] as ContentBlock[]);
    feedStart(framework, 3, [{ type: 'text', text: 'Back now.' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();
    await say(framework, 'quick question for you', addressed('discord:dm:antra'));
    // The first release uses the DM; its stream re-pins to q, then is held again.
    await release(framework);
    assert.equal(membrane.calls.length, 2);
    await release(framework);

    assert.equal(membrane.calls.length, 3, 'two deferred compiles');
    assert.deepEqual(movedTo(framework), ['discord:dm:antra', 'discord:dm:q']);
    assert.deepEqual(routed, [
      { text: 'Back now.', locus: 'discord:dm:q' },
    ], 'the second release keeps the re-pin its stream made');

    await framework.stop();
  });

  it('a message deferred in a start that fails before its stream lands then, so a newer one during the hold wins', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    // The host holds the agent once when its stream can't be set up. (Asked
    // again at the release, it lets the hold go.)
    let hostHolds = 0;
    (framework as unknown as { providerHoldHook: (error: Error) => { holdMs: number; reason: string } | undefined })
      .providerHoldHook = (error) => error.message === 'stream setup failed' && hostHolds++ === 0
        ? { holdMs: 60_000, reason: 'host hold' } : undefined;
    // Stream one is held at its end; the start after the first release
    // fails before its stream exists, and the host holds it; the third start
    // answers.
    const makeStream = membrane.streamYielding.bind(membrane);
    let calls = 0;
    membrane.streamYielding = (request, options) => {
      const n = ++calls;
      if (n === 2) throw new Error('stream setup failed');
      const stream = makeStream(request, options);
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && n === 1) {
            yield { type: 'error' as const, error: accelerationLimit(request) };
            return;
          }
          yield event;
        }
      };
      return stream;
    };
    feedStart(framework, 2, [{ type: 'text', text: 'Back now.' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();
    // During the second start, before its stream exists, a DM arrives and is
    // deferred: the start holds the turn. (Written directly: the run loop
    // that would store an event's message is busy with this start.)
    const store = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata: Record<string, unknown>): string;
      deferredMessages: unknown[];
    };
    let deferredInStart = -1;
    // Another agent's tool cycle is pending when the start fails: the flush
    // at its end waits only on this agent's own cycle.
    const cycles = (framework as unknown as { pendingAssistantBlocks: Map<string, ContentBlock[]> }).pendingAssistantBlocks;
    module.startHook = async () => {
      store.addMessage('Antra', [{ type: 'text', text: 'quick question for you' }] as ContentBlock[], addressed('discord:dm:antra'));
      deferredInStart = store.deferredMessages.length;
      cycles.set('builder', [{ type: 'tool_use', id: 'b1', name: 'x', input: {} }] as ContentBlock[]);
    };
    await release(framework);
    cycles.delete('builder');
    assert.equal(deferredInStart, 1, 'the DM was deferred while the start held the turn');
    assert.equal(calls, 2, 'the second start failed before its stream');
    assert.equal(store.deferredMessages.length, 0, "the failed start's flush stored the DM while another agent's tools were pending");
    // During the second hold, someone else addresses the agent.
    await say(framework, 'over here', addressed('discord:dm:q'));
    await release(framework);

    assert.equal(calls, 3, 'the third start compiled');
    assert.deepEqual(routed, [
      { text: 'Back now.', locus: 'discord:dm:q' },
    ], 'the newer message wins: the deferred one landed when its start failed');

    await framework.stop();
  });

  it("a failed start's flush stops at a message it can't store: it and what follows stay queued, in order", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    let hostHolds = 0;
    (framework as unknown as { providerHoldHook: (error: Error) => { holdMs: number; reason: string } | undefined })
      .providerHoldHook = (error) => error.message === 'stream setup failed' && hostHolds++ === 0
        ? { holdMs: 60_000, reason: 'host hold' } : undefined;
    // As above: stream one is held at its end, the start after the first
    // release fails before its stream exists and is held, the third answers.
    const makeStream = membrane.streamYielding.bind(membrane);
    let calls = 0;
    membrane.streamYielding = (request, options) => {
      const n = ++calls;
      if (n === 2) throw new Error('stream setup failed');
      const stream = makeStream(request, options);
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && n === 1) {
            yield { type: 'error' as const, error: accelerationLimit(request) };
            return;
          }
          yield event;
        }
      };
      return stream;
    };
    feedStart(framework, 2, [{ type: 'text', text: 'Back now.' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();
    // During the second start, before its stream exists, two messages arrive
    // and are deferred, and the store refuses the first of them.
    const store = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata: Record<string, unknown>): string;
      deferredMessages: Array<{ content: ContentBlock[] }>;
    };
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: unknown): string;
    };
    const add = cm.addMessage.bind(cm);
    let refuse = true;
    cm.addMessage = (participant, content, metadata) => {
      if (refuse && (content[0] as { text?: string })?.text === 'first') throw new Error('store refused');
      return add(participant, content, metadata);
    };
    module.startHook = async () => {
      store.addMessage('Antra', [{ type: 'text', text: 'first' }] as ContentBlock[], ambient('discord:dm:antra'));
      store.addMessage('Antra', [{ type: 'text', text: 'second' }] as ContentBlock[], ambient('discord:dm:antra'));
    };
    const texts = () => framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text))
      .filter((t) => t === 'first' || t === 'second');
    await release(framework);
    assert.equal(calls, 2, 'the second start failed before its stream');
    assert.deepEqual(store.deferredMessages.map((m) => (m.content[0] as { text: string }).text), ['first', 'second'],
      'the message the flush could not store, and the one behind it, stay queued in order');
    assert.deepEqual(texts(), [], 'nothing behind the refused message was stored');

    // Once the store takes it, the next start stores both, in order.
    refuse = false;
    await release(framework);
    assert.equal(calls, 3, 'the third start compiled');
    assert.deepEqual(texts(), ['first', 'second']);

    await framework.stop();
  });

  for (const [label, withdrawn, expected] of [
    ['re-pins to an addressed message its over-budget boundary left unweighed', false, 'discord:dm:antra'],
    ['moves nothing for such a message withdrawn before it starts', true, 'chan-live-1'],
  ] as const) {
    it(`a budget restart ${label}`, async () => {
      const overBudget = createMockResponse([
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use');
      overBudget.usage = { inputTokens: 100, outputTokens: 5 };
      membrane.pushResponse(overBudget);

      const framework = await createFramework({ maxStreamTokens: 20 });
      const routed = stubChannelRegistry(framework);
      module.toolDelayMs = 25;
      module.interjection = 'quick question for you';
      module.interjectionMetadata = addressed('discord:dm:antra');
      feedStart(framework, 2, [{ type: 'text', text: 'After the restart.' }] as ContentBlock[]);
      if (withdrawn) {
        // The boundary has stored the message and left it to the restart as
        // an arrival, by the id it was stored under; it leaves the store
        // before the restart starts.
        framework.onTrace((event) => {
          if (event.type === 'inference:stream_restarted') withdraw(framework, 'quick question for you');
        });
      }

      trigger(framework);
      await framework.runUntilIdle();

      assert.equal(membrane.calls.length, 2, 'the turn restarted for its budget');
      assert.deepEqual(routed, [
        { text: 'After the restart.', locus: expected },
      ]);
      assert.deepEqual(movedTo(framework), withdrawn ? [] : [expected]);

      await framework.stop();
    });
  }

  for (const [label, messages, expected] of [
    ["keeps the turn's locus", [], 'chan-turn'],
    ['moves it to the newest addressed arrival',
      [addressed('discord:dm:antra'), addressed('discord:dm:q')], 'discord:dm:q'],
    ['moves it to a follow-up in a channel the turn engaged',
      [ambient('discord:guild:portables')], 'discord:guild:portables'],
    ['leaves it for a reaction in a channel the turn engaged',
      [{ channelId: 'discord:guild:portables', tags: ['chat:reaction'] }], 'chan-turn'],
  ] as const) {
    it(`a re-inference on unstreamed tool results ${label}`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Carrying on.' }] as ContentBlock[]));
      const framework = await createFramework();
      const routed = stubChannelRegistry(framework);
      type Routing = { locus?: string; engaged: Set<string>; [field: string]: unknown };
      const internals = framework as unknown as {
        turnRouting: Map<string, Routing>; openLogical: Map<string, Routing>; pendingRequests: InferenceRequest[];
      };
      // The turn's earlier stream froze `chan-turn` as its locus, sent into
      // #portables, and left its tool results for the non-streaming
      // fallback's re-inference. Messages arrive before that starts.
      const open: Routing = {
        locus: 'chan-turn', triggerChannel: 'chan-turn', engaged: new Set(['discord:guild:portables']),
        destination: null, hybridHold: false, continuation: false, deliveries: [], suppressed: 0, arrivals: [],
      };
      internals.turnRouting.set('assistant', open);
      internals.openLogical.set('assistant', open);
      for (const metadata of messages) await say(framework, 'a message', metadata);
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);

      await framework.runUntilIdle();

      assert.deepEqual(routed, [{ text: 'Carrying on.', locus: expected }]);
      assert.deepEqual(movedTo(framework), expected === 'chan-turn' ? [] : [expected], 'a re-pin leaves its notice');

      await framework.stop();
    });
  }

  it('the start that continues the turn weighs a message its own flush lands, and a delivery assembled for it', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Carrying on.' }] as ContentBlock[]));
    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    type Routing = { locus?: string; engaged: Set<string>; arrivals: Array<{ messageId: string; channelId: string }>; [field: string]: unknown };
    const internals = framework as unknown as {
      turnRouting: Map<string, Routing>; openLogical: Map<string, Routing>; pendingRequests: InferenceRequest[];
      activeTurnTokens: Map<string, number>;
      deferredMessages: Array<Record<string, unknown>>;
      addMessage(participant: string, content: ContentBlock[], metadata: Record<string, unknown>, opts?: { bypassDeferralFor?: string }): string;
    };
    const open: Routing = {
      locus: 'chan-turn', triggerChannel: 'chan-turn', engaged: new Set(),
      destination: null, hybridHold: false, continuation: false, deliveries: [], suppressed: 0, arrivals: [],
    };
    internals.turnRouting.set('assistant', open);
    internals.openLogical.set('assistant', open);
    try {
      // A delivery assembled while a start of the turn holds it (the
      // coalescing assembly writes past the deferral) is an arrival too.
      internals.activeTurnTokens.set('assistant', -1);
      internals.addMessage('Antra', [{ type: 'text', text: 'batched' }] as ContentBlock[], addressed('discord:dm:q'), { bypassDeferralFor: 'assistant' });
      internals.activeTurnTokens.delete('assistant');
      assert.deepEqual(open.arrivals.map((a) => a.channelId), ['discord:dm:q']);
      // A message still deferred when the turn's next start begins lands in
      // that start's own flush, and is the newest arrival.
      internals.deferredMessages.push({
        id: 'deferred-1', seq: 1, participant: 'Antra', forAgent: 'assistant',
        content: [{ type: 'text', text: 'quick question for you' }], metadata: addressed('discord:dm:antra'),
      });
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);
      await framework.runUntilIdle();

      assert.deepEqual(routed, [{ text: 'Carrying on.', locus: 'discord:dm:antra' }]);
      assert.deepEqual(movedTo(framework), ['discord:dm:antra']);
    } finally {
      await framework.stop();
    }
  });

  it('a start that throws before its stream ends its logical turn, so the next start opens its own', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello there.' }] as ContentBlock[]));
    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    // The registry is unavailable for the first start, which throws after it
    // has opened its turn, outside the stream's own failure handling.
    const registry = (framework as unknown as { channelRegistry: Record<string, (agent: string) => string> }).channelRegistry;
    const resolve = registry.resolveLocus;
    let failed = false;
    registry.resolveLocus = (agent) => {
      if (!failed) { failed = true; throw new Error('registry unavailable'); }
      return resolve(agent);
    };
    const internals = framework as unknown as { openLogical: Map<string, unknown> };

    trigger(framework);
    await assert.rejects(framework.runUntilIdle(), /registry unavailable/);
    assert.equal(internals.openLogical.has('assistant'), false, 'the failed start left no turn open');
    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Hello there.', locus: 'chan-live-1' }],
      'the next start resolved a locus of its own');

    await framework.stop();
  });

  it("a silent turn's tool boundary doesn't re-pin its locus or tell it the conversation moved", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'quiet' }] as ContentBlock[]));
    const framework = await createFramework();
    stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'quick question for you';
    module.interjectionMetadata = addressed('discord:dm:antra');
    const internals = framework as unknown as { pendingRequests: InferenceRequest[] };

    internals.pendingRequests.push({
      agentName: 'assistant', reason: 'heartbeat', source: 'framework', timestamp: Date.now(), suppressProse: true,
    } as InferenceRequest);
    await framework.runUntilIdle();

    assert.equal(module.interjection, null, 'the silent turn ran its tool round, and the DM arrived during it');
    assert.deepEqual(movedTo(framework), [], 'no routing notice in a turn that routes no prose');

    await framework.stop();
  });

  it("a start that continues the turn and throws before it takes the turn's routing still ends the turn", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    failStream(1, accelerationLimit);
    feedStart(framework, 2, [{ type: 'text', text: 'A new turn.' }] as ContentBlock[]);
    const internals = framework as unknown as {
      openLogical: Map<string, unknown>;
      recordTurnCheckpoint(agentName: string): void;
    };

    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(internals.openLogical.has('assistant'), true, 'the held turn is open');
    // The deferred compile's checkpoint fails before the start takes the turn.
    const checkpoint = internals.recordTurnCheckpoint.bind(framework);
    internals.recordTurnCheckpoint = () => { throw new Error('checkpoint failed'); };
    await assert.rejects(release(framework), /checkpoint failed/);
    internals.recordTurnCheckpoint = checkpoint;
    assert.equal(internals.openLogical.has('assistant'), false, 'the held turn ended with its failed compile');
    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'A new turn.', locus: 'chan-live-2' }],
      'the next start opened its own turn and resolved its own locus');

    await framework.stop();
  });

  it("an ephemeral run whose start throws outside its stream fails with that error, not by its watchdog", async () => {
    // Adapted from a reviewer's probe. On main the run waited for its startup
    // watchdog (30 s by default), which fails it as a zombie.
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'ephemeral.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [],
      syncIntervalMs: 0,
    });
    const internals = framework as unknown as { recordTurnCheckpoint(agentName: string): void };
    const checkpoint = internals.recordTurnCheckpoint.bind(framework);
    internals.recordTurnCheckpoint = (agentName) => {
      if (agentName === 'worker') throw new Error('checkpoint store unavailable');
      checkpoint(agentName);
    };
    const error = console.error;
    console.error = () => {};
    try {
      const { agent, contextManager } = await framework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
      });
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const run = framework.runEphemeralToCompletion(agent, contextManager, { startupTimeoutMs: 3_000 });
      framework.start();
      await assert.rejects(run, /checkpoint store unavailable/, "the run fails with its start's error");
    } finally {
      console.error = error;
      await framework.stop();
    }
  });

  it("a silent start that throws leaves an open prose turn alone", async () => {
    const framework = await createFramework();
    stubChannelRegistry(framework);
    type Routing = { locus?: string; engaged: Set<string>; [field: string]: unknown };
    const internals = framework as unknown as {
      openLogical: Map<string, Routing>; pendingRequests: InferenceRequest[];
      recordTurnCheckpoint(agentName: string): void;
    };
    const open: Routing = {
      locus: 'chan-turn', engaged: new Set(), destination: null, hybridHold: false,
      continuation: false, deliveries: [], suppressed: 0, arrivals: [],
    };
    internals.openLogical.set('assistant', open);
    internals.recordTurnCheckpoint = () => { throw new Error('checkpoint failed'); };
    internals.pendingRequests.push({
      agentName: 'assistant', reason: 'heartbeat', source: 'framework', timestamp: Date.now(), suppressProse: true,
    } as InferenceRequest);

    await assert.rejects(framework.runUntilIdle(), /checkpoint failed/);
    assert.equal(internals.openLogical.get('assistant'), open);

    await framework.stop();
  });

  it("a resume after stop() continues its turn, and opens it again for the turn's later starts", async () => {
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    failStream(1, () => new Error('synthetic transient stream error'));
    feedStart(framework, 2, [{ type: 'text', text: 'After the retry.' }] as ContentBlock[]);
    type Routing = { locus?: string; engaged: Set<string>; [field: string]: unknown };
    const internals = framework as unknown as {
      turnRouting: Map<string, Routing>; openLogical: Map<string, Routing>; pendingRequests: InferenceRequest[];
    };
    // A turn that crossed its budget before a stop(): its routing state is
    // live, and stop() ended every open turn. Its budget restart now runs,
    // and its stream fails and is retried.
    const turn: Routing = {
      locus: 'chan-turn', triggerChannel: 'chan-turn', engaged: new Set(), destination: null, hybridHold: false,
      continuation: false, deliveries: [], suppressed: 0, arrivals: [],
    };
    internals.turnRouting.set('assistant', turn);
    internals.pendingRequests.push({
      agentName: 'assistant', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(),
    } as InferenceRequest);
    // The retry of a resume is a resume too, and takes the turn's routing
    // state whatever is open. The turn must be open while its streams run, so
    // that its other later starts, such as a re-inference on unstreamed tool
    // results, continue it rather than open a new one.
    const openAtStart: unknown[] = [];
    framework.onTrace((event) => {
      if (event.type === 'inference:started') openAtStart.push(internals.openLogical.get('assistant'));
    });

    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 2, 'the restart was retried');
    assert.deepEqual(openAtStart.map((open) => open === turn), [true, true],
      'the resumed turn was open again while each of its streams ran');
    assert.equal(internals.openLogical.get('assistant'), undefined, "the turn completed");
    assert.deepEqual(routed, [{ text: 'After the retry.', locus: 'chan-turn' }],
      "the retry continued the resumed turn's routing");

    await framework.stop();
  });

  it("a silent turn's over-budget boundary leaves no arrival on an open prose turn", async () => {
    const overBudget = createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use');
    overBudget.usage = { inputTokens: 100, outputTokens: 5 };
    membrane.pushResponse(overBudget);
    const framework = await createFramework({ maxStreamTokens: 20 });
    const routed = stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'quick question for you';
    module.interjectionMetadata = addressed('discord:dm:antra');
    feedStart(framework, 2, [{ type: 'text', text: 'quiet' }] as ContentBlock[]);
    type Routing = { locus?: string; engaged: Set<string>; arrivals: Array<{ messageId: string; channelId: string }>; [field: string]: unknown };
    const internals = framework as unknown as {
      openLogical: Map<string, Routing>; pendingRequests: InferenceRequest[];
    };
    // Built by hand, as #312's silent-start test does: production runs no
    // silent turn while a prose turn is open.
    const open: Routing = {
      locus: 'chan-turn', engaged: new Set(), destination: null, hybridHold: false,
      continuation: false, deliveries: [], suppressed: 0, arrivals: [],
    };
    internals.openLogical.set('assistant', open);
    internals.pendingRequests.push({
      agentName: 'assistant', reason: 'heartbeat', source: 'framework', timestamp: Date.now(), suppressProse: true,
    } as InferenceRequest);

    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 2, 'the silent turn crossed its budget and restarted');
    assert.deepEqual(routed, [], 'and its restart stayed silent');
    assert.equal(module.interjection, null, 'the DM arrived during its tool round');
    assert.deepEqual(open.arrivals, [], "the silent turn's injections are no arrival of the prose turn");

    await framework.stop();
  });

  for (const [label, notice] of [
    ['a re-pin', 'The conversation moved to'],
    ["a turn's announcement", 'Your plain speech now lands in'],
  ] as const) {
    it(`the announce baseline moves only once ${label}'s notice is stored`, async () => {
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }] as ContentBlock[]));
      const framework = await createFramework();
      stubChannelRegistry(framework);
      module.toolDelayMs = 25;
      if (notice === 'The conversation moved to') {
        // Someone addresses the agent mid-turn from a DM: the turn re-pins.
        module.interjection = 'quick question for you';
        module.interjectionMetadata = addressed('discord:dm:antra');
      }
      const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
        addMessage(participant: string, content: ContentBlock[], metadata?: unknown): string;
      };
      const add = cm.addMessage.bind(cm);
      cm.addMessage = (participant, content, metadata) => {
        if ((content[0] as { text?: string })?.text?.includes(notice)) throw new Error('store refused');
        return add(participant, content, metadata);
      };
      const baseline = (framework as unknown as { lastAnnouncedLocus: Map<string, string | null> }).lastAnnouncedLocus;

      trigger(framework);
      await framework.runUntilIdle();

      if (notice === 'The conversation moved to') {
        assert.equal(baseline.get('assistant'), 'chan-live-1', 'the agent was last told of the locus the turn opened at');
      } else {
        assert.equal(baseline.has('assistant'), false, 'the agent was never told a locus');
      }

      await framework.stop();
    });
  }

  // A tool's late write lands in the turn that called it: a send's engaged
  // channel, and a channel_open's move of the locus. (The dispatch functions
  // run on a bare framework, as checkpoint-attribution.test.ts's harness does.)
  function bareFramework(): Record<string, unknown> & { [method: string]: any } {
    const framework = Object.create(AgentFramework.prototype) as Record<string, unknown> & { [method: string]: any };
    framework.emitTrace = () => {};
    framework.pushEvent = () => {};
    framework.conversationAgentHomes = new Map();
    framework.lastAnnouncedLocus = new Map();
    framework.activeTurnTriggers = new Map();
    framework.openLogical = new Map();
    return framework;
  }
  const until = async (done: () => boolean, label: string): Promise<void> => {
    for (const end = Date.now() + 2000; !done();) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  // stop() ends every open turn, but a fresh start that awaits a deferred
  // batch's assembly while the stop runs reaches its routing after it, opens
  // its turn, and is then dropped before its stream sends anything: before
  // its compile, once stop() has closed admission, or after it, once a
  // restart has begun a lifecycle of its own.
  for (const restartFirst of [false, true]) {
    const name = restartFirst
      ? "a start whose compile spans a stop() and restart is dropped and leaves no turn open, so the next start opens its own"
      : "a start that stop() drops before its compile leaves no turn open, so the first start after a restart opens its own";
    it(name, async () => {
      // A store the framework doesn't own, so the same instance can start again.
      const store = JsStore.openOrCreate({ path: join(tempDir, 'restart.chronicle') });
      const framework = await AgentFramework.create({
        store,
        membrane: membrane.asMembrane(),
        agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.' }],
        modules: [module],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 0,
      });
      module.framework = framework;
      const routed = stubChannelRegistry(framework);
      const internals = framework as unknown as {
        pushCoalescer: unknown;
        openLogical: Map<string, unknown>;
        startAgentStream(agent: unknown, trigger?: InferenceRequest): Promise<void>;
      };
      const agent = framework.getAgent('assistant')!;
      const wake = (): InferenceRequest => ({
        agentName: 'assistant', reason: 'external-message', source: 'test', timestamp: Date.now(),
      } as InferenceRequest);
      let entered!: () => void;
      const assembling = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      internals.pushCoalescer = {
        pendingBatches: () => true,
        assemble: async () => {
          entered();
          await released;
          return { settled: new Set<string>(), materialized: new Set<string>() };
        },
        suspend: () => {},
        isRendering: () => false,
      };
      const lines: string[] = [];
      const error = console.error;
      try {
        console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
        try {
          const dropped = internals.startAgentStream(agent, wake());
          await assembling;
          await framework.stop();
          if (restartFirst) framework.start();
          release();
          await dropped;
        } finally { console.error = error; }
        if (restartFirst) {
          assert.ok(lines.some((line) => /stopped and started again/.test(line) && /dropped before it sends anything/.test(line)),
            lines.join('\n'));
        } else {
          assert.equal(membrane.calls.length, 0, 'the start was dropped before its compile');
        }
        assert.deepEqual(routed, [], 'the dropped start routed nothing');
        assert.equal(internals.openLogical.has('assistant'), false, 'the dropped start left no turn open');

        if (!restartFirst) framework.start();
        internals.pushCoalescer = undefined;
        membrane.pushResponse(createMockResponse([{ type: 'text', text: 'After the restart.' }] as ContentBlock[]));
        await internals.startAgentStream(agent, wake());
        await until(() => routed.length > 0, "the next turn's speech");
        // The dropped start resolved chan-live-1. Continuing its turn would
        // have kept that locus, without resolving one.
        assert.deepEqual(routed, [{ text: 'After the restart.', locus: 'chan-live-2' }],
          'the next start resolved a locus of its own');
      } finally {
        release();
        await framework.stop();
        store.close();
      }
    });
  }

  it("a send's engaged channel is recorded on the turn that sent, however late its open resolves", async () => {
    const sending = { engaged: new Set<string>() };
    const next = { engaged: new Set<string>() };
    let resolveOpen!: (outcome: { status: string; channelId: string }) => void;
    const framework = bareFramework();
    framework.mcplServerRegistry = {
      getServer: (id: string) => id === 'chat' ? {
        id: 'chat',
        sendToolsCall: async () => ({ content: [{ type: 'text', text: 'sent' }] }),
      } : null,
    };
    framework.mcplServerConfigs = new Map([['chat', { id: 'chat', toolPrefix: 'chat' }]]);
    framework.mcplToolFeatureSets = new Map();
    framework.checkpointManager = null;
    framework.channelRegistry = {
      openIfClosedForSend: () => new Promise((resolve) => { resolveOpen = resolve; }),
    };
    framework.turnRouting = new Map([['assistant', sending]]);
    const results: unknown[] = [];
    framework.pushEvent = (event: { type: string }) => { if (event.type === 'tool-result') results.push(event); };

    framework.dispatchMcplToolCall('assistant', {
      id: 'send-1', name: 'chat--send_message', input: { channelId: 'discord:guild:portables', text: 'hi' },
    }, 'chat', 'chat');
    await until(() => results.length > 0 && resolveOpen !== undefined, 'the send to finish');
    // The turn that sent has ended, and the next turn is the agent's live routing.
    (framework.turnRouting as Map<string, unknown>).set('assistant', next);
    resolveOpen({ status: 'already-open', channelId: 'discord:guild:portables' });
    await until(() => sending.engaged.size > 0, 'the open to resolve');

    assert.deepEqual([...sending.engaged], ['discord:guild:portables']);
    assert.deepEqual([...next.engaged], [], "the next turn didn't send there");
  });

  // A channel_open's result can land after a later start has made another
  // object the agent's live routing. While the turn that called is open, the
  // result moves that turn's locus and tells the agent. Once the turn has
  // ended, the tool-result handler drops the result, so the agent never reads
  // it, and nothing moves, whether or not a later start has come yet.
  for (const [label, after, moves] of [
    ['moves the locus of its turn, still open, when a silent start\'s routing is the live one', 'silent start', true],
    ['moves no locus once its turn has ended and the next turn has opened', 'next turn', false],
    ['moves no locus once its turn has settled, before any later start', 'settled', false],
  ] as const) {
    it(`a channel_open whose result lands late ${label}`, async () => {
      type Routing = { engaged: Set<string>; triggerChannel?: string; locus?: string };
      const calling: Routing = { engaged: new Set(), locus: 'chan-before' };
      const other: Routing = { engaged: new Set(), locus: 'chan-next' };
      let resolveOpen!: (result: { success: boolean; data: { channelId: string } }) => void;
      const framework = bareFramework();
      framework.agents = new Map([['assistant', { proseRouting: 'locus' }]]);
      framework.channelRegistry = {
        handleChannelToolCall: () => new Promise((resolve) => { resolveOpen = resolve; }),
      };
      framework.turnRouting = new Map([['assistant', calling]]);
      framework.openLogical = new Map([['assistant', calling]]);
      const results: Array<{ result: { data?: { routing?: string } } }> = [];
      framework.pushEvent = (event: { type: string }) => {
        if (event.type === 'tool-result') results.push(event as unknown as { result: { data?: { routing?: string } } });
      };

      framework.dispatchChannelToolCall('assistant', {
        id: 'open-1', name: 'channel_open', input: { channelId: 'discord:guild:observatory' },
      });
      await until(() => resolveOpen !== undefined, 'the open to start');
      const turnRouting = framework.turnRouting as Map<string, unknown>;
      const openLogical = framework.openLogical as Map<string, unknown>;
      if (after === 'silent start') turnRouting.set('assistant', other);
      if (after === 'next turn') { turnRouting.set('assistant', other); openLogical.set('assistant', other); }
      if (after === 'settled') openLogical.delete('assistant');
      resolveOpen({ success: true, data: { channelId: 'discord:guild:observatory' } });
      await until(() => results.length > 0, 'the tool result');

      assert.equal(calling.triggerChannel, 'discord:guild:observatory', 'the turn that called records the channel it opened');
      assert.equal(calling.locus, moves ? 'discord:guild:observatory' : 'chan-before');
      assert.deepEqual(other, { engaged: new Set(), locus: 'chan-next' }, 'the other routing state is untouched');
      assert.equal((framework.lastAnnouncedLocus as Map<string, string>).get('assistant'),
        moves ? 'discord:guild:observatory' : undefined, "the announce baseline moves with the locus, for a move the agent is told");
      assert.equal(results[0]!.result.data?.routing !== undefined, moves, 'and the result says so only then');
    });
  }

  for (const [label, silent, expected] of [
    ['while its turn runs moves the locus and the announce baseline, and says so', false, 'discord:guild:observatory'],
    ['in a silent turn moves no locus, and claims none', true, 'chan-before'],
  ] as const) {
    it(`a channel_open ${label}`, async () => {
      const calling: { engaged: Set<string>; triggerChannel?: string; locus?: string } = { engaged: new Set(), locus: 'chan-before' };
      const framework = bareFramework();
      framework.agents = new Map([['assistant', { proseRouting: 'locus' }]]);
      framework.channelRegistry = {
        handleChannelToolCall: async () => ({ success: true, data: { channelId: 'discord:guild:observatory' } }),
      };
      framework.turnRouting = new Map([['assistant', calling]]);
      if (!silent) framework.openLogical = new Map([['assistant', calling]]);
      (framework.activeTurnTriggers as Map<string, unknown>).set('assistant', silent ? { suppressProse: true } : {});
      const results: Array<{ result: { data?: { routing?: string } } }> = [];
      framework.pushEvent = (event: { type: string }) => {
        if (event.type === 'tool-result') results.push(event as unknown as { result: { data?: { routing?: string } } });
      };

      framework.dispatchChannelToolCall('assistant', {
        id: 'open-1', name: 'channel_open', input: { channelId: 'discord:guild:observatory' },
      });
      await until(() => results.length > 0, 'the tool result');

      assert.equal(calling.locus, expected);
      assert.equal((framework.lastAnnouncedLocus as Map<string, string>).get('assistant'), silent ? undefined : 'discord:guild:observatory');
      assert.equal(results[0]!.result.data?.routing !== undefined, !silent, 'the result tells the agent only of a move it made');
    });
  }

  it('a prose turn ends with a [delivered] receipt naming where the prose landed', async () => {
    // Explicit sends receipt themselves via tool_result; auto-routed prose
    // previously vanished with no in-window trace — the agent could never
    // see where its own words went (2026-07-31 misroute series). One compact
    // system message at logical turn end, channels deduped in delivery order.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'A quiet reply with no tools.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    const cm = (framework as unknown as {
      agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> } }>;
    }).agents.get('assistant')!.getContextManager();
    const texts = cm.getAllMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
    const receipts = texts.filter((t) => t.startsWith('[delivered]'));
    assert.deepEqual(receipts, ['[delivered] plain speech → chan-live-1']);
    // The receipt is the LAST window message — after the assistant blocks.
    assert.ok(texts[texts.length - 1].startsWith('[delivered]'), 'receipt sits at the settled tail');

    await framework.stop();
  });

  it('a re-pinned turn\'s receipt names both channels in delivery order', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Station four, proceeding.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Answering the person who addressed me.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework);
    module.toolDelayMs = 25;
    module.interjection = 'quick question over here?';
    module.interjectionMetadata = { channelId: 'discord:dm:antra', tags: ['chat:addressed'] };

    trigger(framework);
    await framework.runUntilIdle();

    const cm = (framework as unknown as {
      agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> } }>;
    }).agents.get('assistant')!.getContextManager();
    const receipts = cm.getAllMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .filter((t) => t.startsWith('[delivered]'));
    assert.deepEqual(receipts, ['[delivered] plain speech → chan-live-1 · discord:dm:antra']);

    await framework.stop();
  });

  it('suppressed prose is visible in the receipt (silencing is never a silent black hole)', async () => {
    // n=8 (2026-07-31 ~22:46): one round multiplexing two threads — prose
    // for the lane + an explicit send for another channel, textbook per the
    // routing doc. Sticky silencing ate the prose reply and nothing told
    // the author; their own record believed it delivered. The rule stands
    // (antra: visibility is enough) — but the turn-end receipt now reports
    // the suppression, so the segment's fate is visible one turn later.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'the reply that silencing will eat' },
      { type: 'tool_use', id: 'c1', name: 'robot--send_message', input: { text: 'explicit send to the other thread' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'trailing prose, also suppressed (sticky)' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'silencing semantics unchanged: nothing auto-routed');
    const cm = (framework as unknown as {
      agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> } }>;
    }).agents.get('assistant')!.getContextManager();
    const receipts = cm.getAllMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .filter((t) => t.startsWith('[delivered]'));
    assert.deepEqual(receipts, [
      '[delivered] nothing — 2 plain-speech segment(s) suppressed (explicit send in the same round — resend with a send tool if it was meant to be heard)',
    ]);

    await framework.stop();
  });

  for (const verb of ['say', 'whisper'] as const) {
    it(`world \`${verb}\` silences adjacent auto-routed prose in locus mode (no double-publish)`, async () => {
      // 2026-09-01 (Cairn, locus mode): a round of ordinary text + explicit
      // world `say` published TWICE — seq 15146 was the say text, seq 15147
      // the adjacent prose auto-routed to the same world locus, byte-for-byte.
      // World publication verbs silenced only in hybrid mode; Discord sends
      // silenced everywhere. An explicit world utterance is the resident's
      // chosen speech for the round in every mode.
      const input = verb === 'say'
        ? { text: 'the intended utterance' }
        : { to: 'sill', text: 'the intended utterance' };
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'adjacent prose that must NOT auto-publish' },
        { type: 'tool_use', id: 'c1', name: `robot--${verb}`, input },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'trailing prose, also suppressed (sticky)' },
      ] as ContentBlock[]));

      const framework = await createFramework();
      const routed = stubChannelRegistry(framework);

      trigger(framework);
      await framework.runUntilIdle();

      assert.deepEqual(routed, [], `${verb}: nothing auto-routed beside the explicit world utterance`);
      const cm = (framework as unknown as {
        agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> } }>;
      }).agents.get('assistant')!.getContextManager();
      const receipts = cm.getAllMessages()
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .filter((t) => t.startsWith('[delivered]'));
      assert.deepEqual(receipts, [
        '[delivered] nothing — 2 plain-speech segment(s) suppressed (explicit send in the same round — resend with a send tool if it was meant to be heard)',
      ], `${verb}: suppression is visible in the receipt`);

      await framework.stop();
    });
  }

  it('a non-publishing world tool (move) does not silence — speak-while-acting unchanged', async () => {
    // Negative control for the world-verb silencing: only publication verbs
    // silence. Ordinary acting tools still narrate live to the locus.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'walking over' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'there' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed.map((r) => r.text), ['walking over', 'there']);

    await framework.stop();
  });

  it('channel_open moves the pin mid-turn and announces in its own tool result', async () => {
    // The agent's own deliberate open is the strongest "my next words go
    // here" signal — stronger than any injection. The original 2026-07-21
    // Aria fix only set next-turn trigger state; the turn-frozen refactor
    // silently regressed the reply-right-after-opening case. Now the pin
    // moves immediately and the announcement rides the tool result itself
    // (model-requested content: distance zero, safest role).
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'discord:guild:observatory' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Hello, observatory.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    (registry as { handleChannelToolCall?: unknown }).handleChannelToolCall =
      async () => ({ success: true, data: { channelId: 'discord:guild:observatory', opened: true } });

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Hello, observatory.', locus: 'discord:guild:observatory' },
    ], 'prose right after channel_open lands in the opened channel');
    // The announcement rode the tool result the model saw.
    const results = membrane.lastStream!.receivedToolResults.flat() as Array<{ content?: unknown }>;
    assert.ok(
      JSON.stringify(results).includes('plain speech now lands in this channel'),
      'routing note present in the channel_open tool result',
    );

    await framework.stop();
  });

  it('reactions and system markers injected mid-turn do not clear send suppression', async () => {
    // A reaction (`chat:reaction` tag) or a `system: true` marker is not
    // conversational input: prose following an explicit send stays suppressed,
    // so a stray reaction can't make the agent double-post a "sent it"
    // postscript — and (with the frozen locus) can't move routing either.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--send_message', input: { text: 'reply to room4' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Sent it.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    module.interjection = '[reaction] @someone reacted 👍';
    module.interjectionChannelId = null;
    module.interjectionMetadata = { channelId: '999888777', tags: ['chat:reaction'] };

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'post-send prose stayed suppressed after a reaction');

    await framework.stop();
  });

  it('text-only turns route to the turn-frozen locus, not a live re-resolution', async () => {
    // The text-only dispatch runs after the agent is idle; a live resolution
    // there can read the NEXT turn's trigger state or a post-restart cleared
    // one (2026-07-22 Sol DM misroute). The stub increments its locus per
    // resolveLocus() call: the turn-start freeze consumes chan-live-1, so a
    // live re-resolution at dispatch would return chan-live-2. The frozen
    // path must deliver to chan-live-1.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'A quiet reply with no tools.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'A quiet reply with no tools.', locus: 'chan-live-1' },
    ]);

    await framework.stop();
  });

  it('announces the outbound locus in the window only when it changes', async () => {
    // Turn 1 (locus chan-live-1, e2e): one durable [routing] notice — the
    // boot baseline. Then the announce-on-change logic directly (MockMembrane
    // supports one turn per test): same locus → silence (steady state must
    // not chatter — KV); new locus → exactly one more notice.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'one' }] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework);

    const notices: string[] = [];
    framework.onTrace((event) => {
      const e = event as { type: string; source?: string };
      if (e.type === 'message:added' && e.source === 'routing-notice') {
        notices.push(e.source!);
      }
    });

    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(notices.length, 1, 'first turn announced the boot-baseline locus');

    const announce = (
      framework as unknown as {
        announceLocusIfChanged(agentName: string, locus: string | null): void;
      }
    ).announceLocusIfChanged.bind(framework);

    announce('assistant', 'chan-live-1');
    assert.equal(notices.length, 1, 'unchanged locus announced nothing');

    announce('assistant', 'chan-B');
    assert.equal(notices.length, 2, 'changed locus announced exactly once');

    announce('assistant', 'chan-B');
    assert.equal(notices.length, 2, 'steady state on the new locus stays silent');

    announce('assistant', null);
    assert.equal(notices.length, 3, 'losing the locus is announced too');

    await framework.stop();
  });

  // -------------------------------------------------------------------------
  // Hear-while-acting
  // -------------------------------------------------------------------------

  it('injects a mid-turn message into the resumed stream at the tool boundary', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Heard you!' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    module.interjection = 'look left!';

    trigger(framework);
    await framework.runUntilIdle();

    const stream = membrane.lastStream!;
    assert.equal(stream.receivedToolResults.length, 1);
    const options = stream.receivedToolResultOptions[0];
    assert.ok(options?.injectedMessages, 'tool-result resume carried injected messages');
    assert.equal(options!.injectedMessages!.length, 1);
    const injected = options!.injectedMessages![0]!;
    assert.equal(injected.participant, 'Antra');
    const text = (injected.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    assert.equal(text, 'look left!');

    await framework.stop();
  });

  it('passes no injection options when nothing arrived mid-turn', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'done' },
    ] as ContentBlock[]));

    const framework = await createFramework();

    trigger(framework);
    await framework.runUntilIdle();

    const stream = membrane.lastStream!;
    assert.equal(stream.receivedToolResults.length, 1);
    assert.equal(stream.receivedToolResultOptions[0], undefined);

    await framework.stop();
  });
});
