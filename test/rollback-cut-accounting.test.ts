/**
 * A rollback's accounting at the real cut (#291, AF-7). Once an agent's
 * window is presented, context-manager's branchAt cuts at the write that
 * presented the target, not at the target's own place in the record, so the
 * rows stored after the target and before that write stay on the new
 * branch. Before, the framework counted every row after the target as
 * removed and marked their Discord messages, though the cut kept some.
 * Now the rows removed are exactly those stored after the cut; those the
 * window took after the target leave it as arrived and not presented, are
 * reported (`returnedToArrivals`), and wait outside the window until the
 * agent's next turn start, so the cut holds until it speaks again; the rows
 * one write presented together with the target stay after it and are
 * reported too (`keptInWindowAfterTarget`), and a rollback that would
 * change nothing because of them names them and the removals that can take
 * them out; and the preview counts the removed rows no window holds
 * (`neverPresented`). A host's message-granular undo counts back over the
 * rows of the agent's own slot in its window, which can merge a slot the
 * agent observes (a persistent subconscious's).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, OperatorActionError, storeOwnRow } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, OperatorLogEntry, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { until } from './helpers/dendrite.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/** A surface's module: an `external-message` event's text becomes a user message that asks scout. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content } = event as unknown as { content: ContentBlock[] };
    return { addMessages: [{ participant: 'user', content }], requestInference: ['scout'] };
  }
}

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'af-rollback-cut-'));
  dirs.push(dir);
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    modules: [new SurfaceModule()],
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
    addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata): MessageId;
  };
  const windowTexts = () => textsOf(cm().getPresentedMessages());
  /** One of scout's turns, asked with `ask` and answered with `reply`; returns the request it made. */
  const turn = async (ask: string, reply: string) => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: reply } as ContentBlock]));
    const before = membrane.calls.length;
    framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: ask }], metadata: {} } as unknown as ProcessEvent);
    await until(() => windowTexts().includes(reply), `scout's reply "${reply}"`);
    await framework.runUntilIdle();
    return membrane.calls[before]!;
  };
  return { framework, cm, store, textsOf, internals, windowTexts, turn };
}

const logged = (framework: AgentFramework): OperatorLogEntry[] =>
  readFileSync(framework.getOperatorLogPath()!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as OperatorLogEntry);

