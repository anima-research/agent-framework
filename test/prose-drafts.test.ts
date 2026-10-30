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
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MembraneError, type ContentBlock, type NormalizedRequest, type NormalizedResponse, type StreamEvent, type YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { Module } from '../src/index.js';
import { ProseDraftStore, draftState, PROSE_DRAFT_RECORD_TYPE } from '../src/prose-drafts.js';
import { destinationKey } from '../src/mcpl/channel-registry.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

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
  constructor(private readonly inner: YieldingStream, private readonly roundPreamble = false) {}
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
      if (this.roundPreamble) {
        const blocks = (context.roundContent as Array<{ type: string; text?: string }> | undefined) ?? [];
        context.roundPreamble = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      }
      delete context.roundContent;
      yield { ...event, context } as unknown as StreamEvent;
    }
  }
}

/** A membrane in XML tool mode (the inner mock's streams, wrapped). */
function xmlMode(inner: MockMembrane, roundPreamble = false): MockMembrane {
  const streamYielding = inner.streamYielding.bind(inner);
  (inner as unknown as { streamYielding: (r: NormalizedRequest, o?: unknown) => YieldingStream }).streamYielding =
    (request, options) => new XmlModeStream(streamYielding(request, options), roundPreamble);
  return inner;
}

const PARTIAL = 'The partial content an aborted stream carries.';

function breakAfterToolRound(
  membrane: MockMembrane,
  how: 'error' | 'throw' | 'abort' | 'stop',
  opts: {
    fromStart?: boolean;
    stopEnds?: 'aborted' | 'error' | 'silent' | 'throw';
    stream?: number;
    failure?: () => Error;
    beforeFailure?: () => void | Promise<void>;
  } = {},
): void {
  const streamYielding = membrane.streamYielding.bind(membrane);
  let opened = 0;
  (membrane as unknown as { streamYielding: (r: NormalizedRequest, o?: unknown) => YieldingStream }).streamYielding = (request, options) => {
    const inner = streamYielding(request, options);
    if (++opened !== (opts.stream ?? 1)) return inner;
    let resultsGiven = false;
    let cancelled = false;
    let wake: (() => void) | undefined;
    return {
      provideToolResults: () => { resultsGiven = true; wake?.(); },
      cancel: () => { cancelled = true; wake?.(); },
      get isWaitingForTools() { return !resultsGiven && inner.isWaitingForTools; },
      get pendingToolCallIds() { return resultsGiven ? [] : inner.pendingToolCallIds; },
      get toolDepth() { return inner.toolDepth; },
      async *[Symbol.asyncIterator]() {
        const failure = () => ({
          type: 'error',
          error: opts.failure?.() ?? new MembraneError({ type: 'server', retryable: false, message: 'the provider failed', rawError: { status: 500 } }),
        }) as unknown as StreamEvent;
        if (opts.fromStart) { yield failure(); return; }
        for await (const event of inner) {
          yield event;
          if (event.type !== 'tool-calls') continue;
          while (!resultsGiven && !cancelled) await new Promise<void>((resolve) => { wake = resolve; });
          if (how === 'error' && !cancelled) { await opts.beforeFailure?.(); yield failure(); return; }
          if (how === 'throw' && !cancelled) {
            await opts.beforeFailure?.();
            throw opts.failure?.() ?? new MembraneError({ type: 'server', retryable: false, message: 'the stream threw', rawError: { status: 500 } });
          }
          if (how === 'abort' && !cancelled) {
            await opts.beforeFailure?.();
            yield { type: 'aborted', reason: 'error', partialContent: [{ type: 'text', text: PARTIAL }] } as unknown as StreamEvent;
            return;
          }
          while (!cancelled) await new Promise<void>((resolve) => { wake = resolve; });
          const ends = opts.stopEnds ?? 'aborted';
          if (ends === 'aborted') yield { type: 'aborted', reason: 'user', partialContent: [{ type: 'text', text: PARTIAL }] } as unknown as StreamEvent;
          if (ends === 'error') yield failure();
          if (ends === 'throw') throw new Error('the cancelled stream threw');
          return;
        }
      },
    } as YieldingStream;
  };
}

function failWhileToolsRun(membrane: MockMembrane, atRound = 1): void {
  const streamYielding = membrane.streamYielding.bind(membrane);
  let opened = 0;
  (membrane as unknown as { streamYielding: (r: NormalizedRequest, o?: unknown) => YieldingStream }).streamYielding = (request, options) => {
    const inner = streamYielding(request, options);
    if (++opened !== 1) return inner;
    let rounds = 0;
    let failed = false;
    return {
      provideToolResults: (...args: Parameters<YieldingStream['provideToolResults']>) => { if (!failed) inner.provideToolResults(...args); },
      cancel: () => inner.cancel(),
      get isWaitingForTools() { return !failed && inner.isWaitingForTools; },
      get pendingToolCallIds() { return failed ? [] : inner.pendingToolCallIds; },
      get toolDepth() { return inner.toolDepth; },
      async *[Symbol.asyncIterator]() {
        for await (const event of inner) {
          yield event;
          if (event.type === 'tool-calls' && ++rounds === atRound) {
            failed = true;
            yield {
              type: 'error',
              error: new MembraneError({ type: 'server', retryable: false, message: 'the provider failed', rawError: { status: 500 } }),
            } as unknown as StreamEvent;
            return;
          }
        }
      },
    } as YieldingStream;
  };
}

/**
 * The next stream yields its round's tool-calls and then completes at once,
 * its calls unanswered: a stream that ends while the framework still waits
 * for tools.
 */
function completeWhileWaiting(membrane: MockMembrane, response: NormalizedResponse): void {
  const streamYielding = membrane.streamYielding.bind(membrane);
  let used = false;
  (membrane as unknown as { streamYielding: (r: NormalizedRequest, o?: unknown) => YieldingStream }).streamYielding = (request, options) => {
    const inner = streamYielding(request, options);
    if (used) return inner;
    used = true;
    return {
      provideToolResults: (...args: Parameters<YieldingStream['provideToolResults']>) => inner.provideToolResults(...args),
      cancel: () => inner.cancel(),
      get isWaitingForTools() { return inner.isWaitingForTools; },
      get pendingToolCallIds() { return inner.pendingToolCallIds; },
      get toolDepth() { return inner.toolDepth; },
      async *[Symbol.asyncIterator]() {
        for await (const event of inner) {
          yield event;
          if (event.type === 'tool-calls') {
            yield { type: 'complete', response } as StreamEvent;
            return;
          }
        }
      },
    } as YieldingStream;
  };
}

/** The second stream the membrane opens, such as a guard retry's, answers with this response. */
function onSecondStream(membrane: MockMembrane, response: NormalizedResponse): void {
  const streamYielding = membrane.streamYielding.bind(membrane);
  let opened = 0;
  (membrane as unknown as { streamYielding: (r: NormalizedRequest, o?: unknown) => YieldingStream }).streamYielding = (request, options) => {
    if (++opened === 2) membrane.pushResponse(response);
    return streamYielding(request, options);
  };
}

