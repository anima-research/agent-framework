/**
 * Read marks once an agent's window is presented (#291, AF-3): what an agent
 * has read, been shown or answered is what its window held as of the mark,
 * not every row stored below the store's head then. Each case drives the
 * window directly through context-manager's presentRows, writing rows into
 * the contexts past the framework, on a residents' host, mira the primary
 * and oren; the presentation index writes each window down as its agent is
 * registered. (Before AF-6 made presentation mandatory, cases here set
 * beside the presented answer the legacy-mode one the same rows gave, on a
 * host without the flag.)
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextInjection, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, asOwnRow, audienceOf, withAudience, type Agent } from '../src/index.js';
import { HeldStream, MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { destinationKey } from '../src/mcpl/channel-registry.js';
import { storedInjectionMarkOf } from '../src/stored-injections.js';
import { removeStoredMessage } from '../src/stored-removal.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

type Placement = { agent: string; messageId?: string; presented?: false };
type Destination = { serverId: string; channelId: string };
type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; audience?: readonly string[] }): MessageId;
  isUnreadStoredMessage(agent: Agent, id: MessageId, by?: 'consumed' | 'shown'): boolean;
  isUnreadPlacement(placement: Placement, by?: 'consumed' | 'shown'): boolean;
  removePlacement(placement: Placement): boolean;
  rowDone(agent: Agent, readsRow: string, to: Destination | undefined): boolean;
  isNewestIn(agent: Agent, entry: { eventType: string; serverId?: string; eventId?: string }): boolean;
  lastClockOf(agent: Agent): { newestRowAt: number | undefined; lastClockAt: number | undefined };
  draftsNamedInHistory(agent: Agent, ids: string[]): Map<string, string>;
  passNoticeToPrimary(speaker: string, metadata: MessageMetadata | undefined, written?: { participant: string; content: ContentBlock[] }): void;
  storeInjections(agent: Agent, injections: ContextInjection[] | undefined): ContextInjection[] | undefined;
  presentation: { noteFramed(agent: Agent, ids: readonly MessageId[]): void } | null;
  pendingRequests: Array<Record<string, unknown>>;
  processInferenceRequests(): Promise<void>;
  startAgentStream: (...a: unknown[]) => Promise<unknown>;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(options: { subconscious?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-presented-watermarks-'));
  dirs.push(dir);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
      { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
    ],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    ...(options.subconscious ? { subconscious: { enabled: true, systemPrompt: 'You notice.' } } : {}),
  } as never);
  frameworks.push(framework);
  const internals = framework as unknown as Internals;
  const mira = framework.getAgent('mira')!;
  const oren = framework.getAgent('oren')!;
  /** A row in the residents' slot, through mira's context, stamped for `audience`. */
  const store = (t: string, audience: string[], metadata: MessageMetadata = {}): MessageId =>
    mira.getContextManager().addMessage('user', text(t), withAudience(metadata, audience));
  /** Write each resident's window down (presentRows([])), as a presenting host does at boot. */
  const writeDown = (...agents: Agent[]) => {
    for (const agent of agents) {
      agent.getContextManager().presentRows([]);
      assert.equal(agent.getContextManager().windowMode(), 'presented', `${agent.name}'s window is written down`);
    }
  };
  /** Turns the wakes left in the queue start, with no stream run. */
  const turnsStarted = async (): Promise<number> => {
    let started = 0;
    const start = internals.startAgentStream;
    internals.startAgentStream = async () => { started++; return undefined; };
    const error = console.error;
    console.error = () => {};
    try {
      await internals.processInferenceRequests();
    } finally {
      internals.startAgentStream = start;
      console.error = error;
    }
    return started;
  };
  return { framework, internals, mira, oren, store, writeDown, turnsStarted };
}

