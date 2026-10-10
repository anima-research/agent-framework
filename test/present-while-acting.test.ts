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
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, StreamEvent } from '@animalabs/membrane';

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

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

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

/** Minimal ChannelRegistry stub covering everything driveStream touches.
 *  By default every agent has a HOME route (a fork-style deliberate route,
 *  `chan-live-N`); `{ home: false }` leaves routes to the turn's wake. */
function stubChannelRegistry(framework: AgentFramework, opts: { home?: boolean } = {}) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  let locusCalls = 0;
  const explicit: Record<string, unknown> = {
    resolveLocus: () => {
      if (opts.home === false) return null;
      locusCalls++;
      return `chan-live-${locusCalls}`;
    },
    routeSpeech: async (_agent: string, text: string, target?: string | null | { channelId: string; threadId?: string | null }) => {
      const locus = target && typeof target === 'object' ? target.channelId : target ?? null;
      const threadId = target && typeof target === 'object' ? target.threadId : undefined;
      routed.push({ text, locus });
      // Mirror the real registry's outcome shape (delivery receipts read it),
      // the thread included when the publish was placed in one.
      return locus ? { delivered: true, channelId: locus, ...(threadId ? { threadId } : {}) } : null;
    },
    // Hybrid `>>>#name` targets resolve to `chan-name` and deliver through
    // the registry's outcome-returning form, recorded like routeSpeech.
    resolveProseTarget: (spec: string) => ({ channelId: spec.startsWith('#') ? `chan-${spec.slice(1)}` : spec, label: spec }),
    deliverSpeech: async (_agent: string, text: string, target?: string | null | { channelId: string }) => {
      const locus = target && typeof target === 'object' ? target.channelId : target ?? null;
      routed.push({ text, locus });
      return { status: 'delivered', destination: { serverId: 'stub', channelId: locus ?? '' }, at: Date.now() };
    },
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
    // Every channel declares an MCPL RFC-011 publish target, so it can be a
    // route (a route is only ever a place the framework publishes to exactly).
    publishTarget: () => 'root',
  };
  // Everything else driveStream/stop touches (startTyping, stopTyping,
  // stopAll, ensureChannelRegistered, ...) becomes a no-op via Proxy so the
  // stub doesn't chase the real registry's surface.
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

/** A channel item's source envelope, as admission stamps it. */
function envelope(channelId: string, messageId = 'm-arrival'): Record<string, unknown> {
  return {
    kind: 'channel', lane: 'channels/incoming', serverId: 'srv', binding: 'srv',
    channelId, messageId, acceptedAt: Date.now(),
  };
}

/** Wake the agent from one conversation: the turn infers its route there. */
function triggerFromChannel(framework: AgentFramework, channelId = 'chan-A'): void {
  (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
    agentName: 'assistant', reason: 'mcpl:channel-incoming', source: 'srv', timestamp: Date.now(),
    channelId, addressed: true,
    routeCandidates: [{
      conversation: { kind: 'channel', serverId: 'srv', channelId },
      addressed: true, messageId: 'm-trigger', at: Date.now(),
    }],
  });
}

/** The framework's engagement record (turnEngagement), as its send paths write and the hold reads it. */
function engage(framework: AgentFramework) {
  return framework as unknown as {
    noteSendEngagement(agent: string, status: 'delivered' | 'unknown' | 'failed', place: { serverId?: string; channelId: string; threadId?: string | null }): void;
    noteChannelEngagement(agent: string, serverId: string | undefined, channelId: string): void;
    engagementOf(agent: string, c: { kind: 'channel'; serverId?: string; channelId: string; threadId?: string }): string | undefined;
  };
}

