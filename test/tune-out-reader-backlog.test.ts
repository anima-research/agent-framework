/**
 * Reader forks and the messages a tune-out holds (#291).
 *
 * A held message is stored as it arrives, whatever the resident's turn, so
 * a reader fork is handed what arrived while the resident was busy, when a
 * reader is most useful: on a wake, on a cadence look and on a cancel. Each
 * held message goes to exactly one reader, by the coordinator's cursor over
 * the stored rows. A fork that never read what it was handed gives it back
 * (`readerFailed`). A reader's own cancel is followed by one more fork only
 * for what arrived after the reader was handed its own, and a cadence period
 * with nothing new derives no fork. (Before #291 a message that arrived
 * during the resident's turn waited in the deferred queue, and readers were
 * handed it from there, as "queued".)
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

function world(opts: { subconscious?: boolean } = {}) {
  const stored: StoredMessage[] = [];
  /** The held messages a surgery's hold keeps in memory, not stored yet (getSurgeryHeldMessages). */
  const kept: Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> = [];
  /** What the persistent subconscious is given, with `subconscious: true`. */
  const looks: Array<{ text: string; kind: unknown }> = [];
  const invocations: ReaderInvocation[] = [];
  const coordinatorState = new Map<string, unknown>();
  /** Durable records whose read throws, by the last part of their id, such as `last-looks`. */
  const unreadable = new Set<string>();
  const active = new Map<string, { params: Record<string, unknown>; wakeCount: number }>();
  let nextSeq = 1;

  const registry = {
    nameShown: (ref: { channelId: string }) => ref.channelId,
    // main's #852: a channel named in a sentence is quoted as tune_out takes it back.
    quotedShown: (ref: { channelId: string }) => JSON.stringify(ref.channelId),
    listChannelsRaw: () => [NOISY, OTHER, 'disc:guild:work'].map((id) => ({ serverId: SERVER, descriptor: { id } })),
    getTuneOutState: (serverId: string, channelId: string) => active.get(`${serverId}\0${channelId}`) ?? null,
    cancelTuneOut: (serverId: string, channelId: string) => {
      const key = `${serverId}\0${channelId}`;
      const ended = active.get(key) ?? null;
      active.delete(key);
      return ended;
    },
    readCoordinatorState: (id: string) => {
      if (unreadable.has(id.split('/').pop()!)) throw new Error(`the store couldn't read ${id}`);
      return coordinatorState.get(id) ?? null;
    },
    writeCoordinatorState: (id: string, value: unknown) => { coordinatorState.set(id, value); },
  } as unknown as ChannelRegistry;
  const servers = { getServer: () => undefined } as unknown as McplServerRegistry;
  const hooks = {
    addMessage: (_participant: string, content: ContentBlock[], metadata: Record<string, unknown> | undefined, agent?: string) => {
      if (agent === 'Subconscious') looks.push({ text: textOf(content), kind: metadata?.kind });
    },
    requestInference: () => {},
    subconsciousName: () => (opts.subconscious ? 'Subconscious' : null),
    invokeReader: (invocation: ReaderInvocation) => { invocations.push(invocation); },
    deliverFromReader: () => {},
    primaryName: () => 'scout',
    getStoredMessages: () => stored,
    getSurgeryHeldMessages: () => kept,
    // The store's sequence: its newest row's, as chronicle's currentSequence.
    currentSequence: () => nextSeq - 1,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    emitTrace: () => {},
  } as unknown as TuneOutFrameworkHooks;
  type Internals = {
    invokeSubconscious(serverId: string, channelId: string, trigger: 'cadence' | 'wake', count: number): void;
    startCadence(serverId: string, channelId: string, cadenceSeconds: number): void;
  };
  let coordinator = new TuneOutCoordinator(registry, servers, hooks);
  let internals = coordinator as unknown as Internals;

  return {
    get coordinator() { return coordinator; },
    get internals() { return internals; },
    invocations,
    looks,
    unreadable,
    /** A durable record as the store holds it, by the last part of its id. */
    stored: (name: string): unknown => [...coordinatorState].find(([id]) => id.endsWith(`/${name}`))?.[1],
    /** A host restart: a new coordinator over the same store and durable state, its timers armed again. */
    restart(): void {
      coordinator.stop();
      coordinator = new TuneOutCoordinator(registry, servers, hooks);
      internals = coordinator as unknown as Internals;
      coordinator.resumeActiveEpochs();
    },
    /** Hold a channel under an epoch, as a per-channel tune-out does. */
    tuneOut(backlogCap = 200, where: Where = {}) {
      active.set(`${where.serverId ?? SERVER}\0${where.channelId ?? NOISY}`, {
        params: { epochId: where.epochId ?? EPOCH, cadenceSeconds: 30, backlogCap, maxWakes: 5, startedAtSequence: 0 },
        wakeCount: 0,
      });
    },
    /** A held message, stored as it arrives, the resident's turn alive or not. */
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
    /** A held message a surgery's hold keeps in memory, as framework.addMessage does during one. */
    keep(author: string, body: string, where: Where = {}): void {
      kept.push({ participant: 'user', content: [text(body)], metadata: meta(author, where) } as Pick<StoredMessage, 'participant' | 'content' | 'metadata'>);
    },
    /** The hold's release: what it kept is stored, in arrival order. */
    releaseHold(): void {
      for (const write of kept.splice(0)) {
        stored.push({ id: `m-${nextSeq}`, sequence: nextSeq++, timestamp: new Date(), ...write } as unknown as StoredMessage);
      }
    },
    wake: (serverId = SERVER, channelId = NOISY) => internals.invokeSubconscious(serverId, channelId, 'wake', 1),
    startCadence: (seconds: number) => internals.startCadence(SERVER, NOISY, seconds),
  };
}

