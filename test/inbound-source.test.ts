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
  type ChannelRef,
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
import { ContextManager, MalformedContentError, blockAsStored } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
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
    // A module that relays an event's metadata as it came, envelope and all.
    if ((event as { type: string }).type === 'relay') {
      const relayed = event as unknown as { content: string; metadata: Record<string, unknown> };
      return { addMessages: [{ participant: 'Relay', content: [{ type: 'text', text: relayed.content }], metadata: relayed.metadata }] };
    }
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
    return { addMessages: [{ participant: 'Operator', content: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) }] };
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
  /** The agent closes ROOM, so an addressed push from it comes with the closed-channel invitation. */
  const closeRoom = async (): Promise<void> => {
    const registry = (framework as unknown as {
      channelRegistry: { handleChannelToolCall(name: string, input: unknown, caller: unknown): Promise<{ success: boolean }>; isChannelOpen(channel: ChannelRef): boolean };
    }).channelRegistry;
    assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: ROOM }, { kind: 'agent', agentName: 'scout' })).success, true);
    assert.equal(registry.isChannelOpen({ serverId: 'discord', channelId: ROOM }), false);
  };

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
    assert.ok(typeof source.binding === 'string' && source.binding.length > 0, 'an endpoint binding, opaque');
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
    assert.equal(conversationKey(source!), '["surface","tui"]');
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
    // The stored digest is of the stored copy. On this branch the copy
    // carries the author as the agent reads them (presentAuthor), so it
    // hashes the same as the delivered body exactly when presenting the
    // author changed nothing.
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content));
    assert.equal(meta.storedBodyDigest === meta.sourceBodyDigest, sourceBodyDigest(message.content) === meta.sourceBodyDigest);
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
      channelRegistry: { handleChannelToolCall(name: string, input: unknown, caller: unknown): Promise<unknown>; isChannelOpen(channel: ChannelRef): boolean };
    }).channelRegistry;
    const fw = framework as unknown as { pushEvent(e: { type: string }): void };
    const held: Array<{ type: string }> = [];
    const push = fw.pushEvent.bind(framework);
    fw.pushEvent = (e) => { if (e.type === 'mcpl:channel-incoming') held.push(e); else push(e); };
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-closed', mode: 'addressed', text: 'hello while open' });
    await waitFor(() => held.length > 0, 'incoming accepted and held');
    await registry.handleChannelToolCall('channel_close', { channelId: ROOM }, { kind: 'agent', agentName: 'scout' });
    assert.equal(registry.isChannelOpen({ serverId: 'discord', channelId: ROOM }), false);
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
    // A mention pushed from a channel the agent closed: the host appends its invitation.
    await closeRoom();
    command({
      op: 'push', eventId: 'ev-dig', text: 'psst',
      origin: { source: 'discord', mcplChannelId: ROOM, messageId: 'pm-dig', authorName: 'antra' },
      tags: ['chat:mention', 'chat:addressed'],
    });
    await waitFor(() => !!storedWith((m) => m.eventId === 'ev-dig'), 'push stored');
    const message = storedWith((m) => m.eventId === 'ev-dig')!;
    const meta = message.metadata as Record<string, unknown>;
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'psst' }]), 'the adapter body alone');
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content), 'exactly what was stored');
    assert.equal(message.content.length, 2);
    assert.notEqual(meta.storedBodyDigest, meta.sourceBodyDigest, 'the closed-channel invitation decorates the stored copy');
    // A DM's channel is closed too, but all of a DM reaches the agent, so
    // nothing decorates it and its two digests agree.
    command({ op: 'dm', eventId: 'ev-dm', authorId: '134', authorName: 'antra', rawChannelId: RAW_DM, text: 'psst' });
    await waitFor(() => !!storedWith((m) => m.eventId === 'ev-dm'), 'dm stored');
    const dm = storedWith((m) => m.eventId === 'ev-dm')!;
    const dmMeta = dm.metadata as Record<string, unknown>;
    assert.equal(dmMeta.channelInvitation, undefined, 'no invitation on a DM');
    assert.equal(dmMeta.storedBodyDigest, dmMeta.sourceBodyDigest);
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

  it('a mention pushed from a closed channel carries the host\'s digests, never the adapter\'s: the delivered body, and the stored copy with its invitation', async () => {
    await closeRoom();
    command({
      op: 'push', eventId: 'ev-forged', text: 'psst again',
      origin: {
        source: 'discord', mcplChannelId: ROOM, messageId: 'pm-forged', authorName: 'antra',
        sourceBodyDigest: 'adapter-value', storedBodyDigest: 'adapter-value',
      },
      tags: ['chat:mention', 'chat:addressed'],
    });
    await waitFor(() => !!storedWith((m) => m.eventId === 'ev-forged'), 'push stored');
    const message = storedWith((m) => m.eventId === 'ev-forged')!;
    const meta = message.metadata as Record<string, unknown>;
    assert.equal(meta.channelInvitation, true, 'stored with the closed-channel invitation');
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'psst again' }]), 'the delivered body, not the adapter\'s value');
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content), 'exactly what was stored, not the adapter\'s value');
    assert.notEqual(meta.storedBodyDigest, meta.sourceBodyDigest, 'the invitation decorates the stored copy');
  });

  it('a channels/incoming item carries the host\'s digests, never the adapter\'s', async () => {
    command({
      op: 'incoming', channelId: ROOM, messageId: 'm-forged', mode: 'ambient', text: 'forged digests',
      metadata: { sourceBodyDigest: 'adapter-value', storedBodyDigest: 'adapter-value' },
    });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-forged'), 'message stored');
    const message = storedWith((m) => m.messageId === 'm-forged')!;
    const meta = message.metadata as Record<string, unknown>;
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'forged digests' }]), 'the delivered body, not the adapter\'s value');
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(message.content), 'exactly what was stored, not the adapter\'s value');
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

  it("drops an envelope a module's metadata carries: only the framework writes one", async () => {
    const forged = { kind: 'channel', lane: 'channels/incoming', serverId: 'evil', binding: 'x', channelId: 'discord:g9:elsewhere', acceptedAt: 1 };
    framework.pushEvent({ type: 'relay', content: 'relayed words', metadata: { inboundSource: forged, note: 'kept' } } as unknown as ProcessEvent);
    await waitFor(() => stored().some((m) => m.participant === 'Relay'), 'relayed message stored');
    const relayed = stored().find((m) => m.participant === 'Relay')!;
    assert.equal(readInboundSource(relayed.metadata), undefined, 'not the forged envelope');
    assert.equal((relayed.metadata as Record<string, unknown>).note, 'kept', 'the rest of its metadata stays');
    // A surface event's message carries the framework's envelope, whatever its metadata said.
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'console words', metadata: { inboundSource: forged } } as ProcessEvent);
    await waitFor(() => stored().some((m) => m.participant === 'Operator'), 'console message stored');
    const source = readInboundSource(stored().find((m) => m.participant === 'Operator')!.metadata);
    assert.equal(source?.kind, 'surface');
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
      { ...channel, serverId: undefined },
      { ...channel, serverId: '' },
      { ...channel, serverId: 7 },
      { ...channel, binding: undefined },
      { ...channel, binding: { id: 'b' } },
      { ...channel, threadId: 3 },
      { ...channel, threadId: '' },
      { ...channel, replyTo: false },
      { ...channel, eventId: 9 },
      { kind: 'unscoped', lane: 'push/event', serverId: '', binding: 'b', acceptedAt: 1 },
      { kind: 'unscoped', lane: 'push/event', serverId: 's', binding: 'b', acceptedAt: 1, eventId: [] },
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
    // The parts are server-chosen: a separator inside one can't make two
    // conversations one.
    assert.notEqual(
      conversationKey({ ...base, channelId: 'c\u0000x', threadId: 'y' }),
      conversationKey({ ...base, channelId: 'c', threadId: 'x\u0000y' }),
    );
    assert.notEqual(conversationKey({ ...base, threadId: '' }), conversationKey(base), 'an empty thread is not no thread');
  });
});

