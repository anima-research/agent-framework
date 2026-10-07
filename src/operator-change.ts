/**
 * Operator-change admission: the framework resolves each of its own operator
 * mutations to an absolute change and asks the host's gate before acting
 * (FrameworkConfig.operatorChangeGate). The gate answers `apply` (act now,
 * on exactly this change) or `staged` (the host will apply it later, at a
 * safe boundary, through AgentFramework.applyResolvedOperatorChange).
 *
 * A change is resolved once. Application, immediate or delayed, revalidates
 * it against stable identity (the active branch, the settings it was
 * resolved from) and applies exactly what was resolved, never the relative
 * command again: a change that no longer holds is refused as `stale` and the
 * host restages it.
 */
import type { OperatorRequester } from './operator-log.js';

/** What the host's gate decided for one resolved change. */
export type OperatorChangeDecision =
  | { decision: 'apply' }
  | { decision: 'staged'; receipt: OperatorChangeReceipt };

/** The host's receipt for a staged change, shown to whoever asked. */
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
  /** Host-managed (extension) keys the input touches, with their values when
   *  resolved. Their owners apply them; application checks they haven't moved. */
  extensions?: Record<string, unknown>;
}

/** set_tool_visibility / set_tool_description, from an operator or a module. */
export interface ResolvedPresentationChange extends ResolvedOperatorChangeBase {
  kind: 'tool-presentation';
  tool: 'set_tool_visibility' | 'set_tool_description';
  input: Record<string, unknown>;
  /** The targeted tool's presentation entry when resolved. */
  from: { name: string; visible: boolean; description: string };
}

export type ResolvedOperatorChange =
  | ResolvedSettingsChange
  | ResolvedPresentationChange;

/** What applyResolvedOperatorChange did. */
export type AppliedOperatorChange =
  | { kind: 'agent-settings'; result: unknown }
  | { kind: 'tool-presentation'; result: unknown };

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
