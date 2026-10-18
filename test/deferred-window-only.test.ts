/**
 * What the window stores mid-turn is what the live stream carried.
 *
 * A message deferred during a turn is stored at the agent's next tool
 * boundary and injected into the resumed stream (hear-while-acting), so the
 * next compile's prefix is the request the turn's later replies were minted
 * under. Two kinds of message can't be injected: one carrying tool blocks
 * (it would break the tool cycle membrane enforces) and one named as the
 * agent itself (a prefill). Those wait for the turn's end, and so does
 * everything queued behind them, so the queue's order holds. A provider that
 * binds signed thinking to its prefix (context-manager #155) refuses a reply
 * whose stored prefix holds a message its request didn't.
 *
 * A message the stream carried has been read: RFC-006's consumed watermark
 * covers it, so a coalesced replacement can no longer remove it. Only a
 * stream that declares it carries injected messages (membrane's native
 * path) is known to have carried them. One that declares it can't (membrane's
 * XML prefill path) gets none, and what is queued waits for the turn's end.
 * One that doesn't say (membrane 0.5.87) gets them, and they stay unread.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

interface Interjection {
  participant: string;
  content: ContentBlock[];
}

/** The installed context-manager's version. Its package's exports don't
 *  include package.json, so walk up from its entry point to it. */
function contextManagerVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve('@animalabs/context-manager')));
  for (;;) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@animalabs/context-manager' && pkg.version) return pkg.version;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error("can't find @animalabs/context-manager's package.json");
    dir = up;
  }
}

/** Set, with the reason, when shards can't land before a throw: from
 *  context-manager 0.15, a sharded write that fails partway removes what it
 *  wrote. The tests of carrying landed shards pin 0.14.x. */
