/**
 * Reader forks and the messages still queued behind the resident's turn.
 *
 * While the resident's turn runs, what arrives for it waits in the deferred
 * queue rather than in its store. That is when a reader is most useful (the
 * resident is busy), so a reader fork is handed those messages along with
 * the stored ones: on a wake, on a cadence look and on a cancel. Each held
 * message still goes to exactly one reader: a message handed while queued
 * isn't handed again once it lands in the store (its row carries the
 * deferred write's id as `metadata.deferredWriteId`). A fork that never read
 * what it was handed gives it back (`readerFailed`). A reader's own cancel
 * is followed by one more fork only for what arrived after the reader was
 * handed its own, and a cadence period with nothing new derives no fork.
 *
 * The coordinator runs here against a fake registry and fake framework
 * hooks, so no Dendrite build of chronicle or context-manager is needed.
 * test/tune-out-reader-fork-handoff.test.ts has the framework's side.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import { TuneOutCoordinator, type ReaderInvocation, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import { defaultReaderFraming } from '../src/tune-out/tools.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

const SERVER = 'disc';
const NOISY = 'disc:guild:noisy';
const OTHER = 'disc:guild:other';
const EPOCH = 'e-noisy-0001';

type Queued = { participant: string; content: ContentBlock[]; metadata: Record<string, unknown>; writeId?: string };
interface Where { epochId?: string; channelId?: string; serverId?: string }

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
const meta = (author: string, where: Where = {}) => ({
  author: { name: author },
  tuneOut: { epochId: where.epochId ?? EPOCH },
  channelId: where.channelId ?? NOISY,
  serverId: where.serverId ?? SERVER,
});

function world() {
  const stored: StoredMessage[] = [];
  const deferred: Queued[] = [];
  const invocations: ReaderInvocation[] = [];
  const coordinatorState = new Map<string, unknown>();
  const active = new Map<string, { params: Record<string, unknown>; wakeCount: number }>();
  let nextSeq = 1;

  const registry = {
    nameShown: (ref: { channelId: string }) => ref.channelId,
    listChannelsRaw: () => [NOISY, OTHER, 'disc:guild:work'].map((id) => ({ serverId: SERVER, descriptor: { id } })),
    getTuneOutState: (serverId: string, channelId: string) => active.get(`${serverId}\0${channelId}`) ?? null,
    cancelTuneOut: (serverId: string, channelId: string) => {
      const key = `${serverId}\0${channelId}`;
      const ended = active.get(key) ?? null;
      active.delete(key);
      return ended;
    },
    readCoordinatorState: (id: string) => coordinatorState.get(id) ?? null,
    writeCoordinatorState: (id: string, value: unknown) => { coordinatorState.set(id, value); },
  } as unknown as ChannelRegistry;
  const servers = { getServer: () => undefined } as unknown as McplServerRegistry;
  const hooks = {
    addMessage: () => {},
    requestInference: () => {},
    subconsciousName: () => null,
    invokeReader: (invocation: ReaderInvocation) => { invocations.push(invocation); },
    deliverFromReader: () => {},
    primaryName: () => 'scout',
    getStoredMessages: () => stored,
    getDeferredMessages: () => deferred,
    currentSequence: () => nextSeq,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    emitTrace: () => {},
  } as unknown as TuneOutFrameworkHooks;
  const coordinator = new TuneOutCoordinator(registry, servers, hooks);
  const internals = coordinator as unknown as {
    invokeSubconscious(serverId: string, channelId: string, trigger: 'cadence' | 'wake', count: number): void;
    startCadence(serverId: string, channelId: string, cadenceSeconds: number): void;
    readerHandedWrites: Map<string, Set<string>>;
  };

  return {
    coordinator,
    invocations,
    internals,
    /** Hold a channel under an epoch, as a per-channel tune-out does. */
    tuneOut(backlogCap = 200, where: Where = {}) {
      active.set(`${where.serverId ?? SERVER}\0${where.channelId ?? NOISY}`, {
        params: { epochId: where.epochId ?? EPOCH, cadenceSeconds: 30, backlogCap, maxWakes: 5, startedAtSequence: 0 },
        wakeCount: 0,
      });
    },
    /** A held message stored directly (the resident idle). */
    store(author: string, body: string, where: Where = {}): StoredMessage {
      const message = {
        id: `m-${nextSeq}`,
        sequence: nextSeq++,
        participant: 'user',
        content: [text(body)],
        metadata: meta(author, where),
        timestamp: new Date(),
      } as unknown as StoredMessage;
      stored.push(message);
      return message;
    },
    /** A held message queued behind the resident's running turn (no write id: a host that gives none). */
    queue(author: string, body: string, writeId: string | undefined, where: Where = {}): void {
      deferred.push({ participant: 'user', content: [text(body)], metadata: meta(author, where), ...(writeId ? { writeId } : {}) });
    },
    /** The resident's turn ends: the queued messages land (only those named, if any are), stamped with their write ids. */
    land(...writeIds: string[]): void {
      const lands = (q: Queued): boolean => writeIds.length === 0 || (q.writeId !== undefined && writeIds.includes(q.writeId));
      const landing = deferred.filter(lands);
      deferred.splice(0, deferred.length, ...deferred.filter((q) => !lands(q)));
      for (const q of landing) {
        stored.push({
          id: `m-${nextSeq}`,
          sequence: nextSeq++,
          participant: q.participant,
          content: q.content,
          metadata: { ...q.metadata, ...(q.writeId ? { deferredWriteId: q.writeId } : {}) },
          timestamp: new Date(),
        } as unknown as StoredMessage);
      }
    },
    wake: (serverId = SERVER, channelId = NOISY) => internals.invokeSubconscious(serverId, channelId, 'wake', 1),
    startCadence: (seconds: number) => internals.startCadence(SERVER, NOISY, seconds),
  };
}

