import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';

const ROOM = 'discord:g1:room';
const ADMIN = 'discord:g1:admin';
const ADDRESSED = ['chat:mention', 'chat:addressed', 'chat:from-human'];

type Ref = { serverId: string; channelId: string };
type Internals = {
  parkedAnchors: Map<string, unknown>;
  channelRegistry: {
    getDesiredState(serverId: string, channelId: string): string | undefined;
    incomingFor(agentName?: string): { channel: Ref; messageId: string; threadId?: string } | undefined;
    resolveLocus(conversationId: string): Ref | null;
  };
};

async function rig(t: TestContext, framework: Partial<FrameworkConfig>) {
  const f = await fixture({ framework });
  t.after(f.close);
  f.alwaysRespond();
  f.framework.start();
  const fw = f.framework as unknown as Internals;
  await f.send('channels/register', {
    channels: [
      { id: ROOM, type: 'discord', label: 'room', initiallyOpen: true },
      { id: ADMIN, type: 'discord', label: 'admin', initiallyOpen: false },
    ],
  });
  await eventually(() => fw.channelRegistry.getDesiredState('editor', ROOM) === 'open', 'room is open');
  const origin = (channelId: string, messageId: string) => ({
    source: 'discord', mcplChannelId: channelId, channelId: channelId.split(':').pop(), guildId: 'g1', messageId, authorId: 'U1', authorName: 'Antra',
  });
  return { f, fw, origin };
}

const NO_WAKES = { gate: { config: { policies: [], default: 'defer' } } } as unknown as Partial<FrameworkConfig>;

