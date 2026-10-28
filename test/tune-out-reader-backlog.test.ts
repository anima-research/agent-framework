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

function world() {
  const stored: StoredMessage[] = [];
  const invocations: ReaderInvocation[] = [];
  const coordinatorState = new Map<string, unknown>();
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

  it('a fork that fails after its epoch ended gives nothing back', () => {
    const w = world();
    w.tuneOut();
    w.store('ann', 'S-1');
    w.wake();
    const failed = w.invocations[0]!;
    assert.deepEqual(w.coordinator.cancel(SERVER, NOISY, 'agent-tool', 'resident cancelled'), { ok: true });
    assert.equal(w.coordinator.readerFailed(failed), 0, 'the epoch is over: its cancel had its own last fork');
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
