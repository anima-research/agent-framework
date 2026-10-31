// A neutral peer with a control tunnel for real server-to-host RPC.
import { createInterface } from 'node:readline';
let next = 1000;
const waiting = new Map();
const seen = [];
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) { const reply = waiting.get(m.id); if (reply) { waiting.delete(m.id); reply(m); } return; }
  seen.push({ method: m.method, params: m.params });
  const reply = result => write({ id: m.id, result });
  if (m.method === 'initialize') {
    reply({ protocolVersion: '2024-11-05', capabilities: { tools: {}, experimental: { mcpl: {
      version: '0.5', pushEvents: true, inferenceRequest: true,
      channels: { register: true, incoming: true, publish: true, lifecycle: true },
      featureSets: { feed: { description: 'Feed', uses: ['pushEvents', 'inferenceRequest'] } },
    } } } });
  } else if (m.method === 'tools/list') reply({ tools: [] });
  else if (m.method === 'featureSets/update') reply({ accepted: true });
  else if (m.method === 'channels/publish') reply({ delivered: true, messageId: `published-${next++}` });
  else if (m.method === 'channels/open') reply({ channel: { id: m.params.channelId, type: 'synthetic', label: m.params.channelId } });
  else if (m.method === 'channels/close') reply({ closed: true });
  else if (m.method === 'tools/call') {
    const args = m.params.arguments;
    if (m.params.name === 'seen') { reply(seen); return; }
    const id = next++;
    if (args.notify) { write({ method: args.method, params: args.params }); reply({ sent: true }); }
    else { waiting.set(id, reply); write({ id, method: args.method, params: args.params }); }
  } else if (m.id !== undefined) reply({});
});
