/**
 * The audience stamp (#291): who a stored row is for, written on the row
 * when it is stored, in its metadata.
 *
 * A row's target used to live only in the write that stored it: the
 * `forAgent` option, or which agent's context manager a writer called. In
 * the residents' shared slot, rows meant for different agents then look
 * alike in the store, and nothing read later can tell whose a row is. #291's
 * presentation index decides from the row which agents it is presented to,
 * and at boot which rows an agent has to be presented that it wasn't, so the
 * framework now writes that on every row it stores:
 *
 * - `metadata.audience` lists the agents the row is meant for, computed when
 *   it is written: the agent a write names (`forAgent`); for an admitted
 *   inbound message, the recipients admission delivered it to; for a
 *   module's process response whose inference request names agents, those
 *   of them registered. A write that names no agent (a module's write, a
 *   process response that asks every agent or none to read) is for the
 *   agents that take untargeted inbound and own the slot it lands in: on a
 *   residents' host every resident, as each reads the shared slot; with one
 *   resident that resident alone, as before. It falls back to the agent the
 *   write is delivered to when there are none.
 *   This is the rule #291's presentation index presents an untargeted row
 *   in the shared slot by, applied when the row is written, so the record
 *   tells an untargeted row from one written for the primary. A message a
 *   tune-out holds is meant for none of them, so its list is empty.
 *   Observers of a slot (the subconscious watching the residents' slot) are
 *   a relationship in the registry, not part of the list. A target is
 *   stamped as named even where it doesn't read the slot the row lands in
 *   (an inbound message or a response naming a worker or a conversation
 *   fork, stored in the residents' slot): how such a row is presented is
 *   left to the presentation index.
 * - `metadata.ownRowOf` names the agent whose own row it is: one stored by
 *   that agent's turn or act (its rounds, its tool results, a puppeted
 *   call), or by the framework for that agent's own turn (a clock row, a
 *   `[continue]` row, a batched wake's line, a notice about its own speech
 *   or failure, a derived agent's inheritance and framing). Its audience is
 *   that agent alone. "Own" goes by who stored the row, never by its
 *   participant: a shared fork presents its parent's name as its own voice,
 *   but mail its parent sends it is the parent's, meant for the fork, and
 *   isn't the fork's own row.
 *
 * Both keys are the framework's. A write through the framework's
 * `addMessage` is stamped there and a stamp its metadata carried (a copy of
 * a stored row's, say) is replaced, as `deferredWriteId` is. The stamp is
 * metadata only: compiles and requests don't read it, so they are what they
 * were. Rows stored before the stamp existed carry none; `audienceOf` says
 * so by returning undefined. A write an earlier version left in its
 * deferred queue is stamped when the importer stores it at boot, as any
 * write through `addMessage` is, so it isn't stored unstamped after the
 * upgrade.
 */
import type { ContentBlock } from '@animalabs/membrane';
import type { AddMessageOptions, ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
import { isAnotherAgentsInjection } from '../stored-injections.js';
import type { AgentName, ObserveEdge } from './types.js';

/** The metadata key listing who a row is for. */
export const AUDIENCE_KEY = 'audience';
/** The metadata key naming whose own row a row is. */
export const OWN_ROW_KEY = 'ownRowOf';

/** A row's audience stamp, as `audienceOf` reads it. */
export interface AudienceStamp {
  /** The agents the row is meant for, as computed when it was written. */
  audience: AgentName[];
  /** Set when the row is that agent's own (see the module comment). */
  ownRowOf?: AgentName;
}

/**
 * `metadata` stamped as a row meant for `audience`, and as nobody's own
 * row: a stamp it carried is replaced. A new object; `metadata` is unchanged.
 */
export function withAudience(metadata: MessageMetadata | undefined, audience: readonly AgentName[]): MessageMetadata {
  const { [OWN_ROW_KEY]: _replaced, ...rest } = (metadata ?? {}) as MessageMetadata;
  return { ...rest, [AUDIENCE_KEY]: [...audience] } as MessageMetadata;
}

/**
 * `metadata` stamped as `owner`'s own row, meant for `owner` alone: a stamp
 * it carried is replaced. A new object; `metadata` is unchanged.
 */
export function asOwnRow(metadata: MessageMetadata | undefined, owner: AgentName): MessageMetadata {
  return { ...(metadata ?? {}), [AUDIENCE_KEY]: [owner], [OWN_ROW_KEY]: owner } as MessageMetadata;
}

/**
 * The audience stamp a row's metadata carries, or undefined when it carries
 * none (a row stored before the stamp existed) or carries one that isn't a
 * list of names.
 */
export function audienceOf(metadata: unknown): AudienceStamp | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const audience = (metadata as Record<string, unknown>)[AUDIENCE_KEY];
  if (!Array.isArray(audience) || !audience.every((name) => typeof name === 'string')) return undefined;
  const own = (metadata as Record<string, unknown>)[OWN_ROW_KEY];
  return { audience: [...audience], ...(typeof own === 'string' ? { ownRowOf: own } : {}) };
}

