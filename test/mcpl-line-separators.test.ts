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
      process.stdout.write('   \n');
      process.stdout.write('\n');
      process.stdout.write(' \t{"jsonrpc":"2.0"\n');
      send({jsonrpc:'2.0', id:request.id, result:{protocolVersion:'2024-11-05', capabilities:{tools:{}}}});
    } else if (request.method === 'tools/list') {
      process.stdout.write(' \t \n');
      process.stdout.write('42\n');
      process.stdout.write('not json at all\n');
      process.stdout.write('[]\n');
      send({jsonrpc:'2.0', id:request.id, result:{tools:[]}});
    }
  }
});
`;

test('a stdio connection logs the first three lines it drops, in the handshake and once connected, by length and why, never content, then one line says more go unlogged; blank lines are neither logged nor counted', async () => {
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
  const dropped = (length: number, why: string) => `MCP server "dropping" sent a line of length ${length} that ${why}, so it was dropped`;
  const notJson = "isn't JSON";
  const brokenJson = "starts like a JSON object but doesn't parse";
  const notObject = 'is JSON but not an object';
  assert.deepEqual(logged, [
    dropped(17, notJson), dropped(18, brokenJson), dropped(2, notObject),
    'MCP server "dropping" sent another line that isn\'t a JSON object, so it was dropped; more such lines on this connection are dropped without a log line',
  ]);
});

test('once the host closes a stdio transport, a line its child writes after the close is not delivered', async () => {
  const transport = await StdioTransport.spawn({
    id: 'closing', command: process.execPath,
    // On the close's SIGTERM the child writes a line and exits once it's out.
    args: ['-e', String.raw`process.on('SIGTERM', () => process.stdout.write('{"after":"close"}\n', () => process.exit(0))); process.stdout.write('{"ready":true}\n'); setInterval(() => {}, 1000);`],
  });
  const lines: string[] = [];
  const ready = new Promise<void>((resolve) => transport.on('line', (line: string) => { lines.push(line); resolve(); }));
  await ready;
  await transport.close();
  assert.deepEqual(lines, ['{"ready":true}']);
});

test('a line the host writes to a stdio server carries U+2028 and U+2029 escaped, and parses back to the same message', async () => {
  const recordingServer = String.raw`
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    process.stderr.write('WROTE ' + Buffer.from(input.slice(0, end), 'utf8').toString('hex') + '\n');
    input = input.slice(end + 1);
  }
});
setInterval(() => {}, 1000);
`;
  const transport = await StdioTransport.spawn({ id: 'recording', command: process.execPath, args: ['-e', recordingServer] });
  try {
    const heard = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the recording server heard no line within 10 s')), 10_000);
      transport.on('stderr', (line: string) => {
        if (!line.startsWith('WROTE ')) return;
        clearTimeout(timer);
        resolve(line.slice('WROTE '.length));
      });
    });
    const request = { jsonrpc: '2.0', id: 7, method: 'channels/publish', params: { channelId: 'c1', content: [{ type: 'text', text: 'one\u2028two\u2029three' }] } };
    transport.writeLine(JSON.stringify(request));
    const written = Buffer.from(await heard, 'hex').toString('utf8');
    assert.equal(/[\u2028\u2029]/.test(written), false, written);
    assert.deepEqual(JSON.parse(written), request);
  } finally {
    await transport.close();
  }
});
