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

function bodyDigest(contents: ReadonlyArray<readonly ContentBlock[]>): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(contents));
  return hash.digest('hex');
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
        bodies.push(Object.freeze({
          index,
          storeMessageId: stored.id,
          complete: body.complete,
          ...(body.missing ? { missing: [...body.missing] } : {}),
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
