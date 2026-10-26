export { EventGate, wakeProvenance, wakeLineText, type WakeProvenance, type WritePlacement } from './event-gate.js';
export type {
  GateConfig,
  GateOptions,
  GatePolicy,
  GatePolicyMatch,
  GateBehavior,
  GateDecision,
  GateEventInfo,
  GateStatus,
  GatePolicyStats,
  WakeLine,
  JudgeConfig,
  JudgeEventSummary,
  JudgeFn,
  JudgeRequest,
  JudgeVerdict,
  ReplyJudgeOptions,
  UpcomingWake,
} from './types.js';
export { ReplyJudge, DEFAULT_JUDGE_MODEL, type ReplyJudgeDeps } from './reply-judge.js';
