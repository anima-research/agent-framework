/**
 * MCPL content that context-manager won't store is refused where it would
 * be stored or queued. context-manager refuses a write whose content
 * doesn't match ContentBlock (MalformedContentError, its #185), and
 * malformedContentPlaces names where without throwing. Content from an MCPL
 * server is converted at the boundary into blocks the store accepts, so the
 * push and channel lanes' check is the backstop for events that never
 * crossed it, such as a module's, which these tests hand the lanes
 * directly. The lanes ask it first, so such a message stores no row, spawns
 * no fork and queues no wake, and their log line names where it came from.
 * Content the store mends, a tool_use whose input isn't an object, is
 * stored as before, and absent content is the empty-content check's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { logValue } from '../src/mcpl/log-value.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const TS = '2026-10-18T00:00:00.000Z';

/** Content the store refuses, each with a phrase of the place it names. */
const MALFORMED: Array<[string, unknown[], string]> = [
  ['a block that is a string', ['hello'], 'content[0]'],
  ['a text block whose text is a number', [{ type: 'text', text: 'hi' }, { type: 'text', text: 5 }], 'content[1]'],
  ['an image whose source is a string', [{ type: 'image', source: 'data' }], 'content[0]'],
];

async function harness(extra: Partial<Parameters<typeof AgentFramework.create>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'malformed-content-af-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    modules: [],
    ...extra,
  });
  const added: string[] = [];
  const refused: Array<Record<string, unknown>> = [];
  const traces: Array<Record<string, unknown>> = [];
  let starts = 0;
  framework.onTrace((e: any) => {
    traces.push(e);
    if (e.type === 'message:added') added.push(e.source);
    if (e.type === 'mcpl:malformed-content-refused') refused.push(e);
    if (e.type === 'inference:started') starts++;
  });
  // What the agent's own store holds, which a refusal mustn't add to.
  const stored = () => framework.getAgent('assistant')!.getContextManager().getAllMessages().length;
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  return {
    framework, membrane, added, refused, traces, errors, stored, starts: () => starts,
    close: async () => {
      console.error = error;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const [label, content, place] of MALFORMED) {
  test(`push: ${label} is refused, storing no row and queueing no wake, and the line names the server and channel`, async (t) => {
    const x = await harness(); t.after(x.close);
    x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'invented cause' }] as ContentBlock[]));
    const before = x.stored();
    (x.framework as any).handleMcplPushEvent({
      type: 'mcpl:push-event', serverId: 'module', featureSet: 'fs', eventId: 'e1',
      content, timestamp: TS, inferenceId: 'i', triggerInference: true,
      origin: { mcplChannelId: 'discord:g:c' },
    });
    await x.framework.runUntilIdle();
    assert.deepEqual(x.added, [], 'no row traced');
    assert.equal(x.stored(), before, 'and none in the store');
    assert.equal(x.starts(), 0, 'no wake');
    assert.equal(x.refused.length, 1);
    assert.equal(x.refused[0]!.lane, 'push');
    assert.equal(x.refused[0]!.serverId, 'module');
    assert.equal(x.refused[0]!.eventId, 'e1');
    assert.equal(x.refused[0]!.channelId, 'discord:g:c');
    assert.ok((x.refused[0]!.places as string[]).some((p) => p.includes(place)), JSON.stringify(x.refused[0]));
    const names = (e: string) => e.includes('module') && e.includes(logValue('discord:g:c')) && e.includes(logValue('e1')) && e.includes(place);
    assert.ok(x.errors.some((e) => e.startsWith('[push-event-refused]') && names(e)), x.errors.join('\n'));
  });

  test(`channel: ${label} is refused, storing no row and queueing no wake, and the line names the server and channel`, async (t) => {
    const x = await harness(); t.after(x.close);
    x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'invented cause' }] as ContentBlock[]));
    const before = x.stored();
    await (x.framework as any).handleMcplChannelIncoming({
      type: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:c', messageId: 'm1', eventId: 'ev1',
      author: { id: 'u', name: 'User' }, content, timestamp: TS, triggerInference: true,
    });
    await x.framework.runUntilIdle();
    assert.deepEqual(x.added, [], 'no row traced');
    assert.equal(x.stored(), before, 'and none in the store');
    assert.equal(x.starts(), 0, 'no wake');
    assert.deepEqual(x.refused.map((r) => [r.lane, r.serverId, r.channelId, r.messageId, r.eventId]), [['channel', 'discord', 'discord:g:c', 'm1', 'ev1']]);
    assert.ok((x.refused[0]!.places as string[]).some((p) => p.includes(place)), JSON.stringify(x.refused[0]));
    const names = (e: string) => e.replace(logValue('discord:g:c'), '').includes('discord') && e.includes(logValue('discord:g:c')) && e.includes(logValue('m1')) && e.includes(place);
    assert.ok(x.errors.some((e) => e.startsWith('[channel-incoming-refused]') && names(e)), x.errors.join('\n'));
  });
}

