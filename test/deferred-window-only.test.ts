/**
 * What the window holds mid-turn is what the live stream carried (#291's
 * presentation index).
 *
 * A write is stored at once, whatever its agent's turn, and enters the
 * agent's window at the agent's next presentation point. One that arrives
 * during a round enters at the agent's next tool boundary and is injected
 * into the resumed stream (hear-while-acting), so the next compile's prefix
 * is the request the turn's later replies were minted under. Two kinds of
 * message can't be injected: one carrying tool blocks (it would break the
 * tool cycle membrane enforces) and one named as the agent itself (a
 * prefill). Those wait for the turn's end, and so does everything that
 * arrived behind them, so the window keeps the order they were stored in.
 * A provider that binds signed thinking to its prefix (context-manager
 * #155) refuses a later request that replays the signed thinking of a reply
 * whose window holds a message its request didn't.
 *
 * A message a stream declares it carried has been read: RFC-006's consumed
 * watermark covers it, so a coalesced replacement can no longer remove it.
 * Only a stream that declares it carries injected messages (membrane's native
 * path, from 0.6.0) is known to have carried them. One that declares it can't
 * (membrane's XML prefill path, from 0.6.0) gets none, and what arrived
 * waits for the turn's end. One that doesn't say (membrane 0.5.x) gets them,
 * and they stay unread, though its native path carries them.
 *
 * Before #291 these writes waited in a deferred queue and were stored at
 * the boundary that drained them; the queue's own mechanics (its drain, its
 * cuts and read-backs, its persistence and stop()'s drain) went with it, and
 * an earlier release's queue is imported at boot (deferred-import-boot).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { markAtOrAfter } from '../src/read-marks.js';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

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
    // return only once the last is stored, so the tool-result boundary meets
    // them all in the store and out of the window (bounded: a run that never
    // stores them fails).
    const last = pending.at(-1);
    if (last) {
      const cm = this.framework!.getAgent('assistant')!.getContextManager();
      const stored = () => cm.getAllMessages()
        .some((m) => m.participant === last.participant && isDeepStrictEqual(m.content, last.content));
      const end = Date.now() + 5000;
      while (!stored()) {
        if (Date.now() > end) throw new Error(`the last of ${pending.length} interjection(s) was not stored`);
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

/** One line per message: participant, then its text or block types. */
const lineOf = (m: { participant: string; content: ContentBlock[] }): string =>
  `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`;

/** The agent's window, in the order its requests carry it: one line per row. */
function windowOf(framework: AgentFramework): string[] {
  return framework.getAgent('assistant')!.getContextManager().getPresentedMessages().map(lineOf);
}

