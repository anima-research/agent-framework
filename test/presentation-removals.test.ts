/**
 * A removal from the record leaves every window that held the row (#291,
 * AF-7). context-manager tombstones a removal in the window of the context
 * it was made through, and another context on the same slot, or merging
 * it, keeps the row's place (CM-T): its listing and its compile leave the
 * row out, but its ordinal stays issued, and every cursor or watermark kept
 * by place reads past a hole that isn't there. The framework takes the
 * removed rows out of every other live window after each removal in place:
 * a hide, a suppression on its fork, a module's removal (and a process
 * answer's), the coalescer's, a suppression a start finishes, and at boot
 * the rows no live context heard removed (an offline recovery's).
 *
 * First the presentation module's two calls on their own, over real
 * contexts with a fake host; then each removal through a framework with two
 * residents of one slot, mira (the primary) and oren, both presented every
 * row.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, type MessageId, type MessageMetadata, type StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, AgentRegistry, residentSpec, taskForkSpec, withAudience } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentPresentation, heldFromResidents, type PresentationHost, type PresentationTrace, type PresentedAgent } from '../src/presentation.js';
import { isAnotherAgentsInjection } from '../src/stored-injections.js';
import { removeStoredMessage } from '../src/stored-removal.js';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];
const textOf = (m: { content: ContentBlock[] }) => m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join('');

const dirs: string[] = [];
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (closers.length) { try { await closers.pop()!(); } catch { /* closed already */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Every ordinal a window holds, by row id. */
const ordinals = (cm: ContextManager): Map<MessageId, number> =>
  new Map(cm.getPresentedMessages().map((m) => [m.id, cm.ordinalOf(m.id)!]));

/** The ordinals of `before` that `cm` still holds, less `gone`: each must be where it was. */
function assertOrdinalsKept(cm: ContextManager, before: Map<MessageId, number>, gone: readonly string[], who: string): void {
  for (const [id, ordinal] of before) {
    if (gone.includes(id)) continue;
    assert.equal(cm.ordinalOf(id), ordinal, `${who}: ${id} keeps its place`);
  }
}

// ============================================================================
// The module's calls, over real contexts
// ============================================================================

class TestAgent implements PresentedAgent {
  constructor(readonly name: string, public cm: ContextManager) {}
  getContextManager(): ContextManager { return this.cm; }
  isOwnParticipant(participant: string): boolean { return participant === this.name; }
  setOwnRowSink(): void {}
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'af-presentation-removals-'));
  dirs.push(dir);
  const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
  closers.unshift(() => store.close());
  const open = async (name: string) => {
    const cm = await ContextManager.open({
      store, namespace: `agents/${name}`, strategy: new PassthroughStrategy(),
      viewFilter: (m: StoredMessage) => !heldFromResidents(m.metadata as Record<string, unknown> | undefined) && !isAnotherAgentsInjection(m.metadata, name),
    });
    closers.push(() => cm.close());
    return cm;
  };
  const registry = new AgentRegistry();
  registry.register(residentSpec('mira', { primary: true }));
  registry.register(residentSpec('oren', { primary: false }));
  const mira = new TestAgent('mira', await open('mira'));
  const oren = new TestAgent('oren', await open('oren'));
  const live = new Map<string, TestAgent>([['mira', mira], ['oren', oren]]);
  const traces: PresentationTrace[] = [];
  const host: PresentationHost = {
    liveAgents: () => live.values(),
    registry,
    turnAlive: () => false,
    frozen: () => false,
    emitTrace: (event) => { traces.push(event); },
  };
  const presentation = new AgentPresentation(host);
  for (const agent of live.values()) presentation.adopt(agent);
  /** A row for both residents, stored through mira's context and presented at rest to each. */
  const write = (t: string): MessageId => {
    const id = mira.cm.addMessage('someone', text(t), withAudience(undefined, ['mira', 'oren']));
    presentation.afterStore(mira, [id]);
    return id;
  };
  return { store, open, registry, mira, oren, live, traces, presentation, write };
}

const retracted = (traces: ReadonlyArray<{ type: string }>) =>
  traces.filter((t) => t.type === 'presentation:retracted') as unknown as Array<{ agentName: string; messageIds: string[]; reason: string }>;

