/**
 * Refusal-reaction markers — the single source of truth for the emoji the
 * framework places on a message when inference is refused (see
 * AgentFramework.reactToRefusal), exported so host composition can derive
 * a protective suppression baseline from the exact set the framework emits.
 *
 * These annotations are placed by the framework on the resident's account
 * and must never re-enter a resident's context as reaction events — that is
 * the self-amplifying loop behind the 8/3 Mythos incident. The Discord
 * adapter suppresses them when its operator config or the host-injected
 * `DISCORD_SUPPRESSED_REACTIONS_BASELINE` names them; keeping the emitted
 * set and the exported baseline as one constant is what makes drift between
 * "what we stamp" and "what we suppress" structurally impossible, rather
 * than a promise kept in two files.
 */

/** Refusal category → Discord reaction emoji. Unknown categories get the
 *  fallback marker. */
export const REFUSAL_REACTIONS: Readonly<Record<string, string>> = {
  bio: '☣️',
  chem: '🧪',
  nuclear: '☢️',
  cyber: '💻',
  reasoning_extraction: '🧠',
};

/** Marker used when the refusal category has no dedicated emoji. */
export const REFUSAL_REACTION_FALLBACK = '🛑';

/** Every marker the framework can emit — the category map plus the
 *  fallback, deduplicated, in stable declaration order. This IS the
 *  protective baseline: host composition serializes it (comma-joined) into
 *  `DISCORD_SUPPRESSED_REACTIONS_BASELINE` for adapters that render
 *  reactions. */
export const REFUSAL_REACTION_BASELINE: readonly string[] = [
  ...new Set([...Object.values(REFUSAL_REACTIONS), REFUSAL_REACTION_FALLBACK]),
];
