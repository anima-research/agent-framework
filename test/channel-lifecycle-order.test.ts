import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelDescriptor, ChannelIncomingMessage, ChannelsOpenResult } from '../src/mcpl/types.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function descriptor(id = 'x', initiallyOpen = false, address = 'original'): ChannelDescriptor {
  return { id, type: 'test', label: id, direction: 'bidirectional', initiallyOpen, address: { value: address } };
}

type RegistryOptions = NonNullable<ConstructorParameters<typeof ChannelRegistry>[4]>;
type NoticeHandler = NonNullable<RegistryOptions['onChannelAutoOpened']>;

/** A tool result's data, as the channel tools shape it. */
const dataOf = (result: { data?: unknown }) => (result.data ?? {}) as { status?: string; closeError?: string };
/** Why words aren't sent where the fixture's connected server's grant lacks channels.publish. */
const NOT_PERMITTED_TO_POST = 'this host isn\'t permitted to post to the "test" server\'s channels, and trying again won\'t ' +
  'change that; if you need it, ask whoever runs this host';

function message(channelId = 'x', messageId = 'm1'): ChannelIncomingMessage {
  return {
    channelId, messageId, author: { id: 'u1', name: 'someone' },
    timestamp: '2026-10-11T00:00:00Z', content: [{ type: 'text', text: 'hello' }],
  };
}

function fixture(onNotice?: NoticeHandler, store?: JsStore, coalesce?: RegistryOptions['handleCoalescedIncoming']) {
  const actual = new Map<string, boolean>();
  const calls: Array<{ kind: 'open' | 'close'; id: string; address?: unknown }> = [];
  const pending: Array<{ finish: () => void; fail: (err?: Error) => void }> = [];
  const held = new Set<string>();
  const publishedWhileOpen: boolean[] = [];
  const notices: Array<{ source: string; channels: Array<{ channelId: string; label?: string }> }> = [];
  const routeFailures: Array<{ reason: string }> = [];
  // A server that answers an open for another channel, by requested id.
  const answeredFor = new Map<string, string>();
  // The direction an open's answer declares, by the address the open was
  // sent to; an address not here declares the descriptor's own.
  const declares = new Map<string, ChannelDescriptor['direction']>();
  const serve = (kind: 'open' | 'close', params: { channelId?: string; address?: unknown }) => {
    const id = params.channelId!;
    calls.push({ kind, id, address: params.address });
    return new Promise<any>((resolve, reject) => {
      const finish = () => {
        const target = kind === 'open' ? answeredFor.get(id) ?? id : id;
        actual.set(target, kind === 'open');
        const declared = declares.get(String((params.address as { value?: unknown } | undefined)?.value));
        resolve(kind === 'open'
          ? { channel: { ...descriptor(target), ...(declared ? { direction: declared } : {}) } }
          : { closed: true });
      };
      if (held.has(id)) pending.push({ finish, fail: (err?: Error) => reject(err ?? new Error('fixture lifecycle failure')) });
      else finish();
    });
  };
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: (params: { channelId?: string; address?: unknown }) => serve('open', params) as Promise<ChannelsOpenResult>,
    sendChannelsClose: (params: { channelId: string }) => serve('close', params),
    sendChannelsPublish: async (params: { channelId: string }) => {
      publishedWhileOpen.push(actual.get(params.channelId) === true);
      return { delivered: true };
    },
  };
  let currentServer = server;
  const replaceServer = () => { currentServer = { ...server }; };
  const setGrant = (paths: readonly string[]) => { currentServer.grant = new CapabilityGrant(new Set(paths), []); };
  const traces: Array<{ type: string; [key: string]: unknown }> = [];
  const registry = new ChannelRegistry(
    { getServer: () => currentServer } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, (event) => traces.push(event),
    { store, onRouteFailure: (info) => routeFailures.push(info),
      onChannelAutoOpened: (info) => { notices.push(info); onNotice?.(info); },
      ...(coalesce ? { handleCoalescedIncoming: coalesce } : {}) },
  );
  const isOpen = (id = 'x') => registry.getOpenChannels().some((e) => e.descriptor.id === id);
  const tool = (kind: 'open' | 'close') => registry.handleChannelToolCall('channel_' + kind, { serverId: 'test', channelId: 'x' });
  // A machine's close, as subscription-gc makes it: no decision the agent's
  // speech holds to, so speech opens the channel again (speechOpens), where
  // the agent's own close (tool('close')) stands against it.
  const machineClose = () => registry.handleChannelToolCall('channel_close',
    { serverId: 'test', channelId: 'x', source: 'subscription-gc', overrideExplicitOpen: true },
    { kind: 'module', moduleName: 'subscription-gc' });
  // An out-of-order server serves the most recently received operation first.
  // The fixed host should never have two in flight for this channel.
  const drain = async (...work: Promise<unknown>[]) => {
    let settled = false;
    const result = Promise.all(work).finally(() => { settled = true; });
    for (let i = 0; i < 100 && !settled; i++) {
      await tick();
      pending.pop()?.finish();
    }
    assert.equal(settled, true, 'lifecycle operations must settle');
    await result;
  };
  return { registry, actual, calls, pending, held, traces, isOpen, tool, machineClose, drain, publishedWhileOpen, notices, routeFailures, replaceServer, answeredFor, declares, setGrant };
}

test('remove/re-add during reconcile converges on the replacement desired state, with ACK first (#185)', async () => {
  const f = fixture();
  f.held.add('x');
  const first = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  assert.equal(f.pending.length, 1);
  let acknowledged = false;
  const replacement = f.registry.handleChanged('test', {
    removed: ['x'], added: [descriptor('x', true, 'replacement')],
  }, { respond: () => { acknowledged = true; } });
  assert.equal(acknowledged, true, 'registration ACK must not wait for the lifecycle queue');
  await tick();
  assert.equal(f.pending.length, 1, 'the replacement waits for the operation in flight: one RPC per channel at a time');
  await f.drain(first, replacement);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open');
  assert.equal(f.isOpen(), true);
  assert.equal(f.actual.get('x'), true, 'older close must not be the last server-side operation');
  assert.deepEqual(f.calls.filter((c) => c.kind === 'open').at(-1)?.address, { value: 'replacement' });
});

test('explicit open racing a default-close reconcile uses the latest intent', async () => {
  const f = fixture();
  f.held.add('x');
  const reconcile = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  const opened = f.tool('open');
  await f.drain(reconcile, opened);
  assert.equal((await opened).success, true);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open');
  assert.equal(f.isOpen(), true);
  assert.equal(f.actual.get('x'), true);
});

for (const firstKind of ['open', 'close'] as const) {
  test('overlapping explicit ' + firstKind + ' then opposite intent leaves the newest decision in force', async () => {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', firstKind === 'close')] });
    f.held.add('x');
    const first = f.tool(firstKind);
    await tick();
    const lastKind = firstKind === 'open' ? 'close' : 'open';
    const last = f.tool(lastKind);
    await f.drain(first, last);
    assert.equal((await first).success, false);
    assert.equal((await first).error, firstKind === 'open'
      ? 'Channel "x": a later decision to close it came first, so this open doesn\'t stand. Call channel_open again to open it.'
      : 'Channel "x": a later decision to keep it open came first, so this close doesn\'t stand. Call channel_close again to ' +
        'close it.');
    assert.doesNotMatch(String((await first).error), /is recorded|stays recorded/, 'a newer decision replaced it');
    assert.equal((await last).success, true);
    const desired = lastKind === 'open';
    assert.equal(f.registry.getDesiredState('test', 'x'), lastKind === 'open' ? 'open' : 'closed');
    assert.equal(f.isOpen(), desired);
    assert.equal(f.actual.get('x'), desired);
  });
}

test('an already-closed shortcut waits for pending transport work', async () => {
  const f = fixture();
  f.actual.set('x', true);
  f.held.add('x');
  const reconcile = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  let closeSettled = false;
  const close = f.tool('close').then((result) => { closeSettled = true; return result; });
  await tick();
  assert.equal(closeSettled, false, 'entry.open is provisional while a lifecycle RPC is pending');
  await f.drain(reconcile, close);
  assert.equal((await close).success, true);
  assert.equal(f.actual.get('x'), false);
});

test('removal cancels queued work rather than recreating or mutating an unregistered channel', async () => {
  const f = fixture();
  f.held.add('x');
  const reconcile = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  const open = f.tool('open');
  await f.registry.handleChanged('test', { removed: ['x'] });
  await f.drain(reconcile, open);
  assert.equal((await open).success, false);
  assert.equal(f.registry.listChannelsRaw().length, 0);
  assert.equal(f.calls.filter((c) => c.kind === 'open').length, 0);
  assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-reconcile-failed').length, 0,
    'removal while queued is cancellation, not a failed subscription');
});

test('a failed operation releases the queue for a later decision', async () => {
  const f = fixture();
  f.held.add('x');
  const reconcile = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  const open = f.tool('open');
  f.pending.shift()!.fail();
  await f.drain(reconcile, open);
  assert.equal((await open).success, true);
  assert.equal(f.actual.get('x'), true);
  assert.equal(f.isOpen(), true);
  assert.ok(f.traces.some((e) => e.type === 'mcpl:channel-reconcile-failed'));
});

test('a blocked channel does not delay another channel lifecycle or its ACK', async () => {
  const f = fixture();
  f.held.add('x');
  const blocked = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  let acknowledged = false;
  await f.registry.handleChanged('test', { added: [descriptor('y', true)] }, {
    respond: () => { acknowledged = true; },
  });
  assert.equal(acknowledged, true);
  assert.equal(f.actual.get('y'), true);
  assert.equal(f.pending.length, 1);
  await f.drain(blocked);
});

test('descriptor updates during an open refresh its target, but labels alone do not reopen', async () => {
  for (const changesAddress of [false, true]) {
    const f = fixture();
    f.held.add('x');
    const opening = f.registry.handleChanged('test', { added: [descriptor('x', true)] });
    await tick();
    await f.registry.handleChanged('test', {
      updated: [{ ...descriptor('x', true, changesAddress ? 'new-target' : 'original'), label: 'new label' }],
    });
    await f.drain(opening);
    assert.equal(f.calls.length, changesAddress ? 2 : 1);
    assert.deepEqual(f.calls.at(-1)?.address, { value: changesAddress ? 'new-target' : 'original' });
    assert.equal(f.isOpen(), true);
  }
});

for (const delivery of ['speech', 'reply'] as const) {
  test(delivery + ' during pending transport work preserves the newer tune-out epoch', async () => {
    // Felix's review reproduction: merely waiting for transport must not
    // turn a delivery into a decision to cancel attention diversion.
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
    f.calls.length = 0;
    f.held.add('x');
    const close = f.tool('close');
    await tick();
    f.registry.enterTuneOut('test', 'x', {
      epochId: 'new-epoch', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
    }, 'agent-tool');
    // The close in flight converges on the tune-out by opening again, and the
    // delivery joins it: the channel was already decided open, so a reply
    // reports it already open, and nothing sends a third RPC.
    const sent = delivery === 'speech'
      ? f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }).then((result) => result?.delivered === true)
      : f.registry.openIfClosedForSend('x', 'test').then((result) => result.status === 'already-open');
    await f.drain(close, sent);
    assert.equal(await sent, true);
    assert.deepEqual(f.calls.map((c) => c.kind), ['close', 'open']);
    assert.equal(f.registry.getTuneOutState('test', 'x')?.params.epochId, 'new-epoch');
    assert.equal(f.actual.get('x'), true);
    if (delivery === 'speech') assert.deepEqual(f.publishedWhileOpen, [true]);
    assert.equal((await f.tool('open')).success, false, 'explicit channel_open still requires tune-out cancellation');
    assert.equal(f.registry.getTuneOutState('test', 'x')?.params.epochId, 'new-epoch');
  });
}

test('automatic opening accepts a newer tune-out established during its RPC without clearing it', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  f.held.add('x');
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  await tick();
  f.registry.enterTuneOut('test', 'x', {
    epochId: 'mid-open-epoch', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
  }, 'agent-tool');
  await f.drain(speech);
  assert.equal((await speech)?.delivered, true);
  assert.equal(f.registry.getTuneOutState('test', 'x')?.params.epochId, 'mid-open-epoch');
  assert.deepEqual(f.publishedWhileOpen, [true]);
});

test('a failed backscroll open preserves an already-live subscription', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.calls.length = 0;
  f.held.add('x');
  const backscroll = f.registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: 'x', backscroll: 5 });
  await tick();
  f.pending.shift()!.fail();
  assert.equal((await backscroll).success, false);
  assert.equal((await backscroll).error,
    'Channel "x" is open, but the history you asked for didn\'t come: fixture lifecycle failure. ' +
    'Calling channel_open again with backscroll tries once more.', 'the channel is still open');
  assert.equal(f.isOpen(), true, 'a failed redundant open is not a confirmed close');
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  await f.drain(speech);
  assert.equal((await speech)?.delivered, true);
  assert.equal(f.calls.length, 1, 'delivery must not need another open after a failed backscroll');
  assert.deepEqual(f.publishedWhileOpen, [true]);
});

test('speech does not replace a pending explicit close with a new open decision', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const close = f.tool('close');
  await tick();
  const speech = f.registry.routeSpeech('resident', 'tail of the turn', { serverId: 'test', channelId: 'x' });
  await f.drain(close, speech);
  assert.equal((await close).success, true);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
  assert.equal(f.actual.get('x'), false);
  assert.equal(f.isOpen(), false);
  assert.equal(f.notices.length, 0);
});

test("a draft published into a channel with a machine's close pending waits for it and posts nothing, as speech does", async () => {
  // Drafts publish through the same open step as routed speech, so they meet
  // the channel's queued lifecycle work as speech and replies do.
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const close = f.machineClose();
  await tick();
  const draft = f.registry.publish('resident', 'a draft', { serverId: 'test', channelId: 'x' });
  await f.drain(close, draft);
  assert.equal((await close).success, true);
  const outcome = await draft;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'a decision to close the channel came before these words went out');
  assert.deepEqual(outcome.destination, { serverId: 'test', channelId: 'x', label: 'x' });
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
  assert.equal(f.isOpen(), false);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  assert.equal(f.notices.length, 0);
});

test('a channel declared inbound-only while a publish waits for its lifecycle work is refused, and nothing is published', async () => {
  // A publish that finds the channel's lifecycle work queued waits for it.
  // A channels/changed during that wait can declare the channel
  // inbound-only, so the publish checks the channel again after the wait,
  // just before it publishes, and refuses it there.
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  f.held.add('x');
  const open = f.tool('open');
  await tick();
  const draft = f.registry.publish('resident', 'a draft', { serverId: 'test', channelId: 'x' });
  await tick();
  await f.registry.handleChanged('test', { updated: [{ ...descriptor('x'), direction: 'inbound' }] });
  await f.drain(open, draft);
  assert.equal((await open).success, true);
  const outcome = await draft;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /^inbound-only: server "test" declared this channel's direction "inbound"/);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  assert.equal(f.isOpen(), true, 'the open the agent asked for stands');
});

for (const change of ['announced again as inbound-only', 'removed'] as const) {
  test(`a channel ${change} while its opening is announced is refused, and nothing is published`, async () => {
    // The notice of an opening runs after the open and before the publish. A
    // channels/changed there can replace the channel's entry or remove it,
    // so the check before the publish reads the channel's current entry, not
    // the one the open returned.
    let announced: Promise<unknown> | undefined;
    let f!: ReturnType<typeof fixture>;
    f = fixture(() => {
      announced = f.registry.handleChanged('test', change === 'removed'
        ? { removed: ['x'] }
        : { added: [{ ...descriptor('x'), direction: 'inbound' }] });
    });
    await f.registry.handleChanged('test', { added: [descriptor('x')] });
    assert.equal(await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }), null);
    assert.equal(f.notices.length, 1, 'the opening was announced');
    assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
    assert.match(f.routeFailures[0]?.reason ?? '', change === 'removed'
      ? /^the channel was removed before these words went out$/
      : /^inbound-only: server "test" declared this channel's direction "inbound"/);
    await announced;
  });
}

for (const answer of ['opens', 'fails'] as const) {
  test(`a channel registered again while its opening is announced takes the words only once its new registration's open ${answer === 'opens' ? 'succeeds' : 'fails, and then not at all'}`, async () => {
    // A channels/changed during the opening's notice can replace the
    // channel's entry with a fresh registration, which nothing has confirmed
    // open: its reconcile queues the open. The words wait for that work and
    // go out only into the channel it leaves open.
    let announced: Promise<unknown> | undefined;
    let f!: ReturnType<typeof fixture>;
    f = fixture(() => {
      f.held.add('x');
      announced = f.registry.handleChanged('test', { added: [descriptor('x', false, 'replacement')] });
    });
    await f.registry.handleChanged('test', { added: [descriptor('x')] });
    const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(f.notices.length, 1, 'the opening was announced');
    assert.equal(f.pending.length, 1, "the new registration's open is in flight");
    assert.deepEqual(f.publishedWhileOpen, [], 'nothing is published before that open is answered');
    if (answer === 'opens') f.pending.pop()!.finish();
    else f.pending.pop()!.fail();
    const outcome = await speech;
    assert.deepEqual(f.calls.filter((c) => c.kind === 'open').map((c) => c.address), [{ value: 'original' }, { value: 'replacement' }]);
    if (answer === 'opens') {
      assert.equal(outcome?.delivered, true);
      assert.deepEqual(f.publishedWhileOpen, [true]);
      assert.deepEqual(f.routeFailures, []);
    } else {
      assert.equal(outcome, null);
      assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
      assert.equal(f.routeFailures[0]?.reason, "the channel isn't confirmed open: fixture lifecycle failure");
    }
    await announced;
  });
}

