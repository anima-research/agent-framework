/**
 * What the channel tools and speech tell an agent when they can't do what it
 * asked: what happened, whether anything took effect, and what works from
 * there, or plainly that calling again won't change it.
 *
 * A connection's grant is empty from a transport drop until its next policy
 * exchange settles, so a server's state is read before its grant: one that's
 * gone, that this host is connecting to, or that's reconnecting reads as such,
 * and only an up server's missing grant reads as "not permitted". The state
 * words a refusal only: a granted server's channels work whatever it reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelDescriptor } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function descriptor(id: string): ChannelDescriptor {
  return { id, type: 'test', label: id, direction: 'bidirectional', address: { value: id } };
}

function grant(without: string[] = []): CapabilityGrant {
  return new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((path) => !without.includes(path))), []);
}

/** A server as the registry reads one; `isConnected` and `willReconnect`
 *  are a connection's state, and a missing one reads as connected. */
interface Server {
  grant: CapabilityGrant;
  isConnected?: boolean;
  willReconnect?: boolean;
  sendChannelsOpen(params: { channelId: string }): Promise<unknown>;
  sendChannelsClose(params: { channelId: string }): Promise<unknown>;
  sendChannelsPublish(params: { channelId: string }): Promise<unknown>;
  sendChannelsAcknowledge(params: { channelId: string }): Promise<{ acknowledged: boolean; reason?: unknown }>;
}

function up(without: string[] = []): Server {
  return {
    grant: grant(without),
    sendChannelsOpen: async ({ channelId }) => ({ channel: descriptor(channelId) }),
    sendChannelsClose: async () => ({}),
    sendChannelsPublish: async () => ({ delivered: true }),
    sendChannelsAcknowledge: async () => ({ acknowledged: true }),
  };
}

/** Between transports: the grant a drop leaves is empty. */
function down(willReconnect: boolean): Server {
  return { ...up(), grant: CapabilityGrant.empty(), isConnected: false, willReconnect };
}

/** Servers the test sets by id; `connecting` holds the ids this host is
 *  connecting to, as the framework's serverConnecting answers. */
async function fixture(channels: Record<string, string[]>) {
  const servers = new Map<string, Server | undefined>();
  const connecting = new Set<string>();
  const failures: Array<{ reason: string; channelId: string | null }> = [];
  const registry = new ChannelRegistry(
    { getServer: (id: string) => servers.get(id) } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, () => {},
    { serverConnecting: (id) => connecting.has(id), onRouteFailure: (info) => { failures.push(info); } },
  );
  for (const [serverId, ids] of Object.entries(channels)) {
    servers.set(serverId, up());
    await registry.handleRegister(serverId, { channels: ids.map(descriptor) });
  }
  const call = async (tool: string, input: Record<string, unknown>) => {
    const result = await registry.handleChannelToolCall(tool, input);
    return { ...result, data: result.data as Record<string, unknown> | undefined };
  };
  return { registry, servers, connecting, failures, call };
}

test('a channel tool that can\'t find the channel says what finds it', async () => {
  const f = await fixture({ a: ['only-a'], b: ['both'], c: ['both'] });
  assert.equal((await f.call('channel_open', { channelId: 'nope' })).error,
    'No channel has the id "nope", so nothing ran. channel_list shows the channel ids.');
  assert.equal((await f.call('channel_open', { channelId: 'only-a', serverId: 'b' })).error,
    'No channel "only-a" is on server "b", so nothing ran. It\'s on server "a": call again with serverId "a", or leave serverId out.');
  // Leaving serverId out would meet the ambiguity, so it isn't offered.
  assert.equal((await f.call('channel_close', { channelId: 'both', serverId: 'a' })).error,
    'No channel "both" is on server "a", so nothing ran. It\'s on servers "b", "c": call again with serverId set to one of them.');
  assert.equal((await f.call('channel_close', { channelId: 'nope', serverId: 'a' })).error,
    'No channel "nope" is on server "a", so nothing ran. channel_list shows the channels and their servers.');
  assert.equal((await f.call('channel_decline', { channelId: 'both', messageId: 'm1' })).error,
    'Channel "both" is on more than one server ("b", "c"), so nothing ran. Call again with serverId set to one of them.');
  const unknown = await f.call('channel_frobnicate', {});
  assert.equal(unknown.isError, true);
  assert.equal(unknown.error, 'There\'s no channel tool "channel_frobnicate", so nothing ran. Use one of the channel tools you were given.');
});

test('a channel_open or channel_close whose server isn\'t up says the change is recorded, and when it happens', async () => {
  const f = await fixture({ a: ['x'] });
  const later = 'when the "a" server next registers this channel, if this host may open and close its channels then';
  const cases: Array<[string, Server | undefined, boolean, string]> = [
    // Closed for good without reconnect: its channels stay registered here.
    ['gone', undefined, false, 'The "a" server isn\'t connected, and this host won\'t reconnect to it on its own'],
    ['connecting', undefined, true, 'This host is connecting to the "a" server'],
    ['down', down(true), false, 'The "a" server isn\'t connected, and this host is reconnecting to it'],
    // Kept registered for a child it couldn't reap, and not reconnecting.
    ['closed', down(false), false, 'The "a" server isn\'t connected, and this host won\'t reconnect to it on its own'],
    // The same, while this host restarts it, and one reconnecting too.
    ['restarting', down(false), true, 'This host is connecting to the "a" server'],
    ['restarting while reconnecting', down(true), true, 'This host is connecting to the "a" server'],
  ];
  for (const [what, server, connecting, state] of cases) {
    f.servers.set('a', server);
    if (connecting) f.connecting.add('a'); else f.connecting.delete('a');
    const back = state.includes('won\'t reconnect') ? ' If you need the server back, ask whoever runs this host.' : '';
    for (const [tool, done] of [['channel_open', 'open'], ['channel_close', 'closed']] as const) {
      const result = await f.call(tool, { channelId: 'x' });
      assert.equal(result.success, false, `${what}: ${tool}`);
      const action = tool === 'channel_open' ? 'open' : 'close';
      assert.equal(result.error, `${state}, so channel "x" may not be ${done} there yet. The ${action} is recorded and happens ` +
        `${later}, so there's no need to call ${tool} again.${back}` + (action === 'open' ? ' channel_close withdraws it.' : ''), what);
      assert.equal(f.registry.getDesiredState('a', 'x'), action === 'open' ? 'open' : 'closed', `${what}: the ${action} stays recorded`);
    }
  }
  // Reconciling opens the channel, but asks for no history.
  f.connecting.delete('a');
  f.servers.set('a', down(true));
  assert.equal((await f.call('channel_open', { channelId: 'x', backscroll: 5 })).error,
    'The "a" server isn\'t connected, and this host is reconnecting to it, so channel "x" may not be open there yet. The open ' +
    `is recorded and happens ${later}, but the history you asked for doesn't come with it: calling channel_open with ` +
    'backscroll once the server is connected asks for it. channel_close withdraws it.');
  f.servers.set('a', up(['channels.lifecycle']));
  assert.equal((await f.call('channel_open', { channelId: 'x' })).error,
    'This host isn\'t permitted to open or close the "a" server\'s channels, so this open of channel "x" didn\'t go through, ' +
    `and calling channel_open again won't change that. The open stays recorded, and happens ${later}. If you need it, ask ` +
    'whoever runs this host.');
  assert.equal(f.registry.getDesiredState('a', 'x'), 'open', 'the refused open is still recorded as a decision');
});

