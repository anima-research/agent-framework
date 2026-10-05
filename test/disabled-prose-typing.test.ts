import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

async function make(proseRouting: 'disabled' | 'explicit') {
  const dir = mkdtempSync(join(tmpdir(), 'disabled-typing-af-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting }],
    modules: [],
  });
  const typing: string[] = [];
  (framework as any).channelRegistry = new Proxy({
    resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
    routeSpeech: async () => ({ delivered: true, channelId: 'world:commons' }),
    startTyping: (channel: string) => { typing.push(channel); },
    stopTyping: () => {},
    getChannelTools: () => [], getDescriptor: () => undefined,
  }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
  // In explicit mode, prose with no `>>` target keeps this run from going idle
  // (the mock answers every further call with prose); a turn with no prose ends.
  membrane.pushResponse(createMockResponse(
    (proseRouting === 'explicit' ? [] : [{ type: 'text', text: 'working on it' }]) as ContentBlock[]));
  return { dir, framework, typed: () => [...new Set(typing)] };
}

async function wake(proseRouting: 'disabled' | 'explicit', request: Record<string, unknown> | 'silent') {
  const x = await make(proseRouting);
  try {
    if (request === 'silent') {
      (x.framework as any).handleMcplPushEvent({
        type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
        eventId: 'hb-1', content: [], timestamp: new Date().toISOString(),
        origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-05 12:00:00 PT' },
        inferenceId: 'inf-1', triggerInference: true,
      });
    } else {
      (x.framework as any).pendingRequests.push({ agentName: 'assistant', timestamp: Date.now(), ...request });
    }
    await x.framework.runUntilIdle();
    return x.typed();
  } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
}

describe('typing with proseRouting disabled', () => {
  it('shows typing on the channel the trigger came from', async () => {
    const typed = await wake('disabled', { reason: 'channel-message', source: 'zulip', channelId: 'zulip:support', addressed: true });
    assert.deepEqual(typed, ['zulip:support']);
  });

  it('shows typing where a batched gate wake came from (wakeChannelId)', async () => {
    const typed = await wake('disabled', { reason: 'gate', source: 'gate', wakeChannelId: 'zulip:support' });
    assert.deepEqual(typed, ['zulip:support']);
  });

  it('keeps a silent wake private: no typing', async () => {
    assert.deepEqual(await wake('disabled', 'silent'), []);
  });

  it('shows no typing for a wake that names no channel', async () => {
    assert.deepEqual(await wake('disabled', { reason: 'heartbeat', source: 'heartbeat' }), []);
  });

  it('leaves explicit mode unchanged: a batched gate wake shows no typing', async () => {
    assert.deepEqual(await wake('explicit', { reason: 'gate', source: 'gate', wakeChannelId: 'zulip:support' }), []);
    assert.deepEqual(
      await wake('explicit', { reason: 'channel-message', source: 'zulip', channelId: 'zulip:support', addressed: true }),
      ['zulip:support'],
    );
  });
});
