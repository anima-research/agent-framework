import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';
import {
  DISCORD_AWARENESS_RECORD_TYPE,
  DiscordAwarenessOutbox,
} from '../src/recovery/discord-awareness-outbox.js';

/** Read the store's awareness journal with the host (and CLI) stopped. */
function readJournal<T>(storePath: string, read: (outbox: DiscordAwarenessOutbox, store: JsStore) => T): T {
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    return read(new DiscordAwarenessOutbox(store), store);
  } finally {
    store.close();
  }
}

test('offline recovery branches without compiling and queues discarded Discord refs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-safe',
    });
    cm.addMessage('user', [{ type: 'text', text: 'never echo this one' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-toxic-1',
    });
    cm.addMessage('user', [{ type: 'text', text: 'or this one' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-toxic-2',
    });
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      messageId: 'm-safe',
      branchName: 'recovery/cairn/toxic-tail',
    });

    assert.equal(result.sourceBranch, 'main');
    assert.equal(result.targetBranch, 'recovery/cairn/toxic-tail');
    assert.equal(result.messagesRemoved, 2);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['m-toxic-1', 'm-toxic-2']);

    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    assert.equal(recoveredStore.currentBranch().name, 'recovery/cairn/toxic-tail');
    const recoveredCm = await ContextManager.open({
      store: recoveredStore,
      namespace: 'agents/cairn',
    });
    assert.equal(recoveredCm.getMessageCount(), 1);
    assert.equal(recoveredCm.getMessageWindow(0, 1, { resolveBlobs: false }).messages[0].metadata?.messageId, 'm-safe');
    recoveredCm.close();
    recoveredStore.close();

    const batches = readJournal(storePath, (outbox) => outbox.pendingDispatches('discord'));
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map((dispatch) => dispatch.key.messageId), ['m-toxic-1', 'm-toxic-2']);

    // The outbox is metadata-only: quarantined text must never leak to it.
    const rawJournal = readJournal(storePath, (_outbox, store) => store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE)
      .map((id) => Buffer.from(store.getRecord(id)!.payload).toString('utf-8'))
      .join('\n'));
    assert.ok(rawJournal.length > 0);
    assert.ok(!rawJournal.includes('never echo this one'));
    assert.ok(!rawJournal.includes('or this one'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline recovery can branch at the current message and suppress an exact list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-list-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'keep first' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-keep',
    });
    cm.addMessage('user', [{ type: 'text', text: 'suppress A' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-a',
    });
    cm.addMessage('assistant', [{ type: 'text', text: 'keep between' }]);
    cm.addMessage('user', [{ type: 'text', text: 'suppress B' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-b',
    });
    cm.addMessage('user', [{ type: 'text', text: 'current anchor' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      suppressMessageIds: ['m-a', 'm-b'],
      branchName: 'recovery/cairn/exact-list',
    });

    assert.equal(result.messagesRemoved, 0);
    assert.equal(result.messagesSuppressed, 2);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['m-a', 'm-b']);

    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({
      store: recoveredStore,
      namespace: 'agents/cairn',
    });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId ?? message.participant),
      ['m-keep', 'assistant', 'm-current'],
    );

    await recoveredCm.switchBranch('main');
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId ?? message.participant),
      ['m-keep', 'm-a', 'assistant', 'm-b', 'm-current'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline recovery suppresses inclusive ranges in context order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-range-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'keep first' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-keep',
    });
    cm.addMessage('user', [{ type: 'text', text: 'range start' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-from',
    });
    cm.addMessage('assistant', [{ type: 'text', text: 'also suppressed by range' }]);
    cm.addMessage('user', [{ type: 'text', text: 'inside range' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-inside',
    });
    cm.addMessage('user', [{ type: 'text', text: 'range end' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-to',
    });
    cm.addMessage('user', [{ type: 'text', text: 'current anchor' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      // Reversed endpoints should still mean the inclusive context interval.
      suppressRanges: [{ fromMessageId: 'm-to', toMessageId: 'm-from' }],
      branchName: 'recovery/cairn/range',
    });

    assert.equal(result.messagesRemoved, 0);
    assert.equal(result.messagesSuppressed, 4);
    assert.deepEqual(
      result.refs.map((ref) => ref.messageId),
      ['m-from', 'm-inside', 'm-to'],
    );

    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({
      store: recoveredStore,
      namespace: 'agents/cairn',
    });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-keep', 'm-current'],
    );
    recoveredCm.close();
    recoveredStore.close();

    const batches = readJournal(storePath, (outbox) => outbox.pendingDispatches('discord'));
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.map((dispatch) => dispatch.key.messageId),
      ['m-from', 'm-inside', 'm-to'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline recovery accepts an exact internal context ID anchor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-context-id-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'prompt' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-prompt',
    });
    const coherentAssistantId = cm.addMessage('assistant', [{ type: 'text', text: 'safe answer' }]);
    cm.addMessage('user', [{ type: 'text', text: 'poison' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-poison',
    });
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      contextId: String(coherentAssistantId),
      branchName: 'recovery/cairn/internal-anchor',
    });

    assert.equal(result.messagesRemoved, 1);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['m-poison']);
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({
      store: recoveredStore,
      namespace: 'agents/cairn',
    });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.participant),
      ['user', 'assistant'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suppression rejects a range that splits a tool exchange', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-tool-integrity-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'range start' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-from',
    });
    cm.addMessage('assistant', [
      { type: 'tool_use', id: 'tool-1', name: 'shell', input: {} },
    ]);
    cm.addMessage('user', [{ type: 'text', text: 'range end' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-to',
    });
    cm.addMessage('user', [
      { type: 'tool_result', toolUseId: 'tool-1', content: 'result' },
    ]);
    cm.addMessage('user', [{ type: 'text', text: 'current' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    cm.close();
    store.close();

    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath,
        agentName: 'cairn',
        messageId: 'm-current',
        suppressRanges: [{ fromMessageId: 'm-from', toMessageId: 'm-to' }],
      }),
      /split tool exchange tool-1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline recovery is local by default; addressed marks only messages that addressed the agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-marks-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const seed = async () => {
      const store = JsStore.openOrCreate({ path: storePath });
      const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
      cm.addMessage('user', [{ type: 'text', text: 'safe' }], {
        serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-safe',
      });
      cm.addMessage('user', [{ type: 'text', text: 'hey @cairn' }], {
        serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-addressed', tags: ['chat:addressed', 'chat:mention'],
      });
      cm.addMessage('user', [{ type: 'text', text: 'ambient chatter' }], {
        serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-ambient', tags: ['chat:ambient'],
      });
      cm.close();
      store.close();
    };
    await seed();
    const local = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-safe', branchName: 'recovery/cairn/local',
    });
    assert.equal(local.marksScope, 'none');
    assert.equal(local.discordAddressable, 2);
    assert.equal(local.discordMarkersQueued, 0);
    assert.equal(local.unmarked, 2);
    assert.deepEqual(local.markers, { scope: 'none', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 });
    readJournal(storePath, (outbox) => {
      assert.equal(outbox.pendingDispatches('discord').length, 0, 'nothing is queued for Discord');
      assert.equal(outbox.batches().length, 0);
    });

    // A dry run with addressed shows exactly what would be marked.
    rmSync(storePath, { recursive: true, force: true });
    await seed();
    const preview = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'addressed' }, dryRun: true,
    });
    assert.deepEqual(preview.refs.map((ref) => ref.messageId), ['m-addressed']);
    const marked = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'addressed' }, branchName: 'recovery/cairn/marked',
    });
    assert.equal(marked.discordMarkersQueued, 1);
    assert.equal(marked.unmarked, 1);
    assert.equal(marked.markers?.status, 'queued');
    assert.deepEqual(
      readJournal(storePath, (outbox) => outbox.pendingDispatches('discord').map((dispatch) => dispatch.key.messageId)),
      ['m-addressed'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline recovery reports a marker bookkeeping failure apart from the body, which stands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-settle-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-safe' });
    cm.addMessage('user', [{ type: 'text', text: 'hey' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-gone', tags: ['chat:addressed'] });
    cm.close();
    store.close();
    const original = DiscordAwarenessOutbox.prototype.activate;
    DiscordAwarenessOutbox.prototype.activate = function () { throw new Error('injected activation failure'); };
    let result: Awaited<ReturnType<typeof createOfflineRecoveryBranch>>;
    try {
      result = await createOfflineRecoveryBranch({
        storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'recovery/cairn/settle',
      });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = original;
    }
    assert.equal(result.markers?.status, 'not-scheduled');
    assert.match(result.markers?.status === 'not-scheduled' ? result.markers.error : '', /injected activation failure/);
    assert.equal(result.discordMarkersQueued, 0);
    const reopened = JsStore.openOrCreate({ path: storePath });
    try {
      assert.equal(reopened.currentBranch().name, 'recovery/cairn/settle', 'the recovery branch stands');
      const outbox = new DiscordAwarenessOutbox(reopened);
      assert.equal(outbox.batches()[0].status, 'discarded');
      assert.equal(outbox.pendingDispatches('discord').length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed offline suppression retires its batch once the source is confirmed, and keeps it when it is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-fail-'));
  const storePath = join(dir, 'agent.chronicle');
  const seed = async () => {
    rmSync(storePath, { recursive: true, force: true });
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'keep' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-keep' });
    cm.addMessage('user', [{ type: 'text', text: 'hide me' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-a' });
    cm.addMessage('user', [{ type: 'text', text: 'anchor' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current' });
    cm.close();
    store.close();
  };
  const inspect = () => {
    const store = JsStore.openOrCreate({ path: storePath });
    try {
      const outbox = new DiscordAwarenessOutbox(store);
      return { branch: store.currentBranch().name, statuses: outbox.batches().map((b) => b.status), due: outbox.pendingDispatches().length };
    } finally {
      store.close();
    }
  };
  const removeMessage = ContextManager.prototype.removeMessage;
  const switchBranch = ContextManager.prototype.switchBranch;
  try {
    ContextManager.prototype.removeMessage = function () { throw new Error('injected redaction failure'); };

    // The source comes back: the batch is retired; nothing will ever resume or mark.
    await seed();
    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
        marks: { scope: 'all' }, branchName: 'recovery/cairn/fail',
      }),
      (error: Error) => /injected redaction failure/.test(error.message) && !/kept/.test(error.message),
    );
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['discarded'], due: 0 });

    // The source can't be confirmed: the batch stays as the unfinished body's record.
    await seed();
    ContextManager.prototype.switchBranch = async function (this: ContextManager, name: string) {
      if (name === 'main') throw new Error('injected restore failure');
      return switchBranch.call(this, name);
    };
    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
        marks: { scope: 'all' }, branchName: 'recovery/cairn/fail2',
      }),
      /injected redaction failure; restoring main failed: injected restore failure; awareness batch .* kept, since the source branch could not be confirmed/,
    );
    assert.deepEqual(inspect(), { branch: 'recovery/cairn/fail2', statuses: ['prepared'], due: 0 });
  } finally {
    ContextManager.prototype.removeMessage = removeMessage;
    ContextManager.prototype.switchBranch = switchBranch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline recovery onto an existing branch is refused before any intent, and a branch-creation failure settles like any body failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-name-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-safe' });
    const last = cm.addMessage('user', [{ type: 'text', text: 'later' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-later', tags: ['chat:addressed'],
    });
    cm.branchAt(last, 'taken'); // an existing branch that still has both messages
    cm.close();
    store.close();
    const inspect = () => {
      const reopened = JsStore.openOrCreate({ path: storePath });
      try {
        return { branch: reopened.currentBranch().name, statuses: new DiscordAwarenessOutbox(reopened).batches().map((b) => b.status) };
      } finally {
        reopened.close();
      }
    };

    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'taken' }),
      /Recovery branch taken already exists/,
    );
    assert.deepEqual(inspect(), { branch: 'main', statuses: [] }, 'nothing prepared, so starting taken arms nothing');

    const branchAt = ContextManager.prototype.branchAt;
    ContextManager.prototype.branchAt = function () { throw new Error('injected branch failure'); };
    try {
      await assert.rejects(
        createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'fresh' }),
        (error: Error) => /injected branch failure/.test(error.message) && !/kept/.test(error.message),
      );
    } finally {
      ContextManager.prototype.branchAt = branchAt;
    }
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['discarded'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
