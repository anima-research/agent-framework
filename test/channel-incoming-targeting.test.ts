/**
 * targetAgents on the channel-incoming path (issue #77 plumbing).
 *
 * McplChannelIncomingEvent declared `targetAgents` from the start, but the
 * fan-out ignored it and woke every registered agent. Now it mirrors the
 * push-event path: a targeted event wakes exactly the named agents (unknown
 * names skipped), an untargeted event keeps the historical broadcast.
 * Tune-out's wake routing is the first setter.
 *
 * Asserted at the pendingRequests seam (the fan-out's output), not by
 * running turns: MockMembrane hands its whole response queue to the first
 * stream, so two agents' concurrent turns starve one stream and the
 * framework restart-loops it — a harness limitation, not product behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    pendingRequests: Array<{ agentName: string; reason: string }>;
    handleMcplChannelIncoming(event: Record<string, unknown>): Promise<void>;
  };
}

function channelIncoming(text: string, targetAgents?: string[]): Record<string, unknown> {
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
    ...(targetAgents ? { targetAgents } : {}),
  };
}

describe('channel-incoming targetAgents', () => {
  let tempDir: string;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'channel-targeting-test-'));
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'shade', model: 'test-model', systemPrompt: 'You are shade.' },
      ],
      modules: [],
    });
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('untargeted events keep the historical broadcast (both agents queued)', async () => {
    const i = internals(framework);
    await i.handleMcplChannelIncoming(channelIncoming('hello everyone'));
    assert.deepEqual(
      i.pendingRequests.map((r) => r.agentName).sort(),
      ['scout', 'shade'],
    );
  });

  it('a targeted event queues exactly the named agent', async () => {
    const i = internals(framework);
    await i.handleMcplChannelIncoming(channelIncoming('for shade only', ['shade']));
    assert.deepEqual(i.pendingRequests.map((r) => r.agentName), ['shade']);
  });

  it('unknown names in targetAgents are skipped, not crashed on', async () => {
    const i = internals(framework);
    await i.handleMcplChannelIncoming(channelIncoming('mixed', ['nobody-home', 'scout']));
    assert.deepEqual(i.pendingRequests.map((r) => r.agentName), ['scout']);
  });

  it('non-triggering events queue nobody', async () => {
    const i = internals(framework);
    const event = channelIncoming('ambient, gate said no');
    event.triggerInference = false;
    await i.handleMcplChannelIncoming(event);
    assert.equal(i.pendingRequests.length, 0);
  });
});
