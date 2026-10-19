/**
 * A message a tune-out holds from the residents stays out of what they're
 * shown, and a module's reads mark it (ModuleMessage.heldFromResidents). Such
 * a message is stored with `metadata.tuneOut` and no resident's compiled view
 * shows it. A module's context answered it as an ordinary row, so a module
 * that keeps to what the residents see by leaving out `held` rows still took
 * it in; a tool boundary of a turn alive when it arrived injected it into
 * that turn; and a cancel's backlog left it out while it was still held. The
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
  deferredMessages: Array<{ seq: number; content: ContentBlock[] }>;
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
      assert.equal(heldRow.held, undefined, 'a stored row, not a held write');
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

  it("keeps a tuned-out message that arrives during a turn out of that turn, and marks it as well as held, and its stored row once it lands", async () => {
    const { framework, ctx, module, membrane, emit, close } = await open();
    let release: () => void = () => {};
    try {
      emit('t2a', 'T2-STORED chatter before the turn');
      await waitFor('the first message stored', () => !!rowWith(ctx.queryMessages({}).messages, 'T2-STORED'));

      // A turn of the resident's, alive with its round's tool pending, so the
      // framework holds what arrives meanwhile, while the run loop goes on
      // taking channel traffic. (A quiesce pauses the MCPL data plane, so
      // nothing arrives while it lasts.)
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
      await waitFor('the held write', () => rowWith(ctx.queryMessages({}).messages, 'T2-HELD')?.held === true);
      // Queued behind the tuned-out write, so the boundary has to go on past
      // it to inject this one.
      const plainHandle = ctx.addMessage('user', [{ type: 'text', text: 'T2-PLAIN a module write while the turn is alive' }]);

      // With held writes among them, queryMessages answers the stored rows
      // and then the held ones.
      const rows = ctx.queryMessages({}).messages;
      const heldWrite = rowWith(rows, 'T2-HELD')!;
      assert.ok(heldWrite.metadata?.tuneOut, 'the held write carries the stamp');
      assert.equal(heldWrite.held, true);
      assert.equal(heldWrite.heldFromResidents, true, 'a held write with the stamp is marked');
      assert.equal(rowWith(rows, 'T2-STORED')?.heldFromResidents, true, 'a stored held message beside it is marked');
      assert.equal(ctx.getMessage(heldWrite.id)?.heldFromResidents, true, 'getMessage marks the held write by its handle');
      const plain = rowWith(rows, 'T2-PLAIN')!;
      assert.equal(plain.held, true, "the module's own write is held too");
      assert.equal('heldFromResidents' in plain, false, 'a held write without the stamp has no mark');
      assert.equal('heldFromResidents' in ctx.getMessage(plainHandle)!, false, 'nor by its handle');

      // At the tool boundary both writes are stored. The module's is handed
      // to the live turn; the tuned-out one isn't, as its compiled view
      // leaves it out.
      release();
      await waitFor('the write landed', () => {
        const row = rowWith(ctx.queryMessages({}).messages, 'T2-HELD');
        return !!row && row.held === undefined;
      });
      await waitFor('the tool results handed to the stream', () => stream.receivedToolResultOptions.length > 0);
      const injected = stream.receivedToolResultOptions.flatMap((options) =>
        (options?.injectedMessages ?? []).map((message) => JSON.stringify(message.content)));
      assert.ok(injected.some((t) => t.includes('T2-PLAIN')), "the module's write reaches the live turn");
      assert.ok(!injected.some((t) => t.includes('T2-HELD')), "the tuned-out message doesn't");

      const landed = ctx.getMessage(heldWrite.id);
      assert.ok(landed, 'the handle names the stored row');
      assert.equal(landed.held, undefined);
      assert.equal(landed.heldFromResidents, true, 'the stored row the handle names is marked');
      assert.equal(ctx.getMessage(landed.id)?.heldFromResidents, true, 'and so is it by its stored id');
      assert.equal(rowWith(ctx.queryMessages({}).messages, 'T2-HELD')?.heldFromResidents, true, 'and in queryMessages');
    } finally {
      release();
      await close();
    }
  });

  it("brings tuned-out messages still held at the cancel to the residents once, in the cancel's dump, when the cap shows them all", async () => {
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
      await waitFor('the first held write', () => rowWith(ctx.queryMessages({}).messages, 'T3-HELD-1')?.held === true);
      emit('t3d', 'T3-HELD-2 more chatter while the turn is alive');
      await waitFor('the second held write', () => rowWith(ctx.queryMessages({}).messages, 'T3-HELD-2')?.held === true);
      const heldHandle = rowWith(ctx.queryMessages({}).messages, 'T3-HELD-1')!.id;
      ctx.addMessage('user', [{ type: 'text', text: 'T3-PLAIN a module write while the turn is alive' }]);

      // The tune-out ends while the messages are still held, as it does when
      // the resident cancels it in this turn. The backlog is the epoch's
      // stored messages and then its held ones, and the cap of 3 keeps its
      // last three: every held one, so the report is told of none.
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      await waitFor('the dump', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const dumpText = textOf(rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog')!);
      assert.ok(dumpText.includes('messages=4 truncated=1'), "the backlog is the epoch's four messages, and the cap cuts one");
      assert.ok(dumpText.includes('T3-STORED-2'), 'the dump carries the newer stored message');
      assert.ok(dumpText.includes('T3-HELD-1') && dumpText.includes('T3-HELD-2'), 'and both still held');
      assert.ok(!dumpText.includes('T3-STORED-1'), 'the cap cuts the oldest');
      assert.ok(!dumpText.includes('T3-PLAIN'), 'a held write without the stamp stays out');
      const sub = internals.agents.get('Subconscious')!.getContextManager();
      const noticeOf = (): string | undefined =>
        sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
      await waitFor("the subconscious's report notice", () => noticeOf() !== undefined);
      assert.ok(!noticeOf()!.includes('Still held'), 'the notice carries no held message, as the dump shows them all');
      assert.deepEqual(reportOf(internals)!.held, [], 'and no held row follows it');
      assert.ok(noticeOf()!.includes('1 of 4 diverted messages were above the cap and not delivered raw to the resident'), 'it gives the count above the cap');

      // The boundary then stores the held messages without injecting them, so
      // the dump is the one row that shows them to the resident.
      release();
      await waitFor('the held write landed', () => {
        const row = ctx.getMessage(heldHandle);
        return !!row && row.held === undefined;
      });
      const landed = ctx.getMessage(heldHandle)!;
      assert.ok(textOf(landed).includes('T3-HELD-1') && !textOf(landed).includes('<tuned-out-backlog'), 'the handle names the original, stored');
      assert.equal(landed.heldFromResidents, true, 'and marked');
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

  it("hands the subconscious's cancel report the older held message, which the cap leaves out of the dump, after the queue was put out of seq order", async () => {
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
      await waitFor('the first held write', () => rowWith(ctx.queryMessages({}).messages, 'T4-HELD-1')?.held === true);
      emit('t4b', 'T4-HELD-2 more chatter while the turn is alive');
      await waitFor('the second held write', () => rowWith(ctx.queryMessages({}).messages, 'T4-HELD-2')?.held === true);

      // A store write refused at a boundary goes back to the end of the
      // queue, behind newer writes (requeueDrained). Put the queue in that
      // order: the backlog still takes the held messages oldest first.
      const ours = internals.deferredMessages.filter((m) => textOf(m).includes('T4-HELD'));
      assert.equal(ours.length, 2, 'premise: both are in the queue');
      assert.ok(textOf(ours[0]).includes('T4-HELD-1') && ours[0].seq < ours[1].seq, 'premise: the queue is in seq order');
      internals.deferredMessages.reverse();

      // The cap of 1 shows the newest raw. The subconscious's view holds
      // stored rows only, so its report notice carries the held one the dump
      // leaves out.
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      await waitFor('the dump', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const dumpText = textOf(rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog')!);
      assert.ok(dumpText.includes('T4-HELD-2'), 'the dump shows the newest');
      assert.ok(!dumpText.includes('T4-HELD-1'), 'and not the older one');
      const sub = internals.agents.get('Subconscious')!.getContextManager();
      const noticeOf = (): string | undefined =>
        sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
      await waitFor("the subconscious's report notice", () => noticeOf() !== undefined);
      await waitFor('the held row after it', () => (reportOf(internals)?.held.length ?? 0) > 0);
      const report = reportOf(internals)!;
      assert.ok(report.notice.includes('the 1 message after this one'), 'the notice counts the held row that follows it');
      assert.equal(report.held.length, 1);
      assert.ok(report.held[0]!.includes('T4-HELD-1'), 'the notice carries the held message the dump leaves out, as a row of its own');
      assert.ok(!report.held[0]!.includes('T4-HELD-2'), 'and not the one the dump shows');
    } finally {
      release();
      await close();
    }
  });

  it("with backlogCap 0, a cancel in the subconscious's name hands its report every held message, oldest first, and the dump none", async () => {
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
      emit('t5a', 'T5-HELD-1 chatter while the turn is alive');
      await waitFor('the first held write', () => rowWith(ctx.queryMessages({}).messages, 'T5-HELD-1')?.held === true);
      emit('t5b', 'T5-HELD-2 more chatter while the turn is alive');
      await waitFor('the second held write', () => rowWith(ctx.queryMessages({}).messages, 'T5-HELD-2')?.held === true);

      // The cancel cancel_tuneout makes, with the subconscious as its source
      // and a note, though called here while only the resident's turn runs:
      // the note was written before the held messages could be seen, so the
      // notice and a report turn bring them.
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'subconscious', 'subconscious judgment', 'Someone needs you here.').ok);
      await waitFor('the dump', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const dumpText = textOf(rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog')!);
      assert.ok(dumpText.includes('messages=2 truncated=2'), 'the dump counts both and shows none');
      assert.ok(!dumpText.includes('T5-HELD'), 'no raw line reaches the resident');
      const sub = internals.agents.get('Subconscious')!.getContextManager();
      const noticeOf = (): string | undefined =>
        sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
      await waitFor("the subconscious's report notice", () => noticeOf() !== undefined);
      await waitFor('the held rows after it', () => (reportOf(internals)?.held.length ?? 0) === 2);
      const { held } = reportOf(internals)!;
      assert.ok(held[0]!.includes('T5-HELD-1') && held[1]!.includes('T5-HELD-2'), 'the notice carries both held messages, oldest first, a row each');
    } finally {
      release();
      await close();
    }
  });

  it("with a per-message cap that the held messages pass together but not one by one, hands each of them to the subconscious whole", async () => {
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
        await waitFor(`held write ${n}`, () => rowWith(ctx.queryMessages({}).messages, `T6-HELD-${n}`)?.held === true);
      }

      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      // The notice and whatever follows it are added in the one cancel call.
      await waitFor("the subconscious's report notice", () => reportOf(internals) !== undefined);
      // The originals are still held, so the report is the only place the
      // subconscious's view has their text.
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