describe("the presentation module's repairs of removed rows (#291)", () => {
  it("retractRemoved takes a row removed through one context out of every other window at its place, and traces it", async () => {
    const r = await rig();
    const [a, b, c] = ['a', 'b', 'c'].map(r.write);
    assert.ok([a, b, c].every((id) => r.oren.cm.ordinalOf(id) !== undefined), 'both windows hold every row');
    const before = ordinals(r.oren.cm);
    const removed = removeStoredMessage(r.mira.cm, b);
    assert.equal(r.mira.cm.ordinalOf(b), undefined, "context-manager tombstones the remover's own window");
    assert.notEqual(r.oren.cm.ordinalOf(b), undefined, "and not oren's (CM-T): the state the repair is for");

    const out = r.presentation.retractRemoved(r.mira.cm, removed, 'hide');
    assert.deepEqual(out, [{ agent: 'oren', ids: [b] }]);
    assert.equal(r.oren.cm.ordinalOf(b), undefined, "out of oren's window");
    assertOrdinalsKept(r.oren.cm, before, [b], 'oren');
    assert.deepEqual(r.oren.cm.getPresentedMessages().map(textOf), ['a', 'c']);
    assert.deepEqual(retracted(r.traces), [{ type: 'presentation:retracted', agentName: 'oren', messageIds: [b], reason: 'hide' }]);
    // Again: nothing is left to take, and nothing is traced.
    assert.deepEqual(r.presentation.retractRemoved(r.mira.cm, removed, 'hide'), []);
    assert.equal(retracted(r.traces).length, 1);
  });

  it('a window on a branch whose record still holds the row keeps it', async () => {
    const r = await rig();
    const row = r.write('kept on the fork');
    const kidCm = await r.mira.cm.derive({ branch: 'kid-branch', strategy: new PassthroughStrategy() });
    closers.push(() => kidCm.close());
    const derivation = kidCm.getDerivation()!;
    r.registry.register(taskForkSpec('kid', {
      parent: 'mira',
      inherit: { mode: 'shared', atSequence: derivation.atSequence, ownBranch: 'kid-branch', derivation: JSON.parse(JSON.stringify(derivation)) },
    }));
    const kid = new TestAgent('kid', kidCm);
    r.live.set('kid', kid);
    r.presentation.adopt(kid);
    const kidOrdinal = kidCm.ordinalOf(row);
    assert.notEqual(kidOrdinal, undefined, "the fork's window inherited the row");

    const out = r.presentation.retractRemoved(r.mira.cm, removeStoredMessage(r.mira.cm, row), 'module');
    assert.deepEqual(out.map((o) => o.agent), ['oren'], "oren's, not the fork's");
    assert.equal(kidCm.ordinalOf(row), kidOrdinal, 'the fork keeps its row where it was');
    assert.equal(kidCm.windowStatusOf(row), 'in');
  });

  it('a window that is still the record is never written to', async () => {
    const r = await rig();
    const tess = new TestAgent('tess', await r.open('tess'));
    r.live.set('tess', tess);
    const row = r.write('read by every window');
    assert.equal(tess.cm.windowMode(), 'legacy');
    r.presentation.retractRemoved(r.mira.cm, removeStoredMessage(r.mira.cm, row), 'hide');
    assert.equal(tess.cm.windowMode(), 'legacy', 'not written down');
    assert.equal(r.store.getStateLen('agents/tess/window'), null, 'no index state written');
    assert.deepEqual(retracted(r.traces).map((t) => t.agentName), ['oren']);
  });

  it("a window that can't be repaired is logged and passed by: the others are repaired, and nothing throws", async () => {
    const r = await rig();
    const tess = new TestAgent('tess', await r.open('tess'));
    r.live.set('tess', tess);
    r.presentation.adopt(tess);
    const row = r.write('for everyone');
    tess.cm.presentRows([row]);
    (r.oren.cm as unknown as { retractRemoved: () => never }).retractRemoved = () => { throw new Error('zz-injected retract failure'); };
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const out = r.presentation.retractRemoved(r.mira.cm, removeStoredMessage(r.mira.cm, row), 'hide');
      assert.deepEqual(out, [{ agent: 'tess', ids: [row] }], "tess's window is repaired past oren's failure");
    } finally {
      console.error = error;
    }
    assert.ok(logged.some((line) => line.includes("out of oren's window (hide); the removal stands") && line.includes('zz-injected retract failure')), logged.join('\n'));
    assert.equal(r.mira.cm.getMessage(row), null, 'the removal stands');
  });

  it('retractAbsentRows takes out of each presented window the rows its record no longer holds, which no live context heard removed', async () => {
    const r = await rig();
    const [a, b, c] = ['a', 'b', 'c'].map(r.write);
    const before = ordinals(r.oren.cm);
    // Removed through a context of the slot the module never took on, whose
    // window is still the record and so tombstones nothing, as no live
    // context hears a removal made with the host stopped.
    const apart = await r.open('apart');
    removeStoredMessage(apart, b);
    assert.equal(apart.windowMode(), 'legacy');
    assert.notEqual(r.mira.cm.ordinalOf(b), undefined, 'no live window heard it');
    assert.notEqual(r.oren.cm.ordinalOf(b), undefined);
    const out = r.presentation.retractAbsentRows();
    assert.deepEqual(out.sort((x, y) => x.agent.localeCompare(y.agent)), [{ agent: 'mira', ids: [b] }, { agent: 'oren', ids: [b] }]);
    assert.deepEqual(retracted(r.traces).map((t) => [t.agentName, t.reason]).sort(), [['mira', 'boot'], ['oren', 'boot']]);
    assertOrdinalsKept(r.oren.cm, before, [b], 'oren');
    assert.deepEqual([a, c].map((id) => r.mira.cm.ordinalOf(id) !== undefined), [true, true]);
    assert.deepEqual(r.presentation.retractAbsentRows(), [], 'nothing left to take');
  });
});

