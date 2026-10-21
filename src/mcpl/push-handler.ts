/**
 * PushHandler — handles push/event messages from MCPL servers.
 *
 * Validates feature sets, deduplicates by eventId, converts MCPL content blocks
 * to membrane ContentBlock[], and pushes McplPushEvents into the processing queue.
 *
 * Spec reference: Section 9 (Push Events).
 */

import type { ContentBlock } from '@animalabs/membrane';
import { convertBlock } from './convert-block.js';

import type {
  PushEventParams,
  PushEventResult,
} from './types.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import { McplFeatureSetError } from './feature-set-manager.js';
import { expandCoreTags } from './tags.js';
import { coalesceRejectionReason, EmptyContentError, validateCoalescedContent } from './push-coalescer.js';
import type { InboundSource } from './inbound-source.js';
import { isSilentHeartbeatMarker, isVisiblyEmptyConversion } from './visible-content.js';
import { logDetail, logValue } from './log-value.js';
import { RefusalLines } from './refusal-lines.js';
import { channelNotPermitted } from './errors.js';

// ============================================================================
// McplPushEvent (the ProcessEvent shape pushed to the queue)
// ============================================================================

/**
 * A push event converted for the framework processing queue.
 *
 * NOTE: This interface should be added to src/types/events.ts and included
 * in the ProcessEvent union. It is defined here for reference but the actual
 * events.ts modification is deferred.
 */
export interface McplPushEvent {
  type: 'mcpl:push-event';
  serverId: string;
  featureSet: string;
  eventId: string;
  content: ContentBlock[];
  origin?: Record<string, unknown>;
  tags?: string[];
  timestamp: string;
  inferenceId: string;
  triggerInference?: boolean;
  targetAgents?: string[];
  /** RFC-006: set when the coalescer delivers; rides the wake it queues. */
  coalescingSubject?: string;
  /** RFC-006 assembly: materialized for this agent's turn (store directly). */
  assemblingFor?: string;
  /** Host acceptance time (epoch ms), stamped where the push is admitted. */
  acceptedAt?: number;
  /** Framework-owned source envelope, frozen at a coalesced occurrence's
   *  acceptance so its later delivery cannot restamp it (inbound-source.ts). */
  inboundSource?: InboundSource;
}

// ============================================================================
// LRU Dedup Set
// ============================================================================

/**
 * Simple dedup set with a max capacity. When full, clears and starts fresh.
 * Good enough for a deduplication window — exact LRU is overkill here.
 */
class DedupSet {
  private set = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Returns true if the key was already present (duplicate).
   * Otherwise adds it and returns false.
   */
  checkAndAdd(key: string): boolean {
    if (this.set.has(key)) {
      return true;
    }
    if (this.set.size >= this.maxSize) {
      this.set.clear();
    }
    this.set.add(key);
    return false;
  }
}

// ============================================================================
// Responder interface
// ============================================================================

/** Minimal responder interface for sending JSON-RPC results back. */
interface Responder {
  respond(result: PushEventResult): void;
  respondError?(code: number, message: string, data?: unknown): void;
}

// ============================================================================
// PushHandler
// ============================================================================

export class PushHandler {
  private featureSetManager: FeatureSetManager;
  private pushEventFn: (event: McplPushEvent) => void;
  private emitTraceFn: (event: { type: string; [key: string]: unknown }) => void;
  private shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;
  private dedup = new DedupSet(1000);
  /** Holds back repeats of the line for a push refused for its channel: a
   *  channel-scoped one whose channel isn't declared (-32023) or may not be
   *  used (-32017), and one naming a channel another server registers. */
  private channelRefusalLines = new RefusalLines();

