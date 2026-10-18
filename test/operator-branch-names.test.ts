/**
 * Default operator branch names (`<kind>/<agent>/<ms>`) are chosen so the
 * store doesn't hold them yet: two changes of one kind made one after the
 * other in a millisecond get a branch each (`…/<ms>` and `…/<ms>-2`), where
 * the second used to be refused, its name being the first one's branch: as
 * the active branch ("must differ from the active branch") or as a branch the
 * store holds ("Branch already exists", for a turn undone again after a
 * redo). A name the store holds from elsewhere counts as taken too. Each case
 * pins Date.now so the changes share a millisecond.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { AgentFramework, OperatorActionError } from '../src/index.js';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const T = 1_760_000_000_000;

function pinNow(): void {
  mock.method(Date, 'now', () => T);
}

interface Internals {
  handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  saveTurnCheckpoints(name: string, checkpoints: unknown[]): void;
}

describe('default operator branch names', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let ids: string[];

  const cm = () => framework.getAgent('scout')!.getContextManager();
  const branchNames = () => framework.getStore().listBranches().map((branch) => branch.name).sort();

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'operator-branch-names-'));
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    ids = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(cm().addMessage(i % 2 ? 'user' : 'scout', [{ type: 'text', text: `m${i}` }], {
        serverId: 'discord',
        channelId: 'discord:g1:c1',
        messageId: `d${i}`,
      }));
    }
  });

  afterEach(async () => {
    mock.restoreAll();
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('two suppressions in one millisecond each get a branch', async () => {
    pinNow();
    const first = await framework.suppressMessages('scout', { messageIds: [ids[1]] });
    const second = await framework.suppressMessages('scout', { messageIds: [ids[3]] });
    assert.equal(first.targetBranch, `suppress/scout/${T}`);
    assert.equal(second.targetBranch, `suppress/scout/${T}-2`);
    assert.equal(cm().currentBranch().name, second.targetBranch);
    assert.deepEqual(branchNames(), ['main', `suppress/scout/${T}`, `suppress/scout/${T}-2`]);
  });

  it('two rollbacks in one millisecond each get a branch', async () => {
    pinNow();
    const first = await framework.rollbackToMessage('scout', { messageId: ids[3] });
    const second = await framework.rollbackToMessage('scout', { messageId: ids[1] });
    assert.equal(first.targetBranch, `rollback/scout/${T}`);
    assert.equal(second.targetBranch, `rollback/scout/${T}-2`);
    assert.equal(cm().currentBranch().name, second.targetBranch);
    assert.equal(cm().getMessageCount(), 2);
  });

  it("two of the host command's message undos in one millisecond each get a branch", async () => {
    const internals = framework as unknown as Internals;
    pinNow();
    const first = await internals.handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 1 });
    assert.equal(first.ok, true, String(first.error));
    assert.equal(cm().currentBranch().name, `undo-msgs/scout/${T}`);
    const second = await internals.handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 1 });
    assert.equal(second.ok, true, String(second.error));
    assert.equal(cm().currentBranch().name, `undo-msgs/scout/${T}-2`);
    assert.equal(cm().getMessageCount(), 3);
  });

  it('a turn undone, redone and undone again in one millisecond gets a second branch', () => {
    const internals = framework as unknown as Internals;
    const sequenceBefore = framework.getStore().currentSequence();
    cm().addMessage('user', [{ type: 'text', text: 'turn 6' }]);
    cm().addMessage('scout', [{ type: 'text', text: 'reply 6' }]);
    internals.saveTurnCheckpoints('scout', [{ agentName: 'scout', turnIndex: 6, sequenceBefore, branchName: 'main', timestamp: T }]);
    pinNow();
    assert.equal(framework.undoLastTurn('scout').undone, true);
    assert.equal(framework.getStore().currentBranch().name, `undo/scout/6-${T}`);
    assert.equal(framework.redo('scout').redone, true);
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.equal(framework.undoLastTurn('scout').undone, true);
    assert.equal(framework.getStore().currentBranch().name, `undo/scout/6-${T}-2`);
  });

  it('a default name the store already holds, on a branch the framework did not make, takes the next free name', async () => {
    // A counter kept by the framework would hand out the bare name here,
    // since it never gave it out; only asking the store finds it taken.
    framework.getStore().createBranch(`rollback/scout/${T}`);
    pinNow();
    const rolled = await framework.rollbackToMessage('scout', { messageId: ids[3] });
    assert.equal(rolled.targetBranch, `rollback/scout/${T}-2`);
    assert.equal(cm().currentBranch().name, `rollback/scout/${T}-2`);
  });

  it("an explicit name stays the caller's: a taken one is refused, not renamed", async () => {
    await framework.rollbackToMessage('scout', { messageId: ids[3], branchName: 'chosen' });
    await framework.switchBranch('main');
    await assert.rejects(
      framework.rollbackToMessage('scout', { messageId: ids[1], branchName: 'chosen' }),
      (error: unknown) => error instanceof OperatorActionError && error.code === 'failed'
        && /Branch already exists: chosen/.test(error.message),
    );
    assert.deepEqual(branchNames(), ['chosen', 'main']);
  });
});

describe('default offline recovery branch names', () => {
  afterEach(() => { mock.restoreAll(); });

  it('an offline recovery whose default name the store already holds, on a branch that is not active, takes the next free name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-held-'));
    const storePath = join(dir, 'agent.chronicle');
    try {
      const store = JsStore.openOrCreate({ path: storePath });
      const seeded = await ContextManager.open({ store, namespace: 'agents/cairn' });
      for (let i = 1; i <= 3; i++) {
        seeded.addMessage('user', [{ type: 'text', text: `m${i}` }], {
          serverId: 'discord', channelId: 'discord:g1:c1', messageId: `m${i}`,
        });
      }
      seeded.close();
      // Made outside offline recovery, and left inactive: main stays the source.
      store.createBranch(`recovery/cairn/${T}`);
      assert.equal(store.currentBranch().name, 'main');
      store.close();

      pinNow();
      const recovered = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm2' });
      assert.equal(recovered.sourceBranch, 'main');
      assert.equal(recovered.targetBranch, `recovery/cairn/${T}-2`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two offline recoveries in one millisecond each get a branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-names-'));
    const storePath = join(dir, 'agent.chronicle');
    try {
      const store = JsStore.openOrCreate({ path: storePath });
      const seeded = await ContextManager.open({ store, namespace: 'agents/cairn' });
      for (let i = 1; i <= 4; i++) {
        seeded.addMessage('user', [{ type: 'text', text: `m${i}` }], {
          serverId: 'discord', channelId: 'discord:g1:c1', messageId: `m${i}`,
        });
      }
      seeded.close();
      store.close();

      pinNow();
      const first = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm3' });
      const second = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm2' });
      assert.equal(first.targetBranch, `recovery/cairn/${T}`);
      assert.equal(second.targetBranch, `recovery/cairn/${T}-2`);

      const reopened = JsStore.openOrCreate({ path: storePath });
      try {
        assert.equal(reopened.currentBranch().name, `recovery/cairn/${T}-2`);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
