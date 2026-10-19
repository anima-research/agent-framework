/**
 * Hiding or suppressing messages answers with a preview of the last visible
 * message, and a preview is a dry compile. Under the autobiographical strategy
 * that dry compile is the first compile after the removal, which
 * context-manager 0.14.0 mishandled: it left later compiles reading message
 * positions from before the removal, so with the middle of three messages
 * removed, the agent's next turn was refused with UncoveredDropError
 * (anima-research/context-manager#180, fixed in 0.14.1, this package's floor).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { TraceEvent } from '../src/types/trace.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const requestText = (request: unknown): string => JSON.stringify((request as { messages?: unknown }).messages ?? []);

type HostCommand = (serverId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
type LastVisible = { preview?: string } | null | undefined;

/**
 * Three messages on an autobiographical agent, the middle one removed by
 * `remove`, which returns the removal's answer; then a turn. The removal must
 * answer with a preview showing the third message last, and the turn must be
 * sent with the first and third messages and without the second.
 */
async function turnAfterRemoving(
  remove: (framework: AgentFramework, internalIdOf: (externalId: string) => string) => Promise<{ lastVisible?: LastVisible }>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hide-then-turn-'));
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-answered' }]));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'scout',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: new AutobiographicalStrategy({ recentWindowTokens: 30_000 }),
    }],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    // One attempt: a refused compile ends the turn at once.
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  try {
    const cm = framework.getAgent('scout')!.getContextManager();
    for (const [i, text] of ['zz-m1', 'zz-m2', 'zz-m3'].entries()) {
      cm.addMessage('user', [{ type: 'text', text }], { messageId: `d${i + 1}`, channelId: 'zz-channel' });
    }
    const internalIdOf = (externalId: string): string => String(cm.getAllMessages().find((m) =>
      (m.metadata as { messageId?: unknown } | undefined)?.messageId === externalId)!.id);

    const answer = await remove(framework, internalIdOf);
    assert.ok(answer.lastVisible?.preview?.includes('zz-m3'),
      `the removal answered with a preview showing the third message last: ${JSON.stringify(answer.lastVisible)}`);

    framework.start();
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'scout', reason: 'external-message', source: 'test', timestamp: Date.now(),
    });
    await waitFor('the turn to end', () => traces.some((e) =>
      e.type === 'inference:completed' || e.type === 'inference:failed' || e.type === 'inference:exhausted'));
    const failed = traces.find((e) => e.type === 'inference:failed') as { error?: string } | undefined;
    assert.equal(failed, undefined, `the turn failed: ${failed?.error}`);
    assert.equal(membrane.calls.length, 1, 'the turn was sent');
    const sent = requestText(membrane.calls[0]);
    assert.ok(sent.includes('zz-m1') && sent.includes('zz-m3'), 'it carries the messages left');
    assert.ok(!sent.includes('zz-m2'), 'and not the removed one');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const hostCommand = (framework: AgentFramework): HostCommand =>
  (framework as unknown as { handleHostCommand: HostCommand }).handleHostCommand.bind(framework);

test('a turn after hiding one message is sent with the messages left', async () => {
  await turnAfterRemoving(async (framework) => {
    const hidden = await hostCommand(framework)('discord', {
      command: 'hide', agentName: 'scout', fromMessageId: 'd2', requesterName: 'zz-operator',
    });
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    return hidden as { lastVisible?: LastVisible };
  });
});

test('a turn after hiding a range of messages is sent with the messages left', async () => {
  await turnAfterRemoving(async (framework) => {
    const hidden = await hostCommand(framework)('discord', {
      command: 'hide', agentName: 'scout', fromMessageId: 'd2', toMessageId: 'd2', requesterName: 'zz-operator',
    });
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    return hidden as { lastVisible?: LastVisible };
  });
});

test('a turn after suppressing a message is sent with the messages left', async () => {
  await turnAfterRemoving(async (framework, internalIdOf) =>
    framework.suppressMessages('scout', { messageIds: [internalIdOf('d2')] }));
});
