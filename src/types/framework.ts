import type { JsStore } from '@animalabs/chronicle';
import type { Membrane } from '@animalabs/membrane';
import type { Module, EventResponse } from './module.js';
import type { AgentConfig, InferenceRequest } from './agent.js';
import type { ProcessEvent } from './events.js';
import type { McplServerConfig, InferenceRoutingPolicy } from '../mcpl/types.js';
import type { ConversationRouterConfig } from '../mcpl/conversation-router.js';
import type { GateOptions } from '../gate/types.js';

// Re-export trace types
export type { TraceEvent, TraceEventListener } from './trace.js';

/**
 * A module's response to a process event, tagged with the module name.
 */
export interface ModuleProcessResponse {
  moduleName: string;
  response: EventResponse;
}

/**
 * Configuration for process event logging.
 */
export interface ProcessLoggingConfig {
  /** Persist process logs to Chronicle (default: false) */
  persist?: boolean;
  /** Broadcast process:completed trace events (default: false) */
  broadcast?: boolean;
}

/**
 * Configuration for the agent framework.
 */
/**
 * Client-side programmatic tool calling: a synthesized `code_execution` tool
 * that runs model-authored Python on the host, with every framework tool
 * injected as an async function. Mirrors the trained surface of Anthropic's
 * server-side PTC; inner tool results never enter the model context.
 *
 * Robustness boundary, not a security sandbox (same doctrine as gate.js —
 * the agent already has broader host access through its tools).
 */
export interface CodeExecutionConfig {
  /** Master switch — the tool is only synthesized when true. */
  enabled: boolean;
  /** Python interpreter to spawn (default: 'python3' from PATH). */
  pythonPath?: string;
  /**
   * Per-inner-tool-call timeout; exceeding it raises TimeoutError inside the
   * script (default 270_000 ms, mirroring the managed runtime's message).
   */
  toolCallTimeoutMs?: number;
  /** Whole-script deadline: cancel → grace → SIGKILL (default 600_000 ms). */
  scriptTimeoutMs?: number;
  /**
   * Idle interpreter reclaim — script globals are lost after this much
   * inactivity (default 300_000 ms, mirroring ~5-minute container reclaim).
   * 0 disables reclaim.
   */
  idleReclaimMs?: number;
  /** Max concurrent background (daemon) scripts per agent (default 3). */
  maxBackgroundScripts?: number;
  /** Background script lifetime ceiling, ms (default 86_400_000 = 24h). */
  backgroundMaxLifetimeMs?: number;
  /** Minimum interval between wake_agent() deliveries, ms (default 60_000).
   *  Early wakes are delayed, not dropped (backpressure inside the script). */
  wakeMinIntervalMs?: number;
  /** Max wake_agent() calls per background script (default 100); further
   *  calls raise RuntimeError inside the script. */
  maxWakesPerScript?: number;
}

export interface FrameworkConfig {
  /**
   * IANA zone used only when rendering wall-clock times for the agent.
   * Stored/protocol timestamps remain epoch/UTC. Defaults to AGENT_TIMEZONE,
   * then the process zone.
   */
  timeZone?: string;

  /** Path to Chronicle store */
  storePath?: string;

  /**
   * Branch-independent Discord awareness-marker outbox. Defaults to
   * `<storePath>/recovery/discord-awareness-outbox.json`. Set explicitly when
   * providing an app-owned `store` without `storePath`; omit to disable.
   */
  discordAwarenessOutboxPath?: string;

  /** Emoji used for branch-awareness markers (default: 💤). */
  discordAwarenessEmoji?: string;

  /**
   * Mandatory deadline for each Discord awareness marker tools/call. This is
   * independent of MCPL requestTimeoutMs and cannot be disabled with 0.
   * Values are clamped to 50..60000ms; 0 selects the 10000ms default.
   */
  discordAwarenessDeadlineMs?: number;

  /** Or existing store (app-owned) */
  store?: JsStore;

  /** Membrane instance for LLM calls */
  membrane: Membrane;

  /** Agent configurations */
  agents: AgentConfig[];

  /** Modules to load */
  modules: Module[];

  /** Custom inference policy */
  inferencePolicy?: InferencePolicy;

  /** Custom error policy */
  errorPolicy?: ErrorPolicy;

  /** Interval for periodic store sync in milliseconds (default: 1000ms, 0 to disable) */
  syncIntervalMs?: number;

  /**
   * Interval for queued context-maintenance polling in milliseconds
   * (default: 5000ms, 0 to disable). Each pass refreshes the agent's live tool
   * definitions, then advances pending compression/indexing work.
   */
  maintenanceIntervalMs?: number;

  /** Process logging configuration (default: disabled) */
  processLogging?: ProcessLoggingConfig;

  /** MCPL server configurations. If omitted or empty, no MCPL subsystems are created. */
  mcplServers?: McplServerConfig[];

  /**
   * Client-side programmatic tool calling (`code_execution` tool). Omitted or
   * `enabled: false` → tool absent, no python is ever spawned.
   */
  codeExecution?: CodeExecutionConfig;

  /** Inference routing policy for server-initiated inference (optional). */
  inferenceRouting?: InferenceRoutingPolicy;

  /** EventGate config. If omitted, all events trigger inference (unchanged default). */
  gate?: GateOptions;

