// MCPL fixture for speech routing, drafts and provenance tests.
//
// Registers the channels in CHANNELS (JSON array of {id,label,publishTarget?};
// two Discord guild channels by default) and, on command, sends inbound
// traffic over BOTH MCPL lanes. Each channel declares its MCPL RFC-011
// publish target: its own publishTarget ('exact' | 'root' | null for none),
// else PUBLISH_TARGET (default 'root'). channels/publish follows RFC-011 as a
// server that implements it: a threadId is honored or refused, never ignored,
// and a delivery echoes where it posted. A DM's channel (discord:dm:<raw>) is
// registered with its declaration (DM_TARGET, default 'root') just before
// the DM is pushed, as an RFC-011 connector registers its DM channels;
// DM_TARGET=none leaves it to the host's lazy registration, undeclared.
// The tool names in TOOLS (JSON array)
// are listed, so a test can see which connector tools a notice names.
// The TEST appends one JSON object per line to COMMAND_PATH:
//   {"op":"incoming","channelId":…,"messageId":…,"mode":"ambient"|"addressed",
//    "text":…, "threadId"?, "metadata"?, "eventId"?, "coalesce"?}
//   {"op":"dm","eventId":…,"authorId":…,"authorName"?,"rawChannelId":…,"text":…,
//    "content"? (content blocks, instead of text; [] included), "origin"?}
//   {"op":"push","eventId":…,"origin"?,"tags"?,"text":…,"featureSet"?,
//    "content"? (content blocks, instead of text; [] included)}
//   {"op":"rename","channelId":…,"label":…}             (channels/changed)
//   {"op":"publish-mode","mode":"delivered"|"not-delivered"|"no-receipt"|"error"|"hang"|"no-echo"|"wrong-echo"}
//   {"op":"declare","channelId":…,"target":"exact"|"root"|null}   (channels/changed)
//   {"op":"history","channelId":…,"history":[ChannelIncomingMessage…]}
// Host-side channels/publish and channels/open calls are recorded to
// STATUS_PATH as JSONL ({event:'publish', channelId, text, messageId,
// threadId}; threadId absent when the request carried none).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const statusPath = process.env.STATUS_PATH;
const commandPath = process.env.COMMAND_PATH;
const CHANNELS = process.env.CHANNELS
  ? JSON.parse(process.env.CHANNELS)
  : [
      { id: 'discord:g1:room', label: '#room (Guild One)' },
      { id: 'discord:g1:general', label: '#general (Guild One)' },
    ];
const DEFAULT_TARGET = process.env.PUBLISH_TARGET === 'none' ? null : (process.env.PUBLISH_TARGET ?? 'root');
for (const c of CHANNELS) if (c.publishTarget === undefined) c.publishTarget = DEFAULT_TARGET;
const TOOLS = process.env.TOOLS ? JSON.parse(process.env.TOOLS) : [];
const DM_TARGET = process.env.DM_TARGET === 'none' ? null : (process.env.DM_TARGET ?? 'root');
const registeredDms = new Set();
const descriptor = (c) => ({
  id: c.id, type: 'discord', label: c.label, direction: 'bidirectional',
  ...(c.publishTarget ? { capabilities: { publish: { target: c.publishTarget } } } : {}),
});

const log = (event, extra = {}) => {
  if (!statusPath) return;
  appendFileSync(statusPath, JSON.stringify({ event, ...extra }) + '\n');
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

let nextId = 500;
let processedCommands = 0;
let publishMode = 'delivered';
let posted = 0;
const histories = new Map();

const textBlock = (text) => [{ type: 'text', text }];

function pollCommands() {
  if (!commandPath || !existsSync(commandPath)) return;
  const lines = readFileSync(commandPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(processedCommands)) {
    processedCommands++;
    const c = JSON.parse(line);
    if (c.op === 'incoming') {
      log('incoming-sent', { channelId: c.channelId, messageId: c.messageId });
      send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'channels/incoming',
        params: {
          messages: [{
            channelId: c.channelId,
            messageId: c.messageId,
            ...(c.threadId ? { threadId: c.threadId } : {}),
            ...(c.eventId ? { eventId: c.eventId } : {}),
            ...(c.coalesce ? { coalesce: c.coalesce } : {}),
            author: { id: c.authorId ?? 'U-other', name: c.authorName ?? 'someone' },
            timestamp: c.timestamp ?? new Date().toISOString(),
            content: textBlock(c.text ?? ''),
            ...(c.metadata ? { metadata: c.metadata } : {}),
            tags: c.mode === 'addressed'
              ? ['chat:mention', 'chat:addressed', 'chat:from-human']
              : ['chat:ambient', 'chat:from-human'],
          }],
        },
      });
    } else if (c.op === 'dm') {
      const dmChannel = `discord:dm:${c.rawChannelId}`;
      if (DM_TARGET && !registeredDms.has(dmChannel)) {
        registeredDms.add(dmChannel);
        const dm = { id: dmChannel, label: `DM: ${c.authorName ?? 'antra'}`, publishTarget: DM_TARGET };
        CHANNELS.push(dm);
        send({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'channels/changed',
          params: {
            added: [{
              ...descriptor(dm),
              metadata: { channelType: 'dm', recipientName: c.authorName ?? 'antra', ...(c.authorId ? { recipientId: c.authorId } : {}) },
            }],
          },
        });
      }
      log('dm-sent', { eventId: c.eventId });
      send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'push/event',
        params: {
          featureSet: 'chat',
          eventId: c.eventId,
          timestamp: c.timestamp ?? new Date().toISOString(),
          origin: {
            source: 'discord',
            channelId: c.rawChannelId,
            guildId: null,
            isDM: true,
            authorId: c.authorId,
            authorName: c.authorName ?? 'antra',
            messageId: c.messageId ?? c.eventId,
            ...(c.origin ?? {}),
          },
          tags: ['chat:dm', 'chat:addressed', 'chat:private'],
          payload: { content: c.content ?? textBlock(c.text ?? '') },
        },
      });
    } else if (c.op === 'push') {
      log('push-sent', { eventId: c.eventId });
      send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'push/event',
        params: {
          featureSet: c.featureSet ?? 'chat',
          eventId: c.eventId,
          timestamp: c.timestamp ?? new Date().toISOString(),
          ...(c.origin ? { origin: c.origin } : {}),
          ...(c.tags ? { tags: c.tags } : {}),
          payload: { content: c.content ?? textBlock(c.text ?? '') },
        },
      });
    } else if (c.op === 'rename') {
      const channel = CHANNELS.find((x) => x.id === c.channelId);
      if (channel) channel.label = c.label;
      send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'channels/changed',
        params: {
          updated: [descriptor(channel ?? { id: c.channelId, label: c.label, publishTarget: DEFAULT_TARGET })],
        },
      });
      log('renamed', { channelId: c.channelId, label: c.label });
    } else if (c.op === 'declare') {
      const channel = CHANNELS.find((x) => x.id === c.channelId);
      if (channel) channel.publishTarget = c.target;
      send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'channels/changed',
        params: { updated: [descriptor(channel ?? { id: c.channelId, label: c.channelId, publishTarget: c.target })] },
      });
      log('declared', { channelId: c.channelId, target: c.target });
    } else if (c.op === 'publish-mode') {
      publishMode = c.mode;
      log('publish-mode', { mode: c.mode });
    } else if (c.op === 'history') {
      histories.set(c.channelId, c.history);
    }
  }
}
const pollTimer = setInterval(pollCommands, 25);

