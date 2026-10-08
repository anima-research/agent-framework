/**
 * Speech-route inference (src/speech-routes.ts, shelf-355): a turn's route
 * from its wake's candidates, and which mid-turn arrivals hold it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationKey,
  describeConversation,
  inferTurnRoute,
  isConversational,
  suspendsRoute,
  type ConversationRef,
  type RouteCandidate,
  type SpeechRoute,
  type TurnRoute,
} from '../src/speech-routes.js';

const channel = (channelId: string, extra: Partial<Extract<ConversationRef, { kind: 'channel' }>> = {}): ConversationRef =>
  ({ kind: 'channel', serverId: 'discord', channelId, ...extra });
const candidate = (
  conversation: ConversationRef,
  addressed: boolean,
  at: number,
  messageId?: string,
): RouteCandidate => ({ conversation, addressed, at, ...(messageId ? { messageId } : {}) });
/** Every channel declares `root` (MCPL RFC-011): the common, threadless case. */
const rootEverywhere = (): 'root' => 'root';
const exactEverywhere = (): 'exact' => 'exact';
const declaredNowhere = (): undefined => undefined;

describe('inferTurnRoute', () => {
  it('a fork home always wins', () => {
    const home: SpeechRoute = { kind: 'channel', serverId: 'discord', channelId: 'home', origin: 'home' };
    const turn = inferTurnRoute([candidate(channel('elsewhere'), true, 5, 'm1')], home, rootEverywhere);
    assert.deepEqual(turn, { route: home });
  });

  it('a fork home answers the newest message the wake carried in the home conversation itself', () => {
    const home: SpeechRoute = { kind: 'channel', serverId: 'discord', channelId: 'home', origin: 'home' };
    const turn = inferTurnRoute([
      candidate(channel('home'), false, 1, 'm-old'),
      candidate(channel('home'), false, 3, 'm-new'),
      candidate(channel('elsewhere'), true, 4, 'm-else'),
      candidate(channel('home', { threadId: 't1' }), true, 5, 'm-thread'),
    ], home, exactEverywhere);
    assert.deepEqual(turn, { route: { ...home, replyTo: 'm-new' } });
    // Addressed candidates in the home conversation come first, as for an inferred route.
    const addressed = inferTurnRoute([
      candidate(channel('home'), true, 1, 'm-asked'),
      candidate(channel('home'), false, 2, 'm-later'),
    ], home, rootEverywhere);
    assert.deepEqual(addressed, { route: { ...home, replyTo: 'm-asked' } });
    // A candidate without a message gives no reply edge.
    assert.deepEqual(inferTurnRoute([candidate(channel('home'), true, 1)], home, rootEverywhere), { route: home });
  });

  it('no candidates: no route', () => {
    assert.deepEqual(inferTurnRoute([], undefined, rootEverywhere), { route: null });
  });

  it('an addressed candidate outranks newer ambient chatter elsewhere', () => {
    const turn = inferTurnRoute([
      candidate(channel('dm'), true, 1, 'm-dm'),
      candidate(channel('general'), false, 2, 'm-gen'),
    ], undefined, rootEverywhere);
    assert.deepEqual(turn.route, { kind: 'channel', serverId: 'discord', channelId: 'dm', replyTo: 'm-dm', origin: 'trigger' });
    assert.equal(turn.hold, undefined);
  });

  it('two addressed conversations hold the turn, naming both, newest first', () => {
    const turn = inferTurnRoute([
      candidate(channel('room'), true, 1, 'm1'),
      candidate(channel('dm'), true, 2, 'm2'),
      candidate(channel('general'), false, 3, 'm3'),
    ], undefined, rootEverywhere);
    assert.equal(turn.route, null);
    assert.deepEqual(turn.hold, { since: 'turn-start', conversations: [channel('dm'), channel('room')] });
  });

  it('ambient-only: one conversation routes there; two hold', () => {
    const one = inferTurnRoute([candidate(channel('room'), false, 1, 'm1'), candidate(channel('room'), false, 2, 'm2')], undefined, rootEverywhere);
    assert.deepEqual(one.route, { kind: 'channel', serverId: 'discord', channelId: 'room', replyTo: 'm2', origin: 'trigger' });
    const two = inferTurnRoute([candidate(channel('room'), false, 1), candidate(channel('general'), false, 2)], undefined, rootEverywhere);
    assert.equal(two.route, null);
    assert.equal(two.hold?.conversations.length, 2);
  });

  it('several candidates in one conversation answer the newest of the considered ones', () => {
    const turn = inferTurnRoute([
      candidate(channel('room'), true, 1, 'mention'),
      candidate(channel('room'), false, 5, 'later-ambient'),
      candidate(channel('room'), true, 3, 'second-mention'),
    ], undefined, rootEverywhere);
    assert.equal(turn.route?.kind === 'channel' ? turn.route.replyTo : undefined, 'second-mention',
      'the addressed pool decides, so its newest message is the reply edge');
  });

  it('the same channel id on two servers, or two threads of one channel, are different conversations', () => {
    const servers = inferTurnRoute([
      candidate({ kind: 'channel', serverId: 'a', channelId: 'shared' }, true, 1),
      candidate({ kind: 'channel', serverId: 'b', channelId: 'shared' }, true, 2),
    ], undefined, rootEverywhere);
    assert.equal(servers.hold?.conversations.length, 2);
    const threads = inferTurnRoute([
      candidate(channel('forum', { threadId: 't1' }), true, 1),
      candidate(channel('forum', { threadId: 't2' }), true, 2),
    ], undefined, rootEverywhere);
    assert.equal(threads.hold?.conversations.length, 2);
  });

  it('a thread is a route only where the connector posts into a named thread (RFC-011 exact)', () => {
    const thread = channel('forum', { threadId: 't1', label: 'forum' });
    const exact = inferTurnRoute([candidate(thread, true, 1, 'm1')], undefined, exactEverywhere);
    assert.deepEqual(exact.route, {
      kind: 'channel', serverId: 'discord', channelId: 'forum', threadId: 't1', replyTo: 'm1', label: 'forum', origin: 'trigger',
    });
    // A thread on a channel declared threadless is a contradiction: held,
    // never posted to the root (a different conversation).
    const root = inferTurnRoute([candidate(thread, true, 1, 'm1')], undefined, rootEverywhere);
    assert.deepEqual(root, { route: null, unroutable: { conversation: thread, reason: 'thread' } });
    const held = inferTurnRoute([candidate(thread, true, 1), candidate(channel('room'), true, 2)], undefined, exactEverywhere);
    assert.equal(held.hold?.conversations.length, 2, 'it still holds a turn when it competes');
  });

  it('a channel whose connector declares no publish target is never a route (RFC-011)', () => {
    const one = inferTurnRoute([candidate(channel('room'), true, 1, 'm1')], undefined, declaredNowhere);
    assert.deepEqual(one, { route: null, unroutable: { conversation: channel('room'), reason: 'untargetable' } },
      'the connector would choose the place — perhaps a thread — itself');
    const thread = channel('forum', { threadId: 't1' });
    assert.equal(inferTurnRoute([candidate(thread, true, 1)], undefined, declaredNowhere).unroutable?.reason, 'untargetable',
      'no declaration outranks the thread question');
    // A fork home is the same: no declaration, no route.
    const home: SpeechRoute = { kind: 'channel', serverId: 'discord', channelId: 'home', origin: 'home' };
    assert.deepEqual(inferTurnRoute([], home, declaredNowhere), {
      route: null, unroutable: { conversation: { kind: 'channel', serverId: 'discord', channelId: 'home' }, reason: 'untargetable' },
    });
    // The lookup is per channel.
    const mixed = (c: { channelId: string }): 'root' | undefined => (c.channelId === 'room' ? 'root' : undefined);
    assert.equal(inferTurnRoute([candidate(channel('room'), true, 1)], undefined, mixed).route?.kind, 'channel');
    assert.equal(inferTurnRoute([candidate(channel('other'), true, 1)], undefined, mixed).unroutable?.reason, 'untargetable');
  });

  it('a channel whose server is unknown routes without a placeholder server', () => {
    const turn = inferTurnRoute([candidate({ kind: 'channel', channelId: 'solo' }, true, 1, 'm1')], undefined, rootEverywhere);
    assert.deepEqual(turn.route, { kind: 'channel', channelId: 'solo', replyTo: 'm1', origin: 'trigger' });
  });

  it('a conversation whose channel could not be resolved competes, but is never the route', () => {
    const raw = { conversation: channel('1548'), addressed: true, at: 2, unroutable: true as const };
    const competing = inferTurnRoute([candidate(channel('room'), true, 1, 'm1'), raw], undefined, rootEverywhere);
    assert.equal(competing.route, null);
    assert.equal(competing.hold?.conversations.length, 2, 'never the older conversation by default');
    assert.deepEqual(inferTurnRoute([raw], undefined, rootEverywhere), { route: null, unroutable: { conversation: channel('1548'), reason: 'unresolved' } });
  });

  it('a local surface is addressed by nature, and routes to the surface', () => {
    const turn = inferTurnRoute([
      candidate({ kind: 'surface', surface: 'tui' }, true, 1),
      candidate(channel('general'), false, 2),
    ], undefined, rootEverywhere);
    assert.deepEqual(turn.route, { kind: 'surface', surface: 'tui', origin: 'trigger' });
  });
});

