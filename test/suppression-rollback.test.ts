/**
 * Rolling back past suppress rules. A release without them doesn't read the
 * stamp, so a row hidden between messages a summary covers makes that summary
 * non-contiguous under its view, and the store is refused at open
 * (context-manager's topology guard). `removeSuppressed` (agent-framework-recover
 * --remove-suppressed) makes a branch such a release opens.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, StoreTopologyError } from '@animalabs/context-manager';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';
import { suppressionRecordOf } from '../src/gate/suppression-stats.js';

const HIDDEN = 'HIDDEN-ROW';
const strategy = () => new AutobiographicalStrategy({
  compressionModel: 'test-compression-model', targetChunkTokens: 300, headWindowTokens: 0, recentWindowTokens: 0, hierarchical: true,
});
const membrane = {
  complete: async (request: { messages: Array<{ content: Array<{ text?: string }> }> }) => {
    const text = request.messages.flatMap((m) => m.content).map((b) => b.text ?? '').join('\n');
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `[memory of ${text.length}] ${'x '.repeat(40)}` }], usage: { input_tokens: 100, output_tokens: 25 } };
  },
} as never;
/** This release's residents' view of the stamp, and a release's that doesn't read it. */
const hidesStamped = (m: { metadata?: unknown }) => suppressionRecordOf(m.metadata as Record<string, unknown> | undefined) === undefined;

async function storeWithSummariesAroundHiddenRows(path: string): Promise<void> {
  const manager = await ContextManager.open({ path, namespace: 'agents/agent', strategy: strategy(), membrane, viewFilter: hidesStamped as never });
  for (let i = 0; i < 120; i++) {
    const text = `message ${i} ${'word '.repeat(8)}`;
    if (i % 3 === 0) manager.addMessage('user', [{ type: 'text', text: `${HIDDEN} ${text}` }], { suppressed: { rule: 'r', eventType: 'mcpl:push-event' } } as never);
    else manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text }]);
  }
  for (let i = 0; i < 500 && !manager.isReady(); i++) await manager.tick();
  assert.ok(manager.isReady(), 'compression finished');
  await manager.close();
}

describe('rolling back past suppress rules', () => {
  it('a store compressed around hidden rows is refused by a view that does not read the stamp, and opens on the branch removeSuppressed makes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'suppression-rollback-'));
    const path = join(dir, 'store');
    try {
      await storeWithSummariesAroundHiddenRows(path);

      // This release's view opens it.
      const current = await ContextManager.open({ path, namespace: 'agents/agent', strategy: strategy(), membrane, viewFilter: hidesStamped as never });
      assert.equal(current.getAllMessages().length, 120);
      await current.close();

      // A release that doesn't read the stamp refuses it at open.
      await assert.rejects(
        ContextManager.open({ path, namespace: 'agents/agent', strategy: strategy(), membrane }),
        (error: unknown) => error instanceof StoreTopologyError,
      );

      const dry = await createOfflineRecoveryBranch({ storePath: path, agentName: 'agent', removeSuppressed: true, dryRun: true });
      assert.equal(dry.messagesSuppressed, 40, 'a dry run counts the hidden rows');
      const result = await createOfflineRecoveryBranch({ storePath: path, agentName: 'agent', removeSuppressed: true });
      assert.equal(result.messagesSuppressed, 40);

      // On the recovery branch that view opens it, with the visible rows all there.
      const rolledBack = await ContextManager.open({ path, namespace: 'agents/agent', strategy: strategy(), membrane });
      assert.equal(rolledBack.currentBranch().name, result.targetBranch);
      assert.equal(rolledBack.getAllMessages().length, 80);
      assert.ok(!rolledBack.getAllMessages().some((m) => JSON.stringify(m.content).includes(HIDDEN)));
      const compiled = await rolledBack.compile();
      assert.ok(!JSON.stringify(compiled.messages).includes(HIDDEN));

      await rolledBack.close();

      // The source branch keeps them. Read with no strategy, as the recovery
      // tool reads: under the view that doesn't read the stamp it's still refused.
      const reader = await ContextManager.open({ path, namespace: 'agents/agent' });
      await reader.switchBranch(result.sourceBranch);
      assert.equal(reader.getAllMessages().length, 120);
      await reader.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('with no anchor it branches from the head: a second run keeps the rows out, and a removal after the newest row stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'suppression-rollback-'));
    const path = join(dir, 'store');
    try {
      const manager = await ContextManager.open({ path, namespace: 'agents/agent' });
      manager.addMessage('user', [{ type: 'text', text: 'kept' }]);
      const edited = manager.addMessage('user', [{ type: 'text', text: 'removed by hand' }]);
      manager.addMessage('user', [{ type: 'text', text: HIDDEN }], { suppressed: { rule: 'r', eventType: 'x' } });
      manager.addMessage('agent', [{ type: 'text', text: 'newest' }]);
      // Written after the newest row, so a branch at that row's sequence wouldn't have it.
      manager.removeMessage(edited);
      await manager.close();

      const texts = async (): Promise<string[]> => {
        const reader = await ContextManager.open({ path, namespace: 'agents/agent' });
        try {
          return reader.getAllMessages().map((m) => (m.content[0] as { text: string }).text);
        } finally { await reader.close(); }
      };
      const first = await createOfflineRecoveryBranch({ storePath: path, agentName: 'agent', removeSuppressed: true });
      assert.equal(first.messagesSuppressed, 1);
      assert.deepEqual(await texts(), ['kept', 'newest']);

      const second = await createOfflineRecoveryBranch({ storePath: path, agentName: 'agent', removeSuppressed: true });
      assert.equal(second.messagesSuppressed, 0);
      assert.equal(second.sourceBranch, first.targetBranch);
      assert.deepEqual(await texts(), ['kept', 'newest'], 'the second run brings back neither');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
