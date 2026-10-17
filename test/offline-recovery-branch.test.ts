import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';
import { OperatorActionError } from '../src/operator-log.js';
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

test('a suppressed range takes every copy of both its messages, and leaves what was stored after the later one began', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-range-copies-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    const add = (text: string, messageId: string) => cm.addMessage('user', [{ type: 'text', text }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId,
    });
    add('keep', 'm-keep');
    // B was stored twice, a write cut short and retried, with Z between:
    // Z came after B began, so it isn't between A and B.
    add('A', 'm-a');
    add('B, cut short', 'm-b');
    add('Z', 'm-z');
    add('B, retried', 'm-b');
    // C's retry was stored after D and E: it goes too, on its own.
    add('C, cut short', 'm-c');
    add('D', 'm-d');
    add('E', 'm-e');
    add('C, retried', 'm-c');
    add('current anchor', 'm-current');
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      suppressRanges: [
        { fromMessageId: 'm-a', toMessageId: 'm-b' },
        { fromMessageId: 'm-d', toMessageId: 'm-c' },
      ],
      branchName: 'recovery/cairn/range-copies',
    });

    assert.equal(result.messagesSuppressed, 6);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['m-a', 'm-b', 'm-c', 'm-d']);
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({ store: recoveredStore, namespace: 'agents/cairn' });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-keep', 'm-z', 'm-e', 'm-current'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suppressed range whose two messages are stored in shards takes each whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-range-shards-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    const add = (text: string, messageId: string) => cm.addMessage('user', [{ type: 'text', text }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId,
    });
    add('keep', 'm-keep');
    // Each shard of a long message carries its Discord message id.
    appendShards(cm, 'body-a', ['m-a', 'm-a']);
    add('between', 'm-between');
    appendShards(cm, 'body-b', ['m-b', 'm-b', 'm-b']);
    add('after', 'm-after');
    add('current anchor', 'm-current');
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      suppressRanges: [{ fromMessageId: 'm-b', toMessageId: 'm-a' }],
      branchName: 'recovery/cairn/range-shards',
    });

    assert.equal(result.messagesSuppressed, 6, 'both bodies, every shard, and what lies between');
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({ store: recoveredStore, namespace: 'agents/cairn' });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-keep', 'm-after', 'm-current'],
    );
    recoveredCm.close();
    recoveredStore.close();
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

    // The source comes back: the batch is retired; nothing will ever resume
    // or mark. The partly suppressed branch is named.
    await seed();
    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
        marks: { scope: 'all' }, branchName: 'recovery/cairn/fail',
      }),
      (error: Error) => /^injected redaction failure; branch recovery\/cairn\/fail is kept for diagnosis: it may be partly suppressed, so don't start on it, and delete it once it has been looked at \(the host API's branch\.delete, once the host runs\), since nothing refuses a switch onto it once its awareness batch is retired; awareness batch \S+ retired, none of its marks sent\. To apply its marks, run the recovery again onto a new --branch, choosing them again$/.test(error.message),
    );
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['discarded'], due: 0 });

    // The source comes back but retiring the batch fails: the error says its
    // marks are never sent, and that its removals stay pending for the kept
    // branch, whose name stays claimed.
    await seed();
    const discard = DiscordAwarenessOutbox.prototype.discard;
    DiscordAwarenessOutbox.prototype.discard = function () { throw new Error('injected retire failure'); };
    try {
      await assert.rejects(
        createOfflineRecoveryBranch({
          storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
          marks: { scope: 'all' }, branchName: 'recovery/cairn/fail1',
        }),
        /awareness batch \S+ could not be retired \(injected retire failure\); it stays prepared, none of its marks to be sent\. Its removals stay pending for recovery\/cairn\/fail1: a start on recovery\/cairn\/fail1 would finish them there and retire the batch, so delete that branch unless you want that, through the host API's branch\.delete once the host runs, and until then a branch named recovery\/cairn\/fail1 is refused\. To apply its marks, run the recovery again onto a new --branch, choosing them again/,
      );
    } finally {
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['prepared'], due: 0 });
    {
      const store = JsStore.open({ path: storePath });
      try {
        const exists = (name: string) => store.listBranches().some((branch) => branch.name === name);
        assert.deepEqual(new DiscordAwarenessOutbox(store).recoverAtStartup(exists).retired, [],
          'a start on the source leaves it: its removals are pending on its branch, which exists');
        assert.equal(new DiscordAwarenessOutbox(store).batches()[0].status, 'prepared');
      } finally {
        store.close();
      }
    }

    // Retiring the batch fails, and the journal can't be read back either:
    // the error says it can't tell whether the retirement landed, and what
    // stays if it didn't.
    await seed();
    const batchStatus = DiscordAwarenessOutbox.prototype.batchStatus;
    DiscordAwarenessOutbox.prototype.discard = function () { throw new Error('injected retire failure'); };
    DiscordAwarenessOutbox.prototype.batchStatus = function () { throw new Error('injected unreadable journal'); };
    try {
      await assert.rejects(
        createOfflineRecoveryBranch({
          storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
          marks: { scope: 'all' }, branchName: 'recovery/cairn/fail-unread',
        }),
        /awareness batch \S+ could not be retired \(injected retire failure\), and the journal can't be read back to tell whether its retirement landed; if it didn't, it stays prepared, none of its marks to be sent\. Its removals stay pending for recovery\/cairn\/fail-unread: a start on recovery\/cairn\/fail-unread would finish them there and retire the batch/,
      );
    } finally {
      DiscordAwarenessOutbox.prototype.discard = discard;
      DiscordAwarenessOutbox.prototype.batchStatus = batchStatus;
    }
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['prepared'], due: 0 });

    // The retirement lands, and only its sync fails: read back, it's
    // reported retired, with the risk that the sync left.
    await seed();
    DiscordAwarenessOutbox.prototype.discard = function (this: DiscordAwarenessOutbox, batchId: string) {
      discard.call(this, batchId);
      throw new Error('injected sync failure');
    };
    try {
      await assert.rejects(
        createOfflineRecoveryBranch({
          storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
          marks: { scope: 'all' }, branchName: 'recovery/cairn/fail-synced',
        }),
        /; awareness batch \S+ is retired, none of its marks sent, but the journal's sync after its retirement failed \(injected sync failure\): an operating system crash or a power failure before the store's next sync could lose that record, and the batch would then be prepared again at the next start, its removals pending for recovery\/cairn\/fail-synced\. To apply its marks, run the recovery again onto a new --branch, choosing them again$/,
      );
    } finally {
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
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
      // One instruction for the kept branch: a start on it finishes the
      // suppression, so it isn't called unsafe to start.
      // The redo starts from the source, which isn't the store's current branch.
      /^Error: injected redaction failure; restoring main failed: injected restore failure; branch recovery\/cairn\/fail2 is kept: it may be partly suppressed; awareness batch \S+ kept, since the source branch could not be confirmed: a start on recovery\/cairn\/fail2 finishes its removals and retires it, none of its marks sent\. To apply its marks, redo it from main, choosing them again: the recovery starts from the store's current branch, which isn't main now, so start the host, switch to main through the host API's branch\.switch, stop the host, and run the recovery again onto a new --branch$/,
    );
    assert.deepEqual(inspect(), { branch: 'recovery/cairn/fail2', statuses: ['prepared'], due: 0 });
  } finally {
    ContextManager.prototype.removeMessage = removeMessage;
    ContextManager.prototype.switchBranch = switchBranch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed offline suppression whose branch was never made says the next start gives its removals up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-unforked-'));
  const storePath = join(dir, 'agent.chronicle');
  const branchAt = ContextManager.prototype.branchAt;
  const discard = DiscordAwarenessOutbox.prototype.discard;
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'keep' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-keep' });
    cm.addMessage('user', [{ type: 'text', text: 'hide me' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-a' });
    cm.addMessage('user', [{ type: 'text', text: 'anchor' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current' });
    cm.close();
    store.close();
    ContextManager.prototype.branchAt = function () { throw new Error('injected branch failure'); };
    DiscordAwarenessOutbox.prototype.discard = function () { throw new Error('injected retire failure'); };
    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
        marks: { scope: 'all' }, branchName: 'recovery/cairn/never',
      }),
      /^Error: injected branch failure; awareness batch \S+ could not be retired \(injected retire failure\); it stays prepared, none of its marks to be sent\. Its removals stay pending for recovery\/cairn\/never: the next start gives them up and retires the batch, since no branch has that name, and until then a branch named recovery\/cairn\/never is refused\. To apply its marks, run the recovery again onto a new --branch, choosing them again$/,
    );
  } finally {
    ContextManager.prototype.branchAt = branchAt;
    DiscordAwarenessOutbox.prototype.discard = discard;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline suppression whose resume journal could not be closed, or whose closing sync failed, says what is left of it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-unclosed-'));
  const storePath = join(dir, 'agent.chronicle');
  const settleActivation = DiscordAwarenessOutbox.prototype.settleActivation;
  // Each case on a fresh store, since a recovery leaves its fork current.
  const recoverWith = async (settled: ReturnType<typeof settleActivation>, marks: 'none' | { scope: 'all' }) => {
    rmSync(storePath, { recursive: true, force: true });
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'keep' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-keep' });
    cm.addMessage('user', [{ type: 'text', text: 'hide me' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-a' });
    cm.addMessage('user', [{ type: 'text', text: 'anchor' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current' });
    cm.close();
    store.close();
    DiscordAwarenessOutbox.prototype.settleActivation = function () { return settled; };
    return createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'], branchName: 'recovery/cairn/close', marks,
    });
  };
  try {
    // No marks: the batch is the suppression's resume journal alone.
    const unresolved = await recoverWith({ status: 'unresolved', error: 'injected activation failure' }, 'none');
    assert.equal(unresolved.markers?.status, 'none');
    assert.match(
      unresolved.suppressionJournal ?? '',
      /^the resume journal \(awareness batch \S+, no marks\) could not be closed \(injected activation failure\); it stays prepared, unless the journal couldn't be read back and its closing record landed anyway; if it stays prepared, a start on recovery\/cairn\/close finds its removals applied and closes it$/,
    );
    const retired = await recoverWith({ status: 'not-scheduled', error: 'injected activation failure' }, 'none');
    assert.match(
      retired.suppressionJournal ?? '',
      /^the resume journal \(awareness batch \S+, no marks\) could not be closed \(injected activation failure\); it was retired instead, so nothing is left to resume$/,
    );
    const unsynced = await recoverWith({ status: 'queued', queued: 0, error: 'injected sync failure' }, 'none');
    assert.match(
      unsynced.suppressionJournal ?? '',
      /^the resume journal \(awareness batch \S+, no marks\) is closed, but the journal's sync after it failed \(injected sync failure\): an operating system crash or a power failure before the store's next sync could lose that record, and a start on recovery\/cairn\/close then finds its removals applied and closes it$/,
    );
    const closed = await recoverWith({ status: 'queued', queued: 0 }, 'none');
    assert.equal(closed.suppressionJournal, undefined, 'a journal closed and synced says nothing');
    // With marks, the receipt carries a queued settlement's sync error.
    const marked = await recoverWith({ status: 'queued', queued: 2, error: 'injected sync failure' }, { scope: 'all' });
    assert.equal(marked.markers?.status, 'queued');
    assert.equal((marked.markers as { error?: string }).error, 'injected sync failure');
    assert.equal(marked.suppressionJournal, undefined);
  } finally {
    DiscordAwarenessOutbox.prototype.settleActivation = settleActivation;
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

    // The same failure with its retirement failing too: the batch stays
    // prepared until a start retires it, none of its marks sent.
    const discard = DiscordAwarenessOutbox.prototype.discard;
    ContextManager.prototype.branchAt = function () { throw new Error('injected branch failure'); };
    DiscordAwarenessOutbox.prototype.discard = function () { throw new Error('injected retire failure'); };
    try {
      await assert.rejects(
        createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'fresh2' }),
        /^Error: injected branch failure; awareness batch \S+ could not be retired \(injected retire failure\); it stays prepared, none of its marks to be sent, until the next start retires it\. To apply its marks, run the recovery again onto a new --branch, choosing them again$/,
      );
    } finally {
      ContextManager.prototype.branchAt = branchAt;
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['discarded', 'prepared'] });
    // A recovery without suppressions claims no name, since no start
    // completes its marks: a retry under the same name goes ahead.
    const retried = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'fresh2',
    });
    assert.equal(retried.targetBranch, 'fresh2');
    // The next start retires the old batch; the retry's own batch is active.
    const reopened = JsStore.open({ path: storePath });
    try {
      const exists = (name: string) => reopened.listBranches().some((branch) => branch.name === name);
      const recovered = new DiscordAwarenessOutbox(reopened).recoverAtStartup(exists);
      assert.deepEqual(recovered.retired.map((r) => [r.targetBranch, r.reason]), [['fresh2', 'interrupted']]);
      assert.deepEqual(new DiscordAwarenessOutbox(reopened).batches().map((b) => b.status), ['discarded', 'discarded', 'active']);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline recovery onto a name a pending suppression claims is refused, and prepares nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-claim-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-safe' });
    cm.addMessage('user', [{ type: 'text', text: 'later' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-later' });
    // What a suppression whose retirement failed leaves: its removals
    // pending for `claimed`, which doesn't exist.
    new DiscordAwarenessOutbox(store).prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'claimed', refs: [], scope: 'none',
      activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'x1', toId: 'x1' }],
    });
    cm.close();
    store.close();
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm-safe', branchName: 'claimed' }),
      /^Error: Recovery branch claimed is the target of suppression \S+, whose removals aren't recorded as finished: a start on a branch with that name would apply them there\. Choose another --branch\. The name is free once a start finds no branch with it and gives the suppression up$/,
    );
    const reopened = JsStore.open({ path: storePath });
    try {
      assert.equal(reopened.currentBranch().name, 'main');
      assert.equal(new DiscordAwarenessOutbox(reopened).batches().length, 1, 'the refusal prepared nothing');
      // A journal that can't be read can't say which names are claimed: any
      // recovery is refused.
      reopened.appendJson(DISCORD_AWARENESS_RECORD_TYPE, { records: 'nope' });
    } finally {
      reopened.close();
    }
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm-safe', branchName: 'unclaimed' }),
      /^Error: Recovery branch unclaimed can't be made: the Discord awareness journal, or the pre-journal ledger it imports \(--outbox\), can't be read \(Corrupt Discord awareness journal entry \S+\), so whether a suppression's pending removals claim that name can't be checked\. Running the recovery again changes nothing until both can be read: an entry a later build wrote stays unreadable, and stops every start too, until a build that reads its format runs, and a corrupt entry, or a pre-journal ledger that can't be read, until it is repaired; each is the host operator's to do$/,
    );
    const after = JsStore.open({ path: storePath });
    try {
      assert.equal(after.currentBranch().name, 'main');
      assert.ok(!after.listBranches().some((branch) => branch.name === 'unclaimed'), 'no branch was made');
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A document posted twice stores two runs of shards under one bodyGroupId
// (the chunker names a group by its text). Each run is a body of its own.
type ShardAppender = {
  messageStore: {
    append: (
      participant: string,
      content: unknown[],
      metadata?: unknown,
      causedBy?: unknown,
      extra?: { bodyGroupId: string; shardIndex: number },
    ) => { id: unknown };
  };
};

/** One body of `texts.length` shards, each stored with its own Discord message id. */
function appendShards(cm: ContextManager, group: string, discordIds: string[]): string[] {
  return discordIds.map((discordMessageId, shardIndex) => String(
    (cm as unknown as ShardAppender).messageStore.append(
      'user',
      [{ type: 'text', text: `shard ${shardIndex}` }],
      { serverId: 'discord', channelId: 'discord:g1:c1', messageId: discordMessageId },
      undefined,
      { bodyGroupId: group, shardIndex },
    ).id,
  ));
}

function appendDocumentCopy(cm: ContextManager, discordMessageId: string): string[] {
  return ['part one', 'part two'].map((text, shardIndex) => String(
    (cm as unknown as ShardAppender).messageStore.append(
      'user',
      [{ type: 'text', text }],
      { serverId: 'discord', channelId: 'discord:g1:c1', messageId: discordMessageId },
      undefined,
      { bodyGroupId: 'doc-group', shardIndex },
    ).id,
  ));
}

test('an anchor at the end of one copy of a reposted document does not split it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-repost-anchor-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    const first = appendDocumentCopy(cm, 'm-doc-1');
    appendDocumentCopy(cm, 'm-doc-2');
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      contextId: first[1],
      branchName: 'recovery/cairn/repost-anchor',
    });

    assert.equal(result.messagesRemoved, 2);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['m-doc-2']);
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({ store: recoveredStore, namespace: 'agents/cairn' });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-before', 'm-doc-1', 'm-doc-1'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an anchor inside one copy of a document still splits its body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-split-anchor-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    const first = appendDocumentCopy(cm, 'm-doc-1');
    appendDocumentCopy(cm, 'm-doc-2');
    cm.close();
    store.close();

    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath,
        agentName: 'cairn',
        contextId: first[0],
        branchName: 'recovery/cairn/split-anchor',
      }),
      /splits body group doc-group; choose its final shard/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suppressing one copy of a reposted document keeps the other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-repost-suppress-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    appendDocumentCopy(cm, 'm-doc-1');
    appendDocumentCopy(cm, 'm-doc-2');
    cm.addMessage('user', [{ type: 'text', text: 'current' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      suppressMessageIds: ['m-doc-2'],
    });

    assert.equal(result.messagesRemoved, 0);
    assert.equal(result.messagesSuppressed, 2);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['m-doc-2']);
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({ store: recoveredStore, namespace: 'agents/cairn' });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-before', 'm-doc-1', 'm-doc-1', 'm-current'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suppression that splits one copy of a document is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-split-suppress-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    appendShards(cm, 'doc-group', ['m-s0', 'm-s1']);
    appendShards(cm, 'doc-group', ['m-t0', 'm-t1']);
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
        suppressMessageIds: ['m-s1'],
      }),
      /Recovery selection splits body group doc-group/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a split across a scan window is refused too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-split-seam-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    // 999 plain messages put the body's shards at positions 999 and 1000,
    // on either side of the validator's 1,000-message scan window.
    for (let i = 0; i < 999; i++) cm.addMessage('user', [{ type: 'text', text: `filler ${i}` }]);
    appendShards(cm, 'seam-group', ['m-s0', 'm-s1']);
    cm.addMessage('user', [{ type: 'text', text: 'current' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    assert.equal(cm.getMessageCount(), 1002);
    cm.close();
    store.close();

    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath,
        agentName: 'cairn',
        messageId: 'm-current',
        suppressMessageIds: ['m-s1'],
      }),
      /Recovery selection splits body group seam-group/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suppressing a one-shard copy of a reposted document keeps the other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-one-shard-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    appendShards(cm, 'one-shard-group', ['m-doc-1']);
    appendShards(cm, 'one-shard-group', ['m-doc-2']);
    cm.addMessage('user', [{ type: 'text', text: 'current' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      suppressMessageIds: ['m-doc-2'],
    });

    assert.equal(result.messagesSuppressed, 1);
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({ store: recoveredStore, namespace: 'agents/cairn' });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-before', 'm-doc-1', 'm-current'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suppressed message outside any body is removed alone, and a one-shard copy as a range', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-removal-kind-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    const plain = String(cm.addMessage('user', [{ type: 'text', text: 'plain' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-plain',
    }));
    appendShards(cm, 'one-shard-group', ['m-doc-1']);
    const [copy] = appendShards(cm, 'one-shard-group', ['m-doc-2']);
    cm.addMessage('user', [{ type: 'text', text: 'current' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    cm.close();
    store.close();

    // removeMessage's remove event also drops the context-log entries copied
    // from the message; context-manager refuses it for any shard.
    const removeMessage = t.mock.method(ContextManager.prototype, 'removeMessage');
    const removeMessages = t.mock.method(ContextManager.prototype, 'removeMessages');
    const result = await createOfflineRecoveryBranch({
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      suppressMessageIds: ['m-plain', 'm-doc-2'],
    });

    assert.equal(result.messagesSuppressed, 2);
    assert.deepEqual(removeMessage.mock.calls.map((call) => String(call.arguments[0])), [plain]);
    assert.deepEqual(removeMessages.mock.calls.map((call) => call.arguments.map(String)), [[copy, copy]]);
    removeMessage.mock.restore();
    removeMessages.mock.restore();
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({ store: recoveredStore, namespace: 'agents/cairn' });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-before', 'm-doc-1', 'm-current'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an anchor at the end of a write that was cut short keeps that partial body and leaves out its retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-cut-short-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    // Two of a body's shards, written before an interruption, then its retry
    // from shard 0: the retry is a body of its own.
    const partial = appendShards(cm, 'cut-group', ['m-cut-0', 'm-cut-1']);
    appendShards(cm, 'cut-group', ['m-retry-0', 'm-retry-1', 'm-retry-2']);
    cm.close();
    store.close();

    const result = await createOfflineRecoveryBranch({
      marks: { scope: 'all' },
      storePath,
      agentName: 'cairn',
      contextId: partial[1],
      branchName: 'recovery/cairn/cut-short',
    });

    assert.equal(result.messagesRemoved, 3);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['m-retry-0', 'm-retry-1', 'm-retry-2']);
    const recoveredStore = JsStore.openOrCreate({ path: storePath });
    const recoveredCm = await ContextManager.open({ store: recoveredStore, namespace: 'agents/cairn' });
    assert.deepEqual(
      recoveredCm.getAllMessages().map((message) => message.metadata?.messageId),
      ['m-before', 'm-cut-0', 'm-cut-1'],
    );
    recoveredCm.close();
    recoveredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline recovery refuses a marks choice the live methods refuse, before anything is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-bad-marks-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const seed = async () => {
      rmSync(storePath, { recursive: true, force: true });
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
    // A bare scope string (the host/command vocabulary), a misspelled scope
    // and an unknown scope would each skip the scope filter and mark every
    // removed message, ambient ones included. Refs that aren't a list, or a
    // ref that isn't an address, aren't a choice either.
    const malformed = [
      'addressed', 'all', { scop: 'addressed' }, { scope: 'every' }, { scope: 'addressed', refs: 'm-addressed' },
      { scope: 'addressed', refs: [{ serverId: 'discord', channelId: 'discord:g1:c1' }] },
    ];
    for (const marks of malformed) {
      for (const dryRun of [true, false]) {
        await seed();
        await assert.rejects(
          createOfflineRecoveryBranch({
            storePath, agentName: 'cairn', messageId: 'm-safe', marks: marks as never, dryRun, branchName: 'recovery/cairn/bad',
          }),
          (error: unknown) => error instanceof OperatorActionError && error.code === 'invalid'
            && /^marks must be 'none' or \{ scope: 'addressed' \| 'all', refs\? \}/.test(error.message),
          `${JSON.stringify(marks)}${dryRun ? ', dry run' : ''}`,
        );
        readJournal(storePath, (outbox, store) => {
          assert.equal(outbox.batches().length, 0, 'no batch was prepared');
          assert.equal(outbox.pendingDispatches('discord').length, 0, 'nothing is queued for Discord');
          assert.equal(store.listBranches().some((branch) => branch.name === 'recovery/cairn/bad'), false, 'no branch was made');
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
