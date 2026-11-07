/**
 * What a channel_close result says of the all-except hold (the focus) that
 * excepts the channel it names (AF #844 review follow-up, Isaac-3593,
 * round 3): the focus status true when the result arrives, a focus end that
 * happened before a failure, and a repeat close that names the excepted
 * channel after its server no longer registers it; and (Simon-2700, round
 * 7) a bare id the focus's channel answers to means that channel, not
 * another server's channel with the id; and (Mabel-3575, round 8) a bare
 * id that both the focus's channel and the calling turn's own channel on
 * another server answer to is refused, naming both.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { fixture, eventually, REPLY_DEADLINE_MS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { SUB, internals, textOf, find, has, incoming, registerOpen, settle, type Fixture } from './helpers/admission.js';

type Answer = { success: boolean; data?: unknown; error?: string };
type Framework = {
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  disconnectMcplServer(id: string): Promise<void>;
  connectMcplServer(config: { id: string; url: string }): Promise<void>;
  mcplServerRegistry: { getServer(id: string): { sendChannelsClose(params: { channelId: string }): Promise<unknown> } | null };
  channelRegistry: { handleChannelToolCall(name: string, input: unknown, origin?: unknown): Promise<Answer> };
};

const ENDED = 'The focus on it ended, and what the other channels held was delivered, up to its backlog cap.';
const WAITS = /^The close asks to cancel the all-except hold that excepts this channel\. Not cancelled yet: /;

const framework = (f: Fixture) => f.framework as unknown as Framework;
const coordinatorOf = (f: Fixture) => internals(f).tuneOutCoordinator!;
const close = (f: Fixture, input: Record<string, unknown>, id = 'c1'): Promise<Answer> =>
  f.framework.executeToolCall({ id, name: 'channel_close', input, callerAgentName: 'agent' } as never) as Promise<Answer>;

/** `work` the excepted channel, a message held in `noisy`. */
async function focused(): Promise<Fixture> {
  const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
  await registerOpen(f, 'work', 'noisy');
  const r = coordinatorOf(f).enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool');
  assert.ok(r.ok, (r as { error?: string }).error);
  await incoming(f, 'noisy', 'n1', 'held');
  await settle(f);
  return f;
}

describe("a channel_close result says what became of the focus when the result arrives", () => {
  it('control: a close of the registered excepted channel ends the focus and says so', async () => {
    const f = await focused();
    try {
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, true, result.error);
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
      assert.equal((result.data as { note?: string }).note, ENDED);
      assert.match(textOf(find(f, 'all channels except')), /antra: held/, 'its backlog released');
    } finally { await f.close(); }
  });

  it("control: a deferred close whose transport answers before the release says the focus's end waits, the focus in force", async () => {
    const f = await focused();
    const release = framework(f).reserveStoreForSurgery('roll back', 'agent');
    try {
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, true, result.error);
      const data = result.data as { status?: string; note?: string };
      assert.equal(data.status, 'closed');
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus is in force at the answer');
      assert.match(data.note ?? '', WAITS, JSON.stringify(data));
      release();
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'ended at the release');
    } finally { release(); await f.close(); }
  });

  it("a deferred close whose focus release finishes while its transport is awaited says the focus ended", async () => {
    const f = await focused();
    const release = framework(f).reserveStoreForSurgery('roll back', 'agent');
    const server = framework(f).mcplServerRegistry.getServer('editor')!;
    let answer!: () => void;
    const sent = server.sendChannelsClose.bind(server);
    server.sendChannelsClose = async (params) => {
      await new Promise<void>((resolve) => { answer = resolve; });
      return sent(params);
    };
    try {
      const closing = close(f, { channelId: 'work' });
      await eventually(() => answer !== undefined, 'the close is out at the transport');
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus is in force while the transport is awaited');
      release();
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'premise: the release ended the focus while the transport is awaited');
      answer();
      const result = await closing;
      assert.equal(result.success, true, result.error);
      const data = result.data as { status?: string; note?: string };
      assert.equal(data.status, 'closed');
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'no focus at the answer');
      assert.equal(data.note, ENDED, `the note is the focus's status at the answer: ${JSON.stringify(data)}`);
    } finally { release(); answer?.(); await f.close(); }
  });
  it("a deferred close whose focus ended, with a replacement focus begun on another channel before the answer, names the replacement", async () => {
    const f = await focused();
    const release = framework(f).reserveStoreForSurgery('roll back', 'agent');
    const server = framework(f).mcplServerRegistry.getServer('editor')!;
    let answer!: () => void;
    const sent = server.sendChannelsClose.bind(server);
    server.sendChannelsClose = async (params) => {
      await new Promise<void>((resolve) => { answer = resolve; });
      return sent(params);
    };
    try {
      const closing = close(f, { channelId: 'work' });
      await eventually(() => answer !== undefined, 'the close is out at the transport');
      release();
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'premise: the release ended the focus while the transport is awaited');
      const again = coordinatorOf(f).enterAllExcept({ serverId: 'editor', channelId: 'noisy' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool');
      assert.ok(again.ok, (again as { error?: string }).error);
      answer();
      const result = await closing;
      assert.equal(result.success, true, result.error);
      const data = result.data as { status?: string; note?: string };
      assert.equal(data.status, 'closed');
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the replacement focus is in force at the answer');
      assert.equal(data.note, `${ENDED} A new all-except focus is in force now, excepting editor/noisy: not this close's, and what the other channels hold stays held until it ends.`,
        `the note names the replacement: ${JSON.stringify(data)}`);
    } finally { release(); answer?.(); await f.close(); }
  });

});

