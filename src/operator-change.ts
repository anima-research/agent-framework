/**
 * Operator-change admission: the framework resolves each of its own operator
 * mutations to an absolute change and hands it to the host's gate
 * (FrameworkConfig.operatorChangeGate), which stages it and answers with a
 * receipt. Nothing mutates then. There is one way to apply a staged change:
 * AgentFramework.applyResolvedOperatorChange, under a held safe-boundary
 * lease, whenever the host finds it eligible.
 *
 * A change is resolved once. Application revalidates it against stable
 * identity (the active branch, the settings it was resolved from) and
 * applies exactly what was resolved, never the relative command again: a
 * change that no longer holds is refused as `stale` and the host restages it.
 */
import type { OperatorRequester, SurgeryMarkerReceipt } from './operator-log.js';

/** The host's receipt for a staged change, shown to whoever asked: the
 *  change is accepted and queued, not applied. */
export interface OperatorChangeReceipt {
  id: string;
  text: string;
}

/** Settings an agent_settings action touches, by snapshot key. null = unset. */
export type RuntimeSettingsValues = Partial<
  Record<'contextBudgetTokens' | 'tailTokens' | 'transitionPaceTokens' | 'sameRoundThinkTextPolicy', number | string | null>
>;

interface ResolvedOperatorChangeBase {
  /** The framework's id for this resolution. */
  id: string;
  agent: string;
  /** Where the change came from: an operator's host/command, an operator
   *  acting through the agent's own tools (puppet), or a module. */
  surface: 'host-command' | 'puppet' | 'host';
  requester?: OperatorRequester;
  /** Epoch ms. */
  resolvedAt: number;
  /** The active branch when resolved: the stable identity application
   *  checks. Appending messages (a notice, an answer) doesn't change it. */
  sourceBranch: string;
  /** The store it was resolved in (AgentFramework's store identity). Branch
   *  names and message ids mean something only within one store, so a
   *  change is refused anywhere else, a replacement store included. */
  storeId: string;
}

/** agent_settings update / reset / cancel, from an operator or a module. */
export interface ResolvedSettingsChange extends ResolvedOperatorChangeBase {
  kind: 'agent-settings';
  /** The agent_settings input as given. */
  input: Record<string, unknown>;
  /** The touched core settings when resolved (getRuntimeSettings). */
  from: RuntimeSettingsValues;
  /** The concrete values the action leaves them at (Agent.previewRuntimeSettingsTarget).
   *  Application applies the action only if it still produces exactly these. */
  target: RuntimeSettingsValues;
  /** Host-managed (extension) keys the input touches: their values when
   *  resolved, and the values the change leaves them at, from each owner's
   *  preview (AgentSettingsExtension.preview). Application checks both. */
  extensions?: { from: Record<string, unknown>; target: Record<string, unknown> };
}

/** set_tool_visibility / set_tool_description, from an operator or a module. */
export interface ResolvedPresentationChange extends ResolvedOperatorChangeBase {
  kind: 'tool-presentation';
  tool: 'set_tool_visibility' | 'set_tool_description';
  input: Record<string, unknown>;
  /** The targeted tool's presentation entry when resolved. */
  from: { name: string; visible: boolean; description: string };
}

/** host/command undo by turns: the exact turn checkpoints it undoes. */
export interface ResolvedUndoTurnsChange extends ResolvedOperatorChangeBase {
  kind: 'undo-turns';
  /** Turns asked for. `checkpoints` holds fewer when history is shorter. */
  requestedTurns: number;
  /** The checkpoints it undoes, newest first. Application makes one cut at
   *  the oldest one's sequenceBefore, onto a branch named for this change. */
  checkpoints: Array<{ turnIndex: number; sequenceBefore: number; branchName: string }>;
  /** The operator's awareness-marks choice, frozen at staging: 'none', or a
   *  scope with exactly the refs the cut would have removed then. The cut
   *  can also reach messages that arrive later; application marks only the
   *  frozen refs it actually removed, reports later removals as unmarked,
   *  and never widens the set. */
  marks: 'none' | { scope: 'addressed' | 'all'; refs: Array<{ serverId: string; channelId: string; messageId: string }> };
  /** The MCPL server the command came from: marks whose message names no
   *  server are routed through it. */
  serverId?: string;
}

