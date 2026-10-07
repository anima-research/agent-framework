/**
 * Speech routes: where a resident's unaddressed plain speech goes (shelf-355).
 *
 * A route is decided deliberately or inferred from what triggered the turn,
 * never from whichever channel last saw traffic:
 * - deliberate: a conversation fork's home channel, or a channel the resident
 *   opened with `channel_open` (setSpeechTarget, the default); a hybrid
 *   `>>>target` prefix is deliberate too and lives in its own pin;
 * - inferred, at a true new turn, from the wake's candidates: the addressed
 *   ones if any, else the conversational ones. Only candidates that name ONE
 *   conversation infer a route; several conversations start the turn held.
 *
 * A held turn (competing conversations at turn start, or a competing
 * addressed or engaged arrival mid-turn) keeps unaddressed speech as drafts
 * rather than guessing. Ambient traffic never suspends a route and never
 * selects one over an addressed candidate. Explicit sends name their own
 * destination and don't retarget narration.
 *
 * Pure: the framework supplies the candidates and the fork home, and owns
 * the per-turn state.
 */

/** A conversation a reply could belong to. */
export type ConversationRef =
  | {
      kind: 'channel';
      /** The MCPL server, when known. Absent — never a placeholder — when the
       *  channel id couldn't be tied to one server; delivery then resolves
       *  the id alone, the same way on every path. */
      serverId?: string;
      channelId: string;
      threadId?: string;
      /** The channel's registered label when it was seen. */
      label?: string;
    }
  | {
      kind: 'surface';
      /** The local surface (console, TUI, API) — never a channel. */
      surface: string;
    };

/** One conversation the turn's wake carried, as a route candidate. */
export interface RouteCandidate {
  conversation: ConversationRef;
  /** Spoken TO the resident (mention, reply, DM, or a local surface's message). */
  addressed: boolean;
  /** The triggering message within the conversation: the reply edge. */
  messageId?: string;
  /** When its event happened (ms). */
  at: number;
  /** Its registered channel could not be resolved: it competes for the
   *  turn like any conversation, but is never itself the route. */
  unroutable?: true;
}

export type RouteOrigin =
  /** Inferred from the turn's wake. */
  | 'trigger'
  /** A conversation fork's home channel. */
  | 'home'
  /** The resident's own channel_open (setSpeechTarget). */
  | 'open';

export type SpeechRoute =
  | {
      kind: 'channel';
      /** As in ConversationRef: absent when unknown. */
      serverId?: string;
      channelId: string;
      /** Never set on a route: plain speech can't be posted into a thread
       *  (publishing carries no thread), so a thread conversation is never
       *  inferred as a route. Kept for the type's symmetry with
       *  ConversationRef. */
      threadId?: string;
      /** The message being answered, kept across same-conversation arrivals. */
      replyTo?: string;
      label?: string;
      origin: RouteOrigin;
    }
  | {
      kind: 'surface';
      surface: string;
      origin: 'trigger';
    };

/** The turn's routing state. */
export interface TurnRoute {
  /** Where unaddressed speech goes; null when it has no destination. */
  route: SpeechRoute | null;
  /** Unaddressed speech is held as drafts: these conversations compete. */
  hold?: {
    conversations: ConversationRef[];
    since: 'turn-start' | 'mid-turn';
  };
  /** No route because the one conversation the turn answers can't take
   *  plain speech: a thread (publishing carries no thread), or a channel the
   *  host couldn't resolve. Said in the routing notice and the drafts' note. */
  unroutable?: { conversation: ConversationRef; reason: 'thread' | 'unresolved' };
}

/** Identity of a conversation: server, channel and thread, or the surface. */
export function conversationKey(c: ConversationRef): string {
  return c.kind === 'surface'
    ? `surface:${c.surface}`
    : `channel:${c.serverId ?? ''}\u0000${c.channelId}\u0000${c.threadId ?? ''}`;
}

/** The conversation a route speaks into. */
export function routeConversation(route: SpeechRoute): ConversationRef {
  return route.kind === 'surface'
    ? { kind: 'surface', surface: route.surface }
    : {
        kind: 'channel',
        ...(route.serverId ? { serverId: route.serverId } : {}),
        channelId: route.channelId,
        ...(route.threadId ? { threadId: route.threadId } : {}),
        ...(route.label ? { label: route.label } : {}),
      };
}

