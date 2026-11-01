/**
 * A gate policy's `match.channel` against both ways a channel's events
 * arrive, end to end over a real MCPL child (#702). A message in an open
 * channel comes through channels/incoming with the registered id
 * (`discord:g1:room`). Every other event comes as a push/event: an addressed
 * message in a closed channel, with the adapter's raw id (`room`) in
 * origin.channelId and the registered id in origin.mcplChannelId or without
 * it, and, in any channel, a reaction or a voice report, shaped as
 * discord-mcpl sends them. A pattern is tested against the event's id and,
 * when that misses, against the registered id the gate resolves for its
 * route. The gate doesn't know whether a channel is open: the path a message
 * takes is what differs.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { GatePolicy } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const RAW = 'room';
const REGISTERED = `discord:g1:${RAW}`;
const BOTH_PATHS = ['mcpl:channel-incoming', 'mcpl:push-event'];

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('gate channel patterns on both paths', () => {
  let tempDir: string | undefined;
  let framework: AgentFramework | undefined;

  afterEach(async () => {
    await framework?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    framework = undefined;
    tempDir = undefined;
  });

  /** Starts a framework with these policies and returns a function that
   *  sends one fixture command and names the policy the event matched, by
   *  the gate's decision trace, with the trigger of every decision so far. */
  async function gateFor(policies: GatePolicy[]): Promise<((line: string) => Promise<string>) & { triggers: () => boolean[] }> {
    tempDir = mkdtempSync(join(tmpdir(), 'gate-channel-ids-'));
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      gate: { config: { policies, default: 'skip' } },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const internal = framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } };
    await waitFor(() => internal.channelRegistry.listChannelsRaw().length >= 2, 'channel registration');
    // The gate's decision for every event it weighs, as an operator's trace sees it.
    const decisions: Array<{ matchedPolicy: string | null; trigger: boolean }> = [];
    framework.onTrace((event) => { if (event.type === 'gate:decision') decisions.push(event); });
    const send = async (line: string): Promise<string> => {
      const before = decisions.length;
      appendFileSync(commandPath, `${line}\n`);
      await waitFor(() => decisions.length > before, `the gate's decision on ${line}`);
      const made = decisions.slice(before);
      assert.equal(made.length, 1, `one decision on ${line}`);
      assert.ok(made[0]!.matchedPolicy, `a policy matches ${line}`);
      return made[0]!.matchedPolicy!;
    };
    return Object.assign(send, { triggers: () => decisions.map((d) => d.trigger) });
  }

  /** A push/event the fixture sends as given. */
  const push = (params: Record<string, unknown>): string => `push ${JSON.stringify({ featureSet: 'chat', timestamp: new Date().toISOString(), ...params })}`;
  /** An addressed message in a closed guild channel, as discord-mcpl's
   *  push/event sends it: the raw id in origin.channelId, with the registered
   *  id in origin.mcplChannelId (composite) or without it (bare). */
  const guildMessage = (eventId: string, guildId: string, rawChannelId: string, form: 'composite' | 'bare'): string => push({
    eventId,
    origin: {
      source: 'discord',
      messageId: eventId,
      guildId,
      channelId: rawChannelId,
      ...(form === 'composite' ? { mcplChannelId: `discord:${guildId}:${rawChannelId}` } : {}),
      channelName: rawChannelId,
      authorId: 'U-other',
      authorName: 'someone',
      isMention: true,
      isDM: false,
    },
    tags: ['chat:mention', 'chat:addressed', 'chat:from-human'],
    payload: { content: [{ type: 'text', text: 'hello' }] },
  });

  /** One addressed message in the room down each path: channels/incoming,
   *  and a push with the registered id in its origin and without it. */
  async function matched(policies: GatePolicy[]): Promise<{ incoming: string; pushComposite: string; pushBare: string }> {
    const send = await gateFor(policies);
    return {
      incoming: await send(`incoming ${REGISTERED} m-1 addressed hello`),
      pushComposite: await send(guildMessage('ev-2', 'g1', RAW, 'composite')),
      pushBare: await send(guildMessage('ev-3', 'g1', RAW, 'bare')),
    };
  }

  /** A reaction in the room, as discord-mcpl's reaction push carries it. */
  const reaction = push({
    eventId: 'ev-reaction',
    origin: { source: 'discord', channelId: RAW, messageId: 'm-1', guildId: 'g1', mcplChannelId: REGISTERED, reactorId: 'U-other', reactorName: 'someone', emoji: '👍', action: 'add' },
    tags: ['chat:reaction'],
    payload: { content: [{ type: 'text', text: '[reaction] @someone reacted 👍 on your message' }] },
  });
  /** A voice report, whose origin names the channel by its registered id alone. */
  const voiceReport = push({
    eventId: 'ev-voice',
    origin: { source: 'discord', mcplChannelId: REGISTERED, inferenceId: 'inf-1', playedMs: 1200 },
    tags: ['voice:interrupted'],
    payload: { content: [{ type: 'text', text: '[voice] Your spoken message was interrupted' }] },
  });

  const roomThenRest = (channel: string): GatePolicy[] => [
    { name: 'room', match: { scope: BOTH_PATHS, channel }, behavior: 'defer' },
    { name: 'rest', match: { scope: BOTH_PATHS }, behavior: 'defer' },
  ];

  it('a pattern in the registered form matches the channel on both paths', async () => {
    assert.deepEqual(await matched(roomThenRest(REGISTERED)), { incoming: 'room', pushComposite: 'room', pushBare: 'room' });
  });

  it('a glob of the registered form matches the guild on both paths', async () => {
    assert.deepEqual(await matched(roomThenRest('discord:g1:*')), { incoming: 'room', pushComposite: 'room', pushBare: 'room' });
  });

  it('a glob ending in the raw id matches both paths, as before', async () => {
    assert.deepEqual(await matched(roomThenRest(`*${RAW}`)), { incoming: 'room', pushComposite: 'room', pushBare: 'room' });
  });

  it('a glob ending in the raw id now also meets a voice report, which carries no raw id, through its registered id', async () => {
    const send = await gateFor(roomThenRest(`*${RAW}`));
    assert.equal(await send(voiceReport), 'room');
  });

  it('a raw id matches push events alone, as before, since channels/incoming carries no raw id', async () => {
    assert.deepEqual(await matched(roomThenRest(RAW)), { incoming: 'rest', pushComposite: 'room', pushBare: 'room' });
  });

  it("an addressed message's push meets a channel policy ahead of the addressed rule, as its channels/incoming message does", async () => {
    assert.deepEqual(await matched([
      { name: 'firehose', match: { source: 'discord', channel: `discord:*:${RAW}` }, behavior: 'defer' },
      { name: 'mentions', match: { tagsAny: ['chat:addressed'] }, behavior: 'defer' },
    ]), { incoming: 'firehose', pushComposite: 'firehose', pushBare: 'firehose' });
  });

  it("a reaction's push meets the room's policy, and the policy's other conditions still apply", async () => {
    const send = await gateFor([
      { name: 'room-reactions', match: { scope: BOTH_PATHS, channel: REGISTERED, tagsAny: ['chat:reaction'] }, behavior: 'defer' },
      { name: 'rest', match: { scope: BOTH_PATHS }, behavior: 'defer' },
    ]);
    assert.equal(await send(reaction), 'room-reactions');
    assert.equal(await send(guildMessage('ev-2', 'g1', RAW, 'composite')), 'rest', 'an addressed message in the room has no reaction tag');
  });

  it("a voice report, whose origin names its channel by the registered id alone, meets the room's policy", async () => {
    const send = await gateFor(roomThenRest(REGISTERED));
    assert.equal(await send(voiceReport), 'room');
  });

  it("another channel's push doesn't meet the room's policy", async () => {
    const send = await gateFor(roomThenRest(REGISTERED));
    assert.equal(await send(guildMessage('ev-4', 'g1', 'general', 'composite')), 'rest');
    assert.equal(await send(guildMessage('ev-5', 'g2', 'room', 'bare')), 'rest', 'nor does a channel of the same raw id in another guild');
  });

  it("a channel's message, a reaction and a voice report there share one sampling counter under keyBy channelId", async () => {
    const send = await gateFor([
      { name: 'room-sample', match: { scope: BOTH_PATHS, channel: REGISTERED }, behavior: { passive_sample: { every: 3, keyBy: 'channelId' } } },
      { name: 'rest', match: { scope: BOTH_PATHS }, behavior: 'defer' },
    ]);
    assert.equal(await send(`incoming ${REGISTERED} m-1 addressed hello`), 'room-sample');
    assert.equal(await send(reaction), 'room-sample');
    assert.equal(await send(voiceReport), 'room-sample');
    assert.deepEqual(send.triggers().slice(-3), [false, false, true], 'the third event in the channel is the third on its counter, so it fires');
  });

  it("a rate limit keyed by channelId counts a channel's message and reaction in one bucket, whatever its policy matches", async () => {
    const send = await gateFor([
      { name: 'limit', match: { scope: BOTH_PATHS }, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 3_600_000, keyBy: 'channelId' } } },
    ]);
    assert.equal(await send(`incoming ${REGISTERED} m-1 addressed hello`), 'limit');
    assert.equal(await send(reaction), 'limit');
    assert.deepEqual(send.triggers().slice(-2), [true, false], "the reaction finds the message's bucket empty");
  });

  it("another adapter's push that names no registered id matches by its raw id alone", async () => {
    const send = await gateFor([
      { name: 'registered', match: { scope: BOTH_PATHS, channel: REGISTERED }, behavior: 'defer' },
      { name: 'raw', match: { scope: BOTH_PATHS, channel: RAW }, behavior: 'defer' },
      { name: 'rest', match: { scope: BOTH_PATHS }, behavior: 'defer' },
    ]);
    assert.equal(await send(push({
      eventId: 'ev-other-adapter',
      origin: { source: 'other', channelId: RAW, messageId: 'o-1' },
      tags: ['chat:addressed'],
      payload: { content: [{ type: 'text', text: 'hello from elsewhere' }] },
    })), 'raw');
    assert.equal(await send(guildMessage('ev-8', 'g1', RAW, 'bare')), 'registered', "a Discord push in the room meets the registered form first");
  });

  it("a DM's push meets a pattern in a DM's registered form", async () => {
    const send = await gateFor(roomThenRest('discord:dm:*'));
    assert.equal(await send('dm ev-6 134 1548000000000000001 are you there?'), 'room');
    assert.equal(await send(guildMessage('ev-7', 'g1', RAW, 'composite')), 'rest');
  });
});
