- `agent-framework-mcp`, the MCP server's bin, now runs as an installed
  command on Linux and macOS. Its file had no `#!` line, so the shell ran it
  as a shell script, and it started only when `argv[1]` ended in
  `mcp-server.js`, which the path of npm's link doesn't. The command is now
  a file of its own that always starts the server, run through the link or
  by its own path, as `mcp-wrapper.sh` runs it. `McpServer` moved to a
  module of its own, which the package root still exports, so importing or
  bundling the package never starts a server. Before, an entry script, or
  a bundle, named `mcp-server.js` did. The server is a client of the
  framework's WebSocket API (`AGENT_FRAMEWORK_WS_URL`, default
  `ws://localhost:8765/ws`), which must be running: without it, it prints
  "Failed to start MCP server" and exits 1.
