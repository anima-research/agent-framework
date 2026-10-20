import type { ContentBlock, ToolDefinition as MembraneToolDefinition } from '@animalabs/membrane';
import type { MessageId } from '@animalabs/context-manager';

/**
 * Unique identifier for a tool call.
 */
export type ToolCallId = string;

/**
 * Re-export membrane's ToolDefinition for modules to use.
 */
export type ToolDefinition = MembraneToolDefinition;

/**
 * Events that flow through the framework's processing queue.
 *
 * ProcessEvents represent work to be done — modules respond to them via onProcess().
 * They are distinct from TraceEvents, which are observability-only notifications.
 *
 * Modules can define their own namespaced events (e.g., 'api:message', 'discord:reaction').
 */
export type ProcessEvent =
  | ExternalMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | TimerFiredEvent
  | InferenceRequestEvent
  | MessageEditedEvent
  | MessageRemovedEvent
  | ModuleEvent
  | ApiMessageEvent
  | ApiInferenceRequestEvent
  | McplPushEvent
  | McplChannelIncomingEvent
  | CustomEvent;

/**
 * API message event - from the API server.
 */
export interface ApiMessageEvent {
  type: 'api:message';
  participant: string;
  content: string;
  metadata?: Record<string, unknown>;
  triggerInference?: boolean;
  targetAgents?: string[];
}

/**
 * API inference request - from the API server.
 */
export interface ApiInferenceRequestEvent {
  type: 'api:inference-request';
  agentName?: string;
  reason?: string;
}

/**
 * Generic custom event for module-specific namespaced events.
 * Use this for events like 'discord:message', 'slack:reaction', etc.
 */
export interface CustomEvent {
  type: `${string}:${string}`;
  [key: string]: unknown;
}

/**
 * Message from an external source (Discord, HTTP, CLI, etc.)
 */
export interface ExternalMessageEvent {
  type: 'external-message';
  /** Module that produced this event */
  source: string;
  /** Raw content from external system */
  content: unknown;
  /** External system metadata */
  metadata: Record<string, unknown>;
  /** Whether this should trigger inference */
  triggerInference?: boolean;
  /** Specific agents to trigger (if not all) */
  targetAgents?: string[];
}

/**
 * Result of a tool call.
 */
export interface ToolResultEvent {
  type: 'tool-result';
  /** ID of the original tool call */
  callId: ToolCallId;
  /** Agent that made the call */
  agentName: string;
  /** Module that handled the call */
  moduleName: string;
  /** The tool's name, as its call named it. The framework's own
   *  producers set it, so a result nothing can take any more (one arriving
   *  after stop()) is still logged by tool. */
  toolName?: string;
  /** Result of the tool call */
  result: ToolResult;
}

/**
 * Tool call scheduled for execution.
 */
export interface ToolCallEvent {
  type: 'tool-call';
  /** ID of the tool call */
  callId: ToolCallId;
  /** Agent that made the call */
  agentName: string;
  /** Module that will handle the call */
  moduleName: string;
  /** Un-prefixed tool name */
  toolName: string;
  /** Full tool call payload */
  call: ToolCall;
}

/**
 * Scheduled timer fired.
 */
export interface TimerFiredEvent {
  type: 'timer-fired';
  /** Timer identifier */
  timerId: string;
  /** Reason for the timer */
  reason: string;
  /** Specific agent to wake (if any) */
  agentName?: string;
}

/**
 * Explicit request to run inference.
 */
export interface InferenceRequestEvent {
  type: 'inference-request';
  /** Agent to run inference for */
  agentName: string;
  /** Reason for the request */
  reason: string;
  /** Module that requested it */
  source: string;
}

/**
 * External message was edited.
 */
export interface MessageEditedEvent {
  type: 'message-edited';
  /** Module that produced this event */
  source: string;
  /** Our internal message ID */
  messageId: MessageId;
  /** New content */
  newContent: ContentBlock[];
}

/**
 * External message was removed.
 */
export interface MessageRemovedEvent {
  type: 'message-removed';
  /** Module that produced this event */
  source: string;
  /** Our internal message ID */
  messageId: MessageId;
}

/**
 * Generic module-specific event.
 */
export interface ModuleEvent {
  type: 'module-event';
  /** Module that produced this event */
  source: string;
  /** Module-specific event type */
  eventType: string;
  /** Module-specific payload */
  payload: unknown;
}

/**
 * Result of a tool execution.
 */
