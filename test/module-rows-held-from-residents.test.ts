/**
 * A message a tune-out holds from the residents stays out of what they're
 * shown, and a module's reads mark it (ModuleMessage.heldFromResidents). Such
 * a message is stored with `metadata.tuneOut` and no resident's compiled view
 * shows it. A module's context answered it as an ordinary row, so a module
 * that keeps to what the residents see by leaving out `held` rows still took
 * it in; a tool boundary of a turn alive when it arrived injected it into
 * that turn; and a cancel's backlog left it out while it was still held. It
 * is stored at once, whatever the residents' turns (#291, AF-5), so its
 * readers have it while a resident is busy. Since #291 a module's reads also
 * mark `held` a row that isn't in the window of the agent the read is for
 * (AF-6), which a message a tune-out holds from the residents never is. The
 * channel and its traffic come from test/tune-out-e2e.test.ts's MCPL fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type { MessageQuery } from '@animalabs/context-manager';
import type { EventResponse, Module, ModuleContext, ModuleMessage, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, PassthroughStrategy } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

class ProbeModule implements Module {
  readonly name = 'probe';
  ctx: ModuleContext | null = null;
  /** What the `wait` tool waits for, and what it calls as it starts. */
  hold: Promise<void> = Promise.resolve();
  onWait: () => void = () => {};
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for the test', inputSchema: { type: 'object', properties: {} } }];
  }
  /** Keeps the resident's turn alive, with its round's tool pending, until the test lets it go. */
  async handleToolCall(): Promise<ToolResult> {
    this.onWait();
    await this.hold;
    return { success: true, data: { ok: true } };
  }
  /** A test's external message wakes the resident. */
  async onProcess(event: { type: string; source?: string }): Promise<EventResponse> {
    if (event.type !== 'external-message' || event.source !== 'test') return {};
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
  }
}

interface Internals {
  tuneOutCoordinator: TuneOutCoordinator | null;
  agents: Map<string, { getContextManager(): {
    getAllMessages(): Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }>;
    compile(): Promise<{ messages: Array<{ content: ContentBlock[] }> }>;
  } }>;
  channelRegistry: {
    listChannelsRaw(): unknown[];
    getDesiredState(serverId: string, channelId: string): string | undefined;
  } | null;
}

const textOf = (m: { content: ContentBlock[] }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

async function within<T>(what: string, promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Rig {
  framework: AgentFramework;
  ctx: ModuleContext;
  module: ProbeModule;
  membrane: MockMembrane;
  internals: Internals;
  /** An ambient message in the tuned-out channel. */
  emit(id: string, text: string): void;
  close(): Promise<void>;
}

/** A framework with a subconscious, the fixture's channel tuned out with the
 *  given backlogCap, and a module whose context the test reads through. Each
 *  test opens its own, so no reply one test queues on the mock reaches
 *  another's turn. */
async function open(backlogCap = 10, strategy?: PassthroughStrategy): Promise<Rig> {
  const tempDir = mkdtempSync(join(tmpdir(), 'module-rows-held-'));
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const module = new ProbeModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', ...(strategy ? { strategy: strategy as never } : {}) }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: [{
      id: 'disc',
      command: process.execPath,
      args: [FIXTURE],
      env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [module],
  });
  const close = async (): Promise<void> => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    await framework.start();
    const internals = framework as unknown as Internals;
    await waitFor('channel registration', () => (internals.channelRegistry?.listChannelsRaw().length ?? 0) > 0);
    const entered = internals.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap, maxWakes: 5 }, 'agent-tool');
    assert.ok(entered.ok, 'the channel is tuned out');
    return {
      framework,
      ctx: module.ctx!,
      module,
      membrane,
      internals,
      emit: (id, text) => appendFileSync(commandPath, `ambient ${id} ${text}\n`),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const rowWith = (rows: ModuleMessage[], text: string): ModuleMessage | undefined =>
  rows.find((m) => textOf(m).includes(text));

/** The subconscious's cancel report notice, and the held rows after it. */
function reportOf(internals: Internals): { notice: string; held: string[] } | undefined {
  const all = internals.agents.get('Subconscious')!.getContextManager().getAllMessages();
  const at = all.findIndex((m) => textOf(m).includes('[Tune-out cancelled:'));
  if (at === -1) return undefined;
  const held = all.slice(at + 1).filter((m) => m.metadata?.kind === 'tune-out-cancel-held').map(textOf);
  return { notice: textOf(all[at]!), held };
}

/** A strategy whose per-message cap the subconscious mirrors. */
class CappedPassthroughStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 80;
}

