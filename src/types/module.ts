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
  /** Filter by external IDs: messages whose metadata.external.id is one of these. An empty list filters nothing. */
  externalIds?: string[];
  /** Filter by participant name */
  participant?: string;
  /** Filter by metadata fields: each key a path, dot-separated for a nested
   *  field (such as 'external.channelId'), its value compared by strict
   *  equality */
  metadata?: Record<string, unknown>;
}

/**
 * A context injection a module gathers (Module.gatherContext).
 *
 * An `afterUser` one is stored in the agent's window, as the message
 * `compile()` would have placed after the last user message, where it then
 * stays: so the replies after it keep their thinking, and the cache keeps the
 * turns before it. The same source's unchanged content isn't stored again
 * while the copy the agent will read as current has it whole: the one its
 * last request held, or a newer one a start stored whose compile then
 * didn't record. Once a fold has summarized it or a strategy's window has
 * scrolled past it, it's stored again, as one more row. (See
 * stored-injections.ts.)
 *
 * `placedEachCompile: true` opts out: `compile()` places the injection after
 * the last user message at each start, near the end, as before it was
 * stored. That's for context meant to stay near the end, such as
 * instructions moved off `system`. Its cost: it moves, and on a model that
 * binds a reply's thinking to everything before it, every reply after its old
 * place loses its thinking. It has no effect on a `system` or `beforeUser`
 * injection, which `compile()` always places.
 */
export type ModuleContextInjection = ContextInjection & { placedEachCompile?: true };

/**
 * A message as a module context's reads answer it: a stored row, or a row
 * for a write the framework holds (`held`). Either is marked
 * `heldFromResidents` when a tune-out holds it from the residents.
 */
export type ModuleMessage = StoredMessage & {
  /**
   * True while the framework holds the message's write, as it does while
   * the write's agent has a turn alive or the host is quiesced, until a
   * later boundary stores it. The row's `id` is then a handle, which
   * getMessage, editMessage and removeMessage take as they take a stored
   * id, and which names the stored row once the write lands. Its `sequence`
   * and `timestamp` are provisional: the sequence comes after every stored
   * row's, the timestamp is when the framework held the write (for a write
   * an older release held, when its queue was read back), and both change
   * when it lands. A held write whose earlier write may already be stored
   * is looked up first, and answered as the stored row it is when the store
   * holds it. Absent on a stored row.
   */
  held?: true;
  /**
   * True on a message a tune-out holds from the residents: one that arrived
   * in a tuned-out channel, stamped `metadata.tuneOut` as it came in. The
   * store keeps it, but no resident is shown the row itself: no resident's
   * compiled view includes it, during the tune-out or after it, and a
   * resident's tool boundary of a turn alive when it arrived stores it
   * without injecting it into the live turn. The subconscious reads it. Its
   * text can still reach a resident in rows of their own, which aren't
   * marked, such as the
   * cancel's `<tuned-out-backlog>` row, with the text of the tune-out's newest
   * messages, up to `backlogCap` of them and as many as fit in one of the
   * residents' messages, the stored ones first and then those still held;
   * what the subconscious says of it, in its report or its note; and the
   * result of a tool that reads history on request, such as a
   * channel's `fetch_history` or the history module's `extract`. A module
   * that builds on what the residents see, such as one choosing from the
   * recent conversation, leaves a marked row out, and one that matches
   * what's stored, such as a sync's dedupe, keeps it. A held write (`held`)
   * is marked too when it carries the stamp. Absent on every other row.
   */
  heldFromResidents?: true;
};

/**
 * Result of a message query.
 */
export interface MessageQueryResult {
  /** The matching stored rows, then, as the newest, the matching rows of
   *  writes the framework holds (ModuleMessage.held): before the stored rows
   *  in a reversed query */
  messages: ModuleMessage[];
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
   * Called when the module is added: create() adds the modules it is given,
   * so for those it runs before create() returns. Its own removal and the
   * framework's stop() wait for it to settle before the module's stop()
   * runs, so it mustn't await either.
   */
  start(ctx: ModuleContext): Promise<void>;

  /**
   * Stop the module.
   * Called when the framework stops or when the module is removed. Also called
   * when a create() that started the module fails (#389): create() stops the
   * framework before it rejects, so before the host has it and before anything
   * a host wires up after create() returns, such as a WorkspaceModule's
   * initStore(). A stop() that saves state can therefore run before that
   * wiring, and shouldn't then save over state it was handed and hasn't used.
   * It isn't called before the module's start() has settled, so it can end
   * what start() set up.
   */
  stop(): Promise<void>;

