import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';
import { OperatorActionError } from '../src/operator-log.js';
import {
  DiscordAwarenessOutbox,
  defaultDiscordAwarenessOutboxPath,
} from '../src/recovery/discord-awareness-outbox.js';

/** The store's awareness ledger, read with the host (and CLI) stopped. */
const ledger = (storePath: string) => new DiscordAwarenessOutbox(defaultDiscordAwarenessOutboxPath(storePath));

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

    assert.equal(result.outboxPath, defaultDiscordAwarenessOutboxPath(storePath));
    const owed = ledger(storePath).due('discord');
    assert.equal(owed.length, 2);
    assert.deepEqual(owed.map((request) => request.messageId), ['m-toxic-1', 'm-toxic-2']);

    // The ledger is metadata-only: quarantined text must never leak to it.
    const rawLedger = readFileSync(result.outboxPath, 'utf8');
    assert.ok(rawLedger.length > 0);
    assert.ok(!rawLedger.includes('never echo this one'));
    assert.ok(!rawLedger.includes('or this one'));
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

    const batches = ledger(storePath).due('discord');
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.map((request) => request.messageId),
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
    assert.equal(existsSync(defaultDiscordAwarenessOutboxPath(storePath)), false, 'nothing is recorded: no batch, and nothing queued for Discord');

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
      ledger(storePath).due('discord').map((request) => request.messageId),
      ['m-addressed'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an offline recovery rewrites a version 2 ledger as version 3, naming on stderr the marks it drops, none of them sent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-v2-'));
  const storePath = join(dir, 'agent.chronicle');
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-safe' });
    cm.addMessage('user', [{ type: 'text', text: 'later' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-later' });
    cm.close();
    store.close();
    // What agent-framework 0.22.x left: an active batch with an add still to make.
    const path = defaultDiscordAwarenessOutboxPath(storePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 2,
      batches: [{
        id: 'legacy', status: 'active', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1',
        emoji: '💤', createdAt: 1,
        refs: [{ serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-old', desired: true, markerPresent: false,
          deliveryStatus: 'pending', attempts: 0 }],
      }],
    }));
    const recovered = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'recovery/cairn/v2',
    });
    assert.equal(recovered.markers?.status, 'queued');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(file.version, 3);
    assert.deepEqual(file.batches.map((batch: { id: string; status: string }) => [batch.id, batch.status]).slice(0, 1), [['legacy', 'active']]);
    assert.ok(logged.some((line) => line.startsWith(`[discord-awareness] rewriting ${path} as version 3: 1 batch(es) had marks`)
      && line.includes('batch legacy (cairn, main to rollback/cairn/1): 1 to add, 0 to remove')), logged.join('\n'));
    assert.deepEqual(ledger(storePath).due('discord').map((request) => request.messageId), ['m-later'], "0.22.x's add is never sent");
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
    // settleActivation's own activation, which it falls back from.
    const proto = DiscordAwarenessOutbox.prototype as unknown as { activateIn: (...args: unknown[]) => Promise<number> };
    const original = proto.activateIn;
    proto.activateIn = async function () { throw new Error('injected activation failure'); };
    let result: Awaited<ReturnType<typeof createOfflineRecoveryBranch>>;
    try {
      result = await createOfflineRecoveryBranch({
        storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'recovery/cairn/settle',
      });
    } finally {
      proto.activateIn = original;
    }
    assert.equal(result.markers?.status, 'not-scheduled');
    assert.match(result.markers?.status === 'not-scheduled' ? result.markers.error : '', /injected activation failure/);
    assert.equal(result.discordMarkersQueued, 0);
    const reopened = JsStore.openOrCreate({ path: storePath });
    try {
      assert.equal(reopened.currentBranch().name, 'recovery/cairn/settle', 'the recovery branch stands');
    } finally {
      reopened.close();
    }
    assert.equal(ledger(storePath).batches()[0].status, 'retired');
    assert.deepEqual(ledger(storePath).due('discord'), []);
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
      const outbox = ledger(storePath);
      return { branch: store.currentBranch().name, statuses: outbox.batches().map((b) => b.status), due: outbox.due().length };
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
      (error: Error) => /^injected redaction failure; branch recovery\/cairn\/fail is kept for diagnosis: it may be partly suppressed, so don't start on it, and delete it once it has been looked at \(the host API's branch\.delete, once the host runs\); awareness batch \S+ retired, none of its marks sent\. To apply its marks, run the recovery again onto a new --branch, choosing them again$/.test(error.message),
    );
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['retired'], due: 0 });

    // The source comes back but retiring the batch fails: the error says its
    // marks are never sent, and that its removals stay pending for the kept
    // branch, whose name stays claimed.
    await seed();
    const discard = DiscordAwarenessOutbox.prototype.discard;
    DiscordAwarenessOutbox.prototype.discard = async function () { throw new Error('injected retire failure'); };
    try {
      await assert.rejects(
        createOfflineRecoveryBranch({
          storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
          marks: { scope: 'all' }, branchName: 'recovery/cairn/fail1',
        }),
        /awareness batch \S+ could not be retired \(injected retire failure\); it stays prepared, none of its marks to be sent\. Its removals stay pending for recovery\/cairn\/fail1: a start on a branch with that name would finish them there and retire the batch, and recovery\/cairn\/fail1 is kept, so delete it unless you want that, through the host API's branch\.delete once the host runs\. To apply its marks, run the recovery again onto a new --branch, choosing them again/,
      );
    } finally {
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['prepared'], due: 0 });
    assert.deepEqual((await ledger(storePath).recoverAtStartup()).retired, [],
      'a start on the source leaves it: its removals are pending on its branch, which exists');
    assert.equal(ledger(storePath).batches()[0].status, 'prepared');

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

