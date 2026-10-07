/**
 * Request-owned evidence for receipt clocks: which channel bodies a provider
 * request carries, captured when the request is prepared and never mutated
 * afterwards, so an edit made during inference is never attributed to the
 * body that was actually sent.
 */

import { createHash } from 'node:crypto';
import type { ContentBlock } from '@animalabs/membrane';
import type { CompileProvenance, StoredMessage } from '@animalabs/context-manager';
import { readInboundSource, type InboundChannelSource } from '../mcpl/inbound-source.js';
import type { ChannelRef, SourceRef, VersionRef } from './clock-ledger.js';

/** One channel body a request message carries. */
export interface BodyEvidence {
  /** Index into the request's messages (or into its injected batch). */
  index: number;
  storeMessageId: string;
  /** Whether the compile (or injection) carried the whole stored body. */
  complete: boolean;
  /** Why not, when not complete. */
  missing?: string[];
  ch: ChannelRef;
  src: SourceRef;
  ver: VersionRef;
}

/** What one prepared request carries, frozen at preparation. */
export interface RequestEvidence {
  agent: string;
  storeId: string;
  provenance: CompileProvenance | null;
  /** Channel bodies among the request's messages. */
  bodies: readonly BodyEvidence[];
  /**
   * True when request preparation itself did not carry the compile verbatim:
   * it dropped or changed a compiled message (whitespace-only text removed,
   * a guarded tool result substituted). The compile's layout then cannot
   * have been presented exactly, whatever the producer reports.
   */
  preparationAltered: boolean;
}

/**
 * The same evidence after request preparation changed some messages: bodies
 * at those request indices are no longer complete (missing 'preparation'),
 * and the compile is marked not carried verbatim.
 */
export function withPreparation(evidence: RequestEvidence, alteredIndices: ReadonlySet<number>, compileAltered: boolean): RequestEvidence {
  if (alteredIndices.size === 0 && !compileAltered) return evidence;
  const bodies = evidence.bodies.map((body) => alteredIndices.has(body.index)
    ? Object.freeze({ ...body, complete: false, missing: [...new Set([...(body.missing ?? []), 'preparation'])] })
    : body);
  return Object.freeze({
    ...evidence,
    bodies: Object.freeze(bodies),
    preparationAltered: evidence.preparationAltered || compileAltered || alteredIndices.size > 0,
  });
}

/** Channel of a stored item, from its frozen source envelope. */
export function channelOf(source: InboundChannelSource): ChannelRef {
  return { binding: source.binding, channelId: source.channelId, serverId: source.serverId };
}

export function sourceRefOf(source: InboundChannelSource, storeMessageId?: string): SourceRef {
  return {
    acceptedAt: source.acceptedAt,
    ...(source.messageId ? { messageId: source.messageId } : {}),
    ...(source.sourceTimestamp ? { sourceTimestamp: source.sourceTimestamp } : {}),
    ...(source.eventId ? { eventId: source.eventId } : {}),
    ...(storeMessageId ? { storeMessageId } : {}),
  };
}

/**
 * JSON with object keys sorted at every level. A body's digest must not
 * depend on key order: the same content reads back from the store with its
 * keys in a different order than it was written, so a mid-turn injection
 * (hashed from the content as handed over) and the stored copy a later
 * compile carries must hash alike.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function bodyDigest(contents: ReadonlyArray<readonly ContentBlock[]>): string {
  return createHash('sha256').update(canonicalJson(contents)).digest('hex');
}

/**
 * The version a stored channel body is, by the strongest basis its lane
 * guarantees (see VersionRef): the eventId on push/event and RFC-006
 * coalesced admission; else platform message id plus a digest of the body;
 * else the stored copy itself.
 */
export function versionOf(
  source: InboundChannelSource,
  contents: ReadonlyArray<readonly ContentBlock[]>,
  storeId: string,
  storeMessageId: string,
): VersionRef {
  const eventGuaranteed = source.eventId !== undefined && (source.lane === 'push/event' || source.coalesced === true);
  if (eventGuaranteed) {
    return { basis: 'event', key: JSON.stringify([source.binding, source.eventId]) };
  }
  if (source.messageId) {
    return { basis: 'message-digest', key: JSON.stringify([source.binding, source.channelId, source.messageId, bodyDigest(contents)]) };
  }
  return { basis: 'stored-copy', key: JSON.stringify([storeId, storeMessageId]) };
}