describe('stored digests when the store shards a body', () => {
  /** A strategy whose store splits a body of more than one block into one
   *  shard per block, as adaptive ingress chunking does. */
  class ShardingStrategy extends PassthroughStrategy {
    chunkIngressMessage(_participant: string, content: ContentBlock[]) {
      if (content.length < 2) return null;
      return { bodyGroupId: `group-${content.length}-${Date.now()}`, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
    }
  }

  it("every shard carries the whole body's digests, and no shard hashes to them; an unsharded copy matches its own", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inbound-shards-'));
    const commandPath = join(tempDir, 'commands.jsonl');
    writeFileSync(commandPath, '');
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: new ShardingStrategy() }],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    try {
      await framework.start();
      const command = (c: Record<string, unknown>): void => appendFileSync(commandPath, JSON.stringify(c) + '\n');
      const blocks = [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }];
      command({ op: 'push', eventId: 'sharded', content: blocks });
      command({ op: 'push', eventId: 'whole', text: 'one block' });
      const stored = () => framework.getAgent('scout')!.getContextManager().getAllMessages();
      await waitFor(() => stored().some((m) => (m.metadata as { eventId?: string } | undefined)?.eventId === 'whole'), 'both pushes stored');
      const shards = stored().filter((m) => (m.metadata as { eventId?: string } | undefined)?.eventId === 'sharded');
      assert.equal(shards.length, 2, 'stored as two shards');
      assert.ok(shards[0]!.bodyGroupId && shards.every((m) => m.bodyGroupId === shards[0]!.bodyGroupId));
      assert.deepEqual(shards.map((m) => m.shardIndex), [0, 1]);
      const whole = sourceBodyDigest(blocks);
      for (const shard of shards) {
        const meta = shard.metadata as Record<string, unknown>;
        assert.equal(meta.sourceBodyDigest, whole, 'the whole delivered body');
        assert.equal(meta.storedBodyDigest, whole, 'the whole body handed to storage');
        assert.notEqual(sourceBodyDigest(shard.content), whole, 'a shard alone is not the body');
      }
      const one = stored().find((m) => (m.metadata as { eventId?: string } | undefined)?.eventId === 'whole')!;
      assert.equal(one.bodyGroupId, undefined, 'a one-block body is not sharded');
      assert.equal(sourceBodyDigest(one.content), (one.metadata as Record<string, unknown>).storedBodyDigest, 'an unsharded copy matches');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
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
    // The materialized copy is its own storage site: both digests are the
    // host's, over the rendered body, not the deferred placeholder.
    const copy = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
      .find((m) => JSON.stringify(m.content).includes('document_diff'))!;
    const meta = copy.metadata as Record<string, unknown>;
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(copy.content), 'exactly what was stored');
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest(copy.content), 'the rendered body, undecorated');
    assert.notEqual(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'fallback_unavailable' }]), 'not the placeholder');
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

  it('a channel message deferred mid-turn and stored at the boundary still hashes to its stored digest', async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.register('chat');
    const internals = f.framework as unknown as { activeTurnTokens: Map<string, number>; flushDeferredWrites(label: string): Promise<void> };
    internals.activeTurnTokens.set('agent', 100);
    await f.send('channels/incoming', { messages: [f.channel('e1', 'deferred_words', { initial: true })] });
    assert.ok(!f.context().includes('deferred_words'), 'held until the boundary');
    internals.activeTurnTokens.delete('agent');
    await internals.flushDeferredWrites('test');
    const copy = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
      .find((m) => JSON.stringify(m.content).includes('deferred_words'))!;
    const meta = copy.metadata as Record<string, unknown>;
    assert.equal(meta.storedBodyDigest, sourceBodyDigest(copy.content), 'the copy stored at the boundary matches');
    assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text: 'deferred_words' }]), 'the delivered body, unchanged');
  });

  it("the conversation router's and a fork correction's storage sites carry the host's digests, never the adapter's", async (t) => {
    const f = await fixture({ framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as never }); t.after(f.close);
    await f.register();
    const forged = { sourceBodyDigest: 'adapter-value', storedBodyDigest: 'adapter-value' };
    const router = (f.framework as unknown as { conversationRouter: { getBinding(channel: ChannelRef): { agentName: string } | undefined; unbind(channel: ChannelRef): void } }).conversationRouter;
    const chat: ChannelRef = { serverId: 'editor', channelId: 'chat' };
    const check = (text: string, fork: string) => {
      const copy = f.framework.getAgent(fork)!.getContextManager().getAllMessages().find((m) => JSON.stringify(m.content).includes(text));
      assert.ok(copy, `${text} stored in ${fork}`);
      const meta = copy.metadata as Record<string, unknown>;
      assert.equal(meta.sourceBodyDigest, sourceBodyDigest([{ type: 'text', text }]), `${text}: the delivered body, not the adapter's value`);
      assert.equal(meta.storedBodyDigest, sourceBodyDigest(copy.content), `${text}: exactly what was stored, not the adapter's value`);
    };
    // Routed into a fresh fork by the conversation router.
    await f.send('channels/incoming', { messages: [{ ...f.channel('c1', 'routed_original', { initial: true }), metadata: forged }] });
    const fork = router.getBinding(chat)!.agentName;
    check('routed_original', fork);
    // A correction follows the prior delivery into that fork, though the
    // channel is no longer bound to it.
    router.unbind(chat);
    await f.send('channels/incoming', { messages: [{ ...f.channel('c2', 'fork_correction'), metadata: forged }] });
    assert.equal(router.getBinding(chat), undefined, 'no fresh fork was spawned for the correction');
    check('fork_correction', fork);
  });

  it("a channel-scoped push edit that names no message takes its subject's message and thread, as its delivery does", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.register();
    await f.send('channels/incoming', { messages: [{ ...f.channel('c', 'first_version', { initial: true }), threadId: 'thread' }] });
    await f.send('push/event', f.params('e', 'second_version', { channelId: 'chat', key: 'message:m' }));
    await eventually(() => !!sourceOf(f, 'second_version'), 'the edit stored');
    const stored = sourceOf(f, 'second_version');
    assert.ok(stored && stored.kind === 'channel');
    assert.equal(stored.lane, 'push/event');
    assert.equal(stored.messageId, 'm');
    assert.equal(stored.threadId, 'thread');
  });

  it("a channel-scoped push edit that names its own message and thread keeps them over its subject's", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.register();
    await f.send('channels/incoming', { messages: [{ ...f.channel('c', 'first_version', { initial: true }), threadId: 'thread' }] });
    const edit = f.params('e', 'second_version', { channelId: 'chat', key: 'message:m' });
    await f.send('push/event', { ...edit, origin: { ...(edit as { origin?: object }).origin, messageId: 'm2', threadId: 'thread2' } });
    await eventually(() => !!sourceOf(f, 'second_version'), 'the edit stored');
    const stored = sourceOf(f, 'second_version');
    assert.ok(stored && stored.kind === 'channel');
    assert.equal(stored.messageId, 'm2');
    assert.equal(stored.threadId, 'thread2');
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
  const bodies: Record<string, { blocks: unknown[]; changed: boolean; digest: string }> = {
    'plain text': { blocks: [{ type: 'text', text: 'hello' }], changed: false, digest: '20e8a9654f001815055a7b61692923120a516fc0095519f521c8c821421cb4b9' },
    'a labeled image': { blocks: [image(png)], changed: false, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'PNG bytes labeled image/jpeg': { blocks: [image(png, 'image/jpeg')], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'JPEG bytes labeled image/png': { blocks: [image(Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64'))], changed: true, digest: '828ac28be2d13e7621768ba98ec74d555409d97567f9c05b1a1428e614cf9233' },
    // One fixture per signature the store sniffs, each labeled as something
    // else, so a context-manager that stops sniffing one fails here.
    'GIF87a bytes labeled image/png': { blocks: [image(Buffer.from('GIF87a\x01\x00\x01\x00\x00\x00\x00', 'latin1').toString('base64'))], changed: true, digest: 'e6e7bf5cc2225c979b2063abbe811ba02db8208e49b8315d0cab6565b55631fc' },
    'GIF89a bytes labeled image/jpeg': { blocks: [image(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1').toString('base64'), 'image/jpeg')], changed: true, digest: 'd7b8b855a4e81d88931ebf4a1d91c76c57da9d79572f523e29de1b9d23143fb1' },
    'WebP bytes labeled image/png': { blocks: [image(Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00', 'latin1').toString('base64'))], changed: true, digest: 'e643b5a67e56b99e8c555cd1064bc24ccba134e76a240b99c651934b761a9c72' },
    'base64 with a newline in it': { blocks: [image(`${png.slice(0, 11)}\n${png.slice(11)}`)], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'base64 with whitespace around it': { blocks: [image(`  ${png}\n`)], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'base64 without its padding': { blocks: [image(png.replace(/=+$/, ''))], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'base64 with non-zero unused bits': { blocks: [image(png.replace(/8=$/, '9='))], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'base64 in the URL-safe alphabet': { blocks: [image(png.replace(/\//g, '_'))], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'an image whose data is not base64': { blocks: [image('not base64 at all!')], changed: true, digest: '75f6aed70407609a42b127029df45b37de6f61019f25c9ed8ea76c904c7ab6ed' },
    // Bytes the store has no signature for keep their label. Labeled
    // image/png, so a context-manager that learns to sniff one fails here.
    'SVG bytes labeled image/png': { blocks: [image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'))], changed: false, digest: 'b4f895f137c12d828e3c38d9213f02b8126372824adbca4d49c084b2af7c8a99' },
    'BMP bytes labeled image/png': { blocks: [image(Buffer.from('424d3a0000000000000036000000', 'hex').toString('base64'))], changed: false, digest: '8b4d4b8cd7ad44bebd5612eccb4119fca58cf99179217dc5598fae0910c6cf4e' },
    'AVIF bytes labeled image/png': { blocks: [image(Buffer.from('0000001c6674797061766966000000006d696631', 'hex').toString('base64'))], changed: false, digest: '29ee62d0947b86ae92afc97520104f1df0971bef0cdc42f896f84238862bf0c7' },
    'an image whose source is neither base64 nor a URL': { blocks: [{ type: 'image', source: { type: 'file', data: png, mediaType: 'image/png' } }], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'an image with fields the store drops': { blocks: [image(png, 'image/png', { sourceUrl: 'https://cdn.example/a.png', tokenEstimate: 85 })], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'an image by URL, its fields kept': { blocks: [{ type: 'image', source: { type: 'url', url: 'https://cdn.example/a.png' }, sourceUrl: 'https://cdn.example/a.png' }], changed: false, digest: '86c0304289fb63c7aa9c553bb4f74715e41f48dd3369c2a9d3036264436deb37' },
    'audio, wrapped, with a duration': { blocks: [media('audio', 'SUQz\nAwAAAAAA', 'audio/mpeg', { duration: 3 })], changed: true, digest: '98cffd2cea1945c6369cb5e7baff7b9c8227e297bb2065eb75ac756f6be2ec76' },
    'a document with a filename': { blocks: [media('document', 'JVBERi0xLjQ=', 'application/pdf', { filename: 'a.pdf' })], changed: true, digest: '8d07d2f460b247e61d54154454f0c53601b54996af04de5403ac5059a6a7ef2a' },
    'text with lone surrogates': { blocks: [{ type: 'text', text: 'cut \ud83d here, \ude00 there, \ud83d\ud83d twice' }], changed: true, digest: '5d9fcff202fa2c652254c3eba7ac8dcf970124927ad4ae27c8ba77d46c460de8' },
    'a key that is not well-formed': { blocks: [{ type: 'text', text: 'x', rawItem: { 'k\ud800': 1, kept: 2 } }], changed: true, digest: 'a9f7d2e0c020bfbf5b5c7018327a62b27e905283a531cdce6809b2bd0bd40bda' },
    'a relabeled image with a text decoration': { blocks: [image(png, 'image/jpeg'), { type: 'text', text: '[invitation]' }], changed: true, digest: '5361c3940444c2049c32585c60da69561f6b5a7da723fec876ea2e9cc048d0ec' },
    'a video with a duration': { blocks: [media('video', 'AAAAGGZ0eXBtcDQy', 'video/mp4', { duration: 2 })], changed: true, digest: 'f861b815a4330c4f428ec70f6842b427755a1f32e70d195b242a419f0e7edc52' },
    // No media type: an image takes its bytes' own (an image without a
    // signature, or other media, is refused at write: see below).
    'an image without a media type': { blocks: [{ type: 'image', source: { type: 'base64', data: png } }], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'an image whose media type is undefined': { blocks: [{ type: 'image', source: { type: 'base64', data: png, mediaType: undefined } }], changed: true, digest: '45ece3b08410bd3892995e358b0bcae6941f44ce43028ac9255aa83eb0870c1f' },
    'a text block with an undefined field': { blocks: [{ type: 'text', text: 'x', note: undefined }], changed: true, digest: 'e96649c55e4c0362c808071bd07421837b9d6cb02b71739d66e112ef8950ae9e' },
    // Only a non-URL image is blobbed: a URL image keeps even a stray data
    // string as given, and storedBlock must not re-encode it.
    'an image by URL with a stray data string': { blocks: [{ type: 'image', source: { type: 'url', url: 'https://cdn.example/a.png', data: 'not base64 at all' } }], changed: false, digest: 'bc49add8c15470ee7f0c265407c27a487a5a4db29e0a72bcd67459cb40790d7c' },
    'a tool_use whose input is a string': { blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: 'not an object' }], changed: true, digest: 'cad2fc7ae441d577c80caf5c1b600b75b1fac068fbad1bb3c927cf5eaa6ecc8e' },
    'a document whose data is a byte array': { blocks: [{ type: 'document', source: { type: 'base64', data: [...Buffer.from('%PDF-1.4')], mediaType: 'application/pdf' } }], changed: true, digest: '8d07d2f460b247e61d54154454f0c53601b54996af04de5403ac5059a6a7ef2a' },
  };

  it('every body hashes alike as handed to the store, as read back live and after reopening, and as stamped', async () => {
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
        for (const [name, { blocks, changed, digest }] of Object.entries(bodies)) {
          const back = cm.getMessage(ids.get(name)!)!;
          if (changed) assert.notDeepEqual(back.content, blocks, `${when}, ${name}: the store hands it back changed`);
          else assert.deepEqual(back.content, blocks, `${when}, ${name}: the store hands it back as it was`);
          assert.equal(sourceBodyDigest(back.content), (back.metadata as Record<string, unknown>).storedBodyDigest, `${when}, ${name}: it still hashes as handed over`);
          assert.equal(sourceBodyDigest(back.content), digest, `${when}, ${name}: it hashes as stamped`);
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

  it('refused content and caller-supplied blob_ref cannot be written; unresolved and resolved reads have distinct digests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stored-digest-refused-'));
    try {
      const cm = await ContextManager.open({ path: join(dir, 'store.chronicle'), strategy: new PassthroughStrategy() });
      try {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
        for (const [what, block] of [
          ['a document without a media type', { type: 'document', source: { type: 'base64', data: 'JVBERi0xLjQ=' } }],
          ['an image without a media type whose bytes have no signature', { type: 'image', source: { type: 'base64', data: svg } }],
          // The store's append can't represent an undefined array element.
          ['an array with an undefined element', { type: 'text', text: 'x', parts: ['a', undefined] }],
        ] as const) {
          assert.throws(() => cm.addMessage('user', [block] as never), Error, `${what}: refused at write`);
        }
        // Only the store may write blob_ref. An unresolved read can expose
        // one, but callers must resolve it before attempting a new write.
        const held = cm.addMessage('user', [image(png)] as never);
        const ref = cm.getMessageWindow(0, cm.getMessageCount(), { resolveBlobs: false }).messages
          .find((m) => m.id === held)!.content[0] as { type: string };
        assert.equal(ref.type, 'blob_ref');
        const given = [ref];
        const before = cm.getMessageCount();
        assert.throws(() => cm.addMessage('user', given as never), MalformedContentError, 'a raw blob_ref is store-only');
        assert.equal(cm.getMessageCount(), before, 'refused write adds no record');
        const back = cm.getMessage(held)!;
        assert.deepEqual(back.content, [image(png)], 'resolved on read');
        assert.notEqual(sourceBodyDigest(given), sourceBodyDigest(back.content), 'unresolved refs are not inline content');
      } finally {
        cm.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a body the store refuses is digested as given, and nothing is logged for it', (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    for (const block of [
      { type: 'document', source: { type: 'base64', data: 'JVBERi0xLjQ=' } },
      { type: 'image', source: { type: 'base64', data: Buffer.from('<svg/>').toString('base64') } },
      { type: 'blob_ref', blobKind: 'image', hash: 'deadbeef', mediaType: 'image/png' },
    ]) {
      const titled = { ...block, title: 'a' };
      for (const given of [block, titled]) {
        assert.throws(() => blockAsStored(given as never), MalformedContentError, `${given.type}: the store refuses it`);
      }
      assert.match(sourceBodyDigest([block]), /^[0-9a-f]{64}$/, `${block.type}: it has a digest`);
      assert.notEqual(sourceBodyDigest([titled]), sourceBodyDigest([block]), `${block.type}: every field of a refused body counts`);
    }
    assert.deepEqual(logged, []);
  });

  it('any other error from the store\'s transform still gives the block\'s digest as given, and is logged once', (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    let reads = 0;
    const block = {
      type: 'text',
      get text() {
        if (reads++ === 0) throw new TypeError('the first read fails');
        return 'x';
      },
    };
    assert.equal(sourceBodyDigest([block]), sourceBodyDigest([{ type: 'text', text: 'x' }]));
    assert.equal(logged.length, 1, logged.join('\n'));
    assert.match(logged[0], /^\[stored-digest-as-given\] error=TypeError: .*the first read fails/);
  });

  it('a block the store keeps as given is digested as given', () => {
    const plain = (blocks: unknown[]) => createHash('sha256').update(canonicalJson([blocks])).digest('hex');
    // Only a non-URL image is blobbed, so a URL image's stray data string is
    // neither decoded nor re-encoded.
    const urlImage = { type: 'image', source: { type: 'url', url: 'https://cdn.example/a.png', data: 'not base64 at all' } };
    assert.equal(sourceBodyDigest([urlImage]), plain([urlImage]));
    assert.equal(sourceBodyDigest([{ type: 'text', text: 'x' }]), plain([{ type: 'text', text: 'x' }]));
    // An undefined array element is written as null, as JSON writes it (the
    // store refuses such a body, above, so no stored copy holds one).
    assert.equal(
      sourceBodyDigest([{ type: 'text', text: 'x', parts: ['a', undefined] }]),
      sourceBodyDigest([{ type: 'text', text: 'x', parts: ['a', null] }]),
    );
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