const NO_SHARDS_LAND_BEFORE_A_THROW = (() => {
  const version = contextManagerVersion();
  const [major, minor] = version.split('.').map(Number);
  return major! > 0 || minor! >= 15
    ? `context-manager ${version} removes what a sharded write that fails partway wrote, so no shards land before a throw`
    : false;
})();

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
    membrane.supportsInjectedMessages = true; // membrane's native path declares it
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.deepEqual(injected(), ['Antra: look left']);
    assert.equal(unread(framework, 'look left'), false, 'a coalesced replacement must not remove what the agent heard');
    await framework.stop();
  });

  it('a stream that doesn\'t say whether it carries injections gets them, and they stay unread', async () => {
    // membrane 0.5.87 doesn't declare it, on either path, and its XML path
    // drops what's injected: marked read there, a message the agent never
    // saw could no longer be replaced.
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.deepEqual(injected(), ['Antra: look left']);
    assert.deepEqual(windowOf(framework).slice(2), ['user: <tool_result>', 'Antra: look left', 'assistant: Done.']);
    assert.equal(unread(framework, 'look left'), true);
    await framework.stop();
  });

  it('a stream that can\'t carry injections gets none: what is queued waits for the turn to end', async () => {
    membrane.supportsInjectedMessages = false; // membrane's XML prefill path declares it
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.deepEqual(atBoundary(), undefined, 'the boundary drained nothing');
    assert.equal(membrane.lastStream!.receivedToolResultOptions[0], undefined, 'nothing was injected');
    assert.deepEqual(windowOf(framework).slice(2), ['user: <tool_result>', 'assistant: Done.', 'Antra: look left']);
    assert.equal(unread(framework, 'look left'), true);
    await framework.stop();
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
      deferredMessages: Array<{ id: string; seq: number; participant: string }>;
      deferredWritesPersisted: boolean;
      drainDeferredFor: (name: string, stopAt?: unknown) => unknown[];
      readdDrained: (entries: unknown[], where: string) => unknown[];
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string; fromQueue?: { id: string; seq: number } }): string;
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

  /** The strategy's onNewMessage throws once, synchronously, for the record
   *  with this text. The manager's own store listener calls it as each record
   *  is written, so the write throws though its message is stored. A host's
   *  onMessage listener can't do this on context-manager 0.15, which logs its
   *  throw and lets the write stand. */
  function throwOnceAfterStoring(framework: AgentFramework, textOf: string): void {
    const strategy = (framework.getAgent('assistant')!.getContextManager() as unknown as {
      strategy: { onNewMessage?: (message: { content: ContentBlock[] }, ctx: unknown) => Promise<void> };
    }).strategy;
    const onNewMessage = strategy.onNewMessage;
    let thrown = false;
    strategy.onNewMessage = function (this: unknown, message, ctx) {
      if (!thrown && message.content.some((b) => (b as { text?: string }).text === textOf)) {
        thrown = true;
        throw new Error('strategy failed');
      }
      return onNewMessage ? onNewMessage.call(this, message, ctx) : Promise.resolve();
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
      && e.includes('strategy failed')), errors.join('\n'));
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

  it("at a tool boundary, a sharded body that throws after its first shard: what landed is carried and counts as written, and the rest isn't stored", { skip: NO_SHARDS_LAND_BEFORE_A_THROW }, async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    shardOn(framework, 'part one');
    // The strategy throws on the first shard's add, which stops the append
    // loop before the second shard.
    throwOnceAfterStoring(framework, 'part one');
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
    assert.deepEqual(injected(), ['Antra: part one', 'Antra: look right'], 'the request carries what the store holds');
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'Antra: part one',
      'Antra: look right',
      'assistant: Done.',
    ], 'the first shard alone, stored once');
    assert.equal(internalsOf(framework).deferredMessages.length, 0, 'nothing went back into the queue');
    assert.ok(errors.some((e) => e.includes("threw after 1 shard of its body was stored; what was stored counts as written and isn't stored again")
      && e.includes('strategy failed')), errors.join('\n'));
    await framework.stop();
  });

  it('at a tool boundary, the shards that landed before a throw are carried as the next compile renders them', { skip: NO_SHARDS_LAND_BEFORE_A_THROW }, async () => {
    // Probe by Ansel-2428: the autobiographical strategy shards a long
    // message on ingest and joins a body's consecutive shards when it
    // compiles, so the boundary must carry what landed in that shape. The
    // body with an image between two texts fails here if the join changes
    // where it puts a non-text block, so the copy of the join can't drift.
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long message from Antra.`).join(' ');
    const ofLong = (messages: Array<{ content: unknown }>) =>
      messages.filter((m) => JSON.stringify(m.content).includes('Sentence 0 '));
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const image = { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } } as ContentBlock;
    const cases: Array<{ name: string; content: ContentBlock[]; throwAt: number }> = [
      { name: 'text, throw at shard 2', content: text(long), throwAt: 2 },
      { name: 'text, throw at shard 3', content: text(long), throwAt: 3 },
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
      let shards = 0;
      cm.onMessage((event) => {
        if (event.type !== 'add' || !(event.message as { bodyGroupId?: string }).bodyGroupId) return;
        if (++shards === throwAt) throw new Error('listener failed');
      });
      module.interjections = [{ participant: 'Antra', content }];
      const error = console.error;
      console.error = () => {};
      try {
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
        await framework.runUntilIdle();
        const landed = cm.getAllMessages().filter((m) => (m as { bodyGroupId?: string }).bodyGroupId);
        assert.equal(landed.length, throwAt, `${name}: ${throwAt} shards landed before the throw stopped the body`);
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

  it("a write that throws after it's stored, re-added from the queue, is weighed for its agent's open turn as a stored write is", async () => {
    const framework = await createFramework();
    throwOnceAfterStoring(framework, 'from beta');
    const internals = framework as unknown as {
      openLogical: Map<string, unknown>;
      readdDrained(entries: Array<{ id: string; seq: number; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>, where: string): unknown[];
    };
    // A logical turn still open between its streams, engaged with chan-beta:
    // no turn is alive, so no tool boundary weighs what is stored now, and
    // addMessage notes it as one of the turn's arrivals.
    const open = { engaged: new Set(['chan-beta']), arrivals: [] as Array<{ messageId: string; channelId: string }> };
    internals.openLogical.set('assistant', open);
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let written: unknown[];
    try {
      written = internals.readdDrained(
        [{ id: 'w1', seq: 1, participant: 'Antra', content: text('from beta'), metadata: { channelId: 'chan-beta' } }],
        'test flush',
      );
    } finally { console.error = error; }
    assert.ok(errors.some((e) => e.includes('test flush: deferred write')
      && e.includes("threw after it was stored; what was stored counts as written and isn't stored again")
      && e.includes('strategy failed')), errors.join('\n'));
    assert.equal(written.length, 1, 'it counts as written');
    const copies = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { deferredWriteId?: string } | undefined)?.deferredWriteId === 'w1');
    assert.equal(copies.length, 1, 'stored once');
    assert.deepEqual(open.arrivals, [{ messageId: copies[0]!.id, channelId: 'chan-beta' }], 'and noted as one of the open turn\'s arrivals');
    await framework.stop();
  });

  it("writes re-added from the queue are noted for an open turn in the order they landed, one that throws after it's stored among them", async () => {
    const framework = await createFramework();
    throwOnceAfterStoring(framework, 'from alpha');
    const agent = framework.getAgent('assistant')!;
    const internals = framework as unknown as {
      openLogical: Map<string, unknown>;
      readdDrained(entries: Array<{ id: string; seq: number; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>, where: string): unknown[];
      remainingArrival(agent: unknown, routing: unknown): string | undefined;
    };
    // An open turn engaged with both channels, between its streams: the
    // earlier write throws after it's stored, and the later one lands.
    const open = { engaged: new Set(['chan-alpha', 'chan-beta']), arrivals: [] as Array<{ messageId: string; channelId: string }> };
    internals.openLogical.set('assistant', open);
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      internals.readdDrained([
        { id: 'w1', seq: 1, participant: 'Antra', content: text('from alpha'), metadata: { channelId: 'chan-alpha' } },
        { id: 'w2', seq: 2, participant: 'Antra', content: text('from beta'), metadata: { channelId: 'chan-beta' } },
      ], 'test flush');
    } finally { console.error = error; }
    assert.equal(errors.filter((e) => e.includes('threw after it was stored')).length, 1, errors.join('\n'));
    const idOf = (writeId: string) => agent.getContextManager().getAllMessages()
      .find((m) => (m.metadata as { deferredWriteId?: string } | undefined)?.deferredWriteId === writeId)!.id;
    assert.deepEqual(open.arrivals, [
      { messageId: idOf('w1'), channelId: 'chan-alpha' },
      { messageId: idOf('w2'), channelId: 'chan-beta' },
    ]);
    assert.equal(internals.remainingArrival(agent, open), 'chan-beta', "the turn's newest arrival is the later write's");
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
      && e.includes('strategy failed')), errors.join('\n'));
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
});
