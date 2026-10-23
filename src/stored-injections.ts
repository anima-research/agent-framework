/**
 * Context injections kept where they were placed (context-manager #155,
 * part 5).
 *
 * `compile()` places an `afterUser` injection after the last user message
 * each time it runs, and nothing stores it. So at the next start, a new turn
 * or a restart after a tool result, it's gone from where the agent's replies
 * saw it, and on a model that binds a reply's thinking to everything before
 * it, every reply after the old place loses its thinking. A moved injection
 * also rewrites the previous turn's cached prefix. So at each start that
 * sends, the framework appends each `afterUser` injection to the agent's own
 * window, as the message `compile()` would have placed, unless the agent's
 * last request held it with the same content, and the compile then renders
 * it from the store like any message, where it stays. While the window is
 * held (AgentFramework's slotHeldFrom), `compile()` places it instead. Being a
 * message, it's history to the strategy: capped by its per-message bound,
 * sharded, selected by the budget and folded like any other.
 *
 * A stored injection's row carries `system: true`, `kind:
 * 'context-injection'` and `contextInjection` in its metadata (the mark),
 * naming the agent whose context it is and its source's namespace, so a
 * reader can tell it from conversation, and so another agent reading the
 * same slot leaves it out (AgentFramework's view filters). All three are
 * keys only the host writes.
 */

import type { ContextInjection } from '@animalabs/context-manager';
import { stableHash } from './stable-hash.js';
import { injectionsAsStored } from './text-as-stored.js';

/** The metadata key a stored injection's row is marked with. */
export const STORED_INJECTION_KEY = 'contextInjection';

/** The `kind` a stored injection's row carries beside `system: true`, as the
 *  framework's other rows of its own do (a clock row, a notice). */
export const STORED_INJECTION_KIND = 'context-injection';

/**
 * The mark: whose context the row is, its source's namespace, a hash of the
 * content its source gave at that start (the unit), in its stored form
 * (unitHash), and which of the unit's `parts` injections the row holds
 * (`part`, from 0). Every row of one injection, a sharded one's too, carries
 * the same `part`.
 */
export interface StoredInjectionMark {
  agent: string;
  namespace: string;
  contentHash: string;
  part: number;
  parts: number;
}

/** The participant `compile()` gives an injection it places, which a stored
 *  one keeps, so it renders as the placed one did. */
export function injectionParticipant(namespace: string): string {
  return `system_context:${namespace}`;
}

/**
 * A stored injection's mark, read from a row's metadata, so a host's reader
 * tells a stored injection from conversation by the rule the framework's own
 * views use. Undefined for a row with no mark, and for one whose mark isn't
 * whole (a string `agent`, `namespace` and `contentHash`, and integer
 * `part` and `parts` with 0 <= part < parts): no view of the framework's
 * treats such a row as a stored injection, so neither should a host's.
 */
export function storedInjectionMarkOf(metadata: unknown): StoredInjectionMark | undefined {
  const mark = (metadata as Record<string, unknown> | undefined)?.[STORED_INJECTION_KEY];
  if (mark === null || typeof mark !== 'object') return undefined;
  const { agent, namespace, contentHash, part, parts } = mark as Record<string, unknown>;
  return typeof agent === 'string' && typeof namespace === 'string' && typeof contentHash === 'string'
    && Number.isInteger(part) && Number.isInteger(parts) && (part as number) >= 0 && (part as number) < (parts as number)
    ? { agent, namespace, contentHash, part: part as number, parts: parts as number }
    : undefined;
}

/** Whether a row is another agent's stored injection, which `agentName`'s
 *  view leaves out: it's that agent's context, not conversation. */
export function isAnotherAgentsInjection(metadata: unknown, agentName: string): boolean {
  const mark = storedInjectionMarkOf(metadata);
  return mark !== undefined && mark.agent !== agentName;
}

/**
 * Whether an injection is stored, rather than placed by `compile()` each
 * time: an `afterUser` one, unless it opts out
 * (ModuleContextInjection.placedEachCompile). Only a module's can: an MCPL
 * server's is built from four fields alone (convertMcplInjection), so it
 * never carries the field.
 */
export function isStoredKind(injection: ContextInjection): boolean {
  return injection.position === 'afterUser'
    && (injection as { placedEachCompile?: unknown }).placedEachCompile !== true;
}

/**
 * Whether content leaves anything in a request: a block that isn't a text
 * block, or a text block with non-blank text, as the request's sanitizer
 * keeps (Agent's assembleActivationRequest drops blank text blocks, and a
 * message left with none). An injection with none isn't stored: its row
 * would vanish from every request, and the count of stored rows the
 * request ends on, which keeps [Continue] last, would then be wrong.
 * compile() places it, and the sanitizer drops it, as before.
 */
export function hasRenderedContent(content: ContextInjection['content']): boolean {
  return Array.isArray(content) && content.some((block) =>
    !((block as { type?: unknown }).type === 'text'
      && (typeof (block as { text?: unknown }).text !== 'string' || ((block as { text: string }).text).trim() === '')));
}

/** One injection as its row would store it: its namespace as text (as
 *  compile() writes it into the participant's name, so one that isn't a
 *  string, an MCPL server's number or none, is read so), that participant,
 *  and its content in the stored form (injectionsAsStored), as the compile
 *  would have taken it. The store's write would mend the content the same
 *  way; the namespace, which the mark carries too, it wouldn't. */
export function asStoredRow(injection: ContextInjection): { namespace: string; participant: string; content: ContextInjection['content'] } {
  const [stored] = injectionsAsStored([injection])!;
  const namespace = `${stored!.namespace}`;
  return { namespace, participant: injectionParticipant(namespace), content: stored!.content };
}

/** The hash of a unit's content in its stored form, which the same-content
 *  skip compares: the mark's, from the gather that stored the unit, with
 *  this gather's. */
export function unitHash(rows: ReadonlyArray<{ content: ContextInjection['content'] }>): string {
  return stableHash(rows.map((r) => r.content));
}
