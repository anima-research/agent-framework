/**
 * A tune-out keeps its channel's transport open, since the subconscious can
 * watch only the traffic that arrives (TuneOutParams). tune_out records the
 * tune-out, then opens a closed transport through the channel's lifecycle
 * queue (openForTuneOut), behind any work in flight, and writes no decision
 * of its own there, so the tune-out stands whatever becomes of the open.
 * Where the transport doesn't end open, tune_out's answer is still a success,
 * since the tune-out is recorded, and its openError says why the channel's
 * messages don't, or may not, reach the subconscious yet and when they will,
 * or that the tune-out isn't in effect any more. tune_out repeated for a
 * channel already tuned out whose transport doesn't read open, or with work
 * queued for it, gets the answer of the open in flight, or waits and, where
 * this host can open the channel, tries the open again. A decline
 * of a tuned-out channel is refused, whatever its transport, since a decline
 * recorded over the tune-out would end it without its cancel, and lose the
 * backlog the cancel delivers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { ChannelRegistry, destinationKey } from '../src/mcpl/channel-registry.js';
import type { TuneOutParams } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelDescriptor } from '../src/mcpl/types.js';
import { TUNE_OUT_DEFAULTS } from '../src/tune-out/coordinator.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { answerText, scriptCall } from './helpers/script-call.js';
import { jsonLines } from './helpers/json-lines.js';

function descriptor(id: string): ChannelDescriptor {
  return { id, type: 'test', label: id, direction: 'bidirectional', address: { value: id } };
}

function grant(without: string[] = []): CapabilityGrant {
  return new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((path) => !without.includes(path))), []);
}

/** A server as the registry reads one, recording each lifecycle request it
 *  takes, in order, as `open <id>` or `close <id>`. */
interface Server {
  grant: CapabilityGrant;
  isConnected?: boolean;
  willReconnect?: boolean;
  sent: string[];
  sendChannelsOpen(params: { channelId: string }): Promise<unknown>;
  sendChannelsClose(params: { channelId: string }): Promise<unknown>;
  sendChannelsAcknowledge(params: { channelId: string }): Promise<{ acknowledged: boolean }>;
}

function up(without: string[] = []): Server {
  const sent: string[] = [];
  return {
    grant: grant(without),
    sent,
    sendChannelsOpen: async ({ channelId }) => { sent.push(`open ${channelId}`); return { channel: descriptor(channelId) }; },
    sendChannelsClose: async ({ channelId }) => { sent.push(`close ${channelId}`); return {}; },
    sendChannelsAcknowledge: async ({ channelId }) => { sent.push(`ack ${channelId}`); return { acknowledged: true }; },
  };
}

const PARAMS: TuneOutParams = { epochId: 'e1', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 };
const REPLACED = 'The tune-out was recorded, but it isn\'t in effect any more: it ended, or a later decision about the channel ' +
  'or a later tune-out replaced it, while its transport was being opened.';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A registry with server "a" and its channel "y", which registration
 *  leaves closed and the agent's channel_close keeps so: its transport is
 *  confirmed closed. */
async function closedChannel() {
  const servers = new Map<string, Server>();
  const server = up();
  servers.set('a', server);
  // As the host's serverConnecting reads a server being connected or
  // restarted.
  const host = { connecting: false };
  const registry = new ChannelRegistry(
    { getServer: (id: string) => servers.get(id) } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, () => {}, { serverConnecting: () => host.connecting },
  );
  await registry.handleRegister('a', { channels: [descriptor('y')] });
  for (let i = 0; i < 5; i++) await tick();
  const closed = await registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  assert.equal((closed.data as { status?: string } | undefined)?.status, 'already closed');
  server.sent.length = 0;
  const isOpen = () => (registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(destinationKey({ serverId: 'a', channelId: 'y' }))?.open;
  assert.equal(isOpen(), false);
  return { registry, servers, server, isOpen, host };
}

test('a tune-out of a closed, registered channel opens its transport', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.deepEqual(f.server.sent, ['open y']);
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out', 'the open wrote no decision of its own');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1');
});

test('a tune-out of an open channel with nothing pending sends nothing', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.deepEqual(f.server.sent, []);
});

test('a tune-out recorded while a close is out waits for that work, which opens the channel, rather than send a second open', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let release!: () => void;
  const close = f.server.sendChannelsClose;
  f.server.sendChannelsClose = async (params) => {
    f.server.sent.push(`close ${params.channelId}`);
    await new Promise<void>((resolve) => { release = resolve; });
    return {};
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  for (let i = 0; i < 20 && !release; i++) await tick();
  assert.deepEqual(f.server.sent, ['close y'], 'the close is out');
  f.server.sendChannelsClose = close;
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  let settled = false;
  const opening = f.registry.openForTuneOut('a', 'y').finally(() => { settled = true; });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(settled, false, 'the answer waits for the close that\'s out');
  release();
  assert.equal(await opening, undefined);
  await closing;
  assert.deepEqual(f.server.sent, ['close y', 'open y'], 'one open, by the work already queued');
  assert.equal(f.isOpen(), true);
});

test('a tune-out that waited for a close the server then refused confirms the transport with an open, not the refusal', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let refuse!: () => void;
  f.server.sendChannelsClose = async ({ channelId }) => {
    f.server.sent.push(`close ${channelId}`);
    await new Promise<void>((resolve) => { refuse = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  for (let i = 0; i < 20 && !refuse; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  let settled = false;
  const opening = f.registry.openForTuneOut('a', 'y').finally(() => { settled = true; });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(settled, false, 'the answer waits for the close that\'s out');
  refuse();
  assert.equal(await opening, undefined, 'the close\'s refusal says nothing of the open');
  await closing;
  // The failed close leaves the open flag as it was, marked unconfirmed:
  // a close may take effect before its request fails, so the tune-out
  // confirms the transport with an open of its own.
  assert.deepEqual(f.server.sent, ['close y', 'open y']);
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), true, 'the open\'s receipt confirms it, failed close and all');
});

test('a tune-out that waited for an open that then failed opens the channel once more itself', async () => {
  const f = await closedChannel();
  let fail!: () => void;
  const open = f.server.sendChannelsOpen;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { fail = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  const opened = f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  for (let i = 0; i < 20 && !fail; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  f.server.sendChannelsOpen = open;
  fail();
  assert.equal(await opening, undefined);
  await opened;
  assert.deepEqual(f.server.sent, ['open y', 'open y'], 'the failed open, then the tune-out\'s');
  assert.equal(f.isOpen(), true);
});

test('a tune-out on a server whose channels this host can\'t open says its messages come only as the server sends them', async () => {
  const f = await closedChannel();
  const without = up(['channels.lifecycle']);
  f.servers.set('a', without);
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but this host isn\'t permitted to open or close the "a" server\'s channels, so its ' +
    'messages reach the subconscious only as that server sends them, and calling tune_out again won\'t change that. If you need this host to open it, ask whoever runs ' +
    'this host.');
  assert.deepEqual(without.sent, []);
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out');
  // A channel that server has open needs nothing from this host.
  (f.registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(destinationKey({ serverId: 'a', channelId: 'y' }))!.open = true;
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined, 'open there');
  assert.deepEqual(without.sent, []);
});

const DOWN = 'The tune-out is recorded, but its messages don\'t reach the subconscious until the "a" server is connected ' +
  'and the channel is open; it can\'t be opened now: the "a" server isn\'t connected, and this host is reconnecting to it.';

test('a tune-out on a server whose grant lapsed while a close was out waits for the close, then answers from what it left', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let release!: () => void;
  const close = f.server.sendChannelsClose;
  f.server.sendChannelsClose = async (params) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return close(params);
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }).catch(() => undefined);
  for (let i = 0; i < 20 && !release; i++) await tick();
  f.server.grant = grant(['channels.lifecycle']);
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.isOpen(), true, 'open while the close is out');
  release();
  assert.equal(await opening,
    'The tune-out is recorded, but this host isn\'t permitted to open or close the "a" server\'s channels, so its ' +
    'messages reach the subconscious only as that server sends them, and calling tune_out again won\'t change that. If you need this host to open it, ask whoever runs ' +
    'this host.');
  await closing;
  assert.equal(f.isOpen(), false);
  assert.deepEqual(f.server.sent, ['close y']);
});

