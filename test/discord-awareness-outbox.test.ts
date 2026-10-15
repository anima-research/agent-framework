import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DiscordAwarenessOutbox,
  extractDiscordAwarenessRefs,
} from '../src/recovery/discord-awareness-outbox.js';
import { AgentFramework } from '../src/framework.js';
import { OperatorLog } from '../src/operator-log.js';

test('extractDiscordAwarenessRefs keeps only direct Discord addressing metadata', () => {
  const refs = extractDiscordAwarenessRefs([
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'portal', channelId: 'portal:thread-1', messageId: 'p1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1' } },
  ]);

  assert.deepEqual(refs, [
    { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
  ]);
});

test('ledger survives restart and reverses completed markers on source branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-outbox-'));
  const path = join(dir, 'outbox.json');
  try {
    const first = new DiscordAwarenessOutbox(path);
    const batch = first.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/1',
      refs: [
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm2' },
      ],
    });
    assert.ok(batch);
    assert.equal(first.pending('discord').length, 0, 'prepared work is not delivered early');

    // Simulate the host restarting after Chronicle switched branches but
    // before the recovery process activated its batch.
    const reopened = new DiscordAwarenessOutbox(path);
    assert.equal(reopened.activatePreparedForBranch('some-other-branch'), 0);
    assert.equal(reopened.activatePreparedForBranch('recovery/cairn/1'), 1);
    assert.deepEqual(
      reopened.pending('discord').map((operation) => operation.ref.messageId),
      ['m1', 'm2'],
    );

    reopened.recordSuccess(batch.id, batch.refs[0], 'add');
    assert.deepEqual(reopened.pending('discord').map((op) => op.ref.messageId), ['m2']);
    reopened.recordSuccess(batch.id, batch.refs[1], 'add');
    assert.equal(reopened.pending('discord').length, 0);

    // Completed work remains durable and switching back queues removals.
    reopened.reconcileForBranch('main');
    const removals = reopened.pending('discord');
    assert.deepEqual(removals.map((op) => op.action), ['remove', 'remove']);
    for (const operation of removals) {
      reopened.recordSuccess(operation.batchId, operation.ref, operation.action);
    }
    assert.equal(reopened.pending('discord').length, 0);
    assert.equal(reopened.batches().length, 1);
    assert.ok(reopened.batches()[0].refs.every((ref) => !ref.markerPresent));

    const stored = JSON.parse(readFileSync(path, 'utf8')) as { version: number; batches: unknown[] };
    assert.equal(stored.version, 2);
    assert.equal(stored.batches.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit batches are not activated merely because their target branch is current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-explicit-'));
  const path = join(dir, 'outbox.json');
  try {
    const outbox = new DiscordAwarenessOutbox(path);
    const batch = outbox.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/suppressed',
      activationPolicy: 'explicit',
      refs: [
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
      ],
    })!;

    assert.equal(outbox.activatePreparedForBranch('recovery/cairn/suppressed'), 0);
    assert.equal(outbox.pending('discord').length, 0);
    outbox.activate(batch.id);
    assert.equal(outbox.pending('discord').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('framework resumes an interrupted suppression before activating its markers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-resume-'));
  const path = join(dir, 'outbox.json');
  try {
    const outbox = new DiscordAwarenessOutbox(path);
    const batch = outbox.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/suppressed',
      activationPolicy: 'explicit',
      suppressionIntervals: [
        { fromId: 'i1', toId: 'i2' },
        { fromId: 'i3', toId: 'i3' },
      ],
      refs: [
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
      ],
    })!;
    const present = new Set(['i1', 'i2']); // i3 interval committed before crash.
    const removals: string[] = [];
    const cm = {
      getMessage: (id: string) => present.has(id) ? { id } : null,
      removeMessage: (id: string) => { present.delete(id); removals.push(id); },
      removeMessages: (from: string, to: string) => {
        present.delete(from); present.delete(to); removals.push(`${from}..${to}`);
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = outbox;
    framework.store = {
      currentBranch: () => ({ name: 'recovery/cairn/suppressed' }),
      listBranches: () => [],
    };
    framework.agents = new Map([['cairn', { getContextManager: () => cm }]]);

    await framework.resumePreparedDiscordSuppressions();

    assert.deepEqual(removals, ['i1..i2']);
    assert.equal(outbox.batches().find((candidate) => candidate.id === batch.id)?.status, 'active');
    assert.deepEqual(outbox.pending('discord').map((operation) => operation.ref.messageId), ['m1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('framework drain records failures per ref and continues past permanent failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-drain-'));
  const path = join(dir, 'outbox.json');
  try {
    const outbox = new DiscordAwarenessOutbox(path);
    const batch = outbox.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/2',
      refs: [
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm2' },
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm3' },
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm4' },
      ],
    })!;
    outbox.activate(batch.id);

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let retryableFailure = true;
    const connection = {
      isConnected: true,
      sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (args.messageId === 'm2') {
          return { isError: true, content: [{ type: 'text', text: 'Unknown Message' }] };
        }
        if (args.messageId === 'm3' && retryableFailure) throw new Error('Discord unavailable');
        return { content: [{ type: 'text', text: 'Reaction added' }] };
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = outbox;
    framework.discordAwarenessDrains = new Map();
    framework.mcplServerRegistry = { getServer: () => connection };

    const originalError = console.error;
    console.error = () => {};
    try {
      await framework.drainDiscordAwarenessOutbox('discord');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(calls[0], {
      name: 'add_reaction',
      args: { channelId: 'c1', messageId: 'm1', emoji: '💤' },
    });
    assert.deepEqual(outbox.pending('discord').map((operation) => operation.ref.messageId), ['m3']);
    assert.deepEqual(calls.map((call) => call.args.messageId), ['m1', 'm2', 'm3', 'm4']);
    const entries = outbox.batches()[0].refs;
    assert.equal(entries.find((entry) => entry.messageId === 'm2')?.deliveryStatus, 'permanent-failure');
    assert.equal(entries.find((entry) => entry.messageId === 'm3')?.deliveryStatus, 'pending');
    assert.equal(entries.find((entry) => entry.messageId === 'm4')?.deliveryStatus, 'applied');

    retryableFailure = false;
    await framework.drainDiscordAwarenessOutbox('discord');
    assert.equal(outbox.pending('discord').length, 0);

    outbox.reconcileForBranch('main');
    calls.length = 0;
    await framework.drainDiscordAwarenessOutbox('discord');
    assert.deepEqual(calls.map((call) => [call.name, call.args.messageId]), [
      ['remove_reaction', 'm1'],
      ['remove_reaction', 'm3'],
      ['remove_reaction', 'm4'],
    ]);
    assert.ok(outbox.batches()[0].refs.every((entry) => !entry.markerPresent));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message-granular undo prepares markers before switching branches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-undo-'));
  const path = join(dir, 'outbox.json');
  try {
    const messages = [
      { id: 'i0', metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm0' } },
      { id: 'i1', metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
      { id: 'i2', metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm2' } },
    ];
    const calls: string[] = [];
    let currentBranch = 'main';
    const contextManager = {
      getAllMessages: () => messages,
      // Windowed reads — what the live rollback path uses so it never
      // re-inflates every attachment on the branch.
      getMessageCount: () => messages.length,
      getMessageWindow: (offset: number, limit: number) => ({
        messages: messages.slice(offset, offset + limit),
        startIndex: offset,
        totalCount: messages.length,
      }),
      branchAt: (_id: string, name: string) => { calls.push(`branch:${name}`); return name; },
      switchBranch: async (name: string) => { calls.push(`switch:${name}`); currentBranch = name; },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.agents = new Map([['cairn', {
      state: { status: 'idle' },
      getContextManager: () => contextManager,
    }]]);
    framework.store = {
      currentBranch: () => ({ name: currentBranch }),
      listBranches: () => [
        { id: 'b-main', name: 'main' },
        { id: 'b-undo', name: currentBranch, parentId: 'b-main' },
      ],
    };
    framework.discordAwarenessOutbox = new DiscordAwarenessOutbox(path);
    framework.discordAwarenessEmoji = '🫥';
    framework.discordAwarenessDrains = new Map();
    framework.mcplServerRegistry = null;
    framework.moduleRegistry = { getModule: () => null };
    framework.lastVisiblePreview = async () => null;
    // Live rollback reserves the store: it mints turn tokens for every agent
    // and flushes deferred writers on release — give the stub those fields.
    framework.activeTurnTokens = new Map();
    framework.nextTurnToken = 1;
    framework.deferredMessages = [];
    framework.pendingAssistantBlocks = new Map();
    // A host/command and a store surgery are operations stop() waits for.
    framework.operatorOperations = new Set();
    framework.operatorLog = new OperatorLog(undefined);

    const result = await framework.handleHostCommand('discord', {
      command: 'undo', agentName: 'cairn', messages: 2,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.removedRefs.map((ref: { messageId: string }) => ref.messageId), ['m1', 'm2']);
    // The command's receipt says the two marks were scheduled, under the batch the ledger holds.
    const [batch] = framework.discordAwarenessOutbox.batches();
    assert.deepEqual(result.markers, { status: 'queued', queued: 2, batchId: batch.id });
    assert.deepEqual(calls.map((call) => call.split('/')[0]), ['branch:undo-msgs', 'switch:undo-msgs']);
    assert.deepEqual(
      framework.discordAwarenessOutbox.pending('discord').map((operation: { ref: { messageId: string } }) => operation.ref.messageId),
      ['m1', 'm2'],
    );
    assert.ok(framework.discordAwarenessOutbox.pending('discord').every(
      (operation: { emoji: string }) => operation.emoji === '🫥',
    ));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
