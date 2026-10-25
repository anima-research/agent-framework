export { AgentRegistry, AgentSpecError, RESIDENTS_SLOT, sameSlot, observedSlot } from './registry.js';
export type { AgentRegistryOptions, RestoreOutcome, ReconcileOutcome } from './registry.js';
export {
  residentSpec,
  subconsciousSpec,
  conversationForkSpec,
  workerSpec,
  taskForkSpec,
  DEFAULT_TASK_IDLE_TIMEOUT_MS,
} from './presets.js';
export type { BoundedJobOptions } from './presets.js';
export type {
  AgentName,
  AgentKind,
  AgentRoles,
  AgentLifetime,
  ActivationBounds,
  ParentEndPolicy,
  ResultRoute,
  MessageSlotRef,
  ObserveEdge,
  AgentRelationships,
  ContextInheritance,
  AgentSpec,
  AgentEndReason,
  AgentRef,
  ActivationRecord,
  AgentRecord,
  HeldMail,
  RegistrySnapshot,
  EndOutcome,
  PolicyEpoch,
} from './types.js';
export {
  AUDIENCE_KEY,
  OWN_ROW_KEY,
  withAudience,
  asOwnRow,
  audienceOf,
  isOwnRowOf,
  storeOwnRow,
} from './audience.js';
export type { AudienceStamp, OwnRowWriter } from './audience.js';
