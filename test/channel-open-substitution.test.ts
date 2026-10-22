import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { logValue } from '../src/mcpl/log-value.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelDescriptor, ChannelIncomingMessage, ChannelsOpenResult } from '../src/mcpl/types.js';

// A server that answers channels/open for another channel than the one named,
// as discord-mcpl's base did for a stale id: it fell back to its first channel
// of the type, opened that, and returned that channel's history.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function descriptor(id: string, initiallyOpen = false, address = id): ChannelDescriptor {
  return { id, type: 'test', label: id, direction: 'bidirectional', initiallyOpen, address: { value: address } };
}

function historyOf(channelId: string): ChannelIncomingMessage[] {
  return [{
    channelId, messageId: `${channelId}-1`, author: { id: 'u1', name: 'someone' },
    timestamp: '2026-10-09T00:00:00Z', content: [{ type: 'text', text: `from ${channelId}` }],
  }];
}

function fixture(answer: (requested: string) => ChannelsOpenResult | Promise<ChannelsOpenResult>) {
  const calls: Array<{ kind: 'open' | 'close'; id: string }> = [];
  const published: string[] = [];
  const traces: Array<{ type: string; [key: string]: unknown }> = [];
  const routeFailures: Array<{ reason: string }> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async (params: { channelId?: string }) => {
      calls.push({ kind: 'open', id: params.channelId! });
      return answer(params.channelId!);
    },
    sendChannelsClose: async (params: { channelId: string }) => {
      calls.push({ kind: 'close', id: params.channelId });
      return { closed: true };
    },
    sendChannelsPublish: async (params: { channelId: string }) => {
      published.push(params.channelId);
      return { delivered: true };
    },
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, (event) => traces.push(event),
    { onRouteFailure: (info) => routeFailures.push(info) },
  );
  const isOpen = (id: string) => registry.getOpenChannels().some((e) => e.descriptor.id === id);
  const substituted = () => traces.filter((t) => t.type === 'mcpl:channel-open-substituted');
  const openX = (backscroll?: number) =>
    registry.handleChannelToolCall('channel_open', { serverId: 'test', channelId: 'x', ...(backscroll ? { backscroll } : {}) });
  return { registry, calls, published, traces, routeFailures, isOpen, substituted, openX };
}

/** Run `work` with console.error captured, returning what it printed. */
async function capturingErrors<T>(work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await work(), lines };
  } finally {
    console.error = original;
  }
}

test('an open answered for another channel fails, and that channel\'s history goes nowhere', async () => {
  const f = fixture(() => ({ channel: descriptor('y'), history: historyOf('y') }));
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  const { value: result, lines } = await capturingErrors(() => f.openX(5));

  assert.equal(result.success, false);
  // The open stays recorded, as every failed open's does.
  assert.equal(result.error, 'Channel "x" wasn\'t opened: the "test" server answered for a different channel, so nothing in its ' +
    'answer is used. The open stays recorded, and this host tries it again when the "test" server next registers this ' +
    'channel, if this host may open and close its channels then; calling channel_open again is likely to get the same ' +
    'answer. channel_close withdraws it.');
  assert.equal(result.data, undefined, 'no history, or anything else from the answer, reaches the resident');
  assert.equal(f.isOpen('x'), false, 'the requested channel is not marked open');
  assert.equal(f.isOpen('y'), false, 'nor is the channel the server answered for');

  const [trace, ...more] = f.substituted();
  assert.equal(more.length, 0);
  assert.equal(trace?.serverId, 'test');
  assert.equal(trace?.channelId, 'x');
  assert.equal(trace?.answeredFor, 'y');
  assert.deepEqual(lines.filter((l) => l.startsWith('[channel-open-substituted]')),
    ['[channel-open-substituted] server=test requested=x answered=y']);
});

test('an answer naming no channel but carrying another channel\'s history fails the same way', async () => {
  const f = fixture(() => ({ history: historyOf('y') }) as unknown as ChannelsOpenResult);
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  const { value: result } = await capturingErrors(() => f.openX(5));
  assert.equal(result.success, false);
  assert.equal(result.data, undefined);
  assert.equal(f.isOpen('x'), false);
  assert.equal(f.substituted()[0]?.answeredFor, 'y');
});