test('a tune-out on a server whose grant lapsed after a close timed out doesn\'t take the flag the timeout left as open', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  f.server.sendChannelsClose = async ({ channelId }) => {
    f.server.sent.push(`close ${channelId}`);
    throw new McplRequestError(timedOut, 'no-response');
  };
  await f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  assert.equal(f.isOpen(), true, 'the flag the timed-out close left');
  f.server.grant = grant(['channels.lifecycle']);
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but this host isn\'t permitted to open or close the "a" server\'s channels, so its ' +
    'messages reach the subconscious only as that server sends them, and calling tune_out again won\'t change that. If you need this host to open it, ask whoever runs ' +
    'this host.');
  assert.deepEqual(f.server.sent, ['close y']);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false);
  // The server sends the channel's traffic, which shows it open where this
  // host doesn't direct the lifecycle, failed close and all.
  await f.registry.handleIncoming('a', {
    messages: [{
      channelId: 'y', messageId: 'm1', author: { id: 'u1', name: 'U' }, timestamp: '2026-10-21T00:00:00.000Z',
      content: [{ type: 'text' as const, text: 'hello' }],
    }],
  });
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), true);
});

test('a tune-out while its server isn\'t up says its messages wait for it and the channel, whatever the open flag kept', async () => {
  for (const wasOpen of [false, true]) {
    const f = await closedChannel();
    if (wasOpen) await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
    // A dropped connection keeps its entries' open flags, and a reconnect
    // empties the grant until the new one is established.
    f.servers.set('a', { ...up(), grant: CapabilityGrant.empty(), isConnected: false, willReconnect: true });
    f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
    assert.equal(await f.registry.openForTuneOut('a', 'y'), DOWN, wasOpen ? 'open' : 'closed');
  }
  const connecting = await closedChannel();
  connecting.host.connecting = true;
  connecting.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await connecting.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but its messages don\'t reach the subconscious until the "a" server is connected and the ' +
    'channel is open; it can\'t be opened now: this host is connecting to the "a" server.');
  assert.deepEqual(connecting.server.sent, []);
  const gone = await closedChannel();
  gone.servers.set('a', { ...up(), grant: CapabilityGrant.empty(), isConnected: false, willReconnect: false });
  gone.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await gone.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but its messages don\'t reach the subconscious until the "a" server is connected and the ' +
    'channel is open; it can\'t be opened now: the "a" server isn\'t connected, and this host won\'t reconnect to it on ' +
    'its own; if you need it, ask whoever runs this host.');
});

test('a tune-out whose server drops while the work queued before it runs answers from the server\'s state then', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let refuse!: () => void;
  f.server.sendChannelsClose = async ({ channelId }) => {
    f.server.sent.push(`close ${channelId}`);
    await new Promise<void>((resolve) => { refuse = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  for (let i = 0; i < 20 && !refuse; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 5; i++) await tick();
  // The same connection drops, so the refused close leaves the open flag set.
  f.server.isConnected = false;
  f.server.willReconnect = true;
  refuse();
  assert.equal(await opening, DOWN);
  await closing;
  assert.equal(f.isOpen(), true, 'the flag the dropped connection kept');
  assert.deepEqual(f.server.sent, ['close y']);
});

const UNREGISTERED = 'The tune-out is recorded, but its messages may not reach the subconscious until this host opens the ' +
  'channel, which it does when the "a" server next registers this channel, if this host may open and close its channels ' +
  'then; it isn\'t registered here now.';

test('a tune-out of a channel that isn\'t registered here says so', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'nope', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'nope'), UNREGISTERED);
  assert.deepEqual(f.server.sent, []);
});

test('a tune-out whose channel\'s registration goes while the work queued before it runs says so, and sends nothing', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let release!: () => void;
  const close = f.server.sendChannelsClose;
  f.server.sendChannelsClose = async (params) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return close(params);
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }).catch(() => undefined);
  for (let i = 0; i < 20 && !release; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  f.registry.removeServer('a');
  release();
  assert.equal(await opening, UNREGISTERED);
  await closing;
  assert.deepEqual(f.server.sent, ['close y'], 'no open for a registration that isn\'t here');
});

test('a tune-out whose open fails says what failed, when this host opens the channel, and keeps the tune-out', async () => {
  const f = await closedChannel();
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    throw new McplRequestError(timedOut, 'no-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but its messages may not reach the subconscious until this host opens the channel, which ' +
    'it does when the "a" server next registers this channel, if this host may open and close its channels then, or ' +
    'now if you call tune_out again; ' +
    `opening it now didn't complete: ${timedOut}`);
  assert.deepEqual(f.server.sent, ['open y']);
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1', 'the tune-out stands');
});

test('a tune-out whose channel\'s registration goes while the open is out says so, and one that comes back is opened', async () => {
  for (const [back, refused] of [[false, false], [false, true], [true, false]]) {
    const f = await closedChannel();
    let release!: () => void;
    f.server.sendChannelsOpen = async ({ channelId }) => {
      f.server.sent.push(`open ${channelId}`);
      await new Promise<void>((resolve) => { release = resolve; });
      if (refused) throw new McplRequestError('The "a" server refused the request.', 'error-response');
      return { channel: descriptor(channelId) };
    };
    f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
    const opening = f.registry.openForTuneOut('a', 'y');
    for (let i = 0; i < 20 && !release; i++) await tick();
    f.registry.removeServer('a');
    // The registration that comes back queues its reconcile behind the open
    // that's out, so it settles only after that open does.
    let registering: Promise<void> | undefined;
    if (back) {
      f.server.sendChannelsOpen = async ({ channelId }) => ({ channel: descriptor(channelId) });
      registering = f.registry.handleRegister('a', { channels: [descriptor('y')] });
      for (let i = 0; i < 20 && f.registry.listChannelsRaw().length === 0; i++) await tick();
      assert.equal(f.registry.listChannelsRaw().length, 1, 'registered again');
    }
    release();
    await registering;
    // Gone is read from the registration, whatever the request's error.
    assert.equal(await opening, back ? undefined
      : 'The tune-out is recorded, but its messages may not reach the subconscious until this host opens the channel, ' +
        'which it does when the "a" server next registers this channel, if this host may open and close its channels ' +
        'then; it isn\'t registered here any more: ' + (refused ? 'The "a" server refused the request.'
          : 'this host disconnected the "a" server while the change was being made.'),
      back ? 'came back' : refused ? 'gone, the open refused' : 'gone');
    if (back) assert.equal(f.isOpen(), true, 'the registration that came back opened it, and the answer waited for that');
  }
});