describe('a push that delivers a new message becomes the latest delivered inbound', () => {
  it('under \'latest-inbound\', a mention pushed from a closed channel moves the fallback locus and the reply anchor, thread included, and an edit pushed after it doesn\'t', async (t) => {
    const { f, fw, origin } = await rig(t, { ...NO_WAKES, speech: { locus: 'latest-inbound' } });
    await f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId: 'm-room', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED, content: [{ type: 'text', text: 'in room' }] }],
    });
    await f.framework.runUntilIdle();
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ROOM, 'premise: the room message is the latest inbound');

    await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-admin', timestamp: TS, origin: { ...origin(ADMIN, 'm-admin'), threadId: 't-admin' }, tags: ADDRESSED,
      payload: { content: [{ type: 'text', text: '@agent in admin' }] },
    });
    await f.framework.runUntilIdle();
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ADMIN);
    const incoming = fw.channelRegistry.incomingFor('agent');
    assert.deepEqual(incoming && { messageId: incoming.messageId, threadId: incoming.threadId }, { messageId: 'm-admin', threadId: 't-admin' });

    await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-edit', timestamp: TS, origin: origin(ROOM, 'm-room'), tags: ['chat:edited'],
      payload: { content: [{ type: 'text', text: '[message edited] Antra: in room, edited' }] },
    });
    await f.framework.runUntilIdle();
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ADMIN);
  });

  it('a channel-scoped coalesced create from a closed channel is the latest inbound once accepted, and nothing stays parked', async (t) => {
    const { f, fw, origin } = await rig(t, NO_WAKES);
    await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-admin', timestamp: TS, origin: origin(ADMIN, 'm-admin'), tags: ADDRESSED,
      coalesce: { key: 'message:m-admin', initial: true, channelId: ADMIN },
      payload: { content: [{ type: 'text', text: '@agent in admin' }] },
    });
    const incoming = fw.channelRegistry.incomingFor('agent');
    assert.deepEqual(incoming && { channelId: incoming.channel.channelId, messageId: incoming.messageId }, { channelId: ADMIN, messageId: 'm-admin' });
    assert.equal(fw.parkedAnchors.size, 0);
  });

  for (const lane of ['push', 'channel'] as const) {
    const coalescedCreate = (origin: (channelId: string, messageId: string) => Record<string, unknown>) => lane === 'push'
      ? ['push/event', {
        featureSet: 'doc', eventId: 'e-older', timestamp: TS, origin: origin(ADMIN, 'm-older'), tags: ADDRESSED,
        coalesce: { key: 'message:m-older', initial: true, channelId: ADMIN },
        payload: { content: [{ type: 'text', text: '@agent the older message' }] },
      }] as const
      : ['channels/incoming', {
        messages: [{
          channelId: ROOM, messageId: 'm-older', eventId: 'e-older', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED,
          content: [{ type: 'text', text: 'the older message' }], coalesce: { key: 'message:m-older', initial: true },
        }],
      }] as const;
    const newer = (f: Awaited<ReturnType<typeof rig>>['f']) => f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId: 'm-newer', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED, content: [{ type: 'text', text: 'the newer message' }] }],
    });
    type Host = { pushCoalescer: { host: { commit(): Promise<void> } } };

    it(`on the ${lane} lane, a coalesced create resent after a failed acknowledgement doesn't displace a message delivered since`, async (t) => {
      const { f, fw, origin } = await rig(t, NO_WAKES);
      const host = (fw as unknown as Host).pushCoalescer.host;
      const commit = host.commit.bind(host);
      let failOnce = true;
      host.commit = async () => { if (failOnce) { failOnce = false; throw new Error('this commit fails once'); } return commit(); };
      const [method, params] = coalescedCreate(origin);
      const first = await f.send(method, params);
      assert.match(JSON.stringify(first), /durable/, 'premise: the first acceptance failed');
      await newer(f);
      await f.framework.runUntilIdle();
      assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-newer', 'premise: the newer message is the latest inbound');
      await f.send(method, params);
      assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-newer');
    });

    it(`on the ${lane} lane, a message delivered while a coalesced create waits for its commit stays the latest inbound`, async (t) => {
      const { f, fw, origin } = await rig(t, NO_WAKES);
      const host = (fw as unknown as Host).pushCoalescer.host;
      const commit = host.commit.bind(host);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let holdOnce = true;
      let holding = false;
      host.commit = async () => { if (holdOnce) { holdOnce = false; holding = true; await held; } return commit(); };
      const [method, params] = coalescedCreate(origin);
      const sent = f.send(method, params);
      await eventually(() => holding, 'the create delivered, its commit held');
      await newer(f);
      await f.framework.runUntilIdle();
      release();
      await sent;
      assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-newer');
    });
  }

  it('a channel-scoped coalesced push that names no message leaves the latest inbound where it was', async (t) => {
    const { f, fw, origin } = await rig(t, NO_WAKES);
    await f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId: 'm-room', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED, content: [{ type: 'text', text: 'in room' }] }],
    });
    await f.framework.runUntilIdle();
    const { messageId: _none, ...unnamed } = origin(ADMIN, 'unused');
    await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-unnamed', timestamp: TS, origin: unnamed, tags: ADDRESSED,
      coalesce: { key: 'notice:1', initial: true, channelId: ADMIN },
      payload: { content: [{ type: 'text', text: 'a push that names no message' }] },
    });
    await f.framework.runUntilIdle();
    assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-room');
  });

  it('a deferred create, acknowledged and rendered, then resent with the same eventId, leaves the latest inbound where it was', async (t) => {
    const { f, fw, origin } = await rig(t, {});
    await f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId: 'm-room', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED, content: [{ type: 'text', text: 'in room' }] }],
    });
    await f.framework.runUntilIdle();
    const deferred = {
      featureSet: 'doc', eventId: 'e-deferred', timestamp: TS, origin: origin(ADMIN, 'm-deferred'), tags: ADDRESSED,
      coalesce: { key: 'message:m-deferred', initial: true, deferred: true, channelId: ADMIN },
      payload: { content: [{ type: 'text', text: '@agent a deferred message' }] },
    };
    await f.send('push/event', deferred);
    await eventually(() => f.renders.length === 1, 'the deferred create rendered at assembly');
    await f.framework.runUntilIdle();
    await f.send('push/event', deferred);
    const incoming = fw.channelRegistry.incomingFor('agent');
    assert.deepEqual(incoming && { channelId: incoming.channel.channelId, messageId: incoming.messageId }, { channelId: ROOM, messageId: 'm-room' });
  });
});