// ============================================================================
// Each removal through the framework
// ============================================================================

/** A module that keeps its context, and answers `test:remove` with removals. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  ctx!: ModuleContext;
  toRemove: string[] = [];
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'test:remove') return {};
    const removeMessages = this.toRemove;
    this.toRemove = [];
    return { removeMessages };
  }
}

type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
  handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  removePlacement(placement: { agent: string; messageId?: string }): boolean;
  discordAwarenessOutbox: DiscordAwarenessOutbox;
};

async function boot(dir?: string) {
  const at = dir ?? mkdtempSync(join(tmpdir(), 'af-presentation-removals-fw-'));
  if (!dir) dirs.push(at);
  const surface = new SurfaceModule();
  const framework = await AgentFramework.create({
    storePath: join(at, 'store.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
      { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
    ],
    modules: [surface],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  closers.push(() => framework.stop());
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  const internals = framework as unknown as Internals;
  const mira = framework.getAgent('mira')!.getContextManager();
  const oren = framework.getAgent('oren')!.getContextManager();
  /** A Discord message for both residents, presented at rest to each as it is stored. */
  const say = (t: string, discordId: string): MessageId =>
    internals.addMessage('someone', text(t), { serverId: 'discord', channelId: 'discord:g1:c1', messageId: discordId } as MessageMetadata);
  const compiled = async (cm: ContextManager) => (await cm.compile(undefined, undefined, { dryRun: true })).messages.map((m) => JSON.stringify(m.content)).join('\n');
  return { dir: at, framework, surface, traces, internals, mira, oren, say, compiled };
}

