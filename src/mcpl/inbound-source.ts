/**
 * Where an inbound item came from, decided once at Agent Framework's
 * ingestion boundary and stored on the message as `metadata.inboundSource`.
 *
 * Every later consumer reads this one value instead of re-deriving identity
 * from the lane it happened to arrive on: speech routing compares
 * conversations with it, the visible provenance header renders from it, and
 * delivery bookkeeping keys on it. It is frozen when the host ACCEPTS the
 * item. A coalesced occurrence (RFC-006) carries the value stamped at its
 * acceptance through deferral, fan-out and replay, so a later rename,
 * reconnect or re-render never rewrites where an old item says it came from.
 *
 * The field is framework-owned. It is written after any adapter-supplied
 * metadata is spread, so an adapter cannot supply or spoof it (adapter
 * `origin` objects already use a free-form `source` string, which is why this
 * is not called `source`).
 *
 * Facts only, no policy: whether an item is a body, an edit or a deletion
 * stays in its tags (`chat:edited`, `chat:deleted`); `deferred` and
 * `materialized` record what RFC-006 did with it. Nothing here is a version
 * key: `eventId` is present only when the producer supplied one.
 */

/** An item that belongs to a registered channel. */
export interface InboundChannelSource {
  kind: 'channel';
  /** MCPL server (connection) id the item arrived through, as the host names it. */
  serverId: string;
  /** RFC-006 endpoint binding of that connection at acceptance. A recipe that
   *  later points the same server id at a different endpoint gets a
   *  different binding, so old items never acquire the new endpoint's identity. */
  binding: string;
  /** The registered canonical channel id (on the push lane: the composite id
   *  the host derived from `origin`, never the adapter's raw platform id). */
  channelId: string;
  /** Thread within the channel, when the adapter supplied one. */
  threadId?: string;
  /** The platform message this item is (or, for an edit/delete, refers to). */
  messageId?: string;
  /** The producer's occurrence id, when it supplied one. */
  eventId?: string;
  /** The channel's human label when the host accepted the item. */
  label?: string;
  /** Message this one replies to, when the adapter supplied a reply edge. */
  replyTo?: string;
  /** Host acceptance time (epoch ms). */
  acceptedAt: number;
  /** The adapter's own timestamp for the item, verbatim. */
  sourceTimestamp?: string;
  /** RFC-006: accepted as a deferred notification (body rendered later). */
  deferred?: true;
  /** RFC-006: this delivery carries the materialized (rendered) body. */
  materialized?: true;
}

/** An MCPL push that names no channel (heartbeats, timers, feature-set events). */
export interface InboundUnscopedSource {
  kind: 'unscoped';
  serverId: string;
  binding: string;
  eventId?: string;
  acceptedAt: number;
  sourceTimestamp?: string;
  deferred?: true;
  materialized?: true;
}

/** Conversational input from a non-channel surface (console, TUI, API). */
export interface InboundSurfaceSource {
  kind: 'surface';
  /** The surface's name as its module reported it (e.g. `tui`, `api`). */
  surface: string;
  acceptedAt: number;
}

export type InboundSource = InboundChannelSource | InboundUnscopedSource | InboundSurfaceSource;

/**
 * Told once per inbound acceptance, with that acceptance's envelope: when an
 * ordinary item reaches the framework, and when the RFC-006 coalescer admits
 * an occurrence (deferred work included). Deliveries that reuse a frozen
 * envelope (replay, fan-out, materialization, corrections) are not
 * acceptances and are not reported. Observation only: the framework contains
 * and reports a throw, which never affects delivery.
 */
export interface InboundAcceptanceObserver {
  inboundAccepted(source: InboundSource): void;
}

/** Metadata key the framework stamps. */
export const INBOUND_SOURCE_KEY = 'inboundSource';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Read a stored item's source back from its metadata. Returns undefined for
 * anything that is not a well-formed framework stamp (older messages, and any
 * shape this version does not recognize) — never a guess.
 */
export function readInboundSource(metadata: unknown): InboundSource | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>)[INBOUND_SOURCE_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.acceptedAt !== 'number') return undefined;
  if (s.kind === 'channel') {
    if (!str(s.serverId) || !str(s.binding) || !str(s.channelId)) return undefined;
    return s as unknown as InboundChannelSource;
  }
  if (s.kind === 'unscoped') {
    if (!str(s.serverId) || !str(s.binding)) return undefined;
    return s as unknown as InboundUnscopedSource;
  }
  if (s.kind === 'surface') {
    if (!str(s.surface)) return undefined;
    return s as unknown as InboundSurfaceSource;
  }
  return undefined;
}

/**
 * The conversation an item belongs to, as a comparable key: server + channel
 * + thread for a channel item, the surface for console input. Undefined for an
 * unscoped push, which belongs to no conversation.
 */
export function conversationKey(source: InboundSource): string | undefined {
  if (source.kind === 'channel') {
    return `channel\u0000${source.serverId}\u0000${source.channelId}\u0000${source.threadId ?? ''}`;
  }
  if (source.kind === 'surface') return `surface\u0000${source.surface}`;
  return undefined;
}