test('a channel retargeted while its opening is announced takes the words only once its new target is open', async () => {
  // A retarget keeps the channel's registration but marks it unconfirmed,
  // with an open of the new target queued, so the words wait for that open
  // as they do for a new registration's.
  let announced: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    announced = f.registry.handleChanged('test', { updated: [descriptor('x', false, 'retargeted')] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.pending.length, 1, "the new target's open is in flight");
  assert.equal(f.isOpen('x'), false);
  // The fixture's server keeps the channel open by id through a retarget,
  // so this counts the publishes rather than reading publishedWhileOpen's values.
  assert.equal(f.publishedWhileOpen.length, 0, "nothing is published before the new target's open is answered");
  f.pending.pop()!.finish();
  assert.equal((await speech)?.delivered, true);
  assert.deepEqual(f.calls.filter((c) => c.kind === 'open').map((c) => c.address), [{ value: 'original' }, { value: 'retargeted' }]);
  assert.equal(f.publishedWhileOpen.length, 1);
  await announced;
});

test("a channel retargeted while its opening is announced takes the words as it stands once the agent closes it while they wait", async () => {
  // The check after the open waits for the new target's open. The agent's
  // close decided meanwhile stands against nothing the words need, so they
  // go into the channel as that close leaves it, opening nothing more.
  let announced: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    announced = f.registry.handleChanged('test', { updated: [descriptor('x', false, 'retargeted')] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.pending.length, 1, "the new target's open is in flight");
  assert.equal(f.publishedWhileOpen.length, 0);
  const close = f.tool('close');
  await f.drain(speech, close, announced!);
  assert.equal((await speech)?.delivered, true);
  assert.equal(f.publishedWhileOpen.length, 1, 'the words were published once');
  assert.deepEqual(f.routeFailures, []);
  assert.equal((await close).success, true);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
  assert.equal(f.isOpen('x'), false);
});

test('a channel registered again while the words wait for a new registration takes them only once the newest is open', async () => {
  // The server registers x again while the words wait for the first new
  // registration's open. The words wait through the newer one's open too,
  // and the check after the wait reads the registration that stands.
  let announced: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    announced = f.registry.handleChanged('test', { added: [descriptor('x', false, 'second')] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.pending.length, 1, "the second registration's open is in flight");
  const again = f.registry.handleChanged('test', { added: [descriptor('x', false, 'third')] });
  f.pending.pop()!.finish();
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(f.pending.length >= 1, "the third registration's lifecycle work is in flight");
  assert.equal(f.publishedWhileOpen.length, 0, "nothing is published while it's in flight");
  await f.drain(speech, announced!, again);
  assert.equal((await speech)?.delivered, true);
  const opens = f.calls.filter((c) => c.kind === 'open').map((c) => (c.address as { value: string }).value);
  assert.equal(opens.at(-1), 'third', 'the last open is the newest registration\'s');
  assert.equal(f.publishedWhileOpen.length, 1);
});

test('a grant without channels.publish by the time the words would be published refuses them', async () => {
  // A grant reduced during the opening's notice holds at once (§6.7): the
  // last check reads the grant as it is then.
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => { f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.publish')); });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const outcome = await f.registry.publish('resident', 'words', { serverId: 'test', channelId: 'x' });
  assert.equal(f.notices.length, 1, 'the opening was announced');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, NOT_PERMITTED_TO_POST);
  assert.deepEqual(outcome.destination, { serverId: 'test', channelId: 'x', label: 'x' });
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
});

test('a grant without channels.publish after the words wait for a new registration refuses them', async () => {
  // The grant is read after the wait the last check runs, not only before it.
  let announced: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    announced = f.registry.handleChanged('test', { added: [descriptor('x', false, 'replacement')] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const draft = f.registry.publish('resident', 'words', { serverId: 'test', channelId: 'x' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.pending.length, 1, "the new registration's open is in flight");
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.publish'));
  f.pending.pop()!.finish();
  const outcome = await draft;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, NOT_PERMITTED_TO_POST);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  await announced;
});

test("a machine's close decided while its opening is announced refuses the words, as a close decided while they wait does", async () => {
  // The registration is the one the waits returned and still open, but a
  // close is now decided and queued: the words wait for it and are refused.
  let closing: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    closing = f.machineClose();
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing is published while the close is queued');
  await f.drain(closing!, speech);
  assert.equal(await speech, null);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  assert.equal(f.routeFailures[0]?.reason, 'a decision to close the channel came before these words went out');
  assert.equal(f.isOpen(), false, 'the close stands');
});

test("the agent's own close decided while its opening is announced lets the words go into the channel as that close leaves it", async () => {
  // The agent's close stands against its own speech, so the words don't
  // wait for it to be refused: they go into the channel as it stands.
  let closing: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    closing = f.tool('close');
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  await f.drain(speech);
  assert.equal((await speech)?.delivered, true);
  assert.equal(f.publishedWhileOpen.length, 1, 'the words were published');
  assert.deepEqual(f.routeFailures, []);
  await f.drain(closing!);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
  assert.equal(f.isOpen(), false, 'the close the agent decided stands');
});

test("on a server whose lifecycle this host doesn't direct, a retarget with nothing queued for it takes the words as it stands", async () => {
  // Without channels.lifecycle the host queues no open for a retarget, and
  // opens nothing for speech: the server keeps its channels as it chooses,
  // so the words go to the channel as it stands.
  let announced: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
    announced = f.registry.handleChanged('test', { updated: [descriptor('x', false, 'retargeted')] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const outcome = await f.registry.publish('resident', 'words', { serverId: 'test', channelId: 'x' });
  assert.equal(outcome.status, 'delivered');
  assert.equal(f.publishedWhileOpen.length, 1, 'the words were published');
  assert.deepEqual(f.calls.filter((c) => c.kind === 'open').map((c) => c.address), [{ value: 'original' }], 'no open was queued for the new target');
  await announced;
});

test('a channel registered again and confirmed open by its traffic, once the host no longer directs its lifecycle, takes the words though decided closed', async () => {
  // Without channels.lifecycle a decided close doesn't hold words back from
  // a transport that is open, whichever registration carries it: the new
  // registration's traffic confirms it open, and the words go out.
  let closing: Promise<{ success: boolean }> | undefined;
  let announced: Promise<unknown> | undefined;
  let traffic: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
    closing = f.tool('close');
    announced = f.registry.handleChanged('test', { added: [descriptor('x', false, 'replacement')] });
    traffic = f.registry.handleIncoming('test', { messages: [message()] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const outcome = await f.registry.publish('resident', 'words', { serverId: 'test', channelId: 'x' });
  assert.equal((await closing!).success, false, 'the close is refused for the grant');
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed', 'the refused close is still recorded as a decision');
  assert.equal(outcome.status, 'delivered');
  assert.deepEqual(f.publishedWhileOpen, [true]);
  await announced;
  await traffic;
});

test("a close decided while the words wait, once the host no longer directs the channel's lifecycle, leaves them going into the open transport", async () => {
  // waitForOpenChannel takes a decided close as standing only where the host
  // directs the server's lifecycle, as the last check does.
  let announced: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    announced = f.registry.handleChanged('test', { added: [descriptor('x', false, 'replacement')] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const draft = f.registry.publish('resident', 'words', { serverId: 'test', channelId: 'x' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.pending.length, 1, "the new registration's open is in flight");
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
  const closing = await f.tool('close');
  assert.equal(closing.success, false, 'the close is refused for the grant');
  f.pending.pop()!.finish();
  const outcome = await draft;
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed', 'the refused close is still recorded as a decision');
  assert.equal(outcome.status, 'delivered');
  assert.deepEqual(f.publishedWhileOpen, [true]);
  await announced;
});

test('a channel registered again as inbound-only while its opening is announced is refused without waiting for its new open', async () => {
  // Nothing would be published into it whatever its open does, so the words
  // don't wait for that open: they're refused for the declaration at once.
  let announced: Promise<unknown> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture(() => {
    f.held.add('x');
    announced = f.registry.handleChanged('test', { added: [{ ...descriptor('x', false, 'replacement'), direction: 'inbound' }] });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.pending.length, 1, "the new registration's open is in flight");
  assert.match(f.routeFailures[0]?.reason ?? '', /^inbound-only: server "test" declared this channel's direction "inbound"/);
  assert.equal(await speech, null);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  f.pending.pop()!.finish();
  await announced;
});

for (const opener of ['tool', 'reconcile'] as const) {
  test(`an open answered after the agent closed the channel during it leaves it closed, and its inbound-only declaration applies (${opener})`, async () => {
    // The close is the newer decision, so the channel ends closed. The answer
    // is still the server's word about the channel, so a later publish is
    // refused before anything opens.
    const f = fixture();
    f.declares.set('original', 'inbound');
    if (opener === 'tool') await f.registry.handleChanged('test', { added: [descriptor('x')] });
    f.held.add('x');
    const opening = opener === 'tool'
      ? f.tool('open')
      : f.registry.handleChanged('test', { added: [descriptor('x', true)] });
    await tick();
    assert.equal(f.pending.length, 1, 'the open is in flight');
    const close = f.tool('close');
    await f.drain(opening, close);
    assert.equal((await close).success, true);
    assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
    assert.equal(f.isOpen(), false);
    assert.equal(f.actual.get('x'), false);
    assert.equal(f.registry.inboundOnlyServer({ serverId: 'test', channelId: 'x' }), 'test', "the late answer's declaration applies");
    const opens = f.calls.filter((c) => c.kind === 'open').length;
    const outcome = await f.registry.publish('resident', 'words', { serverId: 'test', channelId: 'x' });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /^inbound-only: /);
    assert.equal(f.calls.filter((c) => c.kind === 'open').length, opens, 'refused before anything opens');
  });
}

test("an open answered for another channel applies nothing of its answer to the channel opened", async () => {
  // A substitution fails the open before the answer's declaration is read.
  // That is what lets an answer whose channel names no id stand for the
  // channel opened.
  const f = fixture();
  f.answeredFor.set('x', 'y');
  f.declares.set('original', 'inbound');
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  assert.equal((await f.tool('open')).success, false);
  assert.ok(f.traces.some((e) => e.type === 'mcpl:channel-open-substituted' && e.channelId === 'x'),
    'the open reached the server and was answered for another channel');
  assert.equal(f.registry.inboundOnlyServer({ serverId: 'test', channelId: 'x' }), undefined, "the other channel's declaration isn't applied");
});

// An open the server answered for another channel leaves in doubt which
// channel it reaches by this id, and a publish by that id may not reach it
// either. Words that would go into the channel as it stands, with no open to
// check, aren't published while that doubt stands, whenever the agent's
// close came: while that open was out, after it, or with the words waiting
// on the queue behind it. An open answered for this channel ends the doubt.
const answeredElsewhere = /^the "test" server answered this channel's last open for a different channel, so words sent by its id may not reach it; once an open of it is answered for this channel, they go into it again$/;

test("speech whose open was answered for another channel isn't let through by the agent's close made while that open was out", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  f.answeredFor.set('x', 'y');
  f.held.add('x');
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  await tick();
  assert.equal(f.pending.length, 1, "speech's open is in flight");
  const close = f.tool('close');
  await f.drain(speech, close);
  assert.equal((await close).success, true);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed', "the agent's close stands");
  assert.equal(await speech, null);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  assert.match(f.routeFailures[0]?.reason ?? '', answeredElsewhere);
});

test("a channel whose open was answered for another channel takes no words as it stands after the agent's close, until an open is answered for it", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  f.answeredFor.set('x', 'y');
  assert.equal((await f.tool('open')).success, false);
  assert.equal((await f.tool('close')).success, true, "the agent's close, after the open settled");
  assert.equal(await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }), null);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  assert.match(f.routeFailures[0]?.reason ?? '', answeredElsewhere);
  // Once the server answers an open of x for x, words go into it as it stands again.
  f.answeredFor.delete('x');
  assert.equal((await f.tool('open')).success, true);
  assert.equal((await f.tool('close')).success, true);
  assert.equal((await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }))?.delivered, true);
  assert.equal(f.publishedWhileOpen.length, 1);
});

test("speech waiting behind an open answered for another channel, and the agent's close after it, isn't published", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  f.answeredFor.set('x', 'y');
  f.held.add('x');
  const open = f.tool('open');
  await tick();
  assert.equal(f.pending.length, 1, "the agent's open is in flight");
  const close = f.tool('close');
  const speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
  await f.drain(open, close, speech);
  assert.equal((await open).success, false);
  assert.equal((await close).success, true);
  assert.equal(await speech, null);
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
  assert.match(f.routeFailures[0]?.reason ?? '', answeredElsewhere);
});

for (const waits of ["the agent's close", 'their own open'] as const) {
  test(`words for a channel the agent closed aren't let through where convergence never established its target, waiting on ${waits}`, async () => {
    // The work the words wait on is retargeted before each receipt until its
    // tries run out. The agent's close stands, but the server's channel for
    // this id was never established, so the words aren't published into it:
    // waiting on the close, the first wait meets that failure itself; waiting
    // on their own open, which the close overtook, it's the open's cause.
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x')] });
    let close: Promise<{ success: boolean }> | undefined;
    let speech: Promise<unknown>;
    if (waits === "the agent's close") {
      assert.equal((await f.tool('open')).success, true);
      f.held.add('x');
      close = f.tool('close');
      await tick();
      assert.equal(f.pending.length, 1, 'the close is in flight');
      speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
    } else {
      f.held.add('x');
      speech = f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' });
      await tick();
      assert.equal(f.pending.length, 1, "the words' open is in flight");
      close = f.tool('close');
    }
    try {
      for (let i = 0; i < 12 && f.pending.length > 0; i++) {
        await f.registry.handleChanged('test', { updated: [descriptor('x', false, 'churn-' + i)] });
        f.pending.shift()!.finish();
        await tick();
      }
    } finally {
      f.held.delete('x');
      while (f.pending.length > 0) f.pending.shift()!.finish();
    }
    assert.equal(await speech, null);
    assert.deepEqual(f.publishedWhileOpen, [], 'nothing was published');
    assert.match(f.routeFailures[0]?.reason ?? '', /kept changing, and 5 tries didn't settle it/);
    await close;
    assert.equal(f.registry.getDesiredState('test', 'x'), 'closed', "the agent's close stands");
  });
}

test("an open's answer for a target the channel has since left applies nothing; the new target's answer decides", async () => {
  const f = fixture();
  f.declares.set('original', 'inbound');
  f.held.add('x');
  const opening = f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await tick();
  await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'new-target')] });
  await f.drain(opening);
  assert.deepEqual(f.calls.map((c) => c.address), [{ value: 'original' }, { value: 'new-target' }]);
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.inboundOnlyServer({ serverId: 'test', channelId: 'x' }), undefined, "the old target's declaration isn't applied");
});

test('waiting for a backscroll does not issue new opens or auto-open notices for each speech', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.calls.length = 0;
  f.held.add('x');
  const backscroll = f.registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: 'x', backscroll: 5 });
  await tick();
  const speech1 = f.registry.routeSpeech('resident', 'one', { serverId: 'test', channelId: 'x' });
  const speech2 = f.registry.routeSpeech('resident', 'two', { serverId: 'test', channelId: 'x' });
  await f.drain(backscroll, speech1, speech2);
  assert.equal((await speech1)?.delivered, true);
  assert.equal((await speech2)?.delivered, true);
  assert.equal(f.calls.length, 1, 'only the explicit backscroll needs an open RPC');
  assert.equal(f.notices.length, 0, 'waiting is not a closed-to-open transition');
});

for (const delivery of ['speech', 'reply'] as const) {
  test(delivery + ' opening reports the replacement registration label', async () => {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor()] });
    f.held.add('x');
    const opening = delivery === 'speech'
      ? f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' })
      : f.registry.openIfClosedForSend('x', 'test');
    await tick();
    const replacement = f.registry.handleChanged('test', {
      removed: ['x'], added: [{ ...descriptor('x', true, 'replacement'), label: 'Replacement label' }],
    });
    await f.drain(opening, replacement);
    if (delivery === 'speech') {
      assert.equal(f.notices.length, 1);
      assert.equal(f.notices[0].channels[0].label, 'Replacement label');
    } else {
      const result = await opening;
      assert.ok(result && 'label' in result);
      assert.equal(result.label, 'Replacement label');
    }
  });
}

test('policy announces intent before transport rather than a stale open after supersession', async () => {
  const f = fixture();
  f.registry.setSubscriptionPolicy('test', 'auto');
  f.held.add('x');
  const batch = f.registry.handleChanged('test', { added: [descriptor(), descriptor('y')] });
  assert.equal(f.notices.length, 1, 'the decision is announced before transport can stall');
  assert.deepEqual(f.notices[0].channels, [{ channelId: 'x', label: 'x' }, { channelId: 'y', label: 'y' }]);
  await tick();
  const closeY = await f.registry.handleChannelToolCall('channel_close', { serverId: 'test', channelId: 'y' });
  assert.equal(closeY.success, true);
  await f.drain(batch);
  assert.equal(f.registry.getDesiredState('test', 'y'), 'closed');
  assert.equal(f.notices.length, 1, 'no stale confirmation is emitted after the later close');
});

test('a fresh delivery into a channel a machine closed remains a new engagement', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  assert.equal((await f.machineClose()).success, true);
  assert.equal(f.actual.get('x'), false);
  const delivered = await f.registry.routeSpeech('resident', 'a new engagement', { serverId: 'test', channelId: 'x' });
  assert.equal(delivered?.delivered, true);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open');
  assert.equal(f.notices.length, 1);
});

test("a machine's close that completes while delivery joins a backscroll remains authoritative", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const backscroll = f.registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: 'x', backscroll: 5 });
  await tick();
  const speech = f.registry.routeSpeech('resident', 'tail', { serverId: 'test', channelId: 'x' });
  const close = f.machineClose();
  await f.drain(backscroll, speech, close);
  assert.equal((await close).success, true);
  assert.equal(await speech, null);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
  assert.deepEqual(f.publishedWhileOpen, []);
  assert.equal(f.notices.length, 0);
});

test('concurrent delivery into a closed channel shares one opening and one notice', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  f.calls.length = 0;
  f.held.add('x');
  const first = f.registry.routeSpeech('resident', 'one', { serverId: 'test', channelId: 'x' });
  const second = f.registry.routeSpeech('resident', 'two', { serverId: 'test', channelId: 'x' });
  await f.drain(first, second);
  assert.equal((await first)?.delivered, true);
  assert.equal((await second)?.delivered, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.notices.length, 1);
  assert.deepEqual(f.publishedWhileOpen, [true, true]);
});

test('failed policy opening records intent once, with truthful resident text through a retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-intent-notice-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Test.' }],
    modules: [], syncIntervalMs: 0,
  });
  try {
    const recordNotice = (framework as unknown as {
      recordChannelAutoOpenNotice(agent: undefined, serverId: string, channels: Array<{ channelId: string; label?: string }>, cause: 'subscription-policy' | 'opened-by-delivery'): void;
    }).recordChannelAutoOpenNotice.bind(framework);
    const onNotice: NoticeHandler = (info) => recordNotice(undefined, info.serverId, info.channels, info.source);
    const f = fixture(onNotice, framework.getStore());
    f.registry.setSubscriptionPolicy('test', 'auto');
    f.held.add('x');
    const first = f.registry.handleChanged('test', { added: [descriptor()] });
    assert.equal(f.notices.length, 1);
    await tick();
    f.pending.shift()!.fail();
    await first;
    assert.equal(f.isOpen(), false);

    const noticeTexts = () => framework.getAgent('resident')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text' && b.text.startsWith('[channels]'))
      .map((b) => (b as { text: string }).text);
    assert.equal(noticeTexts().length, 1);
    assert.match(noticeTexts()[0], /Selected for opening by subscription policy/);
    assert.match(noticeTexts()[0], /The host opens it, and if that fails, tries again when its server next registers it; channel_list shows whether it's open yet\./);
    assert.doesNotMatch(noticeTexts()[0], /Now open/);

    // The server registers the channel again while the host runs: the host
    // asks it to open the channel again, with no new admission or notice.
    f.held.delete('x');
    await f.registry.handleRegister('test', { channels: [descriptor()] });
    assert.deepEqual(f.calls.filter((c) => c.kind === 'open').map((c) => c.id), ['x', 'x']);
    assert.equal(f.actual.get('x'), true);
    assert.equal(f.isOpen(), true);
    assert.equal(f.notices.length, 1);

    // Reconstruct the registry from the same Chronicle state before retrying.
    // The admission persists even though its first transport attempt failed.
    const retry = fixture(onNotice, framework.getStore());
    retry.registry.setSubscriptionPolicy('test', 'auto');
    await retry.registry.handleChanged('test', { added: [descriptor()] });
    assert.deepEqual(retry.calls.filter((c) => c.kind === 'open').map((c) => c.id), ['x']);
    assert.equal(retry.actual.get('x'), true);
    assert.equal(retry.isOpen(), true);
    assert.equal(retry.notices.length, 0);
    assert.equal(noticeTexts().length, 1);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unconfirmed target retries explicit close instead of claiming already closed', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  f.calls.length = 0;
  f.held.add('x');
  const closing = f.tool('close');
  await tick();
  await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
  f.pending.shift()!.fail();
  assert.equal((await closing).success, false);
  assert.equal(f.isOpen(), false);
  assert.equal(f.actual.get('x'), true, 'failed close did not change the server state');
  f.held.delete('x');
  assert.equal((await f.tool('close')).success, true);
  assert.equal(f.actual.get('x'), false, 'explicit retry must actually close the channel');
  assert.equal(f.calls.length, 2, 'unconfirmed is different from confirmed closed');
  assert.equal((await f.tool('close')).success, true);
  assert.equal(f.calls.length, 2, 'the confirmed-closed fast path remains available');
});

for (const kind of ['speech', 'reply'] as const) {
  test(kind + " joins a machine's pending close even after retargeting clears open confirmation", async () => {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
    f.calls.length = 0;
    f.held.add('x');
    const closing = f.machineClose();
    await tick();
    await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
    assert.equal(f.isOpen(), false);
    const delivery = kind === 'speech'
      ? f.registry.routeSpeech('resident', 'waiting reply', { serverId: 'test', channelId: 'x' })
      : f.registry.openIfClosedForSend('x', 'test');
    await f.drain(closing, delivery);
    assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
    assert.equal((await closing).success, true);
    assert.equal(f.isOpen(), false);
    assert.deepEqual(f.publishedWhileOpen, []);
    assert.equal(f.calls.every((call) => call.kind === 'close'), true);
    if (kind === 'speech') {
      assert.equal(await delivery, null);
      assert.equal(f.routeFailures.length, 1);
    } else {
      assert.equal((await delivery as { status: string }).status, 'open-failed');
    }
  });
}

