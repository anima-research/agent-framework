// Fake Discord MCPL server for test/surgery-marks-receipt.test.ts.
//
// Every tools/call is appended to CALLS_PATH. While HOLD_PATH is set and that
// file does not exist, replies are withheld, standing in for Discord pacing a
// long reaction drain. When PROBE_PATH appears, the server sends one
// inference-bearing channels/incoming request and appends to EVENTS_PATH when
// the host answers it, so a test can see whether the MCPL data plane was held.
import { appendFileSync, existsSync } from 'node:fs';

const callsPath = process.env.CALLS_PATH;
const eventsPath = process.env.EVENTS_PATH;
const holdPath = process.env.HOLD_PATH;
const probePath = process.env.PROBE_PATH;
const channelId = process.env.CHANNEL_ID ?? 'discord:g1:c1';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const request = (id, method, params) => send({ jsonrpc: '2.0', id, method, params });
const event = (name, extra = {}) => {
  if (eventsPath) appendFileSync(eventsPath, JSON.stringify({ event: name, at: Date.now(), ...extra }) + '\n');
};

const held = [];
let probed = false;
let buf = '';

function answer(message) {
  event('reaction-answered', { messageId: message.params?.arguments?.messageId });
  reply(message.id, { content: [{ type: 'text', text: 'Reaction applied' }] });
}

function handle(message) {
  if (message.method === 'initialize') {
    reply(message.id, {
      capabilities: {
        experimental: {
          mcpl: {
            version: '0.5',
            pushEvents: true,
            channels: { register: true, incoming: true },
            featureSets: { chat: { description: 'chat', uses: ['pushEvents'] } },
          },
        },
      },
    });
    return;
  }
  if (message.method === 'featureSets/update') {
    if (message.id !== undefined && message.id !== null) reply(message.id, { accepted: true });
    return;
  }
  if (message.method === 'notifications/initialized') {
    request(100, 'channels/register', {
      channels: [{ id: channelId, type: 'discord', label: 'busy', direction: 'bidirectional' }],
    });
    return;
  }
  if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [
        { name: 'add_reaction', description: 'add', inputSchema: { type: 'object' } },
        { name: 'remove_reaction', description: 'remove', inputSchema: { type: 'object' } },
      ],
    });
    return;
  }
  if (message.method === 'tools/call') {
    if (callsPath) {
      appendFileSync(callsPath, JSON.stringify({ at: Date.now(), name: message.params?.name, args: message.params?.arguments }) + '\n');
    }
    if (holdPath && !existsSync(holdPath)) held.push(message);
    else answer(message);
    return;
  }
  if (message.id === 900) {
    event('probe-answered', { error: message.error ?? null });
  }
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let newline;
  while ((newline = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      event('server-error', { message: error instanceof Error ? error.message : String(error) });
    }
  }
});

const timer = setInterval(() => {
  if (held.length > 0 && holdPath && existsSync(holdPath)) {
    for (const message of held.splice(0)) answer(message);
  }
  if (!probed && probePath && existsSync(probePath)) {
    probed = true;
    event('probe-sent');
    request(900, 'channels/incoming', {
      messages: [{
        channelId,
        messageId: 'probe-during-delivery',
        author: { id: 'bystander', name: 'Bystander' },
        timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: 'ordinary traffic while marks are delivered' }],
      }],
    });
  }
}, 5);
timer.unref();
