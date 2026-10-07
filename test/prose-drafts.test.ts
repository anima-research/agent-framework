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
      assert.ok(read!.endsWith(`exactly as written):\n${segments[1]}`), `read shows the text in full: ${read}`);
      assert.match(resend!, new RegExp(`${ids[0]}: delivered to #room \\(Guild One\\) \\(${ROOM}\\), message posted-2`));
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
      assert.match(h.toolResults()[0]!, /not sent to .* Nothing was posted; the draft stays held/);
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
      assert.match(receipt!, new RegExp(`${deliver!.id}: delivered — confirmed at .* to #room \\(Guild One\\) \\(${ROOM}\\), message posted-\\d+ .*not sent again`));
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

  it('a draft held in a turn that crashed is named by the next turn\'s catch-up notice', async () => {
    const h = await harness();
    try {
      // Held directly, as if the turn that held it died before its receipt.
      h.store().hold('scout', [{ text: 'orphaned words', source }], 'explicit-send');
      await h.turn([createMockResponse([])]);
      const notice = h.texts().find((t) => t.startsWith('[drafts]'))!;
      assert.match(notice, /^\[drafts\] scout: a held draft of yours has not been named to you yet: d-[a-z2-9]{5} .*"orphaned words"/);
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
      assert.match(second!, /is being sent right now; wait for that result/);
      assert.equal(h.publishes().filter((p) => p.text === 'once only').length, 1);
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