const rl = createInterface({ input: process.stdin });
rl.on('close', () => {
  clearInterval(pollTimer);
  process.exit(0);
});
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        experimental: {
          mcpl: {
            version: '0.5',
            pushEvents: true,
            channels: { register: true, lifecycle: true, incoming: true, publish: true },
            featureSets: {
              chat: { description: 'chat connector', uses: ['pushEvents', 'channels.incoming', 'channels.publish'] },
            },
          },
        },
      },
      serverInfo: { name: 'speech-route-fixture', version: '0.0.0' },
    });
    return;
  }
  if (msg.method === 'featureSets/update') {
    if (msg.id !== undefined && msg.id !== null) reply(msg.id, { accepted: true });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    send({
      jsonrpc: '2.0',
      id: 400,
      method: 'channels/register',
      params: {
        channels: CHANNELS.map((c) => ({ ...descriptor(c), initiallyOpen: true })),
      },
    });
    return;
  }
  if (msg.method === 'channels/open') {
    const channelId = msg.params?.channelId;
    const channel = CHANNELS.find((x) => x.id === channelId) ?? { id: channelId, label: channelId, publishTarget: DEFAULT_TARGET };
    const history = msg.params?.history ? histories.get(channelId) : undefined;
    log('channel-opened', { channelId, history: !!history });
    reply(msg.id, {
      channel: descriptor(channel),
      ...(history ? { history } : {}),
    });
    return;
  }
  if (msg.method === 'channels/close') {
    reply(msg.id, { closed: true });
    return;
  }
  if (msg.method === 'channels/publish') {
    const text = (msg.params?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const channelId = msg.params?.channelId;
    const targeted = msg.params && 'threadId' in msg.params;
    const threadId = msg.params?.threadId;
    const placed = targeted ? { threadId } : {};
    // RFC-011, as a server that implements it: never ignore a threadId.
    if (targeted) {
      const declared = CHANNELS.find((x) => x.id === channelId)?.publishTarget ?? null;
      const why = threadId !== null && (typeof threadId !== 'string' || threadId === '')
        ? 'invalid threadId'
        : !declared
          ? 'this channel declares no publish target'
          : declared === 'root' && threadId !== null
            ? 'this channel has no threads'
            : undefined;
      if (why) {
        log('publish-refused', { channelId, text, ...placed, reason: why });
        if (msg.id !== undefined && msg.id !== null) reply(msg.id, { delivered: false, reason: why });
        return;
      }
    }
    if (publishMode === 'hang') {
      log('publish-hung', { channelId, text });
      return; // never answered: the host's request times out
    }
    if (publishMode === 'error') {
      log('publish-error', { channelId, text });
      if (msg.id !== undefined && msg.id !== null) replyError(msg.id, 'connector exploded');
      return;
    }
    if (publishMode === 'not-delivered') {
      log('publish-refused', { channelId, text, ...placed });
      if (msg.id !== undefined && msg.id !== null) reply(msg.id, { delivered: false });
      return;
    }
    const messageId = `posted-${++posted}`;
    log('publish', { channelId, text, messageId, ...placed });
    if (msg.id !== undefined && msg.id !== null) {
      const echo = publishMode === 'no-echo'
        ? {}
        : publishMode === 'wrong-echo'
          ? { threadId: threadId === null ? 'some-other-thread' : null }
          : placed;
      reply(msg.id, publishMode === 'no-receipt' ? {} : { delivered: true, messageId, ...echo });
    }
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: TOOLS.map((name) => ({ name, description: `fixture tool ${name}`, inputSchema: { type: 'object', properties: {} } })),
    });
    return;
  }
  if (msg.method === 'tools/call') {
    // No tools: answer at once (a rollback's awareness markers call one).
    replyError(msg.id, `no tool "${msg.params?.name}" on this fixture`);
    return;
  }
  // Responses to our own requests (register, incoming, push) need no handling.
});
