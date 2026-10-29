// Neutral stdio peer. tools/call is a control tunnel for real peer-originated RPC.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
let next = 1000;
const waiting = new Map();
const seen = [];
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) { const reply = waiting.get(m.id); if (reply) { waiting.delete(m.id); reply(m); } return; }
  seen.push(m.method);
  if (process.env.TRANSCRIPT) appendFileSync(process.env.TRANSCRIPT, m.method + '\n');
  const reply = result => write({ id: m.id, result });
  if (m.method === 'initialize') {
    reply({ protocolVersion: process.env.PROTOCOL ?? '2024-11-05', proof: { version: 1 }, capabilities: { tools: {}, experimental: { mcpl: {
      version: '0.5', pushEvents: true, inferenceRequest: true,
      channels: { register: true, incoming: true, publish: true, typing: true },
      featureSets: { feed: { description: 'Feed', uses: ['pushEvents', 'inferenceRequest'] } },
    } } } });
  } else if (m.method === 'tools/list') reply({ tools: [] });
  else if (m.method === 'featureSets/update') reply({ accepted: true });
  else if (m.method === 'tools/call') {
    const args = m.params.arguments;
    if (m.params.name === 'seen') { reply(seen); return; }
    const id = next++;
    if (args.notify) { write({ method: args.method, params: args.params }); reply({ sent: true }); }
    else { waiting.set(id, reply); write({ id, method: args.method, params: args.params }); }
  } else if (m.id !== undefined) reply({});
});
