/**
 * The MCP server reads a message's envelope as the MCPL connection does
 * (#475, src/jsonrpc-envelope.ts): `"id": null` is a request, answered with
 * id null; a message whose id isn't a string, a number or null, or whose
 * method isn't a string, with or without an id, is answered once with
 * -32600, carrying its id where that's a string or a number and null
 * otherwise, and isn't dispatched; a message with an id and no method is a
 * response, and so is a JSON-RPC 2.0 error with no id, as MCP allows: this
 * server, sending no requests, logs one and never answers it; and a request
 * named 'initialized' gets -32601 like any unknown method. A JSON
 * value that isn't an object is an invalid request too, and a batch is
 * refused as one. Lines go in as the server's stdin reader hands them
 * over, to a server that's never started, since starting connects it to its
 * WebSocket API first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McpServer } from '../src/api/mcp-server-core.js';

type Reply = { jsonrpc: string; id: unknown; result?: unknown; error?: { code: number; message: string } };

function serve(t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown } }) {
  const server = new McpServer() as unknown as { handleInput(line: string): void; send(message: unknown): void };
  const replies: Reply[] = [];
  server.send = (message: unknown) => { replies.push(JSON.parse(JSON.stringify(message))); };
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  return {
    line: (text: string) => server.handleInput(text),
    send: (msg: unknown) => server.handleInput(JSON.stringify(msg)),
    replies,
    logged,
  };
}

test('a request with id null is answered, with id null', (t) => {
  const { send, replies } = serve(t);
  send({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: null, result: {} }]);
});

test("an id that isn't a string, a number or null: -32600 with id null, and the request isn't handled", (t) => {
  const { send, replies, logged } = serve(t);
  send({ jsonrpc: '2.0', id: { nested: [1] }, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', id: [1], method: 'ping' });
  send({ jsonrpc: '2.0', id: true, method: 'ping' });
  assert.deepEqual(replies, [
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the id must be a string, a number or null, not an object' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the id must be a string, a number or null, not an array' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the id must be a string, a number or null, not a boolean' } },
  ]);
  assert.deepEqual(logged, [], 'the answer says what was wrong');
});

test("a method that isn't a string: -32600, carrying the request's id where it's a string or a number", (t) => {
  const { send, replies } = serve(t);
  send({ jsonrpc: '2.0', id: 9, method: 7 });
  send({ jsonrpc: '2.0', id: 'a', method: ['ping'] });
  send({ jsonrpc: '2.0', id: null, method: null });
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code, r.error?.message, 'result' in r]), [
    [9, -32600, 'Invalid Request: the method must be a string, not a number', false],
    ['a', -32600, 'Invalid Request: the method must be a string, not an array', false],
    [null, -32600, 'Invalid Request: the method must be a string, not null', false],
  ]);
});

test("a method that isn't a string, with no id, isn't a notification either: -32600 with id null", (t) => {
  const { send, replies, logged } = serve(t);
  // JSON-RPC 2.0's own example of an invalid Request object.
  send({ jsonrpc: '2.0', method: 1, params: 'bar' });
  assert.deepEqual(replies, [
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the method must be a string, not a number' } },
  ]);
  assert.deepEqual(logged, []);
});

test('a message without a method is a response: this server sends no requests, so it logs one and never answers it', (t) => {
  const { send, replies, logged } = serve(t);
  // What a client sends for a line it couldn't read (JSON-RPC 2.0 §5), and
  // the form MCP allows for it, with no id (MCP 2025-11-25, Basic).
  send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
  send({ jsonrpc: '2.0', id: 3, result: {} });
  // An error member that isn't an error object is printed as sent too.
  send({ jsonrpc: '2.0', id: { x: 1 }, error: 'boom' });
  // A string id and an error that could pose as log fields are escaped.
  send({ jsonrpc: '2.0', id: 'a b=c', error: 'reason=stolen' });
  assert.deepEqual(replies, [], 'a response is never answered');
  assert.deepEqual(logged, [
    String.raw`[agent-framework-mcp] ignored a response whose id is null, since this server sends no requests; its error: "{\"code\":-32700,\"message\":\"Parse\u0020error\"}"`,
    String.raw`[agent-framework-mcp] ignored a response with no id, since this server sends no requests; its error: "{\"code\":-32700,\"message\":\"Parse\u0020error\"}"`,
    '[agent-framework-mcp] ignored a response whose id is 3, since this server sends no requests',
    '[agent-framework-mcp] ignored a response whose id is an object, since this server sends no requests; its error: boom',
    String.raw`[agent-framework-mcp] ignored a response whose id is "a\u0020b\u003dc", since this server sends no requests; its error: "reason\u003dstolen"`,
  ]);
});

test("a JSON value that isn't an object is an invalid request, answered with id null, and a batch is refused as one", (t) => {
  const { line, replies, logged } = serve(t);
  for (const text of ['5', '"ping"', 'null', '[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]']) line(text);
  const batch = "Invalid Request: this server doesn't accept batches, so send each message on a line of its own";
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code, r.error?.message]), [
    [null, -32600, 'Invalid Request: a message must be an object, not a number'],
    [null, -32600, 'Invalid Request: a message must be an object, not a string'],
    [null, -32600, 'Invalid Request: a message must be an object, not null'],
    [null, -32600, batch],
    [null, -32600, batch],
  ]);
  assert.deepEqual(logged, []);
});

test('controls: a line that isn\'t JSON is a parse error; a notification, an object with neither a method nor an id, and an unknown method are handled as before', (t) => {
  const { line, send, replies, logged } = serve(t);
  line('{"jsonrpc":');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({});
  // An error member alone, without saying it's JSON-RPC, is no response.
  send({ error: { code: -32700, message: 'Parse error' } });
  send({ jsonrpc: '2.0', id: 4, method: 'no/such-method' });
  assert.deepEqual(replies, [
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found: no/such-method' } },
  ]);
  assert.deepEqual(logged, []);
});

test("a request named 'initialized' gets -32601, where it got no answer: MCP's acknowledgment is the notifications/initialized notification", (t) => {
  const { send, replies } = serve(t);
  send({ jsonrpc: '2.0', id: 5, method: 'initialized' });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Method not found: initialized' } }]);
});