test('a tune-out waits for a registration that came back while the work before it ran, and sends no open of its own', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let refuse!: () => void;
  f.server.sendChannelsClose = async ({ channelId }) => {
    f.server.sent.push(`close ${channelId}`);
    await new Promise<void>((resolve) => { refuse = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }).catch(() => undefined);
  for (let i = 0; i < 20 && !refuse; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  // The registration comes back while the close is out, and queues its
  // reconcile, an open, behind it.
  f.registry.removeServer('a');
  const registering = f.registry.handleRegister('a', { channels: [descriptor('y')] }).catch(() => undefined);
  for (let i = 0; i < 20 && f.registry.listChannelsRaw().length === 0; i++) await tick();
  refuse();
  assert.equal(await opening, undefined);
  await registering;
  await closing;
  assert.deepEqual(f.server.sent, ['close y', 'open y'], 'one open, the registration\'s');
  assert.equal(f.isOpen(), true);
});

test('a tune-out whose registration came back while its open was out names the failure that keeps the new one closed', async () => {
  const f = await closedChannel();
  let fail!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { fail = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !fail; i++) await tick();
  // A registration that comes back queues its reconcile behind the open
  // that's out, and that reconcile's open fails for a reason of its own.
  f.registry.removeServer('a');
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    throw new McplRequestError(timedOut, 'no-response');
  };
  const registering = f.registry.handleRegister('a', { channels: [descriptor('y')] }).catch(() => undefined);
  for (let i = 0; i < 20 && f.registry.listChannelsRaw().length === 0; i++) await tick();
  fail();
  await registering;
  assert.equal(await opening,
    'The tune-out is recorded, but its messages may not reach the subconscious until this host opens the channel, which ' +
    'it does when the "a" server next registers this channel, if this host may open and close its channels then, or ' +
    'now if you call tune_out again; ' +
    `opening it now didn't complete: ${timedOut}`, 'the refused open was for the registration that went');
  assert.deepEqual(f.server.sent, ['open y', 'open y'], 'the tune-out\'s open, then the reconcile\'s');
});

test('a tune-out cancelled and made again while its open was out says it isn\'t in effect any more, and the new one stands', async () => {
  const f = await closedChannel();
  let release!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { release = resolve; });
    return { channel: descriptor(channelId) };
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const first = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !release; i++) await tick();
  f.registry.cancelTuneOut('a', 'y', 'open', 'agent-tool');
  f.registry.enterTuneOut('a', 'y', { ...PARAMS, epochId: 'e2' }, 'agent-tool');
  const second = f.registry.openForTuneOut('a', 'y');
  release();
  assert.equal(await first,
    REPLACED);
  assert.equal(await second, undefined);
  assert.deepEqual(f.server.sent, ['open y'], 'one open, which the second tune-out waited for');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e2');
});

test('openForTuneOut with no tune-out recorded answers that none is in effect, and sends nothing', async () => {
  const f = await closedChannel();
  assert.equal(await f.registry.openForTuneOut('a', 'y'), REPLACED);
  assert.deepEqual(f.server.sent, []);
});

test('a tune-out answers first that it ended, then the server\'s state, then the grant, then the registration', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  f.registry.cancelTuneOut('a', 'y', 'open', 'agent-tool');
  f.server.isConnected = false;
  f.server.willReconnect = true;
  assert.equal(await opening, REPLACED, 'ended, with the server down');
  const g = await closedChannel();
  g.servers.set('a', { ...up(['channels.lifecycle']), isConnected: false, willReconnect: true });
  g.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await g.registry.openForTuneOut('a', 'y'), DOWN, 'down, without the grant');
  const h = await closedChannel();
  h.servers.set('a', up(['channels.lifecycle']));
  h.registry.enterTuneOut('a', 'nope', PARAMS, 'agent-tool');
  assert.equal(await h.registry.openForTuneOut('a', 'nope'),
    'The tune-out is recorded, but this host isn\'t permitted to open or close the "a" server\'s channels, so its ' +
    'messages reach the subconscious only as that server sends them, and calling tune_out again won\'t change that. If you need this host to open it, ask whoever runs ' +
    'this host.', 'without the grant, not registered');
});

test('a tune-out cancelled and made again while the work queued before it ran answers for its own epoch', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let release!: () => void;
  const close = f.server.sendChannelsClose;
  f.server.sendChannelsClose = async (params) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return close(params);
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  for (let i = 0; i < 20 && !release; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const first = f.registry.openForTuneOut('a', 'y');
  f.registry.cancelTuneOut('a', 'y', 'open', 'agent-tool');
  f.registry.enterTuneOut('a', 'y', { ...PARAMS, epochId: 'e2' }, 'agent-tool');
  const second = f.registry.openForTuneOut('a', 'y');
  release();
  assert.equal(await first, REPLACED);
  assert.equal(await second, undefined);
  await closing;
  assert.deepEqual(f.server.sent, ['close y', 'open y'], 'the close\'s own operation reopened it');
  assert.equal(f.isOpen(), true);
});

test('a tune-out whose server drops, or whose grant lapses, while its own open is out answers from the state then', async () => {
  for (const [change, refused] of [['drop', false], ['drop', true], ['lapse', false], ['lapse', true]] as const) {
    const f = await closedChannel();
    let release!: () => void;
    f.server.sendChannelsOpen = async ({ channelId }) => {
      f.server.sent.push(`open ${channelId}`);
      await new Promise<void>((resolve) => { release = resolve; });
      if (refused) throw new McplRequestError('The "a" server refused the request.', 'error-response');
      return { channel: descriptor(channelId) };
    };
    f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
    const opening = f.registry.openForTuneOut('a', 'y');
    for (let i = 0; i < 20 && !release; i++) await tick();
    if (change === 'drop') {
      f.server.isConnected = false;
      f.server.willReconnect = true;
    } else {
      f.server.grant = grant(['channels.lifecycle']);
    }
    release();
    const label = `${change}, the open ${refused ? 'refused' : 'answered'}`;
    if (change === 'drop') assert.equal(await opening, DOWN, label);
    else {
      assert.equal(await opening, refused
        ? 'The tune-out is recorded, but this host isn\'t permitted to open or close the "a" server\'s channels, so its ' +
          'messages reach the subconscious only as that server sends them, and calling tune_out again won\'t change that. If you need this host to open it, ask whoever runs ' +
          'this host.'
        : undefined, label);
    }
    assert.deepEqual(f.server.sent, ['open y'], label);
  }
});

test('a tune-out cancelled, and its channel then closed, while its open was out says it isn\'t in effect any more', async () => {
  const f = await closedChannel();
  let release!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { release = resolve; });
    return { channel: descriptor(channelId) };
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !release; i++) await tick();
  // The tune-out is cancelled and the channel closed, as a close's refusal of
  // a tuned-out channel advises, while the open is out.
  f.registry.cancelTuneOut('a', 'y', 'open', 'test');
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  release();
  assert.equal(await opening,
    REPLACED);
  await closing;
  assert.equal(f.registry.getDesiredState('a', 'y'), 'closed');
});

test('a tune-out whose open fails after it was cancelled and its channel closed says it isn\'t in effect any more', async () => {
  const f = await closedChannel();
  let fail!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { fail = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !fail; i++) await tick();
  // Cancelled and closed while the open is out, as above.
  f.registry.cancelTuneOut('a', 'y', 'open', 'test');
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  fail();
  assert.equal(await opening,
    REPLACED);
  await closing;
});

test('a tune-out that ended while its open was out says it isn\'t in effect any more', async () => {
  const f = await closedChannel();
  let release!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { release = resolve; });
    return { channel: descriptor(channelId) };
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !release; i++) await tick();
  // As the coordinator ends one, for its cancel or its duration.
  f.registry.cancelTuneOut('a', 'y', 'open', 'duration');
  release();
  assert.equal(await opening,
    REPLACED);
});

