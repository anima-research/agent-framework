/**
 * Deferred-message / wake integrity (2026-07-31 Mythos "phantom skip").
 *
 * The incident: a DM arrived while a turn was streaming → the message body
 * was deferred (hear-while-acting) but its inference wake was pushed
 * immediately. The wake fired a new turn whose compile ran BEFORE the
 * previous turn's finally flushed the deferred DM; the new turn saw only the
 * routing-shift notice, reasonably skipped, and the DM then landed in the
 * window mid-compile — positioned before the skip. Result: falsified history
 * (the window testified the agent saw the DM and skipped it; the agent later
 * confabulated an apology for a choice it never made) and a KV bust (every
 * later compile diverged from the live prefix at the inserted message).
 *
 * Invariants under test:
 *  1. A turn started by a queued wake CONTAINS the deferred message that woke
 *     it (turn-start flush runs before the locus announcement and compile).
 *  2. addMessage defers on turn-alive (activeTurnTokens), not merely
 *     stream-alive — the compile window between dequeue and stream
 *     registration is closed to cross-turn writers.
 *  3. endTurn edge: a message stored at an endTurn tool boundary (collected
 *     for injection but never delivered — the stream is cancelled) is seen by
 *     the follow-up turn its own wake starts, positioned AFTER the turn that
 *     never saw it, never before.
 *  4. Turn tokens never leak: after runUntilIdle, no turn-alive markers
 *     remain (a leaked token would permanently requeue every wake — the
 *     'idle+turn-alive' wedge).
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
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';

// ---------------------------------------------------------------------------
// Test module: a halt tool that ends the turn, and mid-turn interjections
// that DO request inference (unlike present-while-acting's, which don't) —
// this suite is about the wake/payload split, so the wake matters.
// ---------------------------------------------------------------------------

class DmModule implements Module {
  readonly name = 'dm';
  framework: AgentFramework | null = null;
  /** Next `halt` call pushes this text as an external message (with
   *  requestInference) BEFORE returning its endTurn result. */
  interjection: string | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'halt',
        description: 'End the turn',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name.endsWith('halt')) {
      if (this.interjection) {
        const text = this.interjection;
        this.interjection = null;
        this.framework!.pushEvent({
          type: 'external-message',
          source: 'test',
          content: text,
          metadata: { channelId: 'dm-antra' },
        } as unknown as ProcessEvent);
        // Let the run loop process the queued message while this tool round
        // is still pending, so it lands in deferredMessages with its wake
        // queued behind the busy agent.
        await new Promise((r) => setTimeout(r, 30));
      }
      return { success: true, data: { halted: true }, endTurn: true };
    }
    return { success: true, data: { ok: true } };
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
            ...(metadata ? { metadata: { ...metadata, triggered: true } } : {}),
          },
        ],
        requestInference: true,
      };
    }
    return {};
  }
}