/**
 * host/command unstick, planned in full at staging: exchanges shed
 * newest-first, one per step, re-running the agent after each, until it
 * stops refusing or the plan is spent. The plan walks back from the tail as
 * it stood at staging and names every exchange that may go, so whoever is
 * asked approves a known range; nothing that arrives later is ever chosen.
 * The host drives it: applyResolvedOperatorChange per step under a lease,
 * rerunUnstick between steps outside any lease. AF keeps the durable record
 * (getUnstickOperation) in a store-bound, branch-independent journal.
 */
export interface ResolvedUnstickChange extends ResolvedOperatorChangeBase {
  kind: 'unstick';
  /** The operator's cap (1 to 10); `plan` is shorter when history runs out. */
  cap: number;
  /** Step k sheds exactly plan[k-1]'s messages, newest exchange first. Each
   *  message carries a fingerprint of its content, so an edit in place
   *  makes the step stale rather than shedding something not approved. */
  plan: Array<{ step: number; messageIds: string[]; fingerprints: string[] }>;
}

export type ResolvedOperatorChange =
  | ResolvedSettingsChange
  | ResolvedPresentationChange
  | ResolvedUndoTurnsChange
  | ResolvedUnstickChange;

/** One step of an unstick operation, as journaled: `intent` before its shed
 *  (with exactly what it will remove), `shed` once it is done. */
export interface UnstickStepRecord {
  step: number;
  status: 'intent' | 'shed';
  messageIds: string[];
}

/** One re-run of an unstick operation, as journaled. `launched` is written
 *  durably before the inference is queued. An attempt still `launched` when
 *  no process is running it was interrupted: its outcome is unknown, and it
 *  is never relaunched. */
export interface UnstickAttemptRecord {
  step: number;
  status: 'launched' | 'completed';
  outcome?: 'responded' | 'refused' | 'failed';
  category?: string;
  error?: string;
}

/** The durable record of an unstick operation (getUnstickOperation). */
export interface UnstickOperationRecord {
  operationId: string;
  agent: string;
  steps: UnstickStepRecord[];
  attempts: UnstickAttemptRecord[];
}

/** What rerunUnstick reports for a step's attempt. `interrupted`: launched,
 *  but no outcome was recorded and no process is running it; it may not have
 *  started, or may have finished without a receipt. */
export type UnstickAttemptOutcome =
  | { step: number; status: 'completed'; outcome: 'responded' | 'refused' | 'failed'; category?: string; error?: string }
  | { step: number; status: 'interrupted' };

/** What applyResolvedOperatorChange did. */
export type AppliedOperatorChange =
  | { kind: 'agent-settings'; result: unknown }
  | { kind: 'tool-presentation'; result: unknown }
  | {
      kind: 'undo-turns';
      requested: number;
      undone: number;
      fromBranch: string;
      toBranch: string;
      /** The cut had already been applied (the active branch is its
       *  destination): nothing changed this time. */
      alreadyApplied?: true;
      /** The awareness marks receipt: scheduled once, by the first
       *  application to get that far, and reported again by any retry. */
      markers?: SurgeryMarkerReceipt;
    }
  | {
      kind: 'unstick';
      step: number;
      /** What this step removed (its planned exchange). */
      shedIds: string[];
      /** The step was already journaled as shed: nothing changed this time. */
      alreadyApplied?: true;
    };

/** The self-change kind a tool call is, when it mutates the agent's own body:
 *  agent_settings update/reset/cancel, or a tool-presentation edit. */
export function selfChangeKind(tool: string, input: unknown): 'agent-settings' | 'tool-presentation' | null {
  if (tool === 'agent_settings') {
    const action = (input as { action?: unknown } | null | undefined)?.action;
    return action === 'update' || action === 'reset' || action === 'cancel' ? 'agent-settings' : null;
  }
  if (tool === 'set_tool_visibility' || tool === 'set_tool_description') return 'tool-presentation';
  return null;
}

/** Order-independent structural equality for tool inputs and settings values. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
