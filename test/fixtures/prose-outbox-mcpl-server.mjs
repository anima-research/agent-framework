// Chat-platform MCPL server for prose-outbox end-to-end tests.
//
// Registers one open channel ("chat:room") after initialize and executes
// channels/publish. POST_LOG is the platform's message history (JSONL); it
// outlives the process, like a real channel does. MODE_FILE is re-read on
// every publish:
//   "ok"             post and answer
//   "crash"          post, then exit before answering (in-flight disconnect)
// With "idem" in the mode, a publish whose idempotencyKey is already in the
// history returns the original message instead of posting again (the
// history check a real connector does after a restart), and results echo the
// key.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const postLog = process.env.POST_LOG;
const modeFile = process.env.MODE_FILE;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const history = () => existsSync(postLog)
  ? readFileSync(postLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

function publish(message) {
  const mode = readFileSync(modeFile, 'utf8');
  const idem = mode.includes('idem');
  const { idempotencyKey: key, writtenAt, content } = message.params;
  if (idem && key) {
    const prior = history().find((p) => p.key === key);
    if (prior) {
      reply(message.id, { delivered: true, messageId: prior.id, idempotencyKey: key });
      return;
    }
  }
  const id = `msg-${history().length + 1}`;
  appendFileSync(postLog, JSON.stringify({ id, text: content[0].text, key, writtenAt }) + '\n');
  if (mode.startsWith('crash')) process.exit(3);
  reply(message.id, { delivered: true, messageId: id, ...(idem && key ? { idempotencyKey: key } : {}) });
}

// send_message tool: same history-backed dedupe via tools/call _meta.
function sendTool(message) {
  const mode = readFileSync(modeFile, 'utf8');
  const idem = mode.includes('idem');
  const meta = message.params._meta ?? {};
  const key = meta.idempotencyKey;
  const args = message.params.arguments ?? {};
  if (mode.startsWith('crash-before')) process.exit(4); // dies without posting
  if (idem && key) {
    const prior = history().find((p) => p.key === key);
    if (prior) {
      reply(message.id, { content: [{ type: 'text', text: `sent ${prior.id}` }], _meta: { idempotencyKey: key } });
      return;
    }
  }
  const id = `msg-${history().length + 1}`;
  appendFileSync(postLog, JSON.stringify({ id, text: args.content, key, writtenAt: meta.writtenAt, via: 'send_message', delayReason: meta.delayReason }) + '\n');
  if (mode.startsWith('crash')) process.exit(3);
  reply(message.id, { content: [{ type: 'text', text: `sent ${id}` }], ...(idem && key ? { _meta: { idempotencyKey: key } } : {}) });
}

function handle(message) {
  if (message.method === 'initialize') {
    reply(message.id, {
      capabilities: {
        experimental: {
          mcpl: { version: '0.5', channels: { register: true, lifecycle: true, publish: true, incoming: true } },
        },
      },
    });
  } else if (message.method === 'notifications/initialized') {
    send({
      jsonrpc: '2.0', id: 900, method: 'channels/register',
      params: { channels: [{ id: 'chat:room', type: 'chat', label: 'room', direction: 'bidirectional', initiallyOpen: true }] },
    });
  } else if (message.method === 'channels/publish') {
    publish(message);
  } else if (message.method === 'channels/open') {
    reply(message.id, { channel: { id: message.params.channelId, type: 'chat', label: 'room' } });
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: [{ name: 'send_message', description: 'send', inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, content: { type: 'string' } } } }] });
  } else if (message.method === 'tools/call' && message.params?.name === 'send_message') {
    sendTool(message);
  } else if (message.method === 'featureSets/update') {
    if (message.id !== undefined && message.id !== null) reply(message.id, { accepted: true });
  } else if (message.id !== undefined && message.id !== null && message.method) {
    reply(message.id, {});
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore malformed */ }
  }
});
setInterval(() => {}, 1 << 30);