/** Minimal ChannelRegistry stub (same shape as present-while-acting's). */
function stubChannelRegistry(framework: AgentFramework) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const explicit: Record<string, unknown> = {
    resolveLocus: () => 'dm-antra',
    routeSpeech: async (_agent: string, text: string, locus?: string | null) => {
      routed.push({ text, locus: locus ?? null });
    },
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

/** Serialize a request's messages for containment/ordering checks. */
function flatten(req: NormalizedRequest): string[] {
  return (req.messages as Array<{ role?: string; participant?: string; content: unknown }>).map(
    (m) => JSON.stringify(m),
  );
}
function indexContaining(flat: string[], needle: string): number {
  return flat.findIndex((s) => s.includes(needle));
}

/** Per-turn response scheduling: MockMembrane's streamYielding hands ALL
 *  remaining responses to the first stream, which starves multi-turn tests.
 *  This override gives each turn exactly its own slate. */
function scheduleTurns(membrane: MockMembrane, turns: NormalizedResponse[][]): void {
  let turnIdx = 0;
  (membrane as unknown as { streamYielding: (req: NormalizedRequest) => MockYieldingStream }).streamYielding = (
    req: NormalizedRequest,
  ) => {
    membrane.calls.push(req);
    const slate = turns[turnIdx++] ?? [createMockResponse([{ type: 'text', text: 'fallback' }] as ContentBlock[])];
    const stream = new MockYieldingStream(slate);
    membrane.lastStream = stream;
    return stream;
  };
}

// ---------------------------------------------------------------------------

describe('deferred-message wake integrity', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: DmModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dwi-test-'));
    membrane = new MockMembrane();
    module = new DmModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'assistant', model: 'test-model', systemPrompt: 'You are Mythos.' },
      ],
      modules: [module],
    });
    module.framework = framework;
    return framework;
  }

  type Internals = {
    deferredMessages: Array<{ participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>;
    pendingRequests: Array<Record<string, unknown>>;
    activeTurnTokens: Map<string, number>;
    activeStreams: Map<string, unknown>;
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>) => string;
  };
  const internals = (f: AgentFramework) => f as unknown as Internals;

  // -------------------------------------------------------------------------

  it('a turn started by a queued wake contains the deferred message that woke it', async () => {
    scheduleTurns(membrane, [
      [createMockResponse([{ type: 'text', text: 'answering the DM' }] as ContentBlock[])],
    ]);
    const framework = await createFramework();
    stubChannelRegistry(framework);
    const fw = internals(framework);

    // The incident state, seeded directly: payload deferred, wake queued,
    // agent idle. (Live, this arises when a message lands during another
    // turn's stream: addMessage defers the body, the wake pushes anyway.)
    const dmText = 'and then the restaurant, and the hike — the deferred DM';
    fw.deferredMessages.push({
      participant: 'Antra',
      content: [{ type: 'text', text: dmText }],
      metadata: { channelId: 'dm-antra', triggered: true },
    });
    fw.pendingRequests.push({
      agentName: 'assistant',
      reason: 'mcpl:channel-incoming',
      source: 'test',
      timestamp: Date.now(),
      channelId: 'dm-antra',
      addressed: true,
    });

    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1, 'the wake fired exactly one turn');
    const flat = flatten(membrane.calls[0]);
    assert.ok(
      indexContaining(flat, dmText) >= 0,
      'the compiled request contains the message that woke the turn (turn-start flush)',
    );
    assert.equal(fw.deferredMessages.length, 0, 'deferred queue drained');
    assert.equal(fw.activeTurnTokens.size, 0, 'no turn token leaked');

    await framework.stop();
  });

  it('addMessage defers on turn-alive even when no stream is registered (compile window)', async () => {
    const framework = await createFramework();
    stubChannelRegistry(framework);
    const fw = internals(framework);

    // Simulate the dequeue→stream gap: a turn is alive (token set) but its
    // stream has not registered yet. This is exactly when the incident's
    // deferred flush wrote into the window mid-compile.
    fw.activeTurnTokens.set('assistant', 999999);
    assert.equal(fw.activeStreams.size, 0, 'precondition: no live stream');

    const id = fw.addMessage('Antra', [{ type: 'text', text: 'arrives mid-compile' }]);
    assert.equal(id, '', 'message was deferred, not appended');
    assert.equal(fw.deferredMessages.length, 1, 'message waits in the deferred queue');

    fw.activeTurnTokens.delete('assistant');
    fw.deferredMessages.length = 0; // don't leak state into stop()

    await framework.stop();
  });

  it('endTurn edge: a message stored at an endTurn boundary is answered by its own wake, positioned after the turn that never saw it', async () => {
    scheduleTurns(membrane, [
      // Turn A: the agent is mid-scene and halts (skip_reply-shaped: an
      // endTurn tool result cancels the stream — collected injections are
      // never delivered).
      [createMockResponse(
        [{ type: 'tool_use', id: 'c1', name: 'dm--halt', input: {} }] as ContentBlock[],
        'tool_use',
      )],
      // Turn B: the DM's own wake.
      [createMockResponse([{ type: 'text', text: 'answering antra now' }] as ContentBlock[])],
    ]);
    const framework = await createFramework();
    stubChannelRegistry(framework);
    const fw = internals(framework);

    const dmText = 'laria read me your messages aloud on the trail';
    module.interjection = dmText;

    // Start turn A.
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: {},
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 2, 'turn A (go → halt) and the DM-wake turn B ran');

    // Turn B contains the DM.
    const flatB = flatten(membrane.calls[1]);
    const dmIdx = indexContaining(flatB, dmText);
    assert.ok(dmIdx >= 0, "turn B's request contains the DM");

    // History integrity: in turn B's request the DM appears AFTER turn A's
    // halt (the turn that never saw it) — never retroactively before it.
    const haltIdx = indexContaining(flatB, 'dm--halt');
    assert.ok(haltIdx >= 0, "turn A's halt is in turn B's history");
    assert.ok(
      dmIdx > haltIdx,
      `DM (idx ${dmIdx}) must be positioned after the halt (idx ${haltIdx}) — ` +
      'a DM placed before it would testify the agent saw and skipped it',
    );

    // And turn A itself must NOT contain the DM (it arrived mid-turn and was
    // never injected — the endTurn cancelled the stream before delivery).
    const flatA = flatten(membrane.calls[0]);
    assert.equal(indexContaining(flatA, dmText), -1, "turn A's request predates the DM");

    assert.equal(fw.activeTurnTokens.size, 0, 'no turn token leaked across the sequence');
    assert.equal(fw.deferredMessages.length, 0, 'no message stranded in the deferred queue');

    await framework.stop();
  });

  it('a throw before the compile (checkpoint/store failure) does not leak the turn token', async () => {
    // ENOSPC-class failure: recordTurnCheckpoint (a store write) throws after
    // the token is set but before driveStream exists. Without the caller's
    // token-matched finally, the token leaks and every later wake requeues
    // forever (the 'idle+turn-alive' wedge) — a one-turn failure must stay a
    // one-turn failure.
    scheduleTurns(membrane, [
      [createMockResponse([{ type: 'text', text: 'recovered turn' }] as ContentBlock[])],
    ]);
    const framework = await createFramework();
    stubChannelRegistry(framework);
    const fw = internals(framework);
    type Patchable = { recordTurnCheckpoint: (agentName: string) => void };
    const patchable = framework as unknown as Patchable;

    const original = patchable.recordTurnCheckpoint.bind(framework);
    patchable.recordTurnCheckpoint = () => {
      patchable.recordTurnCheckpoint = original; // one-shot
      throw new Error('ENOSPC: simulated store-write failure');
    };

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: {},
    } as unknown as ProcessEvent);
    // The throw propagates out of the event loop iteration (runUntilIdle
    // surfaces it in this harness; production runLoop logs and continues).
    await assert.rejects(framework.runUntilIdle(), /ENOSPC/);

    assert.equal(fw.activeTurnTokens.size, 0, 'the failed turn cleared its own token');

    // The agent is not wedged: a fresh wake still runs to completion.
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go again',
      metadata: {},
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'the follow-up wake produced a turn');
    assert.equal(fw.activeTurnTokens.size, 0, 'no token leaked after recovery either');

    await framework.stop();
  });

  it('turn tokens are released on normal completion (no idle+turn-alive wedge)', async () => {
    scheduleTurns(membrane, [
      [createMockResponse([{ type: 'text', text: 'plain turn' }] as ContentBlock[])],
    ]);
    const framework = await createFramework();
    stubChannelRegistry(framework);
    const fw = internals(framework);

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: {},
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(fw.activeTurnTokens.size, 0, 'token cleared at teardown');

    // A fresh wake still runs (the agent is not wedged).
    scheduleTurns(membrane, [
      [createMockResponse([{ type: 'text', text: 'second turn' }] as ContentBlock[])],
    ]);
    const callsBefore = membrane.calls.length;
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go again',
      metadata: {},
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, callsBefore + 1, 'agent takes the next turn');

    await framework.stop();
  });
});
