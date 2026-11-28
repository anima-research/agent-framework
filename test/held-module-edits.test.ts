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

  const gatedSwitch = ({ fail = false } = {}) => {
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
      if (fail) throw new Error('injected initialization failure');
      await initialize?.apply(strategy, args);
    };
    openHold = open;
    const move = framework.switchBranch(framework.getStore().currentBranch().name);
    move.catch(() => {});
    return { inHold: within(inHold, "the switch's hold"), open, move };
  };
  const refuseWork = async (): Promise<void> => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { inHold, open, move } = gatedSwitch({ fail: true });
      await inHold;
      open();
      await move;
    } finally {
      console.error = quiet;
    }
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
    ctx().addMessage('user', text('added during the hold'));
    ctx().removeMessage(ids[1]!);
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'nothing changes while the store is held');
    assert.equal(framework.getHostModeStatus().deferredWrites, 3);
    const order: string[] = [];
    const store = cm() as unknown as { editMessage: (...args: unknown[]) => unknown; removeMessage: (...args: unknown[]) => unknown };
    const { editMessage, removeMessage } = store;
    store.editMessage = (...args: unknown[]) => { order.push('edit'); return editMessage.apply(cm(), args); };
    store.removeMessage = (...args: unknown[]) => { order.push('remove'); return removeMessage.apply(cm(), args); };
    framework.onTrace((event) => { if (event.type === 'message:added' && event.source === 'surgery-release') order.push('write'); });
    open();
    const result = await rollback;
    store.editMessage = editMessage;
    store.removeMessage = removeMessage;
    assert.deepEqual(order, ['edit', 'write', 'remove'], 'the release keeps the order they came in');
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

  it("edits made at the release, by a listener of a write that it stores, read each other, and wait behind an edit that the hold kept after that write", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().addMessage('user', text('new'));
    ctx().editMessage(ids[0]!, text('m1 first'));
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

  it("a kept removal of one row of a body hides the whole body from a module's reads, and the release removes the whole body", async () => {
    type ShardStore = { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: string } } };
    const shards = ['s0', 's1', 's2'].map((shard, shardIndex) =>
      (cm() as unknown as ShardStore).messageStore.append('user', [{ type: 'text', text: shard }], {}, undefined, { bodyGroupId: 'g', shardIndex }).id as MessageId);
    const counted = ctx().queryMessages({}).totalCount;
    const { inHold, open, move } = gatedSwitch();
    await inHold;
    ctx().removeMessage(shards[1]!);
    for (const shard of shards) assert.equal(ctx().getMessage(shard), null);
    const queried = ctx().queryMessages({});
    assert(!queried.messages.some((row) => shards.includes(row.id)), "a module's query leaves out the whole body");
    assert.equal(queried.totalCount, counted - 3);
    open();
    await move;
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it("a module's read of a kept edit gives a copy, so a change of what it read doesn't reach the row", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().editMessage(ids[0]!, text('m1 edited'));
    (ctx().getMessage(ids[0]!)!.content[0] as { text: string }).text = 'changed by a reader';
    (ctx().queryMessages({}).messages[0]!.content[0] as { text: string }).text = 'changed by a reader';
    assert.equal((ctx().getMessage(ids[0]!)!.content[0] as { text: string }).text, 'm1 edited');
    open();
    await rollback;
    assert.deepEqual(texts(), ['m1 edited', 'm2', 'm3']);
  });

  it("a kept removal of a body hides that body's rows alone, though another body shares its group id", async () => {
    type ShardStore = { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: string } } };
    const append = (shard: string, shardIndex: number) =>
      (cm() as unknown as ShardStore).messageStore.append('user', [{ type: 'text', text: shard }], {}, undefined, { bodyGroupId: 'g', shardIndex }).id as MessageId;
    const first = [append('a0', 0), append('a1', 1)];
    cm().addMessage('user', text('between'), {});
    const second = [append('b0', 0), append('b1', 1)];
    const counted = ctx().queryMessages({}).totalCount;
    const { inHold, open, move } = gatedSwitch();
    await inHold;
    ctx().removeMessage(first[0]!);
    for (const shard of first) assert.equal(ctx().getMessage(shard), null);
    for (const shard of second) assert.notEqual(ctx().getMessage(shard), null, 'the other body shows');
    assert.equal(ctx().queryMessages({}).totalCount, counted - 2);
    open();
    await move;
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5', 'between', 'b0', 'b1']);
  });

  it("a write and a removal that the release keeps for the agent's recovery reach the store in the order they came", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { inHold, open, move } = gatedSwitch({ fail: true });
      await inHold;
      ctx().addMessage('user', text('added during the hold'));
      ctx().removeMessage(ids[1]!);
      open();
      await move;
    } finally {
      console.error = quiet;
    }
    assert.equal(framework.getHostModeStatus().deferredWrites, 2, 'the release kept both for the recovery');
    const order: string[] = [];
    const store = cm() as unknown as { removeMessage: (...args: unknown[]) => unknown };
    const removeMessage = store.removeMessage;
    store.removeMessage = (...args: unknown[]) => { order.push('remove'); return removeMessage.apply(cm(), args); };
    framework.onTrace((event) => { if (event.type === 'message:added' && event.source === 'surgery-release') order.push('write'); });
    await framework.switchBranch(framework.getStore().currentBranch().name);
    store.removeMessage = removeMessage;
    assert.deepEqual(order, ['write', 'remove']);
    assert.deepEqual(texts(), ['m1', 'm3', 'm4', 'm5', 'added during the hold']);
  });

  it("while the agent's context manager refuses its work, its edits and removals wait in memory, and its recovery applies them", async () => {
    await refuseWork();
    const counted = ctx().queryMessages({}).totalCount;
    ctx().removeMessage(ids[1]!);
    const content = text('m1 edited');
    ctx().editMessage(ids[0]!, content);
    (content[0] as { text: string }).text = 'm1 changed by its caller after the call';
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
    await refuseWork();
    ctx().editMessage(ids[0]!, text('m1 first'));
    await cm().setStrategy(cm().getStrategy());
    ctx().editMessage(ids[0]!, text('m1 second'));
    assert.equal(framework.getHostModeStatus().deferredWrites, 2, 'the second waits behind the first');
    await framework.switchBranch('main');
    assert.deepEqual(texts(), ['m1 second', 'm2', 'm3', 'm4', 'm5']);
  });

  it("an edit or a removal of a row that the store doesn't hold throws at once during a hold, as a write's empty id names none", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    const id = ctx().addMessage('user', text('added during the hold'));
    assert.equal(id, '');
    assert.throws(() => ctx().editMessage(id, text('an edit of the write')));
    assert.throws(() => ctx().removeMessage('no-such-row' as MessageId));
    assert.equal(framework.getHostModeStatus().deferredWrites, 1, 'only the write waits');
    open();
    await rollback;
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'added during the hold']);
  });

  it('a change whose store throws at the release is told in an alert, and the release goes on with the writes after it', async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().editMessage(ids[0]!, text('m1 edited'));
    ctx().addMessage('user', text('added after the edit'));
    const store = cm() as unknown as { editMessage: (...args: unknown[]) => unknown };
    const editMessage = store.editMessage;
    store.editMessage = () => { store.editMessage = editMessage; throw new Error('injected store failure'); };
    const quiet = console.error;
    console.error = () => {};
    try {
      open();
      await rollback;
    } finally {
      console.error = quiet;
    }
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'added after the edit']);
    const alerts = lostAlerts() as unknown as Array<{ message: string; data?: { kinds?: Record<string, number> } }>;
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.message, /injected store failure/);
    assert.match(alerts[0]!.message, /took effect isn't known/);
    assert.deepEqual(alerts[0]!.data?.kinds, { 'edit of a stored row': 1 });
  });

  it("a write and a change that both throw at the release each reach the webhook, and the change's alert names its row and what to do", async () => {
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    ctx().addMessage('user', text('added during the hold'));
    ctx().editMessage(ids[0]!, text('m1 edited'));
    const store = cm() as unknown as { addMessage: (...args: unknown[]) => unknown; editMessage: (...args: unknown[]) => unknown };
    const { addMessage, editMessage } = store;
    store.addMessage = (...args: unknown[]) => {
      if (!JSON.stringify(args).includes('added during the hold')) return addMessage.apply(cm(), args);
      store.addMessage = addMessage;
      throw new Error('injected write failure');
    };
    store.editMessage = () => { store.editMessage = editMessage; throw new Error('injected store failure'); };
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      posts.push(String(JSON.parse(String(init?.body)).content));
      return new Response('{}');
    }) as typeof fetch;
    const hook = process.env.CONNECTOME_OPS_WEBHOOK;
    process.env.CONNECTOME_OPS_WEBHOOK = 'http://webhook.invalid/hook';
    const quiet = console.error;
    console.error = () => {};
    try {
      open();
      await rollback;
    } finally {
      console.error = quiet;
      globalThis.fetch = realFetch;
      if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK;
      else process.env.CONNECTOME_OPS_WEBHOOK = hook;
    }
    const lost = posts.filter((post) => post.includes('store-held-lost'));
    assert.equal(lost.length, 2, 'neither alert waits out the cooldown of the other');
    assert(lost.some((post) => post.includes('injected write failure')));
    const change = lost.find((post) => post.includes('injected store failure'));
    assert(change?.includes(`an edit of ${ids[0]}`), 'the alert names the row');
    assert(change?.includes('Read that row, and make again a change that didn\'t take effect.'));
  });

  it("a change that the release finds its manager refusing waits for the agent's recovery, which applies it", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { inHold, open, move } = gatedSwitch({ fail: true });
      await inHold;
      ctx().removeMessage(ids[1]!);
      open();
      await move;
    } finally {
      console.error = quiet;
    }
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'the release kept it');
    assert.equal(framework.getHostModeStatus().deferredWrites, 1);
    await framework.switchBranch('main');
    assert.deepEqual(texts(), ['m1', 'm3', 'm4', 'm5']);
    assert.deepEqual(lostAlerts(), []);
  });

  it("a change of a row that a failed move's branch lacks waits for the agent's recovery, which applies it on a branch that has the row", async () => {
    const source = framework.getStore().currentBranch().name;
    await framework.rollbackToMessage('scout', { messageId: ids[2]! });
    const cut = framework.getStore().currentBranch().name;
    assert.notEqual(cut, source, 'premise: the rollback lands on a branch of its own');
    await framework.switchBranch(source);
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'premise: the source branch has every row');
    const internals = framework as unknown as { maintenanceRunning: () => boolean; settleMaintenancePass: () => Promise<void> };
    const { maintenanceRunning, settleMaintenancePass } = internals;
    let reached!: () => void;
    const inHold = new Promise<void>((resolve) => { reached = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    openHold = open;
    internals.maintenanceRunning = () => { internals.maintenanceRunning = maintenanceRunning; return true; };
    internals.settleMaintenancePass = async () => { internals.settleMaintenancePass = settleMaintenancePass; reached(); await gate; };
    const strategy = cm().getStrategy() as unknown as { initialize?: (...args: unknown[]) => Promise<void> };
    const own = Object.hasOwn(strategy, 'initialize');
    const initialize = strategy.initialize;
    strategy.initialize = async () => {
      if (own) strategy.initialize = initialize;
      else delete strategy.initialize;
      throw new Error('injected initialization failure');
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      const move = framework.switchBranch(cut);
      move.catch(() => {});
      await within(inHold, "the switch's wait for maintenance");
      ctx().editMessage(ids[4]!, text('m5 edited'));
      open();
      await move;
    } finally {
      console.error = quiet;
    }
    assert.equal(framework.getStore().currentBranch().name, cut, "premise: the failed move stays on the branch that lacks the row");
    assert.equal(framework.getHostModeStatus().deferredWrites, 1, 'the release kept the edit for the recovery');
    await framework.switchBranch(source);
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'm4', 'm5 edited']);
  });

  it("a hold begun during the release keeps the changes still to replay for its own release", async () => {
    const first = gatedRollback();
    await first.inHold;
    ctx().addMessage('user', text('added during the hold'));
    ctx().editMessage(ids[0]!, text('m1 edited'));
    let second: ReturnType<typeof gatedSwitch> | undefined;
    framework.onTrace((event) => {
      if (event.type === 'message:added' && event.source === 'surgery-release' && !second) second = gatedSwitch();
    });
    first.open();
    await first.rollback;
    assert(second, 'setup: the release began a second hold');
    await second.inHold;
    assert.deepEqual(texts(), ['m1', 'm2', 'm3', 'added during the hold'], 'the edit still waits');
    assert.equal(framework.getHostModeStatus().deferredWrites, 1);
    second.open();
    await second.move;
    assert.deepEqual(texts(), ['m1 edited', 'm2', 'm3', 'added during the hold']);
  });

  it("a lookup during a hold of an external id whose new write waits keeps no entry for the row that the move cuts", async () => {
    const old = ctx().addMessage('user', text('m6'), { external: { source: 'chat', id: 'e' } });
    const { inHold, open, rollback } = gatedRollback();
    await inHold;
    assert.equal(ctx().addMessage('user', text('m6 again'), { external: { source: 'chat', id: 'e' } }), '');
    assert.equal(ctx().findMessageByExternalId('chat', 'e'), old, 'the lookup finds the row that the store holds');
    open();
    await rollback;
    const landed = cm().getAllMessages().find((row) => (row.content[0] as { text: string }).text === 'm6 again');
    assert(landed, 'the release stores the new write');
    assert.equal(ctx().findMessageByExternalId('chat', 'e'), landed.id);
  });

  it("a module's removal of a row with an external id during the hold keeps the id's entry, and the first lookup after the release drops it", async () => {
    const id = ctx().addMessage('user', text('m6'), { external: { source: 'chat', id: 'e6' } });
    const entries = () => Object.keys((ctx().getState<{ externalIdMap?: Record<string, string> }>() ?? {}).externalIdMap ?? {});
    assert.deepEqual(entries(), ['chat:e6']);
    const { inHold, open, move } = gatedSwitch();
    await inHold;
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