async function harness(opts: {
  agents?: Array<{ name: string; proseRouting?: 'locus' | 'explicit' | 'hybrid' | 'disabled'; sameRoundThinkTextPolicy?: 'public' | 'private'; autoContinue?: boolean; toolResultGuard?: boolean; maxStreamTokens?: number }>;
  xml?: boolean;
  roundPreamble?: boolean;
  retries?: number;
  retryDelayMs?: number | number[];
  /** The fixture server's requestTimeoutMs (the framework's default when unset). */
  requestTimeoutMs?: number;
  sendTool?: boolean;
  codeExecution?: boolean;
  serverConfig?: Record<string, unknown>;
  channels?: Array<{ id: string; label: string; direction?: 'inbound' | 'outbound' | 'bidirectional' }>;
  modules?: Module[];
  /** FrameworkConfig.heartbeat: the framework's own heartbeat. */
  heartbeat?: boolean | Record<string, unknown>;
  /** FrameworkConfig.speech: where a turn's plain speech lands when nothing names a destination. */
  speech?: { locus: 'delivery' | 'latest-inbound' };
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prose-drafts-e2e-'));
  const commandPath = join(dir, 'commands.jsonl');
  const statusPath = join(dir, 'status.jsonl');
  writeFileSync(commandPath, '');
  const membrane = opts.xml ? xmlMode(new MockMembrane(), opts.roundPreamble) : new MockMembrane();
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
    ...(a.autoContinue ? { autoContinue: a.autoContinue } : {}),
    ...(a.toolResultGuard ? { toolResultGuard: a.toolResultGuard } : {}),
    ...(a.maxStreamTokens !== undefined ? { maxStreamTokens: a.maxStreamTokens } : {}),
  }));
  const create = async () => {
    let retried = 0;
    const retryDelay = (): number => Array.isArray(opts.retryDelayMs)
      ? opts.retryDelayMs[Math.min(retried++, opts.retryDelayMs.length - 1)]!
      : opts.retryDelayMs ?? 10;
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents,
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs')],
        env: {
          STATUS_PATH: statusPath, COMMAND_PATH: commandPath,
          ...(opts.sendTool ? { SEND_TOOL: '1' } : {}),
          ...(opts.channels ? { CHANNELS: JSON.stringify(opts.channels) } : {}),
        },
        ...(opts.sendTool ? { toolPrefix: 'discord' } : {}),
        ...opts.serverConfig,
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      }],
      modules: opts.modules ?? [],
      ...(opts.heartbeat !== undefined ? { heartbeat: opts.heartbeat as never } : {}),
      ...(opts.speech ? { speech: opts.speech } : {}),
      ...(opts.codeExecution ? { codeExecution: { enabled: true } } : {}),
      ...(opts.retries !== undefined ? {
        errorPolicy: {
          maxRetries: opts.retries,
          onInferenceError: (_error: Error, _agent: string, attempt: number) =>
            attempt < opts.retries! ? { retry: true as const, delayMs: retryDelay() } : { retry: false as const },
        },
      } : {}),
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
    publishes: (): Publish[] => jsonLines<Publish>(statusPath)
      .filter((e) => e.event === 'publish' || e.event === 'publish-refused' || e.event === 'publish-error'),
    sendMode: async (mode: string, answers?: string) => {
      const logged = () => jsonLines<{ event: string }>(statusPath).filter((e) => e.event === 'send-mode').length;
      const before = logged();
      h.command({ op: 'send-mode', mode, ...(answers ? { answers } : {}) });
      await until(() => logged() > before, 'the send mode');
    },
    sends: (): Array<{ channelId: string; text: string }> => jsonLines<{ event: string; channelId: string; text: string }>(statusPath)
      .filter((e) => e.event === 'send'),
    /** One addressed message in #room starts a turn (or, with `request`, a
     *  direct inference request for just that resident); resolves when it settles. */
    turn: async (responses: Array<ReturnType<typeof createMockResponse>>, agentName = 'scout', via: 'incoming' | 'request' | 'silent' | 'heartbeat' = 'incoming') => {
      for (const r of responses) membrane.pushResponse(r);
      const before = membrane.calls.length;
      if (via === 'incoming') {
        h.command({ op: 'incoming', channelId: ROOM, messageId: `in-${++incoming}`, mode: 'addressed', text: `message ${incoming}` });
      } else {
        // 'silent': a control-plane wake whose plain prose stays private, as
        // a silent heartbeat's does.
        // 'heartbeat': a heartbeat tick's wake, as the framework's heartbeat
        // (or a heartbeat-mcpl push) makes it, with no channel.
        (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
          agentName, timestamp: Date.now(),
          ...(via === 'heartbeat' ? { reason: 'heartbeat', source: 'heartbeat' } : { reason: 'test', source: 'test' }),
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
const explicitSend = (id: string) => call(id, 'channel_publish', { channelId: ROOM, content: 'an explicit note' });
const unplacedSend = (id: string) => call(id, 'discord--send_message', { channelId: GENERAL, text: 'an explicit note' });

describe('held prose drafts, end to end', () => {
  it('a suppressed three-segment reply is held, named, inspected and delivered without retyping', async () => {
    const h = await harness({ sendTool: true });
    await h.sendMode('no-channel');
    try {
      const segments = ['First — the actual reply.', 'Second, with  two spaces\nand a newline.', 'Third: trailing words.'];
      await h.turn([
        createMockResponse([text(segments[0]!), unplacedSend('s1')], 'tool_use'),
        createMockResponse([text(segments[1]!), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text(segments[2]!)]),
      ]);
      assert.deepEqual(h.publishes(), [], 'nothing was published');
      const held = h.drafts().reverse();
      assert.deepEqual(held.map((d) => d.text), segments, 'exact words, in order');
      assert.ok(held.every((d) => d.reason === 'explicit-send'));
      const ids = held.map((d) => d.id);

      // Safe in-band ordering: each mid-turn notice is stored after the tool
      // result it rode with, and was injected into the live stream there.
      const msgs = h.messages();
      const noticeIdx = msgs.findIndex((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('[drafts]')));
      assert.ok(noticeIdx > 0, 'a held-draft notice was stored');
      assert.ok(msgs[noticeIdx - 1]!.content.some((b) => b.type === 'tool_result'), 'right after the tool result');
      const injected = (h.membrane.lastStream?.receivedToolResultOptions ?? [])
        .flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
      assert.ok(injected.some((t) => t.includes(ids[0]!)), 'the resident heard about the first draft mid-turn');
      const receipt = h.texts().find((t) => t.startsWith('[delivered]'))!;
      assert.equal(receipt, `[delivered] nothing — 3 plain-speech segment(s) held as drafts ${ids.join(', ')} (not sent — drafts can resend them unchanged, or dismiss them)`);

      // A publish into a channel is noted on the agent with what it had read
      // when it made the call (a wake for a message there that it read first
      // needs nothing more of it): nothing yet in room.
      const scout = h.framework.getAgent('scout') as unknown as {
        getConsumedWatermark(): { branch: string; sequence: number };
        publishedAfterReading(channelId: string, branch: string, sequence: number): boolean;
      };
      const room = destinationKey({ serverId: 'discord', channelId: ROOM });
      assert.equal(scout.publishedAfterReading(room, scout.getConsumedWatermark().branch, 0), false, 'nothing published in room yet');

      // Next turn: list (every field present, nulls), read, then resend all three.
      await h.turn([
        createMockResponse([drafts('d1', { action: 'list' })], 'tool_use'),
        createMockResponse([drafts('d2', { action: 'read', draftIds: [ids[1]] })], 'tool_use'),
        createMockResponse([drafts('d3', { action: 'resend', draftIds: ids, destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      const readThrough = scout.getConsumedWatermark();
      assert.equal(scout.publishedAfterReading(room, readThrough.branch, readThrough.sequence), true,
        'the resend is noted as a publish into room, made having read what the turn read');
      assert.equal(scout.publishedAfterReading(room, readThrough.branch, readThrough.sequence + 1), false, 'and nothing stored since');
      const [list, read, resend] = h.toolResults();
      assert.match(list!, /3 open drafts, newest first/);
      assert.ok(read!.endsWith(`exactly as a resend publishes it):\n${segments[1]}`), `read shows the text in full: ${read}`);
      assert.match(resend!, new RegExp(`${ids[0]}: delivered to #room \\(Guild One\\) \\(${ROOM}\\), message posted-1`));
      const sent = h.publishes();
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
      assert.ok(!h.texts().some((t) => t.startsWith('[drafts]')), 'no mid-turn notice: XML rounds present no injections');
      assert.ok(h.texts().some((t) => t.startsWith('[delivered] nothing — 2 plain-speech segment(s) held as drafts')));
    } finally {
      await h.close();
    }
  });

  it("a stream that doesn't say whether it carries injections gets no mid-turn notice: its held reply is named in the receipt", async () => {
    const h = await harness({ sendTool: true });
    h.membrane.supportsInjectedMessages = 'undeclared';
    await h.sendMode('no-channel');
    try {
      const segments = ['First — the actual reply.', 'Second words.', 'Third: trailing words.'];
      await h.turn([
        createMockResponse([text(segments[0]!), unplacedSend('s1')], 'tool_use'),
        createMockResponse([text(segments[1]!), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text(segments[2]!)]),
      ]);
      const held = h.drafts().reverse();
      assert.deepEqual(held.map((d) => d.text), segments, 'the reply is held as drafts');
      assert.ok(!h.texts().some((t) => t.startsWith('[drafts]')), 'no mid-turn notice: a stream that doesn\'t say is taken as one that carries no injections');
      assert.equal(
        h.texts().find((t) => t.startsWith('[delivered]')),
        `[delivered] nothing — 3 plain-speech segment(s) held as drafts ${held.map((d) => d.id).join(', ')} (not sent — drafts can resend them unchanged, or dismiss them)`,
      );
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
      assert.ok(h.texts().some((t) => t === '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)'));
      await h.turn([
        createMockResponse([text('Prose beside a private think.'), call('t1', 'think', { thought: 'hmm' }), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.drafts(), [], 'a same-round private think keeps its prose private, even beside a send');
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note']);
      assert.equal(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1),
        '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)',
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
        assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note'], 'only the explicit send went out');
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
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note'], 'only the explicit send went out');
      const held = h.drafts();
      assert.deepEqual(held.map((d) => d.text), ['Beside the send.'], "only the send's own round is held");
      assert.equal(h.texts().find((t) => t.startsWith('[delivered]')),
        `[delivered] nothing — 1 plain-speech segment(s) held as draft ${held[0]!.id} (not sent — drafts can resend them unchanged, or dismiss them) · 2 plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)`,
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

  it("a resend made in no turn, as a background script's or a puppet's is, isn't noted as a publish into its channel", async () => {
    const h = await harness({ sendTool: true });
    await h.sendMode('no-channel');
    try {
      await h.turn([
        createMockResponse([text('words held for later'), unplacedSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [held] = h.drafts();
      assert.ok(held, 'the words are held as a draft');
      // Dispatched as a background script's call is: with no turn.
      let finished = false;
      h.framework.onTrace((event) => {
        if (event.type === 'tool:completed' && (event as { callId?: string }).callId === 'from-script') finished = true;
      });
      (h.framework as unknown as {
        dispatchToolCall(agentName: string, call: { id: string; name: string; input: unknown }, turnId?: number): void;
      }).dispatchToolCall('scout', { id: 'from-script', name: 'drafts', input: { action: 'resend', draftIds: [held.id], destination: ROOM } });
      await h.until(() => finished, 'the resend to finish');
      assert.ok(h.publishes().some((p) => p.channelId === ROOM && p.text === 'words held for later'), 'the resend delivered');
      const scout = h.framework.getAgent('scout') as unknown as {
        getConsumedWatermark(): { branch: string; sequence: number };
        publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
      };
      const room = destinationKey({ serverId: 'discord', channelId: ROOM });
      assert.equal(scout.publishedAfterReading(room, scout.getConsumedWatermark().branch, 0), false,
        "a background script's resend is not noted");

      // Through executeToolCall, as the admin puppet and ephemeral agents call.
      await h.turn([
        createMockResponse([text('more words held'), unplacedSend('s2')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [again] = h.drafts();
      assert.ok(again, 'the new words are held as a draft');
      const result = await h.framework.executeToolCall({
        id: 'from-puppet', name: 'drafts', input: { action: 'resend', draftIds: [again.id], destination: ROOM }, callerAgentName: 'scout',
      });
      assert.equal(result.success, true, `the puppet's resend delivered: ${JSON.stringify(result)}`);
      assert.ok(h.publishes().some((p) => p.channelId === ROOM && p.text === 'more words held'));
      assert.equal(scout.publishedAfterReading(room, scout.getConsumedWatermark().branch, 0), false, "a puppet's resend is not noted");
    } finally {
      await h.close();
    }
  });

  // A script's resend was decided as its run call started it, though a later
  // round's wait watches it under the same turn.
  it("a script's resend is noted with what its agent had read when the run call started the script", async () => {
    const h = await harness({ sendTool: true });
    await h.sendMode('no-channel');
    try {
      await h.turn([
        createMockResponse([text('words a script will send'), unplacedSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [held] = h.drafts();
      assert.ok(held, 'the words are held as a draft');
      const fw = h.framework as unknown as {
        turnRouting: Map<string, unknown>;
        scriptToolCall(agent: string, tool: string, argsJson: string, context: Record<string, unknown>): Promise<{ ok: boolean; json: string }>;
      };
      const scout = h.framework.getAgent('scout') as unknown as {
        getConsumedWatermark(): { branch: string; sequence: number };
        publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
      };
      const room = destinationKey({ serverId: 'discord', channelId: ROOM });
      const now = scout.getConsumedWatermark();
      const atStart = { branch: now.branch, sequence: now.sequence - 1 };
      fw.turnRouting.set('scout', { turnId: 99, wasIn: [], engaged: new Set() });

      let answered: { ok: boolean; json: string } | undefined;
      void fw.scriptToolCall('scout', 'drafts', JSON.stringify({ action: 'resend', draftIds: [held.id], destination: ROOM }),
        { watch: { turnId: 99, endTurn: false }, startTurnId: 99, startReadThrough: atStart }).then((a) => { answered = a; });
      await h.until(() => answered !== undefined, "the script's resend to be answered");

      assert.ok(h.publishes().some((p) => p.channelId === ROOM && p.text === 'words a script will send'), `the resend delivered: ${answered!.json}`);
      assert.equal(JSON.parse(answered!.json).isError, false, `the call succeeded: ${answered!.json}`);
      assert.equal(scout.publishedAfterReading(room, atStart.branch, atStart.sequence), true, 'noted with what the agent had read when the script started');
      assert.equal(scout.publishedAfterReading(room, now.branch, now.sequence), false, 'not with what it has read since');
    } finally {
      await h.close();
    }
  });

  it('drafts belong to their resident: another resident can neither list nor resend them', async () => {
    const h = await harness({ agents: [{ name: 'scout' }, { name: 'other' }], sendTool: true });
    await h.sendMode('no-channel');
    try {
      // Direct requests: a channel message would wake both residents.
      await h.turn([
        createMockResponse([text('scout words'), unplacedSend('s1')], 'tool_use'),
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
      const held = h.texts('scout').find((t) => t.startsWith(`[drafts] scout: not sent — a plain-speech segment held as draft ${mine.id}`));
      assert.ok(held);
      assert.ok(!held!.includes('scout words'), `the held-draft notice quotes none of the draft's words: ${held}`);
    } finally {
      await h.close();
    }
  });

  it('failed and uncertain resends: a refusal stays resendable; an unknown outcome needs confirmDuplicate', async () => {
    const h = await harness({ sendTool: true });
    await h.sendMode('no-channel');
    try {
      await h.turn([
        createMockResponse([text('fragile words'), unplacedSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      const resend = (id: string, confirm?: boolean) =>
        drafts(id, { action: 'resend', draftIds: [draft!.id], destination: ROOM, ...(confirm ? { confirmDuplicate: true } : {}) });

      // Only a delivered resend is noted as a publish into its channel.
      const scout = h.framework.getAgent('scout') as unknown as {
        getConsumedWatermark(): { branch: string; sequence: number };
        publishedAfterReading(destination: string, branch: string, sequence: number): boolean;
      };
      const room = destinationKey({ serverId: 'discord', channelId: ROOM });
      const noted = () => scout.publishedAfterReading(room, scout.getConsumedWatermark().branch, 0);

      h.command({ op: 'publish-mode', mode: 'not-delivered' });
      await h.turn([createMockResponse([resend('r1')], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /not sent to .* Nothing was posted by this attempt\. The draft stays held\./);
      assert.equal(noted(), false, 'a refused resend is not noted');

      h.command({ op: 'publish-mode', mode: 'no-receipt' });
      await h.turn([createMockResponse([resend('r2')], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /NOT confirmed — it may or may not have been posted/);
      assert.equal(noted(), false, 'an unconfirmed resend is not noted');

      h.command({ op: 'publish-mode', mode: 'delivered' });
      await h.turn([createMockResponse([resend('r3')], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /may already have been posted: .*, so sending it again could post it twice\. To send it anyway, resend with confirmDuplicate: true\. Nothing was sent/);
      const before = h.publishes().length;
      await h.turn([createMockResponse([resend('r4', true)], 'tool_use'), createMockResponse([])]);
      assert.match(h.toolResults()[0]!, /delivered to/);
      assert.equal(h.publishes().length, before + 1);
      assert.equal(noted(), true, 'a delivered resend is noted');
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
      const [resent] = h.toolResults();
      assert.match(resent!, /NOT confirmed — it may or may not have been posted: .*connector exploded/);
      assert.match(resent!, /a resend needs confirmDuplicate: true/);
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
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note'], 'only the explicit send went out');
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
    const h = await harness({ sendTool: true });
    await h.sendMode('no-channel');
    try {
      await h.turn([
        createMockResponse([text('to deliver'), unplacedSend('s1')], 'tool_use'),
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
      h.command({ op: 'publish-mode', mode: 'delivered' });
      // The destination does not resolve, so the envelope bounces: the whole
      // authored attempt is held, and it carries the copied draft's risk.
      await h.turn([createMockResponse([text('>>#nowhere {{unsent}} and a postscript')])]);
      const fresh = h.drafts().find((d) => d.id !== risky!.id)!;
      assert.equal(fresh.text, 'risky words and a postscript', 'nothing substituted or truncated');
      assert.ok(h.texts().some((t) => t.includes(`It includes the words of draft ${risky!.id}, which may already have been posted, so ${fresh.id} can be resent only with the drafts tool and confirmDuplicate: true.`)));
      // {{unsent}} now means the fresh draft, and it is refused unconfirmed.
      const before = h.publishes().length;
      await h.turn([createMockResponse([text(`>>${ROOM} {{unsent}}`)])]);
      assert.equal(h.publishes().length, before, 'neither draft goes out without confirmation');
      assert.ok(h.texts().some((t) => t.startsWith(`[prose-routing] {{unsent}} is draft ${fresh.id}, and ${fresh.id} includes the words of ${risky!.id}`) &&
        t.includes(`Nothing was sent; sending that draft again could post it twice. To send it anyway, use drafts(action: "resend", draftIds: ["${fresh.id}"], destination: "#<channel>", confirmDuplicate: true).`)));
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

  it('prose beside a resend is neither posted nor held: a drafts round keeps what it would hold (#701)', async () => {
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
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note', 'earlier words']);
      assert.deepEqual(h.drafts().map((d) => d.text), [], 'the postscript is not held');
      const receipt = h.texts().filter((t) => t.startsWith('[delivered]')).at(-1)!;
      assert.ok(receipt.includes('1 plain-speech segment(s) kept private'), receipt);
    } finally {
      await h.close();
    }
  });

  const resendWhileOffered = (h: Awaited<ReturnType<typeof harness>>, line: string, callId: string) =>
    whileOffered(h, (id) => [text(line), drafts(callId, { action: 'resend', draftIds: [id], destination: ROOM })]);
  const dismissWhileOffered = (h: Awaited<ReturnType<typeof harness>>, line: string, callId: string) =>
    whileOffered(h, (id) => [text(line), drafts(callId, { action: 'dismiss', draftIds: [id] })]);
  const offeredIds = (h: Awaited<ReturnType<typeof harness>>): string[] => h.messages()
    .flatMap((m) => ((m.metadata as { draftIds?: string[] } | undefined)?.draftIds ?? []));
  function whileOffered(h: Awaited<ReturnType<typeof harness>>, blocks: (id: string) => ContentBlock[]) {
    const now = () => {
      const offered = new Set(offeredIds(h));
      const newest = h.drafts().find((d) => offered.has(d.id));
      return newest ? createMockResponse(blocks(newest.id), 'tool_use') : createMockResponse([]);
    };
    const response = {} as ReturnType<typeof createMockResponse>;
    for (const key of Object.keys(now())) Object.defineProperty(response, key, { get: () => now()[key as keyof typeof response], enumerable: true });
    return response;
  }

  for (const mode of ['locus', 'hybrid', 'explicit'] as const) {
    it(`${mode} mode: a resident that narrates each resend leaves the cycle after one resend, its line kept, or in explicit mode held with no notice (#701)`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        const lines = [1, 2, 3, 4, 5, 6].map((i) => resendWhileOffered(h, `Resending that now (${i}).`, `r${i}`));
        await h.turn([
          createMockResponse([text('A paragraph for the room.'), explicitSend('s1')], 'tool_use'),
          ...lines,
          createMockResponse([]),
        ]);
        assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note', 'A paragraph for the room.'],
          'the paragraph is resent once, and no narration line is posted');
        const draftsCalls = h.messages().flatMap((m) => m.content)
          .filter((b) => b.type === 'tool_use' && (b as { name?: string }).name === 'drafts');
        assert.equal(draftsCalls.length, 1, 'one resend round: nothing new was offered after it');
        const receipt = h.texts().find((t) => t.startsWith('[delivered]'));
        if (mode === 'explicit') {
          const [held] = h.drafts();
          assert.deepEqual([held?.text, held?.reason], ['Resending that now (1).', 'no-destination']);
          assert.equal(receipt, undefined);
          const naming = () => h.texts().filter((t) => t.includes(held!.id));
          if (naming().length === 0) await h.turn([createMockResponse([])]);
          assert.equal(naming().length, 1, `one notice names it: ${JSON.stringify(naming())}`);
          assert.ok(naming()[0]!.includes('that no recent notice on this branch names'), `a catch-up, not a mid-turn offer: ${naming()[0]}`);
        } else {
          assert.deepEqual(h.drafts(), [], 'nothing is left held');
          assert.ok(receipt?.includes('1 plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)'), receipt);
        }
      } finally {
        await h.close();
      }
    });
  }

  for (const mode of ['locus', 'hybrid'] as const) {
    it(`${mode} mode: a round that sends and also calls drafts holds the prose beside the send, and its notice offers it`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        await h.turn([
          createMockResponse([text('A reply meant for the room.'), explicitSend('s1'), drafts('l1', { action: 'list' })], 'tool_use'),
          createMockResponse([]),
        ]);
        const [held] = h.drafts();
        assert.deepEqual([held?.text, held?.reason], ['A reply meant for the room.', 'explicit-send']);
        assert.ok(h.texts().some((t) => !t.startsWith('[delivered]') && t.includes(held!.id)), 'a notice offers it before the turn ends');
      } finally {
        await h.close();
      }
    });

    it(`${mode} mode: after a round that sends and calls drafts, the resend round's narration is kept, and the cycle ends`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        const lines = [1, 2, 3, 4, 5, 6].map((i) => resendWhileOffered(h, `Resending that now (${i}).`, `r${i}`));
        await h.turn([
          createMockResponse([text('A reply meant for the room.'), explicitSend('s1'), drafts('l1', { action: 'list' })], 'tool_use'),
          ...lines,
          createMockResponse([]),
        ]);
        assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note', 'A reply meant for the room.'],
          'the paragraph is resent once, and no narration line is posted');
        assert.deepEqual(h.drafts(), []);
      } finally {
        await h.close();
      }
    });
  }

  it('a line beside a dismiss is kept private too, not held (#701)', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('A paragraph for the room.'), explicitSend('s1')], 'tool_use'),
        dismissWhileOffered(h, 'Dismissing that draft.', 'x1'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note']);
      assert.deepEqual(h.drafts(), [], 'the line is not held');
      const receipt = h.texts().find((t) => t.startsWith('[delivered]'))!;
      assert.match(receipt, /^\[delivered\] nothing — draft d-\S+ dismissed by you · 1 plain-speech segment\(s\) kept private \(skip_reply, a drafts call or a private think\)$/);
    } finally {
      await h.close();
    }
  });

  for (const mode of ['locus', 'hybrid'] as const) {
    it(`${mode} mode: in a turn with no send, prose beside a drafts list is posted as on main, since it would be delivered, not held (#701)`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        await h.turn([
          createMockResponse([text('Checking my drafts.'), drafts('l1', { action: 'list' })], 'tool_use'),
          createMockResponse([text('Here is the actual reply.'), call('c1', 'channel_list', {})], 'tool_use'),
          createMockResponse([]),
        ]);
        assert.deepEqual(h.publishes().map((p) => [p.channelId, p.text]), [[ROOM, 'Checking my drafts.'], [ROOM, 'Here is the actual reply.']]);
        assert.deepEqual(h.drafts(), []);
        assert.ok(!h.texts().some((t) => t.startsWith('[delivered]') && t.includes('kept private')), 'nothing is counted as kept');
      } finally {
        await h.close();
      }
    });
  }

  it("hybrid mode: a drafts round's >>> target is a deliberate send: its words are delivered there, and later rounds follow it (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([
        createMockResponse([text(`>>>${GENERAL} Moving the talk to general.`), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([text('Words for general.'), call('c1', 'channel_list', {})], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => [p.channelId, p.text]), [[GENERAL, 'Moving the talk to general.'], [GENERAL, 'Words for general.']]);
      assert.deepEqual(h.drafts(), []);
    } finally {
      await h.close();
    }
  });

  it("hybrid mode: after a send, a drafts round's envelopes are held with no notice, and one that only names a destination holds nothing (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([
        createMockResponse([explicitSend('s1')], 'tool_use'),
        createMockResponse([text(`>>>${GENERAL}\n>>>${ROOM} Kept words.`), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note']);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason, d.note]), [['Kept words.', 'explicit-send', `written for >>>${ROOM}`]],
        'the deliberate envelope is held, its words not lost');
      const id = h.drafts()[0]!.id;
      assert.ok(!h.texts().some((t) => !t.startsWith('[delivered]') && t.includes(id)), 'no notice names it before the turn ends');
      const receipt = h.texts().find((t) => t.startsWith('[delivered]'))!;
      assert.ok(receipt.includes(id) && !receipt.includes('kept private'), receipt);
    } finally {
      await h.close();
    }
  });

  it("hybrid mode: in a drafts round, a line left with no destination by a refused target is held with no notice (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([
        createMockResponse([text('>>>#nowhere lost words'), call('c1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text('Checking my drafts.'), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes(), []);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]), [['Checking my drafts.', 'no-destination'], ['lost words', 'bounced']],
        'the refused target still bounces; the line after it is held as no-destination');
      assert.ok(!h.texts().some((t) => !t.startsWith('[delivered]') && t.includes(h.drafts()[0]!.id)), 'no notice names the line before the turn ends');
    } finally {
      await h.close();
    }
  });

  it("hybrid mode: after a send, a drafts round's refused and malformed envelopes are held with no notice, as the silenced turn holds them (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], sendTool: true });
    await h.sendMode('no-channel');
    try {
      await h.turn([
        createMockResponse([unplacedSend('s1')], 'tool_use'),
        createMockResponse([text('>>>#nowhere refused words\n>>>'), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes(), []);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]).reverse(), [['refused words', 'explicit-send'], ['>>>', 'explicit-send']],
        'held as main holds them in a silenced turn');
      assert.ok(h.drafts().every((d) => !h.texts().some((t) => !t.startsWith('[delivered]') && t.includes(d.id))), 'no notice names them before the turn ends');
    } finally {
      await h.close();
    }
  });

  it("hybrid mode: after a send, a drafts round's envelopes still move the router: its ' !' starts a continuation turn (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], sendTool: true });
    await h.sendMode('no-channel');
    try {
      const before = h.membrane.calls.length;
      await h.turn([
        createMockResponse([unplacedSend('s1')], 'tool_use'),
        createMockResponse([text(`>>>${GENERAL} ! Kept words.`), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      await h.until(() => h.membrane.calls.length >= before + 2, "its ' !' starts a continuation turn: the model is asked again");
      assert.deepEqual(h.drafts().map((d) => d.text), ['Kept words.'], 'its words are held');
    } finally {
      await h.close();
    }
  });

  it("hybrid mode: a round that calls skip_reply beside drafts stays wholly private: its ' !' asks for nothing (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      const asked: boolean[] = [];
      const fw = h.framework as unknown as { requestProseContinuation(agent: unknown, routing: { continuation: boolean }): void };
      const check = fw.requestProseContinuation.bind(fw);
      fw.requestProseContinuation = (agent, routing) => { asked.push(routing.continuation); check(agent, routing); };
      await h.turn([
        createMockResponse([text(`>>>${GENERAL} ! Kept words.`), drafts('l1', { action: 'list' }), call('k1', 'skip_reply', {})], 'tool_use'),
        createMockResponse([]),
      ]);
      await h.until(() => asked.length > 0, "the turn's continuation check");
      assert.ok(!asked.includes(true), `no continuation is asked for: ${JSON.stringify(asked)}`);
      assert.deepEqual(h.publishes(), []);
      assert.deepEqual(h.drafts(), []);
    } finally {
      await h.close();
    }
  });

  it("hybrid mode: in a turn with no send, a refused target beside a drafts call still bounces (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([
        createMockResponse([text('>>>#nowhere lost words'), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]), [['lost words', 'bounced']]);
    } finally {
      await h.close();
    }
  });

  it("explicit mode: an unprefixed line beside a drafts call goes to the turn's sticky target, as on main (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      await h.turn([
        createMockResponse([text(`>>${GENERAL} First words.`), call('c1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text('More words.'), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => [p.channelId, p.text]), [[GENERAL, 'First words.'], [GENERAL, 'More words.']]);
      assert.deepEqual(h.drafts(), []);
    } finally {
      await h.close();
    }
  });

  it('XML tool mode is unchanged: a line beside a resend is held as a draft, as on main (#701)', async () => {
    const h = await harness({ xml: true });
    try {
      const done = (id: string) => ({ type: 'tool_result', toolUseId: id, content: 'done', isError: false }) as ContentBlock;
      await h.turn([
        createMockResponse([text('A paragraph for the room.'), explicitSend('s1')], 'tool_use'),
        { ...createMockResponse([text('A paragraph for the room.'), explicitSend('s1'), done('s1')]), toolCalls: [] },
      ]);
      const [draft] = h.drafts();
      const resend = drafts('r1', { action: 'resend', draftIds: [draft!.id], destination: ROOM });
      await h.turn([
        createMockResponse([text('Resending that now.'), resend], 'tool_use'),
        { ...createMockResponse([text('Resending that now.'), resend, done('r1')]), toolCalls: [] },
      ]);
      assert.deepEqual(h.drafts().map((d) => d.text), ['Resending that now.']);
    } finally {
      await h.close();
    }
  });

  it("XML tool mode, explicit mode: a line beside a resend bounces as any other, and the bounce-wake cap ends the cycle after two wakes (#701)", async () => {
    const h = await harness({ xml: true, agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      const done = (id: string) => ({ type: 'tool_result', toolUseId: id, content: 'done', isError: false }) as ContentBlock;
      let wakes = 0;
      const streamYielding = h.membrane.streamYielding.bind(h.membrane);
      (h.membrane as unknown as { streamYielding: typeof streamYielding }).streamYielding = (request, options) => {
        const offered = new Set(offeredIds(h));
        const newest = h.drafts().find((d) => offered.has(d.id));
        if (h.membrane.calls.length > 0 && newest) {
          const i = ++wakes;
          const round = [text(`Resending that now (${i}).`), drafts(`r${i}`, { action: 'resend', draftIds: [newest.id], destination: ROOM })];
          h.membrane.pushResponse(createMockResponse(round, 'tool_use'));
          h.membrane.pushResponse({ ...createMockResponse([...round, done(`r${i}`)]), toolCalls: [] });
        }
        return streamYielding(request, options);
      };
      await h.turn([{ ...createMockResponse([text('A paragraph for the room.')]), toolCalls: [] }]);
      const idle = h.framework as unknown as { runUntilIdle(): Promise<void> };
      const secondBounced = () => h.drafts().some((d) => d.text === 'Resending that now (2).' && d.reason === 'bounced');
      for (let k = 0; k < 400 && !secondBounced(); k++) { await idle.runUntilIdle(); await new Promise((resolve) => setTimeout(resolve, 25)); }
      assert.ok(secondBounced(), 'the second wake ran and its line bounced');
      for (let k = 0; k < 3; k++) { await idle.runUntilIdle(); await new Promise((resolve) => setTimeout(resolve, 25)); }
      assert.equal(wakes, 2, 'two bounce wakes, each resending once; the cap starts no third');
      assert.deepEqual(h.publishes().map((p) => p.text), ['A paragraph for the room.', 'Resending that now (1).']);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]), [['Resending that now (2).', 'bounced']],
        'each line beside a resend bounced, and the last is held');
    } finally {
      await h.close();
    }
  });

  it("a module's or server's `<prefix>--drafts` isn't the framework's drafts tool: beside it after a send, a line is held as any silenced round's is (#701)", async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([explicitSend('s1')], 'tool_use'),
        createMockResponse([text('Beside the other tool.'), call('m1', 'mail--drafts', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]), [['Beside the other tool.', 'explicit-send']]);
    } finally {
      await h.close();
    }
  });

  it("a `<prefix>--drafts` resend isn't the framework's resend, so it doesn't silence its round", async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('Words for the room.'), call('m1', 'mail--drafts', { action: 'resend', draftIds: ['d-x'], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => [p.channelId, p.text]), [[ROOM, 'Words for the room.']]);
      assert.deepEqual(h.drafts(), []);
    } finally {
      await h.close();
    }
  });

  it('in a turn with a send, a line beside a drafts call the agent may not use is held as before: a refused call counts for nothing (#701)', async () => {
    const h = await harness();
    try {
      const agent = h.framework.getAgent('scout')!;
      const canUse = agent.canUseTool.bind(agent);
      (agent as unknown as { canUseTool(name: string): boolean }).canUseTool = (name: string) => name !== 'drafts' && canUse(name);
      await h.turn([
        createMockResponse([explicitSend('s1')], 'tool_use'),
        createMockResponse([text('Checking my drafts.'), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]), [['Checking my drafts.', 'explicit-send']]);
    } finally {
      await h.close();
    }
  });

  it("explicit mode: a drafts round's >> target is a deliberate send, delivered as on main (#701)", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      await h.turn([
        createMockResponse([text(`>>${GENERAL} Moving the talk to general.`), drafts('l1', { action: 'list' })], 'tool_use'),
        createMockResponse([text('Words for general.'), call('c1', 'channel_list', {})], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => [p.channelId, p.text]), [[GENERAL, 'Moving the talk to general.'], [GENERAL, 'Words for general.']]);
      assert.deepEqual(h.drafts(), [], 'nothing bounced');
    } finally {
      await h.close();
    }
  });

  it("a later round of the turn, beside another tool, is held as before: only the drafts round keeps what it would hold (#701)", async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('A paragraph for the room.'), explicitSend('s1')], 'tool_use'),
        resendWhileOffered(h, 'Resending that now.', 'r1'),
        createMockResponse([text('Something else to say.'), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note', 'A paragraph for the room.']);
      assert.deepEqual(h.drafts().map((d) => [d.text, d.reason]), [['Something else to say.', 'explicit-send']]);
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

  it('an empty string marks an unused field, a digit string is read trimmed, and a value in use is still checked', async () => {
    const h = await harness();
    try {
      await h.turn([
        createMockResponse([text('words'), explicitSend('s1')], 'tool_use'),
        createMockResponse([]),
      ]);
      const [draft] = h.drafts();
      await h.turn([
        createMockResponse([
          // A caller whose provider presents every property as required, filling
          // the fields it isn't using with empty strings.
          drafts('a', { action: 'list', draftIds: '', destination: '', confirmDuplicate: '', offset: '' }),
          drafts('e', { action: 'list', destination: '' }),
          drafts('b', { action: 'read', draftIds: [draft!.id], destination: '', confirmDuplicate: '', offset: '' }),
          drafts('c', { action: 'list', offset: ' 0 ' }),
          drafts('d', { action: 'list', offset: ' ' }),
        ], 'tool_use'),
        createMockResponse([]),
      ]);
      const [listed, oneEmpty, read, padded, blank] = h.toolResults();
      // The call a review named: one empty field, the rest null.
      assert.match(oneEmpty!, /^1 open draft, newest first:/);
      assert.ok(oneEmpty!.includes(draft!.id), oneEmpty);
      assert.equal(listed, oneEmpty, 'every unused field empty lists the same');
      assert.match(read!, /words/);
      assert.equal(padded, listed, 'a padded offset reads as its digits');
      assert.match(blank!, /offset must be a whole number of drafts to skip/, 'whitespace alone is a value, and not a number');

      // A value in use is still checked, by the guards the rule now feeds.
      await h.turn([
        createMockResponse([
          drafts('f', { action: 'read', draftIds: '' }),
          drafts('g', { action: 'list', destination: '#elsewhere' }),
          drafts('h', { action: 'list', confirmDuplicate: true }),
          drafts('i', { action: 'read', draftIds: [draft!.id], offset: 1 }),
          drafts('j', { action: 'list', offset: ' 1 ' }),
          drafts('k', { action: 'list', offset: -1 }),
          // Past the integers a number holds exactly, digits would read as another number.
          drafts('m', { action: 'list', offset: '9007199254740993' }),
          // false is "don't confirm", what list already does: it lists.
          drafts('l', { action: 'list', confirmDuplicate: false }),
        ], 'tool_use'),
        createMockResponse([]),
      ]);
      const [noIds, destUsed, confirmUsed, offsetUsed, pastOne, negative, unsafe, confirmFalse] = h.toolResults();
      assert.match(noIds!, /action "read" needs draftIds/);
      assert.match(destUsed!, /destination is not used by action "list"/);
      assert.match(confirmUsed!, /confirmDuplicate is not used by action "list"/);
      assert.match(offsetUsed!, /offset is not used by action "read"/);
      assert.match(pastOne!, /^1 open draft, newest first \(showing 0 from #2\):/, 'a padded offset of 1 skips the one draft');
      assert.match(negative!, /offset must be a whole number of drafts to skip/);
      assert.match(unsafe!, /offset must be a whole number of drafts to skip/);
      assert.equal(confirmFalse, listed, 'confirmDuplicate: false lists, as an omitted one does');

      // resend: an empty destination is unused (and this resident has no home to
      // fall back to), and an empty confirmDuplicate is unused, so the send goes.
      await h.turn([
        createMockResponse([
          drafts('r1', { action: 'resend', draftIds: [draft!.id], destination: '', confirmDuplicate: '' }),
          drafts('r2', { action: 'resend', draftIds: [draft!.id], destination: ROOM, confirmDuplicate: '' }),
        ], 'tool_use'),
        createMockResponse([]),
      ]);
      const [noDest, resent] = h.toolResults();
      assert.match(noDest!, /resend needs a destination/);
      assert.match(resent!, new RegExp(`${draft!.id}: delivered to`));
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note', 'words']);
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
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note']);
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
      t.internals.bounceProse(agent, '{{unsent}} third', 'no such channel', undefined, '>>', round);
      const again = t.internals.proseDrafts.open('scout').find((d) => d.text === 'first second third')!;
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
      resolveProseTarget: (spec: string) => ({ serverId: 'discord', channelId: spec }),
      resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'discord', channelId } }),
      publish: (_agent: string, text: string, target: { channelId: string }) => held(text, target.channelId),
      // An envelope's delivery, `{{unsent}}` included, to the channel with its server.
      deliverSpeech: (_agent: string, text: string, to: { channelId: string }) => held(text, to.channelId),
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
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note']);
      assert.deepEqual(h.drafts().reverse().map((d) => [d.text, d.note]), [
        ['words for the room', `written for >>>${ROOM}`],
        ['more for the room', `written for #room (Guild One) (${ROOM})`],
      ]);
      assert.deepEqual((h.framework as unknown as { turnRouting: Map<string, { pin?: unknown }> }).turnRouting.get('scout')?.pin,
        { serverId: 'discord', channelId: ROOM }, 'the named destination, on its server, is the sticky target again, as live routing would leave it');
      assert.match(h.texts().find((t) => t.startsWith('[delivered]'))!, / · 3 plain-speech segment\(s\) kept private \(skip_reply, a drafts call or a private think\)$/);

      // A live `>>>skip_reply` in an earlier round binds a later silenced one.
      const before = h.drafts().length;
      await h.turn(rounds(
        [text('>>>skip_reply thinking aloud'), call('l4', 'channel_list', {})],
        [text('still thinking'), explicitSend('s2')],
      ));
      assert.equal(h.drafts().length, before, 'nothing private was drafted');
      // "still thinking" is the one kept private (live routing does not count
      // the `>>>skip_reply` envelope itself).
      assert.equal(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1), '[delivered] nothing — 1 plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)');
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
      assert.equal(draftState(risky), 'unconfirmed');

      await h.turn(rounds([text('>>>skip_reply {{unsent}}'), explicitSend('s4')]));
      assert.equal(draftState(h.store().get('scout', bounce!.id)!), 'dismissed', 'a send withholds speech, not the dismissal');
      assert.ok(h.drafts().every((d) => !d.text.includes('{{unsent}}')), 'no draft holds the literal token');
      assert.deepEqual(h.publishes().map((p) => p.text).filter((t) => t !== 'an explicit note'), ['lost words'],
        'only the live {{unsent}} went out');
    } finally {
      await h.close();
    }
  });

  it("hybrid: a draft a bare {{unsent}} delivers in its own turn is listed once in the receipt, as the plain speech it went out as", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      fixIds(h, ['d-unsent1']);
      // Bounced, then sent by a bare {{unsent}} in the turn's next round.
      await h.turn(rounds([text('>>>#nowhere lost words'), call('l1', 'channel_list', {})], [text(`>>>${ROOM} {{unsent}}`), call('l2', 'channel_list', {})]));
      assert.deepEqual(h.publishes().map((p) => p.text), ['lost words']);
      assert.equal(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1),
        `[delivered] plain speech → #room (Guild One) (${ROOM}) · draft d-unsent1 delivered by your {{unsent}}`);
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
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note', 'resend me']);
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
      assert.deepEqual(h.publishes().map((p) => p.text).sort(), ['an explicit note', 'slow prior']);
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
      assert.ok(words.startsWith(`[drafts] scout: 2 plain-speech segments held as drafts ${free.id}, ${copy.id} — `), `no "not sent" over words that may be out: ${words}`);
      assert.ok(words.includes(`drafts(action: "resend", draftIds: ["${free.id}"], destination: "#room") delivers it unchanged`), words);
      assert.ok(words.includes(`${copy.id} includes the words of ${original.id}, and ${original.id}'s attempt to #room (Guild One) (${ROOM})`), words);
      assert.ok(words.includes(`so resending ${copy.id} could post it twice (to send it anyway: drafts(action: "resend", draftIds: ["${copy.id}"], destination: "#room", confirmDuplicate: true))`), words);
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
      assert.deepEqual(h.publishes().map((p) => p.text), ['an explicit note']);
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

describe('an explicit send holds plain speech only where it may have posted', () => {
  const LINE = 'That makes sense, and thank you for telling me.';
  const NOTE = 'A note for general.';
  const ROOM_SHOWN = '#room (Guild One) (discord:g1:room)';
  const send = (id: string, channelId: string, words = NOTE) => call(id, 'discord--send_message', { channelId, text: words });
  const script = (id: string, code: string) => call(id, 'code_execution', { code });
  type H = Awaited<ReturnType<typeof harness>>;
  const inRoom = (h: H) => h.publishes().filter((p) => p.event === 'publish' && p.channelId === ROOM).map((p) => p.text);
  const held = (h: H) => h.drafts().map((d) => [d.text, d.reason]).reverse();
  const notices = (h: H) => h.texts().filter((t) => t.startsWith('[drafts]'));

  for (const mode of ['locus', 'hybrid'] as const) {
    it(`${mode}: a line beside a send to another channel goes to the person it was for`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.turn([createMockResponse([text(LINE), send('s1', GENERAL)], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(h.sends().map((s) => [s.channelId, s.text]), [[GENERAL, NOTE]]);
        assert.deepEqual(inRoom(h), [LINE]);
        assert.deepEqual(held(h), []);
        assert.equal(h.texts().find((t) => t.startsWith('[delivered]')), `[delivered] plain speech → ${ROOM_SHOWN}`);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: after a send to another channel, the turn's later rounds go too`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.turn([
          createMockResponse([text(LINE), send('s1', GENERAL)], 'tool_use'),
          createMockResponse([text('And one more thing for you.'), call('l1', 'channel_list', {})], 'tool_use'),
          createMockResponse([text('That is all from me.')]),
        ]);
        assert.deepEqual(inRoom(h), [LINE, 'And one more thing for you.', 'That is all from me.']);
        assert.deepEqual(held(h), []);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a send to the speech's own channel holds it, naming the send, where it went and where the speech was going`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.turn([createMockResponse([text(LINE), send('s1', ROOM, 'The reply, sent with the tool.')], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
        assert.equal(h.drafts()[0]!.note, `written for ${ROOM_SHOWN}`);
        const [notice, ...more] = notices(h);
        assert.equal(more.length, 0);
        assert.match(notice!, new RegExp(`send_message in this round delivered to ${ROOM_SHOWN.replace(/[()]/g, '\\$&')}, where this was going`));
        assert.match(notice!, /destination: "#room"/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: the hold lasts for speech to that channel, and the notice says what ends it`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.turn([
          createMockResponse([text('First.'), send('s1', ROOM, 'sent')], 'tool_use'),
          createMockResponse([text('Second.'), call('l1', 'channel_list', {})], 'tool_use'),
          createMockResponse([]),
        ]);
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [['First.', 'explicit-send'], ['Second.', 'explicit-send']]);
        assert.match(notices(h)[1]!, /earlier this turn delivered to .*stays held until a new message reaches you or this turn ends/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a send that answers with an error holds the line`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.sendMode('error');
        await h.turn([createMockResponse([text(LINE), send('s1', GENERAL)], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
        assert.match(notices(h)[0]!, /can't tell whether or where your send_message in this round posted \(it answered with an error\)/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a send whose answer names no channel holds the line`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.sendMode('no-channel');
        await h.turn([createMockResponse([text(LINE), send('s1', GENERAL)], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
        assert.match(notices(h)[0]!, /can't tell where your send_message in this round posted \(its answer named no channel the framework reads\)/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a channel_publish refused before any request lets the line go`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        await h.turn([createMockResponse([text(LINE), call('p1', 'channel_publish', { channelId: 'discord:g1:nowhere', content: NOTE })], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(inRoom(h), [LINE]);
        assert.deepEqual(held(h), []);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a channel_publish proven not posted lets the line go`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        h.command({ op: 'publish-mode', mode: 'not-delivered' });
        await h.turn([createMockResponse([text(LINE), call('p1', 'channel_publish', { channelId: ROOM, content: NOTE })], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(h.publishes().map((p) => [p.event, p.text]), [['publish-refused', NOTE], ['publish-refused', LINE]]);
        assert.ok(!held(h).some(([, reason]) => reason === 'explicit-send'));
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a channel_publish whose post is unconfirmed holds speech to that channel`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        h.command({ op: 'publish-mode', mode: 'no-receipt' });
        await h.turn([createMockResponse([text(LINE), call('p1', 'channel_publish', { channelId: ROOM, content: NOTE })], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(h.publishes().map((p) => p.text), [NOTE]);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
        assert.match(notices(h)[0]!, /channel_publish in this round may have posted to #room/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a script's send is decided by where it went`, async () => {
      for (const [to, goes] of [[GENERAL, true], [ROOM, false]] as const) {
        const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true, codeExecution: true });
        try {
          await h.turn([
            createMockResponse([text(LINE), script('ce1', `await tools["discord--send_message"]({ channelId: ${JSON.stringify(to)}, text: "from the script" });`)], 'tool_use'),
            createMockResponse([]),
          ]);
          assert.deepEqual(h.sends().map((s) => s.channelId), [to]);
          assert.deepEqual(inRoom(h), goes ? [LINE] : []);
          assert.deepEqual(held(h), goes ? [] : [[LINE, 'explicit-send']]);
        } finally {
          await h.close();
        }
      }
    });

    it(`${mode}: a resend round's narration goes where the resend didn't`, async () => {
      for (const [to, goes] of [[GENERAL, true], [ROOM, false]] as const) {
        const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
        try {
          await h.turn([createMockResponse([text('Held words.'), send('s1', ROOM, 'sent')], 'tool_use'), createMockResponse([])]);
          const [draft] = h.drafts();
          await h.turn([
            createMockResponse([text('Resending it now.'), drafts('r1', { action: 'resend', draftIds: [draft!.id], destination: to })], 'tool_use'),
            createMockResponse([]),
          ]);
          assert.deepEqual(h.publishes().filter((p) => p.event === 'publish').map((p) => [p.channelId, p.text]),
            goes ? [[GENERAL, 'Held words.'], [ROOM, 'Resending it now.']] : [[ROOM, 'Held words.']]);
          assert.deepEqual(held(h), []);
          if (!goes) {
            assert.ok(h.texts().includes('Resending it now.'), 'the narration stays in context');
            assert.match(h.texts().filter((t) => t.startsWith('[delivered]')).at(-1)!, /1 plain-speech segment\(s\) kept private/);
          }
        } finally {
          await h.close();
        }
      }
    });

    it(`${mode}: where a send posted is read from its answer, not from what it asked for`, async () => {
      for (const [asked, answered, goes] of [[GENERAL, ROOM, false], [ROOM, GENERAL, true]] as const) {
        const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
        try {
          await h.sendMode('delivered', answered);
          await h.turn([createMockResponse([text(LINE), send('s1', asked)], 'tool_use'), createMockResponse([])]);
          assert.deepEqual(inRoom(h), goes ? [LINE] : []);
          assert.deepEqual(held(h), goes ? [] : [[LINE, 'explicit-send']]);
        } finally {
          await h.close();
        }
      }
    });

    it(`${mode}: the places of several sends add up, in a script and across rounds`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true, codeExecution: true });
      try {
        const sendTo = (to: string) => `await tools["discord--send_message"]({ channelId: ${JSON.stringify(to)}, text: "x" });`;
        await h.turn([
          createMockResponse([text('One.'), script('ce1', sendTo(ROOM) + sendTo(GENERAL) + sendTo(GENERAL))], 'tool_use'),
          createMockResponse([text('Two.'), send('s1', GENERAL)], 'tool_use'),
          createMockResponse([text('Three.'), call('l1', 'channel_list', {})], 'tool_use'),
          createMockResponse([]),
        ]);
        assert.deepEqual(h.sends().map((s) => s.channelId), [ROOM, GENERAL, GENERAL, GENERAL]);
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [['One.', 'explicit-send'], ['Two.', 'explicit-send'], ['Three.', 'explicit-send']]);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a send the dispatcher refuses holds nothing`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true, serverConfig: { disabledTools: ['send_message'] } });
      try {
        await h.turn([createMockResponse([text(LINE), send('s1', ROOM)], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(h.sends(), []);
        assert.deepEqual(inRoom(h), [LINE]);
        assert.deepEqual(held(h), []);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: an answer naming a channel the framework can't match holds the line, and says so`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.sendMode('delivered', 'discord:g1:nowhere');
        await h.turn([createMockResponse([text(LINE), send('s1', GENERAL)], 'tool_use'), createMockResponse([])]);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
        assert.match(notices(h)[0]!, /can't tell where your send_message in this round posted \(its answer named a channel the framework couldn't match to one it knows\)/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a round whose script returned, its send still out when its stream ends, holds its line`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true, codeExecution: true });
      try {
        await h.sendMode('hang');
        const publish = `await tools.channel_publish({ channelId: ${JSON.stringify(GENERAL)}, content: "x" });`;
        h.membrane.pushResponse(createMockResponse([text(LINE), script('ce1', publish), send('s1', GENERAL)], 'tool_use'));
        h.command({ op: 'incoming', channelId: ROOM, messageId: 'in-script', mode: 'addressed', text: 'hello' });
        const agent = h.framework.getAgent('scout')!;
        await h.until(() => h.sends().length === 1 && agent.getPendingToolIds().join() === 's1', 'the script returned, the send out');
        assert.ok(h.framework.abortInference('scout'));
        await h.until(() => !(h.framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has('scout'), 'turn end');
        await h.framework.runUntilIdle();
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a round withheld while its script runs still holds the turn's later speech to where its sends may post`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true, codeExecution: true });
      try {
        await h.sendMode('hang');
        const hangs = `await tools["discord--send_message"]({ channelId: ${JSON.stringify(GENERAL)}, text: "x" });`;
        const round = [text(LINE), script('ce1', hangs), send('s1', GENERAL)];
        completeWhileWaiting(h.membrane, { ...createMockResponse([...round, text('After.')]), toolCalls: [] });
        await h.turn([createMockResponse(round, 'tool_use')]);
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [['After.', 'explicit-send']]);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: the resend example names the place exactly when it has no name a prefix can carry`, async () => {
      const LOUNGE = 'discord:g1:the lounge';
      const h = await harness({
        agents: [{ name: 'scout', proseRouting: mode }], sendTool: true,
        channels: [{ id: ROOM, label: '#room (Guild One)' }, { id: GENERAL, label: '#general (Guild One)' }, { id: LOUNGE, label: 'the lounge' }],
      });
      try {
        h.membrane.pushResponse(createMockResponse([text(LINE), send('s1', LOUNGE)], 'tool_use'));
        h.membrane.pushResponse(createMockResponse([]));
        h.command({ op: 'incoming', channelId: LOUNGE, messageId: 'in-lounge', mode: 'addressed', text: 'hello' });
        await h.until(() => notices(h).length > 0, 'the notice');
        await h.until(() => !(h.framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has('scout'), 'turn end');
        assert.match(notices(h)[0]!, /destination: "[^"]*the lounge"\) delivers it unchanged/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: after a guard retry, the turn's sends still hold its speech only where they may have posted`, async () => {
      for (const [place, goes] of [[GENERAL, true], [ROOM, false]] as const) {
        const h = await harness({ agents: [{ name: 'scout', proseRouting: mode, toolResultGuard: true }], sendTool: true });
        try {
          onSecondStream(h.membrane, createMockResponse([text(LINE)]));
          const refusal = { ...createMockResponse([text('discarded')], 'refusal'), raw: { request: {}, response: { stop_details: { category: 'test' } } } } as NormalizedResponse;
          await h.turn([createMockResponse([send('s1', place)], 'tool_use'), refusal]);
          assert.equal(h.membrane.calls.length, 2, 'the guard retried the turn');
          assert.deepEqual(inRoom(h), goes ? [LINE] : []);
          assert.deepEqual(held(h), goes ? [] : [[LINE, 'explicit-send']]);
        } finally {
          await h.close();
        }
      }
    });

    it(`${mode}: the resend example says "#<channel>", which reaches no channel, where no name a resend could take reaches the place`, async () => {
      const INBOUND = 'discord:g1:announcements';
      const h = await harness({
        agents: [{ name: 'scout', proseRouting: mode }], sendTool: true,
        channels: [{ id: ROOM, label: '#room (Guild One)' }, { id: GENERAL, label: '#general (Guild One)' }, { id: INBOUND, label: '#announcements (Guild One)', direction: 'inbound' }],
      });
      try {
        h.membrane.pushResponse(createMockResponse([text(LINE), send('s1', INBOUND)], 'tool_use'));
        h.membrane.pushResponse(createMockResponse([]));
        h.command({ op: 'incoming', channelId: INBOUND, messageId: 'in-inbound', mode: 'addressed', text: 'hello' });
        await h.until(() => notices(h).length > 0, 'the notice');
        await h.until(() => !(h.framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has('scout'), 'turn end');
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
        assert.match(notices(h)[0]!, /your send_message in this round delivered to #announcements/);
        assert.match(notices(h)[0]!, /destination: "#<channel>"\) delivers it unchanged/);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a round whose stream ends before its send answers holds its line`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }], sendTool: true });
      try {
        await h.sendMode('hang');
        h.membrane.pushResponse(createMockResponse([text(LINE), send('s1', GENERAL)], 'tool_use'));
        h.command({ op: 'incoming', channelId: ROOM, messageId: 'in-hang', mode: 'addressed', text: 'hello' });
        await h.until(() => h.sends().length === 1, 'the send');
        assert.ok(h.framework.abortInference('scout'));
        await h.until(() => !(h.framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has('scout'), 'turn end');
        await h.framework.runUntilIdle();
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
      } finally {
        await h.close();
      }
    });
  }

  it('hybrid: each envelope is held or sent by where it was going', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], sendTool: true });
    try {
      await h.turn([createMockResponse([text(`For you.\n>>>${GENERAL} And a word for general.`), send('s1', GENERAL)], 'tool_use'), createMockResponse([])]);
      assert.deepEqual(inRoom(h), ['For you.']);
      assert.deepEqual(held(h), [['And a word for general.', 'explicit-send']]);
      assert.equal(h.drafts()[0]!.note, `written for >>>${GENERAL}`);
    } finally {
      await h.close();
    }
  });

  it("hybrid: an unprefixed envelope is decided by the sticky target an earlier '>>>' set", async () => {
    for (const [place, goes] of [[ROOM, true], [GENERAL, false]] as const) {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], sendTool: true });
      try {
        await h.turn([
          createMockResponse([text(`>>>${GENERAL} first`), call('l1', 'channel_list', {})], 'tool_use'),
          createMockResponse([text('second'), send('s1', place)], 'tool_use'),
          createMockResponse([]),
        ]);
        const inGeneral = h.publishes().filter((p) => p.event === 'publish' && p.channelId === GENERAL).map((p) => p.text);
        assert.deepEqual(inGeneral, goes ? ['first', 'second'] : ['first']);
        assert.deepEqual(held(h), goes ? [] : [['second', 'explicit-send']]);
      } finally {
        await h.close();
      }
    }
  });

  it('hybrid: envelopes held for several places keep the order they were written in', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], sendTool: true });
    try {
      await h.turn([
        createMockResponse([text(`>>>${ROOM} first\n>>>${GENERAL} second\n>>>${ROOM} third`), send('s1', ROOM), send('s2', GENERAL)], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(held(h), [['first', 'explicit-send'], ['second', 'explicit-send'], ['third', 'explicit-send']]);
    } finally {
      await h.close();
    }
  });

  it("hybrid: a closing envelope that only names a destination isn't reported as closing words held", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid', autoContinue: true }], sendTool: true });
    try {
      await h.turn([createMockResponse([text(LINE), send('s1', ROOM)], 'tool_use'), createMockResponse([text(`>>>${ROOM}`)])]);
      await h.until(() => h.texts().some((t) => t.startsWith('[continue]')), 'the continuation row');
      const row = h.texts().find((t) => t.startsWith('[continue]'))!;
      assert.doesNotMatch(row, /closing words last turn were held/, row);
    } finally {
      await h.close();
    }
  });

  it('hybrid: a target that names no channel bounces beside a send whose place is known', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], sendTool: true });
    try {
      await h.turn([createMockResponse([text('>>>#nowhere lost words'), send('s1', GENERAL)], 'tool_use'), createMockResponse([])]);
      assert.deepEqual(held(h).map(([, reason]) => reason), ['bounced']);
    } finally {
      await h.close();
    }
  });

  it("XML tool mode: a stream that completes while a round's send is still out holds the turn's speech to that place", async () => {
    const hangs = `await tools["discord--send_message"]({ channelId: ${JSON.stringify(GENERAL)}, text: "x" });`;
    for (const round of [[text(LINE), send('s1', ROOM)], [text(LINE), script('ce1', hangs), send('s1', ROOM)]]) {
      const h = await harness({ xml: true, sendTool: true, codeExecution: true });
      try {
        await h.sendMode('hang');
        completeWhileWaiting(h.membrane, { ...createMockResponse(round), toolCalls: [] });
        await h.turn([createMockResponse(round, 'tool_use')]);
        assert.deepEqual(inRoom(h), []);
        assert.deepEqual(held(h), [[LINE, 'explicit-send']]);
      } finally {
        await h.close();
      }
    }
  });

  it("XML tool mode: the turn's speech is held only where one of its sends may have posted", async () => {
    for (const [to, goes] of [[GENERAL, true], [ROOM, false]] as const) {
      const h = await harness({ xml: true, sendTool: true });
      try {
        const round = [text(LINE), send('s1', to)];
        await h.turn([createMockResponse(round, 'tool_use'), { ...createMockResponse(round), toolCalls: [] }]);
        assert.deepEqual(inRoom(h), goes ? [LINE] : []);
        assert.deepEqual(held(h), goes ? [] : [[LINE, 'explicit-send']]);
      } finally {
        await h.close();
      }
    }
  });
});

describe('a turn whose stream fails or is stopped after a tool round', () => {
  const SPEECH = 'The words written before the tool call.';
  const AFTER = 'The words the retried call writes.';
  const NOTICE = '[speech-not-posted]';
  type H = Awaited<ReturnType<typeof harness>>;
  const published = (h: H, words: string) => h.publishes().filter((p) => p.event === 'publish' && p.text.includes(words));
  const receipts = (h: H) => h.texts().filter((t) => t.startsWith('[delivered]'));
  const notices = (h: H) => h.texts().filter((t) => t.startsWith(NOTICE));
  const markers = (h: H) => h.texts().filter((t) => t.startsWith('[inference-failed]'));
  const AFTER_ROUNDS = /Your previous turn did not complete: it failed( \([^)]*\))?\. Its earlier rounds ran, and their tool calls ran as their results show/;
  const EARLIER = 'Its earlier rounds ran, and their tool calls ran as their results show.';
  const CUT_OFF = "A round's tool calls were started, but its stream ended before their results came back, so that round isn't in your context; those calls may have taken effect.";
  const speechSettled = (h: H) => (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('scout');
  const capture = (h: H) => {
    const cm = h.framework.getAgent('scout')!.getContextManager();
    const written: string[] = [];
    const addMessage = cm.addMessage.bind(cm);
    cm.addMessage = ((...args: Parameters<typeof addMessage>) => {
      const id = addMessage(...args);
      for (const block of args[1] as ContentBlock[]) if (block.type === 'text') written.push((block as { text: string }).text);
      return id;
    }) as typeof cm.addMessage;
    return written;
  };
  const onSnapshot = (h: H, at: number, act: () => void) => {
    const fw = h.framework as unknown as { captureInferenceToolSnapshot: (agent: unknown) => unknown };
    const snapshot = fw.captureInferenceToolSnapshot.bind(fw);
    let snapshots = 0;
    fw.captureInferenceToolSnapshot = (agent: unknown) => {
      if (++snapshots === at) act();
      return snapshot(agent);
    };
    return () => snapshots;
  };
  const accelerationLimit = () => new MembraneError({
    type: 'rate_limit', retryable: true, httpStatus: 429,
    message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
    rawError: { status: 429 },
  });
  const asks = (request: NormalizedRequest | undefined) => JSON.stringify(request?.messages ?? []).includes(NOTICE);
  const round = () => createMockResponse([text(SPEECH), call('l1', 'channel_list', {})], 'tool_use');
  const failingCompile = (h: H, at: number) => {
    const agent = h.framework.getAgent('scout')!;
    const compile = agent.startStreamWithInjections.bind(agent);
    let compiles = 0;
    agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
      if (++compiles === at) throw new Error("the retry's request could not be built");
      return compile(...args);
    }) as typeof agent.startStreamWithInjections;
    return () => compiles;
  };
  const traced = (h: H, type: string) => {
    let seen = false;
    h.framework.onTrace((event) => { if (event.type === type) seen = true; });
    return () => seen;
  };
  const startTurn = async (h: H) => {
    h.membrane.pushResponse(round());
    h.membrane.pushResponse(createMockResponse([]));
    h.command({ op: 'incoming', channelId: ROOM, messageId: `in-${Date.now()}`, mode: 'addressed', text: 'a question' });
    await h.until(() => h.messages().some((m) => m.content.some((b) => b.type === 'tool_result')), "the round's results are stored");
  };
  const turnEnded = async (h: H) => {
    await h.until(() => !(h.framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has('scout'), 'turn end');
    await h.framework.runUntilIdle();
  };

  describe('XML tool mode: the speech is named, not posted', () => {
    for (const [how, shown] of [['error', 'an error'], ['throw', 'a throw'], ['abort', "an abort that isn't a stop"]] as const) {
      it(`a failure after the round, reported as ${shown}, posts and holds nothing, and a notice names the speech beside a marker saying the rounds ran`, async () => {
        const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 0 });
        try {
          breakAfterToolRound(h.membrane, how);
          await h.turn([createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use')]);
          assert.equal(h.sends().length, 1, 'premise: the send to the other channel went out');
          assert.equal(published(h, SPEECH).length, 0);
          assert.equal(published(h, PARTIAL).length, 0);
          assert.equal(h.drafts().length, 0);
          assert.deepEqual(notices(h), ['[speech-not-posted] Nothing you wrote before your tool calls in the rounds just above was posted. If any of it should go out, send it again.']);
          assert.equal(markers(h).length, 1);
          assert.match(markers(h)[0]!, AFTER_ROUNDS);
          assert.ok(!markers(h)[0]!.includes(CUT_OFF), markers(h)[0]);
        } finally {
          await h.close();
        }
      });
    }

    it("a retry after the failure carries the notice in the retried request, posts only the retried call's words, and writes one receipt at the turn's end", async () => {
      const h = await harness({ xml: true, roundPreamble: true, retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        onSecondStream(h.membrane, createMockResponse([text(AFTER)]));
        await h.turn([round()]);
        assert.equal(h.membrane.calls.length, 2, 'premise: the retry ran');
        assert.ok(!asks(h.membrane.calls[0]), 'the first request had no notice');
        assert.ok(asks(h.membrane.calls[1]), 'the retried request carries it');
        assert.equal(notices(h).length, 1);
        assert.equal(published(h, SPEECH).length, 0);
        assert.deepEqual(published(h, AFTER).map((p) => p.channelId), [ROOM]);
        assert.equal(receipts(h).length, 1, receipts(h).join('\n'));
        assert.equal(markers(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it("a budget restart after the round carries the notice once, in the continuation's request", async () => {
      const h = await harness({ xml: true, roundPreamble: true, agents: [{ name: 'scout', maxStreamTokens: 5 }] });
      try {
        onSecondStream(h.membrane, createMockResponse([text(AFTER)]));
        await h.turn([round()]);
        assert.equal(h.membrane.calls.length, 2, 'premise: the stream restarted once');
        assert.ok(asks(h.membrane.calls[1]), "the continuation's request carries the notice");
        assert.equal(notices(h).length, 1);
        assert.equal(published(h, SPEECH).length, 0);
        assert.equal(h.drafts().length, 0);
      } finally {
        await h.close();
      }
    });

    it("a tool-result guard's retry after the round carries the notice in the retried request", async () => {
      const h = await harness({ xml: true, roundPreamble: true, agents: [{ name: 'scout', toolResultGuard: true }] });
      try {
        onSecondStream(h.membrane, createMockResponse([text(AFTER)]));
        const refusal = { ...createMockResponse([text('discarded')], 'refusal'), raw: { request: {}, response: { stop_details: { category: 'test' } } } } as NormalizedResponse;
        await h.turn([round(), refusal]);
        assert.equal(h.membrane.calls.length, 2, 'premise: the guard retried the turn');
        assert.ok(asks(h.membrane.calls[1]), 'the retried request carries the notice');
        assert.equal(notices(h).length, 1);
        assert.equal(published(h, SPEECH).length, 0);
        assert.equal(h.drafts().length, 0);
      } finally {
        await h.close();
      }
    });

    it("a retry whose request can't be built names the speech where the turn ends", async () => {
      const h = await harness({ xml: true, roundPreamble: true, retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        const compiles = failingCompile(h, 2);
        await h.turn([round()]);
        assert.equal(compiles(), 2, 'premise: the retry tried to start');
        assert.equal(notices(h).length, 1);
        assert.match(markers(h)[0]!, AFTER_ROUNDS);
      } finally {
        await h.close();
      }
    });

    for (const [stopEnds, shown] of [['aborted', 'an aborted event'], ['error', 'an error'], ['silent', 'a silent end'], ['throw', 'a throw']] as const) {
      it(`a user's Stop the stream reports as ${shown} posts and holds nothing, and names the speech beside the stop's note`, async () => {
        const h = await harness({ xml: true, roundPreamble: true });
        try {
          breakAfterToolRound(h.membrane, 'stop', { stopEnds });
          await startTurn(h);
          assert.equal(h.framework.abortInference('scout', 'operator stop'), true);
          await turnEnded(h);
          assert.equal(published(h, SPEECH).length, 0);
          assert.equal(published(h, PARTIAL).length, 0);
          assert.equal(h.drafts().length, 0);
          assert.equal(notices(h).length, 1);
          assert.ok(h.texts().some((t) => t.startsWith('[turn-interrupted]')));
        } finally {
          await h.close();
        }
      });
    }

    it('a quiesce that abandons the turn names the speech in words with no actor or stop, and writes no stop note', async () => {
      const h = await harness({ xml: true, roundPreamble: true });
      try {
        breakAfterToolRound(h.membrane, 'stop');
        await startTurn(h);
        await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000, abandon: true });
        await turnEnded(h);
        assert.equal(published(h, SPEECH).length, 0);
        assert.equal(h.drafts().length, 0);
        assert.equal(notices(h).length, 1);
        assert.doesNotMatch(notices(h)[0]!, /stop|interrupt|abandon|operator|quiesce|someone|shut/i);
        assert.ok(!h.texts().some((t) => t.startsWith('[turn-interrupted]')));
        await h.framework.resume();
      } finally {
        await h.close();
      }
    });

    it('a shutdown while the turn runs names the speech, and writes no stop note', async () => {
      const h = await harness({ xml: true, roundPreamble: true });
      try {
        breakAfterToolRound(h.membrane, 'stop');
        await startTurn(h);
        const written = capture(h);
        await h.framework.stop();
        assert.equal(published(h, SPEECH).length, 0);
        assert.equal(written.filter((t) => t.startsWith(NOTICE)).length, 1, written.join('\n'));
        assert.ok(!written.some((t) => t.startsWith('[turn-interrupted]') || t.startsWith('[delivered]')));
      } finally {
        await h.close();
      }
    });

    it("a stop while the round's tool still runs names nothing, since that round never reached the context, and its stop note says the round's calls were started", async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true });
      try {
        await h.sendMode('hang');
        h.membrane.pushResponse(createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use'));
        h.command({ op: 'incoming', channelId: ROOM, messageId: 'in-hang', mode: 'addressed', text: 'a question' });
        await h.until(() => h.sends().length === 1, 'the send');
        assert.equal(h.framework.abortInference('scout', 'operator stop'), true);
        await turnEnded(h);
        assert.ok(!h.messages().some((m) => JSON.stringify(m.content).includes(SPEECH)), 'premise: the round is not in the context');
        assert.equal(notices(h).length, 0);
        const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.includes(CUT_OFF), notes[0]);
      } finally {
        await h.close();
      }
    });

    it("a user's Stop during the retry's wait, after a stream cut off while its tool ran, says that round's calls were started", async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 1, retryDelayMs: 60_000 });
      try {
        await h.sendMode('hang');
        const failed = traced(h, 'inference:failed');
        failWhileToolsRun(h.membrane);
        h.membrane.pushResponse(createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use'));
        h.command({ op: 'incoming', channelId: ROOM, messageId: 'in-wait', mode: 'addressed', text: 'a question' });
        await h.until(failed, 'the failure');
        await h.until(() => h.framework.abortInference('scout', 'operator stop'), 'the stop reaches the waiting retry');
        await turnEnded(h);
        assert.equal(h.membrane.calls.length, 1, 'premise: the retry never ran');
        assert.equal(markers(h).length, 0, 'premise: the stop note stands in for the failure note');
        const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.includes(CUT_OFF), notes[0]);
      } finally {
        await h.close();
      }
    });

    it('a turn a tool ends names the speech, and writes no failure note', async () => {
      const ender = {
        name: 'ender',
        start: async () => {},
        stop: async () => {},
        getTools: () => [{ name: 'stop_here', description: 'End the turn', inputSchema: { type: 'object', properties: {} } }],
        handleToolCall: async () => ({ success: true, data: 'done', endTurn: true }),
        onProcess: async () => ({}),
      } as unknown as Module;
      const h = await harness({ xml: true, roundPreamble: true, modules: [ender] });
      try {
        await h.turn([createMockResponse([text(SPEECH), call('e1', 'ender--stop_here', {})], 'tool_use')]);
        assert.ok(h.messages().some((m) => m.content.some((b) => b.type === 'tool_result')), "premise: the round's result is stored");
        assert.equal(published(h, SPEECH).length, 0);
        assert.equal(notices(h).length, 1);
        assert.equal(markers(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it('a turn its own skip_reply ends names nothing, directly or from a script', async () => {
      const h = await harness({ xml: true, roundPreamble: true, codeExecution: true });
      try {
        let ended = 0;
        h.framework.onTrace((event) => { if (event.type === 'inference:turn_ended') ended++; });
        await h.turn([round(), createMockResponse([text(SPEECH), call('k1', 'skip_reply', {})], 'tool_use')]);
        await h.turn([round(), createMockResponse([text(SPEECH), call('ce1', 'code_execution', { code: 'await tools.skip_reply({});' })], 'tool_use'), createMockResponse([])]);
        assert.equal(ended, 2, 'premise: each skip_reply ended its turn');
        assert.equal(published(h, SPEECH).length, 0, 'premise: the speech stayed private');
        assert.equal(notices(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it('a silent turn that fails after its round names nothing and writes no receipt', async () => {
      const h = await harness({ xml: true, roundPreamble: true, retries: 0 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        await h.turn([round()], 'scout', 'silent');
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.equal(notices(h).length, 0);
        assert.equal(receipts(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it('a round whose text is only a tool call names nothing', async () => {
      const h = await harness({ xml: true, roundPreamble: true, retries: 0 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        await h.turn([createMockResponse([call('l1', 'channel_list', {})], 'tool_use')]);
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.ok(markers(h)[0]!.includes(EARLIER), markers(h)[0]);
        assert.equal(notices(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it('a failure while the only round\'s tool still runs says its calls were started and may have taken effect, and names nothing', async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 0 });
      try {
        await h.sendMode('hang');
        failWhileToolsRun(h.membrane);
        await h.turn([createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use')]);
        assert.ok(!h.messages().some((m) => JSON.stringify(m.content).includes(SPEECH)), 'premise: the round is not in the context');
        assert.equal(markers(h).length, 1);
        assert.ok(markers(h)[0]!.includes(CUT_OFF), markers(h)[0]);
        assert.ok(!markers(h)[0]!.includes(EARLIER), markers(h)[0]);
        assert.equal(notices(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it("a failure while a later round's tool still runs says the earlier rounds ran and the last one's calls were started", async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 0 });
      try {
        await h.sendMode('hang');
        failWhileToolsRun(h.membrane, 2);
        await h.turn([round(), createMockResponse([text(AFTER), unplacedSend('s1')], 'tool_use')]);
        assert.equal(markers(h).length, 1);
        assert.ok(markers(h)[0]!.includes(EARLIER), markers(h)[0]);
        assert.ok(markers(h)[0]!.includes(CUT_OFF), markers(h)[0]);
        assert.equal(notices(h).length, 1);
      } finally {
        await h.close();
      }
    });

    it("a silent turn whose retry fails before a round of its own, after a first stream cut off while its tool ran, says the calls were started", async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 1 });
      try {
        await h.sendMode('hang');
        failWhileToolsRun(h.membrane);
        breakAfterToolRound(h.membrane, 'error', { fromStart: true, stream: 2 });
        await h.turn([createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use')], 'scout', 'silent');
        assert.equal(h.membrane.calls.length, 2, 'premise: the retry ran');
        assert.equal(markers(h).length, 1);
        assert.ok(markers(h)[0]!.includes(CUT_OFF), markers(h)[0]);
        assert.ok(!markers(h)[0]!.includes(EARLIER), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it("a user's Stop at a silent turn's retry start, after its first stream was cut off while its tool ran, says the turn was stopped before it finished and that round's calls were started", async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 1 });
      try {
        await h.sendMode('hang');
        failWhileToolsRun(h.membrane);
        let stopped = false;
        onSnapshot(h, 2, () => { stopped = h.framework.abortInference('scout', 'operator stop'); });
        h.membrane.pushResponse(createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use'));
        (h.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
          agentName: 'scout', reason: 'test', source: 'test', timestamp: Date.now(), suppressProse: true,
        });
        await h.until(() => stopped, "the stop reaches the retry's start");
        await turnEnded(h);
        assert.equal(h.membrane.calls.length, 1, 'premise: the retry never compiled');
        const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.includes('stopped before it finished'), notes[0]);
        assert.ok(notes[0]!.includes(CUT_OFF), notes[0]);
      } finally {
        await h.close();
      }
    });

    it("a user's Stop at a silent turn's retry start, after its first stream's round reached the context, says the turn was stopped before it finished, and nothing of calls or delivery", async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        let stopped = false;
        onSnapshot(h, 2, () => { stopped = h.framework.abortInference('scout', 'operator stop'); });
        h.membrane.pushResponse(round());
        (h.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
          agentName: 'scout', reason: 'test', source: 'test', timestamp: Date.now(), suppressProse: true,
        });
        await h.until(() => stopped, "the stop reaches the retry's start");
        await turnEnded(h);
        assert.equal(h.membrane.calls.length, 1, 'premise: the retry never compiled');
        assert.ok(h.messages().some((m) => m.content.some((b) => b.type === 'tool_result')), "premise: the round's results are in the context");
        assert.deepEqual(h.texts().filter((t) => t.startsWith('[turn-interrupted]')),
          ['[turn-interrupted] Your previous turn was stopped before it finished — a deliberate stop, not a failure.']);
        assert.equal(markers(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it("a retry whose round reaches the context, after a first stream cut off while its tool ran, says the earlier rounds ran and the cut-off round's calls were started", async () => {
      const h = await harness({ xml: true, roundPreamble: true, sendTool: true, retries: 1 });
      try {
        await h.sendMode('hang');
        failWhileToolsRun(h.membrane);
        breakAfterToolRound(h.membrane, 'error', { stream: 2 });
        onSecondStream(h.membrane, round());
        await h.turn([createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use')]);
        assert.equal(h.membrane.calls.length, 2, 'premise: the retry ran');
        assert.equal(markers(h).length, 1);
        assert.ok(markers(h)[0]!.includes(EARLIER), markers(h)[0]);
        assert.ok(markers(h)[0]!.includes(CUT_OFF), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    for (const how of ['error', 'throw'] as const) {
      it(`a provider-acceleration failure, reported as ${how === 'error' ? 'an error' : 'a throw'}, after stop() has closed admission names the speech`, async () => {
        const h = await harness({ xml: true, roundPreamble: true, retries: 1 });
        try {
          breakAfterToolRound(h.membrane, how, {
            failure: accelerationLimit,
            beforeFailure: () => { (h.framework as unknown as { providerAdmissionClosed: boolean }).providerAdmissionClosed = true; },
          });
          await h.turn([round()]);
          assert.equal(h.membrane.calls.length, 1, 'premise: nothing was retried');
          assert.equal(markers(h).length, 0, 'premise: the turn ended without exhausting');
          assert.equal(notices(h).length, 1);
        } finally {
          await h.close();
        }
      });
    }

    for (const how of ['error', 'throw'] as const) {
      it(`a conversation agent's stated provider wait, reported as ${how === 'error' ? 'an error' : 'a throw'}, after stop() has closed admission names the speech`, async () => {
        const h = await harness({ xml: true, roundPreamble: true, retries: 1 });
        try {
          // main's test makes scout a conversation agent through conversationAgentHomes; on this
          // branch that is the registry's record: a home channel, and a role that doesn't own
          // provider scheduling (as conversationForkSpec gives a fork).
          const scout = (h.framework as unknown as {
            registry: { live: Map<string, { homeChannel?: { serverId: string; channelId: string }; roles: { ownsProviderScheduling: boolean } }> };
          }).registry.live.get('scout')!;
          scout.homeChannel = { serverId: 'discord', channelId: ROOM };
          scout.roles.ownsProviderScheduling = false;
          breakAfterToolRound(h.membrane, how, {
            failure: () => new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 30_000, message: 'rate limited', rawError: { status: 429 } }),
            beforeFailure: () => { (h.framework as unknown as { providerAdmissionClosed: boolean }).providerAdmissionClosed = true; },
          });
          await h.turn([round()]);
          assert.equal(h.membrane.calls.length, 1, 'premise: nothing was retried');
          assert.equal(markers(h).length, 0, 'premise: the turn ended without exhausting');
          assert.equal(notices(h).length, 1);
        } finally {
          await h.close();
        }
      });
    }

    it("a retry that stop() drops at the check after its hooks names the speech", async () => {
      const h = await harness({ xml: true, roundPreamble: true, retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        const written = capture(h);
        let stopping: Promise<void> | undefined;
        onSnapshot(h, 2, () => { stopping = h.framework.stop(); });
        h.membrane.pushResponse(round());
        h.command({ op: 'incoming', channelId: ROOM, messageId: 'in-drop', mode: 'addressed', text: 'a question' });
        await h.until(() => stopping !== undefined, "the retry's start");
        await stopping;
        assert.equal(h.membrane.calls.length, 1, 'premise: the retry was dropped before its compile');
        assert.equal(written.filter((t) => t.startsWith(NOTICE)).length, 1, written.join('\n'));
      } finally {
        await h.close();
      }
    });

    it("stop() during the retry's wait names the speech", async () => {
      const h = await harness({ xml: true, roundPreamble: true, retries: 1, retryDelayMs: 60_000 });
      try {
        const failed = traced(h, 'inference:failed');
        breakAfterToolRound(h.membrane, 'error');
        const written = capture(h);
        await startTurn(h);
        await h.until(failed, 'the failure');
        await h.framework.stop();
        assert.equal(h.membrane.calls.length, 1, 'premise: the retry never ran');
        assert.equal(written.filter((t) => t.startsWith(NOTICE)).length, 1, written.join('\n'));
      } finally {
        await h.close();
      }
    });

    it("stop() during the wait after a retry's start failed names the speech", async () => {
      const h = await harness({ xml: true, roundPreamble: true, retries: 2, retryDelayMs: [10, 600_000] });
      try {
        breakAfterToolRound(h.membrane, 'error');
        let threw = false;
        onSnapshot(h, 2, () => { threw = true; throw new Error('the tool snapshot failed'); });
        let waits = 0;
        h.framework.onTrace((event) => { if (event.type === 'inference:waiting') waits++; });
        const written = capture(h);
        await startTurn(h);
        await h.until(() => threw, "the retry's start failed");
        await h.until(() => waits >= 2, 'the next wait');
        await h.framework.stop();
        assert.equal(h.membrane.calls.length, 1, 'premise: no retry compiled');
        assert.equal(written.filter((t) => t.startsWith(NOTICE)).length, 1, written.join('\n'));
      } finally {
        await h.close();
      }
    });

    it('a completed turn posts its rounds and names nothing', async () => {
      const h = await harness({ xml: true, roundPreamble: true });
      try {
        await h.turn([round(), { ...createMockResponse([text(SPEECH), call('l1', 'channel_list', {}), text(AFTER)]), toolCalls: [] }]);
        assert.deepEqual(published(h, SPEECH).map((p) => p.channelId), [ROOM]);
        assert.deepEqual(published(h, AFTER).map((p) => p.channelId), [ROOM]);
        assert.equal(receipts(h).length, 1, receipts(h).join('\n'));
        assert.equal(notices(h).length, 0);
      } finally {
        await h.close();
      }
    });
  });

  describe('native tool mode: the failure and stop notes', () => {
    const HANDED_ON = 'Plain speech its rounds routed live was handed on for delivery as written, and no [delivered] line was written for it.';
    const STILL_ROUTING = 'Some of its plain speech was still being routed when it ended, so it may yet be posted; check the channel before sending it again.';
    for (const [how, shown] of [['error', 'an error'], ['throw', 'a throw'], ['abort', "an abort that isn't a stop"]] as const) {
      it(`a failure after a live-routed round, reported as ${shown}, says the rounds ran and the speech was handed on, and writes no receipt`, async () => {
        const h = await harness({ retries: 0 });
        try {
          breakAfterToolRound(h.membrane, how, { beforeFailure: () => speechSettled(h) });
          await h.turn([round()]);
          await h.until(() => published(h, SPEECH).length === 1, 'premise: the speech was routed live');
          assert.deepEqual(published(h, SPEECH).map((p) => p.channelId), [ROOM]);
          assert.equal(published(h, PARTIAL).length, 0);
          assert.equal(markers(h).length, 1);
          assert.match(markers(h)[0]!, AFTER_ROUNDS);
          assert.ok(markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
          assert.ok(!markers(h)[0]!.includes(CUT_OFF), markers(h)[0]);
          assert.equal(receipts(h).length, 0);
          assert.equal(notices(h).length, 0);
        } finally {
          await h.close();
        }
      });
    }

    it('a failure after a round whose speech was held, not routed, says the rounds ran and nothing of handing on', async () => {
      const h = await harness({ sendTool: true, retries: 0 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        await h.turn([createMockResponse([text(SPEECH), call('s1', 'discord--send_message', { channelId: ROOM, text: 'an explicit note' })], 'tool_use')]);
        assert.equal(published(h, SPEECH).length, 0, 'premise: the speech was held');
        assert.match(markers(h)[0]!, AFTER_ROUNDS);
        assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it('explicit mode: a failure says nothing of handing on', async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }], retries: 0 });
      try {
        breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
        await h.turn([createMockResponse([text(`>>#room ${SPEECH}`), call('l1', 'channel_list', {})], 'tool_use')]);
        await h.until(() => published(h, SPEECH).length === 1, 'premise: the envelope was delivered live');
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it('hybrid mode: a failure after a round whose speech went to its locus says it was handed on; one kept private by >>>skip_reply says nothing of it', async () => {
      for (const [words, live] of [[SPEECH, true], [`>>>skip_reply ${SPEECH}`, false]] as const) {
        const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], retries: 0 });
        try {
          breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
          await h.turn([createMockResponse([text(words), call('l1', 'channel_list', {})], 'tool_use')]);
          if (live) await h.until(() => published(h, SPEECH).length === 1, 'premise: the speech went to its locus');
          else assert.equal(published(h, SPEECH).length, 0, 'premise: the speech was kept private');
          assert.equal(markers(h).length, 1, 'premise: the turn failed');
          assert.equal(markers(h)[0]!.includes(HANDED_ON), live, markers(h)[0]);
        } finally {
          await h.close();
        }
      }
    });

    it("a user's Stop after a round that wrote nothing says nothing of handing on", async () => {
      const h = await harness({});
      try {
        breakAfterToolRound(h.membrane, 'stop');
        h.membrane.pushResponse(createMockResponse([call('l1', 'channel_list', {})], 'tool_use'));
        h.membrane.pushResponse(createMockResponse([]));
        h.command({ op: 'incoming', channelId: ROOM, messageId: 'in-quiet', mode: 'addressed', text: 'a question' });
        await h.until(() => h.messages().some((m) => m.content.some((b) => b.type === 'tool_result')), "the round's results are stored");
        assert.equal(h.framework.abortInference('scout', 'operator stop'), true);
        await turnEnded(h);
        const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
        assert.equal(notes.length, 1);
        assert.ok(!notes[0]!.includes(HANDED_ON), notes[0]);
      } finally {
        await h.close();
      }
    });

    it("a failure while the only round's tool still runs says its calls were started and may have taken effect", async () => {
      const h = await harness({ sendTool: true, retries: 0 });
      try {
        await h.sendMode('hang');
        failWhileToolsRun(h.membrane);
        await h.turn([createMockResponse([text(SPEECH), unplacedSend('s1')], 'tool_use')]);
        assert.equal(markers(h).length, 1);
        assert.ok(markers(h)[0]!.includes(CUT_OFF), markers(h)[0]);
        assert.ok(!markers(h)[0]!.includes(EARLIER), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it("hybrid mode: a failure after a round whose >>> envelope was delivered says it was handed on", async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], retries: 0 });
      try {
        breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
        await h.turn([createMockResponse([text(`>>>${ROOM} ${SPEECH}`), call('l1', 'channel_list', {})], 'tool_use')]);
        await h.until(() => published(h, SPEECH).length === 1, 'premise: the envelope was delivered');
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.ok(markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it("hybrid mode: a failure while a round's delivery is still being routed says it may yet be posted", async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], retries: 0 });
      try {
        h.command({ op: 'publish-mode', mode: 'hang' });
        breakAfterToolRound(h.membrane, 'error');
        await h.turn([createMockResponse([text(SPEECH), call('l1', 'channel_list', {})], 'tool_use')]);
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.ok(markers(h)[0]!.includes(STILL_ROUTING), markers(h)[0]);
        assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it('hybrid mode: a failure after the round\'s delivery settled says nothing of it still being routed', async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], retries: 0 });
      try {
        breakAfterToolRound(h.membrane, 'error', {
          beforeFailure: async () => {
            await (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('scout');
            assert.equal(published(h, SPEECH).length, 1, 'premise: the delivery settled');
          },
        });
        await h.turn([createMockResponse([text(SPEECH), call('l1', 'channel_list', {})], 'tool_use')]);
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.ok(markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
        assert.ok(!markers(h)[0]!.includes(STILL_ROUTING), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it('locus mode: a failure while the delivery is still being routed says it may yet be posted, and nothing of handing on', async () => {
      const h = await harness({ retries: 0 });
      try {
        h.command({ op: 'publish-mode', mode: 'hang' });
        breakAfterToolRound(h.membrane, 'error');
        await h.turn([round()]);
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.ok(markers(h)[0]!.includes(STILL_ROUTING), markers(h)[0]);
        assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    for (const [mode, shown, said] of [['not-delivered', 'refused', 'could not be delivered'], ['no-receipt', 'unconfirmed', 'was not confirmed']] as const) {
      it(`locus mode: a failure after a delivery that finished ${shown} adds neither sentence, beside the send-failed note`, async () => {
        const h = await harness({ retries: 0 });
        try {
          h.command({ op: 'publish-mode', mode });
          breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
          await h.turn([round()]);
          assert.ok(h.texts().some((t) => t.startsWith('[discord-send-failed]') && t.includes(said)), h.texts().join('\n'));
          assert.equal(markers(h).length, 1, 'premise: the turn failed');
          assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
          assert.ok(!markers(h)[0]!.includes(STILL_ROUTING), markers(h)[0]);
        } finally {
          await h.close();
        }
      });
    }

    it("locus mode: a user's Stop while the delivery is still being routed says it may yet be posted, and nothing of handing on", async () => {
      const h = await harness({});
      try {
        h.command({ op: 'publish-mode', mode: 'hang' });
        breakAfterToolRound(h.membrane, 'stop');
        await startTurn(h);
        assert.equal(h.framework.abortInference('scout', 'operator stop'), true);
        await turnEnded(h);
        const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.includes(STILL_ROUTING), notes[0]);
        assert.ok(!notes[0]!.includes(HANDED_ON), notes[0]);
      } finally {
        await h.close();
      }
    });

    for (const [mode, shown, said] of [['not-delivered', 'refused', 'could not be delivered'], ['no-receipt', 'unconfirmed', 'was not confirmed']] as const) {
      it(`hybrid mode: a failure after a plain delivery to its locus that finished ${shown} adds neither sentence, beside the send-failed note`, async () => {
        const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], retries: 0 });
        try {
          h.command({ op: 'publish-mode', mode });
          breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
          await h.turn([createMockResponse([text(SPEECH), call('l1', 'channel_list', {})], 'tool_use')]);
          assert.ok(h.texts().some((t) => t.startsWith('[discord-send-failed]') && t.includes(said)), h.texts().join('\n'));
          assert.equal(markers(h).length, 1, 'premise: the turn failed');
          assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
          assert.ok(!markers(h)[0]!.includes(STILL_ROUTING), markers(h)[0]);
        } finally {
          await h.close();
        }
      });
    }

    it('hybrid mode: a failure after a >>> envelope whose delivery was refused adds neither sentence', async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }], retries: 0 });
      try {
        h.command({ op: 'publish-mode', mode: 'not-delivered' });
        breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
        await h.turn([createMockResponse([text(`>>>${ROOM} ${SPEECH}`), call('l1', 'channel_list', {})], 'tool_use')]);
        assert.ok(h.publishes().some((p) => p.event === 'publish-refused'), 'premise: the delivery was refused');
        assert.equal(markers(h).length, 1, 'premise: the turn failed');
        assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
        assert.ok(!markers(h)[0]!.includes(STILL_ROUTING), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it("hybrid mode: a user's Stop while a round's delivery is still being routed says it may yet be posted", async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
      try {
        h.command({ op: 'publish-mode', mode: 'hang' });
        breakAfterToolRound(h.membrane, 'stop');
        await startTurn(h);
        assert.equal(h.framework.abortInference('scout', 'operator stop'), true);
        await turnEnded(h);
        const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.includes(STILL_ROUTING), notes[0]);
      } finally {
        await h.close();
      }
    });

    it('a failure with no round keeps the marker saying nothing was sent', async () => {
      const h = await harness({ retries: 0 });
      try {
        breakAfterToolRound(h.membrane, 'error', { fromStart: true });
        await h.turn([]);
        assert.equal(markers(h).length, 1);
        assert.match(markers(h)[0]!, /the model call failed( \([^)]*\))? and produced no response, so nothing was sent/);
      } finally {
        await h.close();
      }
    });

    it('a retry that succeeds writes one receipt, at the end of the turn, and no failure note', async () => {
      const h = await harness({ retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        onSecondStream(h.membrane, createMockResponse([text(AFTER)]));
        await h.turn([round()]);
        assert.equal(h.membrane.calls.length, 2, 'premise: the retry ran');
        assert.equal(receipts(h).length, 1, receipts(h).join('\n'));
        const texts = h.texts();
        const words = texts.findIndex((t) => t.includes(AFTER));
        assert.ok(words >= 0, 'premise: the retried call wrote its words');
        assert.ok(texts.indexOf(receipts(h)[0]!) > words, 'after the retried call');
        assert.equal(markers(h).length, 0);
      } finally {
        await h.close();
      }
    });

    it("a retry that fails before any round of its own, after the turn's first stream routed one live, says the rounds ran and the speech was handed on", async () => {
      const h = await harness({ retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
        breakAfterToolRound(h.membrane, 'error', { fromStart: true, stream: 2 });
        await h.turn([round()]);
        assert.equal(h.membrane.calls.length, 2, 'premise: the retry ran');
        assert.equal(markers(h).length, 1);
        assert.match(markers(h)[0]!, AFTER_ROUNDS);
        assert.ok(markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it("a retry whose request can't be built says the rounds ran and the speech was handed on", async () => {
      const h = await harness({ retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
        const compiles = failingCompile(h, 2);
        await h.turn([round()]);
        assert.equal(compiles(), 2, 'premise: the retry tried to start');
        assert.equal(markers(h).length, 1);
        assert.match(markers(h)[0]!, AFTER_ROUNDS);
        assert.ok(markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    it('a silent turn whose retry fails before a round of its own says the rounds ran, and nothing of handing on', async () => {
      const h = await harness({ retries: 1 });
      try {
        breakAfterToolRound(h.membrane, 'error');
        breakAfterToolRound(h.membrane, 'error', { fromStart: true, stream: 2 });
        await h.turn([round()], 'scout', 'silent');
        assert.equal(h.membrane.calls.length, 2, 'premise: the retry ran');
        assert.equal(markers(h).length, 1);
        assert.match(markers(h)[0]!, AFTER_ROUNDS);
        assert.ok(!markers(h)[0]!.includes(HANDED_ON), markers(h)[0]);
      } finally {
        await h.close();
      }
    });

    for (const [stopEnds, shown] of [['aborted', 'an aborted event'], ['error', 'an error'], ['silent', 'a silent end'], ['throw', 'a throw']] as const) {
      it(`a user's Stop the stream reports as ${shown}, after a live-routed round, says the speech was handed on, and posts nothing more`, async () => {
        const h = await harness({});
        try {
          breakAfterToolRound(h.membrane, 'stop', { stopEnds });
          await startTurn(h);
          await h.until(() => published(h, SPEECH).length === 1, "premise: the round's speech was routed live");
          await speechSettled(h);
          const before = h.publishes().length;
          assert.equal(h.framework.abortInference('scout', 'operator stop'), true);
          await turnEnded(h);
          assert.equal(h.publishes().length, before);
          const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
          assert.equal(notes.length, 1);
          assert.ok(notes[0]!.includes(HANDED_ON), notes[0]);
          assert.ok(!notes[0]!.includes(CUT_OFF), notes[0]);
          assert.equal(receipts(h).length, 0);
        } finally {
          await h.close();
        }
      });
    }

    it("a user's Stop during the retry's wait says the failed stream's speech was handed on", async () => {
      const h = await harness({ retries: 1, retryDelayMs: 60_000 });
      try {
        const failed = traced(h, 'inference:failed');
        breakAfterToolRound(h.membrane, 'error', { beforeFailure: () => speechSettled(h) });
        await startTurn(h);
        await h.until(failed, 'the failure');
        await h.until(() => h.framework.abortInference('scout', 'operator stop'), 'the stop reaches the waiting retry');
        await turnEnded(h);
        assert.equal(h.membrane.calls.length, 1, 'premise: the retry never ran');
        const notes = h.texts().filter((t) => t.startsWith('[turn-interrupted]'));
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.includes(HANDED_ON), notes[0]);
      } finally {
        await h.close();
      }
    });
  });
});

describe('a heartbeat turn holds its plain speech as drafts', () => {
  /** Calls the membrane gets for one turn and anything it wakes, once the framework is idle again. */
  const callsFor = async (h: Awaited<ReturnType<typeof harness>>, run: () => Promise<void>): Promise<number> => {
    const before = h.membrane.calls.length;
    await run();
    await new Promise((r) => setTimeout(r, 200));
    await h.framework.runUntilIdle();
    return h.membrane.calls.length - before;
  };

  it('locus mode: nothing is posted where the latest message came from; the words are held, named in the receipt, and resendable', async () => {
    const h = await harness();
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room'], 'the room is the latest inbound channel now');
      await h.turn([createMockResponse([text('Still here, thinking of you.')])], 'scout', 'heartbeat');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room'], 'the heartbeat turn posted nothing');
      const [held] = h.drafts();
      assert.equal(held?.text, 'Still here, thinking of you.');
      assert.equal(held?.reason, 'no-destination');
      const receipt = h.texts().filter((t) => t.startsWith('[delivered]')).at(-1) ?? '';
      assert.ok(receipt.startsWith('[delivered] nothing') && receipt.includes(held!.id), receipt);
      assert.equal(h.texts().filter((t) => t.startsWith('[routing] This turn came from your heartbeat')).length, 1,
        'the heartbeat turn was told up front that its plain speech is held');
      const announced = h.texts().filter((t) => t.startsWith('[routing] Your plain speech now lands in')).length;
      await h.turn([
        createMockResponse([drafts('r1', { action: 'resend', draftIds: [held!.id], destination: ROOM })], 'tool_use'),
        createMockResponse([]),
      ]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room', 'Still here, thinking of you.'], 'sent when the agent chose to');
      assert.equal(h.texts().filter((t) => t.startsWith('[routing] Your plain speech now lands in')).length, announced,
        'the next channel turn did not announce its channel again');
    } finally {
      await h.close();
    }
  });

  it("locus mode: a heartbeat turn's mid-turn and closing prose are both held, and the mid-turn notice says why", async () => {
    const h = await harness();
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      await h.turn([
        createMockResponse([text('a first thought'), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text('closing words')]),
      ], 'scout', 'heartbeat');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room']);
      assert.deepEqual(h.drafts().map((d) => d.text).reverse(), ['a first thought', 'closing words']);
      assert.ok(h.drafts().every((d) => d.reason === 'no-destination'));
      assert.ok(h.texts().some((t) => t.startsWith('[drafts]') && t.includes('this turn came from your heartbeat, not from a channel')),
        JSON.stringify(h.texts().filter((t) => t.startsWith('[drafts]'))));
    } finally {
      await h.close();
    }
  });

  it("a tick from the framework's own heartbeat opens such a turn", async () => {
    const h = await harness({ heartbeat: true });
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      h.membrane.pushResponse(createMockResponse([text('words from a real tick')]));
      const before = h.membrane.calls.length;
      const fired = (h.framework as unknown as { heartbeat: { handleToolCall(name: string, input: unknown): { isError?: boolean } } })
        .heartbeat.handleToolCall('heartbeat--heartbeat_trigger', {});
      assert.notEqual(fired.isError, true, JSON.stringify(fired));
      await h.until(() => h.membrane.calls.length > before, 'the tick\'s turn');
      await h.framework.runUntilIdle();
      await h.until(() => h.drafts().length === 1, 'the held words');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room']);
      assert.equal(h.drafts()[0]?.text, 'words from a real tick');
    } finally {
      await h.close();
    }
  });

  it('a heartbeat batched behind another channel-less wake is still a heartbeat\'s turn', async () => {
    const h = await harness();
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      h.membrane.pushResponse(createMockResponse([text('words from a batched tick')]));
      const before = h.membrane.calls.length;
      const pending = (h.framework as unknown as { pendingRequests: unknown[] }).pendingRequests;
      const t = Date.now();
      pending.push(
        { agentName: 'scout', reason: 'test', source: 'test', timestamp: t },
        { agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: t + 1 },
      );
      await h.until(() => h.membrane.calls.length > before, 'the batch\'s turn');
      await h.framework.runUntilIdle();
      await h.until(() => h.drafts().length === 1, 'the held words');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room'], 'the batch order does not decide');
    } finally {
      await h.close();
    }
  });

  it("hybrid mode: the resend wake after a heartbeat turn's failed >>> target is a heartbeat's turn too", async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      onSecondStream(h.membrane, createMockResponse([text('unprefixed words on the resend turn')]));
      await h.turn([createMockResponse([text('>>>#nowhere words meant for someone')])], 'scout', 'heartbeat');
      await h.until(() => h.drafts().some((d) => d.text === 'unprefixed words on the resend turn'), 'the resend turn\'s words held');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room']);
    } finally {
      await h.close();
    }
  });

  it("a quiesce parks a heartbeat's wake apart from a later channel-less wake, so neither absorbs the other", async () => {
    const h = await harness();
    const internals = h.framework as unknown as {
      pendingRequests: Array<{ agentName: string; source: string }>;
      processInferenceRequests(): Promise<void>;
      quiesced: boolean;
    };
    try {
      const t = Date.now();
      internals.quiesced = true;
      internals.pendingRequests.push(
        { agentName: 'scout', reason: 'mcpl:push-event', source: 'heartbeat', timestamp: t } as never,
        { agentName: 'scout', reason: 'mcpl:push-event', source: 'other', timestamp: t + 1 } as never,
      );
      await internals.processInferenceRequests();
      assert.deepEqual(internals.pendingRequests.filter((r) => r.agentName === 'scout').map((r) => r.source).sort(), ['heartbeat', 'other'],
        'both wait for the resume, where they make a heartbeat\'s batch');
    } finally {
      internals.quiesced = false;
      internals.pendingRequests.length = 0;
      await h.close();
    }
  });

  it('an explicit send from a heartbeat turn still posts', async () => {
    const h = await harness();
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      await h.turn([createMockResponse([explicitSend('s1')], 'tool_use'), createMockResponse([])], 'scout', 'heartbeat');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room', 'an explicit note']);
    } finally {
      await h.close();
    }
  });

  it('a channel-less wake that is not the heartbeat still takes the latest inbound channel, as before', async () => {
    // The latest inbound channel is a fallback only under 'latest-inbound'.
    const h = await harness({ speech: { locus: 'latest-inbound' } });
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      await h.turn([createMockResponse([text('words from a timer')])], 'scout', 'request');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room', 'words from a timer']);
      assert.deepEqual(h.drafts(), []);
    } finally {
      await h.close();
    }
  });

  it('hybrid mode: unprefixed heartbeat prose is held, and a >>> envelope still delivers', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'hybrid' }] });
    try {
      await h.turn([createMockResponse([text('a reply in the room')])]);
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room']);
      await h.turn([
        createMockResponse([text('unprefixed heartbeat words'), call('l1', 'channel_list', {})], 'tool_use'),
        createMockResponse([text(`>>>${ROOM} chosen words`)]),
      ], 'scout', 'heartbeat');
      assert.deepEqual(h.publishes().map((p) => p.text), ['a reply in the room', 'chosen words']);
      const [held] = h.drafts();
      assert.equal(held?.text, 'unprefixed heartbeat words');
      assert.equal(held?.reason, 'no-destination');
    } finally {
      await h.close();
    }
  });

  it("an autoContinue continuation of a heartbeat turn holds its plain speech too", async () => {
    const h = await harness({ agents: [{ name: 'scout', autoContinue: true }] });
    try {
      // No channel turn first: its own run's wakes would merge with the
      // continuation and give it their channel, as a message arriving mid-run
      // rightly does. Without the mark the continuation's words fail to route
      // rather than being held.
      // Each stream takes every queued response, so the continuation's
      // answer is queued as its stream opens.
      onSecondStream(h.membrane, createMockResponse([text('continued heartbeat words')]));
      await h.turn([createMockResponse([text('first heartbeat words')])], 'scout', 'heartbeat');
      await h.until(() => h.drafts().length >= 2, 'the continuation');
      await h.framework.runUntilIdle();
      assert.deepEqual(h.publishes(), [], 'neither the turn nor its continuation posted');
      assert.deepEqual(h.drafts().map((d) => d.text).reverse(), ['first heartbeat words', 'continued heartbeat words']);
      assert.equal(h.texts().filter((t) => t.startsWith('[routing] This turn came from your heartbeat')).length, 1,
        'the continuation is not told again');
      assert.ok(h.texts().some((t) => t.startsWith('[continue]') && t.includes('are held as drafts, as on the heartbeat')),
        'its [continue] row says its words are held');
    } finally {
      await h.close();
    }
  });

  it('explicit mode: a heartbeat turn whose deliberate >> target fails still wakes the agent', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      const before = h.membrane.calls.length;
      await h.turn([createMockResponse([text('>>#nowhere words meant for someone')])], 'scout', 'heartbeat');
      await h.until(() => h.membrane.calls.length - before >= 2, "the failed send's bounce wakes the agent to resend");
    } finally {
      await h.close();
    }
  });

  it("explicit mode: a heartbeat turn's bounce is held and noticed without waking the agent", async () => {
    const control = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      const before = control.membrane.calls.length;
      await control.turn([createMockResponse([text('words with nowhere to go')])], 'scout', 'request');
      await control.until(() => control.membrane.calls.length - before >= 2, "another channel-less turn's bounce wakes the agent to resend");
    } finally {
      await control.close();
    }
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'explicit' }] });
    try {
      const calls = await callsFor(h, () => h.turn([createMockResponse([text('heartbeat words with nowhere to go')])], 'scout', 'heartbeat'));
      assert.equal(calls, 1, 'the heartbeat turn alone: no bounce wake');
      const [bounced] = h.drafts();
      assert.equal(bounced?.reason, 'bounced');
      assert.ok(h.texts().some((t) => t.includes(`It is held as draft ${bounced!.id}`)), 'the bounce is noticed');
      assert.deepEqual(h.publishes(), []);
    } finally {
      await h.close();
    }
  });
});

describe('plain speech whose turn\'s channel is tuned out', () => {
  it('lands in that channel, as the tuned-out invitation\'s reply line says', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'locus' }] });
    try {
      const registry = (h.framework as unknown as {
        channelRegistry: { ensureChannelRegistered(s: string, id: string, label: string): void; enterTuneOut(s: string, c: string, p: unknown, src: string): void };
      }).channelRegistry;
      registry.ensureChannelRegistered('discord', 'discord:g1:side', '#side (Guild One)');
      let tunedOut = false;
      h.framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started' && !tunedOut) {
          tunedOut = true;
          registry.enterTuneOut('discord', 'discord:g1:side', { epochId: 'e1', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
        }
      });
      h.membrane.pushResponse(createMockResponse([text('hello there')]));
      h.command({ op: 'incoming', channelId: 'discord:g1:side', messageId: 'in-side', mode: 'addressed', text: 'over here' });
      await h.until(() => h.publishes().some((p) => p.event === 'publish'), 'the publish');
      assert.equal(tunedOut, true, 'the channel was tuned out before the turn spoke');
      assert.deepEqual(h.publishes().filter((p) => p.event === 'publish').map((p) => [p.channelId, p.text]), [['discord:g1:side', 'hello there']]);
    } finally {
      await h.close();
    }
  });
});

describe('a closed channel\'s invitation offers the reply its agent\'s mode reads', () => {
  const opens = 'it will be delivered there, which opens the channel. To reply without opening it, decline it first (option 3): ' +
    'a channel you\'ve declined stays closed when you speak there.';
  const sendTool = 'check whether discord exposes a send tool that can address it';
  const offered = {
    explicit: { line: `1. Reply — write your reply this turn prefixed with ">>#side"; ${opens}\n`, reply: '>>#side hello there' },
    hybrid: { line: `1. Reply — write your reply this turn prefixed with ">>>#side"; ${opens}\n`, reply: '>>>#side hello there' },
    locus: {
      line: `1. Reply — your plain speech lands where the latest word on where it lands says: a [routing] notice, or ` +
        `channel_open's result. If that is #side (Guild One) (discord:g1:side), write your reply with no prefix; ${opens} ` +
        `If that is another channel, or you see none, to reply here, ${sendTool}, or open it (option 2), whose result says where your plain ` +
        `speech lands.\n`,
      reply: 'hello there',
    },
    disabled: { line: `1. Replying in plain text isn't available: your plain text is never published. To speak there, ${sendTool}.\n`, reply: 'hello there' },
  } as const;
  for (const mode of ['explicit', 'hybrid', 'locus', 'disabled'] as const) {
    it(`${mode}: the reply it offers ${mode === 'disabled' ? 'is none, and plain text posts nothing' : 'lands in the channel, as written after its prefix'}`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: mode }] });
      try {
        (h.framework as unknown as { channelRegistry: { ensureChannelRegistered(s: string, id: string, label: string): void } })
          .channelRegistry.ensureChannelRegistered('discord', 'discord:g1:side', '#side (Guild One)');
        h.membrane.pushResponse(createMockResponse([text(offered[mode].reply)]));
        h.command({ op: 'incoming', channelId: 'discord:g1:side', messageId: 'in-side', mode: 'addressed', text: 'over here' });
        await h.until(() => h.membrane.calls.length >= 1, 'the turn');
        await h.until(() => !(h.framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has('scout'), 'turn end');
        const invitation = h.texts().find((t) => t.includes('[Channel invitation]'))!;
        assert.ok(invitation.includes(offered[mode].line), invitation);
        const published = h.publishes().filter((p) => p.event === 'publish').map((p) => [p.channelId, p.text]);
        assert.deepEqual(published, mode === 'disabled' ? [] : [['discord:g1:side', 'hello there']]);
      } finally {
        await h.close();
      }
    });
  }
  for (const [first, second] of [['explicit', 'locus'], ['locus', 'explicit']] as const) {
    it(`reads the mode of the agent whose window it goes into, the first agent's: ${first} beside ${second}`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: first }, { name: 'quill', proseRouting: second }] });
      try {
        (h.framework as unknown as { channelRegistry: { ensureChannelRegistered(s: string, id: string, label: string): void } })
          .channelRegistry.ensureChannelRegistered('discord', 'discord:g1:side', '#side (Guild One)');
        h.command({ op: 'incoming', channelId: 'discord:g1:side', messageId: 'in-side', mode: 'addressed', text: 'over here' });
        await h.until(() => h.texts().some((t) => t.includes('[Channel invitation]')), 'the invitation');
        const invitation = h.texts().find((t) => t.includes('[Channel invitation]'))!;
        assert.ok(invitation.includes(offered[first].line), invitation);
      } finally {
        await h.close();
      }
    });
    it(`reads the mode of the one agent a deliverTo wakes: ${second}, beside the first agent's ${first}`, async () => {
      const h = await harness({ agents: [{ name: 'scout', proseRouting: first }, { name: 'quill', proseRouting: second }] });
      try {
        (h.framework as unknown as { channelRegistry: { ensureChannelRegistered(s: string, id: string, label: string): void } })
          .channelRegistry.ensureChannelRegistered('discord', 'discord:g1:side', '#side (Guild One)');
        await (h.framework as unknown as { handleMcplChannelIncoming(event: unknown): Promise<unknown> }).handleMcplChannelIncoming({
          type: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g1:side', messageId: 'in-side',
          author: { id: 'u1', name: 'someone' }, content: [{ type: 'text', text: 'over here' }],
          tags: ['chat:mention', 'chat:addressed', 'chat:from-human'], timestamp: new Date().toISOString(),
          triggerInference: false, deliverTo: 'quill', acceptedAt: Date.now(),
        });
        const invitation = h.texts('quill').find((t) => t.includes('[Channel invitation]'))!;
        assert.ok(invitation.includes(offered[second].line), invitation);
      } finally {
        await h.close();
      }
    });
    for (const [targetAgents, reads, which] of [
      [['ghost', 'quill'], second, `the one live agent a push names: ${second}, beside the first agent's ${first} and a name no agent has`],
      [['quill', 'quill'], second, `the one agent a push names twice: ${second}, beside the first agent's ${first}`],
      [['quill', 'scout'], first, `the first agent, when a push names two live agents: ${first}, beside ${second}`],
    ] as const) {
      it(`reads the mode of ${which}`, async () => {
        const h = await harness({ agents: [{ name: 'scout', proseRouting: first }, { name: 'quill', proseRouting: second }] });
        try {
          (h.framework as unknown as { handleMcplPushEvent(event: unknown): unknown }).handleMcplPushEvent({
            type: 'mcpl:push-event', serverId: 'discord', featureSet: 'chat', eventId: 'ev-side', timestamp: new Date().toISOString(),
            origin: { mcplChannelId: 'discord:g1:side', channelName: '#side (Guild One)', authorName: 'someone', messageId: 'in-side' },
            content: [{ type: 'text', text: 'over here' }], tags: ['chat:mention', 'chat:addressed', 'chat:from-human'],
            triggerInference: false, targetAgents: [...targetAgents],
          });
          await h.until(() => h.texts('quill').some((t) => t.includes('[Channel invitation]')), 'the invitation');
          const invitation = h.texts('quill').find((t) => t.includes('[Channel invitation]'))!;
          assert.ok(invitation.includes(offered[reads].line), invitation);
        } finally {
          await h.close();
        }
      });
    }
  }
});
