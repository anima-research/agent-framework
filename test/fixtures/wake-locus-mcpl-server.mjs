// MCPL fixture for batched-wake routing tests.
//
// Registers two open guild channels and, on command, sends either
// channels/incoming traffic or a Discord-shaped DM push/event (raw snowflake
// channel id in the origin, exactly what discord-mcpl sends for a DM). The
// TEST appends lines to COMMAND_PATH:
//   incoming <channelId> <messageId> <ambient|addressed> <text…>
//   dm <eventId> <authorId> <rawChannelId> <text…>
// Every channel declares an MCPL RFC-011 publish target (root), and a DM's
// channel (discord:dm:<raw>) is registered with one just before the DM is
// pushed, as discord-mcpl registers its DM channels.
// Host-side channels/publish and channels/open calls are recorded to
// STATUS_PATH as JSONL.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const statusPath = process.env.STATUS_PATH;
const commandPath = process.env.COMMAND_PATH;

const log = (event, extra = {}) => {
  if (!statusPath) return;
  appendFileSync(statusPath, JSON.stringify({ event, ...extra }) + '\n');
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const CHANNELS = [
  { id: 'discord:g1:room', label: 'room' },
  { id: 'discord:g1:general', label: 'general' },
];
let nextId = 500;
let processedCommands = 0;
const registeredDms = new Set();

function pollCommands() {
  if (!commandPath || !existsSync(commandPath)) return;
  const lines = readFileSync(commandPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(processedCommands)) {
    processedCommands++;
    const [kind, ...rest] = line.split(' ');
    if (kind === 'incoming') {
      const [channelId, messageId, mode, ...words] = rest;
      log('incoming-sent', { channelId, messageId });
      send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'channels/incoming',
        params: {
          messages: [{
            channelId,
            messageId,
            author: { id: 'U-other', name: 'someone' },
            timestamp: new Date().toISOString(),
            content: [{ type: 'text', text: words.join(' ') }],
            tags: mode === 'addressed'
              ? ['chat:mention', 'chat:addressed', 'chat:from-human']
              : ['chat:ambient', 'chat:from-human'],
          }],
        },
      });
    } else if (kind === 'dm') {
      const [eventId, authorId, rawChannelId, ...words] = rest;
      const dmChannel = `discord:dm:${rawChannelId}`;
      if (!registeredDms.has(dmChannel)) {
        registeredDms.add(dmChannel);
        send({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'channels/changed',
          params: {
            added: [{
              id: dmChannel, type: 'discord', label: 'DM: antra', direction: 'bidirectional',
              metadata: { channelType: 'dm', recipientName: 'antra', recipientId: authorId },
              capabilities: { publish: { target: 'root' } },
            }],
          },
        });
      }
      log('dm-sent', { eventId });
      send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'push/event',
        params: {
          featureSet: 'chat',
          eventId,
          timestamp: new Date().toISOString(),
          origin: {
            source: 'discord',
            channelId: rawChannelId,
            guildId: null,
            isDM: true,
            authorId,
            authorName: 'antra',
            messageId: eventId,
          },
          tags: ['chat:dm', 'chat:addressed', 'chat:private'],
          payload: { content: [{ type: 'text', text: words.join(' ') }] },
        },
      });
    }
  }
}
const pollTimer = setInterval(pollCommands, 50);

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
      serverInfo: { name: 'wake-locus-fixture', version: '0.0.0' },
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
          // MCPL RFC-011: every channel posts exactly where it is asked.
          capabilities: { publish: { target: 'root' } },
        })),
      },
    });
    return;
  }
  if (msg.method === 'channels/open') {
    log('channel-opened', { channelId: msg.params?.channelId });
    reply(msg.id, { opened: true });
    return;
  }
  if (msg.method === 'channels/close') {
    reply(msg.id, { closed: true });
    return;
  }
  if (msg.method === 'channels/publish') {
    log('publish', { channelId: msg.params?.channelId });
    // RFC-011: a delivery echoes the place it was asked for.
    const placed = msg.params && 'threadId' in msg.params ? { threadId: msg.params.threadId } : {};
    if (msg.id !== undefined && msg.id !== null) reply(msg.id, { delivered: true, ...placed });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [] });
    return;
  }
  // Responses to our own requests (register, incoming, push) need no handling.
});
