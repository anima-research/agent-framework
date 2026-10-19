// Runs as a separate host process: an uncaught exception ends it, as it would end a host.
import assert from 'node:assert/strict';
import { McplServerConnection } from '../../src/mcpl/server-connection.js';

// A server that answers initialize with an error whose message is an object
// with no primitive form, so a template literal can't convert it.
const server = String.raw`
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const request = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32603, message:{toString:1, valueOf:1}}}) + '\n');
    }
  }
});
`;
let timer;
const outcome = await Promise.race([
  McplServerConnection.connect({ id: 'probe', command: process.execPath, args: ['-e', server] }, { version: '0.5' })
    .then(() => 'connected', (error) => error),
  new Promise((resolve) => { timer = setTimeout(resolve, 10_000, 'still pending after 10 s'); }),
]);
clearTimeout(timer);
assert.ok(outcome instanceof Error, String(outcome));
assert.equal(outcome.message, 'MCPL server "probe" initialize error: [object Object]');
console.log('refused');