test('a channel_open or channel_close whose channel stopped being registered while it was out names no channel tool', async () => {
  // The server stopped listing it: no channel tool could find it now.
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['x', 'z'] });
  const server = f.servers.get('a')!;
  const fails: Array<() => void> = [];
  const lost = new McplRequestError('The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.', 'no-response');
  const later = 'when the "a" server next registers this channel, if this host may open and close its channels then';
  const held = () => new Promise<never>((_, reject) => { fails.push(() => reject(lost)); });
  // Read through a function, so an assertion doesn't narrow the length.
  const sent = () => fails.length;
  server.sendChannelsOpen = held;
  const opening = f.call('channel_open', { channelId: 'x' });
  for (let i = 0; i < 50 && sent() === 0; i++) await tick();
  assert.equal(sent(), 1, 'the open went out');
  await f.registry.handleChanged('a', { removed: ['x'] });
  fails.shift()!();
  assert.equal((await opening).error, `Channel "x" isn't registered here any more. Its open stays recorded, and happens ${later}. ` +
    'The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.');

  // A close's decision is the one that stays recorded for it.
  server.sendChannelsOpen = async ({ channelId }) => ({ channel: descriptor(channelId) });
  assert.equal((await f.call('channel_open', { channelId: 'z' })).success, true);
  server.sendChannelsClose = held;
  const closing = f.call('channel_close', { channelId: 'z' });
  for (let i = 0; i < 50 && sent() === 0; i++) await tick();
  assert.equal(sent(), 1, 'the close went out');
  await f.registry.handleChanged('a', { removed: ['z'] });
  fails.shift()!();
  assert.equal((await closing).error, `Channel "z" isn't registered here any more. Its close stays recorded, and happens ${later}. ` +
    'The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.');
});

test('a channel_open whose channel stopped being registered names the decision that stays, and who stopped listing it', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['t', 'w'] });
  const server = f.servers.get('a')!;
  const later = 'when the "a" server next registers this channel, if this host may open and close its channels then';
  const lost = new McplRequestError('The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.', 'no-response');
  const answers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  server.sendChannelsOpen = ({ channelId }) => new Promise((resolve, reject) => {
    answers.push({ resolve: () => resolve({ channel: descriptor(channelId) }), reject });
  });
  const sent = () => answers.length;

  // A tune-out decided meanwhile is the decision that stays recorded.
  const tuned = f.call('channel_open', { channelId: 't' });
  for (let i = 0; i < 50 && sent() === 0; i++) await tick();
  assert.equal(sent(), 1, 'the open went out');
  f.registry.enterTuneOut('a', 't', { epochId: 'e1', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
  await f.registry.handleChanged('a', { removed: ['t'] });
  answers.shift()!.reject(lost);
  assert.equal((await tuned).error, 'Channel "t" isn\'t registered here any more. It was tuned out meanwhile, and that stays ' +
    'recorded. The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.');

  // An answer that came after the server stopped listing it opened nothing
  // here, and the text says who stopped listing it.
  const answered = f.call('channel_open', { channelId: 'w' });
  for (let i = 0; i < 50 && sent() === 0; i++) await tick();
  assert.equal(sent(), 1, 'the open went out');
  await f.registry.handleChanged('a', { removed: ['w'] });
  answers.shift()!.resolve();
  assert.equal((await answered).error, 'Channel "w" isn\'t registered here any more: the "a" server no longer lists the ' +
    `channel. Its open stays recorded, and happens ${later}.`);
});

test('a channel_open out when this host removed the server says what it met, and the server\'s state', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['w', 'v'] });
  const server = f.servers.get('a')!;
  const answers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  server.sendChannelsOpen = ({ channelId }) => new Promise((resolve, reject) => {
    answers.push({ resolve: () => resolve({ channel: descriptor(channelId) }), reject });
  });
  const sent = () => answers.length;
  const openingW = f.call('channel_open', { channelId: 'w' });
  const openingV = f.call('channel_open', { channelId: 'v' });
  for (let i = 0; i < 50 && sent() < 2; i++) await tick();
  assert.equal(sent(), 2, 'both opens went out');
  // This host disconnects the server, which is then gone.
  f.registry.removeServer('a');
  f.servers.set('a', undefined);
  const lost = new McplRequestError('The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.', 'no-response');
  answers[0]!.resolve();
  answers[1]!.reject(lost);
  const later = 'when the "a" server next registers this channel, if this host may open and close its channels then';
  const back = 'If you need the server back, ask whoever runs this host.';
  assert.equal((await openingW).error, 'Channel "w" isn\'t registered here any more: this host disconnected the "a" server while ' +
    `the change was being made. Its open stays recorded, and happens ${later}. ${back}`);
  assert.equal((await openingV).error, 'Channel "v" isn\'t registered here any more: the "a" server isn\'t connected, and this ' +
    `host won't reconnect to it on its own. Its open stays recorded, and happens ${later}. ${back} The "a" server's ` +
    'connection closed before it answered, so whether the request took effect is unknown.');
});

