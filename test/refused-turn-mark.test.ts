import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';
import { createMockResponse, HeldStream, MockYieldingStream } from './helpers/mock-membrane.js';
import { fixture, eventually, ok, TS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';

const ROOM = 'discord:g1:room';
const ADMIN = 'discord:g1:admin';
const GENERAL = 'discord:g1:general';
const ADDRESSED = ['chat:mention', 'chat:addressed', 'chat:from-human'];
const QUIET_AMBIENT = { config: { policies: [{ name: 'quiet', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer' }], default: 'always' } };

type Internals = {
  logFailure(record: Record<string, unknown>): void;
  deferredMessages: unknown[];
  channelRegistry: { getDesiredState(serverId: string, channelId: string): string | undefined };
};

const refusal = () => createMockResponse([], 'refusal');
const answer = (text: string) => createMockResponse([{ type: 'text', text }]);

class FailedCall implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly kind: 'invalid-request' | 'rate-limit' = 'invalid-request') {}
  provideToolResults(): void {}
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield {
      type: 'error',
      error: this.kind === 'rate-limit'
        ? new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 50, message: 'rate limit reached for requests', rawError: { status: 429 } })
        : new MembraneError({ type: 'invalid_request', retryable: false, httpStatus: 400, message: 'the provider could not process the request', rawError: { status: 400 } }),
    } as StreamEvent;
  }
}

async function rig(t: TestContext, opts: { framework?: Partial<FrameworkConfig>; agents?: unknown[] } = {}) {
  const marks: Array<{ name?: unknown; arguments?: Record<string, unknown> }> = [];
  const f = await fixture({
    framework: opts.framework,
    agents: opts.agents,
    toolsCall: (params) => { marks.push(params as { name?: unknown; arguments?: Record<string, unknown> }); return { content: [] }; },
  });
  t.after(f.close);
  const streams: Array<() => YieldingStream> = [];
  f.membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    f.membrane.calls.push(request);
    const make = streams.shift();
    return make ? make() : new MockYieldingStream([ok()]);
  };
  f.framework.start();
  const fw = f.framework as unknown as Internals;
  const records: Array<Record<string, unknown>> = [];
  t.mock.method(fw, 'logFailure', (record: Record<string, unknown>) => { if (record.kind === 'refusal') records.push(record); });
  await f.send('channels/register', {
    channels: [
      { id: ROOM, type: 'discord', label: 'room', initiallyOpen: true },
      { id: GENERAL, type: 'discord', label: 'general', initiallyOpen: true },
      { id: ADMIN, type: 'discord', label: 'admin', initiallyOpen: false },
    ],
  });
  await eventually(() => fw.channelRegistry.getDesiredState('editor', ROOM) === 'open', 'room is open');
  const incoming = (channelId: string, messageId: string, tags = ADDRESSED) => f.send('channels/incoming', {
    messages: [{ channelId, messageId, timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags, content: [{ type: 'text', text: `message ${messageId}` }] }],
  });
  const adminMention = (messageId: string) => f.send('push/event', {
    featureSet: 'doc', eventId: `e-${messageId}`, timestamp: TS,
    origin: { source: 'discord', mcplChannelId: ADMIN, channelId: 'admin', guildId: 'g1', channelName: 'admin', messageId, authorId: 'U1', authorName: 'Antra' },
    tags: ADDRESSED,
    payload: { content: [{ type: 'text', text: `@agent message ${messageId}` }] },
  });
  const answered = async (channelId: string, messageId: string) => {
    const before = f.membrane.calls.length;
    streams.push(() => new MockYieldingStream([answer(`answer to ${messageId}`)]));
    await incoming(channelId, messageId);
    await eventually(() => f.membrane.calls.length > before, `the turn for ${messageId}`);
    await f.framework.runUntilIdle();
  };
  const marked = () => marks.map((m) => [m.name, m.arguments?.channelId, m.arguments?.messageId]);
  const markSent = async () => {
    await answered(ROOM, 'm-after');
    await eventually(() => f.published.some((p) => JSON.stringify(p).includes('answer to m-after')), 'a later post');
  };
  return { f, fw, streams, records, marks, marked, incoming, adminMention, answered, markSent };
}

