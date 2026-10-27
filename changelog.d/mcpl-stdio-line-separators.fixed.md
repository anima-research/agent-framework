- **A stdio MCP server's message holding U+2028 or U+2029 inside a string
  arrives.** The stdio transport read the server's output with Node's
  `readline`, which also ends a line at U+2028 and U+2029. JSON lets both
  stand raw inside a string, and `JSON.stringify` leaves them so, so such a
  message reached the host as two lines that weren't JSON and was dropped:
  a response's request then failed after its timeout, and a notification
  never arrived. Lines still end at LF, CRLF and a bare CR, and no longer at
  U+2028 or U+2029, for legacy MCPL and modern MCP servers alike. The
  `agent-framework-mcp` command reads its stdin the same way, so a client's
  request holding either character gets its answer, not two parse errors.
- **A line an MCP server sends that isn't JSON is no longer dropped
  silently,** and neither is a JSON value that isn't an object from a legacy
  MCPL server. One stderr line names the server, the line's length, and
  whether it isn't JSON, starts like a JSON object but doesn't parse, or is
  JSON but not an object, never its content. A blank line is still dropped
  without one, and the WebSocket transport still trims each line first and
  drops one that trims to nothing. Each connection logs the first three
  such lines, then one line saying that more go unlogged, so a server that
  writes its logs to stdout doesn't flood the host's.