test('a tune-out that ended while the work queued before it ran says it isn\'t in effect any more', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  let release!: () => void;
  const close = f.server.sendChannelsClose;
  f.server.sendChannelsClose = async (params) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return close(params);
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  for (let i = 0; i < 20 && !release; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  f.registry.cancelTuneOut('a', 'y', 'open', 'agent-tool');
  release();
  assert.equal(await opening,
    REPLACED);
  await closing;
  // The close's own operation reopens the channel decided open again, and
  // the ended tune-out sends nothing of its own.
  assert.deepEqual(f.server.sent, ['open y', 'close y', 'open y']);
});

test('a tune-out made while a decline\'s acknowledgment is out opens the channel once, by the tune-out', async () => {
  // A registration whose close timed out leaves the transport unconfirmed,
  // so the decline would queue work for it, but its decision is replaced
  // before then, and a decline acts only on its own decision.
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  const servers = new Map<string, Server>();
  const server = up();
  servers.set('a', server);
  const registry = new ChannelRegistry(
    { getServer: (id: string) => servers.get(id) } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, () => {},
  );
  server.sendChannelsClose = async () => { throw new McplRequestError(timedOut, 'no-response'); };
  await registry.handleRegister('a', { channels: [descriptor('y')] });
  for (let i = 0; i < 5; i++) await tick();
  server.sendChannelsClose = async ({ channelId }) => { server.sent.push(`close ${channelId}`); return {}; };
  server.sent.length = 0;
  const acks: Array<() => void> = [];
  server.sendChannelsAcknowledge = () => new Promise((resolve) => { acks.push(() => resolve({ acknowledged: true })); });
  const declining = registry.handleChannelToolCall('channel_decline', { channelId: 'y', messageId: 'm1', acknowledge: '👀' });
  for (let i = 0; i < 50 && acks.length === 0; i++) await tick();
  assert.equal(acks.length, 1, 'the acknowledgment is out');
  registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = registry.openForTuneOut('a', 'y');
  acks.shift()!();
  const declined = await declining;
  assert.equal(await opening, undefined);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(server.sent, ['open y'], 'one open, the tune-out\'s');
  assert.equal((declined.data as { status?: string } | undefined)?.status, 'replaced');
  assert.equal((registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(destinationKey({ serverId: 'a', channelId: 'y' }))?.open, true);
});

test('a decline of a tuned-out channel is refused, open or not, and changes nothing', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const refusal = {
    success: false,
    isError: true,
    error: 'Channel "y" is tuned out: its messages go to the subconscious, and channel_decline doesn\'t change that. Call ' +
      'tune_out with channelId "y" and mode "cancel" for it to resume normal attention; cancelling delivers the diverted ' +
      'backlog.',
    data: { refusal: 'tuned-out', channelId: 'y', serverId: 'a' },
  };
  assert.equal(f.isOpen(), false, 'its transport isn\'t open');
  assert.deepEqual(await f.registry.handleChannelToolCall('channel_decline', { channelId: 'y', messageId: 'm1', acknowledge: '👀' }), refusal);
  assert.deepEqual(f.server.sent, [], 'no acknowledgment, and nothing for the transport');
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1', 'the tune-out stands');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  f.server.sent.length = 0;
  assert.deepEqual(await f.registry.handleChannelToolCall('channel_decline', { channelId: 'y', messageId: 'm1' }), refusal, 'open');
  assert.deepEqual(f.server.sent, []);
});

test('a close of a tuned-out channel is refused, open or not, and changes nothing', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const refusal = {
    success: false,
    isError: true,
    error: 'Channel "y" is tuned out: its messages go to the subconscious, and channel_close doesn\'t change that. Call ' +
      'tune_out with channelId "y" and mode "cancel" for it to resume normal attention; cancelling delivers the diverted ' +
      'backlog, and channel_close closes it after that.',
    data: { refusal: 'tuned-out', channelId: 'y', serverId: 'a' },
  };
  const agent = { kind: 'agent' as const, agentName: 'scout' };
  assert.equal(f.isOpen(), false, 'its transport isn\'t open');
  assert.deepEqual(await f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }, agent), refusal);
  assert.deepEqual(f.server.sent, [], 'nothing for the transport');
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1', 'the tune-out stands');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  f.server.sent.length = 0;
  assert.deepEqual(await f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }, agent), refusal, 'open');
  assert.deepEqual(f.server.sent, []);
  assert.equal(f.isOpen(), true, 'its transport stays open');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1');
});

test('a close of a tuned-out channel while the tune-out\'s own open is out is refused at once, and the open answers for the tune-out', async () => {
  const f = await closedChannel();
  let release!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { release = resolve; });
    return { channel: descriptor(channelId) };
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !release; i++) await tick();
  // The refusal comes while the open is still held: a close that waited on
  // the channel's queue first would never answer here.
  const closed = await f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }, { kind: 'agent', agentName: 'scout' });
  assert.equal(closed.isError, true);
  assert.deepEqual(closed.data, { refusal: 'tuned-out', channelId: 'y', serverId: 'a' });
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out');
  release();
  assert.equal(await opening, undefined, 'the tune-out stands, and its open answers success');
  assert.deepEqual(f.server.sent, ['open y'], 'no close went out');
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1');
});

test('a module\'s close of a tuned-out channel that certifies an idle lease is refused as a stand-down, and changes nothing', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  f.server.sent.length = 0;
  const module = { kind: 'module' as const };
  assert.deepEqual(
    await f.registry.handleChannelToolCall('channel_close', { channelId: 'y', source: 'subscription-gc', overrideExplicitOpen: true }, module),
    {
      success: false,
      isError: false,
      error: 'Channel "y" is tuned out: its messages go to the subconscious, and channel_close doesn\'t change that. Call ' +
        'tune_out with channelId "y" and mode "cancel" for it to resume normal attention; cancelling delivers the diverted ' +
        'backlog, and channel_close closes it after that.',
      data: { refusal: 'tuned-out', channelId: 'y', serverId: 'a' },
    },
  );
  assert.deepEqual(f.server.sent, [], 'nothing for the transport');
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1', 'the tune-out stands');
  // Without the lease, the housekeeping guard refuses it first, as before.
  const unleased = await f.registry.handleChannelToolCall('channel_close', { channelId: 'y', source: 'subscription-gc' }, module);
  assert.equal(unleased.isError, false);
  assert.deepEqual(unleased.data, { refusal: 'explicit-open', channelId: 'y', serverId: 'a' });
  assert.deepEqual(f.server.sent, []);
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1');
});

test('a tune-out waits for a registration that came back on the same connection while the work before it ran', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let refuse!: () => void;
  f.server.sendChannelsClose = async ({ channelId }) => {
    f.server.sent.push(`close ${channelId}`);
    await new Promise<void>((resolve) => { refuse = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }).catch(() => undefined);
  for (let i = 0; i < 20 && !refuse; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  // The server registers its channels again on the same connection, with no
  // removal first, so the close that's out was for the entry this replaces,
  // and the registration's reconcile, an open, queues behind it.
  const registering = f.registry.handleRegister('a', { channels: [descriptor('y')] }).catch(() => undefined);
  for (let i = 0; i < 5; i++) await tick();
  refuse();
  assert.equal(await opening, undefined);
  await registering;
  await closing;
  assert.deepEqual(f.server.sent, ['close y', 'open y'], 'one open, the registration\'s');
  assert.equal(f.isOpen(), true);
});

test('a tune-out waits for the reconcile a channels/changed removal and addition queued while the work before it ran', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let answerClose!: () => void;
  f.server.sendChannelsClose = async ({ channelId }) => {
    f.server.sent.push(`close ${channelId}`);
    await new Promise<void>((resolve) => { answerClose = resolve; });
    return {};
  };
  let opens = 0;
  let answerSecond!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    // The close's operation opens the new entry itself; the reconcile the
    // change queued opens it again, and that open is held.
    if (++opens === 2) await new Promise<void>((resolve) => { answerSecond = resolve; });
    return { channel: descriptor(channelId) };
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' }).catch(() => undefined);
  for (let i = 0; i < 20 && !answerClose; i++) await tick();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  let settled = false;
  const opening = f.registry.openForTuneOut('a', 'y').finally(() => { settled = true; });
  // The change's reconcile queues behind the close that's out, so it's let
  // run rather than awaited.
  const changing = f.registry.handleChanged('a', { removed: ['y'], added: [descriptor('y')] }).catch(() => undefined);
  for (let i = 0; i < 5; i++) await tick();
  answerClose();
  for (let i = 0; i < 40 && !answerSecond; i++) await tick();
  assert.ok(answerSecond, 'the change\'s reconcile sends its open');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(settled, false, 'the answer waits for the reconcile the change queued');
  answerSecond();
  assert.equal(await opening, undefined);
  await changing;
  await closing;
  assert.deepEqual(f.server.sent, ['close y', 'open y', 'open y']);
  assert.equal(f.isOpen(), true);
});