function heldDrafts(framework: AgentFramework): Array<{ text: string; reason: string; note?: string }> {
  return (framework as unknown as { proseDrafts: { open(agent: string): Array<{ text: string; reason: string; note?: string }> } })
    .proseDrafts.open('assistant');
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

  async function createFramework(): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.' },
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

  it('an ADDRESSED mid-turn arrival from another conversation holds an inferred route: later prose becomes a draft', async () => {
    // 2026-07-31 misroutes (n=6): someone addresses the agent from another
    // channel mid-turn; the agent's next unaddressed words could answer
    // either conversation. The old re-pin guessed the newcomer and sent
    // words still meant for the first conversation into the second
    // (shelf-355). Now the inferred route is HELD: unaddressed speech becomes
    // drafts for the rest of the turn, with a one-line [routing] notice
    // riding the same injection batch so window and wire agree.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Station four, proceeding.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Answering the person who addressed me.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = 'hey, quick question over here?';
    module.interjectionMetadata = {
      channelId: 'discord:dm:antra', tags: ['chat:addressed'], inboundSource: envelope('discord:dm:antra'),
    };

    const notices: string[] = [];
    framework.onTrace((event) => {
      const e = event as { type: string; source?: string };
      if (e.type === 'message:added' && e.source === 'routing-notice') notices.push(e.source!);
    });

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    // Round-1 prose predates the arrival and goes to the turn's route; the
    // trailing prose is held, never guessed into either conversation.
    assert.deepEqual(routed, [{ text: 'Station four, proceeding.', locus: 'chan-A' }]);
    const [held] = heldDrafts(framework);
    assert.equal(held?.text, 'Answering the person who addressed me.');
    assert.equal(held?.reason, 'ambiguous');
    assert.match(held?.note ?? '', /chan-A; discord:dm:antra/);
    // Turn-start announcement + the mid-turn hold notice.
    assert.equal(notices.length, 2, 'the hold produced exactly one routing notice');
    const wired = membrane.lastStream!.receivedToolResultOptions
      .map((o) => o?.injectedMessages ?? []).flat().map((m) => JSON.stringify(m.content));
    assert.ok(wired.some((t) => t.includes('quick question')), 'the addressed message itself was injected');
    assert.ok(
      wired.some((t) => t.includes('[routing] discord:dm:antra addressed you mid-turn') && t.includes('instead of going to chan-A')),
      'the hold notice was injected alongside it',
    );

    await framework.stop();
  });

  it('a follow-up in a channel the agent explicitly engaged this turn holds the route', async () => {
    // 2026-07-31 n=7 (q's #portables reply): the agent explicitly sent into a
    // channel this turn; someone replies there WITHOUT a mention. Their
    // follow-up competes for the agent's unaddressed words, so it holds them.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Good plan on both counts.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = 'I need to swap out this eye screen';
    module.interjectionMetadata = {
      channelId: 'discord:guild:portables',
      tags: ['chat:ambient', 'chat:from-human'],
      inboundSource: envelope('discord:guild:portables'),
    };
    // Simulate an explicit send into #portables earlier in THIS turn, as a
    // delivered resend or channel_publish records it (the harness module's
    // tools are not MCPL, so seed the turn's engagement mid-turn — after the
    // turn-start clear, before the injection boundary).
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      engage(framework).noteSendEngagement('assistant', 'delivered', { serverId: 'srv', channelId: 'discord:guild:portables', threadId: null });
      return origHandle(call);
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'neither conversation is guessed');
    assert.deepEqual(heldDrafts(framework).map((d) => [d.text, d.reason]), [['Good plan on both counts.', 'ambiguous']]);
    // The notice names the actual cause: a continued conversation, not an address.
    const wired = membrane.lastStream!.receivedToolResultOptions
      .map((o) => o?.injectedMessages ?? []).flat().map((m) => JSON.stringify(m.content));
    assert.ok(wired.some((t) => t.includes('[routing] discord:guild:portables, where you sent a message this turn, continued mid-turn')));
    assert.ok(!wired.some((t) => t.includes('addressed you mid-turn')));

    await framework.stop();
  });

  it('an agent-resident follow-up in an engaged channel holds it too (no author-kind filter)', async () => {
    // Fleet participants include agent-residents — "bot" by Discord flag,
    // full conversational participants in fact (antra, 2026-07-31).
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Continuing with the colleague.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = '*from the table* one receipt for the case, since I have a dated instance';
    module.interjectionMetadata = {
      channelId: 'discord:guild:hospital',
      tags: ['chat:ambient', 'chat:from-bot'],
      inboundSource: envelope('discord:guild:hospital'),
    };
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      // As a connector's own send tool records it: the channel.
      engage(framework).noteChannelEngagement('assistant', 'srv', 'discord:guild:hospital');
      return origHandle(call);
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, []);
    assert.deepEqual(heldDrafts(framework).map((d) => d.reason), ['ambiguous']);

    await framework.stop();
  });

  it('ambient chatter in a channel the agent did NOT engage leaves the route alone', async () => {
    // The Cairn-protection boundary: no mention, no engagement this turn →
    // the route holds steady and speech keeps going where it was going.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Continuing my report.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = 'unrelated lounge chatter';
    module.interjectionMetadata = {
      channelId: 'discord:guild:lounge',
      tags: ['chat:ambient', 'chat:from-human'],
      inboundSource: envelope('discord:guild:lounge'),
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Continuing my report.', locus: 'chan-A' }], 'un-engaged ambient changed nothing');
    assert.deepEqual(heldDrafts(framework), []);

    await framework.stop();
  });

  it('an addressed arrival in the SAME conversation keeps the route and adds no notice', async () => {
    // The person the agent is already talking to sends another message
    // mid-turn: nothing competes, so no hold and — for KV — no notice.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Continuing right here.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = 'and one more thing';
    module.interjectionMetadata = { channelId: 'chan-A', tags: ['chat:addressed'], inboundSource: envelope('chan-A') };

    const notices: string[] = [];
    framework.onTrace((event) => {
      const e = event as { type: string; source?: string };
      if (e.type === 'message:added' && e.source === 'routing-notice') notices.push(e.source!);
    });

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Continuing right here.', locus: 'chan-A' }]);
    assert.equal(notices.length, 1, 'only the turn-start announcement');
    // Someone else speaking in the same conversation doesn't move the reply
    // edge: the route still answers the message that woke the turn.
    const view = (framework as unknown as { speechRouteView(agent: string): Record<string, unknown> }).speechRouteView('assistant');
    assert.deepEqual(view, { kind: 'channel', serverId: 'srv', channelId: 'chan-A', replyTo: 'm-trigger' });

    await framework.stop();
  });

  it('hybrid: a >>> target set this turn survives a hold — deliberate pins are never held', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#alpha Opening note.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'And a follow-up for alpha.' },
    ] as ContentBlock[]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'hybrid.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.', proseRouting: 'hybrid' }],
      modules: [module],
    });
    module.framework = framework;
    const routed = stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = 'hey, over here?';
    module.interjectionMetadata = {
      channelId: 'discord:dm:antra', tags: ['chat:addressed'], inboundSource: envelope('discord:dm:antra'),
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Opening note.', locus: 'chan-alpha' },
      { text: 'And a follow-up for alpha.', locus: 'chan-alpha' },
    ], 'the sticky >>> target keeps carrying unprefixed prose through the hold');
    assert.deepEqual(heldDrafts(framework), []);

    await framework.stop();
  });

  it('a deliberate route (a fork home) is never held by an arrival', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Still answering at home.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework); // home route chan-live-1
    module.toolDelayMs = 25;
    module.interjection = 'hey, over here?';
    module.interjectionMetadata = {
      channelId: 'discord:dm:antra', tags: ['chat:addressed'], inboundSource: envelope('discord:dm:antra'),
    };

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Still answering at home.', locus: 'chan-live-1' }]);
    assert.deepEqual(heldDrafts(framework), []);

    await framework.stop();
  });

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

  it('a held turn\'s receipt names where its speech landed and the draft it held', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Station four, proceeding.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Answering the person who addressed me.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = 'quick question over here?';
    module.interjectionMetadata = {
      channelId: 'discord:dm:antra', tags: ['chat:addressed'], inboundSource: envelope('discord:dm:antra'),
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    const cm = (framework as unknown as {
      agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> } }>;
    }).agents.get('assistant')!.getContextManager();
    const receipts = cm.getAllMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .filter((t) => t.startsWith('[delivered]'));
    assert.equal(receipts.length, 1);
    assert.match(receipts[0]!, /^\[delivered\] plain speech → chan-A/);
    assert.match(receipts[0]!, /held as draft d-[a-z2-9]{5}/);

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
    // The suppressed words are held as drafts, named in the receipt.
    const drafts = (framework as unknown as { proseDrafts: { open(a: string): Array<{ id: string; text: string }> } })
      .proseDrafts.open('assistant').reverse();
    assert.deepEqual(drafts.map((d) => d.text), ['the reply that silencing will eat', 'trailing prose, also suppressed (sticky)']);
    assert.deepEqual(receipts, [
      `[delivered] nothing — 2 plain-speech segment(s) held as drafts ${drafts.map((d) => d.id).join(', ')} ` +
        '(not sent — drafts can resend them unchanged, or dismiss them)',
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
      const drafts = (framework as unknown as { proseDrafts: { open(a: string): Array<{ id: string; text: string }> } })
        .proseDrafts.open('assistant').reverse();
      assert.deepEqual(drafts.map((d) => d.text), ['adjacent prose that must NOT auto-publish', 'trailing prose, also suppressed (sticky)']);
      assert.deepEqual(receipts, [
        `[delivered] nothing — 2 plain-speech segment(s) held as drafts ${drafts.map((d) => d.id).join(', ')} ` +
          '(not sent — drafts can resend them unchanged, or dismiss them)',
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

  it('channel_open sets the speech route mid-turn and announces it in its own tool result', async () => {
    // The agent's own deliberate open is the strongest "my next words go
    // here" signal: by default (setSpeechTarget) its unaddressed speech goes
    // to the opened channel for the rest of the turn — replacing an inferred
    // route, or a hold — and the announcement rides the tool result itself.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'discord:guild:observatory' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Hello, observatory.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    (registry as { handleChannelToolCall?: unknown }).handleChannelToolCall =
      async () => ({ success: true, data: { channelId: 'discord:guild:observatory', opened: true } });

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Hello, observatory.', locus: 'discord:guild:observatory' },
    ], 'prose right after channel_open lands in the opened channel');
    const results = membrane.lastStream!.receivedToolResults.flat() as Array<{ content?: unknown }>;
    assert.ok(
      JSON.stringify(results).includes('Your unaddressed plain speech now goes to discord:guild:observatory for the rest of this turn'),
      'routing note present in the channel_open tool result',
    );

    await framework.stop();
  });

  it('channel_open with setSpeechTarget: false opens for reading and leaves the route where it was', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'discord:guild:observatory', setSpeechTarget: false } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Still talking to chan-A.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    (registry as { handleChannelToolCall?: unknown }).handleChannelToolCall =
      async () => ({ success: true, data: { channelId: 'discord:guild:observatory', opened: true } });

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Still talking to chan-A.', locus: 'chan-A' }]);
    const results = JSON.stringify(membrane.lastStream!.receivedToolResults.flat());
    assert.ok(results.includes('Opened for reading. Your plain speech still goes to chan-A.'));

    await framework.stop();
  });

  it('channel_open with setSpeechTarget: false and no route says speech is held as drafts', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'discord:guild:observatory', setSpeechTarget: false } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Thinking out loud.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    (registry as { handleChannelToolCall?: unknown }).handleChannelToolCall =
      async () => ({ success: true, data: { channelId: 'discord:guild:observatory', opened: true } });

    // A heartbeat-style wake: no conversation, so no route.
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'assistant', reason: 'heartbeat', source: 'timer', timestamp: Date.now(),
    });
    await framework.runUntilIdle();

    assert.deepEqual(routed, []);
    assert.deepEqual(heldDrafts(framework).map((d) => [d.text, d.reason]), [['Thinking out loud.', 'no-destination']]);
    const results = JSON.stringify(membrane.lastStream!.receivedToolResults.flat());
    assert.ok(results.includes('You have no speech route, so unaddressed plain speech is held as drafts.'));

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

  it('announces the speech route in the window only when it changes', async () => {
    // Turn 1 (home route chan-live-1, e2e): one durable [routing] notice —
    // the boot baseline. Then the announce-on-change logic directly
    // (MockMembrane supports one turn per test): same route → silence
    // (steady state must not chatter — KV); a new route, a hold, or no
    // route → exactly one notice each.
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
    assert.equal(notices.length, 1, 'first turn announced the boot-baseline route');

    type Route = { route: unknown; hold?: unknown };
    const announce = (
      framework as unknown as { announceRouteIfChanged(agentName: string, turn: Route): void }
    ).announceRouteIfChanged.bind(framework);
    const channel = (channelId: string, origin = 'trigger'): Route =>
      ({ route: { kind: 'channel', serverId: '', channelId, origin } });

    announce('assistant', channel('chan-live-1', 'home'));
    assert.equal(notices.length, 1, 'unchanged route announced nothing');
    announce('assistant', channel('chan-B'));
    assert.equal(notices.length, 2, 'changed route announced exactly once');
    announce('assistant', channel('chan-B'));
    assert.equal(notices.length, 2, 'steady state on the new route stays silent');
    const held: Route = {
      route: null,
      hold: { since: 'turn-start', conversations: [{ kind: 'channel', serverId: '', channelId: 'chan-B' }, { kind: 'surface', surface: 'tui' }] },
    };
    announce('assistant', held);
    assert.equal(notices.length, 3, 'a held turn is announced');
    announce('assistant', { route: null });
    assert.equal(notices.length, 4, 'losing the route is announced too');

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

// ---------------------------------------------------------------------------
// Speech goes where the route stood when its words were written (#256 review)
// ---------------------------------------------------------------------------

describe('speech follows the moment its words were written', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: RobotModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pwa-moment-'));
    membrane = new MockMembrane();
    module = new RobotModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(proseRouting?: 'hybrid'): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.', ...(proseRouting ? { proseRouting } : {}) }],
      modules: [module],
    });
    module.framework = framework;
    return framework;
  }

  type Registry = Record<string, unknown>;
  const registryOf = (framework: AgentFramework): Registry =>
    (framework as unknown as { channelRegistry: Registry }).channelRegistry;

  /** channel_open succeeds for whatever channel it names. */
  function opensChannels(framework: AgentFramework): void {
    registryOf(framework).handleChannelToolCall = async (name: string, input: { channelId?: string }) =>
      name === 'channel_open' ? { success: true, data: { channelId: input.channelId, opened: true } } : { success: true };
  }

  /** The registry method's first call waits `ms` first, so later speech queues behind it. */
  function slowFirst(framework: AgentFramework, method: 'routeSpeech' | 'deliverSpeech', ms = 60): void {
    const registry = registryOf(framework);
    const fast = registry[method] as (...args: unknown[]) => Promise<unknown>;
    let first = true;
    registry[method] = async (...args: unknown[]) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, ms));
      }
      return fast(...args);
    };
  }

  /** Record the outgoing stream (MCPL §14.3): what each chunk and completion carried. */
  function recordStreams(framework: AgentFramework, refuse: (channelId: string, delta: string) => boolean = () => false) {
    const chunks: Array<{ channelId: string; delta: string; threadId: unknown }> = [];
    const completes: Array<{ channelId: string; text: string; threadId: unknown }> = [];
    const registry = registryOf(framework);
    registry.sendOutgoingChunk = (destination: { channelId: string }, _c: string, _i: string, _n: number, delta: string) => {
      if (refuse(destination.channelId, delta)) return false;
      chunks.push({ channelId: destination.channelId, delta, threadId: null });
      return true;
    };
    registry.sendOutgoingComplete = (destination: { channelId: string }, _c: string, _i: string, text: string) => {
      completes.push({ channelId: destination.channelId, text, threadId: null });
    };
    const streamedTo = (channelId: string): string => chunks.filter((c) => c.channelId === channelId).map((c) => c.delta).join('');
    return { chunks, completes, streamedTo };
  }

  /** An addressed arrival from another conversation, at the next tool call: it holds an inferred route. */
  function addressedArrivalElsewhere(): void {
    module.toolDelayMs = 25;
    module.interjection = 'hey, over here?';
    module.interjectionMetadata = {
      channelId: 'discord:dm:antra', tags: ['chat:addressed'], inboundSource: envelope('discord:dm:antra'),
    };
  }

  /** Wake the agent from a thread of `channelId`. */
  function triggerFromThread(framework: AgentFramework, channelId: string, threadId: string): void {
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'assistant', reason: 'mcpl:channel-incoming', source: 'srv', timestamp: Date.now(),
      channelId, addressed: true,
      routeCandidates: [{
        conversation: { kind: 'channel', serverId: 'srv', channelId, threadId },
        addressed: true, messageId: 'm-trigger', at: Date.now(),
      }],
    });
  }

  // ---- queued speech (review findings 2 and 4) ----------------------------

  it('a channel_open landing while earlier words wait on the speech chain does not move them', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'First words.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Second words, still for chan-A.' },
      { type: 'tool_use', id: 'c2', name: 'channel_open', input: { channelId: 'discord:guild:observatory' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Third words, for the observatory.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    opensChannels(framework);
    slowFirst(framework, 'routeSpeech');

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'First words.', locus: 'chan-A' },
      { text: 'Second words, still for chan-A.', locus: 'chan-A' },
      { text: 'Third words, for the observatory.', locus: 'discord:guild:observatory' },
    ]);

    await framework.stop();
  });

  it('hybrid: words written under a `>>>` choice keep it though a channel_open lands before they are published', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#alpha Pinned words.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'More for alpha.' },
      { type: 'tool_use', id: 'c2', name: 'channel_open', input: { channelId: 'discord:guild:observatory' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'After the open.' },
    ] as ContentBlock[]));

    const framework = await createFramework('hybrid');
    const routed = stubChannelRegistry(framework, { home: false });
    opensChannels(framework);
    slowFirst(framework, 'deliverSpeech');

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Pinned words.', locus: 'chan-alpha' },
      { text: 'More for alpha.', locus: 'chan-alpha' },
      { text: 'After the open.', locus: 'discord:guild:observatory' },
    ], 'the open supersedes the pin for words written after it, and only those');

    await framework.stop();
  });

  it('hybrid: a channel_open that sets the speech route ends a `>>>skip_reply` suppression', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>skip_reply An aside to myself.' },
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'discord:guild:observatory' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Hello, observatory.' },
    ] as ContentBlock[]));

    const framework = await createFramework('hybrid');
    const routed = stubChannelRegistry(framework, { home: false });
    opensChannels(framework);

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Hello, observatory.', locus: 'discord:guild:observatory' }]);
    const results = JSON.stringify(membrane.lastStream!.receivedToolResults.flat());
    assert.ok(results.includes('Your unaddressed plain speech now goes to discord:guild:observatory'));

    await framework.stop();
  });

  it('hybrid: a channel_open with setSpeechTarget: false leaves a `>>>skip_reply` suppression in place', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>skip_reply An aside to myself.' },
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'discord:guild:observatory', setSpeechTarget: false } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Still private.' },
    ] as ContentBlock[]));

    const framework = await createFramework('hybrid');
    const routed = stubChannelRegistry(framework, { home: false });
    opensChannels(framework);

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, []);
    assert.deepEqual(heldDrafts(framework), [], 'kept private, not drafted');

    await framework.stop();
  });

  it('hybrid: a framework retry continues the turn, keeping its `>>>` choice and engagement', async () => {
    const pinnedRound = [
      { type: 'text', text: '>>>#alpha Pinned words.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[];
    class ToolThenErrorStream {
      private events: StreamEvent[] = [{
        type: 'tokens', content: '>>>#alpha Pinned words.', meta: { type: 'text', visible: true, blockIndex: 0 },
      } as StreamEvent, {
        type: 'tool-calls',
        calls: [{ id: 'c1', name: 'robot--move', input: { dir: 'north' } }],
        context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: pinnedRound },
      } as StreamEvent];
      private wake: (() => void) | null = null;
      private done = false;
      get isWaitingForTools() { return !this.done; }
      get pendingToolCallIds() { return this.done ? [] : ['c1']; }
      get toolDepth() { return 0; }
      provideToolResults(): void { this.done = true; this.events.push({ type: 'error', error: new Error('connection reset') } as StreamEvent); this.wake?.(); this.wake = null; }
      cancel(): void { this.done = true; this.wake?.(); this.wake = null; }
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        while (true) { while (this.events.length) yield this.events.shift()!; if (this.done) return; await new Promise<void>((r) => { this.wake = r; }); }
      }
    }
    let streams = 0;
    const retrying = {
      complete: async () => createMockResponse([{ type: 'text', text: 'unused' }] as ContentBlock[]),
      streamYielding: () => streams++ === 0
        ? new ToolThenErrorStream()
        : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'Unprefixed, after the retry.' }] as ContentBlock[])]),
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'retry.chronicle'),
      membrane: retrying as unknown as import('@animalabs/membrane').Membrane,
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.', proseRouting: 'hybrid' }],
      modules: [module],
      errorPolicy: { maxRetries: 1, onInferenceError: (_e: Error, _a: string, attempt: number) => ({ retry: attempt < 1, delayMs: 0 }) },
    });
    module.framework = framework;
    const routed = stubChannelRegistry(framework, { home: false });
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      engage(framework).noteSendEngagement('assistant', 'delivered', { serverId: 'srv', channelId: 'chan-T', threadId: 't1' });
      return origHandle(call);
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.equal(streams, 2, 'the failed stream was retried once');
    assert.deepEqual(routed, [
      { text: 'Pinned words.', locus: 'chan-alpha' },
      { text: 'Unprefixed, after the retry.', locus: 'chan-alpha' },
    ], 'the pin the failed attempt chose still carries unprefixed speech');
    assert.equal(engage(framework).engagementOf('assistant', { kind: 'channel', serverId: 'srv', channelId: 'chan-T', threadId: 't1' }), 'delivered',
      'the send the failed attempt made still counts');

    await framework.stop();
  });

  // ---- engagement by conversation (review finding 6) ----------------------

  it('a send whose place the host knows engages that thread only: ambient chatter in a sibling thread holds nothing', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Still answering chan-A.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    module.toolDelayMs = 25;
    module.interjection = 'unrelated chatter in another thread';
    module.interjectionMetadata = {
      channelId: 'chan-T', tags: ['chat:ambient', 'chat:from-human'], inboundSource: { ...envelope('chan-T'), threadId: 't2' },
    };
    const origHandle = module.handleToolCall.bind(module);
    module.handleToolCall = async (call) => {
      engage(framework).noteSendEngagement('assistant', 'delivered', { serverId: 'srv', channelId: 'chan-T', threadId: 't1' });
      return origHandle(call);
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Still answering chan-A.', locus: 'chan-A' }]);
    assert.deepEqual(heldDrafts(framework), []);

    await framework.stop();
  });

  it('engagement holds as certainly as the host knows it: there, maybe there, or somewhere in the channel', async () => {
    const cases: Array<{
      name: string;
      record: (f: AgentFramework) => void;
      arrivalThread: string;
      notice: string;
    }> = [
      {
        name: 'a delivered send, followed up in its own thread',
        record: (f) => engage(f).noteSendEngagement('assistant', 'delivered', { serverId: 'srv', channelId: 'chan-T', threadId: 't1' }),
        arrivalThread: 't1',
        notice: 'chan-T (thread t1), where you sent a message this turn, continued mid-turn',
      },
      {
        name: 'an unconfirmed send, followed up in its own thread',
        record: (f) => engage(f).noteSendEngagement('assistant', 'unknown', { serverId: 'srv', channelId: 'chan-T', threadId: 't1' }),
        arrivalThread: 't1',
        notice: 'chan-T (thread t1), where you tried to send a message this turn (its delivery wasn\'t confirmed), continued mid-turn',
      },
      {
        name: 'a connector send tool, whose place in the channel the host can\'t know',
        record: (f) => engage(f).noteChannelEngagement('assistant', 'srv', 'chan-T'),
        arrivalThread: 't2',
        notice: 'chan-T (thread t2) continued mid-turn, in a channel you sent something into this turn (where in the channel isn\'t known)',
      },
    ];
    for (const c of cases) {
      membrane = new MockMembrane();
      module = new RobotModule();
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Which conversation is this for?' },
      ] as ContentBlock[]));
      tempDir = mkdtempSync(join(tmpdir(), 'pwa-moment-'));
      const framework = await createFramework();
      const routed = stubChannelRegistry(framework, { home: false });
      module.toolDelayMs = 25;
      module.interjection = 'a follow-up';
      module.interjectionMetadata = {
        channelId: 'chan-T', tags: ['chat:ambient', 'chat:from-human'], inboundSource: { ...envelope('chan-T'), threadId: c.arrivalThread },
      };
      const origHandle = module.handleToolCall.bind(module);
      module.handleToolCall = async (call) => {
        c.record(framework);
        return origHandle(call);
      };

      triggerFromChannel(framework, 'chan-A');
      await framework.runUntilIdle();

      assert.deepEqual(routed, [], c.name);
      assert.deepEqual(heldDrafts(framework).map((d) => d.reason), ['ambiguous'], c.name);
      const wired = membrane.lastStream!.receivedToolResultOptions
        .map((o) => o?.injectedMessages ?? []).flat().map((m) => JSON.stringify(m.content));
      assert.ok(wired.some((t) => t.includes(`[routing] ${c.notice}`)), `${c.name}: ${wired.join(' | ')}`);
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('channel_publish engages the conversation its outcome names when delivered or unknown, and nothing when it fails', async () => {
    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    const dispatch = (framework as unknown as { dispatchChannelToolCall(agent: string, call: unknown): void });
    const outcomes: Array<[string, string, string | undefined]> = [
      ['delivered', 't1', 'delivered'],
      ['unknown', 't2', 'unknown'],
      ['failed', 't3', undefined],
    ];
    for (const [status, threadId, expected] of outcomes) {
      registryOf(framework).handleChannelToolCall = async () => ({
        success: status === 'delivered',
        data: { delivered: status === 'delivered', status, serverId: 'srv', channelId: 'chan-T', threadId },
      });
      dispatch.dispatchChannelToolCall('assistant', { id: `p-${status}`, name: 'channel_publish', input: { channelId: 'chan-T', threadId, content: 'hi' } });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(engage(framework).engagementOf('assistant', { kind: 'channel', serverId: 'srv', channelId: 'chan-T', threadId }), expected, status);
    }
    await framework.stop();
  });

  // ---- supplied selectors (review finding 5) ------------------------------

  it('channel_open refuses an invalid thread, server or setSpeechTarget before opening anything', async () => {
    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    let opened = 0;
    registryOf(framework).handleChannelToolCall = async () => { opened++; return { success: true, data: { channelId: 'chan-B' } }; };
    const results: Array<{ callId: string; result: { success: boolean; error?: string } }> = [];
    const f = framework as unknown as {
      dispatchChannelToolCall(agent: string, call: unknown): void;
      pushEvent(e: unknown): void;
    };
    const push = f.pushEvent.bind(framework);
    f.pushEvent = (e: unknown) => {
      const ev = e as { type?: string; callId?: string; result?: { success: boolean; error?: string } };
      if (ev.type === 'tool-result') results.push({ callId: ev.callId!, result: ev.result! });
      else push(e);
    };
    const invalid: Array<[Record<string, unknown>, RegExp]> = [
      [{ channelId: 'chan-B', threadId: '' }, /threadId must be a thread id/],
      [{ channelId: 'chan-B', threadId: 7 }, /threadId must be a thread id/],
      [{ channelId: 'chan-B', serverId: '' }, /serverId must name a server/],
      [{ channelId: 'chan-B', setSpeechTarget: 'false' }, /setSpeechTarget must be true or false/],
    ];
    for (const [i, [input, why]] of invalid.entries()) {
      f.dispatchChannelToolCall('assistant', { id: `o${i}`, name: 'channel_open', input });
    }
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(opened, 0, 'nothing was opened');
    assert.equal(results.length, invalid.length);
    for (const [i, [, why]] of invalid.entries()) {
      const r = results.find((x) => x.callId === `o${i}`)!;
      assert.equal(r.result.success, false);
      assert.match(r.result.error ?? '', why);
      assert.match(r.result.error ?? '', /Nothing was opened\./);
    }
    // null means "not in use", as for channel_publish's selectors.
    f.dispatchChannelToolCall('assistant', { id: 'ok', name: 'channel_open', input: { channelId: 'chan-B', threadId: null, serverId: null, setSpeechTarget: null } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(opened, 1);
    await framework.stop();
  });

  it('a conversation fork refuses a supplied but empty channelId instead of reading it as its home', async () => {
    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    (framework as unknown as { conversationAgentHomes: Map<string, string> }).conversationAgentHomes.set('assistant', 'chan-home');
    const handled: Array<{ name: string; input: Record<string, unknown> }> = [];
    registryOf(framework).handleChannelToolCall = async (name: string, input: Record<string, unknown>) => {
      handled.push({ name, input });
      return { success: true, data: {} };
    };
    const results: Array<{ callId: string; result: { success: boolean; error?: string } }> = [];
    const f = framework as unknown as { dispatchChannelToolCall(agent: string, call: unknown): void; pushEvent(e: unknown): void };
    const push = f.pushEvent.bind(framework);
    f.pushEvent = (e: unknown) => {
      const ev = e as { type?: string; callId?: string; result?: { success: boolean; error?: string } };
      if (ev.type === 'tool-result') results.push({ callId: ev.callId!, result: ev.result! });
      else push(e);
    };
    f.dispatchChannelToolCall('assistant', { id: 'empty', name: 'channel_publish', input: { channelId: '', content: 'hi' } });
    f.dispatchChannelToolCall('assistant', { id: 'number', name: 'channel_close', input: { channelId: 5 } });
    f.dispatchChannelToolCall('assistant', { id: 'null', name: 'channel_publish', input: { channelId: null, content: 'hi' } });
    f.dispatchChannelToolCall('assistant', { id: 'absent', name: 'channel_publish', input: { content: 'hi' } });
    await new Promise((r) => setTimeout(r, 5));
    assert.match(results.find((r) => r.callId === 'empty')!.result.error ?? '', /channelId must name a channel .*Nothing was sent\./);
    assert.match(results.find((r) => r.callId === 'number')!.result.error ?? '', /channelId must name a channel .*Nothing was closed\./);
    assert.deepEqual(handled.map((h) => [h.name, h.input.channelId]), [
      ['channel_publish', 'chan-home'],
      ['channel_publish', 'chan-home'],
    ], 'only an omitted (or null) channelId means the home');
    await framework.stop();
  });

  // ---- outgoing streams (review finding 1) --------------------------------

  it('a mid-turn hold stops the stream, and completion carries only what streamed', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Before the hold.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Held words.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    const streams = recordStreams(framework);
    addressedArrivalElsewhere();

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.equal(streams.streamedTo('chan-A'), 'Before the hold.');
    assert.ok(streams.chunks.every((c) => !c.delta.includes('Held')), JSON.stringify(streams.chunks));
    assert.deepEqual(streams.completes, [{ channelId: 'chan-A', text: 'Before the hold.', threadId: null }]);
    assert.deepEqual(heldDrafts(framework).map((d) => [d.text, d.reason]), [['Held words.', 'ambiguous']]);

    await framework.stop();
  });

  it('a thread placement is never streamed, held or not; root publication in the same channel streams alone', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Into the thread.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Held words.' },
    ] as ContentBlock[]));
    let framework = await createFramework();
    let routed = stubChannelRegistry(framework, { home: false });
    registryOf(framework).publishTarget = () => 'exact';
    let streams = recordStreams(framework);
    addressedArrivalElsewhere();
    triggerFromThread(framework, 'chan-A', 't1');
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'Into the thread.', locus: 'chan-A' }], 'published into the thread');
    assert.deepEqual(streams.chunks, [], 'the thread placement and the held words: nothing streams');
    assert.deepEqual(streams.completes, []);
    await framework.stop();

    // Hybrid: after the route moves on, a `>>>` envelope to that channel's
    // root is a root publication, and its stream names the root alone.
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), 'pwa-moment-'));
    membrane = new MockMembrane();
    module = new RobotModule();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Into the thread.' },
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'discord:guild:observatory' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>chan-A Root words for chan-A.' },
    ] as ContentBlock[]));
    framework = await createFramework('hybrid');
    routed = stubChannelRegistry(framework, { home: false });
    registryOf(framework).publishTarget = () => 'exact';
    opensChannels(framework);
    streams = recordStreams(framework);
    triggerFromThread(framework, 'chan-A', 't1');
    await framework.runUntilIdle();
    assert.equal(streams.streamedTo('chan-A'), 'Root words for chan-A.');
    assert.deepEqual(streams.completes, [{ channelId: 'chan-A', text: 'Root words for chan-A.', threadId: null }]);
    await framework.stop();
  });

  it('a stream follows the route when channel_open moves it, and each channel completes with its own words', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'To A.' },
      { type: 'tool_use', id: 'c1', name: 'channel_open', input: { channelId: 'chan-B' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'To B.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    opensChannels(framework);
    const streams = recordStreams(framework);

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'To A.', locus: 'chan-A' }, { text: 'To B.', locus: 'chan-B' }]);
    assert.equal(streams.streamedTo('chan-A'), 'To A.');
    assert.equal(streams.streamedTo('chan-B'), 'To B.');
    assert.deepEqual(streams.completes.map((c) => [c.channelId, c.text]).sort(), [['chan-A', 'To A.'], ['chan-B', 'To B.']]);

    await framework.stop();
  });

  it('held words never resurface in a stream: a hold, then a channel_open, then speech', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Before the hold.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Held words.' },
      { type: 'tool_use', id: 'c2', name: 'channel_open', input: { channelId: 'chan-B' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'After the open.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    opensChannels(framework);
    const streams = recordStreams(framework);
    addressedArrivalElsewhere();

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Before the hold.', locus: 'chan-A' }, { text: 'After the open.', locus: 'chan-B' }]);
    assert.equal(streams.streamedTo('chan-A'), 'Before the hold.');
    assert.equal(streams.streamedTo('chan-B'), 'After the open.');
    assert.deepEqual(streams.completes.map((c) => [c.channelId, c.text]).sort(), [['chan-A', 'Before the hold.'], ['chan-B', 'After the open.']]);

    await framework.stop();
  });

  it('each round is its own segment: a later round\'s prefix names its own destination, and a later skip_reply streams nothing', async () => {
    // Mira-1782's probe: the router stayed in `body` across provider rounds,
    // so round 2's `>>>#beta` streamed into #alpha as text.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#alpha First.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#beta Second.' },
      { type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'south' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>skip_reply Private words.' },
    ] as ContentBlock[]));

    const framework = await createFramework('hybrid');
    const routed = stubChannelRegistry(framework, { home: false });
    const streams = recordStreams(framework);

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'First.', locus: 'chan-alpha' }, { text: 'Second.', locus: 'chan-beta' }]);
    assert.equal(streams.streamedTo('chan-alpha'), 'First.');
    assert.equal(streams.streamedTo('chan-beta'), 'Second.');
    assert.ok(streams.chunks.every((c) => !c.delta.includes('>>>') && !c.delta.includes('Private')), JSON.stringify(streams.chunks));

    await framework.stop();
  });

  it('an envelope delivery couldn\'t make streams nothing, nor do the words held after it; a newer prefix\'s publication does', async () => {
    // Mira-1782's probe: delivery held the words after a failed `>>>#alpha`
    // as drafts, while the stream kept carrying them to #alpha.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#alpha First.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Later words.' },
    ] as ContentBlock[]));
    let framework = await createFramework('hybrid');
    stubChannelRegistry(framework, { home: false });
    // One bounce, and no bounce-wake turn after it.
    (framework as unknown as { proseBounceStreaks: Map<string, number> }).proseBounceStreaks.set('assistant', 100);
    registryOf(framework).deliverSpeech = async () => ({ status: 'failed', reason: 'refused', at: Date.now() });
    module.toolDelayMs = 50; // the failure is known before round 2 is written
    let streams = recordStreams(framework);
    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();
    assert.ok(heldDrafts(framework).some((d) => d.text === 'Later words.' && d.reason === 'no-destination'));
    assert.equal(streams.streamedTo('chan-alpha'), '', 'only confirmed publication streams');
    await framework.stop();

    // A newer prefix, parsed before the older envelope's failure is known, stands.
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), 'pwa-moment-'));
    membrane = new MockMembrane();
    module = new RobotModule();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#alpha First.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#beta Second.' },
      { type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'south' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'More for beta.' },
    ] as ContentBlock[]));
    framework = await createFramework('hybrid');
    const routed = stubChannelRegistry(framework, { home: false });
    (framework as unknown as { proseBounceStreaks: Map<string, number> }).proseBounceStreaks.set('assistant', 100);
    const registry = registryOf(framework);
    // routeSpeech's outcome names the resolved server, as the real registry's
    // does, so the envelope's publish (deliverSpeech) and the route's
    // (routeSpeech) are one stream entry on chan-beta.
    const route = registry.routeSpeech as (...args: unknown[]) => Promise<Record<string, unknown> | null>;
    registry.routeSpeech = async (...args: unknown[]) => {
      const outcome = await route(...args);
      return outcome ? { ...outcome, serverId: 'stub' } : outcome;
    };
    const deliver = registry.deliverSpeech as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    registry.deliverSpeech = async (...args: unknown[]) => {
      if (calls++ === 0) {
        await new Promise((r) => setTimeout(r, 100));
        return { status: 'failed', reason: 'refused', at: Date.now() };
      }
      return deliver(...args);
    };
    streams = recordStreams(framework);
    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'Second.', locus: 'chan-beta' }, { text: 'More for beta.', locus: 'chan-beta' }]);
    assert.equal(streams.streamedTo('chan-beta'), 'Second.\n\nMore for beta.');
    assert.deepEqual(streams.completes.filter((c) => c.channelId === 'chan-beta'),
      [{ channelId: 'chan-beta', text: 'Second.\n\nMore for beta.', threadId: null }],
      'one stream entry, one completion, for the envelope and the route alike');
    await framework.stop();
  });

  it('a send-silenced turn streams nothing of the later rounds it holds back', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Sending it now.' },
      { type: 'tool_use', id: 'c1', name: 'robot--send_message', input: { text: 'the note' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Postscript: sent it.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    const streams = recordStreams(framework);

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, []);
    assert.deepEqual(heldDrafts(framework).map((d) => d.reason), ['explicit-send', 'explicit-send']);
    // Neither round was published, so neither streams — not even the words
    // written before the round's own send made them held.
    assert.deepEqual(streams.chunks, []);

    await framework.stop();
  });

  it('a private-think round neither streams nor pins later speech', async () => {
    // Mira-1782's probe: a later call in the same round (a private `think`)
    // made words private that a speculative stream had already carried.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#alpha Private words.' },
      { type: 'tool_use', id: 'think-1', name: 'think', input: { content: 'private reasoning' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Public words.' },
    ] as ContentBlock[]));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'private-think.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test', proseRouting: 'hybrid', sameRoundThinkTextPolicy: 'private' }],
      modules: [module],
    });
    module.framework = framework;
    const routed = stubChannelRegistry(framework, { home: false });
    registryOf(framework).getChannelTools = () => [{ name: 'think', description: 'private reasoning', inputSchema: { type: 'object', properties: {} } }];
    registryOf(framework).handleChannelToolCall = async () => ({ success: true, data: { noted: true } });
    const streams = recordStreams(framework);

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Public words.', locus: 'chan-A' }]);
    assert.equal(streams.streamedTo('chan-alpha'), '');
    assert.equal(streams.streamedTo('chan-A'), 'Public words.');

    await framework.stop();
  });

  it('completion follows the stream\'s last speech, under the inference that wrote it', async () => {
    // A trailing reply is published after the agent is idle: its chunk and
    // the completion still come in that order, with one inference id.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Narrating.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Done.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    slowFirst(framework, 'routeSpeech', 40);
    const events: Array<[string, string, string]> = [];
    const registry = registryOf(framework);
    registry.sendOutgoingChunk = (d: { channelId: string }, _c: string, inferenceId: string, _n: number, delta: string) => {
      events.push(['chunk', inferenceId, delta]);
      return true;
    };
    registry.sendOutgoingComplete = (d: { channelId: string }, _c: string, inferenceId: string, text: string) => {
      events.push(['complete', inferenceId, text]);
    };

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();
    await new Promise((r) => setTimeout(r, 80));

    assert.deepEqual(events.map(([kind, , text]) => [kind, text]), [
      ['chunk', 'Narrating.'],
      ['chunk', '\n\nDone.'],
      ['complete', 'Narrating.\n\nDone.'],
    ]);
    assert.equal(new Set(events.map(([, id]) => id)).size, 1, 'one physical stream, one inference');

    await framework.stop();
  });

  it('each later message on a channel opens a paragraph in its stream, and the completion is the deltas joined', async () => {
    // Two rounds publish two messages to chan-A. A voice consumer speaks the
    // deltas as they come (discord-mcpl's voice output appends them into one
    // utterance), so they must not run "Let me look.Found it." together.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Found it.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubChannelRegistry(framework, { home: false });
    const streams = recordStreams(framework);

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Let me look.', locus: 'chan-A' }, { text: 'Found it.', locus: 'chan-A' }],
      'each message is published as written, with no separator');
    assert.deepEqual(streams.chunks.map((c) => c.delta), ['Let me look.', '\n\nFound it.']);
    assert.deepEqual(streams.completes, [{ channelId: 'chan-A', text: 'Let me look.\n\nFound it.', threadId: null }]);
    assert.equal(streams.completes[0]!.text, streams.streamedTo('chan-A'), 'the completion is exactly the deltas, concatenated');

    await framework.stop();
  });

  it('an aborted stream still completes what its published speech streamed', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Narrating.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Never written.' },
    ] as ContentBlock[]));
    module.toolDelayMs = 300;

    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    const streams = recordStreams(framework);
    // The abort doesn't stop robot--move: the test owns that call, and waits
    // for it after stop() (its late result meets the stopped framework).
    const handle = module.handleToolCall.bind(module);
    let toolSettled: Promise<unknown> = Promise.resolve();
    module.handleToolCall = (call) => {
      const running = handle(call);
      toolSettled = running.catch(() => undefined);
      return running;
    };

    triggerFromChannel(framework, 'chan-A');
    const idle = framework.runUntilIdle();
    const deadline = Date.now() + 2000;
    while (streams.chunks.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.ok(streams.chunks.length > 0, 'the narration was published and streamed');
    assert.ok(framework.abortInference('assistant', 'test abort'), 'the turn was still running');
    await idle;
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(streams.streamedTo('chan-A'), 'Narrating.');
    assert.deepEqual(streams.completes, [{ channelId: 'chan-A', text: 'Narrating.', threadId: null }]);

    await framework.stop();
    await toolSettled;
    await new Promise((r) => setImmediate(r));
  });

  it('completion never replays a chunk the registry refused to stream', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Refused.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Streamed.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubChannelRegistry(framework, { home: false });
    // As when the channel's declaration or streaming grant is briefly absent.
    const streams = recordStreams(framework, (_channelId, delta) => delta.startsWith('Refused'));

    triggerFromChannel(framework, 'chan-A');
    await framework.runUntilIdle();

    assert.equal(streams.streamedTo('chan-A'), 'Streamed.');
    assert.deepEqual(streams.completes, [{ channelId: 'chan-A', text: 'Streamed.', threadId: null }]);

    await framework.stop();
  });
});
