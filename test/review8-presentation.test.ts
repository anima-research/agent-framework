/**
 * The framework's presentation points after one that failed, and what a
 * host is told of a failure (AF #844's bot review, findings 4, 6, 13, 36,
 * 54 and 79), driven through AgentFramework: a write through an agent whose
 * window is the record still reaches the other readers of its slot; a
 * write's placement says when the row is out of its agent's window; a
 * window left as the record is alerted; and the boot leaves out of a window
 * what it couldn't read for a wake.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, type TraceEvent } from '../src/index.js';
import { AgentPresentation } from '../src/presentation.js';
import { fixture, eventually, settles, ok } from './helpers/coalescing-fixture.js';
import { HeldStream, MockMembrane } from './helpers/mock-membrane.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

interface Placement { agent?: string; messageId?: string; presented?: false }
interface Internals {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; placement?: Placement }): MessageId;
  writeToFork(agent: unknown, content: ContentBlock[], metadata: Record<string, unknown>): Placement;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Array<{ agentName: string; reason: string; source?: string }>;
}

/** Run `body` with console.error and console.warn caught; returns its result and the lines logged. */
async function logged<T>(body: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const { error, warn } = console;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = console.error;
  try { return { result: await body(), lines }; } finally { console.error = error; console.warn = warn; }
}

const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'af-review8-presentation-'));
  dirs.push(made);
  return made;
};