for (const late of ['succeeds', 'fails'] as const) {
  test(`a tune-out confirmed by its own operation stays open when a redundant open queued behind it ${late}`, async () => {
    const f = await closedChannel();
    let opens = 0;
    let answerFirst!: () => void;
    f.server.sendChannelsOpen = async ({ channelId }) => {
      f.server.sent.push(`open ${channelId}`);
      opens++;
      if (opens === 1) await new Promise<void>((resolve) => { answerFirst = resolve; });
      if (opens === 3 && late === 'fails') {
        throw new McplRequestError('The "a" server refused the request.', 'error-response');
      }
      return { channel: descriptor(channelId) };
    };
    f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
    const opening = f.registry.openForTuneOut('a', 'y');
    for (let i = 0; i < 20 && !answerFirst; i++) await tick();
    // While the tune-out's own open is out, the server removes and adds the
    // channel: its operation opens the new entry, which confirms it, and the
    // change's reconcile sends one more open.
    const changing = f.registry.handleChanged('a', { removed: ['y'], added: [descriptor('y')] }).catch(() => undefined);
    for (let i = 0; i < 5; i++) await tick();
    answerFirst();
    assert.equal(await opening, undefined, 'an open, failed or not, can\'t have closed the channel');
    await changing;
    assert.deepEqual(f.server.sent, ['open y', 'open y', 'open y']);
    assert.equal(f.isOpen(), true);
    assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), true);
  });
}

test('a tune-out after a failed close whose own open fails too still says its messages may not reach the subconscious', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  const refused = 'The "a" server refused the request.';
  f.server.sendChannelsClose = async ({ channelId }) => {
    f.server.sent.push(`close ${channelId}`);
    throw new McplRequestError(refused, 'error-response');
  };
  await f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  assert.equal(f.isOpen(), true, 'the flag the failed close left');
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    throw new McplRequestError(refused, 'error-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but its messages may not reach the subconscious until this host opens the channel, which ' +
    'it does when the "a" server next registers this channel, if this host may open and close its channels then, or ' +
    `now if you call tune_out again; opening it now didn't complete: ${refused}`);
  assert.deepEqual(f.server.sent, ['close y', 'open y']);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false);
});

test('a tune-out\'s open asked for again while it\'s out gets the same answer, and no second open goes out', async () => {
  const f = await closedChannel();
  let fail!: () => void;
  const refused = 'The "a" server refused the request.';
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { fail = resolve; });
    throw new McplRequestError(refused, 'error-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const first = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !fail; i++) await tick();
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false, 'an open is out');
  const again = f.registry.openForTuneOut('a', 'y');
  fail();
  const [a, b] = await Promise.all([first, again]);
  assert.equal(b, a);
  assert.match(a!, /opening it now didn't complete: The "a" server refused the request\.$/);
  assert.deepEqual(f.server.sent, ['open y']);
});

test('a tune-out whose open failed opens the channel when its open is asked for again', async () => {
  const f = await closedChannel();
  const working = f.server.sendChannelsOpen;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.match((await f.registry.openForTuneOut('a', 'y'))!, /, or now if you call tune_out again; /);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false);
  f.server.sendChannelsOpen = working;
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.deepEqual(f.server.sent, ['open y', 'open y']);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), true);
});

test('tuneOutTransportOpen reads a channel open only with a tune-out, its server up, no queued work and an open flag it takes as open', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false, 'no tune-out, the channel confirmed open');
  await f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false, 'the transport closed');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), true, 'confirmed open, nothing queued');
  // Work queued for the channel: an open, held.
  let answer!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { answer = resolve; });
    return { channel: descriptor(channelId) };
  };
  const queued = (f.registry as unknown as { applyDesiredChannelState(s: string, c: string): Promise<unknown> })
    .applyDesiredChannelState('a', 'y');
  for (let i = 0; i < 20 && !answer; i++) await tick();
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false, 'work queued for the channel');
  answer();
  await queued;
  // The queue's tail is released a few turns after the operation settles.
  for (let i = 0; i < 50 && !f.registry.tuneOutTransportOpen('a', 'y'); i++) await tick();
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), true, 'the queued work done');
  // The server goes down, and the entry keeps its flag.
  f.server.isConnected = false;
  f.server.willReconnect = true;
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false, 'the server not up');
});

test('a tune-out\'s open asked for again while it waits for work queued after it, with the flag reading open, gets the first answer', async () => {
  const f = await closedChannel();
  let opens = 0;
  let answerFirst!: () => void;
  let answerThird!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    opens++;
    if (opens === 1) await new Promise<void>((resolve) => { answerFirst = resolve; });
    if (opens === 3) {
      await new Promise<void>((resolve) => { answerThird = resolve; });
      throw new McplRequestError('The "a" server refused the request.', 'error-response');
    }
    return { channel: descriptor(channelId) };
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const first = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !answerFirst; i++) await tick();
  const changing = f.registry.handleChanged('a', { removed: ['y'], added: [descriptor('y')] }).catch(() => undefined);
  for (let i = 0; i < 5; i++) await tick();
  answerFirst();
  for (let i = 0; i < 40 && !answerThird; i++) await tick();
  // The tune-out's operation has confirmed the new entry, and the change's
  // reconcile, an open, is out: the flag reads open, but work is queued.
  assert.ok(answerThird, 'the reconcile\'s open is out');
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.tuneOutTransportOpen('a', 'y'), false, 'a repeat waits rather than answer at once');
  const again = f.registry.openForTuneOut('a', 'y');
  let answered = 0;
  void first.then(() => { answered++; });
  void again.then(() => { answered++; });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(answered, 0, 'both wait while the reconcile\'s open is out');
  answerThird();
  assert.deepEqual(await Promise.all([first, again]), [undefined, undefined]);
  await changing;
  assert.deepEqual(f.server.sent, ['open y', 'open y', 'open y'], 'no open of the repeat\'s own');
});

