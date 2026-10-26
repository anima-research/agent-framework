/**
 * #291's reproduction: two residents of one slot whose turns overlap. With
 * the presentation index, which every framework has since AF-6, each
 * resident's window is the rows its own requests carried, in the order they
 * carried them, whatever the shared record's order: a row another writer
 * stored during a resident's turn enters its window at its tool boundary,
 * where its stream is given it, or at its turn's end, never inside the
 * turn. So each request a resident makes starts with the one before it (the
 * prompt cache's prefix), and its rounds' signed thinking is sent again
 * under the prefix it was minted under. Without the index, the record's
 * order is every resident's window, and the other resident's rounds land
 * inside each turn.
 *
 * mira (the primary, with a clock) and oren both answer an untargeted
 * event with a tool round that blocks until the test releases it. While
 * both wait, a row is stored for each; oren's round is released first and
 * oren finishes, then a row is stored for oren while mira still waits; then
 * mira's round is released, and a second untargeted event wakes both again.
 *
 * The persistent subconscious's variant (AF-8) runs the same turns with the
 * subconscious serving mira and a tune-out of a channel of mira's active.
 * Its window is over the residents' slot, through its observe edge: the
 * residents' rounds and the rows for either of them, and the tune-out's held
 * traffic, which no resident's window takes. Its own turn is alive, its
 * stream held, through both residents' whole turns, so every row they store
 * lands while it acts: none enters its window inside that turn but at its
 * tool boundary, where its stream is given it, or at its turn's end. Its
 * window starts where the tune-out's start was fixed, which stays put.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompileResult, ContextManager, MessageId, MessageMetadata, StoredMessage, WindowedPassthroughStrategy } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework, audienceOf } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { GateModule, until } from './helpers/dendrite.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { WireMembrane, final, round, signed, wireOf, type WireStream } from './helpers/wire-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const SUB = 'Subconscious';
const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
const usage = { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 };

/** A round of the subconscious's own tool (`think`, a framework tool with no module prefix): `content`, then the call. */
const subRound = (id: string, content: ContentBlock[], input: object): NormalizedResponse =>
  Object.assign(createMockResponse([...content, { type: 'tool_use', id, name: 'think', input } as ContentBlock], 'tool_use'), { usage });

/** A surface's module: it keeps its context, for writes of its own. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

let seq = 0;
/** An untargeted push event that asks for inference: every resident takes it. */
function pushEvent(t: string) {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes',
    eventId: `two-${n}`, content: [text(t)], timestamp: new Date().toISOString(),
    inferenceId: `inf-two-${n}`, triggerInference: true,
  };
}

/**
 * A message's blocks as a request and a window both say them: text,
 * thinking by its signature, a call and a result by their call's id. A
 * result handed to a stream (membrane's ToolResult, with no `type`) reads
 * as a stored one. Empty text, which no request carries, is left out.
 */
function tokensOf(content: readonly unknown[]): string[] {
  return content.flatMap((block) => {
    const b = block as { type?: string; text?: string; signature?: string; id?: string; toolUseId?: string };
    if (b.type === undefined && typeof b.toolUseId === 'string') return [`result:${b.toolUseId}`];
    switch (b.type) {
      case 'text': return b.text!.trim() === '' ? [] : [`text:${b.text}`];
      case 'thinking': return [`thinking:${b.signature}`];
      case 'tool_use': return [`call:${b.id}`];
      case 'tool_result': return [`result:${b.toolUseId}`];
      default: return [String(b.type)];
    }
  });
}

/**
 * Messages as one sequence of tokens, each run of a participant's opened by
 * its name: so two adjacent rows of one participant read the same whether a
 * request carries them as one message or two. A message with no participant
 * (a stream's results) is the user's.
 */
function said(messages: ReadonlyArray<{ participant?: string; content: readonly unknown[] }>): string[] {
  const out: string[] = [];
  let speaker: string | undefined;
  for (const m of messages) {
    const tokens = tokensOf(m.content);
    if (tokens.length === 0) continue;
    const who = m.participant ?? 'user';
    if (who !== speaker) out.push(`@${who}`);
    speaker = who;
    out.push(...tokens);
  }
  return out;
}

