/**
 * AF #844 bot review, round 8: offline recovery on a presented window.
 *
 * 17: a suppression may name a row the cut keeps after the anchor.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, type MessageId } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const textOf = (m: { content: unknown[] }) => String((m.content[0] as { text?: string }).text);

/** P presented by the write-down, then A, B, C stored and presented in one write. */
async function batchStore(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
  dirs.push(dir);
  const storePath = join(dir, 'agent.chronicle');
  const store = JsStore.openOrCreate({ path: storePath });
  const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
  const discord = (t: string): MessageId => cm.addMessage('user', [{ type: 'text', text: t } as ContentBlock], {
    serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}`,
  });
  discord('P');
  cm.presentRows([]);
  const ids = ['A', 'B', 'C'].map(discord);
  cm.presentRows(ids);
  assert.deepEqual(cm.getPresentedMessages().map(textOf), ['P', 'A', 'B', 'C']);
  cm.close();
  store.close();
  return storePath;
}

async function recordOn(storePath: string): Promise<{ branch: string; texts: string[]; window: string[] }> {
  const store = JsStore.openOrCreate({ path: storePath });
  const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
  try {
    return { branch: store.currentBranch().name, texts: cm.getAllMessages().map(textOf), window: cm.getPresentedMessages().map(textOf) };
  } finally {
    cm.close();
    store.close();
  }
}

describe('AF #844 review 8 — offline recovery at a presented cut', () => {
  it('17: a suppression names a row the cut keeps after the anchor', async () => {
    const storePath = await batchStore();
    const result = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'd-A', suppressMessageIds: ['d-B'], marks: { scope: 'all' }, branchName: 'recovery/cairn/suppress',
    });
    assert.equal(result.messagesRemoved, 0);
    assert.equal(result.messagesSuppressed, 1);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['d-B']);
    const after = await recordOn(storePath);
    assert.equal(after.branch, 'recovery/cairn/suppress');
    assert.deepEqual(after.texts, ['P', 'A', 'C']);
    assert.deepEqual(after.window, ['P', 'A', 'C']);
  });

  it('17: a range may end at a kept row after the anchor; a removed row is still not a suppression endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
    dirs.push(dir);
    const storePath = join(dir, 'agent.chronicle');
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    const discord = (t: string): MessageId => cm.addMessage('user', [{ type: 'text', text: t } as ContentBlock], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}`,
    });
    discord('P');
    cm.presentRows([]);
    cm.presentRows(['A', 'B', 'C'].map(discord));
    cm.presentRows([discord('D')]);
    cm.close();
    store.close();
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', suppressMessageIds: ['d-D'], dryRun: true }),
      /Suppression endpoint d-D is not visible at the selected branch point/,
    );
    const result = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'd-A', suppressRanges: [{ fromMessageId: 'd-B', toMessageId: 'd-C' }], branchName: 'recovery/cairn/range',
    });
    assert.equal(result.messagesRemoved, 1, 'D, presented after the cut');
    assert.equal(result.messagesSuppressed, 2);
    assert.deepEqual((await recordOn(storePath)).texts, ['P', 'A']);
  });
});