for (const change of ['address', 'type'] as const) {
  test('failed corrective open does not reuse the old ' + change + ' confirmation', async () => {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
    f.calls.length = 0;
    f.held.add('x');
    const backscroll = f.registry.handleChannelToolCall('channel_open', {
      serverId: 'test', channelId: 'x', backscroll: 5,
    });
    await tick();
    const speech = f.registry.routeSpeech('resident', 'waiting reply', { serverId: 'test', channelId: 'x' });
    const updated = change === 'address'
      ? descriptor('x', true, 'B')
      : { ...descriptor('x', true, 'A'), type: 'new-type' };
    await f.registry.handleChanged('test', { updated: [updated] });
    assert.equal(f.isOpen(), false, 'old target confirmation is invalid after retargeting');
    f.pending.shift()!.finish(); // successful receipt for A
    await tick();
    f.pending.shift()!.fail(); // corrective open for the new target fails
    await f.drain(backscroll, speech);
    assert.equal((await backscroll).success, false);
    assert.equal(await speech, null);
    assert.equal(f.isOpen(), false);
    assert.deepEqual(f.publishedWhileOpen, []);
    assert.equal(f.routeFailures.length, 1);
  });
}

test('a failed RPC from a replaced connection cannot preserve its old open confirmation', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const backscroll = f.registry.handleChannelToolCall('channel_open', {
    serverId: 'test', channelId: 'x', backscroll: 5,
  });
  await tick();
  const speech = f.registry.routeSpeech('resident', 'waiting reply', { serverId: 'test', channelId: 'x' });
  f.replaceServer();
  f.pending.shift()!.fail();
  await f.drain(backscroll, speech);
  assert.equal((await backscroll).success, false);
  assert.equal(await speech, null);
  assert.equal(f.isOpen(), false);
  assert.deepEqual(f.publishedWhileOpen, []);
  assert.equal(f.routeFailures.length, 1);
});

test('descriptor churn exhausts convergence and fails the tool plus joined deliveries instead of hanging', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.calls.length = 0;
  f.held.add('x');
  let toolSettled = false, speechSettled = false, replySettled = false;
  const opening = f.registry.handleChannelToolCall('channel_open', {
    serverId: 'test', channelId: 'x', backscroll: 5,
  }).then((result) => { toolSettled = true; return result; });
  await tick();
  const speech = f.registry.routeSpeech('resident', 'waiting reply', { serverId: 'test', channelId: 'x' })
    .then((result) => { speechSettled = true; return result; });
  const reply = f.registry.openIfClosedForSend('x', 'test')
    .then((result) => { replySettled = true; return result; });
  try {
    // Every RPC succeeds promptly, but its target is superseded before the
    // receipt arrives. Bound the test itself without a hanging provider.
    for (let i = 0; i < 12 && !toolSettled; i++) {
      await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'churn-' + i)] });
      f.pending.shift()?.finish();
      await tick();
    }
    assert.equal(toolSettled, true, 'the whole convergence operation must be bounded');
    assert.equal(speechSettled, true, 'joined speech must receive a terminal result');
    assert.equal(replySettled, true, 'reply preparation must receive a terminal result');
    assert.equal(f.calls.length, 5, 'at most five transport attempts per operation');
    assert.equal((await opening).success, false);
    assert.equal((await opening).error, 'Channel "x" wasn\'t opened: the channel\'s address at the "test" server, or the ' +
      'decision about it, kept changing, and 5 tries didn\'t settle it. The open stays recorded, and calling channel_open ' +
      'again tries once more.');
    assert.equal(await speech, null);
    assert.equal((await reply).status, 'open-failed');
    assert.equal(f.isOpen(), false, 'an unconfirmed current target is not reported open');
    assert.deepEqual(f.publishedWhileOpen, []);
    assert.equal(f.routeFailures.length, 1);
    // The agent's reason and the trace carry the one clause, and the
    // agent's says what helps.
    const unsettled = 'the channel\'s address at the "test" server, or the decision about it, kept changing, and 5 tries didn\'t settle it';
    assert.equal(f.routeFailures[0].reason, `${unsettled}, so try again`);
    assert.ok(f.traces.some((e) => e.type === 'mcpl:channel-reconcile-failed' && e.error === unsettled));
  } finally {
    // Original code needs one stable receipt to release its unbounded loop.
    await f.drain(opening, speech, reply);
  }
  f.held.delete('x');
  const retry = await f.registry.routeSpeech('resident', 'a later stable retry', { serverId: 'test', channelId: 'x' });
  assert.equal(retry?.delivered, true);
  assert.equal(f.calls.length, 6, 'later delivery reconfirms the latest target before publishing');
  assert.equal((await f.tool('close')).success, true, 'exhaustion releases the queue');
  assert.equal((await f.tool('open')).success, true, 'a later stable decision gets a fresh retry budget');
});

test('background reconciliation reports supersession exhaustion and still permits other channels', async () => {
  const f = fixture();
  f.held.add('x');
  let settled = false;
  const reconcile = f.registry.handleChanged('test', { added: [descriptor('x', true)] })
    .then(() => { settled = true; });
  await tick();
  try {
    await f.registry.handleChanged('test', { added: [descriptor('y', true)] });
    assert.equal(f.actual.get('y'), true);
    for (let i = 0; i < 12 && !settled; i++) {
      await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'churn-' + i)] });
      f.pending.shift()?.finish();
      await tick();
    }
    assert.equal(settled, true);
    assert.equal(f.calls.filter((call) => call.id === 'x').length, 5);
    const failures = f.traces.filter((e) => e.type === 'mcpl:channel-reconcile-failed');
    assert.equal(failures.length, 1);
    assert.match(String(failures[0].error), /kept changing, and 5 tries didn't settle it$/);
    assert.equal(f.registry.getDesiredState('test', 'x'), 'open', 'failure does not erase desired intent');
  } finally { await f.drain(reconcile); }
});

test('finite descriptor supersession can converge on its fifth transport attempt', async () => {
  const f = fixture();
  f.held.add('x');
  const reconcile = f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await tick();
  for (let i = 0; i < 4; i++) {
    await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'target-' + i)] });
    f.pending.shift()!.finish();
    await tick();
  }
  await f.drain(reconcile);
  assert.equal(f.calls.length, 5);
  assert.equal(f.isOpen(), true);
  assert.deepEqual(f.calls.at(-1)?.address, { value: 'target-3' });
  assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-reconcile-failed').length, 0);
});

test('a newer tune-out decision keeps transport open when an older close completes', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const close = f.tool('close');
  await tick();
  f.registry.enterTuneOut('test', 'x', {
    epochId: 'new-epoch', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
  }, 'agent-tool');
  await f.drain(close);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'tuned-out');
  assert.equal(f.actual.get('x'), true);
  assert.equal(f.isOpen(), true);
  assert.equal((await close).success, false, 'superseded close must not report current state as closed');
});

test('an explicit open answers only once the current registration is open', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  f.held.add('x');
  let openWhenAnswered: boolean | undefined;
  const opening = f.tool('open').then((result) => { openWhenAnswered = f.isOpen(); return result; });
  await tick();
  assert.equal(f.pending.length, 1);
  // The server registers the channel again while the open is in flight.
  const reRegistered = f.registry.handleChanged('test', { added: [descriptor()] });
  await f.drain(opening, reRegistered);
  assert.equal((await opening).success, true);
  assert.equal(openWhenAnswered, true, 'a receipt for the replaced registration confirms nothing about the new one');
  assert.equal(f.isOpen(), true);
});

test('an explicit open waits for a close in flight rather than answering already open', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const closing = f.tool('close');
  await tick();
  const reopening = f.tool('open');
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open', 'the next open meets an open decision and a pending close');
  let settled = false;
  const again = f.tool('open').then((result) => { settled = true; return result; });
  await tick();
  assert.equal(settled, false, 'entry.open is provisional while the close is in flight');
  await f.drain(closing, reopening, again);
  assert.equal((await again).success, true);
  assert.equal(f.actual.get('x'), true);
  assert.equal(f.isOpen(), true);
});

for (const delivery of ['reply', 'speech'] as const) {
  test('a ' + delivery + " into a channel whose machine close failed opens it again, and says so; one whose own close failed goes out with that close standing", async () => {
    for (const closer of ['machine', 'agent'] as const) {
      const f = fixture();
      await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
      f.calls.length = 0;
      f.held.add('x');
      const closing = closer === 'agent' ? f.tool('close') : f.registry.handleChannelToolCall('channel_close',
        { serverId: 'test', channelId: 'x', source: 'subscription-gc' }, { kind: 'module', moduleName: 'subscription-gc' });
      await tick();
      f.pending.shift()!.fail();
      assert.equal((await closing).success, false);
      await tick();
      assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
      assert.equal(f.isOpen(), true, 'a failed same-target close leaves the transport known open');
      f.held.delete('x');
      // A machine's close is no decision speech holds to, so the words open
      // the channel again; the agent's own close stands against its words,
      // which go out into the transport the failed close left open.
      const reopens = closer === 'machine';
      if (delivery === 'reply') {
        const reply = await f.registry.openIfClosedForSend('x', 'test');
        assert.equal(reply.status, reopens ? 'opened' : 'stays-closed', `${closer}: what the reply did`);
      } else {
        assert.equal((await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }))?.delivered, true);
        assert.equal(f.notices.length, reopens ? 1 : 0, `${closer}: whether the speech turned a channel decided closed open again`);
        assert.deepEqual(f.publishedWhileOpen, [true]);
      }
      assert.equal(f.registry.getDesiredState('test', 'x'), reopens ? 'open' : 'closed', closer);
      assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-opened-by-send').length, reopens ? 1 : 0, closer);
      assert.deepEqual(f.calls.map((c) => c.kind), reopens ? ['close', 'open'] : ['close'],
        reopens ? 'the transport is confirmed again after the failed close' : 'nothing reopens it');
    }
  });
}

test('speech into a channel decided closed keeps publishing where no open can succeed, without the lifecycle grant', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  assert.equal(f.isOpen(), true);
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
  const closing = await f.tool('close');
  assert.equal(closing.success, false);
  assert.equal(closing.error, 'This host isn\'t permitted to open or close the "test" server\'s channels, so this close of ' +
    'channel "x" didn\'t go through, and calling channel_close again won\'t change that. The close stays recorded, and ' +
    'happens when the "test" server next registers this channel, if this host may open and close its channels then. If you ' +
    'need it, ask whoever runs this host.');
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed', 'the refused close is still recorded as a decision');
  f.calls.length = 0;
  assert.equal((await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }))?.delivered, true);
  assert.deepEqual(f.publishedWhileOpen, [true]);
  assert.deepEqual(f.calls, [], 'no open is attempted where it could not succeed');
  assert.equal(f.notices.length, 0);
});

test('a failed explicit open says the open stays recorded, and a later delivery opens it quietly', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  f.calls.length = 0;
  f.held.add('x');
  const opening = f.tool('open');
  await tick();
  f.pending.shift()!.fail();
  const result = await opening;
  assert.equal(result.success, false);
  assert.equal(result.error, 'Opening channel "x" didn\'t complete; the open stays recorded, and this host tries it again ' +
    'when the "test" server next registers this channel, if this host may open and close its channels then, or now if you ' +
    'call channel_open again. fixture lifecycle failure.');
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open', 'the decision outlives a failed round-trip');
  f.held.delete('x');
  await tick();
  assert.equal((await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }))?.delivered, true);
  assert.equal(f.notices.length, 0, 'the resident was already told the open stays recorded');
  assert.deepEqual(f.calls.map((c) => c.kind), ['open', 'open']);
});

for (const delivery of ['speech', 'reply'] as const) {
  test(delivery + ' into a channel decided open whose transport lost confirmation is not announced as opening it', async () => {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
    // A retarget opens the new target; that open fails, so the channel stays
    // decided open with its transport unconfirmed.
    f.held.add('x');
    const retarget = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
    await tick();
    f.pending.shift()!.fail();
    await retarget;
    f.held.delete('x');
    assert.equal(f.isOpen(), false, 'a failed open leaves the new target unconfirmed');
    f.calls.length = 0;
    if (delivery === 'speech') {
      assert.equal((await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }))?.delivered, true);
      assert.deepEqual(f.publishedWhileOpen, [true]);
    } else {
      assert.equal((await f.registry.openIfClosedForSend('x', 'test')).status, 'already-open');
    }
    assert.deepEqual(f.calls.map((c) => [c.kind, c.address]), [['open', { value: 'B' }]], 'the new target is confirmed first');
    assert.equal(f.notices.length, 0, 'the channel was never closed');
    assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-opened-by-send').length, 0);
    assert.equal(f.registry.getDesiredState('test', 'x'), 'open');
  });

  test(delivery + ' into a tuned-out channel whose transport lost confirmation keeps the tune-out, unannounced', async () => {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
    f.registry.enterTuneOut('test', 'x', {
      epochId: 'kept-epoch', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
    }, 'agent-tool');
    f.held.add('x');
    const retarget = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
    await tick();
    f.pending.shift()!.fail();
    await retarget;
    f.held.delete('x');
    assert.equal(f.isOpen(), false);
    if (delivery === 'speech') {
      assert.equal((await f.registry.routeSpeech('resident', 'hello', { serverId: 'test', channelId: 'x' }))?.delivered, true);
      assert.deepEqual(f.publishedWhileOpen, [true]);
    } else {
      assert.equal((await f.registry.openIfClosedForSend('x', 'test')).status, 'already-open');
    }
    assert.equal(f.registry.getDesiredState('test', 'x'), 'tuned-out');
    assert.equal(f.registry.getTuneOutState('test', 'x')?.params.epochId, 'kept-epoch');
    assert.equal(f.isOpen(), true);
    assert.equal(f.notices.length, 0, 'its traffic is still diverted, so nothing new reaches the resident');
    assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-opened-by-send').length, 0);
  });
}

test('a corrective close that cannot converge reports its exhaustion once', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  f.calls.length = 0;
  // Asked to open x, the server opens y instead, and y's corrective close is
  // retargeted before each receipt.
  f.answeredFor.set('x', 'y');
  f.held.add('y');
  assert.equal((await f.tool('open')).success, false);
  await tick();
  assert.equal(f.pending.length, 1, 'the corrective close for y is in flight');
  try {
    for (let i = 0; i < 12 && f.pending.length > 0; i++) {
      await f.registry.handleChanged('test', { updated: [descriptor('y', false, 'churn-' + i)] });
      f.pending.shift()!.finish();
      await tick();
    }
    assert.equal(f.pending.length, 0, 'the corrective close is bounded');
    assert.equal(f.calls.filter((c) => c.id === 'y' && c.kind === 'close').length, 5);
    const failures = f.traces.filter((e) => e.type === 'mcpl:channel-reconcile-failed' && e.channelId === 'y');
    assert.equal(failures.length, 1);
    assert.match(String(failures[0].error), /kept changing, and 5 tries didn't settle it$/);
  } finally {
    f.held.delete('y');
    while (f.pending.length > 0) f.pending.shift()!.finish();
  }
});

test('speech joined to a failed backscroll still reaches a channel that stayed open', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const backscroll = f.registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: 'x', backscroll: 5 });
  await tick();
  const speech = f.registry.routeSpeech('resident', 'joined', { serverId: 'test', channelId: 'x' });
  f.pending.shift()!.fail();
  assert.equal((await backscroll).success, false);
  assert.equal((await speech)?.delivered, true, 'a failed redundant open leaves the channel usable for a joined delivery');
  assert.deepEqual(f.publishedWhileOpen, [true]);
});

test('a reply into a tuned-out channel whose transport is open needs no lifecycle RPC', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.registry.enterTuneOut('test', 'x', {
    epochId: 'quiet', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
  }, 'agent-tool');
  f.calls.length = 0;
  assert.equal((await f.registry.openIfClosedForSend('x', 'test')).status, 'already-open');
  assert.deepEqual(f.calls, []);
  assert.equal(f.registry.getTuneOutState('test', 'x')?.params.epochId, 'quiet');
});

test('a failed reply open reports the label of the registration that replaced it', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  f.held.add('x');
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  const replacement = f.registry.handleChanged('test', {
    removed: ['x'], added: [{ ...descriptor('x', false, 'replacement'), label: 'Replacement label' }],
  });
  f.pending.shift()!.fail();
  const result = await reply;
  assert.equal(result.status, 'open-failed');
  assert.equal(result.label, 'Replacement label');
  await f.drain(replacement);
});

test('a channel removed from its batch holds up none of its siblings, and fails nothing', async () => {
  const f = fixture();
  f.held.add('x');
  const first = f.registry.handleChanged('test', { added: [descriptor('x')] });
  await tick();
  assert.equal(f.pending.length, 1, "x's first operation is in flight");
  f.held.add('y');
  const batch = f.registry.handleChanged('test', { added: [descriptor('y', true), descriptor('x')] });
  await tick();
  assert.equal(f.pending.length, 2, "y's operation is in flight too");
  await f.registry.handleChanged('test', { removed: ['x'] });
  f.pending.pop()!.finish(); // y's receipt; x's first operation stays in flight
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.isOpen('y'), true, "y opened while x's operation was still in flight");
  await f.drain(first, batch);
  assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-reconcile-failed').length, 0,
    'the removed channel is cancelled, not failed');
});

test("a batch's channels reconcile side by side: one held RPC delays none of its siblings", async () => {
  const f = fixture();
  f.held.add('x');
  const batch = f.registry.handleChanged('test', { added: [descriptor('x', true), descriptor('y', true)] });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.isOpen('y'), true, "y's open didn't wait for x's");
  assert.equal(f.isOpen('x'), false);
  await f.drain(batch);
  assert.equal(f.isOpen('x'), true);
});

test('a descriptor the registration rejected is neither admitted nor announced', async () => {
  const f = fixture();
  f.registry.setSubscriptionPolicy('test', 'auto');
  // The first registration migrates the legacy policy; the second is admitted by it.
  await f.registry.handleRegister('test', { channels: [descriptor('x')] });
  await f.registry.handleRegister('test', { channels: [descriptor('y'), { ...descriptor('rejected'), id: '' }] });
  assert.deepEqual(f.notices.map((n) => n.channels.map((c) => c.channelId)), [['y']]);
  assert.equal(f.registry.getDesiredState('test', ''), undefined);
});

test('a failed initial close leaves the channel unconfirmed, so channel_close closes it for real', async () => {
  const f = fixture();
  f.held.add('x');
  const registration = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  f.pending.shift()!.fail();
  await registration;
  f.held.delete('x');
  f.calls.length = 0;
  assert.equal(dataOf(await f.tool('close')).status, 'closed');
  assert.deepEqual(f.calls.map((c) => c.kind), ['close'], 'a failed close may have closed nothing');
  assert.equal(dataOf(await f.tool('close')).status, 'already closed', 'its receipt confirms the close');
  assert.equal(f.calls.length, 1);
});

test("a re-registration's entry is unconfirmed until a receipt, so channel_close never answers already closed for it", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  assert.equal(dataOf(await f.tool('close')).status, 'already closed', 'its initial close was confirmed');
  // The server registers again, without the lifecycle grant this time: the
  // host sends nothing, and nothing confirms the new entry closed.
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
  f.calls.length = 0;
  await f.registry.handleRegister('test', { channels: [descriptor()] });
  assert.equal(f.calls.length, 0);
  const result = await f.tool('close');
  assert.equal(result.success, false);
  assert.match(String(result.error), /^This host isn't permitted to open or close the "test" server's channels, so this close of channel "x" didn't go through/,
    'refused for the grant, not answered already closed');
});

test('traffic after a retarget confirms nothing: only a receipt for the new target does', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  f.held.add('x');
  const retarget = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
  await tick();
  await f.registry.handleIncoming('test', { messages: [message()] });
  assert.equal(f.isOpen(), false, "the old subscription's traffic doesn't confirm the new target");
  f.pending.shift()!.fail();
  await retarget;
  assert.equal(f.isOpen(), false, 'and a failed open for the new target leaves it unconfirmed');
});

test('traffic for a channel decided closed leaves its confirmed close standing', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  assert.equal((await f.tool('close')).success, true);
  await f.registry.handleIncoming('test', { messages: [message()] });
  assert.equal(f.isOpen(), false);
});