  constructor(
    featureSetManager: FeatureSetManager,
    pushEventFn: (event: McplPushEvent) => void,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
    shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean,
    private readonly handleCoalesced?: (serverId: string, params: PushEventParams, event: McplPushEvent) => Promise<PushEventResult>,
    /** An ordinary (uncoalesced) push was just admitted, before it is queued
     *  or acknowledged: return its source envelope, frozen now
     *  (mcpl/inbound-source.ts). Coalesced work is stamped by its own path. */
    private readonly acceptInbound?: (event: McplPushEvent) => InboundSource | undefined,
    /** The channel a push names, and the server that registers it, when
     *  another server registers that channel id and this server doesn't. */
    private readonly channelOfAnotherServer?: (serverId: string, params: PushEventParams) => { channelId: string; holder: string } | undefined,
  ) {
    this.featureSetManager = featureSetManager;
    this.pushEventFn = pushEventFn;
    this.emitTraceFn = emitTraceFn;
    this.shouldTriggerInference = shouldTriggerInference;
  }

  /**
   * Handle a push/event message from an MCPL server.
   *
   * 1. Validate feature set
   * 2. Convert content blocks; reject visibly-empty content
   *    Refuse a push naming a channel another server registers
   * 3. Deduplicate by eventId
   * 4. Optionally check shouldTriggerInference callback
   * 5. Push event to queue
   * 6. Emit trace
   * 7. Respond with accepted + inferenceId
   */
  async handlePushEvent(
    serverId: string,
    params: PushEventParams,
    responder?: Responder,
  ): Promise<void> {
    // §16.3: expand the normative chat:* core closure once, at entry, so
    // every downstream consumer (wake matching, metadata, the queued event)
    // sees the closed set. Producer `implies` edges are NOT consumed —
    // advisory pending acceptance (§16.4). Tags were admitted before this
    // point and grant nothing (§16.6).
    if (params.tags) params.tags = expandCoreTags(params.tags);
    // 1. Validate feature set. §6.6: rejection is diagnostics, not
    // authorization, and MUST be a JSON-RPC error object — not a result
    // carrying a failure flag. (The old `{accepted:false, reason}` result
    // was AUDIT-001's finding: the error factories existed and were never
    // invoked.) Falls back to the result shape only for a legacy responder
    // with no error path.
    try {
      this.featureSetManager.validateInbound(serverId, params.featureSet);
    } catch (err) {
      const reason = err instanceof McplFeatureSetError
        ? err.message
        : 'Feature set validation failed';
      // Loud rejection — a rejected push event is an agent that silently
      // never hears the message. (2026-07-09 diagnosability pass.)
      console.error(`[push-event-rejected] server=${serverId} eventId=${logValue(params.eventId ?? '')} reason=${logValue(reason)}`);
      if (err instanceof McplFeatureSetError && responder?.respondError) {
        responder.respondError(err.code, reason, { featureSet: err.featureSet });
      } else {
        responder?.respond({ accepted: false, reason });
      }
      return;
    }

    const coalesced = params.coalesce !== undefined && !!this.handleCoalesced;
    // Empty content is meaningful only for a coalescing retraction (pure
    // withdrawal, RFC-006 §6 — the coalescer appends nothing for it) and for
    // the silent-heartbeat marker. Anything else that shows the model nothing
    // would wake it with no visible cause.
    const emptyAllowed = (coalesced && params.coalesce?.retract === true)
      || isSilentHeartbeatMarker({ serverId, featureSet: params.featureSet, origin: params.origin, content: params.payload?.content });
    if (coalesced) {
      // RFC-006 §13: malformed content is a -32602, checked before conversion.
      try {
        validateCoalescedContent(params.payload?.content, { allowEmpty: emptyAllowed });
      } catch (error) {
        const err = error as Error & { code?: number; field?: string };
        const code = err.code ?? -32602;
        if (err instanceof EmptyContentError) this.traceEmptyRejection(serverId, params);
        else this.traceCoalesceRejection(serverId, params, err, code);
        if (responder?.respondError) responder.respondError(code, err.message, { field: err.field });
        else responder?.respond({ accepted: false, reason: err instanceof EmptyContentError ? err.reason : err.message });
        return;
      }
    }

    // 2. Convert content blocks, and refuse content with nothing visible in
    // it — before dedup, so a refused eventId is not burned for a retry.
    const content: ContentBlock[] = params.payload.content.map((block) => convertBlock(block, 'attachment on push event', serverId));
    if (!emptyAllowed && isVisiblyEmptyConversion(params.payload.content, content)) {
      const err = new EmptyContentError();
      this.traceEmptyRejection(serverId, params);
      if (responder?.respondError) responder.respondError(err.code, err.message, { field: err.field });
      else responder?.respond({ accepted: false, reason: err.reason });
      return;
    }

    // A push is its own server's event, and the agent's reply to it goes to
    // the channel the push names. A channel's id is the agent's locus, so a
    // push naming a channel another server registers, which this server
    // doesn't, would have the reply sent through that other server. It's
    // refused, before dedup, so a retry once this server registers the
    // channel isn't refused as a duplicate.
    const elsewhere = this.channelOfAnotherServer?.(serverId, params);
    if (elsewhere) {
      this.refuseChannelOfAnotherServer(serverId, params, elsewhere, responder);
      return;
    }

    // 3. Deduplicate by eventId. A coalesced occurrence is deduplicated by the
    // coalescer's receipts instead (RFC-006 §3.1: a retry within the window
    // gets its original result, which this set could not return).
    if (!coalesced && this.dedup.checkAndAdd(params.eventId)) {
      console.error(`[push-event-rejected] server=${serverId} eventId=${logValue(params.eventId ?? '')} reason=duplicate`);
      responder?.respond({ accepted: false, reason: 'duplicate' });
      return;
    }

    // 4. Check shouldTriggerInference callback
    let triggerInference = true;
    if (this.shouldTriggerInference) {
      const textContent = content
        .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const metadata: Record<string, unknown> = {
        serverId,
        featureSet: params.featureSet,
        eventId: params.eventId,
        eventType: 'mcpl:push-event',
        ...(params.origin ?? {}),
        ...(params.tags ? { tags: params.tags } : {}),
      };
      triggerInference = this.shouldTriggerInference(textContent, metadata);
    }

    // 5. Generate inferenceId
    const inferenceId = `${serverId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // 6. Push event to queue
    const pushEvent: McplPushEvent = {
      type: 'mcpl:push-event',
      serverId,
      featureSet: params.featureSet,
      eventId: params.eventId,
      content,
      origin: params.origin,
      tags: params.tags,
      timestamp: params.timestamp,
      inferenceId,
      triggerInference,
      acceptedAt: Date.now(),
    };
    if (coalesced) {
      // RFC-006: the coalescer decides whether this occurrence replaces an
      // unread one, appends, or withdraws; it delivers through the same event
      // the ordinary path would have queued.
      try {
        const result = await this.handleCoalesced!(serverId, params, pushEvent);
        this.emitTraceFn({ type: 'mcpl:push_event', serverId, eventId: params.eventId, featureSet: params.featureSet, coalesce: result.coalesce });
        responder?.respond(result);
      } catch (error) {
        const err = error as Error & { code?: number; field?: string };
        const code = typeof err.code === 'number' ? err.code : -32603;
        this.traceCoalesceRejection(serverId, params, err, code);
        if (responder?.respondError) responder.respondError(code, err.message, { field: err.field });
        else responder?.respond({ accepted: false, reason: err.message });
      }
      return;
    }
    // The source envelope is frozen at admission, before queueing or the
    // acknowledgement: nothing that changes while the push waits in the
    // queue can rewrite where it came from.
    const inboundSource = this.acceptInbound?.(pushEvent);
    if (inboundSource) pushEvent.inboundSource = inboundSource;
    this.pushEventFn(pushEvent);

    // 7. Emit trace
    this.emitTraceFn({
      type: 'mcpl:push_event',
      serverId,
      eventId: params.eventId,
      featureSet: params.featureSet,
    });

    // 8. Respond
    responder?.respond({ accepted: true, inferenceId });
  }

  /**
   * A coalesced occurrence the host refused, as loud as every other push
   * rejection: its producer is told on the wire, and until now the host said
   * nothing, so a dropped message left no trace where operators look
   * (agent-framework#266). The producer gets the wire answer this lane gives
   * (`answered`): the thrown error's code and message, or -32602 for a
   * malformed occurrence without one. The reason follows that answer
   * (coalesceRejectionReason): `coalesce-failed` when the host itself failed,
   * `coalesce-invalid` when the producer's occurrence was refused, with the
   * failing `field` and the error's message as `detail`. A missing eventId
   * prints as `""` and traces as `''`, as the channel lane's missing id does.
   * A channel-scoped push refused because its channel isn't declared or may
   * not be used names the channel on its line and its trace, and is refused
   * for as long as that lasts, so its line prints at most once a minute per
   * channel (RefusalLines); every refusal is traced.
   */
  private traceCoalesceRejection(
    serverId: string,
    params: PushEventParams,
    error: { field?: unknown; message: string },
    answered: number,
  ): void {
    const reason = coalesceRejectionReason(answered);
    const field = typeof error.field === 'string' && error.field ? error.field : undefined;
    const scoped = params.coalesce?.channelId;
    const channelId = (answered === -32023 || answered === -32017) && typeof scoped === 'string' ? scoped : undefined;
    const held = channelId === undefined ? 0 : this.channelRefusalLines.admit(serverId, channelId);
    if (held !== null) {
      console.error(
        `[push-event-rejected] server=${serverId} featureSet=${logValue(params.featureSet ?? '')} eventId=${logValue(params.eventId ?? '')} ` +
        (channelId === undefined ? '' : `channel=${logValue(channelId)} `) +
        `reason=${reason}${field ? ` field=${logValue(field)}` : ''}: ${logDetail(error.message)}` +
        (held ? ` (${held} more since the last line)` : ''),
      );
    }
    this.emitTraceFn({
      type: 'mcpl:push-event-rejected',
      serverId,
      eventId: typeof params.eventId === 'string' ? params.eventId : '',
      featureSet: params.featureSet,
      reason,
      ...(field ? { field } : {}),
      ...(channelId === undefined ? {} : { channelId }),
      detail: error.message,
    });
  }

  /** A push naming a channel another server registers: refused with -32017.
   *  The operator's line names the server that registers it; the answer to
   *  the pushing server doesn't. The line prints at most once a minute per
   *  channel, as the other channel refusals' do, and every refusal is traced. */
  private refuseChannelOfAnotherServer(
    serverId: string,
    params: PushEventParams,
    elsewhere: { channelId: string; holder: string },
    responder: Responder | undefined,
  ): void {
    const held = this.channelRefusalLines.admit(serverId, elsewhere.channelId);
    if (held !== null) {
      console.error(
        `[push-event-rejected] server=${serverId} featureSet=${logValue(params.featureSet ?? '')} eventId=${logValue(params.eventId ?? '')} ` +
        `channel=${logValue(elsewhere.channelId)} reason=channel-of-another-server: registered by server ${logValue(elsewhere.holder)}, not this one` +
        (held ? ` (${held} more since the last line)` : ''),
      );
    }
    this.emitTraceFn({
      type: 'mcpl:push-event-rejected',
      serverId,
      eventId: typeof params.eventId === 'string' ? params.eventId : '',
      featureSet: params.featureSet,
      reason: 'channel-of-another-server',
      channelId: elsewhere.channelId,
      detail: `registered by server ${elsewhere.holder}`,
    });
    const error = channelNotPermitted(elsewhere.channelId);
    if (responder?.respondError) responder.respondError(error.code, error.message, error.data);
    else responder?.respond({ accepted: false, reason: error.message });
  }

  /** Loud, like every other push rejection: the producer's wake went nowhere.
   *  A missing eventId prints as `""` and traces as `''`, as on every push line. */
  private traceEmptyRejection(serverId: string, params: PushEventParams): void {
    console.error(`[push-event-rejected] server=${serverId} eventId=${logValue(params.eventId ?? '')} reason=empty-content`);
    this.emitTraceFn({
      type: 'mcpl:push-event-rejected',
      serverId,
      eventId: typeof params.eventId === 'string' ? params.eventId : '',
      featureSet: params.featureSet,
      reason: 'empty-content',
    });
  }
}