test('the channel opened instead is closed again when the host wants it closed', async () => {
  const f = fixture(() => ({ channel: descriptor('y') }));
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  f.calls.length = 0;
  await capturingErrors(() => f.openX());
  await tick();
  assert.deepEqual(f.calls, [{ kind: 'open', id: 'x' }, { kind: 'close', id: 'y' }],
    'the server opened y, so the host closes it through y\'s own lifecycle');
  assert.equal(f.registry.getDesiredState('test', 'y'), 'closed');
  assert.equal(f.isOpen('y'), false);
});

test('the channel opened instead is left alone when the host wants it open', async () => {
  const f = fixture((requested) => ({ channel: descriptor(requested === 'x' ? 'y' : requested) }));
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y', true)] });
  assert.equal(f.isOpen('y'), true);
  f.calls.length = 0;
  await capturingErrors(() => f.openX());
  await tick();
  assert.deepEqual(f.calls, [{ kind: 'open', id: 'x' }], 'no corrective close, and no reopening of y');
  assert.equal(f.isOpen('y'), true);
});

test('the channel opened instead needs nothing once it is no longer registered', async () => {
  const f = fixture(() => ({ channel: descriptor('y') }));
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  await f.registry.handleChanged('test', { removed: ['y'] });
  f.calls.length = 0;
  await capturingErrors(() => f.openX());
  await tick();
  assert.equal(f.substituted().length, 1, 'the substitution is still reported');
  assert.deepEqual(f.calls, [{ kind: 'open', id: 'x' }], 'nothing is sent for y');
  assert.equal(f.traces.filter((t) => t.type === 'mcpl:channel-reconcile-failed').length, 0,
    'an unregistered channel has no lifecycle to fail');
});

test('a channel admitted open stays closed on a substituted answer, reports it once, and speech into it fails loudly', async () => {
  const f = fixture(() => ({ channel: descriptor('y') }));
  await capturingErrors(() => f.registry.handleChanged('test', { added: [descriptor('x', true), descriptor('y')] }));
  assert.equal(f.isOpen('x'), false);
  assert.equal(f.substituted().length, 1);
  assert.equal(f.traces.filter((t) => t.type === 'mcpl:channel-reconcile-failed').length, 0,
    'the substitution is its own diagnostic, not also a generic reconcile failure');

  const { value: delivery } = await capturingErrors(() => f.registry.routeSpeech('resident', 'hello', 'x'));
  assert.equal(delivery, null);
  assert.deepEqual(f.published, [], 'nothing is sent into a channel the server would not confirm');
  assert.equal(f.routeFailures.length, 1);
  assert.equal(f.routeFailures[0]!.reason, 'opening the channel for these words didn\'t complete: the "test" server ' +
    'answered for a different channel, so nothing in its answer is used');
});

test('a known-open channel loses its confirmation on a substituted answer, and reopens once the server answers for it', async () => {
  let answerFor: string | undefined;
  const f = fixture((requested) => ({ channel: descriptor(answerFor ?? requested) }));
  await f.registry.handleChanged('test', { added: [descriptor('x', true), descriptor('y')] });
  assert.equal(f.isOpen('x'), true);

  answerFor = 'y';
  const { value: backscroll } = await capturingErrors(() => f.openX(5));
  assert.equal(backscroll.success, false);
  assert.equal(f.isOpen('x'), false, 'an answer for another channel confirms nothing about this one');

  answerFor = undefined;
  await tick();
  f.calls.length = 0;
  const delivery = await f.registry.routeSpeech('resident', 'hello', 'x');
  assert.equal(delivery?.delivered, true);
  assert.deepEqual(f.calls, [{ kind: 'open', id: 'x' }], 'delivery reopens the channel before sending');
  assert.deepEqual(f.published, ['x']);
});