const rowText = (row: { content: ContentBlock[] }) => row.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');

type Internals = {
  handleMcplPushEvent(event: unknown): void;
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
  tuneOutCoordinator: TuneOutCoordinator;
  subconsciousStrategy: WindowedPassthroughStrategy | null;
  channelRegistry: { listChannelsRaw(): unknown[]; readCoordinatorState(id: string): unknown; writeCoordinatorState(id: string, value: unknown): void };
};

/** What the subconscious's variant records of its own run. */
interface SubconsciousRun {
  epochId: string;
  /** A row for mira stored at rest before the tune-out began: in the subconscious's window, before its start. */
  before: MessageId;
  /** Its window's start, as fixed at the tune-out's enter. */
  anchor: number;
  /** Its window's start at each of its requests, and at the run's end. */
  anchors: Array<number | undefined>;
  /** The window starts kept for the tune-outs, at the run's end. */
  windowStarts: Record<string, number> | undefined;
  /** The residents' rows it was out of its window for, read as its held stream was let go, by text. */
  outAtRelease: Map<string, boolean>;
  /** Each request's window: its ids in order. */
  windows: MessageId[][];
}

/**
 * The run: boot, the overlapping turns, and the second event. With
 * `subconscious`, the persistent subconscious serves mira; a row is stored
 * for mira, then a tune-out of mira's channel is entered with everything at
 * rest; the subconscious's turn, its stream held, is alive from before the
 * first event until both residents' turns are over; a row the tune-out
 * holds is stored while the residents wait on their tools; and the
 * subconscious takes a second turn at the end.
 */
