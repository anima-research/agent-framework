// MCPL fixture for the tool-resolution tests (#227, #230).
//
// Lists the tools named in the comma-separated env TOOLS, and answers a
// tools/call with "<NAME>:<tool>", so a caller can tell which server it
// reached and the tool name that server was sent.
import { createInterface } from 'node:readline';

const NAME = process.env.NAME ?? 'server';
const TOOLS = (process.env.TOOLS ?? '').split(',').filter(Boolean)
  .map((name) => ({ name, description: `${name} on ${NAME}`, inputSchema: { type: 'object', properties: {} } }));

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, experimental: { mcpl: { version: '0.5' } } },
      serverInfo: { name: `tool-listing-${NAME}`, version: '0.0.0' },
    });
    return;
  }
  if (msg.method === 'tools/list') { reply(msg.id, { tools: TOOLS }); return; }
  if (msg.method === 'tools/call') { reply(msg.id, { content: [{ type: 'text', text: `${NAME}:${msg.params?.name}` }] }); return; }
  if (msg.id !== undefined && msg.id !== null && msg.method) reply(msg.id, {});
});
