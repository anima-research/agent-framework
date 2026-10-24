// MCPL fixture for hook-injection tests: answers context/beforeInference with
// one injection whose text is TEXT_JSON's, at POSITION ('beforeUser', 'afterUser' or
// 'system'), as a string when SHAPE is 'string', as a block whose type is the
// text when SHAPE is 'unknown-type', and as a text block otherwise.
// It lists one tool, `ready`, so a test can tell it's connected.
import { createInterface } from 'node:readline';

const position = process.env.POSITION || 'beforeUser';
// TEXT_JSON is the text as JSON: an environment variable can't carry a lone
// UTF-16 surrogate, which the JSON escape can.
const text = process.env.TEXT_JSON ? JSON.parse(process.env.TEXT_JSON) : '';
// NAMESPACE_JSON, the same way, is the injection's namespace; 'notes' without it.
const namespace = process.env.NAMESPACE_JSON ? JSON.parse(process.env.NAMESPACE_JSON) : 'notes';
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
      capabilities: {
        tools: {},
        experimental: {
          mcpl: {
            version: '0.5',
            contextHooks: { beforeInference: { inject: { [position]: true } } },
            featureSets: {
              notes: { description: 'injects a note', uses: [`contextHooks.beforeInference.inject.${position}`] },
            },
          },
        },
      },
      serverInfo: { name: 'hook-injection-fixture', version: '0.0.0' },
    });
    return;
  }
  if (msg.method === 'context/beforeInference') {
    const content = process.env.SHAPE === 'string' ? text
      : process.env.SHAPE === 'unknown-type' ? [{ type: text }]
        : [{ type: 'text', text }];
    reply(msg.id, { featureSet: 'notes', contextInjections: [{ namespace, position, content }] });
    return;
  }
  if (msg.method === 'tools/list') {
    // A tool the test waits for, which says the server is connected.
    reply(msg.id, { tools: [{ name: 'ready', description: 'Says the fixture is connected.', inputSchema: { type: 'object', properties: {} } }] });
    return;
  }
  if (msg.id !== undefined && msg.id !== null && msg.method) reply(msg.id, {});
});