describe('read marks once windows are presented (#291)', () => {
  it("an agent's marks are read marks, read only through covers", async () => {
    const h = await boot();
    const mark = h.mira.getConsumedWatermark();
    assert.ok(mark, 'taken at her creation');
    // Build-time pins (tsc compiles the tests), never run: no compare by hand.
    const pins = () => {
      // @ts-expect-error A consumed watermark's head is not a field to read.
      void mark.sequence;
      // @ts-expect-error Nor is a shown one's.
      void h.mira.getShownWatermark()!.sequence;
      // @ts-expect-error A publish is noted with a read mark, not a branch and a sequence.
      h.mira.notePublished('chat\u0000room', { branch: 'main', sequence: 1 });
      // @ts-expect-error Whether it published having read a row takes the row and its context.
      h.mira.publishedAfterReading('chat\u0000room', 'main', 1);
    };
    void pins;
    const row = h.store('read at creation?', ['mira']);
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), true, 'stored after her creation mark: unread');
  });

  it('a row stored after the window is written down and before a compile, never presented, stays unread, and its wake stays', async () => {
    const h = await boot();
    h.writeDown(h.mira, h.oren);
    const row = h.store('for mira, never presented to her', ['mira']);
    await h.mira.compileContext();
    h.mira.markAnswered(h.mira.getConsumedWatermark());
    assert.equal(h.mira.getContextManager().ordinalOf(row), undefined, 'the premise: not in her window');
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), true,
      "her compile read her window, which doesn't hold it, though it was stored below the store's head then");
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row, 'shown'), true, 'nor was she shown it');
    assert.equal(h.internals.rowDone(h.mira, row, undefined), false, 'a wake for it has something left to do');
    h.internals.pendingRequests.push({ agentName: 'mira', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsRow: row });
    assert.equal(await h.turnsStarted(), 1, 'and starts its turn');

    // Presented, and compiled past: read, and a wake for it is done.
    h.mira.getContextManager().presentRows([row]);
    await h.mira.compileContext();
    h.mira.markAnswered(h.mira.getConsumedWatermark());
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), false);
    assert.equal(h.internals.rowDone(h.mira, row, undefined), true);
    h.internals.pendingRequests.push({ agentName: 'mira', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsRow: row });
    assert.equal(await h.turnsStarted(), 0, 'its wake starts no turn');
  });

  it("a row presented to mira alone stays unread after oren compiles, until mira's mark covers it", async () => {
    const h = await boot();
    h.writeDown(h.mira, h.oren);
    const row = h.store('for mira alone', ['mira']);
    h.mira.getContextManager().presentRows([row]);
    await h.oren.compileContext();
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), true, "oren's window doesn't hold it, and mira hasn't compiled since");
    assert.equal(h.internals.isUnreadStoredMessage(h.oren, row), true, 'asked of either resident');
    await h.mira.compileContext();
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), false, 'read once her mark covers it');
  });

  // The coalescer removes only what no reader consumed: a row a presented
  // window holds and no request of its agent's answered is taken back, as
  // one never presented is (AF-6, once every window presents and rows enter
  // an idle window at once). A row a reader fork was handed as framing stays.
  it("the coalescer takes back a row a presented window holds that no reader consumed, as one never presented, and keeps one a reader fork was handed as framing", async () => {
    const h = await boot({ subconscious: true });
    const subconscious = h.framework.getAgent('Subconscious')!;
    h.writeDown(subconscious);
    const held = h.store('in the subconscious\'s window', ['mira', 'oren']);
    const loose = h.store('in no window', ['mira', 'oren']);
    const framed = h.store('handed to a reader as framing', ['mira', 'oren']);
    subconscious.getContextManager().presentRows([held]);
    h.internals.presentation!.noteFramed(h.oren, [framed]);
    const placed = (id: MessageId): Placement => ({ agent: 'mira', messageId: id });
    assert.equal(h.internals.isUnreadPlacement(placed(held)), true, 'no reader has consumed it');
    assert.equal(h.internals.removePlacement(placed(held)), true, 'so it is taken back');
    assert.equal(h.mira.getContextManager().getMessage(held), null);
    assert.equal(subconscious.getContextManager().windowStatusOf(held), 'absent', 'and leaves the window that held it with the record');
    assert.equal(h.internals.isUnreadPlacement(placed(loose)), true);
    assert.equal(h.internals.removePlacement(placed(loose)), true, 'a row no window holds is removed, as before');
    assert.equal(h.mira.getContextManager().getMessage(loose), null);
    assert.equal(h.internals.removePlacement(placed(framed)), false, 'a framed row stays');
    assert.ok(h.mira.getContextManager().getMessage(framed), 'stored still');
  });

  it("an agent the presentation index says holds a row reads it, though it isn't one of the slot's readers", async () => {
    // A row a tune-out holds from the residents is the subconscious's alone
    // to read; with no subconscious, nobody reads it. A reader fork handed
    // it as framing holds it (AgentPresentation.noteFramed), and is judged
    // by its own mark.
    const h = await boot();
    const row = h.internals.addMessage('someone', text('held from the residents'), { tuneOut: { epochId: 'e-1' } } as MessageMetadata);
    assert.ok(row, 'stored at once: no turn is alive');
    h.oren.markContextConsumed();
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), true, 'nobody reads it');
    h.internals.presentation!.noteFramed(h.oren, [row]);
    // Oren's window was written down at his registration, so the framing
    // presents the row there, after the mark taken above: his mark covers
    // it once a compile reads it (taken here). Before AF-4 his window stayed
    // the record, and the earlier mark covered it by its sequence.
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), true, 'framed after his mark: not read yet');
    h.oren.markContextConsumed();
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, row), false, "read: its holder's mark covers it");
  });

  it('a wake for a stored row is done once the row is gone, or once an answered request covered it and, with a channel, the agent spoke there after', async () => {
    const h = await boot();
    h.writeDown(h.mira, h.oren);
    const cm = h.mira.getContextManager();
    const gone = h.store('removed before anyone read it', ['mira']);
    assert.equal(h.internals.rowDone(h.mira, gone, undefined), false);
    removeStoredMessage(cm, gone);
    assert.equal(h.internals.rowDone(h.mira, gone, undefined), true, 'gone from the store: nothing left to read');

    const row = h.store('read', ['mira']);
    cm.presentRows([row]);
    await h.mira.compileContext();
    const room: Destination = { serverId: 'chat', channelId: 'chat:room' };
    assert.equal(h.internals.rowDone(h.mira, row, undefined), false, 'consumed, but no answered request carried it yet');
    h.mira.markAnswered(h.mira.getConsumedWatermark());
    assert.equal(h.internals.rowDone(h.mira, row, undefined), true, 'an answered request carried it');
    assert.equal(h.internals.rowDone(h.mira, row, room), false, 'a wake with a channel waits for her to speak there');
    h.mira.notePublished(destinationKey(room), h.mira.getConsumedWatermark());
    assert.equal(h.internals.rowDone(h.mira, row, room), true, 'she spoke there having read it');
  });

  describe("the window's own order and audience, not the record's", () => {
    const entry = { eventType: 'mcpl:push-event', serverId: 'discord', eventId: 'ev-1' };
    const event = { serverId: 'discord', eventId: 'ev-1' } as unknown as MessageMetadata;

    it('an entry stays newest when an own row presented at its write follows it in the record, until it is presented after that row', async () => {
      const h = await boot();
      h.writeDown(h.mira, h.oren);
      const cm = h.mira.getContextManager();
      const arrived = h.store('the event', ['mira'], event);
      const own = cm.addMessage('mira', text('a row of her own'), asOwnRow(undefined, 'mira'));
      cm.presentRows([own]);
      assert.equal(h.internals.isNewestIn(h.mira, entry), true, 'her next request holds her own row, then the entry, which her start presents');
      cm.presentRows([arrived]);
      assert.equal(h.internals.isNewestIn(h.mira, entry), true, 'presented after her row: still newest');
    });

    it("a co-resident's own round stored after the entry doesn't make it not newest", async () => {
      const h = await boot();
      h.writeDown(h.mira, h.oren);
      h.store('the event', ['mira', 'oren'], event);
      h.oren.getContextManager().addMessage('oren', text("oren's reply"), asOwnRow(undefined, 'oren'));
      assert.equal(h.internals.isNewestIn(h.mira, entry), true, "oren's row isn't in mira's window");
    });

    it("a co-resident's clock row isn't this agent's last clock, nor a row not yet presented its newest", async () => {
      const h = await boot();
      h.writeDown(h.mira, h.oren);
      const clock = (owner: string, at: number) => asOwnRow({ system: true, kind: 'clock', clock: { at, onBoundary: false, zone: 'UTC' } } as MessageMetadata, owner);
      const mine = h.mira.getContextManager().addMessage('user', text('[clock] mira'), clock('mira', 1_000));
      h.mira.getContextManager().presentRows([mine]);
      h.oren.getContextManager().addMessage('user', text('[clock] oren'), clock('oren', 2_000));
      const last = h.internals.lastClockOf(h.mira);
      assert.equal(last.lastClockAt, 1_000, "her own clock's");
      const myRow = h.mira.getContextManager().getMessage(mine)!;
      assert.equal(last.newestRowAt, new Date(myRow.timestamp).getTime(), "her window's newest row");
    });

    it("a drafts notice taken out of the window as an undone turn's doesn't name its draft; one not presented yet does", async () => {
      const h = await boot();
      h.writeDown(h.mira);
      const cm = h.mira.getContextManager();
      const notice = (id: string) => cm.addMessage('user', text(`[drafts] ${id}`),
        asOwnRow({ draftOwner: 'mira', draftIds: [id] } as unknown as MessageMetadata, 'mira'));
      const shown = notice('d-1');
      cm.presentRows([shown]);
      const pending = notice('d-2');
      assert.deepEqual([...h.internals.draftsNamedInHistory(h.mira, ['d-1', 'd-2'])], [['d-1', shown], ['d-2', pending]],
        'one in her window, and one her next start presents');
      cm.retractRows([shown], { undone: true });
      assert.deepEqual([...h.internals.draftsNamedInHistory(h.mira, ['d-1', 'd-2'])], [['d-2', pending]],
        "the undone notice is in the record, not in her window");
    });
  });

  it("a released agent's unread notice goes to the primary stamped for the primary alone", async () => {
    const h = await boot();
    h.internals.passNoticeToPrimary('fork-gone', { primaryIfUnread: true, kind: 'module-note' } as unknown as MessageMetadata,
      { participant: 'notes', content: text('a write the fork never read') });
    const row = h.mira.getContextManager().getAllMessages().find((m) => JSON.stringify(m.content).includes('a write the fork never read'));
    assert.ok(row, 'passed on to the primary');
    assert.deepEqual(audienceOf(row.metadata)?.audience, ['mira'], "for mira, not for every resident: oren isn't the one who takes the fork's place");
  });

  it("an agent's unsent injection is its own stored injection since its last compile built to send, whatever another agent stores meanwhile", async () => {
    // Agent.unsentInjection reads the slot's record by sequence. Once rows
    // are stored for other agents at once (#291's store-at-once), its point
    // is still right: it counts only this agent's own stored injections,
    // which enter its window as they are written.
    const h = await boot();
    h.writeDown(h.mira, h.oren);
    const injection = (t: string): ContextInjection => ({ namespace: 'lessons', position: 'afterUser', content: text(t) });
    const ownCopies = () => h.mira.getContextManager().getAllMessages().filter((m) => storedInjectionMarkOf(m.metadata)?.agent === 'mira');
    h.mira.getContextManager().addMessage('user', text('hello'), withAudience(undefined, ['mira']));
    assert.equal(h.internals.storeInjections(h.mira, [injection('A')]), undefined, 'stored');
    await h.mira.buildActivationRequest([], undefined, undefined, [], {});
    assert.equal(h.mira.unsentInjection('lessons'), undefined, 'the first plan since sets the point: nothing unsent');

    // Oren stores an injection of the same namespace, and a row for mira
    // is stored and not presented to her.
    assert.equal(h.internals.storeInjections(h.oren, [injection('OREN')]), undefined, "oren's copy is stored");
    h.store('for mira, not presented yet', ['mira']);
    assert.equal(h.mira.unsentInjection('lessons'), undefined, "another agent's stored injection is none of hers");

    // Her own copy stored since, which no request has had.
    assert.equal(h.internals.storeInjections(h.mira, [injection('B')]), undefined, 'a changed lesson is stored');
    assert.deepEqual(ownCopies().map((m) => m.content), [text('A'), text('B')]);
    const unsent = h.mira.unsentInjection('lessons');
    assert.ok(unsent?.whole, 'her own copy since the point is unsent, whole');
    assert.equal(unsent.contentHash, storedInjectionMarkOf(ownCopies().at(-1)!.metadata)!.contentHash);
  });
});

