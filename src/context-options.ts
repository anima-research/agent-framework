/**
 * How the framework opens a resident's context and the persistent
 * subconscious's (#291, AF-5): which slot each reads, and what its view
 * leaves out. The framework opens its live agents with these, and opens an
 * ended one's context again with the same view (reopenAgentContext). A host
 * that opens one of these contexts itself, to audit a store say, opens it
 * with them too, so what it reads is what the agent's compiles read (the
 * requests then send other agents' rounds as a transcript, `foreignRounds`,
 * which `transcribeForeignRounds` applies to what the context reads):
 * `ContextManager.open({ store, ...subconsciousContextOptions({ serves,
 * name, reAnchorFraction, maxMessageTokens }) })`, with `serves` the
 * primary's name, `name` and `reAnchorFraction` the host's
 * `subconscious.name` and `subconscious.reAnchorFraction`, and
 * `maxMessageTokens` the primary's `strategy.maxMessageTokens`, which the
 * framework mirrors.
 *
 * - A resident reads the residents' shared slot (no `isolate`), its context
 *   state under `agents/<name>`. Its view leaves out what a tune-out holds
 *   (heldFromResidents), what a suppress rule hid (suppressedRow), and the
 *   other residents' stored context injections (isAnotherAgentsInjection):
 *   their context, which they share the slot with it but never its
 *   conversation. Both views also omit legacy reasoning-loss notices.
 * - The subconscious keeps its rows in a slot of its own,
 *   `subconscious/<serves>`, and reads the residents' slot beside it
 *   (`auxiliaryMessageViews: [{}]`), held traffic included, which is what it
 *   reads for. With the presentation index the residents' rows enter its
 *   window by its observe edge's rule, and the merged slot is still the
 *   record its window is presented from. Its view leaves out only the
 *   residents' stored context injections and what a suppress rule hid,
 *   in this shared view, along with legacy notices. Its strategy is a windowed
 *   passthrough, anchored at the oldest active tune-out's start, or at an
 *   earlier start kept in force: a cancelled tune-out's, kept while another
 *   stays active and across a restart, until the next enter sets the oldest
 *   active one's (window-anchor.ts).
 *
 * Each call returns a new object and, for the subconscious, a new strategy:
 * a strategy keeps state for the manager it is opened with.
 */
import { WindowedPassthroughStrategy, type ContextManagerConfig, type StoredMessage } from '@animalabs/context-manager';
import { isReasoningLoss } from './reasoning-loss.js';
import { heldFromResidents, suppressedRow } from './dendrite/audience.js';
import { persistentReaderName } from './tune-out/tools.js';
import { isAnotherAgentsInjection } from './stored-injections.js';

/** ContextManager.open's options over a store the caller gives: everything but the store. */
export type ContextManagerOpenOptions = Omit<Extract<ContextManagerConfig, { store: unknown }>, 'store'>;

/** A resident's view: no held traffic, suppressed rows, foreign injections or legacy notices.
 * Supports both a reusable named predicate and a direct metadata-only probe. */
export function residentViewFilter(message: Pick<StoredMessage, 'metadata'>, name: string): boolean;
export function residentViewFilter(name: string): (message: Pick<StoredMessage, 'metadata'>) => boolean;
export function residentViewFilter(messageOrName: Pick<StoredMessage, 'metadata'> | string, name?: string): boolean | ((message: Pick<StoredMessage, 'metadata'>) => boolean) {
  if (typeof messageOrName !== 'string') return residentViewFilter(name!)(messageOrName);
  return (message) => !heldFromResidents(message.metadata as Record<string, unknown> | undefined)
    && !suppressedRow(message.metadata as Record<string, unknown> | undefined)
    && !isAnotherAgentsInjection(message.metadata, messageOrName)
    && !isReasoningLoss(message.metadata);
}

/** The subconscious includes held traffic, but not suppressed rows, foreign injections or legacy notices. */
export function subconsciousViewFilter(message: Pick<StoredMessage, 'metadata'>, name: string): boolean;
export function subconsciousViewFilter(name: string): (message: Pick<StoredMessage, 'metadata'>) => boolean;
export function subconsciousViewFilter(messageOrName: Pick<StoredMessage, 'metadata'> | string, name?: string): boolean | ((message: Pick<StoredMessage, 'metadata'>) => boolean) {
  if (typeof messageOrName !== 'string') return subconsciousViewFilter(name!)(messageOrName);
  return (message) => !suppressedRow(message.metadata as Record<string, unknown> | undefined)
    && !isAnotherAgentsInjection(message.metadata, messageOrName)
    && !isReasoningLoss(message.metadata);
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
 * name the subconscious runs under, its configuration's `name`, which the
 * host gives it: pass that. Left out, it is the name the framework runs a
 * reader the host didn't name under (persistentReaderName), so a host that
 * left its reader unnamed opens the view the live one reads; this export
 * doesn't choose a name of its own.
 */
export function subconsciousContextOptions(options: {
  serves: string;
  name?: string;
  reAnchorFraction?: number;
  maxMessageTokens?: number;
}): ContextManagerOpenOptions {
  const name = persistentReaderName(options);
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
