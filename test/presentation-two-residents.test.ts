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
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompileResult, ContextManager, MessageId, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework, audienceOf } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { GateModule, until } from './helpers/dendrite.js';
import { WireMembrane, final, round, signed, wireOf, type WireStream } from './helpers/wire-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;

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

describe("two residents' overlapping turns, each in a window of its own (#291)", () => {
  let dir: string;
  let framework: AgentFramework;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'af-two-residents-')); });
  afterEach(async () => {
    try { await framework?.stop(); } catch { /* stopped */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('every request of each resident is its window, its second starts with its first, and its thinking is kept', async () => {
    const membrane = new WireMembrane();
    const gates = new GateModule();
    const surface = new SurfaceModule();
    for (const [name, gate] of [['mira', 'm'], ['oren', 'o']] as const) {
      membrane.script(name,
        round(`call-${gate}`, [signed(`sig-${name}-1`), text(`${name} looks`)], 'wait', { gate }),
        final([signed(`sig-${name}-2`), text(`${name} done`)]));
      membrane.script(name, final([signed(`sig-${name}-3`), text(`${name} again`)]));
    }
    framework = await AgentFramework.create({
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
      modules: [gates, surface],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    const cmOf = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();
    const names = ['mira', 'oren'] as const;
    const modesAtBoot = names.map((name) => cmOf(name).windowMode());

    // Each request: the ordinal of every row its agent's window held, and its index length.
    const snapshots: Array<{ agent: string; ordinals: Map<MessageId, number>; length: number }> = [];
    membrane.onRequest = (agent) => {
      const cm = cmOf(agent);
      snapshots.push({ agent, ordinals: new Map(cm.getPresentedMessages().map((m) => [m.id, cm.ordinalOf(m.id)!])), length: cm.indexLength() });
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
    framework.start();
    const handlePush = (event: unknown) =>
      (framework as unknown as { handleMcplPushEvent(event: unknown): void }).handleMcplPushEvent(event);
    const stored = (name: string, t: string) => cmOf(name).getAllMessages().some((m) => rowText(m) === t);

    handlePush(pushEvent('hello both'));
    await until(() => gates.entered.has('m') && gates.entered.has('o'), 'both rounds waiting on their tools');
    surface.ctx.addMessage('user', [text('for mira')], {}, { forAgent: 'mira' });
    surface.ctx.addMessage('user', [text('for oren')], {}, { forAgent: 'oren' });
    gates.release('o');
    await until(() => stored('oren', 'oren done'), "oren's turn");
    // oren is idle now, mira still waits on her tool.
    surface.ctx.addMessage('user', [text('oren, idle')], {}, { forAgent: 'oren' });
    gates.release('m');
    await until(() => stored('mira', 'mira done'), "mira's turn");
    await framework.runUntilIdle();
    handlePush(pushEvent('round two'));
    await until(() => stored('mira', 'mira again') && stored('oren', 'oren again'), 'both second turns');
    await framework.runUntilIdle();

    const record = cmOf('mira').getAllMessages();
    const at = (t: string) => record.findIndex((m) => rowText(m) === t);
    const streamsOf = (name: string): WireStream[] => membrane.streams.filter((s) => s.agent === name);

    // G. Not vacuous: both windows were presented from boot, and each resident ran two streams.
    assert.deepEqual(modesAtBoot, ['presented', 'presented'], 'both windows are presented from their registration');
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
      assert.deepEqual(windowSaid, said(wireOf(second)), `${name}'s window is what its second stream carried`);

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
        '@user', ...atSecondStart,
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
    }
    assert.deepEqual(audienceOf(record[at('for mira')]!.metadata)?.audience, ['mira'], "'for mira' is stamped for mira");
    assert.deepEqual(strips.filter((s) => s.strip !== undefined), [], 'no committing compile of either resident took thinking out');
    assert.ok(strips.length >= 4, 'every start compiled');

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
  });
});
