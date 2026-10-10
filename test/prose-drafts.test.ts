/**
 * Held prose drafts (shelf-351): plain speech that is not sent is kept as a
 * private, explicitly resendable draft instead of vanishing.
 *
 * Unit tests drive ProseDraftStore over a real Chronicle store; end-to-end
 * tests run real turns (MockMembrane) against a real MCPL child (the
 * speech-route fixture), which records every channels/publish it receives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { ProseDraftStore, draftState, PROSE_DRAFT_RECORD_TYPE } from '../src/prose-drafts.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const ROOM = 'discord:g1:room';
const GENERAL = 'discord:g1:general';
const source = { branch: 'main', turn: 1, round: 1, segment: 0 };
const dest = (channelId = ROOM) => ({ serverId: 'discord', channelId, label: '#room (Guild One)' });

describe('ProseDraftStore', () => {
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), 'prose-drafts-unit-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    return { dir, store, drafts: new ProseDraftStore(store) };
  };

  it('holds exact words in order, with stable ids, per resident', () => {
    const { dir, store, drafts } = open();
    try {
      const { held } = drafts.hold('a', [{ text: ' one\n', source }, { text: 'two  ', source: { ...source, segment: 1 } }], 'explicit-send');
      assert.equal(held.length, 2);
      assert.match(held[0]!.id, /^d-[a-z2-9]{5}$/);
      assert.notEqual(held[0]!.id, held[1]!.id);
      assert.deepEqual(drafts.open('a').map((d) => d.text), ['two  ', ' one\n'], 'newest first, bytes exact');
      assert.deepEqual(drafts.open('b'), [], 'another resident sees none of them');
      assert.equal(drafts.get('b', held[0]!.id), undefined);
      assert.equal(draftState(held[0]!), 'held');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays the journal at reopen: an attempt with no recorded outcome reads as unconfirmed', () => {
    const { dir, store, drafts } = open();
    const path = join(dir, 'store');
    const { held } = drafts.hold('a', [{ text: 'words', source }, { text: 'more', source }], 'explicit-send');
    drafts.beginAttempt('a', held[0]!.id, dest(), 'resend', false); // the process "dies" here
    const second = drafts.beginAttempt('a', held[1]!.id, dest(), 'resend', false);
    drafts.recordOutcome('a', held[1]!.id, second, { status: 'delivered', messageId: 'm-9', at: 5, destination: dest() });
    store.close();
    const reopened = JsStore.openOrCreate({ path });
    try {
      const again = new ProseDraftStore(reopened);
      assert.equal(draftState(again.get('a', held[0]!.id)!), 'unconfirmed');
      assert.equal(draftState(again.get('a', held[1]!.id)!), 'delivered');
      assert.equal(again.get('a', held[1]!.id)!.attempts[0]!.outcome!.messageId, 'm-9');
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not moved by branch switches: undo, rollback and checkout leave every draft as it was', () => {
    const { dir, store, drafts } = open();
    try {
      const main = store.currentBranch().name;
      const { held } = drafts.hold('a', [{ text: 'kept', source }, { text: 'set aside', source }], 'explicit-send');
      const attempt = drafts.beginAttempt('a', held[0]!.id, dest(), 'resend', false);
      drafts.recordOutcome('a', held[0]!.id, attempt, { status: 'delivered', at: 7, destination: dest() });
      drafts.dismiss('a', held[1]!.id);
      store.createBranch('elsewhere', main);
      store.switchBranch('elsewhere');
      drafts.reload();
      assert.equal(draftState(drafts.get('a', held[0]!.id)!), 'delivered', 'a delivered draft stays delivered');
      assert.equal(draftState(drafts.get('a', held[1]!.id)!), 'dismissed', 'a dismissed draft stays dismissed');
      const later = drafts.hold('a', [{ text: 'held on another branch', source }], 'explicit-send').held[0]!;
      store.switchBranch(main);
      drafts.reload();
      assert.equal(draftState(drafts.get('a', later.id)!), 'held', 'a draft is usable from any branch');
      assert.equal(store.getRecordIdsByType(PROSE_DRAFT_RECORD_TYPE).length, 6);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports words it could not hold, and stays consistent with its journal', () => {
    const { dir, store, drafts } = open();
    try {
      const real = store.sync.bind(store);
      let fail = true;
      (store as unknown as { sync: () => void }).sync = () => { if (fail) throw new Error('EIO'); real(); };
      const result = drafts.hold('a', [{ text: 'x', source }, { text: 'y', source }], 'explicit-send');
      assert.equal(result.held.length, 0);
      assert.deepEqual(result.notHeld, { count: 2, error: 'EIO' });
      // The first record reached the store before its barrier failed: the
      // journal was reconciled, so the projection shows what it holds.
      assert.deepEqual(drafts.open('a').map((d) => d.text), ['x']);
      fail = false;
      assert.equal(drafts.hold('a', [{ text: 'z', source }], 'explicit-send').held.length, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a notice only after the history holding it is synced (afterCommittedState)', () => {
    const { dir, store, drafts } = open();
    try {
      const { held } = drafts.hold('a', [{ text: 'x', source }], 'explicit-send');
      const calls: string[] = [];
      const real = { sync: store.sync.bind(store), appendJson: store.appendJson.bind(store) };
      (store as unknown as { sync: () => void }).sync = () => { calls.push('sync'); real.sync(); };
      (store as unknown as { appendJson: (t: string, p: unknown) => unknown }).appendJson = (t, p) => { calls.push(`append:${t}`); return real.appendJson(t, p); };
      drafts.markNoticed('a', [held[0]!.id]);
      assert.deepEqual(calls, ['sync', `append:${PROSE_DRAFT_RECORD_TYPE}`, 'sync']);
      assert.ok(drafts.get('a', held[0]!.id)!.noticedAt);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an inherited duplication risk keeps a draft unconfirmed until a confirmed delivery', () => {
    const { dir, store, drafts } = open();
    try {
      const risky = { draftId: 'd-zzzzz', destination: dest(), at: 1, reason: 'no valid receipt' };
      const [copy] = drafts.hold('a', [{ text: 'risky words and more', source, inheritedRisk: risky }], 'bounced').held;
      assert.equal(draftState(copy!), 'unconfirmed');
      const failed = drafts.beginAttempt('a', copy!.id, dest(), 'resend', true);
      drafts.recordOutcome('a', copy!.id, failed, { status: 'failed', at: 2, destination: dest() });
      assert.equal(draftState(drafts.get('a', copy!.id)!), 'unconfirmed', 'a failed attempt does not clear it');
      const ok = drafts.beginAttempt('a', copy!.id, dest(), 'resend', true);
      drafts.recordOutcome('a', copy!.id, ok, { status: 'delivered', at: 3, destination: dest() });
      assert.equal(draftState(drafts.get('a', copy!.id)!), 'delivered');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('{{unsent}} is the latest bounce while it is open, latest-wins', () => {
    const { dir, store, drafts } = open();
    try {
      const first = drafts.hold('a', [{ text: 'first', source }], 'bounced').held[0]!;
      const second = drafts.hold('a', [{ text: 'second', source }], 'bounced').held[0]!;
      drafts.hold('a', [{ text: 'not a bounce', source }], 'explicit-send');
      assert.equal(drafts.latestBounce('a')?.id, second.id);
      drafts.dismiss('a', second.id);
      assert.equal(drafts.latestBounce('a'), undefined, 'an older bounce is not substituted');
      assert.equal(draftState(drafts.get('a', first.id)!), 'held', 'it stays in the collection by id');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: real turns against a real MCPL child
// ---------------------------------------------------------------------------

type Publish = { event: string; channelId: string; text: string; messageId?: string };

/** A stream in XML tool mode: tool-calls carry no verbatim roundContent. */
class XmlModeStream implements YieldingStream {
  constructor(private readonly inner: YieldingStream) {}
  provideToolResults(...args: Parameters<YieldingStream['provideToolResults']>): void {
    this.inner.provideToolResults(...args);
  }
  cancel(): void { this.inner.cancel(); }
  get isWaitingForTools(): boolean { return this.inner.isWaitingForTools; }
  get pendingToolCallIds(): string[] { return this.inner.pendingToolCallIds; }
  get toolDepth(): number { return this.inner.toolDepth; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of this.inner) {
      if (event.type !== 'tool-calls') {
        yield event;
        continue;
      }
      const context = { ...(event as unknown as { context: Record<string, unknown> }).context };
      delete context.roundContent;
      yield { ...event, context } as unknown as StreamEvent;
    }
  }
}

