/**
 * An inbound message's envelope (#475): a request is a message with an id
 * member, whatever its value, so `"id": null` is a request and is answered
 * with id null, held and flushed or refused as any request is; a message
 * with an id and no method is a response, whatever the id's value, and so
 * is a JSON-RPC 2.0 error with no id, as MCP allows; a response is never
 * answered, and one whose id can't be matched is logged, during the
 * handshake too, except that an error with id null or none then answers
 * initialize, and the connect fails at once; any other object with neither
 * a method nor an id isn't JSON-RPC, so it's ignored, as a JSON value that
 * isn't an object is, a batch included. A message whose id isn't a string,
 * a number or null, or whose method isn't a string, with or without an id,
 * is answered once with -32600, carrying its id where that's a string or a
 * number and null otherwise, and isn't dispatched. Real connection routing
 * and response encoding, and stdio servers for the handshake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';

class ResponseTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void { this.lines.push(line); }
  async close(): Promise<void> {}
}

type Reply = { jsonrpc: string; id: unknown; result?: unknown; error?: { code: number; message: string } };

/** A ready connection with every capability granted, a channels/list
 *  handler that answers, and what it was handed. */
function wire(t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown } }) {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  connection.ready();
  const handled: Array<{ params: unknown; responder: { id: unknown; respond?: unknown } | undefined }> = [];
  connection.on('channels-list', (params: unknown, responder?: { id: unknown; respond: (r: unknown) => void }) => {
    handled.push({ params, responder });
    responder?.respond({ channels: [] });
  });
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const send = (msg: unknown) => transport.emit('line', JSON.stringify(msg));
  const replies = (): Reply[] => transport.lines.map((line) => JSON.parse(line));
  return { connection, transport, send, replies, handled, logged };
}

test('a request with id null is answered, with id null', (t) => {
  const { send, replies, handled } = wire(t);
  send({ jsonrpc: '2.0', id: null, method: 'channels/list', params: {} });
  send({ jsonrpc: '2.0', id: null, method: 'scope/elevate', params: {} });
  send({ jsonrpc: '2.0', id: null, method: 'featureSets/changed', params: {} });
  assert.equal(handled.length, 1);
  assert.equal(typeof handled[0]!.responder?.respond, 'function', 'dispatched as a request, with a responder');
  assert.equal(handled[0]!.responder?.id, null);
  assert.deepEqual(replies(), [
    { jsonrpc: '2.0', id: null, result: { channels: [] } },
    { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'scope/elevate removed in MCPL 0.5.0 (SPEC §7)' } },
    { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'featureSets/changed removed in MCPL 0.5.0 (superseded by mcpl/manifestChanged, SPEC §17)' } },
  ]);
});

test('a request with id null held while the planes are paused is answered with id null when they open', async () => {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  connection.on('channels-list', (_params: unknown, responder?: { respond: (r: unknown) => void }) => responder?.respond({ channels: [] }));
  // Before ready() both planes are closed, as at startup.
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: null, method: 'channels/list', params: {} }));
  assert.deepEqual(transport.lines, [], 'held, not answered or dropped');
  connection.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.lines.map((line) => JSON.parse(line)), [{ jsonrpc: '2.0', id: null, result: { channels: [] } }]);
});

test('a request with id null for an event the grant refuses gets the refusal, with id null', (t) => {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(), []));
  connection.ready();
  t.mock.method(console, 'error', () => {});
  let handled = false;
  connection.on('channels-list', () => { handled = true; });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: null, method: 'channels/list', params: {} }));
  const replies = transport.lines.map((line) => JSON.parse(line));
  assert.equal(handled, false);
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code]), [[null, -32002]]);
});

test('a message with no id member is a notification: dispatched with no responder, and not answered', (t) => {
  const { send, replies, handled } = wire(t);
  send({ jsonrpc: '2.0', method: 'channels/list', params: { n: 1 } });
  assert.deepEqual(handled, [{ params: { n: 1 }, responder: undefined }]);
  assert.deepEqual(replies(), []);
});

test("an id that isn't a string, a number or null: one -32600 with id null, and nothing is dispatched", (t) => {
  const { send, replies, handled, logged } = wire(t);
  const ids = [{ nested: [1] }, [1], true, false];
  for (const id of ids) send({ jsonrpc: '2.0', id, method: 'channels/list', params: {} });
  assert.equal(handled.length, 0);
  assert.deepEqual(replies().map((r) => [r.id, r.error?.code, r.error?.message, 'result' in r]), [
    [null, -32600, 'Invalid Request: the id must be a string, a number or null, not an object', false],
    [null, -32600, 'Invalid Request: the id must be a string, a number or null, not an array', false],
    [null, -32600, 'Invalid Request: the id must be a string, a number or null, not a boolean', false],
    [null, -32600, 'Invalid Request: the id must be a string, a number or null, not a boolean', false],
  ]);
  assert.deepEqual(logged, [
    '[mcpl] srv: answered -32600 to an invalid request for method channels/list: the id must be a string, a number or null, not an object',
    '[mcpl] srv: answered -32600 to an invalid request for method channels/list: the id must be a string, a number or null, not an array',
    '[mcpl] srv: answered -32600 to an invalid request for method channels/list: the id must be a string, a number or null, not a boolean',
    '[mcpl] srv: answered -32600 to an invalid request for method channels/list: the id must be a string, a number or null, not a boolean',
  ]);
});

