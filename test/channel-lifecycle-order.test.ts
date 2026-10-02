import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelDescriptor, ChannelsOpenResult } from '../src/mcpl/types.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function descriptor(id = 'x', initiallyOpen = false, address = 'original'): ChannelDescriptor {
  return { id, type: 'test', label: id, direction: 'bidirectional', initiallyOpen, address: { value: address } };
}

type NoticeHandler = NonNullable<NonNullable<ConstructorParameters<typeof ChannelRegistry>[4]>['onChannelAutoOpened']>;

function fixture(onNotice?: NoticeHandler, store?: JsStore) {
  const actual = new Map<string, boolean>();
  const calls: Array<{ kind: 'open' | 'close'; id: string; address?: unknown }> = [];
  const pending: Array<{ finish: () => void; fail: () => void }> = [];
  const held = new Set<string>();
  const publishedWhileOpen: boolean[] = [];
  const notices: Array<{ source: string; channels: Array<{ channelId: string; label?: string }> }> = [];
  const routeFailures: Array<{ reason: string }> = [];
  const serve = (kind: 'open' | 'close', params: { channelId?: string; address?: unknown }) => {
    const id = params.channelId!;
    calls.push({ kind, id, address: params.address });
    return new Promise<any>((resolve, reject) => {
      const finish = () => {
        actual.set(id, kind === 'open');
        resolve(kind === 'open' ? { channel: descriptor(id) } : { closed: true });
      };
      if (held.has(id)) pending.push({ finish, fail: () => reject(new Error('fixture lifecycle failure')) });
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
  const traces: Array<{ type: string; [key: string]: unknown }> = [];
  const registry = new ChannelRegistry(
    { getServer: () => currentServer } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, (event) => traces.push(event),
    { store, onRouteFailure: (info) => routeFailures.push(info),
      onChannelAutoOpened: (info) => { notices.push(info); onNotice?.(info); } },
  );
  const isOpen = (id = 'x') => registry.getOpenChannels().some((e) => e.descriptor.id === id);
  const tool = (kind: 'open' | 'close') => registry.handleChannelToolCall('channel_' + kind, { serverId: 'test', channelId: 'x' });
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
  return { registry, actual, calls, pending, held, traces, isOpen, tool, drain, publishedWhileOpen, notices, routeFailures, replaceServer };
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
    f.held.add('x');
    const close = f.tool('close');
    await tick();
    f.registry.enterTuneOut('test', 'x', {
      epochId: 'new-epoch', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
    }, 'agent-tool');
    const sent = delivery === 'speech'
      ? f.registry.routeSpeech('resident', 'hello', 'x').then((result) => result?.delivered === true)
      : f.registry.openIfClosedForSend('x', 'test').then((result) => result.status === 'opened' || result.status === 'already-open');
    await f.drain(close, sent);
    assert.equal(await sent, true);
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
  const speech = f.registry.routeSpeech('resident', 'hello', 'x');
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
  assert.equal(f.isOpen(), true, 'a failed redundant open is not a confirmed close');
  const speech = f.registry.routeSpeech('resident', 'hello', 'x');
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
  const speech = f.registry.routeSpeech('resident', 'tail of the turn', 'x');
  await f.drain(close, speech);
  assert.equal((await close).success, true);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'closed');
  assert.equal(f.actual.get('x'), false);
  assert.equal(f.isOpen(), false);
  assert.equal(f.notices.length, 0);
});

test('waiting for a backscroll does not issue new opens or auto-open notices for each speech', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.calls.length = 0;
  f.held.add('x');
  const backscroll = f.registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: 'x', backscroll: 5 });
  await tick();
  const speech1 = f.registry.routeSpeech('resident', 'one', 'x');
  const speech2 = f.registry.routeSpeech('resident', 'two', 'x');
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
      ? f.registry.routeSpeech('resident', 'hello', 'x')
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

test('a fresh delivery into a settled closed channel remains a new engagement', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  assert.equal((await f.tool('close')).success, true);
  assert.equal(f.actual.get('x'), false);
  const delivered = await f.registry.routeSpeech('resident', 'a new engagement', 'x');
  assert.equal(delivered?.delivered, true);
  assert.equal(f.registry.getDesiredState('test', 'x'), 'open');
  assert.equal(f.notices.length, 1);
});

test('a close that completes while delivery joins a backscroll remains authoritative', async () => {
  const f = fixture();
  await f.registry.handleChanged('test', { added: [descriptor('x', true)] });
  f.held.add('x');
  const backscroll = f.registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: 'x', backscroll: 5 });
  await tick();
  const speech = f.registry.routeSpeech('resident', 'tail', 'x');
  const close = f.tool('close');
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
  const first = f.registry.routeSpeech('resident', 'one', 'x');
  const second = f.registry.routeSpeech('resident', 'two', 'x');
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
      recordChannelAutoOpenNotice(agent: undefined, channels: Array<{ channelId: string; label?: string }>, cause: 'subscription-policy' | 'opened-by-delivery'): void;
    }).recordChannelAutoOpenNotice.bind(framework);
    const onNotice: NoticeHandler = (info) => recordNotice(undefined, info.channels, info.source);
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
    assert.match(noticeTexts()[0], /admission decision; channel_list shows current transport state/);
    assert.doesNotMatch(noticeTexts()[0], /Now open/);

    // Reconstruct the registry from the same Chronicle state before retrying.
    // The admission persists even though its first transport attempt failed.
    const retry = fixture(onNotice, framework.getStore());
    retry.registry.setSubscriptionPolicy('test', 'auto');
    await retry.registry.handleChanged('test', { added: [descriptor()] });
    assert.equal(retry.isOpen(), true);
    assert.equal(retry.notices.length, 0);
    assert.equal(noticeTexts().length, 1);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of ['speech', 'reply'] as const) {
  test(kind + ' joins a pending close even after retargeting clears open confirmation', async () => {
    const f = fixture();
    await f.registry.handleChanged('test', { added: [descriptor('x', true, 'A')] });
    f.calls.length = 0;
    f.held.add('x');
    const closing = f.tool('close');
    await tick();
    await f.registry.handleChanged('test', { updated: [descriptor('x', true, 'B')] });
    assert.equal(f.isOpen(), false);
    const delivery = kind === 'speech'
      ? f.registry.routeSpeech('resident', 'waiting reply', 'x')
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
    const speech = f.registry.routeSpeech('resident', 'waiting reply', 'x');
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
  const speech = f.registry.routeSpeech('resident', 'waiting reply', 'x');
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
  const speech = f.registry.routeSpeech('resident', 'waiting reply', 'x')
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
    assert.match((await opening).error!, /did not converge/);
    assert.equal(await speech, null);
    assert.equal((await reply).status, 'open-failed');
    assert.equal(f.isOpen(), false, 'an unconfirmed current target is not reported open');
    assert.deepEqual(f.publishedWhileOpen, []);
    assert.equal(f.routeFailures.length, 1);
    assert.match(f.routeFailures[0].reason, /did not converge/);
    assert.ok(f.traces.some((e) => e.type === 'mcpl:channel-reconcile-failed' &&
      String(e.error).includes('did not converge')));
  } finally {
    // Original code needs one stable receipt to release its unbounded loop.
    await f.drain(opening, speech, reply);
  }
  f.held.delete('x');
  const retry = await f.registry.routeSpeech('resident', 'a later stable retry', 'x');
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
    assert.match(String(failures[0].error), /did not converge/);
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
