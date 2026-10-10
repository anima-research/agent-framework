/**
 * Targeted publish (MCPL RFC-011), end to end over a real MCPL child that
 * implements it (fixtures/speech-route-mcpl-server.mjs): every publication
 * the framework makes names its place inside the channel — a thread, or the
 * root — and goes only where the connector declares it posts exactly
 * (`capabilities.publish.target`). Plain speech, channel_publish, draft
 * resends and channel_open's speech target all follow the one rule; a
 * delivery counts only when its echo names the place asked for.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, type ContentBlock } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ProseDraftStore } from '../src/prose-drafts.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
/** Posts exactly where asked, threads included. */
const ROOM = 'discord:g1:room';
/** Has no threads. */
const GENERAL = 'discord:g1:general';
/** Declares nothing: the connector would choose the place itself. */
const LEGACY = 'discord:g1:legacy';
const CHANNELS = [
  { id: ROOM, label: '#room (Guild One)', publishTarget: 'exact' },
  { id: GENERAL, label: '#general (Guild One)', publishTarget: 'root' },
  { id: LEGACY, label: '#legacy (Guild One)', publishTarget: null },
];

interface Logged { event: string; channelId?: string; text?: string; threadId?: string | null; reason?: string }

describe('targeted publish (MCPL RFC-011)', () => {
  let dir: string;
  let commandPath: string;
  let statusPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let incoming = 0;

  const until = async (cond: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const command = (c: Record<string, unknown>): void => appendFileSync(commandPath, JSON.stringify(c) + '\n');
  const logged = (): Logged[] => existsSync(statusPath)
    ? readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged)
    : [];
  const publishes = (): Logged[] => logged().filter((e) => e.event === 'publish' || e.event === 'publish-refused');
  const texts = (): string[] => framework.getAgent('scout')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
  const drafts = () => (framework as unknown as { proseDrafts: ProseDraftStore }).proseDrafts.open('scout');
  const toolResults = (): string => JSON.stringify(membrane.lastStream?.receivedToolResults ?? []);
  const registry = () => (framework as unknown as {
    channelRegistry: { listChannelsRaw(): unknown[]; publishTarget(t: { channelId: string }): string | undefined };
  }).channelRegistry;

  /** One message in `channelId` (a thread of it with `threadId`) starts a turn; resolves when it settles. */
  const turn = async (
    responses: Array<ReturnType<typeof createMockResponse>>,
    channelId: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    for (const r of responses) membrane.pushResponse(r);
    const before = membrane.calls.length;
    command({ op: 'incoming', channelId, messageId: `in-${++incoming}`, mode: 'addressed', text: `message ${incoming}`, ...extra });
    await until(() => membrane.calls.length > before, 'turn start');
    await framework.runUntilIdle();
    await until(() => !(framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens.has('scout'), 'turn end');
    await framework.runUntilIdle();
  };
  const say = (text: string) => createMockResponse([{ type: 'text', text }]);
  const call = (name: string, input: Record<string, unknown>, id = `c-${name}`) =>
    createMockResponse([{ type: 'tool_use', id, name, input }] as ContentBlock[], 'tool_use');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'targeted-publish-'));
    commandPath = join(dir, 'commands.jsonl');
    statusPath = join(dir, 'status.jsonl');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    incoming = 0;
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: {
          STATUS_PATH: statusPath,
          COMMAND_PATH: commandPath,
          CHANNELS: JSON.stringify(CHANNELS),
          TOOLS: JSON.stringify(['reply_message', 'ring']),
        },
      }],
      modules: [],
    });
    await framework.start();
    await until(() => registry().listChannelsRaw().length >= 3, 'registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads each channel\'s declaration from its descriptor', () => {
    assert.equal(registry().publishTarget({ channelId: ROOM }), 'exact');
    assert.equal(registry().publishTarget({ channelId: GENERAL }), 'root');
    assert.equal(registry().publishTarget({ channelId: LEGACY }), undefined);
  });

  it('plain speech answering a thread goes into that thread, and its receipt says so', async () => {
    await turn([say('answering the thread')], ROOM, { threadId: 't-1' });
    assert.deepEqual(publishes().map((p) => [p.event, p.channelId, p.threadId, p.text]), [['publish', ROOM, 't-1', 'answering the thread']]);
    assert.ok(texts().some((t) => t.startsWith('[routing] Your plain speech now lands in #room (Guild One) (discord / discord:g1:room, thread t-1)')));
    assert.ok(texts().some((t) => t.startsWith('[delivered]') && t.includes('thread t-1')), texts().filter((t) => t.startsWith('[delivered]')).join(' | '));
  });

  it('plain speech answering the channel itself names the root explicitly: threadId null on the wire', async () => {
    await turn([say('at the top level')], ROOM);
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId]), [[ROOM, null]]);
  });

  it('a channel that declares nothing: speech is held as a draft, nothing is published, and the connector\'s tools are named to consult', async () => {
    await turn([say('hello legacy')], LEGACY);
    assert.deepEqual(publishes(), []);
    assert.deepEqual(drafts().map((d) => [d.text, d.reason]), [['hello legacy', 'no-destination']]);
    const notice = texts().find((t) => t.startsWith('[routing]')) ?? '';
    assert.match(notice, /(?:^|[^#])#legacy \(Guild One\) \(discord \/ discord:g1:legacy\): its connector doesn't declare where a post lands \(MCPL RFC-011\)/,
      'the label once, with its own # and no second one');
    assert.match(notice, /publication from here is unavailable until it does/);
    assert.match(notice, /may reach it; consult them: `mcpl--discord--reply_message`\./, 'a send-named tool, not the unrelated one');
    assert.doesNotMatch(notice, /ring/);
  });

  it('a thread on a channel that declares no threads: held, never posted to the root', async () => {
    await turn([say('into the void')], GENERAL, { threadId: 't-9' });
    assert.deepEqual(publishes(), []);
    assert.deepEqual(drafts().map((d) => d.reason), ['no-destination']);
    assert.match(drafts()[0]!.note ?? '', /is a thread, but its connector declares the channel has no threads/);
  });

  it('channel_publish posts into a named thread, refuses a thread where there are none, and means the root without one', async () => {
    await turn([
      call('channel_publish', { channelId: ROOM, threadId: 't-2', content: 'into t-2' }, 'p1'),
      call('channel_publish', { channelId: GENERAL, threadId: 't-3', content: 'nowhere' }, 'p2'),
      call('channel_publish', { channelId: ROOM, content: 'at the root' }, 'p3'),
      call('channel_publish', { channelId: LEGACY, content: 'legacy' }, 'p4'),
      createMockResponse([]),
    ], GENERAL);
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId, p.text]), [
      [ROOM, 't-2', 'into t-2'],
      [ROOM, null, 'at the root'],
    ], 'the threadless and the undeclared channels saw nothing');
    const results = toolResults();
    assert.match(results, /has no threads \(its connector declares root\), so a post into thread t-3 is refused/);
    assert.match(results, /doesn't declare where a post lands \(MCPL RFC-011\)/);
  });

  it('channel_publish without a channel follows the route, thread included', async () => {
    await turn([call('channel_publish', { content: 'explicitly here' }), createMockResponse([])], ROOM, { threadId: 't-4' });
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId, p.text]), [[ROOM, 't-4', 'explicitly here']]);
  });

  it('a held draft can be resent into a named thread, or to a channel\'s root', async () => {
    await turn([say('words for later')], LEGACY);
    const [held] = drafts();
    assert.ok(held);
    await turn([
      call('drafts', { action: 'resend', draftIds: [held!.id], destination: ROOM, threadId: 't-5' }),
      createMockResponse([]),
    ], GENERAL);
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId, p.text]), [[ROOM, 't-5', 'words for later']]);
    assert.match(toolResults(), /delivered to #room \(Guild One\) \(discord \/ discord:g1:room, thread t-5\)/);
  });

  it('resending to a channel that declares nothing is refused before anything is attempted', async () => {
    await turn([say('kept')], LEGACY);
    const [held] = drafts();
    await turn([
      call('drafts', { action: 'resend', draftIds: [held!.id], destination: LEGACY }),
      createMockResponse([]),
    ], GENERAL);
    assert.deepEqual(publishes().filter((p) => p.text === 'kept'), []);
    assert.match(toolResults(), /doesn't declare where a post lands[^]*consult them: `mcpl--discord--reply_message`[^]*Nothing was sent/);
    assert.equal(drafts()[0]!.attempts.length, 0, 'no attempt was recorded');
  });

  it('channel_open can make a thread the speech target; a channel named alone means its root', async () => {
    await turn([
      call('channel_open', { channelId: ROOM, threadId: 't-6' }),
      say('in t-6'),
    ], GENERAL);
    await turn([
      call('channel_open', { channelId: ROOM }),
      say('at the root of room'),
    ], ROOM, { threadId: 't-7' });
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId, p.text]), [
      [ROOM, 't-6', 'in t-6'],
      [ROOM, null, 'at the root of room'],
    ], 'an explicit channel-only choice never borrows the thread the turn came from');
  });

  it('channel_open with a thread but setSpeechTarget: false says the thread was not used', async () => {
    await turn([
      call('channel_open', { channelId: ROOM, threadId: 't-9', setSpeechTarget: false }),
      say('still to general'),
    ], GENERAL);
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId]), [[GENERAL, null]]);
    assert.match(toolResults(), /Opened for reading\. threadId t-9 chooses where speech goes, so with setSpeechTarget: false it was not used\./);
  });

  it('channel_open on a channel that declares nothing opens it but sets no speech target', async () => {
    await turn([
      call('channel_open', { channelId: LEGACY }),
      say('still to general'),
    ], GENERAL);
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId, p.text]), [[GENERAL, null, 'still to general']]);
    assert.match(toolResults(), /Opened, but your plain speech can't go there: .*doesn't declare where a post lands.*Your plain speech still goes to #general/);
  });

  it('a delivery whose echo names another place is unconfirmed, never receipted as delivered', async () => {
    command({ op: 'publish-mode', mode: 'wrong-echo' });
    await until(() => logged().some((e) => e.event === 'publish-mode'), 'mode');
    await turn([say('somewhere?')], ROOM, { threadId: 't-8' });
    assert.deepEqual(publishes().map((p) => [p.channelId, p.threadId]), [[ROOM, 't-8']]);
    assert.ok(!texts().some((t) => t.startsWith('[delivered]')), 'not claimed as delivered');
    assert.ok(texts().some((t) => /was not confirmed/.test(t) && /reported posting at the channel root, not thread t-8/.test(t)),
      texts().filter((t) => t.includes('confirmed')).join(' | '));
  });

  it('a channels/changed that withdraws the declaration applies to the next turn', async () => {
    await turn([say('first')], GENERAL);
    command({ op: 'declare', channelId: GENERAL, target: null });
    await until(() => registry().publishTarget({ channelId: GENERAL }) === undefined, 'withdrawn');
    await turn([say('second')], GENERAL);
    assert.deepEqual(publishes().map((p) => p.text), ['first']);
    assert.deepEqual(drafts().map((d) => d.text), ['second']);
  });
});
