// MCPL fixture for the configuration-diagnostics tests.
//
// Offers two tools, `click` and `run`. Optional behavior via env:
//   GATE_PATH     exit(1) at startup while this file does not exist — a
//                 server that loses the boot race and connects later on a
//                 reconnect attempt.
//   FEATURE_SETS  JSON object merged into the advertised MCPL featureSets.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.GATE_PATH && !existsSync(process.env.GATE_PATH)) process.exit(1);

const featureSets = process.env.FEATURE_SETS ? JSON.parse(process.env.FEATURE_SETS) : undefined;
const TOOLS = [
  { name: 'click', description: 'Click at a point', inputSchema: { type: 'object', properties: {} } },
  { name: 'run', description: 'Run something', inputSchema: { type: 'object', properties: {} } },
];

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    const mcpl = { version: '0.5', ...(featureSets ? { featureSets } : {}) };
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, experimental: { mcpl } },
      serverInfo: { name: 'config-diagnostics', version: '0.0.0' },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === 'featureSets/update') {
    if (msg.id !== undefined && msg.id !== null) reply(msg.id, { accepted: true });
    return;
  }
  if (msg.id !== undefined && msg.id !== null && msg.method) reply(msg.id, {});
});