test('a channel_open or channel_close that a later decision overtook says which decision stands, and what changes it', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['x', 'y'] });
  const server = f.servers.get('a')!;
  const answers: Array<() => void> = [];
  const held = (answer: unknown) => () => new Promise<unknown>((resolve) => { answers.push(() => resolve(answer)); });
  /** Answer the request held longest, once it has gone out. */
  const answer = async () => {
    for (let i = 0; i < 50 && answers.length === 0; i++) await tick();
    assert.ok(answers.length > 0, 'the request went out');
    answers.shift()!();
  };

  // A close decided while the open is out.
  server.sendChannelsOpen = held({ channel: descriptor('x') });
  const opening = f.call('channel_open', { channelId: 'x' });
  await tick();
  const closing = f.call('channel_close', { channelId: 'x' });
  await answer();
  assert.equal((await opening).error,
    'Channel "x": a later decision to close it came first, so this open doesn\'t stand. Call channel_open again to open it.');
  assert.equal((await closing).success, true);

  // The later decision is what stands even where the server dropped while
  // the open was out.
  const lost = new McplRequestError('The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.', 'no-response');
  server.sendChannelsOpen = () => new Promise<never>((_, reject) => { answers.push(() => reject(lost)); });
  const openingOnce = f.call('channel_open', { channelId: 'x' });
  await tick();
  const closingOnce = f.call('channel_close', { channelId: 'x' });
  f.servers.set('a', down(true));
  await answer();
  assert.equal((await openingOnce).error,
    'Channel "x": a later decision to close it came first, so this open doesn\'t stand. Call channel_open again to open it.');
  await closingOnce;
  f.servers.set('a', server);

  // An open decided while the close is out.
  server.sendChannelsOpen = async ({ channelId }) => ({ channel: descriptor(channelId) });
  assert.equal((await f.call('channel_open', { channelId: 'x' })).success, true);
  server.sendChannelsClose = held({});
  const closingAgain = f.call('channel_close', { channelId: 'x' });
  await tick();
  const reopening = f.call('channel_open', { channelId: 'x' });
  await answer();
  assert.equal((await closingAgain).error,
    'Channel "x": a later decision to keep it open came first, so this close doesn\'t stand. Call channel_close again to ' +
    'close it.');
  assert.equal((await reopening).success, true);

  // A tune-out entered while the open is out keeps the transport for the
  // subconscious, and channel_open refuses a tuned-out channel.
  server.sendChannelsOpen = held({ channel: descriptor('y') });
  const openingY = f.call('channel_open', { channelId: 'y' });
  await tick();
  f.registry.enterTuneOut('a', 'y', { epochId: 'e1', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
  await answer();
  assert.equal((await openingY).error, 'Channel "y" was tuned out meanwhile: its messages go to the subconscious, and channel_open ' +
    'doesn\'t change that. Call tune_out with channelId "y" and mode "cancel" for it to resume normal attention.');

  // And a close it overtook says so too.
  server.sendChannelsOpen = async ({ channelId }) => ({ channel: descriptor(channelId) });
  assert.equal((await f.call('channel_open', { channelId: 'x' })).success, true);
  server.sendChannelsClose = held({});
  const closingX = f.call('channel_close', { channelId: 'x' });
  await tick();
  f.registry.enterTuneOut('a', 'x', { epochId: 'e2', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
  await answer();
  assert.equal((await closingX).error,
    'Channel "x": it was tuned out meanwhile, so this close doesn\'t stand. Call channel_close again to close it.');
});

test('a channel_open or channel_close whose change already holds says so, and why nothing more came', async () => {
  const f = await fixture({ a: ['x', 'y', 'z'] });
  const server = f.servers.get('a')!;
  assert.equal((await f.call('channel_open', { channelId: 'x' })).success, true);
  for (const id of ['y', 'z']) {
    assert.equal((await f.call('channel_open', { channelId: id })).success, true);
    assert.equal((await f.call('channel_close', { channelId: id })).success, true);
  }

  // A request that failed for a channel already so.
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  // A request that failed leaves the registry's open flag as it was, and the
  // text reads it as the registry's checks do: after a close that failed, a
  // failed open says the channel is open, as calling channel_open again
  // answers already open.
  const w = await fixture({ a: ['x'] });
  const wServer = w.servers.get('a')!;
  assert.equal((await w.call('channel_open', { channelId: 'x' })).success, true);
  wServer.sendChannelsClose = async () => { throw new McplRequestError(timedOut, 'no-response'); };
  assert.equal((await w.call('channel_close', { channelId: 'x' })).success, false);
  wServer.sendChannelsOpen = async () => { throw new McplRequestError(timedOut, 'no-response'); };
  assert.equal((await w.call('channel_open', { channelId: 'x' })).error,
    `Channel "x" is open, though this call didn't complete: ${timedOut}`);
  assert.equal((await w.call('channel_open', { channelId: 'x' })).data?.status, 'already open');
  server.sendChannelsOpen = async () => { throw new McplRequestError(timedOut, 'no-response'); };
  assert.equal((await f.call('channel_open', { channelId: 'x', backscroll: 5 })).error,
    `Channel "x" is open, but the history you asked for didn't come: ${timedOut} Calling channel_open again with backscroll tries once more.`);
  // A plain open of an open channel asks the server only behind other work
  // for it, here a backscroll's.
  const answers: Array<(err?: Error) => void> = [];
  server.sendChannelsOpen = () => new Promise((resolve, reject) => {
    answers.push((err) => err ? reject(err) : resolve({ channel: descriptor('x') }));
  });
  const withHistory = f.call('channel_open', { channelId: 'x', backscroll: 5 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const plain = f.call('channel_open', { channelId: 'x' });
  answers.shift()!();
  assert.equal((await withHistory).success, true);
  for (let i = 0; i < 50 && answers.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 1, 'the plain open asked the server');
  answers.shift()!(new McplRequestError(timedOut, 'no-response'));
  assert.equal((await plain).error, `Channel "x" is open, though this call didn't complete: ${timedOut}`);

  // Without the grant, nothing more can be asked of the server. A close of
  // y, which is closed, isn't answered as already closed, nor said to be in
  // effect, while other work for it is under way: here an open, held at the
  // server, which may already have opened it.
  const heldY: Array<() => void> = [];
  server.sendChannelsOpen = () => new Promise((resolve) => { heldY.push(() => resolve({ channel: descriptor('y') })); });
  const openingY = f.call('channel_open', { channelId: 'y' });
  for (let i = 0; i < 50 && heldY.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  f.servers.set('a', up(['channels.lifecycle']));
  assert.equal((await f.call('channel_open', { channelId: 'x', backscroll: 5 })).error,
    'Channel "x" is open, but the history you asked for didn\'t come: this host isn\'t permitted to open or close the "a" ' +
    'server\'s channels, so calling channel_open again won\'t change that. If you need it, ask whoever runs this host.');
  assert.equal((await f.call('channel_close', { channelId: 'y' })).error,
    'This host isn\'t permitted to open or close the "a" server\'s channels, so this close of channel "y" didn\'t go ' +
    'through, and calling channel_close again won\'t change that. The close stays recorded, and happens when the "a" server ' +
    'next registers this channel, if this host may open and close its channels then. If you need it, ask whoever runs this ' +
    'host.');
  // An open refused for the grant stays recorded and changes nothing, so z
  // is still confirmed closed, with nothing under way.
  assert.equal((await f.call('channel_open', { channelId: 'z' })).success, false);
  assert.equal((await f.call('channel_close', { channelId: 'z' })).error,
    'Channel "z" is closed. This host isn\'t permitted to open or close the "a" server\'s channels, so it sent the server nothing.');
  heldY.shift()!();
  await openingY;
});

test('a granted server\'s channels open, close and take speech while this host is connecting to its id', async () => {
  // The state words a refusal: a server whose grant has what's asked isn't
  // refused for anything the in-flight marks say.
  const f = await fixture({ a: ['x'] });
  f.connecting.add('a');
  assert.equal((await f.call('channel_open', { channelId: 'x' })).success, true);
  assert.equal((await f.call('channel_publish', { channelId: 'x', content: 'hi' })).success, true);
  assert.equal((await f.registry.routeSpeech('agent', 'hello', 'x'))?.delivered, true);
  assert.equal((await f.call('channel_close', { channelId: 'x' })).success, true);
  assert.deepEqual(f.failures, []);
});

test('channel_publish and speak_in_channel say what they need, and where to find a channel id', async () => {
  const f = await fixture({ a: ['x'] });
  assert.equal((await f.call('channel_publish', { channelId: 'x' })).error,
    'Nothing was posted: channel_publish needs the message in `content`.');
  assert.equal((await f.call('channel_publish', { content: 'hi' })).error,
    'Nothing was posted: channel_publish needs a `channelId`, and there\'s no channel to default to yet. channel_list shows the channel ids.');
  // One that is empty names nothing, whatever the default.
  assert.equal((await f.call('channel_publish', { channelId: '', content: 'hi' })).error,
    'Nothing was posted: channelId is empty. channel_list shows the channel ids.');
  assert.equal((await f.call('channel_publish', { channelId: 'nope', content: 'hi' })).error,
    'No channel has the id "nope", so nothing was posted. channel_list shows the channel ids.');
  // The subconscious isn't offered channel_list.
  assert.equal((await f.registry.publishForAgent('', 'hi', 'subconscious')).error,
    'Nothing was posted: speak_in_channel needs a `channelId`. Use the id of a tuned-out channel whose messages you are reading.');
  assert.equal((await f.registry.publishForAgent('nope', 'hi', 'subconscious')).error,
    'No channel has the id "nope", so nothing was posted. Use the id of a tuned-out channel whose messages you are reading.');
});

test('a send to a server that isn\'t up, or isn\'t permitted, says why in the same words on every send path', async () => {
  const f = await fixture({ a: ['x'] });
  const cases: Array<[Server | undefined, boolean, string]> = [
    [down(true), false, 'the "a" server isn\'t connected, and this host is reconnecting to it, so try again later'],
    [undefined, true, 'this host is connecting to the "a" server, so try again in a moment'],
    [undefined, false, 'the "a" server isn\'t connected, and this host won\'t reconnect to it on its own; if you need it, ask whoever runs this host'],
    [up(['channels.publish']), false,
      'this host isn\'t permitted to post to the "a" server\'s channels, and trying again won\'t change that; if you need it, ask whoever runs this host'],
  ];
  for (const [server, connecting, reason] of cases) {
    f.servers.set('a', server);
    if (connecting) f.connecting.add('a'); else f.connecting.delete('a');
    assert.equal((await f.call('channel_publish', { channelId: 'x', content: 'hi' })).error, `Nothing was posted to channel "x": ${reason}.`);
    assert.equal((await f.registry.publishForAgent('x', 'hi', 'subconscious')).error, `Nothing was posted to channel "x": ${reason}.`);
    f.failures.length = 0;
    assert.equal(await f.registry.routeSpeech('agent', 'hello', 'x'), null);
    assert.deepEqual(f.failures.map((failure) => failure.reason), [reason], 'speech gives the same reason');
  }
});

test('speech that has to open its channel says why the open didn\'t happen, and what helps where it was refused', async () => {
  // A grant can let words out without letting this host open the channel:
  // here channels.publish without channels.lifecycle, for a channel not open.
  const f = await fixture({ a: ['x'] });
  f.servers.set('a', up(['channels.lifecycle']));
  const failed = async () => {
    f.failures.length = 0;
    assert.equal(await f.registry.routeSpeech('agent', 'hello', 'x'), null);
    return f.failures.map((failure) => failure.reason);
  };
  assert.deepEqual(await failed(), ['opening the channel for these words didn\'t complete: this host isn\'t permitted to open or ' +
    'close the "a" server\'s channels; if you need it, ask whoever runs this host']);
  f.connecting.add('a');
  assert.deepEqual(await failed(), ['opening the channel for these words didn\'t complete: this host is connecting to the "a" ' +
    'server, so try again in a moment']);
});

test('words that waited for lifecycle work the server dropped during say what helps', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['x'] });
  const server = f.servers.get('a')!;
  const answers: Array<(err?: Error) => void> = [];
  server.sendChannelsOpen = () => new Promise((resolve, reject) => {
    answers.push((err) => err ? reject(err) : resolve({ channel: descriptor('x') }));
  });
  // An open goes out and is held; a second waits behind it, and so do the words.
  const first = f.call('channel_open', { channelId: 'x' });
  for (let i = 0; i < 50 && answers.length === 0; i++) await tick();
  assert.equal(answers.length, 1, 'the first open went out');
  const second = f.call('channel_open', { channelId: 'x' });
  const speech = f.registry.routeSpeech('agent', 'hello', 'x');
  await tick();
  // The server drops: the held open gets no answer, and the next finds it down.
  f.servers.set('a', down(true));
  answers.shift()!(new McplRequestError('The "a" server\'s connection closed before it answered, so whether the request took effect is unknown.', 'no-response'));
  assert.equal(await speech, null);
  assert.deepEqual(f.failures.map((failure) => failure.reason), ['the channel isn\'t confirmed open: the "a" server isn\'t connected, and this ' +
    'host is reconnecting to it, so try again later']);
  // The held open's own answer reads the server's state as it is now.
  assert.equal((await first).error, 'The "a" server isn\'t connected, and this host is reconnecting to it, so channel "x" may ' +
    'not be open there yet. The open is recorded and happens when the "a" server next registers this channel, if this host ' +
    'may open and close its channels then, so there\'s no need to call channel_open again. channel_close withdraws it.');
  await second;
});

test('channel_decline says the decline is recorded, and what became of its acknowledgment and its close', async () => {
  const f = await fixture({ a: ['x', 'y'] });
  const decline = async (channelId = 'x') =>
    (await f.call('channel_decline', { channelId, messageId: 'm1', acknowledge: '👀' })).data ?? {};
  const postIt = 'call channel_decline again with the same arguments';

  f.servers.set('a', down(true));
  assert.equal((await decline()).acknowledgmentError,
    'The decline is recorded, but the acknowledgment wasn\'t posted: the "a" server isn\'t connected, and this host is ' +
    `reconnecting to it. To post it, ${postIt} once it's back.`);
  f.servers.set('a', undefined);
  f.connecting.add('a');
  assert.equal((await decline()).acknowledgmentError,
    `The decline is recorded, but the acknowledgment wasn't posted: this host is connecting to the "a" server. To post it, ${postIt} in a moment.`);
  f.connecting.delete('a');
  assert.equal((await decline()).acknowledgmentError,
    'The decline is recorded, but the acknowledgment wasn\'t posted: the "a" server isn\'t connected, and this host won\'t ' +
    'reconnect to it on its own. If you need it, ask whoever runs this host.');
  f.servers.set('a', up(['channels.acknowledge']));
  assert.equal((await decline()).acknowledgmentError,
    'The decline is recorded, but this host wasn\'t permitted to post acknowledgments to the "a" server, so none was posted. ' +
    'If you need it, ask whoever runs this host.');

  const server = up();
  f.servers.set('a', server);
  // Only acknowledged: true is a post, with a representation only where it's
  // a string.
  server.sendChannelsAcknowledge = async () => ({ acknowledged: true, representation: 'reacted 👀' }) as never;
  const posted = await decline();
  assert.equal(posted.acknowledged, true);
  assert.equal(posted.representation, 'reacted 👀');
  assert.equal(posted.acknowledgmentError, undefined);
  server.sendChannelsAcknowledge = async () => ({ acknowledged: true, representation: 42 }) as never;
  const odd = await decline();
  assert.equal(odd.acknowledged, true);
  assert.equal('representation' in odd, false);
  // An answer that doesn't say acknowledged true or false leaves it unknown.
  for (const answer of [{}, { acknowledged: 'yes' }, null]) {
    server.sendChannelsAcknowledge = async () => answer as never;
    const unknown = await decline();
    assert.equal(unknown.acknowledgmentError,
      'The decline is recorded, but the "a" server\'s answer didn\'t say whether it posted the acknowledgment. Calling ' +
      'channel_decline again with acknowledge could post it twice.', JSON.stringify(answer));
    assert.equal(unknown.acknowledged, false, JSON.stringify(answer));
  }
  // A reason that isn't a non-empty string is none.
  for (const reason of [undefined, '', 42]) {
    server.sendChannelsAcknowledge = async () => ({ acknowledged: false, reason });
    assert.equal((await decline()).acknowledgmentError,
      `The decline is recorded, but the "a" server didn't post the acknowledgment, and gave no reason. To try once more, ${postIt}.`,
      String(reason));
  }
  server.sendChannelsAcknowledge = async () => ({ acknowledged: false, reason: 'reactions are off here' });
  assert.equal((await decline()).acknowledgmentError,
    'The decline is recorded, but the "a" server didn\'t post the acknowledgment: reactions are off here.');
  // Only a request that never left the host proves nothing was posted.
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  server.sendChannelsAcknowledge = async () => { throw new McplRequestError(timedOut, 'no-response'); };
  assert.equal((await decline()).acknowledgmentError,
    `The decline is recorded, but whether the acknowledgment was posted isn't known: ${timedOut} Calling channel_decline ` +
    'again with acknowledge could post it twice.');
  const notSent = 'The "a" server isn\'t connected, so the request wasn\'t sent.';
  server.sendChannelsAcknowledge = async () => { throw new McplRequestError(notSent, 'not-sent'); };
  assert.equal((await decline()).acknowledgmentError,
    `The decline is recorded, but the acknowledgment wasn't posted: ${notSent} To try again, ${postIt}.`);
  // An error answer may follow a post, so it's unknown too.
  server.sendChannelsAcknowledge = async () => { throw new McplRequestError('Reactions are off in this channel.', 'error-response'); };
  assert.equal((await decline()).acknowledgmentError,
    'The decline is recorded, but whether the acknowledgment was posted isn\'t known: Reactions are off in this channel. ' +
    'Calling channel_decline again with acknowledge could post it twice.');

  // A close that didn't complete leaves its transport unconfirmed, so a
  // decline closes it again.
  server.sendChannelsClose = async () => { throw new McplRequestError(timedOut, 'no-response'); };
  await f.registry.handleRegister('a', { channels: [descriptor('y')] });
  const declined = await f.call('channel_decline', { channelId: 'y', messageId: 'm2' });
  assert.equal(declined.success, true);
  assert.equal(declined.data?.closeError,
    'The decline is recorded, and this host closes the channel when the "a" server next registers this channel, if this ' +
    'host may open and close its channels then; closing it now didn\'t complete: The "a" server didn\'t answer within 30 ' +
    'seconds, so whether the request took effect is unknown.');

  server.sendChannelsClose = async () => ({});
  await f.call('channel_open', { channelId: 'x' });
  assert.equal((await f.call('channel_decline', { channelId: 'x', messageId: 'm3' })).error,
    'Channel "x" is open, or set to open, so there\'s nothing to decline. If you need it closed, call channel_close.');
  // A server that isn't up has an empty grant until its next exchange, and
  // channel_close closes the channel once it's back, so it's still named.
  f.servers.set('a', down(true));
  assert.equal((await f.call('channel_decline', { channelId: 'x', messageId: 'm4' })).error,
    'Channel "x" is open, or set to open, so there\'s nothing to decline. If you need it closed, call channel_close.');
});

test('a decline whose close a later open overtook says that decision stands', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['x'] });
  const server = f.servers.get('a')!;
  // A close that didn't complete, the registration's own here, leaves y's
  // transport unconfirmed, so the decline closes it again.
  server.sendChannelsClose = async () => { throw new McplRequestError('The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.', 'no-response'); };
  await f.registry.handleRegister('a', { channels: [descriptor('y')] });
  for (let i = 0; i < 5; i++) await tick();
  const answers: Array<() => void> = [];
  server.sendChannelsClose = () => new Promise((resolve) => { answers.push(() => resolve({})); });
  const declining = f.call('channel_decline', { channelId: 'y', messageId: 'm1' });
  for (let i = 0; i < 50 && answers.length === 0; i++) await tick();
  assert.equal(answers.length, 1, "the decline's close went out");
  const opening = f.call('channel_open', { channelId: 'y' });
  answers.shift()!();
  const declined = await declining;
  assert.equal(declined.success, true);
  assert.equal(declined.data?.closeError,
    'The decline is recorded, but a later decision to open the channel replaced it, and that decision stands.');
  assert.equal((await opening).success, true);
});

