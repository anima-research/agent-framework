- A modern MCP server whose `requestTimeoutMs` is a value `String()` can't
  print, such as `{"toString": 1}`, which a JSON configuration can hold, is
  now refused like any other wrong deadline, with the value shown as
  `[a value that cannot be printed]`. Before, checking the configuration
  threw a `TypeError` instead: connecting to the server failed with that
  error's text, and `listMcplServers` threw rather than list any server.