  /**
   * Get currently available tools.
   * Can change over time (e.g., based on connection state).
   */
  getTools(): ToolDefinition[];

  /**
   * Utilities: agent-invocable operations that deliberately do NOT get a
   * slot in the tool list. Every tool schema taxes every inference; a
   * capability used twice a month shouldn't. Utilities belong to the host's
   * built-in toolset ("settings"): an agent sees them with
   * `toolsets--look {toolset:"settings"}` and calls them with
   * `toolsets--act` once it has opened it. Same ToolDefinition shape, same
   * un-prefixed names, and dispatch arrives at the SAME handleToolCall as
   * getTools() output. Optional; omitting it means the module contributes no
   * utilities.
   */
  getUtilities?(): ToolDefinition[];

  /**
   * Where one of this module's tools (a getTools() name, unprefixed) is
   * presented: in the agent's tool list (`'header'`, the default), or in the
   * host's built-in toolset (`'builtin'`), out of the tool list, opened with
   * `toolsets--open {toolset:"settings"}` and called with `toolsets--act`.
   * For tools an agent uses rarely: settings, administration, status reads.
   * Optional; omitting it keeps every tool in the tool list.
   */
  toolPlacement?(toolName: string): 'header' | 'builtin' | undefined;

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
   * An `afterUser` injection is appended to the agent's window, where it
   * then stays, unless the copy the agent will read as current has the same
   * content, every part of it (the one its last request held, or a newer
   * one a start stored whose compile then didn't record), or it opts out
   * (ModuleContextInjection.placedEachCompile). At a
   * turn's start or a restart after tool results, that's where `compile()`
   * would have placed it.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  gatherContext?(agentName: string): Promise<ModuleContextInjection[]>;

  /**
   * Called once an agent's tool batch has completed — when the round's last
   * pending result arrives, before it is provided to the agent and before
   * anything that continues the turn (re-inference, stream resume). The
   * framework awaits it, bounded at 30 s and fail-open, so a module can
   * bring its state up to date with what the batch's tools did (the
   * workspace's `watch: 'on-agent-action'` mounts scan disk here) before the
   * agent's next inference. It's awaited in the framework's event loop, so
   * a slow hook holds every agent's event processing, not only this one's.
   * A hook still running from an earlier batch is skipped, not called again.
   * Not called for script-inner tool calls, nor when the framework fills in
   * error results for a batch whose stream ended before its tools answered.
   */
  onToolBatchComplete?(agentName: string): Promise<void>;

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
  /** Current values for the extension's keys. A refused agent_settings call
   *  names what changed by comparing every field this returns, before the
   *  call and at its refusal. */
  get(agentName: string): Record<string, unknown>;
  /** Apply a partial update (only this extension's keys present) and return
   *  the new values. Throw to surface a validation error to the agent. */
  update(agentName: string, patch: Record<string, unknown>): Record<string, unknown>;
  /** Restore the listed keys (or all when omitted) to defaults and return the
   *  new values. Optional: without it, a reset of every setting skips the
   *  extension, and a reset that names one of its keys is refused. */
  reset?(agentName: string, keys?: string[]): Record<string, unknown>;
}

/**
 * Context provided to modules for interacting with the framework.
 *
 * Once the module's `stop()` has completed, through `removeModule()` or the
 * framework's `stop()`, its context has no effect on the framework:
 * - each push is dropped with a log line, as a push after the framework's
 *   `stop()` is;
 * - `setState`, `registerLogState`, `appendToLog`, `editLogItem`,
 *   `editMessage`, `removeMessage`, `notifyOps`, `registerSpeechHandler` and
 *   `unregisterSpeechHandler` do nothing; `addMessage` returns `''` and adds
 *   nothing; `callTool` resolves with an error result and runs nothing;
 *   `getModule` returns `null`; and `onTrace` subscribes nothing, while the
 *   subscriptions made through the context end. None of these throws, and
 *   the first such call of each method logs one line naming the module and
 *   the method;
 * - `findMessageByExternalId` answers without updating its mapping, and logs
 *   nothing.
 *
 * Its reads (`getState`, `getLog`, `getLogLength`, `getMessage`,
 * `queryMessages`, `getAgents`, `getActiveTools`, `findMessageByExternalId`)
 * answer, and fail, as before; one that meets a held write may record that
 * the write has landed, as any reader's does. The framework calls none of the
 * module's `onProcess`, `onAgentSpeech` and `onToolBatchComplete` again; it
 * drops whole a response of its that hadn't been applied by then, with a line
 * naming what the response asked for if it asked for anything; and it leaves
 * its `gatherContext` answer out of a turn whose answers it hadn't merged by
 * then, with a line if it held injections. After `removeModule()`, the result
 * its `handleToolCall` returns for a call it was running when its `stop()`
 * completed is still delivered while the framework runs. The framework's
 * `stop()` closes its event queue before it stops any module, so through the
 * framework's `stop()` that result is dropped, with the line any tool result
 * arriving after the framework's `stop()` gets. A result it pushes through
 * its context after its `stop()` completes is dropped, as its other pushes
 * are. A module whose `stop()` fails stays registered, and its context keeps
 * working.
 * References the module already holds, to other modules or to its own
 * timers, stay as they are.
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
   * handles consolidation. The cadence applies when the state is first
   * registered: a store that already holds the state keeps the cadence it was
   * registered with. `name` must not be 'state' (reserved for the main
   * snapshot state) and must not contain '/'. A registration that fails
   * throws, naming the state, and leaves the name unregistered.
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
   * Process queue for pushing events from external listeners. Once stop()
   * has begun, a push is dropped with a log line naming this module, as
   * pushEvent()'s is.
   * @deprecated Use pushEvent() instead — it also emits process:received traces.
   */
  readonly queue: ProcessQueue;