test('a tune-out\'s open that throws is asked for anew by the next call, not answered with the same rejection', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const registry = f.registry as unknown as { serverReach(serverId: string): unknown };
  const reach = registry.serverReach.bind(f.registry);
  let throwOnce = true;
  registry.serverReach = (serverId: string) => {
    if (throwOnce) { throwOnce = false; throw new Error('the server\'s state couldn\'t be read'); }
    return reach(serverId);
  };
  await assert.rejects(f.registry.openForTuneOut('a', 'y'), /couldn't be read/);
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.deepEqual(f.server.sent, ['open y']);
  // One that throws before it awaits anything still answers with a rejection,
  // so the dispatch's catch answers it.
  const tuneOuts = f.registry as unknown as { getTuneOutState(serverId: string, channelId: string): unknown };
  tuneOuts.getTuneOutState = () => { throw new Error('the tune-out couldn\'t be read'); };
  let opening: Promise<string | undefined> | undefined;
  assert.doesNotThrow(() => { opening = f.registry.openForTuneOut('a', 'y'); });
  await assert.rejects(opening!, /tune-out couldn't be read/);
});

test('a tune-out waits for work queued after its first wait\'s last look at the queue, before the turn that reads the state', async () => {
  const f = await closedChannel();
  const tails = (f.registry as unknown as { channelLifecycleTails: Map<string, Promise<void>> }).channelLifecycleTails;
  const lookUp = tails.get.bind(tails);
  let armed = true;
  tails.get = (key: string) => {
    const tail = lookUp(key);
    // The wait has looked and found nothing queued: work is queued now, in
    // the gap before the wait's caller resumes.
    if (tail === undefined && armed) {
      armed = false;
      void (f.registry as unknown as { applyDesiredChannelState(s: string, c: string): Promise<unknown> })
        .applyDesiredChannelState('a', 'y').catch(() => undefined);
    }
    return tail;
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.deepEqual(f.server.sent, ['open y'], 'the queued work\'s open, and none of the tune-out\'s own behind it');
});

test('a tune-out waits for work queued while the work its last wait waited for ran', async () => {
  const f = await closedChannel();
  const apply = () => (f.registry as unknown as { applyDesiredChannelState(s: string, c: string): Promise<unknown> })
    .applyDesiredChannelState('a', 'y').catch(() => undefined);
  let opens = 0;
  const held: Array<() => void> = [];
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    opens++;
    // The tune-out's own open queues a reconcile behind it, whose open is
    // held; the last open is held too.
    if (opens === 1) void apply();
    if (opens >= 2) await new Promise<void>((resolve) => { held.push(resolve); });
    return { channel: descriptor(channelId) };
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  let answered = false;
  const opening = f.registry.openForTuneOut('a', 'y').finally(() => { answered = true; });
  for (let i = 0; i < 40 && held.length < 1; i++) await tick();
  assert.equal(opens, 2, 'the reconcile\'s open is out, and the answer waits for it');
  // More work is queued while the reconcile the wait is waiting for runs.
  void apply();
  held.shift()!();
  for (let i = 0; i < 40 && held.length < 1; i++) await tick();
  assert.equal(opens, 3, 'the work queued meanwhile sends its open');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(answered, false, 'the answer waits for the work queued while the reconcile ran');
  held.shift()!();
  assert.equal(await opening, undefined);
  assert.deepEqual(f.server.sent, ['open y', 'open y', 'open y']);
});

// --- tune_out itself, through the framework ---------------------------------

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

/** A stubbed open that holds its answer until the test settles it, and says
 *  when it's been called, so a test waits for that rather than a fixed time. */
function heldOpen() {
  let held: { resolve(answer: string | undefined): void; reject(error: Error): void } | undefined;
  let called!: () => void;
  const calledOnce = new Promise<void>((resolve) => { called = resolve; });
  return {
    open: () => new Promise<string | undefined>((resolve, reject) => { held = { resolve, reject }; called(); }),
    async entered(): Promise<void> {
      let timer!: NodeJS.Timeout;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for the open to be called')), 10_000);
      });
      try { await Promise.race([calledOnce, late]); } finally { clearTimeout(timer); }
      // Let the turns after the call run; the dispatch pushes an answer the
      // moment it gives one (the framework's answers()).
      for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    },
    resolve: (answer: string | undefined) => held!.resolve(answer),
    reject: (error: Error) => held!.reject(error),
  };
}

async function framework(t: { after(fn: () => Promise<void>): void }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-transport-'));
  const statusPath = join(tempDir, 'status.jsonl');
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const fw = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath } }],
    modules: [],
  });
  t.after(async () => { await fw.stop(); rmSync(tempDir, { recursive: true, force: true }); });
  const i = fw as unknown as {
    channelRegistry: ChannelRegistry & { handleChannelToolCall(name: string, input: unknown): Promise<{ data?: unknown }> };
    agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ text?: string }>; metadata?: Record<string, unknown> }> } }>;
  };
  // What the dispatch pushes as tune_out's answers, as it pushes them: an
  // answer given early shows here at once.
  const answers: unknown[] = [];
  const pushing = fw as unknown as { pushEvent(event: { type: string; toolName?: string }): void };
  const push = pushing.pushEvent.bind(fw);
  pushing.pushEvent = (event) => {
    if (event.type === 'tool-result' && event.toolName === 'tune_out') answers.push(event);
    push(event);
  };
  await fw.start();
  const deadline = Date.now() + 10_000;
  while (i.channelRegistry.listChannelsRaw().length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for registration');
    await new Promise((r) => setTimeout(r, 20));
  }
  let emitted = 0;
  const events = () => jsonLines<{ event: string }>(statusPath);
  return {
    i,
    membrane,
    events,
    emit: (text: string) => appendFileSync(commandPath, `ambient m${++emitted} ${text}\n`),
    // A script's call through the framework's bridge, as its text, whether
    // it's flagged an error, and whether it was refused before it ran, which
    // tells the script nothing was done.
    script: async (tool: string, input: Record<string, unknown>) => {
      const answer = await scriptCall(fw, 'scout', tool, input);
      return { text: answerText(answer), isError: answer.refused || answer.isError, refused: answer.refused };
    },
    answers: () => answers.length,
  };
}

test('tune_out of a channel this host closed opens it, so its traffic reaches the subconscious, and answers as before', async (t) => {
  const f = await framework(t);
  await f.i.channelRegistry.handleChannelToolCall('channel_close', { channelId: CHANNEL });
  // The fixture server sends nothing for a channel the host has closed.
  f.emit('held back');
  const heldBy = Date.now() + 10_000;
  while (!f.events().some((e) => e.event === 'incoming-withheld')) {
    if (Date.now() > heldBy) throw new Error('timed out waiting for the server to hold a message back');
    await new Promise((r) => setTimeout(r, 20));
  }
  const closedAt = f.events().length;
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL }),
    { text: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes }), isError: false, refused: false });
  assert.deepEqual(f.events().slice(closedAt).map((e) => e.event), ['channel-opened']);
  f.emit('release chatter');
  const scout = f.i.agents.get('scout')!.getContextManager();
  const deadline = Date.now() + 10_000;
  while (!scout.getAllMessages().some((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the diverted message');
    await new Promise((r) => setTimeout(r, 20));
  }
});

test('tune_out answers a success carrying openForTuneOut\'s answer as openError', async (t) => {
  const f = await framework(t);
  const registry = f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> };
  registry.openForTuneOut = async () => 'The tune-out is recorded, but not yet.';
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL }), {
    text: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes, openError: 'The tune-out is recorded, but not yet.' }),
    isError: false,
    refused: false,
  });
});

test('tune_out\'s answer waits while its open is out', async (t) => {
  const f = await framework(t);
  const registry = f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> };
  const held = heldOpen();
  registry.openForTuneOut = held.open;
  const answering = f.script('tune_out', { channelId: CHANNEL });
  await held.entered();
  assert.equal(f.answers(), 0, 'no answer while the open is out');
  held.resolve(undefined);
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(await answering, {
    text: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes }), isError: false, refused: false,
  });
});