test('a decline that a later decision replaced while its acknowledgment was out gives no step another decline would refuse', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const notSent = 'The "a" server isn\'t connected, so the request wasn\'t sent.';
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  type Ack = { resolve: (answer: unknown) => void; reject: (err: Error) => void };
  const outcomes: Array<[string, (ack: Ack) => void, string]> = [
    ['not sent', (ack) => ack.reject(new McplRequestError(notSent, 'not-sent')),
      `The decline is recorded, but the acknowledgment wasn't posted: ${notSent}`],
    ['no answer', (ack) => ack.reject(new McplRequestError(timedOut, 'no-response')),
      `The decline is recorded, but whether the acknowledgment was posted isn't known: ${timedOut}`],
    ['refused with no reason', (ack) => ack.resolve({ acknowledged: false }),
      'The decline is recorded, but the "a" server didn\'t post the acknowledgment, and gave no reason.'],
    ['an answer that didn\'t say', (ack) => ack.resolve({}),
      'The decline is recorded, but the "a" server\'s answer didn\'t say whether it posted the acknowledgment.'],
  ];
  const events: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, string]> = [
    ['an open', async (f) => { assert.equal((await f.call('channel_open', { channelId: 'x' })).success, true); },
      'The decline is recorded, but a later decision to open the channel replaced it, and that decision stands.'],
    ['a tune-out', async (f) => {
      f.registry.enterTuneOut('a', 'x', { epochId: 'e1', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
    }, 'The decline is recorded, but the channel was tuned out meanwhile, and that decision stands: its messages go to the subconscious.'],
  ];
  const declineHeld = async () => {
    const f = await fixture({ a: ['x'] });
    const acks: Ack[] = [];
    f.servers.get('a')!.sendChannelsAcknowledge = () => new Promise((resolve, reject) => {
      acks.push({ resolve: resolve as (answer: unknown) => void, reject });
    });
    const declining = f.call('channel_decline', { channelId: 'x', messageId: 'm1', acknowledge: '👀' });
    for (let i = 0; i < 50 && acks.length === 0; i++) await tick();
    assert.equal(acks.length, 1, 'the acknowledgment went out');
    return { f, ack: acks[0]!, declining };
  };
  for (const [outcome, settle, ackText] of outcomes) {
    for (const [event, happen, closeText] of events) {
      const { f, ack, declining } = await declineHeld();
      await happen(f);
      settle(ack);
      const declined = await declining;
      assert.equal(declined.success, true, `${outcome}, ${event}`);
      assert.equal(declined.data?.acknowledgmentError, ackText, `${outcome}, ${event}`);
      assert.equal(declined.data?.closeError, closeText, `${outcome}, ${event}`);
    }
  }
  // The decline stands where the server stopped listing the channel, but no
  // channel tool can find it, so another decline isn't offered either.
  const { f, ack, declining } = await declineHeld();
  await f.registry.handleChanged('a', { removed: ['x'] });
  ack.reject(new McplRequestError(notSent, 'not-sent'));
  const declined = await declining;
  assert.equal(declined.data?.closeError, undefined);
  assert.equal(declined.data?.acknowledgmentError, `The decline is recorded, but the acknowledgment wasn't posted: ${notSent}`);
});