async function overlappingTurns(dir: string, own: (framework: AgentFramework) => void, options: { subconscious?: boolean } = {}) {
  const membrane = new WireMembrane();
  const gates = new GateModule();
  const surface = new SurfaceModule();
  for (const [name, gate] of [['mira', 'm'], ['oren', 'o']] as const) {
    membrane.script(name,
      round(`call-${gate}`, [signed(`sig-${name}-1`), text(`${name} looks`)], 'wait', { gate }),
      final([signed(`sig-${name}-2`), text(`${name} done`)]));
    membrane.script(name, final([signed(`sig-${name}-3`), text(`${name} again`)]));
  }
  if (options.subconscious) writeFileSync(join(dir, 'commands.txt'), '');
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: ['mira', 'oren'].map((name, i) => ({
      name,
      model: 'claude-opus-5-5',
      systemPrompt: `You are ${name}.`,
      allowedTools: 'all',
      proseRouting: 'disabled',
      thinkingBinding: { binds: true },
      // The primary keeps a clock, so its own clock rows are in the slot
      // too: one a day, so the window takes one at its first event only.
      ...(i === 0 ? { clock: { intervalMinutes: 1440 } } : {}),
    })),
    ...(options.subconscious ? {
      // It takes mira's inference settings, thinking binding included.
      subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for mira.' },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: join(dir, 'commands.txt') } }],
    } : {}),
    modules: [gates, surface],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  own(framework);
  const internals = framework as unknown as Internals;
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  const cmOf = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();
  const names = options.subconscious ? ['mira', 'oren', SUB] : ['mira', 'oren'];
  const modesAtBoot = names.map((name) => cmOf(name).windowMode());

  // Each request: the ordinal of every row its agent's window held, and its index length.
  const snapshots: Array<{ agent: string; ordinals: Map<MessageId, number>; length: number }> = [];
  const windows: MessageId[][] = [];
  const anchors: Array<number | undefined> = [];
  membrane.onRequest = (agent) => {
    const cm = cmOf(agent);
    snapshots.push({ agent, ordinals: new Map(cm.getPresentedMessages().map((m) => [m.id, cm.ordinalOf(m.id)!])), length: cm.indexLength() });
    if (agent === SUB) {
      windows.push(cm.getPresentedMessages().map((m) => m.id));
      anchors.push(internals.subconsciousStrategy!.getAnchorOrdinal());
    }
  };
  // Each committing compile's thinking strip, which a binding context reports where it took thinking out.
  const strips: Array<{ agent: string; strip: unknown }> = [];
  for (const name of names) {
    const cm = cmOf(name);
    const compile = cm.compile.bind(cm);
    cm.compile = (async (...args: Parameters<typeof compile>) => {
      const result: CompileResult = await compile(...args);
      if ((args[2] as { dryRun?: boolean } | undefined)?.dryRun !== true) strips.push({ agent: name, strip: result.thinkingStrip });
      return result;
    }) as typeof compile;
  }
  await framework.start();
  const handlePush = (event: unknown) => internals.handleMcplPushEvent(event);
  const stored = (name: string, t: string) => cmOf(name).getAllMessages().some((m) => rowText(m) === t);
  // With a channel registry up (the variant's tune-out server), each
  // resident's turn end writes a [delivered] receipt, its own row: waited
  // for, so what is stored after it comes after it.
  const receipts = (name: string) => cmOf(name).getAllMessages()
    .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'delivery-receipt' && audienceOf(m.metadata)?.ownRowOf === name).length;
  const turnsEnded = async (count: number) => {
    if (options.subconscious) await until(() => receipts('mira') === count && receipts('oren') === count, `the residents' receipts (${count})`);
  };
  const ask = (agentName: string) => internals.pendingRequests.push({ agentName, reason: 'test', source: 'test', timestamp: Date.now() });

  let sub: SubconsciousRun | undefined;
  let letGo: () => void = () => {};
  try {
    let epochId = '';
    if (options.subconscious) {
      await until(() => internals.channelRegistry.listChannelsRaw().length > 0, 'the channel registered', 30_000);
      // A row from before the tune-out, at rest: in mira's window and the
      // subconscious's at once. A tune-out starts at the store's head, and a
      // row at that sequence is inside its window, so a record that isn't a
      // row is written before the enter.
      const before = internals.addMessage('user', [text('before the tune-out')], undefined, { forAgent: 'mira' });
      internals.channelRegistry.writeCoordinatorState('test/bump', { at: Date.now() });
      const entered = internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
      assert.ok(entered.ok, (entered as { error?: string }).error);
      epochId = entered.params.epochId;
      const anchor = internals.subconsciousStrategy!.getAnchorOrdinal();
      assert.notEqual(anchor, undefined, "the premise: with everything at rest, the subconscious's window start was fixed at the enter");
      sub = { epochId, before, anchor: anchor!, anchors, windowStarts: undefined, outAtRelease: new Map(), windows };
      // Its turn: a round of its own tool, then its reply; its stream held
      // until both residents' turns are over. Its replies set their words
      // aside (its prose routing is explicit), so nothing answers them and
      // no turn of its follows but the two the test asks for.
      membrane.script(SUB, subRound('n1', [signed('sig-sub-1')], { content: 'reading' }), final([signed('sig-sub-2'), text('>>skip_reply sub done')]));
      membrane.script(SUB, final([signed('sig-sub-3'), text('>>skip_reply sub again')]));
      membrane.hold(SUB, new Promise<void>((resolve) => { letGo = resolve; }));
      ask(SUB);
      await until(() => membrane.callsFor(SUB).length === 1, "the subconscious's request, its turn alive", 30_000);
    }

    handlePush(pushEvent('hello both'));
    await until(() => gates.entered.has('m') && gates.entered.has('o'), 'both rounds waiting on their tools');
    surface.ctx.addMessage('user', [text('for mira')], {}, { forAgent: 'mira' });
    surface.ctx.addMessage('user', [text('for oren')], {}, { forAgent: 'oren' });
    if (options.subconscious) {
      // Traffic the tune-out holds: for the subconscious, never a resident.
      internals.addMessage('antra', [text('HELD chatter')], { tuneOut: { epochId }, channelId: CHANNEL, serverId: 'disc' } as MessageMetadata, { forAgent: 'mira' });
    }
    gates.release('o');
    await until(() => stored('oren', 'oren done'), "oren's turn");
    if (options.subconscious) await until(() => receipts('oren') === 1, "oren's turn's receipt");
    // oren is idle now, mira still waits on her tool.
    surface.ctx.addMessage('user', [text('oren, idle')], {}, { forAgent: 'oren' });
    gates.release('m');
    await until(() => stored('mira', 'mira done'), "mira's turn");
    if (options.subconscious) {
      // Both residents' turns lay inside the subconscious's: let its stream go on.
      await turnsEnded(1);
      await until(() => ['mira', 'oren'].every((name) => framework.getAgent(name)!.state.status === 'idle'), 'both residents at rest');
      const subCm = cmOf(SUB);
      for (const row of cmOf('mira').getAllMessages()) {
        if (subCm.windowStatusOf(row.id) !== 'absent') sub!.outAtRelease.set(rowText(row) || row.content.map((b) => b.type).join('+'), subCm.ordinalOf(row.id) === undefined);
      }
      letGo();
      await until(() => stored(SUB, '>>skip_reply sub done'), "the subconscious's turn");
    }
    await framework.runUntilIdle();
    handlePush(pushEvent('round two'));
    await until(() => stored('mira', 'mira again') && stored('oren', 'oren again'), 'both second turns');
    await framework.runUntilIdle();
    if (options.subconscious) {
      await turnsEnded(2);
      ask(SUB);
      await until(() => stored(SUB, '>>skip_reply sub again'), "the subconscious's second turn");
      await framework.runUntilIdle();
      sub!.anchors.push(internals.subconsciousStrategy!.getAnchorOrdinal());
      sub!.windowStarts = (internals.channelRegistry.readCoordinatorState('subconscious/mira/window-starts') as { starts: Record<string, number> } | null)?.starts;
    }
  } finally {
    letGo();
  }
  return { framework, membrane, cmOf, modesAtBoot, snapshots, strips, traces, sub, receipts: !!options.subconscious };
}