/** A usable address for a conversation, as a resident would write it. */
export function describeConversation(c: ConversationRef): string {
  if (c.kind === 'surface') return `${c.surface} (the local surface that messaged you)`;
  const where = `${c.channelId}${c.threadId ? `, thread ${c.threadId}` : ''}`;
  if (!c.label || c.label === c.channelId) return c.threadId ? `${c.channelId} (thread ${c.threadId})` : c.channelId;
  const label = c.label.startsWith('#') || c.label.startsWith('DM') ? c.label : `#${c.label}`;
  return `${label} (${where})`;
}

/**
 * The turn's route from its wake candidates (a true new turn only).
 * A fork's home always wins. Otherwise the addressed candidates are
 * considered if there are any, else every (conversational) candidate; they
 * infer a route only when they name one conversation, from the newest
 * candidate in it (its message is the reply edge). Several conversations
 * start the turn held, naming each; none leaves the turn without a route,
 * and so does one that can't take plain speech (a thread, or a channel that
 * couldn't be resolved), which the turn records as `unroutable`.
 */
export function inferTurnRoute(candidates: readonly RouteCandidate[], home?: SpeechRoute | null): TurnRoute {
  if (home) return { route: home };
  const addressed = candidates.filter((c) => c.addressed);
  const pool = addressed.length > 0 ? addressed : candidates;
  if (pool.length === 0) return { route: null };
  const newestByConversation = new Map<string, RouteCandidate>();
  for (const candidate of pool) {
    const key = conversationKey(candidate.conversation);
    const seen = newestByConversation.get(key);
    if (!seen || candidate.at >= seen.at) newestByConversation.set(key, candidate);
  }
  if (newestByConversation.size > 1) {
    const conversations = [...newestByConversation.values()]
      .sort((a, b) => b.at - a.at)
      .map((c) => c.conversation);
    return { route: null, hold: { conversations, since: 'turn-start' } };
  }
  const [chosen] = newestByConversation.values();
  const c = chosen!.conversation;
  // A conversation whose channel isn't resolvable can't be spoken into, and
  // neither can a thread: publishing carries no thread, so plain speech
  // would land in the channel root — a different conversation than the one
  // being answered. Both still compete for the turn (above).
  if (chosen!.unroutable) return { route: null, unroutable: { conversation: c, reason: 'unresolved' } };
  if (c.kind === 'channel' && c.threadId) return { route: null, unroutable: { conversation: c, reason: 'thread' } };
  return c.kind === 'surface'
    ? { route: { kind: 'surface', surface: c.surface, origin: 'trigger' } }
    : {
        route: {
          kind: 'channel',
          ...(c.serverId ? { serverId: c.serverId } : {}),
          channelId: c.channelId,
          ...(chosen!.messageId ? { replyTo: chosen!.messageId } : {}),
          ...(c.label ? { label: c.label } : {}),
          origin: 'trigger',
        },
      };
}

/**
 * Whether an item is conversational input — something the resident might be
 * answering — rather than machinery: a system marker (send-failure notices,
 * routing notices) or a reaction or its removal (`chat:reaction`,
 * `chat:reaction-remove`, MCPL RFC-001) is not. One
 * predicate for every place that asks: turn-start route candidates, mid-turn
 * holds, and clearing send suppression.
 */
export function isConversational(tags: readonly string[] | undefined, metadata?: Record<string, unknown>): boolean {
  if (metadata?.system === true) return false;
  // Both reaction tags (MCPL RFC-001 / SPEC §16.2 keep them distinct).
  if (tags?.includes('chat:reaction') || tags?.includes('chat:reaction-remove')) return false;
  return true;
}

/**
 * Whether a mid-turn arrival suspends the turn's route: only an inferred
 * route (origin 'trigger') not already held, and only for a conversational
 * message from a DIFFERENT conversation that addressed the resident, or that
 * continues a conversation the resident explicitly sent into this turn.
 * Ambient chatter never does; deliberate routes never are.
 */
export function suspendsRoute(
  turn: TurnRoute,
  arrival: { conversation: ConversationRef; addressed: boolean },
  engaged: (c: ConversationRef) => boolean,
): boolean {
  if (turn.hold || !turn.route || turn.route.origin !== 'trigger') return false;
  if (conversationKey(arrival.conversation) === conversationKey(routeConversation(turn.route))) return false;
  return arrival.addressed || engaged(arrival.conversation);
}