describe('every removal in place leaves every window that held the row (#291, AF-7)', () => {
  it("a hide of one message, and of a range, takes the rows out of oren's window too, at their places", async () => {
    const f = await boot();
    const [a, b, c, d] = [['zz-a', 'd1'], ['zz-b', 'd2'], ['zz-c', 'd3'], ['zz-d', 'd4']].map(([t, id]) => f.say(t!, id!));
    assert.ok([a, b, c, d].every((id) => f.oren.ordinalOf(id) !== undefined && f.mira.ordinalOf(id) !== undefined), 'presented to both');
    const before = ordinals(f.oren);

    const one = await f.internals.handleHostCommand('discord', { command: 'hide', agentName: 'mira', fromMessageId: 'd2', requesterName: 'zz-op' });
    assert.equal(one.ok, true, String(one.error));
    assert.equal(f.oren.ordinalOf(b), undefined, "out of oren's window");
    assert.equal(f.mira.ordinalOf(b), undefined, "and mira's");
    assertOrdinalsKept(f.oren, before, [b], 'oren');
    assert.ok(!(await f.compiled(f.oren)).includes('zz-b'), "oren's compile leaves it out");

    const range = await f.internals.handleHostCommand('discord', { command: 'hide', agentName: 'mira', fromMessageId: 'd3', toMessageId: 'd4', requesterName: 'zz-op' });
    assert.equal(range.ok, true, String(range.error));
    assert.deepEqual([c, d].map((id) => f.oren.ordinalOf(id)), [undefined, undefined]);
    assertOrdinalsKept(f.oren, before, [b, c, d], 'oren');
    assert.deepEqual(retracted(f.traces).map((t) => [t.agentName, t.messageIds, t.reason]), [
      ['oren', [b], 'hide'], ['oren', [c, d], 'hide'],
    ]);
  });

  it("a module's removal, and a process answer's, take the row out of every window", async () => {
    const f = await boot();
    const [a, b, c] = [['zz-a', 'd1'], ['zz-b', 'd2'], ['zz-c', 'd3']].map(([t, id]) => f.say(t!, id!));
    const before = ordinals(f.oren);
    f.surface.ctx.removeMessage(b);
    assert.equal(f.oren.ordinalOf(b), undefined);
    assertOrdinalsKept(f.oren, before, [b], 'oren');

    f.surface.toRemove = [c];
    f.framework.pushEvent({ type: 'test:remove' } as unknown as ProcessEvent);
    await f.framework.runUntilIdle();
    assert.equal(f.mira.getMessage(c), null, 'the answer removed it');
    assert.equal(f.oren.ordinalOf(c), undefined, "and it left oren's window");
    assert.notEqual(f.oren.ordinalOf(a), undefined);
    assert.deepEqual(retracted(f.traces).map((t) => [t.agentName, t.reason]), [['oren', 'module'], ['oren', 'module']]);
  });

  it("the coalescer's removal of an unread row takes it out of every window that held it", async () => {
    const f = await boot();
    const [a, b] = [['zz-a', 'd1'], ['zz-b', 'd2']].map(([t, id]) => f.say(t!, id!));
    const before = ordinals(f.oren);
    assert.equal(f.internals.removePlacement({ agent: 'mira', messageId: a }), true);
    assert.equal(f.oren.ordinalOf(a), undefined);
    assertOrdinalsKept(f.oren, before, [a], 'oren');
    assert.notEqual(f.oren.ordinalOf(b), undefined);
    assert.deepEqual(retracted(f.traces).map((t) => [t.agentName, t.messageIds, t.reason]), [['oren', [a], 'coalescer']]);
  });

  it("a suppression takes the rows out of oren's window on its fork, and the source keeps them", async () => {
    const f = await boot();
    const [a, b, c] = [['zz-a', 'd1'], ['zz-b', 'd2'], ['zz-c', 'd3']].map(([t, id]) => f.say(t!, id!));
    const before = ordinals(f.oren);
    const result = await f.framework.suppressMessages('mira', { messageIds: [b] });
    assert.equal(f.oren.currentBranch().name, result.targetBranch, 'every context is on the fork');
    assert.equal(f.oren.ordinalOf(b), undefined, "out of oren's window on the fork");
    assertOrdinalsKept(f.oren, before, [b], 'oren');
    assert.ok(!(await f.compiled(f.oren)).includes('zz-b'));
    assert.deepEqual(retracted(f.traces).map((t) => [t.agentName, t.reason]), [['oren', 'suppress']]);
    await f.framework.switchBranch(result.sourceBranch);
    assert.deepEqual([a, b, c].map((id) => f.oren.ordinalOf(id)), [...before.values()], 'the source branch keeps every row in its place');
  });

  it("a suppression a start finishes takes its rows out of oren's window too", async () => {
    const f = await boot();
    const [, b] = [['zz-a', 'd1'], ['zz-b', 'd2'], ['zz-c', 'd3']].map(([t, id]) => f.say(t!, id!));
    const before = ordinals(f.oren);
    // An interrupted suppression: its fork exists, nothing was redacted yet.
    const source = f.mira.currentBranch().name;
    await f.mira.fork('partial');
    await f.internals.discordAwarenessOutbox.prepare({
      agentName: 'mira', sourceBranch: source, targetBranch: 'partial', refs: [], scope: 'none',
      suppressionIntervals: [{ fromId: String(b), toId: String(b) }],
    });
    await f.framework.stop();
    closers.pop();

    const g = await boot(f.dir);
    const replayed: TraceEvent[] = [];
    g.framework.onTrace((event) => { replayed.push(event); }, { replay: true });
    assert.equal(g.mira.currentBranch().name, 'partial', 'the start is on the fork');
    assert.equal(g.mira.getMessage(b), null, 'the start finished the removal');
    assert.equal(g.oren.ordinalOf(b), undefined, "and took it out of oren's window");
    assertOrdinalsKept(g.oren, before, [b], 'oren');
    assert.deepEqual(retracted(replayed).map((t) => [t.agentName, t.messageIds, t.reason]), [['oren', [b], 'resume']],
      'as it finished the removal, before the pass over every window');
  });

  it("a hide still answers ok when oren's window can't be repaired, and the failure is logged", async () => {
    const f = await boot();
    const b = f.say('zz-b', 'd2');
    (f.oren as unknown as { retractRemoved: () => never }).retractRemoved = () => { throw new Error('zz-injected retract failure'); };
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let answer: Record<string, unknown>;
    try {
      answer = await f.internals.handleHostCommand('discord', { command: 'hide', agentName: 'mira', fromMessageId: 'd2', requesterName: 'zz-op' });
    } finally {
      console.error = error;
    }
    assert.equal(answer.ok, true, String(answer.error));
    assert.equal(f.mira.getMessage(b), null, 'the removal stands');
    assert.ok(logged.some((line) => line.includes("out of oren's window (hide); the removal stands")), logged.join('\n'));
  });
});
