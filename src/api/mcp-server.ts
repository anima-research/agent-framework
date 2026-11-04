#!/usr/bin/env node
/**
 * The `agent-framework-mcp` command: an MCP server over stdio for Claude Code
 * and other MCP clients, as a client of the framework's WebSocket API at
 * AGENT_FRAMEWORK_WS_URL (default ws://localhost:8765/ws). It always starts:
 * the server itself is McpServer, in ./mcp-server-core.ts, which the package
 * root exports, so importing the package never runs this file. The package's
 * `exports` names only its root, so nothing outside it can import this path
 * by the package's name.
 */
import { McpServer } from './mcp-server-core.js';

const wsUrl = process.env.AGENT_FRAMEWORK_WS_URL ?? 'ws://localhost:8765/ws';
const server = new McpServer(wsUrl);
server.start().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
