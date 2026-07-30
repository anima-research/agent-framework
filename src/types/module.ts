import type { ContentBlock } from '@animalabs/membrane';
import type {
  MessageId,
  MessageMetadata,
  StoredMessage,
  ContextInjection,
} from '@animalabs/context-manager';
import type { ProcessEvent, ToolDefinition, ToolCall, ToolResult } from './events.js';
import type { TraceEventListener } from './trace.js';

/**
 * Filter criteria for querying messages.
 * All fields are optional; messages must match all specified criteria.
 */
export interface MessageQuery {
  /** Filter by external source (e.g., 'discord') */
  source?: string;
  /** Filter by participant name */
  participant?: string;
  /** Filter by metadata fields (shallow match) */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a message query.
 */
export interface MessageQueryResult {
  messages: StoredMessage[];
  totalCount: number;
}

/**
 * A pluggable module that provides capabilities to the framework.
 */
export interface Module {
  /** Unique name, used for tool namespacing and state storage */
  readonly name: string;

  /**
   * Per-module budget (ms) for gatherContext() before the framework skips this
   * module's injection for the turn (fail-open). Defaults to the registry-wide
   * default (15s) when omitted. Declare a larger budget when gatherContext
   * does real work — e.g. sequential LLM calls with provider backoff — so the
   * injection isn't silently dropped every turn.
   */
  readonly contextTimeoutMs?: number;

  /**
   * Start the module.
   * Called when the framework starts or when the module is added.
   */
  start(ctx: ModuleContext): Promise<void>;

  /**
   * Stop the module.
   * Called when the framework stops or when the module is removed.
   */
  stop(): Promise<void>;

  /**
   * Get currently available tools.
   * Can change over time (e.g., based on connection state).
   */
  getTools(): ToolDefinition[];

  /**
   * Utilities: agent-invocable operations that deliberately do NOT get a
   * first-class tool slot. Every tool schema taxes every inference; a
   * capability used twice a month shouldn't. Utilities are listed, described,
   * and invoked through the framework's single `utils` tool instead — same
   * ToolDefinition shape, same un-prefixed names, and dispatch arrives at the
   * SAME handleToolCall as getTools() output, so a tool migrates between
   * surfaces by moving its definition from one list to the other and nothing
   * else. Optional; omitting it means the module contributes no utilities.
   */
  getUtilities?(): ToolDefinition[];

  /**
   * Handle a tool call.
   * Tool name is without module prefix.
   */
  handleToolCall(call: ToolCall): Promise<ToolResult>;

  /**
   * Handle a process event from the queue.
   * Return response indicating what actions to take.
   *
   * @param event - The event to process
   * @param state - Read-only state snapshot for accessing module state and lookups
   */
  onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse>;

  /**
   * Handle agent speech (if registered as speech handler).
   * Called when an agent produces text output.
   */
  onAgentSpeech?(
    agentName: string,
    content: ContentBlock[],
    context: SpeechContext
  ): Promise<void>;

  /**
   * Gather context injections before agent inference.
   * Called before each inference to collect data (e.g., HUD overlays, game state)
   * that should be injected into the compiled context.
   * Complementary to MCPL push-based hooks — modules pull via gatherContext.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  gatherContext?(agentName: string): Promise<ContextInjection[]>;

  /**
   * Declare extra settings for the synthesized `agent_settings` tool.
   * Modules owning hot-tunable runtime state (e.g. a host settings module
   * managing extended-thinking toggles) expose it here instead of registering
   * their own tools — one settings surface for the agent instead of N.
   * The framework merges the declared fields into agent_settings' schema and
   * routes get/update/reset for the declared keys back to the extension.
   */
  getAgentSettingsExtension?(): AgentSettingsExtension;
}

/**
 * A module-owned extension of the `agent_settings` tool: extra hot-tunable
 * fields merged into the tool schema, with get/update/reset routed to the
 * declaring module. Keys must not collide with the core settings
 * (context_budget_tokens, tail_tokens, transition_pace_tokens) or with other
 * extensions — colliding extensions are skipped loudly.
 */
export interface AgentSettingsExtension {
  /** JSON-schema property definitions for the extension's fields, merged into
   *  the agent_settings input schema (e.g. { reasoning_enabled: { type: 'boolean', … } }). */
  properties: Record<string, unknown>;
  /** The setting keys this extension owns (must match `properties` keys). */
  keys: string[];
  /** Current values for the extension's keys. */
  get(agentName: string): Record<string, unknown>;
  /** Apply a partial update (only this extension's keys present) and return
   *  the new values. Throw to surface a validation error to the agent. */
  update(agentName: string, patch: Record<string, unknown>): Record<string, unknown>;
  /** Restore the listed keys (or all when omitted) to defaults and return the
   *  new values. Optional — extensions without reset semantics are skipped. */
  reset?(agentName: string, keys?: string[]): Record<string, unknown>;
}

/**
 * Context provided to modules for interacting with the framework.
 */
export interface ModuleContext {
  /**
   * Get persistent state for this module.
   * State is namespaced to the module.
   */
  getState<T>(): T | null;