test('push: a tool_use whose input is not an object is mended by the store, so it is stored, not refused', async (t) => {
  const x = await harness(); t.after(x.close);
  x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'heard' }] as ContentBlock[]));
  (x.framework as any).handleMcplPushEvent({
    type: 'mcpl:push-event', serverId: 'module', featureSet: 'fs', eventId: 'e2',
    content: [{ type: 'text', text: 'a call' }, { type: 'tool_use', id: 't1', name: 'x', input: 'not an object' }],
    timestamp: TS, inferenceId: 'i', triggerInference: true,
  });
  await x.framework.runUntilIdle();
  assert.deepEqual(x.refused, []);
  assert.equal(x.added.length, 1, 'stored');
  const stored = x.framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content).find((b) => b.type === 'tool_use') as { input?: unknown } | undefined;
  assert.deepEqual(stored?.input, {}, 'with its input mended to an object');
});

test("channel: with conversation routing on, a malformed message that would bind a fork spawns none and stores nothing, where the same message well-formed binds one", async (t) => {
  const x = await harness({ conversations: { templateAgent: 'assistant', bind: { channel: 'mention' } } } as never);
  t.after(x.close);
  const agents = () => x.framework.getAllAgents().length;
  const before = agents();
  const message = (messageId: string, content: unknown[], triggerInference: boolean) => (x.framework as any).handleMcplChannelIncoming({
    type: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'slack:C1', messageId,
    author: { id: 'U1', name: 'alice' }, content, timestamp: TS, triggerInference,
    metadata: { mentioned: true },
  });
  // Visible text beside a malformed block, so the empty-content check would
  // let it through and only the malformed-content check stops it.
  await message('m2', [{ type: 'text', text: 'bot, help' }, { type: 'image', source: 'not-an-object' }], true);
  await x.framework.runUntilIdle();
  assert.equal(agents(), before, 'no fork was spawned');
  assert.deepEqual(x.traces.filter((e) => String(e.type).startsWith('mcpl:conversation-')), [], 'nor bound');
  assert.deepEqual(x.added, [], 'no row traced');
  assert.equal(x.refused.length, 1, 'refused instead');
  assert.equal(x.starts(), 0, 'and no wake');
  await message('m3', [{ type: 'text', text: 'bot, help' }], false);
  await x.framework.runUntilIdle();
  assert.equal(agents(), before + 1, 'the same message well-formed spawns a fork');
});

for (const lane of ['push', 'channel'] as const) {
  test(`${lane}: absent content, undefined or null, is the empty-content check's, not refused as malformed`, async (t) => {
    const x = await harness(); t.after(x.close);
    for (const [id, content] of [['e3', undefined], ['e4', null]] as const) {
      await (lane === 'push'
        ? (x.framework as any).handleMcplPushEvent({
            type: 'mcpl:push-event', serverId: 'module', featureSet: 'fs', eventId: id,
            content, timestamp: TS, inferenceId: 'i', triggerInference: true,
          })
        : await (x.framework as any).handleMcplChannelIncoming({
            type: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:c', messageId: `m-${id}`, eventId: id,
            author: { id: 'u', name: 'User' }, content, timestamp: TS, triggerInference: true,
          }));
      await x.framework.runUntilIdle();
    }
    assert.deepEqual(x.refused, [], 'no malformed-content refusal');
    assert.deepEqual(x.traces.filter((e) => e.type === 'mcpl:empty-content-dropped').map((e) => e.lane), [lane, lane]);
    assert.deepEqual(x.added, []);
  });
}
