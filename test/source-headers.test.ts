/**
 * Visible source headers (shelf-356), end to end over real MCPL children: each
 * channel-bearing item is stamped once, at ingestion, with
 * `[source: server / canonical-channel-id · label-at-receipt · thread … · reply to …]`
 * from its own frozen envelope and stored with the message, so it names its
 * conversation when read alone. Two unlike adapters (a Discord-shaped one with
 * guild channels and DMs, a Zulip-shaped one with topics inside a stream),
 * pushes, renames, coalesced corrections, backscroll and the model's own view
 * are covered.
 */
import { describe, it, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentFramework,
  readInboundSource,
  type Module,
  type ModuleContext,
  type ProcessEvent,
  type ProcessState,
  type EventResponse,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
} from '../src/index.js';
import { renderSourceHeader, SOURCE_HEADER_RULE } from '../src/mcpl/inbound-source.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { fixture } from './helpers/coalescing-fixture.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const GENERAL_1 = 'discord:g1:general';
const GENERAL_2 = 'discord:g2:general';
const STREAM = 'zulip:stream:7';
const RAW_DM = '1548000000000000001';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

class ConsoleModule implements Module {
  readonly name = 'console';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'Operator', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }] };
  }
}

describe('renderSourceHeader', () => {
  it('renders the agreed grammar, leaving out what an item does not have', () => {
    assert.equal(renderSourceHeader({ kind: 'channel', serverId: 'discord', channelId: ROOM, label: '#room (Guild One)' }),
      '[source: discord / discord:g1:room · #room (Guild One)]');
    assert.equal(renderSourceHeader({ kind: 'channel', serverId: 'zulip', channelId: STREAM, label: 'stream design', threadId: 'topic-a', replyTo: 'z0' }),
      '[source: zulip / zulip:stream:7 · stream design · thread topic-a · reply to z0]');
    assert.equal(renderSourceHeader({ kind: 'channel', serverId: 'discord', channelId: ROOM }), '[source: discord / discord:g1:room]');
    assert.equal(renderSourceHeader({ kind: 'unscoped', serverId: 'heartbeat' }), '[source: heartbeat · unscoped]');
    assert.equal(renderSourceHeader({ kind: 'surface' }), undefined);
  });
});