describe('a refused turn is marked on the message it answers, and its failure names that message\'s channel', () => {
  it('a mention pushed from a closed channel after a message answered in an open one: the mark goes on the mention, and the record names its channel', async (t) => {
    const r = await rig(t);
    await r.answered(ROOM, 'm-room');
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.adminMention('m-admin');
    await eventually(() => r.records.length === 1 && r.marks.length === 1, 'the refusal, recorded and marked');
    assert.deepEqual(r.marked(), [['add_reaction', 'admin', 'm-admin']]);
    assert.equal(r.records[0]!.locus, ADMIN);
  });

  it('a mention pushed from a closed channel, alone: it gets its mark', async (t) => {
    const r = await rig(t);
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.adminMention('m-admin');
    await eventually(() => r.records.length === 1 && r.marks.length === 1, 'the refusal, recorded and marked');
    assert.deepEqual(r.marked(), [['add_reaction', 'admin', 'm-admin']]);
    assert.equal(r.records[0]!.locus, ADMIN);
  });

  it('a mention pushed from a closed channel as a channel-scoped coalesced create, as discord-mcpl sends it: it gets its mark', async (t) => {
    const r = await rig(t);
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.f.send('push/event', {
      featureSet: 'doc', eventId: 'e-m-admin', timestamp: TS,
      origin: { source: 'discord', mcplChannelId: ADMIN, channelId: 'admin', guildId: 'g1', channelName: 'admin', messageId: 'm-admin', authorId: 'U1', authorName: 'Antra' },
      tags: ADDRESSED,
      coalesce: { key: 'message:m-admin', initial: true, channelId: ADMIN },
      payload: { content: [{ type: 'text', text: '@agent message m-admin' }] },
    });
    await eventually(() => r.records.length === 1 && r.marks.length === 1, 'the refusal, recorded and marked');
    assert.deepEqual(r.marked(), [['add_reaction', 'admin', 'm-admin']]);
    assert.equal(r.records[0]!.locus, ADMIN);
  });

  it('a channel-scoped coalesced push that names no message marks nothing when its turn is refused', async (t) => {
    const r = await rig(t);
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.f.send('push/event', {
      featureSet: 'doc', eventId: 'e-unnamed', timestamp: TS,
      origin: { source: 'discord', mcplChannelId: ADMIN, channelId: 'admin', guildId: 'g1', channelName: 'admin', authorId: 'U1', authorName: 'Antra' },
      tags: ADDRESSED,
      coalesce: { key: 'notice:1', initial: true, channelId: ADMIN },
      payload: { content: [{ type: 'text', text: '@agent a push that names no message' }] },
    });
    await eventually(() => r.records.length === 1, 'the refusal recorded');
    await r.markSent();
    assert.deepEqual(r.marked(), []);
    assert.equal(r.records[0]!.locus, ADMIN);
  });

  it('a deferred push\'s rendered batch answers no one message: its refused turn marks nothing', async (t) => {
    const r = await rig(t);
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.f.send('push/event', {
      featureSet: 'doc', eventId: 'e-deferred', timestamp: TS,
      origin: { source: 'discord', mcplChannelId: ADMIN, channelId: 'admin', guildId: 'g1', channelName: 'admin', messageId: 'm-deferred', authorId: 'U1', authorName: 'Antra' },
      tags: ADDRESSED,
      coalesce: { key: 'message:m-deferred', initial: true, deferred: true, channelId: ADMIN },
      payload: { content: [{ type: 'text', text: '@agent a deferred message' }] },
    });
    await eventually(() => r.f.renders.length === 1 && r.records.length === 1, 'the batch rendered, and its turn refused');
    await r.markSent();
    assert.deepEqual(r.marked(), []);
    assert.equal(r.records[0]!.locus, ADMIN);
  });

  it('a debounced push answers no one message: nothing is marked, and the record names its channel', async (t) => {
    const r = await rig(t, { framework: { gate: { config: { policies: [{ name: 'batch', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } }], default: 'always' } } } as never });
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.adminMention('m-admin');
    await eventually(() => r.records.length === 1, 'the refusal recorded');
    await r.markSent();
    assert.deepEqual(r.marked(), []);
    assert.equal(r.records[0]!.locus, ADMIN);
  });

  it('a message that arrived while the turn before it was alive: its own refused turn marks it, though an ambient message came after it', async (t) => {
    const r = await rig(t, { framework: { gate: QUIET_AMBIENT } as never });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new HeldStream(released, [answer('answer to m-a')]));
    await r.incoming(ROOM, 'm-a');
    await eventually(() => r.f.membrane.calls.length === 1, 'the turn for m-a, held');
    await r.incoming(ROOM, 'm-b');
    await r.incoming(GENERAL, 'm-c', ['chat:ambient', 'chat:from-human']);
    await eventually(() => r.fw.deferredMessages.length === 2, 'm-b and m-c deferred behind the live turn');
    r.streams.push(() => new MockYieldingStream([refusal()]));
    release();
    await eventually(() => r.records.length === 1 && r.marks.length === 1, 'm-b\'s turn, refused and marked');
    assert.deepEqual(r.marked(), [['add_reaction', 'room', 'm-b']]);
    assert.equal(r.records[0]!.locus, ROOM);
  });

  it('a reaction is about a message, not one the turn answers: a refused turn it woke marks nothing', async (t) => {
    const r = await rig(t);
    await r.answered(ROOM, 'm-room');
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.f.send('push/event', {
      featureSet: 'doc', eventId: 'e-reaction', timestamp: TS,
      origin: { source: 'discord', mcplChannelId: ROOM, channelId: 'room', guildId: 'g1', messageId: 'm-room', reactorId: 'U1', reactorName: 'Antra', emoji: '👍', action: 'add' },
      tags: ['chat:reaction', 'chat:to-self'],
      payload: { content: [{ type: 'text', text: '[reaction] @Antra reacted 👍 on your message' }] },
    });
    await eventually(() => r.records.length === 1, 'the refusal recorded');
    await r.markSent();
    assert.deepEqual(r.marked(), []);
    assert.equal(r.records[0]!.locus, ROOM);
  });

  it('a turn started from a merge of wakes answers no one message, though one of them carried the message a rewind\'s retry answers', async (t) => {
    const r = await rig(t);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new HeldStream(released, [answer('answer to m-a')]));
    await r.incoming(ROOM, 'm-a');
    await eventually(() => r.f.membrane.calls.length === 1, 'the turn for m-a, held');
    (r.fw as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'refusal-rewind-retry', source: 'framework', timestamp: Date.now(),
      channelId: ROOM, channelServerId: 'editor', answersMessageId: 'm-a',
    });
    await r.incoming(GENERAL, 'm-g');
    await eventually(() => r.fw.deferredMessages.length === 1, 'm-g deferred behind the live turn');
    r.streams.push(() => new MockYieldingStream([refusal()]));
    release();
    await eventually(() => r.records.length === 1, 'the merged turn, refused');
    await r.markSent();
    assert.deepEqual(r.marked(), []);
    assert.equal(r.records[0]!.locus, GENERAL);
  });

  it('a merge of wakes whose messages share an id in two channels answers no one message: its refusal marks nothing', async (t) => {
    const r = await rig(t);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new HeldStream(released, [answer('answer to m-a')]));
    await r.incoming(ROOM, 'm-a');
    await eventually(() => r.f.membrane.calls.length === 1, 'the turn for m-a, held');
    (r.fw as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'refusal-rewind-retry', source: 'framework', timestamp: Date.now(),
      channelId: ROOM, channelServerId: 'editor', answersMessageId: 'm-same',
    });
    await r.incoming(GENERAL, 'm-same');
    await eventually(() => r.fw.deferredMessages.length === 1, 'general\'s m-same deferred behind the live turn');
    r.streams.push(() => new MockYieldingStream([refusal()]));
    release();
    await eventually(() => r.records.length === 1, 'the merged turn, refused');
    await r.markSent();
    assert.deepEqual(r.marked(), []);
    assert.equal(r.records[0]!.locus, GENERAL);
  });

  it('a conversation fork\'s refused turn marks its own channel\'s message, though another fork took a message after it', async (t) => {
    const r = await rig(t, { framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new HeldStream(released, [refusal()]), () => new MockYieldingStream([answer('answer to m-g')]));
    await r.incoming(ROOM, 'm-room');
    await eventually(() => r.f.membrane.calls.length === 1, 'the room fork\'s turn, held');
    await r.incoming(GENERAL, 'm-g');
    await eventually(() => r.f.published.some((p) => JSON.stringify(p).includes('answer to m-g')), 'the general fork\'s answer');
    release();
    await eventually(() => r.records.length === 1 && r.marks.length === 1, 'the room fork\'s refusal, recorded and marked');
    assert.deepEqual(r.marked(), [['add_reaction', 'room', 'm-room']]);
    assert.equal(r.records[0]!.locus, ROOM);
  });

  it('a fork\'s two messages that wait out a quiesce wake one turn that answers no one message: its refusal marks nothing', async (t) => {
    const r = await rig(t, { framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new HeldStream(released, [answer('answer to m-0')]), () => new MockYieldingStream([refusal()]));
    await r.incoming(ROOM, 'm-0');
    await eventually(() => r.f.membrane.calls.length === 1, 'the fork\'s turn for m-0, held');
    await r.incoming(ROOM, 'm-1');
    await r.incoming(ROOM, 'm-2');
    const quiesced = r.f.framework.quiesce({ reason: 'test window' });
    release();
    await quiesced;
    await r.f.framework.resume();
    await eventually(() => r.records.length === 1, 'the resumed turn, refused');
    await r.markSent();
    assert.deepEqual(r.marked(), []);
    assert.equal(r.records[0]!.locus, ROOM);
  });

  it('every resident a message wakes marks that message when its turn is refused', async (t) => {
    const r = await rig(t, { agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }, { name: 'second', model: 'test', systemPrompt: 'test' }] });
    r.streams.push(() => new MockYieldingStream([refusal()]), () => new MockYieldingStream([refusal()]));
    await r.incoming(ROOM, 'm-room');
    await eventually(() => r.records.length === 2 && r.marks.length === 2, 'both residents\' refusals, recorded and marked');
    assert.deepEqual(r.records.map((record) => record.agent).sort(), ['agent', 'second']);
    assert.deepEqual(r.marked(), [['add_reaction', 'room', 'm-room'], ['add_reaction', 'room', 'm-room']]);
  });

  it('a turn refused when its retry runs after a provider\'s stated wait marks the message the turn opened for', async (t) => {
    const r = await rig(t);
    r.streams.push(() => new FailedCall('rate-limit'), () => new MockYieldingStream([refusal()]));
    await r.incoming(ROOM, 'm-room');
    await eventually(() => r.records.length === 1 && r.marks.length === 1, 'the retry, refused and marked');
    assert.equal(r.f.membrane.calls.length, 2, 'one call failed into the wait, and its retry was refused');
    assert.deepEqual(r.marked(), [['add_reaction', 'room', 'm-room']]);
    assert.equal(r.records[0]!.locus, ROOM);
  });

  it('control: an addressed message in an open channel, refused, is marked on itself', async (t) => {
    const r = await rig(t);
    r.streams.push(() => new MockYieldingStream([refusal()]));
    await r.incoming(ROOM, 'm-room');
    await eventually(() => r.records.length === 1 && r.marks.length === 1, 'the refusal, recorded and marked');
    assert.deepEqual(r.marked(), [['add_reaction', 'room', 'm-room']]);
    assert.equal(r.records[0]!.locus, ROOM);
  });
});