  /**
   * Set persistent state for this module.
   *
   * This rewrites the module's full state object every call — appropriate for
   * small, bounded state only. For accumulating collections (registries,
   * corpora, histories) use a log state (`registerLogState`/`appendToLog`)
   * instead: a setState of an ever-growing object makes every persisted record
   * proportional to accumulated content, i.e. O(n²) aggregate disk.
   */
  setState<T>(state: T): void;

  /**
   * Register an auxiliary append-log state for this module, stored as
   * `modules/<module>/<name>`. Idempotent — safe to call on every start().
   * Items are appended with `appendToLog` (one O(item) record per append) and
   * point-edited with `editLogItem`; Chronicle's append_log snapshot cadence
   * handles consolidation. `name` must not be 'state' (reserved for the main
   * snapshot state) and must not contain '/'.
   */
  registerLogState(
    name: string,
    opts?: { deltaSnapshotEvery?: number; fullSnapshotEvery?: number }
  ): void;

  /**
   * Append one item to a log state registered via registerLogState.
   * Record size is O(item), independent of accumulated log length.
   */
  appendToLog<T>(name: string, item: T): void;

  /**
   * Overwrite the item at `index` in a log state. Indices are stable —
   * appends assign the next index and nothing is ever removed.
   */
  editLogItem<T>(name: string, index: number, item: T): void;

  /**
   * Read the full contents of a log state (empty array if never written).
   * Intended for one-shot reconstruction at start(); keep hot-path reads
   * against the in-memory copy.
   */
  getLog<T>(name: string): T[];

  /**
   * Number of items in a log state (0 if never written).
   */
  getLogLength(name: string): number;

  /**
   * Process queue for pushing events from external listeners.
   * @deprecated Use pushEvent() instead — it also emits process:received traces.
   */
  readonly queue: ProcessQueue;

  /**
   * Push a process event to the queue and emit a process:received trace.
   * Preferred over direct queue.push() for proper observability.
   */
  pushEvent(event: ProcessEvent): void;

  /**
   * Get another module by name.
   */
  getModule<T extends Module>(name: string): T | null;

  /**
   * Add a message to the conversation.
   */
  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata & { external?: ExternalIdRef }
  ): MessageId;

  /**
   * Edit a message.
   */
  editMessage(id: MessageId, content: ContentBlock[]): void;

  /**
   * Remove a message.
   */
  removeMessage(id: MessageId): void;

  /**
   * Find a message by external ID.
   */
  findMessageByExternalId(source: string, externalId: string): MessageId | null;

  /**
   * Get a message by ID.
   */
  getMessage(id: MessageId): StoredMessage | null;

  /**
   * Query messages by filter criteria.
   * Useful for finding messages from external sources, by participant, etc.
   */
  queryMessages(filter: MessageQuery): MessageQueryResult;

  /**
   * Get info about all agents.
   */
  getAgents(): AgentInfo[];

  /**
   * Get all currently available tools.
   */
  getActiveTools(): ToolDefinition[];

  /**
   * Whether this is a restart (state existed) vs fresh start.
   */
  readonly isRestart: boolean;

  /**
   * Register this module as a speech handler for agents.
   * @param agents - '*' for all agents, or array of agent names
   * @param options - Speech handler options
   */
  registerSpeechHandler(
    agents: '*' | string[],
    options?: SpeechHandlerOptions
  ): void;

  /**
   * Unregister this module as a speech handler.
   */
  unregisterSpeechHandler(): void;

  /**
   * Execute a tool call autonomously, without agent mediation.
   *
   * Routes through the framework's normal tool dispatch — MCPL-prefixed names
   * (e.g. `mcpl--discord--unsubscribe_channel`) hit the MCPL subsystem; module
   * names hit the owning module. Unlike pushing a `tool-call` event, this does
   * NOT record tool_use/tool_result into any agent's context — it's a pure
   * side-effecting call whose result is returned to the caller. Used by modules
   * that need to act on their own (e.g. subscription GC unsubscribing a noisy
   * channel) rather than asking the agent to call the tool.
   */
  callTool(call: ToolCall): Promise<ToolResult>;