const bodies = (invocation: ReaderInvocation) => invocation.backlog.map((m) => textOf(m.content));

describe('reader forks and the messages a tune-out holds', () => {
  it("a wake while the resident's turn runs hands the reader what was held, stored as it arrived, the one that woke it included", () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'AMB-1 chatter');
    w.store('bo', 'AMB-2 more chatter');
    w.store('cy', 'ADDR-3 hey scout, your build is stuck');
    w.wake();
    assert.equal(w.invocations.length, 1, 'one fork');
    assert.deepEqual(bodies(w.invocations[0]!), ['AMB-1 chatter', 'AMB-2 more chatter', 'ADDR-3 hey scout, your build is stuck'], 'all three, oldest first');
    assert.equal((w.invocations[0] as { queued?: unknown }).queued, undefined, 'nothing is queued');
    w.coordinator.stop();
  });

  it('a message handed to a reader is not handed again; what is new still is', () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'S-1 before the turn');
    w.store('bo', 'S-2 during the turn');
    w.wake();
    assert.deepEqual(bodies(w.invocations[0]!), ['S-1 before the turn', 'S-2 during the turn']);
    w.store('cy', 'S-3 after the turn');
    w.wake();
    assert.equal(w.invocations.length, 2);
    assert.deepEqual(bodies(w.invocations[1]!), ['S-3 after the turn'], 'S-1 and S-2 are not handed again');
    w.wake();
    assert.deepEqual(bodies(w.invocations[2]!), [], 'and S-3 is not handed again');
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
    const m2 = w.store('bo', 'AMB-2 while the turn runs');
    w.coordinator.recordHeld(SERVER, NOISY, m2.id, [], 'bo', true);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 2, 'a period with a new message does');
    assert.deepEqual(bodies(w.invocations[1]!), ['AMB-2 while the turn runs']);
    w.coordinator.stop();
  });

  it("a failed fork's messages go to the next reader, with what is new", () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'S-1');
    w.store('bo', 'S-2');
    w.wake();
    const failed = w.invocations[0]!;
    assert.equal(w.coordinator.readerFailed(failed), 2, 'both go back');
    w.store('cy', 'S-3 new');
    w.wake();
    assert.deepEqual(bodies(w.invocations[1]!), ['S-1', 'S-2', 'S-3 new'], 'the returned two again, with the new one');
    w.wake();
    assert.deepEqual(bodies(w.invocations[2]!), [], 'and once handed again, not a third time');
    w.coordinator.stop();
  });

  it('a fork still running when its epoch ends, which then fails, has what it was handed go to one late fork', () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'S-1');
    w.store('bo', 'S-2');
    w.wake();
    const failed = w.invocations[0]!;
    assert.deepEqual(bodies(failed), ['S-1', 'S-2']);
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    const atCancel = w.invocations.length;
    assert.deepEqual(w.invocations.slice(1).map(bodies), [[]], "premise: the cancel's last fork is handed neither");
    assert.equal(w.coordinator.readerFailed(failed), 2, 'both go to a late fork');
    const late = w.invocations.slice(atCancel);
    assert.equal(late.length, 1, 'one late fork');
    assert.deepEqual(bodies(late[0]!), ['S-1', 'S-2'], 'handed both, oldest first');
    assert.equal(late[0]!.epochId, EPOCH);
    assert.ok(late[0]!.notice.includes('These 2 messages were handed to a reader that failed after the tune-out ended'), late[0]!.notice);
    w.coordinator.stop();
  });

  it("the cancel's fork is handed every held message no reader was handed", () => {
    const w = world();
    w.tuneOut(1);
    w.store('ann', 'HELD-1 first');
    w.store('bo', 'HELD-2 second');
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    assert.equal(w.invocations.length, 1, "the cancel's fork");
    const fork = w.invocations[0]!;
    assert.equal(fork.trigger, 'cancel');
    assert.deepEqual(bodies(fork), ['HELD-1 first', 'HELD-2 second'], 'both, though the dump shows only the newer');
    assert.ok(fork.notice.includes("1 of 2 diverted messages, the oldest, weren't delivered raw"), 'its notice counts what the dump left out');
    w.coordinator.stop();
  });

  it("a reader's own cancel derives no fork when the reader was handed everything", () => {
    const w = world();
    w.tuneOut(1);
    w.store('ann', 'AMB-1');
    w.store('bo', 'ADDR-2 hey scout');
    w.wake();
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'subconscious', 'subconscious judgment', undefined, 'reader/scout/x/1'), { ok: true });
    assert.equal(w.invocations.length, 1, 'only the reader that cancelled');
    w.coordinator.stop();
  });

  it("a reader's own cancel is followed by one fork for what arrived after the reader was handed its own", () => {
    const w = world();
    w.tuneOut(1);
    w.store('ann', 'ADDR-1 hey scout');
    w.wake();
    w.store('bo', 'AMB-2 arrived while the reader read');
    w.store('cy', 'AMB-3 arrived after that');
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'subconscious', 'subconscious judgment', undefined, 'reader/scout/x/1'), { ok: true });
    assert.equal(w.invocations.length, 2, 'one more fork');
    const late = w.invocations[1]!;
    assert.equal(late.trigger, 'cancel');
    assert.deepEqual(bodies(late), ['AMB-2 arrived while the reader read', 'AMB-3 arrived after that'],
      'handed only what the cancelling reader was not');
    assert.ok(late.notice.includes('These 2 messages arrived after the reader that cancelled was handed its own.'), late.notice);
    w.coordinator.stop();
  });

  it("a reader's own release of the all-except hold derives a fork for each channel with messages no reader was handed", () => {
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600 }, 'agent-tool').ok);
    const epochId = w.coordinator.getAllExcept()!.params.epochId;
    w.store('ann', 'N-1 in noisy', { epochId, channelId: NOISY });
    w.wake(); // the reader for noisy is handed N-1
    assert.deepEqual(bodies(w.invocations[0]!), ['N-1 in noisy']);
    w.store('bo', 'O-1 in other', { epochId, channelId: OTHER });
    assert.deepEqual(w.coordinator.cancelAllExcept('subconscious', 'subconscious judgment', undefined, 'reader/scout/x/1'), { ok: true });
    assert.equal(w.invocations.length, 2, 'one more fork: for other, whose message no reader had');
    assert.equal(w.invocations[1]!.channelId, OTHER);
    assert.deepEqual(bodies(w.invocations[1]!), ['O-1 in other']);
    w.coordinator.stop();
  });

  it("the resident's release of the all-except hold hands each channel's reader what it holds", () => {
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600 }, 'agent-tool').ok);
    const epochId = w.coordinator.getAllExcept()!.params.epochId;
    w.store('ann', 'N-1 in noisy', { epochId, channelId: NOISY });
    w.store('bo', 'N-2 in noisy, during a turn', { epochId, channelId: NOISY });
    w.store('cy', 'O-1 in other', { epochId, channelId: OTHER });
    assert.deepEqual(w.coordinator.cancelAllExcept('agent-tool', 'resident released'), { ok: true });
    const byChannel = Object.fromEntries(w.invocations.map((inv) => [inv.channelId, bodies(inv)]));
    assert.deepEqual(byChannel, {
      [NOISY]: ['N-1 in noisy', 'N-2 in noisy, during a turn'],
      [OTHER]: ['O-1 in other'],
    });
    w.coordinator.stop();
  });

  it('two servers sharing a channel id keep their readers apart, on a wake and on the release', () => {
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600 }, 'agent-tool').ok);
    const epochId = w.coordinator.getAllExcept()!.params.epochId;
    w.store('ann', 'A-1 on disc', { epochId, channelId: 'general', serverId: 'disc' });
    w.store('bo', 'B-1 on slack', { epochId, channelId: 'general', serverId: 'slack' });
    w.wake('disc', 'general');
    assert.deepEqual(bodies(w.invocations[0]!), ['A-1 on disc'], "disc's reader is handed disc's message only");
    assert.deepEqual(w.coordinator.cancelAllExcept('agent-tool', 'resident released'), { ok: true });
    assert.equal(w.invocations.length, 2, "one more fork: for slack's general, whose message no reader had");
    assert.equal(w.invocations[1]!.serverId, 'slack');
    assert.deepEqual(bodies(w.invocations[1]!), ['B-1 on slack']);
    w.coordinator.stop();
  });
});