test("a method that isn't a string: -32600, carrying the request's id where it's a string or a number", (t) => {
  const { send, replies, handled, logged } = wire(t);
  send({ jsonrpc: '2.0', id: 5, method: 7 });
  send({ jsonrpc: '2.0', id: 'a', method: ['channels/list'] });
  send({ jsonrpc: '2.0', id: null, method: null });
  send({ jsonrpc: '2.0', id: { x: 1 }, method: { y: 2 } });
  assert.equal(handled.length, 0);
  assert.deepEqual(replies().map((r) => [r.id, r.error?.code, r.error?.message]), [
    [5, -32600, 'Invalid Request: the method must be a string, not a number'],
    ['a', -32600, 'Invalid Request: the method must be a string, not an array'],
    [null, -32600, 'Invalid Request: the method must be a string, not null'],
    [null, -32600, 'Invalid Request: the method must be a string, not an object; the id must be a string, a number or null, not an object'],
  ]);
  assert.deepEqual(logged, [
    '[mcpl] srv: answered -32600 to an invalid request: the method must be a string, not a number',
    '[mcpl] srv: answered -32600 to an invalid request: the method must be a string, not an array',
    '[mcpl] srv: answered -32600 to an invalid request: the method must be a string, not null',
    '[mcpl] srv: answered -32600 to an invalid request: the method must be a string, not an object; the id must be a string, a number or null, not an object',
  ]);
});

test("a method that isn't a string, with no id, isn't a notification either: -32600 with id null", (t) => {
  const { send, replies, handled, logged } = wire(t);
  // JSON-RPC 2.0's own example of an invalid Request object.
  send({ jsonrpc: '2.0', method: 1, params: 'bar' });
  send({ jsonrpc: '2.0', method: ['channels/list'], params: {} });
  assert.equal(handled.length, 0);
  assert.deepEqual(replies(), [
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the method must be a string, not a number' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the method must be a string, not an array' } },
  ]);
  assert.deepEqual(logged, [
    '[mcpl] srv: answered -32600 to an invalid request: the method must be a string, not a number',
    '[mcpl] srv: answered -32600 to an invalid request: the method must be a string, not an array',
  ]);
});

test('a message without a method is a response, whatever its id, and is never answered', (t) => {
  const { connection, send, replies, handled, logged } = wire(t);
  const orphans: unknown[] = [];
  connection.on('orphaned-response', (info) => { orphans.push(info); });
  // What a server sends for a request it couldn't read (JSON-RPC 2.0 §5),
  // and the form MCP allows for it, with no id (MCP 2025-11-25, Basic).
  send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
  // An id none of ours can have, with the state an orphan would carry.
  send({ jsonrpc: '2.0', id: { x: 1 }, result: { state: {} } });
  assert.deepEqual(replies(), [], 'a response is never answered');
  assert.equal(handled.length, 0);
  assert.deepEqual(orphans, [], "neither is a late answer to a request of ours");
  // The error member is the server's text, so it prints as log-value prints a
  // server's value: escaped and quoted unless it's a plain token.
  assert.deepEqual(logged, [
    String.raw`[mcpl] srv: ignored a response whose id is null, which can't be matched to a request of ours; its error: "{\"code\":-32700,\"message\":\"Parse\u0020error\"}"`,
    String.raw`[mcpl] srv: ignored a response with no id, which can't be matched to a request of ours; its error: "{\"code\":-32700,\"message\":\"Parse\u0020error\"}"`,
    "[mcpl] srv: ignored a response whose id is an object, which can't be matched to a request of ours",
  ]);
  // The control: a number id that matches no pending request, carrying state,
  // is still surfaced as an orphan.
  send({ jsonrpc: '2.0', id: 999, result: { state: {} } });
  assert.equal(orphans.length, 1);
  assert.deepEqual(replies(), []);
});