test('a close that lands while the coalescer holds a message stands', async () => {
  let admit!: () => void;
  const f = fixture(undefined, undefined, async (_serverId, held) => {
    await new Promise<void>((resolve) => { admit = resolve; });
    return { messageId: held.messageId, accepted: true };
  });
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  const incoming = f.registry.handleIncoming('test', { messages: [{ ...message(), coalesce: { key: 'subject' } }] });
  await tick();
  assert.equal((await f.tool('close')).success, true);
  admit();
  await incoming;
  assert.equal(f.isOpen(), false, 'the close receipt stands');
});

test("a coalesced message the coalescer admits after its channel was withdrawn sets no default, so another server's default stands", async () => {
  let admit!: () => void;
  const f = fixture(undefined, undefined, async (_serverId, held) => {
    await new Promise<void>((resolve) => { admit = resolve; });
    return { messageId: held.messageId, accepted: true };
  });
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  (f.registry as unknown as { noteInbound(channel: { serverId: string; channelId: string }, messageId: string | null): void })
    .noteInbound({ serverId: 'other', channelId: 'z' }, 'm-other');
  const incoming = f.registry.handleIncoming('test', { messages: [{ ...message(), coalesce: { key: 'subject' } }] });
  await tick();
  await f.registry.handleChanged('test', { removed: ['x'] });
  admit();
  await incoming;
  assert.deepEqual(f.registry.getDefaultPublishChannel(), { serverId: 'other', channelId: 'z' }, "the other server's default stands");
  assert.deepEqual(f.registry.incomingFor(), { channel: { serverId: 'other', channelId: 'z' }, messageId: 'm-other', threadId: undefined });
});

test("a coalesced message the coalescer admits after its channel was withdrawn and registered again sets no default, so another server's default stands", async () => {
  let admit!: () => void;
  const f = fixture(undefined, undefined, async (_serverId, held) => {
    await new Promise<void>((resolve) => { admit = resolve; });
    return { messageId: held.messageId, accepted: true };
  });
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  (f.registry as unknown as { noteInbound(channel: { serverId: string; channelId: string }, messageId: string | null): void })
    .noteInbound({ serverId: 'other', channelId: 'z' }, 'm-other');
  const incoming = f.registry.handleIncoming('test', { messages: [{ ...message(), coalesce: { key: 'subject' } }] });
  await tick();
  await f.registry.handleChanged('test', { removed: ['x'] });
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  admit();
  await incoming;
  assert.deepEqual(f.registry.getDefaultPublishChannel(), { serverId: 'other', channelId: 'z' }, "the other server's default stands");
  assert.deepEqual(f.registry.incomingFor(), { channel: { serverId: 'other', channelId: 'z' }, messageId: 'm-other', threadId: undefined });
});

test("a coalesced message the coalescer admits after its server was removed sets no default, so another server's default stands", async () => {
  let admit!: () => void;
  const f = fixture(undefined, undefined, async (_serverId, held) => {
    await new Promise<void>((resolve) => { admit = resolve; });
    return { messageId: held.messageId, accepted: true };
  });
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  // Another server's message set the default before this one arrived.
  (f.registry as unknown as { noteInbound(channel: { serverId: string; channelId: string }, messageId: string | null): void })
    .noteInbound({ serverId: 'other', channelId: 'z' }, 'm-other');
  const incoming = f.registry.handleIncoming('test', { messages: [{ ...message(), coalesce: { key: 'subject' } }] });
  await tick();
  f.registry.removeServer('test');
  admit();
  await incoming;
  assert.deepEqual(f.registry.getDefaultPublishChannel(), { serverId: 'other', channelId: 'z' }, "the other server's default stands");
  assert.deepEqual(f.registry.incomingFor(), { channel: { serverId: 'other', channelId: 'z' }, messageId: 'm-other', threadId: undefined },
    "no message on the removed server is given as the one replied to");
});

test('a retarget of a channel decided open opens the new target; one decided closed sends nothing', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A'), descriptor('y', false, 'A')] });
  f.calls.length = 0;
  await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B'), descriptor('y', false, 'B')] });
  assert.deepEqual(f.calls.map((c) => [c.kind, c.id, c.address]), [['open', 'x', { value: 'B' }]]);
  assert.equal(f.isOpen('x'), true);
  const closeY = await f.registry.handleChannelToolCall('channel_close', { serverId: 'test', channelId: 'y' });
  assert.equal(dataOf(closeY).status, 'closed', "y's new target is unconfirmed, so its close is sent");
  assert.deepEqual(f.calls.at(-1), { kind: 'close', id: 'y', address: undefined });
});

for (const decision of ['open', 'tuned-out'] as const) {
  test(`a retarget while the old target's open is in flight opens the new target when that open fails, for a channel decided ${decision}`, async () => {
    // Greptile's P1 on #210: the retarget queued nothing, since an operation
    // was running, and that operation threw on its failed RPC without
    // reading the new target.
    const f = fixture();
    f.held.add('x');
    const opening = f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
    await tick();
    if (decision === 'tuned-out') {
      f.registry.enterTuneOut('test', 'x', {
        epochId: 'e1', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
      }, 'agent-tool');
    }
    await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
    f.held.delete('x');
    f.pending.shift()!.fail();
    await f.drain(opening);
    assert.deepEqual(f.calls.map((c) => [c.kind, c.address]), [['open', { value: 'A' }], ['open', { value: 'B' }]]);
    assert.equal(f.isOpen(), true);
    assert.equal(f.registry.getDesiredState('test', 'x'), decision);
    assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-reconcile-failed'), []);
  });
}

test("a retarget while the old target's close is in flight sends nothing more when that close fails", async () => {
  // As for any retarget of a channel decided closed, the new target is left
  // unconfirmed for channel_close to close for real.
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  f.calls.length = 0;
  f.held.add('x');
  const close = f.tool('close');
  await tick();
  await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
  f.held.delete('x');
  f.pending.shift()!.fail();
  await f.drain(close);
  assert.equal((await close).success, false);
  assert.deepEqual(f.calls.map((c) => c.kind), ['close']);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
  assert.equal(f.isOpen(), false);
});

test("removing a server cancels its queued lifecycle work, even across a re-registration", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.calls.length = 0;
  f.held.add('x');
  const closing = f.tool('close');
  await tick();
  const reopening = f.tool('open');
  f.registry.removeServer('test');
  const reregistration = f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await f.drain(closing, reopening, reregistration);
  assert.equal((await reopening).success, false, 'the open queued before the removal never runs');
  // Its text is written when it fails, before the re-registration's own
  // open, which applies the recorded open.
  assert.equal((await reopening).error,
    'Channel "x" wasn\'t opened: this host disconnected the "test" server while the change was being made. ' +
    'The open stays recorded, and happens when the "test" server next registers this channel, if this host may open and ' +
    'close its channels then.');
  assert.deepEqual(f.calls.map((c) => c.kind), ['close', 'open'], "the close in flight, then the re-registration's own open");
  assert.equal(f.isOpen(), true);
  assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-reconcile-failed').length, 0);
});

// Work queued before a server's removal cancels when it would run, so it
// carries out no decision for the channel's later entry. A retarget then
// opens the new target itself, as it does with nothing queued.
for (const decision of ['open', 'tuned-out'] as const) {
  test(`a retarget after its server's removal opens the new target, though work queued before the removal is still outstanding, for a channel decided ${decision}`, async () => {
    const f = fixture();
    f.held.add('x');
    const opening = f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
    await tick();
    if (decision === 'tuned-out') {
      f.registry.enterTuneOut('test', 'x', {
        epochId: 'e1', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
      }, 'agent-tool');
    }
    f.registry.removeServer('test');
    // A push names the channel before its server registers it again.
    f.registry.ensureChannelRegistered('test', 'x', 'x');
    const retarget = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
    f.held.delete('x');
    await f.drain(opening, retarget);
    assert.equal(f.registry.getDesiredState('test', 'x'), decision);
    assert.deepEqual(f.calls.map((c) => [c.kind, c.address]), [['open', { value: 'A' }], ['open', { value: 'B' }]]);
    assert.equal(f.isOpen(), true);
    assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-reconcile-failed'), []);
  });
}

test("a retarget once the lifecycle grant is back opens the new target, though work queued before the server's removal is still outstanding", async () => {
  const f = fixture();
  f.held.add('x');
  const opening = f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  await tick();
  f.registry.removeServer('test');
  // Registered again where the host doesn't direct the lifecycle, which
  // reconciles nothing, then retargeted once it does.
  f.setGrant(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle'));
  await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  f.setGrant(ALL_CAPABILITY_PATHS);
  const retarget = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
  f.held.delete('x');
  await f.drain(opening, retarget);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open');
  assert.deepEqual(f.calls.map((c) => [c.kind, c.address]), [['open', { value: 'A' }], ['open', { value: 'B' }]]);
  assert.equal(f.isOpen(), true);
  assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-reconcile-failed'), []);
});

test("a retarget while work queued since its server's removal is outstanding queues nothing more: that work opens the new target", async () => {
  const f = fixture();
  f.held.add('x');
  const opening = f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  await tick();
  f.registry.removeServer('test');
  f.registry.ensureChannelRegistered('test', 'x', 'x');
  // Queues an open under the new removal count, behind the held open to A.
  const toB = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
  f.pending.shift()!.finish();
  for (let i = 0; i < 100 && f.calls.length < 2; i++) await tick();
  assert.deepEqual(f.calls.map((c) => [c.kind, c.address]), [['open', { value: 'A' }], ['open', { value: 'B' }]]);
  // The open to B is outstanding and counted since the removal, so it
  // carries out the retarget to C: no second open is queued for C.
  const toC = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'C')] });
  f.held.delete('x');
  await f.drain(opening, toB, toC);
  assert.deepEqual(f.calls.map((c) => [c.kind, c.address]), [['open', { value: 'A' }], ['open', { value: 'B' }], ['open', { value: 'C' }]]);
  assert.equal(f.isOpen(), true);
  assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-reconcile-failed'), []);
});

test('a substitute removed while its corrective close is queued is cancelled, not traced as failed', async () => {
  const f = fixture();
  f.held.add('y');
  const registration = f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  await tick();
  assert.equal(f.pending.length, 1, "y's initial close is in flight");
  f.answeredFor.set('x', 'y');
  const opening = f.tool('open');
  for (let i = 0; i < 3; i++) await tick();
  await f.registry.handleChanged('test', { removed: ['y'] });
  await f.drain(registration, opening);
  assert.equal((await opening).success, false);
  assert.equal(f.traces.filter((e) => e.type === 'mcpl:channel-reconcile-failed').length, 0);
});

test('declining an invitation closes an unconfirmed transport for real, and waits for pending work', async () => {
  const f = fixture();
  const decline = () => f.registry.handleChannelToolCall('channel_decline', { serverId: 'test', channelId: 'x', messageId: 'm1' });
  f.held.add('x');
  const registration = f.registry.handleChanged('test', { added: [descriptor()] });
  await tick();
  f.pending.shift()!.fail();
  await registration;
  f.held.delete('x');
  f.calls.length = 0;
  const unconfirmed = await decline();
  assert.equal(unconfirmed.success, true);
  assert.equal(dataOf(unconfirmed).status, 'remained closed');
  assert.equal(dataOf(unconfirmed).closeError, undefined);
  assert.deepEqual(f.calls.map((c) => c.kind), ['close'], 'the unconfirmed transport is closed for real');
  f.calls.length = 0;
  assert.equal((await decline()).success, true);
  assert.equal(f.calls.length, 0, 'a confirmed close with nothing pending needs no RPC');

  // A re-registration's close in flight: the decline queues behind it.
  f.held.add('x');
  const reregistration = f.registry.handleChanged('test', { removed: ['x'], added: [descriptor()] });
  await tick();
  assert.equal(f.pending.length, 1);
  const pending = decline();
  await f.drain(reregistration, pending);
  assert.equal((await pending).success, true);
  assert.deepEqual(f.calls.map((c) => c.kind), ['close', 'close'], 'the decline went through the queue behind the close');
});

test("a settled operation releases its channel's queue key", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  const internals = f.registry as unknown as {
    channelLifecycleTails: Map<string, unknown>; lifecycleOutstanding: Map<string, number>; lifecycleQueuedRemovals: Map<string, number>;
  };
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(internals.channelLifecycleTails.size, 0);
  assert.equal(internals.lifecycleOutstanding.size, 0);
  assert.equal(internals.lifecycleQueuedRemovals.size, 0, 'the removal count kept for the queue goes with it');
});

test('the notices say what happened, name the opt-out, and state no rule about later sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-notice-text-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Test.' }],
    modules: [], syncIntervalMs: 0,
  });
  try {
    const recordNotice = (framework as unknown as {
      recordChannelAutoOpenNotice(
        agent: undefined,
        serverId: string,
        channels: Array<{ channelId: string; label?: string }>,
        cause: 'subscription-policy' | 'opened-by-delivery' | 'opened-by-reply',
      ): void;
    }).recordChannelAutoOpenNotice.bind(framework);
    recordNotice(undefined, 'srv', [{ channelId: 'discord:g1:c1', label: '#general' }], 'opened-by-reply');
    recordNotice(undefined, 'srv', [{ channelId: 'c2' }], 'opened-by-delivery');
    recordNotice(undefined, 'srv', [{ channelId: 'c3' }, { channelId: 'c4', label: 'ops' }], 'subscription-policy');
    const texts = framework.getAgent('resident')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text' && b.text.startsWith('[channels]'))
      .map((b) => (b as { text: string }).text);
    assert.deepEqual(texts, [
      "[channels] Now open: #general (discord:g1:c1): your own message into the closed channel opened it. " +
        "What an open channel brings you is up to its server: some send every message in it, and others only what addresses you unless you're subscribed to it; their own tools can change that. If you don't want it, " +
          "use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.",
      "[channels] Now open: c2: your own message into the closed channel opened it. " +
        "What an open channel brings you is up to its server: some send every message in it, and others only what addresses you unless you're subscribed to it; their own tools can change that. If you don't want it, " +
          "use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.",
      '[channels] Selected for opening by subscription policy: c3, ops (c4). ' +
        "The host opens them, and if one doesn't open, tries again when its server next registers it; channel_list shows whether each is open yet. " +
        "What an open channel brings you is up to its server: some send every message in it, and others only what addresses you unless you're subscribed to it; their own tools can change that. If you don't want one of them, " +
        "use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.",
    ]);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server the host doesn't direct opens its own channels: its traffic marks them open, and a decline sends nothing", async () => {
  const f = fixture();
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
  await f.registry.handleChanged('test', { added: [descriptor()] });
  await f.registry.handleIncoming('test', { messages: [message()] });
  assert.equal(f.isOpen(), true, 'traffic is the only evidence such a server gives');
  await f.registry.handleChanged('test', { updated: [descriptor('x', false, 'B')] });
  assert.equal(f.isOpen(), false);
  await f.registry.handleIncoming('test', { messages: [message('x', 'm2')] });
  assert.equal(f.isOpen(), true);
  await f.registry.handleChanged('test', { added: [descriptor('y')] });
  const declined = await f.registry.handleChannelToolCall('channel_decline', { serverId: 'test', channelId: 'y', messageId: 'm3' });
  assert.equal(declined.success, true);
  assert.equal(dataOf(declined).closeError,
    'The decline is recorded, but this host isn\'t permitted to open or close the "test" server\'s channels, so the server ' +
    'keeps this one open or closed as it chooses, and declining again won\'t change that. This host closes it when the "test" ' +
    'server next registers this channel, if this host may open and close its channels then. If you need it closed sooner, ' +
    'ask whoever runs this host.');
  assert.equal(f.calls.length, 0, 'the host sends no lifecycle RPC to a server it does not direct');
});

test('a failed open leaves the channel unconfirmed: traffic afterwards marks nothing open', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  f.held.add('x');
  const opening = f.tool('open');
  await tick();
  f.pending.shift()!.fail();
  assert.equal((await opening).success, false);
  f.held.delete('x');
  await f.registry.handleIncoming('test', { messages: [message()] });
  assert.equal(f.isOpen(), false, 'an RPC can fail after the server acted, and traffic does not settle which');
});

test('disconnecting a server removes its channel entries before its connection closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disconnect-order-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Test.' }],
    modules: [], syncIntervalMs: 0,
  });
  try {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
    let channelsAtClose: number | undefined;
    const internals = framework as unknown as { channelRegistry: ChannelRegistry | null; mcplServerRegistry: unknown };
    internals.channelRegistry = f.registry;
    internals.mcplServerRegistry = {
      removeServer: async () => { channelsAtClose = f.registry.listChannelsRaw().length; },
      getAllServers: () => [],
      closeAll: async () => {},
    };
    await framework.disconnectMcplServer('test');
    assert.equal(channelsAtClose, 0, 'nothing queued for its channels can run against the closing connection');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a channel its server registers while a disconnect closes it is removed with the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disconnect-late-register-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Test.' }],
    modules: [], syncIntervalMs: 0,
  });
  try {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
    const internals = framework as unknown as { channelRegistry: ChannelRegistry | null; mcplServerRegistry: unknown };
    internals.channelRegistry = f.registry;
    let lateRegistered = false;
    internals.mcplServerRegistry = {
      // A connect still setting up when the disconnect began: a channel
      // change it had received is handled while its connection closes, after
      // the disconnect removed the entries it found.
      removeServer: async () => {
        if (lateRegistered) return;
        await f.registry.handleChanged('test', { added: [descriptor('y')] });
        lateRegistered = f.registry.listChannelsRaw().some((c) => c.descriptor.id === 'y');
      },
      getAllServers: () => [],
      closeAll: async () => {},
    };
    await framework.disconnectMcplServer('test');
    assert.equal(lateRegistered, true, 'the channel was registered while the connection closed');
    assert.deepEqual(f.registry.listChannelsRaw(), [], 'no channel of the disconnected server outlives its disconnect');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// An open by speech or a reply is incidental to its words. When its
// round-trip fails, the decision it wrote goes back to the one it replaced,
// while the record is still its own. The agent's own channel_open keeps its
// decision through a failed round-trip (#210).

/** The decision on record for a channel, with its source. */
function decision(registry: ChannelRegistry, id = 'x') {
  const internals = registry as unknown as {
    desiredStates: Map<string, { state: string; source: string }>;
    lifecycleKey(serverId: string, channelId: string): string;
  };
  const record = internals.desiredStates.get(internals.lifecycleKey('test', id));
  return record && { state: record.state, source: record.source };
}

/** The lifecycle records the registry appends from now on, with their state and source. */
function recordLog(registry: ChannelRegistry) {
  const log: Array<{ desired?: string; source?: string }> = [];
  const r = registry as unknown as { appendLifecycleEvent(e: { desired?: string; source?: string }): void };
  const original = r.appendLifecycleEvent.bind(registry);
  r.appendLifecycleEvent = (e) => { original(e); log.push({ desired: e.desired, source: e.source }); };
  return log;
}

/** Makes the registry's next lifecycle append, or the one `skip` appends later, fail as a full store would. */
function failAppend(registry: ChannelRegistry, skip = 0) {
  const r = registry as unknown as { appendLifecycleEvent(e: unknown): void };
  const original = r.appendLifecycleEvent.bind(registry);
  let left = skip;
  r.appendLifecycleEvent = (e) => {
    if (left-- === 0) {
      r.appendLifecycleEvent = original;
      throw new Error('ENOSPC: no space left on device');
    }
    original(e);
  };
}

/** Starts speech into `x` while the server holds its open, and fails that open. */
async function speechWhoseOpenFails(f: ReturnType<typeof fixture>, others: () => Promise<unknown>[] = () => [], failure?: Error) {
  f.held.add('x');
  const speech = f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' });
  await tick();
  const meanwhile = others();
  await tick();
  f.pending.shift()!.fail(failure);
  f.held.delete('x');
  await f.drain(speech, ...meanwhile);
  return { outcome: await speech, meanwhile };
}

async function replyWhoseOpenFails(f: ReturnType<typeof fixture>, others: () => Promise<unknown>[] = () => []) {
  f.held.add('x');
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  const meanwhile = others();
  await tick();
  f.pending.shift()!.fail();
  f.held.delete('x');
  await f.drain(reply, ...meanwhile);
  return { answer: await reply, meanwhile };
}

test("speech whose open fails puts back the decision it replaced, and the next speech's open is a fresh one with its notice", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });

  const { outcome } = await speechWhoseOpenFails(f);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /^opening the channel for these words didn't complete/);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' }, 'what the agent was told stays true');
  assert.equal(f.notices.length, 0);

  const again = await f.registry.publish('agent', 'more words', { serverId: 'test', channelId: 'x' });
  assert.equal(again.status, 'delivered');
  assert.equal(f.isOpen(), true);
  assert.deepEqual(f.notices.map((n) => n.source), ['opened-by-delivery'], 'the open that succeeds tells the agent the channel is open');
});

