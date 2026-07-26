// Types
export * from './types/index.js';

// Core classes
export { AgentFramework } from './framework.js';
export { Agent } from './agent.js';
export type { StartStreamResult } from './agent.js';
export { ProcessQueueImpl } from './queue.js';
export { ModuleRegistry } from './module-registry.js';
export { formatZonedDateTime, formatZonedTime, isValidTimeZone, resolveTimeZone } from './timezone.js';

// Built-in modules
export * from './modules/index.js';

// API
export { ApiServer } from './api/server.js';
export { McpServer } from './api/mcp-server.js';
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

// Client-side programmatic tool calling (code_execution): exposed so external
// tooling can drive the python runtime the way the framework does (protocol
// harnesses, runtime smoke tests).
export {
  PyRunner,
  buildInjectedTools,
  buildCodeExecutionToolDefinition,
  CODE_EXECUTION_TOOL_NAME,
  PYTHON_RUNTIME_SOURCE,
} from './code-execution/index.js';
export type {
  InjectedTool,
  ExecResult,
  PyRunnerOptions,
  ScriptToolCallHandler,
} from './code-execution/index.js';
export type { SessionUsage, AgentUsage, SessionUsageSnapshot, UsageUpdatedEvent } from './usage/index.js';

// EventGate
export { EventGate } from './gate/index.js';
export type { GateConfig, GateOptions, GatePolicy, GatePolicyMatch, GateBehavior } from './gate/index.js';

// MCPL channel registry (exposed for modules that need channel-level operations)
export { ChannelRegistry } from './mcpl/index.js';

// MCPL server config (exposed for hosts that manage servers at runtime via
// connectMcplServer / disconnectMcplServer / restartMcplServer)
export type { McplServerConfig } from './mcpl/index.js';

// MCPL client connection (exposed so external tooling — server playtests,
// health probes, protocol harnesses — can dial an MCPL server exactly the
// way the framework host does, over stdio or WebSocket)
export { McplServerConnection } from './mcpl/index.js';
export type { McplHostCapabilities } from './mcpl/index.js';

// Per-channel conversation routing
export { ConversationRouter, DEFAULT_CLOSURE_PROMPT } from './mcpl/index.js';
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

// Offline outage recovery and branch-independent Discord awareness markers
export {
  DiscordAwarenessOutbox,
  DEFAULT_DISCORD_AWARENESS_EMOJI,
  defaultDiscordAwarenessOutboxPath,
  extractDiscordAwarenessRefs,
} from './recovery/discord-awareness-outbox.js';
export type {
  DiscordAwarenessBatch,
  DiscordAwarenessEntry,
  DiscordAwarenessOperation,
  DiscordAwarenessRef,
  DiscordSuppressionInterval,
} from './recovery/discord-awareness-outbox.js';
export { createOfflineRecoveryBranch } from './recovery/offline-branch.js';
export type {
  OfflineRecoveryBranchOptions,
  OfflineRecoveryBranchResult,
} from './recovery/offline-branch.js';
