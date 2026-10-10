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
 * covers it, so a coalesced replacement can no longer remove it.
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
    // Let the run loop handle them while this round's tools are pending, so
    // they land in the deferred queue before the tool-result boundary.
    if (pending.length > 0) await new Promise((r) => setTimeout(r, 30));
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

  async function createFramework(): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.' }],
      modules: [module],
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

  function injected(): string[] {
    const options = membrane.lastStream!.receivedToolResultOptions[0];
    return (options?.injectedMessages ?? []).map((m) =>
      `${m.participant}: ${(m.content as Array<{ text?: string }>).map((b) => b.text).join(' ')}`);
  }

  it('a message named as the agent waits for the turn to end, after its last round', async () => {
    const framework = await runTurn('move', [{ participant: 'assistant', content: text('my own words') }]);
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
    assert.deepEqual(injected(), ['Antra: look left']);
    assert.deepEqual(windowOf(framework).slice(2), [
      'user: <tool_result>',
      'Antra: look left',
      'assistant: Done.',
      'assistant: my own words',
    ]);
    await framework.stop();
  });

  it('a message the stream carried is read: the consumed watermark covers it', async () => {
    const framework = await runTurn('move', [{ participant: 'Antra', content: text('look left') }]);
    assert.deepEqual(injected(), ['Antra: look left']);
    const agent = framework.getAgent('assistant')!;
    const heard = agent.getContextManager().getAllMessages()
      .find((m) => m.content.some((b) => (b as { text?: string }).text === 'look left'))!;
    const isUnread = (framework as unknown as {
      isUnreadStoredMessage: (a: typeof agent, id: string) => boolean;
    }).isUnreadStoredMessage.bind(framework);
    assert.equal(isUnread(agent, heard.id), false, 'a coalesced replacement must not remove what the agent heard');
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

  it('a write coming back from the deferred queue re-defers while a turn is alive, tool_result or not', async () => {
    const framework = await createFramework();
    const internals = framework as unknown as {
      activeTurnTokens: Map<string, number>;
      deferredMessages: Array<{ id: string }>;
      addMessage: (p: string, c: ContentBlock[], m?: unknown, o?: { deferredWriteId?: string }) => string;
    };
    internals.activeTurnTokens.set('assistant', 1);
    try {
      // A queued pair's tool_result must follow its tool_use back into the
      // queue, or the pair splits (the turn-end flush can run after a
      // successor turn has started).
      const requeued = internals.addMessage('user', [
        { type: 'tool_result', toolUseId: 'p1', content: 'ok' } as ContentBlock,
      ], undefined, { deferredWriteId: 'w1' });
      assert.equal(requeued, '');
      assert.ok(internals.deferredMessages.some((m) => m.id === 'w1'));
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