test('after speech whose open failed, the server announcing the channel again opens nothing', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await speechWhoseOpenFails(f);
  const opens = f.calls.filter((c) => c.kind === 'open').length;

  const before = f.calls.length;
  await f.drain(f.registry.handleChanged('test', { removed: ['x'], added: [descriptor('x', false)] }));
  assert.deepEqual(f.calls.slice(before).map((c) => c.kind), ['close'], "the registration's reconcile ran, and carried out the closed decision");
  assert.equal(f.calls.filter((c) => c.kind === 'open').length, opens, 'no open is sent');
  assert.equal(f.isOpen(), false);
  assert.deepEqual(f.notices, []);
});

test("a close made while speech's open is out stands when that open fails: a machine's fails the words, and the agent's own lets them go into the channel it closed", async () => {
  {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
    const { outcome } = await speechWhoseOpenFails(f, () => [f.machineClose()]);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.reason, "opening the channel for these words didn't complete: fixture lifecycle failure; a decision about the " +
      'channel made while the open was out stands', "the open's own failure, carried as overtaken, and the decision that stands");
    assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' });
  }
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  const { outcome } = await speechWhoseOpenFails(f, () => [f.tool('close')]);
  assert.equal(outcome.status, 'delivered', 'the agent closed it meanwhile, so the words go into it as it stands');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
  assert.equal(f.notices.length, 0, 'nothing says it opened');
});

test("speech whose open was answered after a machine closed the channel meanwhile names that close once; after the agent's own close, the words go into the channel it closed", async () => {
  // The open's own failure is the later close, so its clause names it, and
  // the overtaken failure adds nothing to it.
  for (const closer of ['machine', 'agent'] as const) {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
    f.held.add('x');
    const speech = f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' });
    await tick();
    assert.equal(f.pending.length, 1, "speech's open is out");
    const closing = closer === 'agent' ? f.tool('close') : f.machineClose();
    await tick();
    f.held.delete('x');
    f.pending.shift()!.finish();
    await f.drain(speech, closing);
    const outcome = await speech;
    if (closer === 'machine') {
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.reason, "opening the channel for these words didn't complete: a later decision to close it came first");
      assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' });
    } else {
      assert.equal(outcome.status, 'delivered');
      assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
      assert.equal(f.notices.length, 0);
    }
  }
});

test("the agent's channel_open made while speech's open is out stands when that open fails", async () => {
  // channel_open records the state speech's open already recorded. It still
  // gets its own record, so the failed open sees a decision made meanwhile
  // and puts nothing back.
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  const { meanwhile } = await speechWhoseOpenFails(f, () => [f.tool('open')]);
  const opened = (await meanwhile[0]) as { success: boolean };
  assert.equal(opened.success, true, "the agent's open goes through");
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'agent-tool' });
  assert.equal(f.isOpen(), true);
});

test("a reply whose open fails puts back the machine's close it replaced; a reply into a channel the agent closed sends no open", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await f.drain(f.machineClose());
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' });

  f.held.add('x');
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  f.pending.shift()!.fail();
  f.held.delete('x');
  assert.deepEqual(await reply, { status: 'open-failed', channelId: 'x', serverId: 'test', label: 'x', opening: true }, 'an open that would have opened the channel');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' }, "the machine's close is on record again");

  await f.drain(f.tool('close'));
  const calls = f.calls.length;
  assert.deepEqual(await f.registry.openIfClosedForSend('x', 'test'), { status: 'stays-closed', channelId: 'x', serverId: 'test', label: 'x' });
  assert.equal(f.calls.length, calls, 'no open was sent');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
});

test("a reply's open that the agent's own close replaced during its round-trip isn't an opening that failed", async () => {
  // The agent replies and leaves in one turn: the open-on-send is
  // fire-and-forget, so its channel_close can land while the reply's open is
  // out. The open's operation then carries out the close (Cordelia-2434's
  // PROBE 8).
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  f.held.add('x');
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  assert.equal(f.pending.length, 1, "the reply's open is out when the agent's close lands");
  const closed = f.tool('close');
  await tick();
  f.held.delete('x');
  await f.drain(reply, closed);
  assert.equal(((await closed) as { success: boolean }).success, true);
  assert.deepEqual(await reply, { status: 'stays-closed', channelId: 'x', serverId: 'test', label: 'x' },
    'the channel the agent just closed stays closed, and nothing failed to tell it of');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' }, "the agent's close stands");
  assert.equal(f.isOpen(), false);
});

test("a reply's failed open after the agent's channel_open during its round-trip isn't an opening that failed", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  const { answer, meanwhile } = await replyWhoseOpenFails(f, () => [f.tool('open')]);
  assert.deepEqual(answer, { status: 'open-failed', channelId: 'x', serverId: 'test', label: 'x', opening: false }, "the agent's own open answers for itself");
  assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-open-failed').map((t) => t.error),
    ['fixture lifecycle failure; a decision about the channel made while the open was out stands'],
    "the open's own failure, carried as overtaken, and the decision that stands");
  assert.equal(((await meanwhile[0]) as { success: boolean }).success, true, "the agent's open goes through");
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'agent-tool' });
  assert.equal(f.isOpen(), true);
});

test("a reply's failed open whose put-back can't be recorded is still an opening that failed, and says the channel stays selected", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  failAppend(f.registry, 1); // the open's own record goes through; the put-back's doesn't
  const closes = f.calls.filter((c) => c.kind === 'close').length;
  const { answer } = await replyWhoseOpenFails(f);
  assert.deepEqual(answer, { status: 'open-failed', channelId: 'x', serverId: 'test', label: 'x', opening: true, selectedForOpening: 'unrecorded' });
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'opened-by-reply' }, 'the channel stays selected for opening');
  await tick(); await tick();
  assert.equal(f.calls.filter((c) => c.kind === 'close').length, closes, 'no close is sent: the decision stays open');
});

test("a channel registered from a push, with no decision on record, is put back as closed by default when speech's open fails", async () => {
  const f = fixture();
  f.registry.ensureChannelRegistered('test', 'x', 'x');
  assert.equal(decision(f.registry), undefined, 'nobody has decided');
  const { outcome } = await speechWhoseOpenFails(f);
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
});

test("the put-back is durable: a registry rebuilt from the store doesn't hold the failed open's decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'failed-speech-open-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try {
    const f = fixture(undefined, store);
    await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
    await speechWhoseOpenFails(f);

    const rebuilt = fixture(undefined, store);
    assert.deepEqual(decision(rebuilt.registry), { state: 'closed', source: 'default-closed' });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when speech\'s open fails while the server announces the channel again, the queued reconcile carries out the put-back: one close, no notice", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  f.held.add('x');
  const speech = f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' });
  await tick();
  assert.equal(f.pending.length, 1, "speech's open is out");
  const reannounce = f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick();
  const before = f.calls.length;
  f.pending.shift()!.fail();
  f.held.delete('x');
  await f.drain(speech, reannounce);
  assert.equal((await speech).status, 'failed');
  assert.deepEqual(f.calls.slice(before).map((c) => c.kind), ['close'], 'the queued reconcile closes x, and nothing else does');
  assert.equal(f.isOpen(), false);
  assert.deepEqual(f.notices, []);
});

test("when an open by speech or a reply fails while the server announces the channel again as initially open, the default put back follows that announcement: the channel is selected for opening again, the queued work opens it, and the failure says why", async () => {
  for (const via of ['speech', 'reply'] as const) {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
    const reannounce = () => [f.registry.handleChanged('test', { added: [descriptor('x', true)] })];
    if (via === 'speech') {
      const { outcome } = await speechWhoseOpenFails(f, reannounce);
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.reason,
        "opening the channel for these words didn't complete: fixture lifecycle failure; the channel is selected for opening again, because its server lists it as open by default");
      // A server's own words keep their stop, so what follows is a sentence.
      const g = fixture();
      await g.registry.handleChanged('test', { added: [descriptor('x', false)] });
      const answered = await speechWhoseOpenFails(g, () => [g.registry.handleChanged('test', { added: [descriptor('x', true)] })],
        new McplRequestError('Opening x is not allowed here.', 'error-response'));
      assert.equal(answered.outcome.reason, "opening the channel for these words didn't complete: Opening x is not allowed here. " +
        'The channel is selected for opening again, because its server lists it as open by default');
    } else {
      const { answer } = await replyWhoseOpenFails(f, reannounce);
      assert.deepEqual(answer, { status: 'open-failed', channelId: 'x', serverId: 'test', label: 'x', opening: true, selectedForOpening: 'server-bootstrap' });
    }
    await tick(); await tick();
    assert.deepEqual(decision(f.registry), { state: 'open', source: 'server-bootstrap' },
      `${via}: the announcement the open's own record hid applies to the default put back`);
    assert.deepEqual(f.calls.map((c) => c.kind), ['close', 'open', 'open'],
      `${via}: the registration's close, the open that failed, then the queued work's open; nothing closes x`);
    assert.equal(f.isOpen(), true, via);
    assert.deepEqual(f.notices, [], `${via}: the failure itself says why, so no other notice`);
  }
});

test("when a reply's open fails after the subscription policy came to admit the channel, the default put back follows the policy, and the failure says so", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  const { answer } = await replyWhoseOpenFails(f, () => { f.registry.setSubscriptionPolicy('test', 'auto'); return []; });
  assert.deepEqual(answer, { status: 'open-failed', channelId: 'x', serverId: 'test', label: 'x', opening: true, selectedForOpening: 'subscription-policy' });
  assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-open-failed').map((t) => t.error),
    ['fixture lifecycle failure; the channel is selected for opening again, because the subscription policy admits it']);
  await tick(); await tick();
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'subscription-policy' });
  assert.equal(f.isOpen(), true);
  assert.deepEqual(f.notices, [], 'the failure says it, so no separate admission notice');
});

test("when a reply's open fails while its server is removed and added again as initially open, the default put back follows the new registration", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  const { answer, meanwhile } = await replyWhoseOpenFails(f, () => {
    f.registry.removeServer('test');
    return [f.registry.handleChanged('test', { added: [descriptor('x', true)] })];
  });
  void meanwhile;
  assert.equal(answer.status, 'open-failed');
  assert.equal(answer.selectedForOpening, 'server-bootstrap');
  await tick(); await tick();
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'server-bootstrap' });
  assert.deepEqual(f.calls.slice(f.calls.findIndex((c) => c.kind === 'open') + 1).map((c) => c.kind), ['open'],
    "the new registration's queued work carries the decision out, so the put-back queues nothing of its own");
  assert.equal(f.isOpen(), true);
});

test("when an open's server is removed and its channel comes back from a push while the open is out, the decision the put-back leaves is still carried out: work queued before the removal cancels instead", async () => {
  for (const policy of [true, false]) {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
    const { answer } = await replyWhoseOpenFails(f, () => {
      // A reconcile queued behind the open, then the removal that will cancel it.
      const reannounce = f.registry.handleChanged('test', { added: [descriptor('x', false)] });
      f.registry.removeServer('test');
      f.registry.ensureChannelRegistered('test', 'x');
      if (policy) f.registry.setSubscriptionPolicy('test', 'auto');
      return [reannounce];
    });
    await tick(); await tick();
    const after = f.calls.slice(f.calls.findIndex((c) => c.kind === 'open') + 1).map((c) => c.kind);
    if (policy) {
      assert.equal(answer.selectedForOpening, 'subscription-policy');
      assert.deepEqual(decision(f.registry), { state: 'open', source: 'subscription-policy' });
      assert.deepEqual(after, ['open'], 'the lifted decision is carried out after the cancelled work');
      assert.equal(f.isOpen(), true);
    } else {
      assert.equal(answer.selectedForOpening, undefined);
      assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
      assert.deepEqual(after, ['close'], "the put-back's close goes out, since the failed request may have reached the server");
    }
  }
});

test("a lifted put-back's queued open that fails is traced as an open that failed, and the decision stands", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  f.held.add('x');
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  f.registry.setSubscriptionPolicy('test', 'auto');
  f.pending.shift()!.fail();
  for (let i = 0; i < 20 && f.pending.length === 0; i++) await tick();
  assert.equal(f.pending.length, 1, "the queued work's open is out");
  f.pending.shift()!.fail();
  f.held.delete('x');
  await f.drain(reply);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal((await reply).selectedForOpening, 'subscription-policy');
  assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-reconcile-failed').map((t) => t.desired), ['open']);
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'subscription-policy' });
});

test("a failed open's put-back whose lift can't be recorded leaves the default, closed, and reports the open's own failure", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  const { outcome } = await speechWhoseOpenFails(f, () => {
    failAppend(f.registry, 1); // the put-back's record goes through; the lift's doesn't
    return [f.registry.handleChanged('test', { added: [descriptor('x', true)] })];
  });
  assert.equal(outcome.reason, "opening the channel for these words didn't complete: fixture lifecycle failure");
  await tick(); await tick();
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
  assert.deepEqual(f.calls.map((c) => c.kind), ['close', 'open', 'close'], 'the queued work carries out the close');
});

test("a failed open by speech that put back a machine's close isn't lifted by the server's announcement: only a pure default follows it", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await tick(); await tick();
  // A machine's close fails at the server, so x is decided closed with its
  // transport still open, and speech engages it.
  f.held.add('x');
  const close = f.machineClose();
  await tick();
  f.pending.shift()!.fail();
  f.held.delete('x');
  await f.drain(close);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' });
  const { outcome } = await speechWhoseOpenFails(f, () => [f.registry.handleChanged('test', { added: [descriptor('x', true)] })]);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, "opening the channel for these words didn't complete: fixture lifecycle failure", 'nothing selects it for opening again');
  await tick(); await tick();
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' }, "the machine's close stands");
});

test('speech that waits on a failed open into a channel a machine closed is refused, as the close is on record again', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await tick(); await tick();
  assert.equal(f.actual.get('x'), true);
  // A machine's close fails at the server, so x is decided closed with its
  // transport still open.
  f.held.add('x');
  const close = f.machineClose();
  await tick();
  f.pending.shift()!.fail();
  f.held.delete('x');
  await f.drain(close);
  assert.equal((await close).success, false);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' });

  f.held.add('x');
  const first = f.registry.publish('agent', 'first', { serverId: 'test', channelId: 'x' });
  await tick();
  assert.equal(f.pending.length, 1, "the first speech's open is out");
  const second = f.registry.publish('agent', 'second', { serverId: 'test', channelId: 'x' });
  await tick();
  f.pending.shift()!.fail();
  f.held.delete('x');
  await f.drain(first, second);
  assert.equal((await first).status, 'failed');
  assert.equal((await second).status, 'failed', 'the second speech waited on that open and is refused');
  assert.deepEqual(f.publishedWhileOpen, [], 'nothing is published into the channel the machine closed');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'subscription-gc' });
});

test("an open whose answer is lost after the server opened the channel is closed on the wire too, since its transport wasn't confirmed", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  f.held.add('x');
  const speech = f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' });
  await tick();
  const open = f.pending.shift()!;
  f.actual.set('x', true); // the server opened x ...
  open.fail();             // ... and its answer was lost, as on a timeout
  f.held.delete('x');
  const before = f.calls.length;
  await f.drain(speech);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal((await speech).status, 'failed');
  assert.deepEqual(f.calls.slice(before).map((c) => c.kind), ['close'], 'the put-back is carried out through the queue');
  assert.equal(f.actual.get('x'), false, "the server's transport is closed");
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
  assert.deepEqual(f.notices, []);
});

test("a reply on a server without channels.lifecycle writes no decision, so the agent's close stays the only record", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await tick(); await tick();
  f.setGrant(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle'));
  assert.equal((await f.tool('close')).success, false, 'the close itself is refused for the grant');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' }, "the agent's close is recorded");
  await f.registry.handleIncoming('test', { messages: [message()] });
  const log = recordLog(f.registry);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.registry.openIfClosedForSend('x', 'test')).status, 'already-open', 'its traffic showed it open, and nothing is tried');
  }
  await tick();
  assert.deepEqual(log, [], 'no record is written');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
});

test("speech into a channel that isn't open, on a server without channels.lifecycle, goes out and writes no decision", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  f.setGrant(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle'));
  const log = recordLog(f.registry);
  const outcome = await f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' });
  await tick();
  assert.equal(outcome.status, 'delivered', 'nothing opens there, and the words go into the channel as it stands');
  assert.equal(f.publishedWhileOpen.length, 1);
  assert.deepEqual(log, [], 'no record is written');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
});

test("the agent's channel_open over a channel its server opened at registration is the agent's decision, which a housekeeping close doesn't override", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await tick(); await tick();
  assert.equal(f.isOpen(), true);
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'server-bootstrap' });

  assert.equal(dataOf(await f.tool('open')).status, 'already open');
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'agent-tool' });
  const housekeeping = await f.registry.handleChannelToolCall(
    'channel_close', { serverId: 'test', channelId: 'x', source: 'housekeeping' }, { kind: 'module' },
  );
  assert.equal(housekeeping.success, false, "the agent's explicit open stands against housekeeping");
  assert.equal(f.isOpen(), true);
});

test("the agent's channel_close of a channel closed by default is recorded, so a later registration's initiallyOpen doesn't open it", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });

  assert.equal(dataOf(await f.tool('close')).status, 'already closed');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
  await f.drain(f.registry.handleChanged('test', { removed: ['x'], added: [descriptor('x', true)] }));
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' }, "the agent's close stands");
  assert.equal(f.isOpen(), false);
});

test("the agent's decline of a channel closed by default is recorded, so a later registration's initiallyOpen doesn't open it", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });

  const declined = await f.registry.handleChannelToolCall('channel_decline', { serverId: 'test', channelId: 'x', messageId: 'm1' });
  assert.equal(declined.success, true);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'invitation-declined' });
  await f.drain(f.registry.handleChanged('test', { removed: ['x'], added: [descriptor('x', true)] }));
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'invitation-declined' }, "the agent's decline stands");
  assert.equal(f.isOpen(), false);
});

test('a housekeeping close of a channel closed by default records nothing, and the channel stays undecided', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  const log = recordLog(f.registry);
  const housekeeping = await f.registry.handleChannelToolCall(
    'channel_close', { serverId: 'test', channelId: 'x', source: 'housekeeping' }, { kind: 'module' },
  );
  assert.equal(dataOf(housekeeping).status, 'already closed');
  assert.deepEqual(log, []);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
});

test("a module close outside the machine-close vocabulary is refused on a channel already closed too, where it got 'already closed'", async () => {
  // The source is checked before the "already closed" answer, since that
  // answer now records the decision with it.
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  const log = recordLog(f.registry);
  const gremlin = await f.registry.handleChannelToolCall(
    'channel_close', { serverId: 'test', channelId: 'x', source: 'gremlin-module' }, { kind: 'module' },
  );
  assert.equal(gremlin.success, false);
  assert.equal(gremlin.isError, true);
  assert.match(gremlin.error ?? '', /^Unknown machine close source 'gremlin-module'/);
  assert.deepEqual(log, []);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
});

test("the agent's channel_open twice over a channel speech opened writes one record", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  assert.equal((await f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' })).status, 'delivered');
  const log = recordLog(f.registry);
  assert.equal(dataOf(await f.tool('open')).status, 'already open');
  assert.equal(dataOf(await f.tool('open')).status, 'already open');
  assert.deepEqual(log, [{ desired: 'open', source: 'agent-tool' }]);
});

test("when putting back the decision a failed open replaced can't be recorded, speech's failure says the channel stays selected for opening", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  failAppend(f.registry, 1); // the open's own record goes through; the put-back's doesn't
  const closes = f.calls.filter((c) => c.kind === 'close').length;
  const { outcome } = await speechWhoseOpenFails(f);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /^opening the channel for these words didn't complete: fixture lifecycle failure; the channel stays selected for opening, because this host couldn't record undoing that: ENOSPC/);
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'opened-by-delivery' });
  await tick(); await tick();
  assert.equal(f.calls.filter((c) => c.kind === 'close').length, closes, 'no close is sent: the decision stays open');
});