describe('the retry a rewind queues answers the message the shed turn answered', () => {
  const rewinding = { agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', refusalHandling: { retries: 0, autoRewind: true, maxRewinds: 1 } }], framework: { gate: QUIET_AMBIENT } as never };

  it('a refusal rewind\'s retry speaks in the refused message\'s channel', async (t) => {
    const r = await rig(t, rewinding);
    await r.answered(ROOM, 'm-1');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new MockYieldingStream([refusal()]), () => new HeldStream(released, [answer('the answer after the rewind')]));
    await r.incoming(ROOM, 'm-2');
    await eventually(() => r.records.length === 1 && r.f.membrane.calls.length === 3, 'the refusal, and its retry held');
    await r.incoming(GENERAL, 'm-c', ['chat:ambient', 'chat:from-human']);
    await eventually(() => r.fw.deferredMessages.length === 1, 'm-c deferred behind the retry');
    release();
    await eventually(() => r.f.published.some((p) => JSON.stringify(p).includes('the answer after the rewind')), 'the retry\'s answer published');
    const post = r.f.published.find((p) => JSON.stringify(p).includes('the answer after the rewind'));
    assert.equal(post?.channelId, ROOM);
  });

  it('a refusal rewind\'s retry, refused again, marks the refused message, though an ambient message came meanwhile', async (t) => {
    const r = await rig(t, rewinding);
    await r.answered(ROOM, 'm-1');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new MockYieldingStream([refusal()]), () => new HeldStream(released, [refusal()]));
    await r.incoming(ROOM, 'm-2');
    await eventually(() => r.records.length === 1 && r.f.membrane.calls.length === 3, 'the first refusal, and its retry held');
    await r.incoming(GENERAL, 'm-c', ['chat:ambient', 'chat:from-human']);
    await eventually(() => r.fw.deferredMessages.length === 1, 'm-c deferred behind the retry');
    release();
    await eventually(() => r.records.length === 2 && r.marks.length === 1, 'the retry, refused and marked');
    assert.deepEqual(r.marked(), [['add_reaction', 'room', 'm-2']]);
    assert.equal(r.records[1]!.locus, ROOM);
  });

  it('the poison-history breaker\'s retry speaks in the failed message\'s channel', async (t) => {
    const r = await rig(t, { framework: { gate: QUIET_AMBIENT } as never });
    await r.answered(ROOM, 'm-1');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    r.streams.push(() => new FailedCall(), () => new FailedCall(), () => new FailedCall(),
      () => new HeldStream(released, [answer('the answer after the breaker')]));
    for (const id of ['m-2', 'm-3']) {
      const before = r.f.membrane.calls.length;
      await r.incoming(ROOM, id);
      await eventually(() => r.f.membrane.calls.length > before, `the failed turn for ${id}`);
      await r.f.framework.runUntilIdle();
    }
    await r.incoming(ROOM, 'm-4');
    await eventually(() => r.f.membrane.calls.length === 5, 'the third failure, and the breaker\'s retry held');
    await r.incoming(GENERAL, 'm-c', ['chat:ambient', 'chat:from-human']);
    await eventually(() => r.fw.deferredMessages.length === 1, 'm-c deferred behind the retry');
    release();
    await eventually(() => r.f.published.some((p) => JSON.stringify(p).includes('the answer after the breaker')), 'the retry\'s answer published');
    const post = r.f.published.find((p) => JSON.stringify(p).includes('the answer after the breaker'));
    assert.equal(post?.channelId, ROOM);
  });
});
