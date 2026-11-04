/**
 * What a channel_close result says of the all-except hold (the focus) that
 * excepts the channel it names (AF #844 review follow-up, Isaac-3593,
 * round 3): the focus status true when the result arrives, a focus end that
 * happened before a failure, and a repeat close that names the excepted
 * channel after its server no longer registers it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { SUB, internals, textOf, find, has, incoming, registerOpen, settle, type Fixture } from './helpers/admission.js';

type Answer = { success: boolean; data?: unknown; error?: string };
type Framework = {
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  disconnectMcplServer(id: string): Promise<void>;
  mcplServerRegistry: { getServer(id: string): { sendChannelsClose(params: { channelId: string }): Promise<unknown> } | null };
  channelRegistry: { handleChannelToolCall(name: string, input: unknown, origin?: unknown): Promise<Answer> };
};

const ENDED = 'The focus on it ended, and what the other channels held was delivered.';
const WAITS = /^The close cancels the all-except hold that excepts it\. Not cancelled yet: /;

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
        "The close wasn't recorded: post-end inference refused (probe). The focus on it ended before that failure, and what the other channels held was delivered.");
      assert.match(textOf(find(f, 'all channels except')), /antra: held/, 'its backlog was released');
    } finally { await f.close(); }
  });

  it("a release that fails before the end: the error says the close wasn't recorded, and nothing of an end", async () => {
    const f = await focused();
    try {
      const hooks = (coordinatorOf(f) as unknown as { hooks: { commitDeliveries?: () => boolean } }).hooks;
      hooks.commitDeliveries = () => false;
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus is in force');
      assert.equal(result.error, "The close wasn't recorded: the all-except release could not be made durable, so the hold stays in force");
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

  it("a release that fails before the end: the answer says the focus wasn't ended, and why", async () => {
    const f = await focused();
    try {
      await f.send('channels/changed', { removed: ['work'] });
      (coordinatorOf(f) as unknown as { hooks: { commitDeliveries?: () => boolean } }).hooks.commitDeliveries = () => false;
      const result = await close(f, { channelId: 'work' });
      assert.equal(result.success, false);
      assert.ok(coordinatorOf(f).getAllExcept(), 'premise: the focus is in force');
      assert.equal(result.error, 'Server "editor" no longer registers channel "work", so no close was recorded or sent. '
        + "The focus on it wasn't ended: the all-except release could not be made durable, so the hold stays in force");
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
        + "A step of the focus's release failed: post-end inference refused (probe). The focus on it ended before that failure, and what the other channels held was delivered.");
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
        /^Server "editor" no longer registers channel "work", so no close was recorded or sent\. This call cancels the all-except hold that excepts it\. Not cancelled yet: /,
        result.error);
      release();
      assert.equal(coordinatorOf(f).getAllExcept(), null, 'ended at the release');
      assert.ok(has(f, 'antra: held'), 'its backlog released');
    } finally { release(); await f.close(); }
  });
});