export interface ToolResult {
  /** Whether the tool succeeded */
  success: boolean;
  /** Result data (if success) */
  data?: unknown;
  /** Error message (if failure) */
  error?: string;
  /** Whether this was an error (for LLM) */
  isError?: boolean;
  /**
   * The result's machine-readable form, beside `data`. Programs read it: a
   * script gets it in its result object, and a host in the tool result
   * event. The model never reads this field: it sees the value only where an
   * MCP conversion put it in the content as JSON, which happens only when the
   * server sent no text. An MCP tool's is its `structuredContent`, present
   * exactly when the server sent one, so `false`, `0` and `null` are values
   * here, not absence. Any other tool can set one too, as `code_execution`
   * does with its script's stdout, stderr, exit code and any time-limit note.
   */
  structured?: unknown;
  /**
   * When true, the framework saves tool_use + tool_result messages to context,
   * cancels the active stream, and resets the agent to idle.
   * This is a "sleep until next event" primitive — the LLM expects the call to block.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  endTurn?: boolean;
  /**
   * Fields of `data` that say what the tool acted on, such as the paths a
   * write wrote, removed or took from disk, the path it deleted, or a mount
   * whose root it accepted, in the order they should be kept. When the
   * tool-result guard withholds this result, these fields stay in its stub,
   * so the agent still sees what the tool did; the result as stored goes
   * where every withheld original goes (agent-framework #277). Past the
   * inline cap they're cut, in this order, so a later field can be cut away
   * entirely; put the short, telling ones first. Only data's own fields can
   * be kept, and a failed result (success false) keeps nothing.
   */
  keepWhenWithheld?: string[];
}

/**
 * A tool call from the LLM.
 */
export interface ToolCall {
  /** Unique ID for this call */
  id: ToolCallId;
  /** Full tool name (module:tool) */
  name: string;
  /** Tool input */
  input: unknown;
  /** The agent that made this tool call. Set by the framework dispatch layer. */
  callerAgentName?: string;
  /**
   * The turn the call was made in, the same id as that turn's
   * `SpeechContext.turnId`. Set by the framework dispatch layer, beside
   * `callerAgentName`: a model's call carries the turn whose stream made it, a
   * foreground script's inner call the turn of the code_execution call whose
   * script is running when the call arrives, and a utility run its `utils`
   * call's. A background script runs apart from any turn, so its calls carry
   * none. Ids increase, so a later turn's is larger, and they're unique only
   * within one run of the process. A call made with `executeToolCall` or a
   * module's `callTool` skips that layer and carries whatever turn its caller
   * put on the call, usually none.
   */
  callerTurnId?: number;
  /**
   * How long this call's result may be and still reach its caller whole,
   * measured as the framework stores it: an error's text, or a success's data
   * as JSON (a content array as its text). For a model's call it is the
   * agent's inline cap, past which the framework spills the result to a
   * workspace file and sends a preview. For a call from a running
   * code_execution script it is the script's limit, past which a success's
   * result is cut; an error reaches the script whole, after "Error: ". A
   * result that carries `structured` reaches a script instead as one JSON
   * object of its content, structured content and error, measured whole; one
   * past the limit is saved to a workspace file in its place, or, where it
   * can't be, isn't delivered. A tool
   * that pages or budgets its answer can stay under it. The framework sets it
   * on a model's, a script's and the operator's puppet's call to a module, a
   * utility run through `utils` included. A call made in process with
   * ModuleContext.callTool or executeToolCall carries what its caller put on
   * it, as the puppet's does; the framework's own read_image tool passes a
   * model's call to the workspace without it; and a utility run through
   * `utils` carries what its `utils` call carried. Without it, a module holds
   * its answer to a bound of its own, if any: the workspace's is the house
   * default, 24,000.
   */
  resultMaxChars?: number;
}

// ============================================================================
// MCPL Events (Steps 6-7)
// ============================================================================

/**
 * Push event from an MCPL server (Section 9).
 * Converted from wire-format McplContentBlock to membrane ContentBlock.
 */
export interface McplPushEvent {
  type: 'mcpl:push-event';
  serverId: string;
  featureSet: string;
  eventId: string;
  content: ContentBlock[];
  origin?: Record<string, unknown>;
  tags?: string[];
  timestamp: string;
  inferenceId: string;
  triggerInference?: boolean;
  targetAgents?: string[];
  /** Host acceptance time (epoch ms), stamped where the push is admitted. */
  acceptedAt?: number;
}

/**
 * Incoming channel message from an MCPL server (Section 14).
 * Converted from wire-format McplContentBlock to membrane ContentBlock.
 */
export interface McplChannelIncomingEvent {
  type: 'mcpl:channel-incoming';
  serverId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  author: { id: string; name: string };
  content: ContentBlock[];
  timestamp: string;
  metadata?: Record<string, unknown>;
  triggerInference?: boolean;
  targetAgents?: string[];
  /** Host acceptance time (epoch ms), stamped where the message is admitted. */
  acceptedAt?: number;
}