test("channel_open and channel_close on a channel already so say what failed when the agent's decision can't be recorded", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  assert.equal((await f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' })).status, 'delivered');
  failAppend(f.registry);
  const opened = await f.tool('open');
  assert.equal(opened.success, false);
  assert.equal(opened.isError, true);
  assert.match(opened.error ?? '', /^Channel x is already open, but recording your decision to open it failed: ENOSPC/);

  const g = fixture();
  await g.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  failAppend(g.registry);
  const closed = await g.tool('close');
  assert.equal(closed.success, false);
  assert.equal(closed.isError, true);
  assert.match(closed.error ?? '', /^Channel x is already closed, but recording the decision to close it failed: ENOSPC/);
});

// The framework's half of a reply's failed open: what it tells the agent
// once the registry has answered a send's open. The registry's half, the
// put-back and `opening`, is pinned by the registry tests. The harness is a
// bare framework, as in checkpoint-attribution.
async function replyOpenFailedNotices(opts: {
  opening: boolean; directs: boolean; agentName?: string; live?: string[]; homes?: Array<[string, string]>; denied?: string[];
  selectedForOpening?: 'unrecorded' | 'server-bootstrap' | 'subscription-policy'; primary?: string; dropsDuring?: true;
  opened?: true;
}) {
  const agentName = opts.agentName ?? 'agent';
  const told: Array<{ text: string; metadata: unknown; forAgent?: string }> = [];
  const logged: string[] = [];
  // The server's id isn't its tool prefix, so the notice's inputs can't take
  // one for the other.
  const server = {
    id: 'chat-server',
    isConnected: true,
    async sendToolsList() { return { tools: [{ name: 'send_message', inputSchema: { type: 'object' } }] }; },
    async sendToolsCall() { return { content: [{ type: 'text', text: 'sent' }] }; },
  };
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplTools = [];
  framework.mcplToolFeatureSets = new Map();
  framework.mcplServerConfigs = new Map([['chat-server', { id: 'chat-server', toolPrefix: 'srv' }]]);
  framework.mcplServerRegistry = { getAllServers: () => [server], getServer: (id: string) => (id === 'chat-server' ? server : null) };
  framework.checkpointManager = null;
  framework.turnRouting = new Map();
  framework.openLogical = new Map();
  framework.agents = new Map((opts.live ?? [agentName]).map((name) => [name, { canUseTool: (tool: string) => !(opts.denied ?? []).includes(tool) }]));
  framework.usedEphemeralAgentNames = new Set();
  // A fork's home is a channel on the send's server.
  framework.conversationAgentHomes = new Map((opts.homes ?? []).map(([name, id]) => [name, { serverId: 'chat-server', channelId: id }]));
  framework.primaryAgentName = opts.primary;
  framework.emitTrace = () => {};
  framework.addMessage = (_participant: string, content: Array<{ text: string }>, metadata: unknown, routed?: { forAgent?: string }) => {
    told.push({ text: content[0]!.text, metadata, ...(routed ? { forAgent: routed.forAgent } : {}) });
    return 'm';
  };
  // A transport that drops while the open is out clears the server's grant
  // before the open's failure arrives (dropsDuring).
  let opened = false;
  framework.channelRegistry = {
    openIfClosedForSend: async () => {
      opened = true;
      if (opts.opened) return { status: 'opened', channelId: 'x', serverId: 'chat-server', label: '#x' };
      return { status: 'open-failed', channelId: 'x', serverId: 'chat-server', label: '#x', opening: opts.opening,
        ...(opts.selectedForOpening ? { selectedForOpening: opts.selectedForOpening } : {}) };
    },
    directsLifecycle: () => opts.directs && !(opts.dropsDuring && opened),
    // The send's own channel, which nobody closed, so its answer carries no note.
    resolveSendTarget: () => undefined,
    // The notice names the channel as the agent is shown it: here its id.
    nameShown: (channel: { channelId: string }) => channel.channelId,
  };
  const handled = (l: string) => l.includes('open-on-send failed') || l.includes('opened (send implies engagement)');
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await framework.refreshMcplTools();
    const sent = await new Promise<{ success?: boolean; error?: string }>((resolve) => {
      framework.pushEvent = (event: { type: string; result: { success?: boolean; error?: string } }) => {
        if (event.type === 'tool-result') resolve(event.result);
      };
      framework.dispatchMcplToolCall(agentName, { id: 'c1', name: 'srv--send_message', input: { channelId: 'x' } }, 'chat-server', 'srv');
    });
    assert.equal(sent.success, true, `the send went out: ${sent.error ?? ''}`);
    // The open's answer is handled once its console line is written.
    for (let i = 0; i < 50 && !logged.some(handled); i++) await tick();
  } finally {
    console.error = error;
  }
  assert.ok(logged.some(handled), 'the open was handled');
  return { told, logged };
}

test("a reply whose open would have opened the channel, and failed, tells the agent; a failed reconfirm, or a server without channels.lifecycle, tells it nothing", async () => {
  assert.deepEqual((await replyOpenFailedNotices({ opening: true, directs: true })).told, [{
    text: '[channels] Not open: #x (x). Your reply there went out, but opening the channel failed. channel_open tries again.',
    metadata: { system: true, kind: 'channel-notice' },
    forAgent: 'agent',
  }]);
  assert.deepEqual((await replyOpenFailedNotices({ opening: false, directs: true })).told, [],
    'a failed reconfirm of a channel already selected open changes nothing the agent was told');
  assert.deepEqual((await replyOpenFailedNotices({ opening: true, directs: false })).told, [],
    "where the server opens and closes its own channels, channel_open can't open one either");
  assert.deepEqual((await replyOpenFailedNotices({ opening: true, directs: true, dropsDuring: true })).told.map((t) => t.text), [
    '[channels] Not open: #x (x). Your reply there went out, but opening the channel failed. channel_open tries again.',
  ], "a transport that drops while the open is out clears the grant before the failure arrives: whether the host directs the lifecycle is read before the open");
  assert.deepEqual((await replyOpenFailedNotices({ opening: true, directs: true, selectedForOpening: 'unrecorded' })).told.map((t) => t.text), [
    "[channels] Not open: #x (x). Your reply there went out, but opening the channel failed. It stays selected for opening, because the host couldn't record undoing that: a later delivery or reconnect tries again, and channel_close withdraws that. channel_open tries again.",
  ], "where the put-back couldn't be recorded, as speech's failure says, in channel_open's own failure's words");
  assert.deepEqual((await replyOpenFailedNotices({ opening: true, directs: true, selectedForOpening: 'server-bootstrap' })).told.map((t) => t.text), [
    "[channels] Not open: #x (x). Your reply there went out, but opening the channel failed. It's selected for opening again, because its server lists it as open by default: the host tries again, and channel_close withdraws that.",
  ], "where the server's announcement lifted the default put back, the host tries again itself, so channel_open isn't named");
  assert.deepEqual((await replyOpenFailedNotices({ opening: true, directs: true, selectedForOpening: 'subscription-policy' })).told.map((t) => t.text), [
    "[channels] Not open: #x (x). Your reply there went out, but opening the channel failed. It's selected for opening again, because the subscription policy admits it: the host tries again, and channel_close withdraws that.",
  ], 'where the subscription policy lifted it');
});

test("the reply notice names channel_open and channel_close only where the agent it's addressed to can call them; where the replying agent has ended, no one is told unless the channel is selected for opening, and then the primary is, by name", async () => {
  const facts = '[channels] Not open: #x (x). Your reply there went out, but opening the channel failed.';
  const stays = " It stays selected for opening, because the host couldn't record undoing that: a later delivery or reconnect tries again";
  const fork = await replyOpenFailedNotices({ opening: true, directs: true, homes: [['agent', 'x']] });
  assert.deepEqual(fork.told.map((t) => t.text), [facts], "a conversation fork's channel_open is refused outright");

  const sendOnly = await replyOpenFailedNotices({ opening: true, directs: true, denied: ['channel_open'] });
  assert.deepEqual(sendOnly.told.map((t) => t.text), [facts], "an agent whose allowedTools leave channel_open out");

  const forkHome = await replyOpenFailedNotices({ opening: true, directs: true, homes: [['agent', 'x']], selectedForOpening: 'unrecorded' });
  assert.deepEqual(forkHome.told.map((t) => t.text), [facts + stays + ', and channel_close withdraws that.'],
    'a fork may close its home channel, though not open it');
  assert.equal((forkHome.told[0]!.metadata as { passOn?: { serverId?: unknown } }).passOn?.serverId, 'chat-server',
    "its inputs name the send's server, not its tool prefix");
  // A send that opens its channel tells the agent, and its inputs name the
  // send's server too.
  const sendOpened = await replyOpenFailedNotices({ opening: true, directs: true, homes: [['agent', 'x']], opened: true });
  assert.match(sendOpened.told[0]?.text ?? '', /^\[channels\] Now open: #x \(x\): your own message into the closed channel opened it\./);
  assert.equal((sendOpened.told[0]!.metadata as { passOn?: { serverId?: unknown } }).passOn?.serverId, 'chat-server');
  const forkElsewhere = await replyOpenFailedNotices({ opening: true, directs: true, homes: [['agent', 'y']], selectedForOpening: 'unrecorded' });
  assert.deepEqual(forkElsewhere.told.map((t) => t.text), [facts + stays + '.'],
    "a fork's channel_close is refused for a channel that isn't its home");
  const noOpen = await replyOpenFailedNotices({ opening: true, directs: true, denied: ['channel_open'], selectedForOpening: 'unrecorded' });
  assert.deepEqual(noOpen.told.map((t) => t.text), [facts + stays + ', and channel_close withdraws that.'],
    'an agent without channel_open is still told how to withdraw the selection');
  const noClose = await replyOpenFailedNotices({ opening: true, directs: true, denied: ['channel_close'], selectedForOpening: 'unrecorded' });
  assert.deepEqual(noClose.told.map((t) => t.text), [facts + stays + '. channel_open tries again.'],
    'an agent whose allowedTools leave channel_close out');

  const again = " It's selected for opening again, because its server lists it as open by default: the host tries again";
  const forkAgain = await replyOpenFailedNotices({ opening: true, directs: true, homes: [['agent', 'x']], selectedForOpening: 'server-bootstrap' });
  assert.deepEqual(forkAgain.told.map((t) => t.text), [facts + again + ', and channel_close withdraws that.'],
    'a fork told the server lifted its home channel may close it');

  const ended = await replyOpenFailedNotices({ opening: true, directs: true, live: ['primary'], primary: 'primary' });
  assert.deepEqual(ended.told, [], 'the channel stays closed, so nothing follows from the failure');
  assert.ok(ended.logged.some((l) => l.includes("agent has ended; not telling it that #x (x) couldn't be opened")));

  const endedFacts = "[channels] Not open: #x (x). A reply from agent went out there, but opening the channel failed; agent has ended.";
  const endedAgain = await replyOpenFailedNotices({ opening: true, directs: true, live: ['primary'], primary: 'primary', selectedForOpening: 'server-bootstrap' });
  assert.deepEqual(endedAgain.told, [{
    text: endedFacts + again + ', and channel_close withdraws that.',
    metadata: { system: true, kind: 'channel-notice', speaker: 'agent' },
  }], 'selected for opening, so the primary is told by name, unrouted, with advice judged for it');
  assert.ok(endedAgain.logged.some((l) => l === '[channel] reply open-failed notice -> the primary, by name (agent has ended): #x (x)'));
  const endedStays = await replyOpenFailedNotices({ opening: true, directs: true, live: ['primary'], primary: 'primary', selectedForOpening: 'unrecorded' });
  assert.deepEqual(endedStays.told.map((t) => t.text), [endedFacts + stays + ', and channel_close withdraws that. channel_open tries again.']);
  const endedPrimaryNoClose = await replyOpenFailedNotices({ opening: true, directs: true, live: ['primary'], primary: 'primary', denied: ['channel_close'], selectedForOpening: 'server-bootstrap' });
  assert.deepEqual(endedPrimaryNoClose.told.map((t) => t.text), [endedFacts + again + '.'],
    "the advice is judged for the primary, which can't close it, not for the agent that ended");
  const endedPrimaryNoOpen = await replyOpenFailedNotices({ opening: true, directs: true, live: ['primary'], primary: 'primary', denied: ['channel_open'], selectedForOpening: 'unrecorded' });
  assert.deepEqual(endedPrimaryNoOpen.told.map((t) => t.text), [endedFacts + stays + ', and channel_close withdraws that.'],
    "nor is channel_open named to a primary that can't call it");
  const endedPrimaryGone = await replyOpenFailedNotices({ opening: true, directs: true, live: ['other'], primary: 'gone', selectedForOpening: 'server-bootstrap' });
  assert.deepEqual(endedPrimaryGone.told, [], 'a primary named but not registered is no one to tell');
  const endedNoPrimary = await replyOpenFailedNotices({ opening: true, directs: true, live: [], selectedForOpening: 'server-bootstrap' });
  assert.deepEqual(endedNoPrimary.told, [], 'with no primary there is no one to tell');
  assert.ok(endedNoPrimary.logged.some((l) => l.includes("agent has ended, and there is no primary to tell that #x (x) couldn't be opened and is selected for opening")));
});

test("a reply notice with no agent named, or an empty name, goes out unrouted, with its advice judged for, and its log naming, the agent addMessage delivers to", () => {
  const facts = '[channels] Not open: #x (x). Your reply there went out, but opening the channel failed.';
  const stays = " It stays selected for opening, because the host couldn't record undoing that: a later delivery or reconnect tries again";
  const cases: Array<{
    why: string; name?: string; agents: Array<[string, string[]]>; primary: string | null;
    selectedForOpening?: 'unrecorded' | 'server-bootstrap' | 'subscription-policy';
    reader: string; text: string;
  }> = [
    { why: 'no name, the primary', agents: [['primary', []]], primary: 'primary', reader: 'primary', text: facts + ' channel_open tries again.' },
    { why: 'an empty name, the primary', name: '', agents: [['primary', []]], primary: 'primary', reader: 'primary', text: facts + ' channel_open tries again.' },
    { why: 'a primary without channel_open', agents: [['primary', ['channel_open']]], primary: 'primary', reader: 'primary', text: facts },
    { why: 'stays selected, a primary that can close', agents: [['primary', []]], primary: 'primary', selectedForOpening: 'unrecorded',
      reader: 'primary', text: facts + stays + ', and channel_close withdraws that. channel_open tries again.' },
    { why: 'stays selected, a primary without channel_close', agents: [['primary', ['channel_close']]], primary: 'primary', selectedForOpening: 'unrecorded',
      reader: 'primary', text: facts + stays + '. channel_open tries again.' },
    { why: 'selected again by the server, a primary that can open and close', agents: [['primary', []]], primary: 'primary',
      selectedForOpening: 'server-bootstrap', reader: 'primary',
      text: facts + " It's selected for opening again, because its server lists it as open by default: the host tries again, and channel_close withdraws that." },
    { why: 'no primary: the first registered agent', agents: [['first', ['channel_open']], ['second', []]], primary: null,
      reader: 'first', text: facts },
    { why: 'a primary that is not the first registered agent', agents: [['first', ['channel_open']], ['second', []]], primary: 'second',
      reader: 'second', text: facts + ' channel_open tries again.' },
  ];
  for (const c of cases) {
    const told: Array<{ text: string; forAgent?: string }> = [];
    const logged: string[] = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.agents = new Map(c.agents.map(([name, denied]) => [name, { name, canUseTool: (tool: string) => !denied.includes(tool) }]));
    framework.primaryAgentName = c.primary;
    framework.usedEphemeralAgentNames = new Set();
    framework.conversationAgentHomes = new Map();
    framework.addMessage = (_participant: string, content: Array<{ text: string }>, _metadata: unknown, routed?: { forAgent?: string }) => {
      told.push({ text: content[0]!.text, ...(routed ? { forAgent: routed.forAgent } : {}) });
      return 'm';
    };
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      framework.recordReplyOpenFailedNotice(c.name, 'srv', { channelId: 'x', label: '#x' }, c.selectedForOpening);
    } finally {
      console.error = error;
    }
    assert.deepEqual(told, [{ text: c.text }], `${c.why}: no forAgent, so addMessage delivers it to ${c.reader}`);
    assert.deepEqual(logged, [`[channel] reply open-failed notice -> ${c.reader}: #x (x)`], `${c.why}: the log names ${c.reader}`);
  }
});

