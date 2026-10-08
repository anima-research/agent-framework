/**
 * Live operator surgery: rollbackToMessage / suppressMessages on an OPEN
 * store, and the durable operator-actions.jsonl record every operator
 * mutation leaves behind.
 *
 * Asserted at the store seam (branch names, message counts on each branch,
 * log file contents, operator:action traces) — no inference runs.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, OperatorActionError, OperatorLog } from '../src/index.js';
import type { OperatorLogEntry, TraceEvent } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function readLog(path: string): OperatorLogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as OperatorLogEntry);
}

describe('live operator surgery', () => {
  let tempDir: string;
  let storePath: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  let traces: TraceEvent[];
  let ids: string[];

  const cm = () => framework.getAgent('scout')!.getContextManager();
  const remainingTexts = () =>
    cm().getAllMessages().map((m) => (m.content[0] as { text: string }).text);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'operator-surgery-test-'));
    storePath = join(tempDir, 'test.chronicle');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    traces = [];
    framework.onTrace((e) => { traces.push(e); });
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
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults the operator log next to the store', () => {
    assert.equal(framework.getOperatorLogPath(), join(storePath, 'operator-actions.jsonl'));
  });

  it('rollbackToMessage forks at the message, switches to the fork, keeps the source intact, logs', async () => {
    const r = await framework.rollbackToMessage('scout', {
      messageId: ids[2],
      requester: { via: 'webui', name: 'antra' },
      note: 'bad turn',
    });
    assert.equal(r.sourceBranch, 'main');
    assert.match(r.targetBranch, /^rollback\/scout\/\d+$/);
    assert.equal(r.messagesRemoved, 2);
    assert.equal(r.removedRefs.length, 2, 'discord refs of the discarded messages are collected');
    assert.equal(cm().currentBranch().name, r.targetBranch);
    assert.deepEqual(remainingTexts(), ['m1', 'm2', 'm3']);

    // The source branch still has everything.
    await cm().switchBranch('main');
    assert.deepEqual(remainingTexts(), ['m1', 'm2', 'm3', 'm4', 'm5']);

    const log = readLog(framework.getOperatorLogPath()!);
    const entry = log.find((e) => e.kind === 'rollback');
    assert.ok(entry, 'rollback recorded in operator-actions.jsonl');
    assert.equal(entry.agent, 'scout');
    assert.deepEqual(entry.requester, { via: 'webui', name: 'antra' });
    assert.equal(entry.note, 'bad turn');
    // The marks choice is recorded with the operator's other parameters.
    assert.deepEqual(entry.params, { messageId: ids[2], marks: 'none' });
    assert.equal(entry.result?.messagesRemoved, 2);
    assert.equal(entry.result?.targetBranch, r.targetBranch);
    assert.ok(typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)));

    const trace = traces.find((t) => t.type === 'operator:action' && t.kind === 'rollback');
    assert.ok(trace, 'operator:action trace broadcast');
    assert.equal((trace as { agentName?: string }).agentName, 'scout');
  });

  it('rollback refuses the tail, unknown ids, and busy agents — and logs the refusal', async () => {
    await assert.rejects(
      framework.rollbackToMessage('scout', { messageId: ids[4] }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid',
    );
    await assert.rejects(
      framework.rollbackToMessage('scout', { messageId: 'nope' }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'unknown-message',
    );
    const agent = framework.getAgent('scout')! as unknown as { _state: { status: string } };
    agent._state = { status: 'inferring' };
    try {
      await assert.rejects(
        framework.rollbackToMessage('scout', { messageId: ids[1] }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy',
      );
    } finally {
      agent._state = { status: 'idle' };
    }
    assert.equal(cm().currentBranch().name, 'main', 'nothing moved');
    assert.equal(cm().getMessageCount(), 5);
    const errors = readLog(framework.getOperatorLogPath()!).filter((e) => e.kind === 'rollback' && e.error);
    assert.equal(errors.length, 3);
    assert.match(errors[2].error!, /Cannot roll back while scout is inferring/);
  });

  // --- store-wide exclusion ---------------------------------------------------
  // A branch switch moves the active branch for EVERY context manager on the
  // store; the gate must cover every agent, and hold across the await.

  it('refuses surgery on an idle agent while a different agent sharing the store has a turn alive', async () => {
    await framework.stop();
    framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'shade', model: 'test-model', systemPrompt: 'You are shade.' },
      ],
      modules: [],
    });
    const tokens = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    const shadeBefore = framework.getAgent('shade')!.getContextManager().getMessageCount();
    tokens.set('shade', 7);
    try {
      await assert.rejects(
        framework.rollbackToMessage('scout', { messageId: ids[1] }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /shade is idle\+turn-alive/.test(e.message),
      );
      await assert.rejects(
        framework.suppressMessages('scout', { messageIds: [ids[1]] }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /shade/.test(e.message),
      );
    } finally {
      tokens.delete('shade');
    }
    assert.equal(cm().currentBranch().name, 'main', 'shared branch untouched');
    assert.equal(framework.getAgent('shade')!.getContextManager().getMessageCount(), shadeBefore, "shade's history untouched");

    // With shade idle the same call goes through — and the reservation is
    // released afterwards (no token left behind on either agent).
    const r = await framework.rollbackToMessage('scout', { messageId: ids[1] });
    assert.equal(r.messagesRemoved, 3);
    assert.equal(tokens.size, 0, 'store reservation released');
  });

  it('holds a turn token on every agent for the duration of the switch', async () => {
    const tokens = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    const c = cm() as unknown as { switchBranch: (name: string) => Promise<void> };
    const original = c.switchBranch;
    let heldDuringSwitch: number | null = null;
    c.switchBranch = async (name: string) => { heldDuringSwitch = tokens.size; return original.call(c, name); };
    try {
      await framework.rollbackToMessage('scout', { messageId: ids[2] });
    } finally {
      c.switchBranch = original;
    }
    assert.equal(heldDuringSwitch, 1, 'reservation held while the switch was awaited');
    assert.equal(tokens.size, 0, 'and released after');
  });

  it('holds the store against agents admitted AFTER the reservation: ephemeral admission is refused (ticket kept) and wakes are parked', async () => {
    // Hold the awaited switch open so the surgery is mid-flight.
    const c = cm() as unknown as { switchBranch: (name: string) => Promise<void> };
    const originalSwitch = c.switchBranch;
    let releaseSwitch!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
    c.switchBranch = async (name: string) => { await gate; return originalSwitch.call(c, name); };
    // An ephemeral candidate: not in this.agents, so the token snapshot
    // cannot cover it — this is the reviewer's dynamic-admission probe.
    const worker = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    });
    worker.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    const internals = framework as unknown as {
      surgeryHold: unknown;
      pendingRequests: unknown[];
      ephemeralCandidates: Map<unknown, unknown>;
      processInferenceRequests(): Promise<void>;
    };
    try {
      const rollback = framework.rollbackToMessage('scout', { messageId: ids[1] });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(internals.surgeryHold, 'store hold is up while the switch is awaited');

      await assert.rejects(
        framework.runEphemeralToCompletion(worker.agent, worker.contextManager),
        /under live roll back/,
      );
      assert.equal(internals.ephemeralCandidates.get(worker.agent), worker.contextManager,
        'refused BEFORE consuming the generation ticket — a clean retry stays possible');

      // A wake arriving now is parked by the scheduler, not started.
      framework.nudgeAgent('scout', 'test');
      await internals.processInferenceRequests();
      assert.equal(membrane.calls.length, 0, 'no provider call while the store is held');
      assert.ok(internals.pendingRequests.length >= 1, 'the wake is requeued for after the surgery');

      releaseSwitch();
      const r = await rollback;
      assert.equal(r.messagesRemoved, 3);
      assert.equal(internals.surgeryHold, null, 'hold released with the reservation');
      assert.equal(membrane.calls.length, 0);
    } finally {
      c.switchBranch = originalSwitch;
      worker.cleanup();
    }
  });

  // --- strategy-initialization failure -----------------------------------------
  // switchBranch()/fork() move the chronicle branch BEFORE awaiting strategy
  // initialization, so a rejection there leaves the store on the new branch.

  const failNextStrategyInit = (): (() => void) => {
    const c = cm() as unknown as { initializeStrategy: (...a: unknown[]) => Promise<void> };
    const original = c.initializeStrategy;
    let armed = true;
    c.initializeStrategy = async function (this: unknown, ...args: unknown[]) {
      if (armed) { armed = false; throw new Error('injected strategy init failure'); }
      return original.apply(this, args);
    };
    return () => { c.initializeStrategy = original; };
  };

  it('rollback restores the source branch when strategy initialization rejects after the switch', async () => {
    const restore = failNextStrategyInit();
    try {
      await assert.rejects(
        framework.rollbackToMessage('scout', { messageId: ids[1], branchName: 'failed-rollback' }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed'
          && /active branch restored to main/.test(e.message) && /injected/.test(e.message),
      );
    } finally {
      restore();
    }
    assert.equal(cm().currentBranch().name, 'main');
    assert.equal(cm().isReady(), true, 'strategy re-initialized on the source branch');
    assert.deepEqual(remainingTexts(), ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.ok(cm().listBranches().some((b) => b.name === 'failed-rollback'), 'failed branch kept for diagnosis');
    const tokens = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    assert.equal(tokens.size, 0);
  });

  it('suppress restores the source branch when fork() rejects after the switch', async () => {
    const restore = failNextStrategyInit();
    try {
      await assert.rejects(
        framework.suppressMessages('scout', { messageIds: [ids[1]], branchName: 'failed-suppress' }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed'
          && /active branch restored to main/.test(e.message),
      );
    } finally {
      restore();
    }
    assert.equal(cm().currentBranch().name, 'main');
    assert.equal(cm().isReady(), true);
    assert.equal(cm().getMessageCount(), 5, 'nothing redacted anywhere visible');
    const outbox = (framework as unknown as { discordAwarenessOutbox: { batches(): Array<{ status: string }> } }).discordAwarenessOutbox;
    assert.equal(outbox.batches().filter((b) => b.status === 'prepared').length, 0);
  });

  it('suppressMessages forks at head, redacts only the chosen messages on the fork, logs', async () => {
    const r = await framework.suppressMessages('scout', {
      messageIds: [ids[1], ids[3], ids[3]],
      requester: { via: 'webui', name: 'antra' },
    });
    assert.equal(r.sourceBranch, 'main');
    assert.match(r.targetBranch, /^suppress\/scout\/\d+$/);
    assert.equal(r.messagesRemoved, 2);
    assert.deepEqual(new Set(r.removedIds), new Set([ids[1], ids[3]]));
    assert.equal(cm().currentBranch().name, r.targetBranch);
    assert.deepEqual(remainingTexts(), ['m1', 'm3', 'm5']);

    await cm().switchBranch('main');
    assert.deepEqual(remainingTexts(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'source branch untouched');

    const entry = readLog(framework.getOperatorLogPath()!).find((e) => e.kind === 'suppress');
    assert.ok(entry);
    assert.deepEqual(entry.params, { messageIds: [ids[1], ids[3]], marks: 'none' });
    assert.deepEqual(new Set(entry.result?.removedIds as string[]), new Set([ids[1], ids[3]]));
  });

  it('suppress validates every id before mutating anything', async () => {
    await assert.rejects(
      framework.suppressMessages('scout', { messageIds: [ids[0], 'ghost'] }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'unknown-message' && /ghost/.test(e.message),
    );
    await assert.rejects(
      framework.suppressMessages('scout', { messageIds: ids }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid',
    );
    assert.equal(cm().currentBranch().name, 'main');
    assert.equal(cm().listBranches().length, 1, 'no fork was created');
    assert.equal(cm().getMessageCount(), 5);
  });

  it('host-command message-granular undo rides on rollbackToMessage and keeps its branch prefix', async () => {
    const internals = framework as unknown as {
      handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const r = await internals.handleHostCommand('discord', {
      command: 'undo',
      agentName: 'scout',
      messages: 2,
      requesterName: 'antra',
    });
    assert.equal(r.ok, true);
    assert.equal(r.messagesRemoved, 2);
    assert.match(cm().currentBranch().name, /^undo-msgs\/scout\/\d+$/);
    assert.deepEqual(remainingTexts(), ['m1', 'm2', 'm3']);
    const entry = readLog(framework.getOperatorLogPath()!).find((e) => e.kind === 'rollback');
    assert.ok(entry);
    assert.equal(entry.requester?.via, 'host-command:discord');
    assert.equal(entry.requester?.name, 'antra');
  });

  // --- body groups -----------------------------------------------------------
  // Shards of one large message are stored as a contiguous run sharing a
  // bodyGroupId. Chronicle refuses to bisect a run on removal; the surgeries
  // must never create a partial run either.

  type ShardStore = { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: string } } };
  const appendShards = (group: string, texts: string[]): string[] =>
    texts.map((text, shardIndex) =>
      (cm() as unknown as ShardStore).messageStore
        .append('user', [{ type: 'text', text }], {}, undefined, { bodyGroupId: group, shardIndex }).id,
    );

  it('suppress removes a whole body group from any shard id, and a single-shard group as a range', async () => {
    // m1..m5 exist; add a 3-shard group then a plain message, then a 1-shard group.
    const [g0, g1, g2] = appendShards('g3', ['s0', 's1', 's2']);
    cm().addMessage('user', [{ type: 'text', text: 'after' }]);
    const [lone] = appendShards('g1', ['lone']);
    const before = cm().getMessageCount();

    const r = await framework.suppressMessages('scout', { messageIds: [g1, lone] });
    assert.equal(r.messagesRemoved, 4, 'middle shard expands to its 3-shard group; lone shard removed as a range');
    assert.deepEqual(new Set(r.removedIds), new Set([g0, g1, g2, lone]));
    assert.equal(cm().getMessageCount(), before - 4);
    assert.deepEqual(remainingTexts().slice(-2), ['m5', 'after'], 'no partial run survives');
  });

  it('rollback never bisects a body group: a mid-group target snaps to the group tail', async () => {
    const [s0, s1, s2] = appendShards('g3', ['s0', 's1', 's2']);
    cm().addMessage('user', [{ type: 'text', text: 'after' }]);

    const r = await framework.rollbackToMessage('scout', { messageId: s1 });
    assert.equal(r.tailMessageId, s2, 'fork lands on the last shard');
    assert.equal(r.messagesRemoved, 1, 'only the message after the group leaves');
    assert.deepEqual(remainingTexts().slice(-3), ['s0', 's1', 's2']);
    void s0;
  });

  // --- failure path ----------------------------------------------------------

  it('a failed suppression restores the source branch, retires its outbox batch, and leaves the store bootable', async () => {
    const c = cm() as unknown as { removeMessages: (a: string, b: string) => void };
    const original = c.removeMessages;
    c.removeMessages = () => { throw new Error('injected redaction failure'); };
    try {
      // A 2-shard group forces the range path (the injected failure).
      const [s0] = appendShards('g2', ['x0', 'x1']);
      await assert.rejects(
        framework.suppressMessages('scout', { messageIds: [s0] }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed'
          && /active branch restored to main/.test(e.message) && /injected/.test(e.message),
      );
    } finally {
      c.removeMessages = original;
    }
    assert.equal(cm().currentBranch().name, 'main');
    const fork = cm().listBranches().find((b) => b.name.startsWith('suppress/'));
    assert.ok(fork, 'the fork is kept for diagnosis');

    const outbox = (framework as unknown as { discordAwarenessOutbox: { batches(): Array<{ status: string }> } }).discordAwarenessOutbox;
    assert.equal(outbox.batches().filter((b) => b.status === 'prepared').length, 0, 'no armed batch left behind');

    // The reproduction from review: open the failed fork, restart the host.
    // Before the fix, the orphaned prepared batch re-ran the failed removal
    // at boot and AgentFramework.create() threw.
    await cm().switchBranch(fork!.name);
    await framework.stop();
    framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    assert.equal(cm().currentBranch().name, fork!.name, 'host boots on the diagnostic branch');
  });

  it('the suppression outbox batch activates only after the last redaction', async () => {
    const outbox = (framework as unknown as { discordAwarenessOutbox: { batches(): Array<{ status: string }> } }).discordAwarenessOutbox;
    const c = cm() as unknown as { removeMessage: (id: string) => void };
    const original = c.removeMessage;
    const seen: string[][] = [];
    c.removeMessage = (id: string) => { seen.push(outbox.batches().map((b) => b.status)); original.call(c, id); };
    try {
      await framework.suppressMessages('scout', { messageIds: [ids[1], ids[3]] });
    } finally {
      c.removeMessage = original;
    }
    assert.equal(seen.length, 2);
    for (const statuses of seen) assert.deepEqual(statuses, ['prepared'], 'still prepared while removals run');
    assert.deepEqual(outbox.batches().map((b) => b.status), ['active']);
  });

  it("the idle gate also refuses 'idle+turn-alive' (turn token held, status idle)", async () => {
    const tokens = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    tokens.set('scout', 1);
    try {
      await assert.rejects(
        framework.rollbackToMessage('scout', { messageId: ids[1] }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /idle\+turn-alive/.test(e.message),
      );
      await assert.rejects(
        framework.suppressMessages('scout', { messageIds: [ids[1]] }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy',
      );
    } finally {
      tokens.delete('scout');
    }
    assert.equal(cm().listBranches().length, 1);
  });

  it('nudge and settings changes are recorded; getOperatorLog reads newest-last', async () => {
    framework.nudgeAgent('scout', 'host-console');
    framework.updateAgentRuntimeSettings('scout', { contextBudgetTokens: 150_000 }, {
      persist: false,
      requester: { via: 'webui', name: 'antra' },
    });
    framework.recordOperatorAction({ kind: 'quiesce', requester: { via: 'webui' }, params: { reason: 'maintenance' } });
    const log = framework.getOperatorLog({ limit: 10 });
    assert.deepEqual(log.map((e) => e.kind), ['nudge', 'settings-update', 'quiesce']);
    assert.equal(log[1].params?.persist, false);
    assert.deepEqual(framework.getOperatorLog({ limit: 1 }).map((e) => e.kind), ['quiesce']);
  });
});

describe('OperatorLog', () => {
  it('creates parent directories, tolerates corrupt lines, and is inert when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-log-'));
    try {
      const path = join(dir, 'nested', 'deeper', 'ops.jsonl');
      const log = new OperatorLog(path);
      log.append({ kind: 'a' });
      writeFileSync(path, '{not json\n', { flag: 'a' });
      log.append({ kind: 'b', agent: 'x' });
      assert.deepEqual(log.readTail().map((e) => e.kind), ['a', 'b']);
      assert.deepEqual(log.readTail(1).map((e) => e.kind), ['b']);

      const off = new OperatorLog(undefined);
      assert.equal(off.enabled, false);
      const entry = off.append({ kind: 'noop' });
      assert.equal(entry.kind, 'noop');
      assert.deepEqual(off.readTail(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
