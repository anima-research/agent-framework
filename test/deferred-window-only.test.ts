/**
 * What the window stores mid-turn is what the live stream carried.
 *
 * A message deferred during a turn's start, until its coalescing assembly
 * ends, is stored before the turn's checkpoint, in that request, as the
 * turn-start flush stores what came before. One deferred after that is
 * stored at the agent's next tool
 * boundary and injected into the resumed stream (hear-while-acting), so the
 * next compile's prefix is the request the turn's later replies were minted
 * under. Two kinds of message can't be injected: one carrying tool blocks
 * (it would break the tool cycle membrane enforces) and one named as the
 * agent itself (a prefill). Those wait for the turn's end, and so does
 * everything queued behind them, so the queue's order holds. A message a
 * tune-out holds from the residents is stored at the boundary and not
 * injected, since the next compile leaves it out too
 * (module-rows-held-from-residents). A provider that binds signed thinking
 * to its prefix (context-manager #155) refuses a later request that replays
 * the signed thinking of a reply whose stored prefix holds a message its
 * request didn't. A write that threw after it was
 * stored, whose landing couldn't be read back, is looked up by its id at
 * the boundary that wrote it, and carried there. One that couldn't be looked
 * up either is the exception, a known limit: the flush that finds it later
 * counts it where it was stored, ahead of what the turn stored since without
 * it. On an account where the provider enforces that binding, a later
 * request replaying the signed thinking of a reply stored after it, whose
 * request didn't carry it, is refused with a 400 (context-manager #155).
 *
 * A message a stream declares it carried has been read: RFC-006's consumed
 * watermark covers it, so a coalesced replacement can no longer remove it.
 * Only a stream that declares it carries injected messages (membrane's native
 * path) gets them. One that declares it can't (membrane's XML prefill path)
 * gets none, and neither does one that doesn't say: what is queued waits for
 * the turn's end.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
import { destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
import { heldHandle } from '../src/held-writes.js';
import { AutobiographicalStrategy, MalformedContentError } from '@animalabs/context-manager';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

/** A channel on the server these tests' channel messages come from, as each channel message's metadata names it. */
const srv = (channelId: string): ChannelRef => ({ serverId: 'srv', channelId });

interface Interjection {
  participant: string;
  content: ContentBlock[];
}

/** Tools that deliver messages while they run, the way a module or a channel
 *  would while the agent is busy: `move` continues the turn, `halt` ends it. */
class InterjectingModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  /** Delivered, in order, by the next tool call before it returns. */
  interjections: Interjection[] = [];
  /** Run inside the next tool call, after the interjections are delivered. */
  duringTool: (() => void) | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      { name: 'move', description: 'Move', inputSchema: { type: 'object', properties: {} } },
      { name: 'halt', description: 'End the turn', inputSchema: { type: 'object', properties: {} } },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const pending = this.interjections;
    this.interjections = [];
    for (const interjection of pending) {
      this.framework!.pushEvent({ type: 'interjection', source: 'test', interjection } as unknown as ProcessEvent);
    }
    // Let the run loop handle them while this round's tools are pending, and
    // return only once each is in the deferred queue, so the tool-result
    // boundary meets them there (bounded: a run that never queues them fails).
    if (pending.length > 0) {
      const queue = () => (this.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length;
      const end = Date.now() + 5000;
      while (queue() < pending.length) {
        if (Date.now() > end) throw new Error(`only ${queue()} of ${pending.length} interjection(s) were queued`);
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const during = this.duringTool;
    this.duringTool = null;
    during?.();
    return call.name.endsWith('halt')
      ? { success: true, data: { halted: true }, endTurn: true }
      : { success: true, data: { ok: true } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'Antra', content: [{ type: 'text', text: 'go' }] }],
        requestInference: true,
      };
    }
    if ((event as { type: string }).type === 'interjection') {
      const { participant, content } = (event as unknown as { interjection: Interjection }).interjection;
      // No wake: this suite is about where the message lands in this turn.
      return { addMessages: [{ participant, content }] };
    }
    return {};
  }
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

/** Make the framework's stores unsearchable by a deferred write's id while
 *  context-manager's query throws: its blob-free scan, which stands in
 *  when that query throws (landedPositions), throws too. Returns the undo. */
function noScan(framework: AgentFramework): () => void {
  const self = framework as unknown as { landedPositions?: unknown };
  self.landedPositions = () => { throw new Error('scan failed'); };
  return () => { delete self.landedPositions; };
}

