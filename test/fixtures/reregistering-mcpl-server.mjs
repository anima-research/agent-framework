// MCPL server for test/mcpl-reconnect-registration.test.ts.
//
// Like a chat bridge, it registers its channel as soon as the host sends
// notifications/initialized, before the host's §5.3 policy Request is
// answered, and appends the host's answer to that registration (and its own
// steps) to EVENTS_PATH, tagged with ROLE. Optional coordination, each by
// file so tests order steps without timing:
// - CRASH_PATH: when it appears, remove it and exit (once), so the host
//   reconnects to a fresh process;
// - FAIL_FIRST_PATH: if it is missing at initialize, create it and exit, so
//   the host's first connect fails and its retry succeeds;
// - INITIALIZE_AFTER_PATH: answer initialize only once it exists;
// - POLICY_PENDING_PATH / POLICY_RELEASE_PATH: on the policy Request, create
//   the first, and answer only once the second exists.
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';

const {
  EVENTS_PATH: eventsPath,
  ROLE: role = 'server',
  CRASH_PATH: crashPath,
  FAIL_FIRST_PATH: failFirstPath,
  INITIALIZE_AFTER_PATH: initializeAfterPath,
  POLICY_PENDING_PATH: policyPendingPath,
  POLICY_RELEASE_PATH: policyReleasePath,
} = process.env;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const event = (name, extra = {}) => {
  if (eventsPath) appendFileSync(eventsPath, JSON.stringify({ event: name, role, pid: process.pid, ...extra }) + '\n');
};
const once = (path, fn) => {
  if (!path || existsSync(path)) return fn();
  const timer = setInterval(() => {
    if (!existsSync(path)) return;
    clearInterval(timer);
    fn();
  }, 5);
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
      if (failFirstPath && !existsSync(failFirstPath)) {
        writeFileSync(failFirstPath, '1');
        event('initial-fail');
        process.exit(9);
      }
      once(initializeAfterPath, () => send({
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
      }));
    } else if (message.method === 'notifications/initialized') {
      send({
        jsonrpc: '2.0',
        id: 100,
        method: 'channels/register',
        params: { channels: [{ id: `chat:${role}`, type: 'chat', label: role, direction: 'bidirectional' }] },
      });
      event('register-sent');
    } else if (message.method === 'featureSets/update') {
      if (message.id === undefined || message.id === null) continue;
      if (policyPendingPath) {
        writeFileSync(policyPendingPath, '1');
        event('policy-held');
      }
      once(policyReleasePath, () => {
        event('policy-answered');
        send({ jsonrpc: '2.0', id: message.id, result: { accepted: true } });
      });
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