test("a null-id error while a request of the host's is pending leaves that request pending, and its own answer settles it", async (t) => {
  const { connection, transport, send, logged } = wire(t);
  const orphans: unknown[] = [];
  connection.on('orphaned-response', (info) => { orphans.push(info); });
  // Its own timeout is the hang guard: it rejects the request, failing the
  // test, if the answer below never settles it.
  const pending = (connection as any).sendRequest('tools/list', {}, { timeoutMs: 30_000 }) as Promise<unknown>;
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const request = JSON.parse(transport.lines.at(-1)!);
  // A server that couldn't read the request may answer it so (JSON-RPC 2.0
  // §5), or under MCP with no id.
  send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still pending');
  assert.deepEqual(orphans, []);
  assert.equal(logged.length, 2);
  send({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
  assert.deepEqual(await pending, { tools: [] });
});

/** A stdio server that answers initialize with the given lines, `INIT` in
 *  each standing for initialize's id, and stays up until the host closes it. */
function initializeAnswers(...answers: string[]): string {
  return String.raw`
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const text = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!text.trim()) continue;
    const m = JSON.parse(text);
    if (m.method === 'initialize') {
      for (const answer of ${JSON.stringify(answers)}) process.stdout.write(answer.replaceAll('"INIT"', JSON.stringify(m.id)) + '\n');
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
}

for (const [form, answer] of [
  ['with id null', { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }],
  ['with no id, as MCP allows', { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }],
] as const) {
  test(`during the handshake an error ${form} answers initialize, the one request out: the connect fails at once, in the server's words`, async () => {
    // A server that couldn't read initialize, and so answers it naming no
    // request. Its error is the handshake's, rather than a timeout 30 s later.
    const server = initializeAnswers(JSON.stringify(answer));
    await assert.rejects(
      McplServerConnection.connect({ id: 'unreadable', command: process.execPath, args: ['-e', server] }, { version: '0.5' }),
      { message: 'MCPL server "unreadable" initialize error: Parse error' },
    );
  });
}

test("during the handshake any other response that can't be matched is logged, one with another number is ignored, and the handshake goes on", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  // Answers initialize first with a number that isn't initialize's, then with
  // id null and a result, which no peer sends for a request it couldn't read,
  // then with log lines of its own that carry an error, two with id null,
  // but don't say they're JSON-RPC, then with an object id and a bare string
  // for its error, and then properly.
  const server = initializeAnswers(
    JSON.stringify({ jsonrpc: '2.0', id: 5, result: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: null, result: {} }),
    JSON.stringify({ level: 50, msg: 'request failed', error: { code: -32700, message: 'Parse error' } }),
    JSON.stringify({ level: 50, msg: 'request failed', id: null, error: { code: -32700, message: 'Parse error' } }),
    JSON.stringify({ level: 'error', id: null, error: 'db unavailable' }),
    JSON.stringify({ jsonrpc: '2.0', id: { x: 1 }, error: 'boom' }),
    JSON.stringify({ jsonrpc: '2.0', id: 'INIT', result: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } } } }),
  );
  const connection = await McplServerConnection.connect(
    { id: 'unmatched', command: process.execPath, args: ['-e', server], requestTimeoutMs: 5_000 },
    { version: '0.5' },
  );
  try {
    assert.equal(connection.capabilities?.pushEvents, true, 'the initialize answer that followed was taken');
    // The numbered response that isn't initialize's is neither logged nor taken.
    assert.deepEqual(logged.filter((entry) => entry.startsWith('[mcpl] unmatched: ignored a response')), [
      "[mcpl] unmatched: ignored a response whose id is null, which can't be matched to a request of ours",
      String.raw`[mcpl] unmatched: ignored a response whose id is null, which can't be matched to a request of ours; its error: "{\"code\":-32700,\"message\":\"Parse\u0020error\"}"`,
      String.raw`[mcpl] unmatched: ignored a response whose id is null, which can't be matched to a request of ours; its error: "db\u0020unavailable"`,
      "[mcpl] unmatched: ignored a response whose id is an object, which can't be matched to a request of ours; its error: boom",
    ]);
  } finally {
    await connection.close();
  }
});

test("an object with neither a method nor an id isn't JSON-RPC: it's ignored, with no log", (t) => {
  const { connection, send, replies, handled, logged } = wire(t);
  const orphans: unknown[] = [];
  connection.on('orphaned-response', (info) => { orphans.push(info); });
  // A server's own log lines written to stdout, one of them carrying an error
  // as a JSON-RPC error does but not saying it's JSON-RPC, and a result that
  // left out its id.
  send({ level: 30, msg: 'listening' });
  send({ level: 50, msg: 'request failed', error: { code: -32700, message: 'Parse error' } });
  send({ jsonrpc: '2.0', result: { state: {} } });
  assert.deepEqual(replies(), []);
  assert.equal(handled.length, 0);
  assert.deepEqual(orphans, []);
  assert.deepEqual(logged, []);
});

test("a JSON value that isn't an object, a batch included, is ignored like a server's other output on stdout", (t) => {
  const { transport, replies, handled, logged } = wire(t);
  // Unlike the MCP server, whose stdin carries only its client's messages,
  // a server's stdout can carry output that isn't JSON-RPC.
  for (const line of ['7', '"listening"', 'null', 'true', '[]', JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'channels/list', params: {} }])]) {
    transport.emit('line', line);
  }
  assert.deepEqual(replies(), []);
  assert.equal(handled.length, 0);
  assert.deepEqual(logged, []);
});
