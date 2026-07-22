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
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

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