test('a failed offline suppression whose branch was never made says its removals stay pending for that name', async () => {
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
    DiscordAwarenessOutbox.prototype.discard = async function () { throw new Error('injected retire failure'); };
    await assert.rejects(
      createOfflineRecoveryBranch({
        storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'],
        marks: { scope: 'all' }, branchName: 'recovery/cairn/never',
      }),
      /^Error: injected branch failure; awareness batch \S+ could not be retired \(injected retire failure\); it stays prepared, none of its marks to be sent\. Its removals stay pending for recovery\/cairn\/never: a start on a branch with that name would finish them there and retire the batch\. To apply its marks, run the recovery again onto a new --branch, choosing them again$/,
    );
  } finally {
    ContextManager.prototype.branchAt = branchAt;
    DiscordAwarenessOutbox.prototype.discard = discard;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline suppression whose resume record could not be closed says what became of it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-unclosed-'));
  const storePath = join(dir, 'agent.chronicle');
  const settleActivation = DiscordAwarenessOutbox.prototype.settleActivation;
  // Each case on a fresh store, since a recovery leaves its fork current.
  const recoverWith = async (settled: Awaited<ReturnType<typeof settleActivation>>, marks: 'none' | { scope: 'all' }) => {
    rmSync(storePath, { recursive: true, force: true });
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'keep' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-keep' });
    cm.addMessage('user', [{ type: 'text', text: 'hide me' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-a' });
    cm.addMessage('user', [{ type: 'text', text: 'anchor' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current' });
    cm.close();
    store.close();
    DiscordAwarenessOutbox.prototype.settleActivation = async function () { return settled; };
    return createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-current', suppressMessageIds: ['m-a'], branchName: 'recovery/cairn/close', marks,
    });
  };
  try {
    // No marks: the batch is the suppression's resume record alone.
    const left = await recoverWith({ status: 'not-scheduled', error: 'injected activation failure; retiring it also failed (injected), so it stays prepared' }, 'none');
    assert.equal(left.markers?.status, 'none');
    assert.match(left.suppressionRecord ?? '',
      /^the resume record \(awareness batch \S+, no marks\) could not be closed: injected activation failure; retiring it also failed \(injected\), so it stays prepared$/);
    const closed = await recoverWith({ status: 'queued', queued: 0 }, 'none');
    assert.equal(closed.suppressionRecord, undefined, 'a record closed says nothing');
    // With marks, the receipt is the settlement's.
    const marked = await recoverWith({ status: 'queued', queued: 2 }, { scope: 'all' });
    assert.deepEqual([marked.markers?.status, marked.markers?.queued], ['queued', 2]);
    assert.equal(marked.suppressionRecord, undefined);
    const unmarked = await recoverWith({ status: 'not-scheduled', error: 'injected activation failure' }, { scope: 'all' });
    assert.deepEqual([unmarked.markers?.status, (unmarked.markers as { error?: string }).error], ['not-scheduled', 'injected activation failure']);
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
        return { branch: reopened.currentBranch().name, statuses: ledger(storePath).batches().map((b) => b.status) };
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
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['retired'] });

    // The same failure with its retirement failing too: the batch stays
    // prepared until a start retires it, none of its marks sent.
    const discard = DiscordAwarenessOutbox.prototype.discard;
    ContextManager.prototype.branchAt = function () { throw new Error('injected branch failure'); };
    DiscordAwarenessOutbox.prototype.discard = async function () { throw new Error('injected retire failure'); };
    try {
      await assert.rejects(
        createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'fresh2' }),
        /^Error: injected branch failure; awareness batch \S+ could not be retired \(injected retire failure\); it stays prepared, none of its marks to be sent, until the next start retires it\. To apply its marks, run the recovery again onto a new --branch, choosing them again$/,
      );
    } finally {
      ContextManager.prototype.branchAt = branchAt;
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.deepEqual(inspect(), { branch: 'main', statuses: ['retired', 'prepared'] });
    // A retry under the same name goes ahead.
    const retried = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'm-safe', marks: { scope: 'all' }, branchName: 'fresh2',
    });
    assert.equal(retried.targetBranch, 'fresh2');
    // The next start retires the old batch; the retry's own batch is active.
    const recovered = await ledger(storePath).recoverAtStartup();
    assert.deepEqual(recovered.retired.map((r) => r.targetBranch), ['fresh2']);
    assert.deepEqual(ledger(storePath).batches().map((b) => b.status), ['retired', 'retired', 'active']);
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

test('a suppressed message outside any body and a one-shard copy are both removed, the copy without a refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-recovery-removal-kind-'));
  const storePath = join(dir, 'agent.chronicle');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'before' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-before',
    });
    cm.addMessage('user', [{ type: 'text', text: 'plain' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-plain',
    });
    appendShards(cm, 'one-shard-group', ['m-doc-1']);
    appendShards(cm, 'one-shard-group', ['m-doc-2']);
    cm.addMessage('user', [{ type: 'text', text: 'current' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-current',
    });
    cm.close();
    store.close();

    // context-manager refuses to remove a shard alone, so the copy's removal
    // has to take it as a range for the suppression to go through.
    const result = await createOfflineRecoveryBranch({
      storePath,
      agentName: 'cairn',
      messageId: 'm-current',
      suppressMessageIds: ['m-plain', 'm-doc-2'],
    });

    assert.equal(result.messagesSuppressed, 2);
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
        assert.equal(existsSync(defaultDiscordAwarenessOutboxPath(storePath)), false, 'no batch was prepared, and nothing is queued for Discord');
        const store = JsStore.openOrCreate({ path: storePath });
        try {
          assert.equal(store.listBranches().some((branch) => branch.name === 'recovery/cairn/bad'), false, 'no branch was made');
        } finally {
          store.close();
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the recover CLI places no marks unless --marks chooses them, and refuses a mistyped choice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-'));
  const storePath = join(dir, 'store');
  const cli = fileURLToPath(new URL('../src/recovery/recover-cli.js', import.meta.url));
  const recover = (...args: string[]) => spawnSync(process.execPath, [cli, '--store', storePath, '--agent', 'cairn', ...args], { encoding: 'utf8' });
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-safe' });
    cm.addMessage('user', [{ type: 'text', text: 'one' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-1', tags: ['chat:addressed'] });
    cm.addMessage('user', [{ type: 'text', text: 'two' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm-2', tags: ['chat:ambient'] });
    cm.close();
    store.close();

    const typo = recover('--message-id', 'm-safe', '--marks', 'adressed');
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /--marks must be none, addressed or all/);
    // A dry run shows what the choice covers, and changes nothing.
    const planned = recover('--message-id', 'm-safe', '--marks', 'addressed', '--dry-run');
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.marksScope, 'addressed');
    assert.deepEqual(plan.refs.map((ref: { messageId: string }) => ref.messageId), ['m-1']);
    assert.equal(plan.unmarked, 1);
    // Left out, the choice is none: the recovery is local to the resident.
    const local = recover('--message-id', 'm-safe', '--branch', 'recovery/cairn/1');
    assert.equal(local.status, 0, local.stderr);
    const result = JSON.parse(local.stdout);
    assert.equal(result.marksScope, 'none');
    assert.deepEqual(result.markers, { scope: 'none', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 });
    assert.equal(result.messagesRemoved, 2);
    assert.equal(existsSync(defaultDiscordAwarenessOutboxPath(storePath)), false, 'nothing is queued for Discord');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
