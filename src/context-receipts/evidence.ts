/**
 * Request-owned evidence for receipt clocks: which channel bodies a provider
 * request carries, captured when the request is prepared and never mutated
 * afterwards, so an edit made during inference is never attributed to the
 * body that was actually sent.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { CompileProvenance, StoredMessage } from '@animalabs/context-manager';
import { readInboundSource, sourceBodyDigest, type InboundChannelSource } from '../mcpl/inbound-source.js';
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

/** The shared source-body digest (mcpl/inbound-source.ts): one implementation for producer and receipts. */
export { sourceBodyDigest };

function digestField(metadata: unknown, field: 'sourceBodyDigest' | 'storedBodyDigest'): string | undefined {
  const value = (metadata as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The body digest ingestion recorded for an item, before any decoration or
 * reshaping (`metadata.sourceBodyDigest`), if it recorded one.
 */
export function recordedBodyDigest(metadata: unknown): string | undefined {
  return digestField(metadata, 'sourceBodyDigest');
}

/** What a stored copy's own record says about its body (see versionOf). */
export interface CopyFacts {
  /** The body is stored in shards: its head has a bodyGroupId. */
  sharded: boolean;
  /** `metadata.sourceBodyDigest`: the delivered body's digest, recorded at ingestion. */
  sourceDigest?: string;
  /**
   * `metadata.storedBodyDigest`: the digest of the blocks ingestion handed to
   * storage (decorated, before any sharding), recorded with sourceDigest. It
   * binds the record to the stored representation, so an edit after
   * ingestion can't inherit the delivered body's version.
   */
  storedDigest?: string;
}

/** A stored copy's facts, from its head (the first shard, or the message itself). */
export function copyFacts(head: { metadata?: unknown; bodyGroupId?: string }): CopyFacts {
  const sourceDigest = digestField(head.metadata, 'sourceBodyDigest');
  const storedDigest = digestField(head.metadata, 'storedBodyDigest');
  return {
    sharded: Boolean(head.bodyGroupId),
    ...(sourceDigest ? { sourceDigest } : {}),
    ...(storedDigest ? { storedDigest } : {}),
  };
}

/**
 * The version a stored channel body is, by the strongest basis its lane
 * guarantees (see VersionRef): the eventId on push/event and RFC-006
 * coalesced admission; else platform message id plus a digest of the body;
 * else the stored copy itself.
 *
 * The body digest is the one ingestion recorded for the delivery, before
 * decoration or sharding, so a stored header, sharding, injection and
 * compilation all carry one version. A copy stored without a record
 * predates decoration: unsharded, its stored blocks are the delivered body;
 * sharded (by its own sharding facts, not by how many shards a view
 * returned), the source digest can't be recovered, and it falls back to the
 * stored copy: a replay of it is then not recognizable.
 *
 * Identity says which source item a copy is of, not that the copy still
 * presents it: see copyFidelity, which confirmed delivery requires.
 */
export function versionOf(
  source: InboundChannelSource,
  contents: ReadonlyArray<readonly ContentBlock[]>,
  storeId: string,
  storeMessageId: string,
  facts: CopyFacts = { sharded: false },
): VersionRef {
  const eventGuaranteed = source.eventId !== undefined && (source.lane === 'push/event' || source.coalesced === true);
  if (eventGuaranteed) {
    return { basis: 'event', key: JSON.stringify([source.binding, source.eventId]) };
  }
  const digest = recoverableDigest(contents, facts);
  if (source.messageId && digest) {
    return { basis: 'message-digest', key: JSON.stringify([source.binding, source.channelId, source.messageId, digest]) };
  }
  return { basis: 'stored-copy', key: JSON.stringify([storeId, storeMessageId]) };
}

/** The delivered body's digest: recorded, or recoverable from an unsharded legacy copy. */
function recoverableDigest(contents: ReadonlyArray<readonly ContentBlock[]>, facts: CopyFacts): string | undefined {
  if (facts.sourceDigest) return facts.sourceDigest;
  return !facts.sharded && contents.length === 1 ? sourceBodyDigest(contents[0]!) : undefined;
}

/**
 * Whether this copy still presents what ingestion stored for the source item,
 * whatever its version basis (event id or digest):
 *  - `intact`: shards (which can't be edited), or an unsharded copy whose
 *    blocks still hash to its recorded stored digest;
 *  - `edited`: an unsharded copy whose blocks no longer hash to it. A
 *    supported context edit (CM editMessage) replaces content and keeps
 *    metadata, stamp included; the copy no longer presents the source body;
 *  - `unverifiable`: an unsharded copy with no stored digest to check
 *    against (stored before ingestion recorded one). Its bytes can be
 *    hashed, but nothing shows an edit never changed them.
 * Only an intact copy can confirm delivery.
 */
export type CopyFidelity = 'intact' | 'edited' | 'unverifiable';

export function copyFidelity(contents: ReadonlyArray<readonly ContentBlock[]>, facts: CopyFacts): CopyFidelity {
  if (facts.sharded) return 'intact';
  if (facts.storedDigest === undefined) return 'unverifiable';
  return contents.length === 1 && sourceBodyDigest(contents[0]!) === facts.storedDigest ? 'intact' : 'edited';
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
        const contents = members.map((m) => m.content);
        const facts = copyFacts(stored);
        const lostFragment = droppedFragments.has(body.messageId);
        const fidelity = copyFidelity(contents, facts);
        const missing = [...(body.missing ?? []), ...(lostFragment ? ['preparation'] : []), ...(fidelity === 'intact' ? [] : [fidelity])];
        bodies.push(Object.freeze({
          index,
          storeMessageId: stored.id,
          complete: body.complete && !lostFragment && fidelity === 'intact',
          ...(missing.length > 0 ? { missing } : {}),
          ch: channelOf(source),
          src: sourceRefOf(source, stored.id),
          ver: versionOf(source, contents, inputs.storeId, stored.id, facts),
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

/**
 * Evidence for one mid-turn injected message (index within its batch). The
 * injected content is the whole body as handed to storage; `stored` is the
 * stored copy (its head), whose sharding facts decide legacy recoverability
 * just as they do for the compiled copy.
 */
export function injectedEvidence(
  index: number,
  storeMessageId: string,
  message: { content: readonly ContentBlock[]; metadata?: unknown },
  storeId: string,
  stored?: { metadata?: unknown; bodyGroupId?: string } | null,
): BodyEvidence | null {
  const source = readInboundSource(message.metadata);
  if (!source || source.kind !== 'channel' || !isBody({ metadata: message.metadata as StoredMessage['metadata'] }, source)) return null;
  const facts = { ...copyFacts({ metadata: message.metadata }), sharded: Boolean(stored?.bodyGroupId) };
  // The injected content is the whole body as handed to storage: checked as one copy.
  const fidelity = copyFidelity([message.content], { ...facts, sharded: false });
  return Object.freeze({
    index,
    storeMessageId,
    complete: fidelity === 'intact',
    ...(fidelity === 'intact' ? {} : { missing: [fidelity] }),
    ch: channelOf(source),
    src: sourceRefOf(source, storeMessageId),
    ver: versionOf(source, [message.content], storeId, storeMessageId, facts),
  });
}