/** Tags that make an item a notice about a body rather than a body. */
const NOTICE_TAGS = ['chat:deleted', 'chat:reaction', 'chat:reaction-remove'];

/** Whether a stored item is a body (rather than a notice about one). */
export function isBody(message: Pick<StoredMessage, 'metadata'>, source: InboundChannelSource): boolean {
  if (source.deferred && !source.materialized) return false;
  const tags = (message.metadata as { tags?: unknown } | undefined)?.tags;
  if (Array.isArray(tags) && NOTICE_TAGS.some((tag) => tags.includes(tag))) return false;
  return true;
}

export interface EvidenceInputs {
  agent: string;
  storeId: string;
  provenance: CompileProvenance | null;
  /** For each compiled message, its index in the request, or -1 when dropped. */
  requestIndexOf: readonly number[];
  getMessage: (id: string) => StoredMessage | null;
  /** Every stored message of a body group, in shard order (sharded bodies only). */
  groupMembers: (head: StoredMessage) => StoredMessage[];
}

/** Evidence for a compiled request: its channel bodies, frozen now. */
export function requestEvidence(inputs: EvidenceInputs): RequestEvidence {
  const bodies: BodyEvidence[] = [];
  const provenance = inputs.provenance;
  if (provenance) {
    // A copy (one stored body) can span several compiled messages. If request
    // preparation dropped any of them, the copy wasn't carried whole, so its
    // surviving fragments can't be complete. A copy dropped entirely leaves
    // no evidence at all: it was never an exposure.
    const droppedFragments = new Set<string>();
    provenance.messages.forEach((sources, compiledIndex) => {
      if (sources.kind !== 'raw' || (inputs.requestIndexOf[compiledIndex] ?? -1) >= 0) return;
      for (const body of sources.bodies) droppedFragments.add(body.messageId);
    });
    provenance.messages.forEach((sources, compiledIndex) => {
      if (sources.kind !== 'raw') return;
      const index = inputs.requestIndexOf[compiledIndex] ?? -1;
      if (index < 0) return;
      for (const body of sources.bodies) {
        const stored = inputs.getMessage(body.messageId);
        if (!stored) continue;
        const source = readInboundSource(stored.metadata);
        if (!source || source.kind !== 'channel' || !isBody(stored, source)) continue;
        const members = stored.bodyGroupId ? inputs.groupMembers(stored) : [stored];
        const lostFragment = droppedFragments.has(body.messageId);
        const missing = [...(body.missing ?? []), ...(lostFragment ? ['preparation'] : [])];
        bodies.push(Object.freeze({
          index,
          storeMessageId: stored.id,
          complete: body.complete && !lostFragment,
          ...(missing.length > 0 ? { missing } : {}),
          ch: channelOf(source),
          src: sourceRefOf(source, stored.id),
          ver: versionOf(source, members.map((m) => m.content), inputs.storeId, stored.id),
        }));
      }
    });
  }
  return Object.freeze({
    agent: inputs.agent,
    storeId: inputs.storeId,
    provenance,
    bodies: Object.freeze(bodies),
    preparationAltered: false,
  });
}

/** Evidence for one mid-turn injected message (index within its batch). */
export function injectedEvidence(
  index: number,
  storeMessageId: string,
  message: { content: readonly ContentBlock[]; metadata?: unknown },
  storeId: string,
): BodyEvidence | null {
  const source = readInboundSource(message.metadata);
  if (!source || source.kind !== 'channel' || !isBody({ metadata: message.metadata as StoredMessage['metadata'] }, source)) return null;
  return Object.freeze({
    index,
    storeMessageId,
    complete: true,
    ch: channelOf(source),
    src: sourceRefOf(source, storeMessageId),
    ver: versionOf(source, [message.content], storeId, storeMessageId),
  });
}
