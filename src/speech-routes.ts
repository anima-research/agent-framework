/**
 * Speech routes: where a resident's unaddressed plain speech goes (shelf-355).
 *
 * A route is decided deliberately or inferred from what triggered the turn,
 * and comes from where the last message came in only when the wake named no
 * conversation at all:
 * - deliberate: a conversation fork's home channel, or a channel the resident
 *   opened with `channel_open` (setSpeechTarget, the default); a hybrid
 *   `>>>target` prefix is deliberate too and lives in its own pin;
 * - inferred, at a true new turn, from the wake's candidates: the addressed
 *   ones if any, else the conversational ones. Only candidates that name ONE
 *   conversation infer a route; several conversations start the turn held;
 * - fallback, at a true new turn whose wake named no conversation at all (a
 *   heartbeat, a timer, a self-wake): where the last message any channel
 *   delivered came in, as before speech routes, checked like any route. The
 *   framework decides which wakes those are (InferenceRequest
 *   .namesConversation): a reaction or a channel a fork owns names one
 *   without being a candidate, and gets no fallback. A framework wake that
 *   continues a turn (a rewind retry, an unstick, a prose bounce) names the
 *   conversations that turn answered (continuationCandidates), so its words
 *   go where that turn's would have, by the rules every wake follows.
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
  | 'open'
  /** A wake that named no conversation: the conversation of the last
   *  message any channel delivered (its thread, but no reply edge), as
   *  before speech routes. */
  | 'fallback';

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
  /** Where unaddressed speech goes when the turn isn't held; null when it
   *  has no destination. A mid-turn hold keeps the route it suspended here,
   *  alongside `hold`, which wins while it is set. */
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

/** A channel's declared publish target (RFC-011), as the framework reads it;
 *  `unresolved` when the channel doesn't resolve to exactly one registered
 *  channel (none, or an id more than one server registers, named without
 *  its server). */
export type PublishTargetOf = (channel: { serverId?: string; channelId: string }) => 'exact' | 'root' | 'unresolved' | undefined;

/** Why a channel conversation can't be a route, or undefined when it can. */
export function routeRefusal(c: ConversationRef, targetOf: PublishTargetOf): UnroutableReason | undefined {
  if (c.kind !== 'channel') return undefined;
  const declared = targetOf(c);
  if (declared === 'unresolved') return 'unresolved';
  if (!declared) return 'untargetable';
  if (c.threadId && declared !== 'exact') return 'thread';
  return undefined;
}

/** Identity of a conversation: server, channel and thread, or the surface.
 *  The parts are server-chosen strings, so they are encoded as a JSON array,
 *  never joined with a separator one of them could contain: two keys are
 *  equal only for the same parts (an unknown server is not an empty one). */
export function conversationKey(c: ConversationRef): string {
  return c.kind === 'surface'
    ? JSON.stringify(['surface', c.surface])
    : JSON.stringify(['channel', c.serverId ?? null, c.channelId, c.threadId ?? null]);
}

/**
 * An agent-supplied thread id, read one way by every tool that takes one
 * (channel_publish, channel_open, drafts resend): absent or null is the
 * channel root; a string is trimmed of surrounding whitespace; a blank one,
 * or anything else, is refused, so a blank thread never becomes a place.
 */
