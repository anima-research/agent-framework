// MCPL server for test/mcpl-reconnect-registration.test.ts.
//
// Like a chat bridge, it registers its channel as soon as the host sends
// notifications/initialized, before the host's §5.3 policy Request is
// answered, and appends the host's answer to that registration to
// EVENTS_PATH. When CRASH_PATH appears it removes the file and exits, once,
// so the host's reconnect starts a fresh process that registers again.
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';

const eventsPath = process.env.EVENTS_PATH;
const crashPath = process.env.CRASH_PATH;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const event = (name, extra = {}) => {
  if (eventsPath) appendFileSync(eventsPath, JSON.stringify({ event: name, pid: process.pid, ...extra }) + '\n');
};

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let newline;
  while ((newline = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
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
        },
      });
    } else if (message.method === 'notifications/initialized') {
      send({
        jsonrpc: '2.0',
        id: 100,
        method: 'channels/register',
        params: { channels: [{ id: 'chat:room-1', type: 'chat', label: 'room-1', direction: 'bidirectional' }] },
      });
    } else if (message.method === 'featureSets/update') {
      if (message.id !== undefined && message.id !== null) send({ jsonrpc: '2.0', id: message.id, result: { accepted: true } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    } else if (message.id === 100 && message.method === undefined) {
      event('register-answered', { error: message.error ?? null });
    }
  }
});

const timer = setInterval(() => {
  if (crashPath && existsSync(crashPath)) {
    unlinkSync(crashPath);
    event('crashing');
    process.exit(9);
  }
}, 5);
timer.unref();
