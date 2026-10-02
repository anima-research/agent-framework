// A real stdio child exposing the environment it received from the framework.
import { createInterface } from 'node:readline';

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.id === null || !msg.method) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, experimental: { mcpl: { version: '0.5' } } },
      serverInfo: { name: 'reaction-baseline', version: '0.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{ name: 'read_env', description: 'Read fixture environment', inputSchema: { type: 'object', properties: {} } }] });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({
      baseline: process.env.DISCORD_SUPPRESSED_REACTIONS_BASELINE,
      extra: process.env.BASELINE_TEST_EXTRA,
    }) }] });
  } else {
    reply(msg.id, { accepted: true });
  }
});