test('a decline whose channel its server\'s traffic shows open meanwhile offers no retry, which would be refused', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({});
  // The server opens its own channels, and only its traffic shows one open.
  const server = up(['channels.lifecycle']);
  f.servers.set('a', server);
  await f.registry.handleRegister('a', { channels: [descriptor('y')] });
  // Its traffic while the acknowledgment is out shows y open, so another
  // decline, which would be refused, isn't offered.
  const notSent = 'The "a" server isn\'t connected, so the request wasn\'t sent.';
  const acks: Array<() => void> = [];
  server.sendChannelsAcknowledge = () => new Promise((_, reject) => {
    acks.push(() => reject(new McplRequestError(notSent, 'not-sent')));
  });
  const declining = f.call('channel_decline', { channelId: 'y', messageId: 'm2', acknowledge: '👀' });
  for (let i = 0; i < 50 && acks.length === 0; i++) await tick();
  assert.equal(acks.length, 1, 'the acknowledgment went out');
  await f.registry.handleIncoming('a', { messages: [{
    channelId: 'y', messageId: 'm3', author: { id: 'u1', name: 'someone' },
    timestamp: '2026-10-19T00:00:00Z', content: [{ type: 'text', text: 'hello' }],
  }] });
  acks.shift()!();
  const declined = await declining;
  assert.equal(declined.data?.acknowledgmentError, `The decline is recorded, but the acknowledgment wasn't posted: ${notSent}`);
  // And another decline is refused, with no pointer to a channel_close that
  // couldn't close it here.
  assert.equal((await f.call('channel_decline', { channelId: 'y', messageId: 'm4' })).error,
    'Channel "y" is open, or set to open, so there\'s nothing to decline, and this host isn\'t permitted to open or close ' +
    'the "a" server\'s channels; if you need it closed, ask whoever runs this host.');
});