describe("a channel held in turn by the all-except hold and by its own tune-out", () => {
  // A per-channel tune-out takes a channel the scope holds; its messages are
  // its own epoch's. What readers were handed is each epoch's, so neither
  // epoch's reading moves or clears the other's.
  const scoped = (w: ReturnType<typeof world>): string => {
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600 }, 'agent-tool').ok);
    return w.coordinator.getAllExcept()!.params.epochId;
  };

  it("the channel's own tune-out ending leaves what the scope's readers were handed as it was", () => {
    const w = world();
    const scope = scoped(w);
    w.store('ann', 'S-1 under the scope', { epochId: scope });
    w.wake();
    assert.deepEqual(bodies(w.invocations[0]!), ['S-1 under the scope']);
    w.tuneOut();
    w.store('bo', 'P-2 under its own tune-out');
    w.wake();
    assert.deepEqual(bodies(w.invocations[1]!), ['P-2 under its own tune-out']);
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    w.store('cy', 'S-3 under the scope again', { epochId: scope });
    w.wake();
    const next = w.invocations.at(-1)!;
    assert.equal(next.epochId, scope, 'the scope holds the channel again');
    assert.deepEqual(bodies(next), ['S-3 under the scope again'], 'S-1 was read under the scope, so it is not handed again');
    w.coordinator.stop();
  });

  it("the scope's release hands its reader the scope's unread messages, whatever the channel's own tune-out's readers were handed", () => {
    const w = world();
    const scope = scoped(w);
    w.store('ann', 'S-1 under the scope, unread', { epochId: scope });
    w.tuneOut();
    w.store('bo', 'P-2 under its own tune-out');
    w.wake();
    assert.deepEqual(bodies(w.invocations[0]!), ['P-2 under its own tune-out']);
    assert.deepEqual(w.coordinator.cancelAllExcept('agent-tool', 'resident released'), { ok: true });
    const last = w.invocations.slice(1).filter((inv) => inv.epochId === scope);
    assert.deepEqual(last.map(bodies), [['S-1 under the scope, unread']], 'one last fork, handed S-1');
    w.store('cy', 'P-3 still under its own tune-out');
    w.wake();
    assert.deepEqual(bodies(w.invocations.at(-1)!), ['P-3 still under its own tune-out'],
      "and the channel's own tune-out's readers go on from where they were");
    w.coordinator.stop();
  });

  it("a scope's fork that fails once the channel's own tune-out holds the channel gives its messages back to the scope", () => {
    const w = world();
    const scope = scoped(w);
    w.store('ann', 'S-1 under the scope', { epochId: scope });
    w.wake(); // the scope's fork for noisy is handed S-1, and is still running...
    const running = w.invocations[0]!;
    assert.deepEqual(bodies(running), ['S-1 under the scope']);
    w.tuneOut(); // ...when the resident tunes noisy out on its own
    assert.equal(w.coordinator.readerFailed(running), 1, 'its one message goes back to the scope');
    assert.deepEqual(w.coordinator.cancelAllExcept('agent-tool', 'resident released'), { ok: true });
    const last = w.invocations.slice(1).filter((inv) => inv.epochId === scope);
    assert.deepEqual(last.map(bodies), [['S-1 under the scope']], "the scope's last fork is handed S-1");
    w.coordinator.stop();
  });

  it("a late fork's own failure derives no other", () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'P-1 under its own tune-out');
    w.wake();
    const running = w.invocations[0]!;
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    assert.equal(w.coordinator.readerFailed(running), 1, 'premise: a late fork is handed P-1');
    const late = w.invocations.at(-1)!;
    assert.deepEqual(bodies(late), ['P-1 under its own tune-out']);
    const forks = w.invocations.length;
    assert.equal(w.coordinator.readerFailed(late), 0, 'the late fork fails too: nothing more');
    assert.equal(w.invocations.length, forks, 'and no other fork is derived');
    w.coordinator.stop();
  });
});