/** A membrane in XML tool mode (the inner mock's streams, wrapped). */
function xmlMode(inner: MockMembrane): MockMembrane {
  const streamYielding = inner.streamYielding.bind(inner);
  (inner as unknown as { streamYielding: (r: NormalizedRequest, o?: unknown) => YieldingStream }).streamYielding =
    (request, options) => new XmlModeStream(streamYielding(request, options));
  return inner;
}

async function harness(opts: {
  agents?: Array<{ name: string; proseRouting?: 'locus' | 'explicit' | 'hybrid' | 'disabled'; sameRoundThinkTextPolicy?: 'public' | 'private' }>;
  xml?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prose-drafts-e2e-'));
  const commandPath = join(dir, 'commands.jsonl');
  const statusPath = join(dir, 'status.jsonl');
  writeFileSync(commandPath, '');
  const membrane = opts.xml ? xmlMode(new MockMembrane()) : new MockMembrane();
  // A wake the test did not script (an explicit-mode bounce wake, say) gets
  // an empty completion instead of a stream with no events.
  const streamYielding = membrane.streamYielding.bind(membrane);
  (membrane as unknown as { streamYielding: typeof streamYielding }).streamYielding = (request, options) => {
    const internals = membrane as unknown as { responses: unknown[]; responseIndex: number };
    if (internals.responseIndex >= internals.responses.length) membrane.pushResponse(createMockResponse([]));
    return streamYielding(request, options);
  };
  const agents = (opts.agents ?? [{ name: 'scout' }]).map((a) => ({
    name: a.name, model: 'test-model', systemPrompt: `You are ${a.name}.`,
    ...(a.proseRouting ? { proseRouting: a.proseRouting } : {}),
    ...(a.sameRoundThinkTextPolicy ? { sameRoundThinkTextPolicy: a.sameRoundThinkTextPolicy } : {}),
  }));
  const create = async () => {
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents,
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs')],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await until(() => registry.listChannelsRaw().length >= 2, 'registration');
    return framework;
  };
  const until = async (cond: () => boolean, what: string) => {
    const deadline = Date.now() + 15_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  let framework = await create();
  let incoming = 0;
  const h = {
    dir,
    membrane,
    get framework() { return framework; },
    until,
    command: (c: Record<string, unknown>) => appendFileSync(commandPath, JSON.stringify(c) + '\n'),
    publishes: (): Publish[] => existsSync(statusPath)
      ? readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Publish)
        .filter((e) => e.event === 'publish' || e.event === 'publish-refused' || e.event === 'publish-error')
      : [],
    /** One addressed message in #room starts a turn (or, with `request`, a
     *  direct inference request for just that resident); resolves when it settles. */
    turn: async (responses: Array<ReturnType<typeof createMockResponse>>, agentName = 'scout', via: 'incoming' | 'request' = 'incoming') => {
      for (const r of responses) membrane.pushResponse(r);
      const before = membrane.calls.length;
      if (via === 'incoming') {
        h.command({ op: 'incoming', channelId: ROOM, messageId: `in-${++incoming}`, mode: 'addressed', text: `message ${incoming}` });
      } else {
        (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
          agentName, reason: 'test', source: 'test', timestamp: Date.now(),
        });
      }
      await until(() => membrane.calls.length > before, 'turn start');
      await framework.runUntilIdle();
      await until(() => !(framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has(agentName), 'turn end');
      await framework.runUntilIdle();
    },
    drafts: (agent = 'scout') => (framework as unknown as { proseDrafts: ProseDraftStore }).proseDrafts.open(agent),
    store: () => (framework as unknown as { proseDrafts: ProseDraftStore }).proseDrafts,
    texts: (agent = 'scout') => framework.getAgent(agent)!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text),
    messages: (agent = 'scout') => framework.getAgent(agent)!.getContextManager().getAllMessages(),
    /** Text of every tool result the last stream received, in call order
     *  within each round (results arrive in completion order). */
    toolResults: () => (membrane.lastStream?.receivedToolResults ?? []).flatMap((round, i) => {
      const order = (membrane.lastStream as unknown as { responses: Array<{ toolCalls: Array<{ id: string }> }> })
        .responses[i]?.toolCalls.map((c) => c.id) ?? [];
      const byId = (r: unknown) => order.indexOf((r as { toolUseId?: string }).toolUseId ?? '');
      return [...round].sort((a, b) => byId(a) - byId(b)).map((r) => {
        const content = (r as { content?: unknown }).content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map((b) => (b as { text?: string }).text ?? '').join('');
        return JSON.stringify(r);
      });
    }),
    restart: async () => {
      await framework.stop();
      // A fresh fixture child reads the command file from the top: start it
      // on an empty one so earlier inbound traffic is not replayed.
      writeFileSync(commandPath, '');
      framework = await create();
    },
    close: async () => {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const call = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const drafts = (id: string, input: Record<string, unknown>) =>
  call(id, 'drafts', { action: null, draftIds: null, destination: null, confirmDuplicate: null, offset: null, ...input });
const explicitSend = (id: string) => call(id, 'channel_publish', { channelId: GENERAL, content: 'an explicit note elsewhere' });

describe('held prose drafts, end to end', () => {
  it('a suppressed three-segment reply is held, named, inspected and delivered without retyping', async () => {
    const h = await harness();
    try {
      const segments = ['First — the actual reply.', 'Second, with  two spaces\nand a newline.', 'Third: trailing words.'];
      await h.turn([
        createMockResponse([text(segments[0]!), explicitSend('s1')], 'tool_use'),
        createMockResponse([text(segments[1]!), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text(segments[2]!)]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere'], 'only the explicit send went out');
      const held = h.drafts().reverse();
      assert.deepEqual(held.map((d) => d.text), segments, 'exact words, in order');
      assert.ok(held.every((d) => d.reason === 'explicit-send'));
      const ids = held.map((d) => d.id);

      // Safe in-band ordering: each mid-turn notice is stored after the tool
      // result it rode with, and was injected into the live stream there.
      const msgs = h.messages();
      const noticeIdx = msgs.findIndex((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-drafts');
      assert.ok(noticeIdx > 0, 'a held-draft notice was stored');
      assert.ok(msgs[noticeIdx - 1]!.content.some((b) => b.type === 'tool_result'), 'right after the tool result');
      const injected = (h.membrane.lastStream?.receivedToolResultOptions ?? [])
        .flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
      assert.ok(injected.some((t) => t.includes(ids[0]!)), 'the resident heard about the first draft mid-turn');
      const receipt = h.texts().find((t) => t.startsWith('[delivered]'))!;
      assert.equal(receipt, `[delivered] nothing — 3 plain-speech segment(s) held as drafts ${ids.join(', ')} (not sent — drafts can resend them unchanged, or dismiss them)`);

      // Next turn: list (every field present, nulls), read, then resend all three.
      await h.turn([
        createMockResponse([drafts('d1', { action: 'list' })], 'tool_use'),
        createMockResponse([drafts('d2', { action: 'read', draftIds: [ids[1]] })], 'tool_use'),
        createMockResponse([drafts('d3', { action: 'resend', draftIds: ids, destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      const [list, read, resend] = h.toolResults();
      assert.match(list!, /3 open drafts, newest first/);
      assert.ok(read!.endsWith(`exactly as a resend publishes it):\n${segments[1]}`), `read shows the text in full: ${read}`);
      assert.match(resend!, new RegExp(`${ids[0]}: delivered to #room \\(Guild One\\) \\(discord / ${ROOM}\\), message posted-2`));
      const sent = h.publishes().slice(1);
      assert.deepEqual(sent.map((p) => [p.channelId, p.text]), segments.map((s) => [ROOM, s]), 'verbatim, in order');
      assert.ok(h.store().open('scout').length === 0, 'nothing left open');
    } finally {
      await h.close();
    }
  });

  it('XML tool mode: the whole turn\'s prose is held at turn end and named in the receipt, never mid-turn', async () => {
    const h = await harness({ xml: true });
    try {
      // XML mode completes with the turn's cumulative content (its tool
      // calls already ran: the completion carries none of its own).
      await h.turn([
        createMockResponse([text('Narration before the send.'), explicitSend('s1')], 'tool_use'),
        { ...createMockResponse([text('Narration before the send.'), explicitSend('s1'), text('And after it.')]), toolCalls: [] },
      ]);
      const held = h.drafts().reverse();
      assert.deepEqual(held.map((d) => d.text), ['Narration before the send.', 'And after it.']);
      assert.equal(h.messages().filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-drafts').length, 0,
        'no mid-turn notice: XML rounds present no injections');
      assert.ok(h.texts().some((t) => t.startsWith('[delivered] nothing — 2 plain-speech segment(s) held as drafts')));
    } finally {
      await h.close();
    }
  });

  it('deliberate privacy is never drafted: skip_reply and a same-round private think', async () => {
    const h = await harness({ agents: [{ name: 'scout', sameRoundThinkTextPolicy: 'private' }] });
    try {
      await h.turn([
        createMockResponse([text('Thinking aloud, privately.'), call('k1', 'skip_reply', {})], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.drafts(), []);
      assert.ok(h.texts().some((t) => t === '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply)'));
      await h.turn([
        createMockResponse([text('Prose beside a private think.'), call('t1', 'think', { thought: 'hmm' }), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.drafts(), [], 'a same-round private think keeps its prose private, even beside a send');
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere']);
    } finally {
      await h.close();
    }
  });

  it('disabled mode stays draft-free: its narration is private by configuration', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'disabled' }] });
    try {
      await h.turn([
        createMockResponse([text('Narration that never publishes.'), explicitSend('s1')], 'tool_use'),
        createMockResponse([text('More of it.')]),
      ]);
      assert.deepEqual(h.drafts(), []);
      assert.ok(h.texts().some((t) => t.startsWith('[delivered] nothing — 2 plain-speech segment(s) suppressed (proseRouting=disabled')));
    } finally {
      await h.close();
    }
  });

  it('drafts belong to their resident: another resident can neither list nor resend them', async () => {
    const h = await harness({ agents: [{ name: 'scout' }, { name: 'other' }] });
    try {
      // Direct requests: a channel message would wake both residents.
      await h.turn([
        createMockResponse([text('scout words'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ], 'scout', 'request');
      const [mine] = h.drafts('scout');
      assert.ok(mine);
      await h.turn([
        createMockResponse([drafts('o1', { action: 'list' })], 'tool_use'),
        createMockResponse([drafts('o2', { action: 'resend', draftIds: [mine.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ], 'other', 'request');
      const [list, resend] = h.toolResults();
      assert.match(list!, /You have no open drafts/);
      assert.match(resend!, new RegExp(`No draft of yours with id ${mine.id}`));
      assert.equal(h.publishes().filter((p) => p.text === 'scout words').length, 0);
      // Residents of one framework share a message slot (#197), so the
      // notice is visible there too; it names whose drafts it means.
      assert.ok(h.texts('scout').some((t) => t.startsWith(`[drafts] scout: not sent — a plain-speech segment held as draft ${mine.id}`)));
    } finally {
      await h.close();
    }
  });

  it('failed and uncertain resends: a refusal stays resendable; an unknown outcome needs confirmDuplicate', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('fragile words'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      const resend = (id: string, confirm?: boolean) =>
        drafts(id, { action: 'resend', draftIds: [draft!.id], destination: ROOM, ...(confirm ? { confirmDuplicate: true } : {}) });

      h.command({ op: 'publish-mode', mode: 'not-delivered' });
      await h.turn([createMockResponse([resend('r1')], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /not sent to .* Nothing was posted by this attempt\. The draft stays held\./);
      assert.equal(draftState(h.store().get('scout', draft!.id)!), 'held');

      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([createMockResponse([resend('r2')], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /NOT confirmed — it may or may not have been posted/);
      assert.equal(draftState(h.store().get('scout', draft!.id)!), 'unconfirmed');

      h.command({ op: 'publish-mode', mode: 'delivered' });
      await h.turn([createMockResponse([resend('r3')], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /may already have been posted.*confirmDuplicate: true\. Nothing was sent/);
      const before = h.publishes().length;
      await h.turn([createMockResponse([resend('r4', true)], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /delivered to/);
      assert.equal(h.publishes().length, before + 1);
      const attempts = h.store().get('scout', draft!.id)!.attempts;
      assert.deepEqual(attempts.map((a) => [a.outcome?.status, a.confirmedDuplicate ?? false]), [
        ['failed', false], ['unknown', false], ['delivered', true],
      ]);
    } finally {
      await h.close();
    }
  });

  it('an unknown outcome is not cleared by a later failure: the draft stays unconfirmed', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('maybe already out'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      const resend = (id: string, confirm?: boolean) =>
        drafts(id, { action: 'resend', draftIds: [draft!.id], destination: ROOM, ...(confirm ? { confirmDuplicate: true } : {}) });
      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([createMockResponse([resend('r1')], 'tool_use'), createMockResponse([])]);
      h.command({ op: 'publish-mode', mode: 'not-delivered' });
      await h.turn([createMockResponse([resend('r2', true)], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /Nothing was posted by this attempt\. The draft stays unconfirmed: d-[a-z2-9]{5}'s attempt to .* may already have been posted: .*delivery uncertain/);
      assert.equal(draftState(h.store().get('scout', draft!.id)!), 'unconfirmed');
      h.command({ op: 'publish-mode', mode: 'delivered' });
      const before = h.publishes().length;
      await h.turn([createMockResponse([resend('r3')], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /may already have been posted: .*delivery uncertain.*confirmDuplicate: true\. Nothing was sent/);
      assert.equal(h.publishes().length, before, 'no third publish without confirmation');
    } finally {
      await h.close();
    }
  });

  it('June\'s cases: a rollback to before a confirmed resend returns the receipt, no new publish; a dismissal survives it', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('to deliver'), explicitSend('s1')], 'tool_use'),
        createMockResponse([text('to dismiss')]),
      ]);
      const [deliver, dismiss] = h.drafts().reverse();
      const anchor = h.messages().at(-1)!.id;
      await h.turn([
        createMockResponse([drafts('r1', { action: 'resend', draftIds: [deliver!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([drafts('x1', { action: 'dismiss', draftIds: [dismiss!.id] })], 'tool_use'),
        createMockResponse([]),
      ]);
      const published = h.publishes().length;
      await h.framework.rollbackToMessage('scout', { messageId: anchor });
      assert.ok(!h.texts().some((t) => t.includes('delivered to')), 'the resend turn is gone from the branch');
      await h.turn([
        createMockResponse([drafts('r2', { action: 'resend', draftIds: [deliver!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([drafts('r3', { action: 'resend', draftIds: [dismiss!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      const [receipt, refused] = h.toolResults();
      assert.match(receipt!, new RegExp(`${deliver!.id}: delivered — confirmed at .* to #room \\(Guild One\\) \\(discord / ${ROOM}\\), message posted-\\d+ .*not sent again`));
      assert.match(refused!, new RegExp(`${dismiss!.id} was dismissed`));
      assert.equal(h.publishes().length, published, 'no new publish');
    } finally {
      await h.close();
    }
  });

  it('June\'s case: after a restart, an attempt that never recorded an outcome stays unknown and needs confirmDuplicate', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('half-sent words'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      // The process "died" between journaling the attempt and its outcome.
      h.store().beginAttempt('scout', draft!.id, dest(), 'resend', false);
      await h.restart();
      assert.equal(draftState(h.store().get('scout', draft!.id)!), 'unconfirmed');
      const before = h.publishes().length;
      await h.turn([
        createMockResponse([drafts('r1', { action: 'resend', draftIds: [draft!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.match(h.toolResults()[0]!, /its outcome was never recorded.*confirmDuplicate: true\. Nothing was sent/);
      assert.equal(h.publishes().length, before, 'nothing replayed at boot or sent without confirmation');
    } finally {
      await h.close();
    }
  });

  it('drafts held in a turn that crashed are named by the next turn\'s catch-up notice, each by its actual state', async () => {
    const h = await harness();
    try {
      // Held directly, as if the turn that held it died before its receipt;
      // the second also died mid-send, its attempt never resolved.
      h.store().hold('scout', [{ text: 'orphaned words', source }], 'explicit-send');
      const midSend = h.store().hold('scout', [{ text: 'half-sent words', source }], 'explicit-send').held[0]!;
      h.store().beginAttempt('scout', midSend.id, dest(), 'resend', false);
      await h.turn([createMockResponse([])]);
      const notice = h.texts().find((t) => t.startsWith('[drafts]'))!;
      assert.match(notice, /^\[drafts\] scout: 2 held drafts of yours have not been named to you yet: /);
      assert.match(notice, /d-[a-z2-9]{5} \(held \(not sent\); held .*"orphaned words"\)/);
      assert.match(notice, new RegExp(`${midSend.id} \\(UNCONFIRMED — an attempt to #room \\(Guild One\\) \\(discord / ${ROOM}\\) at .* may have been posted; .*"half-sent words"`));
      assert.doesNotMatch(notice, /They were not sent/);
      await h.turn([createMockResponse([])]);
      assert.equal(h.texts().filter((t) => t.startsWith('[drafts]')).length, 1, 'named once');
    } finally {
      await h.close();
    }
  });

  it('explicit mode: a bounce is a draft that survives a restart, and {{unsent}} delivers and settles it', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      await h.turn([createMockResponse([text('words with nowhere to go')])]);
      const [bounced] = h.drafts();
      assert.equal(bounced?.reason, 'bounced');
      assert.ok(h.texts().some((t) => t.includes(`It is held as draft ${bounced!.id}`)));
      await h.restart();
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}}`)])]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['words with nowhere to go']);
      const after = h.store().get('scout', bounced!.id)!;
      assert.equal(draftState(after), 'delivered');
      assert.equal(after.attempts[0]!.via, 'unsent-token');
    } finally {
      await h.close();
    }
  });

  it('explicit mode: re-bouncing {{unsent}} of a possibly-posted draft keeps the whole text and its risk', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      await h.turn([createMockResponse([text('risky words')])]);
      const [risky] = h.drafts();
      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}}`)])]);
      assert.equal(draftState(h.store().get('scout', risky!.id)!), 'unconfirmed');
      h.command({ op: 'publish-mode', mode: 'delivered' });
      // The destination does not resolve, so the envelope bounces: the whole
      // authored attempt is held, and it carries the copied draft's risk.
      await h.turn([createMockResponse([text('>>#nowhere {{unsent}} and a postscript')])]);
      const fresh = h.drafts().find((d) => d.id !== risky!.id)!;
      assert.equal(fresh.text, 'risky words and a postscript', 'nothing substituted or truncated');
      assert.equal(fresh.inheritedRisk?.draftId, risky!.id);
      assert.equal(draftState(fresh), 'unconfirmed');
      assert.ok(h.texts().some((t) => t.includes(`It includes the words of draft ${risky!.id}, which may already have been posted, so ${fresh.id} can be resent only with the drafts tool and confirmDuplicate: true`)));
      // {{unsent}} now means the fresh draft, and it is refused unconfirmed.
      const before = h.publishes().length;
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}}`)])]);
      assert.equal(h.publishes().length, before, 'neither draft goes out without confirmation');
      assert.ok(h.texts().some((t) => t.startsWith(`[prose-routing] {{unsent}} is draft ${fresh.id}: ${fresh.id} includes the words of ${risky!.id}`)));
      await h.turn([createMockResponse([drafts('r1', { action: 'resend', draftIds: [fresh.id], destination: ROOM, confirmDuplicate: true })], 'tool_use'), createMockResponse([])]);
      assert.deepEqual(h.publishes().slice(before).map((p) => p.text), ['risky words and a postscript']);
      assert.equal(draftState(h.store().get('scout', risky!.id)!), 'unconfirmed', 'the original still needs its own confirmation');
    } finally {
      await h.close();
    }
  });

  it('resend is an explicit send: prose beside it is held, not auto-routed', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('earlier words'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      await h.turn([
        createMockResponse([text('a postscript'), drafts('r1', { action: 'resend', draftIds: [draft!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere', 'earlier words']);
      assert.deepEqual(h.drafts().map((d) => d.text), ['a postscript']);
    } finally {
      await h.close();
    }
  });

  it('two resends of one draft in the same round: one is sent, the other is refused while it is in flight', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('once only'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      const resend = (id: string) =>
        drafts(id, { action: 'resend', draftIds: [draft!.id], destination: ROOM, confirmDuplicate: true });
      await h.turn([createMockResponse([resend('a'), resend('b')], 'tool_use'), createMockResponse([])]);
      const [first, second] = h.toolResults();
      assert.match(first!, /delivered to/);
      assert.match(second!, /is being sent right now \(or is queued in a resend in progress\); wait for that result/);
      assert.equal(h.publishes().filter((p) => p.text === 'once only').length, 1);
    } finally {
      await h.close();
    }
  });

  it('a dismissal in the same round as its draft\'s resend is refused until that result is in: it can\'t call back words on their way', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('words that land'), explicitSend('s1'), text('words in doubt'), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([]),
      ]);
      const sure = h.drafts().find((d) => d.text === 'words that land')!;
      const unsure = h.drafts().find((d) => d.text === 'words in doubt')!;
      // The resend is dispatched first, so its attempt is out when the dismissal runs.
      const raced = (id: string) => [
        drafts(`r-${id}`, { action: 'resend', draftIds: [id], destination: ROOM }),
        drafts(`x-${id}`, { action: 'dismiss', draftIds: [id] }),
      ];
      const waits = (id: string) => new RegExp(
        `${id} is being sent right now, and dismissing it can't call those words back; wait for that result before dismissing it\\. Nothing was dismissed\\.`);

      await h.turn([createMockResponse(raced(sure.id), 'tool_use'), createMockResponse([])]);
      let [resent, dismissal] = h.toolResults();
      assert.match(resent!, /delivered to/);
      assert.match(dismissal!, waits(sure.id), 'no "dismissed" reply over words that went out');
      assert.equal(draftState(h.store().get('scout', sure.id)!), 'delivered');

      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([createMockResponse(raced(unsure.id), 'tool_use'), createMockResponse([])]);
      [resent, dismissal] = h.toolResults();
      assert.match(dismissal!, waits(unsure.id));
      assert.match(resent!, /NOT confirmed .* Check the channel before sending it again \(that needs confirmDuplicate: true\)/,
        'the resend\'s advice holds: the draft is still open');
      assert.equal(draftState(h.store().get('scout', unsure.id)!), 'unconfirmed');

      // With the result in, the resident can set it aside knowingly.
      await h.turn([createMockResponse([drafts('x2', { action: 'dismiss', draftIds: [unsure.id] })], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, new RegExp(`${unsure.id}: dismissed`));
      assert.equal(draftState(h.store().get('scout', unsure.id)!), 'dismissed');
    } finally {
      await h.close();
    }
  });

  it('refuses unusable calls before sending anything', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('words'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      await h.turn([
        createMockResponse([
          drafts('a', { action: 'resend', draftIds: [draft!.id] }),
          drafts('b', { action: 'resend', draftIds: [draft!.id], destination: '#nowhere' }),
          drafts('c', { action: 'list', draftIds: [draft!.id] }),
          drafts('d', { action: 'read', draftIds: ['d-zzzzz'] }),
          drafts('e', { action: 'shout' }),
        ], 'tool_use'),
        createMockResponse([]),
      ]);
      const [noDest, badDest, unused, unknown, badAction] = h.toolResults();
      assert.match(noDest!, /resend needs a destination/);
      assert.match(badDest!, /Destination "#nowhere" did not resolve.*Nothing was sent/);
      assert.match(unused!, /draftIds is not used by action "list"/);
      assert.match(unknown!, /No draft of yours with id d-zzzzz/);
      assert.match(badAction!, /action must be one of/);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere']);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent resends through the actual drafts handler, with publish
// completions under the test's control.
// ---------------------------------------------------------------------------

describe('draft notices and turn-end settlement', () => {
  it('marks as noticed only the drafts a stored message names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prose-drafts-settle-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    try {
      const internals = framework as unknown as {
        proseDrafts: ProseDraftStore;
        turnDrafts: Map<string, unknown[]>;
        settleTurnDrafts(agent: unknown): void;
      };
      const agent = framework.getAgent('scout')!;
      const [named, lost] = internals.proseDrafts.hold('scout', [{ text: 'named', source }, { text: 'lost', source }], 'explicit-send').held;
      // Only the first draft's notice reached the history.
      agent.getContextManager().addMessage('user', [{ type: 'text', text: '[drafts] …' }], { system: true, kind: 'prose-drafts', draftOwner: 'scout', draftIds: [named!.id] } as never);
      internals.turnDrafts.set('scout', [named, lost]);
      internals.settleTurnDrafts(agent);
      assert.ok(internals.proseDrafts.get('scout', named!.id)!.noticedAt);
      assert.equal(internals.proseDrafts.get('scout', lost!.id)!.noticedAt, undefined, 'left for the catch-up');
      assert.deepEqual(internals.proseDrafts.unnoticed('scout').map((d) => d.id), [lost!.id]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('draft identity and risk evidence', () => {
  const setupFramework = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prose-drafts-ident-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }, { name: 'other', model: 'test-model', systemPrompt: 'other' }],
      modules: [],
    });
    const internals = framework as unknown as {
      proseDrafts: ProseDraftStore;
      turnDrafts: Map<string, unknown[]>;
      settleTurnDrafts(agent: unknown): void;
      bounceProse(agent: unknown, text: string, reason: string): void;
      riskText(draft: unknown): string;
    };
    return { dir, framework, internals, close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); } };
  };

  it('a notice names drafts of its own resident only: the same id under another resident is not settled by it', async () => {
    const t = await setupFramework();
    try {
      (t.internals.proseDrafts as unknown as { newId: (agent: string) => string }).newId = () => 'd-same2';
      const [mine] = t.internals.proseDrafts.hold('scout', [{ text: 'scout words', source }], 'explicit-send').held;
      t.internals.proseDrafts.hold('other', [{ text: 'other words', source }], 'explicit-send');
      // Only the OTHER resident's notice for "d-same2" is in the shared history.
      t.framework.getAgent('other')!.getContextManager().addMessage('user', [{ type: 'text', text: '[drafts] other: …' }],
        { system: true, kind: 'prose-drafts', draftOwner: 'other', draftIds: ['d-same2'] } as never);
      t.internals.turnDrafts.set('scout', [mine]);
      t.internals.settleTurnDrafts(t.framework.getAgent('scout')!);
      assert.equal(t.internals.proseDrafts.get('scout', 'd-same2')!.noticedAt, undefined);
    } finally {
      await t.close();
    }
  });

  it('a re-bounce of inherited risk keeps the original attempt as its evidence', async () => {
    const t = await setupFramework();
    try {
      const agent = t.framework.getAgent('scout')!;
      const [original] = t.internals.proseDrafts.hold('scout', [{ text: 'first', source }], 'bounced').held;
      t.internals.proseDrafts.beginAttempt('scout', original!.id, dest(), 'unsent-token', false); // never resolved
      t.internals.bounceProse(agent, '{{unsent}} second', 'no such channel');
      const copy = t.internals.proseDrafts.open('scout').find((d) => d.text === 'first second')!;
      assert.equal(copy.inheritedRisk?.draftId, original!.id);
      t.internals.bounceProse(agent, '{{unsent}} third', 'no such channel');
      const again = t.internals.proseDrafts.open('scout').find((d) => d.text === 'first second third')!;
      assert.equal(again.inheritedRisk?.draftId, copy.id);
      assert.equal(again.inheritedRisk?.sourceDraftId, original!.id);
      assert.deepEqual(again.inheritedRisk?.destination, dest());
      assert.equal(again.inheritedRisk?.reason, 'its outcome was never recorded');
      const text = t.internals.riskText(again);
      assert.match(text, new RegExp(`${again.id} includes the words of ${copy.id}, which itself includes the words of ${original!.id}, and ${original!.id}'s attempt to #room \\(Guild One\\)`));
      assert.doesNotMatch(text, /being sent/);
    } finally {
      await t.close();
    }
  });
});

describe('drafts resend ownership', () => {
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prose-drafts-own-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    const pending: Array<{ text: string; resolve: (o: unknown) => void }> = [];
    const held = (text: string, channelId: string) =>
      new Promise((resolve) => pending.push({
        text,
        resolve: (o) => resolve({ destination: { serverId: 'discord', channelId }, at: Date.now(), ...(o as object) }),
      }));
    const stub: Record<string, unknown> = {
      resolveProseTarget: (spec: string) => ({ channelId: spec }),
      resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'discord', channelId } }),
      publish: (_agent: string, text: string, target: { channelId: string }) => held(text, target.channelId),
      // An envelope's delivery, `{{unsent}}` included.
      deliverSpeech: (_agent: string, text: string, channelId: string) => held(text, channelId),
      getChannelTools: () => [],
      // Every channel declares an MCPL RFC-011 publish target.
      publishTarget: () => 'root',
    };
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(stub, {
      get: (t, prop: string) => (prop in t ? t[prop] : () => undefined),
    });
    const internals = framework as unknown as {
      proseDrafts: ProseDraftStore;
      handleDraftsTool(agent: string, input: unknown): Promise<{ success: boolean; data?: Array<{ text: string }>; error?: string }>;
      deliverProseEnvelope(agent: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
    };
    const say = (r: { success: boolean; data?: Array<{ text: string }>; error?: string }) =>
      r.success ? r.data!.map((b) => b.text).join('') : r.error!;
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const [a, b] = internals.proseDrafts.hold('scout', [{ text: 'A words', source }, { text: 'B words', source }], 'explicit-send').held;
    return {
      dir, framework, internals, pending, say, tick, a: a!, b: b!,
      close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
    };
  };

  it('an all-delivered resend returns its receipts even when the destination no longer resolves', async () => {
    const t = await setup();
    try {
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' });
      await t.tick();
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      assert.match(t.say(await sending), /delivered to \(discord \/ chan\), message m-a/);
      // The channel is gone: destination resolution would now fail.
      const registry = (t.framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
      registry.resolveProseTarget = () => ({ error: 'no channel matches' });
      registry.resolveDestination = () => ({ error: 'no registered channel' });
      const again = t.say(await t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: '#gone' }));
      assert.match(again, new RegExp(`${t.a.id}: delivered — confirmed at .* message m-a .*not sent again`));
      assert.equal(t.pending.length, 0);
      // A mixed batch still needs a destination that resolves.
      const mixed = t.say(await t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, t.b.id], destination: '#gone' }));
      assert.match(mixed, /Destination "#gone" did not resolve/);
    } finally {
      await t.close();
    }
  });

  it('a batch owns its drafts: a concurrent resend of a queued draft is refused, and nothing is sent twice', async () => {
    const t = await setup();
    try {
      const batch = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, t.b.id], destination: 'chan' });
      await t.tick();
      assert.deepEqual(t.pending.map((p) => p.text), ['A words'], 'the batch is waiting on A');
      const concurrent = t.say(await t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.b.id], destination: 'chan' }));
      assert.match(concurrent, new RegExp(`${t.b.id} is being sent right now \\(or is queued in a resend in progress\\)`));
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      await t.tick();
      assert.deepEqual(t.pending.map((p) => p.text), ['B words']);
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-b' });
      const result = t.say(await batch);
      assert.match(result, /delivered to \(discord \/ chan\), message m-a/);
      assert.match(result, /delivered to \(discord \/ chan\), message m-b/);
      assert.equal(t.pending.length, 0, 'B was published exactly once');
    } finally {
      await t.close();
    }
  });

  it('a draft dismissed while the batch waits is not published', async () => {
    const t = await setup();
    try {
      const batch = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, t.b.id], destination: 'chan' });
      await t.tick();
      const dismissed = t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.b.id] }));
      assert.match(dismissed, new RegExp(`${t.b.id}: dismissed`));
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      const result = t.say(await batch);
      assert.match(result, new RegExp(`${t.b.id} was dismissed, so it can't be resent\\. It changed while this resend was waiting — not sent\\.`));
      assert.equal(t.pending.length, 0, 'B never reached publish');
      assert.equal(draftState(t.internals.proseDrafts.get('scout', t.b.id)!), 'dismissed');
    } finally {
      await t.close();
    }
  });

  it('a dismissal naming a draft whose attempt is out dismisses nothing, not even the queued one beside it', async () => {
    const t = await setup();
    try {
      const batch = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, t.b.id], destination: 'chan' });
      await t.tick();
      assert.deepEqual(t.pending.map((p) => p.text), ['A words'], 'A is out; B is queued');
      const refused = t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.b.id, t.a.id] }));
      assert.match(refused, new RegExp(`${t.a.id} is being sent right now, and dismissing it can't call those words back; .*Nothing was dismissed\\.`));
      assert.equal(t.internals.proseDrafts.get('scout', t.b.id)!.dismissedAt, undefined);
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'no receipt' });
      const result = t.say(await batch);
      assert.match(result, new RegExp(`${t.a.id}: delivery to .+ NOT confirmed`));
      assert.equal(draftState(t.internals.proseDrafts.get('scout', t.a.id)!), 'unconfirmed');
      assert.match(t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.a.id] })), new RegExp(`${t.a.id}: dismissed`),
        'with the result in, it can be dismissed');
    } finally {
      await t.close();
    }
  });

  it('>>skip_reply {{unsent}} leaves the latest bounce alone while it is being sent, and tells the resident', async () => {
    const t = await setup();
    try {
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words', source }], 'bounced').held;
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [bounce!.id], destination: 'chan' });
      await t.tick();
      const agent = t.framework.getAgent('scout')!;
      const envelope = (text: string) => t.internals.deliverProseEnvelope(agent, text, { notice: 'later' });
      await envelope('>>skip_reply {{unsent}}');
      assert.equal(t.internals.proseDrafts.get('scout', bounce!.id)!.dismissedAt, undefined);
      const words = agent.getContextManager().getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
      assert.ok(words.includes(`[prose-routing] {{unsent}} is draft ${bounce!.id}, which is being sent right now. It was not set aside, ` +
        'since that can\'t call back words already on their way; wait for that result.'), words.join('\n'));
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'no receipt' });
      await sending;
      await envelope('>>skip_reply {{unsent}}');
      assert.equal(draftState(t.internals.proseDrafts.get('scout', bounce!.id)!), 'dismissed', 'with the result in, it is set aside');
    } finally {
      await t.close();
    }
  });

  it('a dismissal is refused while an {{unsent}} delivery of that draft is out', async () => {
    const t = await setup();
    try {
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words', source }], 'bounced').held;
      const agent = t.framework.getAgent('scout')!;
      const delivering = t.internals.deliverProseEnvelope(agent, '>>chan {{unsent}}', { notice: 'later' });
      await t.tick();
      assert.deepEqual(t.pending.map((p) => p.text), ['bounced words'], 'the bounce is out through {{unsent}}');
      const refused = t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [bounce!.id] }));
      assert.match(refused, new RegExp(`${bounce!.id} is being sent right now, and dismissing it can't call those words back; .*Nothing was dismissed\\.`));
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'no receipt' });
      await delivering;
      assert.equal(draftState(t.internals.proseDrafts.get('scout', bounce!.id)!), 'unconfirmed');
      assert.match(t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [bounce!.id] })), new RegExp(`${bounce!.id}: dismissed`),
        'with the result in, it can be dismissed');
    } finally {
      await t.close();
    }
  });
});