/** A host's store whose index for `name`'s window is in another version's format, so its write-down leaves it in legacy mode. */
function storeWithForeignIndex(path: string, name: string): JsStore {
  const store = JsStore.openOrCreate({ path });
  store.registerState({ id: `agents/${name}/window`, strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
  store.appendToStateJson(`agents/${name}/window`, { v: 99 });
  return store;
}

/** Two residents, mira (the primary) and oren, over `store` or a store at `storePath`; creation's traces replayed into `traces`. */
async function residents(source: { store: JsStore } | { storePath: string }) {
  const traces: TraceEvent[] = [];
  const framework = await AgentFramework.create({
    ...source,
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', proseRouting: 'disabled' },
      { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.', proseRouting: 'disabled' },
    ],
    modules: [],
    syncIntervalMs: 0,
    operatorLogPath: false,
  } as Parameters<typeof AgentFramework.create>[0]);
  framework.onTrace((event) => { traces.push(event); }, { replay: true });
  const internals = framework as unknown as Internals;
  const cm = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();
  return { framework, traces, internals, cm };
}

describe("a write through an agent whose window is the record (AF #844 bot review finding 79)", () => {
  it("enters an idle co-resident's window at once", async () => {
    const store = storeWithForeignIndex(join(dir(), 'store.chronicle'), 'mira');
    const { result: r } = await logged(() => residents({ store }));
    try {
      assert.equal(r.cm('mira').windowMode(), 'legacy', "setup: mira's window couldn't be written down");
      assert.equal(r.cm('oren').windowMode(), 'presented', "setup: oren's is presented");
      const id = r.internals.addMessage('someone', text('a message for everyone'));
      assert.equal(r.cm('oren').windowStatusOf(id), 'in', "in oren's window at its write, though mira's isn't presented");
    } finally {
      await r.framework.stop();
      store.close();
    }
  });
});

describe("a write's placement (AF #844 bot review findings 4 and 13)", () => {
  it("says presented: false for a write to an idle agent whose presentation at rest failed, and nothing for one presented", async () => {
    const r = await residents({ storePath: join(dir(), 'store.chronicle') });
    try {
      const cm = r.cm('mira');
      const presentRows = cm.presentRows.bind(cm);
      cm.presentRows = () => { throw new Error('a transient write failure'); };
      const placement: Placement = {};
      const { result: id } = await logged(() => r.internals.addMessage('someone', text('for mira'), undefined, { forAgent: 'mira', placement }));
      cm.presentRows = presentRows;
      assert.equal(cm.windowStatusOf(id), 'out', 'setup: the row is out of her window');
      assert.deepEqual(placement, { agent: 'mira', messageId: id, presented: false });
      const next: Placement = {};
      const nextId = r.internals.addMessage('someone', text('for mira again'), undefined, { forAgent: 'mira', placement: next });
      assert.deepEqual(next, { agent: 'mira', messageId: nextId }, 'a write presented at rest says nothing more');
      assert.equal(cm.windowStatusOf(id), 'in', 'and took the earlier row in with it');
    } finally {
      await r.framework.stop();
    }
  });

  it("says presented: false for a fork's write while its turn is alive, and for one at rest whose presentation failed", async () => {
    const r = await residents({ storePath: join(dir(), 'store.chronicle') });
    try {
      const mira = r.framework.getAgent('mira')!;
      const cm = r.cm('mira');
      r.internals.activeTurnTokens.set('mira', -1);
      const midTurn = r.internals.writeToFork(mira, text('stored during her turn'), {});
      r.internals.activeTurnTokens.delete('mira');
      assert.deepEqual(midTurn, { agent: 'mira', messageId: midTurn.messageId, presented: false });
      assert.equal(cm.windowStatusOf(midTurn.messageId as MessageId), 'out');
      const presentRows = cm.presentRows.bind(cm);
      cm.presentRows = () => { throw new Error('a transient write failure'); };
      const { result: failed } = await logged(() => r.internals.writeToFork(mira, text('stored at rest'), {}));
      cm.presentRows = presentRows;
      assert.deepEqual(failed, { agent: 'mira', messageId: failed.messageId, presented: false });
      const atRest = r.internals.writeToFork(mira, text('stored at rest again'), {});
      assert.deepEqual(atRest, { agent: 'mira', messageId: atRest.messageId }, 'presented at its write');
    } finally {
      await r.framework.stop();
    }
  });

  it("keeps a coalesced render a fork's live turn never read replaceable, and wakes the fork to read it", async (t) => {
    const f = await fixture({
      framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never,
      server: { shouldTriggerInference: () => true },
    });
    t.after(f.close);
    await f.register();
    f.alwaysRespond();
    await f.send('channels/incoming', { messages: [f.channel('c', 'hello_fork', { initial: true })] });
    await settles(f.framework.runUntilIdle(), "the fork's first turn");
    const router = (f.framework as unknown as { conversationRouter: { getBinding(channel: { serverId: string; channelId: string }): { agentName: string } | undefined } }).conversationRouter;
    const fork = router.getBinding({ serverId: 'editor', channelId: 'chat' })!.agentName;
    const internals = f.framework as unknown as Internals & {
      pushCoalescer: { assemble(agent: string, causes?: readonly string[]): Promise<unknown> };
    };
    // The render is held, and the fork's assembly throws once it has begun:
    // the render lands during the fork's turn, after its assembly, as any
    // write during the turn does.
    let release!: (value: unknown) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    f.renderer(() => { began(); return new Promise((resolve) => { release = resolve; }); });
    const assemble = internals.pushCoalescer.assemble.bind(internals.pushCoalescer);
    internals.pushCoalescer.assemble = async (agent: string, causes?: readonly string[]) => {
      internals.pushCoalescer.assemble = assemble;
      void assemble(agent, causes);
      await started;
      throw new Error('a freeze failed');
    };
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: unknown) => {
      f.membrane.calls.push(request as never);
      return new HeldStream(opened, [ok()]);
    };
    const before = f.membrane.calls.length;
    const error = console.error;
    console.error = () => {};
    try {
      await f.send('push/event', f.params('1', 'first_fallback', { deferred: true, channelId: 'chat', key: 'activity' }));
      const turns = f.framework.runUntilIdle();
      await eventually(() => f.membrane.calls.length === before + 1, "the fork's model call");
      release({ content: [{ type: 'text', text: 'late_render' }] });
      await eventually(() => f.context(fork).includes('late_render'), 'the render landing in the fork');
      assert(!f.window(fork).includes('late_render'), "out of the live turn's window");
      assert(internals.pendingRequests.some((r) => r.agentName === fork), 'the fork is woken to read it');
      const second = await f.send('push/event', f.params('2', 'second_text', { channelId: 'chat', key: 'activity' }));
      assert.equal(second.result.coalesce.outcome, 'replaced', 'the unread render is replaced');
      open();
      await settles(turns, "the fork's turns");
    } finally {
      console.error = error;
      open();
    }
    assert(f.lastRequest().includes('second_text') && !f.lastRequest().includes('late_render'), "the fork's next turn reads the replacement");
  });
});