test('an acknowledgment refused for the grant says so, though the server drops while the decline closes the channel', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['x'] });
  const server = f.servers.get('a')!;
  // A close that didn't complete leaves y's transport unconfirmed, so the
  // decline closes it again.
  server.sendChannelsClose = async () => { throw new McplRequestError('The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.', 'no-response'); };
  await f.registry.handleRegister('a', { channels: [descriptor('y')] });
  for (let i = 0; i < 5; i++) await tick();
  const noAck = { ...up(['channels.acknowledge']), sendChannelsOpen: server.sendChannelsOpen };
  const answers: Array<() => void> = [];
  noAck.sendChannelsClose = () => new Promise((resolve) => { answers.push(() => resolve({})); });
  f.servers.set('a', noAck);
  const declining = f.call('channel_decline', { channelId: 'y', messageId: 'm1', acknowledge: '👀' });
  for (let i = 0; i < 50 && answers.length === 0; i++) await tick();
  assert.equal(answers.length, 1, "the decline's close went out");
  f.servers.set('a', down(true));
  answers.shift()!();
  assert.equal((await declining).data?.acknowledgmentError,
    'The decline is recorded, but this host wasn\'t permitted to post acknowledgments to the "a" server, so none was posted. ' +
    'If you need it, ask whoever runs this host.');
});