test('a substituted answer on a receipt made stale by retargeting is retried, not failed', async () => {
  let release!: (answer: ChannelsOpenResult) => void;
  let first = true;
  const f = fixture((requested) => {
    if (!first) return { channel: descriptor(requested) };
    first = false;
    return new Promise<ChannelsOpenResult>((resolve) => { release = resolve; });
  });
  await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
  f.calls.length = 0;
  const { value: opened } = await capturingErrors(async () => {
    const opening = f.openX();
    await tick();
    await f.registry.handleChanged('test', { updated: [descriptor('x', false, 'new-target')] });
    release({ channel: descriptor('y') });
    return opening;
  });
  assert.equal(opened.success, true, 'the stale receipt is not trusted either way; the retry answers for x');
  assert.equal(f.isOpen('x'), true);
  assert.equal(f.substituted().length, 1, 'the substitution the server made is still reported');
  await tick();
  assert.deepEqual(f.calls.filter((c) => c.id === 'y'), [{ kind: 'close', id: 'y' }],
    'and the channel it opened instead is still closed again');
});

test("the substitution line and its trace print each id as the module's other log lines do, an odd one escaped", async () => {
  const forged = 'y\n[channel-open-substituted] server=other requested=x answered=x';
  const f = fixture(() => ({ channel: { ...descriptor('y'), id: forged } }));
  await f.registry.handleChanged('test', { added: [descriptor('x')] });
  const { lines } = await capturingErrors(() => f.openX());
  const logged = lines.filter((l) => l.includes('channel-open-substituted'));
  assert.deepEqual(logged, [`[channel-open-substituted] server=test requested=x answered=${logValue(forged)}`]);
  const answered = logged[0]!.slice(logged[0]!.indexOf(' answered=') + ' answered='.length);
  assert.doesNotMatch(answered, /[\n =]/, 'the forged id adds no line, field or value of its own');
  assert.equal(f.substituted()[0]?.answeredFor, logValue(forged), 'the trace records the same escaped form');
});

test('an answer whose channel id is not a string fails the open, and closes nothing', async () => {
  for (const answer of [
    () => ({ channel: { ...descriptor('y'), id: 5 } }) as unknown as ChannelsOpenResult,
    () => ({ history: [{ ...historyOf('y')[0]!, channelId: false }] }) as unknown as ChannelsOpenResult,
  ]) {
    const f = fixture(answer);
    await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
    f.calls.length = 0;
    const { value: result } = await capturingErrors(() => f.openX());
    await tick();
    assert.equal(result.success, false);
    assert.match(String(result.error), /answered for a channel whose id isn't a string, so nothing in its answer is used\./);
    assert.equal(f.isOpen('x'), false);
    assert.match(String(f.substituted()[0]?.answeredFor), /^(5|false)$/, 'logValue prints a non-string id as its JSON text');
    assert.deepEqual(f.calls, [{ kind: 'open', id: 'x' }], 'nothing registered by that id to close');
  }
});

test('an answer for the requested channel, with or without its history, or one naming no channel, opens it as before', async () => {
  for (const answer of [
    (requested: string) => ({ channel: descriptor(requested), history: historyOf(requested) }),
    (requested: string) => ({ channel: descriptor(requested) }),
    () => ({}) as ChannelsOpenResult,
    // A null id names no channel, in the answer or in a history item.
    (requested: string) => ({ channel: { ...descriptor(requested), id: null } }) as unknown as ChannelsOpenResult,
    (requested: string) => ({ history: [{ ...historyOf(requested)[0]!, channelId: null }] }) as unknown as ChannelsOpenResult,
  ]) {
    const f = fixture(answer);
    await f.registry.handleChanged('test', { added: [descriptor('x'), descriptor('y')] });
    f.calls.length = 0;
    const result = await f.openX(5);
    assert.equal(result.success, true);
    assert.equal(f.isOpen('x'), true);
    assert.equal(f.substituted().length, 0);
    assert.deepEqual(f.calls, [{ kind: 'open', id: 'x' }]);
  }
});
