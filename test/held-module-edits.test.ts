/**
 * A module's edits and removals while a branch move holds the store, or
 * while the delivery agent's context manager refuses its work: they wait in
 * memory with the writes, in arrival order, and reach the branch that the
 * move lands on.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { MalformedContentError, type MessageId } from '@animalabs/context-manager';
import { AgentFramework, OperatorActionError } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

class Mutator implements Module {
  readonly name = 'mutator';
  ctx: ModuleContext | null = null;
  answer: EventResponse = {};
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = null; }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(event: { type: string }): Promise<EventResponse> { return event.type === 'zz-mutate' ? this.answer : {}; }
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

async function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), 10_000); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("a module's edits and removals while the store is held", () => {
  let dir: string;
  let framework: AgentFramework;
  let mutator: Mutator;
  let traces: TraceEvent[];
  let ids: MessageId[];
  let openHold: (() => void) | undefined;

  const cm = () => framework.getAgent('scout')!.getContextManager();
  const texts = () => cm().getAllMessages().map((m) => (m.content[0] as { text: string }).text);
  const ctx = () => mutator.ctx!;
  const lostAlerts = () => traces.filter((t) => t.type === 'ops:alert' && t.kind === 'store-held-lost');

  /** A rollback to m3 whose hold waits, before its cut, until `open()`. */
  const gatedRollback = () => {
    const internals = framework as unknown as { prepareMarkerBatch: (...args: unknown[]) => Promise<unknown> };
    const prepare = internals.prepareMarkerBatch;
    let reached!: () => void;
    const inHold = new Promise<void>((resolve) => { reached = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    internals.prepareMarkerBatch = async (...args: unknown[]) => {
      internals.prepareMarkerBatch = prepare;
      reached();
      await gate;
      return prepare.apply(framework, args);
    };
    openHold = open;
    const rollback = framework.rollbackToMessage('scout', { messageId: ids[2]! });
    rollback.catch(() => {});
    return { inHold: within(inHold, "the rollback's hold"), open, rollback };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'held-module-edits-'));
    mutator = new Mutator();
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [mutator],
    });
    traces = [];
    framework.onTrace((event) => { traces.push(event); });
    ids = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(cm().addMessage('user', text(`m${i}`), {}));
      cm().presentRows([ids[ids.length - 1]!]);
    }
  });

  afterEach(async () => {
    openHold?.();
    openHold = undefined;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a module's edit, removal and write during a rollback's hold leave the branch it leaves alone, and reach the branch it lands on, in order", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().editMessage(ids[0]!, text('m1 edited'));
    ctx().removeMessage(ids[1]!);
    ctx().addMessage('user', text('added during the hold'));
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'nothing changes while the store is held');
    assert.equal(framework.getHostModeStatus().deferredWrites, 3);
    open();
    const result = await rollback;
    assert.deepEqual(texts(), ['m1 edited', 'm3', 'added during the hold']);
    await cm().switchBranch(result.sourceBranch);
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'the branch the rollback left is as it was');
  });

  it("a module's answer that edits and removes during a rollback's hold reaches the branch it lands on", async () => {
    framework.start();
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    mutator.answer = { editMessages: [{ messageId: ids[0]!, content: text('m1 edited') }], removeMessages: [ids[1]!] };
    const processed = within(new Promise<void>((done) => framework.onTrace((event) => {
      if (event.type === 'process:completed' && (event.processEvent as { type: string }).type === 'zz-mutate') done();
    })), 'the answer to be applied');
    framework.pushEvent({ type: 'zz-mutate' } as never);
    await processed;
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'nothing changes while the store is held');
    open();
    await rollback;
    assert.deepEqual(texts(), ['m1 edited', 'm3']);
  });

  it("a removal of the rollback's target during its hold doesn't stop the rollback, and takes the target out of the branch it lands on", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().removeMessage(ids[2]!);
    open();
    await rollback;
    assert.deepEqual(texts(), ['m1', 'm2']);
  });

  it('an edit and a removal of rows that the rollback cuts are skipped at the release, with no alert', async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().editMessage(ids[3]!, text('m4 edited'));
    ctx().removeMessage(ids[4]!);
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      open();
      await rollback;
    } finally {
      console.error = quiet;
    }
    assert.deepEqual(texts(), ['m1', 'm2', 'm3']);
    assert.deepEqual(lostAlerts(), []);
    assert.equal(logged.filter((line) => line.includes('found no such row on the branch the move landed on')).length, 2);
  });

  it('a malformed edit during the hold throws at once, and nothing waits for the release', async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    try {
      assert.throws(() => ctx().editMessage(ids[0]!, [{ type: 'text' } as unknown as ContentBlock]), MalformedContentError);
      assert.equal(framework.getHostModeStatus().deferredWrites, 0);
    } finally {
      open();
    }
    await rollback;
    assert.deepEqual(texts(), ['m1', 'm2', 'm3']);
  });

  it("a removal during a rollback's hold reaches the source branch that a failed rollback restores", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().removeMessage(ids[2]!);
    const switching = cm() as unknown as { switchBranch: (name: string) => Promise<void> };
    const switchBranch = switching.switchBranch;
    switching.switchBranch = async (name: string) => {
      switching.switchBranch = switchBranch;
      await switchBranch.call(cm(), name);
      throw new Error('injected switch failure');
    };
    open();
    await assert.rejects(rollback, OperatorActionError);
    assert.equal(cm().currentBranch().name, 'main');
    assert.deepEqual(texts(), ['m1', 'm2', 'm4', 'm5']);
  });

  it("edits made at the release, by a listener of a write that it stores, read each other, and come after an edit that the hold kept", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().editMessage(ids[0]!, text('m1 first'));
    ctx().addMessage('user', text('new'));
    const seen: string[] = [];
    framework.onTrace((event) => {
      if (event.type !== 'message:added' || event.source !== 'surgery-release') return;
      const id = event.messageId as MessageId;
      ctx().editMessage(id, text('new, once'));
      seen.push((ctx().getMessage(id)!.content[0] as { text: string }).text);
      ctx().editMessage(id, text(`${seen[0]}, twice`));
      ctx().editMessage(ids[0]!, text('m1 second'));
    });
    open();
    await rollback;
    assert.deepEqual(seen, ['new, once']);
    assert.deepEqual(texts(), ['m1 second', 'm2', 'm3', 'new, once, twice']);
  });

  it("while the agent's context manager refuses its work, its edits and removals wait in memory, and its recovery applies them", async () => {
    const strategy = cm().getStrategy() as unknown as { initialize?: (...args: unknown[]) => Promise<void> };
    const own = Object.hasOwn(strategy, 'initialize');
    const initialize = strategy.initialize;
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
    const quiet = console.error;
    console.error = () => {};
    try {
      await framework.switchBranch('main');
    } finally {
      console.error = quiet;
      if (own) strategy.initialize = initialize;
      else delete strategy.initialize;
    }
    const counted = ctx().queryMessages({}).totalCount;
    ctx().editMessage(ids[0]!, text('m1 edited'));
    ctx().removeMessage(ids[1]!);
    ctx().editMessage(ids[1]!, text('m2 edited after its removal'));
    assert.equal(framework.getHostModeStatus().deferredWrites, 3, 'all three wait in memory');
    assert.equal(ctx().getMessage(ids[1]!), null, "a module's read leaves out the row it removed, though an edit of it came after");
    assert.equal((ctx().getMessage(ids[0]!)!.content[0] as { text: string }).text, 'm1 edited', "a module's read shows its edit");
    const queried = ctx().queryMessages({});
    assert.equal(queried.totalCount, counted - 1, "a module's query counts the removed row out");
    assert.deepEqual(queried.messages.map((m) => (m.content[0] as { text: string }).text), ['m1 edited', 'm3', 'm4', 'm5']);
    await framework.switchBranch('main');
    assert.deepEqual(texts(), ['m1 edited', 'm3', 'm4', 'm5']);
  });

  it("a module's edits for an agent that waits for its recovery apply in the order they came, though its manager takes work again before the move", async () => {
    const strategy = cm().getStrategy() as unknown as { initialize?: (...args: unknown[]) => Promise<void> };
    const own = Object.hasOwn(strategy, 'initialize');
    const initialize = strategy.initialize;
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
    const quiet = console.error;
    console.error = () => {};
    try {
      await framework.switchBranch('main');
    } finally {
      console.error = quiet;
      if (own) strategy.initialize = initialize;
      else delete strategy.initialize;
    }
    ctx().editMessage(ids[0]!, text('m1 first'));
    await cm().setStrategy(cm().getStrategy());
    ctx().editMessage(ids[0]!, text('m1 second'));
    assert.equal(framework.getHostModeStatus().deferredWrites, 2, 'the second waits behind the first');
    await framework.switchBranch('main');
    assert.deepEqual(texts(), ['m1 second', 'm2', 'm3', 'm4', 'm5']);
  });

  it("a module's removal of a row with an external id during the hold keeps the id's entry, and the first lookup after the release drops it", async () => {
    const id = ctx().addMessage('user', text('m6'), { external: { source: 'chat', id: 'e6' } });
    const entries = () => Object.keys((ctx().getState<{ externalIdMap?: Record<string, string> }>() ?? {}).externalIdMap ?? {});
    assert.deepEqual(entries(), ['chat:e6']);
    const strategy = cm().getStrategy() as unknown as { initialize?: (...args: unknown[]) => Promise<void> };
    const own = Object.hasOwn(strategy, 'initialize');
    const initialize = strategy.initialize;
    let reached!: () => void;
    const inHold = new Promise<void>((resolve) => { reached = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    strategy.initialize = async (...args: unknown[]) => {
      if (own) strategy.initialize = initialize;
      else delete strategy.initialize;
      reached();
      await gate;
      await initialize?.apply(strategy, args);
    };
    openHold = open;
    const move = framework.switchBranch('main');
    await within(inHold, "the switch's hold");
    try {
      ctx().removeMessage(id);
      assert.equal(ctx().findMessageByExternalId('chat', 'e6'), null, 'a lookup finds the row gone');
      assert.deepEqual(entries(), ['chat:e6'], 'the saved map keeps the entry while the store is held');
      assert(texts().includes('m6'), 'the row stays while the store is held');
    } finally {
      open();
    }
    await move;
    assert(!texts().includes('m6'), 'the release removes the row');
    assert.equal(ctx().findMessageByExternalId('chat', 'e6'), null);
    assert.deepEqual(entries(), [], 'the first lookup after the release drops the entry');
  });
});