describe('a close that fails after the focus ended says the focus ended', () => {
  it('a release whose step after the end throws: the error says the close was not recorded and that the focus ended before that', async () => {
    const f = await focused();
    try {
      const hooks = (coordinatorOf(f) as unknown as { hooks: { requestInference(agent: string, reason: string, source: string): unknown } }).hooks;
      const ask = hooks.requestInference.bind(hooks);
      hooks.requestInference = (agent, reason, source) => {
        if (agent === 'agent' && reason.startsWith('tune-out cancelled')) throw new Error('post-end inference refused (probe)');
        return ask(agent, reason, source);
      };
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'premise: the focus ended before the failure');
      assert.equal(internals(f).channelRegistry.getDesiredState('editor', 'work'), 'open', 'premise: the close was not recorded');
      assert.equal(result.error,
        "The close wasn't recorded: post-end inference refused (probe). The focus on it ended before that failure, and what the other channels held was delivered, up to its backlog cap.");
      assert.match(textOf(find(f, 'all channels except')), /antra: held/, 'its backlog was released');
    } finally { await f.close(); }
  });

  it("a release that fails before the end: the error says the close wasn't recorded, and that the focus is still in force", async () => {
    const f = await focused();
    try {
      const hooks = (coordinatorOf(f) as unknown as { hooks: { commitDeliveries?: () => boolean } }).hooks;
      hooks.commitDeliveries = () => false;
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus is in force');
      // AF #844 bot review 5, finding 44: the release notice, with the
      // other channels' backlog, was stored before the commit failed, so
      // only what arrives from now on stays held.
      assert.equal(result.error, "The close wasn't recorded: the all-except release could not be made durable, so the hold stays in force. The focus on it is still in force, but its release notice, with what the other channels held up to its backlog cap, was stored before that failure: what they hold from now on stays held until it ends. A resident ends it with tune_out { mode: 'cancel', scope: 'all-except' }, or asks this close again.");
      assert.match(textOf(find(f, 'all channels except')), /antra: held/, 'premise: the release notice, with its backlog, was stored');
    } finally { await f.close(); }
  });
});

const removals: Array<[string, (f: Fixture) => Promise<void>]> = [
  ['its server removes it (channels/changed)', async (f) => { await f.send('channels/changed', { removed: ['work'] }); }],
  ['its server is removed', async (f) => { await framework(f).disconnectMcplServer('editor'); }],
];