describe('a cadence look for held messages no reader has looked at, though nothing new arrives', () => {
  const held = (w: ReturnType<typeof world>, author: string, body: string, where: Where = {}): void => {
    const m = w.store(author, body, where);
    w.coordinator.recordHeld(where.serverId ?? SERVER, where.channelId ?? NOISY, m.id, [], author, true);
  };

  it('after a restart, a channel held across it gets its cadence look', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    w.tuneOut();
    held(w, 'ann', 'H-1 held before the restart');
    held(w, 'bo', 'H-2 held before the restart');
    w.restart();
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 1, 'the first period after the restart reads them');
    assert.deepEqual(bodies(w.invocations[0]!), ['H-1 held before the restart', 'H-2 held before the restart']);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 1, 'and a quiet period after it derives none');
    w.coordinator.stop();
  });

  it('after a restart, each channel the all-except hold holds gets its cadence look', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600, cadenceSeconds: 30 }, 'agent-tool').ok);
    const epochId = w.coordinator.getAllExcept()!.params.epochId;
    held(w, 'ann', 'N-1 in noisy', { epochId, channelId: NOISY });
    held(w, 'bo', 'O-1 in other', { epochId, channelId: OTHER });
    w.restart();
    t.mock.timers.tick(30_000);
    const byChannel = Object.fromEntries(w.invocations.map((inv) => [inv.channelId, bodies(inv)]));
    assert.deepEqual(byChannel, {
      [NOISY]: ['N-1 in noisy'],
      [OTHER]: ['O-1 in other'],
    });
    w.coordinator.stop();
  });

  // AF-C-2: a cadence tick or a wake during a surgery's hold reset the tally
  // to 0, though the held message the hold kept in memory was handed to no
  // fork; after the release, no cadence look counted it.
  it("a held message a surgery's hold keeps in memory still counts after a look during the hold, and the first period after the release hands it", (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    w.tuneOut();
    w.startCadence(30);
    w.keep('ann', 'KEPT-1 during the hold');
    w.coordinator.recordHeld(SERVER, NOISY, 'x1', [], 'ann', true);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 0, 'a period during the hold has nothing stored to hand');
    w.wake();
    assert.equal(w.invocations.length, 1, 'a wake during the hold derives a fork');
    assert.deepEqual(bodies(w.invocations[0]!), [], 'handed nothing: the kept message is not stored');
    w.releaseHold();
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 2, 'the first period after the release reads it');
    assert.deepEqual(bodies(w.invocations[1]!), ['KEPT-1 during the hold']);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 2, 'and the next is quiet');
    w.coordinator.stop();
  });

  it("a failed fork's messages get the next cadence look", (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    w.tuneOut();
    w.startCadence(30);
    held(w, 'ann', 'F-1 read by a fork that failed');
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 1);
    assert.equal(w.coordinator.readerFailed(w.invocations[0]!), 1);
    t.mock.timers.tick(30_000);
    assert.equal(w.invocations.length, 2, 'the next period reads F-1 again');
    assert.deepEqual(bodies(w.invocations[1]!), ['F-1 read by a fork that failed']);
    w.coordinator.stop();
  });

  it("the channel's own tune-out ending gives the all-except hold's unread messages there their cadence look", (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    assert.ok(w.coordinator.enterAllExcept({ serverId: SERVER, channelId: 'disc:guild:work' }, { durationSeconds: 600, cadenceSeconds: 30 }, 'agent-tool').ok);
    const scope = w.coordinator.getAllExcept()!.params.epochId;
    held(w, 'ann', 'S-1 under the scope', { epochId: scope });
    w.tuneOut();
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    const before = w.invocations.length;
    t.mock.timers.tick(30_000);
    const looks = w.invocations.slice(before);
    assert.deepEqual(looks.map((inv) => [inv.epochId, bodies(inv)]), [[scope, ['S-1 under the scope']]],
      "the scope's next period reads S-1");
    w.coordinator.stop();
  });

  it("after a restart, the persistent subconscious's cadence look counts only what was held since its last look", (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world({ subconscious: true });
    w.tuneOut();
    w.startCadence(30);
    held(w, 'ann', 'S-1');
    held(w, 'bo', 'S-2');
    t.mock.timers.tick(30_000);
    assert.equal(w.looks.length, 1);
    assert.match(w.looks[0]!.text, /— 2 diverted messages since your last look/);
    held(w, 'cy', 'S-3 after its look');
    w.restart();
    t.mock.timers.tick(30_000);
    assert.equal(w.looks.length, 2, 'the first period after the restart has a look');
    assert.match(w.looks[1]!.text, /— 1 diverted message since your last look/, 'counting S-3 alone');
    t.mock.timers.tick(30_000);
    assert.equal(w.looks.length, 2, 'and a quiet period after it has none');
    w.coordinator.stop();
  });

  // The house's two cases for a held message still queued behind the
  // resident's turn (across a restart; under the scope when the channel's own
  // tune-out ends) have no counterpart here: every held message is stored as
  // it arrives (#291), and the stored cases above are those.

  it("a look while the stored last looks can't be read leaves the other channels' stored looks as they were", (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world({ subconscious: true });
    w.tuneOut();
    w.tuneOut(200, { channelId: OTHER, epochId: 'e-other' });
    held(w, 'ann', 'N-1');
    w.internals.invokeSubconscious(SERVER, NOISY, 'cadence', 1);
    const before = structuredClone(w.stored('last-looks'));
    assert.deepEqual(Object.keys(before as object), [EPOCH], "premise: noisy's look is stored");
    w.unreadable.add('last-looks');
    w.restart();
    held(w, 'bo', 'O-1', { channelId: OTHER, epochId: 'e-other' });
    w.internals.invokeSubconscious(SERVER, OTHER, 'cadence', 1);
    assert.deepEqual(w.stored('last-looks'), before, "noisy's stored look is as it was");
    w.unreadable.delete('last-looks');
    w.internals.invokeSubconscious(SERVER, OTHER, 'cadence', 1);
    assert.deepEqual(Object.keys(w.stored('last-looks') as object).sort(), [EPOCH, 'e-other'].sort(),
      'once the record reads again, the next look is stored beside it');
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
  const first = row('m-1', 1, 'ann', 'first line');
  const second = row('m-2', 2, 'bo', 'second line');

  it('shows the held messages oldest first, counted', () => {
    const out = textOf(defaultReaderFraming({ ...ctx, backlog: [first, second] }));
    assert.ok(out.includes('since your last look: 2 messages'), out);
    const at = (s: string) => out.indexOf(s);
    assert.ok(at('first line') >= 0 && at('second line') > at('first line'), out);
  });

  it('ignores a queuedCount, which nothing sets since #291, and notes nothing as still queued', () => {
    const out = textOf(defaultReaderFraming({ ...ctx, backlog: [first, second], queuedCount: 1 }));
    assert.ok(!out.includes('still queued'), out);
    assert.ok(out.includes('since your last look: 2 messages'), out);
  });
});
