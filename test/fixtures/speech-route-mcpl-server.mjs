// MCPL fixture for speech routing, drafts and provenance tests.
//
// Registers the channels in CHANNELS (JSON array of {id,label}; two Discord
// guild channels by default) and, on command, sends inbound traffic over
// BOTH MCPL lanes. The TEST appends one JSON object per line to COMMAND_PATH:
//   {"op":"incoming","channelId":…,"messageId":…,"mode":"ambient"|"addressed",
//    "text":…, "content"? (content blocks, instead of text), "threadId"?,
//    "metadata"?, "eventId"?, "coalesce"?}
//   {"op":"dm","eventId":…,"authorId":…,"authorName"?,"rawChannelId":…,"text":…}
//   {"op":"push","eventId":…,"origin"?,"tags"?,"text":…,"featureSet"?}
//   {"op":"rename","channelId":…,"label":…}             (channels/changed)
//   {"op":"publish-mode","mode":"delivered"|"not-delivered"|"no-receipt"|"error"|"hang"}
//   {"op":"history","channelId":…,"history":[ChannelIncomingMessage…]}
// Host-side channels/publish and channels/open calls are recorded to
// STATUS_PATH as JSONL ({event:'publish', channelId, text, messageId}).
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
            content: c.content ?? textBlock(c.text ?? ''),
            ...(c.metadata ? { metadata: c.metadata } : {}),
            tags: c.mode === 'addressed'
              ? ['chat:mention', 'chat:addressed', 'chat:from-human']
              : ['chat:ambient', 'chat:from-human'],
          }],
        },
      });
    } else if (c.op === 'dm') {
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
          payload: { content: textBlock(c.text ?? '') },
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
          payload: { content: textBlock(c.text ?? '') },
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
          updated: [{ id: c.channelId, type: 'discord', label: c.label, direction: 'bidirectional' }],
        },
      });
      log('renamed', { channelId: c.channelId, label: c.label });
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
        channels: CHANNELS.map((c) => ({
          id: c.id, type: 'discord', label: c.label, direction: 'bidirectional', initiallyOpen: true,
        })),
      },
    });
    return;
  }
  if (msg.method === 'channels/open') {
    const channelId = msg.params?.channelId;
    const channel = CHANNELS.find((x) => x.id === channelId) ?? { id: channelId, label: channelId };
    const history = msg.params?.history ? histories.get(channelId) : undefined;
    log('channel-opened', { channelId, history: !!history });
    reply(msg.id, {
      channel: { id: channel.id, type: 'discord', label: channel.label, direction: 'bidirectional' },
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
      log('publish-refused', { channelId, text });
      if (msg.id !== undefined && msg.id !== null) reply(msg.id, { delivered: false });
      return;
    }
    const messageId = `posted-${++posted}`;
    log('publish', { channelId, text, messageId });
    if (msg.id !== undefined && msg.id !== null) {
      reply(msg.id, publishMode === 'no-receipt' ? {} : { delivered: true, messageId });
    }
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [] });
    return;
  }
  // Responses to our own requests (register, incoming, push) need no handling.
});