  /**
   * Subscribe to the framework's trace event stream for observability.
   *
   * Modules use this to react to agent lifecycle without polling — e.g. an
   * adapter that wants to show a "typing" indicator can bracket it between
   * `inference:started` and the terminal events (`inference:turn_ended`,
   * `inference:aborted`, `inference:failed`, `inference:exhausted`), all of
   * which carry `agentName`. The terminal events fire once per turn, after any
   * tool-call cycles, so a single start/stop bracket spans the whole turn.
   *
   * Returns an unsubscribe function. Call it in the module's `stop()` to avoid
   * leaking listeners across teardown/recreate (e.g. session switch).
   */
  onTrace(listener: TraceEventListener): () => void;

  /**
   * Raise an operator-facing ops alert through the framework's ops channel
   * (failures.log + `ops:alert` trace + the ops webhook, when configured).
   * For module actions that change durable state the operator would otherwise
   * discover by surprise — e.g. subscription GC closing a channel. Keep the
   * message privacy-minimal: identifiers and thresholds, not content.
   *
   * Optional so modules built against this version degrade gracefully on an
   * older framework: call as `ctx.notifyOps?.(...)`.
   */
  notifyOps?(kind: string, agentName: string, message: string, data?: Record<string, unknown>): void;
}

/**
 * Read-only state snapshot provided to modules during event processing.
 * State writes happen via EventResponse, not through this interface.
 */
export interface ProcessState {
  /**
   * Get this module's state.
   */
  getState<T>(): T | null;

  /**
   * Get another module's state by name.
   */
  getModuleState<T>(name: string): T | null;

  /**
   * Find a message by external ID.
   */
  findMessageByExternalId(source: string, externalId: string): MessageId | null;

  /**
   * Get info about all agents.
   */
  getAgents(): AgentInfo[];

  /**
   * Get all currently available tools.
   */
  getActiveTools(): ToolDefinition[];

  /**
   * Queue for emitting follow-up events.
   * @deprecated Use pushEvent() instead — it also emits process:received traces.
   */
  readonly queue: ProcessQueue;

  /**
   * Push a process event to the queue and emit a process:received trace.
   * Preferred over direct queue.push() for proper observability.
   */
  pushEvent(event: ProcessEvent): void;
}

/**
 * Reference to an external system's ID.
 */
export interface ExternalIdRef {
  source: string;
  id: string;
}

/**
 * Process queue interface for modules.
 */
export interface ProcessQueue {
  /**
   * Push a process event to the queue.
   */
  push(event: ProcessEvent): void;
}

/**
 * Basic info about an agent.
 */
export interface AgentInfo {
  name: string;
  model: string;
  status: AgentStatus;
}

/**
 * Agent execution status.
 */
export type AgentStatus = 'idle' | 'inferring' | 'streaming' | 'waiting_for_tools' | 'ready';

/**
 * Response from a module's event handler.
 */
export interface EventResponse {
  /**
   * Messages to add to the conversation.
   */
  addMessages?: NewMessage[];

  /**
   * Messages to edit.
   */
  editMessages?: MessageEdit[];

  /**
   * Messages to remove.
   */
  removeMessages?: MessageId[];

  /**
   * Request inference.
   * - true: request for all agents
   * - string[]: request for specific agents
   * - false/undefined: no request
   */
  requestInference?: boolean | string[];

  /**
   * Signal that this module's tools have changed.
   */
  toolsChanged?: boolean;

  /**
   * Module state update. Applied atomically with message operations.
   * The framework will call setState() with this value after applying
   * message changes, ensuring consistent state.
   */
  stateUpdate?: unknown;
}

/**
 * A new message to add.
 */
export interface NewMessage {
  participant: string;
  content: ContentBlock[];
  metadata?: MessageMetadata & { external?: ExternalIdRef };
}

/**
 * An edit to an existing message.
 */
export interface MessageEdit {
  messageId: MessageId;
  content: ContentBlock[];
}

// ============================================================================
// Speech Handler Types
// ============================================================================

/**
 * Context provided to speech handlers.
 */
export interface SpeechContext {
  /**
   * Whether this is a complete turn or tool calls are pending.
   * If false, more output may follow after tool results.
   */
  turnComplete: boolean;

  /**
   * The inference request that triggered this speech.
   */
  trigger: {
    reason: string;
    source: string;
    timestamp: number;
  };

  /**
   * Pre-tool preamble text blocks that preceded tool calls.
   * Modules can display these as "thoughts" (e.g. Discord spoiler tags).
   * Empty when no tool calls were made.
   */
  thoughts?: ContentBlock[];
}

/**
 * Options for speech handler registration.
 */
export interface SpeechHandlerOptions {
  /**
   * If true, add to existing handlers rather than replacing.
   * Multiple handlers will all receive speech.
   */
  additive?: boolean;

  /**
   * Priority for handler ordering (higher = called first).
   * Default: 0
   */
  priority?: number;
}