type Run = Awaited<ReturnType<typeof overlappingTurns>>;

/** The receipt a turn end writes on a host with a channel registry, for `count` segments of a disabled agent's prose. */
const receipt = (count: number) =>
  `text:[delivered] plain speech → no channel — ${count} plain-speech segment(s) kept in the transcript (proseRouting=disabled — post to a channel only with an explicit send tool)`;

/**
 * Assertions A to G, over the residents. With `receipts` (a host with a
 * channel registry), each turn's end adds the resident's own receipt after
 * its last reply, which the next request carries.
 */
function assertResidents(r: Run): void {
  const { membrane, cmOf, modesAtBoot, snapshots, strips } = r;
  const names = ['mira', 'oren'] as const;
  const record = cmOf('mira').getAllMessages();
  const at = (t: string) => record.findIndex((m) => rowText(m) === t);
  const streamsOf = (name: string): WireStream[] => membrane.streams.filter((s) => s.agent === name);

  // G. Not vacuous: both windows were presented from boot, and each resident ran two streams.
  assert.deepEqual(modesAtBoot.slice(0, 2), ['presented', 'presented'], 'both windows are presented from their registration');
  for (const name of names) assert.equal(streamsOf(name).length, 2, `${name} ran two streams`);

  // A. The control, which holds without the index too: the turns overlapped.
  // oren's round, its results and his reply are stored after 'hello both'
  // and before mira's round, and mira's first request carried none of them.
  const orenRound = record.findIndex((m) => m.content.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 'call-o'));
  const orenResults = record.findIndex((m) => m.content.some((b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'call-o'));
  const miraRound = record.findIndex((m) => m.content.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 'call-m'));
  assert.ok(at('hello both') < orenRound && orenRound < orenResults && orenResults < at('oren done') && at('oren done') < miraRound,
    "in the record, oren's whole turn lies inside mira's");
  const miraFirst = said(streamsOf('mira')[0]!.request.messages);
  assert.ok(!miraFirst.includes('call:call-o') && !miraFirst.includes('text:oren done'), "mira's first request carried none of oren's turn");

  for (const name of names) {
    const cm = cmOf(name);
    const window = cm.getPresentedMessages();
    const [first, second] = streamsOf(name) as [WireStream, WireStream];

    // B. Window = wire: the window, from its start, is what each stream
    // carried, in order: its first request, then its rounds, the results
    // and the rows heard with them, and its last reply.
    const windowSaid = said(window);
    const firstWire = said(wireOf(first));
    assert.deepEqual(windowSaid.slice(0, firstWire.length), firstWire, `${name}'s window begins with what its first stream carried`);
    assert.deepEqual(windowSaid, [...said(wireOf(second)), ...(r.receipts ? ['@user', receipt(1)] : [])],
      `${name}'s window is what its second stream carried${r.receipts ? ", then that turn's receipt" : ''}`);

    // C. The cache prefix: the second request starts with the first, then
    // the first stream's rounds, the row heard at its boundary and its
    // reply, then the rows presented at the second start.
    const firstMessages = first.request.messages;
    assert.deepStrictEqual(second.request.messages.slice(0, firstMessages.length), firstMessages, `${name}'s second request starts with its first`);
    const other = name === 'mira' ? 'oren' : 'mira';
    const heard = name === 'mira' ? ['text:for mira'] : ['text:for oren'];
    const atSecondStart = name === 'mira' ? ['text:round two'] : ['text:oren, idle', 'text:round two'];
    const after = said(second.request.messages.slice(firstMessages.length));
    assert.deepEqual(after, [
      `@${name}`, `thinking:sig-${name}-1`, `text:${name} looks`, `call:call-${name[0]}`,
      '@user', `result:call-${name[0]}`, ...heard,
      `@${name}`, `thinking:sig-${name}-2`, `text:${name} done`,
      '@user', ...(r.receipts ? [receipt(2)] : []), ...atSecondStart,
    ], `${name}'s second request goes on from its first in the order its window took the rows`);
    const injected = first.stream.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
    assert.deepEqual(said(injected), ['@user', ...heard], `${name} heard its row at its tool boundary`);

    // D. Signed thinking kept: the second request carries both of the
    // first stream's signatures and none of the other resident's, and no
    // committing compile took thinking out.
    const signatures = tokensOf(second.request.messages.flatMap((m) => m.content)).filter((t) => t.startsWith('thinking:'));
    assert.deepEqual(signatures, [`thinking:sig-${name}-1`, `thinking:sig-${name}-2`], `${name}'s rounds' thinking is sent again`);
    assert.ok(membrane.callsFor(name).every((c) => !JSON.stringify(c.messages).includes(`sig-${other}-`)), `no request of ${name}'s carries ${other}'s thinking`);

    // E. Decision 1: another resident's own rows, and rows for it, never
    // enter the window; rows for both enter both.
    assert.deepEqual(window.filter((m) => audienceOf(m.metadata)?.ownRowOf === other), [], `${name}'s window holds none of ${other}'s own rows`);
    for (const t of name === 'mira' ? ['for oren', 'oren, idle'] : ['for mira']) {
      assert.equal(cm.ordinalOf(record[at(t)]!.id), undefined, `'${t}' is not in ${name}'s window`);
    }
    for (const t of ['hello both', 'round two']) assert.notEqual(cm.ordinalOf(record[at(t)]!.id), undefined, `'${t}' is in ${name}'s window`);
    if (at('HELD chatter') !== -1) assert.equal(cm.ordinalOf(record[at('HELD chatter')]!.id), undefined, `what the tune-out holds is not in ${name}'s window`);
  }
  assert.deepEqual(audienceOf(record[at('for mira')]!.metadata)?.audience, ['mira'], "'for mira' is stamped for mira");
  const residentsStrips = strips.filter((s) => s.agent !== SUB);
  assert.deepEqual(residentsStrips.filter((s) => s.strip !== undefined), [], 'no committing compile of either resident took thinking out');
  assert.ok(residentsStrips.length >= 4, 'every start compiled');

  // F. Windows grow only at their end: what a request's window held keeps
  // its place, and every row presented after the request is past it.
  for (const { agent, ordinals, length } of snapshots) {
    const cm = cmOf(agent);
    for (const [id, ordinal] of ordinals) assert.equal(cm.ordinalOf(id), ordinal, `${agent}'s row keeps its place`);
    for (const row of cm.getPresentedMessages() as StoredMessage[]) {
      if (!ordinals.has(row.id)) assert.ok(cm.ordinalOf(row.id)! >= length, `${agent}'s later row is past the window its request read`);
    }
  }
  assert.ok(snapshots.length >= 4);
  void ({} as NormalizedRequest);
}