describe('a close naming the excepted channel after its server no longer registers it ends the focus', () => {
  for (const [how, remove] of removals) {
    for (const input of [{ channelId: 'work' }, { channelId: 'work', serverId: 'editor' }, { channelId: 'editor:work' }]) {
      it(`when ${how}, a close given ${JSON.stringify(input)} ends the focus and says so`, async () => {
        const f = await focused();
        try {
          await remove(f);
          assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus outlives its channel');
          const result = await close(f, input);
          assert.equal(result.success, false, 'no close ran');
          assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
          assert.equal(result.error,
            `Server "editor" no longer registers channel "work", so no close was recorded or sent. ${ENDED}`);
          const notice = textOf(find(f, 'all channels except'));
          assert.match(notice, /antra: held/, 'its backlog released, as a cancel releases it');
          assert.match(notice, /released — a close of the excepted channel, which its server no longer registers, /, notice);
        } finally { await f.close(); }
      });
    }
  }

  it("inside the turn whose channel it was, the channel's id alone ends the focus, as the turn's own channel", async () => {
    const f = await focused();
    try {
      await f.send('channels/changed', { removed: ['work'] });
      const result = await framework(f).channelRegistry.handleChannelToolCall('channel_close', { channelId: 'work' },
        { kind: 'agent', agentName: 'agent', own: [{ serverId: 'editor', channelId: 'work' }] });
      assert.equal(result.success, false);
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
      assert.equal(result.error, `Server "editor" no longer registers channel "work", so no close was recorded or sent. ${ENDED}`);
    } finally { await f.close(); }
  });

  it("a release that fails before the end: the answer says the focus wasn't ended, why, and that it is still in force", async () => {
    const f = await focused();
    try {
      await f.send('channels/changed', { removed: ['work'] });
      (coordinatorOf(f) as unknown as { hooks: { commitDeliveries?: () => boolean } }).hooks.commitDeliveries = () => false;
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus is in force');
      assert.equal(result.error, 'Server "editor" no longer registers channel "work", so no close was recorded or sent. '
        + "The focus on it wasn't ended: the all-except release could not be made durable, so the hold stays in force. The focus on it is still in force, but its release notice, with what the other channels held up to its backlog cap, was stored before that failure: what they hold from now on stays held until it ends. A resident ends it with tune_out { mode: 'cancel', scope: 'all-except' }, or asks this close again.");
    } finally { await f.close(); }
  });

  it('a release whose step after the end throws: the answer says the focus ended before that failure', async () => {
    const f = await focused();
    try {
      await f.send('channels/changed', { removed: ['work'] });
      const hooks = (coordinatorOf(f) as unknown as { hooks: { requestInference(agent: string, reason: string, source: string): unknown } }).hooks;
      const ask = hooks.requestInference.bind(hooks);
      hooks.requestInference = (agent, reason, source) => {
        if (agent === 'agent' && reason.startsWith('tune-out cancelled')) throw new Error('post-end inference refused (probe)');
        return ask(agent, reason, source);
      };
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'premise: the focus ended');
      assert.equal(result.error, 'Server "editor" no longer registers channel "work", so no close was recorded or sent. '
        + "A step of the focus's release failed: post-end inference refused (probe). The focus on it ended before that failure, and what the other channels held was delivered, up to its backlog cap.");
    } finally { await f.close(); }
  });

  it('a name the focus does not except is refused as before, the focus left in force', async () => {
    const f = await focused();
    try {
      await f.send('channels/changed', { removed: ['work'] });
      const result = await close(f, { channelId: 'elsewhere' });
      assert.equal(result.success, false);
      assert.equal(result.error, 'No channel has the id "elsewhere", so nothing ran. channel_list shows the channel ids.');
      assert.ok(coordinatorOf(f).getAllExcept(), 'the focus is in force');
    } finally { await f.close(); }
  });

  it("a module's close naming the gone excepted channel is refused as before, the focus left in force", async () => {
    const f = await focused();
    try {
      await f.send('channels/changed', { removed: ['work'] });
      const result = await framework(f).channelRegistry.handleChannelToolCall('channel_close', { channelId: 'work' }, { kind: 'module', moduleName: 'gc' });
      assert.equal(result.success, false);
      assert.equal(result.error, 'No channel has the id "work", so nothing ran. channel_list shows the channel ids.');
      assert.ok(coordinatorOf(f).getAllExcept(), 'the focus is in force');
    } finally { await f.close(); }
  });

  it("while the store's writes are held, the close says the focus's end waits, and the release ends it", async () => {
    const f = await focused();
    const release = framework(f).reserveStoreForSurgery('roll back', 'agent');
    try {
      await f.send('channels/changed', { removed: ['work'] });
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus is in force');
      assert.match(result.error ?? '',
        /^Server "editor" no longer registers channel "work", so no close was recorded or sent\. This call asks to cancel the all-except hold that excepts this channel\. Not cancelled yet: /,
        result.error);
      release();
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'ended at the release');
      assert.ok(has(f, 'antra: held'), 'its backlog released');
    } finally { release(); await f.close(); }
  });
});

