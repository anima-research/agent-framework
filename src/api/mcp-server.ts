/**
 * MCP Server for Claude Code integration
 *
 * Exposes agent framework capabilities as MCP tools that can be called
 * from Claude Code or other MCP clients.
 *
 * Communicates with the WebSocket API server to perform operations.
 */

import WebSocket from 'ws';
import { createInterface } from 'node:readline';
import type { ApiRequest, ApiResponse, ApiEvent } from './types.js';

// ============================================================================
// MCP Protocol Types
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// ============================================================================
// MCP Server Implementation
// ============================================================================

export class McpServer {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private connected = false;
  private reconnecting = false;
  private reconnectInterval = 2000; // Retry every 2s
  private closing = false;

  constructor(wsUrl: string = 'ws://localhost:8765/ws') {
    this.wsUrl = wsUrl;
  }

  /**
   * Start the MCP server (stdio mode).
   */
  async start(): Promise<void> {
    // Connect to WebSocket API
    await this.connectWs();

    // Set up stdio interface
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      this.handleInput(line);
    });

    rl.on('close', () => {
      this.close();
      process.exit(0);
    });

    // Handle SIGINT gracefully
    process.on('SIGINT', () => {
      this.close();
      process.exit(0);
    });
  }

  private async connectWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnecting = false;
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleWsMessage(data.toString());
      });

      this.ws.on('close', () => {
        this.connected = false;
        if (!this.closing) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        if (!this.connected) {
          // Connection failed - reject so we can retry
          reject(error);
        } else {
          // Connected but got an error - just log it
          this.sendNotification('notifications/message', {
            level: 'error',
            logger: 'agent-framework',
            data: `WebSocket error: ${error.message}`,
          });
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closing) return;
    this.reconnecting = true;

    setTimeout(() => {
      if (this.closing) return;
      this.connectWs().catch(() => {
        this.reconnecting = false;
        this.scheduleReconnect();
      });
    }, this.reconnectInterval);
  }

  private handleWsMessage(data: string): void {
    try {
      const message = JSON.parse(data) as ApiResponse | ApiEvent;

      if (message.type === 'response' && 'id' in message && message.id) {
        // Handle response to our request
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          this.pendingRequests.delete(message.id);
          if (message.success) {
            pending.resolve(message.data);
          } else {
            pending.reject(new Error(message.error ?? 'Unknown error'));
          }
        }
      } else if (message.type === 'event') {
        // Forward events as MCP notifications
        this.sendNotification('notifications/message', {
          level: 'info',
          logger: 'agent-framework',
          data: `Event: ${message.event} - ${JSON.stringify(message.data)}`,
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  private handleInput(line: string): void {
    try {
      const message = JSON.parse(line);
      
      // Check if this is a notification (no id) or a request (has id)
      if (!('id' in message) || message.id === undefined) {
        // This is a notification - handle silently without response
        // Common notifications: notifications/initialized, notifications/cancelled
        return;
      }
      
      // This is a request - process and respond
      this.handleRequest(message as JsonRpcRequest);
    } catch {
      this.sendError(null, -32700, 'Parse error');
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      switch (request.method) {
        case 'initialize':
          this.sendResult(request.id, {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'agent-framework',
              version: '0.1.0',
            },
          });
          break;

        case 'initialized':
          // Client acknowledgment, no response needed
          break;

        case 'tools/list':
          this.sendResult(request.id, { tools: this.getTools() });
          break;

        case 'tools/call':
          await this.handleToolCall(request);
          break;

        case 'ping':
          this.sendResult(request.id, {});
          break;

        default:
          this.sendError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      this.sendError(
        request.id,
        -32603,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private getTools(): McpTool[] {
    return [
      {
        name: 'agent_send_message',
        description:
          'Send a message to the agent framework. This will add the message to the conversation and optionally trigger inference.',
        inputSchema: {
          type: 'object',
          properties: {
            participant: {
              type: 'string',
              description: 'Name of the participant sending the message (e.g., "user")',
            },
            content: {
              type: 'string',
              description: 'The message content',
            },
            triggerInference: {
              type: 'boolean',
              description: 'Whether to trigger agent inference after sending (default: true)',
            },
            targetAgents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific agents to trigger (optional, defaults to all)',
            },
          },
          required: ['participant', 'content'],
        },
      },
      {
        name: 'agent_list_messages',
        description: 'List recent messages in the conversation',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of messages to return (default: 50)',
            },
            offset: {
              type: 'number',
              description: 'Offset from the most recent message (default: 0)',
            },
          },
        },
      },
      {
        name: 'agent_request_inference',
        description: 'Request the agent to run inference and generate a response',
        inputSchema: {
          type: 'object',
          properties: {
            agentName: {
              type: 'string',
              description: 'Specific agent to run (optional, defaults to all)',
            },
            reason: {
              type: 'string',
              description: 'Reason for the inference request',
            },
          },
        },
      },
      {
        name: 'branch_list',
        description: 'List all branches in the agent framework',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'branch_create',
        description: 'Create a new branch from the current state',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name for the new branch',
            },
            switchTo: {
              type: 'boolean',
              description: 'Whether to switch to the new branch after creation (default: false)',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'branch_switch',
        description: 'Switch to a different branch',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the branch to switch to',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'branch_current',
        description: 'Get the name of the current branch',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'branch_delete',
        description: 'Delete a branch (cannot delete current or main branch)',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the branch to delete',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'agent_list',
        description: 'List all agents in the framework',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'agent_context',
        description: "Get an agent's current context (compiled messages)",
        inputSchema: {
          type: 'object',
          properties: {
            agentName: {
              type: 'string',
              description: 'Name of the agent',
            },
            maxTokens: {
              type: 'number',
              description: 'Maximum tokens to include (optional)',
            },
          },
          required: ['agentName'],
        },
      },
      {
        name: 'module_list',
        description: 'List all modules registered with the framework',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'module_state',
        description: "Get a module's current state",
        inputSchema: {
          type: 'object',
          properties: {
            moduleName: {
              type: 'string',
              description: 'Name of the module',
            },
          },
          required: ['moduleName'],
        },
      },
      {
        name: 'store_states',
        description: 'List all states in the store',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: {
              type: 'string',
              description: "Filter by namespace prefix (e.g., 'agents/', 'modules/')",
            },
            limit: {
              type: 'number',
              description: 'Maximum number of states to return (default: 50)',
            },
          },
        },
      },
      {
        name: 'store_search',
        description: 'Search through store states by namespace and/or content pattern',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: {
              type: 'string',
              description: 'Filter by namespace prefix',
            },
            contentPattern: {
              type: 'string',
              description: 'Regex pattern to match against state content (JSON stringified)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default: 20)',
            },
            offset: {
              type: 'number',
              description: 'Skip first N results for pagination (default: 0)',
            },
            previewLength: {
              type: 'number',
              description: 'Preview length in characters (default: 300)',
            },
          },
        },
      },
      {
        name: 'store_inspect',
        description: 'Inspect a specific state in the store',
        inputSchema: {
          type: 'object',
          properties: {
            stateId: {
              type: 'string',
              description: 'ID of the state to inspect',
            },
          },
          required: ['stateId'],
        },
      },
      // Inference logging tools
      {
        name: 'inference_tail',
        description: 'Get the most recent inference log entries. Shows raw LLM requests and responses for debugging.',
        inputSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'number',
              description: 'Number of recent entries to return (default: 10)',
            },
            agentName: {
              type: 'string',
              description: 'Filter by agent name (optional)',
            },
          },
        },
      },
      {
        name: 'inference_inspect',
        description: 'Inspect a specific inference log entry by sequence number. Returns full raw request and response.',
        inputSchema: {
          type: 'object',
          properties: {
            sequence: {
              type: 'number',
              description: 'Sequence number of the log entry to inspect',
            },
          },
          required: ['sequence'],
        },
      },
      {
        name: 'inference_search',
        description: 'Search through inference logs by agent, pattern, or error status. Useful for debugging specific issues.',
        inputSchema: {
          type: 'object',
          properties: {
            agentName: {
              type: 'string',
              description: 'Filter by agent name',
            },
            pattern: {
              type: 'string',
              description: 'Regex pattern to search in log content',
            },
            errorsOnly: {
              type: 'boolean',
              description: 'Only show failed inferences',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default: 20)',
            },
            offset: {
              type: 'number',
              description: 'Skip first N results for pagination (default: 0)',
            },
          },
        },
      },
    ];
  }

  private async handleToolCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params as { name: string; arguments: Record<string, unknown> };
    const { name, arguments: args } = params;

    // Map MCP tool names to API commands
    const toolToCommand: Record<string, string> = {
      agent_send_message: 'message.send',
      agent_list_messages: 'message.list',
      agent_request_inference: 'inference.request',
      branch_list: 'branch.list',
      branch_create: 'branch.create',
      branch_switch: 'branch.switch',
      branch_current: 'branch.current',
      branch_delete: 'branch.delete',
      agent_list: 'agent.list',
      agent_context: 'agent.context',
      module_list: 'module.list',
      module_state: 'module.state',
      store_states: 'store.states',
      store_search: 'store.search',
      store_inspect: 'store.inspect',
      inference_tail: 'inference.tail',
      inference_inspect: 'inference.inspect',
      inference_search: 'inference.search',
    };

    const command = toolToCommand[name];
    if (!command) {
      this.sendError(request.id, -32602, `Unknown tool: ${name}`);
      return;
    }

    try {
      const result = await this.sendApiRequest(command, args);
      this.sendResult(request.id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      this.sendResult(request.id, {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      });
    }
  }

  private sendApiRequest(
    command: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('Not connected to API server'));
        return;
      }

      const id = `mcp-${++this.requestId}`;
      this.pendingRequests.set(id, { resolve, reject });

      const request: ApiRequest = {
        type: 'request',
        id,
        command,
        params,
      };

      this.ws.send(JSON.stringify(request));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  private sendResult(id: string | number, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.send(response);
  }

  private sendError(id: string | number | null, code: number, message: string): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    this.send(response);
  }

  private sendNotification(method: string, params: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.send(notification);
  }

  private send(message: JsonRpcResponse | JsonRpcNotification): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  close(): void {
    this.closing = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

// Run if executed directly
const isMain = process.argv[1]?.endsWith('mcp-server.js');
if (isMain) {
  const wsUrl = process.env.AGENT_FRAMEWORK_WS_URL ?? 'ws://localhost:8765/ws';
  const server = new McpServer(wsUrl);
  server.start().catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}
