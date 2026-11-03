/**
 * AF #844 bot review, findings 33 and 60: who a row is for, and whose own
 * row it is, where the stamp alone doesn't say.
 *
 * 33: a module's process response whose `requestInference` names agents is
 * stamped for those of them that read the slot the write lands in (the
 * delivery agent's: the residents' slot on a residents' host); one naming
 * only agents that don't read it (an isolated job, a fork) is stamped as a
 * write that names no agent is, for the residents. On main every resident
 * read such a row; stamped for the fork alone, it reached no window. The
 * batched-wake line the gate writes (`gate:debounce`) follows the same rule.
 *
 * 60: in a turn an earlier release recorded, a framework notice of the
 * agent's own (a `prose-drafts` notice, an `[auto-continue]` row) was stored
 * under `user` with no stamp. Its metadata names its owner (`draftOwner`,
 * `agentName`), so an undo of that agent's turn takes it out as undone, and
 * it doesn't return at the agent's next point, nor count as a notice in the
 * agent's history.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager as StoreWindow, PassthroughStrategy, type MessageId, type MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, RESIDENTS_SLOT, audienceOf, sameSlot } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { residentContextOptions } from '../src/context-options.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';
import { WireMembrane } from './helpers/wire-membrane.js';

type Row = { id: MessageId; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> };
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] }) =>
  row.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join('');

/** A surface's module: an `external-message` event's text becomes a message, read by the agents its metadata names. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content, metadata } = event as unknown as { content: ContentBlock[]; metadata: { ask: string[] } };
    return { addMessages: [{ participant: 'user', content }], requestInference: metadata.ask };
  }
}
const input = (t: string, ask: string[]): ProcessEvent =>
  ({ type: 'external-message', source: 'test', content: [text(t)], metadata: { ask } }) as unknown as ProcessEvent;

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-review8-audience-'));
  dirs.push(dir);
  return dir;
};

describe('a write naming agents is for those of them that read the slot it lands in (AF #844 finding 33)', () => {
  it('a response naming only an isolated job is for the residents; one naming a resident beside it is for that resident; so is the gate\'s line', async () => {
    const membrane = new RoutedMembrane();
    const gates = new GateModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir(), 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: ['mira', 'oren'].map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
      modules: [gates, new SurfaceModule()],
      // A gate whose default skips: the responses' wakes aren't the case here.
      gate: { onboarding: false, config: { policies: [], default: 'skip' } },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    frameworks.push(framework);
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    framework.start();

    // An isolated job: a copy of mira on a slot of its own, blocked in a tool while the writes land.
    membrane.identify = (request) => (JSON.stringify(request.messages).includes('[WORKER-FRAMING]') ? 'worker-1' : request.assistantParticipant ?? '');
    membrane.script('worker-1', waitCall('g-worker'), say('worker done'));
    const worker = await framework.deriveAgent({
      name: 'worker-1', from: 'mira', mode: 'copy',
      framing: [{ participant: 'user', content: [text('[WORKER-FRAMING] count them')] }],
    });
    const run = framework.runEphemeralToCompletion(worker.agent, worker.contextManager);
    await until(() => gates.entered.has('g-worker'), 'the worker to block in its tool');
    const workerSlot = framework.getAgentRecord('worker-1')!.ownSlot;
    assert.ok(workerSlot && !sameSlot(workerSlot, RESIDENTS_SLOT), "setup: the worker doesn't read the residents' slot");

    const cm = (name: string) => framework.getAgent(name)!.getContextManager();
    const rowNamed = (t: string) => (cm('mira').getAllMessages() as unknown as Row[]).find((r) => textOf(r) === t);
    const inWindow = (name: string, t: string) => cm(name).ordinalOf(rowNamed(t)!.id) !== undefined;

    framework.pushEvent(input('ASKS-THE-WORKER', ['worker-1']));
    framework.pushEvent(input('ASKS-THE-WORKER-AND-OREN', ['worker-1', 'oren']));
    framework.pushEvent(input('ASKS-OREN', ['oren']));
    await until(() => ['ASKS-THE-WORKER', 'ASKS-THE-WORKER-AND-OREN', 'ASKS-OREN'].every((t) => rowNamed(t) !== undefined), 'the three rows to be stored');

    // The gate's batched line, for a group of agents the gate woke.
    const gate = (framework as unknown as {
      eventGate: { addMessageFn(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string, placement?: unknown, audience?: readonly string[]): unknown };
    }).eventGate;
    gate.addMessageFn('user', [text('GATE-LINE-FOR-THE-WORKER')], { source: 'gate:debounce', policies: ['p'] }, undefined, undefined, ['worker-1']);
    gate.addMessageFn('user', [text('GATE-LINE-FOR-THE-WORKER-AND-OREN')], { source: 'gate:debounce', policies: ['p'] }, undefined, undefined, ['worker-1', 'oren']);

    const audience = (t: string) => {
      const row = rowNamed(t);
      assert.ok(row, `${t} is stored in the residents' slot`);
      return audienceOf(row.metadata)?.audience;
    };
    assert.deepEqual(audience('ASKS-THE-WORKER'), ['mira', 'oren'], 'naming only the worker: for the residents, as a write that names no agent');
    assert.deepEqual(audience('ASKS-THE-WORKER-AND-OREN'), ['oren'], 'for the one it names that reads the slot');
    assert.deepEqual(audience('ASKS-OREN'), ['oren'], 'naming one resident: for that resident only');
    assert.deepEqual(audience('GATE-LINE-FOR-THE-WORKER'), ['mira', 'oren'], "the gate's line for the worker alone: for the residents");
    assert.deepEqual(audience('GATE-LINE-FOR-THE-WORKER-AND-OREN'), ['oren'], "the gate's line for the worker and oren: for oren");

    for (const t of ['ASKS-THE-WORKER', 'GATE-LINE-FOR-THE-WORKER']) {
      assert.deepEqual([inWindow('mira', t), inWindow('oren', t)], [true, true], `${t} reaches both residents' windows`);
    }
    for (const t of ['ASKS-THE-WORKER-AND-OREN', 'ASKS-OREN', 'GATE-LINE-FOR-THE-WORKER-AND-OREN']) {
      assert.deepEqual([inWindow('mira', t), inWindow('oren', t)], [false, true], `${t} reaches oren's window alone`);
    }
    assert.deepEqual(traces.filter((e) => e.type === 'presentation:unreadable-audience'), [], 'no stamp names only agents that cannot read its slot');

    gates.release('g-worker');
    await run;
  });
});

describe("an earlier release's notices of an agent's own, under `user` and unstamped (AF #844 finding 60)", () => {
  it("an undo of the turn takes them out as undone, no later point brings them back, and the history's drafts scan doesn't count them", async () => {
    const dir = tempDir();
    const storePath = join(dir, 'store.chronicle');
    let before: number;
    {
      // An earlier release's store: two turns of mira's; in the second, her
      // drafts notice and an [auto-continue] row, and a drafts notice
      // another resident's turn wrote. Nothing is stamped.
      const store = JsStore.openOrCreate({ path: storePath });
      const cm = await StoreWindow.open({ store, ...residentContextOptions('mira'), strategy: new PassthroughStrategy() });
      cm.addMessage('user', [text('first')]);
      cm.addMessage('mira', [text('one')]);
      cm.addMessage('user', [text('second')]);
      before = store.currentSequence();
      cm.addMessage('mira', [text('two')]);
      cm.addMessage('user', [text('[drafts] mira: an open draft of yours')],
        { system: true, kind: 'prose-drafts', draftOwner: 'mira', draftIds: ['d-1'] } as MessageMetadata);
      cm.addMessage('user', [text('[auto-continue] mira')],
        { system: true, kind: 'auto-continue', agentName: 'mira', continuation: 1, maxConsecutive: 3 } as MessageMetadata);
      cm.addMessage('user', [text("[drafts] oren: an open draft of his")],
        { system: true, kind: 'prose-drafts', draftOwner: 'oren', draftIds: ['d-9'] } as MessageMetadata);
      cm.close();
      store.close();
    }
    const framework = await AgentFramework.create({
      storePath, membrane: new WireMembrane().asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', allowedTools: 'all', proseRouting: 'disabled' }],
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    frameworks.push(framework);
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
      saveTurnCheckpoints(agentName: string, checkpoints: unknown[]): void;
      presentAtEndOf(agent: Agent | undefined): void;
      draftsNamedInHistory(agent: Agent, ids: string[]): Map<string, string>;
    };
    const mira = framework.getAgent('mira')!;
    const cm = mira.getContextManager();
    const windowTexts = () => cm.getPresentedMessages().map((m) => textOf(m));
    const ownNotice = '[drafts] mira: an open draft of yours';
    const continued = '[auto-continue] mira';
    const orensNotice = '[drafts] oren: an open draft of his';
    assert.deepEqual(windowTexts(), ['first', 'one', 'second', 'two', ownNotice, continued, orensNotice], 'setup: written down at boot');
    assert.deepEqual([...internals.draftsNamedInHistory(mira, ['d-1']).keys()], ['d-1'], 'setup: her notice names her draft');

    // The earlier release's checkpoint for the second turn: no window length.
    internals.saveTurnCheckpoints('mira', [{ agentName: 'mira', turnIndex: 1, sequenceBefore: before, branchName: framework.getStore().currentBranch().name, timestamp: Date.now() }]);
    assert.deepEqual(framework.undoLastTurn('mira').window, { retracted: 4, represented: 0 });
    const statusOf = (t: string) => cm.windowStatusOf(cm.getAllMessages().find((m) => textOf(m) === t)!.id);
    assert.deepEqual([ownNotice, continued, orensNotice].map(statusOf), ['undone', 'undone', 'out'],
      "her notices leave as undone; one naming another resident's draft leaves as arrived");
    assert.equal(internals.draftsNamedInHistory(mira, ['d-1']).size, 0, 'the undone notice no longer counts as naming her draft');

    // A write for mira while she is idle presents her at rest; so does the end of a turn.
    internals.addMessage('alice', [text('hello again')], undefined, { forAgent: 'mira' });
    internals.presentAtEndOf(mira);
    assert.deepEqual(windowTexts(), ['first', 'one', 'second', orensNotice, 'hello again'], 'the undone turn stays out; the arrival comes back');
    const redone = framework.redo('mira');
    assert.equal(redone.window?.represented, 4, 'a redo puts back the rows the undo took out, hers and the arrival');
    assert.deepEqual(windowTexts().slice(0, 7), ['first', 'one', 'second', 'two', ownNotice, continued, orensNotice], 'in their order');
  });
});