/**
 * A second MCPL server, `other`, on its own loopback socket, connected to the
 * fixture's host. It records the channels/close requests it is sent, and
 * registers channels as the fixture's server does (registerOpen).
 */
async function otherServer(f: Fixture) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const closes: string[] = [];
  const replies = new Map<number, (value: unknown) => void>();
  let socket: WebSocket | undefined;
  let next = 1;
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (bytes) => {
      const m = JSON.parse(String(bytes));
      if (!m.method) { replies.get(m.id)?.(m); replies.delete(m.id); return; }
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      if (m.method === 'initialize') {
        reply({ protocolVersion: '2024-11-05', capabilities: { tools: {}, experimental: { mcpl: {
          version: '0.5', channels: { incoming: true, register: true, lifecycle: true, publish: true },
        } } }, serverInfo: { name: 'other', version: '1' } });
      } else if (m.method === 'tools/list') reply({ tools: [] });
      else if (m.method === 'channels/close') { closes.push(m.params.channelId); reply({ closed: true }); }
      else if (m.method === 'channels/open') reply({ channel: { id: m.params.channelId, type: 'discord', label: m.params.channelId } });
      else if (m.id !== undefined) reply({});
    });
  });
  await framework(f).connectMcplServer({ id: 'other', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` });
  // Sends a request and waits for its reply, for up to REPLY_DEADLINE_MS, as the fixture's send() does.
  const send = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} within ${REPLY_DEADLINE_MS / 1000} s`)), REPLY_DEADLINE_MS);
    replies.set(id, (value) => { clearTimeout(timer); resolve(value); });
    socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  return {
    closes,
    registerOpen: async (id: string) => {
      await send('channels/register', { channels: [{ id, type: 'discord', label: id, initiallyOpen: true, metadata: { channelType: 'guild_text' } }] });
      await eventually(() => internals(f).channelRegistry.getDesiredState('other', id) === 'open', `other's ${id} open`);
    },
    stop: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

/** A first close of `work` whose release fails before the focus ends, which leaves the focus in force. */
async function firstCloseFails(f: Fixture): Promise<void> {
  const hooks = (coordinatorOf(f) as unknown as { hooks: { commitDeliveries?: () => boolean } }).hooks;
  const commit = hooks.commitDeliveries;
  hooks.commitDeliveries = () => false;
  try {
    const first = await close(f, { channelId: 'work' }, 'c0');
    assert.equal(first.success, false, 'premise: the first close failed');
    assert.match(String((first as { error?: unknown }).error ?? ''), /The focus on it is still in force/, 'premise: the failure is the focus-still-in-force one (AF #844 review 2, #107)');
  } finally { hooks.commitDeliveries = commit; }
  assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus outlived the first close');
}

const OTHER_NOT_CLOSED = 'Channel "work" on server "other" was not closed: to close it, call again with channelId "work" and serverId "other".';

describe("a bare channel_close id the focus's channel answers to means that channel, not another server's with the id", () => {
  it("the focus's channel gone and another server's `work` registered: the repeat ends the focus, and leaves other's `work` open", async () => {
    const f = await focused();
    const other = await otherServer(f);
    try {
      await firstCloseFails(f);
      await f.send('channels/changed', { removed: ['work'] });
      await other.registerOpen('work');
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false, `no close ran: ${JSON.stringify(result)}`);
      assert.equal(result.error,
        `Server "editor" no longer registers channel "work", so no close was recorded or sent. ${ENDED} ${OTHER_NOT_CLOSED}`);
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
      assert.match(textOf(find(f, 'all channels except')), /antra: held/, 'its backlog released');
      assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'open', "other's work stays open");
      // The focus's end wakes the resident: its turn answered, the host is
      // idle, and nothing it did sent other's server a close.
      f.alwaysRespond();
      await f.framework.runUntilIdle();
      assert.deepEqual(other.closes, [], "other's server was sent no close");
    } finally { await f.close(); await other.stop(); }
  });

  it("a focus on `other:work` beside server other's `work`: the not-closed sentence gives the channelId and serverId that close other's `work` (bot review 2, #161)", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    const other = await otherServer(f);
    try {
      await registerOpen(f, 'other:work', 'noisy');
      const r = coordinatorOf(f).enterAllExcept({ serverId: 'editor', channelId: 'other:work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool');
      assert.ok(r.ok, (r as { error?: string }).error);
      await other.registerOpen('work');
      const result = await close(f, { channelId: 'other:work' });
      assert.equal(result.success, true, result.error);
      assert.deepEqual(result.data, { channelId: 'other:work', serverId: 'editor', status: 'closed', note: `${ENDED} ${OTHER_NOT_CLOSED}` });
      assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'open', 'premise: not closed');
      // The advice, followed as given, closes other's `work`; keeping the id
      // the call used and adding the server, as "name its server" read, doesn't.
      const kept = await close(f, { channelId: 'other:work', serverId: 'other' }, 'c2');
      assert.equal(kept.success, false, 'premise: the bare id with the server named is no channel there');
      const followed = await close(f, { channelId: 'work', serverId: 'other' }, 'c3');
      assert.equal(followed.success, true, followed.error);
      assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'closed');
    } finally { await f.close(); await other.stop(); }
  });

  // AF #844 bot review 4, finding 55: where the other channel the bare name
  // reaches has a tune-out of its own, a close of it is refused until that
  // tune-out is cancelled, so the not-closed sentence says so and names the
  // cancel first, then the close.
  it("the focus's channel beside another server's `work` with its own tune-out: the not-closed sentence names that tune-out's cancel, then the close", async () => {
    const f = await focused();
    const other = await otherServer(f);
    try {
      await other.registerOpen('work');
      const tuned = coordinatorOf(f).enter('other', 'work', {}, 'agent-tool');
      assert.ok(tuned.ok, (tuned as { error?: string }).error);
      assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'tuned-out', 'premise: other\'s work is tuned out');
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, true, result.error);
      assert.deepEqual(result.data, {
        channelId: 'work', serverId: 'editor', status: 'closed',
        note: `${ENDED} Channel "work" on server "other" was not closed: it is tuned out, and a close doesn't change that. ` +
          'Call tune_out with channelId "other:work" and mode "cancel" for it to resume normal attention; cancelling delivers ' +
          'the diverted backlog, and channel_close with channelId "work" and serverId "other" closes it after that.',
      });
      // As it says: the close given now is refused while the tune-out stands.
      const early = await close(f, { channelId: 'work', serverId: 'other' }, 'c2');
      assert.equal(early.success, false, 'premise: refused while tuned out');
      assert.match(String(early.error), /is tuned out/);
    } finally { await f.close(); await other.stop(); }
  });

  it("the focus's channel still registered beside another server's `work`: the close goes to the focus's channel, and says other's `work` was not closed", async () => {
    const f = await focused();
    const other = await otherServer(f);
    try {
      await other.registerOpen('work');
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, true, result.error);
      assert.deepEqual(result.data, { channelId: 'work', serverId: 'editor', status: 'closed', note: `${ENDED} ${OTHER_NOT_CLOSED}` });
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
      assert.equal(internals(f).channelRegistry.getDesiredState('editor', 'work'), 'closed');
      assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'open', "other's work stays open");
      // The focus's end wakes the resident: its turn answered, the host is
      // idle, and nothing it did sent other's server a close.
      f.alwaysRespond();
      await f.framework.runUntilIdle();
      assert.deepEqual(other.closes, [], "other's server was sent no close");
    } finally { await f.close(); await other.stop(); }
  });

  it('control: with no second `work`, the repeat ends the old focus and says no close was sent', async () => {
    const f = await focused();
    try {
      await firstCloseFails(f);
      await f.send('channels/changed', { removed: ['work'] });
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.equal(result.error, `Server "editor" no longer registers channel "work", so no close was recorded or sent. ${ENDED}`);
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
    } finally { await f.close(); }
  });

  for (const input of [{ channelId: 'work', serverId: 'other' }, { channelId: 'other:work' }]) {
    it(`control: a close naming other's server (${JSON.stringify(input)}) closes other's \`work\` and leaves the focus alone`, async () => {
      const f = await focused();
      const other = await otherServer(f);
      try {
        await firstCloseFails(f);
        await f.send('channels/changed', { removed: ['work'] });
        await other.registerOpen('work');
        const result = await close(f, input);
        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.data, { channelId: 'work', serverId: 'other', status: 'closed' });
        assert.ok(coordinatorOf(f).getAllExcept(), 'the focus is in force');
        assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'closed');
        // A tool close's lifecycle sends channels/close once per queued
        // operation, here more than once (as for the fixture's own server).
        assert.ok(other.closes.length > 0 && other.closes.every((id) => id === 'work'), `other's server was sent the close: ${JSON.stringify(other.closes)}`);
      } finally { await f.close(); await other.stop(); }
    });
  }
});

