import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';
import {
  DiscordAwarenessOutbox,
  defaultDiscordAwarenessOutboxPath,
} from '../src/recovery/discord-awareness-outbox.js';

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

    const batches = new DiscordAwarenessOutbox(
      defaultDiscordAwarenessOutboxPath(storePath),
    ).pending('discord');
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map((operation) => operation.ref.messageId), ['m-toxic-1', 'm-toxic-2']);

    // The outbox is metadata-only: quarantined text must never leak to it.
    const rawOutbox = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(defaultDiscordAwarenessOutboxPath(storePath), 'utf8'));
    assert.ok(!rawOutbox.includes('never echo this one'));
    assert.ok(!rawOutbox.includes('or this one'));
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

    const batches = new DiscordAwarenessOutbox(
      defaultDiscordAwarenessOutboxPath(storePath),
    ).pending('discord');
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.map((operation) => operation.ref.messageId),
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