describe("a rollback's accounting at the cut (#291, AF-7)", () => {
  it('removes only the rows stored after the write that presented its target, and reports the rows it returns to arrivals, which wait for its next turn start', async () => {
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
    assert.equal(preview.keptInWindowAfterTarget, 0, 'each was presented in a write of its own');
    assert.equal(preview.neverPresented, 1, 'n is in no window');
    assert.deepEqual(preview.scopes.all.refs.map((ref) => ref.messageId), ['d-z', 'd-n']);

    const presented: Array<{ agentName: string; occasion: string; count: number }> = [];
    h.framework.onTrace((event) => { if (event.type === 'presentation:presented') presented.push(event); });
    const result = await h.framework.rollbackToMessage('scout', { messageId: t });
    assert.equal(result.messagesRemoved, 2);
    assert.equal(result.returnedToArrivals, 1);
    assert.equal(result.keptInWindowAfterTarget, 0);
    assert.deepEqual(result.removedRefs.map((ref) => ref.messageId), ['d-z', 'd-n'], "r's Discord message isn't among the removed");
    assert.deepEqual(h.textsOf(h.cm().getAllMessages()), ['t', 'r'], "the new branch's record keeps r");
    // The cut left r out of the window, an arrival again. It waits for
    // scout's next turn start (the thread's answer on a rollback that
    // returns arrivals): the surgery's release, which presents an idle
    // agent what it is owed as at a turn's end, presents nothing, so the
    // operator's cut is what scout's window holds until it speaks. Before,
    // the release put r back after t at once (turn-end, 1).
    assert.deepEqual(presented.map((p) => [p.agentName, p.occasion, p.count]), []);
    assert.deepEqual(h.windowTexts(), ['t']);
    assert.equal(h.cm().windowStatusOf(r), 'out');
    assert.equal(result.lastVisible?.preview, 't');

    const entry = logged(h.framework).find((e) => e.kind === 'rollback')!;
    assert.equal(entry.result?.messagesRemoved, 2);
    assert.equal(entry.result?.returnedToArrivals, 1);
    assert.equal(entry.result?.keptInWindowAfterTarget, 0);

    // A row stored for scout while it is idle enters its window at once; r
    // still waits.
    h.internals.addMessage('someone', [{ type: 'text', text: 'later' } as ContentBlock], {});
    assert.deepEqual(h.windowTexts(), ['t', 'later']);
    // Its next turn start presents r with the turn's inputs, in the order
    // they were stored, and its request carries it.
    h.framework.start();
    const request = await h.turn('ask', 'answer');
    assert.deepEqual(h.windowTexts(), ['t', 'later', 'ask', 'r', 'answer']);
    const sent = request.messages.map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''));
    assert.ok(sent.includes('r'), `the turn's request carries r: ${JSON.stringify(sent)}`);
  });

  it('a rollback to a row presented in one write with the rows after it keeps them after it, reports them, and a repeat names them and the removals that take them out', async () => {
    const h = await boot();
    // Two Discord messages arrive while the agent is busy; its turn's end
    // presents them together, then its reply is presented at its write.
    const a = h.store('A');
    const b = h.store('B');
    h.cm().presentRows([a, b]);
    const r = h.store('R');
    h.cm().presentRows([r]);
    assert.deepEqual(h.windowTexts(), ['A', 'B', 'R']);

    const preview = h.framework.previewSurgeryMarks('scout', { rollbackTo: a });
    assert.deepEqual([preview.messagesRemoved, preview.returnedToArrivals, preview.keptInWindowAfterTarget], [1, 0, 1]);
    assert.deepEqual(preview.scopes.all.refs.map((ref) => ref.messageId), ['d-R'], "B isn't removed, so it isn't marked");
    const result = await h.framework.rollbackToMessage('scout', { messageId: a });
    assert.equal(result.messagesRemoved, 1);
    assert.equal(result.returnedToArrivals, 0);
    assert.equal(result.keptInWindowAfterTarget, 1, 'B was presented with A, so the cut at that write keeps it after A');
    assert.deepEqual(result.removedRefs.map((ref) => ref.messageId), ['d-R']);
    assert.deepEqual(h.windowTexts(), ['A', 'B']);
    const entry = logged(h.framework).find((e) => e.kind === 'rollback' && !e.error)!;
    assert.equal(entry.result?.keptInWindowAfterTarget, 1);

    // Again, to drop B: refused, naming B and the removals that can.
    // Before, the refusal said A was already the tail, and that no row
    // entered the window after it, while B was its tail.
    const branch = h.cm().currentBranch().name;
    for (const attempt of [
      () => h.framework.rollbackToMessage('scout', { messageId: a }),
      async () => h.framework.previewSurgeryMarks('scout', { rollbackTo: a }),
    ]) {
      await assert.rejects(attempt(), (e: unknown) => {
        assert.ok(e instanceof OperatorActionError && e.code === 'invalid', String(e));
        assert.match(e.message, new RegExp(`Message ${a} was presented to scout in one write with the 1 message after it in its window \\(the first: ${b}, Discord message d-B\\)`));
        assert.match(e.message, /a branch cut can't separate the rows one write presented/);
        assert.match(e.message, /suppress it \(suppressMessages\), or hide it by Discord message id/);
        assert.doesNotMatch(e.message, /already the tail/);
        return true;
      });
    }
    assert.equal(h.cm().currentBranch().name, branch, 'no branch was made');
    // The removal it names takes B out.
    const suppressed = await h.framework.suppressMessages('scout', { messageIds: [b] });
    assert.equal(suppressed.messagesRemoved, 1);
    assert.deepEqual(h.windowTexts(), ['A']);
  });

  it('a rollback to a row presented together with every row after it changes nothing, and is refused saying so', async () => {
    const h = await boot();
    const x = h.store('x');
    const y = h.store('y');
    h.cm().presentRows([x, y]); // one presentation, one cut
    // The refusal names the row presented with x and the removals that take
    // it out. It said x was already the tail of scout's window, and that no
    // row entered the window after it, which y did.
    await assert.rejects(
      h.framework.rollbackToMessage('scout', { messageId: x }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid'
        && e.message.includes(`was presented to scout in one write with the 1 message after it in its window (the first: ${y}, Discord message d-y)`)
        && /suppress it \(suppressMessages\)/.test(e.message),
    );
    assert.equal(h.cm().currentBranch().name, 'main', 'no branch was made');
    // Nothing follows y, in the record or the window.
    await assert.rejects(
      h.framework.rollbackToMessage('scout', { messageId: y }),
      (e: unknown) => e instanceof OperatorActionError && /is already the tail of the active branch/.test(e.message),
    );
    // Rows stored after a row and before the write that presented it, none
    // of which the window took after it: the cut keeps them all, and none
    // is in the window after it.
    const p = h.store('p');
    h.store('q'); // never presented
    h.cm().presentRows([p]);
    await assert.rejects(
      h.framework.rollbackToMessage('scout', { messageId: p }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid'
        && /already the tail of scout's window: every message stored after it was stored before the write that presented it/.test(e.message),
    );
    assert.equal(h.cm().currentBranch().name, 'main', 'no branch was made');
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
    assert.equal(answer.keptInWindowAfterTarget, 0);
    // Arrivals again, which wait for scout's next turn start: the surgery's
    // release doesn't present them. (Before, it did, at once, after c, and
    // the window read ['c', 'a', 'b'] again, as if nothing had changed.)
    assert.deepEqual(h.windowTexts(), ['c']);
    assert.deepEqual(h.textsOf(h.cm().getAllMessages()), ['a', 'b', 'c'], 'the record keeps them');
    assert.notEqual(h.cm().currentBranch().name, 'main');
    const refused = await h.internals.handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 3, requesterName: 'zz-op' });
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /Cannot remove 3 message\(s\) — history has 1; at least one must remain/, 'counted in the window, not the record of 3');
  });
});