const bodies = (invocation: ReaderInvocation) => ({
  stored: invocation.backlog.map((m) => textOf(m.content)),
  queued: (invocation.queued ?? []).map((m) => textOf(m.content)),
});

describe('reader forks and messages queued behind the resident turn', () => {
  it("a wake while the resident's turn runs hands the reader the queued messages, the one that woke it included", () => {
    const w = world();
    w.tuneOut();
    w.queue('ann', 'AMB-1 chatter', 'w1');
    w.queue('bo', 'AMB-2 more chatter', 'w2');
    w.queue('cy', 'ADDR-3 hey scout, your build is stuck', 'w3');
    w.wake();
    assert.equal(w.invocations.length, 1, 'one fork');
    assert.deepEqual(bodies(w.invocations[0]!), {
      stored: [],
      queued: ['AMB-1 chatter', 'AMB-2 more chatter', 'ADDR-3 hey scout, your build is stuck'],
    }, 'all three, oldest first, though none is stored yet');
    w.coordinator.stop();
  });

  it('a message handed while queued is not handed again once it lands; what is new still is', () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'S-1 stored before the turn');
    w.queue('bo', 'Q-2 queued', 'w2');
    w.wake();
    assert.deepEqual(bodies(w.invocations[0]!), { stored: ['S-1 stored before the turn'], queued: ['Q-2 queued'] });

    w.land();
    w.store('cy', 'S-3 stored after the turn');
    w.queue('dee', 'Q-4 queued in the next turn', 'w4');
    w.wake();
    assert.equal(w.invocations.length, 2);
    assert.deepEqual(bodies(w.invocations[1]!), { stored: ['S-3 stored after the turn'], queued: ['Q-4 queued in the next turn'] },
      'Q-2, now stored under its write id, and S-1 are not handed again');

    w.land();
    w.wake();
    assert.deepEqual(bodies(w.invocations[2]!), { stored: [], queued: [] }, 'and Q-4 is not handed again once it lands');
    w.coordinator.stop();
  });

  it('a handed write id is let go once its row has landed behind the cursor', () => {
    const w = world();
    w.tuneOut();
    w.queue('ann', 'Q-1', 'w1');
    w.wake();
    const handed = () => w.internals.readerHandedWrites.get(`${SERVER}\0${NOISY}`);
    assert.deepEqual([...(handed() ?? [])], ['w1'], 'kept while it could still be handed by sequence');
    w.land();
    w.store('bo', 'S-2 after it');
    w.wake();
    assert.deepEqual(bodies(w.invocations[1]!), { stored: ['S-2 after it'], queued: [] });
    assert.equal(handed(), undefined, 'Q-1 landed behind the cursor, so its id is dropped');
    w.wake();
    assert.deepEqual(bodies(w.invocations[2]!), { stored: [], queued: [] }, 'and Q-1 is still not handed again');
    w.coordinator.stop();
  });

  it('a queued message the host gives no write id for is left for the reader that comes once it is stored', () => {
    const w = world();
    w.tuneOut();
    w.queue('ann', 'Q-1 without an id', undefined);
    w.wake();
    assert.deepEqual(bodies(w.invocations[0]!), { stored: [], queued: [] }, 'not handed while queued');
    w.land();
    w.wake();
    assert.deepEqual(bodies(w.invocations[1]!), { stored: ['Q-1 without an id'], queued: [] }, 'handed once stored');
    w.coordinator.stop();
  });

  it('a cadence period with nothing new derives no fork, and one with something new does', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    w.tuneOut();
    w.startCadence(30);
    const m1 = w.store('ann', 'AMB-1 once');
    w.coordinator.recordHeld(SERVER, NOISY, m1.id, [], 'ann', true);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 1, 'the first period reads AMB-1');
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 1, 'two quiet periods derive no fork');
    w.queue('bo', 'AMB-2 while the turn runs', 'w2');
    w.coordinator.recordHeld(SERVER, NOISY, 'x2', [], 'bo', true);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 2, 'a period with a new message does');
    assert.deepEqual(bodies(w.invocations[1]!), { stored: [], queued: ['AMB-2 while the turn runs'] });
    w.coordinator.stop();
  });

  it("a failed fork's messages go to the next reader: stored, still queued, and landed behind the cursor", () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'S-1 stored');
    w.queue('bo', 'Q-2 queued, lands later', 'w2');
    w.queue('cy', 'Q-3 queued, still queued', 'w3');
    w.wake();
    const failed = w.invocations[0]!;
    assert.equal(w.coordinator.readerFailed(failed), 3, 'all three go back');
    // Q-2 lands, and a newer message is stored after it; Q-3 stays queued.
    w.land('w2');
    w.store('dee', 'S-4 new');
    w.wake();
    assert.deepEqual(bodies(w.invocations[1]!), {
      stored: ['S-1 stored', 'Q-2 queued, lands later', 'S-4 new'],
      queued: ['Q-3 queued, still queued'],
    }, 'the returned three again, with the new one');
    w.wake();
    assert.deepEqual(bodies(w.invocations[2]!), { stored: [], queued: [] }, 'and once handed again, not a third time');
    w.coordinator.stop();
  });

  it('a fork that fails after its epoch ended gives nothing back', () => {
    const w = world();
    w.tuneOut();
    w.queue('ann', 'Q-1', 'w1');
    w.wake();
    const failed = w.invocations[0]!;
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    assert.equal(w.coordinator.readerFailed(failed), 0, 'the epoch is over: its cancel had its own last fork');
    w.coordinator.stop();
  });

  it("the cancel's fork is handed the messages still queued at the cancel", () => {
    const w = world();
    w.tuneOut(1);
    w.queue('ann', 'HELD-1 first', 'w1');
    w.queue('bo', 'HELD-2 second', 'w2');
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    assert.equal(w.invocations.length, 1, "the cancel's fork");
    const fork = w.invocations[0]!;
    assert.equal(fork.trigger, 'cancel');
    assert.deepEqual(bodies(fork), { stored: [], queued: ['HELD-1 first', 'HELD-2 second'] },
      'both, though the dump shows only the newer');
    assert.ok(fork.notice.includes("1 of 2 diverted messages, the oldest, weren't delivered raw"), 'its notice counts what the dump left out');
    assert.ok(!fork.notice.includes('may not be in what you see'), 'and no longer says the fork may not see them');
    w.coordinator.stop();
  });

  it("a reader's own cancel derives no fork when the reader was handed everything", () => {
    const w = world();
    w.tuneOut(1);
    w.queue('ann', 'AMB-1', 'w1');
    w.queue('bo', 'ADDR-2 hey scout', 'w2');
    w.wake();
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'subconscious', 'subconscious judgment', undefined, 'reader/scout/x/1'), { ok: true });
    assert.equal(w.invocations.length, 1, 'only the reader that cancelled');
    w.coordinator.stop();
  });

  it("a reader's own cancel is followed by one fork for what arrived after the reader was handed its own", () => {
    const w = world();
    w.tuneOut(1);
    w.queue('ann', 'ADDR-1 hey scout', 'w1');
    w.wake();
    w.queue('bo', 'AMB-2 arrived while the reader read', 'w2');
    w.store('cy', 'AMB-3 stored meanwhile');
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'subconscious', 'subconscious judgment', undefined, 'reader/scout/x/1'), { ok: true });
    assert.equal(w.invocations.length, 2, 'one more fork');
    const late = w.invocations[1]!;
    assert.equal(late.trigger, 'cancel');
    assert.deepEqual(bodies(late), { stored: ['AMB-3 stored meanwhile'], queued: ['AMB-2 arrived while the reader read'] },
      'handed only what the cancelling reader was not');
    assert.ok(late.notice.includes('These 2 messages arrived after the reader that cancelled was handed its own.'), late.notice);
    w.coordinator.stop();
  });

  it("a reader's own release of the all-except hold derives a fork for each channel with messages no reader was handed", () => {
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600 }, 'agent-tool').ok);
    const epochId = w.coordinator.getAllExcept()!.params.epochId;
    w.queue('ann', 'N-1 in noisy', 'w1', { epochId, channelId: NOISY });
    w.wake(); // the reader for noisy is handed N-1
    assert.deepEqual(bodies(w.invocations[0]!), { stored: [], queued: ['N-1 in noisy'] });
    w.queue('bo', 'O-1 in other', 'w2', { epochId, channelId: OTHER });
    assert.deepEqual(w.coordinator.cancelAllExcept('subconscious', 'subconscious judgment', undefined, 'reader/scout/x/1'), { ok: true });
    assert.equal(w.invocations.length, 2, 'one more fork: for other, whose message no reader had');
    assert.equal(w.invocations[1]!.channelId, OTHER);
    assert.deepEqual(bodies(w.invocations[1]!), { stored: [], queued: ['O-1 in other'] });
    w.coordinator.stop();
  });

  it("the resident's release of the all-except hold hands each channel's reader what is still queued", () => {
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600 }, 'agent-tool').ok);
    const epochId = w.coordinator.getAllExcept()!.params.epochId;
    w.store('ann', 'N-1 stored in noisy', { epochId, channelId: NOISY });
    w.queue('bo', 'N-2 queued in noisy', 'w2', { epochId, channelId: NOISY });
    w.queue('cy', 'O-1 queued in other', 'w3', { epochId, channelId: OTHER });
    assert.deepEqual(w.coordinator.cancelAllExcept('agent-tool', 'resident released'), { ok: true });
    const byChannel = Object.fromEntries(w.invocations.map((inv) => [inv.channelId, bodies(inv)]));
    assert.deepEqual(byChannel, {
      [NOISY]: { stored: ['N-1 stored in noisy'], queued: ['N-2 queued in noisy'] },
      [OTHER]: { stored: [], queued: ['O-1 queued in other'] },
    });
    w.coordinator.stop();
  });

  it('two servers sharing a channel id keep their readers apart, on a wake and on the release', () => {
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600 }, 'agent-tool').ok);
    const epochId = w.coordinator.getAllExcept()!.params.epochId;
    w.queue('ann', 'A-1 on disc', 'w1', { epochId, channelId: 'general', serverId: 'disc' });
    w.queue('bo', 'B-1 on slack', 'w2', { epochId, channelId: 'general', serverId: 'slack' });
    w.wake('disc', 'general');
    assert.deepEqual(bodies(w.invocations[0]!), { stored: [], queued: ['A-1 on disc'] }, "disc's reader is handed disc's message only");
    assert.deepEqual(w.coordinator.cancelAllExcept('agent-tool', 'resident released'), { ok: true });
    assert.equal(w.invocations.length, 2, "one more fork: for slack's general, whose message no reader had");
    assert.equal(w.invocations[1]!.serverId, 'slack');
    assert.deepEqual(bodies(w.invocations[1]!), { stored: [], queued: ['B-1 on slack'] });
    w.coordinator.stop();
  });
});

