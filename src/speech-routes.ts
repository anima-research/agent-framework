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
 * A route is only ever a place the framework can publish to exactly (MCPL
 * RFC-011): a channel whose connector declares `capabilities.publish.target`,
 * and a thread only on one that declares `exact`. Anything else is
 * unroutable, and speech for it is held rather than handed to a connector
 * that would choose the place itself.
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
      /** The thread the route speaks into — only on a channel whose
       *  connector posts into a named thread (RFC-011 `exact`). Absent: the
       *  channel root. */
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
   *  plain speech, said in the routing notice and the drafts' note:
   *  - `untargetable`: its channel's connector doesn't declare where a post
   *    lands (RFC-011), so the framework doesn't publish there;
   *  - `thread`: a thread on a channel whose connector can't post into a
   *    named thread (it declares `root`: a contradiction the connector
   *    shouldn't produce);
   *  - `unresolved`: a channel the host couldn't resolve. */
  unroutable?: { conversation: ConversationRef; reason: UnroutableReason };
}

export type UnroutableReason = 'untargetable' | 'thread' | 'unresolved';

/** A channel's declared publish target (RFC-011), as the framework reads it. */
export type PublishTargetOf = (channel: { serverId?: string; channelId: string }) => 'exact' | 'root' | undefined;

/** Why a channel conversation can't be a route, or undefined when it can. */
export function routeRefusal(c: ConversationRef, targetOf: PublishTargetOf): UnroutableReason | undefined {
  if (c.kind !== 'channel') return undefined;
  const declared = targetOf(c);
  if (!declared) return 'untargetable';
  if (c.threadId && declared !== 'exact') return 'thread';
  return undefined;
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
 * and so does one that can't take plain speech — a channel the framework
 * can't publish into exactly (`targetOf`, RFC-011), or one that couldn't be
 * resolved — which the turn records as `unroutable`.
 */
export function inferTurnRoute(
  candidates: readonly RouteCandidate[],
  home: SpeechRoute | null | undefined,
  targetOf: PublishTargetOf,
): TurnRoute {
  if (home) {
    const refusal = routeRefusal(routeConversation(home), targetOf);
    return refusal ? { route: null, unroutable: { conversation: routeConversation(home), reason: refusal } } : { route: home };
  }
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
  // neither can one the framework can't publish into exactly: its connector
  // would choose the place, which may be another conversation (RFC-011).
  // Both still compete for the turn (above).
  if (chosen!.unroutable) return { route: null, unroutable: { conversation: c, reason: 'unresolved' } };
  const refusal = routeRefusal(c, targetOf);
  if (refusal) return { route: null, unroutable: { conversation: c, reason: refusal } };
  return c.kind === 'surface'
    ? { route: { kind: 'surface', surface: c.surface, origin: 'trigger' } }
    : {
        route: {
          kind: 'channel',
          ...(c.serverId ? { serverId: c.serverId } : {}),
          channelId: c.channelId,
          ...(c.threadId ? { threadId: c.threadId } : {}),
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