describe("a message a tune-out holds stays out of what the residents are shown, and a module reads it as heldFromResidents", () => {
  it('marks a stored held message in queryMessages and getMessage, during the tune-out and after the cancel, and leaves an ordinary row unmarked', async () => {
    const { framework, ctx, membrane, internals, emit, close } = await open();
    try {
      const ordinaryId = ctx.addMessage('user', [{ type: 'text', text: 'T1-ORDINARY a module write' }]);
      emit('t1', 'T1-HELD chatter in the tuned-out channel');
      await waitFor('the held message stored', () => !!rowWith(ctx.queryMessages({}).messages, 'T1-HELD'));

      const rows = ctx.queryMessages({}).messages;
      const heldRow = rowWith(rows, 'T1-HELD')!;
      assert.ok(heldRow.metadata?.tuneOut, 'the stored message carries the tune-out stamp');
      assert.equal(heldRow.heldFromResidents, true, 'queryMessages marks it');
      assert.equal(heldRow.held, true, "and, in no resident's window, held from the one the read is for");
      assert.equal(ctx.getMessage(heldRow.id)?.heldFromResidents, true, 'getMessage marks it');
      const ordinary = rows.find((m) => m.id === ordinaryId)!;
      assert.equal('heldFromResidents' in ordinary, false, 'an ordinary row from queryMessages has no mark');
      assert.equal('heldFromResidents' in ctx.getMessage(ordinaryId)!, false, 'nor from getMessage');

      // With no held write, queryMessages answers the store's own result,
      // its rows marked: a reversed query of one row counts every match and
      // returns the newest, the held message. (The context takes the store's
      // query, which has `limit` and `reverse`, as module-held-writes says.)
      const storeQuery = (filter: MessageQuery) => ctx.queryMessages(filter as never);
      const all = ctx.queryMessages({});
      const newest = storeQuery({ reverse: true, limit: 1 });
      assert.equal(all.totalCount, all.messages.length);
      assert.equal(newest.totalCount, all.totalCount, 'a limited query counts every match');
      assert.deepEqual(newest.messages.map((m) => m.id), [heldRow.id], 'the newest row is the held message');
      assert.equal(newest.messages[0].heldFromResidents, true, 'marked in a limited query too');

      // The mark says what the resident's view does: the held message is out
      // of it and the ordinary row is in it.
      const scout = framework.getAgent('scout')!.getContextManager();
      const view = (await scout.compile()).messages.map(textOf);
      assert.ok(!view.some((t) => t.includes('T1-HELD')), "the held message isn't in the resident's view");
      assert.ok(view.some((t) => t.includes('T1-ORDINARY')), 'the ordinary row is');

      // After the cancel the stamp stays, and so does the mark: the cancel
      // brings the residents a dump, a row of its own.
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack one' }]));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack two' }]));
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      await waitFor('the channel open again', () => internals.channelRegistry!.getDesiredState('disc', CHANNEL) === 'open');
      await waitFor('the dump stored', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const after = ctx.queryMessages({}).messages;
      assert.equal(rowWith(after, 'T1-HELD')?.heldFromResidents, true, 'still marked after the cancel');
      const dump = rowWith(after, '<tuned-out-backlog')!;
      assert.equal('heldFromResidents' in dump, false, "the dump the residents read isn't marked");
      assert.equal(ctx.getMessage(heldRow.id)?.heldFromResidents, true, 'getMessage still marks it');
    } finally {
      await close();
    }
  });

  // A held message arriving during a turn is stored at once (#291, AF-5):
  // until AF-5 it was deferred behind the turn as a held write, read through
  // its held handle, and stored at the turn's tool boundary. A module's own
  // write during the turn is stored at once too (AF-6), marked held until
  // the live turn's boundary presents it, and reaches the live turn.
  it("stores a tuned-out message that arrives during a turn at once, keeps it out of that turn, and marks it; a module's own write is held until the boundary", async () => {
    const { framework, ctx, module, membrane, internals, emit, close } = await open();
    let release: () => void = () => {};
    try {
      emit('t2a', 'T2-STORED chatter before the turn');
      await waitFor('the first message stored', () => !!rowWith(ctx.queryMessages({}).messages, 'T2-STORED'));

      // A turn of the resident's, alive with its round's tool pending, while
      // the run loop goes on taking channel traffic. (A quiesce pauses the
      // MCPL data plane, so nothing arrives while it lasts.)
      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Waiting.' },
        { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as never);
      await within("the resident's tool", inTool);
      const stream = membrane.lastStream!;
      emit('t2b', 'T2-HELD chatter while the turn is alive');
      await waitFor('the held message stored', () => !!rowWith(ctx.queryMessages({}).messages, 'T2-HELD'));
      const plainHandle = ctx.addMessage('user', [{ type: 'text', text: 'T2-PLAIN a module write while the turn is alive' }]);

      // The stored held row is marked as any stored held row is; the module's
      // own write is held behind the turn, with no mark.
      const rows = ctx.queryMessages({}).messages;
      const heldRow = rowWith(rows, 'T2-HELD')!;
      assert.ok(heldRow.metadata?.tuneOut, 'the stored message carries the stamp');
      assert.equal(heldRow.heldFromResidents, true, 'marked');
      assert.equal(rowWith(rows, 'T2-STORED')?.heldFromResidents, true, 'as is the one stored before the turn');
      assert.equal(ctx.getMessage(heldRow.id)?.heldFromResidents, true, 'getMessage marks it by its stored id');
      const plain = rowWith(rows, 'T2-PLAIN')!;
      assert.equal(plain.id, plainHandle, "the module's own write is answered by its stored id");
      assert.equal(plain.held, true, 'held: out of the live turn\'s window');
      assert.equal('heldFromResidents' in plain, false, 'a write without the stamp has no such mark');
      assert.equal('heldFromResidents' in ctx.getMessage(plainHandle)!, false, 'nor by its id');

      // At the tool boundary the module's write is stored and handed to the
      // live turn; the tuned-out one, stored already, isn't, as its compiled
      // view leaves it out.
      release();
      await waitFor('the tool results handed to the stream', () => stream.receivedToolResultOptions.length > 0);
      const injected = stream.receivedToolResultOptions.flatMap((options) =>
        (options?.injectedMessages ?? []).map((message) => JSON.stringify(message.content)));
      assert.ok(injected.some((t) => t.includes('T2-PLAIN')), "the module's write reaches the live turn");
      assert.ok(!injected.some((t) => t.includes('T2-HELD')), "the tuned-out message doesn't");
      await framework.runUntilIdle();
      const copies = framework.getAgent('scout')!.getContextManager().getAllMessages().filter((m) => textOf(m).includes('T2-HELD'));
      assert.equal(copies.length, 1, 'the held message is stored once');
      const view = (await framework.getAgent('scout')!.getContextManager().compile()).messages.map(textOf);
      assert.ok(!view.some((t) => t.includes('T2-HELD')), "and is not in the resident's view");
    } finally {
      release();
      await close();
    }
  });

  // Rewritten with AF-5 (#291): the held messages that arrive during the
  // turn are stored at once, so the backlog reads them from the record, in
  // store order, where it read them from the deferred queue after the stored
  // ones.
  it("brings tuned-out messages stored during a turn to the residents once, in the cancel's dump, when the cap shows them all", async () => {
    const { framework, ctx, module, membrane, internals, emit, close } = await open(3);
    let release: () => void = () => {};
    try {
      emit('t3a', 'T3-STORED-1 chatter before the turn');
      emit('t3b', 'T3-STORED-2 more chatter before the turn');
      await waitFor('both messages stored', () => {
        const rows = ctx.queryMessages({}).messages;
        return !!rowWith(rows, 'T3-STORED-1') && !!rowWith(rows, 'T3-STORED-2');
      });

      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Waiting.' },
        { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as never);
      await within("the resident's tool", inTool);
      const stream = membrane.lastStream!;
      emit('t3c', 'T3-HELD-1 chatter while the turn is alive');
      emit('t3d', 'T3-HELD-2 more chatter while the turn is alive');
      await waitFor('both held messages stored', () => {
        const rows = ctx.queryMessages({}).messages;
        return !!rowWith(rows, 'T3-HELD-1') && !!rowWith(rows, 'T3-HELD-2');
      });
      ctx.addMessage('user', [{ type: 'text', text: 'T3-PLAIN a module write while the turn is alive' }]);

      // The tune-out ends during the turn, as it does when the resident
      // cancels it in this turn. The backlog is the epoch's four stored
      // messages, and the cap of 3 keeps its last three.
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      await waitFor('the dump', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const dumpText = textOf(rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog')!);
      assert.ok(dumpText.includes('messages=4 truncated=1'), "the backlog is the epoch's four messages, and the cap cuts one");
      assert.ok(dumpText.includes('T3-STORED-2'), 'the dump carries the newer message stored before the turn');
      assert.ok(dumpText.includes('T3-HELD-1') && dumpText.includes('T3-HELD-2'), 'and both stored during it');
      assert.ok(!dumpText.includes('T3-STORED-1'), 'the cap cuts the oldest');
      assert.ok(!dumpText.includes('T3-PLAIN'), 'a write without the stamp stays out');
      const sub = internals.agents.get('Subconscious')!.getContextManager();
      const noticeOf = (): string | undefined =>
        sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
      await waitFor("the subconscious's report notice", () => noticeOf() !== undefined);
      assert.ok(!noticeOf()!.includes('Still held'), 'the notice carries no held message, as none is queued');
      assert.deepEqual(reportOf(internals)!.held, [], 'and no held row follows it');
      assert.ok(noticeOf()!.includes("1 of 4 diverted messages, the oldest, weren't delivered raw to the resident"), 'it gives the count the dump left out');

      // The dump, written for the resident during its turn, is the one row
      // that shows them to the resident: injected at the boundary, once.
      release();
      await waitFor('the tool results handed to the stream', () => stream.receivedToolResultOptions.length > 0);
      const injected = stream.receivedToolResultOptions.flatMap((options) =>
        (options?.injectedMessages ?? []).map((message) => JSON.stringify(message.content)));
      const carrying = injected.filter((t) => t.includes('T3-HELD'));
      assert.equal(carrying.length, 1, 'one message carries them into the live turn');
      assert.ok(carrying[0].includes('tuned-out-backlog'), 'the dump');
      const view = (await framework.getAgent('scout')!.getContextManager().compile()).messages.map(textOf);
      for (const tag of ['T3-HELD-1', 'T3-HELD-2']) {
        const shown = view.filter((t) => t.includes(tag));
        assert.equal(shown.length, 1, `the resident's view holds ${tag}'s text once`);
        assert.ok(shown[0].includes('<tuned-out-backlog'), 'in the dump');
      }
    } finally {
      release();
      await close();
    }
  });

  // Rewritten with AF-5 (#291): a held message that arrives during the
  // turn is stored, so the subconscious's view has the one the cap leaves
  // out of the dump, and its report notice is followed by no held row of
  // its own. Until AF-5 the message was queued behind the turn and handed
  // to the report as a row of its own (that path, for a message a quiesce
  // or a surgery queues, is tune-out-cancel-held's).
  it("leaves the older held message, which the cap leaves out of the dump, to the subconscious's view, which holds it stored", async () => {
    const { framework, ctx, module, membrane, internals, emit, close } = await open(1);
    let release: () => void = () => {};
    try {
      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Waiting.' },
        { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as never);
      await within("the resident's tool", inTool);
      emit('t4a', 'T4-HELD-1 chatter while the turn is alive');
      emit('t4b', 'T4-HELD-2 more chatter while the turn is alive');
      await waitFor('both held messages stored', () => {
        const rows = ctx.queryMessages({}).messages;
        return !!rowWith(rows, 'T4-HELD-1') && !!rowWith(rows, 'T4-HELD-2');
      });

      // The cap of 1 shows the newest raw; the subconscious reports on the rest.
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      await waitFor('the dump', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const dumpText = textOf(rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog')!);
      assert.ok(dumpText.includes('T4-HELD-2'), 'the dump shows the newest');
      assert.ok(!dumpText.includes('T4-HELD-1'), 'and not the older one');
      const sub = internals.agents.get('Subconscious')!.getContextManager();
      const noticeOf = (): string | undefined =>
        sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
      await waitFor("the subconscious's report notice", () => noticeOf() !== undefined);
      const report = reportOf(internals)!;
      assert.ok(report.notice.includes("1 of 2 diverted messages, the oldest, weren't delivered raw to the resident"), report.notice);
      assert.ok(!report.notice.includes('Still held'), 'nothing is still held');
      assert.deepEqual(report.held, [], 'so no held row follows the notice');
      const view = (await sub.compile()).messages.map(textOf).join('\n');
      assert.ok(view.includes('T4-HELD-1'), "the subconscious's view holds the message the dump leaves out");
    } finally {
      release();
      await close();
    }
  });

  // Rewritten with AF-5 (#291): the held messages are stored during the
  // turn, so the report carries none as rows of its own; the cancel the
  // subconscious makes with a note still gets it a report turn, since the
  // messages came in after it last looked (unseenBySubconscious), and its
  // view holds them, stored. Until AF-5 they were queued behind the turn and
  // followed its notice as rows of their own.
  it("with backlogCap 0, a cancel in the subconscious's name gives it a report turn for the held messages it hasn't seen, and the dump none", async () => {
    const { framework, ctx, module, membrane, internals, emit, close } = await open(0);
    let release: () => void = () => {};
    try {
      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Waiting.' },
        { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as never);
      await within("the resident's tool", inTool);
      // The subconscious's own turn is alive while they arrive, as when it
      // writes its note: they stay out of its window until that turn's end
      // (#291). This token stands in for that turn.
      const turns = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
      turns.set('Subconscious', -1);
      emit('t5a', 'T5-HELD-1 chatter while the turn is alive');
      emit('t5b', 'T5-HELD-2 more chatter while the turn is alive');
      await waitFor('both held messages stored', () => {
        const rows = ctx.queryMessages({}).messages;
        return !!rowWith(rows, 'T5-HELD-1') && !!rowWith(rows, 'T5-HELD-2');
      });

      // The cancel cancel_tuneout makes, with the subconscious as its source
      // and a note: the note was written before the held messages could be
      // seen.
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'subconscious', 'subconscious judgment', 'Someone needs you here.').ok);
      await waitFor('the dump', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const dumpText = textOf(rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog')!);
      assert.ok(dumpText.includes('messages=2 truncated=2'), 'the dump counts both and shows none');
      assert.ok(!dumpText.includes('T5-HELD'), 'no raw line reaches the resident');
      const sub = internals.agents.get('Subconscious')!.getContextManager();
      const noticeOf = (): string | undefined =>
        sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
      await waitFor("the subconscious's report notice", () => noticeOf() !== undefined);
      assert.ok(noticeOf()!.includes('2 of its held messages came in after you last looked; your view has them now.'), noticeOf());
      assert.deepEqual(reportOf(internals)!.held, [], 'no held row follows it');
      // Its turn's end presents them.
      turns.delete('Subconscious');
      (framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(framework.getAgent('Subconscious'));
      const view = (await sub.compile()).messages.map(textOf).join('\n');
      assert.ok(view.includes('T5-HELD-1') && view.includes('T5-HELD-2'), "the subconscious's view holds both");
      const pending = (framework as unknown as { pendingRequests: Array<{ agentName: string }> }).pendingRequests;
      const reportTurns = pending.filter((r) => r.agentName === 'Subconscious').length
        + membrane.calls.filter((c) => JSON.stringify(c.messages).includes('[Tune-out cancelled:')).length;
      assert.ok(reportTurns >= 1, 'the subconscious is asked for its report turn');
    } finally {
      release();
      await close();
    }
  });

  // Rewritten with AF-5 (#291): the held messages are stored during the
  // turn, each a row of its own in the residents' slot, so the subconscious's
  // view holds each whole under its per-message cap. Until AF-5 they were
  // queued, and the cancel handed them to it as rows of their own.
  it("with a per-message cap that the held messages pass together but not one by one, the subconscious's view holds each of them whole", async () => {
    // The subconscious mirrors the primary's maxMessageTokens (80 here), and
    // cuts one message's text past it. Each held message is about 55 tokens,
    // four of them well past 80 together.
    const { framework, ctx, module, membrane, internals, emit, close } = await open(0, new CappedPassthroughStrategy());
    let release: () => void = () => {};
    try {
      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Waiting.' },
        { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as never);
      await within("the resident's tool", inTool);
      const filler = 'chatter while the turn is alive, '.repeat(6).trim();
      for (const n of [1, 2, 3, 4]) {
        emit(`t6${n}`, `T6-HELD-${n} ${filler}`);
        await waitFor(`held message ${n} stored`, () => !!rowWith(ctx.queryMessages({}).messages, `T6-HELD-${n}`));
      }

      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      await waitFor("the subconscious's report notice", () => reportOf(internals) !== undefined);
      assert.deepEqual(reportOf(internals)!.held, [], 'no held row follows the notice');
      const view = (await internals.agents.get('Subconscious')!.getContextManager().compile()).messages.map(textOf).join('\n');
      for (const n of [1, 2, 3, 4]) {
        assert.ok(view.includes(`T6-HELD-${n} ${filler}`), `the subconscious's view holds held message ${n} whole`);
      }
    } finally {
      release();
      await close();
    }
  });

});