test('tune_out whose open throws answers a success that says opening its channel failed, never a rejection', async (t) => {
  const f = await framework(t);
  const registry = f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> };
  registry.openForTuneOut = async () => { throw new Error('the store went away'); };
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL }), {
    text: JSON.stringify({
      tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes,
      openError: 'The tune-out is recorded, but its messages may not reach the subconscious, since opening its channel ' +
        'failed: the store went away',
    }),
    isError: false,
    refused: false,
  });
});

test('tune_out repeated for a channel already tuned out whose transport is open refuses as before, and opens nothing', async (t) => {
  const f = await framework(t);
  assert.equal((await f.script('tune_out', { channelId: CHANNEL })).isError, false);
  const registry = f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> };
  let calls = 0;
  registry.openForTuneOut = async () => { calls++; return undefined; };
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  const again = await f.script('tune_out', { channelId: CHANNEL });
  assert.equal(again.isError, true);
  assert.equal(again.refused, false, 'a failure after the call ran, not a refusal before it');
  assert.equal(again.text,
    `Nothing changed: "${CHANNEL}" is already tuned out, with cadenceSeconds ${cadenceSeconds}, backlogCap ` +
    `${backlogCap} and maxWakes ${maxWakes}. To change those, cancel it first with tune_out mode "cancel", which ` +
    'delivers its backlog to you now, then call tune_out again with the new settings.');
  assert.equal(calls, 0, 'its transport is open, with nothing to wait for');
});

for (const outcome of [
  'opens it', 'fails', 'throws', 'ends', 'ends, the open answering success', 'is replaced', 'is replaced, the open answering success',
] as const) {
  test(`tune_out repeated for a channel already tuned out whose transport isn't open tries the open again, and ${outcome}`, async (t) => {
    const f = await framework(t);
    assert.equal((await f.script('tune_out', { channelId: CHANNEL })).isError, false);
    const registry = f.i.channelRegistry as unknown as {
      openForTuneOut(serverId: string, channelId: string): Promise<string | undefined>;
      tuneOutTransportOpen(serverId: string, channelId: string): boolean;
    };
    registry.tuneOutTransportOpen = () => false;
    const held = heldOpen();
    registry.openForTuneOut = held.open;
    const answered = f.answers();
    const answering = f.script('tune_out', { channelId: CHANNEL });
    await held.entered();
    assert.equal(f.answers(), answered, 'the repeat\'s answer waits for the open');
    if (outcome === 'throws') held.reject(new Error('the store went away'));
    else if (outcome === 'ends') {
      // The tune-out ends while the open is out, and the open answers so.
      f.i.channelRegistry.cancelTuneOut('disc', CHANNEL, 'open', 'test');
      held.resolve(REPLACED);
    } else if (outcome === 'ends, the open answering success') {
      // The open answered for the tune-out before it ended.
      f.i.channelRegistry.cancelTuneOut('disc', CHANNEL, 'open', 'test');
      held.resolve(undefined);
    } else if (outcome === 'is replaced' || outcome === 'is replaced, the open answering success') {
      // The tune-out is cancelled and made again, under a new epoch, while
      // the open is out.
      f.i.channelRegistry.cancelTuneOut('disc', CHANNEL, 'open', 'test');
      f.i.channelRegistry.enterTuneOut('disc', CHANNEL, { ...PARAMS, epochId: 'e2', cadenceSeconds: 90 }, 'agent-tool');
      held.resolve(outcome === 'is replaced' ? REPLACED : undefined);
    } else held.resolve(outcome === 'fails' ? 'The tune-out is recorded, but not yet.' : undefined);
    const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
    if (outcome === 'ends' || outcome === 'ends, the open answering success' || outcome === 'is replaced' ||
      outcome === 'is replaced, the open answering success') {
      assert.deepEqual(await answering, { text: REPLACED, isError: true, refused: false },
        'nothing describes the tune-out the repeat read as standing, nor the one that replaced it');
      return;
    }
    const transport = {
      'opens it': 'Its transport is open now, so its messages reach the subconscious.',
      fails: 'The tune-out is recorded, but not yet.',
      throws: 'The tune-out is recorded, but its messages may not reach the subconscious, since opening its channel ' +
        'failed: the store went away.',
    }[outcome];
    assert.deepEqual(await answering, {
      text: `Nothing changed in the tune-out: "${CHANNEL}" is already tuned out, with cadenceSeconds ${cadenceSeconds}, ` +
        `backlogCap ${backlogCap} and maxWakes ${maxWakes}. ${transport} To change those, cancel it first with tune_out ` +
        'mode "cancel", which delivers its backlog to you now, then call tune_out again with the new settings.',
      isError: true,
      // Its open may have run, so it's a failure, not a refusal saying
      // nothing was done.
      refused: false,
    });
  });
}

test('an agent\'s close of a tuned-out channel is refused, and after the cancel delivers the backlog, the close goes through', async (t) => {
  const f = await framework(t);
  const scout = f.i.agents.get('scout')!.getContextManager();
  const diverted = () => scout.getAllMessages().filter((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut).length;
  assert.equal((await f.script('tune_out', { channelId: CHANNEL })).isError, false);
  f.emit('backlog one');
  f.emit('backlog two');
  const deadline = Date.now() + 10_000;
  while (diverted() < 2) {
    if (Date.now() > deadline) throw new Error('timed out waiting for two diverted messages');
    await new Promise((r) => setTimeout(r, 20));
  }
  const refused = await f.script('channel_close', { channelId: CHANNEL });
  assert.equal(refused.isError, true);
  assert.equal(refused.refused, false, 'a failure after the call ran, not a refusal before it');
  assert.equal(refused.text,
    `Channel "${CHANNEL}" is tuned out: its messages go to the subconscious, and channel_close doesn't change that. Call ` +
    `tune_out with channelId "${CHANNEL}" and mode "cancel" for it to resume normal attention; cancelling delivers the ` +
    'diverted backlog, and channel_close closes it after that.');
  assert.equal(f.i.channelRegistry.getDesiredState('disc', CHANNEL), 'tuned-out', 'the tune-out stands');
  // The refusal's advice: cancel, which delivers the backlog, then close.
  f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Read the backlog.' }]));
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL, mode: 'cancel' }),
    { text: JSON.stringify({ cancelled: CHANNEL }), isError: false, refused: false });
  const dumped = () => scout.getAllMessages().find((m) => m.content.some((b) => (b.text ?? '').includes('<tuned-out-backlog')));
  const until = Date.now() + 10_000;
  while (!dumped()) {
    if (Date.now() > until) throw new Error('timed out waiting for the backlog to reach scout');
    await new Promise((r) => setTimeout(r, 20));
  }
  const text = dumped()!.content.map((b) => b.text ?? '').join('');
  assert.ok(text.includes('backlog one') && text.includes('backlog two'), text);
  assert.deepEqual(await f.script('channel_close', { channelId: CHANNEL }),
    { text: JSON.stringify({ channelId: CHANNEL, serverId: 'disc', status: 'closed' }), isError: false, refused: false });
  assert.equal(f.i.channelRegistry.getDesiredState('disc', CHANNEL), 'closed');
});

type RestartInternals = {
  channelRegistry: ChannelRegistry;
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ metadata?: Record<string, unknown> }> } }>;
};

/**
 * A store whose first start, with a subconscious, tuned the channel out and
 * diverted `divert` messages, and stopped; `start` makes the next start of
 * it from `options`, stopped when the test ends, and `logged` holds what
 * console.error got while `capture` ran.
 */
