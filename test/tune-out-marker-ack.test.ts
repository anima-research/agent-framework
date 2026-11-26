import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventually, fixture, TS } from './helpers/coalescing-fixture.js';
import { SUB, MENTION, enter, find, held, incoming, internals, registerOpen, settle } from './helpers/admission.js';
import type { FrameworkConfig } from '../src/types/framework.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const wakeLog = new WeakMap<object, string[]>();

async function tunedOut(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-marker-ack-'));
  const privilegedUsersPath = join(dir, 'privileged.json');
  writeFileSync(privilegedUsersPath, JSON.stringify(['P1']));
  const f = await fixture({
    dir,
    mcpl: { channels: { incoming: true, register: true, lifecycle: true, publish: true, acknowledge: true } },
    framework: {
      subconscious: SUB,
      gate: { config: { policies: [], default: 'always' }, configPath: join(dir, 'gate.json'), privilegedUsersPath },
    } as Partial<FrameworkConfig>,
  });
  await registerOpen(f, 'noisy');
  enter(f, 'noisy');
  const wakes: string[] = [];
  (internals(f).tuneOutCoordinator as unknown as { scheduleWakeInvocation: (serverId: string, channelId: string) => void })
    .scheduleWakeInvocation = (serverId, channelId) => { wakes.push(`${serverId}:${channelId}`); };
  wakeLog.set(f, wakes);
  return f;
}

function line(f: Fixture, messageId: string, text: string, tags: string[], authorId = 'U1') {
  return f.send('channels/incoming', {
    messages: [{ channelId: 'noisy', messageId, timestamp: TS, author: { id: authorId, name: authorId }, tags, content: [{ type: 'text', text }] }],
  });
}

async function ackedBefore(f: Fixture): Promise<unknown[]> {
  await incoming(f, 'noisy', 'sentinel', 'agent, are you still there?', MENTION);
  await settle(f);
  await eventually(() => f.acknowledged.some((a) => a.messageId === 'sentinel'), "the sentinel's acknowledgement");
  const ids = f.acknowledged.map((a) => a.messageId);
  return ids.slice(0, ids.indexOf('sentinel'));
}
const wakesScheduled = (f: Fixture): number => wakeLog.get(f)!.length;

describe('a held marker in a tuned-out channel is not acknowledged', () => {
  it("an edit line that addresses the agent, with a change line's id, gets no channels/acknowledge; the reader's wake is scheduled as before", async () => {
    const f = await tunedOut();
    try {
      await line(f, 'edit:77:b', '[edited] hey agent, lunch at one?', ['chat:edited', 'chat:mention']);
      await settle(f);
      assert.ok(held(find(f, 'lunch at one')), 'premise: the line is held');
      assert.equal(wakesScheduled(f), 1);
      assert.deepEqual(await ackedBefore(f), []);
    } finally { await f.close(); }
  });

  for (const [tag, id] of [['chat:reaction', 'r1'], ['chat:reaction-remove', 'r3'], ['chat:deleted', 'd1']] as const) {
    it(`a ${tag} line that addresses the agent gets no channels/acknowledge; the reader's wake is scheduled as before`, async () => {
      const f = await tunedOut();
      try {
        await line(f, id, `[${tag}] on a message that mentions agent`, [tag, 'chat:mention']);
        await settle(f);
        assert.ok(held(find(f, `[${tag}]`)), 'premise: the line is held');
        assert.equal(wakesScheduled(f), 1);
        assert.deepEqual(await ackedBefore(f), []);
      } finally { await f.close(); }
    });
  }

  it("a notice that addresses the agent by its place gets no channels/acknowledge; the reader's wake is scheduled as before", async () => {
    const f = await tunedOut();
    try {
      await line(f, 's1', 'pat pinned a message', ['chat:system', 'chat:addressed']);
      await settle(f);
      assert.ok(held(find(f, 'pat pinned')), 'premise: the line is held');
      assert.equal(wakesScheduled(f), 1);
      assert.deepEqual(await ackedBefore(f), []);
    } finally { await f.close(); }
  });

  it("a deletion that addresses the agent gets no channels/acknowledge, though its event carries the first-view mark; the reader's wake is scheduled as before", async () => {
    const f = await tunedOut();
    try {
      await (f.framework as unknown as { handleMcplChannelIncoming(event: Record<string, unknown>): Promise<unknown> }).handleMcplChannelIncoming({
        type: 'mcpl:channel-incoming', serverId: 'editor', channelId: 'noisy', messageId: 'd2',
        author: { id: 'U1', name: 'U1' }, content: [{ type: 'text', text: '[deleted] agent, lunch?' }],
        timestamp: TS, metadata: {}, tags: ['chat:deleted', 'chat:edited', 'chat:mention', 'chat:addressed'], triggerInference: true, firstView: true,
      });
      await settle(f);
      assert.ok(held(find(f, '[deleted]')), 'premise: the line is held');
      assert.equal(wakesScheduled(f), 1);
      assert.deepEqual(await ackedBefore(f), []);
    } finally { await f.close(); }
  });
});