describe('the default reader framing', () => {
  const ctx = {
    resident: 'scout',
    fork: 'reader/scout/x/1',
    voice: 'Read for scout.',
    channelId: NOISY,
    epochId: EPOCH,
    trigger: 'wake' as const,
    notice: '[Tune-out wake: disc:guild:noisy — 1 addressed message]',
    dispositions: null,
  };
  const row = (id: string, sequence: number, author: string, body: string) =>
    ({ id, sequence, participant: 'user', content: [text(body)], metadata: meta(author), timestamp: new Date() }) as unknown as StoredMessage;
  const stored = row('m-1', 1, 'ann', 'stored line');
  const queued = row('held:w2', 2, 'bo', 'queued line');

  it('shows the queued messages after the stored ones, counted with them, under a note that they are still queued', () => {
    const out = textOf(defaultReaderFraming({ ...ctx, backlog: [stored, queued], queuedCount: 1 }));
    assert.ok(out.includes('since your last look: 2 messages'), out);
    const at = (s: string) => out.indexOf(s);
    assert.ok(at('stored line') >= 0 && at('queued line') > at('stored line'), 'stored first, then queued');
    const note = "[The last one arrived while scout's turn was running, so it is still queued, not yet stored.]";
    assert.ok(at(note) > at('stored line') && at(note) < at('queued line'), out);
  });

  it('with only queued messages, the note names them all', () => {
    const out = textOf(defaultReaderFraming({ ...ctx, backlog: [queued], queuedCount: 1 }));
    assert.ok(out.includes("[It arrived while scout's turn was running, so it is still queued, not yet stored.]"), out);
  });

  it('with no queued messages, the framing is as it was', () => {
    const out = textOf(defaultReaderFraming({ ...ctx, backlog: [stored] }));
    assert.ok(!out.includes('still queued'), out);
    assert.ok(out.includes('since your last look: 1 message'), out);
  });
});
