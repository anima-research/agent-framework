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
 * Work that no tool call started has no store: a module's own timer, or its
 * event handler, acts for the host.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolCall } from './types/index.js';

export type CallProvenance = Pick<ToolCall, 'origin' | 'admission'>;

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
