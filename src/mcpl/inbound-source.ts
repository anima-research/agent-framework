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

import { createHash } from 'node:crypto';

/** The MCPL admission lane that accepted an item. Its contract decides what
 *  an `eventId` is worth: `push/event` deduplicates by eventId, and RFC-006
 *  coalesced admission (`coalesced: true`) guarantees stable retries and
 *  distinct versions; a `channels/incoming` eventId outside coalescing is
 *  adapter-supplied with no such guarantee. */
export type InboundLane = 'channels/incoming' | 'push/event';

/** An item that belongs to a registered channel. */
export interface InboundChannelSource {
  kind: 'channel';
  /** The admission lane that accepted it (see InboundLane). */
  lane: InboundLane;
  /** Accepted through RFC-006 coalesced admission. */
  coalesced?: true;
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
  lane: 'push/event';
  coalesced?: true;
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

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const optionalText = (v: unknown): boolean => v === undefined || isText(v);
const optionalTrue = (v: unknown): boolean => v === undefined || v === true;

/**
 * Read a stored item's source back from its metadata, validating every field
 * a consumer relies on: identity strings are non-empty strings, `acceptedAt`
 * is a finite number, flags are exactly `true` when present, and the lane is
 * one this version knows. Anything else (older messages, a shape this
 * version does not recognize, a damaged import) is undefined — never a guess.
 */
export function readInboundSource(metadata: unknown): InboundSource | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>)[INBOUND_SOURCE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.acceptedAt !== 'number' || !Number.isFinite(s.acceptedAt)) return undefined;
  if (s.kind === 'surface') {
    return isText(s.surface) ? (s as unknown as InboundSurfaceSource) : undefined;
  }
  const effectFlags = optionalTrue(s.coalesced) && optionalTrue(s.deferred) && optionalTrue(s.materialized);
  if (!isText(s.serverId) || !isText(s.binding) || !effectFlags) return undefined;
  if (!optionalText(s.eventId) || !optionalText(s.sourceTimestamp)) return undefined;
  if (s.kind === 'channel') {
    if (s.lane !== 'channels/incoming' && s.lane !== 'push/event') return undefined;
    if (!isText(s.channelId)) return undefined;
    for (const field of ['threadId', 'messageId', 'label', 'replyTo'] as const) {
      if (!optionalText(s[field])) return undefined;
    }
    return s as unknown as InboundChannelSource;
  }
  if (s.kind === 'unscoped') {
    return s.lane === 'push/event' ? (s as unknown as InboundUnscopedSource) : undefined;
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

/**
 * JSON with object keys sorted at every level and `undefined` values dropped,
 * so a value hashes alike however its keys were ordered (content read back
 * from the store has its keys in a different order than it was written).
 *
 * sourceBodyDigest's serializer, kept out of the package API: serialization
 * and framing both stay inside sourceBodyDigest, so consumers don't
 * duplicate either (`canonicalJson(blocks)` alone hashes differently).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The version identity of a delivered body (agreed with the receipts lane,
 * room-220 #46752–#47210): SHA-256 hex of `canonicalJson([blocks])` over the
 * ContentBlock[] the framework stores for the body — after MCPL conversion,
 * before any host decoration is added and before storage shards it. The
 * one-element array keeps the framing an undecorated, unsharded stored copy
 * has always hashed to, so a stamped copy and an older copy of the same body
 * share a version.
 *
 * Ingestion stamps it as `metadata.sourceBodyDigest`, and the same function
 * over exactly the blocks handed to storage (decorations included) as
 * `metadata.storedBodyDigest`, on both MCPL lanes. Both live outside the
 * frozen admission envelope: they describe the body actually delivered (a
 * materialization, a correction), not the admission. Neither proves later
 * presence or completeness; a copy that no longer hashes to its
 * storedBodyDigest was changed after delivery (editMessage keeps metadata).
 *
 * Exported from the package root, so a consumer checks a copy against either
 * field with this same function rather than a copy of it.
 */
export function sourceBodyDigest(blocks: readonly unknown[]): string {
  return createHash('sha256').update(canonicalJson([blocks])).digest('hex');
}

/**
 * The compact visible source header (shelf-356) every channel-bearing item
 * carries in its stored content, so a message names its conversation when
 * read alone — including the second of two consecutive messages from one
 * channel. Grammar, agreed with discord-mcpl (room-203 #41210):
 *
 *   [source: <server-id> / <canonical-channel-id> · <label-at-receipt> · thread <id> · reply to <id>]
 *   [source: <server-id> · unscoped]
 *
 * The label is the one the host held when it accepted the item (left out
 * when unknown); the thread and reply tails appear only when the item has
 * them. The canonical id is authoritative when a label differs. A local
 * surface's input has no header: it is not channel traffic.
 */
export function renderSourceHeader(
  fields:
    | { kind: 'channel'; serverId: string; channelId: string; label?: string; threadId?: string; replyTo?: string }
    | { kind: 'unscoped'; serverId: string }
    | { kind: 'surface' },
): string | undefined {
  if (fields.kind === 'surface') return undefined;
  if (fields.kind === 'unscoped') return `[source: ${headerValue(fields.serverId)} · unscoped]`;
  const parts = [`${headerValue(fields.serverId)} / ${headerValue(fields.channelId)}`];
  if (fields.label) parts.push(labelValue(fields.label));
  if (fields.threadId) parts.push(`thread ${headerValue(fields.threadId)}`);
  if (fields.replyTo) parts.push(`reply to ${headerValue(fields.replyTo)}`);
  return `[source: ${parts.join(' · ')}]`;
}

/**
 * A header field, rendered so it can't become structure: every value in a
 * header (ids and labels alike) comes from an adapter, and a label holding
 * `]`, a newline and `[source: …` must not read as a second attribution. A
 * value with any character the grammar uses (brackets, the `·` and ` / `
 * separators, quotes, backslashes) or any control or line-separator
 * character is rendered as a quoted, escaped string literal; every other
 * value as is. A header is always one line.
 */
function headerValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  const structural = /[[\]\u00b7"\\\u0000-\u001f\u007f-\u009f\u2028\u2029]| \/ /;
  return structural.test(value) ? quoted(value) : value;
}

/**
 * The label, rendered so it can't read as another field. It stands right
 * after the channel id, where an unlabelled item's thread or reply tail
 * would, so a label beginning with one of the header's own words (`thread`,
 * `reply to`, `unscoped`) is quoted too: `· "thread topic-a"` is a label,
 * `· thread topic-a` a thread. Case and spacing are ignored, because the
 * readers are models rather than a parser, and quoting loses nothing.
 */
function labelValue(label: string): string {
  return /^\s*(?:thread|reply\s+to|unscoped)(?:\s|$)/i.test(label) ? quoted(label) : headerValue(label);
}

/** A value as a quoted, escaped string literal that always stays on one line. */
function quoted(value: string): string {
  // JSON.stringify escapes the C0 controls, quotes and backslashes, but
  // leaves DEL, the C1 controls (U+0085 NEL breaks a line) and U+2028 /
  // U+2029 (line and paragraph separators) literal: escape those visibly too.
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The authority rule every rendering of a source header shares. */
export const SOURCE_HEADER_RULE =
  'The channel id is authoritative when a label differs: labels can change, ids do not.';