describe('suspendsRoute', () => {
  const routeA: TurnRoute = { route: { kind: 'channel', serverId: 'discord', channelId: 'A', replyTo: 'm1', origin: 'trigger' } };
  const notEngaged = () => false;

  it('an addressed arrival from another conversation suspends an inferred route', () => {
    assert.equal(suspendsRoute(routeA, { conversation: channel('dm'), addressed: true }, notEngaged), true);
  });

  it('the same conversation never does, addressed or not', () => {
    assert.equal(suspendsRoute(routeA, { conversation: channel('A'), addressed: true }, notEngaged), false);
  });

  it('ambient chatter does only in a conversation the resident engaged this turn', () => {
    const arrival = { conversation: channel('lounge'), addressed: false };
    assert.equal(suspendsRoute(routeA, arrival, notEngaged), false);
    assert.equal(suspendsRoute(routeA, arrival, (c) => c.kind === 'channel' && c.channelId === 'lounge'), true);
  });

  it('deliberate routes, held turns and route-less turns are never suspended', () => {
    const arrival = { conversation: channel('dm'), addressed: true };
    for (const origin of ['home', 'open'] as const) {
      assert.equal(suspendsRoute({ route: { kind: 'channel', serverId: 'discord', channelId: 'A', origin } }, arrival, notEngaged), false);
    }
    assert.equal(suspendsRoute({ ...routeA, hold: { since: 'turn-start', conversations: [] } }, arrival, notEngaged), false);
    assert.equal(suspendsRoute({ route: null }, arrival, notEngaged), false);
  });
});

