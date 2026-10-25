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
      const { held } = drafts.hold('a', [{ text: ' one\n' }, { text: 'two  ' }], 'explicit-send');
      assert.equal(held.length, 2);
      assert.match(held[0]!.id, /^d-[a-z2-9]{7}$/);
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

  it("the drafts tool's example id has the form newId issues", () => {
    const tool = (AgentFramework as unknown as {
      DRAFTS_TOOL: { inputSchema: { properties: { draftIds: { description: string } } } };
    }).DRAFTS_TOOL;
    const example = /"(d-[^"]*)"/.exec(tool.inputSchema.properties.draftIds.description)?.[1];
    assert.match(example ?? '(none)', /^d-[a-z2-9]{7}$/);
  });

  it('replays the journal at reopen: an attempt with no recorded outcome reads as unconfirmed', () => {
    const { dir, store, drafts } = open();
    const path = join(dir, 'store');
    const { held } = drafts.hold('a', [{ text: 'words' }, { text: 'more' }], 'explicit-send');
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
      const { held } = drafts.hold('a', [{ text: 'kept' }, { text: 'set aside' }], 'explicit-send');
      const attempt = drafts.beginAttempt('a', held[0]!.id, dest(), 'resend', false);
      drafts.recordOutcome('a', held[0]!.id, attempt, { status: 'delivered', at: 7, destination: dest() });
      drafts.dismiss('a', held[1]!.id);
      store.createBranch('elsewhere', main);
      store.switchBranch('elsewhere');
      drafts.reload();
      assert.equal(draftState(drafts.get('a', held[0]!.id)!), 'delivered', 'a delivered draft stays delivered');
      assert.equal(draftState(drafts.get('a', held[1]!.id)!), 'dismissed', 'a dismissed draft stays dismissed');
      const later = drafts.hold('a', [{ text: 'held on another branch' }], 'explicit-send').held[0]!;
      store.switchBranch(main);
      drafts.reload();
      assert.equal(draftState(drafts.get('a', later.id)!), 'held', 'a draft is usable from any branch');
      assert.equal(store.getRecordIdsByType(PROSE_DRAFT_RECORD_TYPE).length, 6);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports words it could not hold, and stays consistent with its journal', (t) => {
    const { dir, store, drafts } = open();
    try {
      const real = store.sync.bind(store);
      let fail = true;
      (store as unknown as { sync: () => void }).sync = () => { if (fail) throw new Error('EIO'); real(); };
      t.mock.method(console, 'error', () => {});
      const result = drafts.hold('a', [{ text: 'x' }, { text: 'y' }], 'explicit-send');
      // The first record reached the store before its barrier failed: the
      // journal was reconciled, so the projection holds it, and so does the
      // answer. Only the second is reported not held.
      assert.deepEqual(result.held.map((d) => d.text), ['x']);
      assert.deepEqual(result.notHeld, { count: 1, error: 'EIO' });
      assert.deepEqual(drafts.open('a').map((d) => d.text), ['x']);
      fail = false;
      assert.equal(drafts.hold('a', [{ text: 'z' }], 'explicit-send').held.length, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a draft counts as named while a message that named it is on the branch, newest first', () => {
    const { dir, store, drafts } = open();
    try {
      const { held } = drafts.hold('a', [{ text: 'one' }, { text: 'two' }, { text: 'three' }], 'explicit-send');
      const [one, two, three] = held;
      drafts.markNoticed('a', [one!.id, two!.id], 'm-1');
      drafts.markNoticed('a', [two!.id], 'm-2');
      const unnamed = (present: string[]) => drafts.unnoticed('a', (id) => present.includes(id)).map((d) => d.text);
      assert.deepEqual(unnamed(['m-1', 'm-2']), ['three'], 'only the draft no notice named');
      assert.deepEqual(unnamed(['m-2']), ['three', 'one'], 'm-1 rolled away: one is unnamed, two is still named by m-2; newest first');
      assert.deepEqual(unnamed([]), ['three', 'two', 'one']);
      assert.deepEqual(drafts.get('a', three!.id)!.noticedIn, undefined);
      // The record outlives a reopen; one written without a message id (an
      // older build's) names nothing, so its draft is named once more.
      store.appendJson(PROSE_DRAFT_RECORD_TYPE, { op: 'noticed', agent: 'a', ids: [three!.id], at: 1 });
      const again = new ProseDraftStore(store);
      assert.deepEqual(again.unnoticed('a', (id) => id === 'm-2').map((d) => d.text), ['three', 'one']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checkpoints what it keeps: the newest drafts, recent ones, and the latest bounce as {{unsent}} means it', (t) => {
    const { dir, store } = open();
    const path = join(dir, 'store');
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const hour = 60 * 60 * 1000;
    const retention = { keepNewest: 2, keepIdleMs: hour, checkpointEvery: 9 };
    let drafts = new ProseDraftStore(store, retention);
    try {
      const [older] = drafts.hold('a', [{ text: 'an older bounce' }], 'bounced').held;
      const [latest] = drafts.hold('a', [{ text: 'the latest bounce' }], 'bounced').held;
      const [settled] = drafts.hold('a', [{ text: 'resent long ago' }], 'explicit-send').held;
      const attempt = drafts.beginAttempt('a', settled!.id, dest(), 'resend', false);
      drafts.recordOutcome('a', settled!.id, attempt, { status: 'delivered', messageId: 'm-1', at: Date.now(), destination: dest() });
      drafts.hold('b', [{ text: "another resident's" }], 'explicit-send');
      t.mock.timers.tick(2 * hour);
      // Something happens to the older bounce now: it isn't idle.
      drafts.beginAttempt('a', older!.id, dest(), 'resend', false);
      const newest = drafts.hold('a', [{ text: 'new one' }, { text: 'new two' }], 'explicit-send').held;
      // That was the ninth entry: the checkpoint let go of 'a''s idle
      // drafts outside its two newest, the latest bounce among them.
      const kept = () => drafts.open('a').map((d) => d.text);
      assert.deepEqual(kept(), ['new two', 'new one', 'an older bounce']);
      assert.equal(drafts.get('a', settled!.id), undefined, 'a settled, idle draft is let go');
      assert.equal(drafts.get('a', latest!.id), undefined);
      assert.equal(drafts.latestBounce('a'), undefined, 'the latest bounce was let go: {{unsent}} has nothing, though an older bounce is kept');
      assert.deepEqual(drafts.open('b').map((d) => d.text), ["another resident's"], 'within its resident\'s newest');
      assert.equal(store.getRecordIdsByType(`${PROSE_DRAFT_RECORD_TYPE}/checkpoint`).length, 1);
      // A reopen reads the checkpoint and the entries after it, and gets the same.
      drafts.markNoticed('a', [newest[0]!.id], 'm-9');
      store.close();
      const reopened = JsStore.openOrCreate({ path });
      try {
        drafts = new ProseDraftStore(reopened, retention);
        assert.deepEqual(kept(), ['new two', 'new one', 'an older bounce']);
        assert.equal(drafts.latestBounce('a'), undefined);
        assert.deepEqual(drafts.get('a', newest[0]!.id)!.noticedIn, ['m-9']);
        assert.equal(draftState(drafts.get('a', older!.id)!), 'unconfirmed', 'its attempt survives the checkpoint');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a notice only after the history holding it is synced (afterCommittedState)', () => {
    const { dir, store, drafts } = open();
    try {
      const { held } = drafts.hold('a', [{ text: 'x' }], 'explicit-send');
      const calls: string[] = [];
      const real = { sync: store.sync.bind(store), appendJson: store.appendJson.bind(store) };
      (store as unknown as { sync: () => void }).sync = () => { calls.push('sync'); real.sync(); };
      (store as unknown as { appendJson: (t: string, p: unknown) => unknown }).appendJson = (t, p) => { calls.push(`append:${t}`); return real.appendJson(t, p); };
      drafts.markNoticed('a', [held[0]!.id], 'm-1');
      assert.deepEqual(calls, ['sync', `append:${PROSE_DRAFT_RECORD_TYPE}`, 'sync']);
      assert.deepEqual(drafts.get('a', held[0]!.id)!.noticedIn, ['m-1']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an inherited duplication risk keeps a draft unconfirmed until a confirmed delivery', () => {
    const { dir, store, drafts } = open();
    try {
      const risky = { draftId: 'd-zzzzz', destination: dest(), at: 1, reason: 'no valid receipt' };
      const [copy] = drafts.hold('a', [{ text: 'risky words and more', inheritedRisk: risky }], 'bounced').held;
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
      const first = drafts.hold('a', [{ text: 'first' }], 'bounced').held[0]!;
      const second = drafts.hold('a', [{ text: 'second' }], 'bounced').held[0]!;
      drafts.hold('a', [{ text: 'not a bounce' }], 'explicit-send');
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
  /** The fixture server's requestTimeoutMs (the framework's default when unset). */
  requestTimeoutMs?: number;
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
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
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
    turn: async (responses: Array<ReturnType<typeof createMockResponse>>, agentName = 'scout', via: 'incoming' | 'request' | 'silent' = 'incoming') => {
      for (const r of responses) membrane.pushResponse(r);
      const before = membrane.calls.length;
      if (via === 'incoming') {
        h.command({ op: 'incoming', channelId: ROOM, messageId: `in-${++incoming}`, mode: 'addressed', text: `message ${incoming}` });
      } else {
        // 'silent': a control-plane wake whose plain prose stays private, as
        // a silent heartbeat's does.
        (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
          agentName, reason: 'test', source: 'test', timestamp: Date.now(),
          ...(via === 'silent' ? { suppressProse: true } : {}),
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
      // Round 2 called nothing that sends: its draft was held by round 1's
      // send, and its own notice names that cause.
      const secondNotice = msgs.find((m) => {
        const meta = m.metadata as { kind?: string; draftIds?: string[] } | undefined;
        return meta?.kind === 'prose-drafts' && meta.draftIds?.includes(ids[1]!) === true;
      });
      assert.ok(secondNotice, 'a notice names the second round\'s draft');
      const secondText = secondNotice!.content.map((b) => (b as { text?: string }).text ?? '').join('');
      assert.ok(secondText.includes(`held as draft ${ids[1]} because you made an explicit send in this round or an earlier one this turn. `),
        `the later round's notice gives the earlier send as the cause: ${secondText}`);
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
      // Round 2's draft gives the cause its notice gave wherever it's shown.
      const secondLine = list!.split('\n').find((l) => l.includes(`${ids[1]} · `));
      assert.ok(secondLine?.includes(' · explicit send in its turn · '), `the listing gives the turn's send as the reason: ${list}`);
      assert.ok(read!.includes(`${ids[1]} — held; held `) && read!.includes('(an explicit send in its round or an earlier one of its turn held it back)'),
        `read gives the same cause: ${read}`);
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
      assert.ok(h.texts().some((t) => t === '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply or a private think)'));
      await h.turn([
        createMockResponse([text('Prose beside a private think.'), call('t1', 'think', { thought: 'hmm' }), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.drafts(), [], 'a same-round private think keeps its prose private, even beside a send');
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere']);
      assert.equal(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1),
        '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply or a private think)',
        'the receipt counts it, and says a private think may be why');
    } finally {
      await h.close();
    }
  });

  for (const xml of [false, true]) {
    it(`${xml ? 'XML tool mode' : 'native tool mode'}: a refused wake keeps only its own round private, so a later send's prose is held as drafts`, async () => {
      // With no EventGate, skip_reply's wake_in_seconds is refused and the
      // turn goes on: the silence before the refusal comes back at the next
      // round, with why it silences, so the send's round is an explicit send's.
      const h = await harness({ xml });
      try {
        const wake = call('w1', 'skip_reply', { reason: 'later', wake_in_seconds: 60 });
        const done = (id: string) => ({ type: 'tool_result', toolUseId: id, content: 'done', isError: false }) as ContentBlock;
        await h.turn([
          createMockResponse([text('Private, beside the refused wake.'), wake], 'tool_use'),
          createMockResponse([text('Beside the send.'), explicitSend('s1')], 'tool_use'),
          // XML mode completes with the turn's whole content, as membrane
          // parses it: each round's calls and then their results.
          xml
            ? { ...createMockResponse([text('Private, beside the refused wake.'), wake, done('w1'), text('Beside the send.'), explicitSend('s1'), done('s1'), text('After the send.')]), toolCalls: [] }
            : createMockResponse([text('After the send.')]),
        ]);
        assert.match(h.toolResults()[0]!, /no wake was set/, 'the wake was refused, and the turn went on');
        assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere'], 'only the explicit send went out');
        const held = h.drafts().reverse();
        assert.deepEqual(held.map((d) => d.text), ['Beside the send.', 'After the send.'],
          'the refused round stays private; the send\'s rounds are held, not kept private');
        assert.ok(held.every((d) => d.reason === 'explicit-send'));
        assert.ok(h.texts().some((t) => t.startsWith('[delivered] nothing — 2 plain-speech segment(s) held as drafts ')));
      } finally {
        await h.close();
      }
    });
  }

  it("native tool mode: beside a refused wake, a module's skip_reply after a send keeps the later prose private", async () => {
    // An unrefused plain skip_reply ends the turn, so the saved silence's
    // 'private' over 'send' decides something only for a call whose bare name
    // is skip_reply but whose full name isn't, here one named like a module's
    // tool: it silences by that name, as main reads any `--skip_reply`, and
    // neither ends the turn nor is refused. In XML tool mode the turn-end scan
    // reads the whole turn's calls, so this case doesn't turn on the saved
    // silence there.
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('Beside the send.'), explicitSend('s1')], 'tool_use'),
        createMockResponse([
          text('Private, beside the refused wake.'),
          call('w1', 'skip_reply', { reason: 'later', wake_in_seconds: 60 }),
          call('m1', 'tools--skip_reply', {}),
        ], 'tool_use'),
        createMockResponse([text('After the wake.')]),
      ]);
      assert.ok(h.toolResults().some((r) => /no wake was set/.test(r)), 'the wake was refused, and the turn went on');
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere'], 'only the explicit send went out');
      const held = h.drafts();
      assert.deepEqual(held.map((d) => d.text), ['Beside the send.'], "only the send's own round is held");
      assert.equal(h.texts().find((t) => t.startsWith('[delivered]')),
        `[delivered] nothing — 1 plain-speech segment(s) held as draft ${held[0]!.id} (not sent — drafts can resend them unchanged, or dismiss them) · 2 plain-speech segment(s) kept private (skip_reply or a private think)`,
        'the refused round and the round after it stay private');
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
      assert.ok(h.texts().some((t) => t.startsWith('[delivered] plain speech → no channel — 2 plain-speech segment(s) kept in the transcript (proseRouting=disabled')));
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
      const held = h.texts('scout').find((t) => t.startsWith('[drafts] scout: '));
      assert.ok(held);
      assert.ok(held!.startsWith(`[drafts] scout: your plain-speech message (11 chars) was not sent and is instead held as draft ` +
        `${mine.id} because you made an explicit send in this round or an earlier one this turn. `),
        `the held-draft notice names the message and why it was held: ${held}`);
      assert.ok(!held!.includes('scout words'), `the held-draft notice quotes none of the draft's words: ${held}`);
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
      assert.match(h.toolResults()[0]!, /may already have been posted: .*, so sending it again could post it twice\. To send it anyway, resend with confirmDuplicate: true\. Nothing was sent/);
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

  it('through the real connection, an error response is unconfirmed, with the connector\'s words', async () => {
    const h = await harness();
    try {
      h.command({ op: 'publish-mode', mode: 'error' });
      await h.turn([createMockResponse([text('words into a failing connector')])]);
      assert.equal(h.publishes().filter((p) => p.event === 'publish-error').length, 1, 'the request reached the server');
      await h.until(() => h.texts().some((t) => t.startsWith('[discord-send-failed]')), 'the marker');
      const marker = h.texts().find((t) => t.startsWith('[discord-send-failed]'))!;
      assert.match(marker, /was not confirmed \(.*connector exploded.*\(delivery uncertain\)\)\. It may or may not have been posted, so sending it again could post it twice/);
      // A resend of a held draft records the same outcome.
      await h.turn([
        createMockResponse([text('held beside a send'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      await h.turn([
        createMockResponse([drafts('r1', { action: 'resend', draftIds: [draft!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      const [attempt] = h.store().get('scout', draft!.id)!.attempts;
      assert.equal(attempt!.outcome?.status, 'unknown');
      assert.match(attempt!.outcome!.reason!, /connector exploded/);
      assert.equal(draftState(h.store().get('scout', draft!.id)!), 'unconfirmed');
    } finally {
      await h.close();
    }
  });

  it('through the real connection, failed locus speech keeps its failure marker, since nothing holds it', async () => {
    const h = await harness();
    try {
      h.command({ op: 'publish-mode', mode: 'not-delivered' });
      await h.turn([createMockResponse([text('words a refusing connector drops')])]);
      await h.until(() => h.texts().some((t) => t.startsWith('[discord-send-failed]')), 'the marker');
      const marker = h.texts().find((t) => t.startsWith('[discord-send-failed]'))!;
      assert.match(marker, /could not be delivered to .* Nothing was posted/);
      assert.deepEqual(h.drafts(), [], 'locus speech is not held');
    } finally {
      await h.close();
    }
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
    it('through the real connection, failed ' + mode + ' speech is held as a bounce draft with one notice, not a second marker', async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        h.command({ op: 'publish-mode', mode: 'not-delivered' });
        await h.turn([createMockResponse([text((mode === 'explicit' ? '>>' : '>>>') + ROOM + ' refused words')])]);
        assert.deepEqual(h.publishes().map((p) => p.text), ['refused words']);
        const [draft] = h.drafts();
        assert.ok(draft, 'the words are held');
        assert.equal(draft!.text, 'refused words');
        assert.ok(h.texts().some((t) => t.startsWith('[prose-routing]') && t.includes(`It is held as draft ${draft!.id}`)), 'the bounce notice names it');
        assert.deepEqual(h.texts().filter((t) => t.startsWith('[discord-send-failed]')), [], 'no second notice for the same failure');
      } finally {
        await h.close();
      }
    });
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    it('through the real connection, unknown ' + mode + ' speech is marked but not held for an ordinary resend', async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        h.command({ op: 'publish-mode', mode: 'no-receipt' });
        await h.turn([createMockResponse([text((mode === 'explicit' ? '>>' : '>>>') + ROOM + ' uncertain words')])]);
        assert.deepEqual(h.publishes().map((p) => p.text), ['uncertain words'], 'one request may already have posted');
        assert.deepEqual(h.drafts(), [], 'uncertainty is not a fresh resendable bounce');
        const markers = h.texts().filter((t) => t.startsWith('[discord-send-failed]'));
        assert.equal(markers.length, 1);
        assert.match(markers[0]!, /was not confirmed.*may or may not have been posted/);
        assert.ok(!h.messages().some((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce'), 'no bounce notice offers a retry');
      } finally {
        await h.close();
      }
    });
  }

  for (const privateThink of [false, true]) {
    it('hybrid skip_reply unsent ' + (privateThink ? 'stays uninterpreted beside a private think' : 'dismisses the bounce while keeping the round private'), async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid', sameRoundThinkTextPolicy: 'private' }] });
      try {
        const original = h.store().hold('scout', [{ text: 'held bounce' }], 'bounced').held[0]!;
        assert.equal(draftState(original), 'held');
        const blocks = [text('>>>skip_reply {{unsent}}'), call('skip1', 'skip_reply', {})];
        if (privateThink) blocks.push(call('think1', 'think', { thought: 'private reasoning' }));
        await h.turn([createMockResponse(blocks, 'tool_use'), createMockResponse([])]);
        assert.equal(draftState(h.store().get('scout', original.id)!), privateThink ? 'held' : 'dismissed');
        assert.deepEqual(h.publishes(), [], 'deliberate privacy posts nothing');
        assert.equal(h.store().open('scout').length, privateThink ? 1 : 0, 'no fresh draft was made from private words');
      } finally {
        await h.close();
      }
    });
  }

  it('an empty completion waits for earlier queued speech and holds before writing their receipt', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    let release: (() => void) | undefined;
    try {
      const registry = (h.framework as unknown as { channelRegistry: { deliverSpeech: (...args: unknown[]) => Promise<unknown> } }).channelRegistry;
      const deliver = registry.deliverSpeech.bind(registry);
      let entered = false;
      registry.deliverSpeech = async (...args: unknown[]) => {
        if (args[1] === 'slow queued words') {
          entered = true;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return deliver(...args);
      };
      // Deliberately not rounds(): the last response has no prior content.
      const running = h.turn([
        createMockResponse([text('>>>' + ROOM + ' slow queued words'), call('list1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text('held behind the slow delivery'), explicitSend('send1')], 'tool_use'),
        createMockResponse([]),
      ]);
      await h.until(() => entered && (h.membrane.lastStream?.receivedToolResults.length ?? 0) >= 2, 'both tool rounds behind the pending delivery');
      assert.deepEqual(h.drafts(), [], 'the hold is still queued');
      release!();
      await running;
      await h.until(() => h.publishes().some((p) => p.text === 'slow queued words') && h.drafts().length === 1, 'the earlier delivery and queued hold');
      const draft = h.drafts()[0]!;
      assert.equal(draft.text, 'held behind the slow delivery');
      const receipt = h.texts().find((t) => t.startsWith('[delivered]'));
      assert.ok(receipt, 'the completed turn receipts the queued work');
      assert.ok(receipt.includes(ROOM), 'the delayed delivery is in the receipt');
      assert.ok(receipt.includes(draft.id), 'so is the hold settled behind it');
    } finally {
      release?.();
      await h.close();
    }
  });

  it('through the real connection, a server that never answers is unconfirmed once the request times out', async () => {
    const h = await harness({ requestTimeoutMs: 1_000 });
    try {
      h.command({ op: 'publish-mode', mode: 'hang' });
      await h.turn([createMockResponse([text('words into silence')])]);
      await h.until(() => h.texts().some((t) => t.startsWith('[discord-send-failed]')), 'the marker');
      assert.equal(h.publishes().length, 0);
      const marker = h.texts().find((t) => t.startsWith('[discord-send-failed]'))!;
      assert.match(marker, /was not confirmed \(The "discord" server didn't answer within 1 second, so whether the request took effect is unknown: .*may do it twice \(delivery uncertain\)\)\. It may or may not have been posted/);
    } finally {
      await h.close();
    }
  });

  it("a silent turn's prose stays private beside a send: never held, named or receipted", async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('private narration'), explicitSend('s1')], 'tool_use'),
        createMockResponse([text('more private words')]),
      ], 'scout', 'silent');
      assert.deepEqual(h.drafts(), [], 'nothing was held as a draft');
      assert.ok(!h.texts().some((t) => t.includes('held as draft')), 'and no notice names one');
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note elsewhere'], 'only the explicit send went out');
      assert.ok(!h.texts().some((t) => t.startsWith('[delivered]')), 'a silent turn receives no plain-speech receipt');
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
      assert.match(h.toolResults()[0]!, /Nothing was posted by this attempt\. The draft stays unconfirmed: d-[a-z2-9]{7}'s attempt to .* may already have been posted: .*delivery uncertain/);
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

  it('drafts held in a turn that crashed are named by the next turn\'s catch-up notice, each by its actual state', async () => {
    const h = await harness();
    try {
      // Held directly, as if the turn that held it died before its receipt;
      // the second also died mid-send, its attempt never resolved.
      h.store().hold('scout', [{ text: 'orphaned words' }], 'explicit-send');
      const midSend = h.store().hold('scout', [{ text: 'half-sent words' }], 'explicit-send').held[0]!;
      h.store().beginAttempt('scout', midSend.id, dest(), 'resend', false);
      await h.turn([createMockResponse([])]);
      const notice = h.texts().find((t) => t.startsWith('[drafts]'))!;
      assert.match(notice, /^\[drafts\] scout: 2 open drafts of yours that no recent notice on this branch names: /);
      assert.match(notice, /d-[a-z2-9]{7} \(held \(not sent\); explicit send in its turn\)/);
      assert.match(notice, new RegExp(`${midSend.id} \\(UNCONFIRMED — an attempt to #room \\(Guild One\\) \\(${ROOM}\\) at .* may have been posted; .*explicit send in its turn\\)`));
      assert.doesNotMatch(notice, /They were not sent/);
      assert.ok(!notice.includes('orphaned words') && !notice.includes('half-sent words'), `the notice quotes no draft's words: ${notice}`);
      await h.turn([createMockResponse([])]);
      assert.equal(h.texts().filter((t) => t.startsWith('[drafts]')).length, 1, 'named once');
    } finally {
      await h.close();
    }
  });

  it('the catch-up names every draft it marks: the newest eight with their state, the rest by id, and no words', async () => {
    const h = await harness();
    try {
      const held = Array.from({ length: 10 }, (_, i) => h.store().hold('scout', [{ text: `orphan ${i}` }], 'explicit-send').held[0]!);
      await h.turn([createMockResponse([])]);
      const notice = h.texts().find((t) => t.startsWith('[drafts]'))!;
      assert.match(notice, /^\[drafts\] scout: 10 open drafts of yours that no recent notice on this branch names: /);
      // Newest first: the eight newest with their state, then the two oldest
      // by id alone. No draft's words appear.
      const named = [...notice.matchAll(/(d-[a-z2-9]{7}) \(held \(not sent\); explicit send in its turn\)/g)].map((m) => m[1]);
      assert.deepEqual(named, [9, 8, 7, 6, 5, 4, 3, 2].map((i) => held[i]!.id));
      assert.ok(notice.includes(` · and 2 more: ${held[1]!.id}, ${held[0]!.id}.`), notice);
      assert.ok(!/orphan \d/.test(notice), `the notice quotes no draft's words: ${notice}`);
      await h.turn([createMockResponse([])]);
      assert.equal(h.texts().filter((t) => t.startsWith('[drafts]')).length, 1, 'all ten named, so none is named again');
    } finally {
      await h.close();
    }
  });

  it('a rollback past the notice that named a draft names it again at the next turn, once', async () => {
    const h = await harness();
    try {
      await h.turn([createMockResponse([text('hello')])]);
      const anchor = h.messages().at(-1)!.id;
      await h.turn([
        createMockResponse([text('words a send held back'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      assert.ok(h.texts().some((t) => t.includes(`held as draft ${draft!.id}`)), 'the turn-end receipt names it');
      const catchUps = () => h.texts().filter((t) => t.includes('that no recent notice on this branch names'));
      assert.deepEqual(catchUps(), []);
      // The rollback takes the turn, and its notices, off the branch; the
      // draft stays, as drafts do.
      await h.framework.rollbackToMessage('scout', { messageId: anchor });
      assert.ok(!h.texts().some((t) => t.includes(draft!.id)), 'nothing on the branch names it now');
      await h.turn([createMockResponse([])]);
      assert.equal(catchUps().length, 1);
      assert.match(catchUps()[0]!, new RegExp(`an open draft of yours that no recent notice on this branch names: ${draft!.id} \\(held \\(not sent\\); explicit send in its turn\\)`));
      assert.ok(!catchUps()[0]!.includes('words a send held back'), "the notice quotes none of the draft's words");
      await h.turn([createMockResponse([])]);
      assert.equal(catchUps().length, 1, 'named once on this branch');
    } finally {
      await h.close();
    }
  });

  /** Make the store's sync fail once, right after a draft outcome record
   *  reaches it: the record lands, its write fails, and the journal is
   *  reconciled with it in. */
  const failOutcomeSyncOnce = (h: Awaited<ReturnType<typeof harness>>) => {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const real = { appendJson: store.appendJson.bind(store), sync: store.sync.bind(store) };
    let armed = false;
    let spent = false;
    (store as unknown as { appendJson: (t: string, p: unknown) => unknown }).appendJson = (t, p) => {
      const ref = real.appendJson(t, p);
      if (!spent && t === PROSE_DRAFT_RECORD_TYPE && (p as { op?: string }).op === 'outcome') armed = true;
      return ref;
    };
    (store as unknown as { sync: () => void }).sync = () => {
      if (armed && !spent) {
        spent = true;
        throw new Error('EIO after the outcome landed');
      }
      real.sync();
    };
  };

  it('a resend whose outcome record fails after landing reports what the draft reads as now', async (t) => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('words to resend'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      failOutcomeSyncOnce(h);
      t.mock.method(console, 'error', () => {});
      await h.turn([
        createMockResponse([drafts('r1', { action: 'resend', draftIds: [draft!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.match(h.toolResults()[0]!, new RegExp(`${draft!.id}: delivered to .*\\(recording this outcome failed; the draft reads as delivered now\\)\\.`));
      assert.equal(draftState(h.store().get('scout', draft!.id)!), 'delivered');
    } finally {
      await h.close();
    }
  });

  it('an {{unsent}} delivery whose outcome record fails tells the resident what the draft reads as now', async (t) => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      await h.turn([createMockResponse([text('words with nowhere to go')])]);
      const [bounced] = h.drafts();
      failOutcomeSyncOnce(h);
      t.mock.method(console, 'error', () => {});
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}}`)])]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['words with nowhere to go']);
      await h.until(() => h.texts().some((x) => x.includes('but recording that failed')), 'the notice');
      assert.ok(h.texts().some((x) => x === `[prose-routing] {{unsent}} was draft ${bounced!.id}; its send came back delivered, but recording that ` +
        'failed, so the draft reads as delivered now. drafts(action: "read") shows it.'), JSON.stringify(h.texts().filter((x) => x.startsWith('[prose-routing]'))));
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
      assert.ok(h.texts().some((t) => t.includes(`It includes the words of draft ${risky!.id}, which may already have been posted, so ${fresh.id} can be resent only with the drafts tool and confirmDuplicate: true.`)));
      // {{unsent}} now means the fresh draft, and it is refused unconfirmed.
      const before = h.publishes().length;
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}}`)])]);
      assert.equal(h.publishes().length, before, 'neither draft goes out without confirmation');
      assert.ok(h.texts().some((t) => t.startsWith(`[prose-routing] {{unsent}} is draft ${fresh.id}, and ${fresh.id} includes the words of ${risky!.id}`) &&
        t.includes(`Nothing was sent; sending that draft again could post it twice. To send it anyway, use drafts(action: "resend", draftIds: ["${fresh.id}"], destination: "#channel", confirmDuplicate: true).`)));
      await h.turn([createMockResponse([drafts('r1', { action: 'resend', draftIds: [fresh.id], destination: ROOM, confirmDuplicate: true })], 'tool_use'), createMockResponse([])]);
      assert.deepEqual(h.publishes().slice(before).map((p) => p.text), ['risky words and a postscript']);
      assert.equal(draftState(h.store().get('scout', risky!.id)!), 'unconfirmed', 'the original still needs its own confirmation');
    } finally {
      await h.close();
    }
  });

  it('explicit mode: {{unsent}} of a possibly-posted bounce holds the envelope\'s words, with nothing to wait for', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      await h.turn([createMockResponse([text('risky words')])]);
      const [risky] = h.drafts();
      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}}`)])]);
      assert.equal(draftState(h.store().get('scout', risky!.id)!), 'unconfirmed');
      h.command({ op: 'publish-mode', mode: 'delivered' });
      const before = h.publishes().length;
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}} and more`)])]);
      assert.equal(h.publishes().length, before, 'nothing goes out without confirmation');
      const copy = h.drafts().find((d) => d.id !== risky!.id)!;
      assert.equal(copy.text, 'risky words and more');
      // No attempt is out, so the notice gives the copy's condition and no wait.
      const notice = h.texts().find((t) => t.startsWith(`[prose-routing] {{unsent}} is draft ${risky!.id}`))!;
      assert.ok(notice.endsWith(`Your message is held as draft ${copy.id}, with {{unsent}} written out; since it includes ` +
        `${risky!.id}'s words, it can be resent only with confirmDuplicate: true.`), notice);
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
      assert.match(resent!, /NOT confirmed .* Sending it again could post it twice, so a resend needs confirmDuplicate: true/,
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
          drafts('f', { action: 'read', draftIds: [''] }),
        ], 'tool_use'),
        createMockResponse([]),
      ]);
      const [noDest, badDest, unused, unknown, badAction, badIds] = h.toolResults();
      assert.match(noDest!, /resend needs a destination/);
      assert.match(badDest!, /Destination "#nowhere" did not resolve.*Nothing was sent/);
      assert.match(unused!, /draftIds is not used by action "list"/);
      assert.match(unknown!, /No draft of yours with id d-zzzzz/);
      assert.match(badAction!, /action must be one of/);
      assert.match(badIds!, /draftIds must be a list of draft ids such as "d-[a-z2-9]{7}", or null/, 'its example has the form newId issues');
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
        routingOf(name: string): { drafts: unknown[] };
        settleTurnDrafts(agent: unknown, logical: unknown): void;
      };
      const agent = framework.getAgent('scout')!;
      const [named, lost] = internals.proseDrafts.hold('scout', [{ text: 'named' }, { text: 'lost' }], 'explicit-send').held;
      // Only the first draft's notice reached the history.
      const cm = agent.getContextManager();
      const notice = cm.addMessage('user', [{ type: 'text', text: '[drafts] …' }], { system: true, kind: 'prose-drafts', draftOwner: 'scout', draftIds: [named!.id] } as never);
      const logical = internals.routingOf('scout');
      logical.drafts.push(named, lost);
      internals.settleTurnDrafts(agent, logical);
      assert.deepEqual(logical.drafts, [], "the turn's draft tally is spent");
      assert.deepEqual(internals.proseDrafts.get('scout', named!.id)!.noticedIn, [String(notice)], 'recorded with the message that names it');
      assert.equal(internals.proseDrafts.get('scout', lost!.id)!.noticedIn, undefined, 'left for the catch-up');
      const onBranch = (id: string) => cm.getMessage(id as never) !== null;
      assert.deepEqual(internals.proseDrafts.unnoticed('scout', onBranch).map((d) => d.id), [lost!.id]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const catchUpFixture = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prose-drafts-catchup-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    const internals = framework as unknown as {
      proseDrafts: ProseDraftStore;
      routingOf(name: string): { drafts: unknown[] };
      openLogical: Map<string, unknown>;
      noticeUnnoticedDrafts(agent: unknown): void;
    };
    const agent = framework.getAgent('scout')!;
    const cm = agent.getContextManager();
    const catchUps = () => cm.getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
      .filter((t) => t.includes('that no recent notice on this branch names'));
    return { framework, internals, agent, cm, catchUps, close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); } };
  };

  it("the catch-up records a draft a notice already names, rather than naming it again", async () => {
    const t = await catchUpFixture();
    try {
      const [late, lost] = t.internals.proseDrafts.hold('scout', [{ text: 'late' }, { text: 'lost' }], 'bounced').held;
      // A bounce notice reached the history after its turn's drafts were
      // settled, so nothing recorded it.
      const notice = t.cm.addMessage('user', [{ type: 'text', text: '[prose-routing] …' }], { system: true, kind: 'prose-bounce', draftOwner: 'scout', draftIds: [late!.id] } as never);
      t.internals.noticeUnnoticedDrafts(t.agent);
      assert.deepEqual(t.internals.proseDrafts.get('scout', late!.id)!.noticedIn, [String(notice)], 'recorded with the notice that names it');
      const [catchUp] = t.catchUps();
      assert.ok(catchUp?.includes(lost!.id), 'the draft no notice names is named');
      assert.ok(!catchUp!.includes(late!.id), `the one its notice names is not: ${catchUp}`);
    } finally {
      await t.close();
    }
  });

  it('the catch-up reads notices among the newest 500 messages, and names a draft whose only notice is further back', async () => {
    const t = await catchUpFixture();
    try {
      const [old, recent] = t.internals.proseDrafts.hold('scout', [{ text: 'old' }, { text: 'recent' }], 'bounced').held;
      // Neither notice was recorded: one now sits 500 messages back, the
      // other among the newest.
      t.cm.addMessage('user', [{ type: 'text', text: '[prose-routing] …' }], { system: true, kind: 'prose-bounce', draftOwner: 'scout', draftIds: [old!.id] } as never);
      for (let i = 0; i < 500; i++) t.cm.addMessage('user', [{ type: 'text', text: `filler ${i}` }]);
      const notice = t.cm.addMessage('user', [{ type: 'text', text: '[prose-routing] …' }], { system: true, kind: 'prose-bounce', draftOwner: 'scout', draftIds: [recent!.id] } as never);
      t.internals.noticeUnnoticedDrafts(t.agent);
      assert.deepEqual(t.internals.proseDrafts.get('scout', recent!.id)!.noticedIn, [String(notice)], 'the recent notice is found and recorded');
      const [catchUp] = t.catchUps();
      assert.ok(catchUp?.includes(old!.id), `the draft whose notice is past the window is named: ${catchUp}`);
      assert.ok(!catchUp!.includes(recent!.id), 'the recently named one is not');
    } finally {
      await t.close();
    }
  });

  // Arthur-2378's probe: with retention shortened, the journal lets the
  // turn's older draft go before the receipt is written.
  it('the receipt reports a draft that retention let go during the turn as let go, not as held', async (t) => {
    const h = await catchUpFixture();
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const drafts = new ProseDraftStore(h.framework.getStore(), { keepNewest: 1, keepIdleMs: 1, checkpointEvery: 1 });
    const f = h.framework as unknown as {
      proseDrafts: ProseDraftStore;
      holdProseDrafts(agent: unknown, texts: Array<{ text: string }>, reason: string, options: unknown): Array<{ id: string }>;
      appendProseDeliveryReceipt(agent: unknown, routing: unknown): void;
    };
    f.proseDrafts = drafts;
    const routing = h.internals.routingOf('scout');
    try {
      const old = f.holdProseDrafts(h.agent, [{ text: 'earlier words' }], 'explicit-send', { routing, notice: 'later' })[0]!;
      // An attempt whose outcome is unknown (Arthur-2378's second probe): once
      // the draft is let go, nothing says whether it was posted.
      const attempt = drafts.beginAttempt('scout', old.id, dest(), 'resend', false);
      drafts.recordOutcome('scout', old.id, attempt, { status: 'unknown', reason: 'connection lost', at: Date.now(), destination: dest() });
      assert.equal(draftState(drafts.get('scout', old.id)!), 'unconfirmed');
      t.mock.timers.tick(2);
      const newer = f.holdProseDrafts(h.agent, [{ text: 'later words' }], 'explicit-send', { routing, notice: 'later' })[0]!;
      assert.equal(drafts.get('scout', old.id), undefined, 'the journal let the older draft go');
      f.appendProseDeliveryReceipt(h.agent, routing);
      const receipt = h.cm.getAllMessages().flatMap((m) => m.content)
        .filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
        .find((text) => text.startsWith('[delivered]'))!;
      const held = receipt.match(/held as drafts? ([^(]+)\(not sent/)?.[1] ?? '';
      assert.ok(held.includes(newer.id), `the draft still held is reported as held: ${receipt}`);
      assert.ok(!held.includes(old.id), `the let-go draft is not offered as held: ${receipt}`);
      assert.ok(receipt.includes(`draft ${old.id} held this turn and since let go by retention (no longer held, so not resendable)`), receipt);
      assert.ok(receipt.startsWith('[delivered] nothing confirmed —'), `a let-go draft's unknown state makes no claim of non-delivery: ${receipt}`);
    } finally {
      t.mock.timers.reset();
      await h.close();
    }
  });

  it('the held-draft notice names each draft by length and order, gives its reason, and quotes none of its words', async () => {
    const h = await catchUpFixture();
    const f = h.framework as unknown as {
      holdProseDrafts(agent: unknown, texts: Array<{ text: string; note?: string; inheritedRisk?: unknown }>, reason: string,
        options: unknown): Array<{ id: string }>;
    };
    const routing = h.internals.routingOf('scout');
    const notice = (ids: string[]): string => h.cm.getAllMessages()
      .filter((m) => (m.metadata as { kind?: string; draftIds?: string[] } | undefined)?.kind === 'prose-drafts'
        && ids.every((id) => (m.metadata as { draftIds: string[] }).draftIds.includes(id)))
      .flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('');
    const hold = (texts: Array<{ text: string; note?: string; inheritedRisk?: unknown }>, reason: string) => {
      const ids = f.holdProseDrafts(h.agent, texts, reason, { routing, notice: 'now' }).map((d) => d.id);
      const text = notice(ids);
      for (const t of texts) assert.ok(!text.includes(t.text), `no words quoted: ${text}`);
      return { ids, text };
    };
    const sendClause = 'you made an explicit send in this round or an earlier one this turn';
    const failedEnvelope = 'had no destination — after a routing envelope failed, plain speech waits for a new valid target';
    try {
      // A hybrid draft's note (its routing token) is shown neither alone nor among several.
      const one = hold([{ text: 'one two three', note: 'written for >>>#room' }], 'explicit-send');
      const [a] = one.ids;
      assert.equal(one.text, `[drafts] scout: your plain-speech message (13 chars) was not sent and is instead held as draft ${a} because ` +
        `${sendClause}. drafts(action: "resend", draftIds: ["${a}"], destination: "#channel") delivers it unchanged; ` +
        `drafts(action: "dismiss", draftIds: ["${a}"]) sets it aside.`);

      // Every draft's text has a space, so no draft id (d- and seven of [a-z2-9]) can hold it.
      const three = hold([{ text: 'first one' }, { text: 'the second one', note: 'written for >>>#room' }, { text: 'last one' }], 'explicit-send');
      const [b, c, d] = three.ids;
      assert.ok(three.text.startsWith(`[drafts] scout: your 3 plain-speech messages were not sent and are instead held as drafts ` +
        `${b} (9 chars), ${c} (14 chars) and ${d} (8 chars), in the order you wrote them, because ${sendClause}. `),
        three.text);
      assert.ok(!three.text.includes('written for'), `a hybrid draft's note, its routing token, isn't quoted either: ${three.text}`);

      const risky = hold([{ text: 'copied words', inheritedRisk: { draftId: 'd-aaaaaaa', reason: 'connection lost' } }], 'explicit-send');
      assert.ok(risky.text.startsWith(`[drafts] scout: your plain-speech message (12 chars) is held as draft ${risky.ids[0]} because ${sendClause}. `),
        `no "not sent" over words that may be out: ${risky.text}`);

      const lost = hold([{ text: 'nowhere to go' }], 'no-destination');
      assert.ok(lost.text.startsWith(`[drafts] scout: your plain-speech message (13 chars) was not sent and is instead held as draft ` +
        `${lost.ids[0]} because it ${failedEnvelope}. `), lost.text);
    } finally {
      await h.close();
    }
  });

  it('the catch-up leaves out a draft that a notice still waiting to be written names', async () => {
    const t = await catchUpFixture();
    const queue = (t.framework as unknown as { deferredMessages: Array<Record<string, unknown>> }).deferredMessages;
    try {
      const [waiting, lost] = t.internals.proseDrafts.hold('scout', [{ text: 'waiting' }, { text: 'lost' }], 'bounced').held;
      // A bounce notice deferred while a turn is alive: not in the history
      // yet, but on its way.
      queue.push({
        id: 'deferred-notice', seq: 1, participant: 'user',
        content: [{ type: 'text', text: '[prose-routing] …' }],
        metadata: { system: true, kind: 'prose-bounce', draftOwner: 'scout', draftIds: [waiting!.id] },
        forAgent: 'scout',
      });
      t.internals.noticeUnnoticedDrafts(t.agent);
      const [catchUp] = t.catchUps();
      assert.ok(catchUp?.includes(lost!.id), 'the draft no notice names is named');
      assert.ok(!catchUp!.includes(waiting!.id), `the one a waiting notice names is not: ${catchUp}`);
    } finally {
      queue.length = 0;
      await t.close();
    }
  });

  it("the catch-up leaves the open logical turn's own drafts to its receipt", async () => {
    const t = await catchUpFixture();
    try {
      const [own, other] = t.internals.proseDrafts.hold('scout', [{ text: 'own' }, { text: 'other' }], 'explicit-send').held;
      // A later start continues this logical turn, whose receipt names its
      // drafts at the turn's end.
      const logical = t.internals.routingOf('scout');
      logical.drafts.push(own);
      t.internals.openLogical.set('scout', logical);
      t.internals.noticeUnnoticedDrafts(t.agent);
      const [catchUp] = t.catchUps();
      assert.ok(catchUp?.includes(other!.id), "another turn's unnamed draft is named");
      assert.ok(!catchUp!.includes(own!.id), `the open turn's own draft is not: ${catchUp}`);
      assert.equal(t.internals.proseDrafts.get('scout', own!.id)!.noticedIn, undefined, 'and stays for its settlement');
    } finally {
      await t.close();
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
      routingOf(name: string): { drafts: unknown[] };
      settleTurnDrafts(agent: unknown, logical: unknown): void;
      bounceProse(agent: unknown, text: string, reason: string, candidates: undefined, prefix: '>>', round: { routing: unknown; notice: 'later' }): void;
      riskText(draft: unknown): string;
    };
    return { dir, framework, internals, close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); } };
  };

  it('a notice names drafts of its own resident only: the same id under another resident is not settled by it', async () => {
    const t = await setupFramework();
    try {
      (t.internals.proseDrafts as unknown as { newId: (agent: string) => string }).newId = () => 'd-same2';
      const [mine] = t.internals.proseDrafts.hold('scout', [{ text: 'scout words' }], 'explicit-send').held;
      t.internals.proseDrafts.hold('other', [{ text: 'other words' }], 'explicit-send');
      // Only the OTHER resident's notice for "d-same2" is in the shared history.
      t.framework.getAgent('other')!.getContextManager().addMessage('user', [{ type: 'text', text: '[drafts] other: …' }],
        { system: true, kind: 'prose-drafts', draftOwner: 'other', draftIds: ['d-same2'] } as never);
      const logical = t.internals.routingOf('scout');
      logical.drafts.push(mine);
      t.internals.settleTurnDrafts(t.framework.getAgent('scout')!, logical);
      assert.equal(t.internals.proseDrafts.get('scout', 'd-same2')!.noticedIn, undefined);
    } finally {
      await t.close();
    }
  });

  it('a re-bounce of inherited risk keeps the original attempt as its evidence', async () => {
    const t = await setupFramework();
    try {
      const agent = t.framework.getAgent('scout')!;
      const [original] = t.internals.proseDrafts.hold('scout', [{ text: 'first' }], 'bounced').held;
      t.internals.proseDrafts.beginAttempt('scout', original!.id, dest(), 'unsent-token', false); // never resolved
      const round = { routing: t.internals.routingOf('scout'), notice: 'later' as const };
      t.internals.bounceProse(agent, '{{unsent}} second', 'no such channel', undefined, '>>', round);
      const copy = t.internals.proseDrafts.open('scout').find((d) => d.text === 'first second')!;
      assert.equal(copy.inheritedRisk?.draftId, original!.id);
      t.internals.bounceProse(agent, '{{unsent}} third', 'no such channel', undefined, '>>', round);
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
    };
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(stub, {
      get: (t, prop: string) => (prop in t ? t[prop] : () => undefined),
    });
    const internals = framework as unknown as {
      proseDrafts: ProseDraftStore;
      handleDraftsTool(agent: string, input: unknown): Promise<{ success: boolean; data?: Array<{ text: string }>; error?: string }>;
      // The explicit gateway's entry: it admits the text's envelopes, then delivers each.
      deliverProse(agent: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
    };
    const say = (r: { success: boolean; data?: Array<{ text: string }>; error?: string }) =>
      r.success ? r.data!.map((b) => b.text).join('') : r.error!;
    /** Until a publish is waiting on the test, bounded: what the next step
     *  needs, rather than a fixed pause that a loaded machine can outrun. */
    const untilPublishing = async () => {
      const deadline = Date.now() + 10_000;
      while (pending.length === 0) {
        if (Date.now() > deadline) throw new Error('no publish reached the stub within 10 s');
        await new Promise((r) => setTimeout(r, 2));
      }
    };
    const [a, b] = internals.proseDrafts.hold('scout', [{ text: 'A words' }, { text: 'B words' }], 'explicit-send').held;
    return {
      dir, framework, internals, pending, say, untilPublishing, a: a!, b: b!,
      close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
    };
  };

  it('an all-delivered resend returns its receipts even when the destination no longer resolves', async () => {
    const t = await setup();
    try {
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      assert.match(t.say(await sending), /delivered to \(chan\), message m-a/);
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
      await t.untilPublishing();
      assert.deepEqual(t.pending.map((p) => p.text), ['A words'], 'the batch is waiting on A');
      const concurrent = t.say(await t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.b.id], destination: 'chan' }));
      assert.match(concurrent, new RegExp(`${t.b.id} is being sent right now \\(or is queued in a resend in progress\\)`));
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      await t.untilPublishing();
      assert.deepEqual(t.pending.map((p) => p.text), ['B words']);
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-b' });
      const result = t.say(await batch);
      assert.match(result, /delivered to \(chan\), message m-a/);
      assert.match(result, /delivered to \(chan\), message m-b/);
      assert.equal(t.pending.length, 0, 'B was published exactly once');
    } finally {
      await t.close();
    }
  });

  it('a draft dismissed while the batch waits is not published', async () => {
    const t = await setup();
    try {
      const batch = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, t.b.id], destination: 'chan' });
      await t.untilPublishing();
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
      await t.untilPublishing();
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

  it("what the connector says was posted reaches an unconfirmed resend's reply and the draft's read", async () => {
    const t = await setup();
    try {
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'part 2 failed (delivery uncertain)', detail: { posted: ['111'] } });
      const reply = t.say(await sending);
      assert.match(reply, new RegExp(`${t.a.id}: delivery to .+ NOT confirmed`));
      assert.ok(reply.endsWith(' Connector detail: {"posted":["111"]}'), reply);
      // The notices send the resident to read before a confirmDuplicate
      // resend, so the attempt's line there carries it too.
      const read = t.say(await t.internals.handleDraftsTool('scout', { action: 'read', draftIds: [t.a.id] }));
      assert.match(read, /UNKNOWN — may have been posted: part 2 failed \(delivery uncertain\); connector detail: \{"posted":\["111"\]\}/);
      // A long string comes through as itself, bounded, in both places.
      const long = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.b.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'timed out (delivery uncertain)', detail: 'p'.repeat(3000) });
      const longReply = t.say(await long);
      assert.ok(longReply.endsWith(` Connector detail: ${'p'.repeat(1987)}… [truncated]`), longReply.slice(-80));
      const longRead = t.say(await t.internals.handleDraftsTool('scout', { action: 'read', draftIds: [t.b.id] }));
      assert.ok(longRead.includes(`; connector detail: ${'p'.repeat(1987)}… [truncated]`), longRead.slice(0, 400));
    } finally {
      await t.close();
    }
  });

  it('a resend that provably posted nothing shows no connector detail', async () => {
    const t = await setup();
    try {
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'failed', reason: 'refused before dispatch', detail: { posted: [] } });
      const reply = t.say(await sending);
      assert.match(reply, new RegExp(`${t.a.id}: not sent to .+ Nothing was posted by this attempt`));
      assert.ok(!reply.includes('onnector detail'), reply);
      const read = t.say(await t.internals.handleDraftsTool('scout', { action: 'read', draftIds: [t.a.id] }));
      assert.ok(!read.includes('onnector detail'), read);
    } finally {
      await t.close();
    }
  });

  it("a draft whose own result is in isn't being sent any more, though the rest of its batch is", async () => {
    const t = await setup();
    try {
      const batch = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, t.b.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      await t.untilPublishing();
      assert.deepEqual(t.pending.map((p) => p.text), ['B words'], 'A is in; B is out');
      assert.match(t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.a.id] })),
        new RegExp(`${t.a.id}: already delivered — nothing to dismiss`));
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-b' });
      await batch;
    } finally {
      await t.close();
    }
  });

  it('a publish that throws leaves its draft dismissable, not marked as being sent', async () => {
    const t = await setup();
    try {
      const registry = (t.framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
      let entered = 0;
      registry.publish = async () => {
        entered++;
        throw new Error('transport gone');
      };
      await assert.rejects(
        t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' }),
        /transport gone/,
      );
      assert.equal(entered, 1, 'the resend reached publish');
      assert.equal(draftState(t.internals.proseDrafts.get('scout', t.a.id)!), 'unconfirmed', 'its attempt has no outcome: it may have been posted');
      assert.match(t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.a.id] })),
        new RegExp(`${t.a.id}: dismissed \\(your history keeps the words\\)\\. Note that ${t.a.id}'s attempt to .* may already have been posted: its outcome was never recorded\\.`));
    } finally {
      await t.close();
    }
  });

  it('a batch that stops says why for each draft after the stop', async () => {
    const t = await setup();
    try {
      const [c] = t.internals.proseDrafts.hold('scout', [{ text: 'C words' }], 'explicit-send').held;
      const batch = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, t.b.id, c!.id], destination: 'chan' });
      await t.untilPublishing();
      t.say(await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.b.id] }));
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      const result = t.say(await batch);
      assert.match(result, new RegExp(`${c!.id}: not attempted \\(${t.b.id} was dismissed while it waited\\)\\.`));

      const [d] = t.internals.proseDrafts.hold('scout', [{ text: 'D words' }], 'explicit-send').held;
      const again = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [c!.id, d!.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'no receipt' });
      assert.match(t.say(await again), new RegExp(`${d!.id}: not attempted \\(${c!.id} was not confirmed delivered\\)\\.`));
    } finally {
      await t.close();
    }
  });

  it('an attempt still out reads as being sent, not as one whose outcome was never recorded', async () => {
    const t = await setup();
    try {
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' });
      await t.untilPublishing();
      const read = t.say(await t.internals.handleDraftsTool('scout', { action: 'read', draftIds: [t.a.id] }));
      assert.match(read, /attempt .* → \(chan\): being sent right now — no outcome yet/);
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      await sending;
    } finally {
      await t.close();
    }
  });

  it('{{unsent}} of a bounce queued in a resend says so, and holds the envelope\'s words with the risk', async () => {
    const t = await setup();
    try {
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words' }], 'bounced').held;
      const batch = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id, bounce!.id], destination: 'chan' });
      await t.untilPublishing();
      const agent = t.framework.getAgent('scout')!;
      await t.internals.deliverProse(agent, '>>chan {{unsent}} and a postscript', { notice: 'later' });
      assert.deepEqual(t.pending.map((p) => p.text), ['A words'], 'nothing more was sent');
      const fresh = t.internals.proseDrafts.latestBounce('scout')!;
      assert.notEqual(fresh.id, bounce!.id);
      assert.equal(fresh.text, 'bounced words and a postscript');
      assert.equal(fresh.inheritedRisk?.draftId, bounce!.id);
      assert.match(fresh.inheritedRisk!.reason, /queued in a resend when these words were held/);
      const words = agent.getContextManager().getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
      assert.ok(words.includes(`[prose-routing] {{unsent}} is draft ${bounce!.id}, which is queued in a resend in progress. Nothing was sent; ` +
        `wait for that result. Your message is held as draft ${fresh.id}, with {{unsent}} written out; since it includes ` +
        `${bounce!.id}'s words, it can be resent only with confirmDuplicate: true, once that result is in.`), words.join('\n'));
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-a' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'delivered', messageId: 'm-b' });
      await batch;
    } finally {
      await t.close();
    }
  });

  it('>>skip_reply {{unsent}} says when the bounce may already have been posted, or could not be set aside', async () => {
    const t = await setup();
    try {
      const agent = t.framework.getAgent('scout')!;
      const words = () => agent.getContextManager().getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words' }], 'bounced').held;
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [bounce!.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'no receipt' });
      await sending;
      // The journal refuses the dismissal: the bounce stays, and the resident is told.
      const dismiss = t.internals.proseDrafts.dismiss.bind(t.internals.proseDrafts);
      t.internals.proseDrafts.dismiss = () => { throw new Error('EIO'); };
      await t.internals.deliverProse(agent, '>>skip_reply {{unsent}}', { notice: 'later' });
      assert.ok(words().includes(`[prose-routing] Recording setting aside draft ${bounce!.id}, which {{unsent}} named, failed (EIO): ` +
        'it reads as unconfirmed now, and {{unsent}} still names it.'), words().join('\n'));
      assert.equal(t.internals.proseDrafts.latestBounce('scout')?.id, bounce!.id);
      t.internals.proseDrafts.dismiss = dismiss;
      await t.internals.deliverProse(agent, '>>skip_reply {{unsent}}', { notice: 'later' });
      assert.equal(draftState(t.internals.proseDrafts.get('scout', bounce!.id)!), 'dismissed');
      assert.ok(words().some((w) => w.startsWith(`[prose-routing] Draft ${bounce!.id} is set aside. Note that ${bounce!.id}'s attempt to (chan) at `) &&
        w.endsWith('may already have been posted: no receipt.')), words().join('\n'));
    } finally {
      await t.close();
    }
  });

  /** The framework's store fails the sync after the next drafts entry with
   *  this op reaches it, as a disk can: the journal reconciles, so the entry
   *  stands though recording it threw. */
  const failSyncAfter = (framework: AgentFramework, op: string): (() => void) => {
    const store = (framework as unknown as { store: { sync(): void; appendJson(t: string, p: unknown): unknown } }).store;
    const real = { sync: store.sync.bind(store), appendJson: store.appendJson.bind(store) };
    let armed = false;
    store.appendJson = (type, payload) => {
      const record = real.appendJson(type, payload);
      if ((payload as { op?: string }).op === op) armed = true;
      return record;
    };
    store.sync = () => {
      if (armed) { armed = false; throw new Error('EIO'); }
      real.sync();
    };
    return () => { store.sync = real.sync; store.appendJson = real.appendJson; };
  };

  it('a dismissal whose recording fails after it reached the journal is reported as it reads: dismissed', async (t0) => {
    const t = await setup();
    t0.mock.method(console, 'error', () => {});
    try {
      const restore = failSyncAfter(t.framework, 'dismissed');
      const answer = await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.a.id] });
      restore();
      assert.equal(answer.success, false);
      assert.equal(t.say(answer), `Recording the dismissal of ${t.a.id} failed (EIO): it reads as dismissed now.`);
      assert.equal(draftState(t.internals.proseDrafts.get('scout', t.a.id)!), 'dismissed');
    } finally {
      await t.close();
    }
  });

  it('a dismissal of a possibly-posted draft that stands after its recording failed says so, with the risk, and is traced', async (t0) => {
    const t = await setup();
    t0.mock.method(console, 'error', () => {});
    try {
      const traced: string[][] = [];
      t.framework.onTrace((e) => {
        const ev = e as { type: string; draftIds?: string[] };
        if (ev.type === 'prose:drafts-dismissed') traced.push(ev.draftIds ?? []);
      });
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'no receipt' });
      await sending;
      const restore = failSyncAfter(t.framework, 'dismissed');
      const answer = await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.a.id] });
      restore();
      const text = t.say(answer);
      assert.ok(text.startsWith(`Recording the dismissal of ${t.a.id} failed (EIO): it reads as dismissed now. Note that ${t.a.id}'s attempt to (chan) at `), text);
      assert.ok(text.endsWith('may already have been posted: no receipt.'), text);
      assert.deepEqual(traced, [[t.a.id]], 'the dismissal that stands is traced');
    } finally {
      await t.close();
    }
  });

  it('the dismissal trace names the drafts the call dismissed, not ones already dismissed', async () => {
    const t = await setup();
    try {
      const traced: string[][] = [];
      t.framework.onTrace((e) => {
        const ev = e as { type: string; draftIds?: string[] };
        if (ev.type === 'prose:drafts-dismissed') traced.push(ev.draftIds ?? []);
      });
      await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.b.id] });
      const answer = await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.a.id, t.b.id] });
      assert.equal(t.say(answer), `${t.a.id}: dismissed (your history keeps the words).\n${t.b.id}: already dismissed.`);
      assert.deepEqual(traced, [[t.b.id], [t.a.id]]);
    } finally {
      await t.close();
    }
  });

  it('a dismissal that never reached the journal says the draft reads as it did, and traces nothing', async () => {
    const t = await setup();
    try {
      const traced: string[][] = [];
      t.framework.onTrace((e) => {
        const ev = e as { type: string; draftIds?: string[] };
        if (ev.type === 'prose:drafts-dismissed') traced.push(ev.draftIds ?? []);
      });
      const dismiss = t.internals.proseDrafts.dismiss.bind(t.internals.proseDrafts);
      t.internals.proseDrafts.dismiss = (agent: string, id: string) => {
        if (id === t.b.id) throw new Error('EIO');
        dismiss(agent, id);
      };
      const answer = await t.internals.handleDraftsTool('scout', { action: 'dismiss', draftIds: [t.a.id, t.b.id] });
      t.internals.proseDrafts.dismiss = dismiss;
      assert.equal(t.say(answer),
        `${t.a.id}: dismissed (your history keeps the words).\nRecording the dismissal of ${t.b.id} failed (EIO): it reads as held now.`);
      assert.deepEqual(traced, [[t.a.id]], 'the dismissal before the failure is traced; the one that failed is not');
    } finally {
      await t.close();
    }
  });

  it(">>skip_reply {{unsent}} whose recording fails after it reached the journal says the bounce is set aside, and that {{unsent}} names nothing", async (t0) => {
    const t = await setup();
    t0.mock.method(console, 'error', () => {});
    try {
      const agent = t.framework.getAgent('scout')!;
      const words = () => agent.getContextManager().getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words' }], 'bounced').held;
      const restore = failSyncAfter(t.framework, 'dismissed');
      await t.internals.deliverProse(agent, '>>skip_reply {{unsent}}', { notice: 'later' });
      restore();
      assert.ok(words().includes(`[prose-routing] Recording setting aside draft ${bounce!.id}, which {{unsent}} named, failed (EIO): ` +
        'it reads as dismissed now, and {{unsent}} names nothing.'), words().join('\n'));
      assert.equal(t.internals.proseDrafts.latestBounce('scout'), undefined);
    } finally {
      await t.close();
    }
  });

  it(">>skip_reply {{unsent}} of a possibly-posted bounce that stands after its recording failed says so, with the risk", async (t0) => {
    const t = await setup();
    t0.mock.method(console, 'error', () => {});
    try {
      const agent = t.framework.getAgent('scout')!;
      const words = () => agent.getContextManager().getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words' }], 'bounced').held;
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [bounce!.id], destination: 'chan' });
      await t.untilPublishing();
      t.pending.shift()!.resolve({ status: 'unknown', reason: 'no receipt' });
      await sending;
      const traced: string[][] = [];
      t.framework.onTrace((e) => {
        const ev = e as { type: string; draftIds?: string[] };
        if (ev.type === 'prose:drafts-dismissed') traced.push(ev.draftIds ?? []);
      });
      const restore = failSyncAfter(t.framework, 'dismissed');
      await t.internals.deliverProse(agent, '>>skip_reply {{unsent}}', { notice: 'later' });
      restore();
      assert.deepEqual(traced, [[bounce!.id]], 'the dismissal that stands is traced');
      assert.ok(words().some((w) => w.startsWith(`[prose-routing] Recording setting aside draft ${bounce!.id}, which {{unsent}} named, failed (EIO): ` +
        `it reads as dismissed now, and {{unsent}} names nothing. Note that ${bounce!.id}'s attempt to (chan) at `) &&
        w.endsWith('may already have been posted: no receipt.')), words().join('\n'));
    } finally {
      await t.close();
    }
  });

  it('a resend whose attempt reached the journal before its recording failed is not sent, and says the draft reads as unconfirmed', async (t0) => {
    const t = await setup();
    t0.mock.method(console, 'error', () => {});
    try {
      const restore = failSyncAfter(t.framework, 'attempt');
      const answer = await t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [t.a.id], destination: 'chan' });
      restore();
      assert.equal(t.pending.length, 0, 'nothing was sent');
      assert.match(t.say(answer), new RegExp(`${t.a.id}: not sent — the attempt could not be recorded durably \\(EIO\\), and the draft reads as unconfirmed now\\.`));
    } finally {
      await t.close();
    }
  });

  it("{{unsent}} whose attempt reached the journal before its recording failed bounces, saying the draft reads as unconfirmed", async (t0) => {
    const t = await setup();
    t0.mock.method(console, 'error', () => {});
    try {
      const agent = t.framework.getAgent('scout')!;
      const words = () => agent.getContextManager().getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words' }], 'bounced').held;
      const restore = failSyncAfter(t.framework, 'attempt');
      await t.internals.deliverProse(agent, '>>chan {{unsent}}', { notice: 'later' });
      restore();
      assert.equal(t.pending.length, 0, 'nothing was sent');
      assert.ok(words().some((w) => w.includes(`the attempt for draft ${bounce!.id} could not be recorded durably (EIO), and the draft reads as unconfirmed now`)),
        words().join('\n'));
    } finally {
      await t.close();
    }
  });

  it("a puppeted drafts call whose handler throws is answered as a failure", async () => {
    const t = await setup();
    try {
      (t.framework as unknown as { handleDraftsTool: () => Promise<unknown> }).handleDraftsTool = async () => { throw new Error('boom'); };
      const { result } = await t.framework.puppetToolCall('scout', 'drafts', {
        action: 'list', draftIds: null, destination: null, confirmDuplicate: null, offset: null,
      });
      assert.equal(result.success, false);
      assert.equal(result.error, 'drafts failed: boom');
    } finally {
      await t.close();
    }
  });

  it("a puppeted drafts call reaches the drafts tool and acts as the resident", async () => {
    const t = await setup();
    try {
      const { result } = await t.framework.puppetToolCall('scout', 'drafts', {
        action: 'read', draftIds: [t.a.id], destination: null, confirmDuplicate: null, offset: null,
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.data), /A words/);
    } finally {
      await t.close();
    }
  });

  it('>>skip_reply {{unsent}} leaves the latest bounce alone while it is being sent, and tells the resident', async () => {
    const t = await setup();
    try {
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words' }], 'bounced').held;
      const sending = t.internals.handleDraftsTool('scout', { action: 'resend', draftIds: [bounce!.id], destination: 'chan' });
      await t.untilPublishing();
      const agent = t.framework.getAgent('scout')!;
      const envelope = (text: string) => t.internals.deliverProse(agent, text, { notice: 'later' });
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
      const [bounce] = t.internals.proseDrafts.hold('scout', [{ text: 'bounced words' }], 'bounced').held;
      const agent = t.framework.getAgent('scout')!;
      const delivering = t.internals.deliverProse(agent, '>>chan {{unsent}}', { notice: 'later' });
      await t.untilPublishing();
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
      assert.equal((h.framework as unknown as { turnRouting: Map<string, { pin?: string }> }).turnRouting.get('scout')?.pin, ROOM,
        'the named destination is the sticky target again, as live routing would leave it');
      assert.match(h.texts().find((t) => t.startsWith('[delivered]'))!, / · 3 plain-speech segment\(s\) kept private \(skip_reply or a private think\)$/);

      // A live `>>>skip_reply` in an earlier round binds a later silenced one.
      const before = h.drafts().length;
      await h.turn(rounds(
        [text('>>>skip_reply thinking aloud'), call('l4', 'channel_list', {})],
        [text('still thinking'), explicitSend('s2')],
      ));
      assert.equal(h.drafts().length, before, 'nothing private was drafted');
      // "still thinking" is the one kept private (live routing does not count
      // the `>>>skip_reply` envelope itself).
      assert.equal(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1), '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply or a private think)');
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
        `[delivered] plain speech → #room (Guild One) (${ROOM}) (draft ${ids[0]}, by your resend) · ` +
        `1 plain-speech segment(s) held as draft ${ids[2]} (not sent — drafts can resend them unchanged, or dismiss them) · ` +
        `draft ${ids[1]} dismissed by you`);

      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([
        createMockResponse([text('uncertain words'), explicitSend('s2')], 'tool_use'),
        createMockResponse([drafts('r2', { action: 'resend', draftIds: [ids[3]], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.match(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1)!, new RegExp(
        `^\\[delivered\\] nothing confirmed — draft ${ids[3]} is unconfirmed: ${ids[3]}'s attempt to #room \\(Guild One\\) \\(${ROOM}\\) at .+ ` +
        'may already have been posted: .+ — sending it again could post it twice \\(resend needs confirmDuplicate: true\\)$'));

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
      const original = h.store().hold('scout', [{ text: 'possibly sent' }], 'bounced').held[0]!;
      h.store().beginAttempt('scout', original.id, dest(), 'unsent-token', false); // its outcome never recorded
      await h.turn(rounds([text(`plain words\n>>>${ROOM} {{unsent}} and a new line`), explicitSend('s1')]));
      const free = h.drafts().find((d) => d.text === 'plain words')!;
      const copy = h.drafts().find((d) => d.text === 'possibly sent and a new line')!;
      assert.equal(draftState(free), 'held');
      assert.equal(draftState(copy), 'unconfirmed');
      const notice = h.messages().find((m) => (m.metadata as { kind?: string; draftIds?: string[] } | undefined)?.kind === 'prose-drafts'
        && (m.metadata as { draftIds?: string[] }).draftIds?.includes(copy.id))!;
      const words = notice.content.map((b) => (b as { text?: string }).text ?? '').join('');
      assert.ok(words.startsWith(`[drafts] scout: your 2 plain-speech messages are held as drafts ${free.id} (11 chars) ` +
        `and ${copy.id} (28 chars), in the order you wrote them, because you made an explicit send in this round or an earlier ` +
        'one this turn. '),
        `no "not sent" over words that may be out: ${words}`);
      assert.ok(!words.includes('plain words') && !words.includes('possibly sent'), `the notice quotes none of the drafts' words: ${words}`);
      assert.ok(words.includes(`drafts(action: "resend", draftIds: ["${free.id}"], destination: "#channel") delivers it unchanged`), words);
      assert.ok(words.includes(`${copy.id} includes the words of ${original.id}, and ${original.id}'s attempt to #room (Guild One) (${ROOM})`), words);
      assert.ok(words.includes(`so resending ${copy.id} could post it twice (to send it anyway: drafts(action: "resend", draftIds: ["${copy.id}"], destination: "#channel", confirmDuplicate: true))`), words);
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
