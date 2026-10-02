// Runs as a separate host process: an uncaught inbound exception fails the test.
import assert from 'node:assert/strict';
import { McplServerConnection } from '../../src/mcpl/server-connection.js';

const mode = process.argv[2];
const server = String.raw`
let input = '';
const values = ['null', '42', '"hi"', 'true', '[]'];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      if (process.argv[1] === 'handshake') {
        for (const value of values) process.stdout.write(value + '\n');
      }
      send({jsonrpc:'2.0', id:request.id, result:{capabilities:{}}});
    } else if (request.method === 'tools/list') {
      if (process.argv[1] === 'connected') {
        for (const value of values) process.stdout.write(value + '\n');
      }
      send({jsonrpc:'2.0', method:'notifications/tools/list_changed', params:{sequence:1}});
      send({jsonrpc:'2.0', method:'notifications/tools/list_changed', params:{sequence:2}});
      send({jsonrpc:'2.0', id:request.id, result:{tools:[]}});
    }
  }
});
`;
const connection = await McplServerConnection.connect({
  id: 'probe', command: process.execPath, args: ['-e', server, mode], requestTimeoutMs: 1000,
}, { version: '0.5' });
try {
  const received = [];
  connection.on('tools-list-changed', (params) => {
    if (mode === 'throwing-listener' && params.sequence === 1) throw new Error('injected sync notification failure');
    received.push(params.sequence);
  });
  // Deliberately no connection error subscriber: diagnostics must not throw.
  connection.ready();
  assert.deepEqual(await connection.sendToolsList(), { tools: [] });
  assert.deepEqual(received, mode === 'throwing-listener' ? [2] : [1, 2]);
  console.log('continued');
} finally {
  await connection.close();
}