describe('isConversational', () => {
  it('reactions and system markers are machinery, everything else is conversation', () => {
    assert.equal(isConversational(['chat:reaction'], {}), false);
    assert.equal(isConversational(['chat:reaction-remove'], {}), false, 'a removal is machinery too');
    assert.equal(isConversational(['chat:ambient'], { system: true }), false);
    assert.equal(isConversational(['chat:addressed'], {}), true);
    assert.equal(isConversational(undefined, undefined), true);
  });
});

describe('conversation identity and wording', () => {
  it('keys include server, channel and thread; surfaces are their own', () => {
    assert.notEqual(conversationKey(channel('x')), conversationKey({ kind: 'channel', serverId: 'other', channelId: 'x' }));
    assert.notEqual(conversationKey(channel('x')), conversationKey(channel('x', { threadId: 't' })));
    assert.notEqual(conversationKey({ kind: 'surface', surface: 'x' }), conversationKey(channel('x')));
  });

  it('describes a conversation by a usable address', () => {
    assert.equal(describeConversation(channel('discord:g1:room', { label: 'room' })), '#room (discord:g1:room)');
    assert.equal(describeConversation(channel('discord:dm:7')), 'discord:dm:7');
    assert.equal(describeConversation(channel('forum', { threadId: 't1' })), 'forum (thread t1)');
    assert.equal(describeConversation({ kind: 'surface', surface: 'tui' }), 'tui (the local surface that messaged you)');
  });
});