describe('source headers at ingestion', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  const commands: Record<string, string> = {};

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-headers-'));
    membrane = new MockMembrane();
    const server = (id: string, channels: Array<{ id: string; label: string }>) => {
      commands[id] = join(tempDir, `${id}-commands.jsonl`);
      writeFileSync(commands[id]!, '');
      return {
        id,
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, `${id}-status.jsonl`), COMMAND_PATH: commands[id]!, CHANNELS: JSON.stringify(channels) },
      };
    };
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      // Only addressed channel messages wake, batched: one turn per test step.
      gate: {
        config: {
          policies: [{ name: 'addressed', match: { scope: ['mcpl:channel-incoming'], tagsAny: ['chat:addressed'] }, behavior: { debounce: 200 } }],
          default: 'skip',
        },
      },
      mcplServers: [
        // Discord-shaped: composite ids, two guilds with the same channel name.
        server('discord', [
          { id: ROOM, label: '#room (Guild One)' },
          { id: GENERAL_1, label: '#general' },
          { id: GENERAL_2, label: '#general' },
        ]),
        // Zulip-shaped: one stream, conversations are topics inside it.
        server('zulip', [{ id: STREAM, label: 'stream design' }]),
      ],
      modules: [new ConsoleModule()],
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 4, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (server: string, c: Record<string, unknown>): void => appendFileSync(commands[server]!, JSON.stringify(c) + '\n');
  const stored = () => framework.getAgent('scout')!.getContextManager().getAllMessages();
  const blocksOf = (pred: (meta: Record<string, unknown>) => boolean): string[] | undefined => {
    const message = stored().find((m) => pred((m.metadata ?? {}) as Record<string, unknown>));
    return message?.content.map((b) => (b as { text?: string }).text ?? `<${b.type}>`);
  };
  const byMessageId = (id: string) => (meta: Record<string, unknown>) => meta.messageId === id;

  it('stamps every channel message with its own header: consecutive, interleaved, and same-named channels in two guilds', async () => {
    command('discord', { op: 'incoming', channelId: ROOM, messageId: 'm-1', mode: 'ambient', text: 'first' });
    command('discord', { op: 'incoming', channelId: ROOM, messageId: 'm-2', mode: 'ambient', text: 'second' });
    command('discord', { op: 'incoming', channelId: GENERAL_1, messageId: 'm-3', mode: 'ambient', text: 'over in guild one' });
    command('discord', { op: 'incoming', channelId: GENERAL_2, messageId: 'm-4', mode: 'ambient', text: 'over in guild two' });
    command('discord', { op: 'incoming', channelId: ROOM, messageId: 'm-5', mode: 'ambient', text: 'back in the room' });
    await waitFor(() => !!blocksOf(byMessageId('m-5')), 'messages stored');

    assert.deepEqual(blocksOf(byMessageId('m-1')), ['[source: discord / discord:g1:room · #room (Guild One)]', 'first']);
    assert.deepEqual(blocksOf(byMessageId('m-2')), ['[source: discord / discord:g1:room · #room (Guild One)]', 'second'],
      'the second of two consecutive messages names its channel too');
    assert.deepEqual(blocksOf(byMessageId('m-3')), ['[source: discord / discord:g1:general · #general]', 'over in guild one']);
    assert.deepEqual(blocksOf(byMessageId('m-4')), ['[source: discord / discord:g2:general · #general]', 'over in guild two'],
      'the canonical id keeps same-named channels apart');
    assert.deepEqual(blocksOf(byMessageId('m-5')), ['[source: discord / discord:g1:room · #room (Guild One)]', 'back in the room']);
  });

  it('an unlike adapter: a topic inside a stream and the reply edge ride the header', async () => {
    command('zulip', {
      op: 'incoming', channelId: STREAM, messageId: 'z-1', mode: 'ambient', text: 'on the topic',
      threadId: 'topic-a', metadata: { replyTo: 'z-0' },
    });
    command('zulip', { op: 'incoming', channelId: STREAM, messageId: 'z-2', mode: 'ambient', text: 'other topic', threadId: 'topic-b' });
    await waitFor(() => !!blocksOf(byMessageId('z-2')), 'messages stored');
    assert.deepEqual(blocksOf(byMessageId('z-1')),
      ['[source: zulip / zulip:stream:7 · stream design · thread topic-a · reply to z-0]', 'on the topic']);
    assert.deepEqual(blocksOf(byMessageId('z-2')), ['[source: zulip / zulip:stream:7 · stream design · thread topic-b]', 'other topic']);
  });

  it('a DM push names its derived channel, an unscoped push says so, and console input has no header', async () => {
    command('discord', { op: 'dm', eventId: 'ev-dm', authorId: '134', authorName: 'antra', rawChannelId: RAW_DM, text: 'psst' });
    command('discord', { op: 'push', eventId: 'tick-1', origin: { source: 'timer' }, text: 'tick' });
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'hi there', metadata: {} } as ProcessEvent);
    await waitFor(() => !!blocksOf((m) => m.eventId === 'tick-1') && !!blocksOf((m) => m.eventId === 'ev-dm')
      && stored().some((m) => m.participant === 'Operator'), 'all stored');

    const dm = blocksOf((m) => m.eventId === 'ev-dm')!;
    assert.equal(dm[0], `[source: discord / discord:dm:${RAW_DM} · DM: antra]`);
    assert.ok(dm.includes('psst'));
    assert.deepEqual(blocksOf((m) => m.eventId === 'tick-1'), ['[source: discord · unscoped]', 'tick']);
    const operator = stored().find((m) => m.participant === 'Operator')!;
    assert.deepEqual(operator.content.map((b) => (b as { text?: string }).text), ['hi there']);
  });

  it('a rename after ingestion leaves stored headers alone; later messages carry the new label', async () => {
    command('discord', { op: 'incoming', channelId: ROOM, messageId: 'm-6', mode: 'ambient', text: 'before' });
    await waitFor(() => !!blocksOf(byMessageId('m-6')), 'first stored');
    command('discord', { op: 'rename', channelId: ROOM, label: '#lobby (Guild One)' });
    command('discord', { op: 'incoming', channelId: ROOM, messageId: 'm-7', mode: 'ambient', text: 'after' });
    await waitFor(() => !!blocksOf(byMessageId('m-7')), 'second stored');
    assert.equal(blocksOf(byMessageId('m-6'))![0], '[source: discord / discord:g1:room · #room (Guild One)]');
    assert.equal(blocksOf(byMessageId('m-7'))![0], '[source: discord / discord:g1:room · #lobby (Guild One)]');
    // The stored header is the envelope's, not re-derived from the registry.
    const source = readInboundSource(stored().find((m) => m.metadata?.messageId === 'm-6')!.metadata);
    assert.equal(source?.kind === 'channel' && source.label, '#room (Guild One)');
  });

  it('the model sees each header on the wire, and is told once what they mean', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    command('discord', { op: 'incoming', channelId: GENERAL_1, messageId: 'm-8', mode: 'addressed', text: '@scout from guild one' });
    command('discord', { op: 'incoming', channelId: GENERAL_2, messageId: 'm-9', mode: 'ambient', text: 'from guild two' });
    await waitFor(() => membrane.calls.length >= 1, 'a turn ran');
    await framework.runUntilIdle();
    const wire = JSON.stringify((membrane.calls.at(-1) as { messages?: unknown }).messages);
    assert.ok(wire.includes('[source: discord / discord:g1:general · #general]'));
    assert.ok(wire.includes('[source: discord / discord:g2:general · #general]'));

    const notices = () => stored().filter((m) => m.metadata?.kind === 'source-header-notice');
    assert.equal(notices().length, 1);
    const notice = (notices()[0]!.content[0] as { text: string }).text;
    assert.ok(notice.includes(SOURCE_HEADER_RULE), 'the notice states the authority rule');

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'again' }]));
    command('discord', { op: 'incoming', channelId: ROOM, messageId: 'm-10', mode: 'addressed', text: '@scout once more' });
    await waitFor(() => membrane.calls.length >= 2, 'a second turn ran');
    await framework.runUntilIdle();
    assert.equal(notices().length, 1, 'explained once');

    const tools = (framework as unknown as { channelRegistry: { getChannelTools(): Array<{ name: string; description: string }> } })
      .channelRegistry.getChannelTools();
    for (const name of ['channel_list', 'channel_open', 'channel_publish']) {
      assert.ok(tools.find((t) => t.name === name)?.description.includes(SOURCE_HEADER_RULE), `${name} states the rule`);
    }
  });

  it('backscroll: each history item carries its own header, from its own channel', async () => {
    command('discord', {
      op: 'history',
      channelId: ROOM,
      history: [
        { channelId: ROOM, messageId: 'h-1', author: { id: 'u1', name: 'ann' }, timestamp: '2026-10-07T00:00:01Z',
          content: [{ type: 'text', text: 'earlier' }], metadata: { replyTo: 'h-0' } },
        // A spliced item from another channel wears its true channel.
        { channelId: GENERAL_2, messageId: 'h-2', author: { id: 'u2', name: 'bo' }, timestamp: '2026-10-07T00:00:02Z',
          content: [{ type: 'text', text: 'spliced' }] },
        // A channel the host never registered: the adapter's own label.
        { channelId: 'discord:g9:elsewhere', channelLabel: '#elsewhere (Guild Nine)', messageId: 'h-3',
          author: { id: 'u3', name: 'cy' }, timestamp: '2026-10-07T00:00:03Z', content: [{ type: 'text', text: 'far' }] },
      ],
    });
    await new Promise((r) => setTimeout(r, 100)); // the fixture polls its command file
    const registry = (framework as unknown as {
      channelRegistry: { handleChannelToolCall(name: string, input: unknown, origin?: unknown): Promise<ToolResult> };
    }).channelRegistry;
    const result = await registry.handleChannelToolCall('channel_open', { channelId: ROOM, backscroll: 3 }, { kind: 'agent', agentName: 'scout' });
    assert.equal(result.success, true);
    const history = (result.data as { history: Array<{ source?: string; messageId: string; content: unknown }> }).history;
    assert.deepEqual(history.map((h) => [h.messageId, h.source]), [
      ['h-1', '[source: discord / discord:g1:room · #room (Guild One) · reply to h-0]'],
      ['h-2', '[source: discord / discord:g2:general · #general]'],
      ['h-3', '[source: discord / discord:g9:elsewhere · #elsewhere (Guild Nine)]'],
    ]);
    assert.deepEqual(history[0]!.content, [{ type: 'text', text: 'earlier' }], 'the item body is unchanged');
  });

  it('backscroll headers reach the model in the channel_open tool result', async () => {
    command('discord', {
      op: 'history',
      channelId: GENERAL_1,
      history: [
        { channelId: GENERAL_1, messageId: 'h-9', author: { id: 'u1', name: 'ann' }, timestamp: '2026-10-07T00:00:01Z',
          content: [{ type: 'text', text: 'what you missed' }] },
      ],
    });
    await new Promise((r) => setTimeout(r, 100));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'open-1', name: 'channel_open', input: { channelId: GENERAL_1, backscroll: 1 } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'caught up' }]));
    command('discord', { op: 'incoming', channelId: ROOM, messageId: 'm-11', mode: 'addressed', text: '@scout catch up on general' });
    await waitFor(() => (membrane.lastStream?.receivedToolResults.flat().length ?? 0) >= 1, 'the tool result went back to the model', 20_000);
    await framework.runUntilIdle();
    const results = JSON.stringify(membrane.lastStream!.receivedToolResults.flat());
    assert.ok(results.includes('[source: discord / discord:g1:general · #general]'), results.slice(0, 400));
    assert.ok(results.includes('what you missed'));
  });
});

test('coalesced corrections carry their own header, on the wire', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  await f.send('channels/incoming', { messages: [f.channel('c', 'original_words', { initial: true })] });
  await f.turn(); // read: the original is consumed
  const edit = await f.send('channels/incoming', { messages: [f.channel('e', 'corrected_words')] });
  assert.equal(edit.result.results[0].coalesce.outcome, 'appended');
  const stored = f.framework.getAgent('agent')!.getContextManager().getAllMessages();
  const original = stored.find((m) => m.metadata?.eventId === 'c')!;
  const correction = stored.find((m) => m.metadata?.eventId === 'e')!;
  const header = (original.content[0] as { text: string }).text;
  assert.match(header, /^\[source: \S+ \/ chat · chat\]$/);
  assert.equal((correction.content[0] as { text: string }).text, header, 'the correction names the same conversation');
  await f.turn();
  assert.ok(f.lastRequest().includes('corrected_words'));
  assert.ok(f.lastRequest().includes(header), 'the model reads the correction with its header');
});