describe('held drafts: exact runs, hybrid envelopes beside a send, and turn-end state', () => {
  /** Draft ids in hold order, so a later round can name them. */
  const fixIds = (h: Awaited<ReturnType<typeof harness>>, ids: string[]) => {
    let next = 0;
    (h.store() as unknown as { newId: () => string }).newId = () => ids[next++]!;
  };
  /** Tool rounds, then the completion a real membrane yields: the whole
   *  turn's content, with no calls of its own (so the turn's speech chain is
   *  settled before its receipt, as in production). */
  const rounds = (...rs: ContentBlock[][]) => [
    ...rs.map((r) => createMockResponse(r, 'tool_use')),
    { ...createMockResponse(rs.flat()), toolCalls: [] },
  ];

  it('a held draft keeps its run exactly as written, and a resend publishes those bytes', async () => {
    const h = await harness();
    try {
      const authored = '    indented code\n    second line\n';
      await h.turn([
        createMockResponse([text(authored), explicitSend('s1')], 'tool_use'),
        createMockResponse([text('\n\nAfter the send.\n')]),
      ]);
      const held = h.drafts().reverse();
      assert.deepEqual(held.map((d) => d.text), [authored, '\n\nAfter the send.\n']);
      await h.turn([
        createMockResponse([drafts('r1', { action: 'resend', draftIds: [held[0]!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.equal(h.publishes().at(-1)!.text, authored);
    } finally {
      await h.close();
    }
  });

  it('hybrid: after >>>skip_reply, prose a send holds back stays private across segments and rounds until a destination is named, which restores the sticky target', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([
        createMockResponse([text('>>>skip_reply a private aside'), explicitSend('s1'), text('still private'), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text('private in a later round'), call('l2', 'channel_list', {})], 'tool_use'),
        createMockResponse([text(`>>>${ROOM} words for the room`), call('l3', 'channel_list', {})], 'tool_use'),
        createMockResponse([text('more for the room')]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere']);
      assert.deepEqual(h.drafts().reverse().map((d) => [d.text, d.note]), [
        ['words for the room', `written for >>>${ROOM}`],
        ['more for the room', undefined],
      ]);
      assert.equal((h.framework as unknown as { proseTargetPins: Map<string, string> }).proseTargetPins.get('scout'), ROOM,
        'the named destination is the sticky target again, as live routing would leave it');
      assert.match(h.texts().find((t) => t.startsWith('[delivered]'))!, / · 3 plain-speech segment\(s\) kept private \(skip_reply\)$/);

      // A live `>>>skip_reply` in an earlier round binds a later silenced one.
      const before = h.drafts().length;
      await h.turn(rounds(
        [text('>>>skip_reply thinking aloud'), call('l4', 'channel_list', {})],
        [text('still thinking'), explicitSend('s2')],
      ));
      assert.equal(h.drafts().length, before, 'nothing private was drafted');
      // "still thinking" is the one kept private (live routing does not count
      // the `>>>skip_reply` envelope itself).
      assert.equal(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1), '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply)');
    } finally {
      await h.close();
    }
  });

  it('hybrid: beside a send, {{unsent}} holds the whole message it would have published, a bare one keeps the bounce as the one draft, and >>>skip_reply {{unsent}} still sets it aside', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([createMockResponse([text('>>>#nowhere lost words')])]);
      const [bounce] = h.drafts();
      assert.equal(bounce?.reason, 'bounced');

      await h.turn(rounds([text(`>>>${ROOM} {{unsent}} and a postscript`), explicitSend('s1')]));
      const copy = h.drafts().find((d) => d.text.endsWith('a postscript'))!;
      assert.deepEqual([copy.text, copy.note, copy.reason, copy.inheritedRisk], ['lost words and a postscript', `written for >>>${ROOM}`, 'explicit-send', undefined]);

      const count = h.drafts().length;
      await h.turn(rounds([text(`>>>${ROOM} {{unsent}}`), explicitSend('s2')]));
      assert.equal(h.drafts().length, count, 'a bare {{unsent}} mints no copy');
      assert.equal(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1),
        `[delivered] nothing — 1 plain-speech segment(s) held as draft ${bounce!.id} (not sent — drafts can resend them unchanged, or dismiss them)`);

      // Once the bounce may have been posted, held words copied from it carry its risk.
      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([createMockResponse([text(`>>>${ROOM} {{unsent}}`)])]);
      assert.equal(draftState(h.store().get('scout', bounce!.id)!), 'unconfirmed');
      h.command({ op: 'publish-mode', mode: 'delivered' });
      await h.turn(rounds([text(`>>>${ROOM} {{unsent}} again`), explicitSend('s3')]));
      const risky = h.drafts().find((d) => d.text === 'lost words again')!;
      assert.equal(risky.inheritedRisk?.draftId, bounce!.id);
      assert.equal(draftState(risky), 'unconfirmed');

      await h.turn(rounds([text('>>>skip_reply {{unsent}}'), explicitSend('s4')]));
      assert.equal(draftState(h.store().get('scout', bounce!.id)!), 'dismissed', 'a send withholds speech, not the dismissal');
      assert.ok(h.drafts().every((d) => !d.text.includes('{{unsent}}')), 'no draft holds the literal token');
      assert.deepEqual(h.publishes().map((p) => p.text).filter((t) => t !== 'an explicit note elsewhere'), ['lost words'],
        'only the live {{unsent}} went out');
    } finally {
      await h.close();
    }
  });

  it('the turn-end receipt reports each draft as it stands: resent, dismissed, unconfirmed or still held', async () => {
    const h = await harness();
    try {
      const ids = ['d-rcpta', 'd-rcptb', 'd-rcptc', 'd-rcptd', 'd-rcpte'];
      fixIds(h, ids);
      await h.turn([
        createMockResponse([text('resend me'), explicitSend('s1'), text('dismiss me'), call('l1', 'channel_list', {}), text('keep me'), call('l2', 'channel_list', {})], 'tool_use'),
        createMockResponse([drafts('r1', { action: 'resend', draftIds: [ids[0]], destination: ROOM })], 'tool_use'),
        createMockResponse([drafts('x1', { action: 'dismiss', draftIds: [ids[1]] })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere', 'resend me']);
      assert.equal(h.texts().find((t) => t.startsWith('[delivered]')),
        `[delivered] plain speech → #room (Guild One) (discord / ${ROOM}) (draft ${ids[0]}, by your resend) · ` +
        `1 plain-speech segment(s) held as draft ${ids[2]} (not sent — drafts can resend them unchanged, or dismiss them) · ` +
        `draft ${ids[1]} dismissed by you`);

      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([
        createMockResponse([text('uncertain words'), explicitSend('s2')], 'tool_use'),
        createMockResponse([drafts('r2', { action: 'resend', draftIds: [ids[3]], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.match(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1)!, new RegExp(
        `^\\[delivered\\] nothing confirmed — draft ${ids[3]} is unconfirmed: ${ids[3]}'s attempt to #room \\(Guild One\\) \\(discord / ${ROOM}\\) at .+ ` +
        'may already have been posted: .+ — check that channel before sending it again \\(resend needs confirmDuplicate: true\\)$'));

      // Dismissed knowingly after an unknown resend: the dismissal sets it
      // aside, and the receipt still says its attempt may have been posted.
      await h.turn([
        createMockResponse([text('dismissed after doubt'), explicitSend('s3')], 'tool_use'),
        createMockResponse([drafts('r3', { action: 'resend', draftIds: [ids[4]], destination: ROOM })], 'tool_use'),
        createMockResponse([drafts('x2', { action: 'dismiss', draftIds: [ids[4]] })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.match(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1)!, new RegExp(
        `^\\[delivered\\] nothing confirmed — draft ${ids[4]} dismissed by you, but ${ids[4]}'s attempt to #room \\(Guild One\\) \\(.*${ROOM}\\) at .+ ` +
        'may already have been posted: .+$'));
    } finally {
      await h.close();
    }
  });

  it('hybrid: a held round starts from the state earlier rounds leave, even while an earlier delivery is still in flight', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    let release: (() => void) | undefined;
    try {
      // Round 1's delivery blocks; its `>>>skip_reply` waits behind it on the
      // speech chain. Round 2's held prose must not run ahead of it.
      const registry = (h.framework as unknown as { channelRegistry: { deliverSpeech: (...args: unknown[]) => Promise<unknown> } }).channelRegistry;
      const deliver = registry.deliverSpeech.bind(registry);
      let entered = false;
      registry.deliverSpeech = async (...args: unknown[]) => {
        if (args[1] === 'slow prior') {
          entered = true;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return deliver(...args);
      };
      const running = h.turn(rounds(
        [text(`>>>${ROOM} slow prior\n>>>skip_reply private aside`), call('l1', 'channel_list', {})],
        [text('later private prose'), explicitSend('s1')],
      ));
      await h.until(() => entered && (h.membrane.lastStream?.receivedToolResults.length ?? 0) >= 2, 'both rounds while the delivery is blocked');
      assert.deepEqual(h.drafts(), [], 'the held round waits for the earlier private transition');
      release!();
      await running;
      assert.deepEqual(h.drafts(), [], 'the later prose stayed private');
      assert.deepEqual(h.publishes().map((p) => p.text).sort(), ['an explicit note elsewhere', 'slow prior']);
      assert.match(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1)!, /1 plain-speech segment\(s\) kept private/);
    } finally {
      release?.();
      await h.close();
    }
  });

  it('hybrid: the held-draft notice gives a copied, possibly-posted draft its risk and the confirmation it needs', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      const original = h.store().hold('scout', [{ text: 'possibly sent', source }], 'bounced').held[0]!;
      h.store().beginAttempt('scout', original.id, dest(), 'unsent-token', false); // its outcome never recorded
      await h.turn(rounds([text(`plain words\n>>>${ROOM} {{unsent}} and a new line`), explicitSend('s1')]));
      const free = h.drafts().find((d) => d.text === 'plain words')!;
      const copy = h.drafts().find((d) => d.text === 'possibly sent and a new line')!;
      assert.equal(draftState(free), 'held');
      assert.equal(draftState(copy), 'unconfirmed');
      const notice = h.messages().find((m) => (m.metadata as { kind?: string; draftIds?: string[] } | undefined)?.kind === 'prose-drafts'
        && (m.metadata as { draftIds?: string[] }).draftIds?.includes(copy.id))!;
      const words = notice.content.map((b) => (b as { text?: string }).text ?? '').join('');
      assert.ok(words.startsWith(`[drafts] scout: 2 plain-speech segments held as drafts ${free.id}, ${copy.id} — `), `no "not sent" over words that may be out: ${words}`);
      assert.ok(words.includes(`drafts(action: "resend", draftIds: ["${free.id}"], destination: "#channel") delivers it unchanged`), words);
      assert.ok(words.includes(`${copy.id} includes the words of ${original.id}, and ${original.id}'s attempt to #room (Guild One) (discord / ${ROOM})`), words);
      assert.ok(words.includes(`so check that channel before resending ${copy.id} (drafts(action: "resend", draftIds: ["${copy.id}"], destination: "#channel", confirmDuplicate: true))`), words);
      assert.ok(!words.includes(`draftIds: ["${free.id}", "${copy.id}"], destination`), 'no plain resend offered for the copy');
    } finally {
      await h.close();
    }
  });

  it('XML tool mode: runs around a refused attempt are held with their edge whitespace and resent exactly', async () => {
    const h = await harness({ xml: true });
    try {
      const before = '    before\n';
      const after = '\n after  ';
      const round = [text(before), explicitSend('s1')];
      await h.turn([
        createMockResponse(round, 'tool_use'),
        {
          ...createMockResponse([
            ...round,
            { type: 'tool_attempt', rawXml: '<invoke name="missing">' } as unknown as ContentBlock,
            { type: 'tool_notice', notices: [] } as unknown as ContentBlock,
            text(after),
          ]),
          toolCalls: [],
        },
      ]);
      const held = h.drafts().reverse();
      assert.deepEqual(held.map((d) => d.text), [before, after]);
      await h.turn([
        createMockResponse([drafts('r1', { action: 'resend', draftIds: held.map((d) => d.id), destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().slice(-2).map((p) => p.text), [before, after]);
    } finally {
      await h.close();
    }
  });

  it('XML tool mode: the same-round think policy is native-only, so prose beside think and a send is held like any other', async () => {
    const h = await harness({ xml: true, agents: [{ name: 'scout', sameRoundThinkTextPolicy: 'private' }] });
    try {
      const round = [text('Prose beside think.'), call('t1', 'think', { content: 'hmm' }), explicitSend('s1')];
      await h.turn([
        createMockResponse(round, 'tool_use'),
        { ...createMockResponse(round), toolCalls: [] },
      ]);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]), [['Prose beside think.', 'explicit-send']]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere']);
    } finally {
      await h.close();
    }
  });

  for (const mode of ['locus', 'hybrid'] as const) {
    it(`${mode}: prose around an all-refused XML attempt posts as two messages`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        await h.turn([createMockResponse([
          text('Before the attempt.'),
          { type: 'tool_attempt', rawXml: '<invoke name="send_message"><parameter name="x">' } as unknown as ContentBlock,
          { type: 'tool_notice', notices: [{ ordinal: 0, kind: 'refused', message: 'boundary' }] } as unknown as ContentBlock,
          text('After its notice.'),
        ])]);
        assert.deepEqual(h.publishes().map((p) => p.text), ['Before the attempt.', 'After its notice.']);
      } finally {
        await h.close();
      }
    });
  }
});
