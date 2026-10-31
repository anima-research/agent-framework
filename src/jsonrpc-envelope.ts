/**
 * A JSON-RPC 2.0 message's envelope, read once where a message arrives, by
 * each of the framework's endpoints that answers requests: the MCPL
 * connection, for its servers' requests, and the MCP server
 * (src/api/mcp-server-core.ts), for its client's.
 *
 * A message with an id member and no method is a response, whatever the
 * id's value: a peer answers a request it couldn't read with id null (§5),
 * and taking that answer for a request would answer it in turn. So is an
 * error with no id, which MCP lets a peer send for a request it couldn't
 * read (MCP 2025-11-25, Basic, Error Responses), but only from a message
 * whose jsonrpc member is "2.0": a peer's own JSON log lines, which an MCPL
 * server's stdout can carry, can have an error key. Any other object with
 * neither a method nor an id isn't JSON-RPC. A message with a method is
 * a request when it has an id member, whatever its value, and a notification
 * when it has none (§4.1), so `"id": null` is a request. A request's method
 * must be a string and its id a string, a number or null (§4). A message
 * that breaks either isn't a Request object, and so isn't a notification
 * either, with or without an id: the endpoints answer it once with -32600,
 * carrying its id where that's a string or a number and null otherwise (§5,
 * and the spec's own example of an invalid Request object, which has no id),
 * and don't dispatch it. The MCPL handshake, which answers only pings,
 * ignores it, as it ignores every other request then. Apart from the error
 * with no id, the `jsonrpc` member isn't checked: a peer that leaves it out
 * is served, as before.
 */

/** A JSON value's kind, as a log line or an error names what a peer sent
 *  without repeating it: "null", "an array", "an object", "a number". */
export function jsonKind(value: unknown): string {
  if (value === null) return 'null';
  const kind = Array.isArray(value) ? 'array' : typeof value;
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
}

export type JsonRpcEnvelope =
  /** An id member and no method, or a JSON-RPC 2.0 error with neither: an
   *  answer, which the endpoint matches to one of its own requests by the
   *  id where it can. */
  | { kind: 'response' }
  /** Neither a method nor an id member, and not such an error: not a
   *  JSON-RPC message. */
  | { kind: 'neither' }
  | { kind: 'request'; method: string; id: string | number | null }
  | { kind: 'notification'; method: string }
  /** Not a Request object, with or without an id: answered with `error`,
   *  carrying `id`, and not dispatched. `method` is its method where that's
   *  a string, for a log line. */
  | { kind: 'invalid'; id: string | number | null; error: { code: -32600; message: string }; method?: string; problems: string };

/** Read a parsed message's envelope. What to do with a value that isn't an
 *  object is the endpoint's own call. */
export function readEnvelope(msg: Record<string, unknown>): JsonRpcEnvelope {
  if (!Object.hasOwn(msg, 'method')) {
    const answers = Object.hasOwn(msg, 'id') || (msg.jsonrpc === '2.0' && Object.hasOwn(msg, 'error'));
    return { kind: answers ? 'response' : 'neither' };
  }
  const isRequest = Object.hasOwn(msg, 'id');
  const { method, id } = msg;
  const problems = [
    ...(typeof method === 'string' ? [] : [`the method must be a string, not ${jsonKind(method)}`]),
    ...(!isRequest || typeof id === 'string' || typeof id === 'number' || id === null
      ? [] : [`the id must be a string, a number or null, not ${jsonKind(id)}`]),
  ].join('; ');
  if (problems) {
    return {
      kind: 'invalid',
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      error: { code: -32600, message: `Invalid Request: ${problems}` },
      ...(typeof method === 'string' ? { method } : {}),
      problems,
    };
  }
  return isRequest
    ? { kind: 'request', method: method as string, id: id as string | number | null }
    : { kind: 'notification', method: method as string };
}
