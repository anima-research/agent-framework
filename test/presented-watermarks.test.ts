/**
 * Read marks once an agent's window is presented (#291, AF-3): what an agent
 * has read, been shown or answered is what its window held as of the mark,
 * not every row stored below the store's head then. Each case drives the
 * window directly through context-manager's presentRows, writing rows into
 * the contexts past the framework, on a residents' host, mira the primary
 * and oren, with the presentation index's module on (FrameworkConfig
 * .presentationIndex), which writes each window down as its agent is
 * registered. Beside each, where the answer differs, the legacy-mode answer
 * the same rows give, on a host without the flag.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextInjection, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, asOwnRow, audienceOf, withAudience, type Agent } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { destinationKey } from '../src/mcpl/channel-registry.js';
import { storedInjectionMarkOf } from '../src/stored-injections.js';
import { removeStoredMessage } from '../src/stored-removal.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

type Placement = { agent: string; messageId?: string; deferredId?: string; presented?: false };
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

async function boot(options: { presentationIndex?: boolean; subconscious?: boolean } = {}) {
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
    presentationIndex: options.presentationIndex ?? true,
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
    const h = await boot({ presentationIndex: false });
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

    // In legacy mode the residents' marks are prefixes of the one record, so
    // oren's compile reads it for both.
    const legacy = await boot({ presentationIndex: false });
    const old = legacy.store('for mira alone', ['mira']);
    await legacy.oren.compileContext();
    assert.equal(legacy.internals.isUnreadStoredMessage(legacy.mira, old), false, 'legacy: read once any reader of the slot compiled past it');
  });

  it("the coalescer doesn't remove a row a presented window holds, though no reader consumed it, and still removes one never presented", async () => {
    const h = await boot({ subconscious: true });
    const subconscious = h.framework.getAgent('Subconscious')!;
    h.writeDown(subconscious);
    const held = h.store('in the subconscious\'s window', ['mira', 'oren']);
    const loose = h.store('in no window', ['mira', 'oren']);
    subconscious.getContextManager().presentRows([held]);
    const placed = (id: MessageId): Placement => ({ agent: 'mira', messageId: id });
    assert.equal(h.internals.isUnreadPlacement(placed(held)), true, 'no reader has consumed it');
    assert.equal(h.internals.removePlacement(placed(held)), false, 'but a window holds it, so it stays');
    assert.ok(h.mira.getContextManager().getMessage(held), 'stored still');
    assert.equal(h.internals.isUnreadPlacement(placed(loose)), true);
    assert.equal(h.internals.removePlacement(placed(loose)), true, 'a row no window holds is removed, as before');
    assert.equal(h.mira.getContextManager().getMessage(loose), null);
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
      for (const presented of [true, false]) {
        // The legacy answer from a host without the flag, whose windows stay
        // the record (until AF-4 the flag's host left them so).
        const h = await boot({ presentationIndex: presented });
        if (presented) h.writeDown(h.mira, h.oren);
        const cm = h.mira.getContextManager();
        const arrived = h.store('the event', ['mira'], event);
        const own = cm.addMessage('mira', text('a row of her own'), asOwnRow(undefined, 'mira'));
        if (presented) cm.presentRows([own]);
        assert.equal(h.internals.isNewestIn(h.mira, entry), presented,
          presented
            ? 'her next request holds her own row, then the entry, which her start presents'
            : 'legacy: the record ends on her own row');
        if (!presented) continue;
        cm.presentRows([arrived]);
        assert.equal(h.internals.isNewestIn(h.mira, entry), true, 'presented after her row: still newest');
      }
    });

    it("a co-resident's own round stored after the entry doesn't make it not newest", async () => {
      for (const presented of [true, false]) {
        // The legacy answer from a host without the flag, whose windows stay
        // the record (until AF-4 the flag's host left them so).
        const h = await boot({ presentationIndex: presented });
        if (presented) h.writeDown(h.mira, h.oren);
        h.store('the event', ['mira', 'oren'], event);
        h.oren.getContextManager().addMessage('oren', text("oren's reply"), asOwnRow(undefined, 'oren'));
        assert.equal(h.internals.isNewestIn(h.mira, entry), presented,
          presented ? "oren's row isn't in mira's window" : 'legacy: the shared record ends on oren\'s row');
      }
    });

    it("a co-resident's clock row isn't this agent's last clock, nor a row not yet presented its newest", async () => {
      for (const presented of [true, false]) {
        // The legacy answer from a host without the flag, whose windows stay
        // the record (until AF-4 the flag's host left them so).
        const h = await boot({ presentationIndex: presented });
        if (presented) h.writeDown(h.mira, h.oren);
        const clock = (owner: string, at: number) => asOwnRow({ system: true, kind: 'clock', clock: { at, onBoundary: false, zone: 'UTC' } } as MessageMetadata, owner);
        const mine = h.mira.getContextManager().addMessage('user', text('[clock] mira'), clock('mira', 1_000));
        if (presented) h.mira.getContextManager().presentRows([mine]);
        h.oren.getContextManager().addMessage('user', text('[clock] oren'), clock('oren', 2_000));
        const last = h.internals.lastClockOf(h.mira);
        assert.equal(last.lastClockAt, presented ? 1_000 : 2_000, presented ? "her own clock's" : "legacy: the shared record's last clock, oren's");
        if (presented) {
          const myRow = h.mira.getContextManager().getMessage(mine)!;
          assert.equal(last.newestRowAt, new Date(myRow.timestamp).getTime(), "her window's newest row");
        }
      }
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
    const h = await boot({ presentationIndex: false });
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
