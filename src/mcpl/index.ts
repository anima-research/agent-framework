// MCPL Protocol Types
export type {
  // JSON-RPC
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,

  // Content blocks (wire format)
  McplContentBlock,
  McplTextContent,
  McplImageContent,
  McplAudioContent,
  McplResourceContent,

  // Capability negotiation
  McplCapabilities,
  McplHostCapabilities,
  McplChannelCapabilities,

  // Server configuration
  McplServerConfig,

  // Feature sets
  FeatureSetUse,
  FeatureSetDeclaration,
  FeatureSetsUpdateParams,
  FeatureSetsChangedParams,

  // Scoped access
  ScopeConfig,
  ScopeLabel,
  ScopeElevateParams,
  ScopeElevateResult,

  // State management
  StateCheckpoint,
  JsonPatchOperation,
  StateRollbackParams,
  StateRollbackResult,

  // Push events
  PushEventParams,
  PushEventResult,

  // Context hooks
  McplModelInfo,
  BeforeInferenceParams,
  McplContextInjection,
  BeforeInferenceResult,
  AfterInferenceParams,
  AfterInferenceResult,

  // Server-initiated inference
  McplMessage,
  McplInferenceRequestParams,
  McplInferencePreferences,
  McplInferenceRequestResult,
  InferenceChunkParams,

  // Channels
  ChannelDescriptor,
  ChannelContext,
  ChannelsRegisterParams,
  ChannelsRegisterResult,
  ChannelsChangedParams,
  ChannelsListResult,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsOutgoingChunkParams,
  ChannelsOutgoingCompleteParams,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelIncomingMessage,
  ChannelsIncomingParams,
  ChannelsIncomingResult,
  ChannelIncomingMessageResult,

  // Inference routing policy
  InferenceRoutingPolicy,

  // Method names
  McplMethodName,

  // MCP standard tool types
  McpToolDefinition,
  McpToolCallResult,
  McpToolResultContent,
} from './types.js';

export { McplMethod } from './types.js';

// Error codes and factories
export {
  FEATURE_SET_NOT_ENABLED,
  UNKNOWN_FEATURE_SET,
  CHECKPOINT_NOT_FOUND,
  CHANNEL_NOT_PERMITTED,
  UNKNOWN_CHANNEL,
  CHANNEL_OPEN_FAILED,
  featureSetNotEnabled,
  unknownFeatureSet,
  checkpointNotFound,
  channelNotPermitted,
  unknownChannel,
  channelOpenFailed,
} from './errors.js';

// Server connection and registry
export { McplServerConnection } from './server-connection.js';
export { McplServerRegistry, type McplCapabilityQuery } from './server-registry.js';

// Feature set management (permission layer)
export { FeatureSetManager, McplFeatureSetError } from './feature-set-manager.js';

// Scope management (whitelist/blacklist enforcement)
export { ScopeManager, type ElevationHandler } from './scope-manager.js';

// Hook orchestration (beforeInference/afterInference fan-out)
export { HookOrchestrator } from './hook-orchestrator.js';

// Push events (Section 9)
export { PushHandler } from './push-handler.js';
export type { McplPushEvent } from './push-handler.js';

// Server-initiated inference (Section 11)
export { InferenceRouter } from './inference-router.js';

// Channel registry (channel lifecycle, incoming messages, synthesized tools)
export { ChannelRegistry } from './channel-registry.js';

// State management (Section 8, checkpoint trees + JSON Patch)
export { CheckpointManager, applyJsonPatch } from './checkpoint-manager.js';
