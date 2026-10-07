/**
 * The inbound source envelope (src/mcpl/inbound-source.ts), end to end over a
 * real MCPL child: every accepted item is stamped once, at the framework's
 * ingestion boundary, with the conversation it came from. Both MCPL lanes
 * (channels/incoming and push/event), unscoped pushes, and console input
 * from a module are covered; an adapter cannot supply or spoof the stamp, and
 * an acceptance observer hears each acceptance exactly once.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentFramework,
  INBOUND_SOURCE_KEY,
  readInboundSource,
  conversationKey,
  type InboundSource,
  type Module,
  type ModuleContext,
  type ProcessEvent,
  type ProcessState,
  type EventResponse,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
} from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const RAW_DM = '1548000000000000001';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** A console surface: the module that turns external-message into context. */
class ConsoleModule implements Module {
  readonly name = 'console';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    return { addMessages: [{ participant: 'Operator', content: [{ type: 'text', text }] }] };
  }
}

describe('inbound source envelope', () => {
  let tempDir: string;
  let commandPath: string;
  let framework: AgentFramework;
  let observed: InboundSource[];
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'inbound-source-'));
    commandPath = join(tempDir, 'commands.jsonl');
    writeFileSync(commandPath, '');
    observed = [];
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [new ConsoleModule()],
    });
    (framework as unknown as { inboundAcceptanceObserver: unknown }).inboundAcceptanceObserver = {
      inboundAccepted: (source: InboundSource) => observed.push(source),
    };
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (c: Record<string, unknown>): void => appendFileSync(commandPath, JSON.stringify(c) + '\n');
  const stored = () => framework.getAgent('scout')!.getContextManager().getAllMessages();
  const storedWith = (pred: (m: Record<string, unknown>) => boolean) =>
    stored().find((m) => pred((m.metadata ?? {}) as Record<string, unknown>));

  it('stamps a channels/incoming message with its registered channel, label, reply edge and acceptance time', async () => {
    const before = Date.now();
    command({
      op: 'incoming', channelId: ROOM, messageId: 'm-1', mode: 'ambient', text: 'hello',
      timestamp: '2026-10-07T01:02:03.000Z',
      metadata: {
        replyTo: 'm-0',
        // An adapter cannot supply the framework's stamp.
        inboundSource: { kind: 'channel', serverId: 'evil', binding: 'x', channelId: 'discord:g9:elsewhere', acceptedAt: 1 },
      },
    });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-1'), 'message stored');
    const message = storedWith((m) => m.messageId === 'm-1')!;
    const source = readInboundSource(message.metadata);
    assert.ok(source && source.kind === 'channel');
    assert.equal(source.serverId, 'discord');
    assert.match(source.binding, /^[0-9a-f]{16}$/);
    assert.equal(source.channelId, ROOM);
    assert.equal(source.messageId, 'm-1');
    assert.equal(source.label, '#room (Guild One)');
    assert.equal(source.replyTo, 'm-0');
    assert.equal(source.sourceTimestamp, '2026-10-07T01:02:03.000Z');
    assert.ok(source.acceptedAt >= before && source.acceptedAt <= Date.now());
    assert.deepEqual(observed, [source], 'observed exactly once, with the stored envelope');
  });

  it('stamps a DM push with the derived composite channel and its people-first label', async () => {
    command({ op: 'dm', eventId: `ev-${++n}`, authorId: '134', authorName: 'antra', rawChannelId: RAW_DM, text: 'psst' });
    await waitFor(() => !!storedWith((m) => readInboundSource(m)?.kind === 'channel'), 'dm stored');
    const source = readInboundSource(storedWith((m) => readInboundSource(m)?.kind === 'channel')!.metadata);
    assert.ok(source && source.kind === 'channel');
    assert.equal(source.channelId, `discord:dm:${RAW_DM}`);
    assert.equal(source.label, 'DM: antra');
    assert.equal(source.messageId, `ev-${n}`);
    assert.equal(source.eventId, `ev-${n}`);
    // The adapter's own free-form origin.source stays where it was.
    assert.equal((storedWith((m) => m.eventId === `ev-${n}`)!.metadata as Record<string, unknown>).source, 'discord');
    assert.equal(observed.length, 1);
  });

  it('stamps a push that names no channel as unscoped, never a guessed channel', async () => {
    command({ op: 'push', eventId: 'tick-1', origin: { source: 'timer' }, text: 'tick' });
    await waitFor(() => !!storedWith((m) => m.eventId === 'tick-1'), 'push stored');
    const source = readInboundSource(storedWith((m) => m.eventId === 'tick-1')!.metadata);
    assert.ok(source && source.kind === 'unscoped');
    assert.equal(source.serverId, 'discord');
    assert.equal(source.eventId, 'tick-1');
    assert.equal(conversationKey(source), undefined);
  });

  it('stamps console input from a module as a surface conversation', async () => {
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'hi there', metadata: {} } as ProcessEvent);
    await waitFor(() => stored().some((m) => m.participant === 'Operator'), 'console message stored');
    const message = stored().find((m) => m.participant === 'Operator')!;
    const source = readInboundSource(message.metadata);
    assert.deepEqual(source && { kind: source.kind, surface: (source as { surface: string }).surface }, { kind: 'surface', surface: 'tui' });
    assert.equal(conversationKey(source!), 'surface\u0000tui');
    assert.equal(observed.length, 1);
  });

  it('keeps a stored envelope when the channel is renamed later', async () => {
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-2', mode: 'ambient', text: 'before rename' });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-2'), 'first message stored');
    command({ op: 'rename', channelId: ROOM, label: '#lobby (Guild One)' });
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-3', mode: 'ambient', text: 'after rename' });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-3'), 'second message stored');
    const first = readInboundSource(storedWith((m) => m.messageId === 'm-2')!.metadata);
    const second = readInboundSource(storedWith((m) => m.messageId === 'm-3')!.metadata);
    assert.equal(first?.kind === 'channel' && first.label, '#room (Guild One)');
    assert.equal(second?.kind === 'channel' && second.label, '#lobby (Guild One)');
  });

  it('delivers normally when the acceptance observer throws, and reports the failure', async () => {
    const traces: Array<Record<string, unknown>> = [];
    framework.onTrace((e) => { if (e.type === 'inbound:observer-failed') traces.push(e as unknown as Record<string, unknown>); });
    (framework as unknown as { inboundAcceptanceObserver: unknown }).inboundAcceptanceObserver = {
      inboundAccepted: () => { throw new Error('ledger down'); },
    };
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-4', mode: 'ambient', text: 'still here' });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-4'), 'message stored despite observer');
    assert.equal(traces.length, 1);
    assert.equal(traces[0]!.kind, 'channel');
    assert.equal(traces[0]!.error, 'ledger down');
  });
});