test("where a reply's reader can't close a channel selected for opening, the primary is told by name too, if it can close it", () => {
  const facts = '[channels] Not open: #x (x). Your reply there went out, but opening the channel failed.';
  const stays = " It stays selected for opening, because the host couldn't record undoing that: a later delivery or reconnect tries again";
  const again = " It's selected for opening again, because its server lists it as open by default: the host tries again";
  const byName = (first: string, again: string) => `[channels] Not open: #x (x). A reply from ${first} went out there, but opening the channel failed, and ${again} can't close it.`;
  const forkByName = byName('your fork in y, named fork,', 'that fork');
  const told = (primary: string) => ` ${primary} has been told, and can withdraw that.`;
  const cases: Array<{
    why: string; name: string; agents: Array<[string, string[]]>; homes?: Array<[string, string]>; primary: string | null;
    selectedForOpening?: 'unrecorded' | 'server-bootstrap';
    told: Array<{ text: string; metadata: unknown; forAgent?: string }>;
  }> = [
    { why: 'a fork away from its home, selected again by its server', name: 'fork', agents: [['fork', []], ['primary', []]], homes: [['fork', 'y']],
      primary: 'primary', selectedForOpening: 'server-bootstrap',
      told: [
        { text: forkByName + again + ', and channel_close withdraws that.', metadata: { system: true, kind: 'channel-notice', speaker: 'fork' } },
        { text: facts + again + '.' + told('Your primary'), metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' },
      ] },
    { why: "an agent whose allowedTools leave channel_close out, the put-back unrecorded", name: 'helper', agents: [['helper', ['channel_close']], ['primary', []]],
      primary: 'primary', selectedForOpening: 'unrecorded',
      told: [
        { text: byName('helper', 'helper') + stays + ', and channel_close withdraws that. channel_open tries again.', metadata: { system: true, kind: 'channel-notice', speaker: 'helper' } },
        { text: facts + stays + '.' + told('primary') + ' channel_open tries again.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'helper' },
      ] },
    { why: 'a reader who can close it, beside a primary that can too', name: 'helper', agents: [['helper', []], ['primary', []]],
      primary: 'primary', selectedForOpening: 'server-bootstrap',
      // Its inputs, so a release that finds it unread tells the primary.
      told: [{ text: facts + again + ', and channel_close withdraws that.', forAgent: 'helper', metadata: { system: true, kind: 'channel-notice',
        passOn: { notice: 'reply-open-failed', serverId: 'srv', channel: { channelId: 'x', label: '#x' }, selectedForOpening: 'server-bootstrap' } } }] },
    { why: 'a reader who can close it, the put-back unrecorded', name: 'helper', agents: [['helper', []], ['primary', []]],
      primary: 'primary', selectedForOpening: 'unrecorded',
      told: [{ text: facts + stays + ', and channel_close withdraws that. channel_open tries again.', forAgent: 'helper', metadata: { system: true, kind: 'channel-notice',
        passOn: { notice: 'reply-open-failed', serverId: 'srv', channel: { channelId: 'x', label: '#x' }, selectedForOpening: 'unrecorded' } } }] },
    { why: "a primary that can close it but not open it, the put-back unrecorded", name: 'fork', agents: [['fork', []], ['primary', ['channel_open']]],
      homes: [['fork', 'y']], primary: 'primary', selectedForOpening: 'unrecorded',
      told: [
        { text: forkByName + stays + ', and channel_close withdraws that.', metadata: { system: true, kind: 'channel-notice', speaker: 'fork' } },
        { text: facts + stays + '.' + told('Your primary'), metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' },
      ] },
    { why: 'a fork that has ended, its home still known while it is released, the channel selected again', name: 'fork', agents: [['primary', []]],
      homes: [['fork', 'y']], primary: 'primary', selectedForOpening: 'server-bootstrap',
      told: [{ text: '[channels] Not open: #x (x). A reply from your fork in y, named fork, went out there, but opening the channel failed; that fork has ended.' +
        again + ', and channel_close withdraws that.', metadata: { system: true, kind: 'channel-notice', speaker: 'fork' } }] },
    { why: 'a fork away from its home, the channel left closed', name: 'fork', agents: [['fork', []], ['primary', []]], homes: [['fork', 'y']],
      primary: 'primary',
      told: [{ text: facts, metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' }] },
    { why: "a primary that can't close it either", name: 'fork', agents: [['fork', []], ['primary', ['channel_close']]], homes: [['fork', 'y']],
      primary: 'primary', selectedForOpening: 'server-bootstrap',
      told: [{ text: facts + again + '.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' }] },
    { why: 'no primary', name: 'fork', agents: [['fork', []]], homes: [['fork', 'y']], primary: null, selectedForOpening: 'server-bootstrap',
      told: [{ text: facts + again + '.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' }] },
    { why: "the primary itself, without channel_close", name: 'primary', agents: [['primary', ['channel_close']]], primary: 'primary', selectedForOpening: 'unrecorded',
      told: [{ text: facts + stays + '. channel_open tries again.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'primary' }] },
  ];
  for (const c of cases) {
    const told: Array<{ text: string; metadata: unknown; forAgent?: string }> = [];
    const logged: string[] = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.agents = new Map(c.agents.map(([name, denied]) => [name, { name, canUseTool: (tool: string) => !denied.includes(tool) }]));
    framework.primaryAgentName = c.primary;
    framework.usedEphemeralAgentNames = new Set();
    framework.conversationAgentHomes = new Map((c.homes ?? []).map(([name, id]) => [name, { serverId: 'srv', channelId: id }]));
    // Forks are made where conversations are routed, here from the primary.
    framework.conversationRouter = c.homes ? { templateAgent: 'primary' } : undefined;
    framework.addMessage = (_participant: string, content: Array<{ text: string }>, metadata: unknown, routed?: { forAgent?: string }) => {
      told.push({ text: content[0]!.text, metadata, ...(routed ? { forAgent: routed.forAgent } : {}) });
      return 'm';
    };
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      framework.recordReplyOpenFailedNotice(c.name, 'srv', { channelId: 'x', label: '#x' }, c.selectedForOpening);
    } finally {
      console.error = error;
    }
    assert.deepEqual(told, c.told, c.why);
    if (c.told.length === 2) {
      assert.ok(logged.includes(`[channel] reply open-failed notice -> the primary, by name (${c.name} can't close it): #x (x)`), `${c.why}: the log says why`);
    }
  }
});

// The opened notice follows the reply notice's rule: channel_close is named
// only where the agent it's addressed to can call it for every channel named
// (other residents of one slot may read it too, #291; a fork's seed leaves it
// out), and where an agent's send opened a channel it can't close, the
// primary is told by name too, if it can close it. The reader's notice
// carries its inputs only where it was told it can close the channels, so a
// release passes on only that.
test('the opened notice names channel_close only where the agent it\'s addressed to can call it, says what the channel delivers only to the agent that holds its traffic, and tells the primary by name where the agent whose send opened it can\'t close it', () => {
  // What the channel delivers: said to the agent whose window holds its
  // traffic. Where conversations are routed (router), that's a fork for its
  // home alone; elsewhere, the agent addMessage delivers to.
  const optOut = " What an open channel brings you is up to its server: some send every message in it, and others only what addresses you unless you're subscribed to it; their own tools can change that.";
  const close = " If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.";
  const closeMany = " If you don't want one of them, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.";
  const own = '[channels] Now open: #x (x): your own message into the closed channel opened it.';
  const opened = (passOn: unknown) => ({ system: true, kind: 'channel-notice', passOn });
  const fromReply = { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: [{ channelId: 'x', label: '#x' }] };
  const cases: Array<{
    why: string; name?: string; cause?: 'opened-by-reply' | 'subscription-policy'; channels?: Array<{ channelId: string; label?: string }>;
    agents: Array<[string, string[]]>; homes?: Array<[string, string]>; labels?: Array<[string, string]>; isolated?: string[];
    router?: boolean; template?: string; expired?: string[]; subconscious?: string; primary: string | null;
    told: Array<{ text: string; metadata: unknown; forAgent?: string }>;
  }> = [
    { why: "a second resident that can close it, which reads the residents' shared slot", name: 'helper', agents: [['helper', []], ['primary', []]], primary: 'primary',
      told: [{ text: own + optOut + close, metadata: opened(fromReply), forAgent: 'helper' }] },
    { why: 'a run that can close it, whose store is its own and holds no channel traffic', name: 'run', agents: [['run', []], ['primary', []]], isolated: ['run'], primary: 'primary',
      told: [{ text: own + close, metadata: opened(fromReply), forAgent: 'run' }] },
    { why: 'a fork away from its home', name: 'fork', agents: [['fork', []], ['primary', []]], homes: [['fork', 'y']], router: true, primary: 'primary',
      told: [
        { text: "[channels] Now open: #x (x): a message from your fork in y, named fork, into the closed channel opened it, and that fork can't close it." + close,
          metadata: { system: true, kind: 'channel-notice', speaker: 'fork' } },
        { text: own + ' Your primary has been told and can close it.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' },
      ] },
    { why: 'a fork away from a home the registry labels', name: 'fork', agents: [['fork', []], ['primary', []]], homes: [['fork', 'y']], labels: [['y', '#dm-y']], router: true, primary: 'primary',
      told: [
        { text: "[channels] Now open: #x (x): a message from your fork in #dm-y (y), named fork, into the closed channel opened it, and that fork can't close it." + close,
          metadata: { system: true, kind: 'channel-notice', speaker: 'fork' } },
        { text: own + ' Your primary has been told and can close it.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' },
      ] },
    { why: "a fork made from a template that isn't the primary", name: 'fork', agents: [['fork', []], ['primary', []], ['other', []]], homes: [['fork', 'y']],
      router: true, template: 'other', primary: 'primary',
      told: [
        { text: "[channels] Now open: #x (x): a message from the fork in y, named fork, into the closed channel opened it, and that fork can't close it." + close,
          metadata: { system: true, kind: 'channel-notice', speaker: 'fork' } },
        { text: own + ' primary has been told and can close it.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' },
      ] },
    { why: 'a fork at its home', name: 'fork', agents: [['fork', []], ['primary', []]], homes: [['fork', 'x']], router: true, primary: 'primary',
      told: [{ text: own + optOut + close, metadata: opened(fromReply), forAgent: 'fork' }] },
    { why: 'a fork at its home whose binding the sweep has ended, closing: its home routes to it no more', name: 'fork', agents: [['fork', []], ['primary', []]],
      homes: [['fork', 'x']], router: true, expired: ['fork'], primary: 'primary',
      told: [{ text: own + close, metadata: opened(fromReply), forAgent: 'fork' }] },
    { why: 'a fork at its home, which the router has bound to a newer fork since: its home routes to that one', name: 'fork',
      agents: [['fork', []], ['newer', []], ['primary', []]], homes: [['fork', 'x'], ['newer', 'x']], router: true, primary: 'primary',
      told: [{ text: own + close, metadata: opened(fromReply), forAgent: 'fork' }] },
    { why: 'the subconscious, which reads the shared slot through its merged view', name: 'sub', agents: [['sub', []], ['primary', []]], subconscious: 'sub', primary: 'primary',
      told: [{ text: own + optOut + close, metadata: opened(fromReply), forAgent: 'sub' }] },
    { why: 'a second resident whose allowedTools leave channel_close out', name: 'helper', agents: [['helper', ['channel_close']], ['primary', []]], primary: 'primary',
      told: [
        { text: "[channels] Now open: #x (x): a message from helper into the closed channel opened it, and helper can't close it." + optOut + close,
          metadata: { system: true, kind: 'channel-notice', speaker: 'helper' } },
        { text: own + optOut + ' primary has been told and can close it.', metadata: { system: true, kind: 'channel-notice' }, forAgent: 'helper' },
      ] },
    { why: "a primary that can't close it either", name: 'fork', agents: [['fork', []], ['primary', ['channel_close']]], homes: [['fork', 'y']], router: true, primary: 'primary',
      told: [{ text: own, metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' }] },
    { why: 'a primary named but not registered', name: 'fork', agents: [['fork', []], ['other', []]], homes: [['fork', 'y']], router: true, primary: 'gone',
      told: [{ text: own, metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' }] },
    { why: 'the primary itself, without channel_close', name: 'primary', agents: [['primary', ['channel_close']]], primary: 'primary',
      told: [{ text: own + optOut, metadata: { system: true, kind: 'channel-notice' }, forAgent: 'primary' }] },
    { why: "several channels, one away from a fork's home", name: 'fork', channels: [{ channelId: 'y', label: '#y' }, { channelId: 'x', label: '#x' }],
      agents: [['fork', []], ['primary', []]], homes: [['fork', 'y']], router: true, primary: 'primary',
      told: [
        { text: "[channels] Now open: #y (y), #x (x): a message from your fork in y, named fork, into the closed channel opened it, and that fork can't close them." + closeMany,
          metadata: { system: true, kind: 'channel-notice', speaker: 'fork' } },
        { text: '[channels] Now open: #y (y), #x (x): your own message into the closed channel opened it. Your primary has been told and can close them.',
          metadata: { system: true, kind: 'channel-notice' }, forAgent: 'fork' },
      ] },
    { why: 'a policy admission, to the primary that can close it', cause: 'subscription-policy', agents: [['primary', []]], primary: 'primary',
      // Addressed to no agent of its own, so it carries no inputs to pass on.
      told: [{ text: "[channels] Selected for opening by subscription policy: #x (x). The host opens it, and if that fails, tries again when its server next registers it; channel_list shows whether it's open yet." + optOut + close,
        metadata: { system: true, kind: 'channel-notice' } }] },
    { why: 'a policy admission where conversations are routed, to the primary, whose window holds no channel traffic', cause: 'subscription-policy', agents: [['primary', []]], router: true, primary: 'primary',
      told: [{ text: "[channels] Selected for opening by subscription policy: #x (x). The host opens it, and if that fails, tries again when its server next registers it; channel_list shows whether it's open yet." + close,
        metadata: { system: true, kind: 'channel-notice' } }] },
    { why: "a policy admission, to a primary that can't close it", cause: 'subscription-policy', agents: [['primary', ['channel_close']]], primary: 'primary',
      told: [{ text: "[channels] Selected for opening by subscription policy: #x (x). The host opens it, and if that fails, tries again when its server next registers it; channel_list shows whether it's open yet." + optOut,
        metadata: { system: true, kind: 'channel-notice' } }] },
    { why: "a policy admission with no primary, to the first agent, a run whose store is its own, which can't close it", cause: 'subscription-policy',
      agents: [['worker', ['channel_close']]], isolated: ['worker'], primary: null,
      told: [{ text: "[channels] Selected for opening by subscription policy: #x (x). The host opens it, and if that fails, tries again when its server next registers it; channel_list shows whether it's open yet." + optOut,
        metadata: { system: true, kind: 'channel-notice' } }] },
    { why: "an agent that has ended, with a primary that can't close it", name: 'gone', agents: [['primary', ['channel_close']]], primary: 'primary',
      told: [{ text: '[channels] Now open: #x (x): a message from gone into the closed channel opened it; gone has ended.' + optOut,
        metadata: { system: true, kind: 'channel-notice', speaker: 'gone' } }] },
    { why: 'an agent that has ended, where conversations are routed', name: 'gone', agents: [['primary', []]], router: true, primary: 'primary',
      told: [{ text: '[channels] Now open: #x (x): a message from gone into the closed channel opened it; gone has ended.' + close,
        metadata: { system: true, kind: 'channel-notice', speaker: 'gone' } }] },
  ];
  for (const c of cases) {
    const told: Array<{ text: string; metadata: unknown; forAgent?: string }> = [];
    const logged: string[] = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.agents = new Map(c.agents.map(([name, denied]) => [name, { name, canUseTool: (tool: string) => !denied.includes(tool) }]));
    framework.primaryAgentName = c.primary;
    framework.usedEphemeralAgentNames = new Set();
    framework.conversationAgentHomes = new Map((c.homes ?? []).map(([name, id]) => [name, { serverId: 'srv', channelId: id }]));
    // Each fork is bound to its home, unless the sweep has ended its binding;
    // of two forks with one home, the router binds the later.
    const bound = new Map((c.homes ?? []).filter(([fork]) => !(c.expired ?? []).includes(fork)).map(([fork, home]) => [home, fork]));
    framework.conversationRouter = c.router
      ? { templateAgent: c.template ?? 'primary', getBinding: (ref: { channelId: string }) => (bound.has(ref.channelId) ? { channelId: ref.channelId, agentName: bound.get(ref.channelId) } : undefined) }
      : undefined;
    framework.subconsciousAgentName = c.subconscious;
    // Residents, and the subconscious through its merged view, read one shared
    // slot; a fork's store, or a run's, is its own.
    framework.sharedSlotAgents = new Set([...framework.agents.values()]
      .filter((a: { name: string }) => !framework.conversationAgentHomes.has(a.name) && !(c.isolated ?? []).includes(a.name)));
    const labels = new Map(c.labels ?? []);
    framework.channelRegistry = {
      getDescriptor: (ref: { channelId: string }) => (labels.has(ref.channelId) ? { id: ref.channelId, label: labels.get(ref.channelId) } : undefined),
      nameShown: (ref: { channelId: string }) => ref.channelId,
    };
    framework.addMessage = (_participant: string, content: Array<{ text: string }>, metadata: unknown, routed?: { forAgent?: string }) => {
      told.push({ text: content[0]!.text, metadata, ...(routed ? { forAgent: routed.forAgent } : {}) });
      return 'm';
    };
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      framework.recordChannelAutoOpenNotice(c.name, 'srv', c.channels ?? [{ channelId: 'x', label: '#x' }], c.cause ?? 'opened-by-reply');
    } finally {
      console.error = error;
    }
    assert.deepEqual(told, c.told, c.why);
    if (c.told.length === 2) {
      assert.ok(logged.some((l) => l.startsWith(`[channel] auto-open notice (opened-by-reply) -> the primary, by name (${c.name} can't close`)), `${c.why}: the log says why`);
    }
  }
});

// Each notice is written on its own: one that can't be written leaves the
// other to be written still. The primary's is written first, and the
// reader's says the primary was told only where the primary's landed.
test("each channel notice is written on its own, and the reader's says the primary was told only where the primary's landed, for both notices", () => {
  for (const write of ['opened', 'reply'] as const) {
    for (const refused of ['reader', 'primary'] as const) {
      const told: Array<{ text: string; forAgent?: string }> = [];
      const logged: string[] = [];
      const framework = Object.create(AgentFramework.prototype) as any;
      framework.agents = new Map([['fork', { name: 'fork', canUseTool: () => true }], ['primary', { name: 'primary', canUseTool: () => true }]]);
      framework.primaryAgentName = 'primary';
      framework.usedEphemeralAgentNames = new Set();
      framework.conversationAgentHomes = new Map([['fork', { serverId: 'srv', channelId: 'y' }]]);
      framework.conversationRouter = { templateAgent: 'primary' };
      framework.addMessage = (_participant: string, content: Array<{ text: string }>, _metadata: unknown, routed?: { forAgent?: string }) => {
        // The reader's notice is addressed to the fork; the primary's to no one.
        if ((refused === 'reader') === !!routed?.forAgent) throw new Error('store refused the write');
        told.push({ text: content[0]!.text, ...(routed?.forAgent ? { forAgent: routed.forAgent } : {}) });
        return 'm';
      };
      const error = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        if (write === 'opened') framework.recordChannelAutoOpenNotice('fork', 'srv', [{ channelId: 'x', label: '#x' }], 'opened-by-reply');
        else framework.recordReplyOpenFailedNotice('fork', 'srv', { channelId: 'x', label: '#x' }, 'server-bootstrap');
      } finally {
        console.error = error;
      }
      const why = `${write}, the ${refused}'s write refused`;
      assert.equal(told.length, 1, `${why}: the other notice is written`);
      if (refused === 'reader') {
        assert.equal(told[0]!.forAgent, undefined, why);
        assert.match(told[0]!.text, /that fork can't close it/, why);
      } else {
        assert.equal(told[0]!.forAgent, 'fork', why);
        assert.equal(told[0]!.text, write === 'opened'
          ? '[channels] Now open: #x (x): your own message into the closed channel opened it.'
          : "[channels] Not open: #x (x). Your reply there went out, but opening the channel failed. It's selected for opening again, because its server lists it as open by default: the host tries again.",
        `${why}: the reader isn't told the primary was`);
      }
      assert.ok(logged.some((l) => l.startsWith(write === 'opened' ? 'recordChannelAutoOpenNotice failed:' : 'recordReplyOpenFailedNotice failed:')),
        `${why}: the failure is logged`);
    }
  }
});

// A release finds a channel notice its reader could act on unread: the
// primary is told in its place, in the words the notice's builder gives an
// agent that has ended, judged for the primary. A notice whose inputs don't
// read back as this build writes them, or that carries none, isn't passed on.
test("a channel notice's inputs give the primary's by-name notice once its reader has ended, and malformed ones give none", () => {
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.agents = new Map([['primary', { name: 'primary', canUseTool: (tool: string) => tool !== 'channel_open' }]]);
  framework.primaryAgentName = 'primary';
  framework.usedEphemeralAgentNames = new Set();
  framework.conversationAgentHomes = new Map();
  // Every channel still as the notice says: open, or still waiting to open.
  framework.channelRegistry = { getDesiredState: () => 'open', isChannelOpen: () => false, nameShown: (ref: { channelId: string }) => ref.channelId };
  const error = console.error;
  console.error = () => {};
  try {
    const reply = framework.noticeForPrimary('gone', { system: true, kind: 'channel-notice',
      passOn: { notice: 'reply-open-failed', serverId: 'srv', channel: { channelId: 'x', label: '#x' }, selectedForOpening: 'unrecorded' } });
    assert.deepEqual(reply?.content, [{ type: 'text', text:
      "[channels] Not open: #x (x). A reply from gone went out there, but opening the channel failed; gone has ended. " +
      "It stays selected for opening, because the host couldn't record undoing that: a later delivery or reconnect tries again, and channel_close withdraws that." }],
      "judged for the primary, which can close it and can't call channel_open");
    assert.deepEqual(reply?.metadata, { system: true, kind: 'channel-notice', speaker: 'gone' });
    for (const passOn of [
      undefined,
      { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: [] },
      { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-whim', channels: [{ channelId: 'x' }] },
      { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: [{ channelId: '' }] },
      { notice: 'reply-open-failed', serverId: 'srv', channel: { channelId: 'x' } },
      { notice: 'reply-open-failed', serverId: 'srv', channel: { channelId: 'x' }, selectedForOpening: 'maybe' },
      { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: [{ channelId: 7 }] },
      { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: 'x' },
      { notice: 'channel-opened', serverId: 'srv', cause: 'subscription-policy', channels: [{ channelId: 'x' }] },
      { notice: 'reply-open-failed', serverId: 'srv', channel: null, selectedForOpening: 'unrecorded' },
      { notice: 'something-else', serverId: 'srv' },
      // Each channel is checked on its own server, so a notice must name one.
      { notice: 'channel-opened', cause: 'opened-by-reply', channels: [{ channelId: 'x' }] },
      { notice: 'channel-opened', serverId: '', cause: 'opened-by-reply', channels: [{ channelId: 'x' }] },
      { notice: 'reply-open-failed', serverId: 7, channel: { channelId: 'x' }, selectedForOpening: 'unrecorded' },
    ]) {
      assert.equal(framework.noticeForPrimary('gone', { system: true, kind: 'channel-notice', ...(passOn ? { passOn } : {}) }), null, JSON.stringify(passOn));
    }
    assert.equal(framework.noticeForPrimary('gone', { system: true, kind: 'routing-notice', passOn: { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: [{ channelId: 'x' }] } }), null,
      'only a channel notice');
    // A channel with no label, or one whose label isn't text, is named by its
    // id, and so is one whose label is its id.
    const unlabeled = framework.noticeForPrimary('gone', { system: true, kind: 'channel-notice',
      passOn: { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-delivery', channels: [{ channelId: 'x', label: 9 }] } });
    assert.match(unlabeled?.content[0]?.text ?? '', /^\[channels\] Now open: x: a message from gone into the closed channel opened it; gone has ended\./);
    const labelIsId = framework.noticeForPrimary('gone', { system: true, kind: 'channel-notice',
      passOn: { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-delivery', channels: [{ channelId: 'x', label: 'x' }] } });
    assert.match(labelIsId?.content[0]?.text ?? '', /^\[channels\] Now open: x: a message from gone into the closed channel opened it; gone has ended\./);
  } finally {
    console.error = error;
  }
});

test("a reply's open that only reconfirms a tuned-out channel's transport, and fails, isn't one that would have opened it", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  f.registry.enterTuneOut('test', 'x', {
    epochId: 'kept-epoch', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
  }, 'agent-tool');
  f.held.add('x');
  const retarget = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
  await tick();
  f.pending.shift()!.fail();
  await retarget;
  assert.equal(f.isOpen(), false);
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  f.pending.shift()!.fail();
  f.held.delete('x');
  assert.deepEqual(await reply, { status: 'open-failed', channelId: 'x', serverId: 'test', label: 'x', opening: false });
  assert.equal(f.registry.getDesiredState('test', 'x'), 'tuned-out');
});

test("a reply's open that only reconfirms a channel selected open, and fails, isn't one that would have opened it", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
  f.held.add('x');
  const retarget = f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
  await tick();
  f.pending.shift()!.fail();
  await retarget;
  assert.equal(f.isOpen(), false);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open');
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  f.pending.shift()!.fail();
  f.held.delete('x');
  assert.deepEqual(await reply, { status: 'open-failed', channelId: 'x', serverId: 'test', label: 'x', opening: false });
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open', 'the decision stands');
});

test("a reply that waits on a queued close, which leaves the channel closed, isn't an opening that failed: nothing was opened", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  await tick(); await tick();
  assert.equal(f.isOpen(), true);
  f.held.add('x');
  const closed = f.tool('close');
  await tick();
  const reply = f.registry.openIfClosedForSend('x', 'test');
  await tick();
  f.held.delete('x');
  const before = f.calls.length;
  await f.drain(closed, reply);
  assert.deepEqual(await reply, { status: 'stays-closed', channelId: 'x', serverId: 'test', label: 'x' });
  assert.deepEqual(f.calls.slice(before).filter((c) => c.kind === 'open'), [], 'the reply sent no open');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
});

test("a reply into a channel whose server is gone writes no decision and queues no close", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  const log = recordLog(f.registry);
  const calls = f.calls.length;
  // The server is gone while its channel is still registered.
  (f.registry as unknown as { serverRegistry: { getServer: () => undefined } }).serverRegistry = { getServer: () => undefined };
  const answer = await f.registry.openIfClosedForSend('x', 'test');
  await tick(); await tick();
  assert.equal(answer.status, 'open-failed');
  assert.deepEqual(f.traces.filter((t) => t.type === 'mcpl:channel-open-failed').map((t) => t.error), ['the "test" server isn\'t connected, and this host won\'t reconnect to it on its own'],
    'the failure names the missing server, not a missing grant');
  assert.deepEqual(log, [], 'nothing to put back, and no close to queue');
  assert.equal(f.calls.length, calls);
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'default-closed' });
});

test("the agent's channel_close over its own decline is recorded: the latest deliberate close is the one on record", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  const declined = await f.registry.handleChannelToolCall('channel_decline', { serverId: 'test', channelId: 'x', messageId: 'm1' });
  assert.equal(declined.success, true);
  const log = recordLog(f.registry);
  const closed = await f.tool('close');
  assert.equal(dataOf(closed).status, 'already closed');
  assert.deepEqual(log, [{ desired: 'closed', source: 'agent-tool' }], 'the latest deliberate close is the one on record');
  assert.deepEqual(decision(f.registry), { state: 'closed', source: 'agent-tool' });
});

test("channel_open on a server without channels.lifecycle still records the agent's decision, though its open fails", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  await tick(); await tick();
  f.setGrant(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle'));
  const opened = await f.tool('open');
  assert.equal(opened.success, false);
  assert.match(opened.error ?? '', /^This host isn't permitted to open or close the "test" server's channels/);
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'agent-tool' }, "the agent's own open stays selected (#210), unlike speech's");
});

test("the agent's channel_open after a lost answer waits behind the put-back's close in the channel's queue", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  f.held.add('x');
  const speech = f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' });
  await tick();
  const open = f.pending.shift()!;
  const before = f.calls.length;
  f.actual.set('x', true); // the server opened x, and its answer was lost
  open.fail();
  await tick(); await tick();
  assert.equal((await speech).status, 'failed');
  assert.equal(f.pending.length, 1, "the put-back's close is out");
  const reopened = f.tool('open');
  await tick(); await tick();
  assert.equal(f.pending.length, 1, "the agent's open waits for that close: one request per channel at a time");
  f.held.delete('x');
  await f.drain(reopened);
  assert.equal((await reopened).success, true);
  const after = f.calls.slice(before).map((c) => c.kind);
  assert.equal(after[0], 'close', `the put-back's close goes first: ${JSON.stringify(after)}`);
  assert.equal(after.at(-1), 'open', `and the agent's open after it: ${JSON.stringify(after)}`);
  assert.equal(f.actual.get('x'), true);
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'agent-tool' });
});

test("the agent's channel_open over a channel speech opened is the agent's decision, which a housekeeping close doesn't override", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', false)] });
  assert.equal((await f.registry.publish('agent', 'words', { serverId: 'test', channelId: 'x' })).status, 'delivered');
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'opened-by-delivery' });

  assert.equal((await f.tool('open')).success, true);
  assert.deepEqual(decision(f.registry), { state: 'open', source: 'agent-tool' });
  const housekeeping = await f.registry.handleChannelToolCall(
    'channel_close', { serverId: 'test', channelId: 'x', source: 'housekeeping' }, { kind: 'module' },
  );
  assert.equal(housekeeping.success, false);
  assert.match(housekeeping.error ?? '', /was explicitly opened \(source: agent-tool\)/);
  assert.equal(f.isOpen(), true);
});

// A channel only a push has registered (ensureChannelRegistered) starts with
// its transport unknown, as a registration's does: after a restart the server
// may still hold a channel an earlier process opened. Its traffic shows it
// open when it's decided open or tuned out, since it has no target a retarget
// could have left behind. In each test below the server holds it open.

test('a close of a channel only a push has registered, decided closed before a restart, is sent to the server, not answered as already closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-registered-close-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try {
    const earlier = fixture(undefined, store);
    earlier.registry.ensureChannelRegistered('test', 'x', 'x');
    assert.equal((await earlier.tool('close')).success, true);

    // A decision kept from an earlier process says nothing about the transport.
    const f = fixture(undefined, store);
    f.actual.set('x', true);
    f.registry.ensureChannelRegistered('test', 'x', 'x');
    assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
    const result = await f.tool('close');
    assert.equal(result.success, true);
    assert.equal(dataOf(result).status, 'closed');
    assert.deepEqual(f.calls.map((c) => [c.kind, c.id]), [['close', 'x']]);
    assert.equal(f.actual.get('x'), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a decline in a channel only a push has registered, after its traffic, sends its close through the lifecycle queue', async () => {
  const f = fixture();
  f.actual.set('x', true);
  f.registry.ensureChannelRegistered('test', 'x', 'x');
  // With nothing decided, its traffic doesn't show it open.
  await f.registry.handleIncoming('test', { messages: [message()] });
  assert.equal(f.isOpen(), false);
  const result = await f.registry.handleChannelToolCall('channel_decline', { serverId: 'test', channelId: 'x', messageId: 'm1' });
  assert.equal(result.success, true);
  assert.equal(dataOf(result).status, 'remained closed');
  assert.equal(dataOf(result).closeError, undefined);
  assert.deepEqual(f.calls.map((c) => [c.kind, c.id]), [['close', 'x']]);
  assert.equal(f.actual.get('x'), false);
});

test("a close refused for the grant, in a channel only a push has registered, doesn't say the channel is closed, nor once the close is recorded", async () => {
  const f = fixture();
  f.actual.set('x', true);
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
  f.registry.ensureChannelRegistered('test', 'x', 'x');
  // The second close finds the first one's decision recorded.
  for (const attempt of [1, 2]) {
    const result = await f.tool('close');
    assert.equal(result.success, false, `close ${attempt}`);
    assert.equal(result.error,
      'This host isn\'t permitted to open or close the "test" server\'s channels, so this close of channel "x" didn\'t ' +
      'go through, and calling channel_close again won\'t change that. The close stays recorded, and happens if the ' +
      '"test" server registers this channel at a time this host may open and close its channels. If you need it, ask ' +
      'whoever runs this host.', `close ${attempt}`);
    assert.equal(f.registry.getDesiredState('test', 'x'), 'closed', `close ${attempt}`);
  }
  assert.deepEqual(f.calls, []);
});

test('traffic in a tuned-out channel only a push has registered shows it open, whether or not this host directs its lifecycle, so a decline leaves the tune-out', async () => {
  for (const directs of [true, false]) {
    const f = fixture();
    f.actual.set('x', true);
    if (!directs) f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
    f.registry.ensureChannelRegistered('test', 'x', 'x');
    f.registry.enterTuneOut('test', 'x', {
      epochId: 'e1', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
    }, 'agent-tool');
    await f.registry.handleIncoming('test', { messages: [message()] });
    // An entry made from a push has no target a retarget could have left
    // behind, so its traffic shows the transport open even where this host
    // directs the lifecycle.
    assert.equal(f.isOpen(), true, `directs: ${directs}`);
    const declined = await f.registry.handleChannelToolCall('channel_decline', { serverId: 'test', channelId: 'x', messageId: 'm1' });
    assert.equal(declined.success, false, `directs: ${directs}`);
    assert.equal(f.registry.getDesiredState('test', 'x'), 'tuned-out', `directs: ${directs}`);
    assert.deepEqual(f.calls, [], `directs: ${directs}`);
  }
});

test("a registration, over a push's entry or carrying the push's placeholder metadata, still waits for a receipt before its traffic shows it open", async () => {
  for (const registration of ['over a push', 'with the placeholder key'] as const) {
    const f = fixture();
    f.actual.set('x', true);
    f.held.add('x');
    if (registration === 'over a push') f.registry.ensureChannelRegistered('test', 'x', 'x');
    f.registry.enterTuneOut('test', 'x', {
      epochId: 'e1', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
    }, 'agent-tool');
    // channels/register over the push's entry; channels/changed's added for
    // the descriptor with the key.
    const registering = registration === 'over a push'
      ? f.registry.handleRegister('test', { channels: [descriptor('x', true)] })
      : f.registry.handleChanged('test', { added: [{ ...descriptor('x', true), metadata: { lazyRegistered: true } }] });
    await tick();
    await f.registry.handleIncoming('test', { messages: [message()] });
    assert.equal(f.isOpen(), false, `${registration}: its traffic is no receipt`);
    f.held.delete('x');
    await f.drain(registering);
    assert.equal(f.isOpen(), true, `${registration}: the reconcile's receipt confirms it`);
  }
});

test('an update that keeps the target of a channel only a push has registered leaves its traffic showing it open; one that gives it a target waits for a receipt', async () => {
  for (const retarget of [false, true]) {
    const f = fixture();
    f.actual.set('x', true);
    f.held.add('x');
    f.registry.ensureChannelRegistered('test', 'x', 'x');
    f.registry.enterTuneOut('test', 'x', {
      epochId: 'e1', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
    }, 'agent-tool');
    // The push's entry has the server id as its type and no address.
    const update: ChannelDescriptor = retarget
      ? descriptor('x', false, 'B')
      : { id: 'x', type: 'test', label: 'x, renamed', direction: 'bidirectional' };
    const updating = f.registry.handleChanged('test', { updated: [update] });
    await tick();
    await f.registry.handleIncoming('test', { messages: [message()] });
    assert.equal(f.isOpen(), !retarget, `retarget: ${retarget}`);
    f.held.delete('x');
    await f.drain(updating);
    assert.equal(f.isOpen(), true, `retarget: ${retarget}`);
  }
});

test("a transport's close withdraws what it confirmed for that server's channels only, so channel_open and channel_close ask the server again", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('z')] });
  await f.registry.handleChanged('other', { added: [descriptor('y')] });
  assert.equal(dataOf(await f.tool('open')).status, 'opened');
  assert.equal(dataOf(await f.registry.handleChannelToolCall('channel_open', { serverId: 'other', channelId: 'y' })).status, 'opened');
  f.calls.length = 0;
  f.registry.transportClosed('test');
  assert.equal(f.isOpen('x'), false, "x's open was the closed transport's");
  assert.equal(f.isOpen('y'), true, "another server's channel keeps its confirmation");
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open', 'the decision stays');
  assert.equal(f.registry.getChannelLabel('test', 'x'), 'x', 'the entry stays');
  assert.equal(f.calls.length, 0, 'the close itself asks the server nothing');
  assert.notEqual(dataOf(await f.tool('open')).status, 'already open');
  // z's close was confirmed by a receipt from the closed transport, so it's unknown now too
  assert.notEqual(dataOf(await f.registry.handleChannelToolCall('channel_close', { serverId: 'test', channelId: 'z' })).status, 'already closed');
  assert.deepEqual(f.calls.map((c) => `${c.kind} ${c.id}`), ['open x', 'close z'], 'each asks the server');
  assert.equal(f.isOpen('x'), true, 'the new receipt confirms x open');
});

test("a request in flight when the transport closes fails without undoing the close's withdrawal, and the next channel_close asks again", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  assert.equal(dataOf(await f.tool('open')).status, 'opened');
  f.held.add('x');
  const closing = f.tool('close');
  await tick();
  assert.equal(f.pending.length, 1, 'the close is out on the transport');
  f.registry.transportClosed('test');
  // The connection's close rejects every request still out on the closed transport.
  f.pending.shift()!.fail(new Error('the transport closed'));
  await closing;
  assert.equal(f.isOpen(), false, "the failure leaves the open flag where the transport's close put it");
  f.held.delete('x');
  f.calls.length = 0;
  assert.notEqual(dataOf(await f.tool('close')).status, 'already closed');
  assert.deepEqual(f.calls.map((c) => c.kind), ['close']);
});