/** One line per stored message: participant, then its text or block types. */
function windowOf(framework: AgentFramework): string[] {
  return framework.getAgent('assistant')!.getContextManager().getAllMessages().map((m) => {
    const parts = m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`));
    return `${m.participant}: ${parts.join(' ')}`;
  });
}

describe('mid-turn deliveries keep the window what the stream carried', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: InterjectingModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dwo-test-'));
    membrane = new MockMembrane();
    module = new InterjectingModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(extra: Partial<Parameters<typeof AgentFramework.create>[0]> = {}): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.' }],
      modules: [module],
      ...extra,
    });
    module.framework = framework;
    return framework;
  }

  /** A turn of two rounds: `tool` with the interjections, then a reply. */
  let drains: Array<{ atBoundary: boolean; queued: string[] }> = [];
  async function runTurn(tool: 'move' | 'halt', interjections: Interjection[]): Promise<AgentFramework> {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: `robot--${tool}`, input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    drains = recordDrains(framework);
    module.interjections = interjections;
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    return framework;
  }

  /** What the tool boundary's drain found queued. */
  const atBoundary = () => drains.find((d) => d.atBoundary)?.queued;

  /** What each drain for the agent found queued, in order, and whether it
   *  stopped at a held message (the tool boundary's drain does). */
  function recordDrains(framework: AgentFramework): Array<{ atBoundary: boolean; queued: string[] }> {
    const drains: Array<{ atBoundary: boolean; queued: string[] }> = [];
    const internals = framework as unknown as {
      deferredMessages: Array<{ participant: string; content: ContentBlock[] }>;
      drainDeferredFor: (name: string, stopAt?: unknown) => unknown[];
    };
    const drain = internals.drainDeferredFor.bind(framework);
    internals.drainDeferredFor = (name: string, stopAt?: unknown) => {
      if (name === 'assistant' && internals.deferredMessages.length > 0) {
        drains.push({
          atBoundary: stopAt !== undefined,
          queued: internals.deferredMessages.map((m) => `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`),
        });
      }
      return drain(name, stopAt);
    };
    return drains;
  }

  function injected(): string[] {
    const options = membrane.lastStream!.receivedToolResultOptions[0];
    return (options?.injectedMessages ?? []).map((m) =>
      `${m.participant}: ${(m.content as Array<{ text?: string }>).map((b) => b.text).join(' ')}`);
  }

  it('a message named as the agent waits for the turn to end, after its last round', async () => {
    const framework = await runTurn('move', [{ participant: 'assistant', content: text('my own words') }]);
    assert.deepEqual(atBoundary(), ['assistant: my own words'], 'it was queued when the boundary drained');
    assert.deepEqual(injected(), []);
    assert.deepEqual(windowOf(framework), [
      'Antra: go',
      'assistant: Moving. <tool_use>',
      'user: <tool_result>',
      'assistant: Done.',
      'assistant: my own words',
    ]);
    await framework.stop();
  });

  it('a message carrying tool blocks waits too', async () => {
    const framework = await runTurn('move', [{
      participant: 'Antra',
      content: [{ type: 'tool_use', id: 'x1', name: 'robot--move', input: {} } as ContentBlock],
    }]);
    assert.deepEqual(injected(), []);
    assert.deepEqual(windowOf(framework).slice(2), ['user: <tool_result>', 'assistant: Done.', 'Antra: <tool_use>']);
    await framework.stop();
  });

  it('what is queued behind a held message waits with it, in order', async () => {
    const framework = await runTurn('move', [
      { participant: 'assistant', content: text('my own words') },
      { participant: 'Antra', content: text('look left') },
    ]);
    assert.deepEqual(atBoundary(), ['assistant: my own words', 'Antra: look left'], 'both were queued when the boundary drained');
    assert.deepEqual(injected(), []);
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'assistant: Done.',
      'assistant: my own words',
      'Antra: look left',
    ]);
    await framework.stop();
  });

  it('what is queued before a held message is still heard at the boundary', async () => {
    const framework = await runTurn('move', [
      { participant: 'Antra', content: text('look left') },
      { participant: 'assistant', content: text('my own words') },
    ]);
    assert.deepEqual(atBoundary(), ['Antra: look left', 'assistant: my own words'], 'both were queued when the boundary drained');
    assert.deepEqual(injected(), ['Antra: look left']);
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'Antra: look left',
      'assistant: Done.',
      'assistant: my own words',
    ]);
    await framework.stop();
  });

  /** Whether the stored message with this text reads as unread (RFC-006). */
  function unread(framework: AgentFramework, textOf: string): boolean {
    const agent = framework.getAgent('assistant')!;
    const stored = agent.getContextManager().getAllMessages()
      .find((m) => m.content.some((b) => (b as { text?: string }).text === textOf))!;
    assert.ok(stored, `'${textOf}' is stored`);
    return (framework as unknown as {
      isUnreadStoredMessage: (a: typeof agent, id: string) => boolean;
    }).isUnreadStoredMessage.call(framework, agent, stored.id);
  }

  it('a message injected into a stream that declares it carries injections is read: the consumed watermark covers it', async () => {
    membrane.supportsInjectedMessages = true; // membrane's native path declares it, from 0.6.0
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.deepEqual(injected(), ['Antra: look left']);
    assert.equal(unread(framework, 'look left'), false, 'a coalesced replacement must not remove what the agent heard');
    await framework.stop();
  });

  it('a stream that can\'t carry injections gets none: what is queued waits for the turn to end', async () => {
    membrane.supportsInjectedMessages = false; // membrane's XML prefill path declares it, from 0.6.0
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.deepEqual(atBoundary(), undefined, 'the boundary drained nothing');
    assert.equal(membrane.lastStream!.receivedToolResultOptions[0], undefined, 'nothing was injected');
    assert.deepEqual(windowOf(framework).slice(2), ['user: <tool_result>', 'assistant: Done.', 'Antra: look left']);
    assert.equal(unread(framework, 'look left'), true);
    await framework.stop();
  });

  it('a stream that doesn\'t say whether it carries injections is taken as one that can\'t: what is queued waits for the turn to end', async () => {
    membrane.supportsInjectedMessages = 'undeclared';
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.deepEqual(atBoundary(), undefined, 'the boundary drained nothing');
    assert.equal(membrane.lastStream!.receivedToolResultOptions[0], undefined, 'nothing was injected');
    assert.deepEqual(windowOf(framework).slice(2), ['user: <tool_result>', 'assistant: Done.', 'Antra: look left']);
    assert.equal(unread(framework, 'look left'), true);
    await framework.stop();
  });

  it("a boundary with no stream, the direct API's, stores what was queued for the agent there", async () => {
    let writer!: ModuleContext;
    const response = createMockResponse([{ type: 'tool_use', id: 'direct-1', name: 'robot--halt', input: {} }] as ContentBlock[], 'tool_use');
    (membrane as unknown as { stream: () => Promise<typeof response> }).stream = async () => response;
    const framework = await createFramework({
      modules: [module, {
        name: 'writer', async start(ctx: ModuleContext) { writer = ctx; }, async stop() {}, getTools: () => [],
        async handleToolCall() { return { success: true }; }, async onProcess() { return {}; },
      } as Module],
    });
    try {
      const agent = framework.getAgent('assistant')!;
      agent.getContextManager().addMessage('user', text('take the direct path'));
      await agent.runInference(framework.getAllTools());
      assert.equal(agent.state.status, 'waiting_for_tools');
      await framework.quiesce({ timeoutMs: 1_000 });
      writer.addMessage('Antra', text('look left'));
      assert.ok(!windowOf(framework).includes('Antra: look left'), 'queued while the host is quiesced');
      await (framework as unknown as { handleProcessEvent(e: unknown): Promise<void> }).handleProcessEvent({
        type: 'tool-result', source: 'robot', moduleName: 'robot', agentName: 'assistant', callId: 'direct-1',
        result: { success: true, data: { halted: true }, endTurn: true },
      });
      assert.deepEqual(windowOf(framework).slice(-2), ['user: <tool_result>', 'Antra: look left'], 'stored at the boundary, after the results');
      assert.equal(unread(framework, 'look left'), true, 'never carried to the model, so it stays unread');
    } finally {
      await framework.resume().catch(() => {});
      await framework.stop();
    }
  });

  it('a message stored at a boundary that ends the turn was never carried, and stays unread', async () => {
    const framework = await runTurn('halt', [{ participant: 'Antra', content: text('too late') }]);
    const agent = framework.getAgent('assistant')!;
    const late = agent.getContextManager().getAllMessages()
      .find((m) => m.content.some((b) => (b as { text?: string }).text === 'too late'))!;
    const isUnread = (framework as unknown as {
      isUnreadStoredMessage: (a: typeof agent, id: string) => boolean;
    }).isUnreadStoredMessage.bind(framework);
    assert.equal(isUnread(agent, late.id), true);
    await framework.stop();
  });

  /** The framework's own queue and its record of turns and tool cycles. */
  function internalsOf(framework: AgentFramework) {
    return framework as unknown as {
      pendingAssistantBlocks: Map<string, ContentBlock[]>;
      activeTurnTokens: Map<string, number>;
      activeStreams: Map<string, unknown>;
      deferredMessages: Array<{ id: string; seq: number; participant: string; forAgent?: string; content: ContentBlock[] }>;
      unackedDeferredWrites: Array<{ id: string }>;
      deferredWritesPersisted: boolean;
      quiesced: boolean;
      assembling: Set<string>;
      drainDeferredFor: (name: string, stopAt?: unknown) => unknown[];
      readdDrained: (entries: unknown[], where: string) => unknown[];
      ackDeferredWrites: () => void;
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: {
        forAgent?: string; fromQueue?: { id: string; seq: number }; bypassDeferralFor?: string;
        placement?: { agent?: string; messageId?: string; deferredId?: string };
      }): string;
    };
  }
  const otherCycle = (): ContentBlock[] => [{ type: 'tool_use', id: 'b1', name: 'robot--move', input: {} } as ContentBlock];

  it('a message held for the turn\'s end lands then, while another agent\'s tool cycle is pending', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const internals = internalsOf(framework);
    // Whether the other cycle was pending at the turn-end flush itself.
    const pendingAtFlush: boolean[] = [];
    const drain = internals.drainDeferredFor.bind(framework);
    internals.drainDeferredFor = (name: string, stopAt?: unknown) => {
      if (name === 'assistant' && stopAt === undefined && internals.deferredMessages.length > 0) {
        pendingAtFlush.push(internals.pendingAssistantBlocks.has('builder'));
      }
      return drain(name, stopAt);
    };
    module.duringTool = () => {
      // Another agent is mid tool cycle when this turn ends, and a write
      // named as this agent (held: it can't join the live stream) waits.
      internals.pendingAssistantBlocks.set('builder', otherCycle());
      assert.equal(internals.addMessage('assistant', text('my own words'), undefined, { forAgent: 'assistant' }), '', 'deferred');
    };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.deepEqual(pendingAtFlush, [true], 'the other cycle was pending at the turn-end flush');
    assert.deepEqual(windowOf(framework).slice(-2), ['assistant: Done.', 'assistant: my own words']);
    internals.pendingAssistantBlocks.delete('builder');
    await framework.stop();
  });

  it("a write waits on its target's own turn and tool cycle, not another agent's, primary-bound or targeted", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.pendingAssistantBlocks.set('builder', otherCycle());
    try {
      assert.notEqual(internals.addMessage('Antra', text('primary-bound')), '', 'stored: the primary is idle');
      assert.notEqual(internals.addMessage('Antra', text('targeted'), undefined, { forAgent: 'assistant' }), '', 'stored too');
      internals.pendingAssistantBlocks.set('assistant', otherCycle());
      assert.equal(internals.addMessage('Antra', text('in its own cycle')), '', "deferred: the primary's own cycle is pending");
      // Its entry names no agent: one with no target is the primary's, as the
      // recovery file and a boot whose primary was renamed take it.
      assert.deepEqual(internals.deferredMessages.map((m) => m.forAgent), [undefined], 'a primary-bound entry names no agent');
    } finally {
      internals.pendingAssistantBlocks.delete('builder');
      internals.pendingAssistantBlocks.delete('assistant');
    }
    await framework.stop();
  });

  it("the puppet's flush lands what was deferred behind it while another agent's tool cycle is pending", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    module.duringTool = () => {
      internals.pendingAssistantBlocks.set('builder', otherCycle());
      assert.equal(internals.addMessage('Antra', text('while puppeted')), '', 'deferred behind the puppet');
    };
    try {
      await framework.puppetToolCall('assistant', 'robot--move', {});
      assert.equal(internals.deferredMessages.length, 0);
      assert.deepEqual(windowOf(framework).slice(-3), ['assistant: <tool_use>', 'user: <tool_result>', 'Antra: while puppeted']);
    } finally {
      internals.pendingAssistantBlocks.delete('builder');
    }
    await framework.stop();
  });

  it('a turn mid-compile when the framework stops never starts a stream, and what was deferred for it is stored', async () => {
    membrane.pushResponse(createMockResponse(text('too late')));
    const framework = await createFramework();
    const internals = internalsOf(framework);
    const agent = framework.getAgent('assistant')!;
    let compiling!: () => void;
    const inCompile = new Promise<void>((resolve) => { compiling = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const start = agent.startStreamWithInjections.bind(agent);
    (agent as unknown as { startStreamWithInjections: typeof start }).startStreamWithInjections = async (...args) => {
      compiling();
      await released;
      return start(...args);
    };
    // The event loop starts the turn, as in a host (stop() awaits the loop).
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await inCompile;
    assert.equal(internals.addMessage('Antra', text('late word')), '', 'deferred: the turn is alive');
    const stopped = framework.stop();
    release();
    await stopped;
    assert.equal(internals.activeStreams.size, 0, 'no stream outlived stop()');

    const reopened = await createFramework();
    assert.ok(windowOf(reopened).includes('Antra: late word'), 'stored before the store closed');
    assert.ok(!windowOf(reopened).includes('assistant: too late'), 'the refused turn produced nothing');
    await reopened.stop();
  });

  it('a drained write whose store throws stays in the persisted queue, and is stored on the next boot', async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.deferredWritesPersisted = true;
    internals.activeTurnTokens.set('assistant', 1);
    assert.equal(internals.addMessage('Antra', text('kept')), '', 'deferred');
    internals.activeTurnTokens.delete('assistant');
    const cm = framework.getAgent('assistant')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
      if ((args[1] as Array<{ text?: string }>).some((b) => b.text === 'kept')) throw new Error('disk full');
      return add(...args);
    };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try { await framework.stop(); } finally { console.error = error; }
    assert.ok(errors.some((e) => e.includes('could not be stored; it stays queued') && e.includes('disk full')), errors.join('\n'));
    assert.equal(internals.deferredMessages.length, 1, 'still queued');

    const reopened = await createFramework();
    assert.ok(windowOf(reopened).includes('Antra: kept'), 'boot recovery stored it');
    await reopened.stop();
  });

  it('at a tool boundary, a write whose store throws cuts the drain: it and what follows wait for the turn end, in order', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const cm = framework.getAgent('assistant')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    let failOnce = true;
    (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
      if (failOnce && (args[1] as Array<{ text?: string }>).some((b) => b.text === 'look left')) {
        failOnce = false;
        throw new Error('transient');
      }
      return add(...args);
    };
    module.interjections = [
      { participant: 'Antra', content: text('look left') },
      { participant: 'Antra', content: text('look right') },
    ];
    const error = console.error;
    console.error = () => {};
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }
    assert.deepEqual(injected(), [], 'nothing from the failed write on is injected');
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'assistant: Done.',
      'Antra: look left',
      'Antra: look right',
    ], 'both were kept, and stored at the turn end in queue order');
    await framework.stop();
  });

  /** The agent's context manager's addMessage throws once, for the message
   *  with this text, after the real call has stored it: a write that throws
   *  though its message is stored. The double is ours: from 0.15,
   *  context-manager logs a throw from a host's onMessage listener and lets
   *  the write stand, and its fix for issue #288, merged after 0.18.0, does
   *  the same for a synchronous throw from its strategy's onNewMessage. */
  function throwOnceAfterStoring(framework: AgentFramework, textOf: string): void {
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage: (participant: string, content: ContentBlock[], ...rest: unknown[]) => string;
    };
    const addMessage = cm.addMessage;
    let thrown = false;
    cm.addMessage = function (this: unknown, participant, content, ...rest) {
      const id = addMessage.call(this, participant, content, ...rest);
      if (!thrown && content.some((b) => (b as { text?: string }).text === textOf)) {
        thrown = true;
        throw new Error('failed after storing');
      }
      return id;
    };
  }

  /** The agent's message store throws once from its append of a shard that
   *  `matches`, after storing that shard: a sharded write that fails partway.
   *  context-manager then removes what the write stored before the error
   *  reaches addMessage's caller, unless that removal fails too. Only
   *  appends that carry a body group are offered to `matches`, so an
   *  unsharded message never counts toward a match or throws. */
  function throwOnceFromShardAppend(
    framework: AgentFramework,
    matches: (shard: { bodyGroupId: string; shardIndex: number }) => boolean,
  ): void {
    type Extra = { bodyGroupId?: string; shardIndex?: number };
    const store = (framework.getAgent('assistant')!.getContextManager() as unknown as {
      messageStore: { append: (participant: string, content: ContentBlock[], metadata?: unknown, causedBy?: unknown, extra?: Extra) => unknown };
    }).messageStore;
    const append = store.append;
    let thrown = false;
    store.append = function (this: unknown, participant, content, metadata, causedBy, extra) {
      const stored = append.call(this, participant, content, metadata, causedBy, extra);
      if (!thrown && extra?.bodyGroupId !== undefined && matches({ bodyGroupId: extra.bodyGroupId, shardIndex: extra.shardIndex! })) {
        thrown = true;
        throw new Error('the store failed partway through a body');
      }
      return stored;
    };
  }

  it('at a tool boundary, a write that throws after its message is stored counts as stored: injected, and not stored again', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    throwOnceAfterStoring(framework, 'look left');
    module.interjections = [
      { participant: 'Antra', content: text('look left') },
      { participant: 'Antra', content: text('look right') },
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }
    assert.deepEqual(injected(), ['Antra: look left', 'Antra: look right'], 'the stored copy is carried too');
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'Antra: look left',
      'Antra: look right',
      'assistant: Done.',
    ], 'stored once, where the stream carried it');
    assert.ok(errors.some((e) => e.includes("threw after it was stored; what was stored counts as written and isn't stored again")
      && e.includes('failed after storing')), errors.join('\n'));
    await framework.stop();
  });

  /** Have the agent's context manager's addMessage throw once, after storing
   *  the message carrying `textOf` (as throwOnceAfterStoring), and the
   *  store's next windowed read after that throw, the drain's readback of
   *  what landed, throw too. */
  function throwAfterStoringThenUnreadable(framework: AgentFramework, textOf: string): void {
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage: (participant: string, content: ContentBlock[], ...rest: unknown[]) => string;
      getMessageWindow: (...args: unknown[]) => unknown;
    };
    const addMessage = cm.addMessage;
    const read = cm.getMessageWindow;
    let thrown = false;
    let unreadable = false;
    cm.addMessage = function (this: unknown, participant, content, ...rest) {
      const id = addMessage.call(this, participant, content, ...rest);
      if (!thrown && content.some((b) => (b as { text?: string }).text === textOf)) {
        thrown = true;
        unreadable = true;
        throw new Error('failed after storing');
      }
      return id;
    };
    cm.getMessageWindow = function (this: unknown, ...args: unknown[]) {
      if (unreadable) {
        unreadable = false;
        throw new Error('readback failed');
      }
      return read.apply(this, args);
    };
  }

  it("at a tool boundary, a write that throws after it's stored, whose store then can't be read back, is looked up by its id there, and carried there", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    throwAfterStoringThenUnreadable(framework, 'look left');
    module.interjections = [
      { participant: 'Antra', content: text('look left') },
      { participant: 'Antra', content: text('look right') },
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }
    assert.deepEqual(windowOf(framework).slice(-4), [
      'user: <tool_result>',
      'Antra: look left',
      'Antra: look right',
      'assistant: Done.',
    ], 'stored once, where it landed, and both carried at the boundary, before the reply');
    assert.deepEqual(injected(), ['Antra: look left', 'Antra: look right'], 'both injected at the boundary');
    assert.ok(errors.some((e) => e.includes('threw after it was stored; what was stored counts as written')
      && e.includes('failed after storing')), errors.join('\n'));
    assert.ok(!errors.some((e) => e.includes("couldn't be read to tell whether it was stored")), 'never marked');
    await framework.stop();
  });

  it("at a tool boundary, a write that throws after it's stored, whose store can then be neither read back nor searched, is found later and counts as written where it landed, ahead of the turn's reply, a known limit", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const cm = framework.getAgent('assistant')!.getContextManager();
    const addMessage = cm.addMessage;
    const read = cm.getMessageWindow;
    const query = cm.queryMessages;
    let thrown = false;
    let readsFailing = 0;
    let queryFailing = false;
    cm.addMessage = function (this: unknown, participant, content, ...rest) {
      const id = addMessage.call(this, participant, content, ...rest);
      if (!thrown && content.some((b) => (b as { text?: string }).text === 'look left')) {
        thrown = true;
        readsFailing = 2;
        queryFailing = true;
        throw new Error('failed after storing');
      }
      return id;
    };
    // The readback, and then the blob-free scan behind the failed query.
    cm.getMessageWindow = function (this: unknown, ...args: unknown[]) {
      if (readsFailing > 0) { readsFailing--; throw new Error('read failed'); }
      return read.apply(this, args as Parameters<typeof read>);
    };
    cm.queryMessages = function (this: unknown, ...args: unknown[]) {
      if (queryFailing) { queryFailing = false; throw new Error('search failed'); }
      return query.apply(this, args as Parameters<typeof query>);
    };
    module.interjections = [
      { participant: 'Antra', content: text('look left') },
      { participant: 'Antra', content: text('look right') },
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }
    assert.deepEqual(windowOf(framework).slice(-4), [
      'user: <tool_result>',
      'Antra: look left',
      'assistant: Done.',
      'Antra: look right',
    ], 'stored once, where its first write landed, and what was queued behind it at the turn end');
    assert.ok(errors.some((e) => e.includes("threw, and its store couldn't be read to tell whether it was stored")), errors.join('\n'));
    assert.ok(errors.some((e) => e.includes('was found by its id: it was stored by an earlier write')
      && e.includes("a later request replaying that reply's signed thinking is refused with a 400 (context-manager #155)")), errors.join('\n'));
    await framework.stop();
  });

  /** The internals a drained write's landing goes through. */
  function drainInternals(framework: AgentFramework) {
    return framework as unknown as {
      writeDrainedInOrder(
        entries: DeferredEntry[], where: string, write: (msg: DeferredEntry) => string,
        onLanded?: (msg: DeferredEntry, id: string) => void,
      ): Map<DeferredEntry, { id: string; content: ContentBlock[] }>;
      releaseWindow(agent: unknown): void;
      addMessage(participant: string, content: ContentBlock[], metadata: unknown, opts: unknown): string;
      editMessage(id: string, content: ContentBlock[]): void;
      removeMessage(id: string): void;
      queryMessages(filter: unknown): { messages: Array<{ content: ContentBlock[]; held?: true }> };
      getMessage(id: string): { held?: true; content: ContentBlock[] } | null;
      deferredWriteDone(agent: unknown, writeId: string, to: unknown): boolean;
      isUnreadPlacement(placement: { agent: string; deferredId?: string }, by?: 'consumed' | 'shown'): boolean;
      removePlacement(placement: { agent: string; deferredId?: string }): boolean;
      deferredMessages: DeferredEntry[];
      deferredWritesPersisted: boolean;
    };
  }
  type DeferredEntry = {
    id: string; seq: number; participant: string; content: ContentBlock[]; heldAt: number;
    metadata?: unknown; forAgent?: string; landing?: 'unknown';
  };
  const entry = (id: string, said: string): DeferredEntry => ({ id, seq: 1, participant: 'Antra', content: text(said), heldAt: Date.now() });
  /** A write that stores the entry as the framework does, under its id, then throws. */
  const storedThenThrows = (framework: AgentFramework) => (msg: DeferredEntry): string => {
    framework.getAgent('assistant')!.getContextManager().addMessage(msg.participant, msg.content, { deferredWriteId: msg.id } as never);
    throw new Error('failed after storing');
  };

  it("at a tool boundary, a marked write found where an earlier write stored it counts as written there, and is injected there", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const internals = drainInternals(framework);
    module.duringTool = () => {
      // An earlier write of it landed, though whether it landed wasn't
      // known.
      framework.getAgent('assistant')!.getContextManager().addMessage('Antra', text('look left'), { deferredWriteId: 'w-carried' } as never);
      internals.deferredMessages.push({ ...entry('w-carried', 'look left'), landing: 'unknown' });
    };
    module.interjections = [{ participant: 'Antra', content: text('look right') }];
    const error = console.error;
    console.error = () => {};
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }
    assert.deepEqual([...injected()].sort(), ['Antra: look left', 'Antra: look right'], 'the found copy is injected with what the boundary stored');
    assert.equal(windowOf(framework).filter((line) => line === 'Antra: look left').length, 1, 'stored once');
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'and not queued again');
    await framework.stop();
  });

  it("a drained write that throws before it's stored, whose readback can't say, is looked up by its id there, found absent, queued unmarked, and stored once at the next flush", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage: (...args: unknown[]) => string;
      getMessageWindow: (...args: unknown[]) => unknown;
    };
    const read = cm.getMessageWindow;
    let readFails = true;
    cm.getMessageWindow = function (this: unknown, ...args: unknown[]) {
      if (readFails) { readFails = false; throw new Error('read failed'); }
      return read.apply(this, args);
    };
    const msg = { ...entry('w-absent-there', 'look left') };
    const error = console.error;
    console.error = () => {};
    try {
      internals.writeDrainedInOrder([msg], 'test', () => { throw new Error('refused before storing'); });
    } finally { console.error = error; cm.getMessageWindow = read; }
    assert.equal(readFails, false, 'the readback was tried, and failed');
    assert.equal((msg as { landing?: string }).landing, undefined, 'found absent by its id, it is never marked');
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), ['w-absent-there'], 'queued again, as unstored');
    internals.writeDrainedInOrder(internals.deferredMessages.splice(0), 'test',
      (m) => cm.addMessage(m.participant, m.content, { deferredWriteId: m.id }));
    assert.deepEqual(copiesOf(framework, 'w-absent-there'), ['look left'], 'stored once');
    await framework.stop();
  });

  it("a write whose scan fails and then whose copy can't be read is said again, since the failure changed", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-kinds', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      queryMessages: (...args: unknown[]) => unknown;
      getMessageWindow: (offset: number, limit: number, opts?: { resolveBlobs?: boolean }) => { messages: Array<{ metadata?: { deferredWriteId?: string } }> };
    };
    const query = cm.queryMessages;
    const read = cm.getMessageWindow;
    cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      const unscan = noScan(framework);
      internals.getMessage(heldHandle('w-kinds'));
      unscan();
      cm.getMessageWindow = function (this: unknown, offset, limit, opts) {
        const window = read.call(this, offset, limit, opts);
        if (opts?.resolveBlobs !== false && window.messages.some((m) => m.metadata?.deferredWriteId === 'w-kinds')) throw new Error('Blob not found: 4567');
        return window;
      };
      internals.getMessage(heldHandle('w-kinds'));
    } finally { cm.queryMessages = query; cm.getMessageWindow = read; console.error = error; }
    assert.equal(errors.filter((e) => e.includes('could not search') && e.includes('w-kinds')).length, 1, errors.join('\n'));
    assert.equal(errors.filter((e) => e.includes('found deferred write w-kinds') && e.includes('could not read its stored copy')).length, 1, errors.join('\n'));
    assert.ok(errors.every((e) => !e.includes('w-kinds') || e.includes('Blob not found: 0123')), 'each names the query\'s own error');
    await framework.stop();
  });

  it("a drained write that throws when its store couldn't count its messages before it is looked up by its id there, and counts as written", async () => {
    const framework = await createFramework();
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { getMessageCount: () => number };
    const count = cm.getMessageCount;
    let failing = true;
    cm.getMessageCount = function (this: unknown) {
      if (failing) { failing = false; throw new Error('count failed'); }
      return count.call(this);
    };
    const internals = drainInternals(framework);
    const msg = entry('w-count', 'look left');
    const error = console.error;
    console.error = () => {};
    let written: Map<DeferredEntry, { id: string; content: ContentBlock[] }>;
    const landed: Array<[string, string]> = [];
    try {
      written = internals.writeDrainedInOrder([msg], 'test', storedThenThrows(framework), (m, id) => { landed.push([m.id, id]); });
    } finally { console.error = error; }
    assert.equal(windowOf(framework).filter((line) => line === 'Antra: look left').length, 1, 'stored once');
    const [copy] = framework.getAgent('assistant')!.getContextManager().queryMessages({ metadata: { deferredWriteId: 'w-count' } } as never).messages;
    assert.equal(written.get(msg)?.id, copy!.id, 'it counts as written, under the id its copy was stored with');
    assert.deepEqual(landed, [['w-count', copy!.id]], 'what landed is noted, as for a write found by its readback');
    assert.equal(msg.landing, undefined, 'found by its id at once, it is never marked');
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'and not queued again');
    await framework.stop();
  });

  it("a drained write whose landing is unknown, found by its id, is carried as its store holds it, not as it was queued", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    // A body whose first part landed before the throw stopped its write.
    framework.getAgent('assistant')!.getContextManager().addMessage('Antra', text('part one'), { deferredWriteId: 'w-part' } as never);
    const msg = { ...entry('w-part', 'part one'), content: [...text('part one'), ...text('part two')], landing: 'unknown' as const };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let written: Map<DeferredEntry, { id: string; content: ContentBlock[] }>;
    try {
      written = internals.writeDrainedInOrder([msg], 'test', () => { throw new Error('written again'); });
    } finally { console.error = error; }
    assert.deepEqual(written.get(msg)?.content, text('part one'), 'what the store holds');
    assert.ok(errors.some((e) => e.includes("it stays where that write stored it, and a reply stored after it whose request didn't carry it was made without it")
      && e.includes('(context-manager #155)')), errors.join('\n'));
    await framework.stop();
  });

  it("a drained write whose landing is unknown, and which its store doesn't hold, is written when it's looked up", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const msg = { ...entry('w-absent', 'look left'), landing: 'unknown' as const };
    let writes = 0;
    const written = internals.writeDrainedInOrder([msg], 'test', (m) => {
      writes++;
      return framework.getAgent('assistant')!.getContextManager().addMessage(m.participant, m.content, { deferredWriteId: m.id } as never);
    });
    assert.equal(writes, 1);
    assert.ok(written.has(msg));
    assert.equal(msg.landing, undefined, 'looked up and written, it is no longer unknown');
    await framework.stop();
  });

  it("a drained write whose landing is unknown stays queued, holding what's behind it, while its store can't be searched", async () => {
    const framework = await createFramework();
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    cm.queryMessages = function () { throw new Error('search failed'); };
    const unscan = noScan(framework);
    const internals = drainInternals(framework);
    const first = { ...entry('w-held', 'look left'), landing: 'unknown' as const };
    // Another target's entry, queued between them, isn't held by them.
    const other = { ...entry('w-other', 'elsewhere'), seq: 2, forAgent: 'gone-fork' };
    const second = { ...entry('w-behind', 'look right'), seq: 3 };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const writes: string[] = [];
    try {
      const written = internals.writeDrainedInOrder([first, other, second], 'test', (m) => { writes.push(m.id); return 'x'; });
      assert.deepEqual([...written.keys()].map((m) => m.id), ['w-other']);
    } finally { console.error = error; }
    assert.deepEqual(writes, ['w-other'], "only the other target's entry is written");
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), ['w-held', 'w-behind'], 'both are back in the queue');
    assert.equal(first.landing, 'unknown');
    assert.ok(errors.some((e) => e.includes("still can't be found and read by its id")), errors.join('\n'));
    cm.queryMessages = query; unscan();
    await framework.stop();
  });

  it("a drained write whose landing is unknown, for an agent that isn't registered, is dropped as an unmarked one is, not held", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const gone = { ...entry('w-gone', 'look left'), forAgent: 'gone-fork', landing: 'unknown' as const };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let written: Map<DeferredEntry, { id: string; content: ContentBlock[] }>;
    try {
      written = internals.writeDrainedInOrder([gone], 'test', (m) => internals.addMessage(m.participant, m.content, m.metadata, {
        fromQueue: { id: m.id, seq: m.seq, heldAt: m.heldAt }, forAgent: m.forAgent,
      }));
    } finally { console.error = error; }
    assert.ok(written.has(gone), 'it leaves the drain');
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'nothing is held');
    assert.ok(!errors.some((e) => e.includes("still can't be found and read by its id")), errors.join('\n'));
    await framework.stop();
  });

  for (const failAt of ['initial-count', 'readback'] as const) {
    it(`real malformed refusal with unavailable ${failAt} drops, unblocks and stays dropped after reopen`, async () => {
      const framework = await createFramework();
      const internals = drainInternals(framework);
      const queue = internalsOf(framework);
      queue.deferredWritesPersisted = true;
      const cm = framework.getAgent('assistant')!.getContextManager();
      const first = { ...entry('w-malformed-real', 'bad'), content: [{ type: 'text', text: 42 }] as unknown as ContentBlock[] };
      const second = { ...entry('w-after-malformed', 'after'), seq: 2 };
      const count = cm.getMessageCount.bind(cm);
      let failCount = false;
      let countPhase = 'drain';
      const failedPhases: string[] = [];
      cm.getMessageCount = () => {
        if (failCount) { failCount = false; failedPhases.push(countPhase); throw new Error('injected count/readback failure'); }
        return count();
      };
      const errors: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      let reopened: AgentFramework | undefined;
      const writes: string[] = [];
      try {
        queue.deferredMessages.push(first, second);
        const drained = queue.drainDeferredFor('assistant') as DeferredEntry[];
        assert.deepEqual(failedPhases, [], 'handoff must not consume the writer fault');
        countPhase = 'writer-before-add';
        failCount = failAt === 'initial-count';
        internals.writeDrainedInOrder(drained, 'test-real-store', (m) => {
          countPhase = 'write-callback';
          writes.push(m.id);
          try { return cm.addMessage(m.participant, m.content, { deferredWriteId: m.id } as never); }
          catch (e) {
            assert.ok(e instanceof MalformedContentError, 'real CM refusal, not a framework readback stub');
            countPhase = 'writer-readback';
            if (failAt === 'readback') failCount = true;
            throw e;
          }
        });
        assert.deepEqual(failedPhases, [failAt === 'initial-count' ? 'writer-before-add' : 'writer-readback'],
          'the intended writer count boundary, not queue handoff or the write callback, failed exactly once');
        assert.deepEqual(writes, [first.id, second.id], 'successor proceeds in the same flush');
        assert.deepEqual(internals.deferredMessages, [], 'malformed refusal is not retained as unknown');
        assert.equal(cm.queryMessages({ metadata: { deferredWriteId: first.id } } as never).messages.length, 0);
        assert.equal(cm.queryMessages({ metadata: { deferredWriteId: second.id } } as never).messages.length, 1);
        assert.ok(errors.some(e => e.includes('dropped')), errors.join('\n'));
        cm.getMessageCount = count;
        queue.ackDeferredWrites();
        await framework.stop();
        reopened = await createFramework();
        const restored = reopened.getAgent('assistant')!.getContextManager();
        assert.equal(restored.queryMessages({ metadata: { deferredWriteId: first.id } } as never).messages.length, 0, 'refused body never stored');
        assert.equal(restored.queryMessages({ metadata: { deferredWriteId: second.id } } as never).messages.length, 1, 'successor not duplicated');
        assert.deepEqual(drainInternals(reopened).deferredMessages, [], 'durable queue does not resurrect refused entry');
      } finally {
        console.error = error;
        cm.getMessageCount = count;
        if (reopened) await reopened.stop();
        else await framework.stop();
      }
    });
  }

  for (const landed of [true, false]) {
    it(`a write whose landing is unknown keeps its mark across a restart, so it's stored once after it (${landed ? 'its first write landed' : 'nothing landed'})`, async () => {
      const framework = await createFramework();
      const internals = drainInternals(framework);
      internals.deferredWritesPersisted = true;
      const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
        addMessage(participant: string, content: ContentBlock[], metadata?: unknown): string;
        queryMessages: (...args: unknown[]) => unknown;
      };
      // Where its first write landed, the hand-off at stop() records the
      // store's count after it, so boot's check for landed writes starts
      // past it and only the restored mark keeps it from a second store.
      if (landed) cm.addMessage('Antra', text('look left'), { deferredWriteId: 'w-rt' });
      internals.deferredMessages.push({ ...entry('w-rt', 'look left'), landing: 'unknown' });
      cm.queryMessages = () => { throw new Error('search failed'); };
      noScan(framework);
      const error = console.error;
      console.error = () => {};
      try { await framework.stop(); } finally { console.error = error; }
      assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.landing]), [['w-rt', 'unknown']], 'held through stop()');

      const reopened = await createFramework();
      assert.equal(windowOf(reopened).filter((line) => line === 'Antra: look left').length, 1, 'stored once');
      assert.deepEqual(drainInternals(reopened).deferredMessages.map((m) => m.id), [], 'and no longer queued');
      await reopened.stop();
    });
  }

  it("a released window doesn't store a write whose landing is unknown a second time, when its store holds it", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const agent = framework.getAgent('assistant')!;
    const cm = agent.getContextManager();
    const copies = (id: string): number => cm.queryMessages({ metadata: { deferredWriteId: id } } as never).messages.length;
    cm.addMessage('Antra', text('look left'), { deferredWriteId: 'w-rel' } as never);
    internals.deferredMessages.push({ ...entry('w-rel', 'look left'), landing: 'unknown' });
    internals.deferredMessages.push({ ...entry('w-rel-2', 'look right'), seq: 2, landing: 'unknown' });
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try { internals.releaseWindow(agent); } finally { console.error = error; }
    assert.equal(copies('w-rel'), 1, 'found by its id, it is not stored again');
    assert.equal(copies('w-rel-2'), 1, 'not found, it is stored');
    assert.ok(errors.some((e) => e.includes('release of assistant') && e.includes('was found by its id')), errors.join('\n'));
    await framework.stop();
  });

  it("a released window doesn't pass a failed reply on a second time when its store holds the reply's copy", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    // A run, whose window is its own: the primary's notice of its failed
    // reply goes to another window, which the notice is looked up in by its
    // id before it's written (queuedNoticeForPrimary keeps the mark).
    const { agent, contextManager: cm } = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    });
    const failed = { kind: 'discord-send-failed', channelId: 'c1', reason: 'gone', textLen: 5, outcome: 'failed' };
    // Its earlier write landed. The release passes the entry on under its
    // own id, and the copy in the run's window, which it reads as unread,
    // isn't passed on as well.
    cm.addMessage('worker', text('hello'), { ...failed, deferredWriteId: 'w-fail' } as never);
    internals.deferredMessages.push({ ...entry('w-fail', 'hello'), participant: 'worker', forAgent: 'worker', metadata: failed, landing: 'unknown' });
    const error = console.error;
    console.error = () => {};
    try { internals.releaseWindow(agent); } finally { console.error = error; }
    const notices = framework.getAgent('assistant')!.getContextManager().queryMessages({} as never).messages
      .filter((m) => (m.metadata as { speaker?: unknown } | undefined)?.speaker === 'worker');
    assert.equal(notices.length, 1, 'the primary is told once');
    await framework.stop();
  });

  it("a released window doesn't pass on a failed reply the agent had read, when its store holds the reply's copy", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    // A run, whose window is its own, as in the test before: the primary's
    // window holds no copy under the entry's id to answer for the read check.
    const { agent, contextManager: cm } = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    });
    const failed = { kind: 'discord-send-failed', channelId: 'c1', reason: 'gone', textLen: 5, outcome: 'failed' };
    cm.addMessage('worker', text('hello'), { ...failed, deferredWriteId: 'w-read' } as never);
    // The run read its copy: the window's read skips it, as main skips a
    // failed reply the agent heard, and the queued entry mustn't pass it on
    // either.
    agent.markContextConsumed();
    internals.deferredMessages.push({ ...entry('w-read', 'hello'), participant: 'worker', forAgent: 'worker', metadata: failed, landing: 'unknown' });
    const error = console.error;
    console.error = () => {};
    try { internals.releaseWindow(agent); } finally { console.error = error; }
    assert.ok(!internals.deferredMessages.some((m) => m.id === 'w-read'), 'the release took the entry from the queue');
    const notices = framework.getAgent('assistant')!.getContextManager().queryMessages({} as never).messages
      .filter((m) => (m.metadata as { speaker?: unknown } | undefined)?.speaker === 'worker');
    assert.equal(notices.length, 0, "the primary isn't told");
    await framework.stop();
  });

  it("a released window that can neither search a write's store nor store it says it may be stored once, twice or not at all", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const agent = framework.getAgent('assistant')!;
    const cm = agent.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown; addMessage: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    const add = cm.addMessage;
    cm.queryMessages = () => { throw new Error('search failed'); };
    const unscan = noScan(framework);
    cm.addMessage = () => { throw new Error('store failed'); };
    internals.deferredMessages.push({ ...entry('w-lost', 'look left'), landing: 'unknown' });
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try { internals.releaseWindow(agent); } finally { console.error = error; cm.queryMessages = query; unscan(); cm.addMessage = add; }
    assert.ok(errors.some((e) => e.includes('w-lost') && e.includes('may be stored once, twice or not at all')), errors.join('\n'));
    assert.ok(!errors.some((e) => e.includes('w-lost') && e.includes('may now be stored twice')), 'not the line for a store that went through');
    await framework.stop();
  });

  it("a released ephemeral run's window settles a write whose landing is unknown in that run's own store", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const { agent } = await framework.createEphemeralAgent({ name: 'run-x', model: 'test-model', systemPrompt: 'Do the task.' });
    const own = agent.getContextManager();
    own.addMessage('Antra', text('look left'), { deferredWriteId: 'w-run' } as never);
    internals.deferredMessages.push({ ...entry('w-run', 'look left'), forAgent: 'run-x', landing: 'unknown' });
    const error = console.error;
    console.error = () => {};
    try { internals.releaseWindow(agent); } finally { console.error = error; }
    assert.equal(own.queryMessages({ metadata: { deferredWriteId: 'w-run' } } as never).messages.length, 1, "found in the run's own store, it isn't stored again");
    assert.deepEqual(copiesOf(framework, 'w-run'), [], "and the primary's store holds none");
    await framework.stop();
  });

  it("a released window stores a write whose landing is unknown while its store can't be searched, saying it may now be stored twice", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const agent = framework.getAgent('assistant')!;
    const cm = agent.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('search failed'); };
    const unscan = noScan(framework);
    internals.deferredMessages.push({ ...entry('w-blind', 'look left'), landing: 'unknown' });
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try { internals.releaseWindow(agent); } finally { console.error = error; }
    cm.queryMessages = query; unscan();
    assert.equal(windowOf(framework).filter((line) => line === 'Antra: look left').length, 1, 'stored');
    assert.ok(errors.some((e) => e.includes('w-blind') && e.includes('may now be stored twice')), errors.join('\n'));
    await framework.stop();
  });

  /** A held write whose landing is unknown, whose first write did land. */
  function heldAndStored(framework: AgentFramework, id: string, said: string): void {
    framework.getAgent('assistant')!.getContextManager().addMessage('Antra', text(said), { deferredWriteId: id } as never);
    drainInternals(framework).deferredMessages.push({ ...entry(id, said), landing: 'unknown' });
  }
  const copiesOf = (framework: AgentFramework, id: string): string[] => framework.getAgent('assistant')!.getContextManager()
    .queryMessages({ metadata: { deferredWriteId: id } } as never).messages
    .map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''));

  it("a module's edit of a held write whose landing is unknown settles it first, so the edit reaches the stored row it landed as", async () => {
    for (const by of ['handle', 'stored id'] as const) {
      // Each pass opens the test's one store again, so each takes its own id.
      const id = `w-${by === 'handle' ? 'h' : 's'}`;
      const framework = await createFramework();
      const internals = drainInternals(framework);
      heldAndStored(framework, id, 'look left');
      const [copy] = framework.getAgent('assistant')!.getContextManager()
        .queryMessages({ metadata: { deferredWriteId: id } } as never).messages;
      const error = console.error;
      console.error = () => {};
      try { internals.editMessage(by === 'handle' ? heldHandle(id) : copy!.id, text('look up')); } finally { console.error = error; }
      assert.deepEqual(copiesOf(framework, id), ['look up'], `by its ${by}: stored once, edited`);
      assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], `by its ${by}: no longer held`);
      await framework.stop();
    }
  });

  it("a module's removal of a held write whose landing is unknown settles it first, so the stored row goes and nothing is written again", async () => {
    for (const by of ['handle', 'stored id'] as const) {
      // Each pass opens the test's one store again, so each takes its own id.
      const id = `w-${by === 'handle' ? 'h' : 's'}`;
      const framework = await createFramework();
      const internals = drainInternals(framework);
      heldAndStored(framework, id, 'look left');
      const [copy] = framework.getAgent('assistant')!.getContextManager()
        .queryMessages({ metadata: { deferredWriteId: id } } as never).messages;
      const error = console.error;
      console.error = () => {};
      try { internals.removeMessage(by === 'handle' ? heldHandle(id) : copy!.id); } finally { console.error = error; }
      assert.deepEqual(copiesOf(framework, id), [], `by its ${by}`);
      assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], `by its ${by}: nothing left to write`);
      await framework.stop();
    }
  });

  it("a module's edit of a held write whose landing is unknown, which its store doesn't hold, settles it as an ordinary held write and edits it", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    internals.deferredMessages.push({ ...entry('w-absent-ed', 'look left'), landing: 'unknown' });
    internals.editMessage(heldHandle('w-absent-ed'), text('look up'));
    assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.content, m.landing]), [['w-absent-ed', text('look up'), undefined]]);
    assert.deepEqual(copiesOf(framework, 'w-absent-ed'), [], 'nothing stored');
    await framework.stop();
  });

  it("settling a held write whose landing is unknown, found, keeps it in the durable queue until an ack, takes the notes a store takes, and logs it by its id", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework) as ReturnType<typeof drainInternals> & {
      unackedDeferredWrites: DeferredEntry[];
      durableDeferredWrites(): DeferredEntry[];
      noteStored(agent: unknown, metadata: unknown, stored: string): void;
    };
    internals.deferredWritesPersisted = true;
    heldAndStored(framework, 'w-found', 'look left');
    const [copy] = framework.getAgent('assistant')!.getContextManager()
      .queryMessages({ metadata: { deferredWriteId: 'w-found' } } as never).messages;
    const noted: string[] = [];
    const note = internals.noteStored;
    internals.noteStored = function (this: unknown, agent: unknown, metadata: unknown, stored: string) {
      noted.push(stored);
      return note.call(this, agent, metadata, stored);
    };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try { internals.queryMessages({}); } finally { console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'no longer held');
    assert.deepEqual(internals.unackedDeferredWrites.map((m) => [m.id, m.landing]), [['w-found', 'unknown']],
      'un-acked, as a drained write is, and still marked, so a restart before the ack looks it up');
    assert.deepEqual(internals.durableDeferredWrites().map((m) => m.id), ['w-found'], 'so the durable queue keeps it until the next ack');
    assert.deepEqual(noted, [copy!.id], 'the notes a store takes, for the copy');
    assert.ok(errors.some((e) => e.includes('w-found') && e.includes('was found by its id')), errors.join('\n'));
    await framework.stop();
  });

  it("settling a held write whose landing is unknown, not found, persists the queue without its mark, as an edit does", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    internals.deferredWritesPersisted = true;
    internals.deferredMessages.push({ ...entry('w-persist', 'look left'), landing: 'unknown' });
    internals.queryMessages({});
    // The durable queue's documented place under the store (FrameworkConfig.deferredWritesPath).
    const onDisk = JSON.parse(readFileSync(join(tempDir, 'test.chronicle', 'recovery', 'deferred-writes.json'), 'utf8')) as { pending: Array<{ id: string; landing?: string }> };
    assert.deepEqual(onDisk.pending.map((m) => [m.id, m.landing]), [['w-persist', undefined]], 'the queue on disk no longer carries the mark');
    assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.landing]), [['w-persist', undefined]]);
    await framework.stop();
  });

  it("a module's edit or removal of a held write whose landing is unknown throws with nothing changed while its store can't be searched", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-blind', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('search failed'); };
    const unscan = noScan(framework);
    const error = console.error;
    console.error = () => {};
    try {
      assert.throws(() => internals.editMessage(heldHandle('w-blind'), text('look up')), /held:w-blind may already be stored, and its store can't be searched/);
      assert.throws(() => internals.removeMessage(heldHandle('w-blind')), /held:w-blind may already be stored, and its store can't be searched/);
    } finally { cm.queryMessages = query; unscan(); console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.content, m.landing]), [['w-blind', text('look left'), 'unknown']], 'still held, unedited');
    assert.deepEqual(copiesOf(framework, 'w-blind'), ['look left'], 'its copy unchanged');
    await framework.stop();
  });

  it("a module's query meets a held write whose landing is unknown, settled, as the one stored row it landed as", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    framework.getAgent('assistant')!.getContextManager().addMessage('Antra', text('look right'));
    heldAndStored(framework, 'w-q', 'look left');
    const error = console.error;
    console.error = () => {};
    let rows: string[];
    try {
      rows = internals.queryMessages({}).messages
        .filter((m) => m.content.some((b) => ['look left', 'look right'].includes((b as { text?: string }).text ?? '')))
        .map((m) => `${m.held ? 'held' : 'stored'}: ${m.content.map((b) => (b as { text?: string }).text).join('')}`);
    } finally { console.error = error; }
    assert.deepEqual(rows, ['stored: look right', 'stored: look left']);
    await framework.stop();
  });

  it("a stored row settles only the held write whose id it carries", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-theirs', 'look right');
    heldAndStored(framework, 'w-mine', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      queryMessages: (...args: unknown[]) => { messages: Array<{ id: string }> };
    };
    const [mine] = cm.queryMessages({ metadata: { deferredWriteId: 'w-mine' } }).messages;
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('search failed'); };
    const unscan = noScan(framework);
    const error = console.error;
    console.error = () => {};
    try { internals.getMessage(mine!.id); } finally { cm.queryMessages = query; unscan(); console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.landing]), [['w-theirs', 'unknown']], "the other write stays marked");
    await framework.stop();
  });

  it("a landed write's row, looked up by its handle while the store can be searched neither way, throws an error naming the query's error and the scan's", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage: (...args: unknown[]) => string;
      queryMessages: (...args: unknown[]) => unknown;
    };
    cm.addMessage('Antra', text('look left'), { deferredWriteId: 'w-landed-blind' });
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
    const unscan = noScan(framework);
    try {
      assert.throws(() => internals.getMessage(heldHandle('w-landed-blind')),
        /deferred write w-landed-blind: its query threw \(Blob not found: 0123\), and then scan failed/);
    } finally { cm.queryMessages = query; unscan(); }
    await framework.stop();
  });

  it("a module's getMessage, by a handle or by a stored id, settles a held write whose landing is unknown and answers its stored row", async () => {
    for (const by of ['handle', 'stored id'] as const) {
      // Each pass opens the test's one store again, so each takes its own id.
      const id = `w-get-${by === 'handle' ? 'h' : 's'}`;
      const framework = await createFramework();
      const internals = drainInternals(framework);
      heldAndStored(framework, id, 'look left');
      const [copy] = framework.getAgent('assistant')!.getContextManager()
        .queryMessages({ metadata: { deferredWriteId: id } } as never).messages;
      const error = console.error;
      console.error = () => {};
      let row: { held?: true; content: ContentBlock[] } | null;
      try { row = internals.getMessage(by === 'handle' ? heldHandle(id) : copy!.id); } finally { console.error = error; }
      assert.ok(row, `by its ${by}: a row`);
      assert.equal(row.held, undefined, `by its ${by}: the stored row`);
      assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], `by its ${by}: settled`);
      await framework.stop();
    }
  });

  it("a module's edit or removal by a stored id, while the store can't be searched, settles the write through the copy it names", async () => {
    for (const op of ['edit', 'remove'] as const) {
      const id = `w-named-${op}`;
      const framework = await createFramework();
      const internals = drainInternals(framework);
      heldAndStored(framework, id, 'look left');
      const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => { messages: Array<{ id: string }> } };
      const [copy] = cm.queryMessages({ metadata: { deferredWriteId: id } }).messages;
      const query = cm.queryMessages;
      cm.queryMessages = () => { throw new Error('search failed'); };
      const unscan = noScan(framework);
      const errors: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      try {
        if (op === 'edit') internals.editMessage(copy!.id, text('look up'));
        else internals.removeMessage(copy!.id);
      } finally { console.error = error; cm.queryMessages = query; unscan(); }
      assert.deepEqual(copiesOf(framework, id), op === 'edit' ? ['look up'] : [], `${op}: the row it names is changed`);
      assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], `${op}: its write is settled by the row`);
      assert.ok(errors.some((e) => e.includes(id) && e.includes('was found through the copy a module named')), errors.join('\n'));
      await framework.stop();
    }
  });

  it("a held write's lookup by its id falls back to a blob-free scan when context-manager's query throws, as a blob missing from another message makes it throw", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-blob', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
    const error = console.error;
    console.error = () => {};
    let settled: { held?: true; content: ContentBlock[] } | null;
    let again: { held?: true; content: ContentBlock[] } | null;
    try {
      settled = internals.getMessage(heldHandle('w-blob'));
      // Settled, the handle reaches its row by the same fallback (landedRow).
      again = internals.getMessage(heldHandle('w-blob'));
    } finally { cm.queryMessages = query; console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'found, and settled');
    assert.ok(settled && settled.held === undefined && again && again.held === undefined, 'its stored row, both times');
    assert.deepEqual(again?.content, text('look left'));
    assert.deepEqual(copiesOf(framework, 'w-blob'), ['look left'], 'stored once');
    await framework.stop();
  });

  it("a blob-free scan that comes back short answers that the store can't be searched, not that the write is absent", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-short', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      queryMessages: (...args: unknown[]) => unknown;
      getMessageWindow: (offset: number, limit: number, opts?: { resolveBlobs?: boolean }) => { messages: unknown[] };
    };
    const query = cm.queryMessages;
    const read = cm.getMessageWindow;
    cm.queryMessages = () => { throw new Error('search failed'); };
    cm.getMessageWindow = function (this: unknown, offset, limit, opts) {
      const window = read.call(this, offset, limit, opts);
      return opts?.resolveBlobs === false ? { ...window, messages: window.messages.slice(1) } : window;
    };
    const error = console.error;
    console.error = () => {};
    try { internals.getMessage(heldHandle('w-short')); } finally { cm.queryMessages = query; cm.getMessageWindow = read; console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.landing]), [['w-short', 'unknown']], 'still a doubt');
    assert.deepEqual(copiesOf(framework, 'w-short'), ['look left'], 'and stored once');
    await framework.stop();
  });

  it("a held write whose store can't be searched is said to be a doubt once, until a lookup of it succeeds", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-said', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const said = () => errors.filter((e) => e.includes('could not search') && e.includes('w-said')).length;
    try {
      cm.queryMessages = () => { throw new Error('search failed'); };
      const unscan = noScan(framework);
      internals.getMessage(heldHandle('w-said'));
      internals.getMessage(heldHandle('w-said'));
      internals.deferredWriteDone(framework.getAgent('assistant'), 'w-said', undefined);
      assert.equal(said(), 1, 'said once over three reads');
      cm.queryMessages = query;
      unscan();
    } finally { cm.queryMessages = query; console.error = error; }
    await framework.stop();
  });

  it("a held write whose found copy is a body stored in shards counts as written where its shards sit, and says how many landed, by the query or by the scan", async () => {
    for (const by of ['query', 'scan'] as const) {
      const id = `w-body-${by}`;
      const framework = await createFramework();
      const internals = drainInternals(framework);
      shardOn(framework, 'part one');
      const cm = framework.getAgent('assistant')!.getContextManager();
      cm.addMessage('Antra', [...text('part one'), ...text('part two')], { deferredWriteId: id } as never);
      internals.deferredMessages.push({ ...entry(id, 'part one'), content: [...text('part one'), ...text('part two')], landing: 'unknown' });
      const query = cm.queryMessages;
      if (by === 'scan') (cm as unknown as { queryMessages: () => never }).queryMessages = () => { throw new Error('Blob not found: 0123'); };
      const errors: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      try { internals.getMessage(heldHandle(id)); } finally { console.error = error; cm.queryMessages = query; }
      assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], `${by}: settled where it sits`);
      assert.deepEqual(copiesOf(framework, id), ['part one', 'part two'], `${by}: its shards stay`);
      assert.ok(errors.some((e) => e.includes(id) && e.includes('2 shards of its body were stored')), errors.join('\n'));
      await framework.stop();
    }
  });

  it("a held write settled through one stored shard of its body a module names says a shard of its body was stored", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    shardOn(framework, 'part one');
    const cm = framework.getAgent('assistant')!.getContextManager();
    cm.addMessage('Antra', [...text('part one'), ...text('part two')], { deferredWriteId: 'w-shard' } as never);
    internals.deferredMessages.push({ ...entry('w-shard', 'part one'), content: [...text('part one'), ...text('part two')], landing: 'unknown' });
    const [first] = cm.queryMessages({ metadata: { deferredWriteId: 'w-shard' } } as never).messages;
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try { internals.getMessage(first!.id); } finally { console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'settled by the row');
    assert.ok(errors.some((e) => e.includes('w-shard') && e.includes('a shard of its body was stored by an earlier write')), errors.join('\n'));
    await framework.stop();
  });

  it("one write's copy whose own blob can't be read leaves that write a doubt, and the others are answered", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-bad', 'look left');
    heldAndStored(framework, 'w-good', 'look right');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      queryMessages: (...args: unknown[]) => unknown;
      getMessageWindow: (offset: number, limit: number, opts?: { resolveBlobs?: boolean }) => { messages: Array<{ metadata?: { deferredWriteId?: string } }> };
    };
    const query = cm.queryMessages;
    const read = cm.getMessageWindow;
    cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
    cm.getMessageWindow = function (this: unknown, offset, limit, opts) {
      const window = read.call(this, offset, limit, opts);
      if (opts?.resolveBlobs !== false && window.messages.some((m) => m.metadata?.deferredWriteId === 'w-bad')) throw new Error('Blob not found: 4567');
      return window;
    };
    const error = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      internals.getMessage(heldHandle('w-good'));
      internals.getMessage(heldHandle('w-bad'));
    } finally { cm.queryMessages = query; cm.getMessageWindow = read; console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.landing]), [['w-bad', 'unknown']], 'only the write whose copy can\'t be read stays a doubt');
    assert.equal(errors.filter((e) => e.includes('found deferred write w-bad') && e.includes('could not read its stored copy') && e.includes('Blob not found: 4567')).length, 1, `said once over two reads:\n${errors.join('\n')}`);
    assert.ok(!errors.some((e) => e.includes('could not search')), 'the store itself could be searched');
    await framework.stop();
  });

  it("the blob-free scan reads past its first window, and a matching row's own image comes back resolved", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage: (...args: unknown[]) => string; queryMessages: (...args: unknown[]) => unknown };
    for (let i = 0; i < 520; i++) cm.addMessage('Antra', text(`filler ${i}`));
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } } as unknown as ContentBlock;
    cm.addMessage('Antra', [image], { deferredWriteId: 'w-far' });
    framework.getAgent('assistant')!.markContextShown();
    internals.deferredMessages.push({ ...entry('w-far', 'look left'), content: [image], landing: 'unknown' });
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
    const error = console.error;
    console.error = () => {};
    let row: { held?: true; content: ContentBlock[] } | null;
    try { row = internals.getMessage(heldHandle('w-far')); } finally { cm.queryMessages = query; console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'found past the first window, and settled');
    assert.equal(row?.held, undefined);
    assert.equal((row?.content[0] as { source?: { data?: string } } | undefined)?.source?.data, 'iVBORw0KGgo=', 'its image resolved');
    await framework.stop();
  });

  it("a lookup whose query works doesn't scan the branch", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-fast', 'look left');
    const unscan = noScan(framework);
    const error = console.error;
    console.error = () => {};
    try { internals.getMessage(heldHandle('w-fast')); } finally { console.error = error; unscan(); }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'settled by the query alone');
    await framework.stop();
  });

  it("a drain that can't search a marked write's store says it holds what's behind it once, until a lookup of it succeeds", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-twice-said', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const said = () => errors.filter((e) => e.includes('w-twice-said') && e.includes("still can't be found and read")).length;
    const searchSaid = () => errors.filter((e) => e.includes('could not search') && e.includes('w-twice-said')).length;
    try {
      cm.queryMessages = () => { throw new Error('search failed'); };
      let unscan = noScan(framework);
      internals.writeDrainedInOrder(internals.deferredMessages.splice(0), 'test', () => { throw new Error('written again'); });
      internals.writeDrainedInOrder(internals.deferredMessages.splice(0), 'test', () => { throw new Error('written again'); });
      assert.equal(said(), 1, 'said once over two drains');
      assert.equal(searchSaid(), 1);
      // A lookup succeeds, and a later failure is said again.
      cm.queryMessages = query; unscan();
      internals.getMessage(heldHandle('w-twice-said'));
      drainInternals(framework).deferredMessages.push({ ...entry('w-twice-said', 'look left'), landing: 'unknown' });
      cm.queryMessages = () => { throw new Error('search failed'); };
      unscan = noScan(framework);
      internals.getMessage(heldHandle('w-twice-said'));
      assert.equal(searchSaid(), 2, 'said again after a lookup succeeded');
      internals.writeDrainedInOrder(internals.deferredMessages.splice(0), 'test', () => { throw new Error('written again'); });
      assert.equal(said(), 2, "the drain's line too");
      unscan();
    } finally { cm.queryMessages = query; console.error = error; }
    await framework.stop();
  });

  it("a marked write the blob-free scan reads the whole branch without finding is written, once", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { addMessage: (...args: unknown[]) => string; queryMessages: (...args: unknown[]) => unknown };
    cm.addMessage('Antra', text('something else'));
    const msg = { ...entry('w-absent', 'look left'), landing: 'unknown' as const };
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      internals.writeDrainedInOrder([msg], 'test', (m) => cm.addMessage(m.participant, m.content, { deferredWriteId: m.id }));
    } finally { cm.queryMessages = query; console.error = error; }
    assert.deepEqual(copiesOf(framework, 'w-absent'), ['look left'], 'stored once');
    assert.ok(!errors.some((e) => e.includes('could not search')), errors.join('\n'));
    await framework.stop();
  });

  it("the scan reads its windows without blobs, so a blob it can't resolve elsewhere on the branch doesn't stop it", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-blobfree', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      queryMessages: (...args: unknown[]) => unknown;
      getMessageWindow: (offset: number, limit: number, opts?: { resolveBlobs?: boolean }) => unknown;
    };
    const query = cm.queryMessages;
    const read = cm.getMessageWindow;
    cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
    // Any read of more than one message with its blobs meets the missing one.
    cm.getMessageWindow = function (this: unknown, offset, limit, opts) {
      if (opts?.resolveBlobs !== false && limit > 1) throw new Error('Blob not found: 0123');
      return read.call(this, offset, limit, opts);
    };
    const error = console.error;
    console.error = () => {};
    try { internals.getMessage(heldHandle('w-blobfree')); } finally { cm.queryMessages = query; cm.getMessageWindow = read; console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'found, and settled');
    await framework.stop();
  });

  it("deferredWriteDone settles a held write whose landing is unknown, so a copy a request the agent had answered carried is done", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    const agent = framework.getAgent('assistant')!;
    heldAndStored(framework, 'w-wake', 'look left');
    heldAndStored(framework, 'w-other', 'look right');
    agent.markContextConsumed();
    agent.markAnswered(agent.getConsumedWatermark());
    const error = console.error;
    console.error = () => {};
    try {
      assert.equal(internals.deferredWriteDone(agent, 'w-wake', undefined), true);
    } finally { console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => [m.id, m.landing]), [['w-other', 'unknown']], 'only the write asked about is settled');
    await framework.stop();
  });

  it("the coalescer reads and removes a held write whose landing is unknown, once settled, as the stored placement it landed as", async () => {
    for (const shown of [false, true]) {
      // Each pass opens the test's one store again, so each takes its own id.
      const id = `w-co-${shown ? 's' : 'u'}`;
      const framework = await createFramework();
      const internals = drainInternals(framework);
      const agent = framework.getAgent('assistant')!;
      agent.markContextConsumed();
      if (!shown) agent.markContextShown();
      heldAndStored(framework, id, 'look left');
      if (shown) agent.markContextShown();
      const placement = { agent: 'assistant', deferredId: id };
      const error = console.error;
      console.error = () => {};
      try {
        assert.equal(internals.isUnreadPlacement(placement), true, 'unread, as its stored row is');
        assert.equal(internals.isUnreadPlacement(placement, 'shown'), !shown, `unshown as its stored row is (${shown ? 'shown' : 'not shown'})`);
        assert.equal(internals.removePlacement(placement), true);
      } finally { console.error = error; }
      assert.deepEqual(copiesOf(framework, id), [], 'its stored row goes');
      assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'and nothing is held');
      await framework.stop();
    }
  });

  it("the turn's draft notice settles the agent's held writes whose landing is unknown before it reads what they name", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework) as ReturnType<typeof drainInternals> & { noticeUnnoticedDrafts(agent: unknown): void };
    heldAndStored(framework, 'w-draft', 'look left');
    const error = console.error;
    console.error = () => {};
    try { internals.noticeUnnoticedDrafts(framework.getAgent('assistant')!); } finally { console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), []);
    await framework.stop();
  });

  it("the coalescer's removal settles a held write whose landing is unknown, and removes it as the stored placement it landed as", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    framework.getAgent('assistant')!.markContextConsumed();
    heldAndStored(framework, 'w-rmp', 'look left');
    const error = console.error;
    console.error = () => {};
    try {
      assert.equal(internals.removePlacement({ agent: 'assistant', deferredId: 'w-rmp' }), true);
    } finally { console.error = error; }
    assert.deepEqual(copiesOf(framework, 'w-rmp'), [], 'its stored row goes');
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), [], 'and nothing is held');
    await framework.stop();
  });

  it("the coalescer reads a held write whose landing is unknown as read and shown, and doesn't remove it, while its store can't be searched", async () => {
    const framework = await createFramework();
    const internals = drainInternals(framework);
    heldAndStored(framework, 'w-cblind', 'look left');
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { queryMessages: (...args: unknown[]) => unknown };
    const query = cm.queryMessages;
    cm.queryMessages = () => { throw new Error('search failed'); };
    const unscan = noScan(framework);
    const error = console.error;
    console.error = () => {};
    try {
      const placement = { agent: 'assistant', deferredId: 'w-cblind' };
      assert.equal(internals.isUnreadPlacement({ ...placement }), false, 'a doubt reads as read');
      assert.equal(internals.isUnreadPlacement({ ...placement }, 'shown'), false, 'and as shown');
      assert.equal(internals.removePlacement({ ...placement }), false, "and isn't removed");
    } finally { cm.queryMessages = query; unscan(); console.error = error; }
    assert.deepEqual(internals.deferredMessages.map((m) => m.id), ['w-cblind'], 'still held');
    assert.deepEqual(copiesOf(framework, 'w-cblind'), ['look left']);
    await framework.stop();
  });

  /** Shard a message whose first block is `marker` into one shard per block,
   *  as a strategy's ingress chunking does. */
  function shardOn(framework: AgentFramework, marker: string): void {
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as { strategy: Record<string, unknown> };
    cm.strategy.chunkIngressMessage = (_participant: string, content: ContentBlock[]) =>
      (content[0] as { text?: string } | undefined)?.text === marker
        ? { bodyGroupId: `body-${marker}`, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) }
        : null;
  }

  it('at a tool boundary, a sharded body whose write throws partway lands nothing: it waits for the turn end with what follows, and is stored whole then', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    shardOn(framework, 'part one');
    // The store's append throws after writing the first shard, and
    // context-manager removes that shard before the write throws.
    throwOnceFromShardAppend(framework, (shard) => shard.bodyGroupId === 'body-part one' && shard.shardIndex === 0);
    module.interjections = [
      { participant: 'Antra', content: [...text('part one'), ...text('part two')] },
      { participant: 'Antra', content: text('look right') },
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }
    assert.deepEqual(injected(), [], 'nothing of the body landed, so the boundary carried nothing');
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'assistant: Done.',
      'Antra: part one',
      'Antra: part two',
      'Antra: look right',
    ], 'the body, stored whole at the turn end, then what was queued behind it');
    assert.equal(internalsOf(framework).deferredMessages.length, 0, 'nothing is left in the queue');
    assert.ok(errors.some((e) => e.includes('could not be stored; it stays queued') && e.includes('the store failed partway through a body')), errors.join('\n'));
    await framework.stop();
  });

  it('at a tool boundary, when removing the shards of a body whose write threw fails too, the shards that stayed are carried as the next compile renders them', async () => {
    // Probe by Ansel-2428: the autobiographical strategy shards a long
    // message on ingest and joins a body's consecutive shards when it
    // compiles, so the boundary must carry what landed in that shape. The
    // body with an image between two texts fails here if the join changes
    // where it puts a non-text block, so the copy of the join can't drift.
    // A write that throws partway removes the shards it wrote, so shards
    // stay only when that removal fails as well, which the store's removal
    // is made to do here.
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long message from Antra.`).join(' ');
    const ofLong = (messages: Array<{ content: unknown }>) =>
      messages.filter((m) => JSON.stringify(m.content).includes('Sentence 0 '));
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const image = { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } } as ContentBlock;
    const cases: Array<{ name: string; content: ContentBlock[]; throwAt: number }> = [
      { name: 'text, throw at shard 1', content: text(long), throwAt: 1 },
      { name: 'text, throw at shard 2', content: text(long), throwAt: 2 },
      { name: 'text, throw at shard 3', content: text(long), throwAt: 3 },
      { name: 'a short text, an image, then the long text, throw at shard 1', content: [...text('Intro. '), image, ...text(long)], throwAt: 1 },
      { name: 'a short text, an image, then the long text, throw at shard 2', content: [...text('Intro. '), image, ...text(long)], throwAt: 2 },
    ];
    for (const [i, { name, content, throwAt }] of cases.entries()) {
      membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Moving.' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse(text('Done.')));
      const framework = await createFramework({
        storePath: join(tempDir, `shards-${i}.chronicle`),
        membrane: membrane.asMembrane(),
        agents: [{
          name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.',
          strategy: new AutobiographicalStrategy({
            adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
            targetChunkTokens: 50,
          }),
        } as never],
      });
      const cm = framework.getAgent('assistant')!.getContextManager();
      const internals = cm as unknown as {
        messageStore: { removeBodyGroup: (id: string) => void };
      };
      // The store's append throws after writing the throwAt-th shard.
      let shards = 0;
      throwOnceFromShardAppend(framework, () => ++shards === throwAt);
      internals.messageStore.removeBodyGroup = () => { throw new Error('removal failed'); };
      module.interjections = [{ participant: 'Antra', content }];
      const error = console.error;
      console.error = () => {};
      try {
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
        await framework.runUntilIdle();
        const landed = cm.getAllMessages().filter((m) => (m as { bodyGroupId?: string }).bodyGroupId);
        assert.equal(landed.length, throwAt, `${name}: ${throwAt} shards stayed, the removal having failed`);
        const injected = ofLong(membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? []);
        // The next turn's request is compiled from the store.
        membrane.pushResponse(createMockResponse(text('Okay.')));
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
        await framework.runUntilIdle();
        const next = ofLong(membrane.calls.at(-1)!.messages);
        assert.equal(injected.length, 1, `${name}: one message injected`);
        assert.equal(next.length, 1, `${name}: one message in the next request`);
        assert.deepEqual(injected[0]!.content, next[0]!.content, `${name}: the boundary carried what the next compile renders`);
      } finally {
        console.error = error;
        await framework.stop();
      }
    }
  });

  it('at a tool boundary, a queued write context-manager refuses as malformed is dropped, and what is queued behind it lands', async () => {
    // addMessage refuses such content before it's queued, so an entry like
    // this one reaches a drain only from a queue an earlier process
    // persisted: it's placed in the queue as boot's restore would place it,
    // ahead of the interjection by its seq.
    module.duringTool = () => {
      (module.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.push({
        id: 'persisted-before', seq: 0, participant: 'Antra', forAgent: 'assistant', heldAt: Date.now(),
        // A text block whose text isn't a string, which the store refuses.
        content: [{ type: 'text', text: 5 } as unknown as ContentBlock],
      });
    };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let framework: AgentFramework;
    try {
      framework = await runTurn('move', [{ participant: 'Antra', content: text('look right') }]);
    } finally { console.error = error; }
    assert.deepEqual(atBoundary(), ['Antra: look right', 'Antra: 5'], 'both were queued when the boundary drained');
    assert.deepEqual(injected(), ['Antra: look right'], 'what was queued behind it is carried');
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'Antra: look right',
      'assistant: Done.',
    ], 'stored where the stream carried it, and the refused write nowhere');
    assert.equal(internalsOf(framework).deferredMessages.length, 0, 'the refused write was not queued again');
    assert.ok(errors.some((e) => e.includes("was refused as malformed, so it's dropped rather than queued again") && e.includes('content[0]')), errors.join('\n'));
    await framework.stop();
  });

  it('at a tool boundary, a sharded body stored whole is carried as the next compile renders it', async () => {
    // A body the strategy shards on ingest is stored as several messages,
    // which a compile joins. A body of one text block reads the same as
    // given and joined; in the other cases the two differ, so the boundary
    // has to carry the join for the stream to carry what later requests do.
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long message from Antra.`).join(' ');
    const ofLong = (messages: Array<{ content: unknown }>) =>
      messages.filter((m) => JSON.stringify(m.content).includes('Sentence 0 '));
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const image = { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } } as ContentBlock;
    const cases: Array<{ name: string; content: ContentBlock[] }> = [
      { name: 'one long text block', content: text(long) },
      { name: 'a short text, then the long text', content: [...text('Intro. '), ...text(long)] },
      { name: 'the long text, then an image', content: [...text(long), image] },
      { name: 'a short text, an image, then the long text', content: [...text('Intro. '), image, ...text(long)] },
    ];
    // Every case is run, and those whose injection differs from the next
    // compile are named together.
    const differ: string[] = [];
    for (const [i, { name, content }] of cases.entries()) {
      membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Moving.' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse(text('Done.')));
      const framework = await createFramework({
        storePath: join(tempDir, `whole-${i}.chronicle`),
        membrane: membrane.asMembrane(),
        agents: [{
          name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.',
          strategy: new AutobiographicalStrategy({
            adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
            targetChunkTokens: 50,
          }),
        } as never],
      });
      const cm = framework.getAgent('assistant')!.getContextManager();
      module.interjections = [{ participant: 'Antra', content }, { participant: 'Antra', content: text('look right') }];
      try {
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
        await framework.runUntilIdle();
        const landed = cm.getAllMessages().filter((m) => (m as { bodyGroupId?: string }).bodyGroupId);
        assert.ok(landed.length > 1, `${name}: stored as ${landed.length} shards`);
        const injected = ofLong(membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? []);
        // The next turn's request is compiled from the store.
        membrane.pushResponse(createMockResponse(text('Okay.')));
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
        await framework.runUntilIdle();
        const next = ofLong(membrane.calls.at(-1)!.messages);
        assert.equal(injected.length, 1, `${name}: one message injected`);
        assert.equal(next.length, 1, `${name}: one message in the next request`);
        if (!isDeepStrictEqual(injected[0]!.content, next[0]!.content)) differ.push(name);
      } finally {
        await framework.stop();
      }
    }
    assert.deepEqual(differ, [], 'the boundary carried what the next compile renders');
  });

  it("a write that throws after it's stored, re-added from the queue, is weighed for its agent's open turn as a stored write is", async () => {
    const framework = await createFramework();
    throwOnceAfterStoring(framework, 'from beta');
    const internals = framework as unknown as {
      openLogical: Map<string, unknown>;
      readdDrained(entries: Array<{ id: string; seq: number; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>, where: string): unknown[];
    };
    // A logical turn still open between its streams, engaged with chan-beta:
    // no turn is alive, so no tool boundary weighs what is stored now, and
    // it's noted as one of the turn's arrivals.
    const open = { engaged: new Set([destinationKey(srv('chan-beta'))]), wasIn: [] as ChannelRef[], arrivals: [] as Array<{ messageId: string; channel: ChannelRef; addressed: boolean }> };
    internals.openLogical.set('assistant', open);
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let written: unknown[];
    try {
      written = internals.readdDrained(
        [{ id: 'w1', seq: 1, participant: 'Antra', content: text('from beta'), metadata: { channelId: 'chan-beta', serverId: 'srv' } }],
        'test flush',
      );
    } finally { console.error = error; }
    assert.ok(errors.some((e) => e.includes('test flush: deferred write')
      && e.includes("threw after it was stored; what was stored counts as written and isn't stored again")
      && e.includes('failed after storing')), errors.join('\n'));
    assert.equal(written.length, 1, 'it counts as written');
    const copies = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { deferredWriteId?: string } | undefined)?.deferredWriteId === 'w1');
    assert.equal(copies.length, 1, 'stored once');
    assert.deepEqual(open.arrivals, [{ messageId: copies[0]!.id, channel: srv('chan-beta'), addressed: false }], 'and noted as one of the open turn\'s arrivals');
    await framework.stop();
  });

  it("writes re-added from the queue are noted for an open turn in the order they landed, one that throws after it's stored among them", async () => {
    const framework = await createFramework();
    throwOnceAfterStoring(framework, 'from alpha');
    const agent = framework.getAgent('assistant')!;
    const internals = framework as unknown as {
      openLogical: Map<string, unknown>;
      readdDrained(entries: Array<{ id: string; seq: number; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>, where: string): unknown[];
      remainingArrival(agent: unknown, routing: unknown): ChannelRef | undefined;
    };
    // An open turn engaged with both channels, between its streams: the
    // earlier write throws after it's stored, and the later one lands.
    const open = { engaged: new Set([destinationKey(srv('chan-alpha')), destinationKey(srv('chan-beta'))]), wasIn: [] as ChannelRef[], arrivals: [] as Array<{ messageId: string; channel: ChannelRef; addressed: boolean }> };
    internals.openLogical.set('assistant', open);
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      internals.readdDrained([
        { id: 'w1', seq: 1, participant: 'Antra', content: text('from alpha'), metadata: { channelId: 'chan-alpha', serverId: 'srv' } },
        { id: 'w2', seq: 2, participant: 'Antra', content: text('from beta'), metadata: { channelId: 'chan-beta', serverId: 'srv' } },
      ], 'test flush');
    } finally { console.error = error; }
    assert.equal(errors.filter((e) => e.includes('threw after it was stored')).length, 1, errors.join('\n'));
    const idOf = (writeId: string) => agent.getContextManager().getAllMessages()
      .find((m) => (m.metadata as { deferredWriteId?: string } | undefined)?.deferredWriteId === writeId)!.id;
    assert.deepEqual(open.arrivals, [
      { messageId: idOf('w1'), channel: srv('chan-alpha'), addressed: false },
      { messageId: idOf('w2'), channel: srv('chan-beta'), addressed: false },
    ]);
    assert.deepEqual(internals.remainingArrival(agent, open), srv('chan-beta'), "the turn's newest arrival is the later write's");
    await framework.stop();
  });

  it('at the turn end, a write that throws after its message is stored is not queued again', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    throwOnceAfterStoring(framework, 'look left');
    // Held behind a message named as the agent, both wait for the turn end.
    module.interjections = [
      { participant: 'assistant', content: text('my own words') },
      { participant: 'Antra', content: text('look left') },
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }
    assert.equal(internalsOf(framework).deferredMessages.length, 0, 'nothing went back into the queue');
    assert.ok(errors.some((e) => e.includes("turn-end flush: deferred write")
      && e.includes("threw after it was stored; what was stored counts as written and isn't stored again")
      && e.includes('failed after storing')), errors.join('\n'));
    await framework.stop(); // stop() lands whatever is still queued

    const reopened = await createFramework();
    assert.deepEqual(windowOf(reopened).slice(2), [
      'user: <tool_result>',
      'assistant: Done.',
      'assistant: my own words',
      'Antra: look left',
    ], 'stored once, at the turn end');
    await reopened.stop();
  });

  it("a queued tool_use whose store throws keeps its tool_result from being stored alone", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.deferredWritesPersisted = true;
    // A pair queued for the agent, as puppetToolCall queues one behind a live turn.
    const queue = framework as unknown as {
      deferredSeq: number;
      deferredMessages: Array<{ id: string; seq: number; participant: string; content: ContentBlock[]; forAgent?: string }>;
    };
    queue.deferredMessages.push(
      { id: 'pair-use', seq: ++queue.deferredSeq, participant: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'robot--move', input: {} } as ContentBlock], forAgent: 'assistant' },
      { id: 'pair-result', seq: ++queue.deferredSeq, participant: 'user', content: [{ type: 'tool_result', toolUseId: 'p1', content: 'moved' } as ContentBlock], forAgent: 'assistant' },
    );
    const cm = framework.getAgent('assistant')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
      if ((args[1] as ContentBlock[]).some((b) => b.type === 'tool_use')) throw new Error('disk full');
      return add(...args);
    };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try { await framework.stop(); } finally { console.error = error; }
    assert.ok(errors.some((e) => e.includes('pair-use (assistant: tool_use)') && e.includes('disk full')), errors.join('\n'));
    assert.deepEqual(queue.deferredMessages.map((m) => m.id), ['pair-use', 'pair-result'], 'both stay queued, in order');

    const reopened = await createFramework();
    const window = windowOf(reopened);
    assert.deepEqual(window.slice(-2), ['assistant: <tool_use>', 'user: <tool_result>'], 'boot recovery stored the pair, in order');
    assert.equal(window.filter((line) => line === 'user: <tool_result>').length, 1, 'no tool_result was stored alone');
    await reopened.stop();
  });

  it("stop() stores what is deferred for an agent whose turn frame it doesn't wait for", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    // A frame stop() doesn't await, such as a turn started outside the
    // event loop, holds the agent's turn token.
    internals.activeTurnTokens.set('assistant', 1);
    assert.equal(internals.addMessage('Antra', text('still to land')), '', 'deferred: the turn is alive');
    await framework.stop();

    const reopened = await createFramework();
    assert.ok(windowOf(reopened).includes('Antra: still to land'), 'stored before the store closed');
    await reopened.stop();
  });

  for (const persisted of [false, true]) {
    it(`stop() stores several agents' deferred writes in the order they arrived (${persisted ? 'persisted' : 'memory-only'} queue)`, async () => {
      // Residents share one message slot, so the order writes arrived in is
      // the order every resident reads.
      const agents = [
        { name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.' },
        { name: 'scout', model: 'test-model', systemPrompt: 'You scout.' },
      ];
      const framework = await createFramework({ agents });
      const internals = internalsOf(framework);
      // A queue boot recovery restored, or one a quiesce persisted, stays
      // persisted until it empties.
      internals.deferredWritesPersisted = persisted;
      // Frames stop() doesn't wait for hold both agents' turns.
      internals.activeTurnTokens.set('assistant', 1);
      internals.activeTurnTokens.set('scout', 2);
      assert.equal(internals.addMessage('Antra', text('one')), '', 'deferred');
      assert.equal(internals.addMessage('Antra', text('two'), undefined, { forAgent: 'scout' }), '', 'deferred');
      assert.equal(internals.addMessage('Antra', text('three')), '', 'deferred');
      // A turn-end flush of the assistant's entries while a successor holds
      // its turn defers them again (the 2026-07-31 interleave). They keep
      // their places in arrival order.
      internals.readdDrained(internals.drainDeferredFor('assistant'), 'turn-end flush');
      assert.equal(internals.deferredMessages.length, 3, 'deferred again');
      await framework.stop();

      const reopened = await createFramework({ agents });
      assert.deepEqual(
        windowOf(reopened).filter((line) => /^Antra: (one|two|three)$/.test(line)),
        ['Antra: one', 'Antra: two', 'Antra: three'],
      );
      await reopened.stop();
    });
  }

  it('a turn waiting to retry when the framework stops gives up rather than compile again', { timeout: 60_000 }, async () => {
    let waiting!: () => void;
    const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
    const framework = await createFramework({
      errorPolicy: {
        maxRetries: 2,
        onInferenceError: (_error: Error, _agent: string, attempt: number) => {
          waiting();
          // Long enough that only stop() ends the wait.
          return attempt < 2 ? { retry: true as const, delayMs: 60_000 } : { retry: false as const };
        },
      },
    });
    const internals = internalsOf(framework);
    const agent = framework.getAgent('assistant')!;
    let compiles = 0;
    (agent as unknown as { startStreamWithInjections: () => Promise<never> }).startStreamWithInjections = async () => {
      compiles++;
      throw new Error('boom');
    };
    // A retry re-enters startAgentStream after its wait. stop() ends the
    // wait, and that cancels the retry before it re-enters: count re-entries,
    // so a retry that went ahead can't pass for one that was cancelled.
    const retries: Array<{ attempt: number; stopping: boolean }> = [];
    const frames = framework as unknown as {
      providerAdmissionClosed: boolean;
      startAgentStream(agent: unknown, trigger?: unknown, attempt?: number, held?: boolean): Promise<void>;
    };
    const startAgentStream = frames.startAgentStream.bind(framework);
    frames.startAgentStream = (a, trigger, attempt = 0, held = false) => {
      if (attempt > 0) retries.push({ attempt, stopping: frames.providerAdmissionClosed });
      return startAgentStream(a, trigger, attempt, held);
    };
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await inDelay;
    assert.equal(internals.addMessage('Antra', text('while it waits')), '', 'deferred: the turn is alive');
    const error = console.error;
    console.error = () => {};
    try { await framework.stop(); } finally { console.error = error; }
    assert.deepEqual(retries, [], 'stop() ended the wait, and the retry was cancelled before it re-entered');
    assert.equal(compiles, 1, 'the retry was not compiled');

    const reopened = await createFramework();
    assert.ok(windowOf(reopened).includes('Antra: while it waits'), 'what was deferred for it was stored');
    await reopened.stop();
  });

  it('a message stored straight into the context during a round, with nothing injected at the boundary, stays unread', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const agent = framework.getAgent('assistant')!;
    let bypassed = '';
    module.duringTool = () => {
      // A writer that bypasses deferral (an older route): the stream never carried it.
      bypassed = agent.getContextManager().addMessage('Antra', text('bypassed'));
    };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.deepEqual(injected(), []);
    const isUnread = (framework as unknown as {
      isUnreadStoredMessage: (a: typeof agent, id: string) => boolean;
    }).isUnreadStoredMessage.bind(framework);
    assert.equal(isUnread(agent, bypassed), true, 'a boundary that injected nothing marks nothing read');
    await framework.stop();
  });

  it("a compile's watermark never rolls back a mark made while it ran", async () => {
    const framework = await createFramework();
    const agent = framework.getAgent('assistant')!;
    const cm = agent.getContextManager();
    cm.addMessage('Antra', text('before'));
    const compile = cm.compile.bind(cm);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    (cm as unknown as { compile: typeof compile }).compile = async (...args) => {
      await released;
      return compile(...args);
    };
    const compiling = agent.compileContext();
    cm.addMessage('Antra', text('heard at a boundary'));
    agent.markContextConsumed();
    const marked = agent.getConsumedWatermark();
    release();
    await compiling;
    assert.deepEqual(agent.getConsumedWatermark(), marked, "the boundary's mark stands");
    (cm as unknown as { compile: typeof compile }).compile = compile;
    await agent.compileContext();
    assert.ok(agent.getConsumedWatermark()!.sequence >= marked!.sequence, 'a later compile still advances it');
    await framework.stop();
  });

  it("a held message waits out a successor turn's tool cycle, and lands once it is over", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const internals = internalsOf(framework) as ReturnType<typeof internalsOf> & { releasePrimaryProviderGate: (name: string) => void };
    const agent = framework.getAgent('assistant')!;
    module.duringTool = () => {
      assert.equal(internals.addMessage('assistant', text('my own words'), undefined, { forAgent: 'assistant' }), '', 'held');
    };
    // As the turn's stream completes, a successor turn takes the agent and is
    // mid tool cycle (the 2026-07-31 interleave): the stream generation, the
    // turn token and the cycle are the successor's when the first turn's
    // teardown flushes.
    let completed = false;
    const off = framework.onTrace((event) => {
      if ((event as { type: string }).type !== 'inference:completed') return;
      off();
      completed = true;
      (agent as unknown as { _streamId: number })._streamId++;
      internals.activeTurnTokens.set('assistant', 1_000_000);
      internals.pendingAssistantBlocks.set('assistant', otherCycle());
    });
    // The first turn's teardown releases its provider gate, then flushes,
    // synchronously: once the release is seen, the flush has run.
    let tornDown!: () => void;
    const teardown = new Promise<void>((resolve) => { tornDown = resolve; });
    const release = internals.releasePrimaryProviderGate.bind(framework);
    internals.releasePrimaryProviderGate = (name: string) => {
      release(name);
      if (completed && name === 'assistant') tornDown();
    };
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await teardown;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!windowOf(framework).includes('assistant: my own words'), "not stored inside the successor's cycle");
    assert.ok(internals.deferredMessages.some((m) => m.participant === 'assistant'), 'still queued');
    // The successor's cycle and turn end; what is still queued lands (here at stop's drain).
    internals.pendingAssistantBlocks.delete('assistant');
    internals.activeTurnTokens.delete('assistant');
    internals.activeStreams.delete('assistant');
    await framework.stop();
    const reopened = await createFramework();
    assert.equal(windowOf(reopened).at(-1), 'assistant: my own words');
    await reopened.stop();
  });

  it('a write coming back from the deferred queue re-defers while a turn is alive, tool_result or not', async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.activeTurnTokens.set('assistant', 1);
    try {
      // A queued pair's tool_result must follow its tool_use back into the
      // queue, or the pair splits (the turn-end flush can run after a
      // successor turn has started).
      const requeued = internals.addMessage('user', [
        { type: 'tool_result', toolUseId: 'p1', content: 'ok' } as ContentBlock,
      ], undefined, { fromQueue: { id: 'w1', seq: 41 } });
      assert.equal(requeued, '');
      // It goes back under its id and its place in arrival order, though this
      // queue is held in memory only.
      assert.ok(internals.deferredMessages.some((m) => m.id === 'w1' && m.seq === 41));
      // So does plain text.
      assert.equal(internals.addMessage('Antra', text('plain'), undefined, { fromQueue: { id: 'w2', seq: 42 } }), '');
      assert.ok(internals.deferredMessages.some((m) => m.id === 'w2' && m.seq === 42));
      // A fresh tool_result write keeps landing as before.
      const fresh = internals.addMessage('user', [
        { type: 'tool_result', toolUseId: 'p2', content: 'ok' } as ContentBlock,
      ]);
      assert.notEqual(fresh, '');
    } finally {
      internals.activeTurnTokens.delete('assistant');
    }
    await framework.stop();
  });

  // The coalescing assembly writes past its agent's deferral, in the window
  // the turn-start flush writes in (bypassDeferralFor). What was deferred
  // for the agent before such a write came first, so it lands first.
  const textsOf = (entries: Array<{ content: ContentBlock[] }>): string[] =>
    entries.map((m) => m.content.map((b) => (b as { text?: string }).text ?? `<${b.type}>`).join(' '));

  it("a write assembled for a turn's start lands after what was deferred for its agent before it, and acknowledges it", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.deferredWritesPersisted = true;
    internals.activeTurnTokens.set('assistant', 1);
    internals.assembling.add('assistant');
    try {
      assert.equal(internals.addMessage('Antra', text('first')), '', 'deferred: the turn is alive');
      // Another target's entry: it neither flushes nor holds this agent's write.
      internals.deferredMessages.push({ id: 'ghost-1', seq: 0, participant: 'Antra', forAgent: 'ghost', content: text('elsewhere') });
      const placement: { agent?: string; messageId?: string; deferredId?: string } = {};
      const id = internals.addMessage('Antra', text('second'), undefined, { bypassDeferralFor: 'assistant', placement });
      assert.notEqual(id, '', 'the assembled write is stored');
      assert.equal(placement.deferredId, undefined);
      assert.deepEqual(windowOf(framework).slice(-2), ['Antra: first', 'Antra: second'], 'what was deferred first lands first');
      assert.deepEqual(textsOf(internals.deferredMessages), ['elsewhere'], "only the other target's entry is still queued");
      assert.deepEqual(internals.unackedDeferredWrites, [], 'what the flush stored is acknowledged');
    } finally {
      internals.assembling.delete('assistant');
      internals.activeTurnTokens.delete('assistant');
      internals.deferredMessages.splice(0);
    }
    await framework.stop();
  });

  it("a write naming its agent's assembly after that assembly has ended is deferred like any write during the turn", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.activeTurnTokens.set('assistant', 1);
    try {
      internals.addMessage('Antra', text('first'));
      // An assembly that throws can leave a render running, which delivers
      // after the window has closed.
      const placement: { agent?: string; messageId?: string; deferredId?: string } = {};
      assert.equal(internals.addMessage('Antra', text('late'), undefined, { bypassDeferralFor: 'assistant', placement }), '', 'deferred');
      assert.ok(placement.deferredId);
      assert.deepEqual(textsOf([...internals.deferredMessages].sort((a, b) => a.seq - b.seq)), ['first', 'late'], 'nothing was flushed into the live turn');
      assert.ok(!windowOf(framework).some((line) => line === 'Antra: first' || line === 'Antra: late'));
    } finally {
      internals.activeTurnTokens.delete('assistant');
    }
    await framework.stop();
  });

  it("a write assembled for a turn's start waits behind a deferred write that can't be stored, and lands after it", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    let failing = true;
    (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
      if (failing && (args[1] as Array<{ text?: string }>).some((b) => b.text === 'first')) throw new Error('disk full');
      return add(...args);
    };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    internals.activeTurnTokens.set('assistant', 1);
    internals.assembling.add('assistant');
    try {
      internals.addMessage('Antra', text('first'));
      const placement: { agent?: string; messageId?: string; deferredId?: string } = {};
      assert.equal(internals.addMessage('Antra', text('second'), undefined, { bypassDeferralFor: 'assistant', placement }), '', 'deferred');
      assert.ok(placement.deferredId, 'its placement names the queued entry');
      assert.ok(errors.some((e) => e.includes('assembly flush for assistant') && e.includes('disk full')), errors.join('\n'));
      assert.deepEqual(textsOf([...internals.deferredMessages].sort((a, b) => a.seq - b.seq)), ['first', 'second'], 'it waits behind the held write');
      assert.ok(!windowOf(framework).includes('Antra: second'));
    } finally {
      internals.assembling.delete('assistant');
      internals.activeTurnTokens.delete('assistant');
      console.error = error;
    }
    failing = false;
    internals.readdDrained(internals.drainDeferredFor('assistant'), 'the turn ends');
    internals.ackDeferredWrites();
    assert.deepEqual(windowOf(framework).slice(-2), ['Antra: first', 'Antra: second'], 'both land, in the order they arrived');
    await framework.stop();
  });

  it("a write assembled for a turn's start waits behind what is queued for its agent while the host is quiesced", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.activeTurnTokens.set('assistant', 1);
    internals.assembling.add('assistant');
    try {
      internals.addMessage('Antra', text('first'));
      // A quiesce that begins while the turn's assembly awaits a render lets
      // the turn drain: what is queued waits for resume(), and so does what
      // the assembly writes after it.
      internals.quiesced = true;
      const placement: { agent?: string; messageId?: string; deferredId?: string } = {};
      assert.equal(internals.addMessage('Antra', text('second'), undefined, { bypassDeferralFor: 'assistant', placement }), '', 'deferred');
      assert.ok(placement.deferredId);
      assert.deepEqual(textsOf([...internals.deferredMessages].sort((a, b) => a.seq - b.seq)), ['first', 'second']);
      assert.ok(!windowOf(framework).some((line) => line === 'Antra: first' || line === 'Antra: second'), 'nothing queued is written while quiesced');
    } finally {
      internals.quiesced = false;
      internals.assembling.delete('assistant');
      internals.activeTurnTokens.delete('assistant');
    }
    internals.readdDrained(internals.drainDeferredFor('assistant'), 'resume');
    internals.ackDeferredWrites();
    assert.deepEqual(windowOf(framework).slice(-2), ['Antra: first', 'Antra: second']);
    await framework.stop();
  });

  it("a write assembled for a turn's start is stored while the host is quiesced when nothing is queued for its agent", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.activeTurnTokens.set('assistant', 1);
    internals.assembling.add('assistant');
    internals.quiesced = true;
    try {
      // Another target's entry doesn't count as queued for this agent.
      internals.deferredMessages.push({ id: 'ghost-1', seq: 0, participant: 'Antra', forAgent: 'ghost', content: text('elsewhere') });
      assert.notEqual(internals.addMessage('Antra', text('assembled'), undefined, { bypassDeferralFor: 'assistant' }), '', 'stored, as the turn\'s own input');
      assert.deepEqual(windowOf(framework).slice(-1), ['Antra: assembled']);
      assert.deepEqual(textsOf(internals.deferredMessages), ['elsewhere'], 'and nothing of the queue was written');
    } finally {
      internals.quiesced = false;
      internals.assembling.delete('assistant');
      internals.activeTurnTokens.delete('assistant');
      internals.deferredMessages.splice(0);
    }
    await framework.stop();
  });

  it("stop()'s drain, which writes past each agent's deferral, keeps its entries un-acked until it has stored them", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.deferredWritesPersisted = true;
    internals.activeTurnTokens.set('assistant', 1);
    internals.addMessage('Antra', text('first'));
    internals.addMessage('Antra', text('second'));
    internals.activeTurnTokens.delete('assistant');
    // An entry for a target that isn't registered stays queued through the
    // drain, so the queue isn't empty while the drain writes.
    internals.deferredMessages.push({ id: 'ghost-1', seq: 0, participant: 'Antra', forAgent: 'ghost', content: text('elsewhere') });
    const cm = framework.getAgent('assistant')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    const unackedAt: Record<string, string[]> = {};
    (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
      const written = (args[1] as Array<{ text?: string }>).map((b) => b.text).join(' ');
      unackedAt[written] = internals.unackedDeferredWrites.map((m) => m.id);
      return add(...args);
    };
    const secondId = internals.deferredMessages.find((m) => textsOf([m])[0] === 'second')!.id;
    const error = console.error;
    console.error = () => {};
    try { await framework.stop(); } finally { console.error = error; }
    assert.ok(unackedAt.first?.includes(secondId), `'second' is still un-acked while 'first' is stored: ${JSON.stringify(unackedAt)}`);
    assert.ok(unackedAt.second?.includes(secondId), `and while 'second' itself is stored: ${JSON.stringify(unackedAt)}`);
  });
});