/**
 * A persistent subconscious's window merges the residents' slot beside its
 * own, so residents' rows sit among its own in it. A rollback finds its
 * target in the agent's own slot, so a host's `/undo n` counts back over
 * the rows of that slot alone, as it did over the record before its window
 * was presented. Counted over every row of the window, it picked a
 * residents' row as the target ('Message … is not on the active branch'),
 * or its own row under a residents' row newer than it, which it then called
 * already the tail of the active branch.
 */
describe("a host's message-granular undo on a window that merges an observed slot (#291)", () => {
  async function bootWithSubconscious() {
    const dir = mkdtempSync(join(tmpdir(), 'af-rollback-cut-sub-'));
    dirs.push(dir);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      subconscious: { enabled: true, systemPrompt: 'You notice.' },
    } as never);
    frameworks.push(framework);
    const SUB = 'Subconscious';
    const sub = framework.getAgent(SUB)!;
    const scm = (): ContextManager => sub.getContextManager();
    assert.equal(scm().windowMode(), 'presented');
    const own = (t: string): MessageId => storeOwnRow(sub, SUB, [{ type: 'text', text: t } as ContentBlock])!;
    /** A residents' row, presented into the subconscious's window. */
    const residents = (t: string): MessageId => {
      const id = framework.getAgent('mira')!.getContextManager().addMessage('someone', [{ type: 'text', text: t } as ContentBlock], {});
      if (scm().ordinalOf(id) === undefined) scm().presentRows([id]);
      return id;
    };
    const textsOf = (rows: Array<{ content: ContentBlock[] }>) => rows.map((m) => (m.content[0] as { text?: string }).text ?? m.content[0]!.type);
    const undo = (messages: number) => (framework as unknown as {
      handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    }).handleHostCommand('discord', { command: 'undo', agentName: SUB, messages, requesterName: 'zz-op' });
    return { framework, scm, own, residents, textsOf, undo };
  }

  it('counts its own rows only, past a residents\' row newer than them', async () => {
    const h = await bootWithSubconscious();
    h.own('sub-own-1');
    h.own('sub-own-2');
    h.residents('residents-row');
    assert.deepEqual(h.textsOf(h.scm().getPresentedMessages()), ['sub-own-1', 'sub-own-2', 'residents-row']);
    const answer = await h.undo(1);
    assert.equal(answer.ok, true, String(answer.error));
    assert.equal(answer.messagesRemoved, 1, 'sub-own-2, the newest of its own');
    assert.deepEqual(h.textsOf(h.scm().getAllMessages()), ['sub-own-1']);
  });

  it('counts its own rows only, with residents\' rows between them, and refuses past the last of them', async () => {
    const h = await bootWithSubconscious();
    h.own('sub-own-1');
    h.residents('residents-1');
    h.own('sub-own-2');
    h.residents('residents-2');
    h.own('sub-own-3');
    assert.deepEqual(h.textsOf(h.scm().getPresentedMessages()), ['sub-own-1', 'residents-1', 'sub-own-2', 'residents-2', 'sub-own-3']);
    const refused = await h.undo(3);
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /Cannot remove 3 message\(s\) — history has 3 of Subconscious's own \(the 2 other row\(s\) of its window are a slot it observes, which an undo doesn't count\); at least one must remain/);
    const two = await h.undo(2);
    assert.equal(two.ok, true, String(two.error));
    assert.equal(two.messagesRemoved, 2, 'sub-own-2 and sub-own-3: the target is sub-own-1, two of its own back');
    assert.deepEqual(h.textsOf(h.scm().getAllMessages()), ['sub-own-1']);
    const last = await h.undo(1);
    assert.equal(last.ok, false);
    assert.match(String(last.error), /Cannot remove 1 message\(s\) — history has 1/);
  });

  it("a rollback to a residents' row in its window is refused as not its own, not as off the branch", async () => {
    const h = await bootWithSubconscious();
    h.own('sub-own-1');
    const row = h.residents('residents-row');
    h.own('sub-own-2');
    await assert.rejects(
      h.framework.rollbackToMessage('Subconscious', { messageId: row }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'unknown-message'
        && e.message === `Message ${row} is in a slot Subconscious observes, not in its own: a rollback of Subconscious takes its target from its own slot`,
    );
    await assert.rejects(
      h.framework.rollbackToMessage('Subconscious', { messageId: 'no-such-row' }),
      (e: unknown) => e instanceof OperatorActionError && /Message no-such-row is not on the active branch/.test(e.message),
    );
  });
});