/** Whether a row's metadata stamps it as `agent`'s own row. */
export function isOwnRowOf(metadata: unknown, agent: AgentName): boolean {
  return audienceOf(metadata)?.ownRowOf === agent;
}

/**
 * The admission record on a stored message: it was held from the residents
 * by a policy epoch (`metadata.tuneOut = { epochId }`). ONE predicate for
 * "held from the resident", read by the compiled-view filter, the mid-turn
 * injection and the presentation index (#291) alike (#232 H1), so the window
 * and the wire agree. Such a row is stamped for nobody (an empty audience),
 * whatever store it lands in.
 */
export const heldFromResidents = (metadata: Record<string, unknown> | undefined): boolean =>
  !!(metadata as { tuneOut?: unknown } | undefined)?.tuneOut;

/**
 * Whether a row of a slot an agent observes is for that agent (#291,
 * decision 1): what an observe edge shows of the slot it reads. `observer`
 * is the agent the edge is on, and `owners` are the agents whose own slot it
 * reads (the registry's `slotOwners`).
 *
 * - Another agent's stored context injection: no. It is that agent's
 *   context, not conversation, as every view of the framework's leaves out.
 * - A row stored under the observer's own name: no. It is the observer's
 *   delivery into the slot (the subconscious's summary or note into the
 *   residents' slot), which its own round already holds.
 * - A row a tune-out holds: only through an edge that shows held traffic
 *   (`includeHeld`, the subconscious's).
 * - A row with no audience stamp (stored before the stamp, or by a host's
 *   writer that doesn't stamp): yes, as the merged view showed it.
 * - An owner's own row (its rounds, results, clock rows, notices about its
 *   own turn), and a row whose audience names an owner (channel traffic,
 *   mail, module rows): yes.
 * - A row whose audience names the observer itself, and that is nobody's
 *   own row (an operator's message or a module's write addressed to the
 *   subconscious alone, which lands in the residents' slot it watches):
 *   yes. The edge is how the observer reads that slot, and the merged view
 *   showed the row before the presentation index, so no window would hold
 *   it otherwise (#291).
 * - Anything else, such as the own row of an agent that doesn't own the
 *   slot (the observer's own included), a row stamped only for an agent
 *   that neither owns nor observes the slot, or one for a derived agent on
 *   another branch: no.
 */
export function observedRowFor(
  edge: Pick<ObserveEdge, 'includeHeld'>,
  row: { participant: string; metadata?: unknown },
  context: { observer: AgentName; owners: readonly AgentName[] },
): boolean {
  if (isAnotherAgentsInjection(row.metadata, context.observer)) return false;
  if (row.participant === context.observer) return false;
  if (heldFromResidents(row.metadata as Record<string, unknown> | undefined)) return edge.includeHeld === true;
  const stamp = audienceOf(row.metadata);
  if (!stamp) return true;
  if (stamp.ownRowOf !== undefined) return context.owners.includes(stamp.ownRowOf);
  return stamp.audience.some((name) => name === context.observer || context.owners.includes(name));
}

/** What `storeOwnRow` writes through: an agent, or anything that names one and holds its context. */
export interface OwnRowWriter {
  readonly name: AgentName;
  getContextManager(): Pick<ContextManager, 'addMessage'>;
  /**
   * Told the ids of the agent's own rows once they are stored (the
   * presentation index's own-row sink, #291), each once its write has
   * returned. A writer without it is told nothing.
   */
  ownRowsStored?(ids: readonly MessageId[]): void;
}

/**
 * Store a row in `agent`'s own context, stamped as its own row (asOwnRow).
 * Every writer that stores into an agent's context directly, past the
 * framework's `addMessage`, stores the agent's own rows through this, so
 * none of them goes unstamped.
 *
 * With `present` (the default), the writer is told of the row once the add
 * has returned (`ownRowsStored`), never from inside it, where a sharded body
 * may still be storing its shards: under the presentation index (#291) that
 * presents the row in the agent's window at once. That is right for a row
 * the agent's stream carries (its round, its results, a notice injected at
 * its boundary), one written before its next compile or after its stream's
 * last request, and one written while the agent has no turn alive. A row
 * written at another moment, where a turn the row isn't part of may be
 * alive, passes `present: false`: it stays stored and out of the window,
 * and the index's own-row sweep at the agent's next presentation point
 * presents it there.
 */
export function storeOwnRow(
  agent: OwnRowWriter,
  participant: string,
  content: ContentBlock[],
  metadata?: MessageMetadata,
  options?: AddMessageOptions,
  present = true,
): MessageId {
  const id = agent.getContextManager().addMessage(participant, content, asOwnRow(metadata, agent.name), undefined, options);
  if (present) agent.ownRowsStored?.([id]);
  return id;
}
