/**
 * Per-agent message-delivery seam (issue #77 plumbing).
 *
 * framework.addMessage historically hardcoded the primary agent: the
 * deferral queue, turn-alive guard, and every flush point evaluated the
 * primary's turn state. The seam adds an optional forAgent target with the
 * guard evaluated against THAT agent's state, flushed at THAT agent's
 * boundaries. Default behavior (no forAgent) is byte-identical.
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
    deferredMessages: Array<{ participant: string; forAgent?: string }>;
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

  it('a targeted message defers on the TARGET\'s busy turn, even with the primary idle', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    // Shade is mid-turn; scout (primary) is idle.
    i.activeTurnTokens.set('shade', 999);

    const id = i.addMessage('user', [{ type: 'text', text: 'for shade' }], undefined, {
      forAgent: 'shade',
    });
    assert.equal(id, '', 'deferred, not stored');
    assert.equal(i.deferredMessages.length, 1);
    assert.equal(i.deferredMessages[0].forAgent, 'shade');

    // An untargeted message with the primary idle stores immediately —
    // shade's busyness must not defer primary-bound traffic.
    const id2 = i.addMessage('user', [{ type: 'text', text: 'for scout' }]);
    assert.notEqual(id2, '', 'primary delivery unaffected by shade\'s turn');
    assert.equal(i.deferredMessages.length, 1, 'still only shade\'s entry queued');

    i.activeTurnTokens.delete('shade');
    await framework.stop();
  });

  it('a queued targeted message survives the PRIMARY\'s boundary and flushes at the target\'s', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    // Queue a message for shade while shade is busy.
    i.activeTurnTokens.set('shade', 7);
    i.addMessage('user', [{ type: 'text', text: 'note for shade' }], undefined, {
      forAgent: 'shade',
    });
    assert.equal(i.deferredMessages.length, 1);

    // Scout (primary) runs a full turn: its turn-start flush must NOT
    // deliver shade's message.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'scout says hi' }]));
    framework.pushEvent(channelIncoming('wake scout', ['scout']));
    await framework.runUntilIdle();
    assert.equal(
      i.deferredMessages.length,
      1,
      'shade\'s entry must survive the primary\'s boundary',
    );

    // Shade's own turn flushes it (turn-start flush at its boundary).
    i.activeTurnTokens.delete('shade');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'shade replies' }]));
    framework.pushEvent(channelIncoming('wake shade', ['shade']));
    await framework.runUntilIdle();
    assert.equal(i.deferredMessages.length, 0, 'flushed at the target\'s boundary');

    await framework.stop();
  });

  it('unknown forAgent drops loudly instead of misdelivering', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    const id = i.addMessage('user', [{ type: 'text', text: 'lost' }], undefined, {
      forAgent: 'nobody-home',
    });
    assert.equal(id, '');
    assert.equal(i.deferredMessages.length, 0, 'not queued for a ghost');

    await framework.stop();
  });
});
