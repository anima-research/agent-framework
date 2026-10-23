// Types
export * from './types/index.js';

// Core classes
export { AgentFramework, AgentStoppedError, BudgetPreflightError, ProviderWaitNotSleptError, QuiesceBlockedError, ResumeBlockedError } from './framework.js';
export type { RuntimeSettingsPreview, HostModeStatus, DeriveAgentOptions } from './framework.js';
export { Agent } from './agent.js';
export type { StartStreamResult } from './agent.js';
export { ProcessQueueImpl } from './queue.js';
export { ModuleRegistry } from './module-registry.js';
export { ShutdownTimeoutError, DEFAULT_SHUTDOWN_TIMEOUT_MS } from './shutdown.js';
export { formatZonedDateTime, formatZonedTime, isValidTimeZone, resolveTimeZone } from './timezone.js';
export { CLOCK_ROW_KIND, resolveClockConfig } from './clock-rows.js';
export type { ClockConfig, ClockStamp, ResolvedClockConfig } from './clock-rows.js';
export { REFUSAL_REACTIONS, REFUSAL_REACTION_FALLBACK, REFUSAL_REACTION_BASELINE } from './refusal-reactions.js';

// Dendrite: agent registry, lifecycle and presets
export * from './dendrite/index.js';

// Built-in modules
export * from './modules/index.js';

// API
export { ApiServer } from './api/server.js';
export { McpServer } from './api/mcp-server-core.js';
export type {
  ApiServerConfig,
  ApiMessage,
  ApiRequest,
  ApiResponse,
  ApiEvent,
  ApiCommand,
  MessageSendParams,
  MessageListParams,
  InferenceRequestParams,
  InferenceAbortParams,
  BranchCreateParams,
  BranchSwitchParams,
  BranchDeleteParams,
  AgentContextParams,
  ModuleStateParams,
  StoreInspectParams,
  MessageInfo,
  BranchInfo,
  ModuleInfo,
  StateInfo,
  ApiEventType,
  InferenceStartEvent,
  InferenceCompleteEvent,
  InferenceAbortedEvent,
  InferenceErrorEvent,
  ToolStartEvent,
  ToolCompleteEvent,
  ToolErrorEvent,
  SpeechEvent,
  MessageAddedEvent,
  BranchSwitchedEvent,
  BranchCreatedEvent,
  BranchDeletedEvent,
} from './api/types.js';
// Note: AgentInfo, MessageEditedEvent, MessageRemovedEvent intentionally not re-exported
// from api/types.js to avoid conflicts with ./types/index.js

// Usage tracking
export { UsageTracker } from './usage/index.js';

// Client-side programmatic tool calling (code_execution): the tool's name,
// and its definition as an agent reads it.
export { buildCodeExecutionToolDefinition, CODE_EXECUTION_TOOL_NAME } from './code-execution/index.js';
export type { SessionUsage, AgentUsage, SessionUsageSnapshot, UsageUpdatedEvent } from './usage/index.js';

// EventGate
export { EventGate, type WakeProvenance } from './gate/index.js';
export type { GateConfig, GateOptions, GatePolicy, GatePolicyMatch, GateBehavior } from './gate/index.js';

// MCPL channel registry (exposed for modules that need channel-level operations)
export { ChannelRegistry } from './mcpl/index.js';
export type { PublishRefusalReason } from './mcpl/index.js';

// Where each accepted inbound item came from (`metadata.inboundSource`), and
// the digest its delivered and stored bodies are stamped with
// (`metadata.sourceBodyDigest`, `metadata.storedBodyDigest`)
export { INBOUND_SOURCE_KEY, readInboundSource, conversationKey, sourceBodyDigest } from './mcpl/index.js';
export type {
  InboundSource,
  InboundChannelSource,
  InboundUnscopedSource,
  InboundSurfaceSource,
} from './mcpl/index.js';

// MCPL server config (exposed for hosts that manage servers at runtime via
// connectMcplServer / disconnectMcplServer / restartMcplServer)
export type { McplServerConfig } from './mcpl/index.js';

// Both engines' client connections, and the configuration helpers and
// protocol revisions they share (exposed so external tooling, such as server
// playtests, health probes and protocol harnesses, can reach a server
// exactly the way the framework host does: MCPL over stdio or WebSocket, and
// modern MCP over stdio or Streamable HTTP)
export { McplServerConnection, McplRequestError, McplProtocolVersionError, McplUnreapedLaunchError } from './mcpl/index.js';
export { ModernMcpConnection } from './mcpl/index.js';
export type { ModernToolCallResult } from './mcpl/index.js';
export {
  LEGACY_MCP_PROTOCOL_VERSION,
  MODERN_MCP_PROTOCOL_VERSION,
  resolveServerBinding,
  serverConfigProblems,
  serverConfigWarnings,
  checkServerConfig,
} from './mcpl/index.js';
export type { McpProtocolFamily, McpTransportKind, ServerBinding } from './mcpl/index.js';
export type { McplHostCapabilities, McplConnectionCloseInfo } from './mcpl/index.js';