test("where the host doesn't direct the lifecycle, a close withdraws what traffic confirmed, and delivery goes to the channel as it stands until the next transport's traffic confirms it open", async () => {
  const f = fixture();
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
  await f.registry.handleChanged('test', { added: [descriptor()] });
  await f.registry.handleIncoming('test', { messages: [message()] });
  assert.equal(f.isOpen(), true, 'its traffic showed it open');
  f.registry.transportClosed('test');
  assert.equal(f.isOpen(), false);
  f.calls.length = 0;
  const outcome = await f.registry.publish('resident', 'words', { serverId: 'test', channelId: 'x' });
  assert.equal(outcome.status, 'delivered', 'the words go into the channel as it stands');
  assert.deepEqual(f.calls, [], 'nothing is sent to open it');
  assert.equal(f.publishedWhileOpen.length, 1);
  await f.registry.handleIncoming('test', { messages: [message('x', 'm2')] });
  assert.equal(f.isOpen(), true, "the next transport's traffic shows it open again");
});

test('traffic that arrives before a close and is admitted after it is still admitted, and marks nothing open: a coalesced message held across it, and a sibling behind it', async () => {
  const admits: Array<() => void> = [];
  const f = fixture(undefined, undefined, async (_serverId, held) => {
    await new Promise<void>((resolve) => { admits.push(resolve); });
    return { messageId: held.messageId, accepted: true };
  });
  await f.registry.handleChanged('test', { added: [descriptor('x', true), descriptor('y', true)] });
  await f.registry.handleChanged('other', { added: [descriptor('z')] });
  // An earlier drop, and the channels opened again on the next transport.
  f.registry.transportClosed('test');
  for (const id of ['x', 'y']) {
    assert.equal((await f.registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: id })).success, true);
    assert.equal(f.isOpen(id), true, `${id} is confirmed open again`);
  }
  assert.equal(f.isOpen('z'), false, "the other server's z is confirmed closed");
  const answered: unknown[] = [];
  const incoming = f.registry.handleIncoming('test', {
    messages: [{ ...message('x', 'm1'), coalesce: { key: 'subject' } }, message('y', 'm1')],
  }, { respond: (result) => { answered.push(result); } });
  const elsewhere = f.registry.handleIncoming('other', { messages: [{ ...message('z', 'm1'), coalesce: { key: 'subject' } }] });
  await tick();
  assert.equal(admits.length, 2, 'both coalesced messages wait on the coalescer');
  f.registry.transportClosed('test');
  // The close leaves the connection's grant empty until the next
  // transport's, so this host now reads as one that doesn't direct the
  // lifecycle: where traffic alone would mark a channel open.
  f.setGrant(ALL_CAPABILITY_PATHS.filter((path) => path !== 'channels.lifecycle'));
  for (const admit of admits) admit();
  await Promise.all([incoming, elsewhere]);
  assert.equal(f.isOpen('x'), false, "the held message's admission doesn't confirm x");
  assert.equal(f.isOpen('y'), false, 'nor does the sibling admitted behind it confirm y');
  assert.deepEqual(answered, [{ results: [{ messageId: 'm1', accepted: true }, { messageId: 'm1', accepted: true }] }], 'both are still admitted');
  assert.equal(f.isOpen('z'), true, "the other server's traffic, under way across that close, still shows z open");
  // The next transport's grant: x is unconfirmed, not confirmed closed.
  f.setGrant(ALL_CAPABILITY_PATHS);
  f.calls.length = 0;
  assert.notEqual(dataOf(await f.registry.handleChannelToolCall('channel_close', { serverId: 'test', channelId: 'x' })).status, 'already closed');
  assert.deepEqual(f.calls.map((c) => `${c.kind} ${c.id}`), ['close x']);
});

test("an untargeted push entry, where the host directs the lifecycle, is confirmed by the next transport's traffic, but not by traffic held across the close", async () => {
  const admits: Array<() => void> = [];
  const f = fixture(undefined, undefined, async (_serverId, held) => {
    await new Promise<void>((resolve) => { admits.push(resolve); });
    return { messageId: held.messageId, accepted: true };
  });
  f.registry.ensureChannelRegistered('test', 'dm', 'DM with someone');
  f.registry.enterTuneOut('test', 'dm', {
    epochId: 'e1', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
  }, 'agent-tool');
  await f.registry.handleIncoming('test', { messages: [message('dm', 'm0')] });
  assert.equal(f.isOpen('dm'), true, 'its traffic shows it open');
  const held = f.registry.handleIncoming('test', { messages: [{ ...message('dm', 'm1'), coalesce: { key: 'subject' } }] });
  await tick();
  f.registry.transportClosed('test');
  assert.equal(f.isOpen('dm'), false);
  // The next transport's grant, which directs the lifecycle again, has
  // arrived before the held message is admitted.
  admits.shift()!();
  await held;
  assert.equal(f.isOpen('dm'), false, "the closed transport's traffic doesn't confirm it");
  await f.registry.handleIncoming('test', { messages: [message('dm', 'm2')] });
  assert.equal(f.isOpen('dm'), true, "the next transport's traffic does");
});

test("a lifecycle receipt from before a transport's close confirms nothing: on the closed connection the open is refused as unreachable, and the decision stays", async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor()] });
  f.held.add('x');
  const opening = f.tool('open');
  await tick();
  assert.equal(f.pending.length, 1, 'the open is out on the transport');
  // The connection closes as a real one does: its grant is emptied and it
  // reads as down before the registry hears of the close.
  const server = (f.registry as unknown as { serverRegistry: { getServer(id: string): Record<string, unknown> } })
    .serverRegistry.getServer('test');
  f.setGrant([]);
  Object.assign(server, { isConnected: false, willReconnect: true });
  f.registry.transportClosed('test');
  // Its answer was read before the close, and is applied after it.
  f.pending.shift()!.finish();
  const result = await opening;
  assert.equal(f.isOpen(), false, "the closed transport's receipt confirms nothing");
  assert.equal(result.success, false);
  assert.match(String(result.error), /isn't connected/, 'the agent is told the server is down');
  assert.equal(f.calls.filter((c) => c.kind === 'open').length, 1, 'nothing more is sent on the closed connection');
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open', 'the decision stays recorded');
});
