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
  // The package's public digest: consumers import it from the root.
  sourceBodyDigest,
  PassthroughStrategy,
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
import { ContextManager } from '@animalabs/context-manager';
import { MockMembrane } from './helpers/mock-membrane.js';
import { canonicalJson } from '../src/mcpl/inbound-source.js';
import { createHash } from 'node:crypto';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const RAW_DM = '1548000000000000001';
/** Bytes that open with PNG's signature, which is all the store reads of an
 *  image. 14 bytes, so their base64 is padded and has a '/' in it. */
const PNG = Buffer.from('89504e470d0a1a0afbefbeffffff', 'hex');

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
    assert.equal(source.lane, 'channels/incoming');
    assert.equal(source.coalesced, undefined);
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

  it('stamps the delivered body\'s digest and the stored copy\'s digest at ingestion', async () => {
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-d1', mode: 'ambient', text: 'digest me' });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-d1'), 'message stored');
    const message = storedWith((m) => m.messageId === 'm-d1')!;
    const meta = message.metadata as Record<string, unknown>;
    // The unsharded framing receipts already hash: canonicalJson([blocks]).
    const expected = createHash('sha256').update(canonicalJson([[{ type: 'text', text: 'digest me' }]])).digest('hex');
    assert.equal(meta.sourceBodyDigest, expected);
    assert.equal(sourceBodyDigest([{ text: 'digest me', type: 'text' }]), expected, 'key order does not matter');
    // This lane stores the body as delivered: the stored copy hashes the same.
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content));
    assert.equal(meta.storedBodyDigest, meta.sourceBodyDigest);
    // Outside the frozen admission envelope.
    assert.equal((readInboundSource(message.metadata) as unknown as Record<string, unknown>).sourceBodyDigest, undefined);

    // An edit through the supported path keeps the metadata, so only the
    // stored digest can reveal that the copy no longer holds the delivery.
    const cm = framework.getAgent('scout')!.getContextManager();
    cm.editMessage(message.id, [{ type: 'text', text: 'edited later' }]);
    const edited = cm.getAllMessages().find((m) => m.id === message.id)!;
    assert.equal((edited.metadata as Record<string, unknown>).storedBodyDigest, meta.storedBodyDigest);
    assert.notEqual(sourceBodyDigest(edited.content), meta.storedBodyDigest);
  });

  it('a message accepted while its channel was open but stored after it closed: the stored digest covers the invitation', async () => {
    // Tessa-974's discriminator (room-220 #48282): the invitation is
    // appended after ingestion stamped the delivered digest, at storage
    // time, when the channel has closed in between.
    const registry = (framework as unknown as {
      channelRegistry: { handleChannelToolCall(name: string, input: unknown, caller: unknown): Promise<unknown>; isChannelOpen(id: string): boolean };
    }).channelRegistry;
    const fw = framework as unknown as { pushEvent(e: { type: string }): void };
    const held: Array<{ type: string }> = [];
    const push = fw.pushEvent.bind(framework);
    fw.pushEvent = (e) => { if (e.type === 'mcpl:channel-incoming') held.push(e); else push(e); };
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-closed', mode: 'addressed', text: 'hello while open' });
    await waitFor(() => held.length > 0, 'incoming accepted and held');
    await registry.handleChannelToolCall('channel_close', { channelId: ROOM }, { kind: 'agent', agentName: 'scout' });
    assert.equal(registry.isChannelOpen(ROOM), false);
    fw.pushEvent = push;
    for (const e of held) push(e);
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-closed'), 'message stored');
    const message = storedWith((m) => m.messageId === 'm-closed')!;
    const meta = message.metadata as Record<string, unknown>;
    assert.equal(meta.channelInvitation, true, 'stored with the closed-channel invitation');
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content), 'the untouched copy matches its own witness');
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'hello while open' }]), 'the delivered body alone');
  });

  it('on the push lane, the delivered digest excludes host decoration and the stored digest covers it', async () => {
    command({ op: 'dm', eventId: 'ev-dig', authorId: '134', authorName: 'antra', rawChannelId: RAW_DM, text: 'psst' });
    await waitFor(() => !!storedWith((m) => m.eventId === 'ev-dig'), 'dm stored');
    const message = storedWith((m) => m.eventId === 'ev-dig')!;
    const meta = message.metadata as Record<string, unknown>;
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'psst' }]), 'the adapter body alone');
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content), 'exactly what was stored');
    // The DM's channel is closed, so the host appends its invitation.
    assert.equal(message.content.length, 2);
    assert.notEqual(meta.storedBodyDigest, meta.sourceBodyDigest, 'the closed-channel invitation decorates the stored copy');
  });

  it('a visibly-empty ordinary push is refused and stores nothing; an accepted push carries the host\'s digests, never the adapter\'s', async () => {
    // Admission (main #236): content with nothing visible is refused with
    // -32602 unless it is the exact silent-heartbeat marker or an RFC-006
    // retraction, so it never reaches storage and has no witnesses. Every
    // push that is accepted is stored with the host's own digests, written
    // over whatever its origin claimed.
    const forged = { sourceBodyDigest: 'adapter-value', storedBodyDigest: 'adapter-value' };
    command({ op: 'push', eventId: 'empty-1', content: [], origin: { source: 'timer', ...forged } });
    command({ op: 'push', eventId: 'full-1', text: 'tick', origin: { source: 'timer', ...forged } });
    await waitFor(() => !!storedWith((m) => m.eventId === 'full-1'), 'accepted push stored');
    assert.equal(storedWith((m) => m.eventId === 'empty-1'), undefined, 'the empty push was refused at admission, before the next was handled');
    const message = storedWith((m) => m.eventId === 'full-1')!;
    const meta = message.metadata as Record<string, unknown>;
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'tick' }]), 'the delivered body, not the adapter\'s value');
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content), 'exactly what was stored, not the adapter\'s value');
  });

  it('a DM pushed into a closed channel carries the host\'s digests, never the adapter\'s: the delivered body, and the stored copy with its invitation', async () => {
    command({
      op: 'dm', eventId: 'ev-forged', authorId: '134', authorName: 'antra', rawChannelId: RAW_DM, text: 'psst again',
      origin: { sourceBodyDigest: 'adapter-value', storedBodyDigest: 'adapter-value' },
    });
    await waitFor(() => !!storedWith((m) => m.eventId === 'ev-forged'), 'dm stored');
    const message = storedWith((m) => m.eventId === 'ev-forged')!;
    const meta = message.metadata as Record<string, unknown>;
    assert.equal(meta.channelInvitation, true, 'stored with the closed-channel invitation');
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'psst again' }]), 'the delivered body, not the adapter\'s value');
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content), 'exactly what was stored, not the adapter\'s value');
    assert.notEqual(meta.storedBodyDigest, meta.sourceBodyDigest, 'the invitation decorates the stored copy');
  });

  it('an image the store relabels or re-encodes still matches both its digests once read back', async () => {
    // slimepriestess's review of #252: the store takes an image's media type
    // from its bytes and re-encodes its base64, so a digest of the blocks as
    // handed to storage failed against the untouched copy read back.
    const png = PNG.toString('base64');
    const pushes: Record<string, { type: 'image'; data: string; mimeType: string }> = {
      'img-labeled': { type: 'image', data: png, mimeType: 'image/png' },
      'img-mislabeled': { type: 'image', data: png, mimeType: 'image/jpeg' },
      'img-wrapped': { type: 'image', data: `${png.slice(0, 11)}\n${png.slice(11)}`, mimeType: 'image/png' },
    };
    for (const [eventId, block] of Object.entries(pushes)) command({ op: 'push', eventId, content: [block] });
    await waitFor(() => Object.keys(pushes).every((id) => !!storedWith((m) => m.eventId === id)), 'images stored');
    for (const eventId of Object.keys(pushes)) {
      const message = storedWith((m) => m.eventId === eventId)!;
      const meta = message.metadata as Record<string, unknown>;
      const image = message.content.find((b) => b.type === 'image');
      assert.deepEqual(image, { type: 'image', source: { type: 'base64', data: png, mediaType: 'image/png' } },
        `${eventId}: stored as the bytes' own type, in canonical base64`);
      assert.equal(sourceBodyDigest(message.content), meta.storedBodyDigest, `${eventId}: the untouched copy matches its stored digest`);
      assert.equal(meta.sourceBodyDigest, sourceBodyDigest([image]), `${eventId}: the delivered body hashes as the image stored for it`);
    }
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

  /**
   * Hold MCPL events between admission and processing (the framework's
   * queue), so a test can change the world while an accepted item waits.
   */
  const holdQueue = () => {
    const held: ProcessEvent[] = [];
    const original = framework.pushEvent.bind(framework);
    (framework as unknown as { pushEvent: (e: ProcessEvent) => void }).pushEvent = (event: ProcessEvent) => {
      if (event.type === 'mcpl:channel-incoming' || event.type === 'mcpl:push-event') held.push(event);
      else original(event);
    };
    return {
      held,
      release: () => {
        (framework as unknown as { pushEvent: (e: ProcessEvent) => void }).pushEvent = original;
        for (const event of held.splice(0)) original(event);
      },
    };
  };
  const registryLabel = (channelId: string) =>
    (framework as unknown as { channelRegistry: { getChannelLabel(s: string, c: string): string | undefined } })
      .channelRegistry.getChannelLabel('discord', channelId);

  it('freezes an ordinary channels/incoming envelope at admission: observed before queueing, and a rename while queued does not change it', async () => {
    const queue = holdQueue();
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-10', mode: 'ambient', text: 'queued words' });
    await waitFor(() => queue.held.length === 1, 'message admitted and held in the queue');
    assert.equal(observed.length, 1, 'observed at admission, before processing');
    assert.equal(observed[0]!.kind === 'channel' && observed[0]!.label, '#room (Guild One)');
    assert.equal(observed[0]!.kind === 'channel' && observed[0]!.lane, 'channels/incoming');
    command({ op: 'rename', channelId: ROOM, label: '#lobby (Guild One)' });
    await waitFor(() => registryLabel(ROOM) === '#lobby (Guild One)', 'rename applied');
    queue.release();
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-10'), 'message stored');
    assert.deepEqual(readInboundSource(storedWith((m) => m.messageId === 'm-10')!.metadata), observed[0]);
    assert.equal(observed.length, 1, 'processing is not a second acceptance');
  });

  it('freezes an ordinary push envelope at admission: a rename while queued does not change it', async () => {
    const queue = holdQueue();
    command({
      op: 'push', eventId: 'ev-room', text: 'pushed into the room',
      origin: { source: 'discord', mcplChannelId: ROOM, messageId: 'pm-1', authorName: 'someone' },
      tags: ['chat:mention', 'chat:addressed'],
    });
    await waitFor(() => queue.held.length === 1, 'push admitted and held in the queue');
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.kind === 'channel' && observed[0]!.lane, 'push/event');
    assert.equal(observed[0]!.kind === 'channel' && observed[0]!.label, '#room (Guild One)');
    command({ op: 'rename', channelId: ROOM, label: '#lobby (Guild One)' });
    await waitFor(() => registryLabel(ROOM) === '#lobby (Guild One)', 'rename applied');
    queue.release();
    await waitFor(() => !!storedWith((m) => m.eventId === 'ev-room'), 'push stored');
    assert.deepEqual(readInboundSource(storedWith((m) => m.eventId === 'ev-room')!.metadata), observed[0]);
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
  const channel = { kind: 'channel', lane: 'channels/incoming', serverId: 's', binding: 'b', channelId: 'c', acceptedAt: 1 };
  const read = (value: unknown) => readInboundSource({ [INBOUND_SOURCE_KEY]: value });

  it('reads only well-formed framework stamps', () => {
    assert.deepEqual(read(channel), channel);
    assert.deepEqual(read({ ...channel, coalesced: true, deferred: true, materialized: true, eventId: 'e', label: '#c' }),
      { ...channel, coalesced: true, deferred: true, materialized: true, eventId: 'e', label: '#c' });
    assert.deepEqual(read({ kind: 'unscoped', lane: 'push/event', serverId: 's', binding: 'b', acceptedAt: 1 }),
      { kind: 'unscoped', lane: 'push/event', serverId: 's', binding: 'b', acceptedAt: 1 });
    assert.equal(readInboundSource({ source: 'discord' }), undefined);
    assert.equal(readInboundSource(undefined), undefined);
  });

  it('refuses a stamp with any field its consumers rely on malformed', () => {
    for (const bad of [
      { ...channel, acceptedAt: 'soon' },
      { ...channel, acceptedAt: Number.POSITIVE_INFINITY },
      { ...channel, acceptedAt: Number.NaN },
      { ...channel, channelId: '' },
      { ...channel, lane: 'carrier-pigeon' },
      { ...channel, lane: undefined },
      { ...channel, deferred: false },
      { ...channel, materialized: 'yes' },
      { ...channel, coalesced: 1 },
      { ...channel, messageId: 42 },
      { ...channel, label: '' },
      { ...channel, sourceTimestamp: {} },
      { kind: 'unscoped', lane: 'channels/incoming', serverId: 's', binding: 'b', acceptedAt: 1 },
      { kind: 'surface', surface: '', acceptedAt: 1 },
      { kind: 'mystery', acceptedAt: 1 },
      [channel],
    ]) {
      assert.equal(read(bad), undefined, JSON.stringify(bad));
    }
  });

  it('keys conversations by server, channel and thread', () => {
    const base = { kind: 'channel' as const, lane: 'channels/incoming' as const, serverId: 's', binding: 'b', channelId: 'c', acceptedAt: 1 };
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
    assert.equal(stored.lane, 'push/event');
    assert.equal(stored.coalesced, true);
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
    assert.equal(stored.lane, 'channels/incoming');
    assert.equal(stored.coalesced, true);
    assert.equal(stored.messageId, 'm');
    assert.equal(stored.eventId, 'e1');
    assert.equal(stored.sourceTimestamp, TS);
    assert.deepEqual(observed, [stored]);
  });
});

describe('sourceBodyDigest hashes a body as the store keeps it', () => {
  // Every agent stores through context-manager over chronicle. Whatever the
  // store changes on the way in (an image's label, base64's spelling, fields
  // it doesn't keep, a lone surrogate), the body read back must hash as it
  // did when it was handed over, live and after the store is reopened.
  const png = PNG.toString('base64');
  const image = (data: string, mediaType = 'image/png', extra: Record<string, unknown> = {}) =>
    ({ type: 'image', source: { type: 'base64', data, mediaType }, ...extra });
  const media = (type: string, data: string, mediaType: string, extra: Record<string, unknown> = {}) =>
    ({ type, source: { type: 'base64', data, mediaType }, ...extra });
  /** Each body, and whether the store hands it back changed. */
  const bodies: Record<string, { blocks: unknown[]; changed: boolean }> = {
    'a labeled image': { blocks: [image(png)], changed: false },
    'PNG bytes labeled image/jpeg': { blocks: [image(png, 'image/jpeg')], changed: true },
    'JPEG bytes labeled image/png': { blocks: [image(Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64'))], changed: true },
    'base64 with a newline in it': { blocks: [image(`${png.slice(0, 11)}\n${png.slice(11)}`)], changed: true },
    'base64 with whitespace around it': { blocks: [image(`  ${png}\n`)], changed: true },
    'base64 without its padding': { blocks: [image(png.replace(/=+$/, ''))], changed: true },
    'base64 with non-zero unused bits': { blocks: [image(png.replace(/8=$/, '9='))], changed: true },
    'base64 in the URL-safe alphabet': { blocks: [image(png.replace(/\//g, '_'))], changed: true },
    // Bytes the store has no signature for keep their label. Labeled
    // image/png, so a context-manager that learns to sniff one fails here.
    'SVG bytes labeled image/png': { blocks: [image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'))], changed: false },
    'BMP bytes labeled image/png': { blocks: [image(Buffer.from('424d3a0000000000000036000000', 'hex').toString('base64'))], changed: false },
    'AVIF bytes labeled image/png': { blocks: [image(Buffer.from('0000001c6674797061766966000000006d696631', 'hex').toString('base64'))], changed: false },
    'an image whose source is neither base64 nor a URL': { blocks: [{ type: 'image', source: { type: 'file', data: png, mediaType: 'image/png' } }], changed: true },
    'an image with fields the store drops': { blocks: [image(png, 'image/png', { sourceUrl: 'https://cdn.example/a.png', tokenEstimate: 85 })], changed: true },
    'an image by URL, its fields kept': { blocks: [{ type: 'image', source: { type: 'url', url: 'https://cdn.example/a.png' }, sourceUrl: 'https://cdn.example/a.png' }], changed: false },
    'audio, wrapped, with a duration': { blocks: [media('audio', 'SUQz\nAwAAAAAA', 'audio/mpeg', { duration: 3 })], changed: true },
    'a document with a filename': { blocks: [media('document', 'JVBERi0xLjQ=', 'application/pdf', { filename: 'a.pdf' })], changed: true },
    'text with lone surrogates': { blocks: [{ type: 'text', text: 'cut \ud83d here, \ude00 there, \ud83d\ud83d twice' }], changed: true },
    'a key that is not well-formed': { blocks: [{ type: 'text', text: 'x', rawItem: { 'k\ud800': 1, kept: 2 } }], changed: true },
    'a relabeled image with a text decoration': { blocks: [image(png, 'image/jpeg'), { type: 'text', text: '[invitation]' }], changed: true },
  };

  it('every body hashes alike as handed to the store and as read back, live and after reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stored-digest-'));
    const path = join(dir, 'store.chronicle');
    try {
      const strategy = () => new PassthroughStrategy();
      const ids = new Map<string, string>();
      let cm = await ContextManager.open({ path, strategy: strategy() });
      for (const [name, { blocks }] of Object.entries(bodies)) {
        ids.set(name, cm.addMessage('user', blocks as never, { storedBodyDigest: sourceBodyDigest(blocks) }));
      }
      const check = (when: string) => {
        for (const [name, { blocks, changed }] of Object.entries(bodies)) {
          const back = cm.getMessage(ids.get(name)!)!;
          if (changed) assert.notDeepEqual(back.content, blocks, `${when}, ${name}: the store hands it back changed`);
          else assert.deepEqual(back.content, blocks, `${when}, ${name}: the store hands it back as it was`);
          assert.equal(sourceBodyDigest(back.content), (back.metadata as Record<string, unknown>).storedBodyDigest, `${when}, ${name}: it still hashes as handed over`);
        }
      };
      check('live');
      cm.close();
      cm = await ContextManager.open({ path, strategy: strategy() });
      check('reopened');
      cm.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('what the store keeps still changes the digest', () => {
    const digest = (blocks: unknown[]) => sourceBodyDigest(blocks);
    assert.notEqual(digest([image(png)]), digest([image(Buffer.from([...PNG, 0]).toString('base64'))]), 'other bytes');
    const svg = Buffer.from('<svg/>').toString('base64');
    assert.notEqual(digest([image(svg, 'image/svg+xml')]), digest([image(svg, 'image/png')]), 'a label the store keeps');
    assert.notEqual(digest([media('audio', 'SUQzAwAAAAAA', 'audio/mpeg')]), digest([media('audio', 'SUQzAwAAAAAA', 'audio/wav')]), 'an audio label');
    assert.notEqual(digest([{ type: 'text', text: 'a' }]), digest([{ type: 'text', text: 'b' }]), 'other text');
    assert.equal(digest([image(png, 'image/jpeg')]), digest([image(png)]), 'a label the store replaces is not part of the body');
  });
});
