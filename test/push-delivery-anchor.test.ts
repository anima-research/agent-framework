import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';

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

const NO_WAKES = { gate: { config: { policies: [], default: 'defer' }, onboarding: false } } as unknown as Partial<FrameworkConfig>;

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

    const edit = await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-edit', timestamp: TS, origin: origin(ROOM, 'm-room'), tags: ['chat:edited'],
      payload: { content: [{ type: 'text', text: '[message edited] Antra: in room, edited' }] },
    });
    assert.match(JSON.stringify(edit), /"accepted":true/, 'premise: the edit is accepted');
    await f.framework.runUntilIdle();
    assert.ok(f.context().includes('in room, edited'), 'premise: the edit was delivered');
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ADMIN);
  });

  it('under \'latest-inbound\', an ambient push from a closed channel moves neither the fallback locus nor the reply anchor, so a timer\'s turn speaks where it did and opens nothing', async (t) => {
    const { f, fw, origin } = await rig(t, { ...NO_WAKES, speech: { locus: 'latest-inbound' } });
    await f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId: 'm-room', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED, content: [{ type: 'text', text: 'in room' }] }],
    });
    await f.framework.runUntilIdle();
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ROOM, 'premise: the room message is the latest inbound');

    await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-ambient', timestamp: TS, origin: origin(ADMIN, 'm-ambient'), tags: ['chat:ambient', 'chat:from-human'],
      payload: { content: [{ type: 'text', text: 'chatter in admin' }] },
    });
    await f.framework.runUntilIdle();
    assert.ok(f.context().includes('chatter in admin'), 'premise: the ambient push was delivered');
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ROOM);
    assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-room');

    const before = f.published.length;
    (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'agent', reason: 'timer', source: 'test', timestamp: Date.now() });
    await eventually(() => f.published.length > before, "the timer's turn spoke");
    await f.framework.runUntilIdle();
    assert.deepEqual(f.published.slice(before).map((p) => p.channelId), [ROOM], "the timer's turn speaks in the room");
    assert.notEqual(fw.channelRegistry.getDesiredState('editor', ADMIN), 'open', 'and admin stays closed');
  });

  it('under \'latest-inbound\', a push its server tagged with nothing counts, as a message no tag calls ambient', async (t) => {
    const { f, fw, origin } = await rig(t, { ...NO_WAKES, speech: { locus: 'latest-inbound' } });
    await f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId: 'm-room', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED, content: [{ type: 'text', text: 'in room' }] }],
    });
    await f.framework.runUntilIdle();
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ROOM, 'premise: the room message is the latest inbound');

    await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-untagged', timestamp: TS, origin: origin(ADMIN, 'm-untagged'),
      payload: { content: [{ type: 'text', text: 'untagged in admin' }] },
    });
    await f.framework.runUntilIdle();
    assert.equal(fw.channelRegistry.resolveLocus('agent')?.channelId, ADMIN);
    assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-untagged');
  });

  it('a push its server was removed before it was processed sets nothing: one queued behind a slow module while its server disconnects', async (t) => {
    let reached = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow: Module = {
      name: 'slow',
      async start(_ctx: ModuleContext) {},
      async stop() {},
      getTools(): ToolDefinition[] { return []; },
      async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: '' }; },
      async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
        if (event.type === 'mcpl:channel-incoming' && (event as unknown as { messageId?: string }).messageId === 'm-room') { reached = true; await held; }
        return {};
      },
    };
    const { f, fw, origin } = await rig(t, { ...NO_WAKES, modules: [slow], speech: { locus: 'latest-inbound' } } as Partial<FrameworkConfig>);
    const servers = (f.framework as unknown as { mcplServerRegistry: { getServer(id: string): unknown } }).mcplServerRegistry;
    await f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId: 'm-room', timestamp: TS, author: { id: 'U1', name: 'Antra' }, tags: ADDRESSED, content: [{ type: 'text', text: 'in room' }] }],
    });
    await eventually(() => reached, 'the slow module holds the loop on the room message');
    try {
      await f.send('push/event', {
        featureSet: 'doc', eventId: 'e-admin', timestamp: TS, origin: origin(ADMIN, 'm-admin'), tags: ADDRESSED,
        payload: { content: [{ type: 'text', text: '@agent in admin' }] },
      });
      await f.framework.disconnectMcplServer('editor');
      assert.equal(servers.getServer('editor'), null, 'premise: the server is removed while its push waits');
      assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, undefined, 'premise: the removal cleared its message');
    } finally {
      release();
    }
    await f.framework.runUntilIdle();
    assert.ok(f.context().includes('@agent in admin'), 'premise: the push was processed after the removal');
    assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, undefined, 'and its message did not become the latest inbound');
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
      assert.equal(fw.parkedAnchors.size, 1, 'premise: the older message\'s anchor is parked');
      await newer(f);
      await f.framework.runUntilIdle();
      assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-newer', 'premise: the newer message is the latest inbound');
      const resent = await f.send(method, params);
      assert.match(JSON.stringify(resent), /"accepted":true/, 'premise: the resend is accepted');
      assert.equal(fw.parkedAnchors.size, 0, 'premise: its acceptance took the parked anchor');
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
      assert.equal(fw.parkedAnchors.size, 1, 'premise: the older message\'s anchor is parked');
      await newer(f);
      await f.framework.runUntilIdle();
      assert.equal(fw.channelRegistry.incomingFor('agent')?.messageId, 'm-newer', 'premise: the newer message is the latest inbound while the older commit is held');
      release();
      assert.match(JSON.stringify(await sent), /"accepted":true/, 'premise: the create is accepted');
      assert.equal(fw.parkedAnchors.size, 0, 'premise: its acceptance took the parked anchor');
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
    const reply = await f.send('push/event', {
      featureSet: 'doc', eventId: 'e-unnamed', timestamp: TS, origin: unnamed, tags: ADDRESSED,
      coalesce: { key: 'notice:1', initial: true, channelId: ADMIN },
      payload: { content: [{ type: 'text', text: 'a push that names no message' }] },
    });
    assert.match(JSON.stringify(reply), /"accepted":true/, 'premise: the push is accepted');
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
    assert.match(JSON.stringify(await f.send('push/event', deferred)), /"accepted":true/, 'premise: the deferred create is accepted');
    await eventually(() => f.renders.length === 1, 'the deferred create rendered at assembly');
    await f.framework.runUntilIdle();
    assert.ok(f.context().includes('document_diff'), 'premise: the rendered create was delivered');
    assert.match(JSON.stringify(await f.send('push/event', deferred)), /"accepted":true/, 'premise: the resend is accepted');
    const incoming = fw.channelRegistry.incomingFor('agent');
    assert.deepEqual(incoming && { channelId: incoming.channel.channelId, messageId: incoming.messageId }, { channelId: ROOM, messageId: 'm-room' });
  });
});
