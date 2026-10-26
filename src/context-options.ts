/**
 * How the framework opens a resident's context and the persistent
 * subconscious's (#291, AF-5): which slot each reads, and what its view
 * leaves out. The framework opens its live agents with these, and opens an
 * ended one's context again with the same view (reopenAgentContext). A host
 * that opens one of these contexts itself, to audit a store say, opens it
 * with them too, so what it reads is what the agent's compiles read:
 * `ContextManager.open({ store, ...subconsciousContextOptions({ serves }) })`.
 *
 * - A resident reads the residents' shared slot (no `isolate`), its context
 *   state under `agents/<name>`. Its view leaves out what a tune-out holds
 *   (heldFromResidents) and the other residents' stored context injections
 *   (isAnotherAgentsInjection): their context, which they share the slot
 *   with it but never its conversation.
 * - The subconscious keeps its rows in a slot of its own,
 *   `subconscious/<serves>`, and reads the residents' slot beside it
 *   (`auxiliaryMessageViews: [{}]`), held traffic included, which is what it
 *   reads for. With the presentation index the residents' rows enter its
 *   window by its observe edge's rule, and the merged slot is still the
 *   record its window is presented from. Its view leaves out only the
 *   residents' stored context injections. Its strategy is a windowed
 *   passthrough, anchored at the oldest active tune-out's start.
 *
 * Each call returns a new object and, for the subconscious, a new strategy:
 * a strategy keeps state for the manager it is opened with.
 */
import { WindowedPassthroughStrategy, type ContextManagerConfig, type StoredMessage } from '@animalabs/context-manager';
import { heldFromResidents } from './dendrite/audience.js';
import { isAnotherAgentsInjection } from './stored-injections.js';

/** ContextManager.open's options over a store the caller gives: everything but the store. */
export type ContextManagerOpenOptions = Omit<Extract<ContextManagerConfig, { store: unknown }>, 'store'>;

/** What a resident's view leaves out: held traffic, and another agent's stored context injections. */
export function residentViewFilter(name: string): (message: StoredMessage) => boolean {
  return (message) => !heldFromResidents(message.metadata as Record<string, unknown> | undefined)
    && !isAnotherAgentsInjection(message.metadata, name);
}

/** What the subconscious's view leaves out: the residents' stored context injections, and nothing it reads for. */
export function subconsciousViewFilter(name: string): (message: StoredMessage) => boolean {
  return (message) => !isAnotherAgentsInjection(message.metadata, name);
}

/** The options a resident named `agentName` is opened with: the residents' slot, through its view. The caller gives its strategy. */
export function residentContextOptions(agentName: string): ContextManagerOpenOptions {
  return {
    namespace: `agents/${agentName}`,
    viewFilter: residentViewFilter(agentName),
  };
}

/**
 * The options the persistent subconscious serving `serves` is opened with:
 * its own slot, the residents' merged beside it, its view, and a new
 * windowed passthrough strategy with `reAnchorFraction` and
 * `maxMessageTokens` (the framework mirrors the primary's). `name` is the
 * subconscious's own name, `Subconscious` by default, as its configuration's.
 */
export function subconsciousContextOptions(options: {
  serves: string;
  name?: string;
  reAnchorFraction?: number;
  maxMessageTokens?: number;
}): ContextManagerOpenOptions {
  const name = options.name ?? 'Subconscious';
  return {
    namespace: `subconscious/${options.serves}`,
    isolate: true,
    auxiliaryMessageViews: [{}],
    viewFilter: subconsciousViewFilter(name),
    strategy: new WindowedPassthroughStrategy({
      reAnchorFraction: options.reAnchorFraction,
      maxMessageTokens: options.maxMessageTokens,
    }),
  };
}
