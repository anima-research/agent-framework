/**
 * A rollback's accounting at the real cut (#291, AF-7). Once an agent's
 * window is presented, context-manager's branchAt cuts at the write that
 * presented the target, not at the target's own place in the record, so the
 * rows stored after the target and before that write stay on the new
 * branch. Before, the framework counted every row after the target as
 * removed and marked their Discord messages, though the cut kept some.
 * Now the rows removed are exactly those stored after the cut; those the
 * window took after the target leave it as arrived and not presented, and
 * are reported (`returnedToArrivals`); and the preview counts the removed
 * rows no window holds (`neverPresented`).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextManager, MessageId } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, OperatorActionError } from '../src/index.js';
import type { OperatorLogEntry } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'af-rollback-cut-'));
  dirs.push(dir);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  frameworks.push(framework);
  const cm = (): ContextManager => framework.getAgent('scout')!.getContextManager();
  /** A Discord message stored past the framework, in no window until presented. */
  const store = (t: string): MessageId => cm().addMessage('someone', [{ type: 'text', text: t } as ContentBlock], {
    serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${t}`,
  });
  const textsOf = (rows: Array<{ content: ContentBlock[] }>) => rows.map((m) => (m.content[0] as { text: string }).text);
  const internals = framework as unknown as {
    handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  return { framework, cm, store, textsOf, internals };
}

describe("a rollback's accounting at the cut (#291, AF-7)", () => {
  it('removes only the rows stored after the write that presented its target, and reports the rows it returns to arrivals', async () => {
    const h = await boot();
    const t = h.store('t');
    const r = h.store('r');
    h.cm().presentRows([t]);
    h.cm().presentRows([r]); // stored before t was presented, presented after it
    const z = h.store('z');
    h.cm().presentRows([z]);
    const n = h.store('n'); // never presented to anyone

    const preview = h.framework.previewSurgeryMarks('scout', { rollbackTo: t });
    assert.equal(preview.messagesRemoved, 2, 'z and n: r is kept by the cut');
    assert.equal(preview.returnedToArrivals, 1);
    assert.equal(preview.neverPresented, 1, 'n is in no window');
    assert.deepEqual(preview.scopes.all.refs.map((ref) => ref.messageId), ['d-z', 'd-n']);

    const presented: Array<{ agentName: string; occasion: string; count: number }> = [];
    h.framework.onTrace((event) => { if (event.type === 'presentation:presented') presented.push(event); });
    const result = await h.framework.rollbackToMessage('scout', { messageId: t });
    assert.equal(result.messagesRemoved, 2);
    assert.equal(result.returnedToArrivals, 1);
    assert.deepEqual(result.removedRefs.map((ref) => ref.messageId), ['d-z', 'd-n'], "r's Discord message isn't among the removed");
    assert.deepEqual(h.textsOf(h.cm().getAllMessages()), ['t', 'r'], "the new branch's record keeps r");
    // The cut left r out of the window, an arrival again; the surgery's
    // release presents an idle agent what it is owed, as at a turn's end, so
    // r entered again there, after t.
    assert.deepEqual(presented.map((p) => [p.agentName, p.occasion, p.count]), [['scout', 'turn-end', 1]]);
    assert.deepEqual(h.textsOf(h.cm().getPresentedMessages()), ['t', 'r']);

    const logged = readFileSync(h.framework.getOperatorLogPath()!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as OperatorLogEntry);
    const entry = logged.find((e) => e.kind === 'rollback')!;
    assert.equal(entry.result?.messagesRemoved, 2);
    assert.equal(entry.result?.returnedToArrivals, 1);
  });

  it('a rollback to a row presented together with every row after it changes nothing, and is refused saying so', async () => {
    const h = await boot();
    const x = h.store('x');
    const y = h.store('y');
    h.cm().presentRows([x, y]); // one presentation, one cut
    await assert.rejects(
      h.framework.rollbackToMessage('scout', { messageId: x }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid'
        && /already the tail of scout's window: every message stored after it was stored before the write that presented it/.test(e.message),
    );
    assert.equal(h.cm().currentBranch().name, 'main', 'no branch was made');
    await assert.rejects(
      h.framework.rollbackToMessage('scout', { messageId: y }),
      (e: unknown) => e instanceof OperatorActionError && /is already the tail of the active branch/.test(e.message),
    );
  });

  it('the preview counts no removed row as never presented where a window holds it, but for a held row a resident never sees', async () => {
    const h = await boot();
    const t = h.store('t');
    h.cm().presentRows([t]);
    for (const name of ['u', 'v']) h.cm().presentRows([h.store(name)]);
    const preview = h.framework.previewSurgeryMarks('scout', { rollbackTo: t });
    assert.equal(preview.messagesRemoved, 2);
    assert.equal(preview.neverPresented, 0);
    assert.equal(preview.returnedToArrivals, 0);
    // A row a tune-out holds from residents, in scout's window (as a
    // write-down takes one in), which its view never shows.
    const held = h.cm().addMessage('someone', [{ type: 'text', text: 'held' } as ContentBlock], { tuneOut: { epochId: 'e1' } } as never);
    h.cm().presentRows([held]);
    assert.equal(h.cm().windowStatusOf(held), 'in');
    const withHeld = h.framework.previewSurgeryMarks('scout', { rollbackTo: t });
    assert.deepEqual([withHeld.messagesRemoved, withHeld.neverPresented], [3, 1]);
    const suppress = h.framework.previewSurgeryMarks('scout', { suppress: [t] });
    assert.deepEqual([suppress.messagesRemoved, suppress.neverPresented, suppress.returnedToArrivals], [1, 0, undefined]);
  });

  it("a host's message-granular undo counts back in the window, whose order isn't the record's", async () => {
    const h = await boot();
    const [a, b, c] = ['a', 'b', 'c'].map(h.store);
    for (const id of [c, a, b]) h.cm().presentRows([id]);
    assert.deepEqual(h.textsOf(h.cm().getPresentedMessages()), ['c', 'a', 'b']);
    const answer = await h.internals.handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, requesterName: 'zz-op' });
    assert.equal(answer.ok, true, String(answer.error));
    assert.equal(answer.messagesRemoved, 0, "the window's third row from its newest is c; a and b were stored before it was presented");
    assert.equal(answer.returnedToArrivals, 2);
    // Arrivals again, which the surgery's release presented at once, as the
    // agent is idle: after c, in the order they were stored.
    assert.deepEqual(h.textsOf(h.cm().getPresentedMessages()), ['c', 'a', 'b']);
    assert.deepEqual(h.textsOf(h.cm().getAllMessages()), ['a', 'b', 'c'], 'the record keeps them');
    assert.notEqual(h.cm().currentBranch().name, 'main');
    const refused = await h.internals.handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 3, requesterName: 'zz-op' });
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /Cannot remove 3 message\(s\) — history has 3; at least one must remain/, 'counted in the window');
  });
});
