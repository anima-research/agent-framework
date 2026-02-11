#!/bin/bash
# MCP wrapper for agent-framework inspector
# Connects to running agent-framework API server at ws://localhost:8765/ws

# Source nvm to get node in PATH
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")"

# Ensure node modules are available
export PATH="./node_modules/.bin:$PATH"

# Set API server URL (can be overridden via env)
export AGENT_FRAMEWORK_WS_URL="${AGENT_FRAMEWORK_WS_URL:-ws://localhost:8765/ws}"

# Run the MCP server
exec node dist/src/api/mcp-server.js