/** The calling turn's origin, the turn owning other's `work`, as a channel_open naming it makes it the turn's. */
const OTHERS_TURN = { kind: 'agent', agentName: 'agent', own: [{ serverId: 'other', channelId: 'work' }] };
const inTurn = (f: Fixture, name: string, input: Record<string, unknown>): Promise<Answer> =>
  framework(f).channelRegistry.handleChannelToolCall(name, input, OTHERS_TURN);

const FOCUS_OR_OWN = 'Channel "work" names both the channel the all-except focus excepts ("editor:work") and this turn\'s channel ("other:work"), ' +
  'so nothing ran. Call again with channelId set to one of them, or with serverId set to "editor" or "other".';

describe("a bare channel_close id that both the focus's channel and the calling turn's own channel on another server answer to is refused", () => {
  const states: Array<[string, (f: Fixture) => Promise<void>]> = [
    ["the focus's channel still registered", async () => {}],
    ["the focus's channel no longer registered", async (f) => { await f.send('channels/changed', { removed: ['work'] }); }],
  ];
  for (const [how, then] of states) {
    it(`${how}: the repeat after a failed close, in a turn that opened other's \`work\`, closes neither, the focus in force`, async () => {
      const f = await focused();
      const other = await otherServer(f);
      try {
        await other.registerOpen('work');
        await firstCloseFails(f);
        await then(f);
        const opened = await inTurn(f, 'channel_open', { channelId: 'work', serverId: 'other' });
        assert.equal(opened.success, true, opened.error);
        const result = await inTurn(f, 'channel_close', { channelId: 'work' });
        assert.equal(result.success, false, `nothing ran: ${JSON.stringify(result)}`);
        assert.equal(result.error, FOCUS_OR_OWN);
        assert.ok(coordinatorOf(f).getAllExcept(), 'the focus is in force');
        assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'open', "other's work stays open");
        assert.deepEqual(other.closes, [], "other's server was sent no close");
      } finally { await f.close(); await other.stop(); }
    });
  }

  for (const input of [{ channelId: 'work', serverId: 'other' }, { channelId: 'other:work' }]) {
    it(`control: in that turn, a close naming other's server (${JSON.stringify(input)}) closes other's \`work\` and leaves the focus alone`, async () => {
      const f = await focused();
      const other = await otherServer(f);
      try {
        await other.registerOpen('work');
        await firstCloseFails(f);
        const result = await inTurn(f, 'channel_close', input);
        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.data, { channelId: 'work', serverId: 'other', status: 'closed' });
        assert.ok(coordinatorOf(f).getAllExcept(), 'the focus is in force');
        assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'closed');
      } finally { await f.close(); await other.stop(); }
    });
  }

  for (const input of [{ channelId: 'work', serverId: 'editor' }, { channelId: 'editor:work' }]) {
    it(`control: in that turn, a close naming the focus's server (${JSON.stringify(input)}) closes the focus's channel and ends the focus`, async () => {
      const f = await focused();
      const other = await otherServer(f);
      try {
        await other.registerOpen('work');
        await firstCloseFails(f);
        const result = await inTurn(f, 'channel_close', input);
        assert.equal(result.success, true, result.error);
        assert.equal((result.data as { serverId?: string }).serverId, 'editor');
        assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
        assert.equal(internals(f).channelRegistry.getDesiredState('editor', 'work'), 'closed');
        assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'open', "other's work stays open");
      } finally { await f.close(); await other.stop(); }
    });
  }

  // AF #844 bot review 3, finding 57: a bare id answers to the turn's own
  // channels first, so where another of them has the id "other:work" (on a
  // server that no longer registers it), that name doesn't reach other's
  // `work`, and the refusal doesn't offer it; the serverId it offers does.
  it("in a turn with another own channel whose id is other's qualified name, the refusal doesn't offer that name, and its serverId advice closes other's `work`", async () => {
    const f = await focused();
    const other = await otherServer(f);
    const turn = { kind: 'agent', agentName: 'agent', own: [{ serverId: 'other', channelId: 'work' }, { serverId: 'gone', channelId: 'other:work' }] };
    const call = (input: Record<string, unknown>) => framework(f).channelRegistry.handleChannelToolCall('channel_close', input, turn);
    try {
      await other.registerOpen('work');
      await firstCloseFails(f);
      const refused = await call({ channelId: 'work' });
      assert.equal(refused.success, false, `nothing ran: ${JSON.stringify(refused)}`);
      assert.ok(!refused.error!.includes('"other:work"'), `"other:work" reaches the turn's other channel, so it isn't offered: ${refused.error}`);
      assert.ok(refused.error!.includes('Call again with channelId "editor:work", or with serverId set to "editor" or "other".'), refused.error);
      const byName = await call({ channelId: 'other:work' });
      assert.equal(byName.success, false, 'premise: the name reaches the turn\'s channel on "gone"');
      const result = await call({ channelId: 'work', serverId: 'other' });
      assert.equal(result.success, true, result.error);
      assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'closed');
      assert.ok(coordinatorOf(f).getAllExcept(), 'the focus is in force');
    } finally { await f.close(); await other.stop(); }
  });

  it("control: a turn whose own channel is the focus's: the bare id closes it and ends the focus", async () => {
    const f = await focused();
    const other = await otherServer(f);
    try {
      await other.registerOpen('work');
      const result = await framework(f).channelRegistry.handleChannelToolCall('channel_close', { channelId: 'work' },
        { kind: 'agent', agentName: 'agent', own: [{ serverId: 'editor', channelId: 'work' }] });
      assert.equal(result.success, true, result.error);
      assert.equal((result.data as { serverId?: string }).serverId, 'editor');
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'the focus ended');
      assert.equal(internals(f).channelRegistry.getDesiredState('other', 'work'), 'open', "other's work stays open");
    } finally { await f.close(); await other.stop(); }
  });
});