/** The agent's store, in the order the rows were stored: one line per row. */
function recordOf(framework: AgentFramework): string[] {
  return framework.getAgent('assistant')!.getContextManager().getAllMessages().map(lineOf);
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
  async function runTurn(tool: 'move' | 'halt', interjections: Interjection[]): Promise<AgentFramework> {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: `robot--${tool}`, input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    module.interjections = interjections;
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    return framework;
  }

  /** Whether each line was stored before the round's results: during the round, as it arrived. */
  function storedDuringTheRound(framework: AgentFramework, lines: string[]): void {
    const record = recordOf(framework);
    const results = record.indexOf('user: <tool_result>');
    for (const line of lines) {
      const at = record.indexOf(line);
      assert.ok(at >= 0 && at < results, `'${line}' was stored as it arrived, before the round's results: ${JSON.stringify(record)}`);
    }
  }

  function injected(): string[] {
    const options = membrane.lastStream!.receivedToolResultOptions[0];
    return (options?.injectedMessages ?? []).map((m) =>
      `${m.participant}: ${(m.content as Array<{ text?: string }>).map((b) => b.text).join(' ')}`);
  }

  it('a message named as the agent waits for the turn to end, after its last round', async () => {
    const framework = await runTurn('move', [{ participant: 'assistant', content: text('my own words') }]);
    storedDuringTheRound(framework, ['assistant: my own words']);
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

  it('what arrived behind a held message waits with it, in order', async () => {
    const framework = await runTurn('move', [
      { participant: 'assistant', content: text('my own words') },
      { participant: 'Antra', content: text('look left') },
    ]);
    storedDuringTheRound(framework, ['assistant: my own words', 'Antra: look left']);
    assert.deepEqual(injected(), []);
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'assistant: Done.',
      'assistant: my own words',
      'Antra: look left',
    ]);
    await framework.stop();
  });

  it('what arrived before a held message is still heard at the boundary', async () => {
    const framework = await runTurn('move', [
      { participant: 'Antra', content: text('look left') },
      { participant: 'assistant', content: text('my own words') },
    ]);
    storedDuringTheRound(framework, ['Antra: look left', 'assistant: my own words']);
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

  it('a stream that can\'t carry injections gets none: what arrived waits for the turn to end', async () => {
    membrane.supportsInjectedMessages = false; // membrane's XML prefill path declares it, from 0.6.0
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.equal(membrane.lastStream!.receivedToolResultOptions[0], undefined, 'nothing was injected');
    assert.deepEqual(windowOf(framework).slice(2), ['user: <tool_result>', 'assistant: Done.', 'Antra: look left']);
    assert.equal(unread(framework, 'look left'), true);
    await framework.stop();
  });

  it('a message that enters the window at a boundary that ends the turn was never carried, and stays unread', async () => {
    const framework = await runTurn('halt', [{ participant: 'Antra', content: text('too late') }]);
    assert.equal(unread(framework, 'too late'), true);
    await framework.stop();
  });

  /** The framework's own record of turns and tool cycles. */
  function internalsOf(framework: AgentFramework) {
    return framework as unknown as {
      pendingAssistantBlocks: Map<string, ContentBlock[]>;
      activeTurnTokens: Map<string, number>;
      activeStreams: Map<string, unknown>;
      presentAtEndOf(agent: unknown): void;
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: {
        forAgent?: string;
        placement?: { agent?: string; messageId?: string; presented?: false };
      }): string;
    };
  }
  const otherCycle = (): ContentBlock[] => [{ type: 'tool_use', id: 'b1', name: 'robot--move', input: {} } as ContentBlock];
  const statusOf = (framework: AgentFramework, id: string) =>
    framework.getAgent('assistant')!.getContextManager().windowStatusOf(id as never);

  it('a message held for the turn\'s end enters then, while another agent\'s tool cycle is pending', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const internals = internalsOf(framework);
    let held = '';
    module.duringTool = () => {
      // Another agent is mid tool cycle when this turn ends, and a write
      // named as this agent (held: it can't join the live stream) waits.
      internals.pendingAssistantBlocks.set('builder', otherCycle());
      held = internals.addMessage('assistant', text('my own words'), undefined, { forAgent: 'assistant' });
      assert.notEqual(held, '', 'stored at once');
      assert.equal(statusOf(framework, held), 'out', 'and out of the window of the live turn');
    };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    assert.ok(internals.pendingAssistantBlocks.has('builder'), "the other agent's cycle is still pending");
    assert.deepEqual(windowOf(framework).slice(-2), ['assistant: Done.', 'assistant: my own words']);
    internals.pendingAssistantBlocks.delete('builder');
    await framework.stop();
  });

  it("a write stays out of the window for its target's own turn and tool cycle, not another agent's, primary-bound or targeted", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    internals.pendingAssistantBlocks.set('builder', otherCycle());
    try {
      const primaryBound: { presented?: false } = {};
      const first = internals.addMessage('Antra', text('primary-bound'), undefined, { placement: primaryBound });
      const targeted: { presented?: false } = {};
      const second = internals.addMessage('Antra', text('targeted'), undefined, { forAgent: 'assistant', placement: targeted });
      assert.deepEqual([primaryBound.presented, targeted.presented], [undefined, undefined], 'the primary is idle');
      assert.deepEqual([statusOf(framework, first), statusOf(framework, second)], ['in', 'in'], 'presented at once');
      internals.pendingAssistantBlocks.set('assistant', otherCycle());
      const own: { presented?: false } = {};
      const third = internals.addMessage('Antra', text('in its own cycle'), undefined, { placement: own });
      assert.notEqual(third, '', 'stored at once');
      assert.equal(own.presented, false, "the primary's own cycle is pending");
      assert.equal(statusOf(framework, third), 'out');
      const ownTargeted: { presented?: false } = {};
      const fourth = internals.addMessage('Antra', text('targeted in its own cycle'), undefined, { forAgent: 'assistant', placement: ownTargeted });
      assert.equal(ownTargeted.presented, false, 'a write targeted at it waits for its own cycle too');
      assert.equal(statusOf(framework, fourth), 'out');
      internals.pendingAssistantBlocks.delete('assistant');
      internals.activeTurnTokens.set('assistant', -1);
      const turnBound: { presented?: false } = {};
      const fifth = internals.addMessage('Antra', text('primary-bound in its own turn'), undefined, { placement: turnBound });
      const turnTargeted: { presented?: false } = {};
      const sixth = internals.addMessage('Antra', text('targeted in its own turn'), undefined, { forAgent: 'assistant', placement: turnTargeted });
      assert.deepEqual([turnBound.presented, turnTargeted.presented], [false, false], "the primary's own turn is alive");
      assert.deepEqual([statusOf(framework, fifth), statusOf(framework, sixth)], ['out', 'out']);
    } finally {
      internals.pendingAssistantBlocks.delete('builder');
      internals.pendingAssistantBlocks.delete('assistant');
      internals.activeTurnTokens.delete('assistant');
    }
    await framework.stop();
  });

  it("the puppet's end presents what arrived behind it while another agent's tool cycle is pending", async () => {
    const framework = await createFramework();
    const internals = internalsOf(framework);
    module.duringTool = () => {
      internals.pendingAssistantBlocks.set('builder', otherCycle());
      const id = internals.addMessage('Antra', text('while puppeted'));
      assert.notEqual(id, '', 'stored at once');
      assert.equal(statusOf(framework, id), 'out', 'out of the window while the puppet holds the agent');
    };
    try {
      await framework.puppetToolCall('assistant', 'robot--move', {});
      assert.deepEqual(windowOf(framework).slice(-3), ['assistant: <tool_use>', 'user: <tool_result>', 'Antra: while puppeted']);
    } finally {
      internals.pendingAssistantBlocks.delete('builder');
    }
    await framework.stop();
  });

  it('a turn mid-compile when the framework stops never starts a stream, and what arrived for it is stored', async () => {
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
    assert.notEqual(internals.addMessage('Antra', text('late word')), '', 'stored at once, though the turn is alive');
    const stopped = framework.stop();
    release();
    await stopped;
    assert.equal(internals.activeStreams.size, 0, 'no stream outlived stop()');

    const reopened = await createFramework();
    assert.ok(windowOf(reopened).includes('Antra: late word'), 'stored, and in the window after the restart');
    assert.ok(!recordOf(reopened).includes('assistant: too late'), 'the refused turn produced nothing');
    await reopened.stop();
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
        // The next turn's request is compiled from the window.
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
    assert.notEqual(internals.addMessage('Antra', text('while it waits')), '', 'stored at once, though the turn is alive');
    const error = console.error;
    console.error = () => {};
    try { await framework.stop(); } finally { console.error = error; }
    assert.deepEqual(retries, [], 'stop() ended the wait, and the retry was cancelled before it re-entered');
    assert.equal(compiles, 1, 'the retry was not compiled');

    const reopened = await createFramework();
    assert.ok(windowOf(reopened).includes('Antra: while it waits'), 'stored, and in the window after the restart');
    await reopened.stop();
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
    assert.equal(markAtOrAfter(agent.getConsumedWatermark()!, marked!), true, 'a later compile still advances it');
    await framework.stop();
  });

  it("a held message waits out a successor turn's tool cycle, and enters the window once it is over", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Moving.' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(text('Done.')));
    const framework = await createFramework();
    const internals = internalsOf(framework) as ReturnType<typeof internalsOf> & { releasePrimaryProviderGate: (name: string) => void };
    const agent = framework.getAgent('assistant')!;
    let held = '';
    module.duringTool = () => {
      held = internals.addMessage('assistant', text('my own words'), undefined, { forAgent: 'assistant' });
      assert.notEqual(held, '', 'stored at once');
    };
    // As the turn's stream completes, a successor turn takes the agent and is
    // mid tool cycle (the 2026-07-31 interleave): the stream generation, the
    // turn token and the cycle are the successor's when the first turn's
    // teardown presents.
    let completed = false;
    const off = framework.onTrace((event) => {
      if ((event as { type: string }).type !== 'inference:completed') return;
      off();
      completed = true;
      (agent as unknown as { _streamId: number })._streamId++;
      internals.activeTurnTokens.set('assistant', 1_000_000);
      internals.pendingAssistantBlocks.set('assistant', otherCycle());
    });
    // The first turn's teardown releases its provider gate, then presents,
    // synchronously: once the release is seen, the teardown has presented.
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
    assert.ok(!windowOf(framework).includes('assistant: my own words'), "not in the window inside the successor's cycle");
    assert.equal(statusOf(framework, held), 'out');
    // The successor's cycle and turn end: what it is owed enters its window.
    internals.pendingAssistantBlocks.delete('assistant');
    internals.activeTurnTokens.delete('assistant');
    internals.activeStreams.delete('assistant');
    internals.presentAtEndOf(agent);
    assert.equal(windowOf(framework).at(-1), 'assistant: my own words');
    await framework.stop();
  });
});