describe('what a held line got before, it still gets', () => {
  it('a message that mentions the agent is acknowledged, and wakes the reader', async () => {
    const f = await tunedOut();
    try {
      await incoming(f, 'noisy', 'm1', 'agent, you there?', MENTION);
      await settle(f);
      assert.ok(held(find(f, 'you there')), 'premise: the message is held');
      assert.equal(wakesScheduled(f), 1);
      assert.deepEqual(await ackedBefore(f), ['m1']);
    } finally { await f.close(); }
  });

  it("an edit that the coalescer delivers as the agent's first view of its message, through the channel lane, is acknowledged as the message it stands for", async () => {
    const f = await tunedOut();
    try {
      await f.send('channels/incoming', { messages: [{ ...f.channel('e3', 'agent, lunch?', { initial: true }, 'noisy', 'm4'), tags: ['chat:mention'] }] });
      await settle(f);
      await f.send('channels/incoming', {
        messages: [{ ...f.channel('e4', 'agent, lunch at one?', {}, 'noisy', 'm4'), tags: ['chat:edited', 'chat:mention'] }],
      });
      await settle(f);
      const row = find(f, 'lunch at one');
      assert.ok(held(row), 'premise: the edit is held');
      assert.equal(row.metadata?.firstView, true, "premise: the coalescer marked the edit as the agent's first view");
      assert.equal(wakesScheduled(f), 2, 'a wake for the message, and one for the edit');
      assert.deepEqual(await ackedBefore(f), ['m4', 'm4'], 'the message, then the edit that stands for it');
    } finally { await f.close(); }
  });

  it("an edit that the coalescer delivers as the agent's first view of its message, through the push lane, is acknowledged too", async () => {
    const f = await tunedOut();
    try {
      const push = (eventId: string, text: string, tags: string[], flags: Record<string, unknown>) => f.send('push/event', {
        ...f.params(eventId, text, { key: 'message:m5', ...flags }),
        origin: { mcplChannelId: 'noisy', authorId: 'U1', authorName: 'antra' }, tags,
      });
      await push('p1', 'agent, dinner?', ['chat:mention'], { initial: true });
      await settle(f);
      await push('p2', 'agent, dinner at eight?', ['chat:edited', 'chat:mention'], {});
      await settle(f);
      const row = find(f, 'dinner at eight');
      assert.ok(held(row), 'premise: the edit is held');
      assert.equal(row.metadata?.firstView, true, "premise: the coalescer marked the edit as the agent's first view");
      assert.equal(wakesScheduled(f), 2, 'a wake for the message, and one for the edit');
      assert.deepEqual(await ackedBefore(f), ['p1', 'p2'], "the message, then the edit that stands for it, each by its event's id, as the push lane names it");
    } finally { await f.close(); }
  });

  it("a reaction of a privileged author that doesn't address the agent wakes the reader, with no channels/acknowledge", async () => {
    const f = await tunedOut();
    try {
      await line(f, 'r2', 'P1 reacted 👍', ['chat:reaction'], 'P1');
      await settle(f);
      assert.ok(held(find(f, 'reacted')), 'premise: the line is held');
      assert.equal(wakesScheduled(f), 1);
      assert.deepEqual(await ackedBefore(f), []);
    } finally { await f.close(); }
  });
});
