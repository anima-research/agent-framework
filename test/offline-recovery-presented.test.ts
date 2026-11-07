/**
 * Offline recovery on an agent's window that was presented (#291, AF-7).
 * The recovery branches at the anchor through context-manager's branchAt,
 * which, once the window is presented, cuts at the write that presented the
 * anchor, so the rows stored after the anchor and before that write stay on
 * the recovery branch. Before, the recovery counted every row after the
 * anchor as removed, queued their Discord marks, and checked the tool pairs
 * of a range the cut doesn't remove. Count mode counts back in the window.
 *
 * Its suppressions are removed through the one context it opens, the
 * anchor agent's, so another resident's window on the recovery branch keeps
 * a place for each removed row, which no live context could hear: the next
 * start's pass over every window (retractAbsentRows) takes them out.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, type MessageId, type MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import { createOfflineRecoveryBranch } from '../src/recovery/offline-branch.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const textOf = (m: { content: unknown[] }) => String((m.content[0] as { text?: string; type?: string }).text ?? (m.content[0] as { type: string }).type);

/** A store whose agent `cairn` has a presented window, with rows written and presented by `fill`. */
async function presentedStore(fill: (cm: ContextManager, discord: (t: string, participant?: string) => MessageId) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'af-offline-presented-'));
  dirs.push(dir);
  const storePath = join(dir, 'agent.chronicle');
  const store = JsStore.openOrCreate({ path: storePath });
  const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
  cm.presentRows([]);
  assert.equal(cm.windowMode(), 'presented');
  fill(cm, (t, participant = 'user') => cm.addMessage(participant, [{ type: 'text', text: t } as ContentBlock], {
    serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}`,
  }));
  cm.close();
  store.close();
  return storePath;
}

async function recordOn(storePath: string, namespace = 'agents/cairn'): Promise<{ branch: string; texts: string[]; window: string[] }> {
  const store = JsStore.openOrCreate({ path: storePath });
  const cm = await ContextManager.open({ store, namespace });
  try {
    return { branch: store.currentBranch().name, texts: cm.getAllMessages().map(textOf), window: cm.getPresentedMessages().map(textOf) };
  } finally {
    cm.close();
    store.close();
  }
}

describe('offline recovery at the cut, on a presented window (#291, AF-7)', () => {
  it('removes and marks only the rows stored after the write that presented the anchor', async () => {
    const storePath = await presentedStore((cm, discord) => {
      const safe = discord('safe');
      const kept = discord('kept'); // stored before the anchor was presented
      cm.presentRows([safe]);
      cm.presentRows([kept]);
      cm.presentRows([discord('toxic')]);
    });
    const result = await createOfflineRecoveryBranch({
      storePath, agentName: 'cairn', messageId: 'd-safe', marks: { scope: 'all' }, branchName: 'recovery/cairn/cut',
    });
    assert.equal(result.messagesRemoved, 1, 'toxic alone: the cut keeps kept');
    assert.equal(result.discordAddressable, 1);
    assert.deepEqual(result.refs.map((ref) => ref.messageId), ['d-toxic'], "kept's Discord message is not marked");
    const after = await recordOn(storePath);
    assert.equal(after.branch, 'recovery/cairn/cut');
    assert.deepEqual(after.texts, ['safe', 'kept']);
    assert.deepEqual(after.window, ['safe'], 'kept is an arrival again on the recovery branch');
  });

  it('an anchor named by its context id is cut the same way', async () => {
    let safeId = '';
    const storePath = await presentedStore((cm, discord) => {
      const safe = discord('safe');
      safeId = String(safe);
      const kept = discord('kept');
      cm.presentRows([safe]);
      cm.presentRows([kept]);
      cm.presentRows([discord('toxic')]);
    });
    const result = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', contextId: safeId, branchName: 'recovery/cairn/ctx' });
    assert.equal(result.messagesRemoved, 1);
    assert.deepEqual((await recordOn(storePath)).texts, ['safe', 'kept']);
  });

  it("checks the tool pairs of the rows the cut removes, not of every row after the anchor", async () => {
    const storePath = await presentedStore((cm, discord) => {
      const call = cm.addMessage('cairn', [{ type: 'tool_use', id: 'x1', name: 'shell', input: {} } as ContentBlock]);
      cm.presentRows([call]);
      const safe = discord('safe');
      const result = cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'x1', content: 'ok' } as ContentBlock]);
      cm.presentRows([safe]);
      cm.presentRows([result]);
    });
    // Before the cut was read, the recovery took the result as removed and
    // its call as kept, and refused to split the exchange.
    const result = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-safe', branchName: 'recovery/cairn/pair' });
    assert.equal(result.messagesRemoved, 0);
    assert.deepEqual((await recordOn(storePath)).texts, ['tool_use', 'safe', 'tool_result']);
  });

  it("count mode counts back in the window, whose order isn't the record's", async () => {
    const storePath = await presentedStore((cm, discord) => {
      const [a, b, c] = ['a', 'b', 'c'].map((t) => discord(t));
      for (const id of [c, a, b]) cm.presentRows([id!]);
    });
    const result = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messages: 2, branchName: 'recovery/cairn/count' });
    assert.equal(result.messagesRemoved, 0, "c is the window's third row from its newest, and a and b were stored before it was presented");
    const after = await recordOn(storePath);
    assert.deepEqual(after.texts, ['a', 'b', 'c']);
    assert.deepEqual(after.window, ['c']);
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messages: 1, branchName: 'recovery/cairn/count-2' }),
      /Cannot remove 1 message\(s\) — history has 1; at least one must remain/,
      'counted in the window',
    );
  });

  it("count mode counts the rows of the agent's own slot only, as the live undo does, though its window index names an observed slot's", async () => {
    // cairn's live context merged another agent's slot, whose rows its
    // window took between its own. The recovery opens cairn's context
    // alone, whose listing leaves those rows out, so this held before the
    // count read only its own slot's rows too; it pins the rule the live
    // `/undo n` now follows.
    const dir = mkdtempSync(join(tmpdir(), 'af-offline-presented-'));
    dirs.push(dir);
    const storePath = join(dir, 'agent.chronicle');
    const store = JsStore.openOrCreate({ path: storePath });
    const other = await ContextManager.open({ store, namespace: 'agents/other', isolate: true });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn', auxiliaryMessageViews: [{ namespace: 'agents/other' }] });
    cm.presentRows([]);
    const text = (t: string) => [{ type: 'text', text: t } as ContentBlock];
    cm.presentRows([cm.addMessage('user', text('own-1'))]);
    cm.presentRows([other.addMessage('user', text('observed-1'))]);
    cm.presentRows([cm.addMessage('user', text('own-2'))]);
    cm.presentRows([other.addMessage('user', text('observed-2'))]);
    assert.deepEqual(cm.getPresentedMessages().map(textOf), ['own-1', 'observed-1', 'own-2', 'observed-2']);
    cm.close();
    other.close();
    store.close();

    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messages: 2, dryRun: true }),
      /Cannot remove 2 message\(s\) — history has 2; at least one must remain/,
    );
    const result = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messages: 1, branchName: 'recovery/cairn/own' });
    assert.equal(result.messagesRemoved, 1, 'own-2, the newest of its own: the anchor is own-1');
    assert.deepEqual((await recordOn(storePath)).texts, ['own-1']);
  });
});

describe("a start takes out of each window the rows an offline recovery removed (#291, AF-7)", () => {
  async function boot(storePath: string) {
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    return framework;
  }

  it("the suppressed rows leave oren's window at the next start, every other row in its place", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-offline-sweep-'));
    dirs.push(dir);
    const storePath = join(dir, 'store.chronicle');
    let framework = await boot(storePath);
    const add = (framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata): MessageId;
    }).addMessage.bind(framework);
    const ids = ['a', 'b', 'c'].map((t) => add('someone', [{ type: 'text', text: t } as ContentBlock], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}`,
    } as MessageMetadata));
    const oren = framework.getAgent('oren')!.getContextManager();
    const before = new Map(ids.map((id) => [id, oren.ordinalOf(id)]));
    assert.ok([...before.values()].every((ordinal) => ordinal !== undefined), "every row is in oren's window");
    await framework.stop();

    const result = await createOfflineRecoveryBranch({
      storePath, agentName: 'mira', messageId: 'd-c', suppressMessageIds: ['d-b'], branchName: 'recovery/mira/sweep',
    });
    assert.equal(result.messagesSuppressed, 1);

    const traces: TraceEvent[] = [];
    framework = await boot(storePath);
    try {
      framework.onTrace((event) => { traces.push(event); }, { replay: true });
      const live = framework.getAgent('oren')!.getContextManager();
      assert.equal(live.currentBranch().name, 'recovery/mira/sweep');
      assert.equal(live.getMessage(ids[1]!), null, 'suppressed on the recovery branch');
      assert.equal(live.ordinalOf(ids[1]!), undefined, "and out of oren's window");
      for (const id of [ids[0]!, ids[2]!]) assert.equal(live.ordinalOf(id), before.get(id), `${id} keeps its place`);
      const swept = traces.filter((t) => t.type === 'presentation:retracted') as Array<{ agentName: string; messageIds: string[]; reason: string }>;
      assert.deepEqual(swept.map((t) => [t.agentName, t.messageIds, t.reason]), [['oren', [ids[1]], 'boot']]);
    } finally {
      await framework.stop();
    }
  });
});