  /**
   * Liveness watchdog: fail hard (and let the supervisor restart) if the main
   * thread wedges — a synchronous infinite loop or microtask flood that would
   * otherwise leave the agent silently deaf. Off unless `enabled` is set.
   */
  watchdog?: {
    enabled?: boolean;
    /** Kill if no heartbeat for this long (ms). Default 30000. */
    thresholdMs?: number;
    /** 'abort' → SIGABRT (core dump for debugging); 'exit' → SIGKILL. Default 'abort'. */
    action?: 'abort' | 'exit';
    /** Optional path for a JSON wedge report written before the kill. */
    reportPath?: string;
  };

  /**
   * Per-channel conversation routing. When set, incoming MCPL channel
   * messages route to per-channel fork agents spawned from the template
   * agent instead of the primary conversation. If omitted, behavior is
   * unchanged (all messages go to the primary agent).
   */
  conversations?: ConversationRouterConfig;
}

/** One agent's outcome within a periodic context-maintenance pass. */
export interface ContextMaintenanceAgentRun {
  agentName: string;
  startedAt: number;
  finishedAt?: number;
  ticks: number;
  readyBefore: boolean;
  readyAfter?: boolean;
  pendingBefore?: string;
  pendingAfter?: string;
  progressBefore?: Record<string, unknown>;
  progressAfter?: Record<string, unknown>;
  error?: string;
}

/** A bounded periodic context-maintenance pass. */
export interface ContextMaintenanceRun {
  id: number;
  startedAt: number;
  finishedAt?: number;
  agents: ContextMaintenanceAgentRun[];
}

/** Debug-safe maintenance state. Contains counts and errors, never messages. */
export interface ContextMaintenanceSnapshot {
  intervalMs: number;
  ticksPerPass: number;
  current: ContextMaintenanceRun | null;
  history: ContextMaintenanceRun[];
  agents: Array<{
    agentName: string;
    ready: boolean;
    pending?: string;
    progress?: Record<string, unknown>;
  }>;
}

/**
 * Policy for deciding when to run inference.
 */
export interface InferencePolicy {
  /**
   * Decide whether to run inference for an agent.
   */
  shouldInfer(
    agentName: string,
    requests: InferenceRequest[],
    state: FrameworkState
  ): boolean;
}

/**
 * Policy for handling errors.
 */
export interface ErrorPolicy {
  /**
   * Handle an inference error.
   */
  onInferenceError(
    error: Error,
    agentName: string,
    attempt: number
  ): ErrorAction;

  /** Maximum retry attempts */
  maxRetries: number;
}

/**
 * Action to take after an error.
 */
export type ErrorAction =
  | { retry: true; delayMs: number }
  | { retry: false; emit?: ProcessEvent };

/**
 * Terminal result for a framework-driven ephemeral agent run.
 */
export interface AgentSettleResult {
  stopReason: 'completed' | 'turn_ended' | 'exhausted';
  speech: string;
  toolCallsCount: number;
  error?: string;
}

/**
 * Framework state exposed to policies.
 */
export interface FrameworkState {
  /** Get agent status */
  getAgentStatus(name: string): import('./agent.js').AgentState | null;

  /** Get module by name */
  getModule(name: string): Module | null;

  /** Get all pending inference requests */
  getPendingRequests(): InferenceRequest[];

  /** Current queue depth */
  queueDepth: number;
}

/**
 * Entry in the inference log.
 */
export interface InferenceLogEntry {
  timestamp: number;
  agentName: string;
  requestId: string;
  /** Whether inference succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Request data or blob ID if large */
  request: unknown | { blobId: string };
  /** Response data or blob ID if large (only if successful) */
  response?: unknown | { blobId: string };
  durationMs: number;
  tokenUsage?: {
    input: number;
    output: number;
    cacheCreation?: number;
    cacheRead?: number;
  };
  /** Stop reason from the model */
  stopReason?: string;
}

/**
 * Entry in the process log - records a processed event with all module responses.
 */
export interface ProcessLogEntry {
  timestamp: number;
  /** The process event that was handled */
  processEvent: ProcessEvent;
  /** Responses from all modules, or blob ID if large */
  responses: ModuleProcessResponse[] | { blobId: string };
}

/**
 * Query options for process logs.
 */
export interface ProcessLogQuery {
  /** Filter by process event type */
  eventType?: string;
  /** Filter by module name (modules that responded) */
  moduleName?: string;
  /** Max number of logs to return */
  limit?: number;
  /** Skip first N logs (for pagination) */
  offset?: number;
  /** Search pattern for content (regex) */
  pattern?: string;
}

/**
 * Result from querying process logs.
 */
export interface ProcessLogQueryResult {
  entries: ProcessLogEntryWithId[];
  total: number;
  hasMore: boolean;
}

/**
 * Process log entry with Chronicle sequence ID.
 */
export interface ProcessLogEntryWithId {
  sequence: number;
  entry: ProcessLogEntry;
  /** Summary for display without resolving blobs */
  summary?: ProcessLogSummary;
}

/**
 * Summary view of a process log (without full responses).
 */
export interface ProcessLogSummary {
  timestamp: number;
  eventType: string;
  moduleCount: number;
  /** Modules that requested inference */
  modulesRequestingInference: string[];
  /** Modules that added messages */
  modulesAddingMessages: string[];
  /** Whether responses are stored as blob */
  responsesIsBlob: boolean;
}
