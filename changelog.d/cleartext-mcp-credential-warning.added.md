- Connecting to an MCP server warns once when its credential (`token` or
  `accessProvider`) would cross the network unencrypted: an `http://` or
  `ws://` url whose host isn't loopback. It warns rather than refuses, since a
  private network or a TLS-terminating proxy can make that deliberate.
  `serverConfigWarnings` is exported beside `serverConfigProblems`, so a host
  can apply the same check in its own configuration validation.