test('a decline whose channel stops being registered while its close is out offers no retry, which couldn\'t find it', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const notSent = 'The "a" server isn\'t connected, so the request wasn\'t sent.';
  const later = 'when the "a" server next registers this channel, if this host may open and close its channels then';
  // The server de-lists it, or this host removes the server, and then its
  // registration may come back; either way the server answered the close
  // first, so the text doesn't say it didn't complete.
  // Another decline, and so the acknowledgment's retry, is offered only where
  // the channel is registered again.
  const retry = ' To try again, call channel_decline again with the same arguments.';
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, string, string]> = [
    ['the server de-lists it', async (f) => { await f.registry.handleChanged('a', { removed: ['y'] }); },
      'it isn\'t registered here any more: the "a" server no longer lists the channel', ''],
    ['this host removes the server', async (f) => { f.registry.removeServer('a'); },
      'it isn\'t registered here any more: this host disconnected the "a" server while the change was being made', ''],
    ['this host removes the server, and it registers the channel again', async (f) => {
      f.registry.removeServer('a');
      // The registration's own reconcile waits behind the decline's close, so
      // it's left running and awaited once that close is answered.
      registering = f.registry.handleRegister('a', { channels: [descriptor('y')] });
      for (let i = 0; i < 5; i++) await tick();
      assert.equal(f.registry.getChannelServerId('y'), 'a', 'y is registered again while the close is out');
    }, 'its registration went and came back while the close was out', retry],
  ];
  let registering: Promise<unknown> | undefined;
  for (const [what, go, why, ackRetry] of cases) {
    const f = await fixture({ a: ['x'] });
    const server = f.servers.get('a')!;
    // A close that didn't complete, the registration's own here, leaves y's
    // transport unconfirmed, so the decline closes it again.
    server.sendChannelsClose = async () => { throw new McplRequestError('The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.', 'no-response'); };
    await f.registry.handleRegister('a', { channels: [descriptor('y')] });
    for (let i = 0; i < 5; i++) await tick();
    server.sendChannelsAcknowledge = async () => { throw new McplRequestError(notSent, 'not-sent'); };
    const answers: Array<() => void> = [];
    server.sendChannelsClose = () => new Promise((resolve) => { answers.push(() => resolve({})); });
    const declining = f.call('channel_decline', { channelId: 'y', messageId: 'm1', acknowledge: '👀' });
    for (let i = 0; i < 50 && answers.length === 0; i++) await tick();
    assert.equal(answers.length, 1, `${what}: the decline's close went out`);
    await go(f);
    answers.shift()!();
    const declined = await declining;
    assert.equal(declined.success, true, what);
    assert.equal(declined.data?.acknowledgmentError, `The decline is recorded, but the acknowledgment wasn't posted: ${notSent}${ackRetry}`, what);
    assert.equal(declined.data?.closeError, `The decline is recorded, and this host closes the channel ${later}; ${why}.`, what);
    // The registration that came back reconciles the decline's close; it's
    // answered here so nothing is left waiting.
    // Read through a function: the assertion above narrows the length.
    const held = () => answers.length;
    for (let i = 0; i < 50 && registering !== undefined && held() === 0; i++) await tick();
    while (held() > 0) answers.shift()!();
    await registering;
    registering = undefined;
  }
});

test('words whose open completed, then met a close decided while later work held them, say the close', async () => {
  // The open step's wait joins lifecycle work queued after the open, here a
  // backscroll's, so a close decided meanwhile is what the words met. Their
  // own open did complete, so nothing says it didn't.
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = await fixture({ a: ['x'] });
  const server = f.servers.get('a')!;
  const answers: Array<() => void> = [];
  server.sendChannelsOpen = ({ channelId }) => new Promise((resolve) => { answers.push(() => resolve({ channel: descriptor(channelId) })); });
  const sent = async (count: number) => {
    for (let i = 0; i < 50 && answers.length < count; i++) await tick();
    assert.equal(answers.length, count, 'the open went out');
  };
  const speech = f.registry.routeSpeech('agent', 'hello', 'x');
  await sent(1);
  const backscroll = f.call('channel_open', { channelId: 'x', backscroll: 5 });
  answers.shift()!();
  await sent(1);
  const closing = f.call('channel_close', { channelId: 'x' });
  answers.shift()!();
  assert.equal(await speech, null);
  assert.deepEqual(f.failures.map((failure) => failure.reason), ['a decision to close the channel came before these words went out']);
  assert.equal((await closing).success, true);
  await backscroll;
});