  /**
   * Push a process event to the queue and emit a process:received trace.
   * Preferred over direct queue.push() for proper observability. Once stop()
   * has begun, nothing will process the event: it's dropped with a log line
   * naming this module, untraced, rather than thrown into the listener or
   * stop() that pushed it.
   */
  pushEvent(event: ProcessEvent): void;

  /**
   * Get another module by name.
   */
  getModule<T extends Module>(name: string): T | null;

  /**
   * Add a message to the conversation, and answer its id. While the
   * framework holds the write (the agent's turn is alive, or the host is
   * quiesced), the id is a handle, `held:` and the write's id, which
   * getMessage, editMessage and removeMessage take as they take a stored
   * id, and which names the stored row once the write lands
   * (ModuleMessage.held). The writes a process held, and keeps across a
   * restart, show to the next process's modules once create() has restored
   * them, which is after every module's start().
   *
   * With `opts.forAgent`, it's added to the named agent's window instead: a
   * conversation fork's or a running sub-agent's own store, or, for an
   * ordinary resident, the residents' shared slot. It's held while that
   * agent's turn is alive, as a write for the primary is while the
   * primary's is. A name that isn't a registered agent when the write is
   * made, or the empty name, throws, naming the registered ones, so a write
   * for a launcher that has gone is heard. For an ephemeral run (a
   * sub-agent's run) or a conversation fork, whose window nothing reads
   * after it's released, a write it never read goes to the primary at its
   * release, as the write itself, through the primary's own delivery. It's
   * read as the framework reads a notice: once it's below the target's
   * consumed watermark, which a compile built to send moves when it
   * commits (a row that compile's strategy left out counts as read too),
   * and a tool round moves when it injects messages into a stream that
   * declares it carries them. So one that waited for its target's end (a
   * run's end, or a fork's last turn), one stored while it was idle and
   * never sent, and one stored at a tool round that ended the turn go to
   * the primary. The framework's own
   * writes for a run or a fork are unchanged: they stay in its store,
   * unless they're notices the primary already takes in their place (a
   * failed reply, or a channel notice its reader could act on). getMessage,
   * editMessage and removeMessage read the delivery agent's window (the
   * primary's, or the first agent's when none is primary): they don't take
   * an id or handle for a row in a fork's or a sub-agent's window, and don't
   * find it (read it with queryMessages and the same forAgent). The
   * residents' shared slot is the primary's window too, for a primary
   * that's an ordinary resident, so there they do.
   * `metadata.external` with a target throws: its id map is read in the
   * primary's window.
   */
  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata & { external?: ExternalIdRef },
    opts?: { forAgent?: string },
  ): MessageId;

  /**
   * Edit a message, by its id or a held write's handle. A held write is
   * stored with the new content. One whose earlier write may already be
   * stored, where the store can't be searched to tell, throws with nothing
   * changed.
   */
  editMessage(id: MessageId, content: ContentBlock[]): void;

  /**
   * Remove a message, by its id or a held write's handle. A held write is
   * dropped, so the agent never reads it. One whose earlier write may
   * already be stored, where the store can't be searched to tell, throws
   * with nothing changed.
   */
  removeMessage(id: MessageId): void;

  /**
   * Find the message for an external ID this context added a message under:
   * the row it added, while the store holds it. For a write the framework
   * held, whose id this context doesn't keep, the first row the store shows
   * under that external ID, held rows included, a held row by its handle.
   * Null when this context added none under it, when the row it added is
   * gone, or when the store shows none for a held write, such as one the
   * last process held, looked up in start().
   */
  findMessageByExternalId(source: string, externalId: string): MessageId | null;

  /**
   * Get a message by its id or a held write's handle, marked
   * `heldFromResidents` when a tune-out holds it from the residents
   * (ModuleMessage).
   */
  getMessage(id: MessageId): ModuleMessage | null;

  /**
   * Query messages by filter criteria.
   * Useful for finding messages from external sources, by participant, etc.
   * The rows of writes the framework holds come after the stored rows, as
   * the newest, or before them in a reversed query, marked `held`
   * (ModuleMessage). Those the last process held show once create() has
   * restored them, after every module's start() (addMessage). A message a
   * tune-out holds from the residents is among the rows, marked
   * `heldFromResidents` (ModuleMessage).
   *
   * It reads the primary's window (the first registered agent's when none
   * is primary), or with `opts.forAgent`, the named agent's: a conversation
   * fork's or a running sub-agent's own store, or, for an ordinary resident,
   * the residents' shared slot. For the subconscious, it's the
   * subconscious's own store, not the residents' slot its compile merges
   * in. A name that isn't a registered agent, or the empty name, throws,
   * naming the registered ones, so a typo is heard rather than read as an
   * empty window.
   */
  queryMessages(filter: MessageQuery, opts?: { forAgent?: string }): MessageQueryResult;

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
   * `inference:started` and the terminal events: `inference:completed` (the
   * model answered and the turn ended, with a final response or with a tool
   * result that ended it, which `inference:turn_ended` then follows),
   * `inference:aborted`, `inference:failed` and `inference:exhausted`, all of
   * which carry `agentName`. A turn's tool-call cycles stay inside its
   * stream, so one bracket spans them. A context-budget restart emits
   * `inference:started` again with no terminal event for the stream it
   * replaced, and a failing turn can emit `inference:failed` and then
   * `inference:exhausted`, so a bracket should allow a repeated start or end.
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
   * Queue for emitting follow-up events. Once stop() has begun, a push is
   * dropped with a log line naming the module, as pushEvent()'s is.
   * @deprecated Use pushEvent() instead — it also emits process:received traces.
   */
  readonly queue: ProcessQueue;

  /**
   * Push a process event to the queue and emit a process:received trace.
   * Preferred over direct queue.push() for proper observability. Once stop()
   * has begun, the event is dropped with a log line naming the module,
   * untraced.
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
 * Response from a module's event handler. The framework applies it in this
 * order: its messages added, edited and removed, then its stateUpdate, then
 * its inference request. When one of these throws, such as an edit of a
 * message the store doesn't hold, what came before it stays applied, the
 * operation that threw may have taken effect in part or whole (a store can
 * throw after it wrote), the rest of the response isn't, and a line names
 * the module and where it threw; the event's other responses, a tool call's dispatch and its trace
 * go on. Content the framework finds malformed refuses the whole response
 * before any of it applies.
 */
export interface EventResponse {
  /**
   * Messages to add to the conversation.
   */
  addMessages?: NewMessage[];

  /**
   * Messages to edit, each by its id or a held write's handle
   * (ModuleContext.editMessage).
   */
  editMessages?: MessageEdit[];

  /**
   * Messages to remove, each by its id or a held write's handle
   * (ModuleContext.removeMessage).
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
   * Module state update. The framework calls setState() with this value
   * after applying the response's message changes, and not when one of
   * them threw.
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

  /**
   * The turn this speech ends: the same id as `ToolCall.callerTurnId` on the
   * calls made in it (its model's calls, and a script's calls that reach the
   * host while a code_execution call of the turn watches the script), kept across the
   * turn's streams (a context-budget restart or a
   * retry), and larger for the agent's next turn. Unique only within one run
   * of the process.
   */
  turnId?: number;
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
