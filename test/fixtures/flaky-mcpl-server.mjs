// Minimal MCP server for reconnect tests.
//
// Availability is controlled by a flag file passed as argv[2]: when the file
// does not exist the process exits(1) immediately (simulating a server that
// loses the boot race); when it exists the process answers the MCP
// `initialize` handshake and stays alive.
//
// Receiving a `tools/list` request makes it exit(7) — tests use this as a
// remote-controlled crash to exercise the unexpected-exit reconnect path.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const flagFile = process.argv[2];
if (flagFile && !existsSync(flagFile)) process.exit(1);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            experimental: { mcpl: { version: '0.5', pushEvents: true } },
          },
          serverInfo: { name: 'flaky-mcpl-server', version: '0.0.0' },
        },
      }) + '\n',
    );
  } else if (msg.method === 'tools/list') {
    process.exit(7);
  }
});