/**
 * What a released fork or run passes to the primary is what was meant for
 * it and it never read (releasedWindow), not every unread row of a record it
 * shares (#291, J-AF7). A shared fork reads its parent's slot on a branch of
 * its own and inherits its parent's window, and a resident reads the slot
 * every resident writes. A notice there for the parent or a co-resident
 * never entered this agent's window, so its mark never covers it, and
 * before this fix every shared fork's release told the primary of it again,
 * in the fork's name.
 */
describe('a released agent passes on only what was meant for it (#291)', () => {
  /** Held streams a case left waiting, let go before its host stops, so a failed case doesn't hang the stop. */
  const holds: Array<() => void> = [];
  afterEach(() => { while (holds.length) holds.pop()!(); });
  const FAILED = { system: true, kind: 'discord-send-failed', channelId: 'c-1', serverId: 'discord', reason: 'x', textLen: 5 } as unknown as MessageMetadata;
  type ReleaseInternals = Internals & {
    releasedWindow(agent: Agent): { unread: Array<{ metadata: MessageMetadata }> } | null;
    activeTurnTokens: Map<string, unknown>;
    invokeReaderFork(invocation: {
      serverId: string; channelId: string; epochId: string; trigger: 'wake'; notice: string; backlog: []; dispositions: null;
    }): void;
  };

  /** A started host of residents, mira the primary; with `readerForks`, the subconscious reads by forks of mira. */
  async function host(options: { residents?: readonly string[]; readerForks?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'af-released-window-'));
    dirs.push(dir);
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: (options.residents ?? ['mira', 'oren']).map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      ...(options.readerForks ? { subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'Read for mira.' } } : {}),
    } as never);
    frameworks.push(framework);
    framework.start();
    const internals = framework as unknown as ReleaseInternals;
    const mira = framework.getAgent('mira')!;
    /** A failed reply's notice for `agent`, stored for it alone. */
    const notice = (agent: string): MessageId => internals.addMessage('user',
      text(`[discord-send-failed] ${agent}'s reply could not be delivered.`), FAILED, { forAgent: agent });
    /** Every failed-reply notice in the residents' slot. */
    const failures = () => mira.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { kind?: unknown } | undefined)?.kind === 'discord-send-failed');
    /** The notices the primary was told in place of `speaker`. */
    const toldFor = (speaker: string) => failures().filter((m) => JSON.stringify(m.content).includes(`A reply by ${speaker} (`));
    /** A shared fork of `from` (deriveAgent's default mode). */
    const derive = (name: string, from = 'mira') =>
      framework.deriveAgent({ name, from, framing: [{ participant: 'user', content: text('[FRAMING] do a thing') }] });
    /** A shared fork of `from` that runs one plain reply and is released. */
    const runFork = async (name: string, from = 'mira') => {
      const fork = await derive(name, from);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `${name} done` }]));
      await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
      assert.equal(framework.getAgent(name), null, `${name} is released`);
    };
    /** A run of `fork` whose one stream waits, once sent, until `finish` lets it end and the run is released. */
    const heldRun = (fork: Awaited<ReturnType<typeof derive>>) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      holds.push(release);
      let sent!: () => void;
      const streaming = new Promise<void>((resolve) => { sent = resolve; });
      membrane.streamYielding = (request) => {
        membrane.calls.push(request);
        sent();
        return new HeldStream(released, [createMockResponse([{ type: 'text', text: `${fork.agent.name} done` }])]);
      };
      const run = framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
      return {
        streaming,
        finish: async () => {
          release();
          await run;
          assert.equal(framework.getAgent(fork.agent.name), null, `${fork.agent.name} is released`);
        },
      };
    };
    return { framework, internals, membrane, mira, notice, failures, toldFor, derive, runFork, heldRun };
  }

  /** oren's failed reply's notice, in his window and read: his consumed and answered marks cover it. */
  async function orensNoticeRead(h: Awaited<ReturnType<typeof host>>): Promise<MessageId> {
    const id = h.notice('oren');
    const oren = h.framework.getAgent('oren')!;
    assert.notEqual(oren.getContextManager().ordinalOf(id), undefined, 'presented to oren at rest');
    await oren.compileContext();
    oren.markAnswered(oren.getConsumedWatermark()!);
    assert.equal(h.internals.isUnreadStoredMessage(oren, id), false, 'oren read it');
    return id;
  }

  it("a shared fork of the primary passes on nothing of a co-resident's notice it inherited and never had in its window", async () => {
    const h = await host();
    const id = await orensNoticeRead(h);
    const fork = await h.derive('kid');
    const kcm = fork.contextManager;
    assert.notEqual(kcm.getMessage(id), null, "the notice is in the fork's record, the residents' slot on its branch");
    assert.equal(kcm.ordinalOf(id), undefined, 'and not in its window, which it inherited from mira');
    assert.deepEqual(h.internals.releasedWindow(fork.agent)!.unread, [], "oren's notice isn't the fork's to pass on");

    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'kid done' }]));
    await h.framework.runEphemeralToCompletion(fork.agent, kcm);

    assert.deepEqual(h.toldFor('kid'), [], 'the primary is told nothing in the fork\'s name');
    assert.deepEqual(h.failures().map((m) => m.id), [id], "oren's notice alone, once");
  });

  it('three successive shared forks pass nothing on', async () => {
    const h = await host();
    const id = await orensNoticeRead(h);
    for (const name of ['kid-1', 'kid-2', 'kid-3']) await h.runFork(name);
    for (const name of ['kid-1', 'kid-2', 'kid-3']) assert.deepEqual(h.toldFor(name), [], `nothing in ${name}'s name`);
    assert.deepEqual(h.failures().map((m) => m.id), [id]);
  });

  it("a reader fork the subconscious spawns passes on nothing of a co-resident's notice", async () => {
    const h = await host({ readerForks: true });
    const id = await orensNoticeRead(h);
    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Nothing new in the channel.' }]));
    h.internals.invokeReaderFork({
      serverId: 'discord', channelId: 'c-1', epochId: 'epoch-0001', trigger: 'wake',
      notice: '[tune-out] someone asked for you', backlog: [], dispositions: null,
    });
    const fork = () => h.framework.listAgents({ includeEnded: true }).find((r) => r.kind === 'subconscious-fork');
    const deadline = Date.now() + 20_000;
    while (!fork()?.ended) {
      assert.ok(Date.now() < deadline, 'the reader fork ends');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const name = fork()!.name;
    assert.match(name, /^reader\/mira\//, "a fork of mira's");
    assert.deepEqual(h.toldFor(name), [], "the primary is told nothing in the reader's name");
    assert.deepEqual(h.failures().map((m) => m.id), [id]);
  });

  it("the single-resident race: the parent's own notice, stored during its live turn and not presented at the fork, is its own to read, once", async () => {
    const h = await host({ residents: ['mira'] });
    h.internals.activeTurnTokens.set('mira', Symbol('turn'));
    const id = h.notice('mira');
    assert.equal(h.mira.getContextManager().ordinalOf(id), undefined, 'out of her live turn\'s window');
    const fork = await h.derive('kid');
    assert.notEqual(fork.contextManager.getMessage(id), null, "in the fork's record");
    assert.deepEqual(h.internals.releasedWindow(fork.agent)!.unread, [], "not the fork's");
    h.internals.activeTurnTokens.delete('mira');
    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'kid done' }]));
    await h.framework.runEphemeralToCompletion(fork.agent, fork.contextManager);

    assert.deepEqual(h.toldFor('kid'), [], 'the primary is not told it again in the fork\'s name');
    assert.deepEqual(h.failures().map((m) => m.id), [id], 'her notice, once');
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, id), true, 'still unread by her: her next point presents it');
  });

  it("a co-resident parent's own notice, unread at its fork, goes on once, in the parent's name, when the parent ends", async () => {
    const h = await host();
    h.internals.activeTurnTokens.set('oren', Symbol('turn'));
    const orens = h.notice('oren');
    const miras = h.notice('mira');
    h.internals.activeTurnTokens.delete('oren');
    await h.runFork('kid', 'oren');
    assert.deepEqual(h.toldFor('kid'), [], "oren's fork passes on neither oren's notice nor mira's");

    h.framework.stopAgent('oren');
    assert.equal(h.toldFor('oren').length, 1, "oren's own unread notice goes on at his release, once; mira's isn't his to pass on");
    assert.match(JSON.stringify(h.toldFor('oren')[0]!.content), /oren has ended/);
    assert.equal(h.failures().filter((m) => m.id === orens || m.id === miras).length, 2, 'the two notices stay where they were stored');
  });

  it("an unstamped notice, as a host's direct writer stores one, is a shared fork's only when stored after its derivation", async () => {
    const h = await host();
    const unstamped = (cm: ReturnType<Agent['getContextManager']>, tag: string) =>
      cm.addMessage('user', text(`[discord-send-failed] ${tag}`), { ...FAILED, tag } as unknown as MessageMetadata);
    unstamped(h.mira.getContextManager(), 'inherited');
    const fork = await h.derive('kid');
    const run = h.heldRun(fork);
    await run.streaming;
    unstamped(fork.contextManager, 'its own');
    assert.deepEqual(h.internals.releasedWindow(fork.agent)!.unread.map((m) => (m.metadata as { tag?: unknown }).tag), ['its own'],
      "one stored at or before its derivation point is its parent's inheritance");
    await run.finish();
    assert.equal(h.toldFor('kid').length, 1, 'its own goes on, once');
  });

  it('a notice for the fork itself, stored after its derivation and never read, still goes on once, in its name', async () => {
    const h = await host();
    await orensNoticeRead(h);
    const fork = await h.derive('kid');
    const run = h.heldRun(fork);
    await run.streaming;
    // Stored during its turn, which never reads it: the turn's request was sent.
    const id = h.notice('kid');
    assert.notEqual(fork.contextManager.getMessage(id), null, "stored in the fork's record");
    assert.deepEqual(audienceOf(fork.contextManager.getMessage(id)!.metadata)?.audience, ['kid']);
    await run.finish();

    const told = h.toldFor('kid');
    assert.equal(told.length, 1, "the fork's own unread notice goes on, once");
    assert.match(JSON.stringify(told[0]!.content), /kid has ended/);
    assert.deepEqual(audienceOf(told[0]!.metadata)?.audience, ['mira'], 'for the primary alone');
  });
});
