/**
 * Where an inbound item came from, decided once at Agent Framework's
 * ingestion boundary and stored on the message as `metadata.inboundSource`.
 *
 * A consumer of where an item came from reads this one value
 * (readInboundSource) rather than re-deriving identity from the lane the
 * item happened to arrive on, and compares conversations with
 * conversationKey. It is frozen when the host ACCEPTS the item. A coalesced
 * occurrence (RFC-006) carries the value stamped at its acceptance through
 * deferral, fan-out and replay, so a later rename, reconnect or re-render
 * never rewrites where an old item says it came from.
 *
 * The field is framework-owned. It is written after any adapter-supplied
 * metadata is spread, so an adapter cannot supply or spoof it, and one a
 * module's messages carry is dropped (adapter `origin` objects already use a
 * free-form `source` string, which is why this is not called `source`).
 *
 * Facts only, no policy: whether an item is a body, an edit or a deletion
 * stays in its tags (`chat:edited`, `chat:deleted`); `deferred` and
 * `materialized` record what RFC-006 did with it. Nothing here is a version
 * key: `eventId` is present only when the producer supplied one.
 */

import { createHash } from 'node:crypto';
import { blockAsStored, MalformedContentError } from '@animalabs/context-manager';
import { logDetail, logValue } from './log-value.js';

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
 * unscoped push, which belongs to no conversation. The parts are server-chosen
 * strings, so they are encoded as a JSON array, never joined with a separator
 * one of them could contain: two keys are equal only for the same parts.
 */
export function conversationKey(source: InboundSource): string | undefined {
  if (source.kind === 'channel') {
    return JSON.stringify(['channel', source.serverId, source.channelId, source.threadId ?? null]);
  }
  if (source.kind === 'surface') return JSON.stringify(['surface', source.surface]);
  return undefined;
}

/**
 * JSON with object keys sorted at every level, written as the store's append
 * keeps a value (its native UTF-8 write, which the real-store digest table
 * checks): an `undefined` object entry is dropped; a string is well-formed
 * (each lone surrogate comes back as U+FFFD); and an entry whose key isn't
 * well-formed is dropped (the store doesn't keep it). An `undefined` array
 * element is written as `null`, as JSON writes it: the store's append
 * refuses a body holding one, so no stored copy does. So a value
 * hashes alike however its keys were ordered (a store on chronicle before
 * 0.5.1 hands content back with its keys sorted), and alike
 * before and after the store. editMessage writes JSON instead, so an edited
 * copy can keep what an append wouldn't; it has changed anyway.
 *
 * It expects JSON-shaped values, as the MCPL lanes deliver them (parsed from
 * JSON). Any other object is written by its own enumerable entries, unlike
 * JSON.stringify: a Date becomes `{}`, as the store's own write keeps it, but
 * a deferred write recovered from its JSON file brings it back as a string.
 *
 * sourceBodyDigest's serializer, kept out of the package API: serialization
 * and framing both stay inside sourceBodyDigest, so consumers don't
 * duplicate either (`canonicalJson(blocks)` alone hashes differently).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => v !== undefined && k.isWellFormed())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value.toWellFormed());
  return JSON.stringify(value) ?? 'null';
}

/**
 * blockAsStored throws a `MalformedContentError` for a block the store
 * refuses on write, a caller-supplied `blob_ref` among them. Such a block
 * has no stored form, and whatever is thrown, it is digested as given.
 */
function storedBlock(block: unknown): unknown {
  try {
    return blockAsStored(block as Parameters<typeof blockAsStored>[0]);
  } catch (err) {
    if (!(err instanceof MalformedContentError)) {
      const { name, message } = (err ?? {}) as { name?: unknown; message?: unknown };
      console.error(
        `[stored-digest-as-given] error=${logValue(typeof name === 'string' ? name : typeof err)}: ` +
        logDetail(typeof message === 'string' ? message : ''),
      );
    }
    return block;
  }
}

/**
 * The version identity of a delivered body (agreed with the receipts lane,
 * room-220 #46752–#47210): SHA-256 hex of `canonicalJson([blocks])` over the
 * ContentBlock[] the framework stores for the body — after MCPL conversion,
 * which marks the server's text at the framework's notice openings
 * (supplied-text.ts), before any host decoration is added and before storage
 * shards it — with
 * each block as the store keeps it, which context-manager's `blockAsStored`
 * gives. So a body hashes alike as delivered, as handed to storage, and as
 * read back unsharded from the store with its blobs resolved, except one
 * whose blocks the store changes together: when it mends a `tool_use` whose
 * input isn't an object, it also releases a raw replay form (`rawXml`,
 * `rawItem`) that the message's other blocks share, which no one block's
 * stored form shows. A body an MCPL lane stamps is never one. A block the
 * store refuses on write, a `blob_ref` among them, is digested as given. The
 * one-element array keeps the framing an undecorated, unsharded stored copy
 * has always hashed to, so a stamped copy and an older copy of the same body
 * share a version where the store keeps the body as it did then.
 *
 * A digest is a digest under the context-manager release that computed it: a
 * release that changes what the store keeps, such as its set of image
 * signatures, changes the digest of a body it touches.
 *
 * Ingestion stamps it as `metadata.sourceBodyDigest`, and the same function
 * over exactly the blocks handed to storage (decorations included) as
 * `metadata.storedBodyDigest`, on both MCPL lanes. Both live outside the
 * frozen admission envelope: they describe the body actually delivered (a
 * materialization, a correction), not the admission. Neither proves later
 * presence or completeness. An unsharded stored copy that no longer hashes
 * to its storedBodyDigest was changed after delivery (editMessage keeps
 * metadata), or holds blocks the store changes together, or its digest was
 * taken under a release that kept some block of it differently: a
 * context-manager release that changed a stored form, or an agent-framework
 * release from 0.24.0 up to the one that brought in blockAsStored, which
 * took stored forms from a copy of the store's transform. Digests already
 * stamped are never recomputed. A body the store shards carries the whole
 * body's two digests on every shard, and no shard hashes to them. Check a
 * copy read back with its blobs resolved (getAllMessages, getMessage, or
 * getMessageWindow without `resolveBlobs: false`): a blob reference never
 * matches.
 *
 * Exported from the package root, so a consumer checks a copy against either
 * field with this same function rather than a copy of it.
 */
export function sourceBodyDigest(blocks: readonly unknown[]): string {
  return createHash('sha256').update(canonicalJson([blocks.map(storedBlock)])).digest('hex');
}
