// MCPL fixture for tune-out e2e tests (issue #77).
//
// Registers one channel (`disc:guild:noisy`, initiallyOpen), or one
// `disc:guild:<label>` per label in CHANNELS (comma-separated, the first the
// default), and then emits channel traffic on command: the TEST appends lines
// to COMMAND_PATH (`ambient <id> <text>` / `addressed <id> <text>`, or
// `ambient@<label> …` for another channel), the fixture polls the
// file and sends a channels/incoming Request per line, once the line's
// newline is written (writtenLines). Host-side
// channels/acknowledge calls are recorded to STATUS_PATH as JSONL — the
// test asserts the deterministic suppressed-mention reaction there. It keeps
// its channels' lifecycle as a server does: channels/open and channels/close
// are recorded there too, and while the host has a channel closed, a
// commanded message for it isn't sent (recorded as withheld).
import { appendFileSync } from 'node:fs';
import { writtenLines } from './command-lines.mjs';
import { createInterface } from 'node:readline';

const statusPath = process.env.STATUS_PATH;
const commandPath = process.env.COMMAND_PATH;

const log = (event, extra = {}) => {
  if (!statusPath) return;
  appendFileSync(statusPath, JSON.stringify({ event, ...extra }) + '\n');
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const LABELS = (process.env.CHANNELS ?? 'noisy').split(',');
const channelIdOf = (label) => `disc:guild:${label}`;
let nextId = 500;
let processedCommands = 0;
// Registered initiallyOpen, so each is open until the host closes it.
const closed = new Set();

function pollCommands() {
  const lines = writtenLines(commandPath);
  for (const line of lines.slice(processedCommands)) {
    processedCommands++;
    const [kindAt, messageId, ...rest] = line.split(' ');
    const [kind, label = LABELS[0]] = kindAt.split('@');
    const channelId = channelIdOf(label);
    const text = rest.join(' ');
    const tags = kind === 'addressed'
      ? ['chat:mention', 'chat:from-human']
      : ['chat:ambient', 'chat:from-human'];
    if (closed.has(channelId)) {
      log('incoming-withheld', { kind, messageId });
      continue;
    }
    log('incoming-sent', { kind, messageId });
    send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'channels/incoming',
      params: {
        messages: [{
          channelId,
          messageId,
          author: { id: 'U1', name: 'antra' },
          timestamp: new Date().toISOString(),
          content: [{ type: 'text', text }],
          tags,
        }],
      },
    });
  }
}
// tune-out-e2e's two-part pin pauses four of these between a line's parts.
const pollTimer = setInterval(pollCommands, 100);

const rl = createInterface({ input: process.stdin });
// Exit when the host closes the transport — a real connector dies with its
// pipe, and the poll timer must not keep this process (and the test run)
// alive past teardown.
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
            channels: {
              register: true,
              lifecycle: true,
              incoming: true,
              publish: true,
              acknowledge: true,
            },
            featureSets: {
              chat: { description: 'chat connector', uses: ['channels.incoming', 'channels.publish'] },
            },
          },
        },
      },
      serverInfo: { name: 'tune-out-fixture', version: '0.0.0' },
    });
    return;
  }
  if (msg.method === 'featureSets/update') {
    // §5.3: answer the initial-policy Request or the grant never activates.
    if (msg.id !== undefined && msg.id !== null) reply(msg.id, { accepted: true });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    send({
      jsonrpc: '2.0',
      id: 400,
      method: 'channels/register',
      params: {
        channels: LABELS.map((label) => ({
          id: channelIdOf(label),
          type: 'disc',
          label,
          direction: 'bidirectional',
          initiallyOpen: true,
        })),
      },
    });
    return;
  }
  if (msg.method === 'channels/open') {
    log('channel-opened', { channelId: msg.params?.channelId });
    closed.delete(msg.params?.channelId);
    reply(msg.id, { opened: true });
    return;
  }
  if (msg.method === 'channels/close') {
    log('channel-closed', { channelId: msg.params?.channelId });
    closed.add(msg.params?.channelId);
    reply(msg.id, { closed: true });
    return;
  }
  if (msg.method === 'channels/acknowledge') {
    log('acknowledge', {
      channelId: msg.params?.channelId,
      messageId: msg.params?.messageId,
      intent: msg.params?.intent,
    });
    reply(msg.id, { acknowledged: true, representation: '👀' });
    return;
  }
  if (msg.method === 'channels/publish') {
    log('publish', { channelId: msg.params?.channelId });
    if (msg.id !== undefined && msg.id !== null) reply(msg.id, { delivered: true });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [] });
    return;
  }
  // Responses to our own requests (register, incoming) need no handling.
});