// MCPL tool lifecycle (RFC-007) and tool classes (RFC-008): the types a host
// needs to write McplServerConfig.toolLifecycle policy and class tables, and
// the portable pattern matcher both use.
export { TOOL_CLASSES, DEFAULT_INPUT_CLASSES, globMatch } from './mcpl/index.js';
export type {
  ToolClass,
  ToolClassSource,
  ToolLifecycleConfig,
  ToolLifecycleNarrowing,
  ToolLifecycleParams,
  ToolObserveRule,
} from './mcpl/index.js';

// Per-channel conversation routing
/** @deprecated Per-channel conversation routing is deprecated and will be removed (anima-research/agent-framework#235). */
export { ConversationRouter, DEFAULT_CLOSURE_PROMPT } from './mcpl/index.js';
/** @deprecated Per-channel conversation routing is deprecated and will be removed (anima-research/agent-framework#235). */
export type {
  ConversationRouterConfig,
  ConversationBinding,
  RoutingDecision,
  IncomingMessageFacts,
  BindRule,
  TriggerRule,
  ChannelKind,
} from './mcpl/index.js';

// Re-export commonly used types from dependencies
export type { ContextManager, ContextStrategy, TokenBudget } from '@animalabs/context-manager';
export { PassthroughStrategy, AutobiographicalStrategy, KnowledgeStrategy } from '@animalabs/context-manager';
export type { KnowledgeConfig, PhaseType } from '@animalabs/context-manager';
export type { Membrane, NormalizedMessage, NormalizedRequest, ContentBlock } from '@animalabs/membrane';

// Offline outage recovery and the Discord awareness-mark ledger
export {
  DiscordAwarenessOutbox,
  DiscordAwarenessRefusal,
  DEFAULT_DISCORD_AWARENESS_EMOJI,
  defaultDiscordAwarenessOutboxPath,
  extractDiscordAwarenessRefs,
  isPermanentDiscordReactionFailure,
  selectDiscordAwarenessRefs,
} from './recovery/discord-awareness-outbox.js';
export type {
  DiscordAwarenessAction,
  DiscordAwarenessBatch,
  DiscordAwarenessBatchStatus,
  DiscordAwarenessBatchView,
  DiscordAwarenessRetractView,
  DiscordAwarenessView,
  DiscordAwarenessCancelReceipt,
  DiscordAwarenessMarks,
  DiscordAwarenessOutcome,
  DiscordAwarenessPrepareInput,
  DiscordAwarenessReactionState,
  DiscordAwarenessImportedUnsent,
  DiscordAwarenessRef,
  DiscordAwarenessRequest,
  DiscordAwarenessRetractReceipt,
  DiscordAwarenessRetirement,
  DiscordAwarenessScope,
  DiscordAwarenessSettlement,
  DiscordSuppressionInterval,
} from './recovery/discord-awareness-outbox.js';
// Live operator surgery (rollback / suppress) and its durable action log
export { OperatorLog, OperatorActionError, defaultOperatorLogPath } from './operator-log.js';
export type {
  OperatorLogEntry,
  OperatorLogInput,
  OperatorRequester,
  SurgeryMarkerFacts,
  SurgeryMarkerReceipt,
  SurgeryMarksPreview,
} from './operator-log.js';
export { createOfflineRecoveryBranch } from './recovery/offline-branch.js';
export type {
  OfflineRecoveryBranchOptions,
  OfflineRecoveryBranchResult,
} from './recovery/offline-branch.js';

export * from "./tool-presentation.js";

// Tune-out: the subconscious configuration and the default reader-fork framing.
export { presentAuthor, authorLine, authorNamed, ANONYMOUS_PARTICIPANT } from './author-presentation.js';
export {
  defaultReaderFraming,
  type SubconsciousConfig,
  type PersistentReaderConfig,
  type ForkReaderConfig,
  type ReaderFramingContext,
} from './tune-out/tools.js';
export {
  SILENT_HEARTBEAT_SEPARATOR,
  silentHeartbeatOf,
  type RequestOnlyPrompt,
  type SilentHeartbeatStamp,
  type SilentHeartbeatTick,
} from './silent-heartbeat.js';
