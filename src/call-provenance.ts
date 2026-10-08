/**
 * Who initiated the module tool call whose handler is running, carried
 * across that handler's asynchronous work.
 *
 * ModuleRegistry.handleToolCall runs every module handler inside
 * `callProvenance.run(...)`, and ModuleContext.callTool reads it. A module
 * that delegates to another tool therefore passes on the actor who started
 * the work: the agent's model (no origin), an operator's puppet, or the
 * host. That includes delegation from a callback the handler scheduled
 * after returning, because AsyncLocalStorage follows the work it started.
 * The agent's own origin passes on only to a call for that same agent: one
 * agent's turn never changes another agent's body as its own.
 * Work that no tool call started has no store: a module's own timer, or its
 * event handler, acts for the host.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolCall } from './types/index.js';

export type CallProvenance = Pick<ToolCall, 'origin' | 'admission'> & {
  /** The agent the initiating call acted for (its callerAgentName). */
  agent?: string;
};

export const callProvenance = new AsyncLocalStorage<CallProvenance>();

/**
 * A caller-supplied origin as the framework reads it: absent (undefined or
 * null) stays absent, 'puppet' stays the operator's, and any other value is
 * the host's. Types forbid other values, but an untyped module or host can
 * pass anything, and a falsy one must never read as the agent's own.
 */
export function normalizeOrigin(origin: unknown): ToolCall['origin'] {
  if (origin === undefined || origin === null) return undefined;
  return origin === 'puppet' ? 'puppet' : 'host';
}

/**
 * Who a module's delegated call (ModuleContext.callTool) acts for: the origin
 * the module named, normalized; otherwise the initiating call's origin, the
 * agent's own only for that same agent; and with no call behind it, the host.
 */
export function delegatedOrigin(
  call: Pick<ToolCall, 'origin' | 'callerAgentName'>,
  ambient: CallProvenance | undefined,
): ToolCall['origin'] {
  const named = normalizeOrigin(call.origin);
  if (named) return named;
  if (!ambient) return 'host';
  if (ambient.origin) return ambient.origin;
  return ambient.agent !== undefined && call.callerAgentName === ambient.agent ? undefined : 'host';
}