export function readThreadId(value: unknown): { threadId: string | null } | { error: string } {
  if (value === undefined || value === null) return { threadId: null };
  if (typeof value !== 'string') return { error: 'threadId must be a thread id (a string), or null for the channel root.' };
  const threadId = value.trim();
  return threadId ? { threadId } : { error: 'threadId must be a thread id, not blank: leave it out, or null, for the channel root.' };
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

/**
 * A conversation as the framework names it to a resident, self-contained: its
 * label as its connector gave it (nothing added or withheld for how it is
 * spelled: a DM or a group may be named after a person or a title), then the
 * server and channel id, written `server / channel-id` as the source headers
 * write them, and its thread. The server is named whenever it is known,
 * never left to what else is on screen: the same channel id (and label) can
 * exist on another server, and a bare id is then no address a resident can
 * send to. Notices, holds and the [delivered] receipt all name conversations
 * this one way.
 */
export function describeConversation(c: ConversationRef): string {
  if (c.kind === 'surface') return `${c.surface} (the local surface that messaged you)`;
  const id = c.serverId ? `${c.serverId} / ${c.channelId}` : c.channelId;
  const where = c.threadId ? `${id}, thread ${c.threadId}` : id;
  if (c.label && c.label !== c.channelId) return `${c.label} (${where})`;
  return c.serverId || c.threadId ? `(${where})` : c.channelId;
}

/**
 * The turn's route from its wake candidates (a true new turn only).
 * A fork's home always wins; the message it answers is the newest of the
 * candidates in the home conversation itself (addressed ones first), as for
 * an inferred route, and none when no candidate is there. Otherwise the
 * addressed candidates are
 * considered if there are any, else every (conversational) candidate; they
 * infer a route only when they name one conversation, from the newest
 * candidate in it (its message is the reply edge). Several conversations
 * start the turn held, naming each. One that can't take plain speech — a
 * channel the framework can't publish into exactly (`targetOf`, RFC-011),
 * or one that couldn't be resolved — leaves the turn without a route, which
 * it records as `unroutable`.
 *
 * `fallback` is for a wake that named no conversation at all (a heartbeat,
 * a timer, a self-wake), and only the caller can tell that from a wake whose
 * named conversations all fell out as candidates (a reaction, a channel a
 * fork owns): it passes one only for the former. With no candidates, the
 * route is then where the last message any channel delivered came in, when
 * plain speech can go there exactly; otherwise there is none.
 */
export function inferTurnRoute(
  candidates: readonly RouteCandidate[],
  home: SpeechRoute | null | undefined,
  targetOf: PublishTargetOf,
  fallback?: RouteCandidate | null,
): TurnRoute {
  if (home) {
    const conversation = routeConversation(home);
    const refusal = routeRefusal(conversation, targetOf);
    if (refusal) return { route: null, unroutable: { conversation, reason: refusal } };
    const key = conversationKey(conversation);
    const replyTo = newestOf(considered(candidates.filter((c) => conversationKey(c.conversation) === key)))?.messageId;
    return { route: replyTo && home.kind === 'channel' ? { ...home, replyTo } : home };
  }
  const pool = considered(candidates);
  if (pool.length === 0) return { route: fallbackRoute(fallback, targetOf) };
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

/** The fallback conversation as a route, or null when there is none or plain
 *  speech can't go there exactly. Nothing in the wake named it, so it is no
 *  conversation in front of the resident: an unroutable fallback is simply
 *  no route, not an `unroutable` one. */
function fallbackRoute(fallback: RouteCandidate | null | undefined, targetOf: PublishTargetOf): SpeechRoute | null {
  if (!fallback || fallback.unroutable) return null;
  const c = fallback.conversation;
  if (c.kind !== 'channel' || routeRefusal(c, targetOf)) return null;
  // No reply edge: the turn answers no message, and the last delivered one
  // didn't trigger it (MCPL's `incoming` names only a triggering message).
  return {
    kind: 'channel',
    ...(c.serverId ? { serverId: c.serverId } : {}),
    channelId: c.channelId,
    ...(c.threadId ? { threadId: c.threadId } : {}),
    ...(c.label ? { label: c.label } : {}),
    origin: 'fallback',
  };
}

/**
 * The conversations a framework wake names when it continues a turn (a
 * rewind retry, an unstick, a prose continuation or bounce), as candidates:
 * the ones that turn answered, so the continuation's words go where the
 * turn's would have. A held turn names each conversation it held between; a
 * turn with a route names its route's conversation, reply edge kept; a turn
 * whose one conversation couldn't take plain speech names that one, to be
 * checked again. Each counts as addressed, since the resident was answering
 * it: an ambient arrival batched beside it doesn't take the turn, and an
 * addressed one from elsewhere holds it. A turn that answered none (a silent
 * wake, an explicit-prose turn, a no-name wake with no fallback place) gives
 * none, so its continuation names none.
 */
export function continuationCandidates(turn: TurnRoute | undefined, at: number): RouteCandidate[] {
  if (!turn) return [];
  if (turn.hold) return turn.hold.conversations.map((conversation) => ({ conversation, addressed: true, at }));
  if (turn.route) {
    const { route } = turn;
    return [{
      conversation: routeConversation(route),
      addressed: true,
      at,
      ...(route.kind === 'channel' && route.replyTo ? { messageId: route.replyTo } : {}),
    }];
  }
  if (turn.unroutable) {
    return [{
      conversation: turn.unroutable.conversation,
      addressed: true,
      at,
      ...(turn.unroutable.reason === 'unresolved' ? { unroutable: true as const } : {}),
    }];
  }
  return [];
}

/** The candidates a route is inferred from: the addressed ones if any, else all. */
function considered(candidates: readonly RouteCandidate[]): readonly RouteCandidate[] {
  const addressed = candidates.filter((c) => c.addressed);
  return addressed.length > 0 ? addressed : candidates;
}

/** The newest candidate (the latest of equals). */
function newestOf(candidates: readonly RouteCandidate[]): RouteCandidate | undefined {
  let newest: RouteCandidate | undefined;
  for (const candidate of candidates) if (!newest || candidate.at >= newest.at) newest = candidate;
  return newest;
}

/**
 * Whether an item is conversational input — something the resident might be
 * answering — rather than machinery: a host system marker (send-failure
 * notices, routing notices) or a reaction or its removal (`chat:reaction`,
 * `chat:reaction-remove`, MCPL RFC-001) is not. One predicate for every place
 * that asks: turn-start route candidates, mid-turn holds, and clearing send
 * suppression. `metadata.system` is host-written only: a caller passes an
 * MCPL item's tags alone, and ingestion drops a `system` an adapter's
 * metadata or origin carries, so no server can mark its item as machinery.
 */
export function isConversational(tags: readonly string[] | undefined, metadata?: Record<string, unknown>): boolean {
  if (metadata?.system === true) return false;
  // Both reaction tags (MCPL RFC-001 / SPEC §16.2 keep them distinct).
  if (tags?.includes('chat:reaction') || tags?.includes('chat:reaction-remove')) return false;
  return true;
}

/**
 * Whether a mid-turn arrival suspends the turn's route: only an inferred
 * route (origin 'trigger', or the 'fallback' a wake that named no
 * conversation took) not already held, and only for an arrival from a
 * DIFFERENT conversation that addressed the resident, or that continues a
 * conversation the resident explicitly sent into this turn. Ambient chatter
 * never does; deliberate routes never are. It sees no tags: the caller passes
 * only conversational arrivals (isConversational), so a reaction or a system
 * marker never reaches it.
 */
export function suspendsRoute(
  turn: TurnRoute,
  arrival: { conversation: ConversationRef; addressed: boolean },
  engaged: (c: ConversationRef) => boolean,
): boolean {
  if (turn.hold || !turn.route || (turn.route.origin !== 'trigger' && turn.route.origin !== 'fallback')) return false;
  if (conversationKey(arrival.conversation) === conversationKey(routeConversation(turn.route))) return false;
  return arrival.addressed || engaged(arrival.conversation);
}