describe("two residents' overlapping turns, each in a window of its own (#291)", () => {
  let dir: string;
  let framework: AgentFramework | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'af-two-residents-')); framework = undefined; });
  afterEach(async () => {
    try { await framework?.stop(); } catch { /* stopped */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('every request of each resident is its window, its second starts with its first, and its thinking is kept', async () => {
    const r = await overlappingTurns(dir, (f) => { framework = f; });
    assertResidents(r);
  });

  it("with the persistent subconscious: its window over the residents' slot takes no row inside its live turn, keeps its turn's thinking, and its start stays put", { timeout: 120_000 }, async () => {
    const r = await overlappingTurns(dir, (f) => { framework = f; }, { subconscious: true });
    // The residents' windows are as they are without it (with the receipts
    // its channel's server has their turn ends write).
    assertResidents(r);
    const sub = r.sub!;
    const cm = r.cmOf(SUB);
    const record = r.cmOf('mira').getAllMessages();
    const rowWith = (t: string) => record.find((m) => rowText(m) === t)!;
    const streams = r.membrane.streams.filter((s) => s.agent === SUB);
    const [first, second] = streams as [WireStream, WireStream];
    const subRows = cm.getAllMessages();
    const own = (pred: (b: { type: string; id?: string; toolUseId?: string; signature?: string }) => boolean) =>
      subRows.find((m) => (m.content as Array<{ type: string }>).some(pred))!;
    const roundRow = own((b) => b.type === 'tool_use' && b.id === 'n1');
    const resultsRow = own((b) => b.type === 'tool_result' && b.toolUseId === 'n1');
    const replyRow = own((b) => b.type === 'thinking' && b.signature === 'sig-sub-2');

    // Not vacuous: its window is presented from boot, it ran exactly its two
    // streams, and the residents' turns were stored while its turn was alive,
    // out of its window.
    assert.equal(r.modesAtBoot[2], 'presented', "the subconscious's window is presented from its registration");
    assert.equal(streams.length, 2, 'it ran its two streams, and no other');
    for (const t of ['hello both', 'mira looks', 'oren looks', 'for mira', 'for oren', 'HELD chatter', 'oren done', 'oren, idle', 'mira done']) {
      assert.equal(sub.outAtRelease.get(t), true, `'${t}' was stored during its turn, out of its window`);
    }

    // No row lands inside its live turn: past what its request read, its
    // window holds its round, its results, the rows its stream was given at
    // its boundary, and its reply, and only then what else was stored
    // meanwhile.
    const window = cm.getPresentedMessages();
    const firstWindow = sub.windows[0]!;
    assert.deepEqual(window.slice(0, firstWindow.length).map((m) => m.id), firstWindow, 'its window keeps what its first request read');
    const injected = first.stream.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
    const replyAt = window.findIndex((m) => m.id === replyRow.id);
    const label = (m: StoredMessage) => (m.id === roundRow.id ? 'round' : m.id === resultsRow.id ? 'results' : m.id === replyRow.id ? 'reply' : `heard:${rowText(m)}`);
    assert.deepEqual(window.slice(firstWindow.length, replyAt + 1).map(label),
      ['round', 'results', ...injected.map((m) => `heard:${rowText(m as never)}`), 'reply'],
      'its turn, and only what its stream was given');
    for (const t of ['mira looks', 'oren looks', 'for mira', 'for oren', 'HELD chatter', 'oren done', 'oren, idle', 'mira done']) {
      const at = window.findIndex((m) => m.id === rowWith(t).id);
      assert.ok(at > replyAt || injected.some((m) => rowText(m as never) === t), `'${t}' entered at its boundary or after its turn`);
    }

    // Its window is over the residents' slot: its second request carries
    // their turns, the rows for each of them and the held row, the
    // residents' rounds as a transcript and none of their thinking.
    const body = second.request.messages.map((m) => rowText(m as never)).join('\n');
    for (const t of ['hello both', 'mira looks', 'oren looks', 'for mira', 'for oren', 'HELD chatter', 'oren, idle', 'mira done', 'oren done', 'round two', 'mira again', 'oren again']) {
      assert.ok(body.includes(t), `its second request carries '${t}'`);
    }
    assert.ok(body.includes('[test--wait called: {"gate":"m"}]') && body.includes('[test--wait called: {"gate":"o"}]'), "the residents' rounds as a transcript");
    for (const call of r.membrane.callsFor(SUB)) {
      assert.ok(!/sig-(mira|oren)-/.test(JSON.stringify(call.messages)), "no request of the subconscious's carries a resident's thinking");
    }
    for (const name of ['mira', 'oren']) {
      assert.ok(r.membrane.callsFor(name).every((c) => !JSON.stringify(c.messages).includes('sig-sub-')), `no request of ${name}'s carries the subconscious's thinking`);
    }

    // Its thinking is kept: its second request starts with its first and
    // carries its turn's signed thinking, and no committing compile of its
    // took thinking out.
    const plain = (req: NormalizedRequest) => req.messages.map(({ participant, content }) => ({ participant, content }));
    assert.deepStrictEqual(plain(second.request).slice(0, first.request.messages.length), plain(first.request), 'its second request starts with its first');
    const signatures = tokensOf(second.request.messages.flatMap((m) => m.content)).filter((t) => t.startsWith('thinking:'));
    assert.deepEqual(signatures, ['thinking:sig-sub-1', 'thinking:sig-sub-2'], "its turn's thinking is sent again");
    const subStrips = r.strips.filter((s) => s.agent === SUB);
    assert.ok(subStrips.length >= 2, 'its starts compiled');
    assert.deepEqual(subStrips.filter((s) => s.strip !== undefined), [], 'no committing compile of its took thinking out');
    assert.deepEqual(r.traces.filter((e) => e.type === 'presentation:hand-off-mismatch'), [], 'every boundary handed its stream the rows its window took');

    // Its window's start stays put: fixed once, at the tune-out's enter, and
    // the same at each of its requests and at the end.
    assert.equal(sub.anchor, cm.ordinalOf(sub.before)! + 1, 'the premise: its window starts just past the row stored before the tune-out');
    assert.deepEqual(sub.anchors, [sub.anchor, sub.anchor, sub.anchor], 'the same start throughout');
    assert.ok(r.membrane.callsFor(SUB).every((c) => !JSON.stringify(c.messages).includes('before the tune-out')), 'so no request of its carries that row');
    assert.ok(r.membrane.callsFor('mira').every((c) => JSON.stringify(c.messages).includes('before the tune-out')), "though every one of mira's does");
    assert.deepEqual(sub.windowStarts, { [sub.epochId]: sub.anchor }, 'and kept for the tune-out');
    assert.deepEqual(r.traces.filter((e) => e.type === 'tune-out:subconscious-window')
      .map((e) => { const { how, ordinal, epochIds } = e as Extract<TraceEvent, { type: 'tune-out:subconscious-window' }>; return { how, ordinal, epochIds }; }),
    [{ how: 'fixed', ordinal: sub.anchor, epochIds: [sub.epochId] }], 'fixed at the enter, and never again');
    assert.ok(cm.ordinalOf(rowWith('hello both').id)! >= sub.anchor, "the run's rows are inside its window");
  });
});