test('words checked against a connection the registry replaced while they waited say so, where the replacement would take them', async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const cases: Array<[string, Server, boolean, string]> = [
    ['a replacement that would take them', up(), false,
      'the "a" server\'s connection was replaced while these words waited, so try again'],
    ['one without the grant', up(['channels.publish']), false,
      'this host isn\'t permitted to post to the "a" server\'s channels, and trying again won\'t change that; if you need it, ' +
      'ask whoever runs this host'],
    ['one this host is still connecting to', up(), true, 'this host is connecting to the "a" server, so try again in a moment'],
  ];
  for (const [what, replacement, connecting, reason] of cases) {
    const f = await fixture({ a: ['x'] });
    const before = f.servers.get('a')!;
    const answers: Array<() => void> = [];
    before.sendChannelsOpen = ({ channelId }) => new Promise((resolve) => { answers.push(() => resolve({ channel: descriptor(channelId) })); });
    const opening = f.call('channel_open', { channelId: 'x' });
    for (let i = 0; i < 50 && answers.length === 0; i++) await tick();
    // The words wait for the open, checked against the connection then.
    const speech = f.registry.routeSpeech('agent', 'hello', 'x');
    await tick();
    // The replacement takes the old connection's place, whose grant goes
    // with it, as a closed connection's does; it answers the open's retry.
    replacement.sendChannelsOpen = async ({ channelId }) => ({ channel: descriptor(channelId) });
    f.servers.set('a', replacement);
    if (connecting) f.connecting.add('a');
    before.grant = CapabilityGrant.empty();
    answers.shift()!();
    assert.equal(await speech, null, what);
    assert.deepEqual(f.failures.map((failure) => failure.reason), [reason], what);
    await opening;
  }
});

test('a channel tool on a server this host is connecting to says so, from the framework\'s own connect', async () => {
  // A server closed for good keeps its channels registered here. An operator
  // connecting its id again has the connect in flight until its handshake is
  // done; this one's never answers.
  const dir = mkdtempSync(join(tmpdir(), 'channel-agent-words-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Test.' }],
    modules: [], syncIntervalMs: 0,
  });
  const internals = framework as unknown as {
    channelRegistry: ChannelRegistry | null;
    mcpServerOps?: Map<string, { kind: string }>;
  };
  let connect: Promise<unknown> | undefined;
  try {
    connect = framework.connectMcplServer({
      id: 'slow', command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1 << 30);'],
    }).catch((err: unknown) => err);
    const deadline = Date.now() + 10_000;
    while (!(internals.channelRegistry && internals.mcpServerOps?.get('slow')?.kind === 'connect') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const registry = internals.channelRegistry!;
    (registry as unknown as { channels: Map<string, unknown> }).channels.set('slow:c1', { serverId: 'slow', descriptor: descriptor('c1'), open: false });
    const publish = () => registry.handleChannelToolCall('channel_publish', { channelId: 'c1', content: 'hi' });
    assert.equal((await publish()).error, 'Nothing was posted to channel "c1": this host is connecting to the "slow" server, so try again in a moment.');
    await framework.disconnectMcplServer('slow');
    await connect;
    (registry as unknown as { channels: Map<string, unknown> }).channels.set('slow:c1', { serverId: 'slow', descriptor: descriptor('c1'), open: false });
    assert.equal((await publish()).error, 'Nothing was posted to channel "c1": the "slow" server isn\'t connected, and this host ' +
      'won\'t reconnect to it on its own; if you need it, ask whoever runs this host.');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a registered server reads as connecting while the policy exchange of the transport it\'s on is in flight, or a restart of its id is', async () => {
  // The exchange's marker (mcplPolicyExchanges) holds a connection's planes
  // while it runs, whatever it then grants. One that ends refused or
  // unanswered leaves the grant empty, which is that transport's answer, so
  // from then on the refusal says "not permitted", not "connecting".
  const dir = mkdtempSync(join(tmpdir(), 'channel-agent-words-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Test.' }],
    modules: [], syncIntervalMs: 0,
  });
  const internals = framework as unknown as {
    initializeMcpl(servers: unknown[]): Promise<void>;
    channelRegistry: ChannelRegistry | null;
    mcplServerRegistry: { servers: Map<string, object> } | null;
    mcplPolicyExchanges: WeakMap<object, number>;
  };
  try {
    await internals.initializeMcpl([]);
    const connection = { id: 'cold', grant: CapabilityGrant.empty(), isConnected: true, transportEpoch: 2 };
    internals.mcplServerRegistry!.servers.set('cold', connection);
    const registry = internals.channelRegistry!;
    (registry as unknown as { channels: Map<string, unknown> }).channels.set('cold:c1', { serverId: 'cold', descriptor: descriptor('c1'), open: true });
    const publish = async () => (await registry.handleChannelToolCall('channel_publish', { channelId: 'c1', content: 'hi' })).error;
    const notPermitted = 'Nothing was posted to channel "c1": this host isn\'t permitted to post to the "cold" server\'s channels, ' +
      'and trying again won\'t change that; if you need it, ask whoever runs this host.';
    internals.mcplPolicyExchanges.set(connection, 2);
    assert.equal(await publish(), 'Nothing was posted to channel "c1": this host is connecting to the "cold" server, so try again in a moment.');
    // A marker an earlier transport's exchange left doesn't hold this one's.
    internals.mcplPolicyExchanges.set(connection, 1);
    assert.equal(await publish(), notPermitted);
    internals.mcplPolicyExchanges.delete(connection);
    assert.equal(await publish(), notPermitted);
    // A restart holds its id from before its disconnect, so a registered
    // connection reads as connecting through it, as does an id not
    // registered meanwhile.
    const claims = (framework as unknown as { restartClaims(): { ids: Map<string, unknown> } }).restartClaims();
    claims.ids.set('cold', { restarting: 'cold' });
    assert.equal(await publish(), 'Nothing was posted to channel "c1": this host is connecting to the "cold" server, so try again in a moment.');
    claims.ids.delete('cold');
    (registry as unknown as { channels: Map<string, unknown> }).channels.set('away:c2', { serverId: 'away', descriptor: descriptor('c2'), open: true });
    const publishAway = async () => (await registry.handleChannelToolCall('channel_publish', { channelId: 'c2', content: 'hi' })).error;
    assert.equal(await publishAway(), 'Nothing was posted to channel "c2": the "away" server isn\'t connected, and this host won\'t ' +
      'reconnect to it on its own; if you need it, ask whoever runs this host.');
    claims.ids.set('away', { restarting: 'away' });
    assert.equal(await publishAway(), 'Nothing was posted to channel "c2": this host is connecting to the "away" server, so try again in a moment.');
    claims.ids.delete('away');
    // A closed connection has no exchange to wait for, whatever marker it
    // was left with.
    connection.isConnected = false;
    internals.mcplPolicyExchanges.set(connection, 2);
    assert.equal(await publish(), 'Nothing was posted to channel "c1": the "cold" server isn\'t connected, and this host won\'t ' +
      'reconnect to it on its own; if you need it, ask whoever runs this host.');
  } finally {
    internals.mcplServerRegistry?.servers.delete('cold');
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