describe('readInboundSource', () => {
  it('reads only well-formed framework stamps', () => {
    const channel = { kind: 'channel', serverId: 's', binding: 'b', channelId: 'c', acceptedAt: 1 };
    assert.deepEqual(readInboundSource({ [INBOUND_SOURCE_KEY]: channel }), channel);
    assert.equal(readInboundSource({ [INBOUND_SOURCE_KEY]: { ...channel, acceptedAt: 'soon' } }), undefined);
    assert.equal(readInboundSource({ [INBOUND_SOURCE_KEY]: { ...channel, channelId: '' } }), undefined);
    assert.equal(readInboundSource({ [INBOUND_SOURCE_KEY]: { kind: 'mystery', acceptedAt: 1 } }), undefined);
    assert.equal(readInboundSource({ source: 'discord' }), undefined);
    assert.equal(readInboundSource(undefined), undefined);
  });

  it('keys conversations by server, channel and thread', () => {
    const base = { kind: 'channel' as const, serverId: 's', binding: 'b', channelId: 'c', acceptedAt: 1 };
    assert.notEqual(conversationKey(base), conversationKey({ ...base, serverId: 't' }));
    assert.notEqual(conversationKey(base), conversationKey({ ...base, threadId: 'th' }));
    assert.equal(conversationKey(base), conversationKey({ ...base, messageId: 'other', acceptedAt: 2 }));
  });
});

describe('inbound source envelope under RFC-006 coalescing', () => {
  const install = (framework: AgentFramework): InboundSource[] => {
    const observed: InboundSource[] = [];
    (framework as unknown as { inboundAcceptanceObserver: unknown }).inboundAcceptanceObserver = {
      inboundAccepted: (source: InboundSource) => observed.push(source),
    };
    return observed;
  };
  const sourceOf = (f: Awaited<ReturnType<typeof fixture>>, text: string): InboundSource | undefined => {
    const message = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
      .find((m) => JSON.stringify(m.content).includes(text));
    return message ? readInboundSource(message.metadata) : undefined;
  };

  it('observes each acceptance once; a replacement carries its own frozen envelope and a retry is not an acceptance', async (t) => {
    const f = await fixture(); t.after(f.close);
    const observed = install(f.framework);
    await f.send('push/event', f.params('1', 'edit_original', { initial: true }));
    await f.send('push/event', f.params('2', 'edit_latest'));
    await f.send('push/event', f.params('2', 'edit_latest'));
    assert.deepEqual(observed.map((s) => (s as { eventId?: string }).eventId), ['1', '2']);
    const stored = sourceOf(f, 'edit_latest');
    assert.ok(stored && stored.kind === 'unscoped');
    assert.deepEqual(stored, observed[1], 'the delivered copy carries the envelope frozen at its acceptance');
  });

  it('observes deferred work at acceptance, before any render; its rendered delivery keeps that envelope and adds materialized', async (t) => {
    const f = await fixture(); t.after(f.close);
    const observed = install(f.framework);
    await f.send('push/event', f.params('1', 'fallback_unavailable', { deferred: true }));
    assert.equal(observed.length, 1, 'observed at acceptance, nothing rendered yet');
    assert.equal(f.renders.length, 0);
    const accepted = observed[0]!;
    assert.equal((accepted as { deferred?: boolean }).deferred, true);
    await f.framework.runUntilIdle();
    assert.equal(f.renders.length, 1);
    assert.equal(observed.length, 1, 'materialization is not a second acceptance');
    const stored = sourceOf(f, 'document_diff');
    assert.deepEqual(stored, { ...accepted, materialized: true });
  });

  it('a channel-scoped coalesced message belongs to its channel, frozen at acceptance', async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.register('chat');
    const observed = install(f.framework);
    await f.send('channels/incoming', { messages: [f.channel('e1', 'first_words')] });
    await eventually(() => !!sourceOf(f, 'first_words'), 'coalesced message stored');
    const stored = sourceOf(f, 'first_words');
    assert.ok(stored && stored.kind === 'channel');
    assert.equal(stored.channelId, 'chat');
    assert.equal(stored.messageId, 'm');
    assert.equal(stored.eventId, 'e1');
    assert.equal(stored.sourceTimestamp, TS);
    assert.deepEqual(observed, [stored]);
  });
});
