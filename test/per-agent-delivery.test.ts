/**
 * Per-agent message-delivery seam (issue #77 plumbing).
 *
 * framework.addMessage historically hardcoded the primary agent: the
 * deferral queue, turn-alive guard, and every flush point evaluated the
 * primary's turn state. The seam adds an optional forAgent target with the
 * guard evaluated against THAT agent's state. Since #291 a write is stored
 * at once, and the guard decides only when it enters the target's window:
 * at once while the target is at rest, at the target's own next point while
 * its turn is alive. These tests once read the deferral queue; they read the
 * target's window now.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    addMessage(
      participant: string,
      content: Array<{ type: 'text'; text: string }>,
      metadata?: Record<string, unknown>,
      opts?: { forAgent?: string },
    ): string;
    activeTurnTokens: Map<string, number>;
  };
}

function channelIncoming(text: string, targetAgents: string[]): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId: 'discord:guild:chanA',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'antra' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    triggerInference: true,
    targetAgents,
  } as unknown as ProcessEvent;
}

const textsOf = (rows: Array<{ content: Array<{ type: string }> }>): string[] =>
  rows.map((m) => m.content.map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : '')).join(''));
const inWindow = (framework: AgentFramework, agent: string, text: string): boolean =>
  textsOf(framework.getAgent(agent)!.getContextManager().getPresentedMessages()).includes(text);
const inRecord = (framework: AgentFramework, agent: string, text: string): boolean =>
  textsOf(framework.getAgent(agent)!.getContextManager().getAllMessages()).includes(text);

describe('per-agent message delivery', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'per-agent-delivery-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework() {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'shade', model: 'test-model', systemPrompt: 'You are shade.' },
      ],
      modules: [],
    });
  }

  it('a targeted message waits on the TARGET\'s busy turn, even with the primary idle', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    // Shade is mid-turn; scout (primary) is idle.
    i.activeTurnTokens.set('shade', 999);

    const id = i.addMessage('user', [{ type: 'text', text: 'for shade' }], undefined, {
      forAgent: 'shade',
    });
    assert.notEqual(id, '', 'stored at once');
    assert.equal(inWindow(framework, 'shade', 'for shade'), false, "out of shade's live turn");

    // An untargeted message with the primary idle enters its window at
    // once: shade's busyness must not hold primary-bound traffic.
    const id2 = i.addMessage('user', [{ type: 'text', text: 'for scout' }]);
    assert.notEqual(id2, '');
    assert.equal(inWindow(framework, 'scout', 'for scout'), true, 'primary delivery unaffected by shade\'s turn');
    assert.equal(inWindow(framework, 'shade', 'for shade'), false, 'shade\'s message still waits');

    i.activeTurnTokens.delete('shade');
    await framework.stop();
  });

  it('a targeted message waits across the PRIMARY\'s boundary and enters the target\'s window at its own', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    // Write a message for shade while shade is busy.
    i.activeTurnTokens.set('shade', 7);
    i.addMessage('user', [{ type: 'text', text: 'note for shade' }], undefined, {
      forAgent: 'shade',
    });
    assert.equal(inWindow(framework, 'shade', 'note for shade'), false);

    // Scout (primary) runs a full turn: its points present nothing into
    // shade's window.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'scout says hi' }]));
    framework.pushEvent(channelIncoming('wake scout', ['scout']));
    await framework.runUntilIdle();
    assert.equal(inWindow(framework, 'shade', 'note for shade'), false, 'shade\'s message waits past the primary\'s boundary');

    // Shade's own turn presents it (at its turn's start).
    i.activeTurnTokens.delete('shade');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'shade replies' }]));
    framework.pushEvent(channelIncoming('wake shade', ['shade']));
    await framework.runUntilIdle();
    assert.equal(inWindow(framework, 'shade', 'note for shade'), true, 'in shade\'s window at its own boundary');
    assert.ok(JSON.stringify(membrane.calls.at(-1)!.messages).includes('note for shade'), 'and in its request');

    await framework.stop();
  });

  it('unknown forAgent drops loudly instead of misdelivering', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    const id = i.addMessage('user', [{ type: 'text', text: 'lost' }], undefined, {
      forAgent: 'nobody-home',
    });
    assert.equal(id, '');
    assert.equal(inRecord(framework, 'scout', 'lost'), false, 'not stored for a ghost');

    await framework.stop();
  });
});
