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
- **A line an MCP server sends that isn't JSON is logged when it's
  dropped,** as is a JSON value that isn't an object from a legacy MCPL
  server: one stderr line naming the server and the line's length, never its
  content. A blank line is still dropped without one, and the WebSocket
  transport still trims each line first and drops one that trims to nothing.
  A server that writes plain-text log lines to its stdout gets one such
  stderr line for each.
