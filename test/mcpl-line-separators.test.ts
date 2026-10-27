import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { StdioTransport } from '../src/mcpl/transport.js';

const listingServer = String.raw`
const sep = { space: ' ', u2028: '\u2028', u2029: '\u2029' }[process.argv[1]];
let input = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      send({jsonrpc:'2.0', id:request.id, result:{protocolVersion:'2024-11-05', capabilities:{tools:{}}}});
    } else if (request.method === 'tools/list') {
      send({jsonrpc:'2.0', method:'notifications/tools/list_changed', params:{sequence:1}});
      send({jsonrpc:'2.0', method:'notifications/tools/list_changed', params:{sequence:2, note:'one' + sep + 'two'}});
      send({jsonrpc:'2.0', method:'notifications/tools/list_changed', params:{sequence:3}});
      send({jsonrpc:'2.0', id:request.id, result:{tools:[{name:'t', description:'one' + sep + 'two', inputSchema:{type:'object', properties:{}}}]}});
    }
  }
});
`;

for (const [name, sep] of [['U+2028', 'u2028'], ['U+2029', 'u2029']] as const) {
  test(`a stdio server's notification and response holding ${name} inside a string arrive whole`, async () => {
    const connection = await McplServerConnection.connect({
      id: 'separators', command: process.execPath, args: ['-e', listingServer, sep], requestTimeoutMs: 5_000,
    }, { version: '0.5' });
    try {
      const received: unknown[] = [];
      connection.on('tools-list-changed', (params: unknown) => received.push(params));
      connection.ready();
      const { tools } = await connection.sendToolsList();
      const text = `one${sep === 'u2028' ? '\u2028' : '\u2029'}two`;
      assert.equal(tools[0]?.description, text);
      assert.deepEqual(received, [{ sequence: 1 }, { sequence: 2, note: text }, { sequence: 3 }]);
    } finally {
      await connection.close();
    }
  });
}

const droppingServer = String.raw`
let input = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write('handshake chatter\n');
      process.stdout.write('[]\n');
      send({jsonrpc:'2.0', id:request.id, result:{protocolVersion:'2024-11-05', capabilities:{tools:{}}}});
    } else if (request.method === 'tools/list') {
      process.stdout.write('not json at all\n');
      process.stdout.write('42\n');
      process.stdout.write('\u{1F600} not json\n');
      process.stdout.write('\u2028\n');
      process.stdout.write(' \t \n');
      process.stdout.write('\n');
      send({jsonrpc:'2.0', id:request.id, result:{tools:[]}});
    }
  }
});
`;

test('a line a connection drops because it is not a JSON object is logged by its length in characters, never its content, in the handshake and once connected; a blank one is not', async () => {
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const connection = await McplServerConnection.connect({
      id: 'dropping', command: process.execPath, args: ['-e', droppingServer], requestTimeoutMs: 5_000,
    }, { version: '0.5' });
    try {
      connection.ready();
      assert.deepEqual(await connection.sendToolsList(), { tools: [] });
    } finally {
      console.error = realError;
      await connection.close();
    }
  } finally {
    console.error = realError;
  }
  const dropped = (length: number) => `MCP server "dropping" sent a line of length ${length} that isn't a JSON object, so it was dropped`;
  assert.deepEqual(logged, [dropped(17), dropped(2), dropped(15), dropped(2), dropped(10), dropped(1)]);
});

test('once the host closes a stdio transport, a line its child writes after the close is not delivered', async () => {
  const transport = await StdioTransport.spawn({
    id: 'closing', command: process.execPath,
    args: ['-e', String.raw`process.on('SIGTERM', () => process.stdout.write('{"after":"close"}\n')); process.stdout.write('{"ready":true}\n'); setInterval(() => {}, 1000);`],
  });
  const lines: string[] = [];
  const ready = new Promise<void>((resolve) => transport.on('line', (line: string) => { lines.push(line); resolve(); }));
  await ready;
  await transport.close();
  assert.deepEqual(lines, ['{"ready":true}']);
});