async function tunedOutStore(t: { after(fn: () => Promise<void>): void }, divert: number) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-transport-'));
  const statusPath = join(tempDir, 'status.jsonl');
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const running: AgentFramework[] = [];
  // Each start stops before the store goes.
  t.after(async () => {
    for (const fw of running) await fw.stop().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  });
  const server = { id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath } };
  const config = (subconscious: boolean, servers: boolean) => ({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    ...(subconscious ? { subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' } } : {}),
    mcplServers: servers ? [server] : [],
    modules: [],
  });
  const first = await AgentFramework.create(config(true, true));
  running.push(first);
  await first.start();
  const i1 = first as unknown as RestartInternals;
  let deadline = Date.now() + 10_000;
  while (i1.channelRegistry.listChannelsRaw().length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for registration');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await scriptCall(first, 'scout', 'tune_out', { channelId: CHANNEL })).refused, false);
  for (let n = 1; n <= divert; n++) appendFileSync(commandPath, `ambient m${n} backlog ${n}\n`);
  const scout = i1.agents.get('scout')!.getContextManager();
  deadline = Date.now() + 10_000;
  while (scout.getAllMessages().filter((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut).length < divert) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${divert} diverted messages`);
    await new Promise((r) => setTimeout(r, 20));
  }
  await first.stop();
  running.splice(running.indexOf(first), 1);
  const logged: string[] = [];
  const capture = async <T>(fn: () => Promise<T>): Promise<T> => {
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try { return await fn(); } finally { console.error = error; }
  };
  const start = async (subconscious: boolean, servers: boolean) => {
    const fw = await capture(() => AgentFramework.create(config(subconscious, servers)));
    running.push(fw);
    return fw;
  };
  return { start, capture, logged, server };
}

const endedLine = `"${CHANNEL}" on the "disc" server was tuned out, and nothing on this host watches or cancels tune-outs, so ` +
  'the tune-out ends here and the channel is decided open again.';

test('a tune-out on record at a start with no subconscious ends there, its channel decided open again, and the log names it and the messages it diverted', async (t) => {
  const store = await tunedOutStore(t, 2);
  const second = await store.start(false, true);
  const registry = (second as unknown as RestartInternals).channelRegistry;
  assert.equal(registry.getDesiredState('disc', CHANNEL), 'open', 'decided open again, as a cancel leaves it');
  assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
  assert.ok(store.logged.includes(`[tune-out] ${endedLine} The 2 messages it diverted stay here, and nothing will deliver them ` +
    'as its backlog.'), store.logged.join('\n'));
});

test('the ending counts a diverted message still queued to be written, and says so in the singular', async (t) => {
  const store = await tunedOutStore(t, 0);
  const second = await store.start(false, true);
  const i = second as unknown as RestartInternals & {
    deferredMessages: Array<{ id: string; seq: number; participant: string; content: unknown[]; metadata?: unknown; forAgent?: string; heldAt: number }>;
    endTuneOutsWithoutCoordinator(): void;
  };
  // A tune-out recorded on this start, with one diverted write still held
  // for the primary and one for another agent, which isn't the primary's
  // backlog.
  i.channelRegistry.enterTuneOut('disc', CHANNEL, { ...PARAMS, epochId: 'held' }, 'agent-tool');
  const diverted = { participant: 'chatter', content: [{ type: 'text', text: 'held' }], metadata: { tuneOut: { epochId: 'held' } }, heldAt: Date.now() };
  i.deferredMessages.push({ id: 'w1', seq: 1, ...diverted }, { id: 'w2', seq: 2, ...diverted, forAgent: 'someone-else' });
  await store.capture(async () => { i.endTuneOutsWithoutCoordinator(); });
  assert.ok(store.logged.includes(`[tune-out] ${endedLine} The 1 message it diverted stays here, and nothing will deliver it as ` +
    'its backlog.'), store.logged.join('\n'));
  i.deferredMessages.length = 0;
});

test('a tune-out on record when a start without servers connects one later ends then, keeping the agent\'s provenance', async (t) => {
  const store = await tunedOutStore(t, 0);
  // A start with a subconscious but no servers makes no coordinator, since
  // the channel subsystem comes up only at the connect.
  const second = await store.start(true, false);
  await store.capture(() => second.connectMcplServer(store.server));
  const registry = (second as unknown as RestartInternals).channelRegistry;
  assert.equal(registry.getDesiredState('disc', CHANNEL), 'open');
  assert.equal(registry.getTuneOutState('disc', CHANNEL), null);
  assert.ok(store.logged.includes(`[tune-out] ${endedLine}`), store.logged.join('\n'));
  const deadline = Date.now() + 10_000;
  while (registry.listChannelsRaw().length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for registration');
    await new Promise((r) => setTimeout(r, 20));
  }
  // The agent tuned it out, so the record stays the agent's: a housekeeping
  // close with no lease is still refused as an explicit open.
  const unleased = await registry.handleChannelToolCall('channel_close', { channelId: CHANNEL, source: 'subscription-gc' }, { kind: 'module' });
  assert.deepEqual(unleased.data, { refusal: 'explicit-open', channelId: CHANNEL, serverId: 'disc' });
});

test('a tune-out whose ending fails at a start with no subconscious stays recorded, and the log says so', async (t) => {
  const store = await tunedOutStore(t, 0);
  const cancel = ChannelRegistry.prototype.cancelTuneOut;
  ChannelRegistry.prototype.cancelTuneOut = () => { throw new Error('the store refused the write'); };
  let second: AgentFramework;
  try {
    second = await store.start(false, true);
  } finally {
    ChannelRegistry.prototype.cancelTuneOut = cancel;
  }
  const registry = (second as unknown as RestartInternals).channelRegistry;
  assert.equal(registry.getDesiredState('disc', CHANNEL), 'tuned-out');
  assert.ok(store.logged.includes(`[tune-out] "${CHANNEL}" on the "disc" server is tuned out, and nothing on this host ` +
    'watches or cancels tune-outs, but ending this one failed, so it stays recorded until a start that can end it: the ' +
    'store refused the write.'), store.logged.join('\n'));
});

test('a decline of a tuned-out channel whose transport isn\'t open is refused, and the backlog survives to the cancel', async (t) => {
  const f = await framework(t);
  const scout = f.i.agents.get('scout')!.getContextManager();
  const diverted = () => scout.getAllMessages().filter((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut).length;
  assert.equal((await f.script('tune_out', { channelId: CHANNEL })).isError, false);
  f.emit('backlog one');
  f.emit('backlog two');
  const deadline = Date.now() + 10_000;
  while (diverted() < 2) {
    if (Date.now() > deadline) throw new Error('timed out waiting for two diverted messages');
    await new Promise((r) => setTimeout(r, 20));
  }
  // A transport that isn't confirmed open, as a failed open, a retarget or a
  // dropped connection leaves it, while the tune-out stands.
  (f.i.channelRegistry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(destinationKey({ serverId: 'disc', channelId: CHANNEL }))!.open = false;
  const declined = await f.script('channel_decline', { channelId: CHANNEL, messageId: 'backlog-one' });
  assert.equal(declined.isError, true);
  assert.equal(declined.refused, false);
  assert.match(declined.text, /is tuned out: its messages go to the subconscious, and channel_decline doesn't change that/);
  f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Read the backlog.' }]));
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL, mode: 'cancel' }),
    { text: JSON.stringify({ cancelled: CHANNEL }), isError: false, refused: false });
  const dumped = () => scout.getAllMessages().find((m) => m.content.some((b) => (b.text ?? '').includes('<tuned-out-backlog')));
  const until = Date.now() + 10_000;
  while (!dumped()) {
    if (Date.now() > until) throw new Error('timed out waiting for the backlog to reach scout');
    await new Promise((r) => setTimeout(r, 20));
  }
  const dump = dumped()!;
  const text = dump.content.map((b) => b.text ?? '').join('');
  assert.ok(text.includes('backlog one') && text.includes('backlog two'), text);
});
