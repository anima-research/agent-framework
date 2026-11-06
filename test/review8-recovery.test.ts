/**
 * AF #844 bot review, round 8: offline recovery on a presented window.
 *
 * 16: a recovery whose cut removes nothing and returns no row to the
 *     arrivals (the anchor shares its presentation write with the rows
 *     after it) is refused, as the live rollback refuses it, pointing at a
 *     suppression.
 * 17: a suppression may name a row the cut keeps after the anchor.
 *
 * Bot review 2:
 * 1: `removeSuppressed` with no anchor takes the newest row on a presented
 *    window as on a legacy one, and a run with nothing to suppress isn't
 *    refused as an anchor "already the tail".
 * 65: a row presented with the anchor that has no Discord id, which the
 *    offline suppression can't name, is pointed at the live
 *    `suppressMessages` by its row id.
 * 85: the rows a cut returns to the arrivals are counted
 *    (`returnedToArrivals`), as the live rollback counts them.
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

/** What the no-op refusal says of the slots an offline recovery reads (AF #844 bot review 3, #58). */
const OWN_SLOT_ONLY = "Offline, only cairn's own slot is read: a row of a slot it observes, which the live rollback weighs, isn't weighed here.";

describe('AF #844 review 8 — offline recovery at a presented cut', () => {
  it('16: a count whose anchor shares its presentation write with the rows after it is refused, naming the suppression', async () => {
    const storePath = await batchStore();
    for (const dryRun of [true, false]) {
      await assert.rejects(
        createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messages: 1, dryRun, branchName: 'recovery/cairn/one' }),
        /presented to cairn in one write with the 1 message after it in its window \(the first: .*Discord message d-C\).*remove nothing.*suppress it in the same recovery/,
      );
    }
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messages: 2, branchName: 'recovery/cairn/two' }),
      /with the 2 messages after it .*Discord message d-B\).*suppress them in the same recovery/,
    );
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', branchName: 'recovery/cairn/id' }),
      /Recovery anchor .*\(Discord message d-A\) was presented to cairn in one write with the 2 messages/,
      'an anchor named by its Discord id is refused the same way',
    );
    const after = await recordOn(storePath);
    assert.equal(after.branch, 'main', 'no branch was made');
    assert.deepEqual(after.texts, ['P', 'A', 'B', 'C']);
  });

  it("16: the tail of the window, its record's later rows all kept, is refused as already the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
    dirs.push(dir);
    const storePath = join(dir, 'agent.chronicle');
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.presentRows([]);
    const a = cm.addMessage('user', [{ type: 'text', text: 'A' } as ContentBlock], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'd-A' });
    cm.presentRows([a]);
    cm.close();
    store.close();
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', dryRun: true }),
      (error: Error) => {
        assert.match(error.message, /already the tail of cairn's window/);
        assert.ok(error.message.endsWith(OWN_SLOT_ONLY), error.message);
        return true;
      },
    );
  });

  it('16: a cut that returns a row to the arrivals still changes the window, and goes ahead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
    dirs.push(dir);
    const storePath = join(dir, 'agent.chronicle');
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.presentRows([]);
    const meta = (t: string) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}` });
    const a = cm.addMessage('user', [{ type: 'text', text: 'A' } as ContentBlock], meta('A'));
    const b = cm.addMessage('user', [{ type: 'text', text: 'B' } as ContentBlock], meta('B'));
    cm.presentRows([a]);
    cm.presentRows([b]);
    cm.close();
    store.close();
    const result = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', branchName: 'recovery/cairn/returned' });
    assert.equal(result.messagesRemoved, 0);
    const after = await recordOn(storePath);
    assert.deepEqual(after.texts, ['A', 'B']);
    assert.deepEqual(after.window, ['A'], 'B is an arrival again');
  });

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

describe('AF #844 bot review 2 — offline recovery on a presented window', () => {
  it('1: removeSuppressed with no anchor removes the hidden row and branches at the head; a second run removes 0 and is not refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
    dirs.push(dir);
    const storePath = join(dir, 'agent.chronicle');
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.presentRows([]);
    const kept = cm.addMessage('user', [{ type: 'text', text: 'kept' } as ContentBlock]);
    const hidden = cm.addMessage('user', [{ type: 'text', text: 'HIDDEN' } as ContentBlock], { suppressed: { rule: 'r', eventType: 'x' } } as never);
    const newest = cm.addMessage('agent', [{ type: 'text', text: 'newest' } as ContentBlock]);
    cm.presentRows([kept, hidden, newest]);
    assert.equal(cm.windowMode(), 'presented');
    cm.close();
    store.close();

    const dry = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', removeSuppressed: true, dryRun: true });
    assert.equal(dry.messagesRemoved, 0);
    assert.equal(dry.messagesSuppressed, 1, 'a dry run counts the hidden row');
    const first = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', removeSuppressed: true, branchName: 'recovery/cairn/hidden' });
    assert.equal(first.messagesRemoved, 0);
    assert.equal(first.messagesSuppressed, 1);
    const after = await recordOn(storePath);
    assert.equal(after.branch, 'recovery/cairn/hidden');
    assert.deepEqual(after.texts, ['kept', 'newest']);
    assert.deepEqual(after.window, ['kept', 'newest'], 'the branch starts at the head, its window as it was but the hidden row');

    const second = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', removeSuppressed: true, branchName: 'recovery/cairn/again' });
    assert.equal(second.messagesRemoved, 0);
    assert.equal(second.messagesSuppressed, 0);
    assert.equal(second.sourceBranch, 'recovery/cairn/hidden');
    assert.deepEqual((await recordOn(storePath)).window, ['kept', 'newest'], 'the second run brings back neither');
  });

  it('65: rows presented with the anchor that carry no Discord id are named for the live suppressMessages, not the offline suppression', async () => {
    /** P presented by the write-down, then `rows` stored and presented in one write; the agent's rows carry no Discord id. */
    const store = async (rows: string[]): Promise<{ storePath: string; ids: Map<string, MessageId> }> => {
      const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
      dirs.push(dir);
      const storePath = join(dir, 'agent.chronicle');
      const st = JsStore.openOrCreate({ path: storePath });
      const cm = await ContextManager.open({ store: st, namespace: 'agents/cairn' });
      const write = (t: string): MessageId => t.startsWith('agent:')
        ? cm.addMessage('agent', [{ type: 'text', text: t } as ContentBlock])
        : cm.addMessage('user', [{ type: 'text', text: t } as ContentBlock], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}` });
      write('P');
      cm.presentRows([]);
      const ids = new Map(rows.map((t) => [t, write(t)] as const));
      cm.presentRows([...ids.values()]);
      cm.close();
      st.close();
      return { storePath, ids };
    };

    // The one row after the anchor lacks a Discord id: the offline suppression can't name it.
    const lone = await store(['A', 'agent:reply']);
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath: lone.storePath, agentName: 'cairn', messageId: 'd-A', dryRun: true }),
      (error: Error) => {
        assert.match(error.message, /in one write with the 1 message after it in its window \(the first: [^,)]+\)/);
        assert.ok(error.message.includes(
          `suppress it by row id with the live suppressMessages (${String(lone.ids.get('agent:reply'))}) once the host runs, ` +
          'since the offline recovery suppresses only by Discord message id and it has none. ',
        ), error.message);
        // AF #844 bot review 3, finding 58: the run reads the agent's own slot only.
        assert.ok(error.message.endsWith(OWN_SLOT_ONLY), error.message);
        assert.doesNotMatch(error.message, /--suppress/);
        return true;
      },
    );
    // Mixed: C by its Discord id here, the agent's note by row id live.
    const mixed = await store(['B', 'C', 'agent:note']);
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath: mixed.storePath, agentName: 'cairn', messageId: 'd-B', dryRun: true }),
      (error: Error) => {
        assert.match(error.message, /in one write with the 2 messages after it .*Discord message d-C\)/);
        // AF #844 bot review 4, finding 64: no --suppress-range here, which
        // would take the agent's note between its ends too, and the live
        // suppression of the note advised beside it would then fail.
        assert.ok(error.message.endsWith(
          'suppress the 1 with a Discord message id in the same recovery (--suppress / suppressMessageIds), ' +
          `and the 1 without one by row id with the live suppressMessages (${String(mixed.ids.get('agent:note'))}) ` +
          `once the host runs, since the offline recovery suppresses only by Discord message id. ${OWN_SLOT_ONLY}`,
        ), error.message);
        return true;
      },
    );
    // AF #844 bot review 3, finding 105: every row without one is named, not
    // five and a count, so following the advice leaves none.
    const six = ['agent:1', 'agent:2', 'agent:3', 'agent:4', 'agent:5', 'agent:6'];
    const many = await store(['D', ...six]);
    await assert.rejects(
      createOfflineRecoveryBranch({ storePath: many.storePath, agentName: 'cairn', messageId: 'd-D', dryRun: true }),
      (error: Error) => {
        assert.ok(error.message.includes(`the live suppressMessages (${six.map((t) => String(many.ids.get(t))).join(', ')}) once the host runs`), error.message);
        assert.doesNotMatch(error.message, /\(\+\d+\)/, 'no count stands in for a row');
        return true;
      },
    );
  });

  it('85: a cut that only returns rows to the arrivals reports them as returnedToArrivals, a dry run too', async () => {
    /** A, B and C stored, each presented in a write of its own. */
    const built = async (): Promise<string> => {
      const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
      dirs.push(dir);
      const at = join(dir, 'agent.chronicle');
      const store = JsStore.openOrCreate({ path: at });
      const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
      cm.presentRows([]);
      const meta = (t: string) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}` });
      const a = cm.addMessage('user', [{ type: 'text', text: 'A' } as ContentBlock], meta('A'));
      const b = cm.addMessage('user', [{ type: 'text', text: 'B' } as ContentBlock], meta('B'));
      const c = cm.addMessage('user', [{ type: 'text', text: 'C' } as ContentBlock], meta('C'));
      cm.presentRows([a]);
      cm.presentRows([b]);
      cm.presentRows([c]);
      cm.close();
      store.close();
      return at;
    };
    const storePath = await built();

    const dry = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', dryRun: true });
    assert.equal(dry.messagesRemoved, 0);
    assert.equal(dry.messagesSuppressed, 0);
    assert.equal(dry.returnedToArrivals, 2, 'B and C leave the window as arrivals');
    // A row the same recovery suppresses is removed, not returned.
    const suppressing = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', suppressMessageIds: ['d-C'], dryRun: true });
    assert.equal(suppressing.messagesSuppressed, 1);
    assert.equal(suppressing.returnedToArrivals, 1, 'only B is returned');
    const result = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', branchName: 'recovery/cairn/returned2' });
    assert.equal(result.returnedToArrivals, 2);
    const after = await recordOn(storePath);
    assert.deepEqual(after.texts, ['A', 'B', 'C']);
    assert.deepEqual(after.window, ['A']);
    // AF #844 bot review 3, finding 60: the same suppression run live, on a
    // store of its own: C is removed, and B alone returns.
    const livePath = await built();
    const live = await createOfflineRecoveryBranch({
      storePath: livePath, agentName: 'cairn', messageId: 'd-A', suppressMessageIds: ['d-C'], branchName: 'recovery/cairn/suppressed',
    });
    assert.deepEqual([live.messagesSuppressed, live.returnedToArrivals], [1, 1]);
    const suppressed = await recordOn(livePath);
    assert.deepEqual(suppressed.texts, ['A', 'B'], 'C is out of the record');
    assert.deepEqual(suppressed.window, ['A'], 'and B waits outside the window, an arrival again');
  });

  it('85: a window that is still the record reports no returnedToArrivals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-review8-recovery-'));
    dirs.push(dir);
    const storePath = join(dir, 'agent.chronicle');
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    const meta = (t: string) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}` });
    cm.addMessage('user', [{ type: 'text', text: 'A' } as ContentBlock], meta('A'));
    cm.addMessage('user', [{ type: 'text', text: 'B' } as ContentBlock], meta('B'));
    cm.close();
    store.close();
    const dry = await createOfflineRecoveryBranch({ storePath, agentName: 'cairn', messageId: 'd-A', dryRun: true });
    assert.equal(dry.messagesRemoved, 1);
    assert.equal(dry.returnedToArrivals, undefined);
  });
});
